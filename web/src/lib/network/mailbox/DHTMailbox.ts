import type { IPeerManager, PeerId, IMailbox, IMessageDispatcher } from '../../types';
import { RingPosition } from '../RingPosition';
import { IndexedDBStore } from '../../storage/IndexedDBStore';
import { Encoding } from '../../common/Encoding';
import { CryptoUtils } from '../../common/CryptoUtils';
import { WireType } from '../wire/WireTypes';
import {
  filterValidEntries,
  isValidTopicHash,
  MAILBOX_LIMITS,
} from './MailboxEntry';

// K=5（自分と最も近い5人）にデータを保存する
const K_NEAREST = 5;

/**
 * K-nearest 帰属判定の許容幅。
 *
 * 各ノードが見えている隣人集合は少しずつ違うので、厳密に「自分が上位 K に
 * 入っているか」で弾くと、視界のずれだけで正当な PUT が落ちる。
 * 少し広めに取って、明らかに無関係なノードからの投げ込みだけを止める。
 */
const PUT_ACCEPT_SLACK = 3;

export class DHTMailbox implements IMailbox {
  private store: IndexedDBStore;
  private pendingRequests = new Map<
    string,
    { resolve: (val: Uint8Array[]) => void; timeout: any; topicHash: string; target: PeerId }
  >();

  private peerManager: IPeerManager;

  constructor(
    peerManager: IPeerManager,
    dispatcher: IMessageDispatcher,
    store: IndexedDBStore,
  ) {
    this.peerManager = peerManager;
    this.store = store;

    dispatcher.register(WireType.DHT_PUT, (peerId, msg) => this.handlePut(peerId, msg));
    dispatcher.register(WireType.DHT_GET, (peerId, msg) => this.handleGet(peerId, msg));
    dispatcher.register(WireType.DHT_RES, (peerId, msg) => this.handleRes(peerId, msg));
  }

  /**
   * データの再レプリケーション（ReplicationManager から呼び出し）
   */
  public replicate(targetPeerId: PeerId, topicHash: string, entries: Uint8Array[]): void {
    // 1 メッセージあたりの上限を送信側でも守る (相手に弾かれて無駄になるため)
    for (let i = 0; i < entries.length; i += MAILBOX_LIMITS.MAX_ENTRIES_PER_MESSAGE) {
      this.sendDHTPut(targetPeerId, topicHash, entries.slice(i, i + MAILBOX_LIMITS.MAX_ENTRIES_PER_MESSAGE));
    }
  }

  /**
   * topicHash(Hex) -> リング上の座標 [0, 1) へマッピング
   */
  private hashToPosition(topicHashHex: string): number {
    const prefix = topicHashHex.substring(0, 8);
    const intVal = parseInt(prefix, 16) || 0;
    return intVal / 0xffffffff;
  }

  /**
   * 指定したトピック位置に近い順に K 人選出する。
   *
   * ハンドシェイク未完了のピアは除外する。座標が Bound Identity で
   * 検証されていないピアを K-nearest に入れると、そこが穴になる。
   */
  private findKNearest(topicPos: number, k: number): PeerId[] {
    const allPeers = Array.from(this.peerManager.peers.values())
      .filter(p => p.isConnected && p.isVerified)
      .map(p => ({ id: p.peerId, pos: p.position }));

    allPeers.push({ id: this.peerManager.myPeerId, pos: this.peerManager.myPosition });

    allPeers.sort((a, b) => {
      const distA = RingPosition.distance(topicPos, a.pos);
      const distB = RingPosition.distance(topicPos, b.pos);
      return distA - distB;
    });

    return allPeers.slice(0, k).map(p => p.id);
  }

  /**
   * 自分がこの topicHash の保管担当かどうか。
   *
   * これが無いと、リング上のどこにいる誰からでも任意のトピックに
   * 書き込めてしまう (無差別ディスク枯渇 DoS)。
   */
  private isResponsibleFor(topicHashHex: string): boolean {
    const topicPos = this.hashToPosition(topicHashHex);
    const nearest = this.findKNearest(topicPos, K_NEAREST + PUT_ACCEPT_SLACK);
    return nearest.includes(this.peerManager.myPeerId);
  }

