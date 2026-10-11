import type { IndexedDBStore } from '../storage/IndexedDBStore';
import type { DHTMailbox } from '../network/mailbox/DHTMailbox';
import type { ZoneGossipRouter } from '../network/gossip/ZoneGossipRouter';
import type { CryptoEngine } from '../crypto/CryptoEngine';
import type { Identity } from '../crypto/Identity';
import type { SyncProtocol } from '../network/mailbox/SyncProtocol';
import type { IPeerManager, IZoneManager, IPoWEngine, IKeyManager } from '../types';
import { ThreadDAGManager, type DAGPost } from './ThreadDAGManager';
import { ThreadStatus } from './types';
import { JsonBinary } from '../common/JsonBinary';
import { PacketBuilder } from '../crypto/PacketBuilder';
import { KeyManager } from '../crypto/KeyManager';
import { POW_POLICY } from '../crypto/PowPolicy';
import { createLogger } from '../common/Logger';
import type { SchrodingerMailbox } from '../network/hint/SchrodingerMailbox';
import type { OpenedHint } from '../network/hint/HintRouter';
import { randomMessageId } from './BoardOrchestrator';

const log = createLogger('logic.thread');




/**
 * ThreadOrchestrator
 * 特定のスレッドにおける投稿（Post）の取得、DAG構築、同期、および投稿を統括する。
 */
export class ThreadOrchestrator {
  private listeners: Set<() => void> = new Set();
  private statusListeners: Set<() => void> = new Set();
  /**
   * useSyncExternalStore に渡すスナップショット。
   * データが変わらない限り同じ参照を返す必要があるため、notify() でだけ作り直す。
   */
  private snapshot: DAGPost[] = [];
  private dag: ThreadDAGManager = new ThreadDAGManager(''); // 初期はダミー
  private seenPacketIds: Set<string> = new Set();
  private currentStatus: ThreadStatus = { phase: 'idle', message: '' };

