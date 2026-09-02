# Part 7: Wire Protocol — バイナリプロトコル仕様

ネットワーク上を流れるパケットの正確なバイト構造を定義する。

---

## 7.1 全体方針

### 7.1.1 既存 Wire V2 を継承

aether-web-lite は既に **Wire V2 (MsgPack ベースのバイナリプロトコル)** を実装している。Substrate v2 はこれを継承し、新規 WireType を追加する形で拡張する。

参考: `web/src/lib/network/wire/WireCodec.ts`, `web/src/lib/network/wire/WireTypes.ts`

### 7.1.2 共通フレーム構造

全ピア間通信は以下のフレームで送受信される:

```
+--------+-----------------+
| Type   | Payload (MsgPack) |
| 1 byte | variable          |
+--------+-----------------+
```

- `Type`: 1 byte WireType
- `Payload`: MsgPack エンコードされた Type 固有の構造

WebRTC DataChannel の上に、必要に応じて `ChunkedSender` (4KB チャンク、WS-3) でラップする。

### 7.1.3 Magic Byte 域

| 範囲 | 用途 |
|---|---|
| `0x00` | ChunkedSender Magic (フレーム外。WS-3) |
| `0x10-0x1F` | Control (JOIN, PING, etc.) |
| `0x20-0x2F` | PEX |
| `0x30-0x3F` | Signaling Relay |
| `0x40-0x4F` | Gossip + Hint |
| `0x50-0x5F` | Slot Store (旧 DHT) |
| `0x60-0xFE` | (予約) |
| `0xFF` | UNKNOWN |

---

## 7.2 WireType 定義 (v2)

```typescript
// web/src/lib/network/wire/WireTypes.ts

export enum WireType {
  // ── Control (0x1x) ── 既存
  JOIN           = 0x10,
  RING_INFO      = 0x11,
  PING           = 0x12,
  PONG           = 0x13,
  LOCAL_LINK_REQ = 0x14,
  LOCAL_LINK_ACK = 0x15,
  LOCAL_LINK_REJ = 0x16,

  // ── PEX (0x2x) ── 既存
  PEX_REQUEST    = 0x20,
  PEX_RESPONSE   = 0x21,

  // ── Signaling Relay (0x3x) ── 既存
  SDP_RELAY      = 0x30,
  ICE_RELAY      = 0x31,

  // ── Gossip + Hint (0x4x) ──
  GOSSIP         = 0x40,  // 既存. (将来 deprecate 候補)
  STEM           = 0x41,  // 既存. Dandelion stem。Hint も載せる
  HINT           = 0x42,  // 🆕 Substrate Hint (Dandelion 経由)
  HINT_CATCHUP_REQ = 0x43,  // 🆕 Hint catchup 要求
  HINT_CATCHUP_RES = 0x44,  // 🆕 Hint catchup 応答

  // ── Slot Store (0x5x) ──
  SLOT_PUT       = 0x50,  // 旧 DHT_PUT を改名・構造変更
  SLOT_GET       = 0x51,  // 旧 DHT_GET 同様
  SLOT_RES       = 0x52,  // 旧 DHT_RES 構造変更
  REPLICATION_HINT = 0x53,  // 🆕 ピア間レプリケーション通知

  UNKNOWN        = 0xFF
}
```

---

## 7.3 各メッセージのペイロード仕様

### 7.3.1 SLOT_PUT (0x50)

**送信方向**: クライアント → K-nearest ピア

**ペイロード**:
```typescript
interface SlotPutPayload {
  slot: Slot
}
// MsgPack エンコード
```

`Slot` 構造 (再掲、MsgPack マップ。v2.1 で `slot_class` 追加):
```
{
  key:           bin 32,
  slot_class:    uint8,           // 0x01=IMMUTABLE, 0x02=OWNED_POINTER
  payload:       bin <variable>,  // = nonce(12) || ciphertext+tag（封印形式 4.1.4）
  payload_hash:  bin 32,          // SHA256(payload)、nonce 込みを覆う
  pow_proof:     bin 8,
  expires_at:    uint64,
  created_at:    uint64,
  version:       uint32,          // IMMUTABLE は 0 固定
  writer_pubkey: bin 32 (optional),  // OWNED_POINTER は必須
  writer_sig:    bin 64 (optional)   // OWNED_POINTER は必須
}
```

