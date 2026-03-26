# Step 8: シグナリングサーバー（トラッカー） — 詳細仕様

**ステータス**: ✅ 設計完了
**更新日**: 2026-03-20
**前提**: なし（他Stepと並行実装可能）
**参照**: `aether_web_lite_design.md` §11, §13

---

## 1. 概要

### 1.1 トラッカーの役割

```
WebRTCの制約:
  ブラウザ同士が直接通信するには、最初にSDP (Session Description Protocol) を
  交換する必要がある。この交換を仲介するのがシグナリングサーバー（トラッカー）。

  「部屋に入るためのドアを開けてくれる案内人」
  → 一度入ったら、もう案内人は不要

トラッカーの存在意義:
  WebRTCの技術的制約（最初の1人目と出会う手段がない）を補うためだけに存在。
  一度メッシュに参加すれば、PEX + SDP Relay で完全自律運用。

トラッカーは:
  ✅ SDPを中継する
  ✅ 初期ピアリスト（8人）を紹介する
  ✅ Turnstileトークンを検証する
  ❌ 暗号鍵を保持しない
  ❌ 通信内容を見ない
  ❌ ユーザーの購読情報を知らない
  ❌ ログを永続保存しない（メモリのみ、切断時に即破棄）
```

### 1.2 トラッカーのライフサイクル

```
1. ユーザーがサイトを開く
   → Cloudflare Bot Fight Mode で自動ブラウザチェック
   → Cloudflare Turnstile トークンを取得

2. WebSocket でトラッカーに接続（Turnstileトークン付き）
   → トラッカーがTurnstile API でトークン検証
   → 有効: ピアリスト（8人）を返却
   → 無効: 接続拒否

3. クライアントはリスト中のピアとWebRTC接続を開始
   → トラッカー経由でSDP/ICE候補を交換

4. RING_LOCAL(4)人以上と接続完了
   → トラッカーとのWebSocketを切断
   → 以降はP2P(PEX + SDP Relay)のみで運用

5. 緊急事態（degree=0、完全孤立）
   → トラッカーに一時再接続
   → 新しいピアを取得して復旧
   → 復旧後に再度切断
```

---

## 2. サーバーアーキテクチャ

### 2.1 技術スタック

| コンポーネント | 技術 | 理由 |
|:--------------|:-----|:-----|
| ランタイム | Node.js 22 LTS | 安定版、WebSocket標準サポート |
| WebSocket | `ws` パッケージ | 最軽量、高性能WebSocket実装 |
| CAPTCHA | Cloudflare Turnstile | 無料、ユーザー透過的 |
| リバースプロキシ | Cloudflare (CDN/WAF) | DDoS保護、Bot Fight Mode |
| デプロイ | Docker + Fly.io / Railway | 低コスト、リージョン分散 |

### 2.2 ファイル構成

```
server/
├── package.json
├── tsconfig.json
├── Dockerfile
└── src/
    ├── index.ts               # エントリポイント・サーバー起動
    ├── TrackerServer.ts       # WebSocketシグナリングサーバー本体
    ├── SessionManager.ts      # 接続中ピアの管理・ピアリスト生成
    ├── RateLimiter.ts         # レートリミット（IP単位）
    ├── TurnstileVerifier.ts   # Cloudflare Turnstile トークン検証
    └── types.ts               # メッセージ型定義
```

---

## 3. メッセージプロトコル

### 3.1 クライアント → サーバー

```typescript
type ClientToServer =
  | {
      type: 'hello';
      peerId: string;           // crypto.randomUUID()
      position: number;         // Ring-Mesh上の位置 (0.0〜1.0)
      zones: number[];          // 購読ゾーンIDリスト (最大16個)
      turnstileToken: string;   // Cloudflare Turnstile トークン
    }
  | {
      type: 'offer';
      from: string;             // 送信者peerId
      to: string;               // 宛先peerId
      sdp: RTCSessionDescriptionInit;
    }
  | {
      type: 'answer';
      from: string;
      to: string;
      sdp: RTCSessionDescriptionInit;
    }
  | {
      type: 'ice-candidate';
      from: string;
      to: string;
      candidate: RTCIceCandidateInit;
    }
  | {
      type: 'goodbye';
    };
```

### 3.2 サーバー → クライアント

```typescript
type ServerToClient =
  | {
      type: 'welcome';
      assignedPeers: Array<{
        peerId: string;
        position: number;
        zones: number[];
      }>;
    }
  | {
      type: 'offer';
      from: string;
      sdp: RTCSessionDescriptionInit;
    }
  | {
      type: 'answer';
      from: string;
      sdp: RTCSessionDescriptionInit;
    }
  | {
      type: 'ice-candidate';
      from: string;
      candidate: RTCIceCandidateInit;
    }
  | {
      type: 'error';
      code: string;
      message: string;
    };
```

