import type { DHTMailbox } from '../mailbox/DHTMailbox';
import type { IPeerManager, IPeerConnection } from '../../types';
import type { HintRouter, OpenedHint } from './HintRouter';
import { Encoding } from '../../common/Encoding';
import { createLogger } from '../../common/Logger';
import { buildHint, mailboxKeyFromNonce, newMailboxSlot, type HintPayload } from './HintCrypto';
import { hintId, type HintPacket } from './HintPacket';
import { decodeSlotBlob, encodeSlotBlob, extractHint } from './SlotBlob';
import { HintReleaseScheduler, type ReleaseMode, type ReleaseStatus } from './HintRelease';

const log = createLogger('net.schrodinger');

/**
 * 再放流の周期。
 *
 * ★ 送出タイミングは mailbox_key から決定論的に導出する (§18.3-A)。
 *   K 個の保持者が同一時間窓で送出すれば、受け手の SeenCache が
 *   同一 id として畳むため帯域が K 倍にならない。
 *
 * ★ **SeenCache の TTL (15分) より長くなければならない。**
 *
 *   Hint の id は中身から決まるので、周期が TTL より短いと
 *   受け手側の重複排除に畳まれて 2 回目以降が 1 ホップも進まない。
 *   それでは「後から参加した人が過去ログを発見できる」という
 *   再放流の目的そのものが果たせない。
 *   `reflood_period_must_exceed_seen_cache_ttl` テストで固定してある。
 */
export const REFLOOD_PERIOD_MS = 20 * 60 * 1000;
/** 再放流の走査間隔 */
export const REFLOOD_TICK_MS = 60 * 1000;

/**
 * 新規接続時に送るバックログの上限。
 * 無制限だと接続のたびに保管物を全部送ることになり、帯域が跳ねる。
 */
export const BACKLOG_LIMIT = 200;

/**
 * SchrodingerMailbox — 「受信者が取得するまで、誰宛てか確定しない」保管
 *
 * ★ 何が変わるのか
 *
 * ```
 * 従来:  mailbox_key = SHA256(boardKey)      板ごとに固定・誰でも計算可能
 * 現在:  mailbox_key = SHA256(random nonce)  投稿ごとにランダム
 * ```
 *
 * 固定鍵だと、GET を受けた K 人は「この IP はこの板/スレを読んでいる」を
 * 直接知る。さらに**問い合わせ先を自分で選べない**(K-nearest はトピック座標が
 * 決める)ため、狙った座標の近くに peerId をグラインドした者は
 * **そのトピックへの全 GET を受け取る立場を取れる**。
 *
 * ランダム鍵にすると板に対応する固定座標が消えるので、
 * 攻撃者は鍵空間全体を覆わない限り観測できない。O(1) の攻撃が O(N) になる。
 *
 * 代償として **nonce を知らないと本体に辿り着けない**。それを配るのが Hint。
 */
export class SchrodingerMailbox {
  private refloodTimer: any = null;
  /** onHint から本体取得までを繋ぐハンドラ */
  private onOpened = async (opened: OpenedHint) => {
    const body = await this.fetchBody(opened.payload);
    if (!body) return;
    log.info(
      () =>
        `hint -> body ok key=${opened.keyId} slot=` +
        `${Encoding.toHex(mailboxKeyFromNonce(opened.payload.nonce)).substring(0, 8)} ${body.length}B`,
    );
    for (const cb of this.bodyListeners) cb(body, opened);
  };
  private bodyListeners: Array<(body: Uint8Array, hint: OpenedHint) => void> = [];

  private onPeerConnect = (peer: IPeerConnection | string) => {
    const peerId = typeof peer === 'string' ? peer : peer?.peerId;
    if (!peerId) return;
    // 繋がった相手は、こちらが持っている Hint を取りこぼしている可能性がある。
    // 要求を待たずに送る (要求のやり取り自体が観測点になるため)。
    this.sendBacklogTo(peerId).catch(e => log.warn('backlog send failed', e));
  };

  /** Hint 放流の時間分離 (§18.4.5) */
  public readonly release: HintReleaseScheduler;

  constructor(
    private mailbox: DHTMailbox,
    private hintRouter: HintRouter,
    private peerManager?: IPeerManager,
    mode: ReleaseMode = 'adaptive',
  ) {
    this.release = new HintReleaseScheduler(mode);
    this.hintRouter.onHint(this.onOpened);
    // 保管した Slot の索引はその場で開く (別経路の到着を待たない)
    this.mailbox.onSlotStored((entry) => {
      const hint = extractHint(entry);
      if (hint) this.hintRouter.ingestLocal(hint);
    });
    this.hintRouter.onAnyHint(() => this.release.noteHintSeen());
    this.peerManager?.on('peer:connect', this.onPeerConnect);
  }

