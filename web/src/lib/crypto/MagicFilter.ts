import sodium from 'libsodium-wrappers';

export class MagicFilter {
  private static readonly MAGIC = 0x41455448; // "AETH" (Big Endian uint32)

  /**
   * Broadcast Veil用の高速スクリーニング
   * 暗号文の先頭4バイトを部分復号して、マジックバイトが一致するか判定する。
   * これにより、他スレッドの無関係な大量パケットをミリ秒未満で弾ける。
   *
   * @returns true なら自分宛ての可能性大（そのままフル復号へ）
   *          false なら確実に無関係（スキップ）
   */
  static quickCheck(
    threadKey: Uint8Array,
    ciphertext: Uint8Array,
    nonce: Uint8Array,
  ): boolean {
    if (ciphertext.length < 4) return false;

    try {
      // AEAD ChaCha20-Poly1305 IETF (RFC 8439) のキーストリームを再現する。
      // AEAD では counter=0 は Poly1305 認証鍵の導出に予約され、平文暗号化は
      // counter=1 のブロックから開始する。よって ic=1 で同じキーストリームを得る。
      const keystream = sodium.crypto_stream_chacha20_ietf_xor_ic(
        new Uint8Array(4), // 4 bytes of zeroes
        nonce,
        1,                 // initial counter (skip Poly1305 OTK block)
        threadKey,
      );

      // キーストリームと暗号文をXORして元の平文を部分復元
      const magic =
        ((ciphertext[0] ^ keystream[0]) << 24) |
        ((ciphertext[1] ^ keystream[1]) << 16) |
        ((ciphertext[2] ^ keystream[2]) << 8)  |
        ((ciphertext[3] ^ keystream[3]));

      // JavaScriptのビット演算は符号付き32bitなので、論理右シフトで符号なし化する
      return (magic >>> 0) === this.MAGIC;
    } catch {
      // fail-open: keystream generation failed, let full AEAD decide
      return true;
    }
  }
}
