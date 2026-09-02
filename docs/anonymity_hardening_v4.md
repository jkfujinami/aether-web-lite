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

## 3. Phase 0 — 地ならし (ワイヤ変更なし)

**目的**: 後続フェーズのレイテンシ増を先に相殺し、計測と検証の土台を作る。

| # | タスク | 見積 |
|---|---|---|
| 0.1 | `fetch()` を「最初の応答で返す」に変更 (`DHTMailbox.ts:168`)。現状は K=5 全員を待っており最遅に引きずられる。`08_performance.md` の SLOT_GET 設計値も「最初の応答で返す(4s タイムアウト)」 | 0.5d |
| 0.2 | `[TRACE:*]` ログの撤去 (または `debug` フラグ化)。`[Dandelion] Stemming packet X to Y` が Stem 先 peerId を出力している点も併せて | 0.5d |
| 0.3 | `web/tests/ui/LiveRender.test.tsx` の jsdom + libsodium 互換性エラーを解消。**未解決のまま。** 解けない場合はテスト自体を落として別手段(Playwright 等)に替える判断をする | 1d |

**完了条件**: 全テスト green。読み込みレイテンシが計測できる状態。

---

## 4. Phase 1 — Hint プリミティブ (ワイヤ変更 #1)

**目的**: Hint の配送機構だけを先に入れ、**まだストレージには繋がない。**
実網で機構を検証してから Phase 2 で切り替える。

### 構造 (core `core/src/protocol/hint.rs` に合わせる)

```
HintPacket {
  version: u8
  ttl: u8              // 中継で減る。id() には含めない
  blind_tag: [u8; 4]   // HMAC(K, hint_nonce)[0..4]
  nonce: [u8; 12]      // ChaCha20 nonce
  pow_nonce: u64       // フラッド対策。id() には含めない
  ciphertext: Vec<u8>  // 末尾 16B が Poly1305 タグ
}

HintPayload (復号後) {
  nonce: [u8; 32]      // mailbox_key = SHA256(nonce)
  message_id: u64
  timestamp: u64
}
```

**`id()` は ttl と pow_nonce を除いて計算する。** 含めると、攻撃者が同じ中身に対して
別の有効な pow_nonce を見つけて「別の Hint」として再フラッドできる (core のコメント参照)。

### 鍵源 (§18.4.2 の「鍵源だけを差し替える」を web-lite に適用)

```
K           = threadKey (既存。URL フラグメント由来)
hint_key    = HKDF(K, "aether_hint_v1")
blind_tag   = HMAC(K, hint_nonce)[0:4]
mailbox_key = SHA256(nonce)     ← K からは導出不能
```

| # | タスク | 見積 |
|---|---|---|
| 1.1 | `HintPacket` / `HintPayload` の型と符号化 (TS + Rust) | 1d |
| 1.2 | 鍵導出 (`hint_key` / `blind_tag`) を `KeyManager` に追加 | 0.5d |
| 1.3 | Hint の PoW (`seal_pow` / `verify_pow`)。core と同じく `id()` に束ねる | 0.5d |
| 1.4 | 受信側の試行復号。手持ち鍵ごとに `HMAC(K_i, hint_nonce)` を計算して 4 バイト比較。板 10 個なら Hint 1 通あたり 10 HMAC で無視できる | 0.5d |
| 1.5 | `WireType.HINT` を追加し、`ZoneGossipRouter` の Broadcast Veil に載せる。Dandelion stem で発信元を隠す | 1d |
| 1.6 | 相互運用ベクタ (§2.1) | 0.5d |
| 1.7 | メッシュテスト: 3 ノードで Hint が全員に届き、鍵を持つ者だけが復号できる | 0.5d |

**完了条件**: Hint が実網で配送・復号できる。ストレージはまだ旧経路のまま動いている。

**リスク**: Hint は全投稿ごとに全ノードへ配られる。PoW と SeenCache が効いているか
帯域込みで確認すること。

---

## 5. Phase 2+3 — Schrödinger 化と Hint 再放流 (ワイヤ変更 #2)

> **2 と 3 は必ず同時に出す。** Schrödinger 化だけを入れると、Hint を受け取れなかった者は
> mailbox_key を永久に計算できず、**後から参加した人が過去ログを一切発見できなくなる。**
> 今は `topicHash` が固定なので板の鍵さえあればいつでも引けている。ここが構造的に変わる。

### 変更内容

```
publish():
  nonce       = random(32)
  mailbox_key = SHA256(nonce)
  PUT(mailbox_key, [hint_blob] ‖ [body_blob]) → K-nearest(mailbox_key)
  Hint(nonce) を Gossip へ

fetch():
  受信済み Hint から mailbox_key を得て GET
  (topicHash 起点の問い合わせは廃止)
```

PUT ペイロードを `hint_blob ‖ body_blob` の 2 分割にするのは §18.3-A の形。
**保持者は hint_blob を復号できないが、バイト列としてそのまま Gossip へ再投入できる。**

