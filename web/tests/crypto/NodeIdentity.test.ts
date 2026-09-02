import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import {
  NodeIdentity,
  NODE_ID_POW_FAST,
  PEER_ID_BYTES,
  type NodeIdPowParams,
} from '@/lib/crypto/NodeIdentity';
import { RingPosition } from '@/lib/network/RingPosition';

const PARAMS: NodeIdPowParams = NODE_ID_POW_FAST;

let alice: NodeIdentity;
let bob: NodeIdentity;

beforeAll(async () => {
  await sodium.ready;
  alice = await NodeIdentity.mine(PARAMS);
  bob = await NodeIdentity.mine(PARAMS);
});

describe('derivePeerId', () => {
  it('公開鍵から決定的に導出される', () => {
    expect(NodeIdentity.derivePeerId(alice.pubkey)).toBe(alice.peerId);
  });

  it('hex 32 文字 (16 バイト)', () => {
    expect(alice.peerId).toMatch(/^[0-9a-f]{32}$/);
    expect(alice.peerId.length).toBe(PEER_ID_BYTES * 2);
  });

  it('鍵が違えば peerId も違う', () => {
    expect(alice.peerId).not.toBe(bob.peerId);
  });
});

describe('derivePosition', () => {
  it('peerId から決定的に導出される', () => {
    expect(NodeIdentity.derivePosition(alice.peerId)).toBe(alice.position);
  });

  it('[0, 1) に収まる', () => {
    for (let i = 0; i < 200; i++) {
      const fakeId = sodium.to_hex(sodium.randombytes_buf(PEER_ID_BYTES));
      const pos = NodeIdentity.derivePosition(fakeId);
      expect(pos).toBeGreaterThanOrEqual(0);
      expect(pos).toBeLessThan(1);
    }
  });

  it('リング上に概ね一様に散る', () => {
    // 10 区間のヒストグラムを取り、極端な偏りがないことを確認する。
    const buckets = new Array(10).fill(0);
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const fakeId = sodium.to_hex(sodium.randombytes_buf(PEER_ID_BYTES));
      buckets[Math.floor(NodeIdentity.derivePosition(fakeId) * 10)]++;
    }
    const expected = n / 10;
    for (const [i, count] of buckets.entries()) {
      expect(count, `bucket ${i} = ${count}`).toBeGreaterThan(expected * 0.6);
      expect(count, `bucket ${i} = ${count}`).toBeLessThan(expected * 1.4);
    }
  });
});

describe('RingPosition の Bound Identity 化', () => {
  it('RingPosition.forPeer が NodeIdentity.derivePosition と一致する', () => {
    // ネットワーク層は RingPosition 経由で座標を得るため、両者がずれると
    // 「自分が計算した相手の位置」と「相手が名乗る位置」が食い違う。
    expect(RingPosition.forPeer(alice.peerId)).toBe(alice.position);
    expect(RingPosition.forPeer(bob.peerId)).toBe(bob.position);
  });

  it('距離計算は円環の最短距離を返す', () => {
    expect(RingPosition.distance(0.1, 0.2)).toBeCloseTo(0.1, 12);
    expect(RingPosition.distance(0.95, 0.05)).toBeCloseTo(0.1, 12);
    expect(RingPosition.distance(0.0, 0.5)).toBeCloseTo(0.5, 12);
  });
});

describe('verifyClaim', () => {
  it('正当な主張を受理する', () => {
    expect(NodeIdentity.verifyClaim(alice.claim(), PARAMS)).toBe(true);
  });

  it('★攻撃: 他人の peerId を名乗る (peerId と pubkey の不一致) を拒否する', () => {
    const forged = { ...alice.claim(), peerId: bob.peerId };
    expect(NodeIdentity.verifyClaim(forged, PARAMS)).toBe(false);
  });

  it('★攻撃: 狙った座標の peerId を自作しても pubkey と結び付かず拒否される', () => {
    // 旧実装では peerId = randomBytes(16) だったので、攻撃者は
    // 標的 topicHash の真隣に来る peerId をそのまま名乗れた。
    const target = 'ff'.repeat(PEER_ID_BYTES);
    const forged = { ...alice.claim(), peerId: target };
    expect(NodeIdentity.verifyClaim(forged, PARAMS)).toBe(false);
  });

  it('★攻撃: NodeId PoW を満たさない鍵ペアを拒否する', () => {
    const kp = sodium.crypto_sign_keypair();
    const peerId = NodeIdentity.derivePeerId(kp.publicKey);
    // PoW を解かずに counter=0 で名乗る
    const claim = { peerId, pubkey: kp.publicKey, powCounter: 0 };
    // difficulty=4 なら 1/16 の確率で偶然通ってしまうので、通らない鍵を探す
    let found = claim;
    for (let i = 0; i < 200; i++) {
      const k = sodium.crypto_sign_keypair();
      const c = { peerId: NodeIdentity.derivePeerId(k.publicKey), pubkey: k.publicKey, powCounter: 0 };
      if (!NodeIdentity.verifyClaim(c, PARAMS)) { found = c; break; }
    }
    expect(NodeIdentity.verifyClaim(found, PARAMS)).toBe(false);
  });

  it('形式不正な主張を拒否する', () => {
    const base = alice.claim();
    expect(NodeIdentity.verifyClaim({ ...base, peerId: 'short' }, PARAMS)).toBe(false);
    expect(NodeIdentity.verifyClaim({ ...base, peerId: 'ZZ'.repeat(16) }, PARAMS)).toBe(false);
    expect(NodeIdentity.verifyClaim({ ...base, pubkey: new Uint8Array(31) }, PARAMS)).toBe(false);
    expect(NodeIdentity.verifyClaim({ ...base, powCounter: -1 }, PARAMS)).toBe(false);
    expect(NodeIdentity.verifyClaim({ ...base, powCounter: 1.5 }, PARAMS)).toBe(false);
    expect(NodeIdentity.verifyClaim(null as any, PARAMS)).toBe(false);
    expect(NodeIdentity.verifyClaim({ ...base, pubkey: 'nope' as any }, PARAMS)).toBe(false);
  });
});

