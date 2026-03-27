import type { IPeerManager, PeerId, P2PMessage, IMailbox } from '../../types';
import { RingPosition } from '../RingPosition';
import { IndexedDBStore } from '../../storage/IndexedDBStore';

// K=5（自分と最も近い5人）にデータを保存する
const K_NEAREST = 5;

export class DHTMailbox implements IMailbox {
  private store: IndexedDBStore;
  private pendingRequests = new Map<string, { resolve: (val: Uint8Array[]) => void, timeout: any }>();

  private peerManager: IPeerManager;

  constructor(
    peerManager: IPeerManager,
    store: IndexedDBStore
  ) {
    this.peerManager = peerManager;
    this.store = store;
    this.peerManager.on('peer:data', (peerId, data) => this.handleData(peerId, data));
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
       const hex = Array.from(p).map(b => b.toString(16).padStart(2, '0')).join('');
       uniquePackets.set(hex, p);
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
        const reqId = `fetch_${Math.random().toString(36).slice(2)}`;
        requestIds.push(reqId);

        this.pendingRequests.set(reqId, {
          resolve: (packets: Uint8Array[]) => {
            responsesReceived++;
            packets.forEach(p => {
              const hex = Array.from(p).map(b => b.toString(16).padStart(2, '0')).join('');
              uniquePackets.set(hex, p);
            });
            if (responsesReceived >= expectedResponses) finalize();
          },
          timeout: null
        });

        this.sendDHTGet(targetId, topicHashHex, reqId);
      });
    });
  }

  /**
   * ピアから DHT 系メッセージを受け取った際の処理
   */
  private handleData(peerId: PeerId, data: Uint8Array | string) {
    if (typeof data !== 'string') return;
    try {
      // Uint8Array のデシリアライズ
      const msg = JSON.parse(data, (_key, value) => {
        if (value && value._type === 'Uint8Array') return new Uint8Array(value.data);
        return value;
      }) as P2PMessage;

      if (msg.type === 'dht-put') {
        console.log(`[DHTMailbox] Received dht-put for ${msg.topicHash.substring(0,8)} (${msg.entries.length} items)`);
        // 一旦自分が担当じゃなくても強制キャッシュ（後ほどのGCで刈り取るためとりあえず保存）
        this.store.put(msg.topicHash, msg.entries).catch(e => console.error(e));
      } 
      else if (msg.type === 'dht-get') {
        console.log(`[DHTMailbox] Received dht-get for ${msg.topicHash.substring(0,8)} from ${peerId.substring(0,8)}`);
        // 持っていれば返す
        this.store.get(msg.topicHash).then(entries => {
          this.sendDHTRes(peerId, msg.topicHash, msg.reqId, entries || []);
        });
      }
      else if (msg.type === 'dht-res') {
        const req = this.pendingRequests.get(msg.reqId);
        if (req) {
          clearTimeout(req.timeout);
          req.resolve(msg.entries);
          this.pendingRequests.delete(msg.reqId);
          console.log(`[DHTMailbox] Received DHT response: ${msg.entries.length} items!`);
          
          // せっかく取得したので、ローカルの IndexedDB にもキャッシュしておく
          if (msg.entries.length > 0) {
             this.store.put(msg.topicHash, msg.entries);
          }
        }
      }
    } catch(e) {}
  }

  private sendDHTPut(targetPeerId: PeerId, topicHash: string, entries: Uint8Array[]) {
    this.sendToPeer(targetPeerId, { type: 'dht-put', topicHash, entries });
  }

  private sendDHTGet(targetPeerId: PeerId, topicHash: string, reqId: string) {
    this.sendToPeer(targetPeerId, { type: 'dht-get', topicHash, reqId });
  }

  private sendDHTRes(targetPeerId: PeerId, topicHash: string, reqId: string, entries: Uint8Array[]) {
    this.sendToPeer(targetPeerId, { type: 'dht-res', topicHash, reqId, entries });
  }

  private sendToPeer(targetPeerId: PeerId, msg: any) {
    const peer = this.peerManager.peers.get(targetPeerId);
    if (peer && peer.isConnected) {
      const payload = JSON.stringify(msg, (_key, value) => {
        if (value instanceof Uint8Array) return { _type: 'Uint8Array', data: Array.from(value) };
        return value;
      });
      peer.send(payload);
    }
  }
}
