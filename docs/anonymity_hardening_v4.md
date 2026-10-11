# AETHER Web-Lite 匿名性強化 (V4) — Schrödinger Mailbox 移行計画

> 前提文書:
> - `docs/security_hardening_v3.md` — Wire V3 でのセキュリティ強化 (完了)
> - `.docs/detailed_implementation/11_schrodinger_mailbox.md` — Schrödinger Mailbox 原設計
> - `.docs/detailed_implementation/18_winny_successor_revision.md` — §18.3-A / §18.4 / §18.5
> - `docs/substrate/04_layer2_primitives.md` §4.1.3 — SlotKey Mode A / Mode B

---

## 0. 背景 — なぜやるのか

Wire V3 でパケット層の穴は塞がったが、**Mailbox 層に匿名性の穴が 2 つ残っている。**
どちらもコードを読んで確認済み。

### 穴 1: GET が「何を読んでいるか」を平文で 5 人に渡す (受信者匿名性)

`web/src/lib/network/mailbox/DHTMailbox.ts:127` の `fetch()` は

1. `hashToPosition(topicHash)` でトピックをリング座標へ
2. `findKNearest(topicPos, 5)` でその座標に近い 5 人を選ぶ
3. 各人へ `sendDHTGet(targetId, topicHash, reqId)` (`:308`)

`topicHash` は平文、宛先は名指し、中継も被覆も無い。

そして `topicHash` は秘密ではない:

- VIP 板: `cryptoHash('AETHER_LITE_VIP_DEFAULT_SEED')` (`web/src/hooks/useBoard.ts:79`) から
  **誰でも計算できる**
- スレッド: `deriveThreadKey(boardKey, threadId)` → `deriveTopicHash()` なので、
  **板の鍵を持つ者(=その板に入った者、当然捜査側も含む)は全スレッドの topicHash を事前計算できる**

結果、GET を受けた 5 人は「この IP は今このスレを読んでいる」を直接知る。
Gossip 側で購読宣言を撤去して Broadcast Veil まで作った性質が、Mailbox 側で成立していない。

さらに悪いのは **問い合わせ先を自分で選べない** こと。K-nearest はトピック座標が決めるので、
狙った座標の近くに来る peerId をグラインドした者は、**そのトピックへの全 GET を受け取る立場を取れる**
(§18.5.3 が「現行案の最大の穴」と書いている位置グラインディングが、そのまま受信者特定に直結する)。

これは稀な経路ではない。`fullSync` が `activate` とピア接続時(デバウンス付き)に走るため、
**板を開くたび・スレを開くたびに発火する。**

### 穴 2: PUT が発信元を隠さない (送信者匿名性)

`DHTMailbox.ts:117-121` の `publish()` は K-nearest それぞれへ `sendDHTPut` を直接投げる。
中継なし、迂回なし。Gossip と違って「中継しただけかも」という否認可能性が無い。

しかも **保管者が板の参加者なら本体を復号できる。** 本文はスレ鍵で AEAD されており、
公開板ならその鍵は参加者全員が持つ。相関を取るまでもなく、手元に平文と相手の IP が揃う。

AETHER core はここを Onion で通している (`core/src/mailbox/schrodinger.rs:106`)。web-lite には無い。

---

## 1. 方針

### やること

| # | 対策 | 効く穴 | 出典 |
|---|---|---|---|
| A | **Schrödinger 化** — `mailbox_key = SHA256(random nonce)`、nonce は不透明な Hint で配る | 穴 1 | Part 11 / Mode B |
| B | **Hint 再放流** — 保持者が hint_blob を定期再投入 | A の副作用(過去ログ消失)を防ぐ + 一次放流者の情報量低下 | §18.3-A |
| C | **PUT を Dandelion stem に載せる** | 穴 2 | (本計画) |
| D | **PUT / Hint の時間分離** | エンベロープ相関 | §18.4.5 |

### やらないこと (今回のスコープ外)

- **3-hop Onion / Inbound Tunnel の TS 移植** — 経路多様性が要る。degree 2 では回路が組めない。
  ビット互換の暗号実装をもう一組抱える負債も大きい (Wire V3 の固定ベクタ作業が回路分増える)
- **ブラウザをシンクライアント化して Rust ノード経由にする構成** — 製品判断が要る。
  ゼロインストールという web-lite の存在意義とのトレードオフ
- **交差攻撃対策** — `docs/substrate/02_threat_model.md` §2.2.6 が明示的に OUT OF SCOPE
- **直接ピアへの IP 露出** — WebRTC の構造的性質。上の 2 つのどちらかを選ばない限り解けない

### 設計上の要点

**Onion の層状暗号は不要。** Onion が層を重ねるのは「最終宛先を途中のホップに隠す」ためだが、
Schrödinger 化後の宛先 `mailbox_key` はランダムな 32 バイトで、非参加者には何も指していない。
本文も既に封印済み。したがって **素の多段中継で目的の性質(発信元と内容の紐付けを切る)がほぼ取れる。**
これが C を Onion ではなく既存の Dandelion stem で済ませられる根拠。

