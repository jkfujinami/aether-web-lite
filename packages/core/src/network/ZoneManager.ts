import { RING_MESH_ZONE } from '../constants';
import type { IPeerManager } from '../types';
import sodium from '../crypto/sodium';
import { KeyManager } from '../crypto/KeyManager';

/** 0 ≤ r < n の一様乱数 (CSPRNG)。購読セットは推測されない方がよい */
function randomBelow(n: number): number {
  return sodium.randombytes_uniform(n);
}

/**
 * ZoneManager: Adaptive Zone の状態・購読セット・Depth管理。
 * ネットワークの規模に応じて「ゾーンの深さ」を自律合意し、
 * 自分が担当する K=16 個の匿名購読セットを維持する。
 */
export class ZoneManager {
  private _depth: number = 0;
  private _subscribedZones: Set<number> = new Set();
  /** 利用者が今見ている板・スレッドのトピック (参照カウント付き) */
  private watched = new Map<string, { topic: Uint8Array; refs: number }>();
  private peerManager: IPeerManager;
  private networkSize: number = 10; // 初期推定値
  private depthDecreaseTimer: ReturnType<typeof setTimeout> | null = null;
  private recomputeTimer: ReturnType<typeof setInterval>;

  constructor(peerManager: IPeerManager) {
    this.peerManager = peerManager;
    this.initSubscribedZones();

    // 1分ごとに depth を再計算 (§5.7)
    this.recomputeTimer = setInterval(() => this.recomputeDepth(), 60_000);
  }

  public destroy(): void {
    clearInterval(this.recomputeTimer);
    if (this.depthDecreaseTimer) clearTimeout(this.depthDecreaseTimer);
    this.depthDecreaseTimer = null;
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

    if (this._subscribedZones.has(zoneId)) return true;
    // 見ているトピックは、どの depth で作られたパケットでも受け取る。
    // depth は各ノードが自分の隣人から推定するので、送り手と自分で食い違うことがある
    // (境界付近や、下降を 5 分待つ間)。パケットは作ったときの depth を運ばないので、
    // 全ての depth で照合する。余分に一致しても、鍵で開けられなければ捨てられるだけ。
    for (const { topic } of this.watched.values()) {
      for (let d = 0; d <= RING_MESH_ZONE.MAX_DEPTH; d++) {
        if (KeyManager.computeZoneId(topic, d) === zoneId) return true;
      }
    }
    return false;
  }

