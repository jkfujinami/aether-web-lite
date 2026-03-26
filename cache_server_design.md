# AETHER Web-Lite: キャッシュサーバー設計書

## 0. 背景と目的

### 解決すべき問題
P2P DHT Mailbox は「全ブラウザノードが一時的な存在」であることが本質的な弱点。

| 状況 | 問題 |
|:-----|:-----|
| 初期（0〜100人） | Mailbox担当 K=5 のうち過半数がタブを閉じるとデータロスト |
| 深夜帯 | アクティブノードが激減 → 過去ログの可用性が崩壊 |
| 板の過疎化 | 全員がタブを閉じると「DAT落ち」→ スレッドが完全消滅 |

### キャッシュ鯖で解決する

```
「24時間稼働する永続Mailboxノード」= キャッシュサーバー

・P2Pノードと全く同じプロトコルで動作（特別扱いしない）
・暗号化データをそのまま保管（中身は読めない）
・ユーザーが増えると P2P 側の Mailbox が強化される → キャッシュ鯖への依存が自然に減少
・5ch の .dat 落ちロジックで無限増殖するデータを制御
```

---

## 1. アーキテクチャ概要

```
┌──────────── Cache Server（永続 Mailbox ノード）────────┐
│                                                         │
│  Ring-Mesh に参加する「普通のノード」として振る舞う        │
│  ただし:                                                 │
│    ✅ 24時間稼働（ブラウザではなく Node.js / Deno）       │
│    ✅ ディスクストレージ（IndexedDB ではなく SQLite/FS）  │
│    ✅ .dat 落ちロジックでストレージ上限を管理             │
│    ✅ Node Aging 即座にパス（起動直後から信頼ノード）     │
│                                                         │
│  プロトコル上、ブラウザノードと完全に同一:                │
│    - dht-get / dht-put で Mailbox として応答              │
│    - gossip パケットの中継（Broadcast Veil）              │
│    - Heartbeat / PEX / Ring 維持                         │
│                                                         │
│  見えるもの:                                              │
│    topic_hash（不透明ハッシュ）、暗号化 Blob、サイズ、時刻│
│                                                         │
│  見えないもの:                                            │
│    板名、スレタイ、レス内容、書き込み者 — 全て暗号の内側  │
└─────────────────────────────────────────────────────────┘
```

### 1.1 位置づけ：P2P ネットワークの「保険」

```
                   信頼性

    100% ┤                          ╭─────── P2P Mailbox のみ
        │                     ╭───╯
        │                ╭───╯
        │           ╭───╯
    50% ┤      ╭───╯ ←── この領域をキャッシュ鯖がカバー
        │ ╭───╯
        │╱
     0% ┤
        └──┬──┬──┬──┬──┬──┬──┬──→ 同接ユーザー数
           10 50 100 500 1K  5K 10K

    キャッシュ鯖 = 「保険」:
      ・ノード数が少ない間は主要なデータソース
      ・ノード数が増えると自然にP2P側のMailboxが十分になる
      ・最終的にキャッシュ鯖は「安心のバックアップ」に留まる
```

---

## 2. キャッシュ鯖の Mailbox 動作

### 2.1 暗号化状態でのMailbox動作 — **完全に可能**

既存の Mailbox プロトコルがそもそも「暗号化 Blob をそのまま保管」する設計のため、
キャッシュ鯖は**何も変更せずに** Mailbox として動作できる。

```
ブラウザノードの Mailbox:
  dht-put(topic_hash, encrypted_blob) → IndexedDB に保存
  dht-get(topic_hash) → IndexedDB から encrypted_blob を返す

キャッシュ鯖の Mailbox:
  dht-put(topic_hash, encrypted_blob) → SQLite / ディスクに保存  ← ここだけ違う
  dht-get(topic_hash) → SQLite / ディスクから encrypted_blob を返す

→ プロトコルレベルで完全互換。暗号化/復号はクライアント側の責務。
→ キャッシュ鯖は「中身を知らない大容量 IndexedDB」として振る舞うだけ。
```

### 2.2 キャッシュ鯖が見えるもの / 見えないもの

| 見える（メタデータ） | 見えない（暗号の内側） |
|:-----|:-----|
| `topic_hash` — 不透明な32バイトハッシュ | 何の板・スレッドか |
| `encrypted_blob` のサイズ (バイト数) | レスの内容・書き込み者 |
| PUT/GET のタイムスタンプ | 誰が読んでいるか |
| PUT の頻度（≈ 投稿頻度） | 署名・公開鍵 |
| リクエスト元の IP アドレス | topic_hash 同士の関連性 |

