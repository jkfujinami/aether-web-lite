import { openDB, type IDBPDatabase } from 'idb';

export class IndexedDBStore {
  private db!: IDBPDatabase;

  public async init() {
    this.db = await openDB('AetherLiteDB', 5, {
      upgrade(db, _oldVersion, _newVersion, transaction) {
        // Mailbox (Raw Packets)
        if (!db.objectStoreNames.contains('mailbox')) {
          const store = db.createObjectStore('mailbox', { keyPath: 'topicHash' });
          store.createIndex('timestamp', 'timestamp');
        }

        // Posts (Decrypted/Verified)
        if (!db.objectStoreNames.contains('posts')) {
          const store = db.createObjectStore('posts', { keyPath: 'id', autoIncrement: true });
          store.createIndex('boardId', 'boardId');
          store.createIndex('threadId', 'threadId');
          store.createIndex('board_thread', ['boardId', 'threadId']);
          store.createIndex('timestamp', 'timestamp');
        } else {
          const store = transaction.objectStore('posts');
          if (!store.indexNames.contains('boardId')) store.createIndex('boardId', 'boardId');
          if (!store.indexNames.contains('threadId')) store.createIndex('threadId', 'threadId');
          if (!store.indexNames.contains('board_thread')) store.createIndex('board_thread', ['boardId', 'threadId']);
        }

        if (!db.objectStoreNames.contains('identity')) {
          db.createObjectStore('identity', { keyPath: 'pubkey' });
        }

        if (!db.objectStoreNames.contains('threads')) {
          const store = db.createObjectStore('threads', { keyPath: 'threadId' });
          store.createIndex('boardId', 'boardId');
        } else {
          const store = transaction.objectStore('threads');
          if (!store.indexNames.contains('boardId')) {
            store.createIndex('boardId', 'boardId');
          }
        }
      },
    });
  }

  public async save(post: any) {
    if (!this.db) return;
    const tx = this.db.transaction(['posts', 'threads'], 'readwrite');
    const postStore = tx.objectStore('posts');
    const threadStore = tx.objectStore('threads');
    
    // 投稿そのものの保存
    await postStore.add({
        boardId: post.boardId,
        threadId: post.threadId,
        payload: post.payload,
        timestamp: Date.now()
    });

    // スレッド統計の更新 (DAGメタデータがある場合)
    if (post.dag) {
        const targetThreadId = post.dag.thread_root || post.threadId;
        const existing = await threadStore.get(targetThreadId);
        
        const currentMaxPow = existing ? (existing.max_pow || 0) : 0;
        const newMaxPow = Math.max(currentMaxPow, post.dag.cumulative_pow || 0);
        
        // 常に古い方を採用する（新参ノードが勝手に上書きするのを防ぐ）
        // post.dag.created_at も正規化を検討するが、ここではDB保存時の生データとして扱う
        const createdAt = existing ? existing.created_at : (post.dag.created_at || Date.now());

        await threadStore.put({
            threadId: targetThreadId,
            boardId: post.boardId,
            max_pow: newMaxPow,
            created_at: createdAt,
            last_updated: Date.now()
        });
    }

    await tx.done;
  }

  public async getPosts(boardId: string, threadId: string): Promise<any[]> {
    const tx = this.db.transaction('posts', 'readonly');
    const store = tx.objectStore('posts');
    const index = store.index('board_thread');
    return index.getAll([boardId, threadId]);
  }

  public async getThreads(boardId: string): Promise<any[]> {
    const tx = this.db.transaction('threads', 'readonly');
    const store = tx.objectStore('threads');
    const index = store.index('boardId');
    return index.getAll(boardId);
  }
}
