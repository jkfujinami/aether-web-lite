import { describe, it, expect, beforeAll } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { OnionRouter, type OnionHop } from '../../src/crypto/OnionRouter';
import type { GossipPacket } from '../../src/types';

describe('OnionRouter (3-Hop Onion Stem 暗号化・多段復号)', () => {
  beforeAll(async () => {
    await sodiumReady;
  });

  function createMockNode(name: string) {
    const kp = sodium.crypto_sign_keypair();
    return {
      name,
      peerId: `${name.repeat(4)}0000000000000000000000000000`.substring(0, 32),
      pubkey: kp.publicKey,
      privkey: kp.privateKey,
    };
  }

  const dummyPacket: GossipPacket = {
    packet_id: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    zone_id: 1,
    timestamp: Date.now(),
    pow_difficulty: 8,
    pow_nonce: '0000000000000001',
    hop_count: 0,
    signature: 'fake-sig',
    payload: {
      type: 'post',
      content: 'Aether Onion Anonymous Message',
      author: 'vip',
    },
  };

  it('1ホップ (直接暗号化) のラップとアンラップが正しく動作する', () => {
    const exitNode = createMockNode('exit');
    const hops: OnionHop[] = [{ peerId: exitNode.peerId, pubkey: exitNode.pubkey }];

    const onion = OnionRouter.wrapStem(dummyPacket, hops);
    expect(onion.length).toBeGreaterThan(0);

    const unwrapped = OnionRouter.unwrap(onion, exitNode.pubkey, exitNode.privkey);
    expect(unwrapped).not.toBeNull();
    expect(unwrapped?.type).toBe('exit_fluff');
    if (unwrapped?.type === 'exit_fluff') {
      expect(unwrapped.packet.packet_id).toBe(dummyPacket.packet_id);
      expect((unwrapped.packet.payload as any).content).toBe('Aether Onion Anonymous Message');
    }
  });

  it('3ホップ (Guard -> Relay -> Exit) の多段オニオン暗号化が順次正しく剥ける', () => {
    const guardNode = createMockNode('guar');
    const relayNode = createMockNode('rela');
    const exitNode = createMockNode('exit');

    const hops: OnionHop[] = [
      { peerId: guardNode.peerId, pubkey: guardNode.pubkey },
      { peerId: relayNode.peerId, pubkey: relayNode.pubkey },
      { peerId: exitNode.peerId, pubkey: exitNode.pubkey },
    ];

    // 発信者が 3 ホップのオニオンを構築
    const outerOnion = OnionRouter.wrapStem(dummyPacket, hops);

    // ── 第 1 ホップ: GuardNode が復号 ──
    // GuardNode は中身の平文パケットを読めず、次が RelayNode であることだけを知る
    const hop1Result = OnionRouter.unwrap(outerOnion, guardNode.pubkey, guardNode.privkey);
    expect(hop1Result).not.toBeNull();
    expect(hop1Result?.type).toBe('relay');
    if (hop1Result?.type !== 'relay') return;
    expect(hop1Result.nextHop).toBe(relayNode.peerId);

    // GuardNode が ExitNode の鍵で復号しようとしても失敗する (読めない)
    const illegalUnwrap = OnionRouter.unwrap(outerOnion, exitNode.pubkey, exitNode.privkey);
    expect(illegalUnwrap).toBeNull();

    // ── 第 2 ホップ: RelayNode が復号 ──
    const hop2Result = OnionRouter.unwrap(hop1Result.innerOnion, relayNode.pubkey, relayNode.privkey);
    expect(hop2Result).not.toBeNull();
    expect(hop2Result?.type).toBe('relay');
    if (hop2Result?.type !== 'relay') return;
    expect(hop2Result.nextHop).toBe(exitNode.peerId);

    // ── 第 3 ホップ: ExitNode が復号 ──
    // 最終出口ノードがアンラップすると、平文の GossipPacket が現れ Fluff を開始できる
    const hop3Result = OnionRouter.unwrap(hop2Result.innerOnion, exitNode.pubkey, exitNode.privkey);
    expect(hop3Result).not.toBeNull();
    expect(hop3Result?.type).toBe('exit_fluff');
    if (hop3Result?.type !== 'exit_fluff') return;

    expect(hop3Result.zoneId).toBe(dummyPacket.zone_id);
    expect(hop3Result.packet.packet_id).toBe(dummyPacket.packet_id);
    expect((hop3Result.packet.payload as any).content).toBe('Aether Onion Anonymous Message');
  });

  it('不正な鍵や改ざんされたオニオンデータは安全に拒否 (null 返却) される', () => {
    const nodeA = createMockNode('node');
    const nodeB = createMockNode('badk');

    const hops: OnionHop[] = [{ peerId: nodeA.peerId, pubkey: nodeA.pubkey }];
    const onion = OnionRouter.wrapStem(dummyPacket, hops);

    // 異なる秘密鍵で復号を試みる
    const failResult = OnionRouter.unwrap(onion, nodeA.pubkey, nodeB.privkey);
    expect(failResult).toBeNull();

    // 壊れたバイナリ
    const corruptedOnion = new Uint8Array(onion);
    corruptedOnion[10] ^= 0xff;
    const corruptResult = OnionRouter.unwrap(corruptedOnion, nodeA.pubkey, nodeA.privkey);
    expect(corruptResult).toBeNull();
  });
});
