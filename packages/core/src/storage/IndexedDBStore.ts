import { openDB, deleteDB, type IDBPDatabase } from 'idb';
import { Encoding } from '../common/Encoding';
import { createLogger } from '../common/Logger';
import { SecretVault, VAULT_PARAMS, type SealedSecret, type VaultParams } from './SecretVault';
import { DataVault, WrongPassphraseError } from './DataVault';

const log = createLogger('storage.idb');

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

export interface BoardRecord {
  boardId: string;
  key: Uint8Array;
  addedAt: number;
}

const DB_VERSION = 7;

/** 封印された DEK の置き場所 (identity ストアの予約キー) */
const DEK_SLOT = '__dek__';

/** 1 日 (ms)。保管時刻はこの単位に丸めて平文に置く (期限切れ削除のためだけ) */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * IndexedDBStore — 端末上の全データの置き場所。
 *
 * ★ v7 で全面暗号化した (パスワード必須)。
 *
 *   {@link unlock} でパスワードから DEK を開くまで、データの読み書きは一切できない
 *   (fail-closed)。各レコードは {@link DataVault} で暗号化され、検索キーも
 *   鍵付きハッシュに置き換えてある。平文で残るのは
 *     - レコードの件数と大きさ
 *     - 保管中の Slot の「保管日」(日単位。期限切れ削除のため)
 *   だけである。
 *
 *   v6 以前の平文データは、初回のロック解除時に暗号化して移し、平文側は消す。
 *   (IndexedDB の下層ストレージが削除済みページを即座に上書きする保証は無いので、
 *    移行前のデータの完全な消去までは保証できない。)
 */
export class IndexedDBStore {
  private db!: IDBPDatabase;
  private vault: DataVault | null = null;

  constructor(private readonly dbName: string = 'AetherLiteDB') {}

