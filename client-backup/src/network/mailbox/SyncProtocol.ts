import type { IMailbox, ICryptoEngine, IPostStore, IKeyManager } from '../../types';
import { KeyManager } from '../../crypto/KeyManager';
import { PacketBuilder } from '../../crypto/PacketBuilder';

/**
 * SyncProtocol
 * 新規参加時やスレッド閲覧開始時に、過去の投稿をネットワークから集約・復元する。
 */
export class SyncProtocol {
  private mailbox: IMailbox;
  private crypto: ICryptoEngine;
  private keyManager: IKeyManager;
  private store: IPostStore;

  constructor(
    mailbox: IMailbox,
    crypto: ICryptoEngine,
    keyManager: IKeyManager,
    store: IPostStore
  ) {
    this.mailbox = mailbox;
    this.crypto = crypto;
    this.keyManager = keyManager;
    this.store = store;
  }

  /**
   * 特定のスレッドの過去ログを同期する
   * @returns 同期に成功した投稿数
   */
  public async syncThread(boardId: string, threadId: string, boardKey: Uint8Array): Promise<number> {
    // 1. 鍵とトピックハッシュの計算
    const threadKey = this.keyManager.deriveThreadKey(boardKey, threadId);
    const topicHash = this.keyManager.deriveTopicHash(threadKey);
    const topicHashHex = KeyManager.toHex(topicHash);

    console.log(`[SyncProtocol] Starting sync for board ${boardId} thread ${threadId} (topic: ${topicHashHex.substring(0,8)})`);

    // 2. DHTから暗号化パケット群を取得
    const packets = await this.mailbox.fetch(topicHashHex);
    if (packets.length === 0) {
      console.log(`[SyncProtocol] No past logs found in DHT for ${topicHashHex.substring(0,8)}`);
      return 0;
    }

    // 3. 復号・検証・保存
    let count = 0;
    for (const binPacket of packets) {
      try {
        // DHTMailboxはJSON.stringify(Uint8Arrayカスタム)で保存しているためパースが必要
        const packetStr = new TextDecoder().decode(binPacket);
        const packetObj = JSON.parse(packetStr, (_key, value) => {
          if (value && value._type === 'Uint8Array') return new Uint8Array(value.data);
          return value;
        });

        // PacketBuilder を使って 3層の検証（Magic -> AEAD -> Ed25519）を一気に行う
        const post = await PacketBuilder.verifyAndDecrypt(packetObj, threadKey, this.crypto);
        
        if (post) {
          await this.store.save({
            boardId: post.board_id,
            threadId: post.thread_id,
            payload: binPacket,
            dag: {
              parents: post.parents || [],
              cumulative_pow: post.cumulative_pow || 0,
              thread_root: post.thread_root || threadId
            }
          });
          count++;
        }
      } catch (e) {
        console.warn(`[SyncProtocol] Failed to process a packet:`, e);
        continue;
      }
    }

    console.log(`[SyncProtocol] Sync finished. Restored ${count} posts for ${threadId}.`);
    return count;
  }
}
