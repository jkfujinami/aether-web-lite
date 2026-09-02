# Part 5: Layer 3 Capabilities — 高レベル抽象

Layer 3 は **Slot と Hint を組み合わせて application で使う構造を作る**層。

> **v2.1 改訂 (2026-06-10)**: 旧 `BundledChannel`（1 slot に全 entry を上書き蓄積）は **廃止**。理由は [04_layer2_primitives.md](./04_layer2_primitives.md) v2.1 改訂ノート参照（中身を見ない保管ノードは多人数共有 blob の追記を検証できず、かつ 64KB 制限で ~130 投稿しか入らなかった）。代わりに 3 つのプリミティブで再構成する。

| Capability | 主用途 | 基盤 Slot クラス | Hint |
|---|---|---|---|
| `OwnedPointer` | 最新版指標（head, manifest, member list） | OWNED_POINTER（単一所有者・可変） | 不要 |
| `Log` | BBS / DM / グループ / pub-sub（多人数 or 1:1 の追記列） | IMMUTABLE（write-once）+ バンドル | ライブ通知に使用 |
| `ChunkSet` | ファイル / 大きな blob | IMMUTABLE | 不要 |

**設計の背骨**:
- **可変なのは `OwnedPointer` だけ**。単一署名者が所有するので安全。
- **多人数 / 並行で書くものは全部 `Log`**＝不変アイテム群の集合。上書き競合が原理的に起きない。
- `Log` は「何も上書きしない発見・収集の抽象」。DM（1:1）も BBS（1:N）も同じコード、違いは cap の共有範囲と署名有無だけ。

---

## 5.1 OwnedPointer — 単一所有者の可変参照

### 5.1.1 コンセプト

> 「特定 pubkey だけが署名で更新できる固定 slot。最新の target slot_key（や任意 metadata）を指す。Freenet SSK / IPNS 相当。可変ロジックはここに隔離される。」

用途: `Log` の最新バンドル指標、ファイルの current manifest、グループの member list 指標。

### 5.1.2 設計

- Slot クラス: **OWNED_POINTER**（4.1.2）
- Slot 鍵: **Mode A** `deriveSlotKey("ptr_v1_" + label)`
- 可変: 所有者の writer_sig + version 単調増加（SlotValidator が強制）

```typescript
interface PointerPayload {
  target_slot_key?: Uint8Array   // 32 bytes（指す先。無くてもよい）
  metadata?: Uint8Array          // application data
  signed_at: bigint
}
```

### 5.1.3 API

```typescript
// web/src/lib/caps/OwnedPointer.ts

export class OwnedPointer {
  private slotKey: SlotKey
  constructor(
    private cap: Capability,
    private owner_pubkey: Uint8Array,   // 期待される唯一の writer
    private store: ISlotStore,
    private label: string = "default",
  ) {
    this.slotKey = cap.deriveSlotKey("ptr_v1_" + label)
  }

  /** 更新（所有者のみ） */
  async update(target: SlotKey | undefined, new_version: number,
               metadata: Uint8Array | undefined, signer: IIdentity): Promise<void> {
    if (!arrayEquals(signer.publicKey, this.owner_pubkey)) throw new Error("not the owner")

    const plain = encodeMsgPack({ target_slot_key: target, metadata, signed_at: BigInt(Date.now()) })
    const payload = seal(this.cap.payloadKey, plain)        // nonce 込み封印（4.1.4）
    const payload_hash = await sha256(payload)
    const expires_at = BigInt(Date.now()) + POINTER_TTL_MS
    const created_at = BigInt(Date.now())

    const slot: Slot = {
      key: this.slotKey, slot_class: SlotClass.OWNED_POINTER,
      payload, payload_hash, version: new_version, expires_at, created_at,
      pow_proof: await computeSlotPoW({ slot_class: SlotClass.OWNED_POINTER, key: this.slotKey,
                                        payload_hash, version: new_version, expires_at, created_at }),
      writer_pubkey: signer.publicKey,
      writer_sig: signer.signRaw(authBytesOf({ slot_class: SlotClass.OWNED_POINTER, key: this.slotKey,
                                               payload_hash, version: new_version, expires_at, created_at })),
    }
    const r = await this.store.put(slot)
    if (!r.ok) throw new Error(`pointer update failed: ${r.reason}`)  // stale_version 等
  }

  /** 解決（★ 署名検証は SlotStore.get / validateSelfContained が実施済み。
      ここでは owner 一致のみ追加確認。C2 対策で署名未検証 slot は get が弾く） */
  async resolve(): Promise<PointerPayload | null> {
    const slot = await this.store.get(this.slotKey)
    if (!slot) return null
    if (slot.slot_class !== SlotClass.OWNED_POINTER) return null
    if (!slot.writer_pubkey || !arrayEquals(slot.writer_pubkey, this.owner_pubkey)) return null
    const plain = open(this.cap.payloadKey, slot.payload)
    return plain ? decodeMsgPack(plain) : null
  }
}
```

