import type { IPeerManager, PeerId, IMessageDispatcher } from '../../types';
import type { DandelionRouter } from '../gossip/DandelionRouter';
import { SeenCache } from '../gossip/SeenCache';
import { WireType } from '../wire/WireTypes';
import { createLogger } from '../../common/Logger';
import type { OnionCircuit } from '../onion/OnionCircuit';
import {
  decodeHint,
  encodeHint,
  HINT_INITIAL_TTL,
  hintId,
  parseHintPacket,
  verifyHintPow,
  type HintPacket,
} from './HintPacket';
import { openHint, type HintPayload } from './HintCrypto';

const log = createLogger('net.hint');

/**
 * 開けなかった Hint を手元に残す上限。
 * 1 件あたり ~90 バイトなので、2000 件で ~180KB。
 */
export const RECENT_HINT_BUFFER = 2000;

/** 復号できた Hint の通知 */
export interface OpenedHint {
  payload: HintPayload;
  /** どの鍵で開いたか (呼び出し側が板/スレッドを引き当てるための目印) */
  keyId: string;
  packet: HintPacket;
}

/**
 * HintRouter — Schrödinger Mailbox の索引配送
 *
 * ★ Gossip と同じ Broadcast Veil に載せる
 *
 * 全ノードが全 Hint を受け取り、**手元でだけ**試行復号する。
 * 「どの Hint に興味があるか」を外に一切申告しないので、
 * 受信者匿名性が情報理論的に成立する (§18.8.4)。
 * ZoneGossipRouter と同じ理由で、中継はゾーンや購読で分岐させない。
 *
 * ★ 中継と配信でキャッシュを分ける
 *
 * ZoneGossipRouter で踏んだのと同じ罠を避ける。「中継したか」と
 * 「UI に渡したか」を 1 つの Set で兼ねると、中継役を担っただけで
 * 以後そのパケットを自分に配信できなくなる。
 */
export class HintRouter {
  /** 全隣人へ中継済みか。フラッディングの増幅を止める。 */
  private flooded = new SeenCache();
  /** 網から受け取った Hint の id (同じ Hint の 2 通目以降を数えない・溜めないため) */
  private received = new SeenCache();
  /** 復号して通知済みか。中継の可否とは独立に判定する。 */
  private delivered = new SeenCache();

  /** 試行復号に使う鍵。keyId -> K */
  private keys = new Map<string, Uint8Array>();
  /**
   * 最近見た Hint (不透明なまま保持)。
   *
   * ★ これが無いと「鍵を持つ前に届いた Hint」が永久に失われる。
   *
   *   Broadcast Veil により全 Hint は常に流れてくるが、その時点で鍵を
   *   持っていなければ開けない。後から板を開いた瞬間に、既に流れ終わった
   *   Hint は二度と来ない (再放流を待つと最大 20 分)。
   *   鍵が増えたときに再試行できるよう、生のまま手元に置いておく。
   *
   *   中身は復号していないので、これを持つこと自体は何も意味しない。
   */
  private recentHints: HintPacket[] = [];
  /** recentHints に入っている Hint の id (同じ Hint を 2 つ溜めない) */
  private recentIds = new Set<string>();
  private listeners: Array<(hint: OpenedHint) => void> = [];
  private anyHintListeners: Array<() => void> = [];

  constructor(
    private peerManager: IPeerManager,
    dispatcher: IMessageDispatcher,
    /**
     * Gossip と**同じインスタンス**を渡すこと。
     * 別インスタンスにするとエポック対象が 2 つになり、
     * 観測者に渡す辺が 1 本増える (§3.1 の前提が崩れる)。
     */
    private dandelion: DandelionRouter,
    /** 作者の Hint はこの回路で出口まで運ぶ */
    private circuit: OnionCircuit,
  ) {
    dispatcher.register(WireType.HINT, (senderId, msg) => this.handleHint(senderId, msg));
    circuit.onExit('exit_hint', (payload) => {
      if (payload.type === 'exit_hint') this.handleExitHint(payload.hint);
    });
  }

  /**
   * 試行復号の対象に鍵を加える。
   *
   * 板やスレッドを開いたときに呼ぶ。手持ちの鍵 1 つにつき
   * Hint 1 通あたり HMAC 1 回のコストなので、数十個までは無視できる。
   */
  public addKey(keyId: string, k: Uint8Array): void {
    this.keys.set(keyId, k);
    log.debug(() => `key added: ${keyId} (total=${this.keys.size})`);

    // ★ 鍵が増えたら、手元に溜めてある Hint を открыть し直す。
    //   「板を開いた瞬間に、それまでに流れた Hint が全部見える」ために必要。
    let opened = 0;
    for (const hint of this.recentHints) {
      const id = hintId(hint);
      if (this.delivered.has(id)) continue;
      if (this.tryOpen(hint, id)) opened++;
    }
    if (opened > 0) log.debug(() => `re-opened ${opened} buffered hint(s) with ${keyId}`);
  }

  public removeKey(keyId: string): void {
    if (this.keys.delete(keyId)) {
      log.debug(() => `key removed: ${keyId} (total=${this.keys.size})`);
    }
  }

