# AETHER Web-Lite: スタンドアロン型キャッシュノード設計書

---

## Part 1: 現行のデータ保持ロジック（完全解説）

### 現在の設計の全体像

```
データの生存は「ブラウザタブが開いているか」に完全依存

     書き込み発生
         │
         ▼
┌─── リアルタイム層 ───────────────────────────────────┐
│  Broadcast Veil / Zone Gossip                        │
│  → 全ノードがパケットを中継                            │
│  → 自分宛てと判定したら IndexedDB に保存               │
│  → データは「今オンラインのノード」のRAM/IndexedDBにのみ存在│
└──────────────────────────────────────────────────────┘
         │
         ▼ gossip 受信時に自動で PUT
┌─── 永続化層（DHT Mailbox）──────────────────────────┐
│  Ring-DHT K=5 Replication                            │
│  → topic_hash に最も近い Ring 上の 5ノードが担当        │
│  → 暗号化 Blob を IndexedDB に保管                    │
│  → 新規参加者は担当ノードから GET して過去ログ取得       │
└──────────────────────────────────────────────────────┘
```

### データライフサイクル（ステップバイステップ）

```
1. 【誕生】ユーザーが書き込む
   → PacketBuilder が 3層パケットを構築
   → gossip で全 zone に配信

2. 【拡散】gossip 受信ノードが処理
   → 自分宛て: IndexedDB に保存（ローカルコピー）
   → Mailbox 担当: dht-put で暗号化 Blob を保管（K=5 冗長）
   → それ以外: 中継のみ、データは保持しない

3. 【保管】Mailbox 担当ノード（K=5）が保持
   → Ring 上で topic_hash に最も近い 5ノード
   → 5人中3人が生存していれば完全復元可能（Reed-Solomon 3+2）

4. 【再配置】Churn（ノード入退出）時
   → 毎分、自分の Mailbox データの K最近接を再計算
   → 新しい担当にデータをコピー
   → 古い担当はGCで削除（即削除はしない、安全マージン）

5. 【取得】新規参加者が過去ログを要求
   → topic_hash で DHT 検索 → K=5 の担当ノードを発見
   → dht-get → 暗号化 Blob を取得 → thread_key で復号

6. 【消滅（DAT落ち）】全ユーザーがタブを閉じる
   → Mailbox 担当ノード 5人全員がオフラインに
   → データがネットワーク上から物理的に完全消滅
   → 「DAT落ち」= 誰もデータを保持していない状態
```

### 現行ロジックの致命的弱点

```
┌─────────────────────────────────────────────────────────┐
│  問題1: Mailbox 担当はブラウザタブに依存                   │
│                                                           │
│  topic_hash に最も近い 5ノード = 5つのブラウザタブ           │
│  → ユーザーがタブを閉じる or PC をスリープ = ノード消滅      │
│  → 5人中3人が消えたらデータ復元不可能                       │
│  → 深夜帯にほぼ確実に起きる                                │
│                                                           │
│  問題2: 再レプリケーションの限界                            │
│                                                           │
│  「毎分」再計算 → K最近接が変わったらコピー                  │
│  → 5人が同時に(1分以内に)消えたらコピーが間に合わない        │
│  → 段階的に消える場合も、「新しい担当」も不安定なブラウザ     │
│                                                           │
│  問題3: 明示的な保存期間が未定義                            │
│                                                           │
│  「いつまで保持するか」のルールがない                        │
│  → ノードのストレージ(IndexedDB)が溢れる可能性              │
│  → ブラウザの IndexedDB は 50MB～数GB（ブラウザ依存）        │
└─────────────────────────────────────────────────────────┘
```

### 現行のMailbox内部動作（疑似コード）

