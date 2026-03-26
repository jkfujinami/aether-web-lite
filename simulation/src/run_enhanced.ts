/**
 * 強化メッシュ vs 従来メッシュ 比較シミュレーション
 *
 * 特にトラッカー非依存での分断回復力を比較検証する。
 */

import { MeshSimulator, type MeshParams } from './MeshSimulator.js';
import { EnhancedMeshSimulator, type EnhancedMeshParams, type SimMetrics } from './EnhancedMeshSimulator.js';

function printM(label: string, m: SimMetrics & { avgPassiveViewSize?: number }): void {
  const st = m.isFullyConnected ? '✅ 完全連結' : `❌ 分断(${m.connectedComponents}成分)`;
  console.log(`  ${label}`);
  console.log(`    ${st} | 孤立:${m.isolatedNodes} | avg度数:${m.averageDegree.toFixed(2)} σ:${m.degreeStdDev.toFixed(2)} [${m.minDeg}..${m.maxDeg}]`);
  console.log(`    avg経路:${m.averageShortestPath.toFixed(2)} | 直径:${m.diameter}${m.avgPassiveViewSize !== undefined ? ` | avgPV:${m.avgPassiveViewSize.toFixed(1)}` : ''}`);
}

function sep(title: string): void {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(70));
}

// ── テスト1: 分断回復力 (30%, 50% 削除後の修復) ──

function test1_partitionRecovery(): void {
  sep('テスト1: 分断回復力 — PEXのみ vs Passive View Promotion');

  const enhancedParams: EnhancedMeshParams = {
    minDegree: 5, maxDegree: 8, targetDegree: 6,
    passiveViewSize: 30,
    shuffleExchangeCount: 6,
    longRangeLinkRatio: 0.5,
  };

  for (const removeRate of [0.1, 0.3, 0.5, 0.7]) {
    console.log(`\n  ── ${removeRate * 100}% ノード削除 ──`);

    // 強化メッシュ
    const sim = new EnhancedMeshSimulator(enhancedParams);
    for (let i = 0; i < 1000; i++) sim.addNode();
    // Passive View を数ラウンドのシャッフルで充実させる
    for (let i = 0; i < 10; i++) {
      sim.shufflePassiveViews();
      sim.repairWithPassiveView();
    }

    // 削除
    const ids = sim.nodeIds;
    shuffle(ids);
    const removeCount = Math.floor(1000 * removeRate);
    for (let i = 0; i < removeCount; i++) sim.removeNode(ids[i]);

    const beforeRepair = sim.computeMetrics();
    printM(`📊 削除直後`, beforeRepair);

    // PEXのみで修復
    for (let r = 0; r < 10; r++) sim.repairPEXOnly();
    const afterPEX = sim.computeMetrics();
    printM(`📊 PEXのみ修復後`, afterPEX);

    // さらにPassive View Promotionで修復
    for (let r = 0; r < 10; r++) sim.repairWithPassiveView();
    const afterPV = sim.computeMetrics();
    printM(`📊 + Passive View修復後`, afterPV);
  }
}

// ── テスト2: 経路長の比較 (Long-Range Links の効果) ──

function test2_pathLength(): void {
  sep('テスト2: 経路長比較 — Long-Range Links の効果');

  const ratios = [0.0, 0.25, 0.5, 0.75, 1.0];

  console.log('\n  LR比率 │ avg経路 │ 直径  │ avg度数 │ σ    │ 連結');
  console.log('  ───────┼────────┼──────┼────────┼──────┼─────');

  for (const ratio of ratios) {
    const sim = new EnhancedMeshSimulator({
      minDegree: 5, maxDegree: 8, targetDegree: 6,
      passiveViewSize: 30, shuffleExchangeCount: 6,
      longRangeLinkRatio: ratio,
    });
    for (let i = 0; i < 1000; i++) sim.addNode();
    for (let i = 0; i < 5; i++) { sim.repairWithPassiveView(); sim.shufflePassiveViews(); }
    // 撹拌を数ラウンド
    for (let i = 0; i < 5; i++) { sim.shuffleActive(); sim.repairWithPassiveView(); }

    const m = sim.computeMetrics();
    console.log(`   ${(ratio * 100).toFixed(0).padStart(3)}%  │ ${m.averageShortestPath.toFixed(2).padStart(6)} │ ${String(m.diameter).padStart(4)}  │ ${m.averageDegree.toFixed(2).padStart(6)} │ ${m.degreeStdDev.toFixed(2).padStart(4)} │ ${m.isFullyConnected ? '✅' : '❌'}`);
  }
}

// ── テスト3: Passive View サイズの影響 ──

