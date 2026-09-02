import { WebSocket } from 'ws';

export interface PeerSession {
  peerId: string;
  ws: WebSocket;
  lastActive: number;
  isSeed: boolean;
  isCache: boolean;
}

export type RegisterResult =
  | { ok: true }
  | { ok: false; reason: 'peer-id-taken' | 'capacity' };

/** 同時接続セッション数の上限 (メモリ枯渇の防止) */
const MAX_SESSIONS = 5000;

/**
 * SessionManager
 *
 * ★ セッション乗っ取りの修正
 *
 * 旧実装は registerSession が
 *     this.sessions.set(peerId, {...})
 * と既存エントリを無条件に上書きしていた。join には認証が無かったので、
 * 攻撃者は被害者の peerId を名乗って join するだけで
 *   - 被害者のセッションを追い出し
 *   - 被害者宛の SDP/ICE リレーを全部自分に向ける
 * ことができた。
 *
 * 現在は「生きているセッションが既にある peerId は奪えない」ようにしてある。
 * 併せて TrackerServer 側で Bound Identity (peerId = SHA256(pubkey) +
 * NodeId PoW + 所有証明) を検証するので、他人の peerId を名乗ること自体が
 * まず通らない。
 *
 * また position / zones を保持しなくなった。position は peerId から
 * 導出できるので配る必要がなく、zones (購読ゾーン) はトラッカーに
 * 集積させると交差攻撃の材料そのものになるため受け取らない。
 */
export class SessionManager {
  private sessions: Map<string, PeerSession> = new Map();
  private cleanupTimer: NodeJS.Timeout;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanupPings(), 60_000);
  }

  public registerSession(
    ws: WebSocket,
    peerId: string,
    isSeed: boolean = false,
    isCache: boolean = false,
  ): RegisterResult {
    const existing = this.sessions.get(peerId);

    if (existing) {
      if (existing.ws === ws) {
        existing.lastActive = Date.now();
        return { ok: true };
      }
      // 生きている接続が既にある peerId は奪えない。
      // 相手が本当に落ちていれば cleanupPings が 2 分以内に回収する。
      if (existing.ws.readyState === WebSocket.OPEN || existing.ws.readyState === WebSocket.CONNECTING) {
        console.warn(`[SessionManager] Refused takeover of live session: ${peerId}`);
        return { ok: false, reason: 'peer-id-taken' };
      }
      this.sessions.delete(peerId);
    }

    if (this.sessions.size >= MAX_SESSIONS) {
      return { ok: false, reason: 'capacity' };
    }

    this.sessions.set(peerId, {
      peerId,
      ws,
      lastActive: Date.now(),
      isSeed,
      isCache,
    });

    console.log(`[SessionManager] Registered ${isSeed ? 'Seed' : (isCache ? 'Cache' : 'Peer')}: ${peerId}`);

    ws.on('close', () => {
      // 自分が登録した接続のときだけ消す。
      // 再接続で別の ws が同じ peerId を持っている場合に、
      // 古い ws の close で新しいセッションを消してしまわないようにする。
      const current = this.sessions.get(peerId);
      if (current && current.ws === ws) this.unregisterSession(peerId);
    });

    ws.on('pong', () => {
      const session = this.sessions.get(peerId);
      if (session && session.ws === ws) session.lastActive = Date.now();
    });

    return { ok: true };
  }

  public unregisterSession(peerId: string): void {
    if (this.sessions.delete(peerId)) {
      console.log(`[SessionManager] Unregistered peer: ${peerId}`);
    }
  }

  public getSession(peerId: string): PeerSession | undefined {
    return this.sessions.get(peerId);
  }

  public get size(): number {
    return this.sessions.size;
  }

  /**
   * ブートストラップ候補をランダムに返す。
   *
   * position も zones も返さない。前者は peerId から導出でき、
   * 後者はそもそも受け取っていない。
   */
  public getRandomPeers(excludeId: string, maxPeers: number = 6): { peerId: string }[] {
    const allIds = Array.from(this.sessions.keys()).filter((id) => id !== excludeId);

    // Fisher-Yates shuffle。先頭 N 件固定だと、早期に接続した攻撃者ノードが
    // 永久に紹介され続ける (本家 18.7-④ と同じ罠)。
    for (let i = allIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allIds[i], allIds[j]] = [allIds[j], allIds[i]];
    }

    return allIds.slice(0, maxPeers).map((peerId) => ({ peerId }));
  }

  public getSeedCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.isSeed) count++;
    }
    return count;
  }

  private cleanupPings(): void {
    const now = Date.now();
    for (const [peerId, session] of this.sessions.entries()) {
      if (now - session.lastActive > 120_000) {
        session.ws.terminate();
        this.sessions.delete(peerId);
        console.log(`[SessionManager] Terminated inactive peer: ${peerId}`);
      } else {
        session.ws.ping();
      }
    }
  }

  public destroy(): void {
    clearInterval(this.cleanupTimer);
    for (const session of this.sessions.values()) {
      session.ws.terminate();
    }
    this.sessions.clear();
  }
}
