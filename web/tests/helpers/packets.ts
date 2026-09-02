import sodium from 'libsodium-wrappers-sumo';
import type { GossipPacket, IPoWEngine, IKeyManager } from '@/lib/types';
import { PacketBuilder } from '@/lib/crypto/PacketBuilder';
import { PoWEngine } from '@/lib/crypto/PoWEngine';
import { CryptoEngine } from '@/lib/crypto/CryptoEngine';
import { KeyManager } from '@/lib/crypto/KeyManager';
import { Identity } from '@/lib/crypto/Identity';
import { POW_POLICY, derivePacketId, solvePow, type PowCommittedHeader } from '@/lib/crypto/PowPolicy';
import { JsonBinary } from '@/lib/common/JsonBinary';

/** Worker を使わない同期 PoW エンジン */
export const syncPowEngine: IPoWEngine = {
  compute: async (header) => PoWEngine.computeSync(header),
};

export const keyMgr: IKeyManager = {
  deriveThreadKey: KeyManager.deriveThreadKey,
  deriveTopicHash: KeyManager.deriveTopicHash,
  computeZoneId: KeyManager.computeZoneId,
};

export interface BuildOptions {
  content?: string;
  boardId?: string;
  threadId?: string;
  difficulty?: number;
  depth?: number;
  postType?: number;
}

/** 正当な GossipPacket を 1 個作る (実際の投稿経路と同じコードを通す) */
export async function buildValidPacket(
  threadKey: Uint8Array,
  opts: BuildOptions = {},
): Promise<GossipPacket> {
  await sodium.ready;
  return PacketBuilder.build(
    opts.content ?? 'hello aether',
    threadKey,
    new Identity(),
    new CryptoEngine(),
    syncPowEngine,
    keyMgr,
    opts.boardId ?? 'vip',
    opts.threadId ?? 'thread1',
    0,
    null,
    opts.difficulty ?? POW_POLICY.MIN_DIFFICULTY,
    opts.depth ?? 0,
    opts.postType ?? 0,
  );
}

/**
 * 攻撃者が作る「PoW を払っていない」パケット。
 * packet_id は自分で計算し直すので CHK は通るが、PoW は満たさない。
 */
export function forgePacketWithoutPow(overrides: Partial<GossipPacket> = {}): GossipPacket {
  const header: PowCommittedHeader = {
    timestamp: overrides.timestamp ?? Date.now(),
    zone_id: overrides.zone_id ?? 0,
    pow_difficulty: overrides.pow_difficulty ?? 0,
    nonce: overrides.nonce ?? new Uint8Array(POW_POLICY.NONCE_SIZE).fill(1),
    payload: overrides.payload ?? new Uint8Array(64).fill(2),
  };
  return {
    packet_id: derivePacketId(header),
    hop_count: overrides.hop_count ?? 0,
    pow_nonce: overrides.pow_nonce ?? 0,
    ...header,
  };
}

/**
 * 指定した難易度で「正しく解いた」パケットを作る。
 * MIN_DIFFICULTY 未満の難易度でもきちんと PoW を解いた状態にできるので、
 * 「ポリシーによる拒否」と「PoW 不足による拒否」を切り分けてテストできる。
 */
export function forgePacketWithPow(difficulty: number, overrides: Partial<GossipPacket> = {}): GossipPacket {
  const header: PowCommittedHeader = {
    timestamp: overrides.timestamp ?? Date.now(),
    zone_id: overrides.zone_id ?? 0,
    pow_difficulty: difficulty,
    nonce: overrides.nonce ?? new Uint8Array(POW_POLICY.NONCE_SIZE).fill(3),
    payload: overrides.payload ?? new Uint8Array(64).fill(4),
  };
  const nonce = solvePow(header, 5_000_000);
  return {
    packet_id: derivePacketId(header),
    hop_count: 0,
    pow_nonce: Number(nonce ?? 0n),
    ...header,
  };
}

/** DHT に格納される形 (JsonBinary 直列化) にする */
export function toMailboxEntry(packet: GossipPacket): Uint8Array {
  return new TextEncoder().encode(JsonBinary.stringify(packet));
}

export function fromMailboxEntry(entry: Uint8Array): GossipPacket {
  return JsonBinary.parse<GossipPacket>(new TextDecoder().decode(entry));
}

export const testBoardKey = () => new Uint8Array(32).fill(9);