  private currentBoardId: string | null = null;
  private currentBoardKey: Uint8Array | null = null;
  /** 開いている板・スレッドのゾーンの購読を外す */
  private unwatchZone: (() => void) | null = null;
  private currentThreadId: string | null = null;
  private currentThreadKey: Uint8Array | null = null;
  private currentThreadTopicHash: Uint8Array | null = null;
  private isListening: boolean = false;
  /** 実行中の fullSync。多重起動を防ぐ */
  private syncInFlight: Promise<void> | null = null;
  private syncDebounce: any = null;
  /** 隣人が居る状態でこれだけ待ってから「1 件も無い」と判定する */
  private static readonly EMPTY_VERDICT_GRACE_MS = 8000;
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
    private syncProtocol: SyncProtocol,
    /**
     * Schrödinger Mailbox。**必須**にしてある。
     * 省略可にすると、渡し忘れたときに新しい保管経路が黙って無効化され、
     * 「動いているように見えて匿名性が無い」状態になる。
     */
    private schrodinger: SchrodingerMailbox,
  ) {}

  /** このスレッドの Hint を引き当てるための鍵 ID */
  private hintKeyId(threadId: string): string {
    return `thread:${threadId}`;
  }

  /** Hint 経由で本体が取れたときの処理 */
  private onHintBody = async (body: Uint8Array, hint: OpenedHint) => {
    const { currentBoardId: b, currentThreadId: t, currentThreadKey: k } = this;
    if (!b || !t || !k) return;
    if (hint.keyId !== this.hintKeyId(t)) return;
    try {
      const packet = JSON.parse(new TextDecoder().decode(body), (_key, v) => {
        if (v && v._type === 'Uint8Array') return new Uint8Array(v.data);
        return v;
      });
      await this.handlePacketObject(b, t, k, packet, false);
    } catch (e) {
      log.warn('hint body parse error (skipping)', e);
    }
  };

  /** useSyncExternalStore の subscribe。購読解除関数を返すだけに徹する。 */
  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  public subscribeStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  /** useSyncExternalStore の getSnapshot。キャッシュ済みの参照を返す。 */
  public getPosts(): DAGPost[] {
    return this.snapshot;
  }

  public getStatus(): ThreadStatus {
    return this.currentStatus;
  }

  private updateStatus(phase: ThreadStatus['phase'], message: string, isSubmitting: boolean = false, powProgress: number = 0) {
    const cur = this.currentStatus;
    // 同じ内容なら通知しない (空判定の再評価が頻繁に走るため)
    if (cur.phase === phase && cur.message === message &&
        (cur.isSubmitting ?? false) === isSubmitting && (cur.powProgress ?? 0) === powProgress) {
      return;
    }
    this.currentStatus = { phase, message, isSubmitting, powProgress };
    this.statusListeners.forEach(l => l());
  }

  /**
   * 「レスが 1 件も無い」と表示してよいかを判定する。
   *
   * ★ 即断してはいけない。理由は BoardOrchestrator.refreshEmptyStatus と同じ。
   *   Schrödinger 化後、履歴は非同期にしか届かないので、繋がった直後に
   *   同期的に判定すると必ず「無い」と表示されてしまう。
   */
  private refreshEmptyStatus(): void {
    if (this.currentStatus.isSubmitting) return;

    if (this.emptyVerdictTimer) {
      clearTimeout(this.emptyVerdictTimer);
      this.emptyVerdictTimer = null;
    }

    if (this.dag.getCount() > 0) {
      this.updateStatus('idle', '');
      return;
    }

    if (this.pm.degree === 0) {
      this.firstPeerAt = null;
      this.updateStatus('idle', 'ネット接続待機中... 他の人がレスをすれば自動で反映されます。');
      return;
    }

    if (this.firstPeerAt === null) this.firstPeerAt = Date.now();
    const remaining = ThreadOrchestrator.EMPTY_VERDICT_GRACE_MS - (Date.now() - this.firstPeerAt);

    if (remaining > 0) {
      this.updateStatus('syncing', 'ピアと同期中...');
      this.emptyVerdictTimer = setTimeout(() => {
        this.emptyVerdictTimer = null;
        this.refreshEmptyStatus();
      }, remaining);
      return;
    }

    this.updateStatus('idle', 'レスが1件もありませんでした。あなたが最初の投稿者になりませんか？');
  }

  /** スナップショットを作り直してから「変わった」と伝える */
  private notify() {
    this.snapshot = this.dag.getSortedPosts();
    log.debug(() => `notify: ${this.snapshot.length} posts -> ${this.listeners.size} listener(s)`);
    this.listeners.forEach(l => l());
  }

  /**
   * パケット（JSONオブジェクト）を処理し、DAGを更新する
   */
  public async handlePacketObject(boardId: string, threadId: string, threadKey: Uint8Array, packet: any, isFromDB: boolean) {
    log.trace(() => `packet enter ${short(packet?.packet_id)} fromDB=${isFromDB}`);
    if (this.seenPacketIds.has(packet.packet_id)) {
      log.trace(() => `packet DROP (already seen) ${short(packet.packet_id)}`);
      return;
    }
    this.seenPacketIds.add(packet.packet_id);

    try {
      const post = await PacketBuilder.verifyAndDecrypt(packet, threadKey, this.cryptoEng);
      if (!post) {
        log.debug(() => `packet DROP (decrypt failed: quickCheck/AEAD/signature) ${short(packet.packet_id)}`);
        return;
      }

      if (post.thread_id === threadId && post.post_type === 0) {

        const dagPost: DAGPost = {
          ...post,
          packet_id: packet.packet_id,
          parents: post.parents || [],
          cumulative_pow: post.cumulative_pow || 0,
          thread_root: post.thread_root || threadId
        };

        const isNew = this.dag.addPost(dagPost);
        log.debug(() => `dag.addPost ${short(packet.packet_id)} isNew=${isNew}`);
        if (isNew) {
          this.notify();
          // 1 件でも届いたら「無い」の表示を消す
          this.refreshEmptyStatus();

          if (!isFromDB) {
              const rawPacketData = new TextEncoder().encode(JsonBinary.stringify(packet));
              await this.db.save({ 
                boardId: boardId, 
                threadId: threadId, 
                payload: rawPacketData,
                dag: {
                  parents: dagPost.parents,
                  cumulative_pow: dagPost.cumulative_pow,
                  thread_root: dagPost.thread_root,
                  created_at: dagPost.created_at
                }
              }).catch((err) => {
                log.error(`DB Save failed for packet ${packet.packet_id}:`, err);
              });
          }
        } else {
          log.debug(`Packet ${packet.packet_id} already exists in DAG (skipped)`);
        }
      } else {
        log.warn(`Packet ${packet.packet_id} skipped: metadata mismatch.`, {
          expectedThread: threadId,
          actualThread: post.thread_id,
          postType: post.post_type
        });
      }
    } catch (e: any) {
      log.error(`Error processing packet ${packet?.packet_id}:`, e);
    }
  }

  /**
   * スレッドの同期と監視を活性化する
   */
  public async activate(boardId: string, threadId: string, boardKey: Uint8Array) {
    // 1. スレッドが切り替わった場合はリセット
    if (this.currentThreadId !== threadId) {
      this.clear();
      this.currentBoardId = boardId;
      this.currentThreadId = threadId;
      // スレッド鍵とハッシュの導出 (useThread L48-49を再現)
      this.currentThreadKey = this.keyMgr.deriveThreadKey(boardKey, threadId);
      this.currentThreadTopicHash = this.keyMgr.deriveTopicHash(this.currentThreadKey);
      // 開いているスレッドのゾーンを購読に加える (ローカルな判断。網には出ない)
      this.unwatchZone = this.zm.watchTopic?.(this.currentThreadTopicHash) ?? null;
      this.dag = new ThreadDAGManager(threadId);

    }

    if (!this.currentThreadKey) return;

    this.updateStatus('loading', '過去ログを読み込み中...');

    // 2. リスナーの登録（一度だけ）
    if (!this.isListening) {
      this.router.onMessage(this.onGossipPacket);
      this.pm.on('peer:connect', this.onPeerConnect);
      // Hint の試行復号にスレッド鍵を渡す。
      // 登録した時点で、手元に溜まっている Hint を HintRouter が開き直す。
      this.schrodinger.addKey(this.hintKeyId(threadId), this.currentThreadKey);
      this.schrodinger.onBody(this.onHintBody);
      this.isListening = true;
    }

    // 3. ローカルDBからキャッシュを復元
    await this.loadInitialCache(boardId, threadId, this.currentThreadKey);

    // 4. ネットワーク同期
    await this.triggerInitialSync(boardId, threadId, boardKey);
  }

  /**
   * 初回のネットワーク同期 (接続待ちを含む)
   */
  private async triggerInitialSync(boardId: string, threadId: string, boardKey: Uint8Array) {
    if (this.dag.getCount() === 0) {
      this.updateStatus('loading', '隣人を探しています...');
    }

    // 隣人がいない場合は少し待つ (useThread L142-156 を再現)
    let isOnline = false;
    if (this.pm.degree > 0) {
      isOnline = true;
    } else {
      isOnline = await new Promise<boolean>((resolve) => {
        let resolved = false;
        const timer = setTimeout(() => {
          if (!resolved) { resolved = true; resolve(false); }
        }, 10000);
        const onConn = () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            this.pm.off('peer:connect', onConn);
            resolve(true);
          }
        };
        this.pm.on('peer:connect', onConn);
      });
    }

    if (isOnline) {
      await this.fullSync(boardId, threadId, boardKey);
    } else {
      this.refreshEmptyStatus();
    }
  }

  /**
   * ネットワーク(DHT)から過去ログを同期する
   */
  public async fullSync(boardId: string, threadId: string, boardKey: Uint8Array): Promise<void> {
    if (this.syncInFlight) return this.syncInFlight;
    this.syncInFlight = this.runFullSync(boardId, threadId, boardKey).finally(() => {
      this.syncInFlight = null;
    });
    return this.syncInFlight;
  }

  private async runFullSync(boardId: string, threadId: string, boardKey: Uint8Array): Promise<void> {
    if (this.pm.degree === 0) {
      this.refreshEmptyStatus();
      return;
    }

    this.updateStatus('syncing', 'ピアと同期中 (DHT同期)...');
    try {
      // ★ SyncProtocol による固定 topicHash からの一括取得は廃止した。
      //
      //   `deriveTopicHash(threadKey)` はスレッド鍵を持つ者なら誰でも計算できる。
      //   これで GET を投げると、受けた K 人に
      //   「この IP はこのスレを読んでいる」が直接漏れる。
      //   しかも問い合わせ先はトピック座標が決めるので、そこに peerId を
      //   グラインドした攻撃者はそのスレの全読者を観測できた。
      //
      //   板側は Phase 2 で塞いだが、スレッド側は SyncProtocol 経由で
      //   残っていた (実網ログで発覚)。
      //   履歴は板と同じく Hint 経由で届く:
      //     - 接続時に隣人が送ってくるバックログ
      //     - 保持者による定期再放流
      //     - 鍵登録時に手元の Hint を開き直した分
      
      // 「無い」の判定は refreshEmptyStatus に一本化する (即断しない)
      this.refreshEmptyStatus();
    } catch (e) {
      log.warn('[ThreadOrchestrator] sync error:', e);
      this.updateStatus('error', '同期中にエラーが発生しました');
    }
  }

  /**
   * ハンドラ: 新しいパケットを検知したとき
   */
  private onGossipPacket = async (packet: any) => {
    if (this.currentBoardId && this.currentThreadId && this.currentThreadKey) {
      await this.handlePacketObject(this.currentBoardId, this.currentThreadId, this.currentThreadKey, packet, false);
    } else {
      log.trace(() => `gossip DROP (thread not activated, current=${this.currentThreadId}) ${short(packet?.packet_id)}`);
    }
  };

  /**
   * ハンドラ: 新しい隣人と繋がったとき
   */
  /** 接続が連続して張られたときに fullSync が何本も重ならないようデバウンスする */
  private onPeerConnect = () => {
    // 新しい隣人は履歴を持っているかもしれない。空判定の猶予を引き直す。
    if (this.dag.getCount() === 0) this.firstPeerAt = Date.now();
    this.refreshEmptyStatus();

    if (!this.currentBoardId || !this.currentThreadId || !this.currentBoardKey) return;
    if (this.syncDebounce) clearTimeout(this.syncDebounce);
    this.syncDebounce = setTimeout(() => {
      this.syncDebounce = null;
      if (this.currentBoardId && this.currentThreadId && this.currentBoardKey) {
        this.fullSync(this.currentBoardId, this.currentThreadId, this.currentBoardKey);
      }
    }, 500);
  };


  /**
   * スレッドへ返信を投稿する
   */
  public async submitReply(text: string) {
    if (!text || !this.currentThreadKey || !this.currentThreadId || !this.currentThreadTopicHash || !this.currentBoardId) return;

    this.updateStatus('submitting', 'PoW計算中...', true, 20);

    try {

      // 網共通の固定値。端末の閲覧状況から計算した値をヘッダに載せない (PowPolicy 参照)
      const powDifficulty = POW_POLICY.NETWORK_DIFFICULTY;

      const tips = this.dag.getTips();
      const currentWeight = this.dag.getMaxCumulativePow();
      const nextWeight = currentWeight + powDifficulty;

      // ★ post_number は 0 固定 (A5)。旧実装は「手元の DAG に何件見えているか」を
      //   入れていた。鍵を持つ全員に見えるので、作者の閲覧状況 (どこまで受信していたか)
      //   の指紋になる。表示は DAG の順序から付けるので、この値は使っていない。
      const postNumber = 0;
      const packet = await PacketBuilder.build(
        text, this.currentThreadKey, this.identity, this.cryptoEng,
        this.powEng, this.keyMgr, this.currentBoardId, this.currentThreadId,
        postNumber, null, powDifficulty, this.zm.depth, 0,
        tips, this.currentThreadId, nextWeight
      );

      // Immediately reflect the reply in local state rather than waiting for
      // the gossip loopback to come back through verifyAndDecrypt.
      // 表示上の時刻も、網に出したパケットと同じ (分単位に丸めた) 値にそろえる
      const now = packet.timestamp;
      const dagPost: DAGPost = {
        packet_id: packet.packet_id,
        content: text,
        post_number: postNumber,
        created_at: now,
        board_id: this.currentBoardId!,
        thread_id: this.currentThreadId!,
        parents: tips,
        cumulative_pow: nextWeight,
        thread_root: this.currentThreadId!,
      };
      const rawPacketData = new TextEncoder().encode(JsonBinary.stringify(packet));
      if (this.dag.addPost(dagPost)) {
        this.seenPacketIds.add(packet.packet_id);
        this.notify();
        await this.db.save({
          boardId: this.currentBoardId!,
          threadId: this.currentThreadId!,
          payload: rawPacketData,
          dag: { parents: tips, cumulative_pow: nextWeight, thread_root: this.currentThreadId!, created_at: now }
        }).catch(() => {});
      }

      this.updateStatus('submitting', '送信完了 (配信待機中...)', true, 100);

      // 物理送信 (バックグラウンド)。
      // ★ 本体はランダムな Slot へ、その在り処は Hint で配る。どちらもオニオン回路に載る。
      //   旧実装は `topicHash = SHA512(threadKey)` という固定鍵に置いていたが、
      //   これはスレッド鍵を持つ者なら誰でも計算できるため、GET を受けた
      //   K 人に「この IP はこのスレを読んでいる」が直接漏れていた。
      this.sendAnonymously(packet, this.currentThreadKey, randomMessageId(), rawPacketData.length);

      this.updateStatus('idle', '計算完了！送信中...', false, 0);
      setTimeout(() => this.updateStatus('idle', ''), 3000);

    } catch (err: any) {
      log.error('Failed to prepare packet:', err);
      this.updateStatus('error', '🔴 失敗: ' + err.toString());
    }
  }

  /**
   * 投稿をオニオン回路で送り出す (BoardOrchestrator.sendAnonymously と同じ方針)。
   * 回路で届かなかった場合は平文に落とさず、その旨を表示する (Fail-Closed)。
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
      log.error('[ThreadOrchestrator] anonymous send failed:', err);
    });
  }

  /**
   * DBから既知のパケットを読み込む
   */

  private async loadInitialCache(boardId: string, threadId: string, threadKey: Uint8Array) {
    const rawEntries = await this.db.getPosts(boardId, threadId).catch(() => []);
    for (const entry of rawEntries) {
      try {
        const packet = JsonBinary.parse(new TextDecoder().decode(entry.payload));
        await this.handlePacketObject(boardId, threadId, threadKey, packet, true);
      } catch (e) {}
    }
  }


  /**
   * メモリ状態をリセットする
   */
  public clear() {
    this.firstPeerAt = null;
    if (this.emptyVerdictTimer) {
      clearTimeout(this.emptyVerdictTimer);
      this.emptyVerdictTimer = null;
    }
    if (this.syncDebounce) {
      clearTimeout(this.syncDebounce);
      this.syncDebounce = null;
    }
    if (this.currentThreadId) {
      this.schrodinger.removeKey(this.hintKeyId(this.currentThreadId));
    }
    if (this.isListening) {
      this.router.offMessage(this.onGossipPacket);
      this.pm.off('peer:connect', this.onPeerConnect);
      this.isListening = false;
    }

    this.unwatchZone?.();
    this.unwatchZone = null;
    this.dag = new ThreadDAGManager('');
    this.seenPacketIds.clear();
    this.currentBoardId = null;
    this.currentBoardKey = null;
    this.currentThreadId = null;
    this.currentThreadKey = null;
    this.currentThreadTopicHash = null;
    this.updateStatus('idle', '');

    this.notify();
  }

}

/** ログ用の短縮表示。undefined でも落ちないようにしておく */
function short(id: string | undefined | null): string {
  return id ? id.substring(0, 8) : '?';
}