> [!IMPORTANT]
> キャッシュ鯖の運営者であっても、`boardkey` / `thread_key` を知らない限り、
> 保管しているデータの中身を読むことは**暗号学的に不可能**。

### 2.3 Ring-Mesh への参加方式

```
キャッシュ鯖の起動シーケンス:

1. 固定の Ring position を設定（設定ファイルで指定）
   → 再起動しても同じ位置 = Mailbox担当が変わらない

2. トラッカーに接続（通常ノードと同じ）
   → Turnstile はサーバー認証トークンで代替（後述）

3. 8ピアと WebRTC 接続... ではなく WebSocket 接続
   → Node.js にはブラウザの WebRTC がない
   → 代替: WebSocket over libdatachannel / node-datachannel
   　 または WebSocket フォールバックプロトコル

4. Ring-Mesh に参加、Heartbeat 開始

5. 全 zone の gossip を中継（キャッシュ鯖は全 zone を購読）
   → 受信した全パケットを topic_hash でインデックスして保管

6. dht-get リクエストに応答（永続 Mailbox として）
```

---

## 3. .dat 落ちロジック（ストレージ管理）

### 3.1 5ch の .dat 落ちとは

```
5ch の .dat 落ち判定基準:
  1. 板のスレッド保持上限（例: 700スレ）を超過
  2. 最も「勢い」のないスレッドから順に .dat 落ち
  3. .dat 落ち = サーバーからデータ削除（過去ログ倉庫送り）
  4. 1000レスに到達 → スレッドストップ（新規書き込み不可）

勢い (Ikioi) = レス数 / (現在時刻 - スレ立て時刻) × 86400
```

### 3.2 AETHER 版 .dat 落ちロジック

キャッシュ鯖は暗号化データしか持たないため、「スレタイ」「レス数」は見えない。
代わりに**メタデータだけで判定できる指標**を使う。

```typescript
// キャッシュ鯖のストレージ管理パラメータ
export const CACHE_SERVER = {
  // ── ストレージ上限 ──
  /** 保持する topic_hash の最大数 */
  MAX_TOPICS: 10_000,

  /** 1つの topic_hash あたりの最大保持サイズ */
  MAX_TOPIC_SIZE: 2 * 1024 * 1024,    // 2MB（≈ 1000レス × 2KB）

  /** 全体のストレージ上限 */
  MAX_TOTAL_STORAGE: 10 * 1024 * 1024 * 1024,  // 10GB

  // ── .dat 落ち判定 ──
  /** 最終更新から自動削除までの時間（完全過疎スレ） */
  EXPIRE_NO_ACTIVITY: 30 * 24 * 60 * 60 * 1000,  // 30日

  /** 「冷却」判定の時間（勢いゼロ扱い） */
  COLD_THRESHOLD: 7 * 24 * 60 * 60 * 1000,  // 7日間更新なし

  // ── 勢い計算 ──
  /** 勢い計算のウィンドウ */
  IKIOI_WINDOW: 24 * 60 * 60 * 1000,  // 24時間

  // ── 削除バッチ ──
  /** 削除チェック間隔 */
  EVICTION_INTERVAL: 60 * 60 * 1000,  // 1時間ごと

  /** 1回の削除で落とす最大数 */
  EVICTION_BATCH_SIZE: 100,
} as const;
```

### 3.3 勢い (Ikioi) の計算

暗号化されたデータの中身は見えないが、以下のメタデータからスレッドの活性度を推定できる。

```typescript
interface TopicMetadata {
  topic_hash: Uint8Array;       // 不透明ハッシュ
  first_seen: number;           // 最初の PUT 時刻
  last_put: number;             // 最後の PUT 時刻
  put_count: number;            // PUT 回数（≈ レス数）
  total_size: number;           // 保持データの合計サイズ
  get_count_24h: number;        // 直近24時間の GET 回数（≈ 閲覧数）
}

/**
 * 勢い = 直近24時間のPUT回数 / 経過日数 × 補正
 * 5ch の「勢い」と同様に、活発なスレッドほど高スコア
 */
function calculateIkioi(meta: TopicMetadata, now: number): number {
  const ageMs = now - meta.first_seen;
  const ageDays = Math.max(ageMs / (24 * 60 * 60 * 1000), 0.01); // 最低0.01日

  // 直近24時間の PUT 数を重視（リアルタイムの活性度）
  // ここでの put_count は24時間ウィンドウ内のカウント
  const recentPuts = countRecentPuts(meta.topic_hash, CACHE_SERVER.IKIOI_WINDOW);

  // 勢い = 直近PUT ÷ 経過日数
  return recentPuts / ageDays;
}
```

