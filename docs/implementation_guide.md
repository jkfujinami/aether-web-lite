# AETHER Web-Lite: 統合実装ガイド

**バージョン**: 1.0.0
**最終更新**: 2026-03-20
**対象読者**: このドキュメント1つで、実装に必要な全情報にアクセスできる

---

## 0. 全体像

```
「配信は中央、通信は分散」のハイブリッドアーキテクチャ

┌──────────── Web Server（中央・静的配信）──────────┐
│  HTML / JS / CSS → ブラウザに配信                   │
│  広告・SEO・OGP → 収益化・検索エンジン対応          │
│  Cloudflare Turnstile → ボット排除                  │
└────────────────────────────────────────────────────┘
                    ↕ WebSocket（初期接続のみ）
┌──────────── Signaling Server（トラッカー）──────────┐
│  SDP中継 → 最初の8人と出会うためだけに存在           │
│  接続完了後に切断 → 以降は完全P2P                    │
└────────────────────────────────────────────────────┘
                    ↕ WebRTC DataChannel（P2P）
┌──────────── P2P Layer（分散・暗号化）──────────────┐
│  Ring-Mesh + Adaptive Zone → 構造的連結＋自動拡縮    │
│  Broadcast Veil / Zone Gossip → 閲覧プライバシー     │
│  Dandelion++ → 書き込みプライバシー                  │
│  ChaCha20 + Ed25519 + Argon2 → 暗号＋署名＋PoW      │
│  DHT Mailbox → 過去ログ永続化                        │
└────────────────────────────────────────────────────┘
```

---

## 1. 仕様書マップ

| 詳細仕様 | パス | 主要トピック |
|:---------|:-----|:-------------|
| 原典設計書 | [`aether_web_lite_design.md`](aether_web_lite_design.md) | 全体思想・暗号モデル・Broadcast Veil・スパム対策 |
| 技術仕様書 | [`technical_specification.md`](technical_specification.md) | 技術スタック・P2Pメッセージ型・ファイル構成概要 |
| Ring-Mesh基盤 | [`spec/step1_ring_mesh.md`](spec/step1_ring_mesh.md) | Ring構造・ローカルリンク・修復・Mailbox・実装注意10項目 |
| Adaptive Zone | [`spec/step1_ring_mesh_zone.md`](spec/step1_ring_mesh_zone.md) | CIDR分割・K-匿名購読・Zone-aware接続・シミュレーション結果 |
| 暗号化 | [`spec/step4_encryption.md`](spec/step4_encryption.md) | 鍵階層・ChaCha20・Ed25519・PoW・マジックバイト・パケット構造 |
| Dandelion++ | [`spec/step5_dandelion.md`](spec/step5_dandelion.md) | Stem/Fluff・エコーリトライ・越境インジェクション |
| シグナリングサーバー | [`spec/step8_signaling_server.md`](spec/step8_signaling_server.md) | WebSocketプロトコル・Turnstile・レートリミット・デプロイ |

---

## 2. ファイル構成（確定版）

