import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { Identity } from '../../src/crypto/Identity';
import { SecretVault, VAULT_PARAMS_FAST } from '../../src/storage/SecretVault';
import { memorySealedStore, captureLogSink, containsBytes } from '../helpers/cryptoStorageFixtures';

const PASS = 'trip passphrase';
const data = new TextEncoder().encode('post body to sign');

let log: ReturnType<typeof captureLogSink>;

beforeAll(async () => {
  await sodiumReady;
});
beforeEach(() => {
  log = captureLogSink();
});
afterEach(() => {
  log.restore();
});

describe('Identity: セッション鍵 (タブごとの一時 ID)', () => {
  it('トリップ無しでは sign の trip 部は null で、セッション署名は検証できる', () => {
    const id = new Identity();
    expect(id.hasTrip).toBe(false);
    expect(id.tripDisplay).toBe('');
    const sig = id.sign(data);
    expect(sig.tripPubkey).toBeNull();
    expect(sig.tripSignature).toBeNull();
    expect(sig.sessionPubkey).toHaveLength(32);
    expect(Identity.verify(data, sig.sessionPubkey, sig.sessionSignature)).toBe(true);
  });

  it('インスタンスごとにセッション鍵が異なる', () => {
    const a = new Identity().sign(data);
    const b = new Identity().sign(data);
    expect(Array.from(a.sessionPubkey)).not.toEqual(Array.from(b.sessionPubkey));
  });

  it('sessionDisplay は SHA-512(pubkey) 先頭 4 バイトの Base64 (8 文字) で安定', () => {
    const id = new Identity();
    const pk = id.sign(data).sessionPubkey;
    const want = Buffer.from(sodium.crypto_hash(pk).slice(0, 4)).toString('base64');
    expect(id.sessionDisplay).toBe(want);
    expect(id.sessionDisplay).toHaveLength(8);
    expect(id.sessionDisplay).toBe(id.sessionDisplay);
  });

  it('Identity.verify は改竄されたデータ・別の公開鍵・改竄された署名を拒否する', () => {
    const id = new Identity();
    const other = new Identity();
    const sig = id.sign(data);
    const tampered = Uint8Array.from(data); tampered[0] ^= 1;
    expect(Identity.verify(tampered, sig.sessionPubkey, sig.sessionSignature)).toBe(false);
    expect(Identity.verify(data, other.sign(data).sessionPubkey, sig.sessionSignature)).toBe(false);
    const badSig = Uint8Array.from(sig.sessionSignature); badSig[10] ^= 1;
    expect(Identity.verify(data, sig.sessionPubkey, badSig)).toBe(false);
  });
});