> **C2 修正の要点**: 旧 `MutablePointer.resolve` は writer_pubkey の等値比較だけで署名を検証していなかった。新仕様では **`store.get` 経由のすべての Slot が `validateSelfContained`（CHK+PoW+署名）を通過済み**（4.1.12）。resolve は owner 一致を確認するだけでよく、偽署名の pointer は get 段階で排除される。

### 5.1.4 性能

| 操作 | コスト |
|---|---|
| update | 1 PUT（~125ms） |
| resolve | 1 GET（~250ms） |

---

## 5.2 Log — 不変アイテムの追記列（BBS / DM / グループ / pub-sub）

### 5.2.1 コンセプト

> 「共有 cap（1:N）or 2 者 cap（1:1）に属する、不変 (IMMUTABLE) アイテムの集合。各アイテムは独立スロットで write-once。発見はライブ＝Hint、過去ログ＝バンドル + gossip union。何も上書きしない。」

これが旧 `BundledChannel` と `HintedInbox` を **1 本に統合**したもの。

### 5.2.2 なぜこの形か（C1 の根治）

- 投稿 = 独立 IMMUTABLE スロット（ランダム鍵 Mode B）。**鍵が衝突しないので、多人数が同時に書いても上書き競合・データ消失が起きない**（旧 C1）。
- 各アイテムは自己検証（CHK + PoW + 任意の writer 署名）。**偽造は不能**。
- 「過去ログの完全性」は P2P 匿名 BBS では原理的に保証不能（旧 BundledChannel も truncate 上書きで偽れた）。本設計は **gossip 収束（union）** を現実的なゴールとし、それを明示する。

### 5.2.3 アイテムと発見の二層モデル

```
  ライブ層（オンライン中）         過去ログ層（コールド参加）
  ┌────────────────────┐         ┌──────────────────────────┐
  │ publish:            │         │ bundle = IMMUTABLE slot  │
  │  1 IMMUTABLE slot   │         │  payload = [item_key...] │
  │  + Hint(cap)        │ ──────▶ │  誰でも作れる/検証可能   │
  │ subscribe:          │         │  省略は可能だが偽造不能  │
  │  Hint → GET → verify│         │  複数 provider の union  │
  └────────────────────┘         └──────────────────────────┘
```

- **ライブ**: `publish` は 1 個の IMMUTABLE スロットを PUT し、`cap` 宛 Hint を broadcast。購読者は Hint→GET→検証で即時受信。
- **過去ログ**: 任意のピアが「seq 範囲 N..M のアイテム鍵リスト」を 1 個の IMMUTABLE **バンドルスロット**にまとめて公開（Mode A 決定論鍵 `deriveSlotKey("log_bundle_v1_" + range)`）。コールド参加者はバンドルを並列 GET して履歴を高速復元。
- **検証**: バンドルが指す各アイテムは独立に GET + 検証。バンドル提供者は **アイテムを省略できる（ソフト検閲）が、偽アイテムを混ぜることはできない**。複数バンドル + ライブ gossip の union で省略を緩和。

### 5.2.4 アイテム payload

```typescript
interface LogItem {
  item_id: Uint8Array       // 16 bytes（重複検出）
  data: Uint8Array          // application bytes
  created_at: bigint
  // 署名は Slot.writer_sig（4.1.6）で行う。匿名なら writer 無し
}
```

### 5.2.5 API

