/**
 * 反復修復ストラテジーの検証
 *
 * 修復 → Passive Shuffle → 修復 → ... を繰り返すことで
 * 分断されたネットワークが段階的に結合していくか検証する。
 */

import { EnhancedMeshSimulator, type EnhancedMeshParams, type SimMetrics } from './EnhancedMeshSimulator.js';

function printCompact(label: string, m: SimMetrics): void {
  const st = m.isFullyConnected ? '✅' : `❌(${m.connectedComponents})`;
  console.log(`  ${label.padEnd(30)} ${st.padEnd(8)} 孤立:${String(m.isolatedNodes).padStart(2)} deg:${m.averageDegree.toFixed(1)} path:${m.averageShortestPath.toFixed(1)} PV:${m.avgPassiveViewSize.toFixed(0)}`);
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

const params: EnhancedMeshParams = {
  minDegree: 5, maxDegree: 8, targetDegree: 6,
  passiveViewSize: 30, shuffleExchangeCount: 6,
  longRangeLinkRatio: 0.5,
};

console.log('🌐 反復修復ストラテジー検証\n');

for (const removeRate of [0.3, 0.5, 0.7]) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  ${removeRate * 100}% 削除 → 反復修復 (repair + shuffle を交互に最大50ラウンド)`);
  console.log('─'.repeat(70));

  const sim = new EnhancedMeshSimulator(params);
  for (let i = 0; i < 1000; i++) sim.addNode();
  // 十分にPassive Viewを充実させる
  for (let i = 0; i < 20; i++) sim.shufflePassiveViews();
  for (let i = 0; i < 5; i++) sim.repairWithPassiveView();
  // 撹拌で小世界性を付与
  for (let i = 0; i < 10; i++) { sim.shuffleActive(); sim.repairWithPassiveView(); }

  const pre = sim.computeMetrics();
  printCompact('削除前', pre);

  // 削除
  const ids = sim.nodeIds;
  shuffle(ids);
  const removeCount = Math.floor(1000 * removeRate);
  for (let i = 0; i < removeCount; i++) sim.removeNode(ids[i]);

  const postDel = sim.computeMetrics();
  printCompact('削除直後', postDel);

  // 反復修復
  for (let round = 0; round < 50; round++) {
    sim.repairWithPassiveView();
    sim.shufflePassiveViews();  // 生存ノード間でPassiveを再交換
    sim.repairWithPassiveView();

    const m = sim.computeMetrics();
    if (round < 5 || round % 10 === 9 || m.isFullyConnected) {
      printCompact(`ラウンド ${round + 1}`, m);
    }
    if (m.isFullyConnected) {
      console.log(`  🎯 ラウンド ${round + 1} で完全連結達成！`);
      break;
    }
  }
}

// ── Passive View の大きさを変えて30%削除の復旧を検証 ──

console.log(`\n${'═'.repeat(70)}`);
console.log('  Passive View サイズ × 反復修復 (30%削除)');
console.log('═'.repeat(70));

for (const pvSize of [10, 20, 30, 50, 80]) {
  const p: EnhancedMeshParams = { ...params, passiveViewSize: pvSize, shuffleExchangeCount: Math.min(8, pvSize) };
  const sim = new EnhancedMeshSimulator(p);
  for (let i = 0; i < 1000; i++) sim.addNode();
  for (let i = 0; i < 20; i++) sim.shufflePassiveViews();
  for (let i = 0; i < 10; i++) { sim.shuffleActive(); sim.repairWithPassiveView(); }

  const ids = sim.nodeIds;
  shuffle(ids);
  for (let i = 0; i < 300; i++) sim.removeNode(ids[i]);

  let recovered = false;
  let recoveredAt = -1;
  for (let round = 0; round < 50; round++) {
    sim.repairWithPassiveView();
    sim.shufflePassiveViews();
    sim.repairWithPassiveView();
    const m = sim.computeMetrics();
    if (m.isFullyConnected) { recovered = true; recoveredAt = round + 1; break; }
  }
  console.log(`  PV=${String(pvSize).padStart(3)}: ${recovered ? `✅ ラウンド${recoveredAt}で復旧` : '❌ 50ラウンドで未復旧'}`);
}

console.log('\n✅ 完了');
