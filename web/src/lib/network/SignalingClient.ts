import { TRACKER } from '../constants';
import type { PeerId, SignalingMessage, ISignalingClient, WireNodeClaim } from '../types';
import { Encoding } from '../common/Encoding';

type PeersCallback = (peers: Array<{ peerId: PeerId }>) => void;
type RelayCallback = (senderId: PeerId, payload: any) => void;

export class SignalingClient implements ISignalingClient {
  private ws: WebSocket | null = null;
  private onPeersCb?: PeersCallback;
  private onRelayCb?: RelayCallback;
  private url: string;
  constructor(url: string = TRACKER.URL) {
    // ブラウザ環境かつデフォルトURLの場合、現在のホスト名から推測する (ngrok対応)
    if (typeof window !== 'undefined' && (url === 'ws://localhost:3000' || url === TRACKER.URL)) {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host;
      this.url = `${protocol}//${host}/ws`;
    } else {
      this.url = url;
    }
    console.log(`[SignalingClient] Tracker URL configured as: ${this.url}`);
  }

  public async connect(options: { claim: WireNodeClaim; turnstileToken?: string }): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`[SignalingClient] Connecting to tracker: ${this.url}`);
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log(`[SignalingClient] Connected to tracker`);
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

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as SignalingMessage | any;
          console.log(`[SignalingClient] <<< Message from tracker: type=${data.type}`);

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
            if (this.onRelayCb) this.onRelayCb(senderId, data);
          } else if (data.type === 'error') {
            console.error(`[SignalingClient] Tracker error:`, data.message);
          } else {
            console.warn(`[SignalingClient] Unhandled message type: ${data.type}`);
          }
        } catch (e) {
          console.error(`[SignalingClient] Failed to parse message`, e);
        }
      };

      this.ws.onerror = (e) => {
        console.error(`[SignalingClient] WebSocket error`, e);
        reject(e);
      };

      this.ws.onclose = () => {
        console.log(`[SignalingClient] Disconnected from tracker`);
      };
    });
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  public on(event: 'peers', cb: PeersCallback): void;
  public on(event: 'relay', cb: RelayCallback): void;
  public on(event: string, cb: any): void {
    if (event === 'peers') this.onPeersCb = cb;
    if (event === 'relay') this.onRelayCb = cb;
  }

  public disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
