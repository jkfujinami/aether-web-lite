import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { NodeIdentityStore } from '../../src/crypto/NodeIdentityStore';
import { NodeIdentity, type NodeIdPowParams } from '../../src/crypto/NodeIdentity';
import { meetsDifficulty } from '../../src/crypto/PowPolicy';
import { SecretVault, VAULT_PARAMS_FAST } from '../../src/storage/SecretVault';
import { WrongPassphraseError } from '../../src/storage/DataVault';
import { memorySealedStore, captureLogSink, containsBytes } from '../helpers/cryptoStorageFixtures';

const FREE: NodeIdPowParams = { difficulty: 0, opsLimit: 1, memLimit: 8192 };
const P4: NodeIdPowParams = { difficulty: 4, opsLimit: 1, memLimit: 8192 };
const PASS = 'node passphrase';

beforeAll(async () => {
  await sodiumReady;
});

let log: ReturnType<typeof captureLogSink>;
beforeEach(() => {
  log = captureLogSink();
});
afterEach(() => {
  log.restore();
});

/** 鍵ペアを "privkey ‖ pubkey" の形で封印して保存する (NodeIdentityStore の保存形式) */
async function storeKeypair(store: ReturnType<typeof memorySealedStore>, seed: number, powCounter: unknown, pass = PASS) {
  const kp = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(seed));
  const blob = new Uint8Array(96);
  blob.set(kp.privateKey, 0);
  blob.set(kp.publicKey, 64);
  await store.saveSealed('node', SecretVault.seal(blob, pass, VAULT_PARAMS_FAST), { powCounter });
  return kp;
}

describe('NodeIdentityStore.loadOrMine: 保存形式', () => {
  it('秘密鍵は封印されて保存され、平文では現れない。meta には公開情報だけを置く', async () => {
    const store = memorySealedStore();
    const id = await NodeIdentityStore.loadOrMine(store, PASS, FREE, VAULT_PARAMS_FAST);
    const rec = store.slots.get('node')!;
    expect(rec.sealed.protected).toBe(true);
    expect(rec.sealed.v).toBe(1);
    const { privkey, pubkey } = id.exportSecret();
    expect(containsBytes(rec.sealed.ciphertext, privkey.subarray(0, 32))).toBe(false);
    expect(containsBytes(rec.sealed.ciphertext, pubkey)).toBe(false);
    expect(rec.meta).toEqual({ powCounter: id.powCounter, peerId: id.peerId });
    // 封印の中身は privkey ‖ pubkey
    const opened = SecretVault.open(rec.sealed, PASS)!;
    expect(Array.from(opened)).toEqual([...privkey, ...pubkey]);
  });

  it('復元した identity は同じ秘密鍵で署名できる', async () => {
    const store = memorySealedStore();
    const first = await NodeIdentityStore.loadOrMine(store, PASS, FREE, VAULT_PARAMS_FAST);
    const again = await NodeIdentityStore.loadOrMine(store, PASS, FREE, VAULT_PARAMS_FAST);
    expect(again.peerId).toBe(first.peerId);
    expect(again.position).toBe(first.position);
    const c = NodeIdentity.newChallenge();
    const b = { verifierId: 'x', signerFingerprint: 'a', verifierFingerprint: 'b' };
    expect(NodeIdentity.verifySignedClaim(again.signClaim(c, b), c, b, FREE)).toBe(true);
  });

  it('PoW 付きの identity も保存・復元できる', async () => {
    const store = memorySealedStore();
    const first = await NodeIdentityStore.loadOrMine(store, PASS, P4, VAULT_PARAMS_FAST);
    expect(NodeIdentity.verifyClaim(first.claim(), P4)).toBe(true);
    const again = await NodeIdentityStore.loadOrMine(store, PASS, P4, VAULT_PARAMS_FAST);
    expect(again.peerId).toBe(first.peerId);
    expect(again.powCounter).toBe(first.powCounter);
  });

  it('パスフレーズが文字列でない・空なら拒否し、何も保存しない', async () => {
    const store = memorySealedStore();
    for (const p of ['', undefined, null, 123]) {
      await expect(NodeIdentityStore.loadOrMine(store, p as any, FREE, VAULT_PARAMS_FAST)).rejects.toThrow(RangeError);
    }
    expect(store.slots.size).toBe(0);
  });
});

