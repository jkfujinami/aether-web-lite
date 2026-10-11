import { describe, it, expect, beforeAll, vi } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import {
  BLIND_TAG_SIZE,
  HINT_CIPHERTEXT_SIZE,
  HINT_INITIAL_TTL,
  HINT_NONCE_SIZE,
  HINT_POW_DIFFICULTY,
  HINT_VERSION,
  decrementHintTtl,
  hintId,
  hintPreimage,
  parseHintPacket,
  sealHintPow,
  verifyHintPow,
  type HintPacket,
} from '@/lib/network/hint/HintPacket';
import {
  buildHint,
  computeBlindTag,
  decodeHintPayload,
  deriveHintKey,
  encodeHintPayload,
  mailboxKeyFromNonce,
  newMailboxSlot,
  openHint,
  MAILBOX_NONCE_SIZE,
} from '@/lib/network/hint/HintCrypto';

let K: Uint8Array;
let OTHER_K: Uint8Array;

beforeAll(async () => {
  await sodium.ready;
  K = sodium.randombytes_buf(32);
  OTHER_K = sodium.randombytes_buf(32);
});

function samplePayload() {
  const { nonce } = newMailboxSlot();
  return { nonce, message_id: 42, timestamp: 1_700_000_000_000 };
}

describe('ペイロードの符号化', () => {
  it('往復する', () => {
    const p = samplePayload();
    const decoded = decodeHintPayload(encodeHintPayload(p));
    expect(decoded).not.toBeNull();
    expect(Array.from(decoded!.nonce)).toEqual(Array.from(p.nonce));
    expect(decoded!.message_id).toBe(p.message_id);
    expect(decoded!.timestamp).toBe(p.timestamp);
  });

  it('長さが固定である (サイズから中身を推測させない)', () => {
    expect(encodeHintPayload(samplePayload())).toHaveLength(48);
  });

  it('壊れた長さは null', () => {
    expect(decodeHintPayload(new Uint8Array(10))).toBeNull();
    expect(decodeHintPayload(new Uint8Array(49))).toBeNull();
  });

  it('nonce 長が違えば投げる', () => {
    expect(() =>
      encodeHintPayload({ nonce: new Uint8Array(31), message_id: 0, timestamp: 0 }),
    ).toThrow(RangeError);
  });
});

describe('★鍵を持つ者だけが開ける', () => {
  it('正しい鍵で往復する', () => {
    const p = samplePayload();
    const opened = openHint(K, buildHint(K, p));
    expect(opened).not.toBeNull();
    expect(Array.from(opened!.nonce)).toEqual(Array.from(p.nonce));
    expect(opened!.message_id).toBe(p.message_id);
  });

  it('★別の鍵では開けない', () => {
    expect(openHint(OTHER_K, buildHint(K, samplePayload()))).toBeNull();
  });

  it('★ciphertext を 1 バイト変えると開けない (AEAD が効いている)', () => {
    const h = buildHint(K, samplePayload());
    const tampered = { ...h, ciphertext: Uint8Array.from(h.ciphertext) };
    tampered.ciphertext[0] ^= 0xff;
    expect(openHint(K, tampered)).toBeNull();
  });

  it('★blind_tag が偶然一致しても AEAD で弾く', () => {
    // blind_tag を無理やり一致させても、鍵が違えば復号は通らない
    const h = buildHint(OTHER_K, samplePayload());
    const forged = { ...h, blind_tag: computeBlindTag(K, h.nonce) };
    expect(openHint(K, forged)).toBeNull();
  });
});