---

## 2. 全フェーズを貫く制約

### 2.1 ワイヤ変更は必ず TS / Rust 同時 + 固定ベクタ

フェーズ 3 の `missing field stemTtl` (全 STEM が 1 通も復号できなかった) を繰り返さない。
ワイヤに触る変更は必ず以下をセットで行う:

1. `web/src/lib/...` (TS)
2. `aether-cache/src/...` (Rust)
3. `web/tests/vectors/generate.ts` → `interop_vectors.json` 再生成
4. `aether-cache/tests/wire_interop.rs` (TS→Rust) と `web/tests/network/WireInterop.test.ts` (Rust→TS) の両方向

### 2.2 ノードを跨ぐテストを必ず書く

単体ノードのテストだけでは「Stem が発信元へ戻って死ぬ」型の欠陥が丸ごと素通しになる
(実際 v3 で 3 回真因を外した)。`web/tests/network/ZoneGossipRouter.test.ts` の
`buildMesh()` パターン(複数ノードを実際に配線して回す)を各フェーズで使う。

### 2.3 匿名性の回帰テストを書く

「配信されるか」だけを見ていると匿名性を壊す修正が素通りする。
v3 で追加した以下の形を踏襲する:

- 観測可能な振る舞いが内部状態から独立していること
- 分布で検証すること (例: Fluff 地点が発信元に偏らない)

---

## 3. Phase 0 — 地ならし (ワイヤ変更なし) ✅ 完了

**目的**: 後続フェーズのレイテンシ増を先に相殺し、計測と検証の土台を作る。

| # | タスク | 状態 |
|---|---|---|
| 0.1 | `fetch()` を「最初の応答 + 猶予」で確定する形に変更 | ✅ |
| 0.2 | ログ基盤 (`Logger.ts`) の導入と全 `console.*` の移行 | ✅ |
| 0.3 | `LiveRender.test.tsx` の jsdom + libsodium 互換性エラー解消 | ✅ |

### 0.1 fetch が最遅のピアを待たない

旧実装は `responsesReceived >= expectedResponses` で K=5 **全員**の応答を待って
おり、1 台でも遅い/落ちていると 4 秒のハードタイムアウトまで引きずられていた。
`08_performance.md` の SLOT_GET 設計値 (~250ms、最初の応答で返す) から乖離していた。

最初の応答が来たら `FETCH_GRACE_MS`(300ms) だけ猶予を置いて確定する。
猶予を置くのは、ほぼ同時に返る他の応答を取りこぼさないため
(保管状況にズレがあると件数が変わる)。誰も応答しなければ従来どおり 4 秒で打ち切る。

回帰テスト: `tests/network/DHTMailbox.test.ts` の
「★1 人でも応答すれば、残りの沈黙を 4 秒待たずに確定する」。
旧挙動へ差し戻すと 4002ms かかって失敗することを確認済み。

### 0.2 ログ基盤 (`web/src/lib/common/Logger.ts`)

`console.*` の直接呼び出しを全廃 (`src/` 配下 0 件) し、スコープ付きの
レベル制御ロガーへ移行した。**匿名性を扱う実装では、デバッグ出力そのものが
経路情報の漏洩源になる**ため、レベルで落とせる形にすることが前提条件になる。

```ts
const log = createLogger('net.gossip');
log.info('peer connected', peerId);
log.trace(() => `expensive ${JSON.stringify(packet)}`);   // 遅延評価
```

**レベル**: `SILENT(0) / ERROR / WARN / INFO / DEBUG / TRACE(5)`。
既定は開発 `INFO`、本番 `WARN`。

**スコープ**: ドット区切りで親を継承する (`net.mailbox` → `net` → `*`)。

| スコープ | 対象 |
|---|---|
| `net.dispatch` | MessageDispatcher (全受信メッセージが通る最ホットパス) |
| `net.gossip` / `net.dandelion` | ZoneGossipRouter / DandelionRouter |
| `net.mailbox` / `net.replication` / `net.sync` | DHT Mailbox 系 |
| `net.peer` / `net.webrtc` / `net.signaling` / `net.ring` / `net.pex` | 接続管理 |
| `net.validator` | PacketValidator |
| `logic.board` / `logic.thread` / `logic.dag` | オーケストレータ |
| `crypto.*` / `worker.bridge` / `p2p` | その他 |
| `ui.board` / `ui.thread` | フック + ビュー (レンダー回数の追跡) |

**実行中の切り替え** (ブラウザのコンソール。再読み込み不要、`localStorage` に永続化):

```js
aetherLog.set('net.gossip', 'trace')   // このスコープだけ TRACE
aetherLog.set('*', 'debug')            // 全体の既定
aetherLog.show()                       // 現在の設定
aetherLog.reset()
```

**起動時の指定**: ブラウザ `localStorage.aether_log = "*=info,net.gossip=trace"` /
Node・テスト `AETHER_LOG="*=warn,net.mailbox=trace"`