```typescript
// web/src/lib/caps/Log.ts

export interface LogOptions {
  my_identity?: IIdentity        // 署名する場合
  allowed_writers?: Uint8Array[] // pubkey allowlist（グループ用。null=匿名で誰でも）
  item_ttl_ms?: bigint
  unlinkable?: boolean           // 高匿名（DM 等）: blind_tag を使わず trial-decrypt
}

export class Log {
  constructor(
    private cap: Capability,
    private store: ISlotStore,
    private hintBus: IHintBus,
    private opts: LogOptions = {},
  ) {}

  /** 投稿: 独立 IMMUTABLE slot を PUT + Hint */
  async publish(data: Uint8Array): Promise<{ item_id: Uint8Array; slot_key: SlotKey }> {
    const item_id = crypto.getRandomValues(new Uint8Array(16))
    const item: LogItem = { item_id, data, created_at: BigInt(Date.now()) }
    const plain = encodeMsgPack(item)
    const payload = seal(this.cap.payloadKey, plain)
    const payload_hash = await sha256(payload)

    // ランダム鍵（Mode B）→ 衝突なし
    const slot_key = await sha256(crypto.getRandomValues(new Uint8Array(32)))
    const expires_at = BigInt(Date.now()) + (this.opts.item_ttl_ms ?? SLOT_CONSTANTS.DEFAULT_TTL_MS)
    const created_at = BigInt(Date.now())

    const core = { slot_class: SlotClass.IMMUTABLE, key: slot_key, payload_hash,
                   version: 0, expires_at, created_at }
    const slot: Slot = {
      ...core, payload, pow_proof: await computeSlotPoW(core),
      ...(this.opts.my_identity ? {
        writer_pubkey: this.opts.my_identity.publicKey,
        writer_sig: this.opts.my_identity.signRaw(authBytesOf(core)),
      } : {}),
    }
    await this.store.put(slot)

    // ライブ通知
    const hintPayload: LogHintPayload = { slot_key, item_id, sent_at: created_at }
    const hint = await HintBuilder.build(this.cap, encodeMsgPack(hintPayload), MIN_HINT_POW_DIFFICULTY)
    await this.hintBus.broadcast(hint)
    return { item_id, slot_key }
  }

  /** ライブ購読 */
  subscribe(handler: (item: LogItem, from?: Uint8Array) => void): Subscription {
    const sub = this.opts.unlinkable ? this.hintBus.subscribeUnlinkable.bind(this.hintBus)
                                     : this.hintBus.subscribe.bind(this.hintBus)
    return sub(this.cap, async (decryptedHint) => {
      const hp: LogHintPayload = decodeMsgPack(decryptedHint)
      const slot = await this.store.get(hp.slot_key)   // get が full validate 済み
      if (!slot || slot.slot_class !== SlotClass.IMMUTABLE) return
      const plain = open(this.cap.payloadKey, slot.payload)
      if (!plain) return
      const item: LogItem = decodeMsgPack(plain)
      if (!arrayEquals(item.item_id, hp.item_id)) return
      // allowed_writers チェック（グループ）
      if (this.opts.allowed_writers && (!slot.writer_pubkey ||
          !this.opts.allowed_writers.some(w => arrayEquals(w, slot.writer_pubkey!)))) return
      handler(item, slot.writer_pubkey)
    })
  }

  /** 過去ログ復元: 既知バンドル範囲を並列 GET */
  async fetchHistory(ranges: BundleRange[]): Promise<LogItem[]> {
    const out: LogItem[] = []
    await Promise.all(ranges.map(async (r) => {
      const bundleKey = this.cap.deriveSlotKey("log_bundle_v1_" + r.id)
      const bundleSlot = await this.store.get(bundleKey)
      if (!bundleSlot) return
      const plain = open(this.cap.payloadKey, bundleSlot.payload)
      if (!plain) return
      const itemKeys: SlotKey[] = decodeMsgPack(plain)
      const items = await this.fetchItems(itemKeys)   // 各 item を GET + 検証
      out.push(...items)
    }))
    return dedupeById(out)
  }

  /** バンドル作成（任意のピアが実行可。IMMUTABLE なので write-once、内容は決定論的に検証可能） */
  async sealBundle(range_id: string, itemKeys: SlotKey[], signer?: IIdentity): Promise<void> {
    const plain = encodeMsgPack(itemKeys)
    const payload = seal(this.cap.payloadKey, plain)
    const payload_hash = await sha256(payload)
    const key = this.cap.deriveSlotKey("log_bundle_v1_" + range_id)
    const expires_at = BigInt(Date.now()) + BUNDLE_TTL_MS
    const created_at = BigInt(Date.now())
    const core = { slot_class: SlotClass.IMMUTABLE, key, payload_hash, version: 0, expires_at, created_at }
    const slot: Slot = { ...core, payload, pow_proof: await computeSlotPoW(core, MIN_BUNDLE_POW_DIFFICULTY),
      ...(signer ? { writer_pubkey: signer.publicKey, writer_sig: signer.signRaw(authBytesOf(core)) } : {}) }
    await this.store.put(slot)   // 既存と同一内容なら冪等 OK、別内容なら immutable_collision
  }
}
```

