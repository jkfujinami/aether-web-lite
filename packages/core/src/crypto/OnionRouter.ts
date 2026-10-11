import sodium from './sodium';
import { Encoding } from '../common/Encoding';
import type { PeerId, GossipPacket } from '../types';
import { createLogger } from '../common/Logger';
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';

const log = createLogger('crypto.onion');

/** peerId は Bound Identity なので hex 32 文字に固定されている */
const PEER_ID_RE = /^[0-9a-f]{32}$/;

/**
 * 出口ノードに渡す指示。
 *
 * ★ 作者が網に出すものは**すべて**この形でオニオンに載せる。
 *   旧実装は Gossip 本体だけをオニオンに載せ、同じパケットを
 *   DHT_PUT_STEM (Slot) と HINT_STEM (索引) で平文のまま並行に送っていたため、
 *   オニオンが丸ごと迂回されていた。
 *
 *   - exit_fluff : Gossip を Fluff し、slot があれば本体を K-nearest へ保管する
 *   - exit_hint  : Hint を全体配信する (放流タイミングは作者側で時間分離済み)
 *   - drop       : cover traffic。出口で黙って捨てる
 */
export type ExitPayload =
  | {
      type: 'exit_fluff';
      zoneId: number;
      packet: GossipPacket;
      /** Schrödinger Slot。本体はパケットから出口が組み立てる (セルに収めるため) */
      slot?: { topicHash: string; hint: Uint8Array };
    }
  | { type: 'exit_hint'; hint: Uint8Array }
  | { type: 'drop' };

export type OnionPayload =
  | {
      type: 'relay';
      nextHop: PeerId;
      innerOnion: Uint8Array;
    }
  | ExitPayload;

export interface OnionHop {
  peerId: PeerId;
  pubkey: Uint8Array; // Ed25519 public key (32 bytes)
}

/** crypto_box_seal の付加長 (ephemeral pk 32 + MAC 16) */
const SEAL_OVERHEAD = 48;

/** X25519 変換キャッシュの上限 (他ノードの公開鍵は無限に流れてくる) */
const XPK_CACHE_LIMIT = 4096;

export class OnionRouter {
  /**
   * 固定長セルサイズ (3800バイト)。
   * WebRTC DataChannel の単一フレーム上限 (CHUNK_SIZE = 4096B) から
   * WireType (1B) および MsgPack エンベロープ (約35B) を差し引いたサイズとし、
   * SCTP 分割チャンキングを一切発生させずに 1 パケットで完全均一送出する。
   */
  public static readonly CELL_SIZE = 3800;

  /**
   * 出口層の平文長 (固定)。
   *
   * ★ 出口層も固定長にパディングする。
   *   しないと Guard が外殻を剥いた時点で innerOnion の長さが見え、
   *   cover traffic (drop) と本物 (exit_fluff) をサイズだけで区別できてしまう。
   *   relay 層 1 枚の付加は msgpack ≒ 68B + seal 48B。3 ホップ回路の外殻が
   *   CELL_SIZE (ヘッダ 4B 込み) に収まるように選んである:
   *     3400 + 48 = 3448 → +116 = 3564 → +116 = 3680 ≤ 3796
   *   出口ペイロードの最大 (payload 2KB のパケット + Slot) は約 2.5KB。
   */
  public static readonly EXIT_LAYER_SIZE = 3400;

  /** 固定長セルのマジックヘッダ (0xA55A) */
  private static readonly CELL_MAGIC = 0xa55a;

  /** Ed25519 公開鍵 → X25519 公開鍵の変換キャッシュ */
  private static xPkCache = new Map<string, Uint8Array>();