**Rust 側 (`aether-cache`)** は `tracing` の `EnvFilter` が同じ役割を果たす。
スコープ名の対応は `aether-cache/src/main.rs` のコメント参照:

```
RUST_LOG=aether_cache::gossip=trace
RUST_LOG=info,aether_cache::mailbox=debug
```

#### 設計上の要点

- **遅延評価**: 引数に関数を渡すと、レベルが届かない限り呼ばれない。
  Gossip 受信は 1 パケットごとに走るため、テンプレートリテラルの構築コストを
  払わないことが効く。`log.enabled(LogLevel.TRACE)` で事前判定もできる
- **経路情報は TRACE 止まり**: Stem の転送先 peerId は経路情報そのもの。
  既定レベルで出していると、コンソールを見られるだけで経路が割れる。
  TS 側 `net.gossip` の `STEM decision=... target=...` と
  Rust 側 `Stem forwarding` はどちらも TRACE に置いてある
- **`info` は状態変化だけ**: パケット毎に出るものは `debug` 以下。
  ここを守らないと実網のログが読めない量になる (Rust 側も同方針で調整済み)

### 0.3 jsdom + libsodium のレルム跨ぎ

`LiveRender.test.tsx` が `TypeError: unsupported input type for message` で
起動すらしていなかった。原因は **Uint8Array のレルム不一致**:

```
jsdom 環境では globalThis.Uint8Array が jsdom のものに差し替わる一方、
TextEncoder は (jsdom 由来でも node:util 由来でも) Node レルムの Uint8Array を返す

  new TextEncoder().encode(s) instanceof Uint8Array  → false
  → libsodium の入力型チェックが落ちる
```

以前入れていた「`node:util` のものに揃える」対処は**逆方向で、効いていなかった**
(実測で jsdom 由来・node:util 由来のどちらも現行レルムの `instanceof` を通らないことを確認)。

`tests/setup.ts` で、出力を現行レルムの `Uint8Array` へコピーして返すよう包んだ。
本番コードには一切手を入れていない。これで React 描画の 8 件が通るようになった。

**完了条件**: 全テスト green (TS 288 件 / Rust 111 件)。

---

## 4. Phase 1 — Hint プリミティブ (ワイヤ変更 #1) ✅ 完了

**目的**: Hint の配送機構だけを先に入れ、**まだストレージには繋がない。**
実網で機構を検証してから Phase 2 で切り替える。

| # | タスク | 状態 |
|---|---|---|
| 1.1 | `HintPacket` / `HintPayload` の型と符号化 (TS + Rust) | ✅ |
| 1.2 | 鍵導出 (`hint_key` / `blind_tag`) | ✅ |
| 1.3 | Hint の PoW (`sealHintPow` / `verifyHintPow`) | ✅ |
| 1.4 | 受信側の試行復号 | ✅ |
| 1.5 | `WireType.HINT` (0x42) と Broadcast Veil への搭載 | ✅ |
| 1.6 | 相互運用ベクタ (双方向) | ✅ |
| 1.7 | メッシュテスト | ✅ |

### 追加したもの

| ファイル | 役割 |
|---|---|
| `web/src/lib/network/hint/HintPacket.ts` | 型・プリイメージ・`id()`・PoW・`parseHintPacket` |
| `web/src/lib/network/hint/HintCrypto.ts` | 鍵導出・`blind_tag`・封印/開封・`mailbox_key` 導出 |
| `web/src/lib/network/hint/HintRouter.ts` | Broadcast Veil への搭載・中継・試行復号 |
| `aether-cache/src/protocol/hint.rs` | 形式検証・`id()`・PoW 検証 (**復号はしない**) |

### ★ Rust 側は Hint を復号しない

キャッシュノードは板/スレッドの鍵を持たない。本体は
`mailbox_key = SHA256(random nonce)` の下にあり、その nonce は Hint の
暗号文の中にある。したがって Rust に必要なのは

1. ワイヤ形式の符号化・復号
2. `id()` の計算 (重複排除)
3. PoW の検証 (フラッド対策)
4. 中継

だけで、**HMAC も AEAD も要らない**。鍵の導出と試行復号はブラウザ側の責務。
これにより Rust 側の実装面積が大きく減り、両実装を一致させる負担も下がった。

### ワイヤ形式

```
version    : u8       (1)
ttl        : u8       中継で 1 ずつ減る
blind_tag  : 4 bytes  HMAC(K, nonce)[0:4] — 鍵が無ければ乱数
nonce      : 12 bytes ChaCha20-Poly1305 の nonce
pow_nonce  : u64      PoW 解
ciphertext : 64 bytes 平文 48 + Poly1305 タグ 16 (**固定長**)
```

平文 48 バイト = `nonce(32) ‖ u64be(message_id) ‖ u64be(timestamp)`。

**鍵無しで読める情報が一つも無い**。`ciphertext` を固定長にしてあるのは、
サイズだけで中身を推測される余地を消すため。