### 5.2.6 1:N（BBS）と 1:1（DM）の差

```typescript
// BBS スレッド（匿名で誰でも投稿）
const thread = new Log(threadCap, store, hintBus, { my_identity })  // 署名は任意

// DM（2 者、高匿名、送受信分離）
const dmSend = new Log(capAtoB, store, hintBus, { my_identity, unlinkable: true })
const dmRecv = new Log(capBtoA, store, hintBus, { unlinkable: true })
```

- **唯一の差**は cap の共有範囲（全員 / 2 者）と `unlinkable` フラグ。コードは同一。
- DM の双方向は片方向 `Log` × 2（送信用 cap と受信用 cap を分け、自分の送信が自分に Hint されない）。

### 5.2.7 性能

| 操作 | コスト |
|---|---|
| publish（BBS post / DM send） | 1 PUT + 1 Hint broadcast ≈ **~175ms**（旧 BBS と同等） |
| ライブ受信（Hint→GET） | Hint 到達 ~400ms + GET ~250ms ≈ **~650ms** |
| 過去ログ（バンドル N 個並列） | ~250-400ms（**64KB 制限を超えてスケールする唯一の形**） |

### 5.2.8 セキュリティプロパティ

| 性質 | 保証 |
|---|---|
| 並行投稿のデータ消失 | **なし**（独立鍵、上書きなし）— 旧 C1 解消 |
| 投稿の偽造 | 不能（CHK + PoW、署名チャネルは writer_sig） |
| 投稿者匿名（匿名モード） | writer 無し。特定不能 |
| 投稿者検証（allowed_writers） | writer_sig を allowlist 照合 |
| バンドルによる検閲 | **省略は可能、偽造は不能**。union で緩和（限界として明示） |
| 単一スロット Eclipse | 解消（投稿がリング全体に分散。旧 9.4.2 の弱点が消える） |
| DM の分内リンク | `unlinkable` で blind_tag を回避（H3 緩和）|

---

## 5.3 ChunkSet — 大きな blob 分散保存

### 5.3.1 コンセプト

> 「大きなバイト列を chunk に分割し、それぞれ独立 IMMUTABLE スロットとして保存。Manifest が chunk のハッシュ列を保持。」

ファイル共有、64KB 超 payload に使う。各 chunk は write-once なので競合なし。

### 5.3.2 設計

- Chunk Slot 鍵: Mode A `deriveSlotKey("chunk_v1_" + i)`、クラス IMMUTABLE
- Manifest:

```typescript
interface ChunkManifest {
  total_size: number
  chunk_size: number
  chunk_count: number
  content_hash: Uint8Array     // SHA256(全データ)
  encoding: 'plain' | 'rs_3_2' // 将来 Reed-Solomon
  chunk_hashes: Uint8Array[]   // 各 chunk の SHA256（検証用）
}
```

### 5.3.3 API（要点のみ）

