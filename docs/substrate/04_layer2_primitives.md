# Part 4: Layer 2 Primitives — Slot と Hint の完全仕様

Layer 2 は **application 非依存の匿名ストレージ基盤**。`Slot` と `Hint` の 2 つのプリミティブで構成される。

> **v2.1 改訂 (2026-06-10)**: 低レイヤーのセキュリティ検証で、旧 Slot 設計に致命的な矛盾が見つかったため、Slot を **2 クラス制 (IMMUTABLE / OWNED_POINTER)** に再構成した。背景は [12_open_questions.md](./12_open_questions.md) の R5 と [01_overview.md](./01_overview.md) を参照。要点:
> - **中身を見ない保管ノード (Schrödinger node) は、暗号化された多人数共有 blob の「追記のみ」を検証できない。** ゆえに「多人数で書く対象」は不変 (write-once) でなければならない。
> - 可変が安全なのは **単一署名者が所有するスロット** だけ。これを `OWNED_POINTER` クラスに隔離する。
> - 旧 `BundledChannel` (1 slot に全 entry を上書き蓄積) は廃止。詳細は [05_layer3_capabilities.md](./05_layer3_capabilities.md)。

---

## 4.1 Slot — 匿名ストレージセル

### 4.1.1 コンセプト

> 「ランダム or 導出された 32 バイト鍵に、暗号化されたバイト列が紐付いた保管単位。保存ノードは中身を知らない。」

Slot は単なる Key-Value ペアだが、以下の不変条件を満たす:

1. **CHK 性**: `payload_hash === SHA256(payload)`（payload は nonce を含む封印済みバイト列）
2. **PoW 性**: 投稿に SHA-256 ベースの計算コスト。**PoW は TTL/version まで束縛する**（改竄不能化）
3. **帰属性**: 保存ノードは自分が K-nearest 圏内にあることを確認（資源管理ヒューリスティック。後述 4.1.10）
4. **TTL 性**: 有限期間で自動消滅。expires_at は PoW/署名で保護
5. **クラス性**: `slot_class` で IMMUTABLE / OWNED_POINTER を区別。上書きはクラスごとに厳格に制御

### 4.1.2 Slot クラス

Slot は 2 クラスのいずれか。`slot_class` は **PoW と署名の入力に含まれる**ため、クラスの偽装は不可能。

| クラス | 値 | 上書き | 用途 | writer 署名 |
|---|---|---|---|---|
| **IMMUTABLE** | `0x01` | **絶対に不可** (write-once) | 投稿1件、DMメッセージ1件、ファイルchunk、バンドル | 任意 (真正性のみ) |
| **OWNED_POINTER** | `0x02` | 単一所有者のみ、version 単調増加 | head 指標、manifest 指標、member list 指標 | **必須** |

**設計原則**:
- 「多人数が書く対象」「並行して書かれる対象」は **必ず IMMUTABLE**。鍵が衝突しない限り上書き競合が原理的に発生しない。
- 「最新版を 1 人が更新する指標」だけが OWNED_POINTER。可変ロジックはこの 1 クラスに隔離され、単一署名者なので安全。

### 4.1.3 SlotKey の派生方式

**Mode A: Derived (HMAC-based)** — 鍵が事前計算可能な用途

```typescript
const slot_key = hmacSha256(
  capability_secret,
  utf8("aether_slot_v1") || label_bytes
)
// 出力: 32 bytes
```

性質:
- 同一 `capability_secret` + `label` から常に同じ slot_key
- 第三者から見ると完全ランダムな 32 バイト
- OWNED_POINTER は **必ず Mode A**（指標の鍵は固定でないと resolve できない）
- IMMUTABLE でも、決定論的に列挙したい場合 (例: `"entry_" || seq`) は Mode A を使える。ただし **write-once なので seq 衝突は claim 競合として扱う**（4.1.9）

**Mode B: Random (per-write nonce)** — 匿名性優先用途

```typescript
const post_nonce = crypto.getRandomValues(new Uint8Array(32))
const slot_key = sha256(post_nonce)
// 出力: 32 bytes
```

性質:
- 各書き込みごとに固有の slot_key。衝突確率 2^-256
- Hint via Gossip でしか発見不可
- IMMUTABLE 専用（ランダム鍵を後から指せないので OWNED_POINTER には使えない）

