# Part 10: Migration — 既存コードからの移行マッピング

## 10.1 マッピング全体図

```
旧アーキテクチャ                       新 Substrate v2

┌─────────────────────┐               ┌─────────────────────┐
│ BoardOrchestrator   │ ────────▶     │ apps/bbs/BBSBoard   │
│ ThreadOrchestrator  │ ────────▶     │ apps/bbs/BBSThread  │
└─────────────────────┘               └─────────────────────┘
                                          │ uses
                                          ▼
┌─────────────────────┐               ┌─────────────────────┐
│ SyncProtocol        │ ────────▶     │ caps/Log            │
│ PacketBuilder       │ ────────▶     │ (一部 → BBSThread)  │
│                     │               │ caps/OwnedPointer   │
└─────────────────────┘               └─────────────────────┘
                                          │ uses
                                          ▼
┌─────────────────────┐               ┌─────────────────────┐
│ DHTMailbox          │ ────────▶     │ substrate/SlotStore │
│ ReplicationManager  │ ────────▶     │ (汎用 Slot 単位)    │
│ ZoneGossipRouter    │ ───┬─────▶    │ substrate/HintBus   │
│                     │   └─────▶     │ (旧 GOSSIP は残す)  │
└─────────────────────┘               └─────────────────────┘
                                          │ uses
                                          ▼
┌─────────────────────┐               ┌─────────────────────┐
│ DandelionRouter     │ ────────▶     │ (そのまま再利用)     │
│ PeerManager         │ ────────▶     │ (そのまま再利用)     │
│ WebRTCPeer          │ ────────▶     │ (そのまま再利用)     │
│ IndexedDBStore      │ ────────▶     │ (拡張: SlotStore impl)│
│ RingPosition        │ ────────▶     │ (Bound Identity 化)  │
│ Identity            │ ────────▶     │ (そのまま再利用)     │
└─────────────────────┘               └─────────────────────┘
```

---

## 10.2 ファイル単位のマッピング

### 10.2.1 そのまま残るもの

| ファイル | 変更 |
|---|---|
| `web/src/lib/network/WebRTCPeer.ts` | なし |
| `web/src/lib/network/PeerManager.ts` | なし |
| `web/src/lib/network/RingMaintainer.ts` | なし |
| `web/src/lib/network/wire/WireCodec.ts` | フィールド名マッピング追加 |
| `web/src/lib/network/gossip/DandelionRouter.ts` | なし |
| `web/src/lib/network/stream/*` | なし |
| `web/src/lib/crypto/Identity.ts` | なし |
| `web/src/lib/crypto/CryptoEngine.ts` | なし |
| `web/src/lib/crypto/KeyManager.ts` | HKDF utility 追加 |
| `web/src/lib/crypto/MagicFilter.ts` | なし (一部 Hint で再利用) |
| `web/src/lib/crypto/PoWEngine.ts` | なし |
| `web/src/lib/common/*` | なし |
| `web/src/lib/network/SignalingClient.ts` | なし |

### 10.2.2 変更が必要なもの

| ファイル | 主な変更 |
|---|---|
| `web/src/lib/network/RingPosition.ts` | `peerId = SHA256(pubkey)`, `position = SHA256(peerId)` 化 |
| `web/src/lib/network/wire/WireTypes.ts` | `HINT`, `HINT_CATCHUP_REQ/RES`, `REPLICATION_HINT` 追加 |
| `web/src/lib/network/gossip/ZoneGossipRouter.ts` | Hint 配送ハンドラ追加 |
| `web/src/lib/storage/IndexedDBStore.ts` | `SlotStore` インターフェース実装、`Slot` 型対応 |
| `web/src/lib/network/mailbox/DHTMailbox.ts` | 段階的に `SlotStore` に置換、最終削除 |
| `web/src/lib/network/mailbox/ReplicationManager.ts` | Slot 単位に汎用化 |
| `web/src/lib/crypto/PacketBuilder.ts` | BBS 固有部分を `apps/bbs/BBSThread.ts` へ移植 |
| `web/src/lib/logic/BoardOrchestrator.ts` | `apps/bbs/BBSBoard.ts` へリネーム + Capability ベース化 |
| `web/src/lib/logic/ThreadOrchestrator.ts` | `apps/bbs/BBSThread.ts` へリネーム + Capability ベース化 |
| `web/src/lib/network/mailbox/SyncProtocol.ts` | `BundledChannel.fetchAll` に統合、削除 |
| `web/src/providers/P2PProvider.tsx` | Substrate 初期化追加 |
| `web/src/hooks/useBoard.ts`, `useThread.ts` | 新 API 呼び出しに調整 |