describe('Identity: トリップの生成と封印', () => {
  it('generateTrip は "◆" + Base64 のトリップを返し、署名にトリップが付く', async () => {
    const store = memorySealedStore();
    const id = new Identity();
    const display = await id.generateTrip(store, PASS, VAULT_PARAMS_FAST);
    expect(display).toBe(id.tripDisplay);
    expect(display.startsWith('◆')).toBe(true);
    expect(id.hasTrip).toBe(true);

    const sig = id.sign(data);
    expect(sig.tripPubkey).toHaveLength(32);
    expect(Identity.verify(data, sig.tripPubkey!, sig.tripSignature!)).toBe(true);
    // セッション鍵とトリップ鍵は別物
    expect(Array.from(sig.tripPubkey!)).not.toEqual(Array.from(sig.sessionPubkey));
    expect(Identity.verify(data, sig.sessionPubkey, sig.tripSignature!)).toBe(false);

    const want = '◆' + Buffer.from(sodium.crypto_hash(sig.tripPubkey!).slice(0, 5)).toString('base64');
    expect(display).toBe(want);
  });

  it('保存されるのは封印 (protected) だけで、秘密鍵・公開鍵は平文で現れない', async () => {
    const store = memorySealedStore();
    const id = new Identity();
    await id.generateTrip(store, PASS, VAULT_PARAMS_FAST);
    const rec = store.slots.get('trip')!;
    expect(rec.sealed.protected).toBe(true);
    const kp = (id as any).tripKeyPair;
    expect(containsBytes(rec.sealed.ciphertext, kp.privateKey.subarray(0, 32))).toBe(false);
    expect(containsBytes(rec.sealed.ciphertext, kp.publicKey)).toBe(false);
    expect(JSON.stringify(rec, (_k, v) => (v instanceof Uint8Array ? Array.from(v) : v))).not.toContain(PASS);
  });

  it('generateTrip は文字列でない・空のパスフレーズを拒否し、既存のトリップも変えない', async () => {
    const store = memorySealedStore();
    const id = new Identity();
    const before = await id.generateTrip(store, PASS, VAULT_PARAMS_FAST);
    const sealedBefore = store.slots.get('trip');
    for (const p of ['', undefined, null, 1]) {
      await expect(id.generateTrip(store, p as any, VAULT_PARAMS_FAST)).rejects.toThrow(RangeError);
    }
    expect(id.tripDisplay).toBe(before);
    expect(store.slots.get('trip')).toBe(sealedBefore);
  });

  it('generateTrip を呼び直すと新しいトリップになる', async () => {
    const store = memorySealedStore();
    const id = new Identity();
    const a = await id.generateTrip(store, PASS, VAULT_PARAMS_FAST);
    const b = await id.generateTrip(store, PASS, VAULT_PARAMS_FAST);
    expect(a).not.toBe(b);
  });
});

describe('Identity.initTrip: 復元', () => {
  it('正しいパスフレーズなら別のインスタンスで同じトリップに戻り、同じ鍵で署名する', async () => {
    const store = memorySealedStore();
    const original = new Identity();
    const display = await original.generateTrip(store, PASS, VAULT_PARAMS_FAST);

    const restored = new Identity();
    expect(await restored.initTrip(store, PASS)).toBe(true);
    expect(restored.hasTrip).toBe(true);
    expect(restored.tripDisplay).toBe(display);
    const sig = restored.sign(data);
    expect(Array.from(sig.tripPubkey!)).toEqual(Array.from(original.sign(data).tripPubkey!));
    expect(Identity.verify(data, sig.tripPubkey!, sig.tripSignature!)).toBe(true);
  });

  it('違うパスフレーズ・既定の空パスフレーズでは開けず、名無しのまま', async () => {
    const store = memorySealedStore();
    await new Identity().generateTrip(store, PASS, VAULT_PARAMS_FAST);
    for (const p of ['Bad-Pass-Marker-9', PASS + ' ', '']) {
      const id = new Identity();
      expect(await id.initTrip(store, p)).toBe(false);
      expect(id.hasTrip).toBe(false);
      expect(id.sign(data).tripSignature).toBeNull();
    }
    const id = new Identity();
    expect(await id.initTrip(store)).toBe(false);
    // 警告にパスフレーズを含めない
    expect(log.text()).not.toContain('Bad-Pass-Marker-9');
    expect(log.text()).not.toContain(PASS);
  });

  it('封印の改竄 (暗号文・nonce・salt・ops/mem・version) は開けない', async () => {
    const store = memorySealedStore();
    await new Identity().generateTrip(store, PASS, VAULT_PARAMS_FAST);
    const good = store.slots.get('trip')!.sealed;
    const flip = (u: Uint8Array) => { const c = Uint8Array.from(u); c[0] ^= 1; return c; };
    const tampered = [
      { ...good, ciphertext: flip(good.ciphertext) },
      { ...good, nonce: flip(good.nonce) },
      { ...good, salt: flip(good.salt) },
      { ...good, opsLimit: good.opsLimit + 1 },
      { ...good, memLimit: good.memLimit * 2 },
      { ...good, v: 2 },
    ];
    for (const sealed of tampered) {
      store.slots.set('trip', { sealed });
      const id = new Identity();
      expect(await id.initTrip(store, PASS)).toBe(false);
      expect(id.hasTrip).toBe(false);
    }
  });

  it('記録が無ければ false', async () => {
    expect(await new Identity().initTrip(memorySealedStore(), PASS)).toBe(false);
  });

  it('保護なしで封印された旧データは開けるが、保護されていない旨を警告する', async () => {
    const store = memorySealedStore();
    const kp = sodium.crypto_sign_keypair();
    await store.saveSealed('trip', SecretVault.seal(new Uint8Array([...kp.privateKey, ...kp.publicKey]), '', VAULT_PARAMS_FAST));
    const id = new Identity();
    expect(await id.initTrip(store)).toBe(true);
    expect(Array.from(id.sign(data).tripPubkey!)).toEqual(Array.from(kp.publicKey));
    expect(log.lines.some((l) => l.method === 'warn' && /NOT passphrase-protected/.test(String(l.args[1])))).toBe(true);
  });

  it('保護つきで復元した場合は「保護されていない」警告を出さない', async () => {
    const store = memorySealedStore();
    await new Identity().generateTrip(store, PASS, VAULT_PARAMS_FAST);
    await new Identity().initTrip(store, PASS);
    expect(log.text()).not.toMatch(/NOT passphrase-protected/);
  });
});