```typescript
// === DHT Mailbox の核心ロジック ===

class DHTMailbox implements IMailbox {
  // 自分が担当するデータ
  private store: Map<string, Uint8Array[]> = new Map();

  // PUT: 自分が K最近接なら保管する
  async put(topicHash: Uint8Array, data: Uint8Array): Promise<void> {
    const nearest = this.findKNearest(topicHash, K=5);
    if (nearest.includes(this.myId)) {
      // 自分が担当 → IndexedDB に保存
      const key = toHex(topicHash);
      const entries = this.store.get(key) || [];
      entries.push(data);
      this.store.set(key, entries);
      await this.db.mailbox.put({ topicHash: key, entries });
    }
    // 担当ノードにも転送
    for (const nodeId of nearest) {
      if (nodeId !== this.myId) {
        this.peerManager.send(nodeId, {
          type: 'dht-put', topicHash: toHex(topicHash), data
        });
      }
    }
  }

  // GET: 自分が持っていたら返す
  async get(topicHash: Uint8Array): Promise<Uint8Array | null> {
    const key = toHex(topicHash);
    const entries = this.store.get(key);
    if (entries && entries.length > 0) {
      // 全エントリを結合して返す（暗号化Blob）
      return concat(entries);
    }
    return null;
  }

  // 再レプリケーション（毎分実行）
  startReplication(): void {
    setInterval(() => {
      for (const [topicHash, entries] of this.store) {
        const currentNearest = this.findKNearest(fromHex(topicHash), K=5);
        for (const nodeId of currentNearest) {
          if (nodeId !== this.myId) {
            // 新しい担当にデータをコピー
            this.peerManager.send(nodeId, {
              type: 'dht-put', topicHash, data: concat(entries)
            });
          }
        }
        // 自分が担当から外れていたら → 次回GCで削除
        if (!currentNearest.includes(this.myId)) {
          this.markForGC(topicHash);
        }
      }
    }, 60_000); // 60秒ごと
  }

  // K最近接ノードの計算（Ring-DHT）
  private findKNearest(topicHash: Uint8Array, k: number): PeerId[] {
    const hashPosition = bytesToPosition(topicHash); // [0,1) にマッピング
    const allNodes = [...this.peerManager.peers.keys(), this.myId];
    return allNodes
      .sort((a, b) => ringDistance(getPosition(a), hashPosition)
                     - ringDistance(getPosition(b), hashPosition))
      .slice(0, k);
  }
}
```

---

## Part 2: スタンドアロン型キャッシュノード

### コンセプト

```
「BitTorrent のシーダーのように、誰でもキャッシュノードになれる」

┌──────────────────────────────────────────────────────┐
│                                                        │
│   $ aether-cache run                                   │
│                                                        │
│   🟢 Aether Cache Node v0.1.0                          │
│   ├── Ring Position: 0.4231 (固定)                      │
│   ├── Peers: 8/8 (WebRTC)                              │
│   ├── Topics: 2,847                                     │
│   ├── Storage: 1.2 GB / 5.0 GB                         │
│   └── Uptime: 3d 14h 22m                               │
│                                                        │
│   誰でもダウンロード → ダブルクリック → キャッシュノード   │
│   ポート開放不要 → WebRTC の NAT 越えをそのまま利用       │
│   ブラウザノードと完全に同一のプロトコル                   │
│                                                        │
└──────────────────────────────────────────────────────┘
```

### なぜ Rust + WebRTC か

| 選択肢 | 評価 |
|:--------|:-----|
| **Rust + webrtc-rs** ✅ | シングルバイナリ、クロスプラットフォーム、WebRTC ネイティブ対応、NAT越え組み込み |
| Go + pion/webrtc | Go も良い選択肢。ただしバイナリサイズが大きい |
| Node.js + node-datachannel | ランタイム依存。配布が面倒 |
| C++ + libdatachannel | 性能◎だがビルド環境が複雑 |

**`webrtc-rs`** が最適な理由：
- **Pure Rust** → `cargo build --release` で 1つのバイナリが出る
- **ICE/STUN/DTLS** 組み込み済み → ポート開放不要
- ブラウザの WebRTC と**直接相互通信可能**（DataChannel 互換）
- クロスコンパイル容易（Windows/macOS/Linux + ARM）
- 2026年現在、Sans-IO アーキテクチャへの移行で安定度向上中

### アーキテクチャ

