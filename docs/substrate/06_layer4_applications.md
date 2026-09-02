# Part 6: Layer 4 Applications — Capability の組み合わせで実現する用途

Layer 4 はユーザー視点の機能。Layer 3 の `Log` / `OwnedPointer` / `ChunkSet` を組み合わせて実装する。

> **v2.1 改訂 (2026-06-10)**: 旧 `BundledChannel` 廃止に伴い、BBS / DM / グループ / pub-sub を `Log`（不変アイテム列）ベースに再構成。[05_layer3_capabilities.md](./05_layer3_capabilities.md) 参照。

---

## 6.1 BBS Thread — 現在のメイン用途

### 6.1.1 構成

```
BBSThread
├── Log              ... 全 post（IMMUTABLE 投稿 + Hint ライブ + バンドル過去ログ）
├── OwnedPointer     ... thread head 指標（最新バンドル range や seq。作成者が更新）
└── (option) ChunkSet ... 画像・大きな添付
```

### 6.1.2 鍵の派生

```typescript
const thread_root = hkdf(board_key, "bbs_thread_v1_" + thread_id, 32)
const thread_cap = new Capability(thread_root)
```

### 6.1.3 実装

```typescript
// web/src/lib/apps/bbs/BBSThread.ts

export class BBSThread {
  private log: Log
  private head: OwnedPointer

  constructor(
    private board_key: Uint8Array,
    private thread_id: string,
    private creator_pubkey: Uint8Array,   // thread 作成者（head 更新権）
    substrate: SubstrateContext,
    private my_identity: IIdentity,
  ) {
    const cap = new Capability(hkdf(board_key, "bbs_thread_v1_" + thread_id, 32))
    // BBS は誰でも投稿（allowed_writers なし）。署名は任意（cap 名やトリップ用）
    this.log = new Log(cap, substrate.slotStore, substrate.hintBus, { my_identity: this.my_identity })
    this.head = new OwnedPointer(cap, creator_pubkey, substrate.slotStore, "head")
  }

  /** 投稿 = 1 IMMUTABLE スロット + Hint */
  async post(text: string): Promise<void> {
    const postData = await this.buildPostData(text)   // BBS 固有の wrapper（本文・トリップ等）
    await this.log.publish(postData)
  }

  /** ライブ購読（オンライン中の新着） */
  subscribe(handler: (post: Post) => void): Subscription {
    return this.log.subscribe((item) => handler(this.decode(item)))
  }

  /** 過去ログ（コールド参加）: head が指すバンドル範囲を取得 */
  async loadHistory(): Promise<Post[]> {
    const h = await this.head.resolve()
    const ranges: BundleRange[] = h?.metadata ? decodeRanges(h.metadata) : inferRanges()
    const items = await this.log.fetchHistory(ranges)
    return this.resolveOrder(items.map(i => this.decode(i)))  // 既存 DAG/PoW 順序解決を流用
  }

  /** 作成者がたまにバンドルを封印し head を進める（任意ピアが封印してもよい。head は作成者のみ） */
  async sealRecent(range_id: string, itemKeys: SlotKey[]): Promise<void> {
    await this.log.sealBundle(range_id, itemKeys, this.my_identity)
    if (arrayEquals(this.my_identity.publicKey, this.creator_pubkey)) {
      await this.head.update(undefined, nextVersion(), encodeRangeAppend(range_id), this.my_identity)
    }
  }

  private async buildPostData(text: string): Promise<Uint8Array> {
    return encodeMsgPack({ content: text, created_at: Date.now() })  // 暗号化は Log に委譲
  }
  private decode(item: LogItem): Post { /* item.data を Post に */ return /* ... */ }
  private resolveOrder(posts: Post[]): Post[] { /* 既存 DAG 解決 */ return posts }
}
```

> **過去ログの真実性について**: バンドル提供者はアイテムを省略できる（ソフト検閲）が偽造はできない。head（作成者署名）が「公式バンドル範囲」を示すが、作成者が消えても **ライブ gossip + 任意ピアのバンドル union** で読める。完全な履歴完全性は匿名 P2P BBS では保証しない（[05](./05_layer3_capabilities.md) 5.2.2、[09](./09_security_analysis.md)）。

