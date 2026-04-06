import type { GossipPacket } from '../../types';
import { PoWEngine } from '../../crypto/PoWEngine';

export const GOSSIP_RULES = {
  MAX_PAYLOAD_SIZE: 1024 * 1024,   // 1MB: 巨大なスパムパケットを落とす
  MAX_TIME_DRIFT: 15 * 60 * 1000,  // ±15分: これより未来・過去のパケットをネットワークから除外
};

export class PacketValidator {
  public static async validate(packet: GossipPacket): Promise<boolean> {
    if (!packet || typeof packet !== 'object') return false;
    if (typeof packet.packet_id !== 'string') return false;
    if (typeof packet.timestamp !== 'number') return false;
    
    // 1. サイズ制約
    const payloadSize = packet.payload ? packet.payload.length : 0;
    if (payloadSize > GOSSIP_RULES.MAX_PAYLOAD_SIZE || payloadSize < 0) {
      console.warn(`[PacketValidator] Dropped ${packet.packet_id.substring(0,8)} (Invalid size: ${payloadSize} bytes)`);
      return false;
    }

    // 2. 時刻制約 (Replay攻撃と無限ループ防衛)
    // - あまりにも過去のパケットは「過去ログ」を装ったスパム（リプレイ）の可能性がある。
    // - 15分以上前の攻撃はネットワーク全員が拒否し、15分以内の再送は LRU(SeenCache) が防ぐ。
    const now = Date.now();
    const drift = Math.abs(now - packet.timestamp);
    if (drift > GOSSIP_RULES.MAX_TIME_DRIFT) {
      console.warn(`[PacketValidator] Dropped ${packet.packet_id.substring(0,8)} (Time drift: ${Math.floor(drift/1000)}s)`);
      return false;
    }
    
    // 3. PoW (DDoSパケット破棄)
    const isValidPoW = await PoWEngine.verify(
      new Uint8Array(packet.payload), 
      BigInt(packet.pow_nonce), 
      packet.pow_difficulty
    );
    if (!isValidPoW) {
      console.warn(`[PacketValidator] Dropped ${packet.packet_id.substring(0,8)} (Invalid PoW)`);
      return false;
    }

    return true;
  }
}