```
┌─────────────────────────────────────────────────────┐
│ aether-cache (Rust バイナリ)                          │
│                                                       │
│  ┌──────────────────────────────────────────────┐    │
│  │ P2P Layer (ブラウザノードと完全互換)            │    │
│  │                                                │    │
│  │  WebRTC DataChannel ←── webrtc-rs             │    │
│  │  ├── ICE + STUN → NAT 越え（ポート開放不要）   │    │
│  │  ├── DTLS → 暗号化トランスポート                │    │
│  │  └── SCTP → 信頼性付きデータ転送               │    │
│  │                                                │    │
│  │  Ring-Mesh プロトコル                           │    │
│  │  ├── position 固定（設定ファイル or 初回自動生成）│    │
│  │  ├── ローカルリンク 4本 + ロングレンジ 4本      │    │
│  │  ├── Heartbeat / PEX                           │    │
│  │  └── gossip パケット中継                        │    │
│  └──────────────────────────────────────────────┘    │
│                                                       │
│  ┌──────────────────────────────────────────────┐    │
│  │ Mailbox Layer (ブラウザの IndexedDB → SQLite)  │    │
│  │                                                │    │
│  │  dht-put → SQLite に暗号化 Blob 保存           │    │
│  │  dht-get → SQLite から暗号化 Blob 返却         │    │
│  │  再レプリケーション（毎分）                      │    │
│  │  .dat 落ちロジック（勢いベース削除）             │    │
│  └──────────────────────────────────────────────┘    │
│                                                       │
│  ┌──────────────────────────────────────────────┐    │
│  │ Storage Engine                                 │    │
│  │                                                │    │
│  │  SQLite (rusqlite)                             │    │
│  │  ├── mailbox_entries (暗号化Blob)              │    │
│  │  ├── topic_metadata (勢い計算用)               │    │
│  │  └── node_state (position, 接続履歴)           │    │
│  └──────────────────────────────────────────────┘    │
│                                                       │
│  ┌──────────────────────────────────────────────┐    │
│  │ TUI Dashboard (ratatui)                        │    │
│  │                                                │    │
│  │  🟢 Connected: 8 peers                         │    │
│  │  📦 Topics: 2,847 | Storage: 1.2 GB / 5 GB    │    │
│  │  📊 In: 25 KB/s | Out: 200 KB/s               │    │
│  │  ⏱️ Uptime: 3d 14h                             │    │
│  └──────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

### ブラウザノードとの通信フロー

```
ポート開放が不要な理由:

  ブラウザ (Chrome)                    aether-cache (Rust)
       │                                    │
       │   1. トラッカーに接続               │
       │      → キャッシュノードの            │
       │        SDP/ICE 情報を取得           │
       │                                    │
       │   2. WebRTC ICE 開始               │
       │      ├── STUN で自分の              │
       │      │   Public IP を取得          │
       │      └── ICE Candidate 交換        │
       │                                    │
       │   3. NAT 越え完了                   │
       │      （双方がSTUNで穴を開ける）      │
       │                                    │
       │ ◄══════ DataChannel ══════════► │
       │   完全に対等な P2P 接続              │
       │   （ポート転送不要、UPnP不要）       │
       │                                    │

  WebRTC の ICE/STUN が NAT 越えを自動処理するため、
  キャッシュノード側でもポート開放は不要。

  成功率: 85-92%（Symmetric NAT 以外）
  家庭の普通のルーターなら問題なし。
```

### UX: 使い方

```bash
# ===== インストール =====

# macOS
brew install aether-cache

# Linux (curl one-liner)
curl -fsSL https://aether.example.com/install.sh | sh

# Windows
winget install aether-cache
# または GitHub Releases からダウンロードしてダブルクリック


# ===== 起動 =====

# 最小構成（デフォルト設定で即起動）
aether-cache run

# ストレージ上限を指定
aether-cache run --max-storage 5GB

# 帯域上限を指定（格安回線向け）
aether-cache run --max-bandwidth 10mbps

# バックグラウンドで実行（デーモン化）
aether-cache run --daemon

