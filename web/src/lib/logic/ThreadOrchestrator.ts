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
import { DifficultyEstimator } from '../crypto/DifficultyEstimator';




/**
 * ThreadOrchestrator
 * 特定のスレッドにおける投稿（Post）の取得、DAG構築、同期、および投稿を統括する。
 */
export class ThreadOrchestrator {
  private listeners: Set<(posts: DAGPost[]) => void> = new Set();
  private statusListeners: Set<(status: ThreadStatus) => void> = new Set();
  private dag: ThreadDAGManager = new ThreadDAGManager(''); // 初期はダミー
  private seenPacketIds: Set<string> = new Set();
  private currentStatus: ThreadStatus = { phase: 'idle', message: '' };

  private currentBoardId: string | null = null;
  private currentBoardKey: Uint8Array | null = null;
  private currentThreadId: string | null = null;
  private currentThreadKey: Uint8Array | null = null;
  private currentThreadTopicHash: Uint8Array | null = null;
  private isListening: boolean = false;



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
    private syncProtocol: SyncProtocol
  ) {}

  public subscribe(listener: (posts: DAGPost[]) => void) {
    this.listeners.add(listener);
    listener(this.getPosts());
    return () => this.listeners.delete(listener);
  }

  public subscribeStatus(listener: (status: ThreadStatus) => void) {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => this.statusListeners.delete(listener);
  }

  public getPosts(): DAGPost[] {
    return this.dag.getSortedPosts();
  }

  private updateStatus(phase: ThreadStatus['phase'], message: string, isSubmitting: boolean = false, powProgress: number = 0) {
    this.currentStatus = { phase, message, isSubmitting, powProgress };
    this.statusListeners.forEach(l => l(this.currentStatus));
  }

  private notify() {
    const list = this.getPosts();
    this.listeners.forEach(l => l(list));
  }

  /**
   * パケット（JSONオブジェクト）を処理し、DAGを更新する
   */
  public async handlePacketObject(boardId: string, threadId: string, threadKey: Uint8Array, packet: any, isFromDB: boolean) {
    if (this.seenPacketIds.has(packet.packet_id)) return;
    this.seenPacketIds.add(packet.packet_id);

    try {
      const post = await PacketBuilder.verifyAndDecrypt(packet, threadKey, this.cryptoEng);
      if (!post) {
        console.warn(`[ThreadOrchestrator] Packet ${packet.packet_id} decrypted to null (failed quickCheck, AEAD, or signature)`);
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
        if (isNew) {
          this.notify();
          
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
                console.error(`[ThreadOrchestrator] DB Save failed for packet ${packet.packet_id}:`, err);
              });
          }
        } else {
          console.log(`[ThreadOrchestrator] Packet ${packet.packet_id} already exists in DAG (skipped)`);
        }
      } else {
        console.warn(`[ThreadOrchestrator] Packet ${packet.packet_id} skipped: metadata mismatch.`, {
          expectedThread: threadId,
          actualThread: post.thread_id,
          postType: post.post_type
        });
      }
    } catch (e: any) {
      console.error(`[ThreadOrchestrator] Error processing packet ${packet?.packet_id}:`, e);
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
      this.dag = new ThreadDAGManager(threadId);

    }

    if (!this.currentThreadKey) return;

    this.updateStatus('loading', '過去ログを読み込み中...');

    // 2. リスナーの登録（一度だけ）
    if (!this.isListening) {
      this.router.onMessage(this.onGossipPacket);
      this.pm.on('peer:connect', this.onPeerConnect);
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
    } else if (this.dag.getCount() === 0) {
      this.updateStatus('idle', 'ネット接続待機中... 他の人がレスをすれば自動で反映されます。');
    }
  }

  /**
   * ネットワーク(DHT)から過去ログを同期する
   */
  public async fullSync(boardId: string, threadId: string, boardKey: Uint8Array) {
    if (this.pm.degree === 0) return;

    this.updateStatus('syncing', 'ピアと同期中 (DHT同期)...');
    try {
      const recoveredCount = await this.syncProtocol.syncThread(boardId, threadId, boardKey).catch(() => 0);
      if (recoveredCount > 0 && this.currentThreadKey) {
        // 新しいパケットがあればDBから読み直す
        await this.loadInitialCache(boardId, threadId, this.currentThreadKey);
      }
      
      if (this.dag.getCount() === 0) {
        this.updateStatus('idle', 'レスが1件もありませんでした。あなたが最初の投稿者になりませんか？');
      } else {
        this.updateStatus('idle', '');
      }
    } catch (e) {
      console.warn('[ThreadOrchestrator] sync error:', e);
      this.updateStatus('error', '同期中にエラーが発生しました');
    }
  }

  /**
   * ハンドラ: 新しいパケットを検知したとき
   */
  private onGossipPacket = async (packet: any) => {
    if (this.currentBoardId && this.currentThreadId && this.currentThreadKey) {
      await this.handlePacketObject(this.currentBoardId, this.currentThreadId, this.currentThreadKey, packet, false);
    }
  };

  /**
   * ハンドラ: 新しい隣人と繋がったとき
   */
  private onPeerConnect = () => {
    if (this.currentBoardId && this.currentThreadId && this.currentBoardKey) {
      this.fullSync(this.currentBoardId, this.currentThreadId, this.currentBoardKey);
    }
  };


  /**
   * スレッドへ返信を投稿する
   */
  public async submitReply(text: string) {
    if (!text || !this.currentThreadKey || !this.currentThreadId || !this.currentThreadTopicHash || !this.currentBoardId) return;

    this.updateStatus('submitting', 'PoW計算中...', true, 20);

    try {
      const currentZoneId = this.keyMgr.computeZoneId(this.currentThreadTopicHash, this.zm.depth);

      const timestamps = await this.db.getRecentTimestamps(DifficultyEstimator.WINDOW);
      const powDifficulty = DifficultyEstimator.compute(timestamps);

      const tips = this.dag.getTips();
      const currentWeight = this.dag.getMaxCumulativePow();
      const nextWeight = currentWeight + powDifficulty;

      const postNumber = this.dag.getCount();
      const packet = await PacketBuilder.build(
        text, this.currentThreadKey, this.identity, this.cryptoEng,
        this.powEng, this.keyMgr, this.currentBoardId, this.currentThreadId,
        postNumber, null, powDifficulty, currentZoneId, 0,
        tips, this.currentThreadId, nextWeight
      );

      // Immediately reflect the reply in local state rather than waiting for
      // the gossip loopback to come back through verifyAndDecrypt.
      const now = Date.now();
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

      // 物理送信 (バックグラウンド)
      this.router.broadcast(packet).catch((err: any) => {
        console.error('ゴシップ送信に失敗:', err);
      });

      const topicHex = KeyManager.toHex(this.currentThreadTopicHash);

      this.mailbox.publish(topicHex, rawPacketData).catch((err: any) => {
        console.warn('[ThreadOrchestrator] Mailbox publish failed:', err);
      });

      this.updateStatus('idle', '計算完了！送信中...', false, 0);
      setTimeout(() => this.updateStatus('idle', ''), 3000);

    } catch (err: any) {
      console.error('Failed to prepare packet:', err);
      this.updateStatus('error', '🔴 失敗: ' + err.toString());
    }
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
    if (this.isListening) {
      this.router.offMessage(this.onGossipPacket);
      this.pm.off('peer:connect', this.onPeerConnect);
      this.isListening = false;
    }

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
