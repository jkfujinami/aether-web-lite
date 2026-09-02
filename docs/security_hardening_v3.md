# AETHER Web-Lite セキュリティ強化 (Wire V3)

**実施日**: 2026-09-01
**対象**: `web/` (Next.js クライアント + トラッカー) と `aether-cache/` (Rust キャッシュノード)
**根拠**: 本家 AETHER `/Users/fujinami/workspace/AETHER/.docs/detailed_implementation/` の Part 18 / 19 / 21

---

## 0. 何をしたか

本家 AETHER の Winny 後継改訂 (Part 18) と実装棚卸し (Part 19)・引き継ぎ書 (Part 21) を、
web-lite の実コードと 1 行ずつ突き合わせて監査し、見つかった 10 件の穴をすべて塞いだ。

Part 18.6.2 が **「web-lite 側も設計書 §6 で『購読宣言の完全廃止』と書きながら
実装が `peer.zones.has()` で宣言してしまっており、同じ罠に落ちている」** と
名指しした箇所を含む。

ワイヤ形式が変わるため **Wire V2 とは非互換**。TypeScript と Rust を同時に改修し、
両実装が同じバイト列を作ることを固定テストベクタで保証している。

### 検証結果

| | 件数 | 状態 |
|:--|--:|:--|
| TypeScript (vitest) | 230 | 全通過 |
| Rust ユニット | 54 | 全通過 |
| Rust 結合 | 21 | 全通過 |
| Rust 実 WebRTC 疎通 | 5 | 全通過 |
| 相互運用: 暗号プリミティブ | 11 | 全通過 |
| 相互運用: ワイヤ符号化 (TS→Rust) | 16 | 全通過 |
| 相互運用: ワイヤ符号化 (Rust→TS) | 13 | 全通過 |
| `tsc --noEmit` / `next build` | — | 通過 |
| `cargo clippy --all-targets` | — | 警告 0 |

```bash
cd web           && npm test && npm run typecheck && npm run build
cd aether-cache  && cargo test && cargo clippy --all-targets
```

---

## 1. 塞いだ穴の一覧

| # | 級 | 内容 | 主な修正先 |
|:-:|:--|:--|:--|
| 1 | S | PoW 検証が自己申告値ベースで完全バイパス可能 | `PowPolicy.ts` / `crypto/pow.rs` |
| 2 | S | PoW がヘッダを覆わず、timestamp 差し替えで無限リプレイ | 同上 |
| 3 | S | DHT PUT が完全無検証 | `DHTMailbox.ts` / `mailbox/entry.rs` |
| 4 | S | DHT RES を無検証で信用 | `DHTMailbox.ts` |
| 5 | S | トラッカーのセッション乗っ取り | `SessionManager.ts` / `TrackerServer.ts` |
| 6 | A | Bound Identity 不在 (Eclipse / 狙い撃ち保持者化) | `NodeIdentity.ts` / `crypto/node_identity.rs` |
| 7 | A | ゾーン購読宣言による交差攻撃 | `ZoneGossipRouter.ts` / 全ワイヤ形式 |
| 8 | A | 隣人ごとのレート制限が皆無 | `RateLimiter.ts` / `network/rate_limiter.rs` |
| 9 | B | Gossip PoW に Argon2id (誤ったプリミティブ選択) | `PoWEngine.ts` / `pow.worker.ts` |
| 10 | B | トリップ秘密鍵が IndexedDB に平文 | `SecretVault.ts` / `Identity.ts` |
| + | — | (追加発見) ChunkedReceiver の再組み立てメモリ枯渇 | `ChunkedReceiver.ts` |
| + | S | (実網で発覚) `JsonBytes` が MsgPack bin 型を読めず、Rust がバイナリを含む全メッセージを復号できない | `network/messages.rs` |
| + | — | (実網で発覚) `PeerConnected` が DataChannel オープン前に発火し、HELLO が捨てられる | `network/webrtc_peer.rs` |
| + | S | (実網で発覚) 同一 peerId での張り直しが古い死んだ接続に流れ込む | 両側 `PeerManager` |
| + | S | (実網で発覚) 古い接続の遅延切断通知が、張り直した新しい接続を消す | 両側 `PeerManager` |
| + | — | (実網で発覚) TS の Dandelion が仕様から逸脱し `stemTtl` を送っておらず、Rust が STEM を復号できない | `DandelionRouter.ts` |

---

## 2. S級の詳細

### S-1. PoW 検証の自己申告バイパス