  /**
   * 今見ている板・スレッドのトピックを購読に加える。
   *
   * ★ 旧実装には自分の板・スレッドのゾーンを購読に加える手段が無く、depth 5 以上
   *   (ゾーン数 > 16) になると、開いている板の投稿がランダムな 16 ゾーンに入らない限り
   *   画面に届かなかった。
   *   購読は「画面に渡すか」の完全にローカルな判断で、中継は購読と無関係に全隣人へ
   *   流す (ZoneGossipRouter)。ここで加えても網からは観測できない。
   */
  public watchTopic(topicHash: Uint8Array): () => void {
    const key = Array.from(topicHash.subarray(0, 32), (b) => b.toString(16).padStart(2, '0')).join('');
    const entry = this.watched.get(key);
    if (entry) entry.refs++;
    else this.watched.set(key, { topic: topicHash.slice(0, 32), refs: 1 });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const e = this.watched.get(key);
      if (!e) return;
      if (--e.refs <= 0) this.watched.delete(key);
    };
  }

  /**
   * ネットワークサイズを推定し、depth を更新する (§3.4)
   * 隣人の Ring 密度が高いほど、ネットワーク全体が巨大であると推定する。
   */
  /**
   * 密度からネットワーク規模を推定するのに必要な最小ピア数。
   *
   * ピアが 2〜3 台しかいないと、たまたま座標が近いだけで
   * 「巨大ネットワークだ」と誤推定し、depth が跳ね上がる。
   * depth が 5 以上になると isSubscribed() が実際にフィルタを始めるため、
   * **少人数の網で受信パケットが黙って捨てられる**という分かりにくい壊れ方をする。
   * 標本が足りないうちは depth 0 (全ゾーン購読 = Broadcast Veil) のままにする。
   */
  private static readonly MIN_PEERS_FOR_ESTIMATE = 8;

  private recomputeDepth() {
    const peers = Array.from(this.peerManager.peers.values());
    if (peers.length < ZoneManager.MIN_PEERS_FOR_ESTIMATE) return;

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

    // ヒステリシス: 上昇は即座、下降は5分待機 (仕様書 IMPORTANT #9 / zone §7.1)
    if (targetDepth > this._depth) {
      // 上昇時: 即座に適用 & 下降タイマーをキャンセル
      if (this.depthDecreaseTimer) {
        clearTimeout(this.depthDecreaseTimer);
        this.depthDecreaseTimer = null;
      }
      const oldDepth = this._depth;
      this._depth = targetDepth;
      this.updateSubscriptionAfterScaleUp(oldDepth);
    } else if (targetDepth < this._depth) {
      // 下降時: 5分待機してから1段階だけ下げる（振動防止）
      if (!this.depthDecreaseTimer) {
        this.depthDecreaseTimer = setTimeout(() => {
          this.depthDecreaseTimer = null;
          this._depth = Math.max(0, this._depth - 1);
          this.initSubscribedZones();
        }, 5 * 60 * 1000);
      }
    } else {
      // depth 変化なし: 保留中の下降タイマーをキャンセル
      if (this.depthDecreaseTimer) {
        clearTimeout(this.depthDecreaseTimer);
        this.depthDecreaseTimer = null;
      }
    }
  }

  private calculateTargetDepth(size: number): number {
    if (size <= RING_MESH_ZONE.TARGET_ZONE_POP) return 0;
    const raw = Math.ceil(Math.log2(size / RING_MESH_ZONE.TARGET_ZONE_POP));
    return Math.max(0, Math.min(RING_MESH_ZONE.MAX_DEPTH, raw));
  }

  /**
   * K=16 匿名購読セットの初期化 (§4.1)
   *
   * ★ 購読セットは端末に保存しない。
   *   旧実装は localStorage に平文で永続化していた。購読は今や「UI に渡すか」の
   *   完全にローカルな判断で網には一切申告しない (Broadcast Veil) ので、
   *   セッションを跨いで固定する利点は無く、押収時の痕跡が増えるだけだった。
   *   旧版が残した値は消す。
   */
  private initSubscribedZones() {
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem('aether_subscribed_zones');
    } catch {}

    const zones = new Set<number>();
    const totalZones = 1 << this._depth;

    // 全ゾーン数 ≤ 16 なら全部購読
    if (totalZones <= RING_MESH_ZONE.SUBSCRIBE_COUNT) {
        for (let i = 0; i < totalZones; i++) zones.add(i);
    } else {
        // ダミーを追加して16個にする
        while (zones.size < RING_MESH_ZONE.SUBSCRIBE_COUNT) {
            zones.add(randomBelow(totalZones));
        }
    }

    this._subscribedZones = zones;
  }

  /**
   * depth が上がった際の追随 (§7.2 対策)。
   *
   * 既存の各購読ゾーンから「子ゾーンを 1 つずつ」選んで引き継ぎ、件数は 16 のまま保つ。
   *
   * ★ 旧実装は各ゾーンの子を 2 つとも足そうとしていたため 16 を超え (depth 6→7 で 24)、
   *   複数段の上昇でも 1 段分のシフト (oldZone << 1) しかしておらず、子ではない
   *   ゾーンを選んでいた。
   */
  private updateSubscriptionAfterScaleUp(oldDepth: number) {
    const totalZones = 1 << this._depth;
    if (totalZones <= RING_MESH_ZONE.SUBSCRIBE_COUNT) {
      this.initSubscribedZones();
      return;
    }
    const shift = this._depth - oldDepth;
    const newZones = new Set<number>();

    for (const oldZone of this._subscribedZones) {
      if (newZones.size >= RING_MESH_ZONE.SUBSCRIBE_COUNT) break;
      newZones.add((oldZone << shift) | randomBelow(1 << shift));
    }

    // 16 個に満たない場合はランダム補充
    while (newZones.size < RING_MESH_ZONE.SUBSCRIBE_COUNT) {
      newZones.add(randomBelow(totalZones));
    }

    this._subscribedZones = newZones;
  }
}
