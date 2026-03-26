import type { IPeerManager, PeerId, GossipPacket, StemPacket } from '../../types';

export const DANDELION_CONFIG = {
  FLUFF_PROBABILITY: 0.1,
  STEM_TTL_MIN: 2,
  STEM_TTL_MAX: 4,
  EPOCH_DURATION: 10 * 60 * 1000,
  ECHO_TIMEOUT: 5000,
  MAX_RETRIES: 2,
};

type EchoCallback = () => void;

export class DandelionRouter {
  private stemTarget: PeerId | null = null;
  private stemTargetExpiry: number = 0;
  private listeners: Map<string, Array<EchoCallback>> = new Map();
  private peerManager: IPeerManager;

  constructor(peerManager: IPeerManager) {
    this.peerManager = peerManager;
  }

  /**
   * 自己発信パケットのステム送信開始
   */
  public async publish(packet: GossipPacket, useDandelion: boolean = true): Promise<boolean> {
    if (!useDandelion || this.peerManager.degree === 0) {
      return false;
    }

    let retries = 0;
    while (retries <= DANDELION_CONFIG.MAX_RETRIES) {
      const neighbors = Array.from(this.peerManager.peers.keys());
      if (neighbors.length === 0) return false;

      const ttl = DANDELION_CONFIG.STEM_TTL_MIN + 
                  Math.floor(Math.random() * (DANDELION_CONFIG.STEM_TTL_MAX - DANDELION_CONFIG.STEM_TTL_MIN + 1));
      
      const target = this.getStemTarget(neighbors);
      const stem: StemPacket = {
        type: 'stem',
        zoneId: packet.zone_id,
        stemTtl: ttl,
        packet: packet
      };

      console.log(`[Dandelion] Stemming packet ${packet.packet_id.substring(0,8)} to ${target.substring(0,8)} (ttl: ${ttl})`);
      
      this.sendToPeer(target, stem);

      // エコー待ち
      const echoed = await this.waitForEcho(packet.packet_id);
      if (echoed) {
        console.log(`[Dandelion] Echo confirmed for ${packet.packet_id.substring(0,8)}!`);
        return true;
      }

      console.warn(`[Dandelion] Echo timeout for ${packet.packet_id.substring(0,8)}. Retrying...`);
      retries++;
      this.resetTarget();
    }

    return false;
  }

  /**
   * 中継処理
   * @param senderId パケットを送ってきた隣人のID
   */
  public handleStemPacket(senderId: PeerId, stem: StemPacket): { action: 'forward' | 'fluff', target?: PeerId, packet: GossipPacket | StemPacket } {
    const neighbors = Array.from(this.peerManager.peers.keys())
        .filter(pid => pid !== senderId); // 送り主を候補から外す (§5.2)
    
    // 10% の確率、または TTL 切れ、または他に隣人がいない場合に Fluff
    if (stem.stemTtl <= 0 || Math.random() < DANDELION_CONFIG.FLUFF_PROBABILITY || neighbors.length === 0) {
      return { 
        action: 'fluff', 
        packet: { ...stem.packet, hop_count: 0 } 
      };
    }

    // 次のターゲットを選択（送り主以外から）
    const nextTarget = this.getStemTarget(neighbors, senderId);
    return {
      action: 'forward',
      target: nextTarget,
      packet: { ...stem, stemTtl: stem.stemTtl - 1 }
    };
  }

  /**
   * エコーを通知
   */
  public notifyEcho(packetId: string) {
    const key = `echo:${packetId}`;
    const callbacks = this.listeners.get(key);
    if (callbacks) {
      callbacks.forEach(cb => cb());
      this.listeners.delete(key);
    }
  }

  private getStemTarget(neighbors: PeerId[], excludeId?: PeerId): PeerId {
    const now = Date.now();
    // 既存のターゲットが有効かつ候補の中にあり、かつ除外対象でないなら再利用 (Epoch)
    if (this.stemTarget && now < this.stemTargetExpiry && neighbors.includes(this.stemTarget) && this.stemTarget !== excludeId) {
      return this.stemTarget;
    }

    // 新しいターゲットを抽選
    this.stemTarget = neighbors[Math.floor(Math.random() * neighbors.length)];
    this.stemTargetExpiry = now + DANDELION_CONFIG.EPOCH_DURATION;
    return this.stemTarget;
  }

  private resetTarget() {
    this.stemTarget = null;
  }

  private async waitForEcho(packetId: string): Promise<boolean> {
    const key = `echo:${packetId}`;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(key);
        resolve(false);
      }, DANDELION_CONFIG.ECHO_TIMEOUT);

      const callback = () => {
        clearTimeout(timeout);
        resolve(true);
      };

      if (!this.listeners.has(key)) {
        this.listeners.set(key, []);
      }
      this.listeners.get(key)!.push(callback);
    });
  }

  private sendToPeer(targetId: PeerId, msg: any) {
    const peer = this.peerManager.peers.get(targetId);
    if (peer && peer.isConnected) {
      peer.send(JSON.stringify(msg, (_key, value) => {
        if (value instanceof Uint8Array) return { _type: 'Uint8Array', data: Array.from(value) };
        return value;
      }));
    }
  }
}