describe('★blind_tag の性質', () => {
  it('長さが 4 バイト', () => {
    expect(computeBlindTag(K, sodium.randombytes_buf(HINT_NONCE_SIZE))).toHaveLength(BLIND_TAG_SIZE);
  });

  it('★nonce ごとに変わる (固定値だと長期観測で束ねられる)', () => {
    const tags = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const n = sodium.randombytes_buf(HINT_NONCE_SIZE);
      tags.add(sodium.to_hex(computeBlindTag(K, n)));
    }
    // 200 回で衝突がほぼ無い = nonce に依存している
    expect(tags.size).toBeGreaterThan(190);
  });

  it('同じ nonce・同じ鍵なら決定的 (受信側が再計算できる)', () => {
    const n = sodium.randombytes_buf(HINT_NONCE_SIZE);
    expect(Array.from(computeBlindTag(K, n))).toEqual(Array.from(computeBlindTag(K, n)));
  });

  it('鍵が違えば別の値になる', () => {
    const n = sodium.randombytes_buf(HINT_NONCE_SIZE);
    expect(Array.from(computeBlindTag(K, n))).not.toEqual(Array.from(computeBlindTag(OTHER_K, n)));
  });

  it('hint_key は K そのものではない (鍵を用途で分ける)', () => {
    expect(Array.from(deriveHintKey(K))).not.toEqual(Array.from(K));
  });
});

describe('★ワイヤ上に鍵無しで読める情報が無い', () => {
  it('平文フィールドは version / ttl / pow_nonce だけ', () => {
    const h = buildHint(K, samplePayload());
    // 残りはすべて鍵が無ければ乱数と区別できない
    expect(h.version).toBe(HINT_VERSION);
    expect(h.ttl).toBe(HINT_INITIAL_TTL);
    expect(h.blind_tag).toHaveLength(BLIND_TAG_SIZE);
    expect(h.nonce).toHaveLength(HINT_NONCE_SIZE);
    expect(h.ciphertext).toHaveLength(HINT_CIPHERTEXT_SIZE);
  });

  it('★ciphertext の長さが常に一定 (長さから中身を推測させない)', () => {
    for (const messageId of [0, 1, 999_999]) {
      const h = buildHint(K, { ...samplePayload(), message_id: messageId });
      expect(h.ciphertext).toHaveLength(HINT_CIPHERTEXT_SIZE);
    }
  });

  it('★同じ中身でも毎回違うバイト列になる (nonce が毎回変わる)', () => {
    const p = samplePayload();
    const a = buildHint(K, p);
    const b = buildHint(K, p);
    expect(sodium.to_hex(a.nonce)).not.toBe(sodium.to_hex(b.nonce));
    expect(sodium.to_hex(a.ciphertext)).not.toBe(sodium.to_hex(b.ciphertext));
    expect(hintId(a)).not.toBe(hintId(b));
  });
});

describe('★id は ttl と pow_nonce を含まない', () => {
  it('中継で ttl が減っても id が変わらない', () => {
    const h = buildHint(K, samplePayload());
    const relayed = decrementHintTtl(decrementHintTtl(h)!)!;
    expect(relayed.ttl).toBeLessThan(h.ttl);
    expect(hintId(relayed)).toBe(hintId(h));
  });

  it('★pow_nonce の差し替えで id が変わらない (別解での再フラッドを防ぐ)', () => {
    const h = buildHint(K, samplePayload());
    expect(hintId({ ...h, pow_nonce: h.pow_nonce + 999 })).toBe(hintId(h));
  });

  it('中身が変われば id が変わる', () => {
    const h = buildHint(K, samplePayload());
    const other = { ...h, ciphertext: Uint8Array.from(h.ciphertext) };
    other.ciphertext[0] ^= 0xff;
    expect(hintId(other)).not.toBe(hintId(h));
  });

  it('プリイメージがドメイン分離子で始まる', () => {
    const pre = hintPreimage(buildHint(K, samplePayload()));
    expect(new TextDecoder().decode(pre.slice(0, 16))).toBe('AETHER/v3/hint__');
  });
});