### id の設計 (`ttl` と `pow_nonce` を除外)

```
preimage = "AETHER/v3/hint__"(16) ‖ version ‖ blind_tag ‖ nonce ‖ u32be(len) ‖ ciphertext
id       = SHA256(preimage)
powHash  = SHA256(preimage ‖ u64be(pow_nonce))
```

- `ttl` は中継のたびに変わる。含めると同一 Hint が別物として扱われ、
  重複排除をすり抜けて無限に再フラッドできる
- `pow_nonce` は探索変数。含めると、攻撃者が同じ中身に対して別の有効な解を
  見つけるだけで「別の Hint」として再フラッドできる

### 鍵源 (§18.4.2「鍵源だけを差し替える」)

```
hint_key  = HMAC(K, "aether_hint_v1")     AEAD 用。K とは分ける
blind_tag = HMAC(K, hint_nonce)[0:4]      受信側が再計算して当たりを絞る
```

web-lite は公開モードなので `K = threadKey`(既存の `deriveThreadKey` の出力)。
`blind_tag` が **nonce ごとに変わる**のが要点で、固定値だと
「同じ tag = 同じ宛先」として長期観測で束ねられる。

4 バイトなので 2^-32 で偶然一致する。**必ず AEAD の復号まで通してから受理する。**

### 実装中に見つかったこと

**`originate()` が自分の Hint を 1 通も送出していなかった。**
`flood()` を呼ぶ前に `flooded` へ登録しており、`flood()` 冒頭の
「中継済みなら何もしない」で即 return していた。
ZoneGossipRouter で潰した `seenCache` 二重判定と**まったく同じ形**の罠。

単体テストは全て通っており、**3 ノードのメッシュテストだけが捕まえた**
(§2.2 がこの型の欠陥を想定して書かれていた通りの結果)。

**Rust の serde タグがずれた。** 挿入位置の都合で `#[serde(rename = "stem")]`
が `Hint` に付き、`Stem` が無名 (既定の `"Stem"`) になっていた。
ワイヤタグが壊れる箇所だが、**相互運用ベクタが即座に検出した**。

### 検証

- **TS→Rust**: Rust が TS の作った Hint を読み、**`id()` が 1 ビットも違わないこと**と
  TS が解いた PoW を受理することを確認 (`decodes_hint_from_typescript`)
- **Rust→TS**: TS が Rust の符号化した Hint を `parseHintPacket` で固め、
  `id()` の一致と PoW を確認
- **メッシュ**: 3 ノードで発信 → 全ノード到達、
  **鍵を持たないノードも中継に加わる**(被覆になる)、有限ステップで収束
- **Broadcast Veil**: 開けた場合と開けなかった場合で外から観測できる送信が同一であること

TS 344 件 / Rust 119 件 通過、`tsc --noEmit` 通過、`cargo clippy --all-targets` 警告 0。

### Phase 1 完了時点で残していた TODO → **解消済み**

`HintRouter.originate()` を直接 flood のままにしていたが、
「TODO は忘れるので残さない」方針により Phase 2 の前に解消した。
詳細は次節。

---

## 5. Phase 2+3 — Schrödinger 化と Hint 再放流 ✅ 完了

> **2 と 3 は同時に出した。** Schrödinger 化だけを入れると、Hint を受け取れなかった者は
> mailbox_key を永久に計算できず、**後から参加した人が過去ログを一切発見できなくなる。**

### 5.0 先に片付けた: Hint 発信の Stem 化 (旧 Phase 4 の一部)

Phase 2 で Hint が `mailbox_key` を運び始めると、発信元が割れることは
「誰がその投稿を書いたか」が割れることと同じになる。**Phase 2 の前提条件**なので先に実施した。

そのために **DandelionRouter をペイロード非依存に一般化**した:

| 追加 API | 役割 |
|---|---|
| `publishVia(id, send, useDandelion)` | 経路判断 (相手選び・エポック・再送・エコー待ち) だけを担い、ワイヤ形式は呼び出し側が `send` で決める |
| `decideStem(senderId)` | 中継の判断だけ。ペイロードを一切見ない |

既存の `publish()` / `handleStemPacket()` はこれらへの薄いラッパになった
(**Gossip 側のテスト 32 件は 1 行も変えずに通過**)。
この一般化は Phase 4 (PUT の stem 化) でもそのまま使える。

**`WireType.HINT_STEM` (0x43)** を追加し、TS/Rust 両方で中継を実装。

★ **DandelionRouter は Gossip と Hint で共有する。**
別インスタンスにするとエポック対象が 2 つになり、観測者に渡す辺が 1 本増えて
§3.1 の前提 (作者パケットと中継パケットが同じ宛先へ行くので区別できない) が崩れる。
`P2PProvider` で 1 つ作って両方に渡し、`ZoneGossipRouter` の第 4 引数で受け取る。

### 5.1 Schrödinger 化

