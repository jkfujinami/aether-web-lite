import type { IPeerManager } from '../types';
import { PEXHandler } from './PEXHandler';
import { RingPosition } from './RingPosition';
import { RING_MESH } from '../constants';
import { createLogger } from '../common/Logger';

const log = createLogger('net.ring');

export class RingMaintainer {
  private timer: ReturnType<typeof setInterval>;
  private peerManager: IPeerManager;
  private pexHandler: PEXHandler;

  constructor(
    peerManager: IPeerManager,
    pexHandler: PEXHandler
  ) {
    this.peerManager = peerManager;
    this.pexHandler = pexHandler;
    this.peerManager.on('peer:connect', () => this.evaluateTopology());
    this.peerManager.on('peer:disconnect', () => this.evaluateTopology());

    this.timer = setInterval(() => {
      this.evaluateTopology();
      
      // MAX_DEGREE (8本) に満たない場合はPEXを発行して、トラッカー無しに自力で新規ピアを探す
      if (this.peerManager.degree < RING_MESH.MAX_DEGREE) {
         if (this.peerManager.degree > 0) {
           // 🟡 Issue 2: 全員にPEX要求を送るとフラッドするので、ランダムな1人のみに依頼
           const connectedPeers = Array.from(this.peerManager.peers.values()).filter(p => p.isConnected);
           if (connectedPeers.length > 0) {
             const target = connectedPeers[Math.floor(Math.random() * connectedPeers.length)];
             log.debug(`Only ${this.peerManager.degree} peers. Requesting PEX from ${target.peerId.substring(0,8)}...`);
             this.pexHandler.requestPeers(target.peerId);
           }
         }
      }
    }, RING_MESH.REPAIR_CHECK_INTERVAL);
  }

  private distance(posA: number, posB: number): number {
    return RingPosition.distance(posA, posB);
  }

  public evaluateTopology() {
    // ★ 検証済みのピアだけで判断する。
    //   未検証の接続まで数えると、攻撃者が未認証の接続を積むだけで次数が
    //   MAX_DEGREE を超えたことになり、正規のロングレンジリンクが切られる。
    const peers = Array.from(this.peerManager.peers.values()).filter(p => p.isConnected && p.isVerified);
    const verifiedDegree = peers.length;

    // まだ少ない場合は強制切断はしない
    if (peers.length <= RING_MESH.LOCAL_LINKS) return;

    // 自分から見て距離が近い順に並び替え
    peers.sort((a, b) => this.distance(this.peerManager.myPosition, a.position) - this.distance(this.peerManager.myPosition, b.position));

    // ローカルリンク = 近い順上位4人
    // ロングレンジ = 残り
    // const localLinks = peers.slice(0, RING_MESH.LOCAL_LINKS);
    const longRangeLinks = peers.slice(RING_MESH.LOCAL_LINKS);

    // 最大接続数超過時は、遠い（効果の薄い）ロングレンジリンクから捨てる
    if (verifiedDegree > RING_MESH.MAX_DEGREE) {
      const excess = verifiedDegree - RING_MESH.MAX_DEGREE;
      
      for (let i = 0; i < excess; i++) {
        const target = longRangeLinks.pop();
        if (target) {
          log.debug(`Auto-healing: dropping excess long-range link ${target.peerId.substring(0,8)}`);
          this.peerManager.disconnect(target.peerId);
        }
      }
    }
  }

  public destroy() {
    clearInterval(this.timer);
  }
}
