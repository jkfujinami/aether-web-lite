import sodium from './sodium';
import { Encoding } from '../common/Encoding';

/**
 * PowPolicy — Gossip パケットの PoW を「申告値」ではなく「構造」に束縛する。
 *
 * 旧実装の欠陥:
 *   1. 受信側が packet.pow_difficulty をそのまま信用していたため、
 *      pow_difficulty=0 を書くだけで PoW 検証を完全にバイパスできた。
 *   2. PoW が ciphertext のみを覆っていたため、timestamp を現在時刻に
 *      書き換えるだけで PoW を再計算せずに再放流でき、SeenCache の TTL
 *      (15分) を超えて無限リプレイが成立した。
 *
 * 対策:
 *   - MIN_DIFFICULTY 未満のパケットはネットワーク全体で拒否する。
 *   - PoW の対象を「可変でないヘッダ全体」に広げる (timestamp / zone_id /
 *     pow_difficulty / nonce / payload)。hop_count は中継で正当に変化する
 *     ため意図的に除外する。
 *   - packet_id を同じプリイメージのハッシュとして定義することで、
 *     コミット済みフィールドを1ビットでも変えれば packet_id が変わり、
 *     かつ PoW の再計算が必要になる (CHK: Content Hash Key)。
 *
 * 本家 AETHER の 18.11「PoW のハッシュ関数選択（訂正）」に従い、
 * ハッシュ関数は SHA-256 を使う。全ノードが全パケットを検証するため、
 * 検証コストは限界まで軽くする必要がある。メモリハード関数 (Argon2id) は
 * フラッド耐性を 1 ビットも増やさず、正直な利用者のコストだけを 1146 倍にする。
 * Argon2id は検証頻度の低い NodeId PoW ({@link NodeIdentity}) の担当。
 */
export const POW_POLICY = {
  /**
   * ネットワークが受理する最小難易度。
   * DifficultyEstimator.MIN_DIFFICULTY と一致させること。
   */
  MIN_DIFFICULTY: 8,

  /** 上限。これを超える申告は異常値として拒否する (検証は常に1ハッシュなので実害はないが、送信側の暴走を弾く) */
  MAX_DIFFICULTY: 32,

  /** ペイロード上限 (bytes) */
  MAX_PAYLOAD_SIZE: 2 * 1024,

  /** AEAD nonce 長 (ChaCha20-Poly1305 IETF) */
  NONCE_SIZE: 12,

  /** 許容する時刻ドリフト (ms)。SeenCache の TTL と揃える二重防御 */
  MAX_TIME_DRIFT: 15 * 60 * 1000,

  /** 中継ホップ数の上限 */
  MAX_HOP_COUNT: 30,
} as const;

/** プリイメージのドメイン分離子。ちょうど 16 バイト。 */
export const GOSSIP_DOMAIN = new Uint8Array([
  0x41, 0x45, 0x54, 0x48, 0x45, 0x52, 0x2f, 0x76, // "AETHER/v"
  0x33, 0x2f, 0x67, 0x6f, 0x73, 0x73, 0x69, 0x70, // "3/gossip"
]);

/**
 * PoW と packet_id がコミットする不変フィールド群。
 * hop_count と pow_nonce は含まない (前者は中継で変化し、後者は探索変数)。
 */
export interface PowCommittedHeader {
  timestamp: number;
  zone_id: number;
  pow_difficulty: number;
  nonce: Uint8Array;
  payload: Uint8Array;
}

function u64be(value: number | bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, BigInt(value), false);
  return buf;
}

function u32be(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value >>> 0, false);
  return buf;
}

function u16be(value: number): Uint8Array {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, value & 0xffff, false);
  return buf;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * 正準プリイメージを組み立てる。
 *
 * レイアウト (すべてビッグエンディアン):
 *   domain          16 bytes
 *   timestamp        8 bytes  u64
 *   zone_id          4 bytes  u32
 *   pow_difficulty   1 byte   u8
 *   nonce_len        2 bytes  u16
 *   nonce            nonce_len bytes
 *   payload_len      4 bytes  u32
 *   payload          payload_len bytes
 *
 * 長さ前置きにより、フィールド境界を動かした異なる入力が同じバイト列に
 * 潰れること (length-extension 型の曖昧さ) を防ぐ。
 */
