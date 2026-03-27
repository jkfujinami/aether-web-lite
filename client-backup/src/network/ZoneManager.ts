import { RING_MESH_ZONE } from '../constants';
import type { IPeerManager } from '../types';

/**
 * ZoneManager: Adaptive Zone の状態・購読セット・Depth管理。
 * ネットワークの規模に応じて「ゾーンの深さ」を自律合意し、
 * 自分が担当する K=16 個の匿名購読セットを維持する。
 */
export class ZoneManager {
  private _depth: number = 0;
  private _subscribedZones: Set<number> = new Set();
  private peerManager: IPeerManager;
  private networkSize: number = 10; // 初期推定値

  constructor(peerManager: IPeerManager) {
    this.peerManager = peerManager;
    this.initSubscribedZones();
    
    // 1分ごとに depth を再計算 (§5.7)
    setInterval(() => this.recomputeDepth(), 60_000);
  }

  public get depth(): number { return this._depth; }
  public get subscribedZones(): Set<number> { return this._subscribedZones; }

  /**
   * パケットが購読対象（またはリレー対象）か判定
   */
  public isSubscribed(zoneId: number): boolean {
    const totalZones = 1 << this._depth;
    // 全ゾーン数が 16 以下の場合は Full Flood (Broadcast Veil) なので常に true
    if (totalZones <= RING_MESH_ZONE.SUBSCRIBE_COUNT) return true;
    
    return this._subscribedZones.has(zoneId);
  }

  /**
   * ネットワークサイズを推定し、depth を更新する (§3.4)
   * 隣人の Ring 密度が高いほど、ネットワーク全体が巨大であると推定する。
   */
  private recomputeDepth() {
    const peers = Array.from(this.peerManager.peers.values());
    if (peers.length < 2) return;

    // 隣人との平均距離を計算
    const myPos = this.peerManager.myPosition;
    let totalDist = 0;
    for (const peer of peers) {
        const d = Math.abs(peer.position - myPos);
        totalDist += Math.min(d, 1.0 - d);
    }
    const avgDist = totalDist / peers.length;
    
    // 密度から全体のノード数 N を推定 (N ≈ 1 / dist)
    this.networkSize = Math.max(10, 1 / (avgDist * 2)); 

    // 設計書 §3.2 の数式に従い depth を決定
    const targetDepth = this.calculateTargetDepth(this.networkSize);

    // ヒステリシス (急激な変動を防ぐ)
    if (targetDepth > this._depth) {
        this._depth = targetDepth; // 上がる時は即座
        this.updateSubscriptionAfterScaleUp();
    } else if (targetDepth < this._depth) {
        // 下がる時はゆっくり（今回は簡易的に即時反映だが、本来は待機が必要）
        this._depth = targetDepth;
        this.initSubscribedZones();
    }
  }

  private calculateTargetDepth(size: number): number {
    if (size <= RING_MESH_ZONE.TARGET_ZONE_POP) return 0;
    const raw = Math.ceil(Math.log2(size / RING_MESH_ZONE.TARGET_ZONE_POP));
    return Math.max(0, Math.min(RING_MESH_ZONE.MAX_DEPTH, raw));
  }

  /**
   * K=16 匿名購読セットの初期化 (§4.1)
   */
  private initSubscribedZones() {
    // セッション中（または永続的に）固定するために localStorage を使用 (§7.2)
    const saved = localStorage.getItem('aether_subscribed_zones');
    if (saved) {
      try {
        const list = JSON.parse(saved) as number[];
        // depth が変わっている可能性があるので、現在の depth で正規化が必要
        this._subscribedZones = new Set(list.map(z => this.normalizeZone(z)));
        if (this._subscribedZones.size >= RING_MESH_ZONE.SUBSCRIBE_COUNT) return;
      } catch (e) {}
    }

    const zones = new Set<number>();
    const totalZones = 1 << this._depth;
    
    // 全ゾーン数 ≤ 16 なら全部購読
    if (totalZones <= RING_MESH_ZONE.SUBSCRIBE_COUNT) {
        for (let i = 0; i < totalZones; i++) zones.add(i);
    } else {
        // ダミーを追加して16個にする
        while (zones.size < RING_MESH_ZONE.SUBSCRIBE_COUNT) {
            zones.add(Math.floor(Math.random() * totalZones));
        }
    }

    this._subscribedZones = zones;
    this.saveSubscribedZones();
  }

  /**
   * depth が上がった際の追随 (§7.2 対策)
   * 既存の購読範囲の「子ゾーン」を優先して購読し、交差攻撃を防ぐ
   */
  private updateSubscriptionAfterScaleUp() {
    const newZones = new Set<number>();
    const totalZones = 1 << this._depth;

    for (const oldZone of this._subscribedZones) {
        // 古い Zone が depth n なら、新しい Zone は depth n+1
        // CIDR形式なので、1つ上のビットを維持したまま 0 と 1 の両方を購読候補にする
        const child1 = oldZone << 1;
        const child2 = (oldZone << 1) | 1;
        newZones.add(child1 % totalZones);
        if (newZones.size < RING_MESH_ZONE.SUBSCRIBE_COUNT) {
            newZones.add(child2 % totalZones);
        }
    }

    // 16個に満たない場合はランダム補充
    while (newZones.size < RING_MESH_ZONE.SUBSCRIBE_COUNT && newZones.size < totalZones) {
        newZones.add(Math.floor(Math.random() * totalZones));
    }

    this._subscribedZones = newZones;
    this.saveSubscribedZones();
  }

  private normalizeZone(zone: number): number {
    const totalZones = 1 << this._depth;
    return zone % (totalZones || 1);
  }

  private saveSubscribedZones() {
    localStorage.setItem('aether_subscribed_zones', JSON.stringify(Array.from(this._subscribedZones)));
  }
}
