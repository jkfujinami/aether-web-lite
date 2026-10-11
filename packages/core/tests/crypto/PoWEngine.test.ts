import { describe, it, expect, beforeAll } from 'vitest';
import { sodiumReady } from '../../src/crypto/sodium';
import { PoWEngine } from '../../src/crypto/PoWEngine';
import { POW_POLICY, powHash, powPreimage, meetsDifficulty, type PowCommittedHeader } from '../../src/crypto/PowPolicy';

const header = (over: Partial<PowCommittedHeader> = {}): PowCommittedHeader => ({
  timestamp: 1_700_000_000_000,
  zone_id: 0,
  pow_difficulty: POW_POLICY.MIN_DIFFICULTY,
  nonce: new Uint8Array(12).fill(7),
  payload: new TextEncoder().encode('pow-engine'),
  ...over,
});

beforeAll(async () => {
  await sodiumReady;
});

describe('PoWEngine', () => {
  it('Worker の無い環境では同期探索にフォールバックし、得た解は検証を通る', async () => {
    expect(typeof (globalThis as any).Worker).toBe('undefined');
    const h = header();
    const nonce = await PoWEngine.compute(h);
    expect(typeof nonce).toBe('bigint');
    expect(PoWEngine.verify(h, nonce)).toBe(true);
    expect(nonce).toBe(PoWEngine.computeSync(h));
  });

  it('網の難易度 (NETWORK_DIFFICULTY) でも解ける', async () => {
    const h = header({ pow_difficulty: POW_POLICY.NETWORK_DIFFICULTY });
    const nonce = await PoWEngine.compute(h);
    expect(meetsDifficulty(powHash(powPreimage(h), nonce), POW_POLICY.NETWORK_DIFFICULTY)).toBe(true);
    expect(PoWEngine.verify(h, nonce)).toBe(true);
  });

  it('ポリシー外の難易度では探索を始めない', async () => {
    await expect(PoWEngine.compute(header({ pow_difficulty: POW_POLICY.MIN_DIFFICULTY - 1 }))).rejects.toThrow(RangeError);
    await expect(PoWEngine.compute(header({ pow_difficulty: 0 }))).rejects.toThrow(RangeError);
    await expect(PoWEngine.compute(header({ pow_difficulty: POW_POLICY.MAX_DIFFICULTY + 1 }))).rejects.toThrow(RangeError);
  });

  it('verify は申告難易度 0 のヘッダをどんな nonce でも拒否する', () => {
    const h = header({ pow_difficulty: 0 });
    for (let i = 0; i < 16; i++) expect(PoWEngine.verify(h, i)).toBe(false);
  });

  it('解を別のヘッダに流用しても通らない', async () => {
    const h = header();
    const nonce = await PoWEngine.compute(h);
    expect(PoWEngine.verify({ ...h, timestamp: h.timestamp + 1 }, nonce)).toBe(false);
  });
});
