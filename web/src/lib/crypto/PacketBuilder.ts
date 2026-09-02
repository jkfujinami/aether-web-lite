import { encode, decode } from '@msgpack/msgpack';
import sodium from './sodium';
import type { ICryptoEngine, IIdentity, IPoWEngine, IKeyManager, GossipPacket } from '../types';
import { Identity } from './Identity';
import { MagicFilter } from './MagicFilter';
import { derivePacketId, toBytes, type PowCommittedHeader } from './PowPolicy';

export class PacketBuilder {
  /**
   * 投稿内容を3層でラップしたGossipPacketを生成する
   */
  static async build(
    content: string,
    threadKey: Uint8Array,
    identity: IIdentity,
    cryptoEngine: ICryptoEngine,
    powEngine: IPoWEngine,
    keyManager: IKeyManager,
    boardId: string,
    threadId: string,
    postNumber: number,
    replyTo: number | null,
    powDifficulty: number,
    currentDepth: number,
    postType: number = 0, // 0=post, 1=thread_meta
    dagParents: string[] = [],
    threadRoot: string = '',
    cumulativePow: number = 0
  ): Promise<GossipPacket> {
    await sodium.ready;

    // タイムスタンプは PoW のコミット対象なので、探索の *前に* 一度だけ確定させる。
    // 旧実装は Date.now() を署名層とパケットヘッダで別々に呼んでおり、
    // PoW 計算に掛かった時間だけ両者がずれていた。
    const now = Date.now();

    // Step 1: 署名層
    const signedDataObj: any = {
      content,
      post_number: postNumber,
      reply_to: replyTo,
      created_at: now,
      board_id: boardId,
      thread_id: threadId,
      // -- DAG fields --
      parents: dagParents,
      cumulative_pow: cumulativePow,
      thread_root: threadRoot
    };
    const signedData = encode(signedDataObj);
    const sig = identity.sign(signedData);

    const innerPayload = encode({
      ...signedDataObj,
      session_pubkey: sig.sessionPubkey,
      session_sig: sig.sessionSignature,
      trip_pubkey: sig.tripPubkey,
      trip_sig: sig.tripSignature,
    });

    // Step 2: 暗号化層
    const encPayload = encode({
      board_id: boardId,
      thread_id: threadId,
      post_type: postType, 
      inner_payload: innerPayload,
    });

    // AEAD暗号化
    const { ciphertext, nonce } = cryptoEngine.encrypt(threadKey, encPayload);

    // Step 3: PoW をヘッダ全体に対して計算する。
    //
    // 旧実装は ciphertext だけを PoW の対象にしていたため、傍受した
    // パケットの timestamp を現在時刻に書き換えるだけで PoW を再計算せずに
    // 再放流でき、SeenCache の TTL (15分) を越えて無限に増幅できた。
    // timestamp / zone_id / pow_difficulty / nonce まで覆うことで、
    // どれか 1 つでも書き換えれば PoW をやり直す必要が生じる。
    const committed: PowCommittedHeader = {
      timestamp: now,
      zone_id: keyManager.computeZoneId(
        keyManager.deriveTopicHash(threadKey),
        currentDepth,
      ),
      pow_difficulty: powDifficulty,
      nonce,
      payload: ciphertext,
    };

    const powNonce = await powEngine.compute(committed);

    // Step 4: 外側パケット。
    // packet_id はコミット済みヘッダのハッシュ (CHK) なので、受信側は鍵なしで
    // 「このヘッダは改竄されていない」を検証できる。
    return {
      packet_id: derivePacketId(committed),
      hop_count: 0,
      pow_nonce: Number(powNonce),
      pow_difficulty: committed.pow_difficulty,
      timestamp: committed.timestamp,
      zone_id: committed.zone_id,
      nonce,
      payload: ciphertext,
    };
  }

  /**
   * 受信パケットから PoW / packet_id がコミットしているフィールドだけを抜き出す。
   * MsgPack や JSON を経由するとバイト列の表現が揺れるため、ここで正規化する。
   */
  static committedHeaderOf(packet: any): PowCommittedHeader {
    return {
      timestamp: packet?.timestamp,
      zone_id: packet?.zone_id,
      pow_difficulty: packet?.pow_difficulty,
      nonce: toBytes(packet?.nonce),
      payload: toBytes(packet?.payload),
    };
  }