```
従来:  mailbox_key = SHA256(boardKey)      板ごとに固定・誰でも計算可能
現在:  mailbox_key = SHA256(random nonce)  投稿ごとにランダム
```

`DHTMailbox` は元から 32 バイト鍵に対して汎用だったため**変更不要**だった。
変わったのは呼び出し側で、`SchrodingerMailbox` が間に入る。

得られる性質:

- GET が指すのはランダム値。受け取った側は何を要求されたのか分からない
- **板ごとの固定座標が消えるので位置グラインディングによる張り込みが成立しない。**
  攻撃者は鍵空間全体を覆わない限り観測できず、O(1) の攻撃が O(N) になる
- 残るのは「同じ Hint を復号できた参加者が、たまたまそのランダム鍵の
  K-nearest に居た場合」だけ。狙い撃ちはできず、捕まるのは K/N のランダム標本

### 5.2 本体と索引を同じ Slot に入れる (`SlotBlob`)

```
Slot = u32be(hintLen) ‖ hint_blob ‖ body_blob
```

保持者は `hint_blob` を**復号できない**が、バイト列としてそのまま
Gossip へ再投入できる。`extractHint()` は本体に一切触れないので、
「保持者が中身を読めない」性質はそのまま保たれる。

### 5.3 Hint 再放流

`SchrodingerMailbox.refloodDue()` が、保管中の Slot から索引だけを取り出して撒き直す。

**送出タイミングは `mailbox_key` から決定論的に導出する** (§18.3-A)。
K 個の保持者が同一時間窓で送出するので、受け手の SeenCache が同一 id として
畳み、帯域が K 倍にならない。

★ **再放流は Stem を通さない。** 保持者は発信元ではないので隠すものが無く、
むしろ「コンテンツと無関係なランダムな保持者が流している」ことそのものが
一次放流者の情報量を下げる。Winny の主要検挙経路だった
「新規キーの初出ノード = 一次放流者」は t=0 の一瞬しか観測機会がなく、
再放流が始まると成立しなくなる。

#### ★ 実装中に見つかった制約: 周期 > SeenCache の TTL

Hint の id は中身から決まるので、**再放流の周期が受け手の重複排除 TTL (15分) より
短いと、2 回目以降が 1 ホップも進まない。** それでは
「後から参加した人が過去ログを発見できる」という目的そのものを果たせない。

`REFLOOD_PERIOD_MS = 20分` とし、`SeenCache.TTL_MS` を公開して
**不変条件をテストで固定した** (`再放流の周期は SeenCache の TTL より長い`)。

### 追加したもの

| ファイル | 役割 |
|---|---|
| `web/src/lib/network/hint/SlotBlob.ts` | `hint_blob ‖ body_blob` の符号化。索引だけの取り出し |
| `web/src/lib/network/hint/SchrodingerMailbox.ts` | ランダム Slot への保管・Hint 駆動の取得・再放流 |
| `DHTMailbox.storedKeys()` / `.stored()` | 再放流のために自分の保管内容を列挙する (中身は読まない) |
| `HintRouter.reflood()` | Stem を通さない再放流 |

### 5.4 オーケストレータの配線

`BoardOrchestrator` / `ThreadOrchestrator` を新経路へ切り替えた。
`schrodinger` は**必須引数**にしてある —— 省略可にすると渡し忘れたときに
新しい保管経路が黙って無効化され、「動いているように見えて匿名性が無い」
状態になるため。

| 旧 | 新 |
|---|---|
| `mailbox.publish(SHA512(boardKey), body)` | `schrodinger.publish(boardKey, body, id)` |
| `mailbox.fetch(SHA512(boardKey))` で一括取得 | Hint 駆動 (`onBody`) |
| — | `activate` で `addKey('board:<id>', boardKey)` |

### 5.5 履歴が届くまでの経路 (実装中に見つかった 3 つの穴)

Schrödinger 化すると「板の過去ログを一括 fetch」が**原理的に消える**
(mailbox_key が投稿ごとにランダムなので、まとめて引く鍵が無い)。
素直に切り替えると履歴が再放流待ち = 最大 20 分になってしまう。
3 つ塞いだ。

**(a) 鍵を持つ前に届いた Hint が失われる**

Broadcast Veil で全 Hint は常に流れてくるが、その時点で鍵が無ければ開けない。
後から板を開いた瞬間、既に流れ終わった Hint は二度と来ない。

→ `HintRouter` が**開けなかった Hint を不透明なまま手元に残し**
(`RECENT_HINT_BUFFER = 2000`)、`addKey()` で開き直す。
中身は復号していないので、持つこと自体は何も意味しない。

**(b) 参加直後に何も見えない**

→ 接続時に、自分が保管している Hint を相手へ push する
(`sendBacklogTo`, 上限 200)。

★ これは購読宣言にならない。送るのは「自分が持っている Hint 全部」で、
相手の興味を聞いていないし、こちらの興味も現れない
(保管物は K-nearest の抽選で降ってきたもので、自分の興味と無相関 —— §18.3-C)。
要求のやり取り自体が観測点になるので、**要求を待たずに送る**。