### 10.2.3 新規追加するもの

| ファイル | 役割 |
|---|---|
| `web/src/lib/substrate/slot/Slot.ts` | Slot 型定義 |
| `web/src/lib/substrate/slot/SlotStore.ts` | SlotStore インターフェース |
| `web/src/lib/substrate/slot/SlotValidator.ts` | 検証ロジック |
| `web/src/lib/substrate/hint/Hint.ts` | Hint 型定義 |
| `web/src/lib/substrate/hint/HintBus.ts` | Hint 配送 |
| `web/src/lib/substrate/hint/BlindTagIndex.ts` | O(1) ルックアップ |
| `web/src/lib/substrate/hint/HintBuilder.ts` | Hint 構築ヘルパー |
| `web/src/lib/substrate/capability/Capability.ts` | Capability 基底クラス |
| `web/src/lib/substrate/capability/KeyDerivation.ts` | HKDF ユーティリティ |
| `web/src/lib/substrate/SubstrateContext.ts` | DI コンテナ |
| `web/src/lib/substrate/crypto/Aead.ts` | seal()/open() 封印ラッパー（4.1.4） |
| `web/src/lib/caps/Log.ts` | 不変アイテム列（BBS/DM/グループ/pub-sub） |
| `web/src/lib/caps/OwnedPointer.ts` | 単一所有者の可変指標 |
| `web/src/lib/caps/ChunkSet.ts` | 大 blob 保存 |
| `web/src/lib/apps/bbs/BBSBoard.ts` | BBS Board |
| `web/src/lib/apps/bbs/BBSThread.ts` | BBS Thread |

---

## 10.3 段階移行戦略 (互換性維持)

### 10.3.1 Phase 1: 最小防御 (3 日)

**目的**: 既存アーキテクチャを変えず、致命的脆弱性だけ塞ぐ。

**変更**:
- `RingPosition.ts`: Bound Identity 化
- `DHTMailbox.handlePut`: PoW + 帰属検証追加
- `DHTMailbox.handleRes`: CHK 自己検証追加

**互換性**: 100%。プロトコル変更なし。古い実装を持つピアとも通信可能。

**コード例**:

```typescript
// web/src/lib/network/RingPosition.ts (改修)
import { sha256 } from '../crypto/hash'

export class RingPosition {
  private _value: number

  constructor(peerId: string | Uint8Array) {
    // 旧: 乱数 or localStorage
    // 新: peerId から決定論的に派生
    const peerIdBytes = typeof peerId === 'string' ? hexToBytes(peerId) : peerId
    const posBytes = sha256_sync(peerIdBytes)  // 同期版を用意
    const u32 = (posBytes[0] << 24) | (posBytes[1] << 16) | (posBytes[2] << 8) | posBytes[3]
    this._value = (u32 >>> 0) / 4294967296.0
  }

  static fromPubkey(pubkey: Uint8Array): RingPosition {
    const peerId = sha256_sync(pubkey)
    return new RingPosition(peerId)
  }

  // (距離計算は変更なし)
}
```

```typescript
// web/src/lib/network/mailbox/DHTMailbox.ts (handlePut 改修)
private async handlePut(senderId: PeerId, msg: any) {
  // 既存処理の前に検証を追加
  
  // 1. K-nearest 帰属検証
  const topicPos = this.hashToPosition(msg.topicHash)
  const nearest = this.findKNearest(topicPos, K_NEAREST)
  if (!nearest.includes(this.peerManager.myPeerId)) {
    console.warn(`[DHTMailbox] handlePut rejected: not K-nearest`)
    return
  }
  
  // 2. PoW + CHK 検証 (各 entry について)
  for (const entry of msg.entries) {
    if (!await PacketValidator.validate(decodePacket(entry))) {
      console.warn(`[DHTMailbox] handlePut rejected: invalid entry`)
      return
    }
  }
  
  // 3. 既存処理
  this.store.put(msg.topicHash, msg.entries).catch(e => console.error(e))
}
```