### 4.1.4 暗号フレーミング（重要・実装ブロッカー）

**AEAD 封印形式を本仕様で確定する。** これを守らないと nonce 再利用などの致命的事故が起きる。

```typescript
// 封印: nonce を payload の先頭に埋め込む。Slot に nonce フィールドは持たない
function seal(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ct = chacha20poly1305_encrypt(key, nonce, plaintext)  // ct は Poly1305 tag 込み
  return concat(nonce, ct)   // = payload
}

function open(key: Uint8Array, sealed: Uint8Array): Uint8Array | null {
  const nonce = sealed.slice(0, 12)
  const ct = sealed.slice(12)
  return chacha20poly1305_decrypt(key, nonce, ct)  // 失敗時 null
}
```

**規約**:
1. `Slot.payload = seal(payloadKey, plaintext)` = `nonce(12) || ciphertext+tag`
2. `Slot.payload_hash = SHA256(Slot.payload)` → **CHK が nonce を覆う**。nonce 改竄は CHK 失敗で検出
3. **固定 nonce・ゼロ nonce は禁止。** nonce は毎回 `getRandomValues`
4. nonce を別フィールドに分離してはならない（取り違え・忘れの事故源）

> 既存 `CryptoEngine.encrypt` は `{ciphertext, nonce}` を別々に返すが、Substrate では `seal()` ラッパーで連結する。`substrate/crypto/Aead.ts` に `seal/open` を実装し、全 Layer 2-3 はこれだけを使う。

### 4.1.5 Slot 型定義 (TypeScript)

```typescript
// web/src/lib/substrate/slot/Slot.ts

export type SlotKey = Uint8Array  // 32 bytes

export const SlotClass = {
  IMMUTABLE:      0x01,
  OWNED_POINTER:  0x02,
} as const
export type SlotClassValue = typeof SlotClass[keyof typeof SlotClass]

export interface Slot {
  /** Slot 識別鍵。32 bytes */
  key: SlotKey

  /** クラス。PoW/署名入力に含まれ偽装不能 */
  slot_class: SlotClassValue

  /** 封印済み payload = nonce(12) || ciphertext+tag。Substrate は不透明扱い */
  payload: Uint8Array

  /** SHA256(payload). CHK 検証用。nonce 込みを覆う */
  payload_hash: Uint8Array  // 32 bytes

  /** Anti-spam PoW. base に key/hash/version/TTL を全て束縛 (4.1.6) */
  pow_proof: Uint8Array     // 8 bytes

  /** TTL (Unix ms). PoW/署名で保護。改竄不能 */
  expires_at: bigint        // u64

  /** 投稿時刻 (Unix ms). PoW/署名で保護 */
  created_at: bigint        // u64

  /** version。IMMUTABLE は常に 0。OWNED_POINTER は単調増加 */
  version: number           // u32

  /** writer 識別。OWNED_POINTER では必須、IMMUTABLE では任意 */
  writer_pubkey?: Uint8Array  // 32 bytes (Ed25519)

  /** writer 署名 (4.1.6 の auth_bytes に対して) */
  writer_sig?: Uint8Array    // 64 bytes
}
```

### 4.1.6 PoW と署名の入力定義（H1/C2/C3 対策の核心）

**両方とも `key, payload_hash, version, expires_at, created_at, slot_class` を束縛する。** これにより:
- TTL 切り詰め・created_at 改竄（旧 H1）が PoW 検証で弾かれる（**匿名 IMMUTABLE は署名が無いので PoW が唯一の保護**）
- version 偽装（旧 C2/M3）が署名・PoW の両方で弾かれる

```typescript
// PoW base（proof を変えて difficulty を満たす）
function powBase(s: Slot): Uint8Array {
  return concat(
    utf8("aether_slot_pow_v1"),
    u8(s.slot_class),
    s.key,                    // 32
    s.payload_hash,           // 32
    u32ToBytes(s.version),
    u64ToBytes(s.expires_at),
    u64ToBytes(s.created_at),
  )
}
// pow_proof: sha256(powBase || pow_proof) の先頭 0-bit 数 >= difficulty となる 8 bytes

// 署名 base（writer_sig が覆う）
function authBytes(s: Slot): Uint8Array {
  return concat(
    utf8("aether_slot_sig_v1"),
    u8(s.slot_class),
    s.key,
    s.payload_hash,
    u32ToBytes(s.version),
    u64ToBytes(s.expires_at),
    u64ToBytes(s.created_at),
  )
}
// writer_sig = Ed25519_sign(writer_priv, authBytes(s))
```