  /**
   * 試行復号の対象に鍵を加える。板やスレッドを開いたときに呼ぶ。
   */
  public addKey(keyId: string, k: Uint8Array): void {
    this.hintRouter.addKey(keyId, k);
  }

  public removeKey(keyId: string): void {
    this.hintRouter.removeKey(keyId);
  }

  /**
   * 新しく繋がった隣人へ、自分が保管している Hint を送る (バックログ)。
   *
   * ★ これが無いと履歴が再放流待ち (最大 REFLOOD_PERIOD) になる。
   *
   * Schrödinger 化すると「板の過去ログを一括 fetch」という操作が原理的に
   * 消える (mailbox_key が投稿ごとにランダムなので、まとめて引く鍵が無い)。
   * 履歴は Hint 経由でしか辿れないため、参加直後に何も見えなくなる。
   *
   * ★ これは購読宣言にならない。
   *
   *   送るのは「自分が持っている Hint 全部」であって、
   *   相手が何に興味があるかを聞いていないし、こちらの興味も現れない
   *   (保管しているものは K-nearest の抽選で降ってきたものであり、
   *    自分の興味とは無相関 —— §18.3-C)。
   *   Hint は元々全員に配られるものなので、これは取りこぼしの穴埋めに過ぎない。
   */
  public async sendBacklogTo(peerId: string, limit = BACKLOG_LIMIT): Promise<number> {
    const keys = await this.mailbox.storedKeys().catch(() => [] as string[]);
    let sent = 0;

    for (const keyHex of keys) {
      if (sent >= limit) break;
      const entries = await this.mailbox.stored(keyHex).catch(() => [] as Uint8Array[]);
      for (const entry of entries) {
        if (sent >= limit) break;
        const hint = extractHint(entry);
        if (!hint) continue;
        this.hintRouter.sendTo(peerId, hint);
        sent++;
      }
    }
    // 0 件でも出す。「バックログが空だった」ことが分からないと
    // 「送っていない」のか「送るものが無かった」のかを切り分けられない。
    log.debug(() => `backlog -> ${peerId.substring(0, 8)}: ${sent} hint(s) from ${keys.length} slot(s)`);
    return sent;
  }

  /** Hint が開けて本体まで取れたときに呼ばれる */
  public onBody(cb: (body: Uint8Array, hint: OpenedHint) => void): void {
    this.bodyListeners.push(cb);
  }

  /**
   * 本体を保管し、その在り処を Hint で配る。
   *
   * @param k         板/スレッドの鍵。これを持つ者だけが Hint を開ける
   * @param body      封印済みの本体 (このクラスは中身を見ない)
   * @param messageId メッセージ識別子
   */
  public async publish(k: Uint8Array, body: Uint8Array, messageId: number): Promise<HintPacket> {
    const { hint } = await this.publishWithStatus(k, body, messageId);
    return hint;
  }

  /** 待ち時間の理由まで返す版 (UI へ出すため) */
  public async publishWithStatus(
    k: Uint8Array,
    body: Uint8Array,
    messageId: number,
  ): Promise<{ hint: HintPacket; release: ReleaseStatus }> {
    const { nonce, mailboxKey } = newMailboxSlot();
    const payload: HintPayload = { nonce, message_id: messageId, timestamp: Date.now() };
    const hint = buildHint(k, payload);

    // 本体と索引を同じ Slot に入れる。保持者は索引を復号できないが、
    // バイト列として再放流できる (§18.3-A)。
    const blob = encodeSlotBlob(hint, body);
    const keyHex = Encoding.toHex(mailboxKey);

    log.info(
      () =>
        `publish slot=${keyHex.substring(0, 8)} body=${body.length}B ` +
        `hint=${hintId(hint).substring(0, 8)} msg=${messageId}`,
    );
    await this.mailbox.publish(keyHex, blob);

    // ★ 本体 PUT と Hint 放流を時間で切り離す (§18.4.5)。
    //
    //   同時に出ると、両方を観測できる位置にいる者に
    //   「この IP が D 秒間アップロードしていた」×「T+ε に Hint が現れた」で
    //   紐づけられる。Hint の中身が不透明でも、この相関は中身を必要としない。
    //
    //   小さい送信や、網が小さくて匿名集合が生まれない状況では
    //   遅延しない (待つ意味が無いコストを払わせない)。
    const release = await this.release.waitFor(body.length);

    // ★ Hint は必ず Stem を通す (HintRouter.originate の中で行う)。
    //   直接 flood すると発信元が隣人に割れ、それは
    //   「誰がその投稿を書いたか」が割れることと同じになる。
    await this.hintRouter.originate(hint, hintId(hint));
    return { hint, release };
  }