  public async init() {
    if (this.db) return;
    this.db = await openDB(this.dbName, DB_VERSION, {
      upgrade(db: any) {
        // 封印済みの鍵 (トリップ・ノード・DEK)。v6 以前から引き継ぐ
        if (!db.objectStoreNames.contains('identity')) {
          db.createObjectStore('identity', { keyPath: 'key' });
        }
        // ── v7: 暗号化ストア ──
        if (!db.objectStoreNames.contains('eposts')) {
          const s = db.createObjectStore('eposts', { keyPath: 'id', autoIncrement: true });
          s.createIndex('bt', 'bt');
        }
        if (!db.objectStoreNames.contains('ethreads')) {
          const s = db.createObjectStore('ethreads', { keyPath: 'k' });
          s.createIndex('b', 'b');
        }
        if (!db.objectStoreNames.contains('emailbox')) {
          const s = db.createObjectStore('emailbox', { keyPath: 'k' });
          s.createIndex('day', 'day');
        }
        if (!db.objectStoreNames.contains('boards')) {
          db.createObjectStore('boards', { keyPath: 'k' });
        }
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv', { keyPath: 'k' });
        }
        // v6 以前の平文ストア ('mailbox' / 'posts' / 'threads') はここでは消さない。
        // DEK が無いと暗号化して移せないので、unlock() で移行してから空にする。
      },
    });
  }

  // ── ロック / ロック解除 ──

  /** パスワードが設定済み (= DEK の封印がある) か。ロック解除前でも呼べる */
  public async hasVault(): Promise<boolean> {
    await this.init();
    return (await this.db.get('identity', DEK_SLOT)) !== undefined;
  }

  public get isUnlocked(): boolean {
    return this.vault !== null && this.vault.isOpen;
  }

  /**
   * パスワードでロックを解除する。初回はこのパスワードで新しい DEK を作る。
   *
   * @throws WrongPassphraseError パスワードが違う
   * @throws RangeError パスワードが空
   */
  public async unlock(passphrase: string, params: VaultParams = VAULT_PARAMS): Promise<void> {
    await this.init();
    const record = await this.db.get('identity', DEK_SLOT);
    if (this.isUnlocked) {
      // ★ 解除済みでもパスワードは照合する。旧実装はここで何もせず成功を返したので、
      //   同じインスタンスでの再認証 (画面のロック解除など) がどんなパスワードでも通った。
      if (!record?.sealed) throw new WrongPassphraseError();
      DataVault.open(record.sealed as SealedSecret, passphrase).wipe();
      return;
    }

    if (record?.sealed) {
      this.vault = DataVault.open(record.sealed as SealedSecret, passphrase);
    } else {
      const { vault, sealed } = DataVault.create(passphrase, params);
      await this.db.put('identity', { key: DEK_SLOT, sealed, updatedAt: Date.now() });
      this.vault = vault;
    }

    await this.migrateLegacy(passphrase, params);
  }

  /** パスワードの変更。DEK を包み直すだけで、データは再暗号化しない */
  public async changePassphrase(oldPassphrase: string, newPassphrase: string, params: VaultParams = VAULT_PARAMS): Promise<void> {
    await this.init();
    const record = await this.db.get('identity', DEK_SLOT);
    if (!record?.sealed) throw new Error('IndexedDBStore: no vault to rewrap');
    const sealed = DataVault.rewrap(record.sealed, oldPassphrase, newPassphrase, params);
    await this.db.put('identity', { key: DEK_SLOT, sealed, updatedAt: Date.now() });
  }

  /** メモリ上の鍵を消す。以後は unlock() し直すまで読み書きできない */
  public lock(): void {
    this.vault?.wipe();
    this.vault = null;
  }

  /**
   * 即時消去 (パニックワイプ)。
   *
   * まず DEK の封印を消す。これだけで残りのデータは誰にも (自分にも) 読めなくなる
   * (crypto-shredding)。その後でデータベースごと削除する。
   * パスワードを忘れた場合の「作り直し」もこれを使う (ロック解除は要らない)。
   */
  public async wipeAll(): Promise<void> {
    await this.init();
    try {
      await this.db.delete('identity', DEK_SLOT);
    } catch (e) {
      log.error('failed to delete sealed DEK', e);
    }
    this.lock();
    this.db.close();
    this.db = undefined as any;
    await deleteDB(this.dbName);
  }

  private requireVault(): DataVault {
    if (!this.vault || !this.vault.isOpen) {
      throw new Error('IndexedDBStore is locked; call unlock(passphrase) first');
    }
    return this.vault;
  }

  // ── Mailbox (他人の Slot の保管) ──

  private mailboxKey(topicHash: string): string {
    return this.requireVault().index('mailbox', topicHash);
  }

  private async readMailbox(topicHash: string): Promise<MailboxEntry | undefined> {
    const vault = this.requireVault();
    const k = this.mailboxKey(topicHash);
    const row = await this.db.get('emailbox', k);
    if (!row) return undefined;
    return vault.open<MailboxEntry>(row.blob, `emailbox:${k}`) ?? undefined;
  }

  private async writeMailbox(record: MailboxEntry): Promise<void> {
    const vault = this.requireVault();
    const k = this.mailboxKey(record.topicHash);
    await this.db.put('emailbox', {
      k,
      day: Math.floor(record.lastUpdated / DAY_MS),
      blob: vault.seal(record, `emailbox:${k}`),
    });
  }

  public async get(topicHash: string): Promise<Uint8Array[] | undefined> {
    if (!this.db) return undefined;
    return (await this.readMailbox(topicHash))?.entries;
  }

  public async put(topicHash: string, newEntries: Uint8Array[]): Promise<void> {
    if (!this.db) return;
    const record = await this.readMailbox(topicHash);
    if (record) {
      const existingHexes = new Set(record.entries.map(e => Encoding.toHex(e)));
      let changed = false;
      for (const e of newEntries) {
        if (!existingHexes.has(Encoding.toHex(e))) {
          record.entries.push(e);
          changed = true;
        }
      }
      if (!changed) return;
      record.lastUpdated = Date.now();
      await this.writeMailbox(record);
    } else {
      await this.writeMailbox({ topicHash, entries: newEntries, lastUpdated: Date.now() });
    }
  }

  public async getAllTopicHashes(): Promise<string[]> {
    if (!this.db) return [];
    const vault = this.requireVault();
    const rows = await this.db.getAll('emailbox');
    const out: string[] = [];
    for (const row of rows) {
      const rec = vault.open<MailboxEntry>(row.blob, `emailbox:${row.k}`);
      if (rec) out.push(rec.topicHash);
    }
    return out;
  }

  /** Mailbox が占めている総バイト数 (暗号化後の大きさ) */
  public async mailboxUsageBytes(): Promise<number> {
    if (!this.db) return 0;
    this.requireVault();
    let total = 0;
    let cursor = await this.db.transaction('emailbox', 'readonly').store.openCursor();
    while (cursor) {
      total += (cursor.value.blob as Uint8Array)?.byteLength ?? 0;
      cursor = await cursor.continue();
    }
    return total;
  }

  /**
   * 保管日が cutoff より前のトピックを消す。
   * @returns 消したトピック数と解放したバイト数
   */
  public async pruneMailbox(cutoff: number): Promise<{ topics: number; bytes: number }> {
    if (!this.db) return { topics: 0, bytes: 0 };
    this.requireVault();
    const tx = this.db.transaction('emailbox', 'readwrite');
    let topics = 0;
    let bytes = 0;
    let cursor = await tx.store.index('day').openCursor(IDBKeyRange.upperBound(Math.floor(cutoff / DAY_MS), true));
    while (cursor) {
      bytes += (cursor.value.blob as Uint8Array)?.byteLength ?? 0;
      await cursor.delete();
      topics++;
      cursor = await cursor.continue();
    }
    await tx.done;
    return { topics, bytes };
  }

  // ── 投稿とスレッド統計 ──

  private postIndex(boardId: string, threadId: string): string {
    return this.requireVault().index('posts', `${boardId}\u0000${threadId}`);
  }

  public async save(post: { boardId: string; threadId: string; payload: Uint8Array; dag?: any }): Promise<void> {
    if (!this.db) return;
    const vault = this.requireVault();
    const bt = this.postIndex(post.boardId, post.threadId);
    const record: PostEntry = {
      boardId: post.boardId,
      threadId: post.threadId,
      payload: post.payload,
      timestamp: Date.now(),
    };

    const tx = this.db.transaction(['eposts', 'ethreads'], 'readwrite');
    await tx.objectStore('eposts').add({ bt, blob: vault.seal(record, `eposts:${bt}`) });

    // スレッド統計の更新 (DAGメタデータがある場合)
    if (post.dag) {
      // 仮想トピック __board_meta__ ではなく、実際のスレッドルートをキーにする
      const targetThreadId = post.dag.thread_root || post.threadId;
      const k = vault.index('thread', targetThreadId);
      const store = tx.objectStore('ethreads');
      const row = await store.get(k);
      const existing = row ? vault.open<any>(row.blob, `ethreads:${k}`) : null;

      const currentMaxPow = existing ? (existing.max_pow || 0) : 0;
      const newMaxPow = Math.max(currentMaxPow, post.dag.cumulative_pow || 0);

      // created_at: 既存値が有効ならそれを保持、壊れていたら新しい値で上書き
      const existingCreatedAt = existing ? existing.created_at : null;
      const incomingCreatedAt = post.dag.created_at;
      const isExistingValid = typeof existingCreatedAt === 'number' && isFinite(existingCreatedAt) && existingCreatedAt > 0;
      const isIncomingValid = typeof incomingCreatedAt === 'number' && isFinite(incomingCreatedAt) && incomingCreatedAt > 0;
      const createdAt = isExistingValid ? existingCreatedAt : (isIncomingValid ? incomingCreatedAt : Date.now());

      const stats = {
        threadId: targetThreadId,
        boardId: post.boardId,
        max_pow: newMaxPow,
        created_at: createdAt,
        last_updated: Date.now(),
      };
      await store.put({ k, b: vault.index('board', post.boardId), blob: vault.seal(stats, `ethreads:${k}`) });
    }

    await tx.done;
  }

  public async getThreads(boardId: string): Promise<any[]> {
    if (!this.db) return [];
    const vault = this.requireVault();
    const rows = await this.db.getAllFromIndex('ethreads', 'b', vault.index('board', boardId));
    return rows
      .map(row => vault.open<any>(row.blob, `ethreads:${row.k}`))
      .filter((s): s is any => s !== null && s.boardId === boardId);
  }

  public async getPosts(boardId: string, threadId: string): Promise<PostEntry[]> {
    if (!this.db) return [];
    const vault = this.requireVault();
    const bt = this.postIndex(boardId, threadId);
    const rows = await this.db.getAllFromIndex('eposts', 'bt', bt);
    const posts: PostEntry[] = [];
    for (const row of rows) {
      const p = vault.open<PostEntry>(row.blob, `eposts:${bt}`);
      if (p && p.boardId === boardId && p.threadId === threadId) posts.push({ ...p, id: row.id });
    }
    return posts.sort((a, b) => a.timestamp - b.timestamp);
  }

  // ── 板の一覧 (板の鍵の保管) ──
  //
  // ★ 板の鍵を URL (#key=...) に載せない。URL は履歴・ログ・スクリーンショットに
  //   残りやすい。鍵は暗号化した DB にだけ置き、URL には板 ID だけを載せる。

  public async saveBoard(boardId: string, key: Uint8Array): Promise<void> {
    const vault = this.requireVault();
    const k = vault.index('boardkey', boardId);
    const record: BoardRecord = { boardId, key, addedAt: Date.now() };
    await this.db.put('boards', { k, blob: vault.seal(record, `boards:${k}`) });
  }

  public async getBoardKey(boardId: string): Promise<Uint8Array | null> {
    const vault = this.requireVault();
    const k = vault.index('boardkey', boardId);
    const row = await this.db.get('boards', k);
    if (!row) return null;
    const rec = vault.open<BoardRecord>(row.blob, `boards:${k}`);
    return rec && rec.boardId === boardId ? rec.key : null;
  }

  public async listBoards(): Promise<BoardRecord[]> {
    const vault = this.requireVault();
    const rows = await this.db.getAll('boards');
    return rows
      .map(row => vault.open<BoardRecord>(row.blob, `boards:${row.k}`))
      .filter((r): r is BoardRecord => r !== null)
      .sort((a, b) => a.addedAt - b.addedAt);
  }

  public async removeBoard(boardId: string): Promise<void> {
    const vault = this.requireVault();
    await this.db.delete('boards', vault.index('boardkey', boardId));
  }

  // ── 任意の設定値 ──

  public async getSetting<T = unknown>(name: string): Promise<T | undefined> {
    const vault = this.requireVault();
    const k = vault.index('kv', name);
    const row = await this.db.get('kv', k);
    if (!row) return undefined;
    return vault.open<T>(row.blob, `kv:${k}`) ?? undefined;
  }

  public async setSetting(name: string, value: unknown): Promise<void> {
    const vault = this.requireVault();
    const k = vault.index('kv', name);
    await this.db.put('kv', { k, blob: vault.seal(value, `kv:${k}`) });
  }

  // ── Identity Storage (封印済み) ──
  //
  // 秘密鍵は SecretVault でパスワード封印した形で保存する。
  // 付随する meta (peerId など) も DEK で暗号化する (平文で残すと端末の素性が分かる)。

  /**
   * @param slot 'trip' = トリップ鍵 / 'node' = ノード identity
   */
  public async getSealed(slot: string): Promise<{ sealed: SealedSecret; meta?: any } | undefined> {
    if (!this.db || slot === DEK_SLOT) return undefined;
    const record = await this.db.get('identity', slot);
    if (!record?.sealed) return undefined;
    let meta = record.meta;
    if (record.emeta instanceof Uint8Array) {
      meta = this.requireVault().open(record.emeta, `identity:${slot}`) ?? undefined;
    }
    return { sealed: record.sealed as SealedSecret, meta };
  }

  public async saveSealed(slot: string, sealed: SealedSecret, meta?: any): Promise<void> {
    if (!this.db) return;
    if (slot === DEK_SLOT) throw new RangeError('reserved identity slot');
    const emeta = meta === undefined ? undefined : this.requireVault().seal(meta, `identity:${slot}`);
    await this.db.put('identity', { key: slot, sealed, emeta, updatedAt: Date.now() });
  }

  public async deleteSealed(slot: string): Promise<void> {
    if (!this.db || slot === DEK_SLOT) return;
    await this.db.delete('identity', slot);
  }

  // ── v6 以前からの移行 ──

  private async migrateLegacy(passphrase: string, params: VaultParams): Promise<void> {
    const names = this.db.objectStoreNames;
    let migrated = 0;

    if (names.contains('mailbox')) {
      const rows = (await this.db.getAll('mailbox')) as MailboxEntry[];
      for (const r of rows) {
        if (typeof r?.topicHash === 'string' && Array.isArray(r.entries)) {
          await this.writeMailbox({ topicHash: r.topicHash, entries: r.entries, lastUpdated: r.lastUpdated || Date.now() });
          migrated++;
        }
      }
      await this.db.clear('mailbox');
    }

    if (names.contains('posts')) {
      const vault = this.requireVault();
      const rows = (await this.db.getAll('posts')) as PostEntry[];
      for (const r of rows) {
        if (typeof r?.boardId !== 'string' || typeof r?.threadId !== 'string') continue;
        const bt = this.postIndex(r.boardId, r.threadId);
        const record: PostEntry = { boardId: r.boardId, threadId: r.threadId, payload: r.payload, timestamp: r.timestamp };
        await this.db.add('eposts', { bt, blob: vault.seal(record, `eposts:${bt}`) });
        migrated++;
      }
      await this.db.clear('posts');
    }

    if (names.contains('threads')) {
      const vault = this.requireVault();
      const rows = (await this.db.getAll('threads')) as any[];
      for (const r of rows) {
        if (typeof r?.threadId !== 'string' || typeof r?.boardId !== 'string') continue;
        const k = vault.index('thread', r.threadId);
        await this.db.put('ethreads', { k, b: vault.index('board', r.boardId), blob: vault.seal(r, `ethreads:${k}`) });
        migrated++;
      }
      await this.db.clear('threads');
    }

    // パスワード無しで封印されていた鍵 (旧版) は、このパスワードで封印し直す
    for (const slot of ['trip', 'node']) {
      const record = await this.db.get('identity', slot);
      if (!record?.sealed || record.sealed.protected === true) continue;
      const secret = SecretVault.open(record.sealed, '');
      if (!secret) continue;
      const meta = record.emeta ? undefined : record.meta;
      await this.saveSealed(slot, SecretVault.seal(secret, passphrase, params), meta);
      migrated++;
    }

    if (migrated > 0) log.info(`migrated ${migrated} legacy plaintext record(s) into the encrypted store`);
  }
}

export { WrongPassphraseError };
