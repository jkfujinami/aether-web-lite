import type { IndexedDBStore } from '../storage/IndexedDBStore';
import type { DHTMailbox } from '../network/mailbox/DHTMailbox';
import type { ZoneGossipRouter } from '../network/gossip/ZoneGossipRouter';
import type { CryptoEngine } from '../crypto/CryptoEngine';
import type { Identity } from '../crypto/Identity';
import type { IPeerManager, IZoneManager, IPoWEngine, IKeyManager } from '../types';
import type { ThreadMeta } from './types';
import { PacketBuilder } from '../crypto/PacketBuilder';
import { KeyManager } from '../crypto/KeyManager';
import { POW_POLICY } from '../crypto/PowPolicy';
import { BOARD_META_THREAD_ID, BoardStatus } from './types';
import { createLogger } from '../common/Logger';
import type { SchrodingerMailbox } from '../network/hint/SchrodingerMailbox';
import type { OpenedHint } from '../network/hint/HintRouter';

const log = createLogger('logic.board');



/**
 * BoardOrchestrator
 * 管理対象の「板」のスレッド一覧の取得、同期、投稿、およびメモリ保持を統括する。
 */
export class BoardOrchestrator {
  private listeners: Set<() => void> = new Set();
  private statusListeners: Set<() => void> = new Set();
  private threads: Map<string, ThreadMeta> = new Map();
  /**
   * useSyncExternalStore に渡すスナップショット。
   *
   * getSnapshot は「データが変わらない限り同じ参照」を返さなければならない
   * (返さないと React が無限ループを検出して例外を投げる)。
   * よって notify() のタイミングでだけ作り直し、それ以外では使い回す。
   */
  private snapshot: ThreadMeta[] = [];
  private seenPacketIds: Set<string> = new Set();
  private currentStatus: BoardStatus = { phase: 'idle', message: '' };
  private statsTimer: any = null;

  private currentBoardId: string | null = null;
  private currentBoardKey: Uint8Array | null = null;
  private isListening: boolean = false;
  /** 実行中の fullSync。多重起動を防ぐ */
  private syncInFlight: Promise<void> | null = null;
  private syncDebounce: any = null;
  /**
   * 隣人が居る状態でこれだけ待ってから「1 件も無い」と判定する。
   * 履歴が非同期にしか届かないので、即断すると必ず「無い」と出る。
   */
  private static readonly EMPTY_VERDICT_GRACE_MS = 8000;
  /** 現在の活性化で最初に隣人が現れた時刻 */
  private firstPeerAt: number | null = null;
  private emptyVerdictTimer: any = null;




  constructor(
    private pm: IPeerManager,
    private db: IndexedDBStore,
    private mailbox: DHTMailbox,
    private router: ZoneGossipRouter,
    private cryptoEng: CryptoEngine,
    private powEng: IPoWEngine,
    private identity: Identity,
    private zm: IZoneManager,
    private keyMgr: IKeyManager,
    /**
     * Schrödinger Mailbox。**必須**にしてある。
     * 省略可にすると、渡し忘れたときに新しい保管経路が黙って無効化され、
     * 「動いているように見えて匿名性が無い」状態になる。
     */
    private schrodinger: SchrodingerMailbox,
  ) {}

  /** この板の Hint を引き当てるための鍵 ID */
  private hintKeyId(boardId: string): string {
    return `board:${boardId}`;
  }

  /**
   * Hint 経由で本体が取れたときの処理。
   *
   * Schrödinger 化により、ネットワークからの流入はこの経路に一本化された
   * (mailbox_key が投稿ごとにランダムなので「板の過去ログを一括 fetch」は
   *  原理的に存在しない)。
   */
  private onHintBody = async (body: Uint8Array, hint: OpenedHint) => {
    if (!this.currentBoardId || !this.currentBoardKey) return;
    if (hint.keyId !== this.hintKeyId(this.currentBoardId)) return;
    try {
      const packet = JSON.parse(new TextDecoder().decode(body), (_k, v) => {
        if (v && v._type === 'Uint8Array') return new Uint8Array(v.data);
        return v;
      });
      await this.handlePacketObject(this.currentBoardId, this.currentBoardKey, packet, false, body);
    } catch (e) {
      log.warn('hint body parse error (skipping)', e);
    }
  };


