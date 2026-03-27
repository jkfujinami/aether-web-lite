import { openDB } from 'idb';
import type { IDBPDatabase } from 'idb';
import type { IPostStore } from '../types';

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

export class IndexedDBStore implements IPostStore {
  private db!: IDBPDatabase;

  public async init() {
    this.db = await openDB('AetherLiteDB', 4, {
      upgrade(db, _oldVersion) {
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
        }

        if (!db.objectStoreNames.contains('identity')) {
          db.createObjectStore('identity', { keyPath: 'key' });
        }

        // Thread Statistics (For Ranking)
        if (!db.objectStoreNames.contains('threads')) {
          const store = db.createObjectStore('threads', { keyPath: 'threadId' });
          store.createIndex('boardId', 'boardId');
        }
      },
    });
  }

  // --- IMailbox Storage Implementation ---

  public async get(topicHash: string): Promise<Uint8Array[] | undefined> {
    const record = await this.db.get('mailbox', topicHash) as MailboxEntry | undefined;
    return record?.entries;
  }

  public async put(topicHash: string, newEntries: Uint8Array[]): Promise<void> {
    const tx = this.db.transaction('mailbox', 'readwrite');
    const store = tx.objectStore('mailbox');
    let record = await store.get(topicHash) as MailboxEntry | undefined;
    
    if (record) {
      const existingHexes = new Set(record.entries.map(e => this.toHex(e)));
      for (const e of newEntries) {
        if (!existingHexes.has(this.toHex(e))) {
          record.entries.push(e);
        }
      }
      record.lastUpdated = Date.now();
      await store.put(record);
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
    return this.db.getAllKeys('mailbox') as Promise<string[]>;
  }

  // --- IPostStore Implementation ---

  public async save(post: { boardId: string; threadId: string; payload: Uint8Array; dag?: any }): Promise<void> {
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
        const existing = await threadStore.get(post.threadId);
        const currentMaxPow = existing ? existing.max_pow : 0;
        const newMaxPow = Math.max(currentMaxPow, post.dag.cumulative_pow || 0);
        
        // 初回投稿(スレ立てパケットなど)の場合は created_at を設定
        const createdAt = existing ? existing.created_at : Date.now();

        await threadStore.put({
            threadId: post.threadId,
            boardId: post.boardId,
            max_pow: newMaxPow,
            created_at: createdAt,
            last_updated: Date.now()
        });
    }

    await tx.done;
  }

  public async getThreads(boardId: string): Promise<any[]> {
    const tx = this.db.transaction('threads', 'readonly');
    const store = tx.objectStore('threads');
    const index = store.index('boardId');
    return index.getAll(boardId);
  }

  public async getPosts(boardId: string, threadId: string): Promise<PostEntry[]> {
    const tx = this.db.transaction('posts', 'readonly');
    const store = tx.objectStore('posts');
    const index = store.index('board_thread');
    
    const results = await index.getAll([boardId, threadId]);
    return results.sort((a, b) => a.timestamp - b.timestamp);
  }

  // --- Identity / Trip Storage ---

  public async getTrip(): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array } | undefined> {
    const record = await this.db.get('identity', 'primary');
    if (!record) return undefined;
    return {
      publicKey: record.publicKey,
      privateKey: record.privateKey,
    };
  }

  public async saveTrip(publicKey: Uint8Array, privateKey: Uint8Array): Promise<void> {
    await this.db.put('identity', {
      key: 'primary',
      publicKey,
      privateKey,
      updatedAt: Date.now(),
    });
  }

  public async deleteTrip(): Promise<void> {
    await this.db.delete('identity', 'primary');
  }

  private toHex(buf: Uint8Array): string {
    return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
  }
}