**(c) 手元にある本体のために GET を出していた**

→ `fetchBody` は先にローカルを見る。Slot は内容アドレス指定で不変なので、
持っているものが正しいものだと確定する。
**ネットワークに問い合わせない = その Slot に興味があることを誰にも見せない。**
速度と匿名性が同じ方向を向く数少ない場所。

### 検証

TS 372 件 / Rust 119 件 通過、`tsc --noEmit` 通過、`cargo clippy --all-targets` 警告 0。
相互運用ベクタは `hint` / `hintStem` の両方を双方向で固定。

**旧経路が消えたことを直接固定するテストを 5 件追加した** (`★固定 topicHash による漏洩経路の消滅`)。
「新経路が動く」だけを見ていると、旧経路が並存したまま漏れ続けていても気付けない。
旧コードへ差し戻すと実際に落ちることを確認済み。

**ソースツリーの TODO は 0 件**(方針: 忘れるので残さない)。

---

## 6. Phase 4 — PUT を Dandelion stem に載せる (送信者匿名性) ✅ 完了

**目的**: 穴 2。保管者が見る IP を発信元のものではなくす。

### 変更内容

`DHTMailbox.publish()` は直接 K-nearest へ投げるのをやめ、**Stem に載せる**。
数ホップ運ばれ、**最後のホップが発信元の代わりに K-nearest へ置く**。
保管者が見る IP は最終ホップのもので、そのノード自身も
「自分が発信したのか中継したのか」を区別されない。

`WireType.DHT_PUT_STEM` (0x53) を追加し、TS/Rust 両方で中継を実装。
`dandelion` は `DHTMailbox` の**必須引数**にしてある
(省略可にすると渡し忘れで直接 PUT へ落ち、「動いているように見えて発信元が丸見え」になる)。

★ **層状暗号 (Onion) は要らない。** Onion が層を重ねるのは最終宛先を途中の
ホップに隠すためだが、Schrödinger 化後の宛先 `topicHash` はランダムな 32 バイトで
非参加者には何も指していない。本体も既に封印済み。したがって素の多段中継で
目的の性質 (発信元と内容の紐付けを切る) がほぼ取れる。

Rust 側の実行地点は「全隣人へ `DhtPut` を撒く」形にした。受け取った側が
それぞれ K-nearest 帰属検証を通すので、担当外は自分で弾く。

### 実装中に見つかったこと

**(a) 発信時に確率 Fluff を引いてはいけない**

`decideStem()` をそのまま使うと、30% の確率で**発信元自身が実行地点**になり、
Stem に載せた意味が丸ごと消える。中継者の判断と発信の判断は別物なので、
`pickOriginTarget()` を分けた (必ず転送する)。

**(b) Stem 先が未検証・切断中でも選ばれていた**

Gossip の Stem はエコー再送で復帰できるが、**PUT には再送が無い**ため、
死んだ相手を選ぶとそこでデータが失われる。
`pickOriginTarget()` を検証済み・接続中に限定した。

**(c) ★ `WireCodec` が WireType の範囲をハードコードしていた**

decode が `0x10 <= t <= 0x52` と書かれており、**範囲外に WireType を足した
瞬間に無言で JSON フォールバックへ落ちて「送っているのに相手が一切受け取らない」**
という壊れ方をした。`DHT_PUT_STEM = 0x53` がちょうど範囲外だった。

症状が送信側に出ないため、実網でしか気付けない類の欠陥。
既知の WireType 集合そのもので判定する形に直し、
**「定義済みの全 WireType が decode で正しく識別される」テストを追加**して
同じ壊れ方を二度としないよう固定した。

### 検証

TS 381 件 / Rust 120 件 通過。相互運用ベクタに `dhtPutStem` を追加。

Stem に関する回帰テスト:
- publish が直接 PUT せず Stem に載せる / Stem は 1 人にだけ送る
- 最終ホップが発信元の代わりに K-nearest へ置く
- 転送時は書き換えない / 送り主に返さない
- PoW を満たさないエントリは運ばない (増幅器にならない)
- 隣人が居なければ自分で置く (届かないより匿名性が下がる方がまし)

---

## 7. Phase 5 — PUT / Hint の時間分離 (§18.4.5) ✅ 完了

**目的**: PUT と Hint が同時に出ると、両方を観測できる位置にいる者に

```
ガードが見るもの : 「この IP が時刻 T まで D 秒間アップロードしていた」
全ノードが見るもの: 「時刻 T+ε に Hint が現れた」
```

で紐づけられる。**Hint の出現時刻は Broadcast Veil で全員に見える**ため、
出口を押さえなくても成立する。Hint の中身が不透明でも、この相関は
中身を必要としない。

### 実装 (`web/src/lib/network/hint/HintRelease.ts`)

遅延量は観測量から逆算する (「数分〜数十分」のような根拠のない値は使わない):

