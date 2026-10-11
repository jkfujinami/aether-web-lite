import type { IPeerManager, PeerId, GossipPacket, StemPacket } from '../../types';
import { WireType } from '../wire/WireTypes';
import { createLogger } from '../../common/Logger';
import { OnionRouter, type OnionHop } from '../../crypto/OnionRouter';
import { Encoding } from '../../common/Encoding';

const log = createLogger('net.dandelion');

/**
 * 仕様: docs/spec/step5_dandelion.md §「確定パラメータ」
 *
 * ★ stemTtl (ホップカウンタ) は廃止した。
 *
 * カウンタを平文でワイヤに載せると、それ自体が「経路上の位置」を漏らす:
 *
 *   - 発信元が送出しうる値 : {2, 3, 4}  (初期 TTL の乱択範囲)
 *   - 中継者が送出しうる値 : {0, 1, 2, 3} (受信値 - 1、上限 4)
 *
 *   → `stemTtl = 4` を受け取ったら、送信者は**発信元だと確定する**。
 *     初期 TTL の乱択は「自分が何番目か」を隠す意図だったが、
 *     上限値だけは発信元にしか出せないため確定オラクルになっていた。
 *     低い値も「中継者確定」を意味し、全域で情報が漏れる。
 *
 * 各ホップで独立に確率 p で Fluff へ移行する方式に変更した。
 * 経路長は幾何分布に従い**無記憶**なので、中継者は自分が何ホップ目かを
 * 推定する材料を一切持たない。本家 Dandelion++ がカウンタではなく
 * 確率を使っているのはこの理由による。
 *
 * 停止性:
 *   平均 1/p ホップ (p=0.3 で 3.33)、50 ホップ到達確率は 0.7^50 ≈ 2e-8。
 *   加えて PoW ヘッダの timestamp が MAX_TIME_DRIFT (15分) を超えると
 *   PacketValidator が落とすため、病的な循環も必ず止まる。
 */
export const DANDELION_CONFIG = {
  /**
   * 各ホップで Fluff に移行する確率。
   *
   * 経路長 = 幾何分布 (平均 1/p ホップ)。p=0.3 で平均 3.33 ホップとなり、
   * 仕様 §4.3 が想定する「2〜4 ホップ / 追加遅延 +120ms」にほぼ一致する。
   * Rust 側 (aether-cache) の FLUFF_PROBABILITY と必ず一致させること。
   */
  FLUFF_PROBABILITY: 0.3,
  EPOCH_DURATION: 10 * 60 * 1000,
  ECHO_TIMEOUT: 5000,
  MAX_RETRIES: 2,
  GUARD_PIN_DURATION: 15 * 60 * 1000,
};

/** エコー待ちのジッタ幅 (±20%) */
export const ECHO_TIMEOUT_JITTER = 0.2;

/**
 * エコー待ち時間にジッタを掛ける。
 *
 * 素の ECHO_TIMEOUT をそのまま使うと、再送の間隔がきっかり 5000ms になる。
 * 再送するのは発信元だけなので、この周期そのものが
 * 「このノードは中継ではなく作者だ」という指紋になる。
 * 幅を持たせて、ループで戻ってきた中継パケットの再転送と
 * 時間軸で切り分けられないようにする。
 */
export function jitteredEchoTimeout(): number {
  const base = DANDELION_CONFIG.ECHO_TIMEOUT;
  const rand = Math.random() || 0.001;
  const expOffset = -500 * Math.log(rand);
  const jitter = (Math.random() < 0.5 ? -1 : 1) * Math.min(1500, expOffset);
  return Math.round(Math.max(3000, Math.min(7500, base + jitter)));
}

type EchoCallback = () => void;

export class DandelionRouter {
  private stemTarget: PeerId | null = null;
  private stemTargetExpiry: number = 0;
  private pinnedGuardId: PeerId | null = null;
  private pinnedGuardExpiry: number = 0;
  private listeners: Map<string, Array<EchoCallback>> = new Map();
  private peerManager: IPeerManager;

