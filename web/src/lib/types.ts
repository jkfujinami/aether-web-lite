export type PeerId = string;

// -- Signaling Serverとの通信用メッセージ --
export type SignalingMessage =
  | { type: 'join'; peerId: PeerId; position: number; zones: number[]; turnstileToken?: string }
  | { type: 'peers'; peers: Array<{ peerId: PeerId; position: number; zones: number[] }> }
  | { type: 'relay'; targetPeerId: PeerId; payload: any } // トラッカー経由の最初のSDP交換用
  | { type: 'error'; message: string };

// -- Gossipの型定義 --
export interface GossipPacket {
  packet_id: string; // SHA256(payload) -> Hex
  hop_count: number;
  pow_nonce: number;
  pow_difficulty: number;
  timestamp: number;
  zone_id: number;
  nonce: number[];
  payload: number[];
}

export interface StemPacket {
  type: 'stem';
  zoneId: number;
  stemTtl: number;
  packet: GossipPacket;
}

// -- WebRTC DataChannelで送受信される P2PMessage --
export type P2PMessage =
  // ── Ring管理 ──
  | { type: 'join'; peerId: PeerId; position: number }
  | { type: 'ring-info'; neighbors: Array<{ id: PeerId; position: number }> }
  | { type: 'local-link-request'; peerId: PeerId; position: number; zones: number[] }
  | { type: 'local-link-accept'; peerId: PeerId }
  | { type: 'local-link-reject'; reason: 'max-degree' | 'not-neighbor' }

  // ── 生存確認 ──
  | { type: 'ping'; ts: number }
  | { type: 'pong'; ts: number; echoTs: number }

  // ── PEX (ロングレンジ候補探索) ──
  | { type: 'pex-request'; minDistance: number }
  | { type: 'pex-response'; peers: Array<{ id: PeerId; position: number; zones: number[] }> }

  // ── シグナリング (DataChannel越し) ──
  | { type: 'sdp-relay'; targetPeerId: PeerId; senderId?: PeerId; position?: number; zones?: number[]; sdp: any }
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
  readonly position: number;
  readonly zones: ReadonlySet<number>;
  readonly rtt: number;
  readonly isConnected: boolean;
  send(msg: Uint8Array | string): void;
  close(): void;
}

export interface IPeerManager {
  readonly peers: ReadonlyMap<PeerId, IPeerConnection>;
  readonly degree: number;
  readonly myPeerId: PeerId;
  readonly myPosition: number;
  connect(peerId: PeerId, position: number, zones: number[], initiator?: boolean, viaPeerId?: PeerId): IPeerConnection | Promise<IPeerConnection> | undefined;
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
  connect(options: { peerId: PeerId; position: number; zones: number[]; turnstileToken?: string }): Promise<void>;
  sendRelay(targetPeerId: PeerId, payload: any): void;
  disconnect(): void;
  on(event: 'peers', cb: (peers: Array<{ peerId: PeerId; position: number; zones: number[] }>) => void): void;
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
  compute(data: Uint8Array, difficulty: number): Promise<bigint>;
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
