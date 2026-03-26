/**
 * AETHER メッシュシミュレーション実行スクリプト
 *
 * 5つのシナリオを実行し、最適なパラメータを探索する。
 */

import { MeshSimulator, type MeshParams, type SimulationMetrics } from './MeshSimulator.js';

// ── ユーティリティ ──

function printMetrics(label: string, m: SimulationMetrics): void {
  const status = m.isFullyConnected ? '✅ 完全連結' : `❌ 分断 (${m.connectedComponents}成分)`;
  console.log(`\n  📊 ${label}`);
  console.log(`     ノード数: ${m.totalNodes} | エッジ数: ${m.totalEdges}`);
  console.log(`     ${status} | 孤立ノード: ${m.isolatedNodes}`);
  console.log(`     接続度: avg=${m.averageDegree.toFixed(2)} σ=${m.degreeStdDev.toFixed(2)} [${m.minDegreeActual}..${m.maxDegreeActual}]`);
  console.log(`     最短経路: avg=${m.averageShortestPath.toFixed(2)} | 直径: ${m.diameter}`);
  console.log(`     クラスタリング係数: ${m.clusteringCoefficient.toFixed(4)}`);
}

function printSeparator(title: string): void {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(70));
}

// ── シナリオ 1: 段階的ノード追加 ──

function scenario1_gradualGrowth(params: MeshParams): void {
  printSeparator('シナリオ1: 段階的ノード追加');
  console.log(`  パラメータ: min=${params.minDegree} max=${params.maxDegree} target=${params.targetDegree}`);

  const sim = new MeshSimulator(params);
  const checkpoints = [10, 50, 100, 500, 1000, 5000];

  for (const target of checkpoints) {
    while (sim.nodeCount < target) {
      sim.addNode();
    }
    // 自己修復を数ラウンド実行
    for (let i = 0; i < 3; i++) sim.repairAll();

    const m = sim.computeMetrics();
    printMetrics(`${target}ノード到達時`, m);
  }
}

// ── シナリオ 2: ランダムノード削除 ──

function scenario2_randomRemoval(params: MeshParams): void {
  printSeparator('シナリオ2: ランダムノード削除 (1000ノードから)');

  const removalRates = [0.1, 0.3, 0.5];

  for (const rate of removalRates) {
    const sim = new MeshSimulator(params);
    for (let i = 0; i < 1000; i++) sim.addNode();
    for (let i = 0; i < 3; i++) sim.repairAll();

    // ノードをランダム削除
    const removeCount = Math.floor(1000 * rate);
    const ids = sim.nodeIds;
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    for (let i = 0; i < removeCount; i++) {
      sim.removeNode(ids[i]);
    }

    const beforeRepair = sim.computeMetrics();
    printMetrics(`${rate * 100}%削除直後 (修復前)`, beforeRepair);

    // 修復ラウンド
    for (let round = 0; round < 10; round++) {
      const repaired = sim.repairAll();
      if (repaired === 0) break;
    }

    const afterRepair = sim.computeMetrics();
    printMetrics(`${rate * 100}%削除 → 修復後`, afterRepair);
  }
}

// ── シナリオ 3: Churn耐性 ──

function scenario3_churn(params: MeshParams): void {
  printSeparator('シナリオ3: Churn耐性 (1000ノード、毎ステップ5%入替)');

  const sim = new MeshSimulator(params);
  for (let i = 0; i < 1000; i++) sim.addNode();
  for (let i = 0; i < 3; i++) sim.repairAll();

  const churnRate = 0.05;
  const steps = 20;
  let worstIsolated = 0;
  let disconnectedSteps = 0;

  for (let step = 0; step < steps; step++) {
    const removeCount = Math.floor(sim.nodeCount * churnRate);

    // ランダムにノード削除
    const ids = sim.nodeIds;
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    for (let i = 0; i < removeCount; i++) {
      sim.removeNode(ids[i]);
    }

    // 同数のノードを追加
    for (let i = 0; i < removeCount; i++) {
      sim.addNode();
    }

    // 修復
    for (let r = 0; r < 5; r++) sim.repairAll();

    const m = sim.computeMetrics();
    if (m.isolatedNodes > worstIsolated) worstIsolated = m.isolatedNodes;
    if (!m.isFullyConnected) disconnectedSteps++;

    if (step % 5 === 0 || step === steps - 1) {
      printMetrics(`Step ${step + 1}/${steps}`, m);
    }
  }

  console.log(`\n  📋 Churn結果: 最悪孤立数=${worstIsolated} | 分断ステップ=${disconnectedSteps}/${steps}`);
}

