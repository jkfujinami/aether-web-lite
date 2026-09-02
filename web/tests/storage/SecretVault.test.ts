import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { SecretVault, VAULT_PARAMS_FAST } from '@/lib/storage/SecretVault';
import { Identity } from '@/lib/crypto/Identity';
import { NodeIdentityStore } from '@/lib/crypto/NodeIdentityStore';
import { NodeIdentity, NODE_ID_POW_FAST } from '@/lib/crypto/NodeIdentity';

const P = VAULT_PARAMS_FAST;

/** SealedStore のメモリ実装 */
class MemStore {
  public records = new Map<string, { sealed: any; meta?: any }>();
  async getSealed(slot: string) { return this.records.get(slot); }
  async saveSealed(slot: string, sealed: any, meta?: any) { this.records.set(slot, { sealed, meta }); }
  async deleteSealed(slot: string) { this.records.delete(slot); }
}

beforeAll(async () => {
  await sodium.ready;
});

describe('SecretVault', () => {
  it('封印して復元できる', () => {
    const secret = sodium.randombytes_buf(64);
    const sealed = SecretVault.seal(secret, 'correct horse', P);
    expect(SecretVault.open(sealed, 'correct horse')).toEqual(secret);
  });

  it('★封印後のレコードに平文が残らない', () => {
    // 旧実装は Ed25519 秘密鍵を IndexedDB に生で書いていた。
    const secret = new Uint8Array(64).fill(0xab);
    const sealed = SecretVault.seal(secret, 'pw', P);

    const blob = JSON.stringify(sealed, (_k, v) =>
      v instanceof Uint8Array ? Array.from(v) : v);
    // 平文のバイト列 (0xab の並び) が生のまま現れないこと
    expect(blob).not.toContain(Array.from(secret).join(','));
    expect(sealed.ciphertext).not.toEqual(secret);
  });

  it('パスフレーズが違えば復元できない', () => {
    const secret = sodium.randombytes_buf(32);
    const sealed = SecretVault.seal(secret, 'right', P);
    expect(SecretVault.open(sealed, 'wrong')).toBeNull();
  });

  it('★改竄された封印を復元しない (AEAD)', () => {
    const secret = sodium.randombytes_buf(32);
    const sealed = SecretVault.seal(secret, 'pw', P);
    sealed.ciphertext[0] ^= 0xff;
    expect(SecretVault.open(sealed, 'pw')).toBeNull();
  });

  it('nonce を差し替えても復元できない', () => {
    const secret = sodium.randombytes_buf(32);
    const sealed = SecretVault.seal(secret, 'pw', P);
    sealed.nonce[0] ^= 0xff;
    expect(SecretVault.open(sealed, 'pw')).toBeNull();
  });

  it('salt を差し替えても復元できない', () => {
    const secret = sodium.randombytes_buf(32);
    const sealed = SecretVault.seal(secret, 'pw', P);
    sealed.salt[0] ^= 0xff;
    expect(SecretVault.open(sealed, 'pw')).toBeNull();
  });

  it('毎回異なる salt / nonce を使う (同じ秘密でも暗号文が変わる)', () => {
    const secret = new Uint8Array(32).fill(1);
    const a = SecretVault.seal(secret, 'pw', P);
    const b = SecretVault.seal(secret, 'pw', P);
    expect(a.salt).not.toEqual(b.salt);
    expect(a.nonce).not.toEqual(b.nonce);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it('パスフレーズ未設定は protected:false として記録される', () => {
    // 「保護されているつもりで保護されていない」を型と値で区別できるようにする
    const sealed = SecretVault.seal(new Uint8Array(32), '', P);
    expect(sealed.protected).toBe(false);
    expect(SecretVault.open(sealed, '')).toEqual(new Uint8Array(32));

    const guarded = SecretVault.seal(new Uint8Array(32), 'pw', P);
    expect(guarded.protected).toBe(true);
  });

  it('不明なバージョンの封印を開かない', () => {
    const sealed = SecretVault.seal(new Uint8Array(32), 'pw', P);
    expect(SecretVault.open({ ...sealed, v: 2 as any }, 'pw')).toBeNull();
    expect(SecretVault.open(null as any, 'pw')).toBeNull();
  });
});

describe('Identity のトリップ鍵', () => {
  it('封印して保存し、同じパスフレーズで復元できる', async () => {
    const store = new MemStore();
    const a = new Identity();
    const display = await a.generateTrip(store, 'pw', P);
    expect(display).toMatch(/^◆/);

    const b = new Identity();
    expect(await b.initTrip(store, 'pw')).toBe(true);
    expect(b.tripDisplay).toBe(display);
    expect(b.hasTrip).toBe(true);
  });

  it('★保存されたレコードに秘密鍵が平文で入っていない', async () => {
    const store = new MemStore();
    const a = new Identity();
    await a.generateTrip(store, 'pw', P);

    const record = store.records.get('trip')!;
    expect(record.sealed.protected).toBe(true);
    // 生の鍵素材を持つフィールドが存在しない
    expect(record.sealed).not.toHaveProperty('privateKey');
    expect(record.sealed).not.toHaveProperty('publicKey');
  });

  it('パスフレーズが違えば復元されず、名無しのまま継続する', async () => {
    const store = new MemStore();
    await new Identity().generateTrip(store, 'right', P);

    const b = new Identity();
    expect(await b.initTrip(store, 'wrong')).toBe(false);
    expect(b.hasTrip).toBe(false);
    expect(b.tripDisplay).toBe('');
  });

  it('トリップが無ければ false を返すだけで壊れない', async () => {
    const store = new MemStore();
    const a = new Identity();
    expect(await a.initTrip(store, '')).toBe(false);
    expect(a.hasTrip).toBe(false);
  });

  it('削除できる', async () => {
    const store = new MemStore();
    const a = new Identity();
    await a.generateTrip(store, '', P);
    await a.deleteTrip(store);
    expect(store.records.has('trip')).toBe(false);
    expect(a.hasTrip).toBe(false);
  });

  it('復元したトリップで署名すると同じ公開鍵になる', async () => {
    const store = new MemStore();
    const a = new Identity();
    await a.generateTrip(store, 'pw', P);
    const sigA = a.sign(new TextEncoder().encode('msg'));

    const b = new Identity();
    await b.initTrip(store, 'pw');
    const sigB = b.sign(new TextEncoder().encode('msg'));

    expect(sigB.tripPubkey).toEqual(sigA.tripPubkey);
    expect(
      sodium.crypto_sign_verify_detached(sigB.tripSignature!, new TextEncoder().encode('msg'), sigA.tripPubkey!),
    ).toBe(true);
  });
});

describe('NodeIdentityStore', () => {
  it('初回は採掘し、次回は復元する (同じ peerId になる)', async () => {
    const store = new MemStore();
    const first = await NodeIdentityStore.loadOrMine(store, 'pw', NODE_ID_POW_FAST, P);
    const second = await NodeIdentityStore.loadOrMine(store, 'pw', NODE_ID_POW_FAST, P);

    expect(second.peerId).toBe(first.peerId);
    expect(second.position).toBe(first.position);
    expect(second.powCounter).toBe(first.powCounter);
  });

  it('★保存レコードに秘密鍵が平文で入っていない', async () => {
    const store = new MemStore();
    const identity = await NodeIdentityStore.loadOrMine(store, 'pw', NODE_ID_POW_FAST, P);
    const record = store.records.get('node')!;

    // meta には公開情報だけ
    expect(record.meta).toEqual({ powCounter: identity.powCounter, peerId: identity.peerId });
    expect(record.sealed.protected).toBe(true);

    const secretKeyBytes = Array.from(identity.exportSecret().privkey).join(',');
    const blob = JSON.stringify(record, (_k, v) => (v instanceof Uint8Array ? Array.from(v) : v));
    expect(blob).not.toContain(secretKeyBytes);
  });

  it('復元した identity は claim の検証を通る', async () => {
    const store = new MemStore();
    await NodeIdentityStore.loadOrMine(store, '', NODE_ID_POW_FAST, P);
    const restored = await NodeIdentityStore.loadOrMine(store, '', NODE_ID_POW_FAST, P);
    expect(NodeIdentity.verifyClaim(restored.claim(), NODE_ID_POW_FAST)).toBe(true);
  });

  it('難易度を引き上げたら採掘し直す', async () => {
    const store = new MemStore();
    const easy = { difficulty: 1, opsLimit: 1, memLimit: 8192 };
    const first = await NodeIdentityStore.loadOrMine(store, '', easy, P);

    const harder = { difficulty: 8, opsLimit: 1, memLimit: 8192 };
    const second = await NodeIdentityStore.loadOrMine(store, '', harder, P);

    expect(NodeIdentity.verifyClaim(second.claim(), harder)).toBe(true);
    // 元の identity が新基準を満たしていなければ別物になっているはず
    if (!NodeIdentity.verifyClaim(first.claim(), harder)) {
      expect(second.peerId).not.toBe(first.peerId);
    }
  });

  it('パスフレーズが違えば復元せず採掘し直す', async () => {
    const store = new MemStore();
    const first = await NodeIdentityStore.loadOrMine(store, 'right', NODE_ID_POW_FAST, P);
    const second = await NodeIdentityStore.loadOrMine(store, 'wrong', NODE_ID_POW_FAST, P);
    expect(second.peerId).not.toBe(first.peerId);
  });
});