**PoW / 署名の入力** は [04_layer2_primitives.md](./04_layer2_primitives.md) 4.1.6 の `powBase` / `authBytes` 定義に従う（`slot_class, key, payload_hash, version, expires_at, created_at` を束縛 → TTL/version 改竄を弾く）。

**受信側の処理**:
1. デコード
2. `SlotValidator.validateForStore(slot, ctx)` で検証（self-contained + 帰属 + 既存関係）
3. 検証 OK なら `store.put(slot)`、失敗ならドロップ
4. 応答は送り返さない (fire-and-forget)

### 7.3.2 SLOT_GET (0x51)

**送信方向**: クライアント → K-nearest ピア

**ペイロード**:
```typescript
interface SlotGetPayload {
  key: Uint8Array      // 32 bytes
  req_id: bigint       // u64. 応答との対応付け
}
```

**受信側の処理**:
1. デコード
2. `store.get(payload.key)` でローカル取得
3. `SLOT_RES` を送信元に返す (slot 有無 + req_id 同梱)

### 7.3.3 SLOT_RES (0x52)

**送信方向**: K-nearest → クライアント (SLOT_GET への応答)

**ペイロード**:
```typescript
interface SlotResPayload {
  req_id: bigint
  slot: Slot | null   // 存在しない場合 null
}
```

**受信側の処理 (C2 対策)**:
1. `pendingRequests.get(req_id)` で待ち callback 取得
2. slot があれば **`SlotValidator.validateSelfContained` を完全実行**（CHK + PoW + class + 署名）。送信元（隣接ピア）を信頼しない
3. 検証通過した slot のみ callback へ
4. K-nearest 全員から応答 or タイムアウトで finalize。**version で順位付けするのは署名検証済み OWNED_POINTER のみ**（署名未検証 version を信用すると悪意ノード 1 台に結果を乗っ取られる）

### 7.3.4 HINT (0x42)

**送信方向**: 全方向 (Dandelion stem → fluff)

**ペイロード**:
```typescript
interface HintPayload {
  version:    number          // u8
  blind_tag:  Uint8Array      // 4 bytes
  nonce:      Uint8Array      // 12 bytes
  ciphertext: Uint8Array      // variable
  pow_proof:  Uint8Array      // 8 bytes
  time_bucket: number         // u32
}
```

**MsgPack エンコード例**:
```
{
  v: 1,
  bt: bin 4,
  n: bin 12,
  ct: bin <variable>,
  pp: bin 8,
  tb: uint32
}
```

短いフィールド名で 1 hint あたり ~100 bytes に収める。

**受信側の処理** (詳細は 04_layer2_primitives.md):
1. `seenHints` で重複チェック
2. PoW 検証
3. time_bucket 妥当性
4. BlindTagIndex で O(1) ルックアップ
5. マッチした Capability で AEAD 復号
6. 復号成功 → handler 呼び出し
7. 中継 (送信元以外の全ピアへ flood)

### 7.3.5 STEM (0x41) ・ Hint 配送モード

既存 `STEM` パケットを Hint 配送にも流用する。`zoneId: 0` (zone 非依存) として送信:

```typescript
interface StemHintPayload {
  type: 'stem-hint'           // 新規。既存の 'stem' と区別
  zoneId: 0                   // 固定
  hint: HintPayload           // 内包
}
```

Dandelion 側で stem-hint を判別して、Fluff 時に `WireType.HINT` で送り直す。

### 7.3.6 HINT_CATCHUP_REQ (0x43)

**送信方向**: クライアント → 隣接ピア (再接続時など)

**ペイロード**:
```typescript
interface HintCatchupReqPayload {
  /** 自分が知っている最後の time_bucket. これより新しい hints を要求 */
  since_bucket: number
  /** 最大返す件数 */
  max_count: number
  /** リクエスト ID */
  req_id: bigint
}
```

### 7.3.7 HINT_CATCHUP_RES (0x44)

**送信方向**: 隣接ピア → クライアント

**ペイロード**:
```typescript
interface HintCatchupResPayload {
  req_id: bigint
  hints: HintPayload[]
}
```

**実装上の注意**:
- 各ピアは `LRU<hint_id, Hint>` で直近 N=10000 件の Hint をキャッシュ
- catchup レスポンスは PoW 検証済み Hint のみ
- スパム防止: 同一ピアからの catchup_req は 1 分に 1 回まで