// ── シナリオ 4: パラメータスイープ ──

function scenario4_paramSweep(): void {
  printSeparator('シナリオ4: パラメータスイープ (最適値探索)');

  const configs: { min: number; max: number; target: number }[] = [
    { min: 3, max: 6, target: 4 },
    { min: 4, max: 7, target: 5 },
    { min: 5, max: 8, target: 6 },
    { min: 6, max: 9, target: 7 },
    { min: 5, max: 10, target: 7 },
  ];

  console.log('\n  min max tgt │ 連結 │ 孤立 │ avg度数 │ σ    │ avg経路 │ 直径 │ 30%削除後孤立 │ 復旧');
  console.log('  ────────────┼──────┼──────┼────────┼──────┼────────┼──────┼──────────────┼──────');

  for (const cfg of configs) {
    const params: MeshParams = {
      minDegree: cfg.min,
      maxDegree: cfg.max,
      targetDegree: cfg.target,
      pexMaxPeers: 4,
      shuffleDropCount: 1,
    };

    // 1000ノード構築
    const sim = new MeshSimulator(params);
    for (let i = 0; i < 1000; i++) sim.addNode();
    for (let i = 0; i < 5; i++) sim.repairAll();

    const stable = sim.computeMetrics();

    // 30%削除テスト
    const sim2 = new MeshSimulator(params);
    for (let i = 0; i < 1000; i++) sim2.addNode();
    for (let i = 0; i < 5; i++) sim2.repairAll();

    const ids = sim2.nodeIds;
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    for (let i = 0; i < 300; i++) sim2.removeNode(ids[i]);

    const afterDrop = sim2.computeMetrics();
    for (let r = 0; r < 10; r++) sim2.repairAll();
    const afterRepair = sim2.computeMetrics();

    console.log(
      `   ${cfg.min}   ${cfg.max}   ${cfg.target} │  ${stable.isFullyConnected ? '✅' : '❌'}  │  ${String(stable.isolatedNodes).padStart(3)} │  ${stable.averageDegree.toFixed(2).padStart(5)} │ ${stable.degreeStdDev.toFixed(2).padStart(4)} │  ${stable.averageShortestPath.toFixed(2).padStart(5)} │  ${String(stable.diameter).padStart(3)} │     ${String(afterDrop.isolatedNodes).padStart(4)}      │  ${afterRepair.isFullyConnected ? '✅' : '❌'}`
    );
  }
}

// ── シナリオ 5: 撹拌効果の検証 ──

function scenario5_shuffleEffect(params: MeshParams): void {
  printSeparator('シナリオ5: 撹拌効果の検証 (500ノード)');

  const sim = new MeshSimulator(params);
  for (let i = 0; i < 500; i++) sim.addNode();
  for (let i = 0; i < 3; i++) sim.repairAll();

  const before = sim.computeMetrics();
  printMetrics('撹拌前', before);

  for (let round = 0; round < 10; round++) {
    sim.shuffleAll();
    sim.repairAll();
  }

  const after = sim.computeMetrics();
  printMetrics('撹拌10ラウンド後', after);

  console.log(`\n  📋 撹拌効果:`);
  console.log(`     クラスタリング: ${before.clusteringCoefficient.toFixed(4)} → ${after.clusteringCoefficient.toFixed(4)}`);
  console.log(`     平均経路長: ${before.averageShortestPath.toFixed(2)} → ${after.averageShortestPath.toFixed(2)}`);
  console.log(`     度数σ: ${before.degreeStdDev.toFixed(2)} → ${after.degreeStdDev.toFixed(2)}`);
}

// ── メイン ──

function main(): void {
  console.log('🌐 AETHER メッシュネットワーク シミュレーション');
  console.log(`   実行日時: ${new Date().toISOString()}`);

  const defaultParams: MeshParams = {
    minDegree: 5,
    maxDegree: 8,
    targetDegree: 6,
    pexMaxPeers: 4,
    shuffleDropCount: 1,
  };

  scenario1_gradualGrowth(defaultParams);
  scenario2_randomRemoval(defaultParams);
  scenario3_churn(defaultParams);
  scenario4_paramSweep();
  scenario5_shuffleEffect(defaultParams);

  console.log(`\n${'═'.repeat(70)}`);
  console.log('  ✅ 全シミュレーション完了');
  console.log('═'.repeat(70));
}

main();
