/**
 * 最終パラメータ最適化
 *
 * Passive View サイズの細かいスイープと、
 * 「チェーン型成長」の問題を解消する接続ストラテジーの検証。
 * 
 * キーインサイト:
 * - PV=80で30%削除が完全復旧 → PVサイズが鍵
 * - だがPVが大きすぎるとメモリ消費 → 最適なサイズを探す
 * - 経路長の線形増加問題 → 撹拌の頻度を上げて解決できるか
 */

import { EnhancedMeshSimulator, type EnhancedMeshParams } from './EnhancedMeshSimulator.js';

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

console.log('🌐 最終パラメータ最適化\n');

// ── テスト1: PVサイズのスイープ (30%削除復旧) ──

console.log('══ テスト1: PVサイズ × 削除率 マトリクス ══\n');
console.log('  PVサイズ │ 10%削除 │ 30%削除 │ 50%削除 │ 70%削除');
console.log('  ────────┼────────┼────────┼────────┼────────');

for (const pvSize of [30, 40, 50, 60, 80, 100]) {
  const results: string[] = [];
  
  for (const rate of [0.1, 0.3, 0.5, 0.7]) {
    const p: EnhancedMeshParams = {
      minDegree: 5, maxDegree: 8, targetDegree: 6,
      passiveViewSize: pvSize,
      shuffleExchangeCount: Math.min(8, Math.floor(pvSize / 3)),
      longRangeLinkRatio: 0.5,
    };
    
    const sim = new EnhancedMeshSimulator(p);
    for (let i = 0; i < 1000; i++) sim.addNode();
    // 十分な初期化
    for (let i = 0; i < 20; i++) sim.shufflePassiveViews();
    for (let i = 0; i < 10; i++) { sim.shuffleActive(); sim.repairWithPassiveView(); }
    
    const ids = sim.nodeIds;
    shuffle(ids);
    for (let i = 0; i < Math.floor(1000 * rate); i++) sim.removeNode(ids[i]);
    
    let recovered = false;
    let rounds = -1;
    for (let r = 0; r < 30; r++) {
      sim.repairWithPassiveView();
      sim.shufflePassiveViews();
      sim.repairWithPassiveView();
      const m = sim.computeMetrics();
      if (m.isFullyConnected) { recovered = true; rounds = r + 1; break; }
    }
    results.push(recovered ? `✅ R${rounds}`.padEnd(6) : '❌    ');
  }
  
  console.log(`    ${String(pvSize).padStart(3)}    │ ${results[0]}  │ ${results[1]}  │ ${results[2]}  │ ${results[3]}`);
}

// ── テスト2: 撹拌後の経路長 (5000ノード) ──

console.log('\n══ テスト2: 撹拌の充実度 × 経路長 (1000ノード) ══\n');

const base: EnhancedMeshParams = {
  minDegree: 5, maxDegree: 8, targetDegree: 6,
  passiveViewSize: 60, shuffleExchangeCount: 8,
  longRangeLinkRatio: 0.5,
};

const sim = new EnhancedMeshSimulator(base);
for (let i = 0; i < 1000; i++) sim.addNode();
for (let i = 0; i < 20; i++) sim.shufflePassiveViews();

console.log('  撹拌回数 │ avg経路 │ 直径  │ avg度数 │ CC    │ 連結');
console.log('  ─────────┼────────┼──────┼────────┼──────┼─────');

for (const totalRounds of [0, 5, 10, 20, 50, 100]) {
  const s = new EnhancedMeshSimulator(base);
  for (let i = 0; i < 1000; i++) s.addNode();
  for (let i = 0; i < 20; i++) s.shufflePassiveViews();
  for (let i = 0; i < 5; i++) s.repairWithPassiveView();
  
  for (let r = 0; r < totalRounds; r++) {
    s.shuffleActive();
    s.repairWithPassiveView();
  }
  
  const m = s.computeMetrics();
  console.log(`    ${String(totalRounds).padStart(4)}    │ ${m.averageShortestPath.toFixed(1).padStart(6)} │ ${String(m.diameter).padStart(4)}  │ ${m.averageDegree.toFixed(2).padStart(6)} │ ${m.clusteringCoefficient?.toFixed(3) ?? 'N/A'} │ ${m.isFullyConnected ? '✅' : '❌'}`);
}

// ── テスト3: 推奨パラメータでの総合テスト ──

console.log('\n══ テスト3: 推奨パラメータ総合テスト ══\n');
console.log('  推奨値: min=5 max=8 target=6 PV=60 LR=50%\n');

const recommended: EnhancedMeshParams = {
  minDegree: 5, maxDegree: 8, targetDegree: 6,
  passiveViewSize: 60, shuffleExchangeCount: 8,
  longRangeLinkRatio: 0.5,
};

// 3回試行して安定性を確認
for (let trial = 0; trial < 3; trial++) {
  console.log(`  ── Trial ${trial + 1} ──`);
  const s = new EnhancedMeshSimulator(recommended);
  for (let i = 0; i < 1000; i++) s.addNode();
  for (let i = 0; i < 20; i++) s.shufflePassiveViews();
  for (let i = 0; i < 20; i++) { s.shuffleActive(); s.repairWithPassiveView(); }
  
  const stable = s.computeMetrics();
  console.log(`    安定時: 連結=${stable.isFullyConnected?'✅':'❌'} deg=${stable.averageDegree.toFixed(1)} path=${stable.averageShortestPath.toFixed(1)} PV=${stable.avgPassiveViewSize.toFixed(0)}`);
  
  // 30%削除テスト
  const ids = s.nodeIds;
  shuffle(ids);
  for (let i = 0; i < 300; i++) s.removeNode(ids[i]);
  
  let recovered = false;
  for (let r = 0; r < 30; r++) {
    s.repairWithPassiveView();
    s.shufflePassiveViews();
    s.repairWithPassiveView();
    const m = s.computeMetrics();
    if (m.isFullyConnected) {
      console.log(`    30%削除 → ラウンド${r+1}で完全復旧 ✅ (deg=${m.averageDegree.toFixed(1)} path=${m.averageShortestPath.toFixed(1)})`);
      recovered = true;
      break;
    }
  }
  if (!recovered) console.log(`    30%削除 → 30ラウンドで未復旧 ❌`);
}

console.log('\n✅ 最適化完了');
