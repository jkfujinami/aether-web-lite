import sodium from '../crypto/sodium';

/**
 * SecretVault — 端末に置く秘密鍵の封印。
 *
 * 旧実装は `IndexedDBStore.saveTrip(publicKey, privateKey)` で
 * Ed25519 の秘密鍵を *生のまま* IndexedDB に書いていた。端末を押収されれば
 * トリップ鍵がそのまま出てくるので、過去の全投稿がその人物に紐付く。
 *
 * 本家 AETHER の脅威モデル (21 §1) は「監視ノード → IP 特定 → ISP 照会 →
 * 押収 → フォレンジック」であり、押収耐性は後段の要である。
 * (完全な前方秘匿 = X3DH は本家でも未実装の大物なので、ここでは
 *  「保存された鍵が平文で読めない」ところまでを担保する。)
 *
 * 構成:
 *   KEK        = Argon2id(passphrase, salt)          … 本家 Part 6.6 と同じ用途
 *   ciphertext = XSalsa20-Poly1305(secret, KEK)      … crypto_secretbox
 *
 * パスフレーズ未設定でも同じ経路を通し、`protected: false` を記録する。
 * 「保護されているつもりで保護されていない」状態を型と値で区別できるように
 * するのが目的で、空パスフレーズの封印自体に秘匿性は無い。
 */

export interface VaultParams {
  /** Argon2id opslimit */
  opsLimit: number;
  /** Argon2id memlimit (bytes) */
  memLimit: number;
}

/**
 * 本家 Part 6.6 の KeyStore KEK と同じ強度。アンロック時に 1 回だけ走る。
 * NodeId PoW (毎回の検証で走る) とは要求が違うので、こちらは重くてよい。
 */
export const VAULT_PARAMS: VaultParams = {
  opsLimit: 3,
  memLimit: 64 * 1024 * 1024,
};

/** テスト用の軽量パラメータ */
export const VAULT_PARAMS_FAST: VaultParams = {
  opsLimit: 1,
  memLimit: 8192,
};

export interface SealedSecret {
  /** 封印形式のバージョン */
  v: 1;
  /** この封印が実際にパスフレーズで守られているか */
  protected: boolean;
  salt: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  opsLimit: number;
  memLimit: number;
}

export class SecretVault {
  /**
   * 秘密を封印する。
   *
   * @param passphrase 空文字なら「保護なし」として記録する
   */
  static seal(
    secret: Uint8Array,
    passphrase: string,
    params: VaultParams = VAULT_PARAMS,
  ): SealedSecret {
    const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const key = SecretVault.deriveKey(passphrase, salt, params);

    return {
      v: 1,
      protected: passphrase.length > 0,
      salt,
      nonce,
      ciphertext: sodium.crypto_secretbox_easy(secret, nonce, key),
      opsLimit: params.opsLimit,
      memLimit: params.memLimit,
    };
  }

  /**
   * 封印を解く。パスフレーズ違い・改竄はいずれも null を返す
   * (どちらであるかを攻撃者に教えない)。
   */
  static open(sealed: SealedSecret, passphrase: string): Uint8Array | null {
    if (!sealed || sealed.v !== 1) return null;
    try {
      const key = SecretVault.deriveKey(passphrase, sealed.salt, {
        opsLimit: sealed.opsLimit,
        memLimit: sealed.memLimit,
      });
      return sodium.crypto_secretbox_open_easy(sealed.ciphertext, sealed.nonce, key);
    } catch {
      return null;
    }
  }

  private static deriveKey(passphrase: string, salt: Uint8Array, params: VaultParams): Uint8Array {
    return sodium.crypto_pwhash(
      sodium.crypto_secretbox_KEYBYTES,
      passphrase,
      salt,
      params.opsLimit,
      params.memLimit,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
  }
}
