# AETHER Web-Lite: 残タスク一覧 (2026-03-26)

> 全ソースコード（JS 20ファイル / Rust 10ファイル / Server 3ファイル）を行単位で精読し、
> `docs/implementation_guide.md` のファイル構成・致命的注意点と突き合わせた結果です。

---

## ✅ 完了済み（動作確認済み）

| カテゴリ | ファイル | 内容 |
|:---------|:---------|:-----|
| Ring-Mesh | `RingPosition.ts` | 座標生成 + localStorage 永続化 |
| Ring-Mesh | `WebRTCPeer.ts` | WebRTC 接続・切断検知・Ping/Pong |
| Ring-Mesh | `PeerManager.ts` | 接続管理・ロングレンジ evict・クールダウン・ゴーストタイムアウト |
| Ring-Mesh | `RingMaintainer.ts` | トポロジー修復・PEX 自動発行 |
| Ring-Mesh | `PEXHandler.ts` | ピア紹介・viaPeerId 経由の分散シグナリング |
| Ring-Mesh | `SignalingClient.ts` | トラッカー WS 接続・15秒後の自動切断 |
| Ring-Mesh | `constants.ts` | 全定数パラメータ（MAX_DEGREE=8 等） |
| Ring-Mesh | `types.ts` | 型定義・インターフェース（IPeerManager 等） |
| Gossip | `ZoneGossipRouter.ts` | Gossip 受信・Fluff 送信・Stem 中継 |
| Gossip | `DandelionRouter.ts` | Stem phase・Fluff 判定・Echo 待ち・Epoch 管理 |
| Gossip | `SeenCache.ts` | LRU 重複排除（50,000件・TTL 15分） |
| Gossip | `PacketValidator.ts` | サイズ制限・時刻検証・PoW 検証 |
| Crypto | `CryptoEngine.ts` | ChaCha20-Poly1305 AEAD 暗号化/復号 + マジックバイト |
| Crypto | `MagicFilter.ts` | Broadcast Veil 用の高速4Bスクリーニング |
| Crypto | `KeyManager.ts` | boardkey→thread_key→topic_hash 派生 + zone_id 計算 |
| Crypto | `Identity.ts` | Ed25519 セッション鍵・署名・検証 |
| Crypto | `PacketBuilder.ts` | 3層パケット構築（署名→暗号化→PoW） |
| Crypto | `PoWEngine.ts` | **Web Worker 経由** の Argon2id 計算（UIフリーズ解消済み） |
| Crypto | `DifficultyEstimator.ts` | ネットワーク速度ベースの難易度自律合意 |
| Worker | `pow.worker.ts` | Argon2id の実計算を隔離する Worker |
| Worker | `WorkerBridge.ts` | メインスレッド ↔ Worker の Promise RPC |
| Mailbox | `DHTMailbox.ts` | K=5 最近接ノードへの PUT/GET/RES + 60秒レプリケーション |
| Storage | `IndexedDBStore.ts` | ブラウザ側 IndexedDB 永続化 |
| Server | `TrackerServer.ts` | WebSocket シグナリング・Seed上限管理 |
| Server | `SessionManager.ts` | セッション管理・isSeed/isCache フラグ |
| Server | `index.ts` | エントリポイント |
| Rust | `main.rs` | メインループ・**SeenCache**・**Dandelion++ Stem/Fluff**・Ikioi自動削除 |
| Rust | `webrtc_peer.rs` | WebRTC 接続・切断検知センチネル |
| Rust | `signaling_client.rs` | トラッカー接続・isSeed/isCache フラグ |
| Rust | `messages.rs` | P2PMessage 型定義（Stem含む） |
| Rust | `dht_mailbox.rs` | SQLite への PUT/GET 応答 |
| Rust | `sqlite_store.rs` | SQLite BLOB 保存 + 24h TTL 自動削除 |
| Rust | `seen_cache.rs` | LRU 重複排除（50,000件・TTL 15分） |
| Rust | `tui/` | ratatui ベースの TUI ダッシュボード |

---

## ❌ 未実装（ガイドに記載あり・ファイル未作成 or 中身が空）

