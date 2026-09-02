import { WorkerBridge } from '../worker/WorkerBridge';
import {
  POW_POLICY,
  solvePow,
  verifyPow,
  type PowCommittedHeader,
} from './PowPolicy';

/**
 * PoWEngine — Gossip パケットの PoW。
 *
 * 本家 AETHER 18.11 の訂正に従い SHA-256 を使う。旧実装は Argon2id
 * (argon2-browser) を使っていたが、これは二重に誤りだった:
 *
 *   1. 飽和条件 M ≥ 2^D において、ハッシュ単価 C は約分で消える。
 *      つまりフラッド耐性は難易度 D だけで決まり、メモリハード関数に
 *      しても耐性は 1 ビットも増えない。増えるのは正直な投稿者のコスト
 *      (実測 1146 倍) と、全ノードが払う検証コストだけ。
 *   2. 検証まで Worker に投げていたため、受信パケット 1 通ごとに
 *      postMessage の往復 + Argon2 1 回が発生した。単一 Worker が
 *      直列化点になり、攻撃者はゴミパケットを流すだけで正当なパケットの
 *      処理を詰まらせられた (head-of-line blocking)。
 *
 * 現在の構成:
 *   - 検証 (verify)  : メインスレッドで同期実行。SHA-256 1回 ≒ 1.3us。
 *   - 探索 (compute) : Worker に委譲。ここだけが重い。
 *
 * 実際の負荷上限を決めるのは PoW ではなく隣人ごとのレート制限
 * ({@link ../network/RateLimiter}) である、という本家 18.11.3 の結論も併せて実装してある。
 */
export class PoWEngine {
  /**
   * PoW 探索を Worker に委譲する。
   *
   * @returns 見つかった pow_nonce
   */
  static async compute(header: PowCommittedHeader): Promise<bigint> {
    if (header.pow_difficulty < POW_POLICY.MIN_DIFFICULTY) {
      throw new RangeError(
        `PoWEngine.compute: difficulty ${header.pow_difficulty} < MIN_DIFFICULTY ${POW_POLICY.MIN_DIFFICULTY}`,
      );
    }
    if (header.pow_difficulty > POW_POLICY.MAX_DIFFICULTY) {
      throw new RangeError(
        `PoWEngine.compute: difficulty ${header.pow_difficulty} > MAX_DIFFICULTY ${POW_POLICY.MAX_DIFFICULTY}`,
      );
    }

    // Worker が使えない環境 (SSR / テスト) では同期版にフォールバックする。
    if (typeof Worker === 'undefined') {
      return PoWEngine.computeSync(header);
    }

    const nonce = await WorkerBridge.request<string>('compute', {
      header: serializeHeader(header),
    });
    return BigInt(nonce);
  }

  /** メインスレッドで探索する。Worker が無い環境と単体テスト用。 */
  static computeSync(header: PowCommittedHeader): bigint {
    const nonce = solvePow(header);
    if (nonce === null) throw new Error('PoWEngine: PoW search exhausted');
    return nonce;
  }

  /**
   * 検証。同期・SHA-256 1回。難易度の下限/上限は {@link verifyPow} が強制する。
   */
  static verify(header: PowCommittedHeader, powNonce: number | bigint): boolean {
    return verifyPow(header, powNonce);
  }
}

/** Worker へ渡すために構造化複製可能な形へ落とす */
function serializeHeader(header: PowCommittedHeader) {
  return {
    timestamp: header.timestamp,
    zone_id: header.zone_id,
    pow_difficulty: header.pow_difficulty,
    nonce: header.nonce,
    payload: header.payload,
  };
}