### 10.3.2 Phase 2: Slot プリミティブ導入 (1 週間)

**目的**: Substrate Layer 2 (Slot) を実装。既存 BBS は引き続き旧プロトコル。

**変更**:
- `substrate/slot/*` 新規追加
- `SlotStore` インターフェース、`IndexedDBStore` で実装
- `SLOT_PUT/GET/RES` WireType を有効化 (`0x50-0x52` を Slot 用に切り替え)
- 既存 `DHTMailbox` は旧 wire 経由でしばらく動き続ける

**互換性**: 新旧ピアが並列稼働。新ピア同士は SLOT_* を、旧ピア相手では DHT_* を使う。

**実装ステップ**:
1. `Slot`, `SlotKey` 型定義
2. `SlotValidator` 実装 + 単体テスト
3. `IndexedDBStore` に `ISlotStore` 実装メソッド追加 (`putSlot`, `getSlot` 等)
4. `SlotStore` wrapper クラス (WireCodec とつなぐ)
5. dispatcher で SLOT_* を `SlotStore.handleNet` にルーティング

### 10.3.3 Phase 3: BBS を Log へ移行 (1 週間)

**目的**: 既存 BBS を新 Capability で書き直す。旧データの読み出し互換は維持。

**変更**:
- `caps/Log.ts`, `caps/OwnedPointer.ts` 実装
- `apps/bbs/BBSBoard.ts`, `apps/bbs/BBSThread.ts` 新規
- 旧 `BoardOrchestrator`/`ThreadOrchestrator` を deprecate
- UI フック (`useBoard`, `useThread`) を新 API へ向ける
- 旧 BBS データは「読み込みのみ」サポート、新規投稿は新形式

**互換性**:
- 新ピア間: 新形式で完結
- 新→旧: 旧形式で送信フォールバック
- 旧→新: 旧形式を読み込み (legacy decoder)

### 10.3.4 Phase 4: Hint 配信導入 (1 週間)

**目的**: Log のライブ配信 (DM / BBS 新着) に Hint を導入。

**変更**:
- `substrate/hint/*` 全部新規
- `ZoneGossipRouter` に Hint 配送統合
- `Log` のライブ通知を Hint で送る
- (オプション) BBS UI で「DM 試験機能」を追加

**互換性**:
- 新ピア間: Hint で更新通知
- 旧ピア混在: Hint を中継してくれるが復号できない (OK、自然に dedup される)

### 10.3.5 Phase 5: 旧プロトコル削除 (3-5 日)

**目的**: 旧 GOSSIP / DHT_* を完全に廃止。

**条件**:
- 全ユーザーが新版にアップグレードしてから 30 日経過
- アクセスログで旧 wire 利用が 0 になったことを確認

**変更**:
- `DHTMailbox`, `SyncProtocol`, `BoardOrchestrator`, `ThreadOrchestrator`, `PacketBuilder` (BBS 固有部分) を削除
- `WireType.GOSSIP` を `UNKNOWN` 扱いに

---

## 10.4 データ互換性

### 10.4.1 IndexedDB スキーマ

旧スキーマ:
```
- mailbox: { topicHash, entries: Uint8Array[], lastUpdated }
- posts:   { boardId, threadId, payload, dag }
- threads: { threadId, boardId, max_pow, created_at }
- identity: { pubkey, privkey }
```

新スキーマ:
```
- slots:   { key: SlotKey (PK), payload, payload_hash, ..., version }
            (互換: 旧 mailbox は読み込みのみ、新規は slots へ)
- posts:   (BBS 固有、現状維持)
- threads: (BBS 固有、現状維持)
- identity: (現状維持)
- capabilities: { id (PK), root_secret, type, metadata, created_at }
                (新規。ローカル管理用)
```

マイグレーション:
- 起動時に旧 `mailbox` を読み込み → `slots` テーブルへ変換 (1 回限り)
- 旧 `posts`/`threads` はそのまま継続利用 (BBS application)
- `capabilities` テーブルは新規作成

### 10.4.2 鍵の継承

既存ユーザーの `board_key` / `thread_id` は維持。Capability への変換は決定論:

