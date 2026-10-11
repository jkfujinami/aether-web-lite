import sodium from 'libsodium-wrappers-sumo';
import { concat, u64be } from '../../crypto/PowPolicy';
import {
  BLIND_TAG_SIZE,
  HINT_CIPHERTEXT_SIZE,
  HINT_NONCE_SIZE,
  HINT_PLAINTEXT_SIZE,
  HINT_INITIAL_TTL,
  HINT_VERSION,
  sealHintPow,
  type HintPacket,
} from './HintPacket';

/**
 * Hint の中身 (復号後)
 *
 * `nonce` から `mailbox_key = SHA256(nonce)` を計算して本体を取りに行く。
 * **この nonce こそが Hint の存在理由**で、これが無いと本体の在り処が
 * 誰にも (保管している当人にも) 分からない。
 */
export interface HintPayload {
  /** mailbox_key 生成用。SHA256(nonce) が本体の保管キーになる */
  nonce: Uint8Array;
  /** メッセージ識別子 */
  message_id: number;
  /** 送信時刻 (UNIX ミリ秒) */
  timestamp: number;
}

/** mailbox_key の素になる nonce の長さ */
export const MAILBOX_NONCE_SIZE = 32;

/**
 * 鍵源 (§18.4.2「鍵源だけを差し替える」)
 *
 * ```
 * 私信モード: K = SharedSecret       (X3DH で確立)
 * 公開モード: K = threadKey / boardKey (URL フラグメント由来)
 * ```
 *
 * 以降の処理はどちらも完全に同一。web-lite は公開モードなので、
 * 既存の `KeyManager.deriveThreadKey()` の出力をそのまま K として渡す。
 */

/** AEAD 用の鍵。K とは分けておく (同じ鍵を 2 用途に使わない) */
export function deriveHintKey(k: Uint8Array): Uint8Array {
  return sodium.crypto_auth(new TextEncoder().encode('aether_hint_v1'), k);
}

/**
 * blind_tag = HMAC(K, nonce)[0:4]
 *
 * 受信者は手持ちの鍵ごとにこれを計算し、一致したものだけ復号を試す。
 * 鍵を持たない観測者にとっては 4 バイトの乱数にしか見えない。
 *
 * ★ nonce ごとに変わる点が重要。固定値だと「同じ tag = 同じ宛先」として
 *   長期観測で束ねられてしまう。
 */
export function computeBlindTag(k: Uint8Array, nonce: Uint8Array): Uint8Array {
  return sodium.crypto_auth(nonce, k).slice(0, BLIND_TAG_SIZE);
}

/** 平文ペイロードの固定長エンコード (nonce32 ‖ u64be(message_id) ‖ u64be(timestamp)) */
export function encodeHintPayload(p: HintPayload): Uint8Array {
  if (p.nonce.length !== MAILBOX_NONCE_SIZE) {
    throw new RangeError(`encodeHintPayload: nonce must be ${MAILBOX_NONCE_SIZE} bytes`);
  }
  if (!Number.isSafeInteger(p.message_id) || p.message_id < 0) {
    throw new RangeError(`encodeHintPayload: invalid message_id ${p.message_id}`);
  }
  if (!Number.isSafeInteger(p.timestamp) || p.timestamp < 0) {
    throw new RangeError(`encodeHintPayload: invalid timestamp ${p.timestamp}`);
  }
  return concat([p.nonce, u64be(p.message_id), u64be(p.timestamp)]);
}

export function decodeHintPayload(bytes: Uint8Array): HintPayload | null {
  if (bytes.length !== HINT_PLAINTEXT_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const messageId = Number(view.getBigUint64(MAILBOX_NONCE_SIZE));
  const timestamp = Number(view.getBigUint64(MAILBOX_NONCE_SIZE + 8));
  if (!Number.isSafeInteger(messageId) || !Number.isSafeInteger(timestamp)) return null;
  return {
    nonce: bytes.slice(0, MAILBOX_NONCE_SIZE),
    message_id: messageId,
    timestamp,
  };
}

/**
 * Hint を組み立てる (PoW 込み)。
 *
 * @param k       板/スレッドの鍵。これを持つ者だけが復号できる
 * @param payload 中身 (mailbox_key の素になる nonce を含む)
 */
export function buildHint(
  k: Uint8Array,
  payload: HintPayload,
  opts?: {
    /**
     * ★ 相互運用ベクタの生成専用。**実運用では絶対に渡さないこと。**
     *
     * 同じ鍵で同じ nonce を使い回すと ChaCha20-Poly1305 の安全性が崩壊する
     * (鍵ストリームの再利用で平文が復元できる)。
     * ベクタが再生成のたびに変わると差分が読めないので、そこだけ固定する。
     */
    unsafeFixedNonceForVectors?: Uint8Array;
  },
): HintPacket {
  const hintNonce = opts?.unsafeFixedNonceForVectors ?? sodium.randombytes_buf(HINT_NONCE_SIZE);
  if (hintNonce.length !== HINT_NONCE_SIZE) {
    throw new RangeError(`buildHint: nonce must be ${HINT_NONCE_SIZE} bytes`);
  }
  const hintKey = deriveHintKey(k);

  const ciphertext = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
    encodeHintPayload(payload),
    null,
    null,
    hintNonce,
    hintKey,
  );

  if (ciphertext.length !== HINT_CIPHERTEXT_SIZE) {
    throw new Error(
      `buildHint: unexpected ciphertext length ${ciphertext.length} (want ${HINT_CIPHERTEXT_SIZE})`,
    );
  }

  return sealHintPow({
    version: HINT_VERSION,
    ttl: HINT_INITIAL_TTL,
    blind_tag: computeBlindTag(k, hintNonce),
    nonce: hintNonce,
    pow_nonce: 0,
    ciphertext,
  });
}

/**
 * 手持ちの鍵で Hint を開く。開けなければ null。
 *
 * blind_tag が一致しても AEAD が通るとは限らない (4 バイトなので
 * 2^-32 で偶然一致する)。**必ず復号まで通してから受理すること。**
 */
export function openHint(k: Uint8Array, h: HintPacket): HintPayload | null {
  const expected = computeBlindTag(k, h.nonce);
  if (!sodium.memcmp(expected, h.blind_tag)) return null;

  try {
    const plaintext = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
      null,
      h.ciphertext,
      null,
      h.nonce,
      deriveHintKey(k),
    );
    return decodeHintPayload(plaintext);
  } catch {
    // AEAD 失敗 = 自分宛てではない (blind_tag の偶然一致)
    return null;
  }
}

/** payload.nonce → 本体の保管キー */
export function mailboxKeyFromNonce(nonce: Uint8Array): Uint8Array {
  if (nonce.length !== MAILBOX_NONCE_SIZE) {
    throw new RangeError(`mailboxKeyFromNonce: nonce must be ${MAILBOX_NONCE_SIZE} bytes`);
  }
  return sodium.crypto_hash_sha256(nonce);
}

/** 新しい mailbox_key を作る (発信側)。nonce は Hint で配る。 */
export function newMailboxSlot(): { nonce: Uint8Array; mailboxKey: Uint8Array } {
  const nonce = sodium.randombytes_buf(MAILBOX_NONCE_SIZE);
  return { nonce, mailboxKey: mailboxKeyFromNonce(nonce) };
}
