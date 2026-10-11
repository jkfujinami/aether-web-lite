import { describe, it, expect, beforeAll } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { CryptoEngine } from '../../src/crypto/CryptoEngine';
import { containsBytes } from '../helpers/cryptoStorageFixtures';

const KEY = new Uint8Array(32).fill(0x42);
const OTHER = new Uint8Array(32).fill(0x43);
const msg = (s: string) => new TextEncoder().encode(s);

beforeAll(async () => {
  await sodiumReady;
});

describe('CryptoEngine (スレッド鍵による AEAD)', () => {
  it('暗号化して同じ鍵で復号すると元に戻る (空のペイロードも)', () => {
    for (const p of [msg('hello world'), new Uint8Array(0), new Uint8Array(2048).fill(7)]) {
      const enc = CryptoEngine.encrypt(KEY, p);
      expect(Array.from(CryptoEngine.decrypt(KEY, enc)!)).toEqual(Array.from(p));
    }
  });

  it('暗号文の長さは マジック 4 + 本文 + タグ 16、nonce は 12 バイト', () => {
    const enc = CryptoEngine.encrypt(KEY, msg('abc'));
    expect(enc.nonce).toHaveLength(12);
    expect(enc.ciphertext).toHaveLength(4 + 3 + 16);
  });

  it('暗号文に平文 (マジックバイトも含め) がそのまま現れない', () => {
    const plain = msg('PLAINTEXT-MARKER-PLAINTEXT-MARKER');
    const enc = CryptoEngine.encrypt(KEY, plain);
    expect(containsBytes(enc.ciphertext, plain)).toBe(false);
    expect(containsBytes(enc.ciphertext.subarray(0, 4), msg('AETH'))).toBe(false);
  });

  it('同じ平文でも毎回 nonce と暗号文が変わる', () => {
    const a = CryptoEngine.encrypt(KEY, msg('same'));
    const b = CryptoEngine.encrypt(KEY, msg('same'));
    expect(Array.from(a.nonce)).not.toEqual(Array.from(b.nonce));
    expect(Array.from(a.ciphertext)).not.toEqual(Array.from(b.ciphertext));
  });

  it('別の鍵では復号できず null', () => {
    const enc = CryptoEngine.encrypt(KEY, msg('secret'));
    expect(CryptoEngine.decrypt(OTHER, enc)).toBeNull();
  });

  it('暗号文・タグ・nonce のどの 1 ビットを反転しても null', () => {
    const enc = CryptoEngine.encrypt(KEY, msg('integrity'));
    for (let i = 0; i < enc.ciphertext.length; i++) {
      const ct = Uint8Array.from(enc.ciphertext); ct[i] ^= 0x01;
      expect(CryptoEngine.decrypt(KEY, { ciphertext: ct, nonce: enc.nonce })).toBeNull();
    }
    for (let i = 0; i < enc.nonce.length; i++) {
      const n = Uint8Array.from(enc.nonce); n[i] ^= 0x80;
      expect(CryptoEngine.decrypt(KEY, { ciphertext: enc.ciphertext, nonce: n })).toBeNull();
    }
  });

  it('切り詰めた暗号文・空の暗号文は null', () => {
    const enc = CryptoEngine.encrypt(KEY, msg('truncate me'));
    expect(CryptoEngine.decrypt(KEY, { ciphertext: enc.ciphertext.subarray(0, enc.ciphertext.length - 1), nonce: enc.nonce })).toBeNull();
    expect(CryptoEngine.decrypt(KEY, { ciphertext: new Uint8Array(0), nonce: enc.nonce })).toBeNull();
  });

  it('正しく認証されてもマジックバイトが無い平文は拒否する', () => {
    const nonce = new Uint8Array(12).fill(1);
    const noMagic = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(msg('XXXXpayload'), null, null, nonce, KEY);
    expect(CryptoEngine.decrypt(KEY, { ciphertext: noMagic, nonce })).toBeNull();
    const tooShort = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(msg('AET'), null, null, nonce, KEY);
    expect(CryptoEngine.decrypt(KEY, { ciphertext: tooShort, nonce })).toBeNull();
    const magicOnly = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(msg('AETH'), null, null, nonce, KEY);
    expect(CryptoEngine.decrypt(KEY, { ciphertext: magicOnly, nonce })).toHaveLength(0);
  });

  it('不正な形の入力 (鍵長・nonce 長・型) でも例外を投げず null', () => {
    const enc = CryptoEngine.encrypt(KEY, msg('x'));
    expect(CryptoEngine.decrypt(new Uint8Array(16), enc)).toBeNull();
    expect(CryptoEngine.decrypt(KEY, { ciphertext: enc.ciphertext, nonce: new Uint8Array(8) })).toBeNull();
    expect(CryptoEngine.decrypt(KEY, { ciphertext: enc.ciphertext, nonce: new Uint8Array(24) })).toBeNull();
    expect(CryptoEngine.decrypt(KEY, { ciphertext: null as any, nonce: enc.nonce })).toBeNull();
    expect(CryptoEngine.decrypt(KEY, {} as any)).toBeNull();
  });

  it('不正な長さの鍵では暗号化しない (例外)', () => {
    expect(() => CryptoEngine.encrypt(new Uint8Array(31), msg('x'))).toThrow();
  });

  it('インスタンスメソッドは静的版と相互運用できる', () => {
    const engine = new CryptoEngine();
    const enc = engine.encrypt(KEY, msg('inst'));
    expect(new TextDecoder().decode(CryptoEngine.decrypt(KEY, enc)!)).toBe('inst');
    expect(new TextDecoder().decode(engine.decrypt(KEY, CryptoEngine.encrypt(KEY, msg('stat')))!)).toBe('stat');
  });
});