```
aether-web-lite/
│
├── docs/                              # ドキュメント
│   ├── aether_web_lite_design.md      # 原典設計書
│   ├── technical_specification.md     # 技術仕様書 v0.2.0
│   ├── implementation_guide.md        # ★ 本ファイル（統合実装ガイド）
│   └── spec/                          # 各Stepの詳細仕様
│
├── client/                            # ブラウザ側（Vite + TypeScript）
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── package.json
│   │
│   └── src/
│       ├── main.ts                    # エントリポイント（初期化オーケストレーション）
│       ├── types.ts                   # 共通型定義（PeerId, P2PMessage, etc.）
│       ├── constants.ts               # 全定数パラメータ
│       │
│       ├── network/                   # === Layer 1: Ring-Mesh 基盤 ===
│       │   ├── RingPosition.ts        #   円環位置の生成・永続化・距離計算
│       │   ├── WebRTCPeer.ts          #   単一WebRTC接続のラッパー
│       │   ├── PeerManager.ts         #   全ピア管理・接続度維持・Zone-aware選択
│       │   ├── RingMaintainer.ts      #   リング構造の維持・修復・隣人計算
│       │   ├── ZoneManager.ts         #   Adaptive Zone Depth管理・購読セット
│       │   ├── PEXHandler.ts          #   Peer Exchange（ゾーンメイト探索含む）
│       │   ├── SignalingClient.ts     #   トラッカーWebSocket通信
│       │   ├── Heartbeat.ts           #   死活監視（ping/pong）
│       │   └── NetworkEvents.ts       #   ネットワークイベント型定義
│       │
│       ├── gossip/                    # === Layer 2: ゴシップ配信 ===
│       │   ├── ZoneGossipRouter.ts    #   ゾーン内BFS Flood
│       │   ├── DandelionRouter.ts     #   Stem/Fluff切替・越境インジェクション
│       │   ├── PacketValidator.ts     #   PoW検証・TTL・サイズ制限
│       │   └── SeenCache.ts           #   packet_id重複排除（LRU）
│       │
│       ├── mailbox/                   # === Layer 3: DHT 永続化 ===
│       │   ├── DHTMailbox.ts          #   Ring-DHT K最近接・PUT/GET
│       │   ├── ReplicationManager.ts  #   K=5冗長・再レプリケーション
│       │   └── SyncProtocol.ts        #   新規参加者への過去ログ同期
│       │
│       ├── crypto/                    # === Layer 4: 暗号化 ===
│       │   ├── CryptoEngine.ts        #   ChaCha20-Poly1305 暗号化/復号
│       │   ├── MagicFilter.ts         #   マジックバイト4B部分復号フィルタ
│       │   ├── KeyManager.ts          #   boardkey → thread_key → topic_hash
│       │   ├── Identity.ts            #   Ed25519 セッションID・トリップ
│       │   ├── PoWEngine.ts           #   Argon2id WASM PoW計算
│       │   ├── DifficultyEstimator.ts #   難易度の自律合意
│       │   └── PacketBuilder.ts       #   3層パケット構築
│       │
│       ├── storage/                   # === ローカルストレージ ===
│       │   ├── Database.ts            #   Dexie.js スキーマ・マイグレーション
│       │   └── PostStore.ts           #   投稿のCRUD・期限付き削除
│       │
│       ├── worker/                    # === Web Worker ===
│       │   ├── network.worker.ts      #   中継・暗号・PoW検証（メイン非阻害）
│       │   └── WorkerBridge.ts        #   メインスレッド ↔ Worker RPC
│       │
│       └── ui/                        # === UI（後半フェーズ）===
│           ├── App.ts
│           ├── BoardView.ts
│           ├── ThreadView.ts
│           └── SettingsView.ts
│
├── server/                            # シグナリングサーバー
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   └── src/
│       ├── index.ts                   # エントリポイント
│       ├── TrackerServer.ts           # WebSocketシグナリング本体
│       ├── SessionManager.ts          # 接続中ピア管理・ピアリスト生成
│       ├── RateLimiter.ts             # IPベースレートリミット
│       └── TurnstileVerifier.ts       # Cloudflare Turnstile検証
│
├── simulation/                        # シミュレーション
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── RingMeshSimulator.ts       # Ring-Mesh基本シミュレータ
│       ├── run_adaptive_zone.ts       # Adaptive Zoneテスト
│       ├── run_gossip_mailbox.ts      # ゴシップ+Mailbox統合テスト
│       └── ...
│
└── __tests__/                         # テスト
    ├── unit/
    │   ├── network/
    │   ├── gossip/
    │   ├── mailbox/
    │   └── crypto/
    ├── integration/
    │   ├── mesh-gossip.test.ts
    │   ├── gossip-crypto.test.ts
    │   └── full-post-flow.test.ts
    └── e2e/
        └── browser-p2p.test.ts
```

---

## 3. SOLID原則に基づくモジュール設計

### 3.1 各原則の適用方針

| 原則 | 適用方針 |
|:-----|:---------|
| **S** 単一責任 | 1クラス = 1つの関心事。`PeerManager`は接続管理のみ。暗号はしない。ゾーンも知らない |
| **O** 開放閉鎖 | Gossipルーターはインターフェース経由で差し替え可能。Zone有無で実装切替 |
| **L** リスコフ置換 | `IGossipRouter`を実装する`ZoneGossipRouter`と`BroadcastRouter`は完全に交換可能 |
| **I** インターフェース分離 | `WebRTCPeer`は`ISendable`と`IReceivable`に分離。UIは`ISendable`だけ参照 |
| **D** 依存性逆転 | 全モジュールはインターフェースに依存。具象クラスの生成は`main.ts`のDIコンテナのみ |

