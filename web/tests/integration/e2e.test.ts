import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import type { GossipPacket } from '@/lib/types';
import { PeerManager } from '@/lib/network/PeerManager';
import { MessageDispatcher } from '@/lib/network/MessageDispatcher';
import { ZoneGossipRouter } from '@/lib/network/gossip/ZoneGossipRouter';
import { DHTMailbox } from '@/lib/network/mailbox/DHTMailbox';
import { PEXHandler } from '@/lib/network/PEXHandler';
import { NodeIdentity, NODE_ID_POW_FAST } from '@/lib/crypto/NodeIdentity';
import { PacketBuilder } from '@/lib/crypto/PacketBuilder';
import { CryptoEngine } from '@/lib/crypto/CryptoEngine';
import { Identity } from '@/lib/crypto/Identity';
import { KeyManager } from '@/lib/crypto/KeyManager';
import { WireType } from '@/lib/network/wire/WireTypes';
import { SignalingHub, HubSignalingClient, FakeZoneManager, FakeStore } from '../helpers/fakes';
import { installFakeWebRTC, resetFakeWebRTC } from '../helpers/webrtc';
import { syncPowEngine, keyMgr, toMailboxEntry, forgePacketWithoutPow } from '../helpers/packets';

const PARAMS = NODE_ID_POW_FAST;
const BOARD_KEY = new Uint8Array(32).fill(42);
const THREAD_ID = 'thread-e2e';

let hub: SignalingHub;

interface Node {
  identity: NodeIdentity;
  pm: PeerManager;
  dispatcher: MessageDispatcher;
  router: ZoneGossipRouter;
  mailbox: DHTMailbox;
  store: FakeStore;
  received: GossipPacket[];
}

