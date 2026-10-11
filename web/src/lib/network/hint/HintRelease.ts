import { createLogger } from '../../common/Logger';

const log = createLogger('net.release');

/**
 * Hint 放流の時間分離 (§18.4.5)
 *
 * ★ 何を守っているのか
 *
 * 本体 PUT と Hint 放流が同時に出ると、両方を観測できる位置にいる者に
 * こう紐づけられる:
 *
 * ```
 * ガードが見るもの : 「この IP が時刻 T まで D 秒間アップロードしていた」
 * 全ノードが見るもの: 「時刻 T+ε に Hint が現れた」
 * ```
 *
 * **Hint の出現時刻は Broadcast Veil で全員に見える。**
 * ε が小さく D が特徴的なら、出口を押さえなくても紐づく。
 * Hint の中身が不透明でも、この相関は中身を必要としない。
 *
 * ★ 小さい送信には要らない
 *
 * この相関は PUT が観測可能なエンベロープを作る場合にしか成立しない。
 * 定常の中継トラフィックより十分小さい送信は、自分が常時流している雑音に沈む。
 *
 * ```
 * 定常中継 1Mbps = 125 KB/s → 埋もれる上限 約 1MB (8秒ぶん)
 * チャット1通 約10KB  → 中継 0.08秒ぶん。遅延不要
 * 4GB ファイル        → 数時間ぶん。遅延が必要
 * ```
 *
 * ★ 中継していないと何も埋もれない
 *
 * `relayThroughputBps = 0` なら noise floor も 0 になり、どんな小さな送信も
 * 遅延対象になる。**中継しないほど自分の送信が目立つ**という関係が式にそのまま出る。
 */

export type ReleaseMode = 'disabled' | 'adaptive' | 'strict';

export interface ReleaseStatus {
  mode: ReleaseMode;
  /** 実際に待つ時間 (ms) */
  delayMs: number;
  /** なぜその待ち時間になったか。匿名性の強度が黙って変わるのが一番まずい。 */
  reason: string;
  /** 観測した Hint レート (件/秒)。Broadcast Veil のおかげでローカルで直接測れる */
  observedHintRate: number;
  /** 観測した中継スループット (bytes/秒) */
  relayThroughputBps: number;
  /** その窓で期待できる匿名集合の大きさ */
  expectedAnonymitySet: number;
  /** 目標に届いているか */
  targetMet: boolean;
}

export const RELEASE_CONFIG = {
  /** 目標とする匿名集合の件数 */
  TARGET_ANONYMITY_SET: 8,
  /**
   * ★ これを下回るなら遅延しない。
   *
   * 素朴に実装すると「網が小さいほど長く待つ」という完全に逆の挙動になる。
   * 観測レートが 0 なら必要窓は無限大に発散し、上限まで待たされる。
   * **しかも待っても匿名集合は生まれない。**
   * 利益ゼロのコストを、最も離脱されやすい立ち上げ期に払わせることになり、
   * 網が育つ経路そのものを塞ぐ。
   */
  MIN_MEASURABLE_SET: 2,
  /** エンベロープを隠すのに必要な、送出所要時間に対する倍率 */
  ENVELOPE_FACTOR: 10,
  /** 待てる下限 (これ以下には切り詰めない) */
  MIN_PATIENCE_MS: 60_000,
  /**
   * 雑音に沈む判定の窓 (秒)。
   * 定常中継 8 秒ぶんまでの送信は自分の雑音に埋もれるとみなす。
   */
  NOISE_WINDOW_SEC: 8,
  /** レート計測の窓 (ms) */
  RATE_WINDOW_MS: 5 * 60 * 1000,
} as const;

/**
 * Hint 放流の待ち時間を決める。
 *
 * 観測量から逆算する (「数分〜数十分」のような根拠のない値は使わない)。
 */
export class HintReleaseScheduler {
  private hintTimes: number[] = [];
  private relayBytes: Array<{ at: number; bytes: number }> = [];

  constructor(private mode: ReleaseMode = 'adaptive') {}

  public setMode(mode: ReleaseMode): void {
    this.mode = mode;
    log.info(`release mode = ${mode}`);
  }

  public getMode(): ReleaseMode {
    return this.mode;
  }

  /** Hint を 1 件観測した。Broadcast Veil により全 Hint が自分に届く。 */
  public noteHintSeen(now: number = Date.now()): void {
    this.hintTimes.push(now);
    this.prune(now);
  }

  /** 中継したバイト数。自分の雑音の量を測る。 */
  public noteRelayBytes(bytes: number, now: number = Date.now()): void {
    if (bytes <= 0) return;
    this.relayBytes.push({ at: now, bytes });
    this.prune(now);
  }

