import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { SessionManager } from './SessionManager';
import sodium, { sodiumReady } from '../lib/crypto/sodium';
import { NodeIdentity, NODE_ID_POW, type NodeIdPowParams } from '../lib/crypto/NodeIdentity';
import { RateLimiter, type RateLimitConfig } from '../lib/network/RateLimiter';

const PEER_ID_RE = /^[0-9a-f]{32}$/;

/** 1 フレームの上限。これを超える join/relay は読まずに切る */
const MAX_FRAME_BYTES = 64 * 1024;

/**
 * トラッカー側のレート制限。
 * ここは「1 本の WebSocket 接続あたり」で数える。
 */
const TRACKER_LIMITS: Record<string, RateLimitConfig> = {
  // NodeId PoW の検証は Argon2id 1 回 (~3.4ms) なので特に絞る
  join: { ratePerSec: 0.2, burst: 3 },
  relay: { ratePerSec: 20, burst: 60 },
};

export interface TrackerOptions {
  /** NodeId PoW のパラメータ。テストや開発では難易度を下げられる */
  powParams?: NodeIdPowParams;
  rateLimiter?: RateLimiter;
}

/**
 * TrackerServer — ブートストラップ用のシグナリング。
 *
 * 修正した穴:
 *   1. セッション乗っ取り
 *      旧: join は無認証で、SessionManager が peerId を無条件に上書きしていた。
 *          被害者の peerId を名乗るだけで、被害者宛の SDP/ICE を全部奪えた。
 *      新: Bound Identity (peerId = SHA256(pubkey) + NodeId PoW) を検証し、
 *          生きているセッションの上書きも拒否する。
 *   2. Sybil によるブートストラップ汚染
 *      旧: 誰でも無制限に join できたので、ピアリストを Sybil で埋められた。
 *      新: NodeId PoW (Argon2id) が identity 1 個あたりのコストを立てる。
 *   3. 購読ゾーンの集積
 *      旧: join が zones 配列を運び、トラッカーが保持して配布していた。
 *          「誰が何に興味があるか」がトラッカー 1 箇所に集まっていた。
 *      新: zones は受け取らない。
 *   4. レート制限の不在
 *      新: join / relay ともに接続単位のトークンバケットを通す。
 */
export class TrackerServer {
  private wss: WebSocketServer;
  private sessionManager: SessionManager;
  private wsToPeerId: Map<WebSocket, string> = new Map();
  /** レートリミッタの鍵に使う、接続ごとの匿名 ID */
  private wsToConnId: Map<WebSocket, string> = new Map();
  private rateLimiter: RateLimiter;
  private powParams: NodeIdPowParams;
  private ready: Promise<void>;
  private connSeq = 0;