### 3.3 エラーコード

| コード | 意味 | クライアント対応 |
|:-------|:-----|:---------------|
| `INVALID_TOKEN` | Turnstileトークン無効 | ページリロードして再取得 |
| `RATE_LIMITED` | レートリミット超過 | バックオフして再接続 |
| `PEER_NOT_FOUND` | SDP転送先が見つからない | 別のピアを試行 |
| `SERVER_FULL` | 同時接続数上限 | 別リージョンのトラッカーに接続 |

---

## 4. 実装詳細

### 4.1 TrackerServer（メイン）

```typescript
// TrackerServer.ts

import { WebSocketServer, WebSocket } from 'ws';
import { SessionManager } from './SessionManager';
import { RateLimiter } from './RateLimiter';
import { TurnstileVerifier } from './TurnstileVerifier';

export class TrackerServer {
  private wss: WebSocketServer;
  private sessions: SessionManager;
  private rateLimiter: RateLimiter;
  private turnstile: TurnstileVerifier;

  constructor(port: number) {
    this.wss = new WebSocketServer({ port });
    this.sessions = new SessionManager();
    this.rateLimiter = new RateLimiter();
    this.turnstile = new TurnstileVerifier(process.env.TURNSTILE_SECRET!);

    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));

    console.log(`Tracker listening on :${port}`);
  }

  private async onConnection(ws: WebSocket, req: any): Promise<void> {
    const ip = req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress;

    // レートリミットチェック
    if (!this.rateLimiter.allow(ip)) {
      ws.send(JSON.stringify({
        type: 'error', code: 'RATE_LIMITED',
        message: 'Too many connections. Try again later.',
      }));
      ws.close();
      return;
    }

    // 最大接続時間タイマー
    const sessionTimer = setTimeout(() => {
      ws.close(1000, 'Session timeout');
    }, TRACKER.MAX_SESSION_DURATION);

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ClientToServer;
        await this.handleMessage(ws, ip, msg);
      } catch (e) {
        // 不正なメッセージは無視
      }
    });

    ws.on('close', () => {
      clearTimeout(sessionTimer);
      this.sessions.remove(ws);
    });
  }

  private async handleMessage(
    ws: WebSocket,
    ip: string,
    msg: ClientToServer,
  ): Promise<void> {
    switch (msg.type) {
      case 'hello':
        await this.handleHello(ws, ip, msg);
        break;

      case 'offer':
      case 'answer':
      case 'ice-candidate':
        this.handleRelay(ws, msg);
        break;

      case 'goodbye':
        this.sessions.remove(ws);
        ws.close();
        break;
    }
  }

  private async handleHello(
    ws: WebSocket,
    ip: string,
    msg: Extract<ClientToServer, { type: 'hello' }>,
  ): Promise<void> {
    // 1. Turnstile検証
    const valid = await this.turnstile.verify(msg.turnstileToken, ip);
    if (!valid) {
      ws.send(JSON.stringify({
        type: 'error', code: 'INVALID_TOKEN',
        message: 'Turnstile verification failed.',
      }));
      ws.close();
      return;
    }

    // 2. セッション登録
    this.sessions.add(ws, {
      peerId: msg.peerId,
      position: msg.position,
      zones: msg.zones,
      ip,  // メモリのみ。永続化しない。
    });

    // 3. 初期ピアリストを生成して返却
    const peers = this.sessions.selectPeersFor(msg.peerId, msg.position, msg.zones);

    ws.send(JSON.stringify({
      type: 'welcome',
      assignedPeers: peers.map(p => ({
        peerId: p.peerId,
        position: p.position,
        zones: p.zones,
      })),
    }));
  }

  private handleRelay(ws: WebSocket, msg: ClientToServer): void {
    if (!('to' in msg)) return;
    const targetWs = this.sessions.getWs(msg.to);
    if (!targetWs) {
      ws.send(JSON.stringify({
        type: 'error', code: 'PEER_NOT_FOUND',
        message: `Peer ${msg.to} is not connected.`,
      }));
      return;
    }

    // SDPリレー: 宛先のWebSocketに転送
    targetWs.send(JSON.stringify({
      type: msg.type,
      from: msg.from,
      ...(msg.type === 'ice-candidate'
        ? { candidate: (msg as any).candidate }
        : { sdp: (msg as any).sdp }),
    }));
  }
}
```