### 3.2 コア・インターフェース定義

```typescript
// types.ts — 全モジュールが依存する抽象層

// ── ネットワーク ──
export interface IPeerConnection {
  readonly peerId: PeerId;
  readonly position: number;
  readonly zones: ReadonlySet<number>;
  readonly rtt: number;
  send(msg: Uint8Array): void;
  close(): void;
}

export interface IPeerManager {
  readonly peers: ReadonlyMap<PeerId, IPeerConnection>;
  readonly degree: number;
  connect(peerId: PeerId, position: number, zones: number[]): Promise<IPeerConnection>;
  disconnect(peerId: PeerId): void;
  on(event: string, handler: (...args: any[]) => void): void;
}

// ── ゴシップ ──
export interface IGossipRouter {
  publish(packet: GossipPacket): void;
  onReceive(handler: (packet: GossipPacket) => void): void;
}

// ── 暗号 ──
export interface ICryptoEngine {
  encrypt(threadKey: Uint8Array, payload: Uint8Array): EncryptedPayload;
  decrypt(threadKey: Uint8Array, payload: EncryptedPayload): Uint8Array | null;
}

export interface IKeyManager {
  deriveThreadKey(boardkey: Uint8Array, threadId: string): Uint8Array;
  deriveTopicHash(threadKey: Uint8Array): Uint8Array;
  computeZoneId(topicHash: Uint8Array, depth: number): number;
}

export interface IIdentity {
  readonly sessionDisplay: string;
  readonly tripDisplay: string;
  sign(data: Uint8Array): SignatureBundle;
}

export interface IPoWEngine {
  compute(payload: Uint8Array, difficulty: number): Promise<bigint>;
  verify(payload: Uint8Array, nonce: bigint, difficulty: number): Promise<boolean>;
}

// ── ストレージ ──
export interface IPostStore {
  save(post: Post): Promise<void>;
  getByThread(boardId: string, threadId: string): Promise<Post[]>;
  getRecentTimestamps(count: number): Promise<number[]>;
}

// ── Mailbox ──
export interface IMailbox {
  put(topicHash: Uint8Array, data: Uint8Array): Promise<void>;
  get(topicHash: Uint8Array): Promise<Uint8Array | null>;
}
```

### 3.3 依存関係グラフ（モジュール間の接続）

```
main.ts（DIコンテナ・オーケストレーション）
  │
  ├── SignalingClient ─────────────→ TrackerServer (WebSocket)
  │
  ├── RingPosition (永続化: IndexedDB)
  │
  ├── PeerManager
  │     ├── uses: WebRTCPeer (生成・管理)
  │     ├── uses: RingMaintainer (ローカルリンク計算)
  │     └── uses: PEXHandler (候補探索)
  │
  ├── ZoneManager
  │     ├── uses: IKeyManager (ゾーンID計算)
  │     └── uses: IPeerManager (隣人のゾーン情報)
  │
  ├── ZoneGossipRouter ← implements IGossipRouter
  │     ├── uses: IPeerManager (隣人へ送信)
  │     ├── uses: ZoneManager (ゾーンフィルタ)
  │     ├── uses: SeenCache (重複排除)
  │     └── uses: PacketValidator (PoW検証・TTL)
  │
  ├── DandelionRouter
  │     ├── uses: IGossipRouter (Fluff移行時にデリゲート)
  │     ├── uses: IPeerManager (Stem先選択)
  │     └── uses: IMailbox (越境インジェクション失敗時のフォールバック)
  │
  ├── CryptoEngine ← implements ICryptoEngine
  │     └── uses: libsodium-wrappers
  │
  ├── MagicFilter
  │     └── uses: libsodium-wrappers (ChaCha20 keystream)
  │
  ├── KeyManager ← implements IKeyManager
  │     └── uses: libsodium-wrappers (HMAC, SHA256)
  │
  ├── Identity ← implements IIdentity
  │     └── uses: libsodium-wrappers (Ed25519)
  │
  ├── PoWEngine ← implements IPoWEngine
  │     └── uses: argon2-browser (WASM, Worker内で実行)
  │
  ├── DifficultyEstimator
  │     └── uses: IPostStore (直近タイムスタンプ取得)
  │
  ├── PacketBuilder
  │     ├── uses: ICryptoEngine (暗号化)
  │     ├── uses: IIdentity (署名)
  │     ├── uses: IPoWEngine (PoW計算)
  │     └── uses: IKeyManager (ゾーンID計算)
  │
  ├── DHTMailbox ← implements IMailbox
  │     ├── uses: IPeerManager (K最近接ノード探索)
  │     └── uses: ReplicationManager (K=5冗長)
  │
  ├── Database (Dexie.js)
  │     └── PostStore ← implements IPostStore
  │
  └── WorkerBridge
        └── network.worker.ts (中継・暗号・PoW検証)
```

