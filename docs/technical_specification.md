# AETHER Web-Lite: 技術仕様書

**バージョン**: 0.2.0
**最終更新**: 2026-03-20
**言語**: TypeScript
**対象**: ブラウザ完結型 P2P メッシュネットワーク掲示板

---

## 0. 実装ロードマップ（段階的ビルド）

| Step | 機能 | 状態 | 依存 | 仕様書 |
|:----:|:-----|:----:|:----:|:-------|
| **1** | Ring-Mesh基盤 + Adaptive Zone (WebRTC, PEX, 自己修復) | ✅ 設計完了 | なし | `step1_ring_mesh.md`, `step1_ring_mesh_zone.md` |
| **2** | Zone内ゴシップ配信 (Broadcast Veil / BFS Flood) | ✅ 設計完了 | Step 1 | `step1_ring_mesh_zone.md` §5 |
| **3** | Mailbox (Ring-DHT K=5冗長永続化 + IndexedDB) | ✅ 設計完了 | Step 1 | `step1_ring_mesh.md` §7.3 |
| **4** | 暗号化 (ChaCha20-Poly1305, Ed25519, PoW) | 📝 設計中 | Step 2, 3 | `step4_encryption.md` |
| **5** | Dandelion++ Stem（匿名強化モード） | ✅ 設計完了 | Step 2, 4 | `step5_dandelion.md` |
| **7** | UI/UX（板・スレッド・検索・設定画面） | 🔲 未着手 | Step 1-4 | — |
| **8** | シグナリングサーバー（Node.js WebSocket トラッカー） | ✅ 設計完了 | なし | `step8_signaling_server.md` |

> **注**: 旧Step 6 (K-Anonymous Zone Routing) は Step 1 に統合された。
> Adaptive Zone Depth は Ring-Mesh 基盤の一部として動作する。

---

## 1. 技術スタック

### 1.1 クライアント（ブラウザ）

| カテゴリ | ライブラリ / API | バージョン | 用途 |
|:---------|:----------------|:-----------|:-----|
| **言語** | TypeScript | 5.x | 型安全な開発 |
| **ビルド** | Vite | 6.x | バンドル・HMR |
| **フレームワーク** | Vanilla TS (後にReact検討) | - | 最小依存で基盤構築 |
| **P2P通信** | WebRTC (native API) | - | DataChannel によるピア間通信 |
| **暗号** | libsodium.js (libsodium-wrappers) | 0.7.x | ChaCha20-Poly1305, Ed25519, HMAC-SHA256 |
| **PoW** | argon2-browser (WASM) | 1.x | Client-side Proof of Work |
| **ストレージ** | Dexie.js | 4.x | IndexedDB ラッパー（Mailbox, 過去ログ） |
| **バックグラウンド** | Web Worker (native API) | - | 中継・暗号・PoW処理の委譲 |
| **シリアライズ** | MessagePack (msgpackr) | 1.x | バイナリシリアライズ（JSON比 30-50%削減） |

### 1.2 サーバー（シグナリング / トラッカー）

| カテゴリ | ライブラリ | 用途 |
|:---------|:----------|:-----|
| **ランタイム** | Node.js 22 LTS | サーバー実行環境 |
| **WebSocket** | ws | シグナリング（SDP交換） |
| **ボット対策** | Cloudflare Turnstile | 無料CAPTCHA |
| **検索API** | Hono + SQLite (better-sqlite3) | 公開スレメタデータ |

---

## 2. アーキテクチャ概要

### 2.1 二層構造

```
┌─────────────────────────────────────────────────┐
│  Layer 2: Adaptive Zone Gossip                  │
│  ・CIDRサブネッティング方式のゾーン自動分割       │
│  ・ゾーン内BFS Floodゴシップ（到達率100%）       │
│  ・K=16 匿名購読 + Dandelion++ Stem             │
├─────────────────────────────────────────────────┤
│  Layer 1: Ring-Mesh Backbone                    │
│  ・ローカルリンク4本 + Zone-aware 12本 = MAX16   │
│  ・構造的連結保証 + DHT Mailbox (K=5)            │
│  ・Heartbeat / 自動修復                           │
└─────────────────────────────────────────────────┘
```

### 2.2 確定パラメータ