### 3.4 .dat 落ち（Eviction）のフロー

```
毎時実行: evictionCheck()

1. 全 topic のメタデータを取得

2. 即時削除（強制 .dat 落ち）:
   a. last_put が 30日以上前 → 完全過疎 → 削除
   b. total_size が MAX_TOPIC_SIZE (2MB) 超過 → 超過分の古いデータを削除

3. ストレージ上限チェック:
   a. topic 数が MAX_TOPICS (10,000) を超過
      → 勢い (ikioi) の低い順にソート
      → 下位のスレッドから削除（MAX_TOPICS まで減らす）

   b. 合計サイズが MAX_TOTAL_STORAGE (10GB) を超過
      → 勢い (ikioi) の低い順にソート
      → 下位のスレッドから削除（10GB以下まで減らす）

4. ログ出力:
   [EVICTION] Dropped 42 topics. Remaining: 9958 topics, 8.2GB
```

### 3.5 5ch との対応表

| 5ch の概念 | AETHER キャッシュ鯖での対応 |
|:-----------|:---------------------------|
| 板のスレッド上限 (700) | `MAX_TOPICS` (10,000) |
| .dat 落ち | 勢い最下位のスレッドをキャッシュから削除 |
| 過去ログ倉庫 | なし（P2P側にデータが残っていればそこから取得） |
| 1000レスでストップ | `MAX_TOPIC_SIZE` (2MB) で暗黙的に制限 |
| 勢い (Ikioi) | `PUT頻度 / 経過時間`（暗号化状態でも計測可能） |
| 保守 | ブラウザノードが Mailbox として保持 |
| 圧縮 | あり得る（暗号化Blobのgzip圧縮は有効） |

---

## 4. ストレージ設計

### 4.1 SQLite スキーマ

```sql
-- メインテーブル: 暗号化データの保管
CREATE TABLE mailbox_entries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_hash      BLOB NOT NULL,          -- 32 bytes
    encrypted_data  BLOB NOT NULL,          -- 暗号化された投稿データ
    received_at     INTEGER NOT NULL,       -- UNIX ms
    data_size       INTEGER NOT NULL,       -- バイト数
    
    -- インデックス
    UNIQUE(topic_hash, id)
);

CREATE INDEX idx_topic_hash ON mailbox_entries(topic_hash);
CREATE INDEX idx_received_at ON mailbox_entries(received_at);

-- メタデータテーブル: .dat 落ち判定用
CREATE TABLE topic_metadata (
    topic_hash      BLOB PRIMARY KEY,       -- 32 bytes
    first_seen      INTEGER NOT NULL,       -- 最初の PUT
    last_put        INTEGER NOT NULL,       -- 最後の PUT
    put_count       INTEGER NOT NULL DEFAULT 0,
    total_size      INTEGER NOT NULL DEFAULT 0,
    get_count_24h   INTEGER NOT NULL DEFAULT 0,
    last_get_reset  INTEGER NOT NULL        -- GET カウントのリセット時刻
);

-- アクセスログ（GET頻度の計測用、定期的にローテーション）
CREATE TABLE access_log (
    topic_hash      BLOB NOT NULL,
    accessed_at     INTEGER NOT NULL,
    request_type    TEXT NOT NULL            -- 'GET' or 'PUT'
);

CREATE INDEX idx_access_time ON access_log(accessed_at);
```

### 4.2 ディスクレイアウト

```
cache-server/
├── data/
│   ├── mailbox.db              # SQLite データベース
│   ├── mailbox.db-wal          # WAL ジャーナル
│   └── blobs/                  # 大きなBlob用（オプション）
│       ├── <topic_hash_hex>/   # topic ごとのディレクトリ
│       │   ├── 00001.enc       # 暗号化 Blob
│       │   ├── 00002.enc
│       │   └── ...
│       └── ...
├── config.toml                 # サーバー設定
└── logs/
    └── cache-server.log        # 運用ログ
```

---

## 5. プロトコル拡張

### 5.1 ブラウザノード ↔ キャッシュ鯖の通信

キャッシュ鯖は WebRTC DataChannel を直接話すか、WebSocket フォールバックを使う。

