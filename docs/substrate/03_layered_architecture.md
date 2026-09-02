# Part 3: Layered Architecture — 4 層アーキテクチャ

## 3.1 全体図

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Layer 4: Applications                                               │
│  ┌─────────────┐ ┌─────────┐ ┌──────────┐ ┌────────────────┐         │
│  │   BBS       │ │   DM    │ │  Files   │ │  Group Chat    │         │
│  │ (Derived)   │ │(Random) │ │(Derived) │ │  (Derived)     │         │
│  └─────────────┘ └─────────┘ └──────────┘ └────────────────┘         │
│       ▲              ▲           ▲              ▲                    │
│       │              │           │              │                    │
│       │   uses Layer 3 Capabilities             │                    │
│       │              │           │              │                    │
├───────┼──────────────┼───────────┼──────────────┼────────────────────┤
│       │              │           │              │                    │
│  Layer 3: Composable Capabilities                                    │
│  ┌──────────────────────┐ ┌──────────────┐ ┌──────────┐              │
│  │ Log (IMMUTABLE+Hint) │ │ OwnedPointer │ │ ChunkSet │              │
│  └──────────────────────┘ └──────────────┘ └──────────┘              │
│       ▲              ▲              ▲              ▲                 │
│       │              │              │              │                 │
│       │   composed from Layer 2 primitives          │                │
│       │              │              │              │                 │
├───────┼──────────────┼──────────────┼──────────────┼─────────────────┤
│       │              │              │              │                 │
│  Layer 2: Anonymous Storage Primitives                               │
│  ┌──────────────────────┐  ┌──────────────────────┐                  │
│  │  Slot                │  │  Hint                │                  │
│  │  - PoW               │  │  - Blind Tag         │                  │
│  │  - CHK               │  │  - AEAD              │                  │
│  │  - TTL               │  │  - Gossip via Dand.  │                  │
│  │  - Membership check  │  │                      │                  │
│  └──────────────────────┘  └──────────────────────┘                  │
│       ▲                            ▲                                 │
│       │                            │                                 │
│       │   uses Layer 1 network                                       │
│       │                            │                                 │
├───────┼────────────────────────────┼──────────────────────────────────┤
│       │                            │                                 │
│  Layer 1: Network Substrate (既存)                                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                 │
│  │ Ring-DHT │ │ Dandelion│ │  Wire V2 │ │ Bound ID │                 │
│  │ K=5      │ │ Gossip   │ │  MsgPack │ │ (新規)   │                 │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                 │
│  │ WebRTC   │ │ STUN/NAT │ │Signaling │ │IndexedDB │                 │
│  │ DTLS     │ │ Traverse │ │ Tracker  │ │ Storage  │                 │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘                 │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

各層は **下層のみに依存**。上位層への依存は禁止する (循環依存を構造的に防ぐ)。

---

## 3.2 各層の責務

### 3.2.1 Layer 1: Network Substrate

**目的**: P2P 接続、メッセージ配送、永続化の物理基盤を提供する

**含むもの**:
- WebRTC DataChannel (`WebRTCPeer.ts`)
- Ring トポロジ管理 (`RingMaintainer.ts`)
- Ring position 計算 (`RingPosition.ts`) — Bound Identity 化により改修
- Wire V2 バイナリプロトコル (`WireCodec.ts`)
- Dandelion stem/fluff (`DandelionRouter.ts`, `ZoneGossipRouter.ts`)
- Identity (Ed25519) (`Identity.ts`)
- メッセージディスパッチャ (`MessageDispatcher.ts`)
- IndexedDB ストレージ (`IndexedDBStore.ts`)
- シグナリング (`SignalingClient.ts`)

**変更点 (v2)**:
- `RingPosition` を Bound Identity 化: `peerId = SHA256(pubkey)`, `position = SHA256(peerId)`
- それ以外は **既存実装をそのまま再利用**

**変更しない理由**:
- 既存実装は速度実績がある
- 安定している
- 上位層が抽象化を提供するので Layer 1 を触る理由がない

### 3.2.2 Layer 2: Anonymous Storage Primitives

**目的**: 匿名性を保ったストレージと発見の基本単位を提供する

**含むもの**:

| プリミティブ | 役割 |
|---|---|
| `Slot` | ランダム/導出鍵で識別される暗号化バイト列の保管単位 |
| `SlotStore` | Slot の put/get インターフェース (DHT 経由) |
| `Hint` | Slot 鍵を暗号化して通知する Gossip パケット |
| `HintBus` | Hint の subscribe/publish インターフェース |
| `Capability` | 鍵と派生関数の束。Layer 3 が継承して特殊化 |