### 7.3.8 REPLICATION_HINT (0x53)

**送信方向**: ピア → 新規 K-nearest

トポロジ変化時に、自分が持つ slot を「あなたも担当に入りました」と通知:

```typescript
interface ReplicationHintPayload {
  slot_keys: Uint8Array[]  // 自分が持つ K-nearest 圏内 slot 鍵
}
```

受信側は知らない slot_key について `SLOT_GET` を発行して取得。

---

## 7.4 既存メッセージとの互換性

### 7.4.1 GOSSIP (0x40) は当面残す

Phase 1-3 では既存 BBS が `GOSSIP` を使い続ける。Phase 4 で `Log`（Hint + IMMUTABLE slot）経由に移行後、 `GOSSIP` は不要になるが、後方互換のため残す。

**移行**: GOSSIP 受信時に新コードはエラーなく無視するか、レガシーチャネルとして処理する。

### 7.4.2 旧 DHT_PUT/GET/RES → SLOT_*

- Wire code は同じ (0x50/0x51/0x52) を使い続ける
- ペイロード構造を変更
- `DHTMailbox` を `SlotStore` に置き換え

**互換性**: Phase 2 移行期は旧 `DHTMailbox` 形式と新 `Slot` 形式を判別:

```typescript
// 受信時に try-decode
private handleSlotPut(sender: PeerId, msg: any) {
  if (isLegacyDhtPut(msg)) {
    return this.legacyDhtHandler.handlePut(sender, msg)
  }
  return this.slotStoreV2.put(msg.slot)
}
```

Phase 3 完了後にレガシー対応を削除。

---

## 7.5 MsgPack エンコード規約

### 7.5.1 短いフィールド名

ペイロードは MsgPack マップ。サイズ削減のため**短いキー名**を使う:

| Long | Short |
|---|---|
| `version` | `v` |
| `blind_tag` | `bt` |
| `nonce` | `n` |
| `ciphertext` | `ct` |
| `pow_proof` | `pp` |
| `time_bucket` | `tb` |
| `key` | `k` |
| `payload` | `p` |
| `payload_hash` | `ph` |
| `expires_at` | `ea` |
| `writer_pubkey` | `wp` |
| `writer_sig` | `ws` |
| `created_at` | `ca` |
| `req_id` | `rid` |

WireCodec で encode/decode 時にマッピング:

```typescript
const SLOT_FIELD_MAP = {
  k: 'key', cl: 'slot_class', p: 'payload', ph: 'payload_hash',
  pp: 'pow_proof', ea: 'expires_at', ca: 'created_at', v: 'version',
  wp: 'writer_pubkey', ws: 'writer_sig',
}
```

### 7.5.2 大きな整数の扱い

JavaScript の `number` は 53bit 限界なので、`u64` (expires_at, created_at, req_id, sent_at 等) は `bigint` で扱う。MsgPack は `int 64` をサポートする実装 (`@msgpack/msgpack` の `useBigInt64: true`) を使う。

### 7.5.3 バイナリ vs 文字列

- `Uint8Array` (bin) を使う。`hex` 文字列にしない (Wire V2 の原則)
- Capability URI 等の export 形式でのみ `base64url` 文字列化

---

## 7.6 暗号原始の確定

### 7.6.1 ハッシュ

- `SHA-256`: Slot/Hint の hash 検証、PoW、HMAC ベース
- `SHA-512`: 互換性のため Identity で利用 (Ed25519 内部)

### 7.6.2 AEAD

- `ChaCha20-Poly1305`: 全暗号化用途 (Slot payload、Hint ciphertext)
- nonce: 12 bytes ランダム

実装: `libsodium-wrappers` の `crypto_aead_chacha20poly1305_ietf_encrypt/decrypt`

### 7.6.3 鍵派生

- `HKDF-SHA256`: Capability の派生鍵
- info string: `"aether_<purpose>_v1"`

### 7.6.4 署名

- `Ed25519`: writer_sig、Identity 署名
- 実装: `libsodium-wrappers` の `crypto_sign_detached/verify_detached`

### 7.6.5 鍵交換 (DM 用)

- `X25519`: ECDH
- 実装: `libsodium-wrappers` の `crypto_scalarmult`