### 4.1.7 検証ルール (SlotValidator)

Slot を受信したとき（**SLOT_PUT でも SLOT_RES でも必ず**）通す検証フロー。クラスごとに分岐する。

```typescript
// web/src/lib/substrate/slot/SlotValidator.ts

export class SlotValidator {
  /** ネットワーク非依存の検証（CHK/PoW/クラス/署名）。GET 応答でも必ず実行 */
  static async validateSelfContained(slot: Slot, ctx: SelfCtx): Promise<ValidationResult> {
    // 1. サイズ・形式
    if (slot.key.length !== 32) return fail('invalid_key_size')
    if (slot.payload_hash.length !== 32) return fail('invalid_hash_size')
    if (slot.payload.length > MAX_PAYLOAD_SIZE) return fail('payload_too_large')
    if (slot.payload.length < MIN_SEALED_SIZE) return fail('payload_too_small') // >= 12(nonce)+16(tag)
    if (slot.pow_proof.length !== 8) return fail('invalid_pow_size')
    if (slot.slot_class !== SlotClass.IMMUTABLE &&
        slot.slot_class !== SlotClass.OWNED_POINTER) return fail('invalid_class')

    // 2. CHK（nonce 込みを覆う）
    const h = await sha256(slot.payload)
    if (!arrayEquals(h, slot.payload_hash)) return fail('chk_mismatch')

    // 3. PoW（TTL/version/class まで束縛）
    const powHash = await sha256(concat(powBase(slot), slot.pow_proof))
    if (leadingZeros(powHash) < ctx.required_pow_difficulty) return fail('insufficient_pow')

    // 4. TTL / clock
    const now = BigInt(Date.now())
    if (slot.expires_at <= now) return fail('expired')
    if (slot.expires_at > now + MAX_TTL_MS) return fail('ttl_too_long')
    if (slot.created_at > now + CLOCK_SKEW_MS) return fail('future_timestamp')

    // 5. クラス別の構造規約
    if (slot.slot_class === SlotClass.IMMUTABLE) {
      if (slot.version !== 0) return fail('immutable_version_must_be_zero')
      // writer は任意。あるなら両方そろっていること
      if ((slot.writer_pubkey ? 1 : 0) ^ (slot.writer_sig ? 1 : 0)) return fail('incomplete_writer_proof')
    } else { // OWNED_POINTER
      if (!slot.writer_pubkey || !slot.writer_sig) return fail('pointer_requires_signature')
    }

    // 6. 署名検証（writer があるとき。OWNED_POINTER は必須経路）
    if (slot.writer_pubkey && slot.writer_sig) {
      if (!await ed25519Verify(slot.writer_pubkey, authBytes(slot), slot.writer_sig)) {
        return fail('invalid_signature')
      }
    }
    return { ok: true }
  }

  /** 保存判断（既存 slot との関係 + 帰属）。PUT 受信時のみ */
  static async validateForStore(slot: Slot, ctx: StoreCtx): Promise<ValidationResult> {
    const self = await this.validateSelfContained(slot, ctx)
    if (!self.ok) return self

    // 7. K-nearest 帰属（資源管理ヒューリスティック、4.1.10 参照）
    const target_pos = bytesToPosition(slot.key)
    if (!ctx.peer_manager.isAmongKNearest(target_pos, K_NEAREST)) return fail('not_k_nearest')

    // 8. 既存 slot との関係
    const existing = await ctx.store.peek(slot.key)
    if (existing) {
      if (slot.slot_class === SlotClass.IMMUTABLE) {
        // write-once: 同一内容の再 PUT は冪等 OK、異なる内容は拒否
        if (!arrayEquals(existing.payload_hash, slot.payload_hash)) {
          return fail('immutable_collision')   // → 上位は別 key で claim し直す (4.1.9)
        }
        return { ok: true, idempotent: true }
      } else { // OWNED_POINTER
        if (!existing.writer_pubkey) return fail('pointer_state_corrupt')
        if (!arrayEquals(existing.writer_pubkey, slot.writer_pubkey!)) return fail('writer_mismatch')
        if (slot.version <= existing.version) return fail('stale_version')
      }
    }
    return { ok: true }
  }
}
```