### 6.1.4 Board（複数 Thread 一覧）

Board のスレ一覧も `Log`（メタ情報のアイテム列）。新規スレ作成 = メタ Log への publish。

```typescript
// web/src/lib/apps/bbs/BBSBoard.ts
export class BBSBoard {
  private metaLog: Log
  constructor(private board_key: Uint8Array, private board_id: string, private substrate: SubstrateContext) {
    const cap = new Capability(hkdf(board_key, "bbs_board_meta_v1", 32))
    this.metaLog = new Log(cap, substrate.slotStore, substrate.hintBus)
  }
  async listThreads(): Promise<ThreadMeta[]> {
    const items = await this.metaLog.fetchHistory(inferBoardRanges())
    return items.map(i => decodeThreadMeta(i.data))
  }
  async createThread(title: string, id: IIdentity): Promise<void> {
    await this.metaLog.publish(encodeThreadMeta({ thread_id: randomB36(10), title, creator: id.publicKey }))
  }
  subscribeThreads(handler: (t: ThreadMeta) => void): Subscription {
    return this.metaLog.subscribe(i => handler(decodeThreadMeta(i.data)))
  }
}
```

### 6.1.5 既存コードとの対応

| 既存ファイル | 移行先 |
|---|---|
| `BoardOrchestrator.ts` | `apps/bbs/BBSBoard.ts`（`Log` ベース） |
| `ThreadOrchestrator.ts` | `apps/bbs/BBSThread.ts`（`Log` + `OwnedPointer`） |
| `SyncProtocol.ts` | `Log.fetchHistory` / `Log.subscribe` |
| `DHTMailbox` の topic 蓄積 | IMMUTABLE 投稿スロット群 + バンドル |
| `PacketBuilder.ts` | 暗号化は `Log`(seal) に委譲、BBS 固有 wrapper のみ `BBSThread.buildPostData` |

### 6.1.6 速度評価（BBS）

| 操作 | 旧実装 | 新実装 |
|---|---|---|
| Post | ~175ms | ~175ms（1 PUT + 1 Hint） |
| ライブ新着 | （ポーリング/Gossip） | ~650ms（Hint→GET、リアルタイム化） |
| 過去ログ読み込み | ~250ms（※ ~130 post で破綻） | ~250-400ms（バンドル並列、**スケールする**） |

---

## 6.2 DM（Direct Messaging）

### 6.2.1 構成

```
DirectMessage
├── Log (send) ... 自分→相手（unlinkable, 署名あり）
├── Log (recv) ... 相手→自分（unlinkable）
└── KeyExchange ... X3DH 簡易版 or PSK
```

DM は **BBS と同じ `Log`**。違いは cap が 2 者限定・`unlinkable: true`・常に署名、の 3 点だけ。

### 6.2.2 鍵交換（X3DH 簡易版）

招待方式。完全な X3DH（ID Key + Signed PreKey + Onetime PreKey）は Phase 8（[12](./12_open_questions.md) Q11）。

```typescript
// Alice が招待を生成
const aliceEph = generateX25519KeyPair()
const invite = `aether://dm/invite/v1?epk=${b64(aliceEph.pub)}&id=${b64(aliceIdPub)}&sig=${b64(sigOverEpk)}`