  /**
   * 変更通知を購読する。
   *
   * useSyncExternalStore の subscribe としてそのまま渡せるよう、
   * 「購読解除関数を返すだけ」に徹する。以前はここで即座に listener を
   * 呼んでいたが、それは useSyncExternalStore の契約に反する
   * (初期値は getSnapshot が返す)。
   */
  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  public subscribeStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  /** useSyncExternalStore の getSnapshot。キャッシュ済みの参照を返す。 */
  public getThreads(): ThreadMeta[] {
    return this.snapshot;
  }

  public getStatus(): BoardStatus {
    return this.currentStatus;
  }

  private updateStatus(phase: BoardStatus['phase'], message: string, isSubmitting: boolean = false, powProgress: number = 0) {
    const cur = this.currentStatus;
    // 同じ内容なら通知しない。空判定の再評価は頻繁に走るので、
    // ここで畳まないと無意味な再描画が積み上がる。
    if (cur.phase === phase && cur.message === message &&
        (cur.isSubmitting ?? false) === isSubmitting && (cur.powProgress ?? 0) === powProgress) {
      return;
    }
    this.currentStatus = { phase, message, isSubmitting, powProgress };
    this.statusListeners.forEach(l => l());
  }

  /**
   * 「スレッドが 1 件も無い」と表示してよいかを判定する。
   *
   * ★ 即断してはいけない。
   *
   *   Schrödinger 化後、履歴は**非同期にしか届かない**:
   *     - 接続時に隣人が送ってくるバックログ
   *     - 保持者による定期再放流
   *     - 鍵登録時に手元の Hint を開き直した分
   *   いずれも Hint → 本体取得というネットワーク往復を挟む。
   *
   *   旧実装は fullSync の中で同期的に `threads.size === 0` を見て
   *   「見つかりませんでした」と断定していたため、**繋がった直後は必ず
   *   「無い」と表示された**。その後スレッドが届いても文言が残り、
   *   一覧と表示が食い違う状態にもなっていた。
   *
   *   隣人が居る状態で猶予を過ぎて初めて「無い」と言う。
   *   新しい隣人が増えたら、その隣人が履歴を持っているかもしれないので
   *   猶予を引き直す。
   */
  private refreshEmptyStatus(): void {
    // 投稿中の表示は壊さない
    if (this.currentStatus.isSubmitting) return;

    if (this.emptyVerdictTimer) {
      clearTimeout(this.emptyVerdictTimer);
      this.emptyVerdictTimer = null;
    }

    if (this.threads.size > 0) {
      this.updateStatus('idle', '');
      return;
    }

    if (this.pm.degree === 0) {
      this.firstPeerAt = null;
      this.updateStatus('loading', '隣人を探しています (接続中)...');
      return;
    }

    if (this.firstPeerAt === null) this.firstPeerAt = Date.now();
    const remaining = BoardOrchestrator.EMPTY_VERDICT_GRACE_MS - (Date.now() - this.firstPeerAt);

    if (remaining > 0) {
      this.updateStatus('syncing', `${this.pm.degree}人の隣人と同期中...`);
      this.emptyVerdictTimer = setTimeout(() => {
        this.emptyVerdictTimer = null;
        this.refreshEmptyStatus();
      }, remaining);
      return;
    }

    this.updateStatus('idle', 'スレッドが見つかりませんでした。一番乗りで立ててみませんか？');
  }