---

## 4. 起動シーケンス（main.ts のオーケストレーション）

```typescript
// main.ts — 初期化の順序（依存関係に基づく）

async function boot(): Promise<void> {
  // Phase 0: ライブラリ初期化
  await sodium.ready;                    // libsodium WASM読み込み
  const db = new AetherDB();             // IndexedDB接続

  // Phase 1: ローカル状態の復元
  const position = await RingPosition.loadOrCreate(db);
  const identity = new Identity();
  await identity.initTrip(db);
  const keyManager = new KeyManager();
  const postStore = new PostStore(db);

  // Phase 2: ネットワーク基盤の構築
  const peerManager = new PeerManager(position);
  const ringMaintainer = new RingMaintainer(peerManager);
  const pexHandler = new PEXHandler(peerManager);
  const heartbeat = new Heartbeat(peerManager);

  // Phase 3: ゾーン管理
  const zoneManager = new ZoneManager(keyManager, peerManager, db);
  await zoneManager.restoreSubscriptions(db);  // 既存セッションの購読復元

  // Phase 4: ゴシップ・暗号
  const cryptoEngine = new CryptoEngine();
  const magicFilter = new MagicFilter();
  const powEngine = new PoWEngine();       // Web Worker内で実行
  const seenCache = new SeenCache(db);
  const packetValidator = new PacketValidator(powEngine);
  const gossipRouter = new ZoneGossipRouter(peerManager, zoneManager, seenCache, packetValidator);
  const dandelionRouter = new DandelionRouter(gossipRouter, peerManager, zoneManager);
  const difficultyEstimator = new DifficultyEstimator(postStore);
  const packetBuilder = new PacketBuilder(cryptoEngine, identity, keyManager, powEngine);

  // Phase 5: Mailbox
  const mailbox = new DHTMailbox(peerManager, position);
  const replicationMgr = new ReplicationManager(mailbox, peerManager);
  const syncProtocol = new SyncProtocol(mailbox, cryptoEngine);

  // Phase 6: トラッカー接続 → P2Pメッシュへ参加
  const signaling = new SignalingClient(TRACKER.URL, peerManager);
  await signaling.connect({
    peerId: peerManager.myPeerId,
    position: position.value,
    zones: Array.from(zoneManager.subscribedZones),
    turnstileToken: await getTurnstileToken(),
  });

  // Phase 7: 初期ピアとWebRTC接続確立
  signaling.on('peers', async (peers) => {
    for (const peer of peers) {
      await peerManager.connect(peer.peerId, peer.position, peer.zones);
    }
    // RING_LOCAL以上接続したらトラッカー切断
    if (peerManager.degree >= RING_MESH_ZONE.RING_LOCAL) {
      signaling.disconnect();
    }
  });

  // Phase 8: 定期タスク開始
  heartbeat.start();
  ringMaintainer.start();
  pexHandler.start();
  zoneManager.startDepthRecompute();

  // Phase 9: 受信パイプライン組み立て
  setupReceivePipeline(gossipRouter, cryptoEngine, magicFilter, identity, postStore, db);

  // Phase 10: UI初期化
  const app = new App(packetBuilder, dandelionRouter, gossipRouter, postStore, keyManager, zoneManager);
  app.mount('#root');
}
```

---

## 5. コアフロー（シーケンス図）

### 5.1 書き込みフロー

