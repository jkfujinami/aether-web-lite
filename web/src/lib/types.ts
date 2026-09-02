import type { PowCommittedHeader } from './crypto/PowPolicy';

export type PeerId = string;

/**
 * トラッカーに提示する Bound Identity の主張。
 *
 * position と zones は載せない:
 *   - position は peerId の純粋関数なので受け取る側が自分で計算する
 *     (申告させると詐称の余地が生まれる → Eclipse)
 *   - zones (購読ゾーン) を申告すると、そのピアが何に興味を持っているかが
 *     トラッカーと全隣人に漏れ、交差攻撃の材料になる (本家 18.6.2)
 */
export interface WireNodeClaim {
  peerId: PeerId;
  /** Ed25519 公開鍵 (32 バイト) */
  pubkey: Uint8Array;
  /** NodeId PoW の解 */
  powCounter: number;
}

// -- Signaling Serverとの通信用メッセージ --
export type SignalingMessage =
  | ({ type: 'join'; turnstileToken?: string } & WireNodeClaimJson)
  | { type: 'peers'; peers: Array<{ peerId: PeerId }> }
  | { type: 'relay'; targetPeerId: PeerId; payload: any } // トラッカー経由の最初のSDP交換用
  | { type: 'error'; message: string };

/** WebSocket は JSON なのでバイト列は hex 文字列で運ぶ */
export interface WireNodeClaimJson {
  peerId: PeerId;
  /** hex 64 文字 */
  pubkey: string;
  powCounter: number;
}

// -- Gossipの型定義 --
export interface GossipPacket {
  packet_id: string; // SHA256(payload) -> Hex
  hop_count: number;
  pow_nonce: number;
  pow_difficulty: number;
  timestamp: number;
  zone_id: number;
  nonce: Uint8Array;
  payload: Uint8Array;
}

export interface StemPacket {
  type: 'stem';
  zoneId: number;
  /**
   * ★ ホップカウンタ (stemTtl) は意図的に持たない。
   *
   * カウンタを載せると上限値が「発信元しか出せない値」になり、
   * それを受け取った中継者が発信元を確定できてしまう。
   * 停止は各ホップの確率判定 (DANDELION_CONFIG.FLUFF_PROBABILITY) が担う。
   * 詳細は DandelionRouter.ts のコメントを参照。
   */
  packet: GossipPacket;
}

// -- WebRTC DataChannelで送受信される P2PMessage --
export type P2PMessage =
  // ── Ring管理 ──
  /** 接続直後に双方が送るチャレンジ。相手はこれに署名して JOIN を返す */
  | { type: 'hello'; challenge: Uint8Array }
  /** Bound Identity の主張 + 所有証明 */
  | ({ type: 'join'; challenge: Uint8Array; signature: Uint8Array } & WireNodeClaim)
  | { type: 'ring-info'; neighbors: Array<{ id: PeerId }> }

  // ── 生存確認 ──
  | { type: 'ping'; ts: number }
  | { type: 'pong'; ts: number; echoTs: number }

  // ── PEX (ロングレンジ候補探索) ──
  | { type: 'pex-request'; minDistance: number }
  /** position は id から導出できるので載せない */
  | { type: 'pex-response'; peers: Array<{ id: PeerId }> }

  // ── シグナリング (DataChannel越し) ──
  | { type: 'sdp-relay'; targetPeerId: PeerId; senderId?: PeerId; sdp: any }
  | { type: 'ice-relay'; targetPeerId: PeerId; senderId?: PeerId; candidate: any }

  // ── ゴシップ (Step 2以降) ──
  | { type: 'gossip'; packet: GossipPacket }
  | StemPacket

  // ── Mailbox (Step 3以降) ──
  | { type: 'dht-put'; topicHash: string; entries: Uint8Array[] } // 複数件の書き込み
  | { type: 'dht-get'; topicHash: string; reqId: string }
  | { type: 'dht-res'; topicHash: string; reqId: string; entries: Uint8Array[] };

