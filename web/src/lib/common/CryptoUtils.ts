export class CryptoUtils {
  /**
   * ランダムなID（英数字の文字列）を生成
   * @param length 指定がない場合は10文字
   */
  static generateId(length: number = 10): string {
    return Math.random().toString(36).substring(2, 2 + length);
  }

  /**
   * より強力な暗号学的に安全なランダムバイトを生成
   */
  static randomBytes(length: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(length));
  }

  /**
   * Uint8Array から 16進数文字列を生成（ Encoding との重複だが便宜上ここに置くこともあるが、Encoding に委譲する）
   */
}