**旧設計との差分（C1 解消）**:
- 旧 rule 7 の「既存があれば writer 必須・同一 writer のみ」は **OWNED_POINTER だけに適用**。
- IMMUTABLE は「同一 key への異内容書き込み = 衝突」で、上位層が別 key を選んで回避する（多人数並行書き込みでもデータ消失しない）。
- これにより BBS（多人数投稿）は IMMUTABLE な投稿スロット群として表現でき、追記不能だった C1 が消える。

### 4.1.8 定数

```typescript
export const SLOT_CONSTANTS = {
  K_NEAREST:           5,
  MIN_SEALED_SIZE:     28,          // 12(nonce) + 16(Poly1305 tag) 最低
  MAX_PAYLOAD_SIZE:    65536,       // 64 KB（超過分は ChunkSet / バンドル分割）
  // PoW フロア（旧 16 は低すぎた。H2 対策で引き上げ）
  MIN_POW_DIFFICULTY:        20,    // bits. IMMUTABLE/OWNED_POINTER 共通の下限
  MIN_BUNDLE_POW_DIFFICULTY: 18,    // バンドル（大量だが集約済み）はやや軽め
  MAX_TTL_MS:          90n * 86400n * 1000n,   // 90 days
  DEFAULT_TTL_MS:      30n * 86400n * 1000n,   // 30 days
  CLOCK_SKEW_MS:       300_000n,    // 5 min
} as const
```

> **PoW フロアの根拠 (H2)**: 旧 16-bit (~65K hash) は WASM/native 攻撃者 (~5M hash/s) には ~13ms で、スパム抑止として無力だった。20-bit (~1M hash) でも攻撃者は ~0.2s だが、**検証側も同一 WASM 実装で計測** し、難易度を `DifficultyEstimator` で動的に押し上げる前提。フロアはあくまで下限。LRU eviction は PoW 重み付け or ランダム化し、安価 PUT による標的 eviction (旧 H2) を防ぐ。

### 4.1.9 IMMUTABLE の claim 競合（決定論鍵の場合）

Mode A の決定論鍵（例 `"entry_" || seq`）を多人数で使うと、2 人が同じ seq を取り合う。write-once なので:

1. writer は seq を仮取得し PUT
2. **read-after-write で確認**（PUT は fire-and-forget なので、確定には読み戻しが必要）
3. 自分の payload_hash と一致 → 成功。別内容が居る → 衝突。seq+1 で再試行

競合面は「現在の末尾 seq 付近」だけに局所化され、旧モデルの「1 板 = 1 ホットスロット全体が競合」より遥かに軽い。ランダム鍵 (Mode B) を使えば claim 競合自体が消える（発見は Hint に依存）。

> **設計判断**: 匿名 BBS の本流は **Mode B（ランダム鍵）+ Hint 発見 + バンドル（過去ログ）** を推奨。決定論 seq は「小規模・既知 roster」向け。詳細は [05](./05_layer3_capabilities.md) の `Log`。

### 4.1.10 K-nearest 帰属検証の位置づけ（M1）

`validateForStore` step 7 の帰属チェックは **honest ノードが「自分の担当外の Slot を貯め込まない」ための資源管理**であり、悪意ノードに対する防御ではない（攻撃者は自分のノードで任意鍵を保管・応答できる）。データ完全性は **受信側の CHK + 署名検証**（4.1.7 self-contained）が担保する。セキュリティ評価でこのチェックを「圏外 PUT 拒否 ◎」と過大評価しないこと。

### 4.1.11 SlotStore インターフェース