### 4.2 SessionManager（ピア管理）

```typescript
// SessionManager.ts

interface PeerSession {
  peerId: string;
  position: number;
  zones: number[];
  ip: string;
  connectedAt: number;
}

export class SessionManager {
  private sessions: Map<WebSocket, PeerSession> = new Map();
  private peerToWs: Map<string, WebSocket> = new Map();

  add(ws: WebSocket, session: Omit<PeerSession, 'connectedAt'>): void {
    const full = { ...session, connectedAt: Date.now() };
    this.sessions.set(ws, full);
    this.peerToWs.set(session.peerId, ws);
  }

  remove(ws: WebSocket): void {
    const session = this.sessions.get(ws);
    if (session) {
      this.peerToWs.delete(session.peerId);
      this.sessions.delete(ws);
      // ★ IPアドレス等の情報も即座に消滅（メモリから削除）
    }
  }

  getWs(peerId: string): WebSocket | undefined {
    return this.peerToWs.get(peerId);
  }

  /**
   * 新規ピアに紹介する初期ピアリストを選出
   *
   * 選出戦略（Ring-Mesh + Zone-aware）:
   *   1. Ring上の近接ピア（position距離が近い）を4人
   *   2. Zone共有が多いピアを2人
   *   3. ランダムなロングレンジピアを2人
   *   合計: 8人
   */
  selectPeersFor(
    requesterId: string,
    requesterPosition: number,
    requesterZones: number[],
  ): PeerSession[] {
    const candidates = Array.from(this.sessions.values())
      .filter(s => s.peerId !== requesterId);

    if (candidates.length === 0) return [];
    if (candidates.length <= 8) return candidates;

    const result: PeerSession[] = [];
    const used = new Set<string>();

    // 1. Ring近接（4人）
    const byDist = [...candidates].sort((a, b) =>
      this.ringDist(requesterPosition, a.position) -
      this.ringDist(requesterPosition, b.position),
    );
    for (const p of byDist) {
      if (result.length >= 4) break;
      if (!used.has(p.peerId)) { result.push(p); used.add(p.peerId); }
    }

    // 2. Zone共有（2人）
    const zonesSet = new Set(requesterZones);
    const byZone = [...candidates]
      .filter(c => !used.has(c.peerId))
      .map(c => ({
        peer: c,
        shared: c.zones.filter(z => zonesSet.has(z)).length,
      }))
      .sort((a, b) => b.shared - a.shared);
    for (const { peer } of byZone) {
      if (result.length >= 6) break;
      if (!used.has(peer.peerId)) { result.push(peer); used.add(peer.peerId); }
    }

    // 3. ランダム（2人）
    const remaining = candidates.filter(c => !used.has(c.peerId));
    this.shuffle(remaining);
    for (const p of remaining) {
      if (result.length >= 8) break;
      result.push(p); used.add(p.peerId);
    }

    return result;
  }

  get connectedCount(): number { return this.sessions.size; }

  private ringDist(a: number, b: number): number {
    const d = Math.abs(a - b); return Math.min(d, 1 - d);
  }

  private shuffle<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
}
```

### 4.3 RateLimiter

```typescript
// RateLimiter.ts

export class RateLimiter {
  private connections: Map<string, number[]> = new Map();

  /**
   * IPベースのレートリミット
   * 同一IPからの接続: 30秒に1回まで
   */
  allow(ip: string): boolean {
    const now = Date.now();
    const history = this.connections.get(ip) ?? [];

    // 5分以上古いエントリを削除
    const recent = history.filter(t => now - t < 5 * 60 * 1000);

    // 30秒以内に接続がある → 拒否
    if (recent.length > 0 && now - recent[recent.length - 1] < 30_000) {
      this.connections.set(ip, recent);
      return false;
    }

    // 5分間に10回以上 → 拒否（バースト防止）
    if (recent.length >= 10) {
      this.connections.set(ip, recent);
      return false;
    }

    recent.push(now);
    this.connections.set(ip, recent);

    // 定期的にメモリ解放（1時間以上古いIPを削除）
    if (this.connections.size > 10000) {
      this.cleanup();
    }

    return true;
  }

  private cleanup(): void {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [ip, history] of this.connections) {
      if (history.every(t => t < cutoff)) {
        this.connections.delete(ip);
      }
    }
  }
}
```

### 4.4 TurnstileVerifier