```typescript
// 既存 board key → Substrate Capability
const board_secret = hkdf(legacy_board_key, "bbs_board_meta_v1", 32)
const board_cap = new Capability(board_secret)
```

### 10.4.3 Identity 継承

`Identity` (Ed25519 鍵ペア) はそのまま継続利用。`peerId` の計算式だけ変更:

旧:
```typescript
peerId = randomB64()  // 起動時生成、localStorage 保存
```

新:
```typescript
peerId = bytesToHex(await sha256(identity.publicKey))
position = positionFromBytes(await sha256(hexToBytes(peerId)))
```

→ ユーザーの Identity (鍵) は維持、peerId/position は新規計算 (localStorage の古い値は無視)。

---

## 10.5 マイグレーション期のリスク

### 10.5.1 互換性ウィンドウ

Phase 2-4 の期間 (約 3 週間) は新旧プロトコルが混在する。リスク:

| リスク | 緩和策 |
|---|---|
| 新ピアと旧ピアで分断 | wire type で版判別、両方サポート |
| データ不整合 | Slot version monotonic で last-write-wins |
| パフォーマンス劣化 | 両方の codec を載せる → メモリ使用 +1MB 程度 |

### 10.5.2 ロールバック戦略

各 Phase で問題が出たら、その Phase をロールバック可能にする:

- Phase 1: 検証ロジックを feature flag で off
- Phase 2: SLOT_* を WireType.UNKNOWN として無視
- Phase 3: 新 BBS UI を旧 UI に切り替え
- Phase 4: HintBus を disable

### 10.5.3 監視指標

各 Phase で監視すべき指標:

| 指標 | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 |
|---|---|---|---|---|---|
| BBS post 成功率 | ✓ | ✓ | ✓ | ✓ | ✓ |
| BBS read レイテンシ p99 | ✓ | ✓ | ✓ | ✓ | ✓ |
| handlePut reject 率 | ✓ | ✓ | ✓ | ✓ | ✓ |
| Slot validation 失敗率 |  | ✓ | ✓ | ✓ | ✓ |
| 旧 wire 使用率 |  | ✓ | ✓ | ✓ | ✓ |
| Log 過去ログ並列 GET 本数 |  |  | ✓ | ✓ | ✓ |
| Hint 配信成功率 |  |  |  | ✓ | ✓ |

---

## 10.6 テスト戦略

### 10.6.1 単体テスト

各 Phase で追加:

| Phase | テスト対象 |
|---|---|
| 1 | `RingPosition.fromPubkey`, `handlePut` 検証 |
| 2 | `SlotValidator` 全条件、`SlotStore` put/get |
| 3 | `Log` publish/fetchHistory/subscribe、IMMUTABLE 競合（claim） |
| 4 | `HintBus` subscribe/broadcast、`BlindTagIndex` ルックアップ |
| 5 | 旧コード削除に伴う既存テスト調整 |

### 10.6.2 統合テスト

`simulation/` の multi-node シミュレーションで:

- N=10 ノードでの BBS post-read レイテンシ
- 1 ノードを攻撃者として K-nearest 制圧シミュレーション
- 新旧版混在ネットワークでの相互通信

### 10.6.3 ブラウザ E2E テスト

- 既存 Playwright テストを Substrate v2 で再実行
- BBS UI 操作 (投稿、スレ閲覧、新規スレ作成) が全部成功
- DM UI 試験 (Phase 4)

---

## 10.7 ドキュメント追従

各 Phase で更新するドキュメント:

| ドキュメント | 更新タイミング |
|---|---|
| `docs/aether_web_lite_design.md` | Phase 3 完了時に Substrate 概要を追記 |
| `docs/architecture_audit.md` | Phase 1 完了で旧脆弱性を「解決済み」マーク |
| `docs/spec/step4_encryption.md` | Phase 2 で Slot 暗号化を追記 |
| `docs/implementation_guide.md` | 各 Phase で新 API ガイドを追記 |
| `web/CLAUDE.md` (もしあれば) | 全 Phase 通して新規パターンを記録 |

---

## 10.8 次に読む

→ [11_roadmap.md](./11_roadmap.md): 詳細なスケジュールと優先度
→ [12_open_questions.md](./12_open_questions.md): 未決事項
