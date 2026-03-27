import type { IPeerManager, PeerId, GossipPacket, P2PMessage, StemPacket } from '../../types';
import { SeenCache } from './SeenCache';
import { PacketValidator } from './PacketValidator';
import { DandelionRouter } from './DandelionRouter';
import { ZoneManager } from '../ZoneManager';

/**
 * ZoneGossipRouter: ゾーン認識型のゴシップルーター。
 * 自分が購読している 16 ゾーンのパケットのみを中継・表示する。
 */
export class ZoneGossipRouter {
  private seenCache = new SeenCache();
  private listeners: Array<(packet: GossipPacket) => void> = [];
  private dandelion: DandelionRouter;
  private peerManager: IPeerManager;
  private zoneManager: ZoneManager;

  constructor(peerManager: IPeerManager, zoneManager: ZoneManager) {
    this.peerManager = peerManager;
    this.zoneManager = zoneManager;
    this.dandelion = new DandelionRouter(peerManager);
    this.peerManager.on('peer:data', (senderId, data) => this.handleData(senderId, data));
  }

  public onMessage(handler: (packet: GossipPacket) => void) {
    this.listeners.push(handler);
  }

  /**
   * 自己発信またはUIからの手動再送
   */
  public async broadcast(packet: GossipPacket, useDandelion: boolean = true): Promise<void> {
    // 🌟 自分が発信したものは即座に既読に入れて、回帰パケットを無視する
    this.seenCache.add(packet.packet_id);
    
    // 🌟 ネットワークに流す前に、まず自分のUIに即座に通知する
    this.listeners.forEach(cb => cb(packet));

    console.log(`[GossipRouter] Originating broadcast: ${packet.packet_id.substring(0,8)} (Zone: ${packet.zone_id})`);
    
    // 1. Dandelion++ Stem 送信を試みる (匿名化)
    const echoed = await this.dandelion.publish(packet, useDandelion);
    if (echoed) return;

    // 2. Stem 失敗または不使用時は直接 Fluff (全体放送)
    this.flood(packet, this.peerManager.myPeerId);
  }

  private async fluffToZone(packet: GossipPacket): Promise<void> {
    // まだ見たことがない場合のみ UI に通知する
    if (!this.seenCache.has(packet.packet_id)) {
      if (this.zoneManager.isSubscribed(packet.zone_id)) {
        this.listeners.forEach(cb => cb(packet));
      }
      this.seenCache.add(packet.packet_id);
    }
    
    this.flood(packet, this.peerManager.myPeerId);
  }

  private async handleData(senderId: PeerId, data: Uint8Array | string) {
    if (typeof data !== 'string') return;
    
    try {
      const msg = JSON.parse(data, (_key, value) => {
        if (value && value._type === 'BigInt') return BigInt(value.value);
        if (value && value._type === 'Uint8Array') return new Uint8Array(value.data);
        return value;
      }) as P2PMessage;

      // --- 通常ゴシップの処理 ---
      if (msg.type === 'gossip') {
        const packet = msg.packet;
        
        // 1. 基本検証
        if (!(await PacketValidator.validate(packet))) return;
        if (this.seenCache.has(packet.packet_id)) return;

        // 2. 🌟 ゾーンフィルタリング (§5.2) 🌟
        // 自分が購読していないゾーンのパケットは「見ないし、回さない」
        if (!this.zoneManager.isSubscribed(packet.zone_id)) {
          // ただし SeenCache には入れておく（同じパケットが他から来た時に無駄な検証をしないため）
          this.seenCache.add(packet.packet_id);
          return;
        }

        console.log(`[GossipRouter] Relaying zone ${packet.zone_id} packet ${packet.packet_id.substring(0,8)} from ${senderId.substring(0,8)}`);
        this.seenCache.add(packet.packet_id);

        // 3. エコー通知 (Dandelion用) & UI通知
        this.dandelion.notifyEcho(packet.packet_id);
        this.listeners.forEach(cb => cb(packet));

        // 4. ゾーン内隣人への転送
        this.flood(packet, senderId);

      // --- Dandelion++ Stem (匿名一本道) の処理 ---
      } else if ((msg as any).type === 'stem') {
        const stem = msg as StemPacket;
        // Stem パケットは自分が購読していなくても、秘密のルートを守って中継する
        const decision = this.dandelion.handleStemPacket(senderId, stem); // senderId を渡すように修正予定

        if (decision.action === 'fluff') {
          console.log(`[Dandelion] Fluffing stem packet into zone ${stem.packet.zone_id}`);
          await this.fluffToZone(decision.packet as GossipPacket);
        } else if (decision.action === 'forward' && decision.target) {
          const peer = this.peerManager.peers.get(decision.target);
          if (peer && peer.isConnected) {
            peer.send(JSON.stringify(decision.packet, (_key, value) => {
                if (value instanceof Uint8Array) return { _type: 'Uint8Array', data: Array.from(value) };
                return value;
            }));
          }
        }
      }
    } catch(e) { }
  }

  /**
   * ゾーン認識型フラッディング (§5.2)
   */
  private flood(packet: GossipPacket, excludePeerId: PeerId) {
    const msg = JSON.stringify({ type: 'gossip', packet }, (_key, value) => {
       if (typeof value === 'bigint') return { _type: 'BigInt', value: value.toString() };
       if (value instanceof Uint8Array) return { _type: 'Uint8Array', data: Array.from(value) };
       return value;
    });

    for (const peer of this.peerManager.peers.values()) {
      if (peer.peerId === excludePeerId) continue;

      // 🌟 Zonemate 優先転送 🌟
      // 相手がこのパケットのゾーンを購読している場合のみ送信する。
      // これにより、ネットワーク全体にパケットが溢れるのを防ぐ。
      if (peer.zones.has(packet.zone_id)) {
        peer.send(msg);
      }
    }
  }

  public destroy() {
    this.seenCache.destroy();
  }
}
