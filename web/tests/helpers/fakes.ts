import type {
  IMessageDispatcher,
  IPeerConnection,
  IPeerManager,
  ISignalingClient,
  PeerId,
  IZoneManager,
  WireNodeClaim,
} from '@/lib/types';
import { MessageDispatcher } from '@/lib/network/MessageDispatcher';
import { RingPosition } from '@/lib/network/RingPosition';

/** 送信されたメッセージの記録 */
export interface SentMessage {
  to: PeerId;
  type: number;
  payload: any;
}

export class FakePeer implements IPeerConnection {
  public readonly position: number;
  public rtt = 0;
  public isConnected = true;
  public isVerified = true;
  public sent: Array<Uint8Array | string> = [];

  constructor(public readonly peerId: PeerId, opts: { verified?: boolean; connected?: boolean } = {}) {
    this.position = RingPosition.forPeer(peerId);
    if (opts.verified !== undefined) this.isVerified = opts.verified;
    if (opts.connected !== undefined) this.isConnected = opts.connected;
  }

  send(msg: Uint8Array | string): void {
    this.sent.push(msg);
  }

  close(): void {
    this.isConnected = false;
  }
}

/**
 * ネットワークを持たない PeerManager の代役。
 * sendMessage は記録するだけで、実際の送信は行わない。
 */
export class FakePeerManager implements IPeerManager {
  private _peers = new Map<PeerId, FakePeer>();
  private listeners = new Map<string, Array<(...args: any[]) => void>>();
  public sentMessages: SentMessage[] = [];
  public disconnected: PeerId[] = [];

  constructor(
    public readonly myPeerId: PeerId,
    public readonly myPosition: number = RingPosition.forPeer(myPeerId),
  ) {}

  get peers(): ReadonlyMap<PeerId, IPeerConnection> {
    return this._peers;
  }

  get degree(): number {
    let n = 0;
    for (const p of this._peers.values()) if (p.isConnected) n++;
    return n;
  }

  addPeer(peerId: PeerId, opts: { verified?: boolean; connected?: boolean } = {}): FakePeer {
    const peer = new FakePeer(peerId, opts);
    this._peers.set(peerId, peer);
    return peer;
  }

  connect(peerId: PeerId): IPeerConnection | undefined {
    return this.addPeer(peerId);
  }

  disconnect(peerId: PeerId): void {
    this._peers.delete(peerId);
    this.disconnected.push(peerId);
  }

  sendMessage(peerId: PeerId, type: number, payload: any): void {
    this.sentMessages.push({ to: peerId, type, payload });
  }

  on(event: string, handler: (...args: any[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
  }

  off(event: string, handler: (...args: any[]) => void): void {
    const list = this.listeners.get(event);
    if (list) this.listeners.set(event, list.filter((h) => h !== handler));
  }

  emit(event: string, ...args: any[]): void {
    for (const h of this.listeners.get(event) ?? []) h(...args);
  }

  /** 指定した WireType で送られたメッセージだけを取り出す */
  messagesOfType(type: number): SentMessage[] {
    return this.sentMessages.filter((m) => m.type === type);
  }

  clearSent(): void {
    this.sentMessages = [];
  }
}

/** 常に全ゾーンを購読しているとみなす ZoneManager */
export class FakeZoneManager implements IZoneManager {
  constructor(
    public readonly depth: number = 0,
    private subscribed: Set<number> | null = null,
  ) {}

  get subscribedZones(): ReadonlySet<number> {
    return this.subscribed ?? new Set([0]);
  }

  isSubscribed(zoneId: number): boolean {
    return this.subscribed === null ? true : this.subscribed.has(zoneId);
  }
}

/** 何もしないシグナリングクライアント */
export class FakeSignalingClient implements ISignalingClient {
  public connectedWith: { claim: WireNodeClaim } | null = null;
  public relays: Array<{ target: PeerId; payload: any }> = [];
  private peersCb?: (peers: Array<{ peerId: PeerId }>) => void;
  private relayCb?: (senderId: PeerId, payload: any) => void;

  async connect(options: { claim: WireNodeClaim; turnstileToken?: string }): Promise<void> {
    this.connectedWith = { claim: options.claim };
  }

  sendRelay(targetPeerId: PeerId, payload: any): void {
    this.relays.push({ target: targetPeerId, payload });
  }

  disconnect(): void {}

  on(event: 'peers' | 'relay', cb: any): void {
    if (event === 'peers') this.peersCb = cb;
    if (event === 'relay') this.relayCb = cb;
  }

  /** テストからトラッカー応答を注入する */
  emitPeers(peers: Array<{ peerId: PeerId }>): void {
    this.peersCb?.(peers);
  }

  emitRelay(senderId: PeerId, payload: any): void {
    this.relayCb?.(senderId, payload);
  }
}

export function newDispatcher(): IMessageDispatcher {
  return new MessageDispatcher();
}

/** メモリ上の IndexedDBStore 代替 (mailbox 部分のみ) */
export class FakeStore {
  public topics = new Map<string, Uint8Array[]>();

  async get(topicHash: string): Promise<Uint8Array[] | undefined> {
    return this.topics.get(topicHash);
  }

  async put(topicHash: string, entries: Uint8Array[]): Promise<void> {
    const existing = this.topics.get(topicHash) ?? [];
    const seen = new Set(existing.map((e) => Buffer.from(e).toString('hex')));
    for (const e of entries) {
      const hex = Buffer.from(e).toString('hex');
      if (!seen.has(hex)) {
        existing.push(e);
        seen.add(hex);
      }
    }
    this.topics.set(topicHash, existing);
  }

  async getAllTopicHashes(): Promise<string[]> {
    return Array.from(this.topics.keys());
  }
}

/**
 * 2 台以上の PeerManager を SDP/ICE リレーで繋ぐハブ。
 * 実運用の TrackerServer.handleRelay と同じく「送信元は接続から決める」形で中継する。
 */
export class SignalingHub {
  private clients = new Map<PeerId, HubSignalingClient>();
  /** 中継したメッセージの記録 (何が流れたかを検査するため) */
  public relayed: Array<{ from: PeerId; to: PeerId; payload: any }> = [];

  register(peerId: PeerId, client: HubSignalingClient): void {
    this.clients.set(peerId, client);
  }

  route(from: PeerId, to: PeerId, payload: any): void {
    this.relayed.push({ from, to, payload });
    const target = this.clients.get(to);
    if (!target) return;
    // トラッカーは senderId を自分が知っている値で上書きする
    target.deliverRelay(from, { ...payload, senderId: from });
  }
}

export class HubSignalingClient implements ISignalingClient {
  public connectedWith: { claim: WireNodeClaim } | null = null;
  private peersCb?: (peers: Array<{ peerId: PeerId }>) => void;
  private relayCb?: (senderId: PeerId, payload: any) => void;

  constructor(private hub: SignalingHub, private myPeerId: PeerId) {
    hub.register(myPeerId, this);
  }

  async connect(options: { claim: WireNodeClaim }): Promise<void> {
    this.connectedWith = { claim: options.claim };
  }

  sendRelay(targetPeerId: PeerId, payload: any): void {
    this.hub.route(this.myPeerId, targetPeerId, payload);
  }

  disconnect(): void {}

  on(event: 'peers' | 'relay', cb: any): void {
    if (event === 'peers') this.peersCb = cb;
    if (event === 'relay') this.relayCb = cb;
  }

  deliverRelay(senderId: PeerId, payload: any): void {
    this.relayCb?.(senderId, payload);
  }

  emitPeers(peers: Array<{ peerId: PeerId }>): void {
    this.peersCb?.(peers);
  }
}