  /**
   * 固定長セルパディング (Fixed Cell Size Padding)
   *
   * セル形式:
   * [0..1]: Magic (0xA55A)
   * [2..3]: 実データ長 L (Big Endian, 16bit)
   * [4..4+L-1]: 実データ
   * [4+L..cellSize-1]: 暗号論的擬似乱数パディング
   */
  public static padCell(payload: Uint8Array, cellSize: number = this.CELL_SIZE): Uint8Array {
    if (!(payload instanceof Uint8Array)) {
      throw new TypeError('OnionRouter: payload must be a Uint8Array');
    }
    if (payload.byteLength > cellSize - 4) {
      throw new Error(`OnionRouter: payload size (${payload.byteLength}) exceeds cell capacity (${cellSize - 4})`);
    }

    const cell = new Uint8Array(cellSize);
    cell[0] = (this.CELL_MAGIC >> 8) & 0xff;
    cell[1] = this.CELL_MAGIC & 0xff;
    cell[2] = (payload.byteLength >> 8) & 0xff;
    cell[3] = payload.byteLength & 0xff;
    cell.set(payload, 4);

    const padLen = cellSize - 4 - payload.byteLength;
    if (padLen > 0) {
      cell.set(sodium.randombytes_buf(padLen), 4 + payload.byteLength);
    }
    return cell;
  }

  /**
   * 固定長セルからパディングを剥離して実データを取り出す。
   *
   * ★ 形式が合わないものは null を返す。
   *   旧実装はマジック不一致のバイト列をそのまま「生の暗号文」として受け入れており、
   *   固定長でないセルが網を流れる余地を残していた。
   */
  public static unpadCell(cell: Uint8Array, expectedSize: number = this.CELL_SIZE): Uint8Array | null {
    if (!(cell instanceof Uint8Array) || cell.byteLength !== expectedSize) return null;
    if (cell[0] !== ((this.CELL_MAGIC >> 8) & 0xff) || cell[1] !== (this.CELL_MAGIC & 0xff)) return null;
    const len = (cell[2] << 8) | cell[3];
    if (len > cell.byteLength - 4) return null;
    return cell.subarray(4, 4 + len);
  }

  /**
   * Ed25519 公開鍵を X25519 (Curve25519) 公開鍵へ変換
   */
  public static toCurvePublicKey(edPubkey: Uint8Array): Uint8Array {
    const hex = Encoding.toHex(edPubkey);
    let xPk = this.xPkCache.get(hex);
    if (!xPk) {
      xPk = sodium.crypto_sign_ed25519_pk_to_curve25519(edPubkey);
      if (this.xPkCache.size >= XPK_CACHE_LIMIT) {
        const oldest = this.xPkCache.keys().next().value;
        if (oldest !== undefined) this.xPkCache.delete(oldest);
      }
      this.xPkCache.set(hex, xPk);
    }
    return xPk;
  }

  /**
   * Ed25519 秘密鍵を X25519 (Curve25519) 秘密鍵へ変換
   */
  public static toCurvePrivateKey(edPrivkey: Uint8Array): Uint8Array {
    return sodium.crypto_sign_ed25519_sk_to_curve25519(edPrivkey);
  }

  /**
   * 多段オニオン暗号化 (Onion Wrap)
   *
   * 経路 hops: [Hop1 (Guard), ..., HopK (Exit)]
   * 出口層を固定長 (EXIT_LAYER_SIZE) にパディングしてから HopK → Hop1 の逆順に
   * 多重暗号化し、最外殻を固定長セル (CELL_SIZE) にパディングして返す。
   *
   * @returns Hop1 に送信する固定長セル
   */
  public static wrapCircuit(exit: ExitPayload, hops: OnionHop[]): Uint8Array {
    if (hops.length === 0) {
      throw new Error('OnionRouter: hops list cannot be empty');
    }

    const exitHop = hops[hops.length - 1];
    let currentCiphertext = sodium.crypto_box_seal(
      this.padCell(msgpackEncode(exit), this.EXIT_LAYER_SIZE),
      this.toCurvePublicKey(exitHop.pubkey),
    );

    for (let i = hops.length - 2; i >= 0; i--) {
      const relayPayload: OnionPayload = {
        type: 'relay',
        nextHop: hops[i + 1].peerId,
        innerOnion: currentCiphertext,
      };
      currentCiphertext = sodium.crypto_box_seal(
        msgpackEncode(relayPayload),
        this.toCurvePublicKey(hops[i].pubkey),
      );
    }

    return this.padCell(currentCiphertext);
  }

