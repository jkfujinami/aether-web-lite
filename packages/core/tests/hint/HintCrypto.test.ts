import { describe, it, expect, beforeAll } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { Encoding } from '../../src/common/Encoding';
import { KeyManager } from '../../src/crypto/KeyManager';
import {
  buildHint,
  computeBlindTag,
  decodeHintPayload,
  deriveHintKey,
  encodeHintPayload,
  mailboxKeyFromNonce,
  MAILBOX_NONCE_SIZE,
  newMailboxSlot,
  openHint,
  type HintPayload,
} from '../../src/network/hint/HintCrypto';
import {
  BLIND_TAG_SIZE,
  encodeHint,
  HINT_CIPHERTEXT_SIZE,
  HINT_INITIAL_TTL,
  HINT_NONCE_SIZE,
  HINT_PLAINTEXT_SIZE,
  HINT_VERSION,
  verifyHintPow,
  type HintPacket,
} from '../../src/network/hint/HintPacket';
import { fixedHint } from '../helpers/hintMailboxFakes';

let K: Uint8Array;
let OTHER: Uint8Array;

const payloadOf = (seed = 7): HintPayload => ({
  nonce: new Uint8Array(MAILBOX_NONCE_SIZE).fill(seed),
  message_id: 42,
  timestamp: 1_700_000_040_000,
});

/** haystack に needle が連続部分列として含まれるか */
function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

beforeAll(async () => {
  await sodiumReady;
  K = sodium.randombytes_buf(32);
  OTHER = sodium.randombytes_buf(32);
});

describe('HintCrypto: 鍵を持つ者だけが Hint を開ける', () => {
  it('正しい鍵で開くと中身 (nonce / message_id / timestamp) がそのまま戻る', () => {
    const p = payloadOf();
    const opened = openHint(K, buildHint(K, p));
    expect(opened).not.toBeNull();
    expect(Array.from(opened!.nonce)).toEqual(Array.from(p.nonce));
    expect(opened!.message_id).toBe(42);
    expect(opened!.timestamp).toBe(1_700_000_040_000);
  });

  it('違う鍵では開けない (null を返し、例外を投げない)', () => {
    const h = buildHint(K, payloadOf());
    expect(() => openHint(OTHER, h)).not.toThrow();
    expect(openHint(OTHER, h)).toBeNull();
  });

  it('多数の無関係な鍵のどれでも開けない', () => {
    const h = buildHint(K, payloadOf());
    for (let i = 0; i < 50; i++) {
      expect(openHint(sodium.randombytes_buf(32), h)).toBeNull();
    }
  });

  it('★blind_tag を受信者の鍵に合わせて偽造しても、AEAD が通らなければ受理しない', () => {
    // 攻撃者は OTHER の持ち主に「当たり」と思わせたい。
    // blind_tag だけ OTHER で計算し直しても、暗号文は K で封じてあるので開かない。
    const h = buildHint(K, payloadOf());
    const forged: HintPacket = { ...h, blind_tag: computeBlindTag(OTHER, h.nonce) };
    expect(openHint(OTHER, forged)).toBeNull();
  });

  it('暗号文を 1 ビットでも書き換えると開けない', () => {
    const h = buildHint(K, payloadOf());
    for (const idx of [0, 10, HINT_PLAINTEXT_SIZE - 1, HINT_CIPHERTEXT_SIZE - 1]) {
      const ct = h.ciphertext.slice();
      ct[idx] ^= 0x01;
      expect(openHint(K, { ...h, ciphertext: ct })).toBeNull();
    }
  });

  it('nonce を書き換えると開けない (blind_tag も AEAD も nonce に依存する)', () => {
    const h = buildHint(K, payloadOf());
    const n = h.nonce.slice();
    n[0] ^= 0xff;
    expect(openHint(K, { ...h, nonce: n })).toBeNull();
    // blind_tag を新しい nonce に合わせて作り直しても、AEAD で落ちる
    expect(openHint(K, { ...h, nonce: n, blind_tag: computeBlindTag(K, n) })).toBeNull();
  });

  it('blind_tag を書き換えると (AEAD を試す前に) 開けない', () => {
    const h = buildHint(K, payloadOf());
    const t = h.blind_tag.slice();
    t[3] ^= 0x80;
    expect(openHint(K, { ...h, blind_tag: t })).toBeNull();
  });

  it('正しい鍵で封じてあっても、平文が固定長でなければ受理しない', () => {
    const nonce = new Uint8Array(HINT_NONCE_SIZE).fill(3);
    const shortPlain = new Uint8Array(10);
    const ct = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(shortPlain, null, null, nonce, deriveHintKey(K));
    const h: HintPacket = {
      version: HINT_VERSION, ttl: 8, blind_tag: computeBlindTag(K, nonce), nonce, pow_nonce: 0, ciphertext: ct,
    };
    expect(openHint(K, h)).toBeNull();
  });

  it('正しい鍵で封じてあっても、message_id が安全整数を超える平文は受理しない', () => {
    const nonce = new Uint8Array(HINT_NONCE_SIZE).fill(4);
    const plain = new Uint8Array(HINT_PLAINTEXT_SIZE);
    plain.fill(0xff, MAILBOX_NONCE_SIZE, MAILBOX_NONCE_SIZE + 8); // u64 max
    const ct = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(plain, null, null, nonce, deriveHintKey(K));
    const h: HintPacket = {
      version: HINT_VERSION, ttl: 8, blind_tag: computeBlindTag(K, nonce), nonce, pow_nonce: 0, ciphertext: ct,
    };
    expect(openHint(K, h)).toBeNull();
  });
});

