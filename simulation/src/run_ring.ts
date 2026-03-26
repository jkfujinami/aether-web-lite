/**
 * Ring-Mesh シミュレーション実行
 *
 * 円環メッシュの特性を検証:
 * 1. 段階的成長 + 構造的連結性
 * 2. 大規模削除からの自己修復
 * 3. Churn耐性
 * 4. パラメータスイープ
 * 5. 従来メッシュとの比較
 */

import { RingMeshSimulator, type RingMeshParams, type RingMetrics } from './RingMeshSimulator.js';

function pm(label: string, m: RingMetrics): void {
  const st = m.isFullyConnected ? '✅' : `❌(${m.connectedComponents})`;
  const ring = m.ringIntact ? '🔵Ring維持' : '🔴Ring切断';
  console.log(`  ${label}`);
  console.log(`    ${st} ${ring} | 孤立:${m.isolatedNodes} | deg: avg=${m.averageDegree.toFixed(2)} σ=${m.degreeStdDev.toFixed(2)} [${m.minDeg}..${m.maxDeg}]`);
  console.log(`    avg経路:${m.averageShortestPath.toFixed(2)} | 直径:${m.diameter}`);
}

function sep(t: string): void {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${t}`);
  console.log('═'.repeat(70));
}

function shuffle<T>(a: T[]): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

// ── テスト1: 段階的成長 ──

function test1(params: RingMeshParams): void {
  sep('テスト1: 段階的成長 (Ring-Mesh)');
  console.log(`  params: local=${params.localLinks} longRange=${params.longRangeLinks} PV=${params.passiveViewSize}`);

  const sim = new RingMeshSimulator(params);
  for (const target of [10, 50, 100, 500, 1000, 5000]) {
    while (sim.nodeCount < target) sim.addNode();
    const m = sim.computeMetrics();
    pm(`📊 ${target}ノード`, m);
  }
}

// ── テスト2: 大規模削除 + 自己修復 ──

function test2(params: RingMeshParams): void {
  sep('テスト2: ノード削除 + 自己修復 (1000ノードから)');

  for (const rate of [0.1, 0.3, 0.5, 0.7]) {
    console.log(`\n  ── ${rate * 100}% 削除 ──`);
    const sim = new RingMeshSimulator(params);
    for (let i = 0; i < 1000; i++) sim.addNode();
    for (let i = 0; i < 5; i++) sim.shufflePassiveViews();

    const ids = sim.nodeIds;
    shuffle(ids);
    for (let i = 0; i < Math.floor(1000 * rate); i++) sim.removeNode(ids[i]);

    const after = sim.computeMetrics();
    pm(`削除直後`, after);

    for (let r = 0; r < 5; r++) sim.repairAll();
    for (let r = 0; r < 5; r++) sim.shufflePassiveViews();
    for (let r = 0; r < 5; r++) sim.repairAll();

    const repaired = sim.computeMetrics();
    pm(`修復後`, repaired);
  }
}

// ── テスト3: Churn耐性 ──

function test3(params: RingMeshParams): void {
  sep('テスト3: Churn耐性 (1000ノード、5%/step入替、30ステップ)');

  const sim = new RingMeshSimulator(params);
  for (let i = 0; i < 1000; i++) sim.addNode();
  for (let i = 0; i < 10; i++) sim.shufflePassiveViews();

  let worstIsolated = 0;
  let disconnected = 0;
  let ringBroken = 0;

  for (let step = 0; step < 30; step++) {
    const removeCount = Math.floor(sim.nodeCount * 0.05);
    const ids = sim.nodeIds;
    shuffle(ids);
    for (let i = 0; i < removeCount; i++) sim.removeNode(ids[i]);
    for (let i = 0; i < removeCount; i++) sim.addNode();

    sim.repairAll();
    sim.shufflePassiveViews();

    const m = sim.computeMetrics();
    if (m.isolatedNodes > worstIsolated) worstIsolated = m.isolatedNodes;
    if (!m.isFullyConnected) disconnected++;
    if (!m.ringIntact) ringBroken++;

    if (step % 5 === 0 || step === 29) pm(`Step ${step + 1}/30`, m);
  }

  console.log(`\n  📋 結果: 最悪孤立=${worstIsolated} | 分断=${disconnected}/30 | Ring切断=${ringBroken}/30`);
}

// ── テスト4: パラメータスイープ ──

function test4(): void {
  sep('テスト4: パラメータスイープ');

  const configs = [
    { local: 2, lr: 2, label: 'L2+LR2=4本' },
    { local: 4, lr: 2, label: 'L4+LR2=6本' },
    { local: 4, lr: 4, label: 'L4+LR4=8本' },
    { local: 6, lr: 2, label: 'L6+LR2=8本' },
    { local: 6, lr: 4, label: 'L6+LR4=10本' },
  ];

  console.log('\n  構成      │ 連結 │ Ring │ deg   │ σ    │ 経路  │ 直径 │ 30%削除復旧');
  console.log('  ──────────┼──────┼──────┼───────┼──────┼──────┼──────┼───────────');

  for (const cfg of configs) {
    const p: RingMeshParams = { localLinks: cfg.local, longRangeLinks: cfg.lr, passiveViewSize: 50 };
    const sim = new RingMeshSimulator(p);
    for (let i = 0; i < 1000; i++) sim.addNode();
    for (let i = 0; i < 5; i++) sim.shufflePassiveViews();

    const stable = sim.computeMetrics();

    // 30%削除テスト
    const sim2 = new RingMeshSimulator(p);
    for (let i = 0; i < 1000; i++) sim2.addNode();
    for (let i = 0; i < 5; i++) sim2.shufflePassiveViews();
    const ids = sim2.nodeIds;
    shuffle(ids);
    for (let i = 0; i < 300; i++) sim2.removeNode(ids[i]);
    for (let r = 0; r < 10; r++) { sim2.repairAll(); sim2.shufflePassiveViews(); }
    const repaired = sim2.computeMetrics();

    console.log(
      `  ${cfg.label.padEnd(10)}│  ${stable.isFullyConnected ? '✅' : '❌'}  │  ${stable.ringIntact ? '✅' : '❌'}  │ ${stable.averageDegree.toFixed(2).padStart(5)} │ ${stable.degreeStdDev.toFixed(2).padStart(4)} │ ${stable.averageShortestPath.toFixed(1).padStart(5)} │ ${String(stable.diameter).padStart(4)} │ ${repaired.isFullyConnected ? '✅' : '❌'} ${repaired.ringIntact ? 'Ring✅' : 'Ring❌'}`
    );
  }
}

// ── テスト5: 可視化データ出力（小規模） ──

function test5(params: RingMeshParams): void {
  sep('テスト5: 小規模可視化 (20ノード)');

  const sim = new RingMeshSimulator(params);
  for (let i = 0; i < 20; i++) sim.addNode();

  const viz = sim.getVisualizationData();
  console.log('\n  ノード配置 (円環上の位置):');
  for (const n of viz.nodes) {
    const angle = n.position * 360;
    const bar = '█'.repeat(Math.floor(n.position * 50));
    console.log(`    ID=${String(n.id).padStart(2)} pos=${n.position.toFixed(3)} ${String(angle.toFixed(0)).padStart(3)}° │${bar}`);
  }

  console.log(`\n  エッジ数: ${viz.edges.length}`);
  const m = sim.computeMetrics();
  pm('📊 20ノードのメトリクス', m);
}

// ── メイン ──

function main(): void {
  console.log('🌐 AETHER Ring-Mesh シミュレーション');
  console.log(`   実行日時: ${new Date().toISOString()}\n`);

  const defaultParams: RingMeshParams = {
    localLinks: 4,       // 左右各2本 = 4本のローカルリンク
    longRangeLinks: 2,   // 対角方向に2本のショートカット
    passiveViewSize: 50,
  };

  test5(defaultParams); // まず小規模で可視化
  test1(defaultParams);
  test2(defaultParams);
  test3(defaultParams);
  test4();

  console.log(`\n${'═'.repeat(70)}`);
  console.log('  ✅ 全テスト完了');
  console.log('═'.repeat(70));
}

main();