```
User → UI → PacketBuilder → DandelionRouter → Mesh → 全ゾーン住人

詳細:
  1. ユーザーが「書き込む」ボタンを押す
  2. PacketBuilder:
     a. 本文をMessagePackでシリアライズ
     b. Ed25519で署名（セッション鍵 + トリップ鍵）
     c. "AETH" + signed_payload を ChaCha20-Poly1305 で暗号化
     d. DifficultyEstimator で現在の難易度を取得
     e. PoWEngine (Worker) で Argon2id nonce を計算（0.5〜30秒）
     f. 外側ヘッダー（packet_id, hop_count=0, pow_nonce, zone_id）を付加
  3. DandelionRouter:
     a. Dandelion ON → Stemパケット作成、1人にだけ送信
     b. Dandelion OFF → ZoneGossipRouterに直接渡す
  4. ZoneGossipRouter:
     → zone_idが一致する隣人にBFS Flood
  5. 受信側:
     → 検証パイプライン（§5.2）を通過 → IndexedDB保存 → UI表示
```

### 5.2 受信パイプライン

```
Packet着信 → 11段階の検証 → UIに表示

  [メインスレッド / Worker で実行]
  1. payload_size ≤ 2KB        → 超過: DROP
  2. packet_id 重複チェック     → SeenCache にあり: DROP
  3. hop_count ≤ 30            → 超過: DROP
  4. |timestamp - now| ≤ 5min  → 範囲外: DROP
  5. zone_id ∈ mySubscribedZones → 非購読: DROP（中継しない）
  6. PoW検証 (Argon2id 1回)    → 不合格: DROP
  7. SeenCacheに登録
  8. hop_count++ して同ゾーン隣人にリレー

  [暗号判定（自分宛てか？）]
  9. for each threadKey:
       MagicFilter.quickCheck(4B XOR) → 不一致: SKIP(~5ns)
  10. CryptoEngine.decrypt(AEAD)      → 失敗: SKIP(~500ns)
  11. Identity.verify(Ed25519)        → 検証

  → 成功: PostStore.save() → UI.display()
```

### 5.3 新規参加→過去ログ取得→リアルタイム受信開始

```
  1. ブラウザでURL（#key=XXX付き）を開く
  2. main.ts の boot() → Phase 0〜7（トラッカー→P2P接続確立）
  3. URLからboardkeyを抽出 → thread_keyを派生
  4. topic_hash = SHA256(thread_key) → DHT Mailboxに問い合わせ
  5. K=5のうち応答した最寄りノードから暗号化過去ログ取得
  6. thread_keyで復号 → IndexedDBに保存 → UIにスレッド表示
  7. zone_id = topic_hash[0..depth] → ZoneManager.subscribe(zone_id)
  8. 以降、該当ゾーンのゴシップが自動的に流れてくる（リアルタイム受信開始）
```

---

## 6. データフロー図

```
                    ┌─────────────────────────────────────┐
                    │           ユーザーの画面              │
                    │  ┌───────┐ ┌───────┐ ┌──────────┐   │
                    │  │板一覧  │ │スレ表示│ │書き込み欄 │   │
                    │  └───┬───┘ └───┬───┘ └────┬─────┘   │
                    └──────┼────────┼──────────┼──────────┘
                           │        │          │
                     read  │        │ read     │ write
                           ▼        ▼          ▼
                    ┌──────────────────────────────────┐
                    │         PostStore (IndexedDB)      │
                    │  posts / boards / identity         │
                    └──────┬─────────────────┬──────────┘
                     sync  │                 │ save
                           ▼                 ▲
                    ┌──────────────┐  ┌──────┴─────────┐
                    │ SyncProtocol │  │ PacketBuilder   │
                    │ (初回同期)    │  │ (署名→暗号→PoW) │
                    └──────┬──────┘  └──────┬──────────┘
                     GET   │                │ publish
                           ▼                ▼
                    ┌──────────────┐  ┌─────────────────┐
                    │ DHTMailbox   │  │ DandelionRouter  │
                    │ (K=5 DHT)    │  │ (Stem → Fluff)   │
                    └──────┬──────┘  └──────┬──────────┘
                           │                │
                           ▼                ▼
                    ┌──────────────────────────────────┐
                    │       ZoneGossipRouter             │
                    │  (ゾーン内BFS Flood + SeenCache)    │
                    └──────┬─────────────────┬──────────┘
                     send  │                 │ recv
                           ▼                 ▲
                    ┌──────────────────────────────────┐
                    │         PeerManager                │
                    │  WebRTCPeer × 16 (Ring + Zone)    │
                    └──────────────────────────────────┘
```

