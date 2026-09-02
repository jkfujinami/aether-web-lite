import { describe, it, expect } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import {
  POW_POLICY,
  powPreimage,
  powHash,
  meetsDifficulty,
  derivePacketId,
  verifyPow,
  solvePow,
  toBytes,
  type PowCommittedHeader,
} from '@/lib/crypto/PowPolicy';

function header(overrides: Partial<PowCommittedHeader> = {}): PowCommittedHeader {
  return {
    timestamp: 1_700_000_000_000,
    zone_id: 3,
    pow_difficulty: POW_POLICY.MIN_DIFFICULTY,
    nonce: new Uint8Array(12).fill(7),
    payload: new Uint8Array([1, 2, 3, 4, 5]),
    ...overrides,
  };
}

describe('meetsDifficulty', () => {
  it('difficulty 0 は常に成立する', () => {
    expect(meetsDifficulty(Uint8Array.of(0xff, 0xff), 0)).toBe(true);
  });

  it('先頭ゼロビットをバイト境界で正しく数える', () => {
    expect(meetsDifficulty(Uint8Array.of(0x00, 0xff), 8)).toBe(true);
    expect(meetsDifficulty(Uint8Array.of(0x00, 0xff), 9)).toBe(false);
    expect(meetsDifficulty(Uint8Array.of(0x00, 0x00), 16)).toBe(true);
  });

  it('バイト内の端数ビットを正しく扱う', () => {
    // 0x0f = 0000 1111 → 先頭 4 ビットがゼロ
    expect(meetsDifficulty(Uint8Array.of(0x0f), 4)).toBe(true);
    expect(meetsDifficulty(Uint8Array.of(0x0f), 5)).toBe(false);
    // 0x07 = 0000 0111 → 先頭 5 ビットがゼロ
    expect(meetsDifficulty(Uint8Array.of(0x07), 5)).toBe(true);
    expect(meetsDifficulty(Uint8Array.of(0x07), 6)).toBe(false);
  });

  it('ハッシュ長を超える難易度は成立しない', () => {
    expect(meetsDifficulty(new Uint8Array(32), 257)).toBe(false);
  });
});

describe('powPreimage', () => {
  it('決定的である', () => {
    expect(powPreimage(header())).toEqual(powPreimage(header()));
  });

  it('コミット対象フィールドのどれを変えてもプリイメージが変わる', () => {
    const base = powPreimage(header());
    const mutations: Array<Partial<PowCommittedHeader>> = [
      { timestamp: 1_700_000_000_001 },
      { zone_id: 4 },
      { pow_difficulty: POW_POLICY.MIN_DIFFICULTY + 1 },
      { nonce: new Uint8Array(12).fill(8) },
      { payload: new Uint8Array([1, 2, 3, 4, 6]) },
    ];
    for (const m of mutations) {
      expect(powPreimage(header(m)), JSON.stringify(m)).not.toEqual(base);
    }
  });

  it('長さ前置きによりフィールド境界の曖昧さが生じない', () => {
    // nonce="ab", payload="cd"  と  nonce="abc", payload="d" は
    // 単純連結だと同じバイト列になるが、長さ前置きにより区別される。
    const a = powPreimage(header({ nonce: Uint8Array.of(0x61, 0x62), payload: Uint8Array.of(0x63, 0x64) }));
    const b = powPreimage(header({ nonce: Uint8Array.of(0x61, 0x62, 0x63), payload: Uint8Array.of(0x64) }));
    expect(a).not.toEqual(b);
  });

  it('不正な値を拒否する', () => {
    expect(() => powPreimage(header({ timestamp: -1 }))).toThrow(RangeError);
    expect(() => powPreimage(header({ zone_id: -1 }))).toThrow(RangeError);
    expect(() => powPreimage(header({ pow_difficulty: 256 }))).toThrow(RangeError);
    expect(() => powPreimage(header({ timestamp: 1.5 }))).toThrow(RangeError);
  });
});

