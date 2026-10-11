import { describe, it, expect, beforeAll } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import {
  BLIND_TAG_SIZE,
  decodeHint,
  decrementHintTtl,
  encodeHint,
  ENCODED_HINT_SIZE,
  HINT_CIPHERTEXT_SIZE,
  HINT_DOMAIN,
  HINT_NONCE_SIZE,
  HINT_POW_DIFFICULTY,
  HINT_VERSION,
  hintId,
  hintPowHash,
  hintPreimage,
  parseHintPacket,
  sealHintPow,
  verifyHintPow,
  type HintPacket,
} from '../../src/network/hint/HintPacket';
import { meetsDifficulty } from '../../src/crypto/PowPolicy';
import { fixedHint } from '../helpers/hintMailboxFakes';

let K: Uint8Array;
let H: HintPacket; // 決定論的な正当 Hint

/** H と同じ中身で、別の有効な PoW 解を持つ Hint */
function alternativePowSolution(h: HintPacket): HintPacket {
  for (let n = h.pow_nonce + 1; ; n++) {
    const c = { ...h, pow_nonce: n };
    if (verifyHintPow(c)) return c;
  }
}

/** PoW を満たさない pow_nonce を決定論的に探す */
function failingPow(h: HintPacket): HintPacket {
  for (let n = 0; ; n++) {
    const c = { ...h, pow_nonce: n };
    if (!verifyHintPow(c)) return c;
  }
}

beforeAll(async () => {
  await sodiumReady;
  K = new Uint8Array(32).fill(0x11);
  H = fixedHint(K, 1).hint;
});

