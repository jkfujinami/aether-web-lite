import type { IPeerManager, PeerId, GossipPacket, P2PMessage, StemPacket, IMessageDispatcher, IZoneManager } from '../../types';
import { SeenCache } from './SeenCache';
import { PacketValidator } from './PacketValidator';
import { DandelionRouter } from './DandelionRouter';
import { JsonBinary } from '../../common/JsonBinary';
import { WireType } from '../wire/WireTypes';

/**
 * ZoneGossipRouter: ゾーン認識型のゴシップルーター。
 * 自分が購読している 16 ゾーンのパケットのみを中継・表示する。
 */
export class ZoneGossipRouter {
  private seenCache = new SeenCache();
  private listeners: Array<(packet: GossipPacket) => void> = [];
  private dandelion: DandelionRouter;
  private peerManager: IPeerManager;
  private zoneManager: IZoneManager;

  constructor(peerManager: IPeerManager, dispatcher: IMessageDispatcher, zoneManager: IZoneManager) {
    this.peerManager = peerManager;
    this.zoneManager = zoneManager;
    this.dandelion = new DandelionRouter(peerManager);

    dispatcher.register(WireType.GOSSIP, (senderId, msg) => this.handleGossip(senderId, msg));
    dispatcher.register(WireType.STEM, (senderId, msg) => this.handleStem(senderId, msg));
  }

  public onMessage(handler: (packet: GossipPacket) => void) {
    this.listeners.push(handler);
  }

  public offMessage(handler: (packet: GossipPacket) => void) {
    this.listeners = this.listeners.filter(h => h !== handler);
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
    // Fluff 移行時に PoW 検証を実施 (仕様書 CRITICAL #4)
    if (!(await PacketValidator.validate(packet))) return;

    // まだ見たことがない場合のみ UI に通知する
    if (!this.seenCache.has(packet.packet_id)) {
      if (this.zoneManager.isSubscribed(packet.zone_id)) {
        this.listeners.forEach(cb => cb(packet));
      }
      this.seenCache.add(packet.packet_id);
    }

    this.flood(packet, this.peerManager.myPeerId);
  }

  /** ── Dispatcher Handlers ── */

  private async handleGossip(senderId: PeerId, msg: any) {
    const packet = msg.packet;
    
    // 1. 基本検証
    if (!(await PacketValidator.validate(packet))) return;
    if (this.seenCache.has(packet.packet_id)) return;

    // 2. 🌟 ゾーンフィルタリング (§5.2) 🌟
    if (!this.zoneManager.isSubscribed(packet.zone_id)) {
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
  }

  private async handleStem(senderId: PeerId, msg: any) {
    const stem = msg as StemPacket;
    const decision = this.dandelion.handleStemPacket(senderId, stem);

    if (decision.action === 'fluff') {
      console.log(`[Dandelion] Fluffing stem packet into zone ${stem.packet.zone_id}`);
      await this.fluffToZone(decision.packet as GossipPacket);
    } else if (decision.action === 'forward' && decision.target) {
      this.peerManager.sendMessage(decision.target, WireType.STEM, decision.packet);
    }
  }

  /**
   * ゾーン認識型フラッディング (§5.2)
   * hop_count をインクリメントして転送する
   */
  private flood(packet: GossipPacket, excludePeerId: PeerId) {
    const relayPacket: GossipPacket = { ...packet, hop_count: packet.hop_count + 1 };
    const payload = { packet: relayPacket };

    for (const peer of this.peerManager.peers.values()) {
      if (peer.peerId === excludePeerId) continue;

      // 🌟 Zonemate 優先転送 🌟
      if (peer.zones.has(relayPacket.zone_id)) {
        this.peerManager.sendMessage(peer.peerId, WireType.GOSSIP, payload);
      }
    }
  }

  public destroy() {
    this.seenCache.destroy();
  }
}
