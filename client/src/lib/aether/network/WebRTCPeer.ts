import type { IPeerConnection, PeerId } from '../types';

interface WebRTCPeerOptions {
  localId: string;
  remoteId: string;
  position: number;
  zones: number[];
  initiator: boolean;
  onSignal: (payload: any) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onData: (data: Uint8Array | string) => void;
}

export class WebRTCPeer implements IPeerConnection {
  private pc: RTCPeerConnection;
  private channel?: RTCDataChannel;
  
  public readonly peerId: PeerId;
  public readonly position: number;
  public readonly zones: ReadonlySet<number>;
  public rtt: number = 0;

  private _connected = false;
  private opts: WebRTCPeerOptions;

  public get isConnected(): boolean {
    return this._connected;
  }

  constructor(opts: WebRTCPeerOptions) {
    this.opts = opts;
    this.peerId = opts.remoteId;
    this.position = opts.position;
    this.zones = new Set(opts.zones);

    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

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
        this.opts.onDisconnect();
      }
    };
  }

  private setupChannelEvents(channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      console.log(`[WebRTCPeer] DataChannel open with ${this.peerId}`);
      this._connected = true;
      this.opts.onConnect();
    };

    channel.onclose = () => {
      console.log(`[WebRTCPeer] DataChannel closed with ${this.peerId}`);
      this._connected = false;
      this.opts.onDisconnect();
    };

    channel.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.opts.onData(new Uint8Array(event.data));
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
    if (this.channel && this.channel.readyState === 'open') {
      try {
        if (typeof msg === 'string') {
          this.channel.send(msg);
        } else {
          // DOM typed definitions require ArrayBuffer or strict ArrayBufferView.
          // Type cast 'any' protects against SharedArrayBuffer mismatch in TS config.
          this.channel.send(msg as any);
        }
      } catch (e) {
        console.error(`[WebRTCPeer] Send failed`, e);
      }
    }
  }

  public close(): void {
    this._connected = false;
    if (this.channel) this.channel.close();
    this.pc.close();
  }
}
