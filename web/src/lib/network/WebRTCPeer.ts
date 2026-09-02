import type { IPeerConnection, PeerId } from '../types';
import { RingPosition } from './RingPosition';
import { ChunkedSender } from './stream/ChunkedSender';
import { ChunkedReceiver } from './stream/ChunkedReceiver';

interface WebRTCPeerOptions {
  localId: string;
  remoteId: string;
  initiator: boolean;
  onSignal: (payload: any) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onData: (data: Uint8Array | string) => void;
}

export class WebRTCPeer implements IPeerConnection {
  private pc: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private chunkedSender = new ChunkedSender();
  private chunkedReceiver: ChunkedReceiver;

  public readonly peerId: PeerId;
  /**
   * リング座標。peerId から導出した値であって、相手の申告ではない。
   * 書き換え可能な public フィールドではなく readonly にしてある。
   */
  public readonly position: number;
  public rtt: number = 0;

  private _connected = false;
  private _connecting = true;
  private _verified = false;
  /** 相手に送ったチャレンジ。JOIN の署名検証に使う */
  private _challenge: Uint8Array | null = null;
  private opts: WebRTCPeerOptions;

  public get isConnected(): boolean {
    return this._connected;
  }

  public get isConnecting(): boolean {
    return this._connecting;
  }

  /** HELLO/JOIN のハンドシェイクで Bound Identity を検証済みか */
  public get isVerified(): boolean {
    return this._verified;
  }

  public get challenge(): Uint8Array | null {
    return this._challenge;
  }

  constructor(opts: WebRTCPeerOptions) {
    this.opts = opts;
    this.peerId = opts.remoteId;
    // 座標は peerId の純粋関数。相手からもらった数値は一切使わない。
    this.position = RingPosition.forPeer(opts.remoteId);

    this.chunkedReceiver = new ChunkedReceiver((assembled) => {
      this.opts.onData(new Uint8Array(assembled));
    });

    const iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' }
    ];

    this.pc = new RTCPeerConnection({ iceServers });

    this.setupEvents();

    if (opts.initiator) {
      // DataChannelの作成 (送信者側)
      this.channel = this.pc.createDataChannel('aether', {
        ordered: true,
      });
      this.setupChannelEvents(this.channel);
      this.createOffer();
    }
  }

  private setupEvents(): void {
    this.pc.onicecandidate = (event) => {
      console.log(`[WebRTCPeer ${this.peerId}] onicecandidate:`, event.candidate ? 'has candidate' : 'null (done)');
      if (event.candidate) {
        this.opts.onSignal(event.candidate);
      }
    };

    this.pc.ondatachannel = (event) => {
      // 着信側のDataChannel受信
      this.channel = event.channel;
      this.setupChannelEvents(this.channel);
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      console.log(`[WebRTCPeer ${this.peerId}] iceConnectionState:`, state);
      if (state === 'disconnected' || state === 'failed') {
        this._connected = false;
        this._connecting = false;
        this.opts.onDisconnect();
      }
    };
  }

  private setupChannelEvents(channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      console.log(`[WebRTCPeer] DataChannel open with ${this.peerId}`);
      this._connected = true;
      this._connecting = false;
      this.opts.onConnect();
    };

    channel.onclose = () => {
      console.log(`[WebRTCPeer] DataChannel closed with ${this.peerId}`);
      this._connected = false;
      this._connecting = false;
      this.opts.onDisconnect();
    };

    channel.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.chunkedReceiver.receive(event.data);
      } else {
        this.opts.onData(event.data);
      }
    };
  }

  private async createOffer(): Promise<void> {
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      
      this.opts.onSignal(this.pc.localDescription);
    } catch (e) {
      console.error(`[WebRTCPeer] Error creating offer`, e);
    }
  }

  private pendingCandidates: RTCIceCandidateInit[] = [];

  public async signal(data: any): Promise<void> {
    console.log(`[WebRTCPeer ${this.peerId}] signal() called with:`, data.type);
    try {
      if (data.sdp) {
        console.log(`[WebRTCPeer ${this.peerId}] Setting remote description (${data.sdp.type})`);
        const sdp = new RTCSessionDescription(data.sdp);
        await this.pc.setRemoteDescription(sdp);
        
        if (sdp.type === 'offer') {
          console.log(`[WebRTCPeer ${this.peerId}] Creating answer`);
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);

          // 返信のシグナリング
          this.opts.onSignal(this.pc.localDescription);
        }
        
        // バッファされたICE Candidateを処理
        console.log(`[WebRTCPeer ${this.peerId}] Processing ${this.pendingCandidates.length} buffered candidates`);
        for (const candidate of this.pendingCandidates) {
          await this.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error(e));
        }
        this.pendingCandidates = [];

      } else if (data.candidate) {
        console.log(`[WebRTCPeer ${this.peerId}] Received ICE candidate`);
        if (this.pc.remoteDescription) {
          const candidate = new RTCIceCandidate(data.candidate);
          await this.pc.addIceCandidate(candidate).catch(e => console.error(e));
        } else {
          console.warn(`[WebRTCPeer ${this.peerId}] remoteDescription not set yet, buffering candidate!`);
          this.pendingCandidates.push(data.candidate);
        }
      }
    } catch (e) {
      console.error(`[WebRTCPeer ${this.peerId}] Error handling signal`, e);
    }
  }

  public send(msg: Uint8Array | string): void {
    if (!this.channel || this.channel.readyState !== 'open') return;
    if (typeof msg === 'string') {
      this.channel.send(msg);
      return;
    }
    // Use ChunkedSender: messages <= 4KB go through in one send(),
    // larger messages (e.g. DHT sync responses) are split into 4KB chunks.
    this.chunkedSender.send(this.channel, msg).catch((e) => {
      console.error(`[WebRTCPeer] ChunkedSend failed`, e);
    });
  }

  /** 送出したチャレンジを記録する (HELLO 送信時) */
  public setChallenge(challenge: Uint8Array) {
    this._challenge = challenge;
  }

  /** Bound Identity の検証に成功した印を付ける */
  public markVerified() {
    this._verified = true;
  }

  public close(): void {
    this._connected = false;
    this._connecting = false;
    this.chunkedReceiver.destroy();
    if (this.channel) this.channel.close();
    this.pc.close();
  }
}