function test3_passiveViewSize(): void {
  sep('テスト3: Passive View サイズの影響 (30%削除からの復旧)');

  const pvSizes = [5, 10, 20, 30, 50];

  console.log('\n  PVサイズ │ 削除後成分数 │ PEX修復後 │ PV修復後 │ 完全復旧');
  console.log('  ────────┼────────────┼──────────┼─────────┼────────');

  for (const pvSize of pvSizes) {
    const sim = new EnhancedMeshSimulator({
      minDegree: 5, maxDegree: 8, targetDegree: 6,
      passiveViewSize: pvSize, shuffleExchangeCount: Math.min(6, pvSize),
      longRangeLinkRatio: 0.5,
    });
    for (let i = 0; i < 1000; i++) sim.addNode();
    for (let i = 0; i < 10; i++) { sim.shufflePassiveViews(); sim.repairWithPassiveView(); }

    // 30%削除
    const ids = sim.nodeIds;
    shuffle(ids);
    for (let i = 0; i < 300; i++) sim.removeNode(ids[i]);

    const afterDrop = sim.computeMetrics();

    for (let r = 0; r < 10; r++) sim.repairPEXOnly();
    const afterPEX = sim.computeMetrics();

    for (let r = 0; r < 10; r++) sim.repairWithPassiveView();
    const afterPV = sim.computeMetrics();

    console.log(`    ${String(pvSize).padStart(3)}    │     ${String(afterDrop.connectedComponents).padStart(4)}     │   ${String(afterPEX.connectedComponents).padStart(4)}     │   ${String(afterPV.connectedComponents).padStart(4)}    │  ${afterPV.isFullyConnected ? '✅' : '❌'}`);
  }
}

// ── テスト4: 大規模 Churn 耐性 (トラッカーなし) ──

function test4_churnNoTracker(): void {
  sep('テスト4: Churn耐性 (トラッカー完全不使用、1000ノード、5%/step入替)');

  const sim = new EnhancedMeshSimulator({
    minDegree: 5, maxDegree: 8, targetDegree: 6,
    passiveViewSize: 30, shuffleExchangeCount: 6,
    longRangeLinkRatio: 0.5,
  });
  for (let i = 0; i < 1000; i++) sim.addNode();
  for (let i = 0; i < 10; i++) { sim.shufflePassiveViews(); sim.repairWithPassiveView(); }

  let worstIsolated = 0;
  let disconnected = 0;

  for (let step = 0; step < 30; step++) {
    const removeCount = Math.floor(sim.nodeCount * 0.05);
    const ids = sim.nodeIds;
    shuffle(ids);
    for (let i = 0; i < removeCount; i++) sim.removeNode(ids[i]);
    for (let i = 0; i < removeCount; i++) sim.addNode();

    // トラッカーなしの修復サイクル
    sim.repairWithPassiveView();
    sim.shufflePassiveViews();
    sim.repairWithPassiveView();

    const m = sim.computeMetrics();
    if (m.isolatedNodes > worstIsolated) worstIsolated = m.isolatedNodes;
    if (!m.isFullyConnected) disconnected++;

    if (step % 5 === 0 || step === 29) {
      printM(`Step ${step + 1}/30`, m);
    }
  }

  console.log(`\n  📋 結果: 最悪孤立=${worstIsolated} | 分断ステップ=${disconnected}/30`);
}

// ── テスト5: 5000ノード大規模テスト ──

function test5_largeScale(): void {
  sep('テスト5: 5000ノード大規模テスト (撹拌あり)');

  const sim = new EnhancedMeshSimulator({
    minDegree: 5, maxDegree: 8, targetDegree: 6,
    passiveViewSize: 30, shuffleExchangeCount: 6,
    longRangeLinkRatio: 0.5,
  });

  const checkpoints = [100, 500, 1000, 5000];
  for (const target of checkpoints) {
    while (sim.nodeCount < target) sim.addNode();
    for (let i = 0; i < 5; i++) {
      sim.repairWithPassiveView();
      sim.shufflePassiveViews();
    }
    // 撹拌
    for (let i = 0; i < 5; i++) {
      sim.shuffleActive();
      sim.repairWithPassiveView();
    }
    const m = sim.computeMetrics();
    printM(`📊 ${target}ノード`, m);
  }
}

// ── ユーティリティ ──

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ── メイン ──

function main(): void {
  console.log('🌐 AETHER 強化メッシュ シミュレーション (HyParView + Long-Range)');
  console.log(`   実行日時: ${new Date().toISOString()}\n`);

  test1_partitionRecovery();
  test2_pathLength();
  test3_passiveViewSize();
  test4_churnNoTracker();
  test5_largeScale();

  console.log(`\n${'═'.repeat(70)}`);
  console.log('  ✅ 全テスト完了');
  console.log('═'.repeat(70));
}

main();