  constructor(peerManager: IPeerManager) {
    this.peerManager = peerManager;
  }

  /**
   * 自己発信パケットのステム送信開始 (Onion Stem 優先)
   */
  public async publish(packet: GossipPacket, useDandelion: boolean = true): Promise<boolean> {
    const peersWithKeys = (this.peerManager as any)?.verifiedPeersWithKeys as OnionHop[] | undefined;
    if (useDandelion && peersWithKeys && peersWithKeys.length >= 2) {
      return this.publishOnion(packet, 2);
    }

    return this.publishVia(
      packet.packet_id,
      (target) => this.sendToPeer(target, { type: 'stem', zoneId: packet.zone_id, packet }),
      useDandelion,
    );
  }

  /**
   * 多段オニオン暗号化 (Onion Stem Routing) によるパケット発信
   *
   * 経路上の全ノードが共謀スパイでない限り、発信元IPとパケットID・内容の紐付けが不可能。
   */
  /**
   * 多段オニオン暗号化 (Onion Stem Routing) によるパケット発信
   *
   * 1. Guard Sticky Pinning: 第1ホップをエポック単位で固定し、長期統計的交差攻撃を遮断。
   * 2. Retransmission Guard Affinity: 出口ドロップ等の再送時も同一 Guard を維持し、Exit のみ交代。
   * 3. Fresh Ephemeral Re-wrapping: 試行ごとに新しい X25519 鍵で 3800B セルをゼロから再生成。
   *    ワイヤ上の暗号文はビットレベルで完全な無相関乱数となり、同一 Guard やスパイ網から
   *    「再送パケット」であること自体を不可視化する。
   */
  public async publishOnion(
    packet: GossipPacket,
    hopsCount: number = 2,
    explicitHops?: OnionHop[],
  ): Promise<boolean> {
    const directNeighbors = ((this.peerManager as any)?.verifiedPeersWithKeys as OnionHop[]) || [];
    if (!explicitHops && directNeighbors.length === 0) return false;

    // 第1ホップ (Guard Node) の選定
    let guardHop: OnionHop;
    if (explicitHops && explicitHops.length > 0) {
      guardHop = explicitHops[0];
    } else {
      const pinned = this.getPinnedGuard(directNeighbors);
      if (!pinned) return false;
      guardHop = pinned;
    }

    const triedExits = new Set<PeerId>();

    for (let attempt = 0; attempt < DANDELION_CONFIG.MAX_RETRIES; attempt++) {
      let selectedHops: OnionHop[];

      if (explicitHops && explicitHops.length > 0) {
        selectedHops = explicitHops;
      } else {
        // ★ Retransmission Guard Affinity:
        // 再送時も Guard は変更しない (Guard が生存している限り同一の隣人を維持)。
        // Guard が切断された場合のみフォールバック再選定する。
        if (!this.peerManager.peers.has(guardHop.peerId)) {
          const freshNeighbors = ((this.peerManager as any)?.verifiedPeersWithKeys as OnionHop[]) || [];
          const newGuard = this.getPinnedGuard(freshNeighbors);
          if (!newGuard) return false;
          guardHop = newGuard;
        }

        selectedHops = [guardHop];

        // 第2ホップ以降 (Relay / Exit) は、Guard 以外の候補から選定。
        // 再送時は前回試した Exit と異なるノードを優先して選択する。
        if (hopsCount > 1) {
          const exitCandidates = directNeighbors.filter(
            p => p.peerId !== guardHop.peerId && !triedExits.has(p.peerId)
          );
          const pool = exitCandidates.length > 0
            ? exitCandidates
            : directNeighbors.filter(p => p.peerId !== guardHop.peerId);

          if (pool.length > 0) {
            const exitHop = pool[Math.floor(Math.random() * pool.length)];
            triedExits.add(exitHop.peerId);
            selectedHops.push(exitHop);
          }
        }
      }

      // ★ Fresh Ephemeral Re-wrapping:
      // 試行ごとに新しい X25519 エフェメラル暗号化キーでセルをゼロから再ラッピング。
      // これにより、同一の Guard や同一の Exit を通過したとしても、
      // ワイヤ上の 3800B セルはビットレベルで完全な新規ランダム値となる。
      // 外部スパイや Guard ノードはこれが「再送パケット」であること自体を検知できない。
      const onionBytes = OnionRouter.wrapStem(packet, selectedHops);

      log.trace(() => `onion-stemming attempt ${attempt + 1}/${DANDELION_CONFIG.MAX_RETRIES} for ${packet.packet_id.substring(0, 8)} to guard ${guardHop.peerId.substring(0, 8)} (${selectedHops.length} hops)`);

      const echoPromise = this.waitForEcho(packet.packet_id);
      this.peerManager.sendMessage(guardHop.peerId, WireType.ONION_STEM, {
        onionBytes,
      });

      const echoed = await echoPromise;
      if (echoed) {
        log.debug(() => `onion-stem echo confirmed for ${packet.packet_id.substring(0, 8)} (attempt ${attempt + 1})`);
        return true;
      }

      log.debug(() => `onion-stem echo timeout for ${packet.packet_id.substring(0, 8)} (attempt ${attempt + 1}), retrying via fresh circuit`);
      // ★ 誣告攻撃 (Framing Attack) の遮断:
      // 多段オニオン暗号化経路では途中の Exit が故意破棄した場合でも Guard の過失に見えるため、
      // Guard にペナルティを課さない。
    }

    return false;
  }