  /**
   * 復号できたかに関わらず、Hint を 1 件観測したことを通知する。
   *
   * 放流タイミングの逆算に使う観測レートは、Broadcast Veil のおかげで
   * **ローカルで直接測れる** (全 Hint が自分に届くため)。
   * 他の設計では得られない性質。
   */
  public onAnyHint(handler: () => void): void {
    this.anyHintListeners.push(handler);
  }

  public onHint(handler: (hint: OpenedHint) => void): void {
    this.listeners.push(handler);
  }

  public offHint(handler: (hint: OpenedHint) => void): void {
    this.listeners = this.listeners.filter(h => h !== handler);
  }

  /**
   * 自分が作った Hint をネットワークへ放流する。
   *
   * ★ 必ずオニオン回路を通す。
   *
   *   直接 flood すると、隣人から見て「この IP が発信元」が確定する。
   *   Hint は mailbox_key の在り処を運ぶので、発信元が割れることは
   *   「誰がその投稿を書いたか」が割れることと同じになる。
   *   旧実装は平文 Stem (HINT_STEM) で運び、失敗時は直接 flood に落ちていた。
   *
   * ★ Fail-Closed: 回路で届かなくても平文には落とさない。
   *   Hint は Slot に同梱されて保管されるため、保持者の再放流 (§18.3-A) で
   *   後から必ず配られる。可用性の損失は遅延だけ。
   *
   * @returns 網に現れたこと (エコー) を確認できたか
   */
  public async originate(hint: HintPacket, id: string): Promise<boolean> {
    // 自分が作ったものを自分に通知しても意味が無い。戻ってきたときの
    // 二重通知も防げる。中継の記録 (flooded) はここでは触らない。
    this.delivered.add(id);
    log.debug(() => `originating hint ${id.substring(0, 8)} via onion circuit`);

    const echoed = await this.circuit.send({ type: 'exit_hint', hint: encodeHint(hint) }, id);
    if (!echoed) {
      log.warn(`hint delivery failed for ${id.substring(0, 8)}; dropping (fail-closed, holders will reflood)`);
    }
    return echoed;
  }

  /**
   * 出口として受け取った Hint を全体配信へ移す。
   */
  private handleExitHint(bytes: Uint8Array): void {
    const hint = decodeHint(bytes);
    if (!hint) {
      log.debug(() => `exit hint REJECTED (malformed)`);
      return;
    }
    if (!verifyHintPow(hint)) {
      log.debug(() => `exit hint REJECTED (pow)`);
      return;
    }
    const id = hintId(hint);
    // 自分で Fluff した時点でエコーを確定させる (flood は自分に返ってこない)
    this.dandelion.notifyEcho(id);
    this.remember(hint);
    this.tryOpen(hint, id);
    this.flood(hint, this.peerManager.myPeerId);
  }

  /**
   * 保持者による Hint の再放流 (§18.3-A)。
   *
   * ★ Stem を通さない。
   *
   *   保持者は発信元ではないので隠すものが無い。むしろ
   *   「コンテンツと無関係なランダムな保持者が流している」ことそのものが
   *   一次放流者の情報量を下げる仕組みになっている。
   *   Winny の主要検挙経路だった「新規キーの初出ノード = 一次放流者」は
   *   t=0 の一瞬しか観測機会がなく、再放流が始まると成立しなくなる。
   *
   * 既に中継済みのものは flood 側で畳まれるので、何度呼んでも安全。
   */
  public reflood(hint: HintPacket): void {
    const id = hintId(hint);
    log.trace(() => `reflood ${id.substring(0, 8)}`);
    this.flood(hint, this.peerManager.myPeerId);
  }

  /**
   * 特定の相手にだけ Hint を送る (新規接続時のバックログ用)。
   *
   * 全体へ撒くわけではないので `flooded` は触らない。
   * 受け手側は通常の HINT として扱い、そこから先は普通に中継される。
   */
  public sendTo(peerId: PeerId, hint: HintPacket): void {
    const peer = this.peerManager.peers.get(peerId);
    if (!peer || !peer.isConnected || !peer.isVerified) return;
    this.peerManager.sendMessage(peerId, WireType.HINT, hint);
  }

  /**
   * ネットワーク経由ではなく、手元で得た Hint を取り込む。
   *
   * ★ 中継はしない。
   *
   *   保管した Slot から取り出した索引がこれにあたる。既にネットワークを
   *   流れてきたものなので、ここから撒き直すと二重に配ることになる。
   *   やりたいのは「自分が開けるか試す」ことだけ。
   *
   *   これが無いと、**本体は複製で届いて保管されているのに、
   *   索引が別経路で来るまで画面に出ない**という状態になる。
   */
  public ingestLocal(hint: HintPacket): boolean {
    if (!verifyHintPow(hint)) return false;
    const id = hintId(hint);
    this.remember(hint);
    const opened = this.tryOpen(hint, id);
    log.debug(() => `ingest local hint ${id.substring(0, 8)} opened=${opened}`);
    return opened;
  }