describe('HintCrypto: ワイヤ上の形は鍵無しでは何も語らない', () => {
  it('★同じ鍵・同じ中身でも、Hint ごとに nonce・blind_tag・暗号文がすべて変わる (束ねられない)', () => {
    const p = payloadOf();
    const a = buildHint(K, p);
    const b = buildHint(K, p);
    expect(Encoding.toHex(a.nonce)).not.toBe(Encoding.toHex(b.nonce));
    expect(Encoding.toHex(a.blind_tag)).not.toBe(Encoding.toHex(b.blind_tag));
    expect(Encoding.toHex(a.ciphertext)).not.toBe(Encoding.toHex(b.ciphertext));
  });

  it('blind_tag は nonce ごとに変わり、鍵ごとにも変わる', () => {
    const n1 = new Uint8Array(HINT_NONCE_SIZE).fill(1);
    const n2 = new Uint8Array(HINT_NONCE_SIZE).fill(2);
    const t11 = Encoding.toHex(computeBlindTag(K, n1));
    expect(Encoding.toHex(computeBlindTag(K, n2))).not.toBe(t11);
    expect(Encoding.toHex(computeBlindTag(OTHER, n1))).not.toBe(t11);
    expect(computeBlindTag(K, n1)).toHaveLength(BLIND_TAG_SIZE);
    // 同じ入力なら決定論的
    expect(Encoding.toHex(computeBlindTag(K, n1))).toBe(t11);
  });

  it('暗号文の長さは中身に依らず固定 (サイズから中身を推測できない)', () => {
    const small = buildHint(K, { nonce: new Uint8Array(32), message_id: 0, timestamp: 0 });
    const big = buildHint(K, {
      nonce: new Uint8Array(32).fill(0xff), message_id: Number.MAX_SAFE_INTEGER, timestamp: Number.MAX_SAFE_INTEGER,
    });
    expect(small.ciphertext).toHaveLength(HINT_CIPHERTEXT_SIZE);
    expect(big.ciphertext).toHaveLength(HINT_CIPHERTEXT_SIZE);
    expect(encodeHint(small)).toHaveLength(encodeHint(big).length);
  });

  it('★mailbox_key の素 (nonce) も mailbox_key 自体も、Hint のバイト列に平文で現れない', () => {
    const { nonce, mailboxKey } = newMailboxSlot();
    const h = buildHint(K, { nonce, message_id: 1, timestamp: 1 });
    const wire = encodeHint(h);
    expect(containsBytes(wire, nonce)).toBe(false);
    expect(containsBytes(wire, mailboxKey)).toBe(false);
    expect(containsBytes(wire, K)).toBe(false);
  });

  it('AEAD 鍵は K そのものではなく、K から分離された別の鍵', () => {
    const hk = deriveHintKey(K);
    expect(hk).toHaveLength(32);
    expect(Encoding.toHex(hk)).not.toBe(Encoding.toHex(K));
    // K を直接 AEAD 鍵に使った暗号文としては開けない
    const h = buildHint(K, payloadOf());
    expect(() =>
      sodium.crypto_aead_chacha20poly1305_ietf_decrypt(null, h.ciphertext, null, h.nonce, K),
    ).toThrow();
  });

  it('buildHint は初期 TTL・現行バージョンで、Hint の PoW を満たした状態で返す', () => {
    const h = buildHint(K, payloadOf());
    expect(h.version).toBe(HINT_VERSION);
    expect(h.ttl).toBe(HINT_INITIAL_TTL);
    expect(verifyHintPow(h)).toBe(true);
  });

  it('ベクタ用の固定 nonce を渡すと決定論的になり、長さが違えば RangeError', () => {
    const a = fixedHint(K, 5).hint;
    const b = fixedHint(K, 5).hint;
    expect(Encoding.toHex(encodeHint(a))).toBe(Encoding.toHex(encodeHint(b)));
    expect(() => buildHint(K, payloadOf(), { unsafeFixedNonceForVectors: new Uint8Array(11) })).toThrow(RangeError);
  });
});