describe('NodeIdentityStore.loadOrMine: 復元できない場合', () => {
  it('違うパスフレーズでは開けず、保存済みの identity を上書きしない (打ち間違いで鍵を失わない)', async () => {
    const store = memorySealedStore();
    const first = await NodeIdentityStore.loadOrMine(store, PASS, FREE, VAULT_PARAMS_FAST);
    const before = store.slots.get('node');
    await expect(NodeIdentityStore.loadOrMine(store, 'Bad-Pass-Marker-9', FREE, VAULT_PARAMS_FAST))
      .rejects.toBeInstanceOf(WrongPassphraseError);
    expect(store.slots.get('node')).toBe(before);
    const back = await NodeIdentityStore.loadOrMine(store, PASS, FREE, VAULT_PARAMS_FAST);
    expect(back.peerId).toBe(first.peerId);
    // 警告にパスフレーズは出さない
    expect(log.text()).not.toContain('Bad-Pass-Marker-9');
    expect(log.text()).not.toContain(PASS);
  });

  it('封印の中身の長さが違えば採掘し直す', async () => {
    const store = memorySealedStore();
    await store.saveSealed('node', SecretVault.seal(new Uint8Array(95), PASS, VAULT_PARAMS_FAST), { powCounter: 0 });
    const id = await NodeIdentityStore.loadOrMine(store, PASS, FREE, VAULT_PARAMS_FAST);
    expect(NodeIdentity.verifyClaim(id.claim(), FREE)).toBe(true);
    expect(SecretVault.open(store.slots.get('node')!.sealed, PASS)).toHaveLength(96);
  });

  it('meta の powCounter が不正なら採掘し直す', async () => {
    for (const bad of [undefined, -1, 1.5, '0', NaN]) {
      const store = memorySealedStore();
      const kp = await storeKeypair(store, 7, bad);
      const id = await NodeIdentityStore.loadOrMine(store, PASS, FREE, VAULT_PARAMS_FAST);
      expect(id.peerId).not.toBe(NodeIdentity.derivePeerId(kp.publicKey));
      expect(store.slots.get('node')!.meta.powCounter).toBe(id.powCounter);
    }
  });

  it('meta そのものが無くても例外を投げずに採掘し直す', async () => {
    const store = memorySealedStore();
    const kp = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(3));
    await store.saveSealed('node', SecretVault.seal(new Uint8Array([...kp.privateKey, ...kp.publicKey]), PASS, VAULT_PARAMS_FAST));
    const id = await NodeIdentityStore.loadOrMine(store, PASS, FREE, VAULT_PARAMS_FAST);
    expect(id.peerId).not.toBe(NodeIdentity.derivePeerId(kp.publicKey));
  });

  it('保存済みの解が現在の難易度を満たさなければ採掘し直し、新しい解を保存する', async () => {
    const store = memorySealedStore();
    const kp = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(9));
    let bad = 0;
    while (meetsDifficulty(NodeIdentity.nodeIdPowHash(kp.publicKey, bad, P4), 4)) bad++;
    await storeKeypair(store, 9, bad);

    // 旧ポリシー (難易度 0) なら復元できる
    const old = await NodeIdentityStore.loadOrMine(store, PASS, FREE, VAULT_PARAMS_FAST);
    expect(old.peerId).toBe(NodeIdentity.derivePeerId(kp.publicKey));

    // 新ポリシーでは捨てて採掘し直す
    const fresh = await NodeIdentityStore.loadOrMine(store, PASS, P4, VAULT_PARAMS_FAST);
    expect(fresh.peerId).not.toBe(old.peerId);
    expect(NodeIdentity.verifyClaim(fresh.claim(), P4)).toBe(true);
    const again = await NodeIdentityStore.loadOrMine(store, PASS, P4, VAULT_PARAMS_FAST);
    expect(again.peerId).toBe(fresh.peerId);
  });

  it('封印が改竄されていれば復元せず、上書きもしない', async () => {
    const store = memorySealedStore();
    await NodeIdentityStore.loadOrMine(store, PASS, FREE, VAULT_PARAMS_FAST);
    const rec = store.slots.get('node')!;
    rec.sealed.ciphertext[0] ^= 1;
    await expect(NodeIdentityStore.loadOrMine(store, PASS, FREE, VAULT_PARAMS_FAST))
      .rejects.toBeInstanceOf(WrongPassphraseError);
    expect(store.slots.get('node')).toBe(rec);
  });

  it('ストアの読み出しが失敗したら例外を伝え、採掘して上書きしない', async () => {
    const store = memorySealedStore({ failGet: true });
    await expect(NodeIdentityStore.loadOrMine(store, PASS, FREE, VAULT_PARAMS_FAST)).rejects.toThrow();
    expect(store.slots.has('node')).toBe(false);
  });

  it('保存に失敗したら例外を伝える (保存されたと誤認させない)', async () => {
    const store = memorySealedStore({ failSave: true });
    await expect(NodeIdentityStore.loadOrMine(store, PASS, FREE, VAULT_PARAMS_FAST)).rejects.toThrow('save failed');
  });
});

describe('NodeIdentityStore.mineEphemeral', () => {
  it('保存しない。ストアの読み出し・削除が失敗しても採掘して続行する', async () => {
    const a = memorySealedStore({ failGet: true });
    const id = await NodeIdentityStore.mineEphemeral(a, FREE);
    expect(NodeIdentity.verifyClaim(id.claim(), FREE)).toBe(true);
    expect(a.slots.size).toBe(0);

    const b = memorySealedStore({ failDelete: true });
    await b.saveSealed('node', SecretVault.seal(new Uint8Array(96), '', VAULT_PARAMS_FAST), { powCounter: 0 });
    await expect(NodeIdentityStore.mineEphemeral(b, FREE)).resolves.toBeInstanceOf(NodeIdentity);
  });

  it('protected フラグの無い (形の壊れた) 記録も保護なしとみなして消す', async () => {
    const store = memorySealedStore();
    await store.saveSealed('node', { garbage: true }, { powCounter: 0 });
    await NodeIdentityStore.mineEphemeral(store, FREE);
    expect(store.slots.has('node')).toBe(false);
  });

  it('保護なしの鍵を消したことを警告する', async () => {
    const store = memorySealedStore();
    await store.saveSealed('node', SecretVault.seal(new Uint8Array(96), '', VAULT_PARAMS_FAST), { powCounter: 0 });
    await NodeIdentityStore.mineEphemeral(store, FREE);
    expect(log.lines.some((l) => l.method === 'warn' && String(l.args[0]) === '[crypto.nodeid]')).toBe(true);
  });

  it('毎回の採掘結果は PoW を満たす', async () => {
    const id = await NodeIdentityStore.mineEphemeral(memorySealedStore(), P4);
    expect(NodeIdentity.verifyClaim(id.claim(), P4)).toBe(true);
  });
});