describe('derivePacketId', () => {
  it('SHA-256 の hex (64 文字) を返す', () => {
    const id = derivePacketId(header());
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('コミット対象を変えると packet_id が変わる (CHK)', () => {
    const id = derivePacketId(header());
    expect(derivePacketId(header({ timestamp: 1_700_000_000_001 }))).not.toBe(id);
    expect(derivePacketId(header({ payload: new Uint8Array([9]) }))).not.toBe(id);
  });

  it('プリイメージの SHA-256 と一致する', () => {
    const h = header();
    const expected = sodium.to_hex(sodium.crypto_hash_sha256(powPreimage(h)));
    expect(derivePacketId(h)).toBe(expected);
  });
});

describe('solvePow / verifyPow', () => {
  it('探索した nonce が検証を通る', () => {
    const h = header({ pow_difficulty: 10 });
    const nonce = solvePow(h);
    expect(nonce).not.toBeNull();
    expect(verifyPow(h, nonce!)).toBe(true);
  });

  it('別の nonce では検証が落ちる', () => {
    const h = header({ pow_difficulty: 10 });
    const nonce = solvePow(h)!;
    expect(verifyPow(h, nonce + 1n)).toBe(false);
  });

  it('★攻撃: pow_difficulty=0 を申告しても受理されない', () => {
    // 旧実装では PoWEngine.verify が difficulty===0 で即 true を返したため、
    // これだけで PoW を完全にバイパスできた。
    const h = header({ pow_difficulty: 0 });
    expect(verifyPow(h, 0)).toBe(false);
  });

  it('★攻撃: MIN_DIFFICULTY 未満の申告はすべて拒否される', () => {
    for (let d = 0; d < POW_POLICY.MIN_DIFFICULTY; d++) {
      const h = header({ pow_difficulty: d });
      // その難易度としては正当な解を与えても、ポリシー違反なので拒否
      const nonce = solvePow(h, 200_000);
      expect(verifyPow(h, nonce ?? 0n), `difficulty=${d}`).toBe(false);
    }
  });

  it('MAX_DIFFICULTY 超過の申告を拒否する', () => {
    const h = header({ pow_difficulty: POW_POLICY.MAX_DIFFICULTY + 1 });
    expect(verifyPow(h, 0)).toBe(false);
  });

  it('★攻撃: timestamp を差し替えると PoW が無効になる (リプレイ増幅の遮断)', () => {
    // 旧実装では PoW が ciphertext のみを覆っていたため、傍受したパケットの
    // timestamp を現在時刻に書き換えるだけで PoW を再計算せず再放流でき、
    // SeenCache の TTL (15分) を超えて無限に増幅できた。
    const original = header({ pow_difficulty: 10 });
    const nonce = solvePow(original)!;
    expect(verifyPow(original, nonce)).toBe(true);

    const replayed = { ...original, timestamp: original.timestamp + 20 * 60 * 1000 };
    expect(verifyPow(replayed, nonce)).toBe(false);
  });

  it('★攻撃: zone_id を差し替えると PoW が無効になる (他ゾーンへの転用の遮断)', () => {
    const original = header({ pow_difficulty: 10 });
    const nonce = solvePow(original)!;
    const moved = { ...original, zone_id: original.zone_id + 1 };
    expect(verifyPow(moved, nonce)).toBe(false);
  });

  it('maxIterations に達したら null を返す', () => {
    // 難易度 32 は 2^32 回相当なので、少ない試行数では必ず見つからない
    const h = header({ pow_difficulty: 32 });
    expect(solvePow(h, 50)).toBeNull();
  });
});

describe('powHash', () => {
  it('pow_nonce が違えばハッシュが変わる', () => {
    const pre = powPreimage(header());
    expect(powHash(pre, 0n)).not.toEqual(powHash(pre, 1n));
  });

  it('SHA-256 なので 32 バイト', () => {
    expect(powHash(powPreimage(header()), 0n).length).toBe(32);
  });
});

describe('toBytes', () => {
  it('MsgPack / JSON 経由の各種表現を正規化する', () => {
    const expected = Uint8Array.of(1, 2, 3);
    expect(toBytes(Uint8Array.of(1, 2, 3))).toEqual(expected);
    expect(toBytes([1, 2, 3])).toEqual(expected);
    expect(toBytes({ _type: 'Uint8Array', data: [1, 2, 3] })).toEqual(expected);
    expect(toBytes(Uint8Array.of(1, 2, 3).buffer)).toEqual(expected);
  });

  it('未知の入力は空配列になる (例外を投げない)', () => {
    expect(toBytes(null)).toEqual(new Uint8Array(0));
    expect(toBytes(undefined)).toEqual(new Uint8Array(0));
    expect(toBytes('nope')).toEqual(new Uint8Array(0));
  });

  it('ビューのオフセットを尊重する', () => {
    const buf = Uint8Array.of(9, 9, 1, 2, 3);
    const view = new Uint8Array(buf.buffer, 2, 3);
    expect(toBytes(view)).toEqual(Uint8Array.of(1, 2, 3));
  });
});