```typescript
export interface ISlotStore {
  put(slot: Slot): Promise<PutResult>
  get(key: SlotKey): Promise<Slot | null>
  /** 存在確認のみ（上書き判定用） */
  peek(key: SlotKey): Promise<Pick<Slot, 'version' | 'writer_pubkey' | 'payload_hash' | 'slot_class'> | null>
  evictExpired(): Promise<number>
  listMyKeys(): Promise<SlotKey[]>
}

export type PutResult =
  | { ok: true; idempotent?: boolean }
  | { ok: false; reason: ValidationFailReason }
  | { ok: false; reason: 'storage_full'; evicted?: number }
```

### 4.1.12 ネットワークプロトコル（PUT/GET）

WireType は [07_wire_protocol.md](./07_wire_protocol.md) 参照（`SLOT_PUT=0x50`, `SLOT_GET=0x51`, `SLOT_RES=0x52`）。

#### PUT フロー

```typescript
async function publishSlot(slot: Slot): Promise<void> {
  const target_pos = bytesToPosition(slot.key)
  const nearest = peerManager.findKNearest(target_pos, K_NEAREST)
  if (nearest.includes(peerManager.myPeerId)) await store.put(slot)
  for (const id of nearest) {
    if (id === peerManager.myPeerId) continue
    peerManager.sendMessage(id, WireType.SLOT_PUT, { slot })
  }
}
```

#### GET フロー（C2: 応答も full validate）

```typescript
async function fetchSlot(key: SlotKey, timeout_ms = 4000): Promise<Slot | null> {
  const local = await store.get(key)
  if (local) return local

  const nearest = peerManager.findKNearest(bytesToPosition(key), K_NEAREST)
    .filter(id => id !== peerManager.myPeerId)
  if (nearest.length === 0) return null

  return new Promise((resolve) => {
    const req_id = randomU64()
    const valid = new Map<string, Slot>()  // payload_hash hex → slot
    let responses = 0
    const timer = setTimeout(finalize, timeout_ms)

    const onResponse = async (slot: Slot | null) => {
      responses++
      if (slot) {
        // ★ 送信元を信頼しない: full self-contained validate（CHK+PoW+class+署名）
        const r = await SlotValidator.validateSelfContained(slot, selfCtx)
        if (r.ok && arrayEquals(bytesToKeyCheck(slot.key), key)) {
          valid.set(hex(slot.payload_hash), slot)
        }
      }
      if (responses >= nearest.length) finalize()
    }
    function finalize() {
      clearTimeout(timer); pendingRequests.delete(req_id)
      const cands = [...valid.values()]
      // OWNED_POINTER のみ version で順位付け（署名検証済みなので version は信頼可能）
      cands.sort((a, b) => b.version - a.version)
      resolve(cands[0] ?? null)
    }
    pendingRequests.set(req_id, onResponse)
    for (const t of nearest) peerManager.sendMessage(t, WireType.SLOT_GET, { key, req_id })
  })
}
```

**重要 (C2)**: version で順位付けするのは **署名検証を通過した OWNED_POINTER のみ**。署名未検証の version を信用すると、悪意ノード 1 台が巨大 version を返して結果を乗っ取れる（旧 C2）。IMMUTABLE は version=0 固定なので順位付け不要、payload_hash で重複排除するだけ。

### 4.1.13 レプリケーション

Slot 単位で独立管理。担当が `K_NEAREST` 未満になったら補充。`ReplicationManager` は **検証済み Slot のみ**送信し、受信側も再検証する（検証チェーンを切らない）。詳細は旧仕様と同じ。

---

## 4.2 Hint — 暗号化発見プロトコル

### 4.2.1 コンセプト

> 「Slot 鍵を暗号化して Gossip で配信。`Capability` 保有者だけが復号できる。」

Hint は **Mode B（ランダム slot 鍵）の発見メカニズム**。`Log`（多人数チャネル / DM）のライブ配信路として使う。

### 4.2.2 Hint パケット構造

```typescript
// web/src/lib/substrate/hint/Hint.ts

export interface Hint {
  version: number               // u8, 0x01
  blind_tag: Uint8Array         // 4 bytes（自分宛て O(1) 判定）
  nonce: Uint8Array             // 12 bytes（AEAD）
  ciphertext: Uint8Array        // 可変長（typ 48-128 bytes、tag 込み）
  pow_proof: Uint8Array         // 8 bytes
  time_bucket: number           // u32, floor(unix_ms / TIME_BUCKET_MS)
}
```

固定部 `1+4+12+8+4 = 29` + ciphertext ≈ **100 bytes**。