describe('verifySignedClaim (所有証明)', () => {
  it('自分が出したチャレンジに対する署名を受理する', () => {
    const challenge = NodeIdentity.newChallenge();
    const signed = alice.signClaim(challenge);
    expect(NodeIdentity.verifySignedClaim(signed, challenge, PARAMS)).toBe(true);
  });

  it('★攻撃: 傍受した JOIN の再生 (replay) を拒否する', () => {
    // 攻撃者が alice の JOIN を丸ごと傍受し、別の接続でそのまま流す。
    // 検証側のチャレンジが毎回違うので通らない。
    const challengeA = NodeIdentity.newChallenge();
    const captured = alice.signClaim(challengeA);

    const challengeB = NodeIdentity.newChallenge();
    expect(NodeIdentity.verifySignedClaim(captured, challengeB, PARAMS)).toBe(false);
  });

  it('★攻撃: 他人の pubkey を貼り付けただけの主張を拒否する (秘密鍵を持っていない)', () => {
    const challenge = NodeIdentity.newChallenge();
    const mine = bob.signClaim(challenge);
    // bob の署名に alice の identity を被せる
    const forged = { ...mine, peerId: alice.peerId, pubkey: alice.pubkey };
    expect(NodeIdentity.verifySignedClaim(forged, challenge, PARAMS)).toBe(false);
  });

  it('署名を1バイト書き換えると拒否される', () => {
    const challenge = NodeIdentity.newChallenge();
    const signed = alice.signClaim(challenge);
    const tampered = { ...signed, signature: Uint8Array.from(signed.signature) };
    tampered.signature[0] ^= 0xff;
    expect(NodeIdentity.verifySignedClaim(tampered, challenge, PARAMS)).toBe(false);
  });

  it('challenge を書き換えると拒否される', () => {
    const challenge = NodeIdentity.newChallenge();
    const signed = alice.signClaim(challenge);
    const tampered = { ...signed, challenge: Uint8Array.from(signed.challenge) };
    tampered.challenge[0] ^= 0xff;
    expect(NodeIdentity.verifySignedClaim(tampered, challenge, PARAMS)).toBe(false);
  });

  it('challenge の長さが違う場合も安全に false を返す', () => {
    const challenge = NodeIdentity.newChallenge();
    const signed = alice.signClaim(challenge);
    expect(NodeIdentity.verifySignedClaim(signed, new Uint8Array(8), PARAMS)).toBe(false);
  });

  it('署名やチャレンジが欠落していても例外を投げない', () => {
    const challenge = NodeIdentity.newChallenge();
    const base = alice.signClaim(challenge);
    expect(NodeIdentity.verifySignedClaim({ ...base, signature: undefined as any }, challenge, PARAMS)).toBe(false);
    expect(NodeIdentity.verifySignedClaim({ ...base, challenge: undefined as any }, challenge, PARAMS)).toBe(false);
  });
});

describe('mine / fromKeyPair', () => {
  it('採掘した identity は自分の主張を検証できる', () => {
    expect(NodeIdentity.verifyClaim(alice.claim(), PARAMS)).toBe(true);
  });

  it('鍵ペアから復元しても同じ peerId / position になる', () => {
    const secret = alice.exportSecret();
    const restored = NodeIdentity.fromKeyPair(secret.pubkey, secret.privkey, secret.powCounter);
    expect(restored.peerId).toBe(alice.peerId);
    expect(restored.position).toBe(alice.position);
    expect(NodeIdentity.verifyClaim(restored.claim(), PARAMS)).toBe(true);
  });

  it('復元した identity で署名した主張が検証を通る', () => {
    const secret = alice.exportSecret();
    const restored = NodeIdentity.fromKeyPair(secret.pubkey, secret.privkey, secret.powCounter);
    const challenge = NodeIdentity.newChallenge();
    expect(NodeIdentity.verifySignedClaim(restored.signClaim(challenge), challenge, PARAMS)).toBe(true);
  });

  it('difficulty=0 なら PoW 探索をスキップする', () => {
    const kp = sodium.crypto_sign_keypair();
    expect(NodeIdentity.solveNodeIdPow(kp.publicKey, { ...PARAMS, difficulty: 0 })).toBe(0);
  });
});