**性質**:
- **Application 非依存**: thread/post/message を知らない
- **意味を持たない bytes 処理**: payload は不透明
- **検証は厳格**: 受信した Slot は CHK + PoW + 帰属を必ず検証

**詳細**: [04_layer2_primitives.md](./04_layer2_primitives.md) 参照

### 3.2.3 Layer 3: Composable Capabilities

**目的**: Layer 2 を組み合わせて、application が使う高レベル概念を提供する

**含むもの**:

| Capability | 役割 | 内部構成 |
|---|---|---|
| `Log` | 1:N / 1:1 の不変アイテム追記列 (BBS, DM, グループ, pub-sub) | 多数の IMMUTABLE Slot (Mode B) + Hint + バンドル |
| `OwnedPointer` | 単一所有者が署名で更新する最新版指標 | 1 つの OWNED_POINTER Slot + 署名 + version |
| `ChunkSet` | 大きな blob を分散保存 | 多数の IMMUTABLE Slot + Manifest |

> **v2.1**: 旧 `BundledChannel`（1 slot 上書き蓄積）は廃止。「中身を見ない保管ノードは多人数共有 blob の追記を検証できない」「64KB 制限で ~130 投稿で破綻」のため、多人数 / 並行書き込みは全て不変 (IMMUTABLE) アイテムの `Log` に統合。可変は単一所有者の `OwnedPointer` のみ。詳細 [04](./04_layer2_primitives.md) / [05](./05_layer3_capabilities.md)。

**性質**:
- Layer 2 を組み合わせる
- Application 共通の用途を抽象化
- Application 固有のロジックは含まない

**詳細**: [05_layer3_capabilities.md](./05_layer3_capabilities.md) 参照

### 3.2.4 Layer 4: Applications

**目的**: ユーザーが見える機能を Layer 3 を組み合わせて実装する

**含むもの (例)**:

| Application | Layer 3 構成 |
|---|---|
| BBS Thread | `Log` + `OwnedPointer` (head 指標) |
| DM | `Log` (2 者 cap, unlinkable, 双方向 = 2 つ) |
| ファイル共有 | `ChunkSet` + `OwnedPointer` (manifest) + `Log` (コメント) |
| グループチャット | `Log` (allowed_writers) + `OwnedPointer` (member list) + 鍵交換 |
| pub-sub Topic | `Log` のみ |

**性質**:
- ユーザー体験を定義する
- UI 層 (React コンポーネント) を含む
- Application 固有のロジック (例: BBS の anonymous/cap-name の使い分け)

**詳細**: [06_layer4_applications.md](./06_layer4_applications.md) 参照

---

## 3.3 依存関係の規則

### 3.3.1 許可される依存

```
Layer 4 (App)        ──depends on──▶  Layer 3 (Capabilities)
                                       │
                                       ▼
                                      Layer 2 (Primitives)
                                       │
                                       ▼
                                      Layer 1 (Network)
```

### 3.3.2 禁止される依存

```
Layer 1  ──╳──▶  Layer 2/3/4  (network 層は上位を知らない)
Layer 2  ──╳──▶  Layer 3/4    (primitive は capability/app を知らない)
Layer 3  ──╳──▶  Layer 4      (capability は app を知らない)
```

### 3.3.3 同層内の依存

各層内では cross-依存 OK だが、循環は禁止:
- Layer 3 内: `Log` が `OwnedPointer` を使う等は許可
- Layer 4 内: Application 同士の参照は許可 (BBS が DM を使う等)

---

## 3.4 ディレクトリ構成 (提案)

実装時の `web/src/lib/` 構成:

```
web/src/lib/
├── crypto/                  # 既存
│   ├── Identity.ts
│   ├── CryptoEngine.ts
│   ├── KeyManager.ts
│   ├── PacketBuilder.ts     # 既存。BBS-specific なので Layer 4 へ移動推奨
│   ├── MagicFilter.ts
│   └── PoWEngine.ts
├── network/                 # 既存
│   ├── WebRTCPeer.ts
│   ├── PeerManager.ts
│   ├── RingPosition.ts      # ⚠️ Bound Identity 化が必要
│   ├── RingMaintainer.ts
│   ├── wire/
│   │   ├── WireTypes.ts     # HINT (0x42) 追加
│   │   └── WireCodec.ts
│   ├── gossip/
│   │   ├── DandelionRouter.ts
│   │   └── ZoneGossipRouter.ts  # ⚠️ Hint 配送に拡張
│   └── stream/              # 既存 (WS-3)
├── substrate/               # 🆕 Layer 2
│   ├── slot/
│   │   ├── Slot.ts          # Slot 型定義
│   │   ├── SlotStore.ts     # IMailbox 後継。汎用化
│   │   └── SlotValidator.ts # PoW + CHK + 帰属検証
│   ├── hint/
│   │   ├── Hint.ts          # Hint 型定義
│   │   ├── HintBus.ts       # subscribe/publish
│   │   └── BlindTagIndex.ts # 事前計算インデックス
│   └── capability/
│       ├── Capability.ts    # 基底クラス
│       └── KeyDerivation.ts # HKDF 派生ユーティリティ
├── substrate/crypto/        # 🆕 封印ラッパー
│   └── Aead.ts              # seal()/open() = nonce(12)||ct（4.1.4）
├── caps/                    # 🆕 Layer 3
│   ├── Log.ts               # 不変アイテム列（BBS/DM/グループ/pub-sub）
│   ├── OwnedPointer.ts      # 単一所有者の可変指標
│   └── ChunkSet.ts
├── apps/                    # 🆕 Layer 4 (旧 logic/ を再編)
│   ├── bbs/
│   │   ├── BBSThread.ts     # 旧 ThreadOrchestrator
│   │   └── BBSBoard.ts      # 旧 BoardOrchestrator
│   ├── dm/                  # 将来
│   ├── files/               # 将来
│   └── groupchat/           # 将来
├── storage/                 # 既存
│   └── IndexedDBStore.ts    # ⚠️ SlotStore 実装に拡張
└── common/                  # 既存
    ├── Encoding.ts
    ├── CryptoUtils.ts
    └── JsonBinary.ts
```

**移行戦略**:
- 既存ファイルは変更しない (Phase 1 では検証追加のみ)
- 新規 `substrate/` `caps/` `apps/` を追加
- 既存 `logic/`, `network/mailbox/` は段階的に `apps/`, `substrate/` へ移動

---

## 3.5 各層のテスト戦略

各層独立にテスト可能であることが重要:

| 層 | テスト粒度 | モック対象 |
|---|---|---|
| Layer 1 | ピア間接続テスト (既存) | シグナリング |
| Layer 2 | Slot/Hint 単体テスト | Layer 1 全体 (`MockPeerManager`) |
| Layer 3 | Capability 動作テスト | Layer 2 (`MockSlotStore`, `MockHintBus`) |
| Layer 4 | E2E テスト | UI 層のみ実物、Layer 1-3 はモック可 |

特に Layer 2 のテストは「PoW 検証が動く」「CHK が破損 payload を弾く」「帰属外 PUT を拒否する」など、攻撃シナリオの単体テストを含める。

---

## 3.6 並行性とパフォーマンス特性

### 3.6.1 各層の並行性モデル

| 層 | モデル |
|---|---|
| Layer 1 | イベント駆動 (WebRTC `onmessage`, MessageDispatcher) |
| Layer 2 | Promise ベース (async/await) |
| Layer 3 | Promise + Subscription (Observable パターン) |
| Layer 4 | React state + useEffect |

### 3.6.2 ボトルネック予測

| 層 | 主要ボトルネック | 対策 |
|---|---|---|
| Layer 1 | WebRTC RTT (~50-150ms) | 既存通り |
| Layer 2 | PoW 計算 (post 時 ~100ms) | WASM 化 (既存) |
| Layer 2 | AEAD 暗号化 (1KB あたり ~µs) | 問題なし |
| Layer 3 | Log の過去ログ並列 GET 本数 | バンドルで集約、並列 concurrency 制御 |
| Layer 4 | UI 描画 (React) | 仮想スクロール等 |

---

## 3.7 拡張ポイント

新しい用途を追加する際の標準パターン:

### パターン A: 新 Application 追加 (例: マーケットプレイス)
1. `apps/market/` ディレクトリ作成
2. 既存 Capability (Log + OwnedPointer 等) を組み合わせ
3. Layer 2-3 には触らない

### パターン B: 新 Capability 追加 (例: Time-Locked Slot)
1. `caps/TimeLockedSlot.ts` 追加
2. Slot を内部で使う
3. Layer 1-2 には触らない

### パターン C: 新 Primitive 追加 (慎重に)
1. 既存 Capability で実現困難な場合のみ
2. `substrate/` に追加
3. Layer 1 への接続点を明確化
4. 必ず threat model 再評価

---

## 3.8 次に読む

→ [04_layer2_primitives.md](./04_layer2_primitives.md): Slot と Hint の詳細仕様
→ [07_wire_protocol.md](./07_wire_protocol.md): バイト構造の詳細