// ── インターフェース抽象群 (アーキテクチャ設計通り) ──

export interface IPeerConnection {
  readonly peerId: PeerId;
  /** peerId から導出された値。相手の申告ではない */
  readonly position: number;
  readonly rtt: number;
  readonly isConnected: boolean;
  /** HELLO/JOIN のハンドシェイクで Bound Identity を検証済みか */
  readonly isVerified: boolean;
  send(msg: Uint8Array | string): void;
  close(): void;
}

export interface IPeerManager {
  readonly peers: ReadonlyMap<PeerId, IPeerConnection>;
  readonly degree: number;
  readonly myPeerId: PeerId;
  readonly myPosition: number;
  connect(peerId: PeerId, initiator?: boolean, viaPeerId?: PeerId): IPeerConnection | Promise<IPeerConnection> | undefined;
  disconnect(peerId: PeerId): void;
  // 高レベルバイナリ送信 (Wire V2)
  sendMessage(peerId: PeerId, type: number, payload: any): void;
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler: (...args: any[]) => void): void;
}

// ── Message Dispatcher ──
export interface IMessageDispatcher {
  register(type: number, handler: (peerId: PeerId, payload: any) => void): void;
  dispatch(peerId: PeerId, type: number, payload: any): void;
}

// ── Signaling Client ──
export interface ISignalingClient {
  connect(options: { claim: WireNodeClaim; turnstileToken?: string }): Promise<void>;
  sendRelay(targetPeerId: PeerId, payload: any): void;
  disconnect(): void;
  on(event: 'peers', cb: (peers: Array<{ peerId: PeerId }>) => void): void;
  on(event: 'relay', cb: (senderId: PeerId, payload: any) => void): void;
}

// ── Mailbox (DHT) ──
export interface IMailbox {
  publish(topicHashHex: string, data: Uint8Array): Promise<void>;
  fetch(topicHashHex: string): Promise<Uint8Array[]>;
  replicate(targetPeerId: string, topicHash: string, entries: Uint8Array[]): void;
}

// ── Storage ──
export interface DAGMetadata {
  parents: string[];
  cumulative_pow: number;
  thread_root: string;
}

export interface IPostStore {
  save(post: { boardId: string; threadId: string; payload: Uint8Array; dag?: DAGMetadata }): Promise<void>;
  getPosts(boardId: string, threadId: string): Promise<any[]>;
  getRecentTimestamps(count: number): Promise<number[]>;
}

// ── Key Management ──
export interface IKeyManager {
  deriveThreadKey(boardKey: Uint8Array, threadId: string): Uint8Array;
  deriveTopicHash(threadKey: Uint8Array): Uint8Array;
  computeZoneId(topicHash: Uint8Array, depth: number): number;
}

// ── Identity & Signing ──
export interface SignatureResult {
  sessionPubkey: Uint8Array;
  sessionSignature: Uint8Array;
  tripPubkey: Uint8Array | null;
  tripSignature: Uint8Array | null;
}

export interface IIdentity {
  sign(data: Uint8Array): SignatureResult;
}

// ── Zone Manager ──
export interface IZoneManager {
  readonly depth: number;
  readonly subscribedZones: ReadonlySet<number>;
  isSubscribed(zoneId: number): boolean;
}

// ── Anti-Spam (PoW) ──
export interface IPoWEngine {
  /** コミット済みヘッダ全体に対して PoW を探索する */
  compute(header: PowCommittedHeader): Promise<bigint>;
}

// ── Crypto Engine ──
export interface EncryptedPayload {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

export interface ICryptoEngine {
  encrypt(threadKey: Uint8Array, payload: Uint8Array): EncryptedPayload;
  decrypt(threadKey: Uint8Array, encrypted: EncryptedPayload): Uint8Array | null;
}
