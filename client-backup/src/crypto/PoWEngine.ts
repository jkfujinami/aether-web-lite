import { WorkerBridge } from '../worker/WorkerBridge';

export class PoWEngine {
  // スパム・ボットを排除し、並列計算を無力化するためのメモリハード関数
  static readonly PARAMS = {
    type: 2, // Argon2id (Must match worker logic)
    mem: 1024,        // 1MB メモリ (テスト用に少なめ)
    time: 1,          // 1イテレーション
    parallelism: 1,
    hashLen: 32,
  };

  /**
   * PoW計算: Worker に委託して、計算完了まで Promise を返す。
   */
  static async compute(
    payload: Uint8Array,
    difficulty: number,
  ): Promise<bigint> {
    if (difficulty === 0) return 0n;

    return await WorkerBridge.request('compute', {
      payload,
      difficulty,
      params: this.PARAMS
    });
  }

  /**
   * 受信側の検証ロジック (Worker に委託)
   */
  static async verify(
    payload: Uint8Array,
    nonce: bigint,
    difficulty: number,
  ): Promise<boolean> {
    if (difficulty === 0) return true;

    return await WorkerBridge.request('verify', {
      payload,
      nonce,
      difficulty,
      params: this.PARAMS
    });
  }
}