```typescript
// web/src/lib/caps/ChunkSet.ts
export const DEFAULT_CHUNK_SIZE = 32 * 1024

export class ChunkSet {
  constructor(private cap: Capability, private store: ISlotStore) {}

  async upload(data: Uint8Array, opt?: { chunk_size?: number }): Promise<ChunkManifest> {
    const cs = opt?.chunk_size ?? DEFAULT_CHUNK_SIZE
    const count = Math.ceil(data.byteLength / cs)
    const chunk_hashes: Uint8Array[] = []
    const puts: Promise<void>[] = []
    for (let i = 0; i < count; i++) {
      const chunk = data.slice(i * cs, Math.min((i + 1) * cs, data.byteLength))
      chunk_hashes.push(await sha256(chunk))
      const payload = seal(this.cap.payloadKey, chunk)   // nonce 込み（4.1.4）
      const payload_hash = await sha256(payload)
      const key = this.cap.deriveSlotKey("chunk_v1_" + i)
      const expires_at = BigInt(Date.now()) + FILE_TTL_MS, created_at = BigInt(Date.now())
      const core = { slot_class: SlotClass.IMMUTABLE, key, payload_hash, version: 0, expires_at, created_at }
      const slot: Slot = { ...core, payload, pow_proof: await computeSlotPoW(core, MIN_BUNDLE_POW_DIFFICULTY) }
      puts.push(this.store.put(slot).then(r => { if (!r.ok && r.reason !== undefined && !('idempotent' in r)) {/* immutable_collision は同一内容なら OK */} }))
    }
    await Promise.all(puts)
    return { total_size: data.byteLength, chunk_size: cs, chunk_count: count,
             content_hash: await sha256(data), encoding: 'plain', chunk_hashes }
  }

  async download(m: ChunkManifest): Promise<Uint8Array> {
    const chunks: Uint8Array[] = new Array(m.chunk_count)
    const concurrency = 8
    const q = Array.from({ length: m.chunk_count }, (_, i) => i)
    while (q.length) {
      await Promise.all(q.splice(0, concurrency).map(async (i) => {
        const slot = await this.store.get(this.cap.deriveSlotKey("chunk_v1_" + i))
        if (!slot) throw new Error(`chunk ${i} missing`)
        const chunk = open(this.cap.payloadKey, slot.payload)
        if (!chunk) throw new Error(`chunk ${i} decrypt failed`)
        if (!arrayEquals(await sha256(chunk), m.chunk_hashes[i])) throw new Error(`chunk ${i} hash mismatch`)
        chunks[i] = chunk
      }))
    }
    const result = new Uint8Array(m.total_size)
    let off = 0; for (const c of chunks) { result.set(c, off); off += c.byteLength }
    if (!arrayEquals(await sha256(result), m.content_hash)) throw new Error("content hash mismatch")
    return result
  }
}
```

### 5.3.4 性能

| 操作 | コスト |
|---|---|
| 1MB upload（32KB×32 chunk） | PoW 並列 + PUT 並列 ≈ ~1-3s |
| 1MB download | 並列 GET（concurrency 8）≈ ~1s |

将来: Reed-Solomon (3+2) で一部 chunk 欠落耐性（[12](./12_open_questions.md) Q14）。

---

## 5.4 Capability のシリアライズ（export/import）

```
aether://cap/<type>/v<version>/<base64url(msgpack)>
```

```typescript
interface CapabilityExport {
  version: 1
  type: 'log' | 'ptr' | 'chunkset'
  root_secret: Uint8Array
  metadata?: any   // type-specific（ptr は owner_pubkey、chunkset は manifest）
}
```

### Read-only vs Read-Write

- **Read cap**: `root_secret` のみ（slot_key / payloadKey / discoveryKey を導出可）。**ただし匿名 `Log` では read=write**（署名不要なので誰でも publish 可能）。これは匿名 BBS の前提どおり。
- **Write 制限が要る場合**は `allowed_writers`（`Log`）または OWNED_POINTER の owner 署名で実現。読み書き分離は「署名鍵を渡すか否か」で表現する。

---

## 5.5 Capability ライフサイクル

- **作成**: アプリが root_secret を生成（X3DH / ランダム / PSK）
- **共有**: URI / QR / 暗号化リンク
- **廃棄/ローテーション**: root_secret 更新、旧 slot は TTL で自然消滅、application が切替通知

---

## 5.6 次に読む

→ [06_layer4_applications.md](./06_layer4_applications.md): `Log` / `OwnedPointer` / `ChunkSet` での BBS / DM / File / Group 実装
→ [07_wire_protocol.md](./07_wire_protocol.md): バイト構造