  /**
   * ペイロードに依存しない Stem 発信。
   *
   * 「どのワイヤ形式で送るか」は呼び出し側が `send` の中で決める。
   * DandelionRouter は**経路の判断 (相手選び・エポック・再送・エコー待ち) だけ**を持つ。
   *
   * ★ Gossip も Hint も同じインスタンスに乗せること。
   *   別々の DandelionRouter を持たせるとエポック対象が 2 つになり、
   *   観測者に渡す辺が 1 本増えて §3.1 の前提 (作者パケットと中継パケットが
   *   同じ宛先へ行くので区別できない) が崩れる。
   *
   * @param id   エコー照合に使う識別子 (packet_id / hint id)
   * @param send 選ばれた相手へ実際に送る処理
   */
  public async publishVia(
    id: string,
    send: (target: PeerId) => void,
    useDandelion: boolean = true,
  ): Promise<boolean> {
    if (!useDandelion || this.peerManager.degree === 0) {
      return false;
    }

    // ★ 平文 Stem は 1 回だけ送り、再送しない。
    //
    //   再送は「発信元しか行わない」観測可能な振る舞いである。中継者は同じ id を
    //   再送しないので、「同じバイト列を数秒あけて別の隣人へ送るノード = 発信元」
    //   という指紋が成立し、攻撃者は Stem を握り潰すだけでこれを誘発できた。
    //
    // ★ タイムアウトでエポックを壊さない・隣人を罰しない。
    //
    //   旧実装はタイムアウトのたびに resetTarget() で Stem 先を引き直していた。
    //   これは getStemTarget のコメントが「対策済み」とするエポック破壊攻撃そのもので、
    //   下流の攻撃者は捨て続けるだけで「自分が Stem 先に選ばれる」まで
    //   引き直しを強制できた。さらに落としたのが下流でも、無実の直接の
    //   Stem 先に 25 点のペナルティが付き、4 回で正規の隣人が BAN された
    //   (陥れによる Eclipse)。どちらも削除した。
    const neighbors = Array.from(this.peerManager.peers.values())
      .filter(p => p.isConnected && p.isVerified)
      .map(p => p.peerId);
    if (neighbors.length === 0) return false;

    const target = this.getStemTarget(neighbors);
    // ★ 送信先 peerId は TRACE 止まり。Stem 先は経路情報そのもの。
    log.trace(() => `stemming ${id.substring(0, 8)} to ${target.substring(0, 8)}`);
    send(target);

    const echoed = await this.waitForEcho(id);
    if (echoed) {
      log.debug(() => `echo confirmed for ${id.substring(0, 8)}`);
    } else {
      log.debug(() => `echo timeout for ${id.substring(0, 8)} (no retransmission)`);
    }
    return echoed;
  }