```typescript
// TurnstileVerifier.ts

export class TurnstileVerifier {
  private readonly secretKey: string;
  private readonly verifyUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

  constructor(secretKey: string) {
    this.secretKey = secretKey;
  }

  /**
   * Cloudflare Turnstile トークンを検証
   */
  async verify(token: string, remoteIp: string): Promise<boolean> {
    try {
      const res = await fetch(this.verifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret: this.secretKey,
          response: token,
          remoteip: remoteIp,
        }),
      });

      const data = await res.json() as { success: boolean };
      return data.success;
    } catch {
      // API障害時はフォールバック: 許可（DoSの一時対処）
      console.error('Turnstile API error, allowing connection');
      return true;
    }
  }
}
```

---

## 5. セキュリティ

### 5.1 4層防御（設計書§13準拠）

```
第1層: Cloudflare Bot Fight Mode + Turnstile
  → ボットの自動大量参加を阻止
  → Headless Chrome / Puppeteer / curl → 即ブロック

第2層: トラッカーのレートリミット
  → 同一IP: 30秒に1回まで
  → 5分間に10回まで
  → 1万ノード立てるには 1万 × 30秒 = 83時間（3.5日）必要

第3層: Node Aging（メッシュ側で適用）
  → 新参ノード（Age < 10分）はMailbox担当に選ばれない
  → PEXで他人に紹介されない

第4層: K-Replicatonの多数決（メッシュ側で適用）
  → 5ノード中3ノード以上の合意で正データを採用
```

### 5.2 プライバシー保護

```
トラッカーが知る情報:
  ✅ IPアドレス（WebSocket接続元）
  ✅ peerId（セッション単位のランダムUUID）
  ✅ position（Ring上の位置。ランダムなfloat）
  ✅ zones（購読ゾーンIDリスト。ダミー含む）

トラッカーが知らない情報:
  ❌ boardkey / thread_key（暗号鍵）
  ❌ 板名、スレッド名、投稿内容
  ❌ ユーザーが何を読んでいるか（Broadcast Veilにより不可視）

ログポリシー:
  ★ IPアドレスはメモリ上のみ保持
  ★ WebSocket切断と同時に即破棄（SessionManager.remove()）
  ★ ディスクに書き込むデータは一切なし
  ★ アクセスログも保存しない（console.logは標準エラー出力のみ）
```

### 5.3 トラッカーのposition/zones漏洩リスク

```
Q: トラッカーにpositionとzonesを送るのはリスクか？
A: 限定的リスク。

  position: ランダムなfloat（0.0〜1.0）
    → Ring-Mesh上の位置。セッションごとに異なる可能性あり
    → 永続化した場合は固定だが、位置自体に意味はない

  zones: 16個のゾーンID（ダミー含む）
    → 16個中15個はダミーの可能性（K=16匿名性が適用）
    → トラッカーが本命ゾーンを特定する確率 = 1/16 = 6.25%

  対策:
    → positionはセッション間で変更可能（IndexedDB永続化を無効化）
    → zonesはクライアント側で生成済み（ダミー混入済み）
    → トラッカーは切断後にデータ破棄

  残存リスク:
    → トラッカー運営者が悪意を持つ場合、
      接続時のIP + zones の組み合わせを記録できる
    → 対策: トラッカーの多重化（複数の独立トラッカー）
```

---

## 6. 設定パラメータ

```typescript
export const TRACKER = {
  /** トラッカーのWebSocket URL */
  URL: 'wss://tracker.reiwa-2ch.net/ws',

  /** フォールバックトラッカー（多重化） */
  FALLBACK_URLS: [
    'wss://tracker2.reiwa-2ch.net/ws',
    'wss://tracker-us.reiwa-2ch.net/ws',
  ],

  /** トラッカーから取得する初期ピア数 */
  INITIAL_PEERS: 8,

  /** WebSocket接続の最大維持時間 (ms) */
  MAX_SESSION_DURATION: 30_000,  // 30秒

  /** トラッカー再接続のバックオフ (ms) */
  RECONNECT_BACKOFF: [0, 5_000, 15_000, 30_000, 60_000],

  /** レートリミット: 接続間隔 (ms) */
  RATE_LIMIT_INTERVAL: 30_000,

  /** レートリミット: 5分間の最大接続数 */
  RATE_LIMIT_BURST: 10,

  /** Turnstile サイトキー（フロントエンド） */
  TURNSTILE_SITE_KEY: '0x...',

  /** サーバー側のListenポート */
  PORT: 8080,
} as const;
```

---

## 7. デプロイメント

### 7.1 Dockerfile

```dockerfile
FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/node_modules/ ./node_modules/
COPY package.json ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]
```

### 7.2 環境変数