  /**
   * スナップショットを作り直してから購読者に「変わった」と伝える。
   *
   * 参照が必ず変わるので、React は確実に再描画する。
   */
  private notify() {
    this.snapshot = Array.from(this.threads.values());
    log.debug(() => `notify: ${this.snapshot.length} threads -> ${this.listeners.size} listener(s)`);
    this.listeners.forEach(l => l());
  }

  // --- 以降、将来のステップでロジックを順次移植する ---

  /**
   * パケット（JSONオブジェクト）を処理し、板の状態を更新する
   */
  public async handlePacketObject(boardId: string, boardKey: Uint8Array, packet: any, isFromDB: boolean, rawData?: Uint8Array) {
    log.trace(() => `packet enter ${short(packet?.packet_id)} fromDB=${isFromDB}`);
    if (this.seenPacketIds.has(packet.packet_id)) {
      log.trace(() => `packet DROP (already seen) ${short(packet.packet_id)}`);
      return;
    }
    this.seenPacketIds.add(packet.packet_id);
    try {
      const meta = await PacketBuilder.verifyAndDecrypt(packet, boardKey, this.cryptoEng);
      if (!meta) {
        log.debug(() => `packet DROP (decrypt failed: quickCheck/AEAD/signature) ${short(packet.packet_id)}`);
        return;
      }
      if (meta.post_type !== 1) {
        log.trace(() => `packet DROP (post_type=${meta.post_type}, want 1) ${short(packet.packet_id)}`);
        return;
      }

      const created_at = this.normalizeTimestamp(meta.created_at);
      const max_pow = await this.resolveMaxPow(boardId, meta);
      const changed = this.mergeThread(meta, packet.packet_id, max_pow, created_at);
      log.debug(() => `merge thread=${short(meta.thread_id)} changed=${changed} total=${this.threads.size}`);
      if (changed) {
        this.notify();
        // 1 件でも届いたら「無い」の表示を消す
        this.refreshEmptyStatus();
      }
      if (!isFromDB) await this.persistThread(boardId, packet, meta, rawData);
    } catch (e: any) {
      log.error(`Error processing packet ${packet?.packet_id}:`, e);
    }
  }

  private normalizeTimestamp(raw: any): number {
    const n = Number(raw);
    return isFinite(n) && n > 0 ? n : Date.now();
  }

  private async resolveMaxPow(boardId: string, meta: any): Promise<number> {
    const base = Number(meta.cumulative_pow || 0);
    const stats = await this.db.getThreads(boardId)
      .then((list: any[]) => list.find((s: any) => s.threadId === meta.thread_id));
    return stats ? Math.max(base, stats.max_pow || 0) : base;
  }

  private mergeThread(meta: any, packetId: string, max_pow: number, created_at: number): boolean {
    const existing = this.threads.get(meta.thread_id);
    if (existing) {
      const mergedPow = Math.max(existing.max_pow || 0, max_pow);
      const mergedAt = isFinite(existing.created_at) && existing.created_at > 0
        ? existing.created_at : created_at;
      if (mergedPow === existing.max_pow && mergedAt === existing.created_at) return false;
      this.threads.set(meta.thread_id, { ...existing, max_pow: mergedPow, created_at: mergedAt });
    } else {
      this.threads.set(meta.thread_id, { ...meta, packet_id: packetId, max_pow, created_at });
    }
    return true;
  }

  private async persistThread(boardId: string, packet: any, meta: any, rawData?: Uint8Array): Promise<void> {
    const data = rawData ?? new TextEncoder().encode(JSON.stringify(packet, (_k, v) => {
      if (v instanceof Uint8Array) return { _type: 'Uint8Array', data: Array.from(v) };
      return v;
    }));
    await this.db.save({
      boardId,
      threadId: BOARD_META_THREAD_ID,
      payload: data,
      dag: {
        parents: meta.parents || [],
        cumulative_pow: meta.cumulative_pow || 0,
        thread_root: meta.thread_id,
        created_at: meta.created_at
      }
    }).catch((err) => {
      log.error(`DB Save failed for thread meta ${meta?.thread_id}:`, err);
    });
  }


