import { describe, it, expect, beforeAll } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import {
  POW_POLICY,
  GOSSIP_DOMAIN,
  powPreimage,
  powHash,
  meetsDifficulty,
  derivePacketId,
  verifyPow,
  solvePow,
  toBytes,
  u64be,
  u32be,
  u16be,
  concat,
  type PowCommittedHeader,
} from '../../src/crypto/PowPolicy';
import { DifficultyEstimator } from '../../src/crypto/DifficultyEstimator';

/** 固定値のヘッダ (乱数を使わないので結果は決定的) */
const header = (over: Partial<PowCommittedHeader> = {}): PowCommittedHeader => ({
  timestamp: 1_700_000_000_000,
  zone_id: 3,
  pow_difficulty: POW_POLICY.MIN_DIFFICULTY,
  nonce: Uint8Array.from({ length: 12 }, (_, i) => i + 1),
  payload: new TextEncoder().encode('fixed-payload-for-pow-tests'),
  ...over,
});

let solved: { h: PowCommittedHeader; nonce: bigint };

beforeAll(async () => {
  await sodiumReady;
  const h = header();
  solved = { h, nonce: solvePow(h)! };
});

/** 与えた難易度を満たさない pow_nonce を決定的に探す */
function failingNonce(h: PowCommittedHeader): bigint {
  const pre = powPreimage(h);
  for (let i = 0n; ; i++) if (!meetsDifficulty(powHash(pre, i), h.pow_difficulty)) return i;
}

describe('PowPolicy: 定数', () => {
  it('ドメイン分離子は ちょうど 16 バイトの "AETHER/v3/gossip"', () => {
    expect(GOSSIP_DOMAIN).toHaveLength(16);
    expect(new TextDecoder().decode(GOSSIP_DOMAIN)).toBe('AETHER/v3/gossip');
  });

  it('網の難易度は [MIN, MAX] に収まり、DifficultyEstimator の下限と一致する', () => {
    expect(POW_POLICY.MIN_DIFFICULTY).toBeGreaterThan(0);
    expect(POW_POLICY.NETWORK_DIFFICULTY).toBeGreaterThanOrEqual(POW_POLICY.MIN_DIFFICULTY);
    expect(POW_POLICY.NETWORK_DIFFICULTY).toBeLessThanOrEqual(POW_POLICY.MAX_DIFFICULTY);
    expect(DifficultyEstimator.MIN_DIFFICULTY).toBe(POW_POLICY.MIN_DIFFICULTY);
  });
});