  private prune(now: number): void {
    const cutoff = now - RELEASE_CONFIG.RATE_WINDOW_MS;
    while (this.hintTimes.length > 0 && this.hintTimes[0] < cutoff) this.hintTimes.shift();
    while (this.relayBytes.length > 0 && this.relayBytes[0].at < cutoff) this.relayBytes.shift();
  }

  /** 観測 Hint レート (件/秒) */
  public hintRate(now: number = Date.now()): number {
    this.prune(now);
    return this.hintTimes.length / (RELEASE_CONFIG.RATE_WINDOW_MS / 1000);
  }

  /** 観測中継スループット (bytes/秒) */
  public relayThroughputBps(now: number = Date.now()): number {
    this.prune(now);
    const total = this.relayBytes.reduce((a, r) => a + r.bytes, 0);
    return total / (RELEASE_CONFIG.RATE_WINDOW_MS / 1000);
  }

  /**
   * この大きさの本体を出すときの待ち時間を決める。
   *
   * ```
   * 匿名集合から  : W1 = 目標件数 / 観測 Hint レート
   * エンベロープから: W2 = ENVELOPE_FACTOR × 送出所要時間
   * 待てる上限    : patience = max(MIN_PATIENCE, 2 × 送出所要時間)
   * W = min( max(W1, W2), patience )
   * ```
   */
  public plan(payloadBytes: number, now: number = Date.now()): ReleaseStatus {
    const rate = this.hintRate(now);
    const throughput = this.relayThroughputBps(now);

    const base = (delayMs: number, reason: string): ReleaseStatus => {
      const set = (delayMs / 1000) * rate;
      return {
        mode: this.mode,
        delayMs: Math.max(0, Math.round(delayMs)),
        reason,
        observedHintRate: rate,
        relayThroughputBps: throughput,
        expectedAnonymitySet: set,
        targetMet: set >= RELEASE_CONFIG.TARGET_ANONYMITY_SET,
      };
    };

    if (this.mode === 'disabled') {
      return base(0, 'mode=disabled');
    }

    // 自分の雑音に沈む送信は、そもそもエンベロープを作らない。
    // 中継していない (throughput 0) なら noise floor も 0 で、何も沈まない。
    const noiseFloorBytes = throughput * RELEASE_CONFIG.NOISE_WINDOW_SEC;
    if (payloadBytes <= noiseFloorBytes) {
      return base(0, `sinks into relay noise (${Math.round(noiseFloorBytes)}B floor)`);
    }

    const sendSec = throughput > 0 ? payloadBytes / throughput : 0;
    const fromEnvelopeSec = RELEASE_CONFIG.ENVELOPE_FACTOR * sendSec;
    const fromSetSec = rate > 0 ? RELEASE_CONFIG.TARGET_ANONYMITY_SET / rate : Infinity;
    const patienceSec = Math.max(RELEASE_CONFIG.MIN_PATIENCE_MS / 1000, 2 * sendSec);

    const wantedSec = Math.max(fromEnvelopeSec, Number.isFinite(fromSetSec) ? fromSetSec : 0);
    const windowSec = Math.min(wantedSec, patienceSec);
    const reachableSet = windowSec * rate;

    // ★ ブートストラップ期: 待って得られる匿名集合が測定可能な水準に
    //   達しないなら遅延しない。待つ意味が無いコストを立ち上げ期に払わせない。
    if (this.mode === 'adaptive' && reachableSet < RELEASE_CONFIG.MIN_MEASURABLE_SET) {
      return base(
        0,
        `anonymity set unreachable (${reachableSet.toFixed(2)} < ${RELEASE_CONFIG.MIN_MEASURABLE_SET}); ` +
          `network too small to hide in`,
      );
    }

    const capped = windowSec < wantedSec;
    return base(
      windowSec * 1000,
      capped ? `capped by patience (${patienceSec.toFixed(0)}s)` : 'window from observed rate',
    );
  }

  /** 計画した時間だけ待つ */
  public async waitFor(payloadBytes: number): Promise<ReleaseStatus> {
    const status = this.plan(payloadBytes);
    log.debug(
      () =>
        `hint release: ${status.delayMs}ms (${status.reason}) ` +
        `set=${status.expectedAnonymitySet.toFixed(1)} rate=${status.observedHintRate.toFixed(3)}/s`,
    );
    if (status.delayMs > 0) {
      await new Promise(r => setTimeout(r, status.delayMs));
    }
    return status;
  }
}