| # | タスク | 見積 |
|---|---|---|
| 2.1 | `publish()` を random nonce ベースへ。`findKNearest` / `isResponsibleFor` は mailbox_key を食わせるだけで変更不要 | 1d |
| 2.2 | PUT ペイロードの 2 分割 (`hint_blob ‖ body_blob`) と保管形式の変更 (TS + Rust) | 1d |
| 2.3 | `fetch()` を Hint 駆動へ。受信済み Hint の索引から mailbox_key を引く | 1d |
| 3.1 | 保持者による hint_blob の定期再放流。**再放流タイミングは `mailbox_key` から決定論的に導出する** — K 個の保持者が同一時間窓で送出すれば SeenCache が同一ハッシュとして畳むため帯域が K 倍にならない (§18.3-A) | 1.5d |
| 3.2 | 移行期の二重運用: 新形式で書きつつ旧 `topicHash` 経路も読む。実網の入れ替わりが済んだら旧経路を削除 | 1d |
| 2.4 | 相互運用ベクタ + メッシュテスト | 1d |

**完了条件**:
- 新規参加者が、自分がオフラインだった間の投稿を再放流経由で発見できる
- GET のリクエストに板/スレを特定できる値が乗っていない
- 旧経路を落としても過去ログが引ける

**リスク**: 3.1 の再放流が効いていないと過去ログが静かに消える。
**「発見できる」を自動テストで担保すること**(オフライン期間を挟んだノードが後から拾えるか)。

### この時点で得られる性質

- GET が指すのはランダム値。受け取った側は何を要求されたのか分からない
- 板ごとの固定座標が消えるので **位置グラインディングによる張り込みが成立しない**。
  攻撃者は鍵空間全体を覆わない限り観測できず、O(1) の攻撃が O(N) になる
- 残るのは「同じ Hint を復号できた参加者が、たまたまそのランダム鍵の K-nearest に居た場合」だけ。
  狙い撃ちはできず、捕まるのは K/N のランダム標本

---

## 6. Phase 4 — PUT を Dandelion stem に載せる (送信者匿名性)

**目的**: 穴 2。保管者が見る IP を発信元のものではなくす。

数ホップ stem で運び、**最後のホップが発信元の代わりに K-nearest へ PUT する。**
保管者が見る IP は最終ホップのもので、そのノード自身も「自分が発信したのか中継したのか」を
区別されない。

層状暗号は不要 (§1 の設計上の要点)。

| # | タスク | 見積 |
|---|---|---|
| 4.1 | stem 搬送用の PUT メッセージ型 (TS + Rust)。既存 `DandelionRouter` を再利用 | 1d |
| 4.2 | 最終ホップでの K-nearest PUT 実行 | 0.5d |
| 4.3 | メッシュテスト: 保管者が受け取る IP が発信元と一致しないこと。分布で検証 (Fluff 地点テストと同じ形) | 1d |

**コスト**: Post 経路に stem 2〜4 ホップ (~200-400ms)。読み込み側は影響を受けない。

**完了条件**: 3 ノードメッシュで、PUT を受けた保管者が発信元 IP を得られないこと。

---

## 7. Phase 5 — PUT / Hint の時間分離 (§18.4.5)

**目的**: PUT と Hint が同時に出ると、両方を観測できる位置にいる者に
「T にアップロードしていた人」と「T+ε に現れた Hint」でエンベロープ相関を取られる。
Hint の中身が不透明でも、この相関は中身を要さない。

遅延量は §18.4.5 の式で観測量から逆算する。**観測 Hint レートは Broadcast Veil のおかげで
ローカルで直接測れる**(全 Hint が自分に届く)。

| # | タスク | 見積 |
|---|---|---|
| 5.1 | `ReleaseStatus` 付きの遅延スケジューラ (core `mailbox/hint_release.rs` を参考に) | 1.5d |
| 5.2 | モード実装 (`Disabled` / `Adaptive` / `Strict`) | 0.5d |

### ★ ブートストラップ期の扱い (最重要)

素朴に実装すると **「網が小さいほど長く待つ」という完全に逆の挙動**になる。
観測レートが 0 なら必要窓は無限大に発散し、上限まで待たされる。
**しかも待っても匿名集合は生まれない。** 利益ゼロのコストを最も離脱されやすい
立ち上げ期に払わせることになり、網が育つ経路そのものを塞ぐ。

→ `Adaptive` では **待って得られる匿名集合が測定可能な水準 (2 件) に達しない場合は遅延しない。**

チャット規模 (10KB) は常に遅延なし。遅延が要るのは中継トラフィックより十分大きい送信のみ。

**完了条件**: 母数 0 のとき遅延が入らないことをテストで固定する。

---

## 8. 見積まとめ

| Phase | 内容 | 見積 |
|---|---|---|
| 0 | 地ならし | ~2d |
| 1 | Hint プリミティブ | ~4.5d |
| 2+3 | Schrödinger 化 + 再放流 | ~6.5d |
| 4 | PUT の stem 化 | ~2.5d |
| 5 | 時間分離 | ~2d |
| | **合計** | **~3.5 週間** (1 人) |

Phase 0→1→2+3 まででこの計画の主目的(穴 1)は達成される。
Phase 4 は穴 2、Phase 5 は仕上げ。

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
