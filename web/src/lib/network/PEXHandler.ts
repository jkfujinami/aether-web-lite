import type { P2PMessage, PeerId, IPeerManager, IMessageDispatcher } from '../types';
import { RING_MESH } from '../constants';
import { WireType } from './wire/WireTypes';

export class PEXHandler {
  private peerManager: IPeerManager;

  constructor(peerManager: IPeerManager, dispatcher: IMessageDispatcher) {
    this.peerManager = peerManager;
    dispatcher.register(WireType.PEX_REQUEST, (peerId, msg) => this.handlePexRequest(peerId, msg));
    dispatcher.register(WireType.PEX_RESPONSE, (peerId, msg) => this.handlePexResponse(peerId, msg));
  }

  /**
   * PEX (Peer Exchange) リクエストを送信する。
   * トラッカーに頼らず、既存の隣人から新たなピア情報を取得する。
   */
  public requestPeers(targetPeerId?: PeerId) {
    const payload = { minDistance: 0 };

    if (targetPeerId) {
      this.peerManager.sendMessage(targetPeerId, WireType.PEX_REQUEST, payload);
    } else {
      // 指定がなければ全隣人に一斉送信
      for (const peerId of this.peerManager.peers.keys()) {
        this.peerManager.sendMessage(peerId, WireType.PEX_REQUEST, payload);
      }
    }
  }

  /** ── Dispatcher Handlers ── */

  private handlePexRequest(senderPeerId: PeerId, _msg: any) {
    const peers = Array.from(this.peerManager.peers.values())
      .filter(p => p.peerId !== senderPeerId)
      .map(p => ({
        id: p.peerId,
        position: p.position,
        zones: Array.from(p.zones)
      }));
      
    this.peerManager.sendMessage(senderPeerId, WireType.PEX_RESPONSE, { peers });
  }

  private handlePexResponse(senderPeerId: PeerId, msg: any) {
    console.log(`[PEXHandler] <<< [PEX_RESPONSE] received from ${senderPeerId.substring(0,8)}`, {
      fullMsg: msg,
      hasPeers: !!msg?.peers,
      peerCount: msg?.peers?.length
    });

    if (!msg || !msg.peers || !Array.isArray(msg.peers)) {
      console.warn(`[PEXHandler] Invalid PEX_RESPONSE format: msg.peers is not an array. keys:`, Object.keys(msg || {}));
      return;
    }

    for (const p of msg.peers) {
      const idType = typeof p.id;
      const isUint8 = p.id instanceof Uint8Array;
      const existingPeer = this.peerManager.peers.get(p.id) as any;
      const isAlive = existingPeer && (existingPeer.isConnected || existingPeer.isConnecting);

      console.log(`[PEXHandler]   - Peer in list: ${isUint8 ? '[Binary]' : p.id.substring(0,8)}`, {
        type: idType,
        isAlive,
        isConnected: existingPeer?.isConnected,
        isConnecting: existingPeer?.isConnecting
      });

      if (p.id !== this.peerManager.myPeerId && !isAlive) {
        if (this.peerManager.degree < RING_MESH.MAX_DEGREE) {
          console.log(`[PEXHandler]   -> DISCOVERED PEER! Initiating connect to: ${isUint8 ? '[Binary]' : p.id.substring(0,8)} (via ${senderPeerId.substring(0,8)})`);
          this.peerManager.connect(p.id, p.position, p.zones, true, senderPeerId);
        } else {
          console.log(`[PEXHandler]   -> Max degree reached (${this.peerManager.degree}), skipping connection.`);
        }
      }
    }
  }
}