**旧**: `PacketValidator.ts:43` が受信パケットの `pow_difficulty` をそのまま
`PoWEngine.verify` に渡し、`PoWEngine.ts:44` は `if (difficulty === 0) return true;` だった。
攻撃者は `pow_difficulty: 0` と書くだけで PoW を一切計算せず全ノードに受理された。
下限値の検査がコードのどこにも無かった (`MIN_DIFFICULTY` は送信側の
`DifficultyEstimator` にしか登場しなかった)。

**新**: `verifyPow()` が `POW_POLICY.MIN_DIFFICULTY` / `MAX_DIFFICULTY` を強制する。
その難易度としては正当な解を持っていても、ポリシー外なら拒否する。

```ts
// web/src/lib/crypto/PowPolicy.ts
export function verifyPow(header, powNonce) {
  if (header.pow_difficulty < POW_POLICY.MIN_DIFFICULTY) return false;
  if (header.pow_difficulty > POW_POLICY.MAX_DIFFICULTY) return false;
  return meetsDifficulty(powHash(powPreimage(header), powNonce), header.pow_difficulty);
}
```

送信側の下限 (`DifficultyEstimator.MIN_DIFFICULTY`) と受信側の下限が一致していることも
テストで固定してある。ずれると「自分の投稿を他人が全部弾く」か「弾くべきものを通す」になる。

### S-2. ヘッダ改竄によるリプレイ増幅

**旧**: `PacketBuilder.build` が `powEngine.compute(ciphertext, difficulty)` と
暗号文だけに PoW をコミットしていた。`timestamp` と `zone_id` は PoW の外側かつ
署名の外側なので、傍受したパケットの `timestamp` を現在時刻に書き換えるだけで
PoW を再計算せずに再放流できた。SeenCache の TTL は 15 分なので、
**16 分ごとに同じパケットを永久に増幅**できた。

**新**: PoW と `packet_id` を「可変でないヘッダ全体」にコミットする。

```
preimage = "AETHER/v3/gossip"      (16 bytes)
        || timestamp               (u64 BE)
        || zone_id                 (u32 BE)
        || pow_difficulty          (u8)
        || len(nonce)   || nonce    (u16 BE + bytes)
        || len(payload) || payload  (u32 BE + bytes)

pow_hash  = SHA256(preimage || pow_nonce_be_u64)
packet_id = hex(SHA256(preimage))          ← CHK (Content Hash Key)
```

- 長さ前置きにより、フィールド境界を動かした別入力が同じバイト列に潰れない。
- `hop_count` は中継で正当に変化するため意図的に除外 (範囲検査のみ)。
- コミット対象を 1 ビットでも変えると `packet_id` が変わり、かつ PoW をやり直す必要が生じる。

### S-3 / S-4. DHT の無検証

**旧**:

```ts
private handlePut(_peerId, msg) {
  this.store.put(msg.topicHash, msg.entries)   // 無検証
}
private handleRes(_peerId, msg) {
  req.resolve(msg.entries);                    // 無検証
  this.store.put(msg.topicHash, msg.entries);  // ローカルにも焼き付け
}
```

誰でも任意のスレッドの過去ログを捏造でき、IndexedDB を枯渇させられた。
K=5 のうち 1 台が悪意を持てば偽の過去ログが正史として定着した。
本家 18.7-⑦ が Rust 側で指摘したのと同じ穴が両側にあった。

**新**: DHT のエントリは「JsonBinary で直列化した GossipPacket」なので、
保管ノードは鍵を持たなくても CHK と PoW を検証できる (Schrödinger 原則を維持したまま)。

- **PUT**: topicHash 形式 → K-nearest 帰属 → エントリ単位の CHK+PoW → 件数/トピック数の上限
- **RES**: 自分が出した reqId か → その reqId を投げた相手からか → topicHash 一致 → CHK+PoW
- 検証を通ったものだけを resolve / 保存する

> **重要な設計判断**: DHT エントリは `allowStale: true` で検証する。
> DHT は過去ログの保管庫なので何日も前のパケットが正当に入っている。
> ライブゴシップと同じ 15 分のドリフト検査を掛けると過去ログ同期が丸ごと壊れる。
> 未来日付・PoW・CHK は変わらず全件に掛かるので、偽造は依然として不可能。

なお K-nearest 帰属検証はブラウザ側だけの制御である。キャッシュノードは
「広く保持する常駐ノード」という役割上、担当範囲で受け入れを絞らない。
そちらは容量上限が保護の主役になる。