---

## 7. テスト戦略

### 7.1 テストピラミッド

```
          ╱╲
         ╱E2E╲         ブラウザ2台のP2P通信（Playwright）
        ╱──────╲
       ╱ 統合    ╲      モジュール間の結合テスト
      ╱────────────╲
     ╱   ユニット    ╲   各クラスの単体テスト（Vitest）
    ╱────────────────╲
```

### 7.2 ユニットテスト

| モジュール | テスト対象 | モック |
|:-----------|:----------|:-------|
| **RingPosition** | 距離計算(ラップアラウンド)、永続化/復元 | IndexedDB (in-memory) |
| **RingMaintainer** | 隣人計算、修復トリガー、evictLongRange | PeerManager (stub) |
| **ZoneManager** | depth計算、購読セット生成、再抽選禁止 | KeyManager (stub) |
| **PeerManager** | 接続度維持、MAX_DEGREE制限、ローカル優先 | WebRTCPeer (mock) |
| **ZoneGossipRouter** | ゾーンフィルタ、BFS転送、SeenCache連携 | PeerManager, SeenCache |
| **DandelionRouter** | Stem TTL減算、Fluff判定、エポック固定、エコー | GossipRouter (mock) |
| **CryptoEngine** | encrypt→decrypt往復、不正鍵での復号失敗 | なし (libsodium実体) |
| **MagicFilter** | quickCheck正常判定、不正鍵でfalse | なし |
| **KeyManager** | boardkey→thread_key→topic_hash→zone_id の一貫性 | なし |
| **Identity** | 署名→検証、セッションID表示文字列、トリップ永続化 | IndexedDB |
| **PoWEngine** | compute→verify往復、difficulty境界テスト | なし (argon2 WASM) |
| **DifficultyEstimator** | 投稿頻度→difficulty変換、境界値(MIN/MAX) | PostStore (stub) |
| **PacketBuilder** | 3層構築→各層の正常デコード | CryptoEngine, Identity |
| **PacketValidator** | サイズ超過、TTL超過、タイムスタンプ範囲外、PoW不合格 | PoWEngine (stub) |
| **SeenCache** | 登録→重複判定、LRU溢れ | なし |
| **SessionManager** | ピア選出(Ring近接+Zone共有+ランダム) | なし |
| **RateLimiter** | 30秒間隔制限、バースト制限、クリーンアップ | なし |

### 7.3 統合テスト

| テスト名 | 検証内容 | 結合するモジュール |
|:---------|:---------|:------------------|
| **mesh → gossip** | メッシュ参加後にゴシップが伝搬するか | PeerManager + ZoneGossipRouter |
| **gossip → crypto** | 暗号化パケットが正しく復号されるか | ZoneGossipRouter + CryptoEngine + MagicFilter |
| **write → receive** | 書き込み→暗号化→PoW→Gossip→復号→表示の全フロー | PacketBuilder + DandelionRouter + ZoneGossipRouter + CryptoEngine |
| **mailbox sync** | DHT PUT→新規参加→GET→復号→表示 | DHTMailbox + SyncProtocol + CryptoEngine |
| **dandelion echo** | Stem送信→Fluff→エコー確認→タイマー停止 | DandelionRouter + ZoneGossipRouter |

### 7.4 E2Eテスト（Playwright）

```typescript
// browser-p2p.test.ts
test('2つのブラウザタブでリアルタイムチャットができる', async () => {
  // Tab A: 板を作成、URLをコピー
  const tabA = await browser.newPage();
  await tabA.goto('http://localhost:5173/board/test#boardkey=...');
  await tabA.waitForSelector('[data-testid="connected"]');  // P2P接続確立

  // Tab B: 同じURLで参加
  const tabB = await browser.newPage();
  await tabB.goto(/* same URL */);
  await tabB.waitForSelector('[data-testid="connected"]');

  // Tab A: 書き込み
  await tabA.fill('[data-testid="post-input"]', 'キタ━━━(゜∀゜)━━━!!');
  await tabA.click('[data-testid="post-submit"]');

  // Tab B: 受信確認
  await tabB.waitForSelector('text=キタ━━━(゜∀゜)━━━!!', { timeout: 5000 });
});
```

