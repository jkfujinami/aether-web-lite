import sodium from 'libsodium-wrappers';
import type { ICryptoEngine, EncryptedPayload } from '../types';

export class CryptoEngine implements ICryptoEngine {
  private static readonly MAGIC = new Uint8Array([0x41, 0x45, 0x54, 0x48]); // "AETH"
  private static readonly NONCE_SIZE = 12; // IETF ChaCha20-Poly1305 nonce

  /**
   * 静的・インスタンス両方から呼び出せるように実装
   */
  public encrypt(threadKey: Uint8Array, innerPayload: Uint8Array): EncryptedPayload {
    return CryptoEngine.encrypt(threadKey, innerPayload);
  }

  public decrypt(threadKey: Uint8Array, encrypted: EncryptedPayload): Uint8Array | null {
    return CryptoEngine.decrypt(threadKey, encrypted);
  }

  /**
   * 暗号化（静的版 - 既存コードとの互換性用）
   */
  static encrypt(
    threadKey: Uint8Array,
    innerPayload: Uint8Array,
  ): EncryptedPayload {
    // マジックバイトを先頭に付与
    const plaintext = new Uint8Array(4 + innerPayload.length);
    plaintext.set(CryptoEngine.MAGIC, 0);
    plaintext.set(innerPayload, 4);

    // ランダムnonce生成
    const nonce = sodium.randombytes_buf(CryptoEngine.NONCE_SIZE);

    // AEAD暗号化
    const ciphertext = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
      plaintext,
      null,
      null,
      nonce,
      threadKey,
    );

    return { ciphertext, nonce };
  }

  /**
   * 復号（静的版）
   */
  static decrypt(
    threadKey: Uint8Array,
    encrypted: EncryptedPayload,
  ): Uint8Array | null {
    try {
      const plaintext = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
        null,       // nsec
        encrypted.ciphertext,
        null,       // additional data
        encrypted.nonce,
        threadKey,
      );

      // マジックバイト検証
      if (plaintext.length < 4) return null;
      if (plaintext[0] !== 0x41 || plaintext[1] !== 0x45 ||
          plaintext[2] !== 0x54 || plaintext[3] !== 0x48) return null;

      // マジックバイトを除去して純粋なペイロードを返す
      return plaintext.slice(4);
    } catch {
      return null;
    }
  }
}