  /** Hint から本体を取りに行く */
  public async fetchBody(payload: HintPayload): Promise<Uint8Array | null> {
    const keyHex = Encoding.toHex(mailboxKeyFromNonce(payload.nonce));

    // ★ 手元にあれば GET を出さない。
    //
    //   Slot は内容アドレス指定で不変 (mailbox_key = SHA256(nonce) で、
    //   中身は封印済み) なので、持っているものが正しいものだと確定する。
    //   ネットワークに問い合わせないということは、
    //   **その Slot に興味があることを誰にも見せない**ということでもある。
    //   速度と匿名性が同じ方向を向く数少ない場所。
    const local = await this.mailbox.stored(keyHex).catch(() => [] as Uint8Array[]);
    for (const entry of local) {
      const blob = decodeSlotBlob(entry);
      if (blob) {
        log.trace(() => `fetch hit locally slot=${keyHex.substring(0, 8)}`);
        return blob.body;
      }
    }

    const entries = await this.mailbox.fetch(keyHex);
    if (entries.length === 0) {
      // 「Hint は開けたのに本体が無い」= バックログや再放流で索引だけ先に
      //   届いた状態。ここが続くなら保管側が落ちている可能性が高い。
      log.warn(() => `fetch MISS slot=${keyHex.substring(0, 8)} (hint opened but body not found)`);
      return null;
    }
    for (const entry of entries) {
      const blob = decodeSlotBlob(entry);
      if (blob) return blob.body;
    }
    log.warn(() => `fetch got ${entries.length} entries but none decoded slot=${keyHex.substring(0, 8)}`);
    return null;
  }

  /**
   * 保持者による Hint の再放流を開始する (§18.3-A)。
   *
   * ★ これが無いと、Hint を受け取れなかった人は mailbox_key を永久に
   *   計算できず、**後から参加した人が過去ログを一切発見できない。**
   *   Schrödinger 化とセットで必ず有効にすること。
   *
   * ★ 匿名性への効果は可用性より大きい。
   *   「新規キーの初出ノード = 一次放流者」は t=0 の一瞬しか観測機会がなく、
   *   再放流が始まると以降 Hint を流しているのはコンテンツと無関係な
   *   ランダムな保持者になる。
   */
  public startReflood(): void {
    this.stopReflood();
    this.refloodTimer = setInterval(() => {
      this.refloodDue().catch(e => log.error('reflood failed', e));
    }, REFLOOD_TICK_MS);
  }

  public stopReflood(): void {
    if (this.refloodTimer) {
      clearInterval(this.refloodTimer);
      this.refloodTimer = null;
    }
  }

  /**
   * 今の時間窓で再放流すべき Slot を撒く。
   *
   * 送出タイミングを mailbox_key から決定論的に導出するので、
   * K 個の保持者が同じ窓で送る → 受け手の SeenCache が畳む → 帯域が K 倍にならない。
   */
  public async refloodDue(now: number = Date.now()): Promise<number> {
    const keys = await this.mailbox.storedKeys().catch(() => [] as string[]);
    let sent = 0;

    for (const keyHex of keys) {
      if (!this.isDueNow(keyHex, now)) continue;
      const entries = await this.mailbox.stored(keyHex).catch(() => [] as Uint8Array[]);
      for (const entry of entries) {
        const hint = extractHint(entry);
        if (!hint) continue;
        // 再放流は Stem を通さない。**保持者は発信元ではない**ので隠すものが無く、
        // むしろ「無関係な保持者が流している」ことが匿名性の источник になる。
        this.hintRouter.reflood(hint);
        sent++;
      }
    }
    if (sent > 0) log.debug(() => `reflooded ${sent} hint(s)`);
    return sent;
  }

  /**
   * この mailbox_key を今の窓で再放流すべきか。
   *
   * key から決定論的にオフセットを決めるので、同じ Slot を持つ K 人は
   * 必ず同じ窓で送出する。
   */
  private isDueNow(keyHex: string, now: number): boolean {
    const offset = Number.parseInt(keyHex.substring(0, 8), 16) % REFLOOD_PERIOD_MS;
    const windowStart = Math.floor((now - offset) / REFLOOD_PERIOD_MS);
    const dueAt = windowStart * REFLOOD_PERIOD_MS + offset;
    return now - dueAt < REFLOOD_TICK_MS;
  }

  public destroy(): void {
    this.stopReflood();
    this.peerManager?.off('peer:connect', this.onPeerConnect);
    this.hintRouter.offHint(this.onOpened);
    this.bodyListeners = [];
  }
}