```
方式A: WebRTC (node-datachannel ライブラリ使用)
  ・ブラウザノードと完全に同一のプロトコル
  ・ NAT 内のブラウザから直接接続可能
  ・ 実装コストはやや高い

方式B: WebSocket フォールバック（推奨）
  ・キャッシュ鯖は WebSocket エンドポイントを公開
  ・ブラウザノードは WebRTC 失敗時に WebSocket で接続
  ・ メッセージフォーマットは P2P と完全に同一
  ・ 実装がシンプル、デバッグ容易

方式C: ハイブリッド（最終形）
  ・通常は WebSocket で接続
  ・Ring-Mesh 内での位置はキャッシュ鯖の position に固定
  ・ P2P メッセージを WebSocket でラップして送受信
```

### 5.2 既存プロトコルとの互換性

```typescript
// 既存の P2P メッセージ型をそのまま使用
// キャッシュ鯖固有のメッセージは追加しない

// ブラウザ → キャッシュ鯖
{ type: 'dht-get', topicHash: string }          // 既存
{ type: 'dht-put', topicHash: string, data: Uint8Array }  // 既存

// キャッシュ鯖 → ブラウザ  
{ type: 'dht-response', topicHash: string, data: Uint8Array | null }  // 既存

// → 新規メッセージ型の追加は不要！
```

### 5.3 キャッシュ鯖の発見方法

```
方式1: トラッカー経由（推奨）
  ・トラッカーが「キャッシュ鯖のピア情報」を優先的に返す
  ・新規参加者は最初にキャッシュ鯖と接続 → 即座にデータ取得可能
  ・トラッカーの SessionManager に cache_node フラグを追加

方式2: DNS ベースの発見
  ・_aether-cache._tcp.example.com TXT レコードで接続情報を公開
  ・トラッカーが落ちている場合のフォールバック

方式3: ハードコード
  ・クライアントの constants.ts にキャッシュ鯖の接続先を埋め込み
  ・開発初期はこれで十分
```

---

## 6. セキュリティとプライバシー

### 6.1 脅威モデル

| 脅威 | リスク | 対策 |
|:-----|:-------|:-----|
| キャッシュ鯖運営者がデータを読む | 低（暗号化済み） | `boardkey` がない限り復号不可能 |
| キャッシュ鯖がアクセスパターンを記録 | 中 | 後述の対策（§6.2） |
| キャッシュ鯖がデータを改竄 | 低 | 署名検証で検知（暗号層の内側に Ed25519 署名） |
| キャッシュ鯖のデータが法的に押収される | 中 | 全てが暗号化 Blob → 復号鍵なしでは無意味 |
| キャッシュ鯖が選択的にデータを削除（検閲） | 中 | K=5 冗長 + P2P Mailbox があるため、キャッシュ鯖は唯一のコピーではない |
| キャッシュ鯖がダウン | 低 | P2P Mailbox がバックアップとして機能 |

### 6.2 アクセスパターン分析への対策

キャッシュ鯖は暗号化データの中身は読めないが、「どの topic_hash がいつ、どの IP からアクセスされたか」というメタデータは取得可能。

```
対策1: ログの最小化
  ・IP アドレスをログに記録しない
  ・access_log は GET 頻度の計測のみに使用し、IP は保存しない
  ・トラフィック分析に必要な最小限のメタデータのみ保持

対策2: バッチ応答
  ・dht-get の応答を即座に返さず、50-200ms のランダム遅延を挿入
  ・タイミング攻撃を困難にする

対策3: ダミーリクエスト（クライアント側）
  ・ブラウザノードがキャッシュ鯖にアクセスする際、
    本命の topic_hash に加えてダミーの topic_hash を混ぜる
  ・ K-匿名性の Zone と同じ原理
```

### 6.3 キャッシュ鯖の認証

```
キャッシュ鯖は「特権ノード」ではない。ただし以下の理由で認証が必要：

1. Node Aging バイパス:
   キャッシュ鯖は起動直後から信頼ノードとして扱う必要がある
   → トラッカーが「認証済みキャッシュノード」としてフラグを付与

2. Turnstile 免除:
   キャッシュ鯖は人間ではないので Turnstile を通過できない
   → サーバー間認証トークン（HS256 JWT 等）で代替

3. 接続優先:
   新規参加者はキャッシュ鯖との接続を優先すべき
   → トラッカーが peers リストの先頭にキャッシュ鯖を配置
```

---

## 7. 段階的移行：P2P のみ → キャッシュ鯖併用

### 7.1 初期（ユーザー 0〜100人）

```
データの主要ソース: キャッシュ鯖（ほぼ100%）
P2P Mailbox の信頼性: 低い（ノードの生存時間が短い）

動作:
  ・新規参加 → キャッシュ鯖から過去ログ取得（高速・確実）
  ・書き込み → gossip + キャッシュ鯖に dht-put（二重保管）
  ・キャッシュ鯖が落ちると過去ログが失われるリスクあり
    → 複数のキャッシュ鯖で冗長化推奨
```