  /**
   * 中継処理
   * @param senderId パケットを送ってきた隣人のID
   */
  /**
   * 発信用の Stem 先を 1 人選ぶ。隣人が居なければ null。
   *
   * ★ 発信時は確率 Fluff を引かない。
   *
   *   発信元が実行地点 (Fluff 地点) になってしまうと、Stem に載せた意味が
   *   丸ごと消える。中継者の判断 (`decideStem`) と発信の判断は別物。
   *   `publishVia` も同じ理由で必ず送出する。
   */
  public pickOriginTarget(): PeerId | null {
    // ★ 検証済み・接続中に限る。
    //   PUT の Stem にはエコー再送が無いので、死んだ相手や未検証の相手を
    //   選ぶとそこでデータが失われる (Gossip はエコー再送で復帰できる)。
    const neighbors = Array.from(this.peerManager.peers.values())
      .filter(p => p.isConnected && p.isVerified)
      .map(p => p.peerId);
    if (neighbors.length === 0) return null;
    return this.getStemTarget(neighbors);
  }

  /**
   * 中継の判断だけを行う (ペイロードを一切見ない)。
   *
   * ★ ホップカウンタは見ない (廃止済み)。各ホップで独立に確率を引くだけ。
   *   幾何分布は無記憶なので、この判定からは「経路上の位置」が漏れない。
   *   転送先がいない場合も Fluff に落とす (でないとパケットが黙って消える)。
   */
  public decideStem(senderId: PeerId): { action: 'fluff' } | { action: 'forward'; target: PeerId } {
    const neighbors = Array.from(this.peerManager.peers.keys())
        .filter(pid => pid !== senderId); // 送り主を候補から外す (§5.2)

    if (Math.random() < DANDELION_CONFIG.FLUFF_PROBABILITY || neighbors.length === 0) {
      return { action: 'fluff' };
    }
    return { action: 'forward', target: this.getStemTarget(neighbors, senderId) };
  }

  /** Gossip 用の薄いラッパ。判断は decideStem に委譲する。 */
  public handleStemPacket(senderId: PeerId, stem: StemPacket): { action: 'forward' | 'fluff', target?: PeerId, packet: GossipPacket | StemPacket } {
    const decision = this.decideStem(senderId);
    if (decision.action === 'fluff') {
      return { action: 'fluff', packet: { ...stem.packet, hop_count: 0 } };
    }
    // パケットは一切書き換えない —— 書き換える値があると、それが
    // 経路上の位置を示す手がかりになる。
    return { action: 'forward', target: decision.target, packet: stem };
  }

  /**
   * エコーを通知
   */
  public notifyEcho(packetId: string) {
    const key = `echo:${packetId}`;
    const callbacks = this.listeners.get(key);
    if (callbacks) {
      callbacks.forEach(cb => cb());
      this.listeners.delete(key);
    }
  }

