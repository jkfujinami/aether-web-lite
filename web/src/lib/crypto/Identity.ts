import sodium from './sodium';
import type { IIdentity, SignatureResult } from '../types';
import { SecretVault, VAULT_PARAMS, type VaultParams } from '../storage/SecretVault';

/** トリップ鍵を保存できる最小のインターフェース */
export interface SealedStore {
  getSealed(slot: string): Promise<{ sealed: any; meta?: any } | undefined>;
  saveSealed(slot: string, sealed: any, meta?: any): Promise<void>;
  deleteSealed(slot: string): Promise<void>;
}

const TRIP_SLOT = 'trip';

export class Identity implements IIdentity {
  /** セッションID（毎タブ一時的） */
  private sessionKeyPair: any;
  /** トリップ（永続的、オプション） */
  private tripKeyPair: any | null = null;

  constructor() {
    // セッション鍵ペアを自動生成
    this.sessionKeyPair = sodium.crypto_sign_keypair();
  }

  /**
   * トリップの初期化（IndexedDB から封印を読み出して解く）
   * なければ／解けなければ名無しモード（tripKeyPair = null）のまま継続。
   *
   * @param passphrase 封印時に使ったパスフレーズ。未設定なら空文字。
   * @returns 復元できたか
   */
  public async initTrip(store: SealedStore, passphrase: string = ''): Promise<boolean> {
    const record = await store.getSealed(TRIP_SLOT);
    if (!record) return false;

    const secret = SecretVault.open(record.sealed, passphrase);
    if (!secret) {
      // パスフレーズ違いか改竄。どちらであるかは区別しない。
      console.warn(`[Identity] Could not unseal trip identity (wrong passphrase or tampered).`);
      return false;
    }

    this.tripKeyPair = {
      publicKey: secret.slice(sodium.crypto_sign_SECRETKEYBYTES),
      privateKey: secret.slice(0, sodium.crypto_sign_SECRETKEYBYTES),
      keyType: 'ed25519',
    };
    console.log(`[Identity] Recovered persistent trip identity.`);
    return true;
  }

  /**
   * トリップを新規生成して封印・永続化する。
   *
   * 旧実装は秘密鍵を平文で IndexedDB に書いていた。押収されれば
   * 過去の全投稿がこのトリップで紐付く。
   */
  public async generateTrip(
    store: SealedStore,
    passphrase: string = '',
    params: VaultParams = VAULT_PARAMS,
  ): Promise<string> {
    this.tripKeyPair = sodium.crypto_sign_keypair();

    const secret = new Uint8Array(
      sodium.crypto_sign_SECRETKEYBYTES + sodium.crypto_sign_PUBLICKEYBYTES,
    );
    secret.set(this.tripKeyPair.privateKey, 0);
    secret.set(this.tripKeyPair.publicKey, sodium.crypto_sign_SECRETKEYBYTES);

    await store.saveSealed(TRIP_SLOT, SecretVault.seal(secret, passphrase, params));
    console.log(
      `[Identity] Generated and sealed new trip identity (passphrase-protected: ${passphrase.length > 0}).`,
    );
    return this.tripDisplay;
  }

  /**
   * トリップを破棄する
   */
  public async deleteTrip(store: SealedStore): Promise<void> {
    this.tripKeyPair = null;
    await store.deleteSealed(TRIP_SLOT);
    console.log(`[Identity] Deleted trip identity.`);
  }

  /** トリップが設定されているか */
  public get hasTrip(): boolean {
    return this.tripKeyPair !== null;
  }

  /**
   * セッションIDの表示文字列（8文字）
   * 公開鍵のSHA256ハッシュの先頭4バイトをBase64化
   */
  get sessionDisplay(): string {
    const hash = sodium.crypto_hash(this.sessionKeyPair.publicKey);
    return this.toBase64(hash.slice(0, 4));
  }

  /**
   * トリップの表示文字列（12文字）
   * 公開鍵のSHA256ハッシュの先頭5バイトをBase64化
   */
  get tripDisplay(): string {
    if (!this.tripKeyPair) return '';
    const hash = sodium.crypto_hash(this.tripKeyPair.publicKey);
    return '◆' + this.toBase64(hash.slice(0, 5));
  }

  /**
   * 投稿データにデジタル署名を行う
   */
  sign(postData: Uint8Array): SignatureResult {
    return {
      sessionPubkey: this.sessionKeyPair.publicKey,
      sessionSignature: sodium.crypto_sign_detached(
        postData, this.sessionKeyPair.privateKey,
      ),
      tripPubkey: this.tripKeyPair?.publicKey ?? null,
      tripSignature: this.tripKeyPair
        ? sodium.crypto_sign_detached(postData, this.tripKeyPair.privateKey)
        : null,
    };
  }

  /**
   * 署名検証
   */
  static verify(
    postData: Uint8Array,
    pubkey: Uint8Array,
    signature: Uint8Array,
  ): boolean {
    return sodium.crypto_sign_verify_detached(
      signature, postData, pubkey,
    );
  }

  private toBase64(buf: Uint8Array): string {
    return btoa(String.fromCharCode(...buf));
  }
}