| 変数 | 必須 | 説明 |
|:-----|:----:|:-----|
| `TURNSTILE_SECRET` | ✅ | Cloudflare Turnstile のシークレットキー |
| `PORT` | ❌ | Listenポート（デフォルト: 8080） |
| `MAX_CONNECTIONS` | ❌ | 最大同時接続数（デフォルト: 10000） |

### 7.3 インフラ構成

```
┌─────────────────────────────────────────────┐
│  Cloudflare (CDN / WAF / Bot Fight Mode)    │
│  ・DDoS保護                                  │
│  ・Bot検知                                    │
│  ・WebSocket Proxying                        │
├─────────────────────────────────────────────┤
│  Fly.io / Railway (Docker Container)        │
│  ・TrackerServer (Node.js)                   │
│  ・リージョン: 東京, US-East, EU-West        │
│  ・スケール: 各リージョン1インスタンス         │
│  ・メモリ: 256MB〜512MB                      │
├─────────────────────────────────────────────┤
│  コスト見積もり                               │
│  ・Cloudflare: 無料（Free plan）             │
│  ・Fly.io: ~$5/月（最小インスタンス）         │
│  ・合計: ~$5〜15/月（3リージョン）            │
└─────────────────────────────────────────────┘
```

### 7.4 多重化戦略

```
複数の独立トラッカーを運用:

  tracker.reiwa-2ch.net        → 東京リージョン
  tracker2.reiwa-2ch.net       → US-Eastリージョン
  tracker-us.reiwa-2ch.net     → EU-Westリージョン

クライアントの接続先選択:
  1. メイン(東京)に接続試行
  2. 失敗 → フォールバック1(US)に接続試行
  3. 失敗 → フォールバック2(EU)に接続試行
  4. 全失敗 → UIに「ネットワーク接続不可」表示

メリット:
  - 1台のトラッカーが落ちても他で代替
  - リージョン分散で低レイテンシ
  - トラッカーはステートレス（セッション情報はメモリのみ）
    → どのトラッカーに接続しても同じ
```

---

## 8. 監視とメトリクス

### 8.1 収集するメトリクス（プライバシーに配慮）

```typescript
// 定期出力（60秒間隔、stdout）
interface TrackerMetrics {
  /** 現在の同時接続数 */
  activeConnections: number;
  /** 直近1分の新規接続数 */
  connectionsPerMinute: number;
  /** 直近1分のSDP中継数 */
  relaysPerMinute: number;
  /** Turnstile検証の成功率 */
  turnstileSuccessRate: number;
  /** レートリミットの発動回数 */
  rateLimitHits: number;
  /** メモリ使用量 */
  memoryUsageMB: number;
}

// ★ 収集しないもの:
//   IPアドレスの統計
//   ゾーンIDの分布
//   ピアの接続先情報
//   その他ユーザーを識別できる情報
```

---

## 9. 実装上の注意点

### 9.1 WebSocket Heartbeat

```
WSはTCP上で動作するが、NAT/プロキシがアイドル接続を切断することがある。

対策:
  - サーバー側: 30秒ごとにws.ping()を送信
  - クライアント側: pongを自動返答（ブラウザWebSocket標準動作）
  - 45秒間pongがなければ切断

ただし、トラッカー接続は最大30秒で切断するため、
HeartbeatはほぼMAX_SESSION_DURATION用の安全弁。
```

### 9.2 同一peerId問題

```
同一ユーザーが複数タブを開いた場合、peerId は各タブで異なる。
→ 問題なし（独立したセッションとして扱う）

同一peerId で複数接続が来た場合:
→ 旧接続を切断し、新接続を採用
→ SDPリレーの宛先が常に最新接続を指すようにする
```

### 9.3 Cloudflareの背後でのIP取得

```typescript
// Cloudflare経由の場合、真のIPは cf-connecting-ip ヘッダーにある
const ip = req.headers['cf-connecting-ip']
         ?? req.headers['x-forwarded-for']
         ?? req.socket.remoteAddress;
```

### 9.4 グレースフルシャットダウン

```typescript
process.on('SIGTERM', async () => {
  console.log('Shutting down...');

  // 新規接続を拒否
  wss.close();

  // 既存接続に通知して切断
  for (const ws of wss.clients) {
    ws.send(JSON.stringify({
      type: 'error', code: 'SERVER_SHUTDOWN',
      message: 'Server is restarting. Please reconnect.',
    }));
    ws.close(1001, 'Server shutdown');
  }

  // セッション情報はメモリのみなので、破棄は自動
  process.exit(0);
});
```