  /**
   * Stem 先をエポック (10分) 固定で決める。
   *
   * ★ エポックの固定こそが匿名性の土台である (仕様 §3.1)。
   *   自分の書き込みも他人の中継も同じ宛先へ送られるからこそ、
   *   隣人から見て「作者パケット」と「中継パケット」が区別できない。
   *
   * ★ 攻撃: エポック破壊 (Epoch Churn)
   *   旧実装は「エポック対象が今回の候補に居ない/送り主本人」の場合に
   *   その場で再抽選し、**永続状態と 10 分タイマーごと上書き**していた。
   *   攻撃者は自分が対象になっている隣人へ Stem を送りつけるだけで
   *   相手のエポックを破壊でき、それを繰り返せば
   *   「自分が Stem 先に選ばれる」まで再抽選を強制できる。
   *   一度選ばれれば相手の自己発信パケットが直接自分に届く
   *   (first-spy) ため、特定率が設計値 (§4.1 の 3.3%) を大きく超える。
   *
   *   対策: 「今回だけ使えない」と「エポックが満了/対象が離脱した」を
   *   区別する。前者はこのパケット限りの代替で凌ぎ、エポックは温存する。
   */
  private getStemTarget(neighbors: PeerId[], excludeId?: PeerId): PeerId {
    const now = Date.now();

    // エポックが生きている条件は「期限内」かつ「対象がまだ接続中」。
    // 候補集合 (neighbors) は呼び出しごとに送り主を除いた一時的なものなので、
    // ここでエポックの生死を判定してはいけない。
    const target = this.stemTarget;
    const epochLive =
      target !== null &&
      now < this.stemTargetExpiry &&
      this.peerManager.peers.has(target);

    if (epochLive) {
      // 通常経路: エポック対象をそのまま使う
      if (target !== excludeId && neighbors.includes(target!)) {
        return target!;
      }
      // 今回だけ使えない (送り主本人など)。エポックは壊さず、
      // このパケット限りの代替を選ぶ。
      if (neighbors.length > 0) {
        return neighbors[Math.floor(Math.random() * neighbors.length)];
      }
    }

    // エポック満了、または対象が離脱した → 新しいエポックを開始
    this.stemTarget = neighbors[Math.floor(Math.random() * neighbors.length)];
    this.stemTargetExpiry = now + DANDELION_CONFIG.EPOCH_DURATION;
    return this.stemTarget;
  }

  /** テストまたは特定環境向けのエコータイムアウト上書き (ms) */
  public echoTimeoutMs?: number;

  /**
   * Guard Sticky Pinning:
   * 直結隣人から第1ホップ (Guard) を選定し、エポック期間 (または切断されるまで) 固定する。
   * これにより、同一ノードから連続投稿した際の Guard 接触頻度の偏りによる
   * 長期統計的交差攻撃 (Statistical Disclosure / Intersection Attack) を防護する。
   */
  public getPinnedGuard(candidates: OnionHop[]): OnionHop | null {
    const now = Date.now();
    const isLive =
      this.pinnedGuardId !== null &&
      now < this.pinnedGuardExpiry &&
      this.peerManager.peers.has(this.pinnedGuardId) &&
      candidates.some(c => c.peerId === this.pinnedGuardId);

    if (isLive) {
      return candidates.find(c => c.peerId === this.pinnedGuardId)!;
    }

    if (candidates.length === 0) return null;
    const selected = candidates[Math.floor(Math.random() * candidates.length)];
    this.pinnedGuardId = selected.peerId;
    this.pinnedGuardExpiry = now + DANDELION_CONFIG.GUARD_PIN_DURATION;
    return selected;
  }

  public getPinnedGuardId(): PeerId | null {
    return this.pinnedGuardId;
  }

  public resetPinnedGuard(): void {
    this.pinnedGuardId = null;
    this.pinnedGuardExpiry = 0;
  }

  private async waitForEcho(packetId: string): Promise<boolean> {
    const key = `echo:${packetId}`;
    const timeoutDuration = this.echoTimeoutMs ?? jitteredEchoTimeout();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        // 自分のコールバックだけを外す。キーごと消すと、同じ id を待つ
        // 他の待機者のエコーまで取りこぼす。
        const remaining = (this.listeners.get(key) ?? []).filter(cb => cb !== callback);
        if (remaining.length > 0) this.listeners.set(key, remaining);
        else this.listeners.delete(key);
        resolve(false);
      }, timeoutDuration);

      const callback = () => {
        clearTimeout(timeout);
        resolve(true);
      };

      if (!this.listeners.has(key)) {
        this.listeners.set(key, []);
      }
      this.listeners.get(key)!.push(callback);
    });
  }

  private sendToPeer(targetId: PeerId, stem: StemPacket) {
    this.peerManager.sendMessage(targetId, WireType.STEM, stem);
  }
}