---

## 8. 実装フェーズと優先度

### Phase 1: 最小P2P通信（メッシュ基盤）

```
目標: 2つのブラウザタブ間でWebRTCメッセージを送受信
期間: 1-2週間

実装ファイル:
  ├── constants.ts           (定数定義)
  ├── types.ts               (型定義)
  ├── network/
  │   ├── RingPosition.ts    (位置生成のみ、永続化は後)
  │   ├── WebRTCPeer.ts      (DataChannel接続)
  │   ├── PeerManager.ts     (接続度管理)
  │   ├── SignalingClient.ts  (トラッカー接続)
  │   ├── Heartbeat.ts       (ping/pong)
  │   └── NetworkEvents.ts   (イベント型)

テスト:
  - WebRTCPeer: DataChannel経由のメッセージ送受信
  - PeerManager: degree維持、MAX制限

サーバー（並行実装）:
  └── server/src/
      ├── index.ts
      ├── TrackerServer.ts    (SDP中継のみ。Turnstileは後)
      └── SessionManager.ts   (最小限のピア管理)
```

### Phase 2: リング構造 + PEX

```
目標: トラッカー切断後もP2Pだけで新規ピアと接続できる
期間: 1週間

追加ファイル:
  ├── network/
  │   ├── RingMaintainer.ts   (ローカルリンク計算・修復)
  │   └── PEXHandler.ts       (SDP Relay経由のピア交換)

テスト:
  - 3ノード以上でのRing形成
  - トラッカー切断後のPEXによるピア発見
  - ノード離脱 → 自動修復
```

### Phase 3: ゴシップ配信

```
目標: 1ノードが送信したメッセージが全ノードに到達する
期間: 1週間

追加ファイル:
  ├── gossip/
  │   ├── ZoneGossipRouter.ts  (BFS Flood、Zone未対応=Full Broadcast)
  │   ├── PacketValidator.ts   (TTL・サイズ制限のみ。PoWは後)
  │   └── SeenCache.ts         (LRU重複排除)

テスト:
  - 5ノードでのメッセージ到達確認
  - SeenCacheによる重複排除
  - TTL超過でのドロップ
```

### Phase 4: 暗号化

```
目標: 暗号化された書き込みがURL所有者だけに読める
期間: 1-2週間

追加ファイル:
  ├── crypto/
  │   ├── CryptoEngine.ts      (ChaCha20暗号/復号)
  │   ├── MagicFilter.ts       (4Bフィルタ)
  │   ├── KeyManager.ts        (鍵派生)
  │   ├── Identity.ts          (Ed25519署名)
  │   ├── PoWEngine.ts         (Argon2id)
  │   ├── DifficultyEstimator.ts
  │   └── PacketBuilder.ts     (3層パケット構築)
  ├── worker/
  │   ├── network.worker.ts    (PoW計算をWorkerに移動)
  │   └── WorkerBridge.ts
  ├── storage/
  │   ├── Database.ts          (Dexie.jsスキーマ)
  │   └── PostStore.ts

テスト:
  - 暗号化→復号の往復
  - MagicFilter判定
  - PoW compute→verify
  - 不正鍵・改竄パケットの拒否
```

### Phase 5: Adaptive Zone

```
目標: ノード数に応じてゾーン分割が自動で効く
期間: 1週間

追加ファイル:
  ├── network/
  │   └── ZoneManager.ts       (depth計算・購読セット・K-匿名)
  └── gossip/
      └── ZoneGossipRouter.ts  (ゾーンフィルタリング追加)

テスト:
  - depth自動計算
  - ゾーンフィルタリング（非購読ゾーンのドロップ）
  - 購読セット固定（再抽選禁止）
```

### Phase 6: Dandelion++ + Mailbox

```
目標: 送信者匿名化 + 過去ログ永続化
期間: 1-2週間

追加ファイル:
  ├── gossip/
  │   └── DandelionRouter.ts   (Stem/Fluff・エコーリトライ)
  ├── mailbox/
  │   ├── DHTMailbox.ts
  │   ├── ReplicationManager.ts
  │   └── SyncProtocol.ts

テスト:
  - Stem経路の到達確認
  - エコーリトライ → フォールバック
  - Mailbox PUT/GETの往復
  - 新規参加者の過去ログ同期
```

