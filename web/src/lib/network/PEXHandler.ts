import type { PeerId, IPeerManager, IMessageDispatcher } from '../types';
import { RING_MESH } from '../constants';
import { WireType } from './wire/WireTypes';

const PEER_ID_RE = /^[0-9a-f]{32}$/;

/** 1 回の PEX_RESPONSE で返す/受け取る最大件数 */
const MAX_PEX_ENTRIES = 8;

/**
 * PEXHandler — トラッカーに頼らないピア発見。
 *
 * 変更点:
 *   - position と zones を載せない。position は peerId から導出でき、
 *     zones は購読宣言そのものなので流してはいけない (本家 18.6.2)。
 *   - 応答件数に上限を設ける。旧実装は隣人全員をそのまま返しており、
 *     応答サイズが接続数に比例して膨らんだ。
 *   - peerId の形式を検証する。Bound Identity では hex 32 文字に固定される。
 */
export class PEXHandler {
  private peerManager: IPeerManager;

  constructor(peerManager: IPeerManager, dispatcher: IMessageDispatcher) {
    this.peerManager = peerManager;
    dispatcher.register(WireType.PEX_REQUEST, (peerId, msg) => this.handlePexRequest(peerId, msg));
    dispatcher.register(WireType.PEX_RESPONSE, (peerId, msg) => this.handlePexResponse(peerId, msg));
  }

  public requestPeers(targetPeerId?: PeerId) {
    const payload = { minDistance: 0 };

    if (targetPeerId) {
      this.peerManager.sendMessage(targetPeerId, WireType.PEX_REQUEST, payload);
    } else {
      for (const peerId of this.peerManager.peers.keys()) {
        this.peerManager.sendMessage(peerId, WireType.PEX_REQUEST, payload);
      }
    }
  }

  /** ── Dispatcher Handlers ── */

  private handlePexRequest(senderPeerId: PeerId, _msg: any) {
    const candidates = Array.from(this.peerManager.peers.values())
      .filter(p => p.peerId !== senderPeerId && p.isConnected && p.isVerified)
      .map(p => ({ id: p.peerId }));

    // ランダムに間引いてから上限で切る。先頭 N 件固定だと、
    // 早期に接続した攻撃者ノードが永久に紹介され続ける
    // (本家 18.7-④ が Rust 側で指摘したのと同じ罠)。
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    this.peerManager.sendMessage(senderPeerId, WireType.PEX_RESPONSE, {
      peers: candidates.slice(0, MAX_PEX_ENTRIES),
    });
  }

  private handlePexResponse(senderPeerId: PeerId, msg: any) {
    if (!msg || !Array.isArray(msg.peers)) {
      console.warn(`[PEXHandler] Invalid PEX_RESPONSE from ${senderPeerId.substring(0, 8)}`);
      return;
    }

    // 相手が何件返してこようと、こちらが処理する件数は自分で決める
    for (const p of msg.peers.slice(0, MAX_PEX_ENTRIES)) {
      const id = p?.id;
      if (typeof id !== 'string' || !PEER_ID_RE.test(id)) continue;
      if (id === this.peerManager.myPeerId) continue;

      const existing = this.peerManager.peers.get(id);
      if (existing && (existing.isConnected || (existing as any).isConnecting)) continue;
      if (this.peerManager.degree >= RING_MESH.MAX_DEGREE) break;

      // position は渡さない。PeerManager が peerId から導出する。
      this.peerManager.connect(id, true, senderPeerId);
    }
  }
}