  /**
   * Gossip等で生まれたデータをデータベースと担当のK人に保管する (PUT)
   */
  public async publish(topicHashHex: string, data: Uint8Array): Promise<void> {
    if (!isValidTopicHash(topicHashHex)) {
      throw new RangeError(`DHTMailbox.publish: invalid topicHash`);
    }

    const topicPos = this.hashToPosition(topicHashHex);
    const nearest = this.findKNearest(topicPos, K_NEAREST);

    console.log(`[DHTMailbox] Putting data to ${topicHashHex.substring(0, 8)}. Nearest K=${nearest.length}`);

    if (nearest.includes(this.peerManager.myPeerId)) {
      await this.store.put(topicHashHex, [data]);
    }

    for (const targetId of nearest) {
      if (targetId !== this.peerManager.myPeerId) {
        this.sendDHTPut(targetId, topicHashHex, [data]);
      }
    }
  }

  /**
   * 新規参加時などに、過去のデータをネットワーク上の担当者から取得する (GET)
   */
  public async fetch(topicHashHex: string): Promise<Uint8Array[]> {
    if (!isValidTopicHash(topicHashHex)) return [];

    const topicPos = this.hashToPosition(topicHashHex);
    const nearest = this.findKNearest(topicPos, K_NEAREST).filter(id => id !== this.peerManager.myPeerId);

    console.log(`[DHTMailbox] Fetching logs for ${topicHashHex.substring(0, 8)}. Targets: ${nearest.length}`);

    const localEntries = (await this.store.get(topicHashHex).catch(() => [])) || [];
    const uniquePackets = new Map<string, Uint8Array>();
    localEntries.forEach(p => uniquePackets.set(Encoding.toHex(p), p));

    if (nearest.length === 0) {
      return Array.from(uniquePackets.values());
    }

    return new Promise((resolve) => {
      let responsesReceived = 0;
      const expectedResponses = nearest.length;
      const requestIds: string[] = [];

      const finalize = () => {
        if (timer) clearTimeout(timer);
        for (const rid of requestIds) this.pendingRequests.delete(rid);
        const result = Array.from(uniquePackets.values());
        console.log(`[DHTMailbox] Global fetch complete for ${topicHashHex.substring(0, 8)}. Total: ${result.length} items.`);
        resolve(result);
      };

      const timer = setTimeout(finalize, 4000);

      nearest.forEach(targetId => {
        const reqId = `fetch_${CryptoUtils.generateId()}`;
        requestIds.push(reqId);

        this.pendingRequests.set(reqId, {
          topicHash: topicHashHex,
          target: targetId,
          resolve: (packets: Uint8Array[]) => {
            responsesReceived++;
            packets.forEach(p => uniquePackets.set(Encoding.toHex(p), p));
            if (responsesReceived >= expectedResponses) finalize();
          },
          timeout: null,
        });

        this.sendDHTGet(targetId, topicHashHex, reqId);
      });
    });
  }

  /** ── Dispatcher Handlers ── */

  /**
   * ★ PUT の検証 (旧実装はここが完全に素通しだった)
   *
   * 旧:
   *   private handlePut(_peerId, msg) {
   *     this.store.put(msg.topicHash, msg.entries)   // 無検証
   *   }
   *
   * これにより誰でも
   *   - 任意のスレッドの「過去ログ」を捏造して差し込める
   *   - 無関係なトピックに無制限に書いて IndexedDB を枯渇させられる
   * 状態だった。
   *
   * 現在は 4 段で縛る:
   *   1. topicHash の形式
   *   2. 帰属 — 自分が K-nearest 圏内でなければ受け取らない
   *   3. エントリ単位の PoW + CHK 検証 (鍵は不要)
   *   4. 件数・サイズの上限
   */
  private async handlePut(peerId: PeerId, msg: any): Promise<void> {
    const topicHash = msg?.topicHash;
    if (!isValidTopicHash(topicHash)) {
      console.warn(`[DHTMailbox] PUT rejected from ${peerId.substring(0, 8)}: malformed topicHash`);
      return;
    }

    if (!this.isResponsibleFor(topicHash)) {
      console.warn(
        `[DHTMailbox] PUT rejected for ${topicHash.substring(0, 8)}: not in K-nearest set (attribution check)`,
      );
      return;
    }

    const { accepted, rejected } = filterValidEntries(msg.entries);

    if (rejected.size > 0) {
      const summary = Array.from(rejected.entries()).map(([r, n]) => `${r}x${n}`).join(', ');
      console.warn(`[DHTMailbox] PUT from ${peerId.substring(0, 8)}: dropped invalid entries (${summary})`);
    }
    if (accepted.length === 0) return;

    try {
      const existing = (await this.store.get(topicHash)) ?? [];
      if (existing.length >= MAILBOX_LIMITS.MAX_ENTRIES_PER_TOPIC) {
        console.warn(`[DHTMailbox] PUT rejected for ${topicHash.substring(0, 8)}: topic is full`);
        return;
      }

      if (existing.length === 0) {
        const topicCount = (await this.store.getAllTopicHashes()).length;
        if (topicCount >= MAILBOX_LIMITS.MAX_TOPICS) {
          console.warn(`[DHTMailbox] PUT rejected: topic capacity reached (${topicCount})`);
          return;
        }
      }

      const room = MAILBOX_LIMITS.MAX_ENTRIES_PER_TOPIC - existing.length;
      await this.store.put(topicHash, accepted.slice(0, room));
      console.log(`[DHTMailbox] Stored ${Math.min(accepted.length, room)} verified entries for ${topicHash.substring(0, 8)}`);
    } catch (e) {
      console.error(`[DHTMailbox] PUT storage error:`, e);
    }
  }

