import type { IPeerManager, PeerId, P2PMessage, IMailbox, IMessageDispatcher } from '../../types';
import { RingPosition } from '../RingPosition';
import { IndexedDBStore } from '../../storage/IndexedDBStore';
import { Encoding } from '../../common/Encoding';
import { JsonBinary } from '../../common/JsonBinary';
import { CryptoUtils } from '../../common/CryptoUtils';
import { WireType } from '../wire/WireTypes';

// K=5（自分と最も近い5人）にデータを保存する
const K_NEAREST = 5;

export class DHTMailbox implements IMailbox {
  private store: IndexedDBStore;
  private pendingRequests = new Map<string, { resolve: (val: Uint8Array[]) => void, timeout: any }>();

  private peerManager: IPeerManager;

  constructor(
    peerManager: IPeerManager,
    dispatcher: IMessageDispatcher,
    store: IndexedDBStore
  ) {
    this.peerManager = peerManager;
    this.store = store;

    // Dispatcher への各ハンドラの登録
    dispatcher.register(WireType.DHT_PUT, (peerId, msg) => this.handlePut(peerId, msg));
    dispatcher.register(WireType.DHT_GET, (peerId, msg) => this.handleGet(peerId, msg));
    dispatcher.register(WireType.DHT_RES, (peerId, msg) => this.handleRes(peerId, msg));
  }

  /**
   * データの再レプリケーション（ReplicationManager から呼び出し）
   */
  public replicate(targetPeerId: PeerId, topicHash: string, entries: Uint8Array[]): void {
    this.sendDHTPut(targetPeerId, topicHash, entries);
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
   * 自分を含めた全ピアの中から、指定したトピック位置に近い順に K 人選出する
   */
  private findKNearest(topicPos: number, k: number): PeerId[] {
    const allPeers = Array.from(this.peerManager.peers.values())
      .filter(p => p.isConnected)
      .map(p => ({ id: p.peerId, pos: p.position }));
    
    // 自分を足す
    allPeers.push({ id: this.peerManager.myPeerId, pos: this.peerManager.myPosition });

    // 距離が近い順にソート (Ring-Meshなので距離計算には関数を使う)
    allPeers.sort((a, b) => {
      const distA = RingPosition.distance(topicPos, a.pos);
      const distB = RingPosition.distance(topicPos, b.pos);
      return distA - distB;
    });

    return allPeers.slice(0, k).map(p => p.id);
  }

  /**
   * Gossip等で生まれたデータをデータベースと担当のK人に保管する (PUT)
   */
  public async publish(topicHashHex: string, data: Uint8Array): Promise<void> {
    const topicPos = this.hashToPosition(topicHashHex);
    const nearest = this.findKNearest(topicPos, K_NEAREST);

    console.log(`[DHTMailbox] Putting data to ${topicHashHex.substring(0,8)}. Nearest K=${nearest.length}`);

    // もし自分が K-nearest に入っていたらローカルの IndexedDB に書き込む
    if (nearest.includes(this.peerManager.myPeerId)) {
      await this.store.put(topicHashHex, [data]);
    }

    // 他の担当者に対して同期を投げる
    for (const targetId of nearest) {
      if (targetId !== this.peerManager.myPeerId) {
        this.sendDHTPut(targetId, topicHashHex, [data]);
      }
    }
  }

  /**
   * 新規参加時などに、過去のデータをネットワーク上の担当者から取得する (GET)
   * K=5台の担当ノードへ並列リクエストを送り、結果をマージする
   */
  public async fetch(topicHashHex: string): Promise<Uint8Array[]> {
    const topicPos = this.hashToPosition(topicHashHex);
    // ネットワークへの問い合わせ先（自分以外）
    const nearest = this.findKNearest(topicPos, K_NEAREST).filter(id => id !== this.peerManager.myPeerId);

    console.log(`[DHTMailbox] Fetching logs for ${topicHashHex.substring(0,8)}. Targets: ${nearest.length}`);

    // 1. まず自分のローカルDBにある分を確保する
    const localEntries = await this.store.get(topicHashHex).catch(() => []) || [];
    const uniquePackets = new Map<string, Uint8Array>();
    localEntries.forEach(p => {
       uniquePackets.set(Encoding.toHex(p), p);
    });

    // 他に誰もいなければ、ローカル分だけで即座に返す
    if (nearest.length === 0) {
      return Array.from(uniquePackets.values());
    }

    // 2. ネットワーク上の担当者へ並列リクエストを送り、結果をマージする
    return new Promise((resolve) => {
      let responsesReceived = 0;
      const expectedResponses = nearest.length;
      const requestIds: string[] = [];

      const finalize = () => {
        timer && clearTimeout(timer);
        for (const rid of requestIds) this.pendingRequests.delete(rid);
        const result = Array.from(uniquePackets.values());
        console.log(`[DHTMailbox] Global fetch complete for ${topicHashHex.substring(0,8)}. Total: ${result.length} items.`);
        resolve(result);
      };

      const timer = setTimeout(finalize, 4000); // 最大4秒

      nearest.forEach(targetId => {
        const reqId = `fetch_${CryptoUtils.generateId()}`;
        requestIds.push(reqId);

        this.pendingRequests.set(reqId, {
          resolve: (packets: Uint8Array[]) => {
            responsesReceived++;
            packets.forEach(p => {
              uniquePackets.set(Encoding.toHex(p), p);
            });
            if (responsesReceived >= expectedResponses) finalize();
          },
          timeout: null
        });

        this.sendDHTGet(targetId, topicHashHex, reqId);
      });
    });
  }

  /** ── Dispatcher Handlers ── */

  private handlePut(_peerId: PeerId, msg: any) {
    console.log(`[DHTMailbox] Received dht-put for ${msg.topicHash.substring(0,8)} (${msg.entries.length} items)`);
    this.store.put(msg.topicHash, msg.entries).catch(e => console.error(e));
  }

  private handleGet(peerId: PeerId, msg: any) {
    console.log(`[DHTMailbox] Received dht-get for ${msg.topicHash.substring(0,8)} from ${peerId.substring(0,8)}`);
    this.store.get(msg.topicHash).then(entries => {
      this.sendDHTRes(peerId, msg.topicHash, msg.reqId, entries || []);
    });
  }

  private handleRes(_peerId: PeerId, msg: any) {
    const req = this.pendingRequests.get(msg.reqId);
    if (req) {
      req.resolve(msg.entries);
      this.pendingRequests.delete(msg.reqId);
      console.log(`[DHTMailbox] Received DHT response: ${msg.entries.length} items!`);
      
      if (msg.entries.length > 0) {
        this.store.put(msg.topicHash, msg.entries);
      }
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