### 7.2 成長期（100〜1,000人）

```
データの主要ソース: キャッシュ鯖 + P2P Mailbox（ハイブリッド）
P2P Mailbox の信頼性: 中程度

動作:
  ・dht-get は P2P Mailbox を先に試し、失敗したらキャッシュ鯖にフォールバック
  ・キャッシュ鯖が落ちても P2P Mailbox で多くのスレッドが存続
  ・.dat 落ちの閾値を緩めに設定可能（ストレージに余裕があれば）  
```

### 7.3 全盛期（1,000人〜）

```
データの主要ソース: P2P Mailbox（ほぼ100%）
キャッシュ鯖の役割: バックアップ・過疎スレの保全

動作:
  ・P2P Mailbox が十分に機能 → キャッシュ鯖への依存は最小
  ・キャッシュ鯖は「過疎スレのアーカイブ」として機能
  ・P2P で Mailbox 担当が見つからないスレ → キャッシュ鯖が応答
  ・キャッシュ鯖が完全に落ちても、ネットワーク全体には影響なし
```

---

## 8. 運用パラメータの目安

### 8.1 ストレージ見積もり

```
1レス = 平均 500B（暗号化後、ヘッダー含む）
1スレッド（1000レス） = 500KB
10,000 スレッド = 5GB

MAX_TOTAL_STORAGE = 10GB なら:
  ・約 20,000 スレッド分を保持可能
  ・.dat 落ちで古い過疎スレを落としていけば、一般的な VPS (50GB SSD) で十分
```

### 8.2 帯域見積もり

```
キャッシュ鯖の帯域負荷:

  Gossip 中継（全 zone を購読する場合）:
    50件/秒 × 500B = 25 KB/s（受信）
    × 8 隣人 = 200 KB/s（送信）

  Mailbox 応答:
    100 GET/秒 × 500KB/スレッド = 50 MB/s（ピーク時）
    → 通常は 1-10 GET/秒 = 500 KB/s 〜 5 MB/s

  合計: 1Gbps の VPS で十分に動作
```

### 8.3 推奨サーバースペック

| スペック | 小規模（〜1000人） | 中規模（〜10,000人） |
|:---------|:------------------|:--------------------|
| CPU | 1 vCPU | 2 vCPU |
| RAM | 1 GB | 4 GB |
| SSD | 20 GB | 100 GB |
| 帯域 | 100 Mbps | 1 Gbps |
| コスト | 月 $5-10 (Vultr, Hetzner) | 月 $20-40 |

---

## 9. 実装計画

### 9.1 ファイル構成

```
cache-server/
├── package.json
├── tsconfig.json
├── config.toml                    # 運用設定
├── Dockerfile
│
└── src/
    ├── index.ts                   # エントリポイント
    ├── CacheNode.ts               # Ring-Mesh 参加 + Mailbox 動作
    ├── StorageEngine.ts           # SQLite ストレージ管理
    ├── EvictionManager.ts         # .dat 落ちロジック
    ├── IkioiCalculator.ts         # 勢い計算
    ├── WebSocketTransport.ts      # WebSocket ↔ P2P メッセージ変換
    ├── MetricsCollector.ts        # 統計情報（Prometheus 互換）
    └── config.ts                  # 設定読み込み
```

### 9.2 Phase 1 との連携

```
Phase 1 (最小P2P通信) の実装と並行して:

1. cache-server の WebSocket エンドポイントを実装
2. client の PeerManager に「WebSocket ピア」のサポートを追加
3. トラッカーの SessionManager にキャッシュノードの登録を追加
4. dht-put/dht-get のフローでキャッシュサーバーを優先応答先に

→ Phase 1 完了時点で「キャッシュ鯖経由の Mailbox」が動作する
```

---

## 10. まとめ：設計判断の根拠

| 判断 | 根拠 |
|:-----|:-----|
| 「特別なプロトコル」を追加しない | 既存の dht-get/put がそのまま使える。複雑性を増やさない |
| SQLite を使用 | 組み込み型DB。外部依存なし。WAL で高速書き込み |
| .dat 落ちに「メタデータのみ」使用 | 暗号化を解かずに勢い判定ができる唯一の方法 |
| WebSocket フォールバック | node-datachannel は成熟度に不安。WS は枯れた技術 |
| ストレージ上限 10GB | 標準 VPS の SSD 容量に収まる。コスト月$5-10 |
| Ring-Mesh に参加する方式 | 「特権サーバー」ではなく「強いノード」として振る舞う → 中央集権化を回避 |