```typescript
export const RING_MESH_ZONE = {
  // ── Ring-Mesh 基盤 ──
  RING_LOCAL: 4,              // ローカルリンク: 左2 + 右2
  MAX_DEGREE: 16,             // 1ノードの最大WebRTC接続数

  // ── Adaptive Zone ──
  MAX_DEPTH: 12,              // 最大4096ゾーン
  TARGET_ZONE_POP: 500,       // 1ゾーンあたり目標500人
  SUBSCRIBE_COUNT: 16,        // 常に16ゾーン購読

  // ── タイマー ──
  HEARTBEAT_INTERVAL: 15_000,
  HEARTBEAT_TIMEOUT: 45_000,
  REPAIR_CHECK_INTERVAL: 10_000,
  DEPTH_RECOMPUTE_INTERVAL: 60_000,

  // ── シグナリング ──
  INITIAL_PEERS: 8,
  CONNECTION_TIMEOUT: 10_000,
} as const;
```

---

## 3. ファイル構成

```
aether-web-lite/
├── docs/
│   ├── aether_web_lite_design.md          # 原典アーキテクチャ設計書
│   ├── technical_specification.md         # 本ファイル（技術仕様書）
│   └── spec/
│       ├── step1_ring_mesh.md             # Ring-Mesh基盤仕様
│       ├── step1_ring_mesh_zone.md        # Ring-Mesh + Adaptive Zone 統合仕様
│       ├── step4_encryption.md            # 暗号化詳細仕様
│       └── simulation_report.md           # シミュレーション結果レポート
│
├── client/                                # ブラウザ側（Vite + TS）
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── package.json
│   │
│   └── src/
│       ├── main.ts                        # エントリポイント
│       ├── types.ts                       # 共通型定義
│       ├── constants.ts                   # 定数・パラメータ
│       │
│       ├── network/                       # Step 1: Ring-Mesh + Zone基盤
│       │   ├── RingPosition.ts            # 円環位置の生成・永続化・距離計算
│       │   ├── WebRTCPeer.ts              # 個別WebRTC接続の抽象化
│       │   ├── PeerManager.ts             # 全ピア管理・ローカルリンク優先・Zone-aware接続
│       │   ├── RingMaintainer.ts          # リング構造の維持・修復・ローカル隣人計算
│       │   ├── ZoneManager.ts             # Adaptive Zone Depth管理・購読セット・depth合意
│       │   ├── PEXHandler.ts              # ロングレンジ候補 + ゾーンメイト探索
│       │   ├── SignalingClient.ts          # トラッカーWebSocket（初期接続のみ）
│       │   ├── Heartbeat.ts               # 死活監視 (Web Worker内で実行)
│       │   └── NetworkEvents.ts           # ネットワークイベント定義
│       │
│       ├── gossip/                        # Step 2: Zone内ゴシップ配信
│       │   ├── ZoneGossipRouter.ts         # ゾーン内BFS Flood・ゾーンフィルタリング
│       │   ├── DandelionRouter.ts          # Stem/Fluff切替・越境インジェクション
│       │   ├── PacketValidator.ts          # PoW検証・重複排除・TTL管理
│       │   └── SeenCache.ts               # packet_id の Bloom Filter / LRU
│       │
│       ├── mailbox/                       # Step 3: DHT永続化層
│       │   ├── DHTMailbox.ts              # Ring-DHT K最近接・PUT/GET
│       │   ├── ReplicationManager.ts      # K=5冗長・再レプリケーション
│       │   └── SyncProtocol.ts            # 新規参加者への過去ログ同期
│       │
│       ├── crypto/                        # Step 4: 暗号化
│       │   ├── CryptoEngine.ts            # ChaCha20-Poly1305 暗号化/復号
│       │   ├── KeyManager.ts              # 鍵派生 (boardkey → thread_key → topic_hash)
│       │   ├── Identity.ts                # Ed25519 鍵ペア・署名・トリップ
│       │   ├── MagicFilter.ts             # マジックバイト部分復号フィルタ
│       │   └── PoWEngine.ts               # Argon2 WASM PoW
│       │
│       ├── storage/                       # ローカルストレージ
│       │   ├── Database.ts                # Dexie.js スキーマ定義
│       │   └── PostStore.ts               # 投稿データのCRUD
│       │
│       ├── worker/                        # Web Worker
│       │   ├── network.worker.ts          # 中継・暗号・PoW検証ワーカー
│       │   └── WorkerBridge.ts            # メインスレッド ↔ Worker 通信
│       │
│       └── ui/                            # Step 7: UI（後半フェーズ）
│           ├── App.ts
│           ├── BoardView.ts
│           ├── ThreadView.ts
│           └── SettingsView.ts
│
├── server/                                # Step 8: シグナリングサーバー
│   ├── package.json
│   ├── src/
│   │   ├── index.ts
│   │   ├── TrackerServer.ts
│   │   ├── RateLimiter.ts
│   │   └── TurnstileVerifier.ts
│   └── Dockerfile
│
└── simulation/                            # シミュレーション
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── RingMeshSimulator.ts            # Ring-Mesh シミュレータ
        ├── run_adaptive_zone.ts            # ★ Adaptive Zone テスト
        ├── run_gossip_mailbox.ts           # ★ ゴシップ + Mailbox 統合テスト
        ├── run_zone_ring.ts               # Zone × MAX接続数スイープ
        ├── run_strict_ring.ts             # MAX=8厳密制限テスト
        ├── run_ring_constrained.ts        # MAX + PVスイープ
        └── run_ring.ts                    # Ring-Mesh基本テスト
```