  /** Gossip パケットを Fluff させる回路 (互換用の薄いラッパ) */
  public static wrapStem(packet: GossipPacket, hops: OnionHop[]): Uint8Array {
    return this.wrapCircuit({ type: 'exit_fluff', zoneId: packet.zone_id, packet }, hops);
  }

  /**
   * オニオンセルを復号して 1 枚剥く (Onion Unwrap)
   *
   * @param cell 受信した固定長セル (CELL_SIZE)
   * @returns 復号・形式検証済みのペイロード。失敗時は null
   */
  public static unwrap(
    cell: Uint8Array,
    myEdPubkey: Uint8Array,
    myEdPrivkey: Uint8Array,
  ): OnionPayload | null {
    return this.unwrapWithCurveKeys(
      cell,
      this.toCurvePublicKey(myEdPubkey),
      this.toCurvePrivateKey(myEdPrivkey),
    );
  }

  /** X25519 鍵を事前に変換済みの呼び出し側向け (受信ホットパスで毎回変換しない) */
  public static unwrapWithCurveKeys(
    cell: Uint8Array,
    myXPk: Uint8Array,
    myXSk: Uint8Array,
  ): OnionPayload | null {
    try {
      const rawCiphertext = this.unpadCell(cell);
      if (!rawCiphertext) return null;

      let plaintext = sodium.crypto_box_seal_open(rawCiphertext, myXPk, myXSk);

      // 出口層は固定長にパディングされている。msgpack の map は 0x8X / 0xDE / 0xDF で
      // 始まるので、マジック 0xA55A とは衝突しない (長さとマジックの両方で判定する)
      if (plaintext.byteLength === this.EXIT_LAYER_SIZE) {
        const inner = this.unpadCell(plaintext, this.EXIT_LAYER_SIZE);
        if (inner) plaintext = inner;
      }

      return this.parsePayload(msgpackDecode(plaintext));
    } catch (err) {
      log.trace(() => `Onion unwrap failed: ${err}`);
      return null;
    }
  }

  /**
   * 復号結果の形を確定させる。
   *
   * 誰でも任意のノード宛てにオニオンを作れるので、復号できたことは
   * 中身が正しいことを何も保証しない。ここで型と範囲を全部確かめる。
   */
  private static parsePayload(decoded: any): OnionPayload | null {
    if (!decoded || typeof decoded !== 'object') return null;

    switch (decoded.type) {
      case 'relay': {
        if (typeof decoded.nextHop !== 'string' || !PEER_ID_RE.test(decoded.nextHop)) return null;
        if (!(decoded.innerOnion instanceof Uint8Array)) return null;
        if (decoded.innerOnion.byteLength > this.CELL_SIZE - 4) return null;
        return { type: 'relay', nextHop: decoded.nextHop, innerOnion: decoded.innerOnion };
      }
      case 'exit_fluff': {
        if (!decoded.packet || typeof decoded.packet !== 'object') return null;
        if (!Number.isInteger(decoded.zoneId)) return null;
        let slot: { topicHash: string; hint: Uint8Array } | undefined;
        if (decoded.slot !== undefined && decoded.slot !== null) {
          const s = decoded.slot;
          if (typeof s.topicHash !== 'string' || !(s.hint instanceof Uint8Array)) return null;
          slot = { topicHash: s.topicHash, hint: s.hint };
        }
        return { type: 'exit_fluff', zoneId: decoded.zoneId, packet: decoded.packet, slot };
      }
      case 'exit_hint': {
        if (!(decoded.hint instanceof Uint8Array)) return null;
        return { type: 'exit_hint', hint: decoded.hint };
      }
      case 'drop':
        return { type: 'drop' };
      default:
        return null;
    }
  }
}

/** 封印された出口層の長さ (= Guard が外殻を剥いたときに見える innerOnion の長さ) */
export const SEALED_EXIT_LAYER_SIZE = OnionRouter.EXIT_LAYER_SIZE + SEAL_OVERHEAD;
