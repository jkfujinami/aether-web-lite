import { describe, it, expect } from 'vitest';
import {
  HintReleaseScheduler,
  RELEASE_CONFIG,
  type ReleaseMode,
} from '@/lib/network/hint/HintRelease';

const KB = 1024;
const MB = 1024 * KB;

/** 指定のレートで観測を積む */
function feed(
  s: HintReleaseScheduler,
  opts: { hintsPerSec?: number; relayBps?: number },
  now = 1_000_000,
) {
  const windowSec = RELEASE_CONFIG.RATE_WINDOW_MS / 1000;
  const hints = Math.round((opts.hintsPerSec ?? 0) * windowSec);
  for (let i = 0; i < hints; i++) s.noteHintSeen(now);
  if (opts.relayBps) s.noteRelayBytes(opts.relayBps * windowSec, now);
  return now;
}

describe('★ブートストラップ期: 網が小さいときは遅延しない', () => {
  it('★観測レート 0 なら待たない (待っても匿名集合が生まれない)', () => {
    // 素朴に実装すると W = 目標/0 = ∞ となり上限まで待たされる。
    // 利益ゼロのコストを、最も離脱されやすい立ち上げ期に払わせることになり、
    // 網が育つ経路そのものを塞ぐ。
    const s = new HintReleaseScheduler('adaptive');
    const now = feed(s, { relayBps: 0 });
    const st = s.plan(4 * MB, now);

    expect(st.delayMs).toBe(0);
    expect(st.reason).toContain('unreachable');
    expect(st.targetMet).toBe(false);
  });

  it('★レートが低すぎる間も待たない', () => {
    const s = new HintReleaseScheduler('adaptive');
    // 0.001 件/秒 = 上限まで待っても 0.06 件しか集まらない
    const now = feed(s, { hintsPerSec: 0.001, relayBps: 10 * KB });
    const st = s.plan(4 * MB, now);

    expect(st.delayMs).toBe(0);
    expect(st.expectedAnonymitySet).toBeLessThan(RELEASE_CONFIG.MIN_MEASURABLE_SET);
  });

  it('★網が育つと自動的に効き始める', () => {
    const s = new HintReleaseScheduler('adaptive');
    const now = feed(s, { hintsPerSec: 1, relayBps: 10 * KB });
    const st = s.plan(4 * MB, now);

    expect(st.delayMs, '網が育っても遅延が入らない').toBeGreaterThan(0);
    expect(st.expectedAnonymitySet).toBeGreaterThanOrEqual(RELEASE_CONFIG.MIN_MEASURABLE_SET);
  });

  it('★strict は届かなくても待つ (使用感より秘匿を優先)', () => {
    const s = new HintReleaseScheduler('strict');
    const now = feed(s, { hintsPerSec: 0.001, relayBps: 10 * KB });
    const st = s.plan(4 * MB, now);

    expect(st.delayMs).toBeGreaterThan(0);
    expect(st.targetMet).toBe(false);
  });

  it('disabled は常に 0', () => {
    const s = new HintReleaseScheduler('disabled');
    const now = feed(s, { hintsPerSec: 10, relayBps: 1 * MB });
    expect(s.plan(4096 * MB, now).delayMs).toBe(0);
  });
});

describe('★小さい送信には遅延を入れない', () => {
  it('★チャット規模は常に遅延なし (自分の雑音に沈む)', () => {
    const s = new HintReleaseScheduler('adaptive');
    // 定常中継 1Mbps = 125KB/s → 8 秒ぶん = 1MB まで沈む
    for (const rate of [0, 0.1, 1, 10]) {
      const now = feed(s, { hintsPerSec: rate, relayBps: 125 * KB });
      const st = s.plan(10 * KB, now);
      expect(st.delayMs, `hintRate=${rate} で遅延が入っている`).toBe(0);
      expect(st.reason).toContain('noise');
    }
  });

  it('雑音の上限を超える送信には遅延が要る', () => {
    const s = new HintReleaseScheduler('adaptive');
    const now = feed(s, { hintsPerSec: 1, relayBps: 125 * KB });
    // 8 秒ぶん = 1MB が上限。4MB は沈まない。
    expect(s.plan(4 * MB, now).delayMs).toBeGreaterThan(0);
  });

  it('★中継していないと何も埋もれない', () => {
    // relayThroughput = 0 なら noise floor も 0。
    // 「中継しないほど自分の送信が目立つ」という関係が式にそのまま出る。
    const s = new HintReleaseScheduler('adaptive');
    const now = feed(s, { hintsPerSec: 1, relayBps: 0 });
    const st = s.plan(1 * KB, now);

    expect(st.relayThroughputBps).toBe(0);
    expect(st.delayMs, '中継していないのに沈んだ扱いになっている').toBeGreaterThan(0);
  });
});