  private async handleGet(peerId: PeerId, msg: any): Promise<void> {
    const topicHash = msg?.topicHash;
    const reqId = msg?.reqId;
    if (!isValidTopicHash(topicHash) || typeof reqId !== 'string' || reqId.length > 64) return;

    try {
      const entries = (await this.store.get(topicHash)) ?? [];
      this.sendDHTRes(peerId, topicHash, reqId, entries.slice(0, MAILBOX_LIMITS.MAX_ENTRIES_PER_MESSAGE));
    } catch (e) {
      console.error(`[DHTMailbox] GET storage error:`, e);
    }
  }

  /**
   * ★ RES の検証 (旧実装はここも素通しだった)
   *
   * 旧実装は届いた entries をそのまま resolve し、さらに store.put で
   * ローカルにも焼き付けていた。K=5 のうち 1 台が悪意を持てば、偽の過去ログが
   * 正史として定着した。
   *
   * 現在は
   *   1. 自分が出した reqId への応答か
   *   2. その reqId を投げた *相手* からの応答か (別ノードの割り込み応答を弾く)
   *   3. 各エントリが CHK + PoW を満たすか
   * を確認してから受け入れる。
   */
  private async handleRes(peerId: PeerId, msg: any): Promise<void> {
    const reqId = msg?.reqId;
    if (typeof reqId !== 'string') return;

    const req = this.pendingRequests.get(reqId);
    if (!req) return;

    // 自分が問い合わせた相手以外からの応答は受け取らない
    if (req.target !== peerId) {
      console.warn(`[DHTMailbox] RES from unexpected peer ${peerId.substring(0, 8)} (expected ${req.target.substring(0, 8)})`);
      return;
    }
    if (msg?.topicHash !== req.topicHash) {
      console.warn(`[DHTMailbox] RES topicHash mismatch for reqId ${reqId}`);
      return;
    }

    this.pendingRequests.delete(reqId);

    const { accepted, rejected } = filterValidEntries(msg.entries);
    if (rejected.size > 0) {
      const summary = Array.from(rejected.entries()).map(([r, n]) => `${r}x${n}`).join(', ');
      console.warn(`[DHTMailbox] RES from ${peerId.substring(0, 8)}: dropped invalid entries (${summary})`);
    }

    console.log(`[DHTMailbox] DHT response accepted: ${accepted.length} verified items`);
    req.resolve(accepted);

    if (accepted.length > 0 && this.isResponsibleFor(req.topicHash)) {
      // 検証済みのものだけをローカルにも保管する
      this.store.put(req.topicHash, accepted).catch(e => console.error(e));
    }
  }

  private sendDHTPut(targetPeerId: PeerId, topicHash: string, entries: Uint8Array[]) {
    this.peerManager.sendMessage(targetPeerId, WireType.DHT_PUT, { topicHash, entries });
  }

  private sendDHTGet(targetPeerId: PeerId, topicHash: string, reqId: string) {
    this.peerManager.sendMessage(targetPeerId, WireType.DHT_GET, { topicHash, reqId });
  }

  private sendDHTRes(targetPeerId: PeerId, topicHash: string, reqId: string, entries: Uint8Array[]) {
    this.peerManager.sendMessage(targetPeerId, WireType.DHT_RES, { topicHash, reqId, entries });
  }
}
