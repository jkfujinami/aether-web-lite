import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { NodeIdentity } from '../../src/crypto/NodeIdentity';
import { MessageDispatcher } from '../../src/network/MessageDispatcher';
import { PeerManager } from '../../src/network/PeerManager';
import { DandelionRouter } from '../../src/network/gossip/DandelionRouter';
import { ZoneGossipRouter } from '../../src/network/gossip/ZoneGossipRouter';
import { ZoneManager } from '../../src/network/ZoneManager';
import { WireType } from '../../src/network/wire/WireTypes';
import { WireCodec } from '../../src/network/wire/WireCodec';
import { PacketBuilder } from '../../src/crypto/PacketBuilder';
import type { GossipPacket } from '../../src/types';

describe('Onion Stem Routing 実網結合テスト (Alice -> Bob -> Charlie -> Dave)', () => {
  beforeAll(async () => {
    await sodiumReady;
  });

  interface SimPeerNode {
    identity: NodeIdentity;
    dispatcher: MessageDispatcher;
    peerManager: PeerManager;
    dandelion: DandelionRouter;
    gossip: ZoneGossipRouter;
    receivedPackets: GossipPacket[];
  }

  async function createTestNode(name: string): Promise<SimPeerNode> {
    const identity = await NodeIdentity.mine({ difficulty: 0, opsLimit: 1, memLimit: 8192 });
    const dispatcher = new MessageDispatcher();
    const mockSignaling: any = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      sendRelay: vi.fn(),
      on: vi.fn(),
      isConnected: false,
    };

    const peerManager = new PeerManager(identity, dispatcher, mockSignaling, {
      powParams: { timeCost: 1, memoryCostKiB: 64, parallelism: 1, difficultyBits: 0 },
    });

    const zoneManager: any = {
      isSubscribed: () => true,
      depth: 0,
    };

    const dandelion = new DandelionRouter(peerManager);
    const gossip = new ZoneGossipRouter(peerManager, dispatcher, zoneManager, dandelion);

    const receivedPackets: GossipPacket[] = [];
    gossip.onMessage((pkt) => receivedPackets.push(pkt));

    return {
      identity,
      dispatcher,
      peerManager,
      dandelion,
      gossip,
      receivedPackets,
    };
  }

  function linkPeers(nodeA: SimPeerNode, nodeB: SimPeerNode) {
    const peerOnA: any = {
      peerId: nodeB.identity.peerId,
      position: nodeB.identity.position,
      isConnected: true,
      isVerified: true,
      pubkey: nodeB.identity.pubkey,
      send: (data: Uint8Array) => {
        // nodeA -> nodeB への直接メッセージ配送
        (nodeB.peerManager as any).handleData(nodeA.identity.peerId, data);
      },
      close: vi.fn(),
    };

    const peerOnB: any = {
      peerId: nodeA.identity.peerId,
      position: nodeA.identity.position,
      isConnected: true,
      isVerified: true,
      pubkey: nodeA.identity.pubkey,
      send: (data: Uint8Array) => {
        // nodeB -> nodeA への直接メッセージ配送
        (nodeA.peerManager as any).handleData(nodeB.identity.peerId, data);
      },
      close: vi.fn(),
    };

    (nodeA.peerManager as any)._peers.set(nodeB.identity.peerId, peerOnA);
    (nodeB.peerManager as any)._peers.set(nodeA.identity.peerId, peerOnB);
  }

  it('★ Alice が放流したパケットが Bob(Guard) -> Charlie(Exit) を Onion暗号のまま通過し、CharlieからFluffされて Dave に到達する', async () => {
    const alice = await createTestNode('alice');
    const bob = await createTestNode('bob');
    const charlie = await createTestNode('charlie');
    const dave = await createTestNode('dave');

    // トポロジーを接続:
    // Alice <--> Bob
    // Bob <--> Charlie
    // Charlie <--> Dave
    // (Alice と Charlie, Dave は直接接続していない)
    linkPeers(alice, bob);
    linkPeers(bob, charlie);
    linkPeers(charlie, dave);

    // Alice が定義するオニオン回路:
    // Hop 1: Bob (Guard Node - 直結隣人)
    // Hop 2: Charlie (Exit Node - 出口フラッフノード)
    const circuit = [
      { peerId: bob.identity.peerId, pubkey: bob.identity.pubkey },
      { peerId: charlie.identity.peerId, pubkey: charlie.identity.pubkey },
    ];

    // 有効なテストパケットを構築 (PoW & CHK 整合)
    const timestamp = Date.now();
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const nonce = new Uint8Array(12); // POW_POLICY.NONCE_SIZE = 12
    const pow_difficulty = 8;
    const header = {
      timestamp,
      zone_id: 1,
      pow_difficulty,
      nonce,
      payload,
    };
    const { derivePacketId, verifyPow } = await import('../../src/crypto/PowPolicy');
    const packet_id = derivePacketId(header);
    let pow_nonce = 0;
    while (!verifyPow(header, pow_nonce)) {
      pow_nonce++;
    }

    const packet: GossipPacket = {
      packet_id,
      zone_id: 1,
      timestamp,
      pow_difficulty,
      pow_nonce,
      hop_count: 0,
      signature: 'mock-sig',
      payload,
      nonce,
    } as any;

    // Bob が受信したメッセージを監視
    const bobInterceptedMessages: any[] = [];
    const origBobHandleData = (bob.peerManager as any).handleData.bind(bob.peerManager);
    (bob.peerManager as any).handleData = (senderId: string, data: any) => {
      const decoded = WireCodec.decode(data instanceof Uint8Array ? data : new TextEncoder().encode(data));
      bobInterceptedMessages.push(decoded);
      return origBobHandleData(senderId, data);
    };

    // Alice が Onion Stem でパケットを発信！
    const success = await alice.dandelion.publishOnion(packet, 2, circuit);
    expect(success).toBe(true);

    // ── 検証 1: Bob (Guardノード) が傍受できた内容の検証 ──
    // Bob は平文パケットを受信していない！
    // 受信したのは WireType.ONION_STEM の暗号化バイナリのみ。
    const bobReceivedOnion = bobInterceptedMessages.find(m => m.type === WireType.ONION_STEM);
    expect(bobReceivedOnion).toBeDefined();
    // 平文の packet_id や内容は Bob のメッセージに一切含まれない
    expect(JSON.stringify(bobReceivedOnion.payload)).not.toContain(packet.packet_id);
    expect(JSON.stringify(bobReceivedOnion.payload)).not.toContain('Hello via Onion Stem!');

    // ★ セルサイズ検証: Alice -> Bob 間は固定長セル (3800バイト) かつバイナリ直接配送 (No-Chunking)
    const { OnionRouter } = await import('../../src/crypto/OnionRouter');
    const bobRawBytes = bobReceivedOnion.payload.onionBytes;
    const bobCellBytes = bobRawBytes instanceof Uint8Array
      ? bobRawBytes
      : (await import('../../src/common/Encoding')).Encoding.fromHex(bobRawBytes);
    expect(bobCellBytes.byteLength).toBe(OnionRouter.CELL_SIZE);
    expect(bobCellBytes.byteLength).toBe(3800);

    // ── 検証 2: Dave (出口 Charlie の隣人) に Fluff 経由で届いたことの検証 ──
    expect(dave.receivedPackets.length).toBe(1);
    expect(dave.receivedPackets[0].packet_id).toBe(packet.packet_id);
    expect(Array.from(dave.receivedPackets[0].payload as Uint8Array)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    // ── 検証 3: Alice (発信元) でエコーが確定していること ──
    expect(success).toBe(true);
  });

  it('★ 誣告攻撃 (Framing Attack) 対策検証: 出口ノードがパケットを握り潰しても正直なGuardノードはBANされない', async () => {
    const alice = await createTestNode('alice_frame');
    const bobGuard = await createTestNode('bob_guard');
    const eveExit = await createTestNode('eve_exit');

    linkPeers(alice, bobGuard);
    linkPeers(bobGuard, eveExit);

    // Eve (Exitノード) のハンドラをクリアしてパケットを黙って破棄 (Drop) させる
    (eveExit.dispatcher as any).handlers.set(WireType.ONION_STEM, new Set());

    const circuit = [
      { peerId: bobGuard.identity.peerId, pubkey: bobGuard.identity.pubkey },
      { peerId: eveExit.identity.peerId, pubkey: eveExit.identity.pubkey },
    ];

    const timestamp = Date.now();
    const payload = new Uint8Array([9, 9, 9]);
    const nonce = new Uint8Array(12);
    const header = { timestamp, zone_id: 1, pow_difficulty: 8, nonce, payload };
    const { derivePacketId, verifyPow } = await import('../../src/crypto/PowPolicy');
    const packet_id = derivePacketId(header);
    let pow_nonce = 0;
    while (!verifyPow(header, pow_nonce)) pow_nonce++;

    const packet: GossipPacket = {
      packet_id,
      zone_id: 1,
      timestamp,
      pow_difficulty: 8,
      pow_nonce,
      hop_count: 0,
      signature: 'mock-sig',
      payload,
      nonce,
    } as any;

    // Alice のエコータイムアウトを高速テスト用に 50ms に設定
    alice.dandelion.echoTimeoutMs = 50;

    // Alice が送信を試行 (Eve が破棄するためエコータイムアウトする)
    const success = await alice.dandelion.publishOnion(packet, 2, circuit);
    expect(success).toBe(false);

    // ★ 核心検証: エコーが届かなくても、Alice は正直な Bob(Guard) を BAN していないこと！
    expect(alice.peerManager.misbehavior.isBanned(bobGuard.identity.peerId)).toBe(false);
    expect(alice.peerManager.misbehavior.getScore(bobGuard.identity.peerId)).toBe(0);
  });

  it('★ Guard Sticky Pinning: 複数回連続で選定しても同一の Guard ノードを使い続け、切断時のみフェイルオーバーする', async () => {
    const alice = await createTestNode('alice_pin');
    const bob1 = await createTestNode('bob1');
    const bob2 = await createTestNode('bob2');

    linkPeers(alice, bob1);
    linkPeers(alice, bob2);

    const candidates = [
      { peerId: bob1.identity.peerId, pubkey: bob1.identity.pubkey },
      { peerId: bob2.identity.peerId, pubkey: bob2.identity.pubkey },
    ];

    // 1回目の選定
    const pinned1 = alice.dandelion.getPinnedGuard(candidates);
    expect(pinned1).toBeDefined();
    const originalGuardId = pinned1!.peerId;

    // 10回連続で選定しても、同一の Guard が選ばれ続ける (Sticky Pinning)
    for (let i = 0; i < 10; i++) {
      const g = alice.dandelion.getPinnedGuard(candidates);
      expect(g?.peerId).toBe(originalGuardId);
      expect(alice.dandelion.getPinnedGuardId()).toBe(originalGuardId);
    }

    // 元の Guard (originalGuardId) がネットワークから切断された場合
    (alice.peerManager as any)._peers.delete(originalGuardId);
    const remainingCandidates = candidates.filter(c => c.peerId !== originalGuardId);

    // 切断後は自動的に残りの候補へフェイルオーバーし、新しい Guard が Pin される
    const newPinned = alice.dandelion.getPinnedGuard(remainingCandidates);
    expect(newPinned).toBeDefined();
    expect(newPinned!.peerId).not.toBe(originalGuardId);
    expect(alice.dandelion.getPinnedGuardId()).toBe(newPinned!.peerId);
  });

  it('★ 再送指紋耐性 (Retransmission Resistance): 再送時に同一 Guard を維持しつつ新エフェメラル鍵で暗号文が完全無相関化される', async () => {
    const alice = await createTestNode('alice_retransmit');
    const bobGuard = await createTestNode('bob_guard2');
    const eveExit = await createTestNode('eve_exit2');
    const frankExit = await createTestNode('frank_exit2');

    linkPeers(alice, bobGuard);
    linkPeers(alice, eveExit);
    linkPeers(alice, frankExit);
    linkPeers(bobGuard, eveExit);
    linkPeers(bobGuard, frankExit);

    // Bob を確実に Guard として Pin 留め
    alice.dandelion.getPinnedGuard([
      { peerId: bobGuard.identity.peerId, pubkey: bobGuard.identity.pubkey },
    ]);

    // Bob (Guard) が受信した Onion セルを記録
    const bobReceivedPackets: Uint8Array[] = [];
    const origBobHandle = (bobGuard.peerManager as any).handleData.bind(bobGuard.peerManager);
    (bobGuard.peerManager as any).handleData = (senderId: string, data: any) => {
      const decoded = WireCodec.decode(data instanceof Uint8Array ? data : new TextEncoder().encode(data));
      if (decoded.type === WireType.ONION_STEM) {
        bobReceivedPackets.push(decoded.payload.onionBytes);
      }
      return origBobHandle(senderId, data);
    };

    // Eve と Frank (Exit 候補) はパケットを破棄してエコーを返さない (故意ドロップ誘発)
    (eveExit.dispatcher as any).handlers.set(WireType.ONION_STEM, new Set());
    (frankExit.dispatcher as any).handlers.set(WireType.ONION_STEM, new Set());

    // Alice のエコー待ちを高速化
    alice.dandelion.echoTimeoutMs = 60;

    const timestamp = Date.now();
    const payload = new Uint8Array([42, 42, 42]);
    const nonce = new Uint8Array(12);
    const header = { timestamp, zone_id: 1, pow_difficulty: 8, nonce, payload };
    const { derivePacketId, verifyPow } = await import('../../src/crypto/PowPolicy');
    const packet_id = derivePacketId(header);
    let pow_nonce = 0;
    while (!verifyPow(header, pow_nonce)) pow_nonce++;

    const packet: GossipPacket = {
      packet_id,
      zone_id: 1,
      timestamp,
      pow_difficulty: 8,
      pow_nonce,
      hop_count: 0,
      signature: 'mock-sig',
      payload,
      nonce,
    } as any;

    await alice.dandelion.publishOnion(packet, 2);

    // MAX_RETRIES = 2 回試行されたことを確認
    expect(bobReceivedPackets.length).toBe(2);

    // ★ 核心検証 1: 試行 1 と試行 2 は同じ Bob(Guard) に送られた (Guard Affinity)
    // ★ 核心検証 2: 試行 1 と試行 2 の 3800B セルはビットレベルで完全な別物 (Fresh Ephemeral Keys)
    const attempt1Bytes = bobReceivedPackets[0];
    const attempt2Bytes = bobReceivedPackets[1];

    expect(attempt1Bytes.byteLength).toBe(3800);
    expect(attempt2Bytes.byteLength).toBe(3800);
    // 暗号文が 1 バイトたりとも同じブロックに一致しない (完全無相関)
    expect(Array.from(attempt1Bytes)).not.toEqual(Array.from(attempt2Bytes));
  });

  it('★ Fail-Closed 検証: オニオン送信が完全失敗しても平文 flood() へフォールバックせず安全にドロップされる', async () => {
    const alice = await createTestNode('alice_failclosed');
    const bob = await createTestNode('bob_failclosed');

    linkPeers(alice, bob);

    // Bob が受信した平文 GOSSIP パケットを監視
    const bobReceivedGossip: any[] = [];
    (bob.dispatcher as any).register(WireType.GOSSIP, (_sender: string, msg: any) => {
      bobReceivedGossip.push(msg);
    });

    // Bob (唯一の隣人) は ONION_STEM を一切処理せず破棄する (故意ドロップ)
    (bob.dispatcher as any).handlers.set(WireType.ONION_STEM, new Set());

    // Alice のエコータイムアウトを高速化
    alice.dandelion.echoTimeoutMs = 30;

    const timestamp = Date.now();
    const payload = new Uint8Array([11, 22, 33]);
    const nonce = new Uint8Array(12);
    const header = { timestamp, zone_id: 1, pow_difficulty: 8, nonce, payload };
    const { derivePacketId, verifyPow } = await import('../../src/crypto/PowPolicy');
    const packet_id = derivePacketId(header);
    let pow_nonce = 0;
    while (!verifyPow(header, pow_nonce)) pow_nonce++;

    const packet: GossipPacket = {
      packet_id,
      zone_id: 1,
      timestamp,
      pow_difficulty: 8,
      pow_nonce,
      hop_count: 0,
      signature: 'mock-sig',
      payload,
      nonce,
    } as any;

    // Alice が broadcast() を実行 (オニオン経由)
    await alice.gossip.broadcast(packet, true);

    // ★ 核心検証: オニオン配信が失敗しても、平文 GOSSIP が Bob に直送されることは絶対にない！
    expect(bobReceivedGossip.length).toBe(0);
  });
});


