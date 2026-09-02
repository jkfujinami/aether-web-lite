import type { IndexedDBStore } from '../storage/IndexedDBStore';
import type { DHTMailbox } from '../network/mailbox/DHTMailbox';
import type { ZoneGossipRouter } from '../network/gossip/ZoneGossipRouter';
import type { CryptoEngine } from '../crypto/CryptoEngine';
import type { Identity } from '../crypto/Identity';
import type { IPeerManager, IZoneManager, IPoWEngine, IKeyManager } from '../types';
import type { ThreadMeta } from './types';
import { PacketBuilder } from '../crypto/PacketBuilder';
import { KeyManager } from '../crypto/KeyManager';
import { DifficultyEstimator } from '../crypto/DifficultyEstimator';
import { BOARD_META_THREAD_ID, BoardStatus } from './types';



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




  constructor(
    private pm: IPeerManager,
    private db: IndexedDBStore,
    private mailbox: DHTMailbox,
    private router: ZoneGossipRouter,
    private cryptoEng: CryptoEngine,
    private powEng: IPoWEngine,
    private identity: Identity,
    private zm: IZoneManager,
    private keyMgr: IKeyManager
  ) {}


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
    this.currentStatus = { phase, message, isSubmitting, powProgress };
    this.statusListeners.forEach(l => l());
  }



  /**
   * スナップショットを作り直してから購読者に「変わった」と伝える。
   *
   * 参照が必ず変わるので、React は確実に再描画する。
   */
  private notify() {
    this.snapshot = Array.from(this.threads.values());
    console.log(`[TRACE:6-notify] BoardOrchestrator snapshot rebuilt: ${this.snapshot.length} threads, notifying ${this.listeners.size} listener(s)`);
    this.listeners.forEach(l => l());
  }

  // --- 以降、将来のステップでロジックを順次移植する ---

  /**
   * パケット（JSONオブジェクト）を処理し、板の状態を更新する
   */
  public async handlePacketObject(boardId: string, boardKey: Uint8Array, packet: any, isFromDB: boolean, rawData?: Uint8Array) {
    console.log(`[TRACE:4-handlePacketObject] enter packet_id=${packet?.packet_id?.substring(0, 8)} isFromDB=${isFromDB}`);
    if (this.seenPacketIds.has(packet.packet_id)) {
      console.log(`[TRACE:4-handlePacketObject] DROPPED already in seenPacketIds packet_id=${packet.packet_id.substring(0, 8)}`);
      return;
    }
    this.seenPacketIds.add(packet.packet_id);
    try {
      const meta = await PacketBuilder.verifyAndDecrypt(packet, boardKey, this.cryptoEng);
      if (!meta) {
        console.debug(`[TRACE:4-handlePacketObject] DROPPED decrypted to null (failed quickCheck, AEAD, or signature) packet_id=${packet.packet_id}`);
        return;
      }
      if (meta.post_type !== 1) {
        console.debug(`[TRACE:4-handlePacketObject] DROPPED post_type is not 1 (thread meta) but ${meta.post_type} packet_id=${packet.packet_id}`);
        return;
      }

      const created_at = this.normalizeTimestamp(meta.created_at);
      const max_pow = await this.resolveMaxPow(boardId, meta);
      const changed = this.mergeThread(meta, packet.packet_id, max_pow, created_at);
      console.log(`[TRACE:5-mergeThread] thread_id=${meta.thread_id.substring(0, 8)} changed=${changed} totalThreads=${this.threads.size}`);
      if (changed) this.notify();
      if (!isFromDB) await this.persistThread(boardId, packet, meta, rawData);
    } catch (e: any) {
      console.error(`[BoardOrchestrator] Error processing packet ${packet?.packet_id}:`, e);
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
      console.error(`[BoardOrchestrator] DB Save failed for thread meta ${meta?.thread_id}:`, err);
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
        this.updateStatus('loading', '隣人を探しています (接続中)...');
        return;
      }

      this.updateStatus('syncing', `${this.pm.degree}人の隣人から最新のスレッドを取得中...`);
      
      // Board Meta Topic Hash は SHA-512 (128文字) を使用
      const boardTopicHash = KeyManager.toHex(KeyManager.cryptoHash(boardKey));
      const entries = await this.mailbox.fetch(boardTopicHash);
      
      for (const entry of entries) {
        try {
          const rawPacket = (entry as any).payload || entry;
          if (rawPacket instanceof Uint8Array) {
            const decoded = new TextDecoder().decode(rawPacket);
            const packet = JSON.parse(decoded, (_k, v) => {
              if (v && v._type === 'Uint8Array') return new Uint8Array(v.data);
              return v;
            });
            await this.handlePacketObject(boardId, boardKey, packet, false, rawPacket);
          }
        } catch (e) {
          console.warn('[BoardOrchestrator] Packet parse error (skipping):', e);
        }
      }


      const currentCount = this.threads.size;
      if (currentCount === 0) {
        this.updateStatus('idle', 'スレッドが見つかりませんでした。一番乗りで立ててみませんか？');
      } else {
        this.updateStatus('idle', '');
      }

      // 定期的なDB統計の同期を開始
      this.startStatsSync(boardId);

    } catch (err) {
      console.error('[BoardOrchestrator] fullSync error:', err);
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
      console.log(`[TRACE:3.5-onGossipPacket] DROPPED not activated (currentBoardId=${this.currentBoardId}) packet_id=${packet?.packet_id?.substring(0, 8)}`);
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

      const timestamps = await this.db.getRecentTimestamps(DifficultyEstimator.WINDOW);
      const powDifficulty = DifficultyEstimator.compute(timestamps);

      const packet = await PacketBuilder.build(
        title, boardKey, this.identity, this.cryptoEng,
        this.powEng, this.keyMgr, boardId, threadId,
        0, null, powDifficulty, boardZoneId, 1,
        [], threadId, powDifficulty
      );

      this.updateStatus('submitting', '拡散中...', true, 100);

      const boardB64TopicHash = KeyManager.toHex(KeyManager.cryptoHash(boardKey));
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
      this.router.broadcast(packet).catch((err: any) => {
        console.error('[BoardOrchestrator] Gossip broadcast failed:', err);
      });
      this.mailbox.publish(boardB64TopicHash, rawPacketData).catch((e: any) => {
        console.warn('[BoardOrchestrator] Mailbox publish failed:', e);
      });

      this.updateStatus('idle', '', false, 0);
      return threadId;
    } catch (err) {
      console.error('[BoardOrchestrator] submitThread error:', err);
      this.updateStatus('error', 'スレッドの作成に失敗しました', false, 0);
      return null;
    }
  }


  /**
   * メモリ状態をリセットする（板の切り替え時など）
   */
  public clear() {
    this.stopStatsSync();
    if (this.syncDebounce) {
      clearTimeout(this.syncDebounce);
      this.syncDebounce = null;
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