```
匿名集合から  : W1 = 目標件数 / 観測 Hint レート
エンベロープから: W2 = 10 × 送出所要時間
待てる上限    : patience = max(60秒, 2 × 送出所要時間)
W = min( max(W1, W2), patience )
```

**観測 Hint レートは Broadcast Veil のおかげでローカルで直接測れる**
(全 Hint が自分に届くため)。他の設計では得られない性質。

| モード | 用途 |
|---|---|
| `disabled` | ネットワーク構築中。一切遅延しない |
| `adaptive` (既定) | 待てる範囲で待つ。**網が育つと自動的に効き始める** |
| `strict` | 使用感より秘匿を優先。目標に届かなくても待つ |

### ★ ブートストラップ期の扱い (最重要)

素朴に実装すると **「網が小さいほど長く待つ」という完全に逆の挙動**になる。
観測レートが 0 なら必要窓は無限大に発散し、上限まで待たされる。
**しかも待っても匿名集合は生まれない。** 利益ゼロのコストを、最も離脱されやすい
立ち上げ期に払わせることになり、**網が育つ経路そのものを塞ぐ**。

→ `adaptive` では、待って得られる匿名集合が測定可能な水準
(`MIN_MEASURABLE_SET = 2`) に達しないなら遅延しない。

テストで固定してある:
- 観測レート 0 なら待たない
- レートが低すぎる間も待たない
- 網が育つと自動的に効き始める
- `strict` は届かなくても待つ

### ★ 小さい送信には要らない

この相関は PUT が観測可能なエンベロープを作る場合にしか成立しない。
定常の中継トラフィックより十分小さい送信は、自分が常時流している雑音に沈む。

```
定常中継 1Mbps = 125 KB/s → 埋もれる上限 約 1MB (8秒ぶん)
チャット1通 約10KB  → 中継 0.08秒ぶん。遅延不要
```

**リアルタイムチャットに遅延は入らない** (全レート帯でテスト済み)。

### ★ 中継していないと何も埋もれない

`relayThroughputBps = 0` なら noise floor も 0 になり、どんな小さな送信も
遅延対象になる。**中継しないほど自分の送信が目立つ**という関係が式にそのまま出る。
これもテストで固定した。

### ★ 「なぜその待ち時間になったか」を必ず返す

**匿名性の強度が黙って変わるのが一番まずい。** `ReleaseStatus` が
待ち時間・理由・観測レート・中継量・期待できる匿名集合・目標到達の可否を返す。
全モードで `reason` が空でないことをテストで固定してある。

### 検証

TS 403 件 / Rust 120 件 通過。

---

## 8. 実績

| Phase | 内容 | 状態 |
|---|---|---|
| 0 | 地ならし (ログ基盤 / fetch / jsdom) | ✅ |
| 1 | Hint プリミティブ | ✅ |
| 2+3 | Schrödinger 化 + 再放流 + オーケストレータ配線 | ✅ |
| 4 | PUT の stem 化 | ✅ |
| 5 | 時間分離 | ✅ |

**TS 413 件 / Rust 122 件 通過**、`tsc --noEmit` 通過、
`cargo clippy --all-targets` 警告 0、**ソースツリーの TODO 0 件**。

### 追加した WireType

| 型 | 用途 |
|---|---|
| `HINT` (0x42) | Schrödinger Mailbox の索引 (Broadcast Veil で全員へ) |
| `HINT_STEM` (0x43) | Hint の発信を隠す Stem フェーズ |
| `DHT_PUT_STEM` (0x53) | PUT の発信を隠す Stem フェーズ |

すべて相互運用ベクタで双方向に固定してある。

## 8.5 実網ログで発覚した 3 件 (Phase 5 後)

どちらもテストが全通過している状態で、**実網でしか出なかった**。

### (a) ★ Slot が受信側の検証で全部捨てられていた

実網ログ:

```
[DHT] PUT from 7297a5d5: dropped 1 invalid entries (Some(NotJson))
[net.mailbox] PUT from 7297a5d5: dropped invalid entries (not-jsonx1)
```

`checkEntry` / `check_entry` はエントリを **JSON 化された GossipPacket** として
解釈するが、Schrödinger 化後の Slot は `u32be(hintLen) ‖ hint_blob ‖ body_blob`
というバイナリのエンベロープ。素の JSON として読もうとして必ず失敗していた。

**結果として Schrödinger の PUT が一件も保管されず、履歴が完全に死んでいた。**

なぜテストで出なかったか: 単体テストでは K-nearest に自分が入るため
`putToKNearest` がローカルへ直接書き、**受信側の `handlePut` を通らない**。
検証は受信側にしかないので、ノードを跨がない限り発火しない。

対策:
- `checkEntry` / `check_entry` が Slot 形式を先に試し、
  **索引の PoW を検証してから本体を通常のパケットとして検証する**
  (索引を素通しにすると、本体だけ正しい Slot を大量に作って索引をフラッドできる)
- **ノードを跨いだ Slot 保管の e2e テストを追加**した。
  修正前のコードで実際に落ちることを確認済み
