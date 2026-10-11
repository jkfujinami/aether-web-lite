import sodium from 'libsodium-wrappers-sumo';
import { Encoding } from '../../common/Encoding';
import { concat, u32be, u64be, meetsDifficulty, toBytes } from '../../crypto/PowPolicy';

/**
 * Hint パケット (Schrödinger Mailbox の索引)
 *
 * ★ 何のためにあるか
 *
 * 本体は `mailbox_key = SHA256(random nonce)` という**ランダムな鍵**の下に
 * 保管される。ランダムなので、板やスレッドから計算で導くことができない。
 * その nonce を「鍵を持つ者だけが読める形」で全員に配るのが Hint である。
 *
 *   - 保管ノード → 何を持っているか原理的に分からない (mailbox_key が無意味な乱数)
 *   - 中継ノード → Hint は不透明な数十バイト。誰宛てかも中身も分からない
 *   - 受信者    → 手持ちの鍵で試行復号し、当たったものだけ nonce を得る
 *
 * ★ ワイヤに載るもの (すべて鍵無しでは意味を持たない)
 *
 * ```
 * version    : u8
 * ttl        : u8          中継で減る
 * blind_tag  : 4 bytes     HMAC(K, nonce)[0:4]。鍵が無ければ乱数
 * nonce      : 12 bytes    ChaCha20-Poly1305 の nonce
 * pow_nonce  : u64         フラッド対策の PoW 解
 * ciphertext : bytes       末尾 16 バイトが Poly1305 タグ
 * ```
 */
export interface HintPacket {
  version: number;
  ttl: number;
  blind_tag: Uint8Array;
  nonce: Uint8Array;
  pow_nonce: number;
  ciphertext: Uint8Array;
}

export const HINT_VERSION = 1;

/** blind_tag の長さ。短いほど帯域は減るが、試行復号の空振りが増える。 */
export const BLIND_TAG_SIZE = 4;
/** ChaCha20-Poly1305 (IETF) の nonce 長 */
export const HINT_NONCE_SIZE = 12;
/** 復号後ペイロードの固定長: nonce(32) + message_id(8) + timestamp(8) */
export const HINT_PLAINTEXT_SIZE = 48;
/** ciphertext = 平文 + Poly1305 タグ */
export const HINT_CIPHERTEXT_SIZE = HINT_PLAINTEXT_SIZE + 16;

/** 初期 TTL。Gossip の hop_count とは別物 (こちらは Hint 中継の寿命) */
export const HINT_INITIAL_TTL = 8;

/**
 * Hint の PoW 難易度。
 *
 * Hint は投稿ごとに**全ノードへ**配られるため、ここが唯一のフラッド防壁になる。
 * 高すぎると投稿のたびに体感が悪化するので、数ミリ秒に収まる範囲で置く。
 * Rust 側 (aether-cache) の HINT_POW_DIFFICULTY と必ず一致させること。
 */
export const HINT_POW_DIFFICULTY = 12;

/** プリイメージのドメイン分離子。ちょうど 16 バイト。 */
export const HINT_DOMAIN = new Uint8Array([
  0x41, 0x45, 0x54, 0x48, 0x45, 0x52, 0x2f, 0x76, // "AETHER/v"
  0x33, 0x2f, 0x68, 0x69, 0x6e, 0x74, 0x5f, 0x5f, // "3/hint__"
]);

/**
 * PoW と id() がコミットするバイト列。
 *
 * ★ ttl と pow_nonce を意図的に除外している。
 *
 *   - `ttl` は中継のたびに変わる。含めると同一 Hint が別物として扱われ、
 *     SeenCache をすり抜けて無限に再フラッドできる
 *   - `pow_nonce` は探索変数。含めると、攻撃者が同じ中身に対して
 *     別の有効な解を見つけるだけで「別の Hint」として再フラッドできる
 */
export function hintPreimage(h: HintPacket): Uint8Array {
  const blindTag = toBytes(h.blind_tag);
  const nonce = toBytes(h.nonce);
  const ciphertext = toBytes(h.ciphertext);

  if (!Number.isInteger(h.version) || h.version < 0 || h.version > 255) {
    throw new RangeError(`hintPreimage: invalid version ${h.version}`);
  }
  if (blindTag.length !== BLIND_TAG_SIZE) {
    throw new RangeError(`hintPreimage: blind_tag must be ${BLIND_TAG_SIZE} bytes`);
  }
  if (nonce.length !== HINT_NONCE_SIZE) {
    throw new RangeError(`hintPreimage: nonce must be ${HINT_NONCE_SIZE} bytes`);
  }
  if (ciphertext.length > 0xffffffff) {
    throw new RangeError('hintPreimage: ciphertext too long');
  }

  return concat([
    HINT_DOMAIN,
    Uint8Array.of(h.version),
    blindTag,
    nonce,
    u32be(ciphertext.length),
    ciphertext,
  ]);
}

/** 重複排除用の識別子 (hex)。SeenCache のキーに使う。 */
export function hintId(h: HintPacket): string {
  return Encoding.toHex(sodium.crypto_hash_sha256(hintPreimage(h)));
}