# ステータス確認
aether-cache status

# 停止
aether-cache stop
```

```
# ===== TUI ダッシュボード =====

┌── Aether Cache Node v0.1.0 ─────────────────────────┐
│                                                       │
│  Status: 🟢 Online                                    │
│  Uptime: 3d 14h 22m 15s                              │
│                                                       │
│  ── Network ──────────────────────────────────────    │
│  Ring Position: 0.4231                                │
│  Connected Peers: 8/8 (Local: 4, LongRange: 4)       │
│  Avg RTT: 45ms                                        │
│                                                       │
│  ── Storage ──────────────────────────────────────    │
│  Topics: 2,847                                        │
│  Entries: 142,350                                     │
│  Size: 1.2 GB / 5.0 GB [████████░░░░░░░░░░] 24%      │
│  Evicted (dat-ochi): 42 topics today                  │
│                                                       │
│  ── Traffic ──────────────────────────────────────    │
│  ↓ In:  25.3 KB/s  │  ↑ Out: 198.7 KB/s              │
│  GET: 847/h         │  PUT: 12,450/h                  │
│                                                       │
│  ── Top Active Topics ────────────────────────────    │
│  1. 0xa3f2... │ 勢い: 142.3 │ Size: 812 KB │ PUTs: 47│
│  2. 0x1b8c... │ 勢い:  89.1 │ Size: 523 KB │ PUTs: 31│
│  3. 0xf7d1... │ 勢い:  45.7 │ Size: 1.1 MB │ PUTs: 18│
│                                                       │
│  [q] Quit  [s] Settings  [p] Peers  [d] Detail       │
└───────────────────────────────────────────────────────┘
```

---

## Part 3: Rust モジュール設計

### Cargo.toml (主要依存)

```toml
[package]
name = "aether-cache"
version = "0.1.0"
edition = "2024"

[dependencies]
# WebRTC
webrtc = "0.12"                      # webrtc-rs (ICE/STUN/DTLS/SCTP/DataChannel)

# Async Runtime
tokio = { version = "1", features = ["full"] }

# Storage
rusqlite = { version = "0.32", features = ["bundled"] }

# Serialization (MessagePack - ブラウザと互換)
rmp-serde = "1.3"

# Crypto
chacha20poly1305 = "0.10"           # ChaCha20-Poly1305 (検証用)
ed25519-dalek = "2"                  # Ed25519 (署名検証用)
sha2 = "0.10"                       # SHA-256

# TUI
ratatui = "0.29"
crossterm = "0.28"

# CLI
clap = { version = "4", features = ["derive"] }

# Config
toml = "0.8"
serde = { version = "1", features = ["derive"] }

# Logging
tracing = "0.1"
tracing-subscriber = "0.3"
```

### ソースツリー

```
aether-cache/
├── Cargo.toml
├── Cargo.lock
├── README.md
│
├── src/
│   ├── main.rs                    # CLI エントリポイント (clap)
│   │
│   ├── node/                      # === ノード本体 ===
│   │   ├── mod.rs
│   │   ├── cache_node.rs          # メインループ（起動→接続→Mailbox動作）
│   │   └── config.rs              # 設定ファイル読み込み
│   │
│   ├── network/                   # === P2P ネットワーク ===
│   │   ├── mod.rs
│   │   ├── ring_position.rs       # Ring 位置 (position) 管理
│   │   ├── peer_manager.rs        # 接続管理 (MAX=8, ローカル優先)
│   │   ├── webrtc_peer.rs         # webrtc-rs DataChannel ラッパー
│   │   ├── ring_maintainer.rs     # リング修復
│   │   ├── pex_handler.rs         # Peer Exchange
│   │   ├── heartbeat.rs           # 死活監視
│   │   ├── signaling_client.rs    # トラッカー接続 (WebSocket)
│   │   └── messages.rs            # P2P メッセージ型定義
│   │
│   ├── gossip/                    # === ゴシップ配信 ===
│   │   ├── mod.rs
│   │   ├── zone_gossip_router.rs  # Zone BFS Flood
│   │   ├── packet_validator.rs    # PoW 検証, TTL, サイズ
│   │   └── seen_cache.rs          # 重複排除 (LRU)
│   │
│   ├── mailbox/                   # === DHT Mailbox ===
│   │   ├── mod.rs
│   │   ├── dht_mailbox.rs         # K最近接 PUT/GET
│   │   ├── replication.rs         # K=5 再レプリケーション
│   │   └── eviction.rs            # .dat 落ちロジック
│   │
│   ├── storage/                   # === ストレージ ===
│   │   ├── mod.rs
│   │   └── sqlite_store.rs        # rusqlite ラッパー
│   │
│   └── tui/                       # === ダッシュボード ===
│       ├── mod.rs
│       └── dashboard.rs           # ratatui TUI
│
├── config/
│   └── default.toml               # デフォルト設定
│
└── scripts/
    ├── install.sh                 # Linux/macOS インストーラ
    └── build-release.sh           # クロスコンパイル用