describe('待ち時間の算出', () => {
  it('大きいほど長く待つ', () => {
    const s = new HintReleaseScheduler('adaptive');
    const now = feed(s, { hintsPerSec: 1, relayBps: 125 * KB });
    const small = s.plan(4 * MB, now).delayMs;
    const large = s.plan(400 * MB, now).delayMs;
    expect(large).toBeGreaterThan(small);
  });

  it('★上限 (patience) で頭打ちになる', () => {
    const s = new HintReleaseScheduler('adaptive');
    const now = feed(s, { hintsPerSec: 1, relayBps: 125 * KB });
    const st = s.plan(4096 * MB, now);
    // 2 × 送出所要時間 が上限
    const sendSec = (4096 * MB) / (125 * KB);
    expect(st.delayMs / 1000).toBeLessThanOrEqual(Math.max(60, 2 * sendSec) + 1);
    expect(st.reason).toContain('capped');
  });

  it('レートが高いほど短い窓で足りる', () => {
    const a = new HintReleaseScheduler('adaptive');
    const b = new HintReleaseScheduler('adaptive');
    const now = 1_000_000;
    feed(a, { hintsPerSec: 0.5, relayBps: 125 * KB }, now);
    feed(b, { hintsPerSec: 50, relayBps: 125 * KB }, now);
    // 同じ大きさなら、レートが高い方が短い窓で目標に届く
    expect(b.plan(4 * MB, now).delayMs).toBeLessThanOrEqual(a.plan(4 * MB, now).delayMs);
  });
});

describe('★なぜその待ち時間になったかを必ず返す', () => {
  it('全モードで reason が空でない', () => {
    for (const mode of ['disabled', 'adaptive', 'strict'] as ReleaseMode[]) {
      const s = new HintReleaseScheduler(mode);
      const now = feed(s, { hintsPerSec: 1, relayBps: 125 * KB });
      const st = s.plan(4 * MB, now);
      // 匿名性の強度が黙って変わるのが一番まずい
      expect(st.reason.length, `${mode} で reason が空`).toBeGreaterThan(0);
      expect(st.mode).toBe(mode);
    }
  });

  it('観測値をそのまま返す', () => {
    const s = new HintReleaseScheduler('adaptive');
    const now = feed(s, { hintsPerSec: 2, relayBps: 100 * KB });
    const st = s.plan(4 * MB, now);
    expect(st.observedHintRate).toBeCloseTo(2, 1);
    expect(st.relayThroughputBps).toBeCloseTo(100 * KB, -2);
  });
});

describe('レート計測', () => {
  it('窓の外の観測は落とす', () => {
    const s = new HintReleaseScheduler('adaptive');
    const t0 = 1_000_000;
    for (let i = 0; i < 100; i++) s.noteHintSeen(t0);
    expect(s.hintRate(t0)).toBeGreaterThan(0);
    // 窓を過ぎたら 0 に戻る
    expect(s.hintRate(t0 + RELEASE_CONFIG.RATE_WINDOW_MS + 1)).toBe(0);
  });

  it('負や 0 のバイト数は無視する', () => {
    const s = new HintReleaseScheduler('adaptive');
    const t0 = 1_000_000;
    s.noteRelayBytes(0, t0);
    s.noteRelayBytes(-5, t0);
    expect(s.relayThroughputBps(t0)).toBe(0);
  });

  it('モードを実行中に変えられる', () => {
    const s = new HintReleaseScheduler('adaptive');
    expect(s.getMode()).toBe('adaptive');
    s.setMode('strict');
    expect(s.getMode()).toBe('strict');
  });
});