/** PoW ハッシュ: SHA-256(preimage ‖ pow_nonce_be_u64) */
export function hintPowHash(preimage: Uint8Array, powNonce: number): Uint8Array {
  return sodium.crypto_hash_sha256(concat([preimage, u64be(powNonce)]));
}

/** PoW が難易度を満たすか。難易度 0 なら常に true。 */
export function verifyHintPow(h: HintPacket, difficulty = HINT_POW_DIFFICULTY): boolean {
  if (difficulty <= 0) return true;
  if (!Number.isSafeInteger(h.pow_nonce) || h.pow_nonce < 0) return false;
  try {
    return meetsDifficulty(hintPowHash(hintPreimage(h), h.pow_nonce), difficulty);
  } catch {
    return false;
  }
}

/**
 * 放流前に PoW を解いて pow_nonce を確定する。
 * preimage を 1 度だけ作って回すので、難易度 12 なら数ミリ秒で終わる。
 */
export function sealHintPow(h: HintPacket, difficulty = HINT_POW_DIFFICULTY): HintPacket {
  if (difficulty <= 0) return { ...h, pow_nonce: 0 };
  const preimage = hintPreimage(h);
  const MAX_ITER = 1 << 24;
  for (let nonce = 0; nonce < MAX_ITER; nonce++) {
    if (meetsDifficulty(hintPowHash(preimage, nonce), difficulty)) {
      return { ...h, pow_nonce: nonce };
    }
  }
  throw new Error(`sealHintPow: no solution within ${MAX_ITER} iterations`);
}

/** TTL を 1 減らす。0 になったら false (破棄) */
export function decrementHintTtl(h: HintPacket): HintPacket | null {
  if (h.ttl <= 0) return null;
  return { ...h, ttl: h.ttl - 1 };
}

/**
 * 受信したオブジェクトが Hint の形をしているか。
 *
 * ワイヤから来るものは任意の JSON/MsgPack なので、
 * 触る前にここで形を確定させる (壊れた入力で例外を投げない)。
 */
export function parseHintPacket(raw: any): HintPacket | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.version !== HINT_VERSION) return null;
  if (!Number.isInteger(raw.ttl) || raw.ttl < 0 || raw.ttl > 255) return null;
  if (!Number.isSafeInteger(raw.pow_nonce) || raw.pow_nonce < 0) return null;

  let blindTag: Uint8Array;
  let nonce: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    blindTag = toBytes(raw.blind_tag);
    nonce = toBytes(raw.nonce);
    ciphertext = toBytes(raw.ciphertext);
  } catch {
    return null;
  }

  if (blindTag.length !== BLIND_TAG_SIZE) return null;
  if (nonce.length !== HINT_NONCE_SIZE) return null;
  // 長さを固定しておくと、サイズだけで中身を推測される余地が消える
  if (ciphertext.length !== HINT_CIPHERTEXT_SIZE) return null;

  return {
    version: raw.version,
    ttl: raw.ttl,
    blind_tag: blindTag,
    nonce,
    pow_nonce: raw.pow_nonce,
    ciphertext,
  };
}

/**
 * 保管用のバイト列表現。
 *
 * 保持者は Hint を**復号できない**が、バイト列としてそのまま再放流できる
 * 必要がある (§18.3-A)。そのために本体と一緒に保管する。
 *
 * 形式: version(1) ‖ ttl(1) ‖ blind_tag(4) ‖ nonce(12) ‖ pow_nonce(8, BE) ‖ ciphertext
 * ciphertext は固定長なので長さフィールドは要らない。
 */
export function encodeHint(h: HintPacket): Uint8Array {
  const out = new Uint8Array(1 + 1 + BLIND_TAG_SIZE + HINT_NONCE_SIZE + 8 + HINT_CIPHERTEXT_SIZE);
  let o = 0;
  out[o++] = h.version;
  out[o++] = h.ttl;
  out.set(h.blind_tag, o); o += BLIND_TAG_SIZE;
  out.set(h.nonce, o); o += HINT_NONCE_SIZE;
  new DataView(out.buffer, out.byteOffset).setBigUint64(o, BigInt(h.pow_nonce)); o += 8;
  out.set(h.ciphertext, o);
  return out;
}

export const ENCODED_HINT_SIZE =
  1 + 1 + BLIND_TAG_SIZE + HINT_NONCE_SIZE + 8 + HINT_CIPHERTEXT_SIZE;

export function decodeHint(bytes: Uint8Array): HintPacket | null {
  if (bytes.length !== ENCODED_HINT_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const version = bytes[o++];
  const ttl = bytes[o++];
  const blindTag = bytes.slice(o, o + BLIND_TAG_SIZE); o += BLIND_TAG_SIZE;
  const nonce = bytes.slice(o, o + HINT_NONCE_SIZE); o += HINT_NONCE_SIZE;
  const powNonce = Number(view.getBigUint64(o)); o += 8;
  const ciphertext = bytes.slice(o);
  if (!Number.isSafeInteger(powNonce)) return null;
  return parseHintPacket({
    version, ttl, blind_tag: blindTag, nonce, pow_nonce: powNonce, ciphertext,
  });
}
