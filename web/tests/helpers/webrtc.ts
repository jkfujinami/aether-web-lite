/**
 * Node 上で WebRTC の代わりに使う最小実装。
 *
 * 目的は「PeerManager → WebRTCPeer → ChunkedSender → DataChannel →
 * ChunkedReceiver → handleData → dispatcher」という実際の経路を
 * そのまま通すこと。ハンドシェイクやレート制限を本物のコードで検証したいので、
 * PeerManager 側にはテスト用の分岐を一切入れない。
 *
 * SDP の中身に PC の識別子を埋め込むことで 2 つの PC を突き合わせる。
 */

let pcSeq = 0;
const registry = new Map<string, FakeRTCPeerConnection>();

class FakeDataChannel {
  public readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  public binaryType = 'arraybuffer';
  public bufferedAmount = 0;
  public onopen: (() => void) | null = null;
  public onclose: (() => void) | null = null;
  public onmessage: ((e: { data: any }) => void) | null = null;
  public peer: FakeDataChannel | null = null;
  /** テストから通信を落とすためのスイッチ */
  public dropAll = false;

  constructor(public readonly label: string) {}

  send(data: any): void {
    if (this.readyState !== 'open' || !this.peer || this.dropAll) return;
    const bytes = data instanceof Uint8Array
      ? data.slice()
      : typeof data === 'string'
        ? new TextEncoder().encode(data)
        : new Uint8Array(data);
    const target = this.peer;
    // 実際の DataChannel と同じく非同期に届く
    queueMicrotask(() => {
      if (target.readyState === 'open') {
        target.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
      }
    });
  }

  open(): void {
    if (this.readyState === 'open') return;
    this.readyState = 'open';
    queueMicrotask(() => this.onopen?.());
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    queueMicrotask(() => this.onclose?.());
  }
}

class FakeRTCPeerConnection {
  public readonly id = `pc${++pcSeq}`;
  public localDescription: any = null;
  public remoteDescription: any = null;
  public iceConnectionState = 'new';
  public onicecandidate: ((e: any) => void) | null = null;
  public ondatachannel: ((e: any) => void) | null = null;
  public oniceconnectionstatechange: (() => void) | null = null;

  private channel: FakeDataChannel | null = null;
  private remotePcId: string | null = null;

  constructor(_config?: any) {
    registry.set(this.id, this);
  }

  createDataChannel(label: string): FakeDataChannel {
    this.channel = new FakeDataChannel(label);
    return this.channel;
  }

  async createOffer() {
    return { type: 'offer', sdp: `fake-sdp:${this.id}` };
  }

  async createAnswer() {
    return { type: 'answer', sdp: `fake-sdp:${this.id}` };
  }

  async setLocalDescription(desc: any) {
    this.localDescription = desc;
  }

  async setRemoteDescription(desc: any) {
    this.remoteDescription = desc;
    const sdp = desc?.sdp ?? '';
    const match = /fake-sdp:(pc\d+)/.exec(String(sdp));
    if (match) {
      this.remotePcId = match[1];
      this.tryLink();
    }
  }

  private tryLink(): void {
    if (!this.remotePcId) return;
    const other = registry.get(this.remotePcId);
    if (!other || other.remotePcId !== this.id) return;

    // 応答側はまだチャネルを持っていないので、ここで作って ondatachannel を焚く
    for (const pc of [this, other]) {
      if (!pc.channel) {
        pc.channel = new FakeDataChannel('aether');
        const ch = pc.channel;
        queueMicrotask(() => pc.ondatachannel?.({ channel: ch }));
      }
    }

    const a = this.channel!;
    const b = other.channel!;
    a.peer = b;
    b.peer = a;

    // ondatachannel のハンドラ登録が済んでから open する
    queueMicrotask(() => {
      this.iceConnectionState = 'connected';
      other.iceConnectionState = 'connected';
      a.open();
      b.open();
    });
  }

  async addIceCandidate(_c: any) {}

  close(): void {
    this.iceConnectionState = 'closed';
    this.channel?.close();
    registry.delete(this.id);
  }

  /** テスト用: この接続のチャネルを取り出す */
  getChannel(): FakeDataChannel | null {
    return this.channel;
  }
}

/** グローバルに WebRTC のスタブを設置する */
export function installFakeWebRTC(): void {
  const g = globalThis as any;
  g.RTCPeerConnection = FakeRTCPeerConnection;
  g.RTCSessionDescription = class {
    type: string;
    sdp: string;
    constructor(init: any) {
      this.type = init?.type;
      this.sdp = init?.sdp;
    }
  };
  g.RTCIceCandidate = class {
    candidate: string;
    constructor(init: any) {
      this.candidate = init?.candidate ?? '';
    }
  };
}

export function resetFakeWebRTC(): void {
  registry.clear();
}

/**
 * 2 つの SignalingClient 代役の間で SDP/ICE を往復させる。
 * 実運用のトラッカー中継と同じ形 (senderId を添えて相手に渡す) を再現する。
 */
export function wireSignaling(
  a: { id: string; sendRelay: (t: string, p: any) => void; emitRelay: (s: string, p: any) => void },
  b: { id: string; sendRelay: (t: string, p: any) => void; emitRelay: (s: string, p: any) => void },
): void {
  // 実装は各テストで FakeSignalingClient を直接繋ぐため、ここはプレースホルダ
  void a;
  void b;
}