  /**
   * 板全体の過去ログをネットワークから取得する
   */
  public async fullSync(boardId: string, boardKey: Uint8Array): Promise<void> {
    // 同時に複数の fullSync が走ると DHT fetch のタイムアウト (4秒) が
    // そのぶん重なり、UI が「同期中」から抜けられなくなる。
    if (this.syncInFlight) return this.syncInFlight;
    this.syncInFlight = this.runFullSync(boardId, boardKey).finally(() => {
      this.syncInFlight = null;
    });
    return this.syncInFlight;
  }

  private async runFullSync(boardId: string, boardKey: Uint8Array): Promise<void> {
    if (!this.pm || !this.mailbox) return;

    try {
      if (this.pm.degree === 0) {
        this.refreshEmptyStatus();
        return;
      }

      // ★ topicHash による一括 fetch は廃止した。
      //
      //   旧実装は `mailbox.fetch(SHA512(boardKey))` で板の過去ログをまとめて
      //   引いていたが、この topicHash は板の鍵から誰でも計算できるため、
      //   GET を受けた K 人に「この IP はこの板を読んでいる」が直接漏れていた。
      //   しかも問い合わせ先はトピック座標が決めるので、そこに peerId を
      //   グラインドした攻撃者は板の全読者を観測できた。
      //
      //   現在は本体がランダムな Slot にあり、在り処は Hint でしか分からない。
      //   履歴は次の 2 つで埋まる (どちらも要求を出さない = 何も申告しない):
      //     - 接続時に隣人が送ってくるバックログ (SchrodingerMailbox)
      //     - 保持者による定期再放流 (§18.3-A)
      //   加えて、板の鍵を登録した時点で手元に溜まっている Hint を
      //   HintRouter が開き直すので、既に流れてきた分は即座に反映される。

      // 「無い」の判定は refreshEmptyStatus に一本化する (即断しない)
      this.refreshEmptyStatus();

      // 定期的なDB統計の同期を開始
      this.startStatsSync(boardId);

    } catch (err) {
      log.error('[BoardOrchestrator] fullSync error:', err);
      this.updateStatus('error', '最新スレッドの取得に失敗しました');
    }
  }

  /**
   * DBの統計情報を定期的にメモリへ反映する
   */
  public startStatsSync(boardId: string) {
    this.stopStatsSync();
    this.statsTimer = setInterval(async () => {
      const allStats = await this.db.getThreads(boardId).catch(() => []);
      if (allStats.length === 0) return;

      let changed = false;
      for (const s of allStats) {
        const t = this.threads.get(s.threadId);
        if (!t) continue;

        const newPow = Math.max(s.max_pow || 0, t.max_pow || 0);
        const currentCreatedAt = (isFinite(t.created_at) && t.created_at > 0) ? t.created_at : 0;
        const dbCreatedAt = (isFinite(s.created_at) && s.created_at > 0) ? s.created_at : 0;
        const bestCreatedAt = currentCreatedAt > 0 ? currentCreatedAt : (dbCreatedAt > 0 ? dbCreatedAt : Date.now());

        if (newPow !== t.max_pow || bestCreatedAt !== t.created_at) {
          this.threads.set(s.threadId, { ...t, max_pow: newPow, created_at: bestCreatedAt });
          changed = true;
        }
      }
      if (changed) this.notify();
    }, 5000);
  }

