import { vi } from 'vitest';
import { NodeIdentity } from '../../src/crypto/NodeIdentity';
import { MessageDispatcher } from '../../src/network/MessageDispatcher';
import { PeerManager } from '../../src/network/PeerManager';
import { RateLimiter } from '../../src/network/RateLimiter';
import { PEXHandler } from '../../src/network/PEXHandler';
import { DandelionRouter } from '../../src/network/gossip/DandelionRouter';
import { ZoneGossipRouter } from '../../src/network/gossip/ZoneGossipRouter';
import { HintRouter } from '../../src/network/hint/HintRouter';
import { OnionCircuit } from '../../src/network/onion/OnionCircuit';
import { WireCodec } from '../../src/network/wire/WireCodec';
import { derivePacketId, verifyPow } from '../../src/crypto/PowPolicy';
import sodium from '../../src/crypto/sodium';
import type { GossipPacket } from '../../src/types';

export const FAST_POW = { difficulty: 0, opsLimit: 1, memLimit: 8192 };

/** テスト用に十分緩いレート制限 (cover traffic を短い間隔で回すため) */
const LOOSE_LIMITS = Object.fromEntries(
  ['gossip', 'dhtPut', 'dhtGet', 'pex', 'handshake', 'signaling', 'control', 'onion'].map(k => [k, { ratePerSec: 1e6, burst: 1e6 }]),
);

export interface SimNode {
  name: string;
  identity: NodeIdentity;
  dispatcher: MessageDispatcher;
  peerManager: PeerManager;
  dandelion: DandelionRouter;
  circuit: OnionCircuit;
  gossip: ZoneGossipRouter;
  hints: HintRouter;
  received: GossipPacket[];
  /** この節点が受け取った生のワイヤメッセージ (送信者つき) */
  inbox: Array<{ from: string; type: number; payload: any }>;
}

export async function createSimNode(name: string, circuitOptions?: any): Promise<SimNode> {
  const identity = await NodeIdentity.mine(FAST_POW);
  const dispatcher = new MessageDispatcher();
  const signaling: any = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    sendRelay: vi.fn(),
    on: vi.fn(),
    isConnected: false,
  };
  const peerManager = new PeerManager(identity, dispatcher, signaling, {
    powParams: FAST_POW,
    rateLimiter: new RateLimiter(LOOSE_LIMITS),
    allowMissingDtlsFingerprint: true,
  });
  // PEX 応答で新規接続を張りに行かないようにする (テストのトポロジーを固定するため)
  (peerManager as any).connect = vi.fn();

  const zoneManager: any = { isSubscribed: () => true, depth: 0 };
  const dandelion = new DandelionRouter(peerManager);
  const circuit = new OnionCircuit(peerManager, dispatcher, dandelion, circuitOptions ?? {
    coverIntervalMs: 15,
    relayDelayMs: 1,
    exitDelayMs: 1,
    echoTimeoutMs: 400,
  });
  const gossip = new ZoneGossipRouter(peerManager, dispatcher, zoneManager, dandelion, circuit);
  const hints = new HintRouter(peerManager, dispatcher, dandelion, circuit);
  new PEXHandler(peerManager, dispatcher);

  const received: GossipPacket[] = [];
  gossip.onMessage(p => received.push(p));

  const node: SimNode = {
    name, identity, dispatcher, peerManager, dandelion, circuit, gossip, hints, received, inbox: [],
  };
  const original = (peerManager as any).handleData.bind(peerManager);
  (peerManager as any).handleData = (from: string, data: Uint8Array) => {
    const decoded = WireCodec.decode(data);
    node.inbox.push({ from, type: decoded.type, payload: decoded.payload });
    return original(from, data);
  };
  return node;
}

/** 双方向の検証済みリンクを張る (配送は非同期) */
export function link(a: SimNode, b: SimNode): void {
  const half = (from: SimNode, to: SimNode) => ({
    peerId: to.identity.peerId,
    position: to.identity.position,
    rtt: 0,
    isConnected: true,
    isVerified: true,
    pubkey: to.identity.pubkey,
    powCounter: to.identity.powCounter,
    send: (data: Uint8Array) => {
      const copy = data.slice();
      setTimeout(() => (to.peerManager as any).handleData(from.identity.peerId, copy), 0);
    },
    close: vi.fn(),
  });
  (a.peerManager as any)._peers.set(b.identity.peerId, half(a, b));
  (b.peerManager as any)._peers.set(a.identity.peerId, half(b, a));
}

export function unlink(a: SimNode, b: SimNode): void {
  (a.peerManager as any)._peers.delete(b.identity.peerId);
  (b.peerManager as any)._peers.delete(a.identity.peerId);
}

export function startAll(nodes: SimNode[]): void {
  for (const n of nodes) n.circuit.start();
}

export function stopAll(nodes: SimNode[]): void {
  for (const n of nodes) {
    n.circuit.stop();
    n.gossip.destroy();
    n.hints.destroy();
  }
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** PoW と CHK が整合した最小の GossipPacket */
export function makePacket(payloadBytes: number[] | Uint8Array = [1, 2, 3, 4]): GossipPacket {
  const payload = payloadBytes instanceof Uint8Array ? payloadBytes : Uint8Array.from(payloadBytes);
  const header = {
    timestamp: Date.now(),
    zone_id: 1,
    pow_difficulty: 8,
    nonce: sodium.randombytes_buf(12),
    payload,
  };
  let pow_nonce = 0;
  while (!verifyPow(header, pow_nonce)) pow_nonce++;
  return {
    packet_id: derivePacketId(header),
    hop_count: 0,
    pow_nonce,
    pow_difficulty: header.pow_difficulty,
    timestamp: header.timestamp,
    zone_id: header.zone_id,
    nonce: header.nonce,
    payload,
  };
}
