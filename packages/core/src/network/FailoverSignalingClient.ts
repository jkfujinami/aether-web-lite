import type { ISignalingClient, PeerId, WireNodeClaim } from '../types';
import { SignalingClient } from './SignalingClient';
import { createLogger } from '../common/Logger';

const log = createLogger('net.signaling');

/** 1 つのトラッカーへの接続を諦めるまでの時間 */
const CONNECT_TIMEOUT_MS = 8_000;

/**
 * トラッカー URL として受け付けるか。
 *
 * ★ wss:// を必須にする (ws:// はローカルホストだけ)。
 *   トラッカーは最初の隣人の一覧を渡す。平文の WebSocket だと、
 *   途中の経路でその一覧を Sybil にすり替えられる (Eclipse の入口になる)。
 */
export function isAcceptableTrackerUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'wss:') return true;
  if (parsed.protocol === 'ws:') {
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
  }
  return false;
}

/**
 * 複数のトラッカーを順に試し、最初につながったものを使う。
 *
 * 将来トラッカー同士を同期させる (どこにつないでも同じ網に参加できる) までの
 * 間も、1 か所が落ちていれば次へ回れるようにしておく。
 */
export class FailoverSignalingClient implements ISignalingClient {
  private clients: SignalingClient[];
  private active: SignalingClient | null = null;
  private peersCb?: (peers: Array<{ peerId: PeerId }>) => void;
  private relayCb?: (senderId: PeerId, payload: any) => void;

  constructor(urls: string[]) {
    const accepted = urls.filter(isAcceptableTrackerUrl);
    if (accepted.length !== urls.length) {
      log.warn(`ignored ${urls.length - accepted.length} tracker URL(s): wss:// is required (ws:// only for localhost)`);
    }
    this.clients = accepted.map((u) => new SignalingClient(u));
  }

  public get isConnected(): boolean {
    return this.active?.isConnected ?? false;
  }

  public get hasTrackers(): boolean {
    return this.clients.length > 0;
  }

  public async connect(options: { claim: WireNodeClaim; turnstileToken?: string; signJoin?: (nonce: Uint8Array) => Uint8Array }): Promise<void> {
    if (this.clients.length === 0) throw new Error('No tracker configured');
    let lastError: unknown = null;
    for (const client of this.clients) {
      try {
        await withTimeout(client.connect(options), CONNECT_TIMEOUT_MS);
        this.active = client;
        return;
      } catch (err) {
        lastError = err;
        client.disconnect();
      }
    }
    throw lastError ?? new Error('All trackers unreachable');
  }

  public sendRelay(targetPeerId: PeerId, payload: any): void {
    this.active?.sendRelay(targetPeerId, payload);
  }

  public disconnect(): void {
    for (const c of this.clients) c.disconnect();
    this.active = null;
  }

  public on(event: 'peers', cb: (peers: Array<{ peerId: PeerId }>) => void): void;
  public on(event: 'relay', cb: (senderId: PeerId, payload: any) => void): void;
  public on(event: string, cb: any): void {
    if (event === 'peers') this.peersCb = cb;
    if (event === 'relay') this.relayCb = cb;
    for (const c of this.clients) {
      // 今つながっているトラッカーからの通知だけを渡す
      if (event === 'peers') c.on('peers', (peers) => { if (c === this.active) this.peersCb?.(peers); });
      if (event === 'relay') c.on('relay', (sender, payload) => { if (c === this.active) this.relayCb?.(sender, payload); });
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('tracker connect timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