---

## 4. P2Pメッセージ定義

```typescript
export type PeerId = string; // crypto.randomUUID()

export type P2PMessage =
  // ── Ring管理 ──
  | { type: 'join'; peerId: PeerId; position: number; zones: number[] }
  | { type: 'ring-info'; neighbors: Array<{ id: PeerId; position: number; zones: number[] }> }
  | { type: 'local-link-request'; peerId: PeerId; position: number }
  | { type: 'local-link-accept'; peerId: PeerId }
  | { type: 'local-link-reject'; reason: 'max-degree' | 'not-neighbor' }

  // ── 生存確認 ──
  | { type: 'ping'; ts: number; depth: number }
  | { type: 'pong'; ts: number; echoTs: number; depth: number }

  // ── PEX ──
  | { type: 'pex-request'; minDistance: number; preferredZones?: number[] }
  | { type: 'pex-response'; peers: Array<{ id: PeerId; position: number; zones: number[] }> }

  // ── シグナリング ──
  | { type: 'sdp-relay'; targetPeerId: PeerId; sdp: RTCSessionDescriptionInit }
  | { type: 'ice-relay'; targetPeerId: PeerId; candidate: RTCIceCandidateInit }

  // ── ゴシップ ──
  | { type: 'gossip'; zoneId: number; packet: GossipPacket }

  // ── Dandelion++ Stem ──
  | { type: 'stem'; zoneId: number; stemTtl: number; packet: GossipPacket }

  // ── DHT Mailbox ──
  | { type: 'dht-get'; topicHash: string }
  | { type: 'dht-put'; topicHash: string; data: Uint8Array }
  | { type: 'dht-response'; topicHash: string; data: Uint8Array | null };
```

---

## 5. 詳細仕様へのリファレンス

各Stepの詳細仕様は個別ファイルに記載:

| Step | 仕様書 | 主要な内容 |
|:----:|:-------|:-----------|
| — | [implementation_guide.md](implementation_guide.md) | **★ 統合実装ガイド（SOLID設計・全フロー・テスト戦略）** |
| 1 | [step1_ring_mesh.md](spec/step1_ring_mesh.md) | Ring-Mesh構造、ローカルリンク優先ルール、実装注意点10項目 |
| 1+6 | [step1_ring_mesh_zone.md](spec/step1_ring_mesh_zone.md) | Adaptive Zone Depth、K-匿名性、Zone-aware接続、Dandelion越境 |
| 4 | [step4_encryption.md](spec/step4_encryption.md) | 鍵階層、ChaCha20、Ed25519、PoW、マジックバイト |
| 5 | [step5_dandelion.md](spec/step5_dandelion.md) | Stem/Fluff、エコーリトライ、越境インジェクション |
| 8 | [step8_signaling_server.md](spec/step8_signaling_server.md) | WebSocketプロトコル、Turnstile、レートリミット、デプロイ |
| — | [simulation_report.md](spec/simulation_report.md) | 旧メッシュシミュレーション結果（参考） |

---

## 6. 廃止された仕様

以下は検証の結果採用されなかった設計。参考資料として残存:

| ファイル | 内容 | 廃止理由 |
|:---------|:-----|:---------|
| `spec/step1_mesh_network.md` | PEXベースメッシュ | 経路長O(N)、30%削除で分断 |
| `spec/step1_hyparview_mesh.md` | HyParView強化メッシュ | PV=80のIPキャッシュが必要 |
