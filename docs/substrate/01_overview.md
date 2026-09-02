# Part 1: Overview — 設計動機とゴール

## 1.1 現状とその限界

### 1.1.1 現状アーキテクチャの構成

aether-web-lite は現在、BBS (2ch 風掲示板) として動作している。主要コンポーネント:

```
Browser (TypeScript)
├── PeerManager / WebRTCPeer       ... P2P 接続
├── ZoneGossipRouter / Dandelion   ... 投稿の拡散
├── DHTMailbox / SyncProtocol      ... 永続層 (K=5 nearest)
├── ReplicationManager             ... 冗長性維持
├── BoardOrchestrator              ... 板単位ロジック
└── ThreadOrchestrator             ... スレ単位ロジック
```

特徴:
- WebRTC 直 P2P (Relay/Onion なし)
- Ring-Mesh トポロジ
- Dandelion stem/fluff で発信者匿名化
- K-nearest DHT で過去ログ保存

### 1.1.2 速度実績

現状の操作レイテンシ:

| 操作 | 体感速度 |
|---|---|
| BBS 投稿 (Dandelion broadcast + DHT publish) | ~175ms |
| BBS スレ読み込み (DHT fetch) | ~250ms |
| 新規スレ作成 | ~200ms |

ブラウザ完結型 P2P としてはかなり速い。**この速度を維持することが本設計の必須要件**。

### 1.1.3 現状の致命的脆弱性

[architecture_audit.md](../architecture_audit.md) および本セッションでの分析により、以下の重大脆弱性が判明している:

| 脆弱性 | 影響 | 場所 |
|---|---|---|
| **位置自己選択** | Eclipse 攻撃で特定スレを検閲可能 | `RingPosition.ts:11-17` |
| **handlePut 無検証** | ストレージ枯渇攻撃、PoW バイパス | `DHTMailbox.ts:152-155` |
| **handleRes 信頼** | レスポンス偽造で DB 汚染 + 拡散 | `DHTMailbox.ts:164-175` |
| **topicHash 平文** | 「誰がどのスレを読んだか」観測可能 | `DHTMailbox.ts:181` |
| **K-nearest 圏外 PUT 受理** | 任意ノードに任意データを詰められる | `DHTMailbox.ts:152` |
| **ReplicationManager 信頼** | 汚染データを善意でばら撒く | `ReplicationManager.ts:55-65` |

これらは「現状の DHT 設計を続ける限り根本解決できない」性質のもの。

### 1.1.4 アプリケーション拡張性の不在

現状コードは BBS 専用に最適化されており、`thread_id`, `board_id`, `post_type`, `BOARD_META_THREAD_ID` など BBS 概念が core まで漏れ出ている。

DM、ファイル共有、グループチャットを追加するには、現状の `DHTMailbox` / `GossipRouter` を application 知識を含んだまま分岐させる必要があり、複雑度が指数的に増える。

---

## 1.2 設計のゴール

### 1.2.1 機能ゴール

1. **BBS の現状速度を維持** (read ~250ms / post ~175ms)
2. **同一基盤の上に複数 application を載せる**
   - BBS (現在)
   - DM (近未来)
   - ファイル共有 (中期)
   - グループチャット (中期)
   - その他 (将来)
3. **application 非依存の Substrate 層**を持つ
4. **アプリ間で security/anonymity が相互強化** される

### 1.2.2 セキュリティゴール

| 攻撃カテゴリ | 目標水準 |
|---|---|
| メタデータ攻撃 | **完全防御**: 保存ノードは内容も対象も不明 |
| 相関攻撃 | **強い防御**: 同一 channel/conversation 内の slot を結びつけられない |
| Sybil/Eclipse | **完全防御**: 特定 target を狙えない |
| ストレージ汚染 | **完全防御**: PoW + CHK + 帰属検証で全 PUT を弾く |
| 検閲 | **強い防御**: 特定 channel を Sybil 軍で潰せない |
| 交差攻撃 | **out-of-scope** (application 層で対応) |

### 1.2.3 非ゴール (明示的に諦めるもの)

- **IP 完全秘匿**: WebRTC 直 P2P の制約上、隣接ピアには IP が露呈する。Relay/Onion を入れれば解決するが、可用性とのトレードオフで採用しない
- **Forward Secrecy**: BBS の永続性と両立困難。Capability 単位の epoch ローテーションをオプションで提供
- **完全な交差攻撃耐性**: Cover Traffic が必要で、速度劣化が許容範囲を超える。application 層で対処
- **Sybil 完全防御**: Bound Identity + 軽量 PoW で「コストを上げる」までは行う。完全防御は Darknet (友人接続限定) でないと不可能

---

## 1.3 設計哲学

### 1.3.1 三原則