### 優先度 S: これがないと「掲示板として使えない」

| # | 機能 | ガイド参照 | 概要 |
|:-:|:-----|:----------|:-----|
| 1 | **2ch風 UI** | §2 `ui/` | `BoardView.ts`, `ThreadView.ts`, `SettingsView.ts` — スレ一覧・スレ立て・レス表示の UI が一切ない。現在はデバッグ用チャット画面のみ |
| 2 | **SyncProtocol.ts** | §2 `mailbox/` | 新規参加時に「板を開いた瞬間に過去ログを一気取得」する全体同期ロジック。これがないと過去ログが見えない |

### 優先度 A: スケール時に必須

| # | 機能 | ガイド参照 | 概要 |
|:-:|:-----|:----------|:-----|
| 3 | **ZoneManager.ts** | §2 `network/` | Adaptive Zone Depth 管理。ノード数に応じて購読ゾーンを自動分割する。未実装だと全パケットが全員に届き、1000人超でパンクする |
| 4 | **ReplicationManager.ts** | §2 `mailbox/` | K=5 冗長保存の明示的な管理。現在は `DHTMailbox.ts` 内に簡易版が埋め込まれているが、独立モジュールとしての分離が未完 |
| 5 | **Heartbeat.ts** | §2 `network/` | 死活監視の独立モジュール。現在は `WebRTCPeer.ts` 内に Ping タイマーが直書きされている |
| 6 | **NetworkEvents.ts** | §2 `network/` | ネットワークイベント型定義の独立ファイル。現在は `types.ts` に統合されている |

### 優先度 B: セキュリティ・運用

| # | 機能 | ガイド参照 | 概要 |
|:-:|:-----|:----------|:-----|
| 7 | **RateLimiter.ts** | §2 `server/` | IP ベースのレート制限。現在のトラッカーはオープンで、DoS 攻撃に弱い |
| 8 | **TurnstileVerifier.ts** | §2 `server/` | Cloudflare Turnstile によるボット排除。join 時のトークン検証が未実装 |
| 9 | **Trip鍵の永続化** | §9 Identity.ts | `Identity.ts` L14 に `// TODO` が残っている。IndexedDB にトリップ鍵を保存し、タブ間で共有する機能 |
| 10 | **Database.ts / PostStore.ts** | §2 `storage/` | Dexie.js ベースの本格的なストレージ管理。現在は `IndexedDBStore.ts` の簡易版のみ |

### 優先度 C: 品質・テスト

| # | 機能 | ガイド参照 | 概要 |
|:-:|:-----|:----------|:-----|
| 11 | **テストスイート** | §2 `__tests__/` | ユニットテスト・統合テスト・E2Eテストのディレクトリ自体が未作成 |
| 12 | **Dockerfile** | §2 `server/` | サーバーのコンテナ化が未完 |

---

## ⚠️ 実装済みだが注意が必要な箇所

| # | 箇所 | 問題 |
|:-:|:-----|:-----|
| 1 | `ZoneGossipRouter.ts` L133 | `// ※Zone機能の実装時に、ここのフィルタリング条件を作る` — Zone 未実装のため全員にフラッディングしている |
| 2 | `main.ts` L51 | `new Uint8Array(32).fill(1)` — テスト用の固定板キー。本番では URL フラグメントから取得する仕組みが必要 |
| 3 | `main.ts` L145 | `TARGET_DIFFICULTY = 8` — テスト用の最低難易度。本番では `DifficultyEstimator` と連携させる |
| 4 | `PoWEngine.ts` L7 | `type: 2` (Argon2id) に修正済みだが、`pow.worker.ts` L7 は `type: 0` (Argon2d) のまま — **不整合あり、要修正** |

---

## 🎯 推奨着手順序

```
1. [S-2] SyncProtocol.ts        ← 過去ログが見えないと掲示板にならない
2. [S-1] 2ch風 UI               ← 見た目がないとデモできない
3. [A-3] ZoneManager.ts         ← スケールの生命線
4. [B-7] RateLimiter.ts         ← 公開前に必須
5. [B-8] TurnstileVerifier.ts   ← 公開前に必須
```