### Phase 7: UI + 結合

```
目標: 2ch風の掲示板UIで全機能を統合
期間: 2-3週間

  ├── ui/
  │   ├── App.ts            (ルーティング)
  │   ├── BoardView.ts      (スレ一覧)
  │   ├── ThreadView.ts     (レス表示・書き込み)
  │   └── SettingsView.ts   (Dandelion ON/OFF等)

  └── server/src/
      ├── RateLimiter.ts      (レートリミット追加)
      └── TurnstileVerifier.ts (Turnstile認証追加)
```

---

## 9. 実装上の致命的注意点（全Step横断）

### 🔴 CRITICAL（守らないと暗号やプライバシーが崩壊する）

| # | 注意点 | 該当仕様 |
|:-:|:-------|:---------|
| 1 | **ChaCha20のnonceを再使用するな** → 同一鍵で同一nonceを使うと暗号が完全崩壊。毎回`randombytes_buf(12)`で生成 | step4 §9.3 |
| 2 | **ゾーン購読セットをセッション中に変更するな** → 交差攻撃で本命ゾーンが特定される | zone §7.2 |
| 3 | **Stemパケットを SeenCache に登録するな** → 登録するとFluffで戻ってきた時に重複判定で消える → 配信失敗 | step5 §8.2 |
| 4 | **PoW検証はFluff移行時に行え** → Stem中にPoW検証すると攻撃ベクタ | step5 §6.2 |
| 5 | **libsodium.ready を待て** → WASM読み込み前に暗号APIを呼ぶとクラッシュ | step4 §9.1 |
| 6 | **PoW計算はWeb Worker内で実行** → メインスレッドで回すとUIが数十秒フリーズ | step4 §9.2 |

### 🟡 IMPORTANT（守らないと性能や安定性に問題が出る）

| # | 注意点 | 該当仕様 |
|:-:|:-------|:---------|
| 7 | **ローカルリンク(4本)を切断するな** → ロングレンジだけ切る(evictLongRange) | step1 §8.2 |
| 8 | **repairAll は1回だけ実行** → 無限ループ防止 | step1 §8.5 |
| 9 | **depth変更は上昇=即座、下降=5分待機** → ヒステリシスで振動防止 | zone §7.1 |
| 10 | **ゴシップはBFS（全隣人転送）** → DFSやランダム選択だと到達率が下がる | step1 §8.1 |
| 11 | **Dandelion OFFでも他人のStemは中継する** → 拒否するとDandelion使用の有無が漏れる | step5 §8.3 |

### 🟢 RECOMMENDED（品質向上のための推奨事項）

| # | 注意点 | 該当仕様 |
|:-:|:-------|:---------|
| 12 | **positionはIndexedDBに永続化** → タブ再開時にRing上の位置を維持 | step1 §8.3 |
| 13 | **Mailboxデータのage管理** → Node Aging(10分)でSybil耐性 | design §13.3 |
| 14 | **MessagePackでシリアライズ** → JSON比30-50%削減 | tech_spec §1.1 |
| 15 | **SeenCacheの永続化** → タブ復帰時の重複受信を防止 | step4 §8.1 |

---

## 10. 技術選定の根拠

| 選択 | 代替案 | 採用理由 |
|:-----|:-------|:---------|
| ChaCha20-Poly1305 | AES-256-GCM | WASM/JS環境ではChaChaの方が高速。AES-NI非対応モバイルでも安定 |
| Ed25519 | ECDSA (secp256k1) | libsodiumで直接利用可。署名サイズが小さい(64B) |
| Argon2id | SHA256 PoW | メモリハードでGPU/ASIC耐性。ボットが不利 |
| Dexie.js | 生IndexedDB | 型安全なクエリAPI。マイグレーション機構付き |
| MessagePack | JSON / Protobuf | スキーマレスで柔軟、JSONより30-50%小さい。Protobufほどの複雑さ不要 |
| Vite | Webpack | 高速HMR。ESBuildベースで開発体験が良い |
| ws (server) | Socket.io | 最軽量。Socket.ioの抽象化は不要（WebSocket標準だけで十分） |