### S-5. トラッカーのセッション乗っ取り

**旧**: `SessionManager.registerSession` が `this.sessions.set(peerId, ...)` で
既存エントリを無条件に上書きしていた。`join` に認証が無かったので、攻撃者は
被害者の `peerId` を名乗るだけで被害者宛の SDP/ICE リレーを全部奪えた。

**新**:
- 生きている接続がある `peerId` は奪えない (相手が本当に落ちていれば 2 分以内に回収される)
- `join` で Bound Identity (peerId = SHA256(pubkey) + NodeId PoW) を検証する
- `relay` の `senderId` はサーバーが接続から逆引きした値で上書きする (クライアントの申告を採用しない)
- `join` / `relay` に接続単位のトークンバケット
- `ws.on('close')` は自分が登録した接続のときだけセッションを消す (再接続との競合対策)

---

## 3. A級の詳細

### A-6. Bound Identity

**旧**: `peerId = randomBytes(16)`、`position` も純粋な乱数で、両者に何の関係も無かった。
さらに JOIN ハンドラが `peer.updatePosition(msg.position)` を無検証で受け入れていた。
攻撃者は狙った `topicHash` の真隣に着地して K=5 の保持者になれたし、
特定ノードを囲んで Eclipse できた。本家 18.5.3 が「★未解決だった重大欠陥」として
挙げた項目そのもの。

**新**:

```
peerId   = SHA256("AETHER/v3/peerid"   ‖ pubkey)[0..16]
position = SHA256("AETHER/v3/position" ‖ peerId)[0..8] / 2^64
```

**position は peerId の純粋関数なので、ネットワーク上で座標を送る必要がなくなった。**
受信側が自分で計算する。「申告された座標」という攻撃面そのものが消えている。

狙った座標に着地するには鍵をグラインドするしかなく、そのコストを
**NodeId PoW (Argon2id)** で引き上げる。ハッシュ関数の使い分けは本家 18.11 に従う:

| 用途 | ハッシュ | 理由 |
|:--|:--|:--|
| Gossip PoW | SHA-256 | 全ノードが全件検証するので限界まで軽く |
| NodeId PoW | Argon2id | 検証は新規ピア登録時のみ。ASIC 優位を潰す価値がそのまま効く |
| トリップ鍵の封印 | Argon2id (t=3, m=64MiB) | アンロック時に 1 回 |

**所有証明**: 公開鍵を貼り付けただけのなりすましと、傍受した JOIN の再生を防ぐため、
接続ごとのチャレンジ・レスポンスを追加した。

```
接続確立 → 双方が HELLO{challenge: 32B ランダム} を送る
        → 相手は JOIN{peerId, pubkey, powCounter, challenge, sig} を返す
        → sig = Ed25519("AETHER/v3/join" ‖ challenge)
        → 検証成功で verified、以後それ以外のメッセージを受け付ける
```

検証は 4 段:
1. 名乗った peerId が、この接続の相手として認識している peerId と一致するか
2. `peerId == SHA256("AETHER/v3/peerid" ‖ pubkey)[0..16]` か (束縛)
3. NodeId PoW を満たすか (グラインド耐性)
4. **自分がこの接続で送った** challenge への署名が正しいか (所有証明・リプレイ耐性)

ハンドシェイク未完了のピアは HELLO/JOIN 以外を一切ディスパッチされず、30 秒で切断される。

**パラメータ** (実測 libsodium WASM: Argon2id 1MiB/t=1 で 3.4ms/hash):

| | difficulty | 採掘 | 検証 |
|:--|--:|--:|--:|
| `NODE_ID_POW` (既定) | 10 | 約 3.5 秒 (端末ごとに一度だけ) | 3.4 ms |
| `NODE_ID_POW_FAST` (テスト/開発) | 4 | 約 54 ms | 3.4 ms |

採掘結果は封印して IndexedDB (ブラウザ) / `node_identity.key` (Rust) に保存し、
次回以降は復元する。

### A-7. ゾーン購読宣言の撤去

本家 18.6.2 の指摘どおり、web-lite は 2 経路で購読を漏らしていた。

1. `ZoneGossipRouter.flood()` が `peer.zones.has(zone_id)` で送信先を絞っていた。
   つまり全隣人に「自分がどのゾーンを購読しているか」を申告し、
   JOIN / PEX / トラッカーがその配列を運んでいた。
2. 購読外のパケットを中継せずに握り潰していた。攻撃者はゾーン Z のプローブを送り、
   それが転送されるかを観察するだけで「この隣人は Z を購読しているか」を判定できた。