  private handleHint(senderId: PeerId, msg: any): void {
    const hint = parseHintPacket(msg);
    if (!hint) {
      log.debug(() => `HINT REJECTED (malformed) from=${senderId.substring(0, 8)}`);
      return;
    }

    // PoW は中継より先に検証する。ここを素通しにすると、
    // 検証していないパケットを自分が増幅して撒くことになる。
    if (!verifyHintPow(hint)) {
      log.debug(() => `HINT REJECTED (pow) from=${senderId.substring(0, 8)}`);
      return;
    }

    // id は ttl / pow_nonce を含まないので、中継で ttl が減っても同一と判定される
    const id = hintId(hint);
    log.trace(() => `HINT from=${senderId.substring(0, 8)} ${id.substring(0, 8)} ttl=${hint.ttl}`);

    // エコー通知は何よりも先に。ここで発信元の再送が止まる。
    this.dandelion.notifyEcho(id);

    // ★ 同じ Hint は隣人の数だけ届く。旧実装は 2 通目以降も
    //   - 観測した Hint の流量 (anyHintListeners → HintRelease) に数え、
    //   - 開き直し用のバッファに溜めていた。
    //   流量の水増しで放流の遅延が縮み (匿名性の状態表示が実際より良く見える)、
    //   正当な Hint 1 つ (PoW 1 回分) の再送だけでバッファを埋めて、他の Hint を
    //   後から開けなくすることもできた。初めて受け取ったものだけを扱う。
    if (this.received.has(id)) {
      log.trace(() => `HINT duplicate ${id.substring(0, 8)}`);
      return;
    }
    this.received.add(id);
    for (const cb of this.anyHintListeners) cb();

    // 1. ローカルでの試行復号。中継状態とは独立に必ず試みる。
    //    開けなくても手元に残す (後から鍵を得たときに開き直すため)。
    this.remember(hint);
    this.tryOpen(hint, id);

    // 2. 中継は無条件に全隣人へ (Broadcast Veil)
    this.flood(hint, senderId);
  }

  /** 手持ちの全鍵で試行復号する */
  private tryOpen(hint: HintPacket, id: string): boolean {
    if (this.delivered.has(id)) {
      log.trace(() => `HINT skip (already delivered) ${id.substring(0, 8)}`);
      return false;
    }

    for (const [keyId, k] of this.keys) {
      const payload = openHint(k, hint);
      if (!payload) continue;

      this.delivered.add(id);
      log.debug(() => `HINT opened with key=${keyId} ${id.substring(0, 8)}`);
      const opened: OpenedHint = { payload, keyId, packet: hint };
      for (const cb of this.listeners) cb(opened);
      return true;
    }
    log.trace(() => `HINT not for me ${id.substring(0, 8)} (tried ${this.keys.size} key(s))`);
    return false;
  }

  /** 開けなかった Hint も後で開き直せるよう手元に残す (上限つき) */
  private remember(hint: HintPacket): void {
    // ★ どの経路 (網・出口・保管した Slot) から来ても、同じ Hint は 1 つだけ溜める。
    //   重複を溜めると、正当な Hint 1 つの使い回しでバッファを埋め、他の Hint を
    //   後から開けなくできてしまう。
    const id = hintId(hint);
    if (this.recentIds.has(id)) return;
    this.recentIds.add(id);
    this.recentHints.push(hint);
    if (this.recentHints.length > RECENT_HINT_BUFFER) {
      const evicted = this.recentHints.splice(0, this.recentHints.length - RECENT_HINT_BUFFER);
      for (const old of evicted) this.recentIds.delete(hintId(old));
    }
  }

  /**
   * 全隣人へ中継する。同じ Hint を二度中継しない判定はここだけが行う。
   *
   * ★ TTL は減らさず、常に初期値で送る (H6)。
   *
   *   旧実装は中継のたびに 1 減らしていたため、受け取った ttl から
   *   「Fluff 地点 (出口) まであと何ホップか」が分かった (ttl=7 なら送り主が出口)。
   *   ttl は id にコミットされていないのでワイヤ互換のために残すが、情報は載せない。
   *   停止性は flooded (重複排除) が担う。
   */
  private flood(hint: HintPacket, excludePeerId: PeerId): void {
    const id = hintId(hint);
    if (this.flooded.has(id)) {
      log.trace(() => `HINT flood SKIP (already flooded) ${id.substring(0, 8)}`);
      return;
    }

    const relayed: HintPacket = { ...hint, ttl: HINT_INITIAL_TTL };

    this.flooded.add(id);
    for (const peer of this.peerManager.peers.values()) {
      if (peer.peerId === excludePeerId) continue;
      if (!peer.isConnected || !peer.isVerified) continue;
      this.peerManager.sendMessage(peer.peerId, WireType.HINT, relayed);
    }
  }

  public destroy(): void {
    this.flooded.destroy();
    this.received.destroy();
    this.delivered.destroy();
    this.keys.clear();
    this.listeners = [];
    this.anyHintListeners = [];
    this.recentHints = [];
    this.recentIds.clear();
  }
}
