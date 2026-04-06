import type { IPeerManager, PeerId, IMessageDispatcher } from '../types';
import { WireType } from './wire/WireTypes';

/**
 * Heartbeat Module
 * 全ピアへの定期的な Ping 送信、Pong 応答、および RTT (往復遅延) の計測を担当する。
 */
export class Heartbeat {
  private peerManager: IPeerManager;
  private interval: number = 15_000; // 15秒
  private timer: any = null;

  constructor(peerManager: IPeerManager, dispatcher: IMessageDispatcher) {
    this.peerManager = peerManager;

    dispatcher.register(WireType.PING, (peerId, msg) => this.handlePing(peerId, msg));
    dispatcher.register(WireType.PONG, (peerId, msg) => this.handlePong(peerId, msg));
  }

  /**
   * ハートビートを開始
   */
  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.pingAll(), this.interval);
  }

  /**
   * ハートビートを停止
   */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 全ピアに対して Ping を送信する
   */
  private pingAll(): void {
    const now = Date.now();
    for (const [peerId, peer] of this.peerManager.peers) {
      if (peer.isConnected) {
        this.peerManager.sendMessage(peerId, WireType.PING, { ts: now });
      }
    }
  }

  /** ── Dispatcher Handlers ── */

  private handlePing(peerId: PeerId, msg: any): void {
    this.peerManager.sendMessage(peerId, WireType.PONG, { ts: msg.ts });
  }

  private handlePong(peerId: PeerId, msg: any): void {
    const peer = this.peerManager.peers.get(peerId);
    if (peer && typeof msg.ts === 'number') {
      const rtt = Date.now() - msg.ts;
      (peer as any).rtt = rtt;
    }
  }
}
