import { describe, it, expect, beforeAll } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { MagicFilter } from '../../src/crypto/MagicFilter';
import { CryptoEngine } from '../../src/crypto/CryptoEngine';

const KEY = new Uint8Array(32).fill(0x21);
const OTHER = new Uint8Array(32).fill(0x22);
const NONCE = Uint8Array.from({ length: 12 }, (_, i) => i * 7);
const enc = (key: Uint8Array, text: string, nonce = NONCE) =>
  sodium.crypto_aead_chacha20poly1305_ietf_encrypt(new TextEncoder().encode(text), null, null, nonce, key);

beforeAll(async () => {
  await sodiumReady;
});

describe('MagicFilter.quickCheck (Broadcast Veil の事前選別)', () => {
  it('CryptoEngine が作った暗号文は正しい鍵なら必ず通す (取りこぼしゼロ)', () => {
    for (let i = 0; i < 200; i++) {
      const e = CryptoEngine.encrypt(KEY, new TextEncoder().encode(`post ${i}`));
      expect(MagicFilter.quickCheck(KEY, e.ciphertext, e.nonce)).toBe(true);
    }
  });

  it('AEAD のキーストリーム (counter=1 から) と一致する', () => {
    const ct = enc(KEY, 'AETHpayload');
    expect(MagicFilter.quickCheck(KEY, ct, NONCE)).toBe(true);
  });

  it('別のスレッド鍵の暗号文は弾く (固定入力なので決定的)', () => {
    const ct = enc(KEY, 'AETHpayload');
    expect(MagicFilter.quickCheck(OTHER, ct, NONCE)).toBe(false);
  });

  it('マジックの無い平文の暗号文は弾く', () => {
    expect(MagicFilter.quickCheck(KEY, enc(KEY, 'AETXpayload'), NONCE)).toBe(false);
    expect(MagicFilter.quickCheck(KEY, enc(KEY, 'hello world'), NONCE)).toBe(false);
  });

  it('nonce が違えば弾く', () => {
    const ct = enc(KEY, 'AETHpayload');
    const n = Uint8Array.from(NONCE); n[0] ^= 1;
    expect(MagicFilter.quickCheck(KEY, ct, n)).toBe(false);
  });

  it('先頭 4 バイトのいずれかを改竄すると弾く', () => {
    const ct = enc(KEY, 'AETHpayload');
    for (let i = 0; i < 4; i++) {
      const t = Uint8Array.from(ct); t[i] ^= 0x01;
      expect(MagicFilter.quickCheck(KEY, t, NONCE)).toBe(false);
    }
  });

  it('4 バイト未満の暗号文は弾く', () => {
    expect(MagicFilter.quickCheck(KEY, new Uint8Array(0), NONCE)).toBe(false);
    expect(MagicFilter.quickCheck(KEY, new Uint8Array(3), NONCE)).toBe(false);
  });

  it('キーストリームを作れない入力 (鍵長・nonce 長の不正) は fail-open で true (最終判定は AEAD に任せる)', () => {
    const ct = enc(KEY, 'AETHpayload');
    expect(MagicFilter.quickCheck(new Uint8Array(16), ct, NONCE)).toBe(true);
    expect(MagicFilter.quickCheck(KEY, ct, new Uint8Array(8))).toBe(true);
    // fail-open しても AEAD 側で必ず拒否される
    expect(CryptoEngine.decrypt(new Uint8Array(16), { ciphertext: ct, nonce: NONCE })).toBeNull();
    expect(CryptoEngine.decrypt(KEY, { ciphertext: ct, nonce: new Uint8Array(8) })).toBeNull();
  });
});
