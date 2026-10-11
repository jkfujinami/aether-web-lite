import type { IPeerManager, PeerId, GossipPacket, IMessageDispatcher, IZoneManager } from '../../types';
import { SeenCache } from './SeenCache';
import { PacketValidator } from './PacketValidator';
import type { DandelionRouter } from './DandelionRouter';
import type { OnionCircuit } from '../onion/OnionCircuit';
import { WireType } from '../wire/WireTypes';
import { createLogger } from '../../common/Logger';

const log = createLogger('net.gossip');

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
 *
 * ★ 平文 Stem は廃止した。作者の発信は {@link OnionCircuit} の固定長セルで運ばれ、
 *   出口が exit_fluff を受け取った時点で Fluff に入る。
 */
export class ZoneGossipRouter {
  /** 全隣人へ中継 (flood) 済みか。フラッディングの増幅を止める。 */
  private flooded = new SeenCache();
  /** UI (onMessage リスナー) へ渡し済みか。中継の可否とは独立に判定する。 */
  private delivered = new SeenCache();

  private listeners: Array<(packet: GossipPacket) => void> = [];

  constructor(
    private peerManager: IPeerManager,
    dispatcher: IMessageDispatcher,
    private zoneManager: IZoneManager,
    /** HintRouter / OnionCircuit と**同じインスタンス**を渡すこと (エコーと Guard を共有する) */
    private dandelion: DandelionRouter,
    /** 作者の発信はすべてこの回路に載せる */
    private circuit: OnionCircuit,
  ) {
    dispatcher.register(WireType.GOSSIP, (senderId, msg) => this.handleGossip(senderId, msg));
    circuit.onExit('exit_fluff', (payload) => {
      if (payload.type === 'exit_fluff') this.handleExitFluff(payload.packet);
    });
  }

  public onMessage(handler: (packet: GossipPacket) => void) {
    this.listeners.push(handler);
  }

  public offMessage(handler: (packet: GossipPacket) => void) {
    this.listeners = this.listeners.filter(h => h !== handler);
  }

  /**
   * 自己発信。
   *
   * ★ オニオン回路以外の経路は持たない (Fail-Closed)。
   *
   *   旧実装は「匿名化フラグ無しなら平文 flood」「隣人が 2 人未満なら平文 Stem」
   *   「失敗したら Guard を交代して再試行」という分岐を持っていた。どれも
   *   攻撃者が隣人を減らす・セルを捨てるだけで誘発でき、作者の IP から
   *   平文を出させるか、Guard の座を回させる手段になっていた。
   *
   * @param opts.slot 出口に本体の保管も任せる場合の Schrödinger Slot
   * @returns 網に現れたこと (エコー) を確認できたか
   */
  public async broadcast(
    packet: GossipPacket,
    opts: { slot?: { topicHash: string; hint: Uint8Array } } = {},
  ): Promise<boolean> {
    // ネットワークに流す前に、まず自分のUIに即座に通知する
    // (ゾーン購読に関係なく、自分の投稿は必ず自分に見える)
    this.delivered.add(packet.packet_id);
    this.listeners.forEach(cb => cb(packet));

    log.debug(() => `originating broadcast ${short(packet.packet_id)} via onion circuit`);
    const ok = await this.circuit.send(
      { type: 'exit_fluff', zoneId: packet.zone_id, packet, slot: opts.slot },
      packet.packet_id,
    );
    if (!ok) {
      log.error(`onion delivery failed for ${short(packet.packet_id)}; dropped (fail-closed, no plaintext fallback)`);
    }
    return ok;
  }

  /**
   * 出口として受け取ったパケットを Fluff (全体配信) する。
   */
  private handleExitFluff(packet: GossipPacket): void {
    if (!PacketValidator.validate(packet)) {
      log.debug(() => `exit fluff REJECTED (validate) ${short(packet?.packet_id)}`);
      return;
    }
    log.debug(() => `exit -> FLUFF zone=${packet.zone_id} ${short(packet.packet_id)}`);
    this.dandelion.notifyEcho(packet.packet_id);
    this.deliverLocal(packet);
    this.flood(packet, this.peerManager.myPeerId);
  }

  /**
   * ローカル配信の判断。ここだけがゾーン購読を見る。
   * 外部からは観測できない純粋にローカルな判断なので、交差攻撃の材料にならない。
   */
  private deliverLocal(packet: GossipPacket): void {
    if (this.delivered.has(packet.packet_id)) {
      log.trace(() => `deliver SKIP (already delivered) ${short(packet.packet_id)}`);
      return;
    }
    if (!this.zoneManager.isSubscribed(packet.zone_id)) {
      log.debug(() => `deliver DROP (zone not subscribed) ${short(packet.packet_id)} zone=${packet.zone_id} depth=${this.zoneManager.depth}`);
      return;
    }
    this.delivered.add(packet.packet_id);
    log.debug(() => `deliver -> ${this.listeners.length} listener(s) ${short(packet.packet_id)}`);
    this.listeners.forEach(cb => cb(packet));
  }

  /** ── Dispatcher Handlers ── */

  private handleGossip(senderId: PeerId, msg: any) {
    const packet = msg?.packet;
    log.trace(() => `GOSSIP from=${short(senderId)} ${short(packet?.packet_id)} zone=${packet?.zone_id}`);

    // 1. 基本検証 (CHK + PoW + サイズ + 時刻)。同期実行。
    if (!PacketValidator.validate(packet)) {
      log.debug(() => `GOSSIP REJECTED (validate) from=${short(senderId)} ${short(packet?.packet_id)}`);
      return;
    }

    // エコー通知は何よりも先に。ここで発信元の待ち合わせが解ける。
    this.dandelion.notifyEcho(packet.packet_id);

    // 2. ローカル配信 (購読ゾーンのみ)。中継状態とは独立に必ず試みる。
    this.deliverLocal(packet);

    // 3. 中継は購読状態に関係なく全隣人へ。
    //    ここを購読で分岐させると、その分岐自体が購読宣言になる。
    this.flood(packet, senderId);
  }

  /**
   * フラッディング。hop_count をインクリメントして全隣人へ転送する。
   *
   * 送信先をゾーンで絞らないのが要点 (Broadcast Veil)。
   * 同じパケットを二度中継しないための判定はここだけが行う (flooded)。
   */
  private flood(packet: GossipPacket, excludePeerId: PeerId) {
    if (this.flooded.has(packet.packet_id)) {
      log.trace(() => `flood SKIP (already flooded) ${short(packet.packet_id)}`);
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

/** ログ用の短縮表示。undefined でも落ちないようにしておく */
function short(id: string | undefined | null): string {
  return id ? id.substring(0, 8) : '?';
}