  public stopStatsSync() {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  /**
   * ハンドラ: 新しいパケットを検知したとき
   */
  private onGossipPacket = async (packet: any) => {
    if (this.currentBoardId && this.currentBoardKey) {
      await this.handlePacketObject(this.currentBoardId, this.currentBoardKey, packet, false);
    } else {
      log.trace(() => `gossip DROP (board not activated, current=${this.currentBoardId}) ${short(packet?.packet_id)}`);
    }
  };

  /**
   * ハンドラ: 新しい隣人と繋がったとき
   */
  /**
   * 隣人が増えたら再同期する。ただし接続は一気に何本も張られるので、
   * そのたびに fullSync を投げると DHT fetch (最大4秒) が何本も重なる。
   * デバウンスして 1 本に畳む。
   */
  private onPeerConnect = () => {
    // 新しい隣人は履歴を持っているかもしれない。空判定の猶予を引き直す。
    if (this.threads.size === 0) this.firstPeerAt = Date.now();
    this.refreshEmptyStatus();

    if (!this.currentBoardId || !this.currentBoardKey) return;
    if (this.syncDebounce) clearTimeout(this.syncDebounce);
    this.syncDebounce = setTimeout(() => {
      this.syncDebounce = null;
      if (this.currentBoardId && this.currentBoardKey) {
        this.fullSync(this.currentBoardId, this.currentBoardKey);
      }
    }, 500);
  };

  /**
   * 板の同期を活性化する
   */
  public async activate(boardId: string, boardKey: Uint8Array) {
    // 1. 板が切り替わった場合はリセット
    if (this.currentBoardId !== boardId) {
      this.clear();
      this.currentBoardId = boardId;
      this.currentBoardKey = boardKey;
    }

    // 2. リスナーの登録（一度だけ）
    if (!this.isListening) {
      this.router.onMessage(this.onGossipPacket);
      this.pm.on('peer:connect', this.onPeerConnect);
      // Hint の試行復号に板の鍵を渡し、本体が取れたら流し込む
      this.schrodinger.addKey(this.hintKeyId(boardId), boardKey);
      this.schrodinger.onBody(this.onHintBody);
      this.isListening = true;
    }

    // 3. ローカルDBからキャッシュを復元
    await this.loadInitialCache(boardId, boardKey);

    // 4. 初期ネットワーク同期
    await this.fullSync(boardId, boardKey);
  }

  /**
   * DBから既知のパケットを読み込む
   */
  private async loadInitialCache(boardId: string, boardKey: Uint8Array) {
    const rawEntries = await this.db.getPosts(boardId, BOARD_META_THREAD_ID).catch(() => []);
    for (const entry of rawEntries) {
      try {
        const decoded = new TextDecoder().decode(entry.payload);
        const packet = JSON.parse(decoded, (_k, v) => {
          if (v && v._type === 'Uint8Array') return new Uint8Array(v.data);
          return v;
        });
        await this.handlePacketObject(boardId, boardKey, packet, true, entry.payload);
      } catch (e) {}
    }
  }




  /**
   * 新しいスレッドを立てる
   */
  public async submitThread(boardId: string, boardKey: Uint8Array, title: string): Promise<string | null> {
    if (!title || !boardKey || !this.powEng || !this.identity || !this.cryptoEng || !this.keyMgr || !this.zm || !this.router || !this.mailbox || !this.db) return null;

    this.updateStatus('submitting', 'スレッドを構築中...', true, 30);

    try {
      const threadId = Math.random().toString(36).substring(2, 12);
      const threadKey = KeyManager.deriveThreadKey(boardKey, threadId);
      
      // 🌟 板のメタデータ（スレッド作成通知）なので、スレッドのゾーンではなく「板のゾーン」にブロードキャストする
      const boardTopicHash = KeyManager.cryptoHash(boardKey);
      const boardZoneId = KeyManager.computeZoneId(boardTopicHash, this.zm.depth);

      // 網共通の固定値。端末の閲覧状況から計算した値をヘッダに載せない (PowPolicy 参照)
      const powDifficulty = POW_POLICY.NETWORK_DIFFICULTY;

      const packet = await PacketBuilder.build(
        title, boardKey, this.identity, this.cryptoEng,
        this.powEng, this.keyMgr, boardId, threadId,
        0, null, powDifficulty, boardZoneId, 1,
        [], threadId, powDifficulty
      );

      this.updateStatus('submitting', '拡散中...', true, 100);

      const rawPacketData = new TextEncoder().encode(JSON.stringify(packet, (_k, v) => {
          if (v instanceof Uint8Array) return { _type: 'Uint8Array', data: Array.from(v) };
          return v;
      }));

      // ★ 先に自分の画面へ反映する。
      //
      //   以前は `await this.router.broadcast(packet)` としていたが、
      //   broadcast は Dandelion++ のエコー確認を待つため
      //   ECHO_TIMEOUT(5秒) × (MAX_RETRIES+1 = 3回) = 最大 15 秒ブロックする。
      //   その間 isSubmitting が立ちっぱなしになり、立てたスレッドが
      //   画面に出ないまま固まって見えた。
      //   ThreadOrchestrator.submitReply は元から非同期送信だったので、
      //   スレ立てだけが取り残されていた。
      const savedAt = Date.now();
      this.mergeThread(
        { thread_id: threadId, board_id: boardId, content: title, post_type: 1, created_at: savedAt },
        packet.packet_id,
        powDifficulty,
        savedAt
      );
      this.seenPacketIds.add(packet.packet_id);
      this.notify();

      await this.db.save({
        boardId: boardId,
        threadId: BOARD_META_THREAD_ID,
        payload: rawPacketData,
        dag: {
            parents: [],
            cumulative_pow: powDifficulty,
            thread_root: threadId,
            created_at: savedAt
        }
      }).catch(() => {});

      // ── ここから先はネットワークへの送出。UI を待たせない。 ──
      this.sendAnonymously(packet, boardKey, savedAt, rawPacketData.length);

      this.updateStatus('idle', '', false, 0);
      return threadId;
    } catch (err) {
      log.error('[BoardOrchestrator] submitThread error:', err);
      this.updateStatus('error', 'スレッドの作成に失敗しました', false, 0);
      return null;
    }
  }


  /**
   * 投稿をオニオン回路で送り出す。
   *
   * ★ 本体・Slot・索引のすべてがオニオンセルに載る (C3)。
   *   Slot は Gossip と同じセルに同梱し、出口が作者の代わりに保管する。
   *   索引 (Hint) は本体が網に現れた後で、時間をずらして別のセルで放流する。
   *   回路で届かなかった場合は平文に落とさず、その旨を表示する (Fail-Closed)。
   */
  private sendAnonymously(packet: any, key: Uint8Array, messageId: number, bodyBytes: number): void {
    const slot = this.schrodinger.prepareSlot(key, messageId);
    void (async () => {
      const delivered = await this.router.broadcast(packet, { slot: slot.exitSlot });
      if (!delivered) {
        this.updateStatus('error', '匿名経路で送信できませんでした (平文での送信は行っていません)。隣人が増えてから再度お試しください。');
        return;
      }
      await this.schrodinger.releaseHint(slot.hint, bodyBytes);
    })().catch((err: any) => {
      log.error('[BoardOrchestrator] anonymous send failed:', err);
    });
  }

  /**
   * メモリ状態をリセットする（板の切り替え時など）
   */
  public clear() {
    this.stopStatsSync();
    this.firstPeerAt = null;
    if (this.emptyVerdictTimer) {
      clearTimeout(this.emptyVerdictTimer);
      this.emptyVerdictTimer = null;
    }
    if (this.syncDebounce) {
      clearTimeout(this.syncDebounce);
      this.syncDebounce = null;
    }

    if (this.currentBoardId) {
      this.schrodinger.removeKey(this.hintKeyId(this.currentBoardId));
    }
    if (this.isListening) {
      this.router.offMessage(this.onGossipPacket);
      this.pm.off('peer:connect', this.onPeerConnect);
      this.isListening = false;
    }

    this.currentBoardId = null;
    this.currentBoardKey = null;
    this.threads.clear();
    this.seenPacketIds.clear();
    this.notify();
  }


}

/** ログ用の短縮表示。undefined でも落ちないようにしておく */
function short(id: string | undefined | null): string {
  return id ? id.substring(0, 8) : '?';
}