`ZoneManager` は購読セットを localStorage に永続化しているため、この情報は
セッションを跨いで不変であり、長期の交差攻撃で「誰がどのスレッドを読んでいるか」が特定できた。

**新** (Broadcast Veil の回復):
- 中継は**無条件に全隣人へ**。転送するかどうかが購読状態に一切依存しない。
- ゾーンフィルタは「UI に渡すかどうか」だけに使う。完全にローカルな判断で外から観測できない。
- `zones` をワイヤ形式から全廃 (JOIN / PEX / SDP リレー / トラッカー join / peers 応答)。
- `IPeerConnection.zones` も型と実体の両方から削除。

テストでは「購読しているゾーンと購読していないゾーンで、外部から観測可能な振る舞いが
完全に一致する」ことを直接検証している。

代償は帯域だが、本家 18.3-E の試算どおり Winny 級の規模までゾーン分割は不要であり、
depth が小さいうちは `isSubscribed` が常に true を返すため実質的な差は無い。

### A-8. レート制限

本家 18.11.3 の結論「**PoW は主役ではない。ゴシップ網の本来の防御は暗号ではなく、
隣人ごとのレート制限である**」を実装した。旧実装には 1 箇所も無く、
1 人の隣人が GOSSIP も PEX も DHT_PUT も無制限に送り込めた。

ピア単位・カテゴリ単位で独立したトークンバケット (DHT_PUT を撃たれても GOSSIP の予算は減らない):

| カテゴリ | rate/sec | burst | 根拠 |
|:--|--:|--:|:--|
| gossip | 20 | 60 | 板が炎上しても 1 隣人あたりこれで足りる |
| dhtPut | 5 | 30 | レプリケーションはバースト的 |
| dhtGet | 5 | 20 | |
| pex | 1 | 5 | RingMaintainer は 10 秒に 1 回しか投げない |
| handshake | 0.2 | 3 | NodeId PoW の検証が 3.4ms と重いので特に絞る |
| signaling | 10 | 40 | |

次数 16 × 20 件/秒 = 320 件/秒 が受信レートの構造的上限になる。
攻撃者の制約が「ハッシュ能力」から「何本コネクションを張れるか」に変わる。

---

## 4. B級の詳細

### B-9. Gossip PoW のハッシュ関数

本家 18.11 の実測に基づく訂正。飽和条件 `M ≥ 2^D` においてハッシュ単価 C は
約分で消えるため、**フラッド耐性は難易度 D だけで決まり、ハッシュ関数の重さとは無関係**。
Argon2id は耐性を 1 ビットも増やさず、正直な利用者のコストだけを 1146 倍にする。

旧実装は二重に誤っていた:

1. Gossip PoW に Argon2id を使っていた (検証コスト 276us vs SHA-256 0.24us)。
2. **検証まで Worker に投げていた**。受信パケット 1 通ごとに postMessage の往復 +
   Argon2 1 回が発生し、単一 Worker が直列化点になっていた。攻撃者はゴミパケットを
   流すだけで正当なパケットの処理を詰まらせられた (head-of-line blocking)。

