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

    // ChaCha20のキーストリーム先頭4バイトを生成
    // JS APIではゼロ埋め配列をXORすることでキーストリームを得る
    const keystream = sodium.crypto_stream_chacha20_ietf_xor(
      new Uint8Array(4), // 4 bytes of zeroes
      nonce,
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
  }
}