// Bob が応答
const bobEph = generateX25519KeyPair()
const dh1 = X25519(bobEph.priv, aliceEph.pub)
const dh2 = X25519(bobIdPriv, aliceEph.pub)   // ID 鍵でクロス強化
const dh3 = X25519(bobEph.priv, aliceIdPub)
const shared = hkdf(concat(dh1, dh2, dh3), "dm_x3dh_lite_v1", 32)
// Bob → Alice に bobEph.pub + bobIdPub を返信（最初の Log メッセージに同梱）
```

派生:

```typescript
const capSend = new Capability(hkdf(shared, "dm_send_to_" + b64(peerPub), 32))
const capRecv = new Capability(hkdf(shared, "dm_recv_from_" + b64(peerPub), 32))
```

### 6.2.3 API

```typescript
// web/src/lib/apps/dm/DirectMessage.ts
export class DirectMessage {
  private send: Log
  private recv: Log
  constructor(private myId: IIdentity, private peerPub: Uint8Array,
              shared: Uint8Array, substrate: SubstrateContext) {
    const capSend = new Capability(hkdf(shared, "dm_send_to_" + b64(peerPub), 32))
    const capRecv = new Capability(hkdf(shared, "dm_recv_from_" + b64(peerPub), 32))
    this.send = new Log(capSend, substrate.slotStore, substrate.hintBus, { my_identity: myId, unlinkable: true })
    this.recv = new Log(capRecv, substrate.slotStore, substrate.hintBus, { unlinkable: true })
  }
  async sendText(text: string): Promise<void> {
    await this.send.publish(encodeMsgPack({ text, sent_at: Date.now() }))
  }
  subscribe(handler: (m: DMMessage) => void): Subscription {
    return this.recv.subscribe((item, from) => {
      const d = decodeMsgPack(item.data)
      handler({ text: d.text, sent_at: d.sent_at, from: from ?? new Uint8Array() })
    })
  }
}
export interface DMMessage { text: string; sent_at: number; from: Uint8Array }
```

### 6.2.4 速度・オフライン受信

| 操作 | コスト |
|---|---|
| Send | ~175ms |
| Receive | ~650ms（Hint→GET） |

オフライン受信: K-nearest が IMMUTABLE メッセージスロットを TTL 内保管。再接続時に `HINT_CATCHUP_REQ` で過去 Hint を補完 → slot_key → GET。

### 6.2.5 Burn-on-Read

DM メッセージは IMMUTABLE（上書き不可）なので、burn は **「送信者が短 TTL で初回設定」+「受信確認後に best-effort で K-nearest へ TTL 切れ扱いを要求」**で近似。完全削除は保証不能（[09](./09_security_analysis.md) T5）。

---

## 6.3 ファイル共有

### 6.3.1 構成

```
SharedFile
├── ChunkSet      ... ファイル本体（IMMUTABLE chunks）
├── OwnedPointer  ... current manifest 指標（可変ファイル）
└── (option) Log  ... コメント/メタデータ
```

### 6.3.2 不変ファイル（固定リンク）

```typescript
export class ImmutableFile {
  static async upload(data: Uint8Array, s: SubstrateContext): Promise<FileCapability> {
    const cap = new Capability(crypto.getRandomValues(new Uint8Array(32)))
    const manifest = await new ChunkSet(cap, s.slotStore).upload(data)
    return { root_secret: cap.toBytes(), manifest }
  }
  static async download(fc: FileCapability, s: SubstrateContext): Promise<Uint8Array> {
    return new ChunkSet(Capability.fromBytes(fc.root_secret), s.slotStore).download(fc.manifest)
  }
}
export interface FileCapability { root_secret: Uint8Array; manifest: ChunkManifest }
```

共有 URI: `aether://file/v1?cap=<b64(root_secret)>&mf=<b64(manifest)>`。大きい manifest は manifest 自体を ChunkSet 化して OwnedPointer で指す。

### 6.3.3 可変ファイル

```typescript
export class MutableFile {
  private head: OwnedPointer
  constructor(private cap: Capability, ownerPub: Uint8Array, private s: SubstrateContext) {
    this.head = new OwnedPointer(cap, ownerPub, s.slotStore, "file_head")
  }
  async upload(data: Uint8Array, signer: IIdentity, version: number): Promise<ChunkManifest> {
    const manifest = await new ChunkSet(this.cap, this.s.slotStore).upload(data)
    const mfKey = this.cap.deriveSlotKey("file_manifest_v_" + version)
    await this.putManifestImmutable(mfKey, manifest)          // IMMUTABLE
    await this.head.update(mfKey, version, undefined, signer) // OWNED_POINTER
    return manifest
  }
  async download(): Promise<{ data: Uint8Array; version: number }> {
    const h = await this.head.resolve()
    if (!h?.target_slot_key) throw new Error("no file")
    const mfSlot = await this.s.slotStore.get(h.target_slot_key)
    if (!mfSlot) throw new Error("manifest missing")
    const manifest = decodeManifest(open(this.cap.payloadKey, mfSlot.payload)!)
    const data = await new ChunkSet(this.cap, this.s.slotStore).download(manifest)
    return { data, version: /* h.version は OwnedPointer 検証済み */ 0 }
  }
}
```

