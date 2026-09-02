import type { IPeerManager, PeerId, GossipPacket, StemPacket, IMessageDispatcher, IZoneManager } from '../../types';
import { SeenCache } from './SeenCache';
import { PacketValidator } from './PacketValidator';
import { DandelionRouter } from './DandelionRouter';
import { WireType } from '../wire/WireTypes';

/**
 * ZoneGossipRouter
 *
 * ★ 購読宣言の撤去 (本家 AETHER 18.6.2)
 *
 * 旧実装は 2 つの経路でゾーン購読を漏らしていた:
 *
 *   1. flood() が `peer.zones.has(zone_id)` で送信先を絞っていた。
 *      つまり全隣人に「自分がどのゾーンを購読しているか」を申告し、
 *      JOIN / PEX / トラッカーがその配列を運んでいた。
 *   2. 購読外のパケットを中継せずに握り潰していた。攻撃者はゾーン Z の
 *      プローブパケットを送り、それが転送されるかどうかを観察するだけで
 *      「この隣人は Z を購読しているか」を判定できた。
 *
 *   ZoneManager は購読セットを localStorage に永続化しているため、
 *   この情報はセッションを跨いで不変であり、長期の交差攻撃で
 *   「誰がどのスレッドを読んでいるか」が特定できた。
 *   設計書が「購読宣言の完全廃止」と書いている内容と実装が真逆だった。
 *
 * 現在の挙動 (Broadcast Veil):
 *   - 中継は無条件に全隣人へ行う。転送するかどうかが購読状態に依存しない。
 *   - ゾーンによるフィルタは「UI に渡すかどうか」だけに使う。これは
 *     完全にローカルな判断で、外から観測できない。
 *
 *
 * ★ パケット単位の状態は用途ごとに分けて持つ (旧実装は 1 つに混ぜていた)
 *
 * 旧実装は `seenCache` ひとつで「中継したか」「Stem を裁いたか」
 * 「UI に届けたか」の 3 つを兼用しており、これが小規模網で
 * ゴシップが一切画面に出ない原因になっていた。実際の壊れ方:
 *
 *   1. A が broadcast → 自分の packet_id を seenCache に入れる
 *   2. A --stem--> B --stem--> C --stem--> A  (小規模網では必ず発信元へ戻る)
 *   3. A は「もう seenCache にある」として **黙って捨てる**
 *      → 誰も Fluff しない → ネットワークに一度も広まらない
 *   4. エコーが返らないので A は 5 秒ごとに再送するが、
 *      B も C も already-seen で捨てるため、Stem は 1 ホップも進まない
 *   5. 15 秒かけてリトライを使い切り、ようやく publish() が false を返し
 *      broadcast() の fallback flood で GOSSIP が直送される
 *
 * 現在は用途ごとに分離してある:
 *   - `flooded`   … 全隣人へ中継済みか (フラッディングの増幅を止める)
 *   - `delivered` … UI へ渡し済みか (中継の可否とは独立)
 *   - Stem は**どちらでも重複排除しない** (仕様 §8.2)。
 *     停止性は TTL の単調減少が担保する。ここで既読判定を入れると
 *     「既に知っていたか」を外から観測できるオラクルになり、
 *     Stem 経路 (2〜4 ノード) の特定 = 発信元特定に直結する。
 */
export class ZoneGossipRouter {
  /** 全隣人へ中継 (flood) 済みか。フラッディングの増幅を止める。 */
  private flooded = new SeenCache();
  /** UI (onMessage リスナー) へ渡し済みか。中継の可否とは独立に判定する。 */
  private delivered = new SeenCache();

  private listeners: Array<(packet: GossipPacket) => void> = [];
  private dandelion: DandelionRouter;
  private peerManager: IPeerManager;
  private zoneManager: IZoneManager;

  constructor(peerManager: IPeerManager, dispatcher: IMessageDispatcher, zoneManager: IZoneManager) {
    this.peerManager = peerManager;
    this.zoneManager = zoneManager;
    this.dandelion = new DandelionRouter(peerManager);

    dispatcher.register(WireType.GOSSIP, (senderId, msg) => this.handleGossip(senderId, msg));
    dispatcher.register(WireType.STEM, (senderId, msg) => this.handleStem(senderId, msg));
  }

  public onMessage(handler: (packet: GossipPacket) => void) {
    this.listeners.push(handler);
  }

