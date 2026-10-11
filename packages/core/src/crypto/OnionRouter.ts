import sodium, { sodiumReady } from './sodium';
import { Encoding } from '../common/Encoding';
import type { PeerId, GossipPacket } from '../types';
import { createLogger } from '../common/Logger';

const log = createLogger('crypto.onion');

export type OnionPayload =
  | {
      type: 'relay';
      nextHop: PeerId;
      innerOnion: Uint8Array;
    }
  | {
      type: 'exit_fluff';
      zoneId: number;
      packet: GossipPacket;
    };

export interface OnionHop {
  peerId: PeerId;
  pubkey: Uint8Array; // Ed25519 public key (32 bytes)
}

import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';

export class OnionRouter {
  /**
   * 固定長セルサイズ (3800バイト)。
   * WebRTC DataChannel の単一フレーム上限 (CHUNK_SIZE = 4096B) から
   * WireType (1B) および MsgPack エンベロープ (約35B) を差し引いたサイズとし、
   * SCTP 分割チャンキングを一切発生させずに 1 パケットで完全均一送出する。
   */
  public static readonly CELL_SIZE = 3800;
  /** 固定長セルのマジックヘッダ (0xA55A) */
  private static readonly CELL_MAGIC = 0xa55a;

  /** Ed25519 公開鍵 → X25519 公開鍵の変換キャッシュ */
  private static xPkCache = new Map<string, Uint8Array>();

  /**
   * 固定長セルパディング (Fixed Cell Size Padding)
   *
   * パケット長を常に CELL_SIZE (4096 バイト) に均一化し、残余領域を
   * 暗号論的擬似乱数 (libsodium randombytes_buf) で充填する。
   *
   * セル形式:
   * [0..1]: Magic (0xA55A)
   * [2..3]: 実データ長 L (Big Endian, 16bit)
   * [4..4+L-1]: 実データ
   * [4+L..CELL_SIZE-1]: 暗号論的擬似乱数パディング
   */
  public static padCell(payload: Uint8Array, cellSize: number = this.CELL_SIZE): Uint8Array {
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
      const padding = sodium.randombytes_buf(padLen);
      cell.set(padding, 4 + payload.byteLength);
    }
    return cell;
  }

  /**
   * 固定長セルからパディングを剥離して実データを取り出す
   */
  public static unpadCell(cell: Uint8Array): Uint8Array {
    if (
      cell.byteLength >= 4 &&
      cell[0] === ((this.CELL_MAGIC >> 8) & 0xff) &&
      cell[1] === (this.CELL_MAGIC & 0xff)
    ) {
      const len = (cell[2] << 8) | cell[3];
      if (len <= cell.byteLength - 4) {
        return cell.subarray(4, 4 + len);
      }
    }
    return cell;
  }

  /**
   * Ed25519 公開鍵を X25519 (Curve25519) 公開鍵へ変換
   */
  public static toCurvePublicKey(edPubkey: Uint8Array): Uint8Array {
    const hex = Encoding.toHex(edPubkey);
    let xPk = this.xPkCache.get(hex);
    if (!xPk) {
      xPk = sodium.crypto_sign_ed25519_pk_to_curve25519(edPubkey);
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
   * 経路 hops: [Hop1 (Guard), Hop2 (Relay), ..., HopK (Exit)]
   * パケットを出口ノード HopK から逆順に多重暗号化し、
   * 最外殻を固定長セル (CELL_SIZE) にパディングして送出する。
   *
   * @param packet 放流対象の平文 GossipPacket
   * @param hops 中継ホップのリスト (1〜3台)
   * @param padToCell 固定長セル (4096B) にパディングするか (既定: true)
   * @returns Hop1 (直前ピア) に送信する最外殻のオニオン暗号文
   */
  public static wrapStem(
    packet: GossipPacket,
    hops: OnionHop[],
    padToCell: boolean = true,
  ): Uint8Array {
    if (hops.length === 0) {
      throw new Error('OnionRouter: hops list cannot be empty');
    }

    // 1. 最深部 (出口ノード HopK 向けペイロード)
    const exitHop = hops[hops.length - 1];
    const exitPayload: OnionPayload = {
      type: 'exit_fluff',
      zoneId: packet.zone_id,
      packet,
    };

    let currentCiphertext = sodium.crypto_box_seal(
      msgpackEncode(exitPayload),
      this.toCurvePublicKey(exitHop.pubkey),
    );

    // 2. 中間層 (HopK-1 から Hop1 に向かって逆順にラップ)
    for (let i = hops.length - 2; i >= 0; i--) {
      const hop = hops[i];
      const nextHop = hops[i + 1];

      const relayPayload: OnionPayload = {
        type: 'relay',
        nextHop: nextHop.peerId,
        innerOnion: currentCiphertext,
      };

      currentCiphertext = sodium.crypto_box_seal(
        msgpackEncode(relayPayload),
        this.toCurvePublicKey(hop.pubkey),
      );
    }

    return padToCell ? this.padCell(currentCiphertext) : currentCiphertext;
  }

  /**
   * オニオン暗号文を復号して1枚剥く (Onion Unwrap)
   *
   * @param onionBytes 受信したオニオン暗号文 (パディング済みセルまたは生暗号文)
   * @param myEdPubkey 自ノードの Ed25519 公開鍵
   * @param myEdPrivkey 自ノードの Ed25519 秘密鍵
   * @returns 復号されたペイロード (転送指示または Fluff 出口指示)、失敗時は null
   */
  public static unwrap(
    onionBytes: Uint8Array,
    myEdPubkey: Uint8Array,
    myEdPrivkey: Uint8Array,
  ): OnionPayload | null {
    try {
      const rawCiphertext = this.unpadCell(onionBytes);
      const myXPk = this.toCurvePublicKey(myEdPubkey);
      const myXSk = this.toCurvePrivateKey(myEdPrivkey);

      const decryptedBytes = sodium.crypto_box_seal_open(rawCiphertext, myXPk, myXSk);
      const decoded = msgpackDecode(decryptedBytes) as any;

      if (decoded.type === 'relay') {
        return {
          type: 'relay',
          nextHop: decoded.nextHop,
          innerOnion: decoded.innerOnion,
        };
      } else if (decoded.type === 'exit_fluff') {
        return {
          type: 'exit_fluff',
          zoneId: decoded.zoneId,
          packet: decoded.packet,
        };
      }

      return null;
    } catch (err) {
      log.warn(`Onion unwrap failed: ${err}`);
      return null;
    }
  }
}

