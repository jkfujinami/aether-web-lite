import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HintReleaseScheduler, RELEASE_CONFIG } from '../../src/network/hint/HintRelease';

const T0 = 1_700_000_000_000;
const WINDOW_SEC = RELEASE_CONFIG.RATE_WINDOW_MS / 1000; // 300

/** 窓内に n 件の Hint を観測させる (rate = n / 300 件/秒) */
function seeHints(s: HintReleaseScheduler, n: number, now = Date.now()): void {
  for (let i = 0; i < n; i++) s.noteHintSeen(now);
}

describe('HintReleaseScheduler: 放流の待ち時間 (§18.4.5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('既定のモードは adaptive。setMode / getMode で切り替わる', () => {
    const s = new HintReleaseScheduler();
    expect(s.getMode()).toBe('adaptive');
    s.setMode('strict');
    expect(s.getMode()).toBe('strict');
    s.setMode('disabled');
    expect(s.plan(10_000_000).mode).toBe('disabled');
  });

  it('disabled は観測量に関わらず遅延 0', () => {
    const s = new HintReleaseScheduler('disabled');
    seeHints(s, 300);
    const st = s.plan(10 * 1024 * 1024);
    expect(st.delayMs).toBe(0);
    expect(st.reason).toBe('mode=disabled');
  });

  it('★観測が無い立ち上げ期 (adaptive) は待たない (待っても匿名集合が生まれない)', () => {
    const s = new HintReleaseScheduler('adaptive');
    const st = s.plan(1024);
    expect(st.delayMs).toBe(0);
    expect(st.reason).toMatch(/unreachable/);
    expect(st.observedHintRate).toBe(0);
    expect(st.expectedAnonymitySet).toBe(0);
    expect(st.targetMet).toBe(false);
  });

  it('★Hint レートが低すぎる網では adaptive は待たないが、strict は上限まで待つ', () => {
    // 3 件 / 300 秒 = 0.01 件/秒 → 目標 8 件に 800 秒。patience 60 秒で 0.6 件しか集まらない
    const a = new HintReleaseScheduler('adaptive');
    const s = new HintReleaseScheduler('strict');
    seeHints(a, 3);
    seeHints(s, 3);

    const pa = a.plan(1024);
    expect(pa.delayMs).toBe(0);
    expect(pa.reason).toMatch(/network too small/);

    const ps = s.plan(1024);
    expect(ps.delayMs).toBe(RELEASE_CONFIG.MIN_PATIENCE_MS);
    expect(ps.reason).toMatch(/capped by patience/);
    expect(ps.expectedAnonymitySet).toBeCloseTo(0.6, 5);
    expect(ps.targetMet).toBe(false);
  });

  it('観測レートから窓を逆算する: 1 件/秒なら 8 秒待てば目標の 8 件に届く', () => {
    const s = new HintReleaseScheduler('adaptive');
    seeHints(s, WINDOW_SEC); // 300 件 → 1 件/秒
    const st = s.plan(1024);
    expect(st.observedHintRate).toBeCloseTo(1, 10);
    expect(st.delayMs).toBe(8_000);
    expect(st.reason).toBe('window from observed rate');
    expect(st.expectedAnonymitySet).toBeCloseTo(8, 10);
    expect(st.targetMet).toBe(true);
  });

  it('必要な窓が patience を超えると打ち切られ、そのことが reason に出る', () => {
    const s = new HintReleaseScheduler('adaptive');
    seeHints(s, 30); // 0.1 件/秒 → 80 秒必要。patience 60 秒
    const st = s.plan(1024);
    expect(st.delayMs).toBe(60_000);
    expect(st.reason).toMatch(/capped by patience \(60s\)/);
    expect(st.expectedAnonymitySet).toBeCloseTo(6, 5);
    expect(st.targetMet).toBe(false);
  });

  it('★自分の中継トラフィック (8 秒ぶん) に沈む送信は待たない', () => {
    const s = new HintReleaseScheduler('strict');
    seeHints(s, 300);
    s.noteRelayBytes(300_000); // 1000 B/s → noise floor 8000 B
    expect(s.relayThroughputBps()).toBeCloseTo(1000, 10);
    const sinks = s.plan(8000);
    expect(sinks.delayMs).toBe(0);
    expect(sinks.reason).toMatch(/sinks into relay noise \(8000B floor\)/);
    // 1 バイトでも超えれば遅延対象
    expect(s.plan(8001).delayMs).toBeGreaterThan(0);
  });

  it('★中継していない (throughput 0) なら、どんなに小さい送信も雑音に沈まない', () => {
    const s = new HintReleaseScheduler('adaptive');
    seeHints(s, 300);
    const st = s.plan(1);
    expect(st.relayThroughputBps).toBe(0);
    expect(st.reason).not.toMatch(/sinks/);
    expect(st.delayMs).toBe(8_000);
  });

  it('大きな送信はエンベロープ (送出所要時間 × 10) で窓が決まり、patience は 2 × 送出所要時間まで伸びる', () => {
    const s = new HintReleaseScheduler('strict');
    seeHints(s, 300); // 1 件/秒
    s.noteRelayBytes(300_000); // 1000 B/s
    // 送出 1000 秒 → エンベロープ 10000 秒、patience = max(60, 2000) = 2000 秒
    const st = s.plan(1_000_000);
    expect(st.delayMs).toBe(2_000_000);
    expect(st.reason).toMatch(/capped by patience \(2000s\)/);
    expect(st.targetMet).toBe(true);
  });

  it('雑音床 (送出 8 秒ぶん) を超える送信では、エンベロープ窓 (×10 = 80 秒以上) が必ず patience で打ち切られる', () => {
    const s = new HintReleaseScheduler('adaptive');
    seeHints(s, 300);
    s.noteRelayBytes(300_000); // 1000 B/s, floor 8000
    // 送出 9 秒 → エンベロープ 90 秒 > patience max(60, 18)=60 → 60 秒
    expect(s.plan(9_000).delayMs).toBe(60_000);
    // 送出 10 秒 → 100 秒 > 60 → 60 秒
    const st = s.plan(10_000);
    expect(st.delayMs).toBe(60_000);
    expect(st.reason).toMatch(/capped by patience/);
  });

  it('★観測は 5 分の窓でだけ数える (古い観測は抜け落ちる)', () => {
    const s = new HintReleaseScheduler('adaptive');
    seeHints(s, 300, T0);
    s.noteRelayBytes(300_000, T0);
    expect(s.hintRate(T0)).toBeCloseTo(1, 10);

    const later = T0 + RELEASE_CONFIG.RATE_WINDOW_MS + 1;
    expect(s.hintRate(later)).toBe(0);
    expect(s.relayThroughputBps(later)).toBe(0);
    expect(s.plan(1024, later).delayMs).toBe(0);
  });

  it('窓の境界ちょうど (cutoff と同時刻) の観測はまだ数える', () => {
    const s = new HintReleaseScheduler('adaptive');
    s.noteHintSeen(T0);
    expect(s.hintRate(T0 + RELEASE_CONFIG.RATE_WINDOW_MS)).toBeGreaterThan(0);
    expect(s.hintRate(T0 + RELEASE_CONFIG.RATE_WINDOW_MS + 1)).toBe(0);
  });

  it('既定の now は (偽装した) Date.now() を使う', () => {
    const s = new HintReleaseScheduler('adaptive');
    seeHints(s, 300);
    vi.setSystemTime(T0 + RELEASE_CONFIG.RATE_WINDOW_MS + 1000);
    expect(s.hintRate()).toBe(0);
  });

  it('0 以下の中継バイト数は無視する', () => {
    const s = new HintReleaseScheduler('adaptive');
    s.noteRelayBytes(0);
    s.noteRelayBytes(-1000);
    expect(s.relayThroughputBps()).toBe(0);
  });

  it('★waitFor は計画した時間だけ待ってから解決する', async () => {
    const s = new HintReleaseScheduler('adaptive');
    seeHints(s, 300); // 8 秒
    let done = false;
    const p = s.waitFor(1024).then(st => { done = true; return st; });

    await vi.advanceTimersByTimeAsync(7_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect((await p).delayMs).toBe(8_000);
  });

  it('waitFor は遅延 0 ならタイマーを使わずに解決する', async () => {
    const s = new HintReleaseScheduler('disabled');
    const st = await s.waitFor(10_000_000);
    expect(st.delayMs).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