  /**
   * 受信時に外側部分から順序立てて展開・検証・デコードする。
   */
  static async verifyAndDecrypt(
    packet: any,
    threadKey: Uint8Array,
    cryptoEngine: ICryptoEngine
  ): Promise<any | null> {
    const ciphertext = toBytes(packet.payload);
    const nonce = toBytes(packet.nonce);

    // 0. Broadcast Veil: 4バイト高速スクリーニング (~5ns)
    // 自分宛てでないパケットをフルAEAD復号の前に弾く
    let isMatch = false;
    try {
      isMatch = MagicFilter.quickCheck(threadKey, ciphertext, nonce);
    } catch (e: any) {
      console.error(`[PacketBuilder] QuickCheck threw exception for packet ${packet.packet_id}:`, e);
      throw new Error(`QuickCheck failure: ${e.message}`);
    }

    if (!isMatch) {
      return null;
    }

    // 1. フルAEAD復号
    let decPayloadBuf: Uint8Array | null = null;
    try {
      decPayloadBuf = cryptoEngine.decrypt(threadKey, { ciphertext, nonce });
    } catch (e: any) {
      console.error(`[PacketBuilder] AEAD decryption crashed for packet ${packet.packet_id}:`, e);
      throw new Error(`AEAD decrypt crash: ${e.message}`);
    }

    if (!decPayloadBuf) {
      console.debug(`[PacketBuilder] AEAD decryption failed (not a target packet or invalid key) for packet ${packet.packet_id}`);
      return null;
    }

    // 2. 第一層のデシリアライズ
    let encPayload: any;
    try {
      encPayload = decode(decPayloadBuf) as any;
    } catch (e: any) {
      console.error(`[PacketBuilder] Msgpack decode (layer 1) failed for packet ${packet.packet_id}:`, e);
      return null;
    }

    // 3. 第二層の展開
    let innerPayload: any;
    try {
      innerPayload = decode(encPayload.inner_payload) as any;
    } catch (e: any) {
      console.error(`[PacketBuilder] Msgpack decode (layer 2) failed for packet ${packet.packet_id}:`, e);
      return null;
    }
    
    // 4. Ed25519 署名検証 (後方互換性のために、存在するフィールドのみで構成)
    const originalPostDataObj: any = {
      content: innerPayload.content,
      post_number: innerPayload.post_number,
      reply_to: innerPayload.reply_to,
      created_at: innerPayload.created_at,
      board_id: innerPayload.board_id,
      thread_id: innerPayload.thread_id,
    };
    
    // DAGフィールドが存在する場合のみ署名対象に含める (新旧パケットの共存)
    if (innerPayload.parents !== undefined) {
      originalPostDataObj.parents = innerPayload.parents;
      originalPostDataObj.cumulative_pow = innerPayload.cumulative_pow;
      originalPostDataObj.thread_root = innerPayload.thread_root;
    }

    const signedData = encode(originalPostDataObj);

    // Identity.verify は static なのでそのまま呼び出し
    let isValid = false;
    try {
      isValid = Identity.verify(
        signedData, 
        new Uint8Array(innerPayload.session_pubkey), 
        new Uint8Array(innerPayload.session_sig)
      );
    } catch (e: any) {
      console.error(`[PacketBuilder] Ed25519 signature verification crashed for packet ${packet.packet_id}:`, e);
      return null;
    }

    if (!isValid) {
      console.warn(`[PacketBuilder] Signature Verification Failed for packet: ${packet.packet_id}`);
      return null;
    }

    return {
      ...originalPostDataObj,
      post_type: encPayload.post_type,
      session_pubkey: innerPayload.session_pubkey,
      trip_pubkey: innerPayload.trip_pubkey,
      // -- DAG fields --
      parents: innerPayload.parents,
      cumulative_pow: innerPayload.cumulative_pow,
      thread_root: innerPayload.thread_root
    };
  }
}