  public offMessage(handler: (packet: GossipPacket) => void) {
    this.listeners = this.listeners.filter(h => h !== handler);
  }

  /**
   * 自己発信またはUIからの手動再送
   */
  public async broadcast(packet: GossipPacket, useDandelion: boolean = true): Promise<void> {
    // ネットワークに流す前に、まず自分のUIに即座に通知する
    // (ゾーン購読に関係なく、自分の投稿は必ず自分に見える)
    this.delivered.add(packet.packet_id);
    this.listeners.forEach(cb => cb(packet));

    console.log(`[GossipRouter] Originating broadcast: ${packet.packet_id.substring(0, 8)} (Zone: ${packet.zone_id})`);

    // 1. Dandelion++ Stem 送信を試みる (匿名化)
    const echoed = await this.dandelion.publish(packet, useDandelion);
    if (echoed) return;

    // 2. Stem 失敗または不使用時は直接 Fluff (全体放送)
    this.flood(packet, this.peerManager.myPeerId);
  }

  /**
   * Fluff (拡散フェーズ) へ移行する。
   * ローカル配信と中継はそれぞれ独立に冪等なので、何度呼んでも安全。
   */
  private fluffToZone(packet: GossipPacket): void {
    console.log(`[TRACE:2.5-fluffToZone] packet_id=${packet?.packet_id?.substring(0, 8)}`);
    // Fluff 移行時にも必ず検証する。Stem 経路から入ってきた不正パケットを
    // ここで網に掛けないと、Fluff 地点が増幅器になる。
    if (!PacketValidator.validate(packet)) {
      console.log(`[TRACE:2.5-fluffToZone] REJECTED by PacketValidator.validate packet_id=${packet?.packet_id?.substring(0, 8)}`);
      return;
    }

    // ★ エコーは「パケットが Fluff 段階に入った」ことの確認なので、
    //   自分自身が Fluff した時点で確定させる。
    //
    //   flood() は送信元を除外するため、自分が撒いた Fluff は隣人同士で
    //   転送し合うだけで自分には返ってこない。handleGossip でしか
    //   notifyEcho を呼んでいないと、自分で Fluff したのにエコーが返らず、
    //   発信元が 5 秒 × 3 回のリトライを空回りさせることになる。
    this.dandelion.notifyEcho(packet.packet_id);

    this.deliverLocal(packet);
    this.flood(packet, this.peerManager.myPeerId);
  }

  /**
   * ローカル配信の判断。ここだけがゾーン購読を見る。
   * 外部からは観測できない純粋にローカルな判断なので、交差攻撃の材料にならない。
   *
   * 「UI へ届けたか」の判定はこのメソッドだけが行う (delivered)。
   * 呼び出し元は中継状態を気にせず毎回呼んでよい。
   */
  private deliverLocal(packet: GossipPacket): void {
    if (this.delivered.has(packet.packet_id)) {
      console.log(`[TRACE:3-deliverLocal] SKIPPED already delivered to UI packet_id=${packet.packet_id.substring(0, 8)}`);
      return;
    }
    if (!this.zoneManager.isSubscribed(packet.zone_id)) {
      console.log(`[TRACE:3-deliverLocal] DROPPED (zone not subscribed) packet_id=${packet.packet_id.substring(0, 8)} zone=${packet.zone_id} depth=${this.zoneManager.depth}`);
      return;
    }
    this.delivered.add(packet.packet_id);
    console.log(`[TRACE:3-deliverLocal] delivering to ${this.listeners.length} listener(s) packet_id=${packet.packet_id.substring(0, 8)}`);
    this.listeners.forEach(cb => cb(packet));
  }

  /** ── Dispatcher Handlers ── */

  private handleGossip(senderId: PeerId, msg: any) {
    const packet = msg?.packet;
    console.log(`[TRACE:2-handleGossip] from=${senderId.substring(0, 8)} packet_id=${packet?.packet_id?.substring(0, 8)} zone=${packet?.zone_id}`);

    // 1. 基本検証 (CHK + PoW + サイズ + 時刻)。同期実行。
    if (!PacketValidator.validate(packet)) {
      console.log(`[TRACE:2-handleGossip] REJECTED by PacketValidator.validate packet_id=${packet?.packet_id?.substring(0, 8)}`);
      return;
    }

    // エコー通知 (Dandelion用) は何よりも先に。ここで発信元のリトライが止まる。
    this.dandelion.notifyEcho(packet.packet_id);

    // 2. ローカル配信 (購読ゾーンのみ)。中継状態とは独立に必ず試みる。
    this.deliverLocal(packet);

    // 3. 中継は購読状態に関係なく全隣人へ。
    //    ここを購読で分岐させると、その分岐自体が購読宣言になる。
    this.flood(packet, senderId);
  }