describe('Hint の PoW', () => {
  it('解いた PoW が検証を通る', () => {
    expect(verifyHintPow(buildHint(K, samplePayload()))).toBe(true);
  });

  it('★pow_nonce を改竄すると落ちる', () => {
    const h = buildHint(K, samplePayload());
    expect(verifyHintPow({ ...h, pow_nonce: h.pow_nonce + 1 })).toBe(false);
  });

  it('★別の中身へ PoW を使い回せない', () => {
    const h = buildHint(K, samplePayload());
    const reused = { ...h, ciphertext: Uint8Array.from(h.ciphertext) };
    reused.ciphertext[0] ^= 0xff;
    expect(verifyHintPow(reused)).toBe(false);
  });

  it('難易度 0 は常に通る', () => {
    const h: HintPacket = {
      version: HINT_VERSION, ttl: 4,
      blind_tag: new Uint8Array(BLIND_TAG_SIZE),
      nonce: new Uint8Array(HINT_NONCE_SIZE),
      pow_nonce: 0,
      ciphertext: new Uint8Array(HINT_CIPHERTEXT_SIZE),
    };
    expect(verifyHintPow(h, 0)).toBe(true);
  });

  it('壊れた pow_nonce でも例外を投げない', () => {
    const h = buildHint(K, samplePayload());
    for (const bad of [-1, 1.5, NaN, Infinity]) {
      expect(() => verifyHintPow({ ...h, pow_nonce: bad as any })).not.toThrow();
      expect(verifyHintPow({ ...h, pow_nonce: bad as any })).toBe(false);
    }
  });

  it('難易度は仕様値で固定 (Rust 側と一致させる)', () => {
    expect(HINT_POW_DIFFICULTY).toBe(12);
  });
});

describe('parseHintPacket: ワイヤからの入力を固める', () => {
  const valid = () => {
    const h = buildHint(K, samplePayload());
    return JSON.parse(JSON.stringify({
      version: h.version, ttl: h.ttl,
      blind_tag: Array.from(h.blind_tag),
      nonce: Array.from(h.nonce),
      pow_nonce: h.pow_nonce,
      ciphertext: Array.from(h.ciphertext),
    }));
  };

  it('正しい形は通る', () => {
    expect(parseHintPacket(valid())).not.toBeNull();
  });

  it('壊れた入力を全部 null で返す (例外を投げない)', () => {
    const bads: any[] = [
      undefined, null, 0, 'x', [], {},
      { ...valid(), version: 99 },
      { ...valid(), ttl: -1 },
      { ...valid(), ttl: 999 },
      { ...valid(), pow_nonce: -1 },
      { ...valid(), blind_tag: [1, 2] },
      { ...valid(), nonce: [1, 2, 3] },
      { ...valid(), ciphertext: [1, 2, 3] },
      { ...valid(), blind_tag: 'nope' },
    ];
    for (const bad of bads) {
      expect(() => parseHintPacket(bad)).not.toThrow();
      expect(parseHintPacket(bad), JSON.stringify(bad)?.substring(0, 40)).toBeNull();
    }
  });

  it('★ciphertext 長が違うものを弾く (長さの揺れを許さない)', () => {
    const v = valid();
    expect(parseHintPacket({ ...v, ciphertext: v.ciphertext.slice(0, 60) })).toBeNull();
    expect(parseHintPacket({ ...v, ciphertext: [...v.ciphertext, 0] })).toBeNull();
  });
});

describe('mailbox_key の導出', () => {
  it('nonce から決定的に決まる', () => {
    const { nonce, mailboxKey } = newMailboxSlot();
    expect(Array.from(mailboxKeyFromNonce(nonce))).toEqual(Array.from(mailboxKey));
  });

  it('★毎回違う値になる (板やスレッドから導出できない)', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 100; i++) keys.add(sodium.to_hex(newMailboxSlot().mailboxKey));
    expect(keys.size).toBe(100);
  });

  it('nonce 長が違えば投げる', () => {
    expect(() => mailboxKeyFromNonce(new Uint8Array(31))).toThrow(RangeError);
  });

  it('nonce は 32 バイト', () => {
    expect(newMailboxSlot().nonce).toHaveLength(MAILBOX_NONCE_SIZE);
  });
});

describe('TTL', () => {
  it('1 ずつ減る', () => {
    const h = buildHint(K, samplePayload());
    expect(decrementHintTtl(h)!.ttl).toBe(h.ttl - 1);
  });

  it('0 では null を返して破棄させる', () => {
    const h = { ...buildHint(K, samplePayload()), ttl: 0 };
    expect(decrementHintTtl(h)).toBeNull();
  });
});