```

### 設定ファイル

```toml
# config/default.toml

[node]
# Ring位置（空なら初回起動時に自動生成＆永続化）
# position = 0.4231

# トラッカーURL
tracker_url = "wss://tracker.aether.example.com/ws"

[storage]
# データベースのパス
db_path = "~/.aether-cache/data/mailbox.db"

# ストレージ上限
max_total_size = "5GB"       # 全体の上限
max_topic_size = "2MB"       # 1 topic あたりの上限
max_topics = 10000           # topic 数の上限

[eviction]
# .dat 落ち設定
expire_no_activity_days = 30   # 最終更新から30日で自動削除
cold_threshold_days = 7        # 7日更新なし = 勢いゼロ扱い
check_interval_minutes = 60    # 削除チェック間隔

[network]
# 帯域上限（0 = 無制限）
max_bandwidth_mbps = 0

# 全 Zone を購読するか（true 推奨）
subscribe_all_zones = true

# STUN サーバー
stun_servers = [
    "stun:stun.l.google.com:19302",
    "stun:stun.cloudflare.com:3478",
]

[tui]
# TUI ダッシュボードを表示するか
enabled = true
# リフレッシュ間隔
refresh_interval_ms = 1000
```

---

## Part 4: .dat 落ちロジック（Rust 実装）

```rust
// src/mailbox/eviction.rs

/// 暗号化データの中身を見ずに、メタデータだけで勢いを計算
pub struct EvictionManager {
    store: Arc<SqliteStore>,
    config: EvictionConfig,
}

impl EvictionManager {
    /// 勢い (Ikioi) 計算
    /// 5ch: 勢い = レス数 / (現在 - スレ立て) × 86400
    /// AETHER: 勢い = 24時間のPUT数 / 経過日数
    fn calculate_ikioi(&self, meta: &TopicMetadata, now: u64) -> f64 {
        let age_days = ((now - meta.first_seen) as f64) 
                       / (24.0 * 60.0 * 60.0 * 1000.0);
        let age_days = age_days.max(0.01); // ゼロ除算防止
        
        let recent_puts = self.store
            .count_recent_puts(&meta.topic_hash, Duration::hours(24))
            .unwrap_or(0);
        
        recent_puts as f64 / age_days
    }

