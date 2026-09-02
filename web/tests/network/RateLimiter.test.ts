import { describe, it, expect } from 'vitest';
import { RateLimiter, RATE_LIMITS } from '@/lib/network/RateLimiter';

/** 時刻を手で進められるクロック */
function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) { now += ms; },
  };
}

describe('RateLimiter', () => {
  it('バースト分までは通す', () => {
    const clock = fakeClock();
    const rl = new RateLimiter({ test: { ratePerSec: 1, burst: 5 } }, clock.now);
    for (let i = 0; i < 5; i++) {
      expect(rl.allow('peer', 'test'), `#${i}`).toBe(true);
    }
  });

  it('★攻撃: バーストを超えたフラッドを頭打ちにする', () => {
    const clock = fakeClock();
    const rl = new RateLimiter({ test: { ratePerSec: 1, burst: 5 } }, clock.now);
    for (let i = 0; i < 5; i++) rl.allow('attacker', 'test');

    // 時間を進めずに 10000 件撃ち込んでも 1 件も通らない
    let passed = 0;
    for (let i = 0; i < 10_000; i++) {
      if (rl.allow('attacker', 'test')) passed++;
    }
    expect(passed).toBe(0);
    expect(rl.dropped.get('test')).toBe(10_000);
  });

  it('時間経過でトークンが定常レートで回復する', () => {
    const clock = fakeClock();
    const rl = new RateLimiter({ test: { ratePerSec: 10, burst: 10 } }, clock.now);
    for (let i = 0; i < 10; i++) rl.allow('peer', 'test');
    expect(rl.allow('peer', 'test')).toBe(false);

    clock.advance(1000); // 10 トークン回復
    let passed = 0;
    for (let i = 0; i < 20; i++) if (rl.allow('peer', 'test')) passed++;
    expect(passed).toBe(10);
  });

  it('回復はバースト上限で頭打ちになる', () => {
    const clock = fakeClock();
    const rl = new RateLimiter({ test: { ratePerSec: 10, burst: 10 } }, clock.now);
    rl.allow('peer', 'test');
    clock.advance(60_000); // 600 トークン分の時間

    let passed = 0;
    for (let i = 0; i < 100; i++) if (rl.allow('peer', 'test')) passed++;
    expect(passed).toBe(10); // burst を超えて溜まらない
  });

  it('ピアごとにバケットが独立している (1人が使い切っても他は無傷)', () => {
    const clock = fakeClock();
    const rl = new RateLimiter({ test: { ratePerSec: 1, burst: 3 } }, clock.now);
    for (let i = 0; i < 10; i++) rl.allow('attacker', 'test');

    expect(rl.allow('attacker', 'test')).toBe(false);
    expect(rl.allow('honest', 'test')).toBe(true);
  });

  it('カテゴリごとにバケットが独立している', () => {
    const clock = fakeClock();
    const rl = new RateLimiter(
      { a: { ratePerSec: 1, burst: 2 }, b: { ratePerSec: 1, burst: 2 } },
      clock.now,
    );
    rl.allow('peer', 'a');
    rl.allow('peer', 'a');
    expect(rl.allow('peer', 'a')).toBe(false);
    // DHT_PUT を撃たれても GOSSIP の予算は減らない、という性質
    expect(rl.allow('peer', 'b')).toBe(true);
  });

  it('未定義カテゴリは素通しする (設定漏れで通信を止めない)', () => {
    const rl = new RateLimiter({}, fakeClock().now);
    for (let i = 0; i < 1000; i++) expect(rl.allow('peer', 'unknown')).toBe(true);
  });

  it('forget でピアの状態を捨てる', () => {
    const clock = fakeClock();
    const rl = new RateLimiter({ test: { ratePerSec: 1, burst: 2 } }, clock.now);
    rl.allow('peer', 'test');
    rl.allow('peer', 'test');
    expect(rl.allow('peer', 'test')).toBe(false);

    rl.forget('peer');
    expect(rl.allow('peer', 'test')).toBe(true);
  });

  it('forget は接頭辞が一致する別ピアを巻き込まない', () => {
    const clock = fakeClock();
    const rl = new RateLimiter({ test: { ratePerSec: 1, burst: 1 } }, clock.now);
    rl.allow('peerAB', 'test');
    rl.allow('peerA', 'test');
    expect(rl.allow('peerA', 'test')).toBe(false);

    rl.forget('peerA');
    // peerAB は消えていない
    expect(rl.tokensFor('peerAB', 'test')).toBeLessThan(1);
  });

  it('既定の設定はすべて正の値', () => {
    for (const [name, cfg] of Object.entries(RATE_LIMITS)) {
      expect(cfg.ratePerSec, name).toBeGreaterThan(0);
      expect(cfg.burst, name).toBeGreaterThanOrEqual(1);
    }
  });

  it('handshake は NodeId PoW 検証が重いので特に絞られている', () => {
    // 3.4ms/検証 × このレート = CPU 占有率が 1% 未満に収まること
    const cost = 0.0034;
    expect(RATE_LIMITS.handshake.ratePerSec * cost).toBeLessThan(0.01);
  });
});