---

## 7.7 PoW スキーム

### 7.7.1 計算

```typescript
async function computePoW(
  base: Uint8Array,
  difficulty_bits: number,
  proof_size: number = 8,
): Promise<Uint8Array> {
  let counter = 0n
  while (true) {
    const proof = u64ToBytes(counter)
    const hash = await sha256(concat(base, proof))
    if (leadingZeros(hash) >= difficulty_bits) {
      return proof.slice(0, proof_size)
    }
    counter++
  }
}

function leadingZeros(hash: Uint8Array): number {
  let zeros = 0
  for (const byte of hash) {
    if (byte === 0) { zeros += 8; continue }
    zeros += Math.clz32(byte) - 24
    break
  }
  return zeros
}
```

### 7.7.2 検証

```typescript
async function verifyPow(
  base: Uint8Array,
  proof: Uint8Array,
  difficulty_bits: number,
): Promise<boolean> {
  const hash = await sha256(concat(base, proof))
  return leadingZeros(hash) >= difficulty_bits
}
```

### 7.7.3 動的難易度

既存 `DifficultyEstimator` を再利用:

```typescript
// 直近 N 件の post 間隔から自動調整
const SLOT_POW_DIFFICULTY = DifficultyEstimator.compute(recent_post_timestamps, WINDOW=128)
```

- Slot PoW: `max(SLOT_POW_DIFFICULTY, MIN_POW_DIFFICULTY=20)`
- Hint PoW: `max(SLOT_POW_DIFFICULTY - 2, MIN_HINT_POW_DIFFICULTY=18)`（旧 -4/12 は低すぎた。H2）
- ChunkSet / バンドル PoW: `max(SLOT_POW_DIFFICULTY - 2, MIN_BUNDLE_POW_DIFFICULTY=18)`（大量だが集約済み）
- Identity PoW: 固定 20 bits 程度（起動時のみ、Sybil 抑制。[12](./12_open_questions.md) Q10）

> **フロアの根拠 (H2)**: 旧 16/12-bit は WASM/native 攻撃者には数〜十数 ms で、スパム・標的 LRU eviction・Hint flood 増幅を許した。検証も同一 WASM 実装で行い、`leadingZeros` ベースの difficulty を動的に押し上げる。

---

## 7.8 Frame Size と Chunking

### 7.8.1 サイズ予測

| メッセージ | 典型サイズ |
|---|---|
| Hint | 100 bytes |
| SLOT_GET | 50 bytes |
| SLOT_RES (空) | 30 bytes |
| SLOT_RES (1KB Slot) | 1.1 KB |
| SLOT_RES (64KB Slot) | 64.2 KB |
| SLOT_PUT (1KB) | 1.1 KB |
| SLOT_PUT (64KB) | 64.2 KB |
| HINT_CATCHUP_RES (100 hints) | ~10 KB |

### 7.8.2 WebRTC DataChannel と Chunking

WebRTC DataChannel の MTU は典型 16KB だが、4KB 以上は不安定なことがある。既存 `ChunkedSender` (WS-3) で wrap:

- 4KB 以下: 直接送信
- 4KB 超: ChunkedSender でフラグメント化

`SlotPutPayload` で 64KB の slot を送る場合は ChunkedSender 経由になる。

---

## 7.9 受信時の検証順序 (まとめ)

すべての受信メッセージに対する標準検証:

```typescript
function onMessage(sender_id: PeerId, type: WireType, raw: Uint8Array) {
  // 1. ChunkedReceiver でデフラグメント (必要なら)
  const buf = chunkedReceiver.process(raw)
  if (!buf) return  // まだ完成してない

  // 2. WireType デコード
  if (buf[0] !== type) return  // 型不一致

  // 3. MsgPack デコード
  let msg
  try { msg = decodeMsgPack(buf.slice(1)) }
  catch { return }

  // 4. 型ごとの検証 + 処理
  switch (type) {
    case WireType.SLOT_PUT:    return handleSlotPut(sender_id, msg)
    case WireType.SLOT_GET:    return handleSlotGet(sender_id, msg)
    case WireType.SLOT_RES:    return handleSlotRes(sender_id, msg)
    case WireType.HINT:        return handleHint(sender_id, msg)
    // ...
  }
}
```