describe('PowPolicy: 整数のビッグエンディアン符号化', () => {
  it('u64be / u32be / u16be', () => {
    expect(Array.from(u64be(0x0102030405060708n))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Array.from(u64be(1))).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(Array.from(u32be(0xdeadbeef))).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(Array.from(u16be(0x1234))).toEqual([0x12, 0x34]);
  });

  it('u64be は整数でない値を例外で拒否する', () => {
    expect(() => u64be(1.5)).toThrow(RangeError);
    expect(() => u64be(NaN)).toThrow(RangeError);
  });

  it('u64be は 2^64-1 まで表現できる', () => {
    expect(Array.from(u64be((1n << 64n) - 1n))).toEqual(new Array(8).fill(0xff));
    expect(Array.from(u64be(Number.MAX_SAFE_INTEGER))).toEqual([0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  });

  it('concat は順序どおりに連結する', () => {
    expect(Array.from(concat([Uint8Array.of(1), new Uint8Array(0), Uint8Array.of(2, 3)]))).toEqual([1, 2, 3]);
    expect(concat([])).toHaveLength(0);
  });
});

describe('PowPolicy: 正準プリイメージ', () => {
  it('レイアウトどおりに並ぶ (domain|ts|zone|diff|nonce_len|nonce|payload_len|payload)', () => {
    const h = header({ nonce: Uint8Array.of(0xaa, 0xbb), payload: Uint8Array.of(0xcc) });
    const pre = powPreimage(h);
    expect(pre).toHaveLength(16 + 8 + 4 + 1 + 2 + 2 + 4 + 1);
    expect(Array.from(pre.subarray(0, 16))).toEqual(Array.from(GOSSIP_DOMAIN));
    expect(Array.from(pre.subarray(16, 24))).toEqual(Array.from(u64be(h.timestamp)));
    expect(Array.from(pre.subarray(24, 28))).toEqual([0, 0, 0, 3]);
    expect(pre[28]).toBe(h.pow_difficulty);
    expect(Array.from(pre.subarray(29, 31))).toEqual([0, 2]);
    expect(Array.from(pre.subarray(31, 33))).toEqual([0xaa, 0xbb]);
    expect(Array.from(pre.subarray(33, 37))).toEqual([0, 0, 0, 1]);
    expect(pre[37]).toBe(0xcc);
  });

  it('長さ前置きにより nonce と payload の境界をずらした入力は別のプリイメージになる', () => {
    const a = powPreimage(header({ nonce: Uint8Array.of(1, 2), payload: Uint8Array.of(3) }));
    const b = powPreimage(header({ nonce: Uint8Array.of(1), payload: Uint8Array.of(2, 3) }));
    expect(Encoding(a)).not.toBe(Encoding(b));
  });

  it('範囲外のフィールドは RangeError', () => {
    const bad: Array<Partial<PowCommittedHeader>> = [
      { timestamp: -1 },
      { timestamp: 1.5 },
      { timestamp: Number.MAX_SAFE_INTEGER + 2 },
      { timestamp: NaN },
      { zone_id: -1 },
      { zone_id: 0x1_0000_0000 },
      { zone_id: 0.5 },
      { pow_difficulty: -1 },
      { pow_difficulty: 256 },
      { pow_difficulty: 8.5 },
      { nonce: new Uint8Array(0x10000) },
    ];
    for (const over of bad) expect(() => powPreimage(header(over)), JSON.stringify(Object.keys(over))).toThrow(RangeError);
  });

  it('境界値 (zone_id=2^32-1, nonce 65535 バイト, difficulty 255) は受け付ける', () => {
    expect(() => powPreimage(header({ zone_id: 0xffffffff, pow_difficulty: 255, nonce: new Uint8Array(0xffff) }))).not.toThrow();
  });
});

describe('PowPolicy: toBytes (MsgPack 由来の形の正規化)', () => {
  it('Uint8Array / 配列 / {data:[...]} / ArrayBuffer / Buffer / DataView が同じバイト列になる', () => {
    const want = [1, 2, 3];
    const backing = new Uint8Array([9, 1, 2, 3, 9]);
    const forms: unknown[] = [
      Uint8Array.of(1, 2, 3),
      [1, 2, 3],
      { data: [1, 2, 3] },
      Uint8Array.of(1, 2, 3).buffer,
      Buffer.from([1, 2, 3]),
      new DataView(backing.buffer, 1, 3),
      backing.subarray(1, 4),
    ];
    for (const f of forms) expect(Array.from(toBytes(f))).toEqual(want);
  });

  it('解釈できない値は空のバイト列', () => {
    for (const v of [undefined, null, 'abc', 42, {}, { data: 'x' }]) expect(toBytes(v)).toHaveLength(0);
  });

  it('同じ内容なら表現が違っても packet_id は一致する', () => {
    const a = derivePacketId(header());
    const b = derivePacketId(header({ nonce: Array.from(header().nonce) as any, payload: { data: Array.from(header().payload) } as any }));
    expect(a).toBe(b);
  });
});

describe('PowPolicy: meetsDifficulty', () => {
  const h = (bytes: number[]) => Uint8Array.from([...bytes, ...new Array(32 - bytes.length).fill(0xff)]);

  it('difficulty <= 0 は常に true', () => {
    expect(meetsDifficulty(h([0xff]), 0)).toBe(true);
    expect(meetsDifficulty(h([0xff]), -5)).toBe(true);
  });

  it('ハッシュ長を超える difficulty は常に false (全ゼロでも)', () => {
    expect(meetsDifficulty(new Uint8Array(32), 257)).toBe(false);
    expect(meetsDifficulty(new Uint8Array(32), 256)).toBe(true);
  });

  it('ビット単位で境界を判定する', () => {
    // 0x00 0x1f → 先頭ゼロビットはちょうど 11
    const x = h([0x00, 0x1f]);
    expect(meetsDifficulty(x, 8)).toBe(true);
    expect(meetsDifficulty(x, 11)).toBe(true);
    expect(meetsDifficulty(x, 12)).toBe(false);
    // 0x80 → 先頭ゼロビット 0
    expect(meetsDifficulty(h([0x80]), 1)).toBe(false);
    // 0x7f → 先頭ゼロビット 1
    expect(meetsDifficulty(h([0x7f]), 1)).toBe(true);
    expect(meetsDifficulty(h([0x7f]), 2)).toBe(false);
    // 0x00 0x00 0x01 → 23 ビット
    expect(meetsDifficulty(h([0, 0, 1]), 23)).toBe(true);
    expect(meetsDifficulty(h([0, 0, 1]), 24)).toBe(false);
  });
});

describe('PowPolicy: packet_id (CHK)', () => {
  it('packet_id は SHA-256(preimage) の hex', () => {
    const want = Array.from(sodium.crypto_hash_sha256(powPreimage(header())))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(derivePacketId(header())).toBe(want);
    expect(derivePacketId(header())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('コミット対象のどのフィールドを 1 ビット変えても packet_id が変わる', () => {
    const base = derivePacketId(header());
    const flip = (u: Uint8Array, i: number) => { const c = Uint8Array.from(u); c[i] ^= 1; return c; };
    const variants: Array<Partial<PowCommittedHeader>> = [
      { timestamp: header().timestamp + 1 },
      { zone_id: 2 },
      { pow_difficulty: 9 },
      { nonce: flip(header().nonce, 11) },
      { payload: flip(header().payload, 0) },
      { payload: header().payload.subarray(0, header().payload.length - 1) },
    ];
    const ids = new Set([base, ...variants.map((v) => derivePacketId(header(v)))]);
    expect(ids.size).toBe(variants.length + 1);
  });
});

describe('PowPolicy: 検証', () => {
  it('solvePow の解は verifyPow を通り、number でも bigint でも同じ結果', () => {
    expect(verifyPow(solved.h, solved.nonce)).toBe(true);
    expect(verifyPow(solved.h, Number(solved.nonce))).toBe(true);
    expect(meetsDifficulty(powHash(powPreimage(solved.h), solved.nonce), solved.h.pow_difficulty)).toBe(true);
  });

  it('難易度を満たさない pow_nonce は拒否する', () => {
    expect(verifyPow(solved.h, failingNonce(solved.h))).toBe(false);
  });

  it('MIN_DIFFICULTY 未満の申告は、ハッシュが条件を満たしていても拒否する (申告値を信用しない)', () => {
    for (let d = 0; d < POW_POLICY.MIN_DIFFICULTY; d++) {
      const h = header({ pow_difficulty: d });
      // d ビットは満たすが、ポリシー違反
      const n = solvePow(h)!;
      expect(verifyPow(h, n)).toBe(false);
    }
  });

  it('MAX_DIFFICULTY を超える申告は拒否する', () => {
    const h = header({ pow_difficulty: POW_POLICY.MAX_DIFFICULTY + 1 });
    expect(verifyPow(h, 0)).toBe(false);
    expect(verifyPow(header({ pow_difficulty: 255 }), 0)).toBe(false);
  });

  it('timestamp を書き換えたリプレイは PoW をやり直さない限り通らない', () => {
    // 固定入力なので結果は決定的
    const tampered = { ...solved.h, timestamp: solved.h.timestamp + 60_000 };
    expect(verifyPow(tampered, solved.nonce)).toBe(false);
  });

  it('payload / zone_id / nonce を書き換えると同じ pow_nonce では通らない', () => {
    const p = Uint8Array.from(solved.h.payload); p[0] ^= 0x01;
    const n = Uint8Array.from(solved.h.nonce); n[0] ^= 0x01;
    expect(verifyPow({ ...solved.h, payload: p }, solved.nonce)).toBe(false);
    expect(verifyPow({ ...solved.h, zone_id: solved.h.zone_id + 1 }, solved.nonce)).toBe(false);
    expect(verifyPow({ ...solved.h, nonce: n }, solved.nonce)).toBe(false);
  });

  it('壊れたヘッダは例外ではなく false を返す', () => {
    expect(verifyPow({ ...solved.h, timestamp: -1 }, solved.nonce)).toBe(false);
    expect(verifyPow({ ...solved.h, zone_id: 2 ** 33 }, solved.nonce)).toBe(false);
    expect(verifyPow({ ...solved.h, pow_difficulty: NaN }, solved.nonce)).toBe(false);
  });

  it('solvePow は打ち切り上限に達すると null を返す', () => {
    expect(solvePow(header({ pow_difficulty: 32 }), 4)).toBeNull();
    expect(solvePow(header(), 0)).toBeNull();
  });

  it('solvePow は最小の解を返す (それより小さい nonce はすべて不合格)', () => {
    const pre = powPreimage(solved.h);
    for (let i = 0n; i < solved.nonce; i++) {
      expect(meetsDifficulty(powHash(pre, i), solved.h.pow_difficulty)).toBe(false);
    }
  });

  it('ドメイン分離子を除いたプリイメージでは別のハッシュになる', () => {
    const pre = powPreimage(solved.h);
    const without = pre.subarray(16);
    expect(Encoding(powHash(pre, 0))).not.toBe(Encoding(powHash(without, 0)));
  });
});

function Encoding(u: Uint8Array): string {
  return Buffer.from(u).toString('hex');
}