describe('HintCrypto: ペイロードの固定長エンコード', () => {
  it('往復する', () => {
    const p = payloadOf(9);
    const bytes = encodeHintPayload(p);
    expect(bytes).toHaveLength(HINT_PLAINTEXT_SIZE);
    const back = decodeHintPayload(bytes)!;
    expect(Array.from(back.nonce)).toEqual(Array.from(p.nonce));
    expect(back.message_id).toBe(p.message_id);
    expect(back.timestamp).toBe(p.timestamp);
  });

  it('不正な入力は RangeError で拒否する', () => {
    const ok = payloadOf();
    expect(() => encodeHintPayload({ ...ok, nonce: new Uint8Array(31) })).toThrow(RangeError);
    expect(() => encodeHintPayload({ ...ok, nonce: new Uint8Array(33) })).toThrow(RangeError);
    expect(() => encodeHintPayload({ ...ok, message_id: -1 })).toThrow(RangeError);
    expect(() => encodeHintPayload({ ...ok, message_id: 1.5 })).toThrow(RangeError);
    expect(() => encodeHintPayload({ ...ok, message_id: Number.MAX_SAFE_INTEGER + 2 })).toThrow(RangeError);
    expect(() => encodeHintPayload({ ...ok, timestamp: -1 })).toThrow(RangeError);
    expect(() => encodeHintPayload({ ...ok, timestamp: NaN })).toThrow(RangeError);
    // 封印前に弾かれるので buildHint も同じく投げる
    expect(() => buildHint(K, { ...ok, message_id: -5 })).toThrow(RangeError);
  });

  it('長さが違う / 安全整数を超えるバイト列は null', () => {
    expect(decodeHintPayload(new Uint8Array(HINT_PLAINTEXT_SIZE - 1))).toBeNull();
    expect(decodeHintPayload(new Uint8Array(HINT_PLAINTEXT_SIZE + 1))).toBeNull();
    const bad = new Uint8Array(HINT_PLAINTEXT_SIZE);
    bad.fill(0xff, MAILBOX_NONCE_SIZE + 8); // timestamp = u64 max
    expect(decodeHintPayload(bad)).toBeNull();
  });

  it('オフセット付きのビューからでも正しく読める', () => {
    const inner = encodeHintPayload(payloadOf(3));
    const outer = new Uint8Array(inner.length + 7);
    outer.set(inner, 7);
    const back = decodeHintPayload(outer.subarray(7))!;
    expect(back.message_id).toBe(42);
    expect(back.nonce[0]).toBe(3);
  });
});

describe('HintCrypto: mailbox_key (Slot の保管キー)', () => {
  it('mailbox_key = SHA256(nonce)', () => {
    const { nonce, mailboxKey } = newMailboxSlot();
    expect(nonce).toHaveLength(MAILBOX_NONCE_SIZE);
    expect(Encoding.toHex(mailboxKey)).toBe(Encoding.toHex(sodium.crypto_hash_sha256(nonce)));
    expect(Encoding.toHex(mailboxKeyFromNonce(nonce))).toBe(Encoding.toHex(mailboxKey));
  });

  it('nonce の長さが違えば RangeError', () => {
    expect(() => mailboxKeyFromNonce(new Uint8Array(16))).toThrow(RangeError);
  });

  it('★Slot は毎回ランダムで、板/スレッドの鍵から計算で導けない', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) seen.add(Encoding.toHex(newMailboxSlot().mailboxKey));
    expect(seen.size).toBe(20);
    // 旧方式の固定座標 (SHA256(K) / topicHash 派生) と一致しない
    expect(seen.has(Encoding.toHex(sodium.crypto_hash_sha256(K)))).toBe(false);
    expect(seen.has(Encoding.toHex(KeyManager.deriveTopicHash(K)))).toBe(false);
  });
});