- 相互運用ベクタに `dhtPutSlot` を追加し、TS が作った Slot を Rust が
  受理することを固定した

### (b) ★ スレッド側に固定 topicHash の GET が残っていた

`SyncProtocol.syncThread()` が `deriveTopicHash(threadKey)` で GET しており、
`ThreadOrchestrator.runFullSync` から呼ばれ続けていた。

板側は Phase 2 で塞いだが、**スレッド側は SyncProtocol 経由で漏洩したまま**
だった。その座標はスレッド鍵を持つ者なら誰でも計算できるので、
受けた K 人に「この IP はこのスレを読んでいる」が直接渡る。

Phase 2 で追加した回帰テストは板の GET と**スレッドの PUT** は見ていたが、
**スレッドの GET** を見ていなかった。テストの穴がそのまま実装の穴だった。

対策: 呼び出しを撤去し、`★スレを開いても固定 topicHash へ GET しない` を追加。

### (c) ★ 複製で届いた Slot の索引を、その場で開いていなかった

実網ログ:

```
[net.mailbox] stored 1 entries for 78188a9c from 537691ba (slot=true)
[net.mailbox] stored 27 entries for 7e99d636 from 537691ba (slot=false)
```

`slot=true` で保管はできている。だが `HINT opened` も `hint -> body ok` も
**一行も出ていない**。つまり本体は手元に届いているのに、
同じバイト列の中に同梱されている索引を誰も開こうとしていなかった。

原因は経路の非対称性:

- `WireType.HINT` で**索引として**届いた Hint → `HintRouter` が開く
- DHT 複製 (`handlePut` / `handleRes`) で**本体として**届いた Slot
  → `store.put` するだけで終わり

Slot は §18.3-A の定義どおり `u32be(hintLen) ‖ hint_blob ‖ body_blob` で、
索引を**内包している**。保管者が索引を持ち歩けるのはそのためだ。
にもかかわらず、保管経路から索引を取り出す線が引かれていなかった。

実害: HINT のフラッドを取りこぼしたノード (後から参加した、Stem が
自分を通らなかった、`SeenCache` の TTL を跨いだ) は、本体を持っているのに
**永久に描画できない**。新規参加者ほど確実に踏む。

対策:
- `DHTMailbox.onSlotStored(cb)` を追加し、`handlePut` / `handleRes` の
  `store.put` 直後に発火させる
- `SchrodingerMailbox` が購読し、`extractHint(entry) → HintRouter.ingestLocal()`
- `ingestLocal` は **PoW 検証 → 記憶 → 開封のみで、中継はしない**。
  複製で届いたものを再フラッドすると、本体の配信と索引の配信が二重になる
- 回帰テスト 3 本 (`tests/hint/SchrodingerMailbox.test.ts`):
  複製で届いた Slot が即座に本体として通知される / 鍵を持たない Slot は
  開かない / ローカル取り込みは再フラッドしない。
  購読を外すと 1 本目が落ちることを確認済み

なぜテストで出なかったか: (a) と同じ形。単体テストは自分で publish して
自分で開くので、**「本体だけが複製で降ってくる」状況を作っていなかった**。

### 教訓

「新経路が動く」テストは両方通っていた。足りなかったのは

1. **ノードを跨いだ経路のテスト** (検証は受信側にしかない)
2. **旧経路が消えたことを、PUT と GET の両方向で確認するテスト**
3. **「自分で作っていないデータが降ってくる」テスト** —— publish した本人は
   全部を手元に持っているので、取りこぼしたノードの視点が再現されない

---

## 9. 完了後に残る既知の穴 (明示)

| 残る穴 | 理由 |
|---|---|
| **直接ピアへの IP 露出** | WebRTC は IP を隠さず交換する (`WebRTCPeer.ts:64` の STUN、`:90` の candidate 送出)。TURN 未設定で全接続が直結。捜査側がノードを 1 台立てて接続すればその時点で IP が得られる。トラッカーも鯖ログも経由しない |
| **交差攻撃** | `02_threat_model.md` §2.2.6 で OUT OF SCOPE。トリップ (`trip_pubkey`) は投稿をまたぐ永続識別子であり、この攻撃の入力を製品機能として供給している |
| **シグナリングトラッカー** | 誰がいつオンラインかと IP を一箇所で見る。Winny には存在しなかった単一の令状執行先。分散化で希釈できるが消えはしない |
| **母数** | 匿名性は群衆の性質であってコードの性質ではない。3 ノードでは何をやってもゼロ |
| **公開モードの索引** | キーワード空間は辞書攻撃可能。公開検索可能性と両立しない原理的トレードオフ (§18.4.3 が自認) |

**この 5 つのうち上 3 つは、web-lite をブラウザ完全ピアとして運用する限り解けない。**
解くには §1「やらないこと」で挙げた「Rust ノードを実ピアにしてブラウザをシンクライアント化」
が必要で、それはゼロインストールとのトレードオフになる。