describe('HintPacket: id と PoW のコミット範囲', () => {
  it('ドメイン分離子はちょうど 16 バイト', () => {
    expect(HINT_DOMAIN).toHaveLength(16);
    expect(new TextDecoder().decode(HINT_DOMAIN)).toBe('AETHER/v3/hint__');
  });

  it('★id は ttl と pow_nonce に依存しない (中継で TTL が変わっても同一 Hint)', () => {
    const id = hintId(H);
    expect(hintId({ ...H, ttl: 0 })).toBe(id);
    expect(hintId({ ...H, ttl: 255 })).toBe(id);
    expect(hintId({ ...H, pow_nonce: H.pow_nonce + 12345 })).toBe(id);
  });

  it('★同じ中身に対する別の PoW 解も同じ id になる (別 Hint として再フラッドできない)', () => {
    const alt = alternativePowSolution(H);
    expect(alt.pow_nonce).not.toBe(H.pow_nonce);
    expect(verifyHintPow(alt)).toBe(true);
    expect(hintId(alt)).toBe(hintId(H));
  });

  it('version / blind_tag / nonce / ciphertext のどれかが変われば id も変わる', () => {
    const id = hintId(H);
    const flip = (b: Uint8Array, i = 0) => { const c = b.slice(); c[i] ^= 1; return c; };
    expect(hintId({ ...H, version: 2 })).not.toBe(id);
    expect(hintId({ ...H, blind_tag: flip(H.blind_tag) })).not.toBe(id);
    expect(hintId({ ...H, nonce: flip(H.nonce) })).not.toBe(id);
    expect(hintId({ ...H, ciphertext: flip(H.ciphertext, 63) })).not.toBe(id);
  });

  it('id は 64 桁の hex', () => {
    expect(hintId(H)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('preimage はサイズ・バージョンの不正を RangeError で拒否する', () => {
    expect(() => hintPreimage({ ...H, version: 256 })).toThrow(RangeError);
    expect(() => hintPreimage({ ...H, version: -1 })).toThrow(RangeError);
    expect(() => hintPreimage({ ...H, version: 1.5 })).toThrow(RangeError);
    expect(() => hintPreimage({ ...H, blind_tag: new Uint8Array(BLIND_TAG_SIZE + 1) })).toThrow(RangeError);
    expect(() => hintPreimage({ ...H, nonce: new Uint8Array(HINT_NONCE_SIZE - 1) })).toThrow(RangeError);
  });

  it('preimage は長さ前置きつきなので、暗号文の境界をずらした偽造で同じ id にならない', () => {
    // 暗号文を 1 バイト短くしたものは別の preimage
    const shorter = { ...H, ciphertext: H.ciphertext.slice(0, -1) };
    expect(hintId(shorter)).not.toBe(hintId(H));
  });
});

describe('HintPacket: PoW 検証', () => {
  it('seal 済みの Hint は既定の難易度を満たす', () => {
    expect(verifyHintPow(H)).toBe(true);
    expect(meetsDifficulty(hintPowHash(hintPreimage(H), H.pow_nonce), HINT_POW_DIFFICULTY)).toBe(true);
  });

  it('PoW を満たさない pow_nonce は拒否される', () => {
    expect(verifyHintPow(failingPow(H))).toBe(false);
  });

  it('★中身を書き換えると既存の PoW 解は無効になる (この固定ベクタでは決定論的)', () => {
    const ct = H.ciphertext.slice();
    ct[0] ^= 0x01;
    expect(verifyHintPow({ ...H, ciphertext: ct })).toBe(false);
  });

  it('pow_nonce が負・小数・安全整数超えなら false (例外を投げない)', () => {
    expect(verifyHintPow({ ...H, pow_nonce: -1 })).toBe(false);
    expect(verifyHintPow({ ...H, pow_nonce: 0.5 })).toBe(false);
    expect(verifyHintPow({ ...H, pow_nonce: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
  });

  it('形の壊れた Hint は false を返す (preimage の例外を漏らさない)', () => {
    expect(() => verifyHintPow({ ...H, nonce: new Uint8Array(3) })).not.toThrow();
    expect(verifyHintPow({ ...H, nonce: new Uint8Array(3) })).toBe(false);
    expect(verifyHintPow({ ...H, version: 999 })).toBe(false);
  });

  it('難易度 0 なら常に true / seal は pow_nonce=0 を返す', () => {
    expect(verifyHintPow({ ...H, pow_nonce: -1 }, 0)).toBe(true);
    expect(sealHintPow({ ...H, pow_nonce: 77 }, 0).pow_nonce).toBe(0);
  });

  it('seal は指定難易度を満たす最小の解を返す', () => {
    const sealed = sealHintPow({ ...H, pow_nonce: 0 }, 4);
    expect(verifyHintPow(sealed, 4)).toBe(true);
    for (let n = 0; n < sealed.pow_nonce; n++) {
      expect(verifyHintPow({ ...sealed, pow_nonce: n }, 4)).toBe(false);
    }
  });
});

describe('HintPacket: TTL', () => {
  it('1 ずつ減り、0 で破棄 (null)', () => {
    expect(decrementHintTtl({ ...H, ttl: 2 })!.ttl).toBe(1);
    expect(decrementHintTtl({ ...H, ttl: 1 })!.ttl).toBe(0);
    expect(decrementHintTtl({ ...H, ttl: 0 })).toBeNull();
  });

  it('元のオブジェクトは変更しない', () => {
    const h = { ...H, ttl: 5 };
    decrementHintTtl(h);
    expect(h.ttl).toBe(5);
  });
});

describe('HintPacket: ワイヤ入力の検証 (parseHintPacket)', () => {
  const wireOf = (h: HintPacket) => ({
    version: h.version, ttl: h.ttl, blind_tag: h.blind_tag, nonce: h.nonce, pow_nonce: h.pow_nonce, ciphertext: h.ciphertext,
  });

  it('正当な形はそのまま通る', () => {
    const p = parseHintPacket(wireOf(H))!;
    expect(p).not.toBeNull();
    expect(hintId(p)).toBe(hintId(H));
  });

  it('バイト列が配列 / {data:[]} / ArrayBuffer / DataView でも受け付ける', () => {
    const asArr = { ...wireOf(H), blind_tag: Array.from(H.blind_tag), nonce: { data: Array.from(H.nonce) } };
    expect(parseHintPacket(asArr)).not.toBeNull();
    const ab = H.ciphertext.slice().buffer;
    expect(parseHintPacket({ ...wireOf(H), ciphertext: ab })).not.toBeNull();
    expect(parseHintPacket({ ...wireOf(H), ciphertext: new DataView(ab) })).not.toBeNull();
  });

  it('★壊れた入力はすべて null (例外を投げない)', () => {
    const base = wireOf(H);
    const bad: any[] = [
      null, undefined, 0, 1, 'hint', true, [], [1, 2, 3], Symbol.iterator,
      {},
      { ...base, version: 0 },
      { ...base, version: 2 },
      { ...base, version: '1' },
      { ...base, ttl: -1 },
      { ...base, ttl: 256 },
      { ...base, ttl: 1.5 },
      { ...base, ttl: '8' },
      { ...base, ttl: undefined },
      { ...base, pow_nonce: -1 },
      { ...base, pow_nonce: 1.5 },
      { ...base, pow_nonce: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, pow_nonce: '0' },
      { ...base, pow_nonce: 10n },
      { ...base, blind_tag: new Uint8Array(3) },
      { ...base, blind_tag: new Uint8Array(5) },
      { ...base, blind_tag: 'abcd' },
      { ...base, blind_tag: undefined },
      { ...base, nonce: new Uint8Array(11) },
      { ...base, nonce: new Uint8Array(24) },
      { ...base, nonce: null },
      { ...base, ciphertext: new Uint8Array(HINT_CIPHERTEXT_SIZE - 1) },
      { ...base, ciphertext: new Uint8Array(HINT_CIPHERTEXT_SIZE + 1) },
      { ...base, ciphertext: new Uint8Array(1024 * 1024) },
      { ...base, ciphertext: 12345 },
      { ...base, ciphertext: { data: 'nope' } },
    ];
    for (const raw of bad) {
      expect(() => parseHintPacket(raw)).not.toThrow();
      expect(parseHintPacket(raw)).toBeNull();
    }
  });

  it('余計なフィールドは引き継がない (中継で送り主の情報が混ざらない)', () => {
    const p = parseHintPacket({ ...wireOf(H), sender: 'peer-x', extra: 1 })!;
    expect(Object.keys(p).sort()).toEqual(['blind_tag', 'ciphertext', 'nonce', 'pow_nonce', 'ttl', 'version']);
  });
});

describe('HintPacket: 保管用バイト列 (encodeHint / decodeHint)', () => {
  it('固定長 94 バイトで往復する', () => {
    expect(ENCODED_HINT_SIZE).toBe(1 + 1 + 4 + 12 + 8 + 64);
    const bytes = encodeHint(H);
    expect(bytes).toHaveLength(ENCODED_HINT_SIZE);
    const back = decodeHint(bytes)!;
    expect(back.version).toBe(HINT_VERSION);
    expect(back.ttl).toBe(H.ttl);
    expect(back.pow_nonce).toBe(H.pow_nonce);
    expect(hintId(back)).toBe(hintId(H));
    expect(verifyHintPow(back)).toBe(true);
  });

  it('ttl は 0〜255 のどれでも往復する', () => {
    for (const ttl of [0, 1, 128, 255]) expect(decodeHint(encodeHint({ ...H, ttl }))!.ttl).toBe(ttl);
  });

  it('長さが違えば null', () => {
    const bytes = encodeHint(H);
    expect(decodeHint(bytes.slice(0, -1))).toBeNull();
    expect(decodeHint(new Uint8Array(ENCODED_HINT_SIZE + 1))).toBeNull();
    expect(decodeHint(new Uint8Array(0))).toBeNull();
  });

  it('未知のバージョンは null', () => {
    const bytes = encodeHint(H);
    bytes[0] = 2;
    expect(decodeHint(bytes)).toBeNull();
  });

  it('pow_nonce が安全整数を超えるなら null', () => {
    const bytes = encodeHint(H);
    bytes.fill(0xff, 18, 26);
    expect(decodeHint(bytes)).toBeNull();
  });

  it('オフセット付きのビューからでも読める', () => {
    const inner = encodeHint(H);
    const outer = new Uint8Array(inner.length + 5);
    outer.set(inner, 5);
    expect(hintId(decodeHint(outer.subarray(5))!)).toBe(hintId(H));
  });

  it('ランダムなバイト列で例外を投げない', () => {
    for (let i = 0; i < 200; i++) {
      const junk = sodium.randombytes_buf(ENCODED_HINT_SIZE);
      expect(() => decodeHint(junk)).not.toThrow();
    }
  });
});