### 4.2.3 Hint Payload（application 定義・不透明）

```typescript
// Log のライブ通知（IMMUTABLE 投稿の発見）
export interface LogHintPayload {
  slot_key: Uint8Array          // 32 bytes（IMMUTABLE 投稿スロット）
  item_id: Uint8Array           // 16 bytes（重複検出）
  seq?: number                  // 任意のヒント連番
  sent_at: bigint               // u64
}
```

### 4.2.4 Capability と派生鍵

```typescript
// web/src/lib/substrate/capability/Capability.ts

export class Capability {
  constructor(private readonly root_secret: Uint8Array) {}  // 32 bytes

  /** すべて HKDF-SHA256(root_secret, info, len)。鍵を一貫した KDF で分離（M4） */
  get encryptKey(): Uint8Array  { return hkdf(this.root_secret, "aether_hint_enc_v1", 32) }
  get discoveryKey(): Uint8Array { return hkdf(this.root_secret, "aether_hint_disc_v1", 32) }
  get payloadKey(): Uint8Array  { return hkdf(this.root_secret, "aether_payload_enc_v1", 32) }

  /** Mode A 用 Slot 鍵派生（domain-separated） */
  deriveSlotKey(label: string | Uint8Array): SlotKey {
    const lb = typeof label === 'string' ? utf8(label) : label
    return hmacSha256(hkdf(this.root_secret, "aether_slot_root_v1", 32),
                      concat(utf8("aether_slot_v1"), lengthPrefixed(lb)))
  }

  /** Blind tag */
  computeBlindTag(time_bucket: number): Uint8Array {
    return hmacSha256(this.discoveryKey,
                      concat(utf8("aether_blind_v1"), u32ToBytes(time_bucket))).slice(0, 4)
  }

  toBytes(): Uint8Array { return this.root_secret.slice() }
  static fromBytes(b: Uint8Array): Capability { return new Capability(b) }
}
```

> **M4 修正**: 全派生鍵を HKDF に統一し、`deriveSlotKey` も `root_secret` 直 HMAC ではなく専用 PRK 経由にした。label は **長さ前置** (`lengthPrefixed`) して `"entry_"+"1"` と `"entry_1"+""` のような prefix 衝突を防ぐ。

### 4.2.5 Blind Tag の事前計算とリンク可能性（H3 を明示）

```
blind_tag = HMAC(discovery_key, "aether_blind_v1" || time_bucket)[0..4]
```

受信者は現在の time_bucket だけ事前計算すれば O(1) HashMap lookup で自分宛て Hint を判定できる。

> **⚠️ 既知のメタデータ漏洩 (H3)**: blind_tag は **同一 cap・同一 time_bucket では同一値**になる。つまり観測者は復号できなくても、`(blind_tag, time_bucket)` で **同じ受信者宛ての Hint 群を 1 分単位で束ねられる**（4 byte なので別 cap との衝突は 2^-32 でほぼ起きず、束ね分けは事実上正確）。
>
> - これは「予測可能 tag で O(1) 発見」と「観測者にリンクさせない」が原理的に両立しない、という構造的トレードオフ。
> - **影響**: DM の同一 inbox 宛バーストが 1 分粒度で相関される。cross-bucket（分跨ぎ）リンクは tag が変わるので切れる。
> - **本設計の立場**: この **分内リンク可能性は許容**し、脅威モデルに明記する（[09](./09_security_analysis.md) で ◎→○ に格下げ）。完全な非リンク性が要る高匿名 cap は、Blind Tag を使わず **trial-decryption（O(N_caps)）にフォールバック**する経路を提供する（`HintBus.subscribeUnlinkable`、Phase 4 で実装）。

#### BlindTagIndex 実装

