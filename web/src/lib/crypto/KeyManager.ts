import sodium from 'libsodium-wrappers';

export class KeyManager {
  /**
   * boardkey → thread_key を派生 (HMAC-SHA256)
   */
  static deriveThreadKey(boardkey: Uint8Array, threadId: string): Uint8Array {
    // 32バイトの派生鍵を生成
    return sodium.crypto_auth(
      new TextEncoder().encode(`thread:${threadId}`),
      boardkey,
    );
  }

  /**
   * thread_key → topic_hash を派生 (SHA256)
   */
  static deriveTopicHash(threadKey: Uint8Array): Uint8Array {
    return sodium.crypto_hash(threadKey).slice(0, 32);
  }

  /**
   * topic_hash → zone_id を計算
   */
  static computeZoneId(topicHash: Uint8Array, depth: number): number {
    if (depth === 0) return 0;
    const bits = (topicHash[0] << 8 | topicHash[1]) >> (16 - depth);
    return bits;
  }

  /**
   * URLフラグメントなどから取得したHex文字列をUint8Arrayに変換
   */
  static fromHex(hex: string): Uint8Array {
    const bytes = new Uint8Array(Math.ceil(hex.length / 2));
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  /**
   * Uint8ArrayをHex文字列に変換
   */
  static toHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * 新しい板の鍵を生成
   */
  static generateBoardKey(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(32));
  }

  /**
   * Base64URLをUint8Arrayに変換
   */
  static fromBase64(b64: string): Uint8Array {
    const binary = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Uint8ArrayをBase64URLに変換
   */
  static toBase64(bytes: Uint8Array): string {
    const binary = String.fromCharCode(...bytes);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  /**
   * SHA256ハッシュを計算
   */
  static cryptoHash(data: Uint8Array): Uint8Array {
    return sodium.crypto_hash(data);
  }
}