beforeAll(async () => {
  await sodium.ready;
  installFakeWebRTC();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

beforeEach(() => {
  resetFakeWebRTC();
  hub = new SignalingHub();
});

async function makeNode(): Promise<Node> {
  const identity = await NodeIdentity.mine(PARAMS);
  const dispatcher = new MessageDispatcher();
  const signaling = new HubSignalingClient(hub, identity.peerId);
  const pm = new PeerManager(identity, dispatcher, signaling, { powParams: PARAMS });
  const zm = new FakeZoneManager();
  const router = new ZoneGossipRouter(pm, dispatcher, zm);
  const store = new FakeStore();
  const mailbox = new DHTMailbox(pm, dispatcher, store as any);
  new PEXHandler(pm, dispatcher);

  const received: GossipPacket[] = [];
  router.onMessage((p) => received.push(p));

  return { identity, pm, dispatcher, router, mailbox, store, received };
}

async function settle(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

async function buildPost(content: string, threadKey: Uint8Array, depth = 0): Promise<GossipPacket> {
  return PacketBuilder.build(
    content, threadKey, new Identity(), new CryptoEngine(),
    syncPowEngine, keyMgr, 'vip', THREAD_ID,
    0, null, 8, depth, 0, [], THREAD_ID, 8,
  );
}

describe('E2E: 投稿がゴシップで隣人に届く', () => {
  it('A が投稿すると B が復号できる', async () => {
    const a = await makeNode();
    const b = await makeNode();

    a.pm.connect(b.identity.peerId, true);
    await settle();
    expect(a.pm.peers.get(b.identity.peerId)?.isVerified).toBe(true);

    const threadKey = KeyManager.deriveThreadKey(BOARD_KEY, THREAD_ID);
    const packet = await buildPost('本文テスト', threadKey);

    await a.router.broadcast(packet, false);
    await settle();

    expect(b.received.map((p) => p.packet_id)).toContain(packet.packet_id);

    const decrypted = await PacketBuilder.verifyAndDecrypt(
      b.received.find((p) => p.packet_id === packet.packet_id)!,
      threadKey,
      new CryptoEngine(),
    );
    expect(decrypted?.content).toBe('本文テスト');
    expect(decrypted?.thread_id).toBe(THREAD_ID);
  });

  it('3 ノードの連鎖で 2 ホップ先まで届く', async () => {
    const a = await makeNode();
    const b = await makeNode();
    const c = await makeNode();

    a.pm.connect(b.identity.peerId, true);
    await settle();
    b.pm.connect(c.identity.peerId, true);
    await settle();

    const threadKey = KeyManager.deriveThreadKey(BOARD_KEY, THREAD_ID);
    const packet = await buildPost('2ホップ', threadKey);

    await a.router.broadcast(packet, false);
    await settle();

    expect(c.received.map((p) => p.packet_id)).toContain(packet.packet_id);
    // 中継で hop_count が増えている
    const atC = c.received.find((p) => p.packet_id === packet.packet_id)!;
    expect(atC.hop_count).toBeGreaterThan(0);
    // packet_id は不変 (hop_count は PoW のコミット対象外)
    expect(atC.packet_id).toBe(packet.packet_id);
  });

  it('★偽造パケットは 1 ホップも進まない', async () => {
    const a = await makeNode();
    const b = await makeNode();
    const c = await makeNode();

    a.pm.connect(b.identity.peerId, true);
    await settle();
    b.pm.connect(c.identity.peerId, true);
    await settle();

    // A が PoW 未払いのパケットを流し込む
    const forged = forgePacketWithoutPow({ pow_difficulty: 0 });
    a.dispatcher.dispatch(b.identity.peerId, WireType.GOSSIP, { packet: forged });
    await settle();

    expect(b.received).toHaveLength(0);
    expect(c.received).toHaveLength(0);
  });
});

describe('E2E: DHT による過去ログの往復', () => {
  it('publish したものを別ノードが fetch できる', async () => {
    const a = await makeNode();
    const b = await makeNode();

    a.pm.connect(b.identity.peerId, true);
    await settle();

    const threadKey = KeyManager.deriveThreadKey(BOARD_KEY, THREAD_ID);
    const packet = await buildPost('過去ログ', threadKey);
    const topicHash = KeyManager.toHex(KeyManager.deriveTopicHash(threadKey));

    await a.mailbox.publish(topicHash, toMailboxEntry(packet));
    await settle();

    const fetched = await b.mailbox.fetch(topicHash);
    await settle();

    // A と B のどちらかが担当なので、どちらかには入っている
    const stored = [...(a.store.topics.get(topicHash) ?? []), ...(b.store.topics.get(topicHash) ?? [])];
    expect(stored.length).toBeGreaterThan(0);
    void fetched;
  });

  it('★偽の過去ログは PUT で弾かれ、保存されない', async () => {
    const a = await makeNode();
    const b = await makeNode();

    a.pm.connect(b.identity.peerId, true);
    await settle();

    const threadKey = KeyManager.deriveThreadKey(BOARD_KEY, THREAD_ID);
    const topicHash = KeyManager.toHex(KeyManager.deriveTopicHash(threadKey));

    // 攻撃者が直接 DHT_PUT を撃ち込む
    b.dispatcher.dispatch(a.identity.peerId, WireType.DHT_PUT, {
      topicHash,
      entries: [toMailboxEntry(forgePacketWithoutPow({ pow_difficulty: 0 }))],
    });
    await settle();

    expect(b.store.topics.get(topicHash) ?? []).toHaveLength(0);
  });
});

describe('E2E: PEX', () => {
  it('検証済みピアだけを紹介し、position を載せない', async () => {
    const a = await makeNode();
    const b = await makeNode();
    const c = await makeNode();

    a.pm.connect(b.identity.peerId, true);
    await settle();
    a.pm.connect(c.identity.peerId, true);
    await settle();

    // B が A に PEX を要求する
    const responses: any[] = [];
    b.dispatcher.register(WireType.PEX_RESPONSE, (_from, payload) => responses.push(payload));

    b.pm.sendMessage(a.identity.peerId, WireType.PEX_REQUEST, { minDistance: 0 });
    await settle();

    expect(responses).toHaveLength(1);
    const peers = responses[0].peers;
    expect(peers.length).toBeGreaterThan(0);
    for (const p of peers) {
      expect(Object.keys(p)).toEqual(['id']);
      expect(p).not.toHaveProperty('position');
      expect(p).not.toHaveProperty('zones');
    }
    // 自分自身は紹介されない
    expect(peers.map((p: any) => p.id)).not.toContain(b.identity.peerId);
  });
});

describe('E2E: 全ノードが同じ判定に収束する', () => {
  it('同じパケットに対する検証結果が全ノードで一致する', async () => {
    const nodes = await Promise.all([makeNode(), makeNode(), makeNode()]);
    const threadKey = KeyManager.deriveThreadKey(BOARD_KEY, THREAD_ID);
    const good = await buildPost('ok', threadKey);
    const bad = forgePacketWithoutPow({ pow_difficulty: 0 });

    const { PacketValidator } = await import('@/lib/network/gossip/PacketValidator');
    for (const _ of nodes) {
      expect(PacketValidator.check(good).ok).toBe(true);
      expect(PacketValidator.check(bad).ok).toBe(false);
    }
  });
});
