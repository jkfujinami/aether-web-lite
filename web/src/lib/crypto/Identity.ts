import sodium from 'libsodium-wrappers';
import type { IIdentity, SignatureResult } from '../types';

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
   * トリップの初期化（IndexedDBから読み込み）
   * なければ名無しモード（tripKeyPair = null）のまま継続
   */
  public async initTrip(store: any): Promise<void> {
    const stored = await store.getTrip();
    if (stored) {
      console.log(`[Identity] Recovered persistent trip identity.`);
      this.tripKeyPair = {
        publicKey: stored.publicKey,
        privateKey: stored.privateKey,
        keyType: 'ed25519'
      };
    }
  }

  /**
   * トリップを新規生成して永続化する
   */
  public async generateTrip(store: any): Promise<string> {
    this.tripKeyPair = sodium.crypto_sign_keypair();
    await store.saveTrip(this.tripKeyPair.publicKey, this.tripKeyPair.privateKey);
    console.log(`[Identity] Generated and saved new trip identity.`);
    return this.tripDisplay;
  }

  /**
   * トリップを破棄する
   */
  public async deleteTrip(store: any): Promise<void> {
    this.tripKeyPair = null;
    await store.deleteTrip();
    console.log(`[Identity] Deleted trip identity.`);
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
