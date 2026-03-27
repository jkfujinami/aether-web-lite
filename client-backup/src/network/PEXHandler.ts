import { PeerManager } from './PeerManager';
import type { P2PMessage, PeerId } from '../types';
import { RING_MESH } from '../constants';

export class PEXHandler {
  private peerManager: PeerManager;

  constructor(peerManager: PeerManager) {
    this.peerManager = peerManager;
    this.peerManager.on('peer:data', (peerId, data) => this.handleData(peerId, data));
  }

  /**
   * PEX (Peer Exchange) リクエストを送信する。
   * トラッカーに頼らず、既存の隣人から新たなピア情報を取得する。
   */
  public requestPeers(targetPeerId?: PeerId) {
    const msg: P2PMessage = { type: 'pex-request', minDistance: 0 };
    const payload = JSON.stringify(msg);

    if (targetPeerId) {
      const peer = this.peerManager.peers.get(targetPeerId);
      if (peer) peer.send(payload);
    } else {
      // 指定がなければ全隣人に一斉送信
      for (const peer of this.peerManager.peers.values()) {
        peer.send(payload);
      }
    }
  }

  private handleData(senderPeerId: PeerId, data: Uint8Array | string) {
    if (typeof data !== 'string') return;

    try {
      const msg = JSON.parse(data) as P2PMessage;
      
      if (msg.type === 'pex-request') {
        // リクエストを受け取ったら、自分が現在接続しているピアのリストを返す
         // ※ ただし要求元(senderPeerId)自身は除外する
        const peers = Array.from(this.peerManager.peers.values())
          .filter(p => p.peerId !== senderPeerId)
          .map(p => ({
            id: p.peerId,
            position: p.position,
            zones: Array.from(p.zones)
          }));
          
        const res: P2PMessage = { type: 'pex-response', peers };
        this.peerManager.peers.get(senderPeerId)?.send(JSON.stringify(res));
        
      } else if (msg.type === 'pex-response') {
        // 新たなピア情報を取得した！
        for (const p of msg.peers) {
          // 自分自身ではなく、まだ接続していないノードであれば
          if (p.id !== this.peerManager.myPeerId && !this.peerManager.peers.has(p.id)) {
            
            // リングの上限に達していなければ接続を試みる
            if (this.peerManager.degree < RING_MESH.MAX_DEGREE) {
              console.log(`[PEXHandler] Found new peer ${p.id.substring(0,8)} via ${senderPeerId.substring(0,8)}. Initiating PEX-based connection!`);
              // peerManager の拡張 connect を呼び、viaPeerId (経路) を指定する。
              // トラッカーサーバーではなく、senderPeerId を中継点 (relay) として SDP を飛ばす。
              this.peerManager.connect(p.id, p.position, p.zones, true, senderPeerId);
            }
          }
        }
      }
    } catch (e) {
      // not JSON or not PEX msg
    }
  }
}