  constructor(server: Server, options: TrackerOptions = {}) {
    this.sessionManager = new SessionManager();
    this.rateLimiter = options.rateLimiter ?? new RateLimiter(TRACKER_LIMITS);
    this.powParams = options.powParams ?? NODE_ID_POW;
    this.ready = sodiumReady;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

    // Next.js の HMR（/_next/webpack-hmr）と競合しないよう、手動で '/ws' のみフックする
    server.on('upgrade', (req, socket, head) => {
      const url = req.url || '';
      if (url.startsWith('/ws')) {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit('connection', ws, req);
        });
      }
    });

    this.wss.on('connection', (ws: WebSocket) => {
      this.wsToConnId.set(ws, `conn${++this.connSeq}`);
      ws.on('message', (message: Buffer | string) => {
        void this.handleMessage(ws, message);
      });
      ws.on('close', () => {
        this.wsToPeerId.delete(ws);
        const connId = this.wsToConnId.get(ws);
        if (connId) this.rateLimiter.forget(connId);
        this.wsToConnId.delete(ws);
      });
      ws.on('error', () => { /* close で回収される */ });
    });

    console.log(`[TrackerServer] Attached to provided HTTP server on /ws`);
  }

  private allow(ws: WebSocket, category: string): boolean {
    const connId = this.wsToConnId.get(ws) ?? 'unknown';
    return this.rateLimiter.allow(connId, category);
  }

  private async handleMessage(ws: WebSocket, raw: Buffer | string): Promise<void> {
    let data: any;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return this.sendError(ws, 'Message parsing failed');
    }

    try {
      if (data?.type === 'join') {
        await this.handleJoin(ws, data);
      } else if (data?.type === 'relay') {
        this.handleRelay(ws, data);
      }
    } catch (e) {
      console.warn(`[TrackerServer] Failed to handle message`, e);
      this.sendError(ws, 'Internal error');
    }
  }

  private async handleJoin(ws: WebSocket, data: any): Promise<void> {
    if (!this.allow(ws, 'join')) return this.sendError(ws, 'Rate limit exceeded');

    await this.ready;

    const { peerId, pubkey, powCounter, isSeed, isCache } = data;

    if (typeof peerId !== 'string' || !PEER_ID_RE.test(peerId)) {
      return this.sendError(ws, 'Invalid peerId');
    }
    if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(pubkey)) {
      return this.sendError(ws, 'Invalid pubkey');
    }
    if (!Number.isSafeInteger(powCounter) || powCounter < 0) {
      return this.sendError(ws, 'Invalid powCounter');
    }

    // ★ Bound Identity の検証。
    //   peerId が公開鍵のハッシュであること、および NodeId PoW を
    //   満たすことを確認する。これがブートストラップ段階での
    //   Sybil / なりすましの関門になる。
    const claim = {
      peerId,
      pubkey: sodium.from_hex(pubkey),
      powCounter,
    };
    if (!NodeIdentity.verifyClaim(claim, this.powParams)) {
      console.warn(`[TrackerServer] Rejected join with invalid identity claim: ${peerId}`);
      return this.sendError(ws, 'Invalid identity claim');
    }

    if (isSeed) {
      const MAX_SEEDS = 10;
      if (this.sessionManager.getSeedCount() >= MAX_SEEDS) {
        console.warn(`[TrackerServer] Seed limit reached (${MAX_SEEDS}). Rejecting ${peerId}`);
        return this.sendError(ws, 'Seed limit reached');
      }
    }

    const result = this.sessionManager.registerSession(ws, peerId, !!isSeed, !!isCache);
    if (!result.ok) {
      return this.sendError(ws, result.reason === 'peer-id-taken' ? 'peerId already in use' : 'Tracker at capacity');
    }

    this.wsToPeerId.set(ws, peerId);

    const peers = this.sessionManager.getRandomPeers(peerId, 8);
    console.log(`[TrackerServer] Sending ${peers.length} peers to ${peerId}`);
    this.send(ws, { type: 'peers', peers });
  }

  private handleRelay(ws: WebSocket, data: any): void {
    if (!this.allow(ws, 'relay')) return;

    const { targetPeerId, payload } = data;

    // 送信元は WebSocket からの逆引きだけを信じる。
    // ペイロード中の senderId は上書きする (詐称防止)。
    const senderPeerId = this.wsToPeerId.get(ws);
    if (!senderPeerId) {
      console.warn(`[TrackerServer] Relay from unknown ws (not joined yet)`);
      return;
    }

    if (typeof targetPeerId !== 'string' || !PEER_ID_RE.test(targetPeerId)) {
      return this.sendError(ws, 'Invalid relay target');
    }
    if (targetPeerId === senderPeerId) return;
    if (!payload || typeof payload !== 'object') return;

    const targetSession = this.sessionManager.getSession(targetPeerId);
    if (!targetSession) {
      console.warn(`[TrackerServer] Target peer not found for relay: ${targetPeerId}`);
      return;
    }

    // 構造を維持したまま senderId を「サーバーが知っている本当の送信元」で
    // 上書きして転送する。クライアントが名乗った senderId は採用しない。
    const forwarded = {
      ...payload,
      senderId: senderPeerId,
      from: senderPeerId,
    };

    this.send(targetSession.ws, forwarded);
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private sendError(ws: WebSocket, message: string): void {
    this.send(ws, { type: 'error', message });
  }

  public shutdown(): void {
    this.sessionManager.destroy();
    this.wss.close();
  }
}