export function powPreimage(header: PowCommittedHeader): Uint8Array {
  const nonce = toBytes(header.nonce);
  const payload = toBytes(header.payload);

  if (!Number.isSafeInteger(header.timestamp) || header.timestamp < 0) {
    throw new RangeError(`powPreimage: invalid timestamp ${header.timestamp}`);
  }
  if (!Number.isInteger(header.zone_id) || header.zone_id < 0 || header.zone_id > 0xffffffff) {
    throw new RangeError(`powPreimage: invalid zone_id ${header.zone_id}`);
  }
  if (!Number.isInteger(header.pow_difficulty) || header.pow_difficulty < 0 || header.pow_difficulty > 255) {
    throw new RangeError(`powPreimage: invalid pow_difficulty ${header.pow_difficulty}`);
  }
  if (nonce.length > 0xffff) throw new RangeError('powPreimage: nonce too long');
  if (payload.length > 0xffffffff) throw new RangeError('powPreimage: payload too long');

  return concat([
    GOSSIP_DOMAIN,
    u64be(header.timestamp),
    u32be(header.zone_id),
    Uint8Array.of(header.pow_difficulty),
    u16be(nonce.length),
    nonce,
    u32be(payload.length),
    payload,
  ]);
}

/**
 * PoW ハッシュ: SHA-256(preimage ‖ pow_nonce_be_u64)
 */
export function powHash(preimage: Uint8Array, powNonce: number | bigint): Uint8Array {
  return sodium.crypto_hash_sha256(concat([preimage, u64be(powNonce)]));
}

/**
 * ハッシュの先頭ゼロビット数が difficulty 以上かを判定する。
 */
export function meetsDifficulty(hash: Uint8Array, difficulty: number): boolean {
  if (difficulty <= 0) return true;
  if (difficulty > hash.length * 8) return false;

  const fullBytes = difficulty >> 3;
  for (let i = 0; i < fullBytes; i++) {
    if (hash[i] !== 0) return false;
  }
  const remainBits = difficulty & 7;
  if (remainBits > 0) {
    const mask = (0xff << (8 - remainBits)) & 0xff;
    if ((hash[fullBytes] & mask) !== 0) return false;
  }
  return true;
}

/**
 * packet_id = hex(SHA-256(preimage))
 *
 * CHK (Content Hash Key)。受信側はこれを再計算して申告値と突き合わせるだけで、
 * ヘッダが改竄されていないことを鍵なしで確認できる。
 */
export function derivePacketId(header: PowCommittedHeader): string {
  return Encoding.toHex(sodium.crypto_hash_sha256(powPreimage(header)));
}

/**
 * PoW の検証。同期・SHA-256 1回なので受信ホットパスで直接呼んでよい。
 *
 * 難易度の下限・上限をここで強制するのが要点。呼び出し側が
 * packet.pow_difficulty を渡しても、ポリシー外の値なら必ず false になる。
 */
export function verifyPow(header: PowCommittedHeader, powNonce: number | bigint): boolean {
  const difficulty = header.pow_difficulty;
  if (difficulty < POW_POLICY.MIN_DIFFICULTY) return false;
  if (difficulty > POW_POLICY.MAX_DIFFICULTY) return false;

  let preimage: Uint8Array;
  try {
    preimage = powPreimage(header);
  } catch {
    return false;
  }
  return meetsDifficulty(powHash(preimage, powNonce), difficulty);
}

/**
 * PoW の探索。Worker からも同期的に呼べる。
 *
 * @param maxIterations 打ち切り上限。到達したら null を返す。
 */
export function solvePow(
  header: PowCommittedHeader,
  maxIterations: number = Number.MAX_SAFE_INTEGER,
): bigint | null {
  const preimage = powPreimage(header);
  const difficulty = header.pow_difficulty;

  for (let i = 0; i < maxIterations; i++) {
    const nonce = BigInt(i);
    if (meetsDifficulty(powHash(preimage, nonce), difficulty)) return nonce;
  }
  return null;
}

/**
 * MsgPack 経由で受け取ったバイト列は Uint8Array / Array / Buffer / {data:[...]}
 * のいずれの形にもなり得るため、正規化してから正準化に掛ける。
 */
export function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (value && typeof value === 'object' && Array.isArray((value as any).data)) {
    return Uint8Array.from((value as any).data as number[]);
  }
  return new Uint8Array(0);
}