さらに `PoWEngine.PARAMS` が `type: 2` (Argon2id)、`pow.worker.ts` の
`DEFAULT_PARAMS` が `type: 0` (Argon2d) で、**送信側と Worker で別のハッシュを
計算し得る不整合**があった (`remaining_tasks.md` の「⚠️ 実装済みだが注意が必要な箇所 #4」)。

**新**:
- 検証はメインスレッドで同期実行 (SHA-256 1 回 = 1.25us 実測)。
- 探索のみ Worker に委譲。
- 実装を `PowPolicy` 1 箇所に集約したので、上記の不整合は構造的に起こらない。
- `argon2-browser` 依存を削除し、`libsodium-wrappers-sumo` に一本化
  (標準ビルドには `crypto_hash_sha256` も `crypto_pwhash` も無いため)。

### B-10. トリップ秘密鍵の平文保存

**旧**: `IndexedDBStore.saveTrip(publicKey, privateKey)` が Ed25519 秘密鍵を
生のまま書いていた。端末を押収されれば過去の全投稿がその人物に紐付く。
本家 Part 21 §1 の脅威モデル (監視ノード → IP 特定 → ISP 照会 → 押収 → フォレンジック) の後段。

**新**: `SecretVault` で封印してから保存する。

```
KEK        = Argon2id(passphrase, salt)      … 本家 Part 6.6 の KeyStore KEK と同じ用途
ciphertext = XSalsa20-Poly1305(secret, KEK)  … crypto_secretbox
```

- パスフレーズ違いと改竄はどちらも `null` を返す (区別を攻撃者に教えない)。
- パスフレーズ未設定でも同じ経路を通し `protected: false` を記録する。
  「保護されているつもりで保護されていない」状態を型と値で区別できるようにするため。
- IndexedDB を v5 → v6 に上げ、**旧バージョンの平文レコードを upgrade 時に削除**する。
  残したままだと押収時に読めてしまい、封印した意味が無い。

> **未達**: 完全な前方秘匿 (X3DH) は本家でも未実装の大物 (Part 21 §3「3-1」)。
> ここで担保したのは「保存された鍵が平文で読めない」ところまで。

### 追加発見: ChunkedReceiver の再組み立てメモリ枯渇

監査中に発見。`ChunkedReceiver.pending` に上限が無く、
`msgId` を変えながらヘッダだけを送り続けると 10 秒間ずっと保持され続けた。
また `totalChunks` の上限が無く 65535 × 4096B = 268MB まで伸ばせた。

**新**: 同時組み立て数 64 件 / 1 メッセージ 1MiB / チャンク数上限を設け、
「同じ msgId で totalChunks を変えてくる」「同じ seq を繰り返してサイズを水増しする」
「ヘッダのサイズ欄と実体が食い違う」いずれも拒否する。

---

## 4.5 実網で発覚した 2 件

Wire V3 を実際に動かしたところ、DataChannel は両側で開くのにハンドシェイクが
完了しないという症状が出た。ログの `webrtc_sctp: failed to handle_inbound: ErrChunk`
は DataChannel オープンのちょうど 31 秒後 —— ブラウザ側の 30 秒ハンドシェイク
タイムアウトによる切断の *結果* であって原因ではなかった。原因は次の 2 件。

### W-1. `JsonBytes` が MsgPack の bin 型を読めない (S級)

`JsonBytes` は `#[serde(untagged)]` の enum で `Tagged {_type, data}` と
`Raw(Vec<u8>)` を受け分ける設計だった。しかし untagged は `deserialize_any` を
通るため **MsgPack の bin 型にマッチしない**。bin は `visit_bytes` を呼ぶのに対し、
`Vec<u8>` は seq を期待するためである。

ブラウザの `@msgpack/msgpack` は `Uint8Array` を bin 型で符号化する。結果として

- `HELLO` の challenge
- `JOIN` の pubkey / challenge / signature
- `Gossip` の nonce / payload
- `DHT_PUT` / `DHT_RES` の entries

つまり **バイト列を含むメッセージが Rust 側で 1 通も復号できていなかった**。
これは Wire V3 で入った不具合ではなく、`JsonBytes` が導入された時点から
存在していた。数値と文字列だけの PING/PONG が通っていたこと、そして受信側が

```rust
if let Ok(msg) = WireCodec::decode_v2(&assembled) { ... }   // エラーを握り潰す
```

とデコード失敗を黙って捨てていたことが重なり、ログに痕跡が一切残らなかった。

**修正**: untagged enum を捨て、手書きの Visitor を持つ newtype に置き換えた。

| 受信 | 対応 |
|:--|:--|
| MsgPack bin | `visit_bytes` / `visit_byte_buf` (本命) |
| 配列 | `visit_seq` (JSON 経由 / MsgPack array) |
| `{_type, data}` | `visit_map` (旧 `JsonBinary.stringify` 形式。IndexedDB の過去データ用) |

送信は常に `serialize_bytes`。MsgPack では bin 型、JSON では配列にフォールバックし、
どちらもブラウザ側の `toBytes()` が受け取れる。旧 `{_type, data}` 形式での送信は
やめた —— 本家 18.6.2 が「バイナリが約 2 倍に膨らむ」として不採用にした形式そのもの
だったため。

併せて `decode_v2` の失敗をログに出すようにした。これがあれば即座に判明していた。

### W-2. `PeerConnected` が DataChannel オープン前に発火する

Rust 側は `RTCPeerConnectionState::Connected` で `PeerConnected` を出していたが、
これは DataChannel が open する数ミリ秒前に起きる (実測 4ms)。

```
16:02:48.820  State: Connected          ← ここで PeerConnected を発火
16:02:48.824  DataChannel opened        ← self.dc がセットされるのはここ
```

`GossipActor` はこのイベントを受けて即座に HELLO を送るが、
`PeerActorCommand::Send` は `self.dc` が `None` のときに黙って捨てていた。
アクター間のホップ (Gossip → PeerManager → WebRTCPeer) はマイクロ秒単位なので、
HELLO はほぼ確実にこの 4ms の窓に入って消えていた。

**修正**:
- `PeerConnected` を `DataChannelOpened` のタイミングで発火するようにした
  (ICE が繋がっただけでは 1 バイトも送れないため)。
- 受信側も `on_data_channel` の即時ではなく `on_open` を待つようにした
  (以前は readyState が connecting のまま送信し得た)。
- `dc` 未オープン時の送信は捨てずに最大 32 件まで積み、オープン時に流す。

### この 2 件を見逃した理由

**暗号プリミティブの相互運用テストはあったが、ワイヤ符号化のテストが無かった。**
`interop_vectors.rs` の 11 件は全部通っていたのに、フレームが解けないので
何も動かなかった。両実装が「自分の実装内では整合」してしまう典型例である。

`aether-cache/tests/wire_interop.rs` (TS→Rust) と
`web/tests/network/WireInterop.test.ts` (Rust→TS) を追加し、
実際のフレームのバイト列で両方向を縛った。回帰テストとして、

- bin 型のバイト列が往復すること
- ブラウザが署名した JOIN を Rust が検証できること (逆も)
- ブラウザが作ったパケットを Rust の検証器が受理すること (逆も)
- ブラウザが DHT に入れた過去ログを Rust が読めること (逆も)
- 旧 `{_type, data}` 形式も引き続き読めること
- `{_type, data}` 形式での *送信* に戻っていないこと

を固定ベクタで検証している。

---

## 4.6 Bound Identity の副作用: 同一 peerId での張り直し

W-1 / W-2 を直した後も、ブラウザ側で ICE は `connected` になるのに
DataChannel が open しないという症状が残った。Rust 側は
`Send error: DataChannel is not opened` を吐き続けていた。

### R-1. 死んだ接続に新しい offer が流れ込む

**これは Wire V3 が持ち込んだ副作用である。** Bound Identity 以前は
`peerId = randomBytes(16)` で、ブラウザをリロードすれば必ず新しい peerId に
なっていた。つまり「同じ peerId の相手が張り直してくる」ことが原理的に無かった。

Bound Identity で peerId が端末ごとに永続化された結果、リロード後も同じ ID で
戻ってくるようになった。ところが受信側は

```rust
if let Some(meta) = self.peers.get(&sender_id) {
    let _ = meta.cmd_tx.send(PeerActorCommand::HandleSignal(payload));  // 古いアクターへ
}
```

と、**既に死んでいる `RTCPeerConnection` に新しい offer を流し込んでいた**。
ICE は（古い候補で）繋がったように見えるのに DTLS/SCTP が成立せず、
DataChannel が二度と open しない。

**修正**: SDP が `offer` で、かつ既にその peerId のピアがいる場合は
「相手がセッションを張り直した」と解釈し、古い接続を畳んでから作り直す。
`answer` と ICE candidate では張り直さない（前者は自分が出した offer への応答、
後者は進行中のセッションの一部）。

併せて、ハンドシェイク状態を必ずリセットする。ここを残すと
**ハンドシェイクを一度も通っていない新しい接続が「検証済み」として扱われる**。
Rust では専用の `NetworkEvent::PeerReset` を追加した（`PeerDisconnected` を
使うと GossipActor が削除通知を返してきて、これから作る新しいピアを消してしまう）。

### R-2. 古い接続の遅延切断が新しい接続を巻き込む

R-1 を直した直後、テストで「張り直した直後にピアが消える」ことが判明した。

`RTCDataChannel.onclose` は**非同期**に発火する。古いピアを `close()` してから
同じ tick で新しいピアを作ると、

1. `disconnect(old)` … 古いチャネルの `onclose` がマイクロタスクに積まれる
2. `connect()` … 新しいピアがマップに入る
3. マイクロタスクが走る … 古いピアの `onDisconnect` → `disconnect(peerId)`
   → **新しいピアが消える**

`onDisconnect` が `peerId` しか見ておらず、「自分がまだ登録されている本人か」を
確認していなかったのが原因。15 秒 / 30 秒のタイムアウトも同じ穴を持っていた。

**修正 (TypeScript)**: 破棄処理の前に同一性を確認する。

```ts
let created: WebRTCPeer | undefined;
const isStillCurrent = () => created !== undefined && this._peers.get(peerId) === created;
// onDisconnect / 15s タイムアウト / 30s ハンドシェイクタイムアウト すべてで確認
```

**修正 (Rust)**: インスタンス同一性が使えないので接続世代 (`session: u64`) を
導入した。`NetworkEvent::PeerDisconnected` と
`PeerManagerControl::PeerDisconnected` が世代を運び、PeerManager は
現在の世代と一致するときだけ削除する。

併せて、ポリシー違反による強制切断（Bound Identity の検証失敗）は
世代に関係なく落とすべきなので `PeerManagerControl::DropPeer` に分離した。
「今この peerId を名乗っている接続は信用できない」という判断なので、
どの世代であっても残してはいけない。

### この 2 件を見逃した理由

**実際に WebRTC を張るテストが 1 つも無かった。** 結合テストは
`NetworkEvent` を手で流し込んでいたため、「DataChannel がいつ open するか」
「切断コールバックがいつ発火するか」という一番壊れやすい部分が
まったくカバーされていなかった。

`aether-cache/tests/webrtc_handshake.rs` を追加し、2 つの `WebRTCPeer` を
ローカルで直結して ICE → DTLS → SCTP → DataChannel → PeerConnected →
実データ往復までを通しで確認するようにした。特に

> **PeerConnected を受けた *直後* に送ったメッセージが届くこと**

は W-2 の直接の回帰テストである。

---

## 4.7 Dandelion++ の実装が仕様から逸脱していた

ハンドシェイクと DHT が通るようになった後、Rust 側に残った警告:

```
Failed to decode 644 byte frame (type=0x41): missing field `stemTtl`
```

`0x41` は STEM。`docs/spec/step5_dandelion.md` は

```
STEM_TTL_MIN = 2, STEM_TTL_MAX = 4, FLUFF_PROBABILITY = 0.1
Fluff 判定: stemTtl <= 0 || random() < FLUFF_PROBABILITY
```

と定めており、**Rust はこの仕様どおりだったが TypeScript が逸脱していた**。
TS 側は `stemTtl` を持たず、`FLUFF_PROBABILITY` を 0.25 に変えた
「確率のみで停止する」実装になっていた。結果、ブラウザが送る STEM は
Rust 側で 1 通も復号できず、**Dandelion++ による発信元秘匿がキャッシュノード
経由では機能していなかった**。

**修正**: TypeScript を仕様に戻した。

- `publish` は `[STEM_TTL_MIN, STEM_TTL_MAX]` から乱択した `stemTtl` を載せる
- `handleStemPacket` は `stemTtl <= 0 || random() < 0.1` で Fluff、
  それ以外は `stemTtl - 1` にして転送
- 初期 TTL を乱択するのは、中継者が「自分が経路の何番目か」を推定しにくく
  するため (仕様書 §「stem_ttl が分からないため、どこで始まったか不明」)

併せて両実装に **TTL の上限クランプ**を入れた。これが無いと、攻撃者が
巨大な `stemTtl` を申告して Stem 経路を不当に引き延ばせる。

### 見逃した理由

ワイヤ相互運用テストで **STEM は Rust→TS の方向しか張っていなかった**。
Rust が送る STEM には当然 `stemTtl` が入っているので、その方向は通っていた。
TS→Rust のベクタに `stem` を追加し、両方向を塞いだ。

---

## 5. 相互運用の保証

TypeScript と Rust は同じ暗号プリミティブを独立に実装している。どこか 1 箇所でも
バイト列の組み方がずれると、

- 片方が作ったパケットをもう片方が「PoW 不正」として全部捨てる
- peerId から計算するリング座標が食い違い、DHT の担当がずれる

という形で壊れる。しかも通常のテストでは双方が「自分の実装内で整合」してしまうため気付けない。

そこで TS 側の出力を固定ベクタとして書き出し、Rust 側がそれと突き合わせる。

```bash
cd web && npx tsx tests/vectors/generate.ts   # → web/tests/vectors/interop_vectors.json
cd aether-cache && cargo test --test interop_vectors
```

### 5.1 暗号プリミティブ (11 件)

| 項目 | 確認内容 |
|:--|:--|
| PoW プリイメージ | バイト列が完全一致 |
| packet_id (CHK) | 一致 |
| PoW ハッシュ | nonce=0 と解済み nonce の両方で一致 |
| 双方向の PoW 検証 | TS が解いた nonce を Rust が受理 / その逆 |
| peerId 導出 | 一致 |
| リング座標 | f64 として厳密一致 |
| seed → 鍵ペア | libsodium `crypto_sign_seed_keypair` と `ed25519-dalek` が同じ公開鍵 |
| NodeId PoW | libsodium `crypto_pwhash(ALG_ARGON2ID13)` と argon2 クレートが同じ出力 |
| JOIN 署名 | 決定的署名がバイト一致 |
| ドメイン分離子 | 値そのものを固定 |

### 5.2 ワイヤ符号化 (27 件)

暗号プリミティブが一致していてもフレームが解けなければ何も動かない (§4.5)。
両方向を別々のテストで縛る。

| 方向 | テスト | ベクタ |
|:--|:--|:--|
| TS → Rust | `aether-cache/tests/wire_interop.rs` (14) | `web/tests/vectors/interop_vectors.json` の `wire.tsFrames` |
| Rust → TS | `web/tests/network/WireInterop.test.ts` (13) | `web/tests/vectors/rust_wire_frames.json` |

```bash
# TS 側のベクタを再生成
cd web && npx tsx tests/vectors/generate.ts

# Rust 側のベクタを再生成 (テストが書き出す)
cd aether-cache && cargo test --test wire_interop
```

どちらのベクタもコミットしておくこと。片方の符号化を変えると、もう片方の
テストが差分を検出する。

**ベクタを更新したら必ず両側のテストを走らせること。**

---

## 6. ワイヤ形式の変更点 (V2 → V3)

| メッセージ | 変更 |
|:--|:--|
| `HELLO` (0x17) | **新設**。`{ challenge: 32B }` |
| `JOIN` (0x10) | `{ peerId, position }` → `{ peerId, pubkey, powCounter, challenge, signature }` |
| `PEX_RESPONSE` | `{ peers: [{id, position, zones}] }` → `{ peers: [{id}] }` |
| `RING_INFO` | 同上 |
| `SDP_RELAY` | `position` / `zones` を削除 |
| トラッカー `join` | `{peerId, position, zones}` → `{peerId, pubkey, powCounter}` |
| トラッカー `peers` | `[{peerId, position, zones}]` → `[{peerId}]` |
| `GOSSIP` / `STEM` | 形は同じだが `packet_id` の定義と PoW の対象が変わった |

---

## 7. 残っている課題

| 項目 | 状況 |
|:--|:--|
| 前方秘匿 (X3DH) | 未実装。本家でも「範囲大」として保留中 (Part 21 §3) |
| Rust ノードの seed 保護 | ファイル権限 0600 のみ。押収には無防備。`AETHER_NODE_SEED` 環境変数で外部の秘密管理から注入可能にしてある |
| エポックビーコン (18.5.3 対策2) | 未実装。`position = H(NodeId ‖ epoch_seed)` にすると、グラインドした位置が 1 エポックしか持たない。epoch_seed の合意手順が本家でも未決 (18.12) |
| Turnstile によるボット排除 | 未実装 (`remaining_tasks.md` B-8) |
| Gossip の Onion 経由化 | web-lite では意図的に不採用 (本家 18.6.2「Relay/Onion 採用しない = 可用性優先」) |

---

## 8. 追加されたファイル

### TypeScript (`web/`)

```
src/lib/crypto/sodium.ts              libsodium (sumo) の単一入口
src/lib/crypto/PowPolicy.ts           PoW ポリシー・正準プリイメージ・CHK
src/lib/crypto/NodeIdentity.ts        Bound Identity + NodeId PoW + 所有証明
src/lib/crypto/NodeIdentityStore.ts   採掘結果の封印・永続化
src/lib/network/RateLimiter.ts        隣人ごとのトークンバケット
src/lib/network/mailbox/MailboxEntry.ts  DHT エントリの検証と上限
src/lib/storage/SecretVault.ts        秘密鍵の封印 (Argon2id + secretbox)

tests/                                205 件 (攻撃シナリオ中心)
tests/vectors/generate.ts             相互運用ベクタの生成器
```

### Rust (`aether-cache/`)

```
src/crypto/pow.rs                     Gossip PoW (TS と一致)
src/crypto/node_identity.rs           Bound Identity (TS と一致)
src/gossip/validator.rs               パケット検証
src/mailbox/entry.rs                  DHT エントリの検証と上限
src/network/rate_limiter.rs           隣人ごとのトークンバケット
src/node_key.rs                       ノード seed の永続化

tests/interop_vectors.rs              TS との固定ベクタ照合 (11 件)
tests/integration_test.rs             アクター結合 + 攻撃シナリオ (17 件)
```