### 6.3.4 速度

| 操作 | コスト |
|---|---|
| 1MB upload | ~1-3s | 1MB download | ~1s | 10MB upload | ~10-30s | 10MB download | ~5-10s |

---

## 6.4 グループチャット

### 6.4.1 構成

```
GroupChat
├── Log           ... メッセージ（allowed_writers で member 制限、署名必須）
├── OwnedPointer  ... member list 指標（admin が更新）
└── KeyRotation   ... 参加/離脱時の rekey
```

### 6.4.2 実装の骨子

```typescript
export class GroupChat {
  private log: Log
  private members: OwnedPointer
  constructor(groupSecret: Uint8Array, adminPub: Uint8Array, private myId: IIdentity, s: SubstrateContext) {
    const cap = new Capability(groupSecret)
    // member 制限は member list を解決して allowed_writers に渡す
    this.members = new OwnedPointer(cap, adminPub, s.slotStore, "members")
    this.log = new Log(cap, s.slotStore, s.hintBus, { my_identity: myId /* allowed_writers は動的設定 */ })
  }
  async send(text: string) { await this.log.publish(encodeMsgPack({ text, sent_at: Date.now() })) }
  async listMembers(): Promise<Uint8Array[]> {
    const p = await this.members.resolve()
    return p?.metadata ? decodeMembers(p.metadata) : []
  }
  // admin only
  async addMember(pub: Uint8Array, admin: IIdentity) { /* members.update */ }
  async removeMember(pub: Uint8Array, admin: IIdentity) { /* members.update + rotateKey */ }
  async rotateKey(admin: IIdentity): Promise<Uint8Array> { /* 新 groupSecret を旧 cap で配布 */ return new Uint8Array() }
}
```

rekey: 新 `group_secret_v2` を旧 cap の `Log` で配布。離脱 member は新 cap を得られず取り残される。退会前メッセージは rekey 後も復号可（forward secrecy なし、[09](./09_security_analysis.md) T4）。

---

## 6.5 pub-sub Topic

最小の application。`Log` そのもの。

```typescript
export class PubSubTopic {
  private log: Log
  constructor(topicSecret: Uint8Array, s: SubstrateContext) {
    this.log = new Log(new Capability(topicSecret), s.slotStore, s.hintBus)
  }
  publish(msg: Uint8Array) { return this.log.publish(msg) }
  subscribe(h: (msg: Uint8Array) => void): Subscription {
    return this.log.subscribe(item => h(item.data))
  }
}
```

---

## 6.6 Application 間の安全な共存

- **Capability 分離**: 各 app は独立 root_secret。1 つ流出しても波及しない
- **Storage 共有**（推奨）: 単一 `SlotStore` で全 app の Slot を担当（K-nearest 効率）
- **Hint cross-app cover**: 全 app の Hint が同じ Gossip 経路を混ざって流れ、どの app かさえ観測者には不明（セキュリティ的にプラス）
- **リソース**: Hint 購読数は数千 cap まで実用範囲（[08](./08_performance.md)）

---

## 6.7 Application 拡張ガイド

| 質問 | → 推奨 Capability |
|---|---|
| 1:N / 1:1 の追記列か？ | `Log`（共有 cap or 2 者 cap、unlinkable 切替） |
| 最新版を 1 人が更新するか？ | `OwnedPointer` |
| 大きな blob か？ | `ChunkSet` |
| 認証は？ | 匿名（writer 無し）/ 署名（writer_sig）/ allowlist（allowed_writers） |

新 app は `apps/<myapp>/` に上記を組み合わせるだけ。Layer 2-3 には触らない。

---

## 6.8 次に読む

→ [07_wire_protocol.md](./07_wire_protocol.md): 通信プロトコル
→ [09_security_analysis.md](./09_security_analysis.md): 各 application のセキュリティ評価