describe('Identity.resealTrip / deleteTrip', () => {
  it('resealTrip で新しいパスフレーズに移すと、旧パスフレーズでは開けなくなる', async () => {
    const store = memorySealedStore();
    const id = new Identity();
    const display = await id.generateTrip(store, PASS, VAULT_PARAMS_FAST);
    await id.resealTrip(store, 'new pass', VAULT_PARAMS_FAST);
    expect(store.slots.get('trip')!.sealed.protected).toBe(true);
    expect(await new Identity().initTrip(store, PASS)).toBe(false);
    const again = new Identity();
    expect(await again.initTrip(store, 'new pass')).toBe(true);
    expect(again.tripDisplay).toBe(display);
  });

  it('保護なしの旧データを resealTrip で保護つきに移行できる', async () => {
    const store = memorySealedStore();
    const kp = sodium.crypto_sign_keypair();
    await store.saveSealed('trip', SecretVault.seal(new Uint8Array([...kp.privateKey, ...kp.publicKey]), '', VAULT_PARAMS_FAST));
    const id = new Identity();
    await id.initTrip(store);
    await id.resealTrip(store, PASS, VAULT_PARAMS_FAST);
    expect(store.slots.get('trip')!.sealed.protected).toBe(true);
    expect(await new Identity().initTrip(store, '')).toBe(false);
    expect(await new Identity().initTrip(store, PASS)).toBe(true);
  });

  it('トリップが無いとき・空のパスフレーズでは resealTrip しない', async () => {
    const store = memorySealedStore();
    await expect(new Identity().resealTrip(store, PASS, VAULT_PARAMS_FAST)).rejects.toThrow(/no trip/);
    const id = new Identity();
    await id.generateTrip(store, PASS, VAULT_PARAMS_FAST);
    const before = store.slots.get('trip');
    await expect(id.resealTrip(store, '', VAULT_PARAMS_FAST)).rejects.toThrow(RangeError);
    expect(store.slots.get('trip')).toBe(before);
  });

  it('deleteTrip はメモリと保存先の両方から消す', async () => {
    const store = memorySealedStore();
    const id = new Identity();
    await id.generateTrip(store, PASS, VAULT_PARAMS_FAST);
    await id.deleteTrip(store);
    expect(id.hasTrip).toBe(false);
    expect(id.tripDisplay).toBe('');
    expect(id.sign(data).tripPubkey).toBeNull();
    expect(store.slots.has('trip')).toBe(false);
    expect(await new Identity().initTrip(store, PASS)).toBe(false);
  });
});