    /// 定期実行: .dat 落ちチェック
    pub async fn run_eviction(&self) -> EvictionResult {
        let now = current_time_ms();
        let mut evicted = 0;
        
        // Step 1: 完全過疎（最終更新から30日以上）→ 即時削除
        let expired = self.store.find_expired(
            now - self.config.expire_no_activity_ms
        )?;
        for topic in &expired {
            self.store.delete_topic(&topic.topic_hash)?;
            evicted += 1;
        }
        
        // Step 2: topic 数上限チェック
        let total_topics = self.store.count_topics()?;
        if total_topics > self.config.max_topics {
            let excess = total_topics - self.config.max_topics;
            let weakest = self.store.get_all_topics_sorted_by_ikioi(now)?;
            for topic in weakest.iter().take(excess) {
                self.store.delete_topic(&topic.topic_hash)?;
                evicted += 1;
            }
        }
        
        // Step 3: 合計サイズ上限チェック
        let total_size = self.store.total_size()?;
        if total_size > self.config.max_total_size {
            let weakest = self.store.get_all_topics_sorted_by_ikioi(now)?;
            let mut freed = 0u64;
            for topic in &weakest {
                if total_size - freed <= self.config.max_total_size {
                    break;
                }
                freed += topic.total_size;
                self.store.delete_topic(&topic.topic_hash)?;
                evicted += 1;
            }
        }
        
        EvictionResult { evicted, remaining: self.store.count_topics()? }
    }
}
```

---

## Part 5: セキュリティ考慮

### キャッシュノードの信頼モデル

```
キャッシュノードは「信頼されたサーバー」ではない。
「たまたま長時間稼働している普通のノード」として扱う。

悪意あるキャッシュノードが出来ること / 出来ないこと:

  ✅ データの中身を読む → 不可能（暗号化 Blob）
  ✅ データを改竄する   → 検知可能（Ed25519 署名が暗号層の内側）
  ⚠️ データを選択的に削除（検閲）→ K=5 の他 4ノードにデータあり
  ⚠️ アクセスパターンを記録    → topic_hash の GET/PUT 頻度は見える
  ⚠️ Eclipse 攻撃の起点       → ローカルリンクを乗っ取る可能性

対策:
  1. キャッシュノードは「K=5 の 1つ」に過ぎない
     → 1つが悪意があっても残り4つが正直ならデータは安全
  2. ブラウザノードは複数のキャッシュノードからデータを取得
     → 多数決で正しいデータを判定
  3. 悪意あるキャッシュノードの.dat落ち操作も問題なし
     → P2P側のMailboxにデータが残るため
```

### 配布時のセキュリティ

```
GitHub Releases でバイナリ配布:
  ・各OS向けにクロスコンパイル (x86_64, aarch64)
  ・SHA256 チェックサム公開
  ・（将来）コード署名 (macOS notarization, Windows Authenticode)

ソースからのビルド:
  $ git clone https://github.com/aether-project/aether-cache
  $ cd aether-cache
  $ cargo build --release
  → target/release/aether-cache
```

---

## Part 6: ブラウザノードとキャッシュノードの比較

| 項目 | ブラウザノード | キャッシュノード |
|:-----|:-------------|:----------------|
| 実行環境 | Chrome/Firefox/Safari | Rust バイナリ (Win/Mac/Linux) |
| WebRTC | ブラウザ組み込み | webrtc-rs |
| ストレージ | IndexedDB (50MB～数GB) | SQLite (GB～TB) |
| 稼働時間 | タブが開いている間 | 24時間 (デーモン) |
| Mailbox 担当 | K=5 の1つ（不安定） | K=5 の1つ（安定） |
| gossip 中継 | 購読 Zone のみ | 全 Zone（オプション） |
| NAT 越え | ブラウザの WebRTC | webrtc-rs の ICE/STUN |
| ポート開放 | 不要 | **不要** |
| .dat 落ち管理 | なし | あり（勢いベース） |
| P2P プロトコル | **完全に同一** | **完全に同一** |

---

## Part 7: 段階的なキャッシュノード参加モデル

```
ユーザー数の増加と共に、キャッシュノードの価値が変化:

Phase 0: 運営のみ（初期）
  ・運営が 1-2 台のキャッシュノードを稼働
  ・データの「最後の砦」として機能
  ・ブラウザノードは常にキャッシュノードに接続

Phase 1: 有志のシーダー出現
  ・「保守したい」ユーザーが自宅PCでキャッシュノードを稼働
  ・BitTorrent のシーダーと同じモチベーション
  ・キャッシュノード数が増えると冗長性が向上

Phase 2: P2P が自律稼働
  ・同接 1000+ の世界
  ・P2P Mailbox だけでデータが十分に永続
  ・キャッシュノードは「安心のバックアップ」に留まる
  ・キャッシュノードが全滅してもネットワークは存続
```
