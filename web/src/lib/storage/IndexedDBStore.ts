import { openDB, type IDBPDatabase } from 'idb';
import { Encoding } from '../common/Encoding';

export interface MailboxEntry {
  topicHash: string;
  entries: Uint8Array[];
  lastUpdated: number;
}

export interface PostEntry {
  id?: number;
  boardId: string;
  threadId: string;
  payload: Uint8Array;
  timestamp: number;
}

export class IndexedDBStore {
  private db!: IDBPDatabase;

  public async init() {
    this.db = await openDB('AetherLiteDB', 5, {
      upgrade(db, _oldVersion, _newVersion, transaction) {
        // Mailbox (Raw Packets)
        if (!db.objectStoreNames.contains('mailbox')) {
          const store = db.createObjectStore('mailbox', { keyPath: 'topicHash' });
          store.createIndex('lastUpdated', 'lastUpdated');
        }

        // Posts (Decrypted/Verified)
        if (!db.objectStoreNames.contains('posts')) {
          const store = db.createObjectStore('posts', { keyPath: 'id', autoIncrement: true });
          store.createIndex('board_thread', ['boardId', 'threadId']);
          store.createIndex('timestamp', 'timestamp');
        } else {
          // 既存の posts にインデックスがない場合の補填
          const store = transaction.objectStore('posts');
          if (!store.indexNames.contains('board_thread')) {
            store.createIndex('board_thread', ['boardId', 'threadId']);
          }
        }

        // Identity / Trip
        if (!db.objectStoreNames.contains('identity')) {
          db.createObjectStore('identity', { keyPath: 'key' });
        }

        // Thread Statistics (For Ranking)
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

  // --- IMailbox Storage Implementation ---

  public async get(topicHash: string): Promise<Uint8Array[] | undefined> {
    if (!this.db) return undefined;
    const record = await this.db.get('mailbox', topicHash) as MailboxEntry | undefined;
    return record?.entries;
  }

  public async put(topicHash: string, newEntries: Uint8Array[]): Promise<void> {
    if (!this.db) return;
    const tx = this.db.transaction('mailbox', 'readwrite');
    const store = tx.objectStore('mailbox');
    let record = await store.get(topicHash) as MailboxEntry | undefined;
    
    if (record) {
      const existingHexes = new Set(record.entries.map(e => Encoding.toHex(e)));
      let changed = false;
      for (const e of newEntries) {
        if (!existingHexes.has(Encoding.toHex(e))) {
          record.entries.push(e);
          changed = true;
        }
      }
      if (changed) {
        record.lastUpdated = Date.now();
        await store.put(record);
      }
    } else {
      await store.put({
        topicHash,
        entries: newEntries,
        lastUpdated: Date.now()
      });
    }
    await tx.done;
  }

  public async getAllTopicHashes(): Promise<string[]> {
    if (!this.db) return [];
    return this.db.getAllKeys('mailbox') as Promise<string[]>;
  }

  // --- IPostStore Implementation ---

  public async save(post: { boardId: string; threadId: string; payload: Uint8Array; dag?: any }): Promise<void> {
    if (!this.db) return;
    const tx = this.db.transaction(['posts', 'threads'], 'readwrite');
    const postStore = tx.objectStore('posts');
    const threadStore = tx.objectStore('threads');
    
    // 1. 投稿の保存
    await postStore.add({
      boardId: post.boardId,
      threadId: post.threadId,
      payload: post.payload,
      timestamp: Date.now(),
    });

    // 2. スレッド統計の更新 (DAGメタデータがある場合)
    if (post.dag) {
        // 仮想トピック __board_meta__ ではなく、実際のスレッドルートをキーにする
        const targetThreadId = post.dag.thread_root || post.threadId;
        const existing = await threadStore.get(targetThreadId);
        
        const currentMaxPow = existing ? (existing.max_pow || 0) : 0;
        const newMaxPow = Math.max(currentMaxPow, post.dag.cumulative_pow || 0);
        
        // created_at: 既存値が有効ならそれを保持、壊れていたら新しい値で上書き
        const existingCreatedAt = existing ? existing.created_at : null;
        const incomingCreatedAt = post.dag.created_at;
        const isExistingValid = typeof existingCreatedAt === 'number' && isFinite(existingCreatedAt) && existingCreatedAt > 0;
        const isIncomingValid = typeof incomingCreatedAt === 'number' && isFinite(incomingCreatedAt) && incomingCreatedAt > 0;
        const createdAt = isExistingValid ? existingCreatedAt : (isIncomingValid ? incomingCreatedAt : Date.now());

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

  public async getThreads(boardId: string): Promise<any[]> {
    if (!this.db) return [];
    const tx = this.db.transaction('threads', 'readonly');
    const store = tx.objectStore('threads');
    const index = store.index('boardId');
    return index.getAll(boardId);
  }

  public async getPosts(boardId: string, threadId: string): Promise<PostEntry[]> {
    if (!this.db) return [];
    const tx = this.db.transaction('posts', 'readonly');
    const store = tx.objectStore('posts');
    const index = store.index('board_thread');

    const results = await index.getAll([boardId, threadId]);
    return results.sort((a, b) => a.timestamp - b.timestamp);
  }

  public async getRecentTimestamps(count: number): Promise<number[]> {
    if (!this.db) return [];
    const all = await this.db.getAllFromIndex('posts', 'timestamp');
    return all.slice(-count).map((r: any) => r.timestamp as number);
  }

  // --- Identity / Trip Storage ---

  public async getTrip(): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array } | undefined> {
    if (!this.db) return undefined;
    const record = await this.db.get('identity', 'primary');
    if (!record) return undefined;
    return {
      publicKey: record.publicKey,
      privateKey: record.privateKey,
    };
  }

  public async saveTrip(publicKey: Uint8Array, privateKey: Uint8Array): Promise<void> {
    if (!this.db) return;
    await this.db.put('identity', {
      key: 'primary',
      publicKey,
      privateKey,
      updatedAt: Date.now(),
    });
  }

  public async deleteTrip(): Promise<void> {
    if (!this.db) return;
    await this.db.delete('identity', 'primary');
  }
}
