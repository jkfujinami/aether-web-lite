# AETHER WebLite コアライブラリ（SDK）分離設計書

## 1. 概要と背景

### 1.1 目的
現在、AETHER WebLite の P2P プロトコル、暗号プリミティブ、DHT/Schrodinger Mailbox、Dandelion++ ルーティング、および掲示板ロジックは、Next.js アプリケーション内部（[`web/src/lib/`](file:///Users/fujinami/github/aether-web-lite/web/src/lib)）に密結合している。

本設計の目的は、このコアロジックを UI および特定実行環境から完全に切り離し、再利用可能なコアライブラリ（`@aether/core`）としてパッケージ化することである。

### 1.2 達成される利点
1. **クライアント UI の疎結合化**: Next.js 掲示板 UI は `@aether/core` の高レベル API を呼ぶだけの純粋なプレゼンテーション層となる。
2. **キャッシュサーバーの言語統一（Rust 脱却）**: `aether-cache` の Rust 実装を廃止し、Node.js または Electron 上で `@aether/core` をそのまま稼働させる。ワイヤ定義変更に伴う二重保守コストをゼロにする。
3. **マルチプラットフォーム展開**: デスクトップ常駐クライアント、ヘッドレスノード、CLI ツール、ボット、別形式の P2P アプリ（チャットやファイル共有）へ同一コードベースでプロトコルスタックを展開可能にする。

---

## 2. アーキテクチャとレイヤリング

### 2.1 全体構造図

```
┌──────────────────────────────────────────────────────────────────┐
│                   アプリケーション層                             │
│  - Web 掲示板 (Next.js / React)                                  │
│  - キャッシュデーモン (Node.js / Docker)                         │
│  - デスクトップ常駐クライアント (Electron)                       │
└─────────────────────────────────┬────────────────────────────────┘
                                  │ 利用 (高レベル API)
┌─────────────────────────────────▼────────────────────────────────┐
│               @aether/core (ファサード & ロジック層)             │
│  - AetherNode (ライフサイクル・イベント統合)                     │
│  - BoardOrchestrator / ThreadOrchestrator                        │
│  - SyncProtocol (差分同期)                                       │
├──────────────────────────────────────────────────────────────────┤
│               P2P プロトコル & 暗号オーバレイ層                  │
│  - SchrodingerMailbox (ランダムスロット・時間分離)               │
│  - DHTMailbox (Kademlia K-nearest 格納)                          │
│  - HintRouter / ZoneGossipRouter / DandelionRouter               │
│  - WireCodec / ChunkedSender / ChunkedReceiver                   │
│  - CryptoEngine / Identity / PoWEngine                           │
├──────────────────────────────────────────────────────────────────┤
│              環境抽象化 SPI (Service Provider Interface)         │
│  - IStorageAdapter       - ITransport / IPeerConnection          │
│  - IPoWRunner            - ISignalingTransport                   │
└──────────────────▲──────────────────────────────▲────────────────┘
                   │ 実装注入                     │ 実装注入
┌──────────────────┴───────────────┐ ┌────────────┴────────────────┐
│      ブラウザ環境アダプタ        │ │      Node / Electron アダプタ  │
│ - IndexedDBStorage (Dexie/idb)   │ │ - SQLiteStorage (better-sqlite3)
│ - WebRTCTransport (ネイティブ)   │ │ - NodeDataChannelTransport   │
│ - WebWorkerPoW (Worker)          │ │ - WorkerThreadsPoW           │
└──────────────────────────────────┘ └─────────────────────────────┘
```

---

## 3. パッケージ・モノレポ構成案

npm workspaces を導入し、リポジトリを整理する。

```
aether-web-lite/
├── package.json                   # ルート workspace 設定
├── packages/
│   ├── core/                      # @aether/core (環境非依存コア)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts           # 公開ファサード
│   │       ├── node/              # AetherNode, NodeConfig
│   │       ├── logic/             # Board/Thread オーケストレータ
│   │       ├── network/           # DHT, Schrodinger, Dandelion, Zone
│   │       ├── wire/              # WireCodec, WireType
│   │       ├── stream/            # ChunkedSender / Receiver
│   │       ├── crypto/            # 暗号, 署名, Identity
│   │       ├── spi/               # ストレージ/通信の抽象インターフェース
│   │       └── common/            # ロガー, エンコーディング, キャッシュ
│   │
│   ├── storage-indexeddb/         # ブラウザ用 IndexedDB アダプタ
│   ├── storage-sqlite/            # Node/Electron 用 SQLite アダプタ
│   ├── transport-webrtc/          # ブラウザネイティブ WebRTC
│   └── transport-node/            # Node.js 用 Transport (WebSocket/DataChannel)
│
├── apps/
│   ├── web/                       # 現行 Next.js UI
│   ├── cache-daemon/              # Node.js キャッシュサーバー (aether-cache 代替)
│   └── desktop/                   # 将来の Electron トレイアプリ
└── docs/
```

---

## 4. SPI（環境抽象化インターフェース）詳細設計

コアライブラリがブラウザ・Node 双方で無改変動作するため、環境依存部分をインターフェースとして分離する。

### 4.1 ストレージ層: `IStorageAdapter`

IndexedDB 特有の `idb` / `Dexie` 依存を `@aether/core` から排除し、KeyValue 永続化およびクエリを抽象化する。

```typescript
export interface IStorageAdapter {
  // Key-Value 操作 (DHT スロット、ノードメタデータ、秘密鍵保存)
  get(table: string, key: string): Promise<Uint8Array | null>;
  put(table: string, key: string, value: Uint8Array): Promise<void>;
  delete(table: string, key: string): Promise<void>;
  listKeys(table: string): Promise<string[]>;

  // 構造化エンティティ操作 (板一覧、スレッド一覧、投稿レコード)
  query<T>(table: string, filter?: (record: T) => boolean): Promise<T[]>;
  save<T extends { id: string }>(table: string, record: T): Promise<void>;
  deleteRecord(table: string, id: string): Promise<void>;

  close(): Promise<void>;
}
```

- **ブラウザ実装**: `IndexedDBStorage`（既存の `Database.ts` の内部実装を適合）。
- **Node/Electron 実装**: `SQLiteStorage`（WAL モードの SQLite を利用し高速化）。

### 4.2 トランスポート層: `ITransport` & `IPeerConnection`

WebRTC のネイティブ API（`window.RTCPeerConnection`）への直接依存を隠蔽する。

```typescript
export interface IPeerConnection {
  readonly peerId: string;
  readonly isConnected: boolean;
  send(data: Uint8Array): void;
  close(): void;
  on(event: 'message', handler: (data: Uint8Array) => void): void;
  on(event: 'close', handler: () => void): void;
}

export interface ITransport {
  createConnection(peerId: string, initiator: boolean): IPeerConnection;
  handleIncomingSignal(fromPeerId: string, signal: SignalingMessage): Promise<SignalingMessage | null>;
}
```

- **ブラウザ実装**: ネイティブ `RTCPeerConnection` + `RTCDataChannel`。
- **Node.js キャッシュサーバー実装**:
  - 双方向 WebSocket トランスポート（他ノードと直接 TCP/WS 接続）。
  - または `node-datachannel`（C++ ネイティブ WebRTC バインディング）。

### 4.3 並列計算層: `IPoWRunner`

投稿時の耐スパム計算（Argon2 / SHA-256 PoW）を UI スレッドから逃がす仕組み。

```typescript
export interface IPoWRunner {
  compute(challenge: Uint8Array, difficulty: number): Promise<Uint8Array>;
}
```

- **ブラウザ実装**: `WebWorkerPoW`（Web Worker を使用）。
- **Node.js 実装**: `WorkerThreadsPoW`（`node:worker_threads` を使用）。

---

## 5. 公開ファサード API 設計 (`AetherNode`)

外部利用者が内部の 15 種以上のサブシステム（PeerManager, ZoneManager, Dandelion, Schrodinger, HintRouter など）を個別配線する負担を無くすため、単一のエントリポイントを提供する。

### 5.1 クラス設計

```typescript
export interface AetherNodeOptions {
  storage: IStorageAdapter;
  transport: ITransport;
  pow?: IPoWRunner;
  signalingUrls: string[];
  maxPeers?: number;
  bootstrapKey?: string;
}

export class AetherNode {
  // ファクトリメソッド
  public static async create(options: AetherNodeOptions): Promise<AetherNode>;

  // ライフサイクル
  public async start(): Promise<void>;
  public async stop(): Promise<void>;

  // ノード状態
  public get peerId(): string;
  public get connectedPeerCount(): number;
  public on(event: 'peer:connect' | 'peer:disconnect', cb: (peerId: string) => void): void;

  // 板・スレッド操作
  public openBoard(boardKey: string | Uint8Array): Promise<BoardHandle>;
  public listJoinedBoards(): Promise<BoardSummary[]>;
}
```

### 5.2 板およびスレッドのハンドル操作

```typescript
export interface BoardHandle {
  readonly boardKey: string;
  listThreads(): Promise<ThreadSummary[]>;
  createThread(title: string, firstPost: PostContent): Promise<ThreadHandle>;
  openThread(threadId: string): Promise<ThreadHandle>;
  onThreadUpdated(cb: (thread: ThreadSummary) => void): () => void;
}

export interface ThreadHandle {
  readonly threadId: string;
  listPosts(): Promise<PostRecord[]>;
  post(content: PostContent): Promise<{ messageId: number; releaseDelayMs: number }>;
  onPost(cb: (post: PostRecord) => void): () => void;
  close(): void;
}
```

---

## 6. 実装・切り出しロードマップ

```
Phase 1: 依存分離と抽象化（現状の web/src/lib 内）
  - IStorageAdapter を定義し、Database.ts をアダプタ経由に変更
  - ブラウザグローバル (window, navigator) への直接参照をパージ
  - テストが fake-indexeddb のみで純粋に完走することを確認

Phase 2: モノレポ構造への移行
  - ルート package.json に workspaces ("packages/*", "apps/*") を定義
  - packages/core ディレクトリを作成し、lib/ を移動
  - packages/storage-indexeddb を作成
  - apps/web が @aether/core をインポートして動く状態を確立

Phase 3: 高レベルファサード (AetherNode) の提供
  - AetherNode / BoardHandle / ThreadHandle を実装
  - apps/web の P2PProvider.tsx を AetherNode 利用コードへリファクタリング

Phase 4: Node.js キャッシュデーモンの作成 (aether-cache 代替)
  - apps/cache-daemon を TypeScript で新設
  - packages/storage-sqlite を実装
  - Rust 版 aether-cache を完全にリプレイス
```
