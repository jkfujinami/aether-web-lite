import type { PeerId, SignalingMessage, ISignalingClient, WireNodeClaim } from '../types';
import { Encoding } from '../common/Encoding';
import { createLogger } from '../common/Logger';
import { parseTrackerUrl } from './TrackerUrl';

const log = createLogger('net.signaling');

type PeersCallback = (peers: Array<{ peerId: PeerId }>) => void;
type RelayCallback = (senderId: PeerId, payload: any) => void;

/** トラッカーが設定されていない (公式のトラッカーは無いので、利用者が設定するまでこの状態) */
export class TrackerNotConfiguredError extends Error {
  constructor() {
    super('tracker URL is not configured');
    this.name = 'TrackerNotConfiguredError';
  }
}

export interface SignalingClientOptions {
  /** テスト用。既定は globalThis.WebSocket */
  WebSocketImpl?: typeof WebSocket;
  /** 接続待ちの上限 */
  connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const WS_CONNECTING = 0;
const WS_OPEN = 1;

export class SignalingClient implements ISignalingClient {
  private ws: WebSocket | null = null;
  private onPeersCb?: PeersCallback;
  private onRelayCb?: RelayCallback;
  private _url: string | null = null;
  private pending: Promise<void> | null = null;
  /** setUrl / disconnect のたびに進める。古い接続のコールバックを無効にするため */
  private generation = 0;
  private readonly WebSocketImpl: typeof WebSocket | undefined;
  private readonly connectTimeoutMs: number;

  /**
   * ★ 旧実装は URL 未指定やページの場所から接続先を推測していた
   *   (Electron では ws://localhost:3000、開発時は Vite のサーバ)。
   *   利用者の知らない相手に peerId と IP を送らないよう、推測はしない。
   *   URL が無ければ connect() は失敗する。
   */
  constructor(url?: string | null, options: SignalingClientOptions = {}) {
    this.WebSocketImpl = options.WebSocketImpl ?? (globalThis as any).WebSocket;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    if (url) this.setUrl(url);
  }

  public get url(): string | null {
    return this._url;
  }

  public get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WS_OPEN;
  }

  /**
   * 接続先を変える (null で未設定に戻す)。既存の接続は切る。
   * 不正な URL は例外にし、以前の設定を残す。
   */
  public setUrl(url: string | null): void {
    let next: string | null = null;
    if (url !== null) {
      const parsed = parseTrackerUrl(url);
      if (!parsed.ok) throw new Error(`invalid tracker URL: ${parsed.reason}`);
      next = parsed.url;
    }
    this.disconnect();
    this._url = next;
    log.debug(() => `Tracker URL ${next ? 'configured' : 'cleared'}`);
  }

  public async connect(options: { claim: WireNodeClaim; turnstileToken?: string }): Promise<void> {
    if (!this._url) throw new TrackerNotConfiguredError();
    if (this.isConnected) return;
    if (this.pending) return this.pending;
    if (!this.WebSocketImpl) throw new Error('WebSocket is not available');

    // 閉じかけの古い接続は捨てる (二重接続で同じ peerId を 2 回登録しない)
    this.closeSocket();
    const generation = ++this.generation;
    const url = this._url;

    const attempt = new Promise<void>((resolve, reject) => {
      log.debug(`Connecting to tracker`);
      let settled = false;
      const ws = new this.WebSocketImpl!(url);
      this.ws = ws;

      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.ws === ws) this.closeSocket();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('tracker connect timeout')), this.connectTimeoutMs);

      ws.onopen = () => {
        if (settled || generation !== this.generation) return;
        settled = true;
        clearTimeout(timer);
        log.debug(`Connected to tracker`);
        // 接続直後に Join メッセージで自身を登録。
        // position と zones は送らない (前者は peerId から導出可能、
        // 後者は購読宣言そのものでトラッカーに興味を晒すことになる)。
        const joinMsg: SignalingMessage = {
          type: 'join',
          peerId: options.claim.peerId,
          pubkey: Encoding.toHex(options.claim.pubkey),
          powCounter: options.claim.powCounter,
          turnstileToken: options.turnstileToken,
        };
        this.send(joinMsg);
        resolve();
      };

      ws.onmessage = (event) => {
        if (generation !== this.generation) return;
        this.handleMessage(event.data);
      };

      ws.onerror = () => {
        // 詳細 (URL を含むことがある) はログに出さない
        log.warn(`Tracker connection error`);
        fail(new Error('tracker connection error'));
      };

      ws.onclose = () => {
        log.debug(`Disconnected from tracker`);
        fail(new Error('tracker connection closed'));
        if (this.ws === ws) this.ws = null;
      };
    });

    this.pending = attempt;
    try {
      await attempt;
    } finally {
      if (this.pending === attempt) this.pending = null;
    }
  }

  private handleMessage(raw: unknown): void {
    try {
      const data = JSON.parse(String(raw)) as SignalingMessage | any;
      log.debug(`<<< Message from tracker: type=${data.type}`);

      if (data.type === 'peers') {
        const peers = Array.isArray(data.peers)
          ? data.peers.filter((p: any) => typeof p?.peerId === 'string').map((p: any) => ({ peerId: p.peerId }))
          : [];
        if (this.onPeersCb) this.onPeersCb(peers);
      } else if (data.type === 'relay') {
        // トラッカー経由のリレーメッセージ (Unwrap)
        const senderId = data.senderId || data.sender_id;
        if (this.onRelayCb && senderId) {
          this.onRelayCb(senderId, data.payload);
        }
      } else if (data.sdp || data.candidate || data.type === 'sdp-relay' || data.type === 'ice-relay') {
        // 後位互換: トラッカーによるフラットなリレーや、V1形式
        const senderId = data.senderId || data.sender_id;
        if (this.onRelayCb && senderId) this.onRelayCb(senderId, data);
      } else if (data.type === 'error') {
        log.error(`Tracker error:`, data.message);
      } else {
        log.warn(`Unhandled message type: ${data.type}`);
      }
    } catch (e) {
      log.error(`Failed to parse message`, e);
    }
  }

  public sendRelay(targetPeerId: PeerId, payload: any): void {
    const msg: SignalingMessage = {
      type: 'relay',
      targetPeerId,
      payload
    };
    this.send(msg);
  }

  private send(msg: SignalingMessage): void {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  public on(event: 'peers', cb: PeersCallback): void;
  public on(event: 'relay', cb: RelayCallback): void;
  public on(event: string, cb: any): void {
    if (event === 'peers') this.onPeersCb = cb;
    if (event === 'relay') this.onRelayCb = cb;
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws && (ws.readyState === WS_CONNECTING || ws.readyState === WS_OPEN)) {
      try { ws.close(); } catch { /* 既に閉じている */ }
    }
  }

  public disconnect(): void {
    this.generation++;
    this.pending = null;
    this.closeSocket();
  }
}
