/**
 * Ring-Mesh シミュレーション実行 (10人規模, 100人規模のChurn耐性テスト)
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

function runChurnTest(scale: number, steps: number, churnRate: number, params: RingMeshParams): void {
  sep(`テスト: Churn耐性 (${scale}ノード、${churnRate * 100}%入替/step、${steps}ステップ)`);

  const sim = new RingMeshSimulator(params);
  
  // 初期化
  for (let i = 0; i < scale; i++) {
    sim.addNode();
  }
  for (let i = 0; i < 5; i++) {
    sim.repairAll(); // 初期メッシュを安定させる
  }

  let worstIsolated = 0;
  let disconnected = 0;
  let ringBroken = 0;
  
  const initialMetrics = sim.computeMetrics();
  pm(`初期状態 (0/${steps})`, initialMetrics);

  for (let step = 1; step <= steps; step++) {
    // scaleが10のような小規模の場合、少なくとも1ノードは入れ替える
    const removeCount = Math.max(1, Math.floor(sim.nodeCount * churnRate));
    const ids = sim.nodeIds;
    shuffle(ids);
    
    // 削除
    for (let i = 0; i < removeCount; i++) {
      sim.removeNode(ids[i]);
    }
    // 参加
    for (let i = 0; i < removeCount; i++) {
      sim.addNode();
    }

    // 自動修復ロジック（Heartbeat/修理サイクル相当）
    sim.repairAll();
    
    // Metrics計算
    const m = sim.computeMetrics();
    if (m.isolatedNodes > worstIsolated) worstIsolated = m.isolatedNodes;
    if (!m.isFullyConnected) disconnected++;
    if (!m.ringIntact) ringBroken++;

    if (step % 5 === 0 || step === steps) {
      pm(`Step ${step}/${steps}`, m);
    }
  }

  console.log(`\n  📋 結果: 最悪孤立=${worstIsolated}ノード | 分断=${disconnected}/${steps}回 | Ring切断=${ringBroken}/${steps}回`);
}

function main(): void {
  console.log('🌐 AETHER Ring-Mesh 10人/100人規模 Churn シミュレーション');
  console.log(`   実行日時: ${new Date().toISOString()}\n`);

  // Ring-Mesh確定仕様に合わせたパラメータ
  // LOCAL=4, LONGRANGE=4, PV=0
  const params: RingMeshParams = {
    localLinks: 4,
    longRangeLinks: 4,
    passiveViewSize: 0,
  };

  // 10人規模のテスト
  // 10人の場合、1ステップあたり2人(20%)が入れ替わる激しいChurnをテスト
  runChurnTest(10, 20, 0.20, params);

  // 100人規模のテスト
  // 100人の場合、1ステップあたり10人(10%)が入れ替わるChurnをテスト
  runChurnTest(100, 20, 0.10, params);

  console.log(`\n${'═'.repeat(70)}`);
  console.log('  ✅ 全テスト完了');
  console.log('═'.repeat(70));
}

main();