### 7.9.1 SLOT_PUT 検証フロー (詳細)

```typescript
async function handleSlotPut(sender: PeerId, msg: SlotPutPayload) {
  // 1. 構造検証
  if (!isValidSlotShape(msg.slot)) return

  // 2. SlotValidator (self-contained + 帰属 + 既存関係)
  const ctx = { peer_manager, store, required_pow_difficulty: SLOT_POW_DIFFICULTY }
  const result = await SlotValidator.validateForStore(msg.slot, ctx)
  if (!result.ok) {
    log.warn(`SLOT_PUT rejected: ${result.reason} from ${sender}`)
    return
  }

  // 3. ストレージクォータ（PoW 重み付け or ランダム eviction で標的 eviction を防ぐ。H2）
  const used = await store.getUsedBytes()
  if (used + msg.slot.payload.byteLength > MAX_STORAGE_BYTES) {
    await store.evictWeighted(used + msg.slot.payload.byteLength - MAX_STORAGE_BYTES)
  }

  // 4. 保存（idempotent な immutable 再 PUT も OK）
  await store.put(msg.slot)
}
```

### 7.9.2 SLOT_RES 検証フロー (詳細)

```typescript
async function handleSlotRes(sender: PeerId, msg: SlotResPayload) {
  // 1. pending request 確認
  const pending = pendingRequests.get(msg.req_id)
  if (!pending) return  // 既にタイムアウト or 別ピアの req_id

  // 2. slot null なら「持ってない」応答
  if (!msg.slot) { pending.onResponse(null); return }

  // 3. ★ full self-contained validate（送信元を信頼しない。C2）
  //    CHK + PoW + class 規約 + 署名（OWNED_POINTER は署名必須、writer/sig 片方だけは拒否）
  if (!isValidSlotShape(msg.slot)) return
  const r = await SlotValidator.validateSelfContained(msg.slot, selfCtx)
  if (!r.ok) { log.warn(`SLOT_RES rejected: ${r.reason}`); return }

  // 4. callback（version 順位付けは呼び出し側で署名検証済み OWNED_POINTER のみ対象）
  pending.onResponse(msg.slot)
}
```

---

## 7.10 セキュリティ上の留意点

### 7.10.1 リソース消費攻撃

| 攻撃 | 対策 |
|---|---|
| 巨大 payload を詰める | `MAX_PAYLOAD_SIZE` 制限 |
| 大量 Hint で Gossip 飽和 | PoW + seen キャッシュ + zone-aware flood |
| 大量 SLOT_PUT で帯域消費 | PoW 必須化 |
| 偽 req_id で SLOT_RES スパム | pendingRequests に存在しない req_id を無視 |

### 7.10.2 タイミング攻撃

- `pendingRequests.get()` は定数時間ではないが、攻撃には使えないレベル
- AEAD 復号失敗を秘密保持 (`return null`、エラー伝播しない)

### 7.10.3 サイドチャネル

- HintBus 復号にかかる時間で「自分宛てか」を観測されるリスク
- 対策: 全 candidates について常に復号試行 (false positive 込み)、`Math.max(time, MIN_DECRYPT_TIME)` で正規化

---

## 7.11 マイグレーション戦略

### 7.11.1 Phase 1: 既存 wire のまま検証強化

- WireType 変更なし
- `DHTMailbox.handlePut/handleRes` に検証追加のみ
- 旧プロトコルとの互換性 100%

### 7.11.2 Phase 2: 新 SLOT_* 投入

- 旧 DHT_* と新 SLOT_* を判別
- 新規データは新形式で書き込み
- 既存データは旧形式で読み出し (一定期間)

### 7.11.3 Phase 3: HINT 投入

- 新 WireType `HINT (0x42)` 追加
- 既存 GOSSIP は維持
- Log がライブ通知に HINT を使い始める

### 7.11.4 Phase 4: 旧プロトコル deprecate

- 既存 GOSSIP / DHT_* を読み込みのみサポートに格下げ
- 新規書き込みは全部新プロトコル

### 7.11.5 Phase 5: 旧プロトコル削除

- 一定期間後、レガシーコード削除

---

## 7.12 次に読む

→ [08_performance.md](./08_performance.md): 各メッセージのレイテンシ予測
→ [10_migration.md](./10_migration.md): 移行計画の詳細