**原則 1: Application-agnostic Substrate**
- Substrate (Layer 1-2) は `thread`, `post`, `message`, `file` といった application 概念を一切知らない
- 扱うのは「ランダム鍵 + 暗号化バイト列」だけ
- これにより application 追加コストが線形に保たれる

**原則 2: Speed-First Schrödinger**
- Schrödinger 原則 (保存ノードが内容を知らない) を採用
- ただし速度劣化要因 (cover traffic, batching, delay) は不採用
- 検証コストは ms オーダーに抑える

**原則 3: Capability-based Access**
- Tahoe-LAFS 流。鍵の所有 = アクセス権
- Capability から派生鍵を導出 (read_key, discovery_key, write_key)
- Capability を渡すことで権限委譲

### 1.3.2 設計判断のトレードオフマトリクス

| 軸 | 採用した立場 | 捨てたもの |
|---|---|---|
| 速度 vs 匿名性 | 速度優先 | 交差攻撃完全耐性 |
| 単純さ vs 防御力 | 単純さ優先 | Cover Traffic 関連の複雑機能 |
| 汎用性 vs 専用最適化 | 汎用性優先 | BBS 専用最適化 (一部維持) |
| Mode A (速) vs Mode B (匿) | **両方サポート** | application 選択責任を負う |

---

## 1.4 着想元の整理

本設計は以下の先行設計を統合したもの:

### 1.4.1 本家 AETHER Core

- **Schrödinger Mailbox** (Part 11): 中核思想
- **Lookup Token** (Part 6.4): 導出鍵での秘匿検索
- **Reed-Solomon Sharding** (Part 5.2): ChunkSet の元
- **Burn-on-Read** (Part 14): Inbox の削除モデル

捨てた部分:
- **Relay/Onion** (Part 12): Web-lite 制約で不採用
- **X3DH/Double Ratchet** (Part 4): BBS には過剰、DM 導入時に検討
- **Hybrid KEM** (Part 4.3): ブラウザ実装コストが高く後回し

### 1.4.2 Tahoe-LAFS

- Capability-based access (read-cap, write-cap)
- 不変 vs 可変オブジェクトの区別 (CHK vs SSK 相当)

### 1.4.3 Freenet (Hyphanet)

- CHK (Content Hash Key) → Slot の `payload_hash` 検証
- USK (Updatable Subspace Key) → OwnedPointer
- Opportunistic Caching → 将来の拡張として保留

### 1.4.4 IPFS / IPNS

- 不変オブジェクト + 可変ポインタの分離 → Slot + OwnedPointer

### 1.4.5 Dandelion++

- 既存実装をそのまま流用
- Hint の Gossip 配信路として継続活用

---

## 1.5 本設計が解決する具体的な問題

### 1.5.1 BBS 単独で見たとき

| 問題 (旧) | 解決 (新) |
|---|---|
| 板のスレ消し攻撃が可能 | Slot 鍵の予測不能化で狙えない |
| 任意 PUT 受理 | PoW + CHK + 帰属検証で拒否 |
| GET 平文 topicHash | Mode A の HMAC-derived 鍵で第三者に不可視 |
| 自由 position 選択 | Bound Identity で防止 |
| ReplicationManager の盲目拡散 | 検証済み Slot のみ replicate |

### 1.5.2 BBS を超えて

| ニーズ | 解決 |
|---|---|
| DM を追加したい | `Log`（2 者 cap, unlinkable）で実装。BBS と同一コード |
| ファイル共有を追加したい | `ChunkSet` + `OwnedPointer`（manifest 指標） |
| グループチャット | `Log`（allowed_writers）+ `OwnedPointer`（member list）+ 鍵交換 |
| pub-sub topic | `Log` がそのまま使える |

---

## 1.6 本ドキュメント群の射程

本ドキュメント群は **Substrate v2 のアーキテクチャ設計** をカバーする。以下は別ドキュメント:

| トピック | 場所 |
|---|---|
| 既存 Dandelion 実装詳細 | [../spec/step5_dandelion.md](../spec/step5_dandelion.md) |
| 既存 Ring-Mesh トポロジ | [../spec/step1_ring_mesh.md](../spec/step1_ring_mesh.md) |
| 既存 Zone 管理 | [../spec/step1_ring_mesh_zone.md](../spec/step1_ring_mesh_zone.md) |
| WireType の現状 | `web/src/lib/network/wire/WireTypes.ts` |
| WebRTC NAT 越え | [../ws3_ws4_stream_nat.md](../ws3_ws4_stream_nat.md) |

---

## 1.7 次に読む

→ [02_threat_model.md](./02_threat_model.md): 詳細な脅威モデル
→ [03_layered_architecture.md](./03_layered_architecture.md): 4 層構成の全体図