```typescript
export const TIME_BUCKET_MS = 60_000  // 1 分粒度

export class BlindTagIndex {
  private map = new Map<string, { cap: Capability; bucket: number }[]>()
  private caps = new Set<Capability>()
  private currentBucket = -1

  add(cap: Capability) { this.caps.add(cap); this.rebuild() }
  remove(cap: Capability) { this.caps.delete(cap); this.rebuild() }
  private getBucket(ts = Date.now()) { return Math.floor(ts / TIME_BUCKET_MS) }

  refresh() {
    const b = this.getBucket()
    if (b === this.currentBucket) return
    this.currentBucket = b; this.rebuild()
  }
  private rebuild() {
    const m = new Map<string, { cap: Capability; bucket: number }[]>()
    for (const bucket of [this.currentBucket - 1, this.currentBucket, this.currentBucket + 1]) {
      for (const cap of this.caps) {
        const key = bytesToHex(cap.computeBlindTag(bucket))
        ;(m.get(key) ?? m.set(key, []).get(key)!).push({ cap, bucket })
      }
    }
    this.map = m
  }
  lookup(tag: Uint8Array, time_bucket: number): Capability[] {
    return (this.map.get(bytesToHex(tag)) ?? [])
      .filter(e => e.bucket === time_bucket).map(e => e.cap)
  }
}
```

コスト: rebuild は 1000 caps × 3 buckets ≈ 3ms（1 分に 1 回）、lookup O(1)、メモリ ~100KB。

### 4.2.6 HintBus

```typescript
export interface IHintBus {
  subscribe(cap: Capability, handler: HintHandler): Subscription
  /** 高匿名用: blind_tag を使わず全 hint を trial-decrypt（O(N_caps)、低頻度 cap 向け） */
  subscribeUnlinkable(cap: Capability, handler: HintHandler): Subscription
  broadcast(hint: Hint, options?: BroadcastOptions): Promise<void>
}
export type HintHandler = (decrypted_payload: Uint8Array, meta: HintMeta) => void
export interface HintMeta { received_at: number; time_bucket: number; cap: Capability }
export interface Subscription { unsubscribe(): void }
export interface BroadcastOptions { via_dandelion?: boolean; ttl_hops?: number }
```

### 4.2.7 HintBus 受信処理（PoW フロア H2 反映）

```typescript
private async onReceive(sender_id: PeerId, msg: Hint): Promise<void> {
  // 1. 重複（nonce 由来）
  const hint_id = await sha256(msg.nonce)
  if (this.seenHints.has(hint_id)) return
  this.seenHints.add(hint_id)

  // 2. PoW（フロア = MIN_HINT_POW_DIFFICULTY、H2 で引き上げ）
  if (!await this.verifyPow(msg)) return

  // 3. time_bucket 妥当性（±1 のみ）
  const nb = Math.floor(Date.now() / TIME_BUCKET_MS)
  if (Math.abs(msg.time_bucket - nb) > 1) return

  // 4. blind_tag O(1) lookup + 5. 復号
  const candidates = this.index.lookup(msg.blind_tag, msg.time_bucket)
  for (const cap of candidates) {
    const dec = open(cap.encryptKey, concat(msg.nonce, msg.ciphertext))
    if (!dec) continue
    this.deliver(cap, dec, msg)
  }
  // 5b. unlinkable 購読者には常に trial-decrypt（タイミング正規化のため candidates と独立に）
  for (const cap of this.unlinkableCaps) {
    const dec = open(cap.encryptKey, concat(msg.nonce, msg.ciphertext))
    if (dec) this.deliver(cap, dec, msg)
  }

  // 6. 中継（自分宛てでも他人が購読している可能性）
  this.router.floodHint(msg, sender_id)
}

private async verifyPow(h: Hint): Promise<boolean> {
  const input = concat([h.version], h.blind_tag, h.nonce, h.ciphertext, h.pow_proof)
  return leadingZeros(await sha256(input)) >= MIN_HINT_POW_DIFFICULTY
}
```

> **H2 注記**: Hint は投稿量に比例して流れ、各ノードが PoW 検証 + 全ピア再 flood する。`MIN_HINT_POW_DIFFICULTY` を旧 12 から **18** に引き上げ、規模化時は **zone-aware flood**（[12](./12_open_questions.md) Q8）で増幅を抑える。

### 4.2.8 HintBuilder

```typescript
export class HintBuilder {
  static async build(cap: Capability, payload: Uint8Array, pow_difficulty: number): Promise<Hint> {
    const time_bucket = Math.floor(Date.now() / TIME_BUCKET_MS)
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const blind_tag = cap.computeBlindTag(time_bucket)
    const sealed = chacha20poly1305_encrypt(cap.encryptKey, nonce, payload)  // ciphertext+tag
    const partial = concat([1], blind_tag, nonce, sealed)
    const pow_proof = await computePoW(partial, pow_difficulty, 8)
    return { version: 1, blind_tag, nonce, ciphertext: sealed, pow_proof, time_bucket }
  }
}
```

