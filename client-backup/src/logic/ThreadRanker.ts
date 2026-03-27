/**
 * ThreadRanker
 * スレッドの「熱量(PoW)」と「重力(経過時間)」から、
 * Hacker News / Reddit 流のランキングスコアを算出する。
 */
export class ThreadRanker {
  // 重力定数 (1.8 は標準的な情報の沈下速度)
  private static readonly GRAVITY = 1.8;
  // スコアが無限大になるのを防ぐオフセット(時間単位)
  private static readonly TIME_OFFSET_HOURS = 2;
  // スレ立て自体の基礎難易度 (ベースの勢い)
  private static readonly BASE_SCORE = 16;

  /**
   * スレッドのランキングスコアを算出する
   * @param maxCumulativePow スレッド内での最大累積難易度
   * @param createdAtMs スレッドの作成日時(ミリ秒)
   */
  static calculateScore(maxCumulativePow: number, createdAtMs: number): number {
    const now = Date.now();
    // 経過時間を時間(hours)単位に変換
    const hoursSinceCreated = (now - createdAtMs) / (1000 * 60 * 60);

    // 数式: Score = (PoW + Base) / (Hours + Offset)^G
    const numerator = maxCumulativePow + this.BASE_SCORE;
    const denominator = Math.pow(hoursSinceCreated + this.TIME_OFFSET_HOURS, this.GRAVITY);

    return numerator / denominator;
  }

  /**
   * スレッドリストをスコア順にソートする
   */
  static sortThreadsByScore<T extends { max_pow: number; created_at: number }>(threads: T[]): T[] {
    return [...threads].sort((a, b) => {
      const scoreA = this.calculateScore(a.max_pow, a.created_at);
      const scoreB = this.calculateScore(b.max_pow, b.created_at);
      return scoreB - scoreA; // スコア降順
    });
  }
}
