import { encode, decode } from '@msgpack/msgpack';
import sodium from 'libsodium-wrappers';
import type { ICryptoEngine, IIdentity, IPoWEngine, IKeyManager } from '../types';
import { Identity } from './Identity';
import { KeyManager } from './KeyManager';

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
  ) {
    await sodium.ready; 

    // Step 1: 署名層
    const signedDataObj: any = {
      content,
      post_number: postNumber,
      reply_to: replyTo,
      created_at: Date.now(),
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

    // Step 3: PoW計算
    const powNonce = await powEngine.compute(ciphertext, powDifficulty);

    // Step 4: 外側パケット
    const packetId = sodium.crypto_hash(ciphertext);

    return {
      packet_id: KeyManager.toHex(packetId.slice(0, 32)),
      hop_count: 0,
      pow_nonce: Number(powNonce),
      pow_difficulty: powDifficulty,
      timestamp: Date.now(),
      zone_id: keyManager.computeZoneId(
        keyManager.deriveTopicHash(threadKey),
        currentDepth,
      ),
      nonce: Array.from(nonce),
      payload: Array.from(ciphertext),
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
    const ciphertext = new Uint8Array(packet.payload);
    const nonce = new Uint8Array(packet.nonce);

    // 1. フルAEAD復号
    const decPayloadBuf = cryptoEngine.decrypt(threadKey, { ciphertext, nonce });
    if (!decPayloadBuf) return null;

    // 2. 第一層のデシリアライズ
    const encPayload = decode(decPayloadBuf) as any;

    // 3. 第二層の展開
    const innerPayload = decode(encPayload.inner_payload) as any;
    
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
    const isValid = Identity.verify(
      signedData, 
      new Uint8Array(innerPayload.session_pubkey), 
      new Uint8Array(innerPayload.session_sig)
    );

    if (!isValid) {
      console.warn("Signature Verification Failed for packet:", packet.packet_id);
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