### 4.2.9 Hint 配信路（Dandelion 流用）・4.2.10 Catchup

既存仕様どおり（`ZoneGossipRouter` を `WireType.HINT=0x42` で流用、`HINT_CATCHUP_REQ/RES` で再接続時補完）。Catchup の認可は [12](./12_open_questions.md) Q3。Hint はあくまで **ライブ発見**であり、**過去ログの真実源ではない**（過去ログは `Log` のバンドル＋gossip union が担う。[05](./05_layer3_capabilities.md)）。

---

## 4.3 Capability 派生 info 一覧

```typescript
const DERIVATION_INFOS = {
  // Layer 2 共通（HKDF info）
  HINT_ENC:    "aether_hint_enc_v1",
  HINT_DISC:   "aether_hint_disc_v1",
  PAYLOAD_ENC: "aether_payload_enc_v1",
  SLOT_ROOT:   "aether_slot_root_v1",   // deriveSlotKey 用 PRK

  // Slot label（deriveSlotKey の引数。長さ前置で衝突回避）
  POINTER:     "ptr_v1",                // OWNED_POINTER
  LOG_BUNDLE:  "log_bundle_v1",         // バンドル（IMMUTABLE）
  CHUNK:       "chunk_v1",              // ChunkSet（IMMUTABLE）
}
```

---

## 4.4 セキュリティプロパティ

### 4.4.1 Slot

| 性質 | 保証 |
|---|---|
| Storage poisoning 不能 | CHK + PoW + 受信側再検証（4.1.12 GET も full validate） |
| 任意 slot への偽上書き不能 | IMMUTABLE は上書き経路が存在しない。OWNED_POINTER は単一署名者 + version 単調 + 署名必須 |
| TTL/created_at 改竄不能 | PoW base + 署名 base に束縛（H1） |
| version 偽装不能 | 署名 base に束縛。GET 順位付けは署名検証済みのみ（C2） |
| nonce 再利用事故防止 | 封印形式を仕様化、CHK が nonce を覆う（C3） |
| Slot key の意味不明性 | Mode A は HMAC、Mode B は random。保存ノードからは random 32 bytes |

### 4.4.2 Hint

| 性質 | 保証 |
|---|---|
| 自分宛て以外の中身不可視 | AEAD（ChaCha20-Poly1305） |
| 偽 Hint の spam 抑止 | PoW（`MIN_HINT_POW_DIFFICULTY=18`） |
| 受信発見コスト | O(1) HashMap lookup |
| **分内リンク可能性** | **残存（H3）**。同一 cap・同一 bucket の Hint は束ねられる。高匿名は unlinkable 購読へ |

### 4.4.3 制約と限界

- Slot key（hex）は K-nearest には見える（PUT 先なので隠せない）
- Hint の流量は Gossip 経由で観測可能（cover 不採用）
- time_bucket は平文（「いつ」は分かるが「何を」は不明）
- **blind_tag による分内リンク可能性**（H3、上記）

---

## 4.5 実装上の注意点

- **AEAD**: `libsodium-wrappers` の `crypto_aead_chacha20poly1305_ietf_*`。封印は 4.1.4 の `seal/open` に必ず通す
- **SHA-256 / HMAC-SHA-256**: WebCrypto `crypto.subtle`
- **Ed25519**: 既存 `Identity.ts`（libsodium `crypto_sign_detached/verify_detached`）
- **HKDF-SHA256**: `substrate/capability/KeyDerivation.ts` に実装
- **PoW**: 既存 `PoWEngine`（WASM）。検証も同一実装で行い、難易度フロア（4.1.8）を守る

---

## 4.6 次に読む

→ [05_layer3_capabilities.md](./05_layer3_capabilities.md): Slot/Hint を組み合わせた `OwnedPointer` / `Log` / `ChunkSet`
→ [07_wire_protocol.md](./07_wire_protocol.md): バイト構造の正確な仕様
