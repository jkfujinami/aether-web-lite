import type { IPeerManager, PeerId } from '../types';

/**
 * Heartbeat Module
 * 全ピアへの定期的な Ping 送信、Pong 応答、および RTT (往復遅延) の計測を担当する。
 */
export class Heartbeat {
  private peerManager: IPeerManager;
  private interval: number = 15_000; // 15秒
  private timer: any = null;

  constructor(peerManager: IPeerManager) {
    this.peerManager = peerManager;

    // ピアからのデータ受信を監視し、ping/pong メッセージを処理する
    this.peerManager.on('peer:data', (peerId, data) => this.handleData(peerId, data));
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
        try {
          peer.send(JSON.stringify({
            type: 'ping',
            ts: now
          }));
        } catch (e) {
          console.warn(`[Heartbeat] Failed to ping ${peerId}:`, e);
        }
      }
    }
  }

  /**
   * 受信データを解析し、ping/pong であれば適切に処理する
   */
  private handleData(peerId: PeerId, data: Uint8Array | string): void {
    // 文字列データ（JSON）のみを対象とする
    if (typeof data !== 'string') return;

    try {
      const msg = JSON.parse(data);
      if (!msg || typeof msg.type !== 'string') return;

      const peer = this.peerManager.peers.get(peerId);
      if (!peer) return;

      if (msg.type === 'ping') {
        // Ping を受け取ったら Pong を返す
        peer.send(JSON.stringify({
          type: 'pong',
          ts: msg.ts
        }));
      } 
      else if (msg.type === 'pong') {
        // Pong を受け取ったら RTT を計算し、ピア情報に反映する
        if (typeof msg.ts === 'number') {
          const rtt = Date.now() - msg.ts;
          // IPeerConnection.rtt は readonly ではないため直接代入可能
          (peer as any).rtt = rtt;
        }
      }
    } catch (e) {
      // JSON ではない通常のゴシップパケット等は無視
    }
  }
}
