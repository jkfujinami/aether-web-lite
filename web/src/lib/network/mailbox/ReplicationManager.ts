import type { IPeerManager, IMailbox, PeerId, IPeerConnection } from '../../types';
import { RingPosition } from '../RingPosition';
import { IndexedDBStore } from '../../storage/IndexedDBStore';

/**
 * ReplicationManager
 * P2Pトポロジーの変化（ノードの離脱・参加）を監視し、
 * データ（トピック）のK=5冗長性が維持されるように再配分を制御する。
 */
export class ReplicationManager {
  private mailbox: IMailbox;
  private peerManager: IPeerManager;
  private store: IndexedDBStore;
  private K_REPLICATION = 5;
  
  // 頻繁な接続変化によるバーストを防ぐためのデバウンスタイマー
  private rebalanceTimer: any = null;

  constructor(mailbox: IMailbox, peerManager: IPeerManager, store: IndexedDBStore) {
    this.mailbox = mailbox;
    this.peerManager = peerManager;
    this.store = store;

    // ピアの接続・切断をトリガーに再配分を検討する
    this.peerManager.on('peer:connect', () => this.planRebalance());
    this.peerManager.on('peer:disconnect', () => this.planRebalance());

    // 定期的なバックアップチェック（念のため）
    setInterval(() => this.planRebalance(), 300_000); // 5分ごと
  }

  /**
   * 再配分を計画する（デバウンス付き）
   */
  private planRebalance() {
    if (this.rebalanceTimer) clearTimeout(this.rebalanceTimer);
    this.rebalanceTimer = setTimeout(() => this.executeRebalance(), 10_000); // 10秒待機
  }

  /**
   * 現在保持している全トピックを、現在の最新K最近接ノードへコピーする
   */
  public async executeRebalance() {
    if (this.peerManager.degree === 0) return;

    const allTopicHashes = await this.store.getAllTopicHashes();
    if (allTopicHashes.length === 0) return;

    console.log(`[ReplicationManager] Starting rebalance for ${allTopicHashes.length} topics...`);

    for (const topicHash of allTopicHashes) {
      const topicPos = this.hashToPosition(topicHash);
      const nearestPeers = this.findKNearestExcludingMe(topicPos, this.K_REPLICATION);
      
      const entries = await this.store.get(topicHash);
      if (!entries || entries.length === 0) continue;

      // 1トピックにつき、自分以外のK人にデータを送る（または確認させる）
      for (const targetId of nearestPeers) {
        try {
          this.mailbox.replicate(targetId, topicHash, entries);
        } catch (e) {
          console.error(`[ReplicationManager] Failed to send replication to ${targetId}:`, e);
        }
      }
    }

    console.log(`[ReplicationManager] Rebalance complete.`);
  }

  private hashToPosition(topicHashHex: string): number {
    const prefix = topicHashHex.substring(0, 8);
    const intVal = parseInt(prefix, 16) || 0;
    return intVal / 0xffffffff;
  }

  private findKNearestExcludingMe(topicPos: number, k: number): PeerId[] {
    const allPeers = Array.from(this.peerManager.peers.values()) as IPeerConnection[];
    
    // RingPosition.distance を使って距離順にソート
    const sorted = allPeers.map(p => ({
      id: p.peerId,
      dist: RingPosition.distance(topicPos, p.position)
    })).sort((a, b) => a.dist - b.dist);

    return sorted.slice(0, k).map(p => p.id);
  }
}