  private handleStem(senderId: PeerId, msg: any) {
    const stem = msg as StemPacket;
    const packet = stem?.packet;
    console.log(`[TRACE:2-handleStem] from=${senderId.substring(0, 8)} packet_id=${packet?.packet_id?.substring(0, 8)} zone=${stem?.zoneId}`);

    // Stem 経路にも同じ検証を掛ける。旧実装は Stem 受信時に検証しておらず、
    // 不正パケットが Fluff 地点まで無検査で運ばれていた。
    if (!PacketValidator.validate(packet)) {
      console.log(`[TRACE:2-handleStem] REJECTED by PacketValidator.validate packet_id=${packet?.packet_id?.substring(0, 8)}`);
      return;
    }

    // ★ Stem では packet_id による重複排除を一切しない (仕様 §8.2)。
    //
    //   停止性は各ホップの確率判定が担保する。経路長は幾何分布に従い
    //   平均 1/FLUFF_PROBABILITY ホップ (p=0.3 で 3.33)、50 ホップ到達確率は
    //   0.7^50 ≈ 2e-8。加えて timestamp が MAX_TIME_DRIFT (15分) を超えると
    //   PacketValidator が落とすため、病的な循環も必ず止まる。
    //   増幅も起きない (Stem は 1 通受けて 1 通出すだけで、
    //   Fluff 側の増幅は flooded キャッシュが 1 回に抑える)。
    //
    //   ここで「見たことがあるか」で分岐してはいけない。分岐させると、
    //   攻撃者が任意のパケットを Stem として送りつけ、相手が即座に Fluff
    //   (= 全隣人へのブロードキャスト) を返すかどうかを見るだけで
    //   「この相手はそのパケットを既に知っていたか」を判定できてしまう。
    //   Stem 経路は 2〜4 ノードしかないため、これは発信元特定に直結する。
    //   加えて、自分の Stem が一周して戻ってきたときに自分が Fluff すると、
    //   発信元自身が Fluff 地点 (hop_count=0 の出所) になり、
    //   Dandelion++ の目的そのものが無効になる。
    const decision = this.dandelion.handleStemPacket(senderId, stem);
    console.log(`[TRACE:2-handleStem] decision=${decision.action} target=${decision.target?.substring(0, 8)} packet_id=${packet.packet_id.substring(0, 8)}`);

    if (decision.action === 'fluff') {
      console.log(`[Dandelion] Fluffing stem packet into zone ${packet.zone_id}`);
      this.fluffToZone(decision.packet as GossipPacket);
    } else if (decision.action === 'forward' && decision.target) {
      this.peerManager.sendMessage(decision.target, WireType.STEM, decision.packet);
    }
  }

  /**
   * フラッディング。hop_count をインクリメントして全隣人へ転送する。
   *
   * 送信先をゾーンで絞らないのが要点 (Broadcast Veil)。
   * 同じパケットを二度中継しないための判定はここだけが行う (flooded)。
   */
  private flood(packet: GossipPacket, excludePeerId: PeerId) {
    if (this.flooded.has(packet.packet_id)) {
      console.log(`[TRACE:2.7-flood] SKIPPED already flooded packet_id=${packet.packet_id.substring(0, 8)}`);
      return;
    }

    const relayPacket: GossipPacket = { ...packet, hop_count: packet.hop_count + 1 };

    // hop_count 上限に達したパケットはここで止める
    if (relayPacket.hop_count > PacketValidator.MAX_HOP_COUNT) return;

    this.flooded.add(packet.packet_id);
    const payload = { packet: relayPacket };

    for (const peer of this.peerManager.peers.values()) {
      if (peer.peerId === excludePeerId) continue;
      if (!peer.isConnected || !peer.isVerified) continue;
      this.peerManager.sendMessage(peer.peerId, WireType.GOSSIP, payload);
    }
  }

  public destroy() {
    this.flooded.destroy();
    this.delivered.destroy();
  }
}
