# Part 9: Security Analysis — 攻撃別防御評価

[02_threat_model.md](./02_threat_model.md) で定義した攻撃カテゴリそれぞれについて、Substrate v2 の防御能力を評価する。

---

## 9.1 評価指標

| 記号 | 意味 |
|---|---|
| **◎ 完全防御** | 計算量的に攻撃成功不能。または効果なし |
| **○ 強い防御** | 攻撃コストが実用的に困難なレベル (e.g., 大規模 PoW) |
| **△ 部分防御** | 攻撃を制限・遅延させるが、原理的には可能 |
| **× 防御なし** | 設計上対応せず (out-of-scope or 制約) |

---

## 9.2 メタデータ攻撃

### 9.2.1 GET fingerprinting (どのスレを読んでるか観測)

**攻撃シナリオ**: 隣接 K-nearest ピアが、自分の `SLOT_GET` を観測し、頻度パターンから「どの thread / channel を読んでいるか」推定する。

| 防御要素 | 効果 |
|---|---|
| Mode A (HMAC-derived) slot_key | secret 保有者以外は slot ↔ thread 不明 ○ |
| Mode B (random) slot_key | 各 GET が独立、結びつかない ◎ |
| Hint 暗号化 | 観測者は中身を知らない ◎ |
| Time bucket は平文 | 時間粒度の情報は漏れる (許容) △ |
| 1 channel = 1 slot_key (Mode A) | secret 保有者間では集中 (BBS の前提) △ |

**評価**: 第三者 (channel 非加入者) に対して **◎ 完全防御**。同じ channel メンバーは secret を持つので必然的に slot_key を知る (これは設計上の前提)。

### 9.2.2 PUT origin tracing

**攻撃シナリオ**: PUT パターンから投稿者を推定。

| 防御要素 | 効果 |
|---|---|
| Dandelion stem 経由 PUT | 起点が隣人に隠れる ○ |
| Slot key の予測不能性 | 「特定 channel への投稿」と関連付けられない ○ |
| Bound Identity | position から identity 連結を防ぐ ○ |

**評価**: ○ 強い防御。完全な発信者匿名性は Relay/Onion なしには困難。

### 9.2.3 Storage census

**攻撃シナリオ**: 自分の K-nearest 圏内のデータから、ネットワーク全体の活動度推定。

| 防御要素 | 効果 |
|---|---|
| Random slot_key 分布 | channel/conv 単位の集計不能 ○ |
| Hint via Dandelion | 全体投稿レートは観測可能 △ |
| Cover hint 不採用 | 攻撃者から見ても本物トラフィック量 = 真のレート × |

**評価**: △ 部分防御。「全体投稿レート」は隠せない。Cover traffic 不採用の対価。

### 9.2.4 Channel enumeration

**攻撃シナリオ**: DHT 全鍵スキャンで存在する channel を列挙。

| 防御要素 | 効果 |
|---|---|
| Slot key が 256-bit ランダム | 列挙不可 (2^256) ◎ |
| HMAC-derived slot_key も secret 必要 | 同上 ◎ |

**評価**: ◎ 完全防御。スキャンによる発見は計算量的に不可能。

---

## 9.3 相関攻撃

### 9.3.1 Per-channel correlation

**攻撃シナリオ**: 同一 channel の複数 entry を同一投稿者に紐付け。

| 防御要素 | 効果 |
|---|---|
| `Log` の各投稿は独立 IMMUTABLE slot（別鍵） | 投稿同士が slot 鍵で結びつかない ◎ |
| Entry の writer_pubkey は anonymous mode で空 | 識別子なし ◎ |
| 署名付き mode (allowed_writers) | 署名で writer が明示される (意図的) - |
| **Hint の blind_tag（同一 cap・同一分で同値）** | **同一 channel 宛 Hint を 1 分粒度で束ねられる △ (H3)** |

**評価**: slot レベルでは **◎ 完全防御**（旧 BundledChannel の「全 entry が 1 slot」より改善）。ただし **Hint の blind_tag による分内リンク可能性 (H3)** が残るため、同一 channel の Hint 群は 1 分単位で相関され得る。高匿名用途（DM）は `Log` の `unlinkable: true`（blind_tag 不使用・trial-decrypt）で回避。

### 9.3.2 Cross-channel profiling

**攻撃シナリオ**: 複数 channel の観測を統合して「この人は X, Y, Z チャンネルを読んでる」プロファイル化。

| 防御要素 | 効果 |
|---|---|
| Channel 間で独立 Capability | 同一 channel の slot 群同士しか結びつかない ○ |
| Slot key は channel 別 | 観測から channel 識別不能 ◎ |
| Hint も channel 別 blind_tag | 観測から channel 識別不能 ◎ |

**評価**: ◎ 完全防御。channel 横断の profiling は (slot/hint 鍵が独立なので) 不可能。

### 9.3.3 Position-identity linking

**攻撃シナリオ**: Ring 上の固定 position から identity 推定。

| 防御要素 | 効果 |
|---|---|
| Bound Identity (`peerId = SHA256(pubkey)`) | position は pubkey 起源、誤魔化せない |
| Position はリスタートで変わらない | 長期観測で安定 △ |
| 投稿は Dandelion stem 経由 | 起点 = 自分の隣人、推定難 ○ |

**評価**: △ 部分防御。Position は長期 identity に紐づくが、投稿経路は隠れる。完全防御には pseudonym rotation が必要 (本設計では out-of-scope)。

### 9.3.4 PoW fingerprinting

**攻撃シナリオ**: PoW パターン (計算速度、難易度) から個体識別。

| 防御要素 | 効果 |
|---|---|
| PoW は post 内容にバインド | 投稿ごとに異なる △ |
| 計算時間は environment 依存 | デバイス特定可能 × |

**評価**: × 防御なし。Application 層で対処すべき (例: 計算時間にジッタ)。

---

## 9.4 検閲攻撃

### 9.4.1 Targeted Eclipse (特定 slot 狙い)

**攻撃シナリオ**: 攻撃者が特定 slot の K=5 nearest を全部自分のノードで埋める → GET 妨害、PUT 黙殺。

| 防御要素 | 効果 |
|---|---|
| Slot key が予測不能 (Mode A の secret 未保有時) | 攻撃対象を選べない ◎ |
| Slot key が予測可能 (Mode A の secret 保有時) | Bound Identity で position grind 必要 ○ |
| K-nearest 帰属検証 (PUT 時) | 圏外攻撃者の偽装 PUT を拒否 ◎ |

**評価**: secret 未保有攻撃者には **◎ 完全防御**。secret 保有攻撃者 (= channel メンバー内部攻撃) は別の問題で、application 層の moderation で対処。

### 9.4.2 Channel takeover

**攻撃シナリオ**: ある板/会話の全 slot の K-nearest を制圧。

| 防御要素 | 効果 |
|---|---|
| `Log` は投稿ごとに別 IMMUTABLE slot（リング全体に分散） | 単一ホットスロットが存在しない ◎ |
| 1 投稿を消すには その slot の K-nearest 5 個を制圧 | 投稿 N 件で N × 5 position 制御が必要 ○ |
| Bound Identity + PoW Identity | position grind に PoW コスト ○ |

**評価**: ○ 強い防御（旧 BundledChannel の「1 slot 集中」弱点は解消）。`Log` は投稿が分散するため、channel 全体の takeover には投稿数に比例した position 制御が必要になり、現実的に困難。残る攻撃面は **バンドルの省略（ソフト検閲）** だが、これは偽造不能で複数 provider の union とライブ gossip で緩和する（完全な履歴完全性は匿名 P2P BBS では非保証、9.9 参照）。

### 9.4.3 PUT suppression

**攻撃シナリオ**: 担当ノードが受信 PUT を捨てる。

| 防御要素 | 効果 |
|---|---|
| K=5 並列 PUT | 5 ノードのうち 1 個でも保存すれば retrieval 成功 ○ |
| ReplicationManager で補充 | 後から K-nearest になる ○ |

**評価**: K=5 中 5 個全員が悪意でない限り防御可能。**○ 強い防御**。

### 9.4.4 GET poisoning

**攻撃シナリオ**: 担当ノードが偽データで応答。

| 防御要素 | 効果 |
|---|---|
| CHK 自己検証 (受信時) | 偽 payload は弾く ◎ |
| writer 署名検証 | 偽 writer の上書きを拒否 ◎ |
| K=5 並列 GET | 最新 version を全応答から選ぶ ○ |

**評価**: ◎ 完全防御。受信側が必ず検証する。

---

## 9.5 ストレージ攻撃

### 9.5.1 Bloat attack

**攻撃シナリオ**: 任意 slot に大量データを詰める。

| 防御要素 | 効果 |
|---|---|
| MAX_PAYLOAD_SIZE 制限 | 64KB 上限 ◎ |
| PoW 必須（フロア 20-bit、動的引き上げ） | 大量 PUT のコスト増。ただし WASM 攻撃者には限定的 △→○ (H2) |
| K-nearest 帰属検証 | honest ノードの資源管理であって攻撃防御ではない（M1） |
| 重み付け / ランダム evict | 容量飽和時、標的 eviction を防ぐ ○ (H2) |

**評価**: ○ 強い防御。旧 16-bit PoW では WASM/native 攻撃者に対し無力（標的 LRU eviction が可能）だったため、**フロアを 20-bit に引き上げ + 動的難易度 + eviction のランダム化/重み付け** で対処。経済的完全防御 (◎) ではなく「コストを実用的困難に上げる」レベルと評価を修正。

### 9.5.2 Quota exhaustion

**攻撃シナリオ**: IndexedDB のクォータを使い切らせる。

| 防御要素 | 効果 |
|---|---|
| 自ノードの MAX_STORAGE_BYTES 制限 | クライアント側で制御 ◎ |
| TTL + GC | 自動消滅 ○ |
| LRU evict | 圧迫時の自動削除 ○ |

**評価**: ◎ 完全防御。クライアントが自分のクォータを管理する。

### 9.5.3 Replication amplification

**攻撃シナリオ**: 汚染データを ReplicationManager に拡散させる。

| 防御要素 | 効果 |
|---|---|
| ReplicationManager は validated slot のみ送る | 汚染 slot は store に入らない ◎ |
| 送信先も検証 | 受信側で再検証 ◎ |

**評価**: ◎ 完全防御。検証チェーンが切れない。

### 9.5.4 PoW bypass

**攻撃シナリオ**: PoW なしで PUT を通す。

| 防御要素 | 効果 |
|---|---|
| SlotValidator で必須化 | 検証失敗で reject ◎ |
| 全ノードで同じ検証 | 1 ノードだけ甘くしても他で弾く ◎ |

**評価**: ◎ 完全防御。

---

## 9.6 Identity 攻撃

### 9.6.1 Position spoofing

**攻撃シナリオ**: 任意の Ring position を主張。

| 防御要素 | 効果 |
|---|---|
| Bound Identity: `position = SHA256(peerId)` | 自由選択不能 ◎ |
| `peerId = SHA256(pubkey)` | 公開鍵 grind コストが発生 ○ |

**評価**: ◎ 完全防御 (基本的な位置改竄)。Grind による精密位置選択は別途 (下記)。

### 9.6.2 PeerId grinding

**攻撃シナリオ**: 特定 position に来る公開鍵を計算。

| 防御要素 | 効果 |
|---|---|
| 公開鍵 grind コスト | 平均 2^L iteration for L-bit precision |
| (オプション) PoW Identity | 追加 ~20-bit PoW で grind コスト × 2^20 |

評価:
- 16-bit precision の position 一致を狙うと ~65000 iteration × Ed25519 keygen ~10ms = ~10 分 / position
- 32-bit precision なら ~年単位

**評価**: ○ 強い防御。短期 grind は可能だが、複数 position を狙うには時間が必要。

### 9.6.3 Sybil mass production

**攻撃シナリオ**: 大量の独立 peerId 生成。

| 防御要素 | 効果 |
|---|---|
| Bound Identity の鍵生成コスト | 10ms × 万単位なら現実的 △ |
| PoW Identity (オプション) | 1 peerId あたり ~30 秒 ○ |
| K-nearest 必要数 (K=5) | 5 個の grind が必要 ○ |

**評価**: ○ 強い防御 (PoW Identity 有効化時)。なしだと △。

### 9.6.4 Identity replay

**攻撃シナリオ**: 他者の peerId を主張する。

| 防御要素 | 効果 |
|---|---|
| 接続時の署名チェック | 秘密鍵保有者しか発言できない ◎ |
| Slot writer_sig | 偽の writer は拒否 ◎ |

**評価**: ◎ 完全防御。

---

## 9.7 交差攻撃 (Out of scope)

本設計は対応しないが、application 層対応のヒント:

### 9.7.1 Online-time intersection

| 緩和策 (Application 層) | 効果 |
|---|---|
| ランダム化されたオンライン時刻 | 共通 set 縮小 |
| パッシブ mode (受信のみ) | 投稿時刻と乖離 |
| 専用デバイス使用 | 行動パターン分離 |

### 9.7.2 Long-term observation

| 緩和策 | 効果 |
|---|---|
| 期間ごとの pseudonym rotation | 長期 identity 切断 |
| Application 層 cover post | パターン混乱 |

### 9.7.3 Friend graph reconstruction

| 緩和策 | 効果 |
|---|---|
| DM だけ専用 Identity 使用 | BBS 活動と分離 |
| グループチャットは別 device | クロス汚染防止 |

---

## 9.8 Application 別評価サマリ

### 9.8.1 BBS

| 攻撃 | 防御水準 | 備考 |
|---|---|---|
| 板内検閲 (target eclipse) | ◎ | slot key 予測不能 |
| 投稿者特定 | ○ | Dandelion 経由、完全には無理 |
| 閲覧者特定 (第三者) | ◎ | Hint 暗号化 |
| 閲覧者特定 (同 board メンバー) | × | 設計上の前提 |
| Sybil による大量投稿 | ○ | PoW で抑制 |
| 過去ログ流出 (board_key 漏れ後) | × | Forward secrecy なし |

### 9.8.2 DM

| 攻撃 | 防御水準 | 備考 |
|---|---|---|
| 通信ペア特定 | ◎ | Hint 暗号化、cap 別 |
| 投稿時刻特定 | △ | 観測されると後追い可能 |
| メッセージ内容流出 | ◎ | AEAD |
| 通信履歴改竄 | ◎ | writer 署名 |
| Burn-on-Read の保証 | △ | best-effort、強制力なし |

### 9.8.3 ファイル共有

| 攻撃 | 防御水準 | 備考 |
|---|---|---|
| ファイル内容漏洩 (第三者) | ◎ | 各 chunk が AEAD |
| ファイル削除 (検閲) | ○ | 多数 chunk 制圧必要 |
| バージョン改竄 | ◎ | OwnedPointer 署名 + version 単調（GET も署名検証 C2） |
| Manifest 偽造 | ◎ | signing 署名 |

### 9.8.4 グループチャット

| 攻撃 | 防御水準 | 備考 |
|---|---|---|
| 非メンバーによる閲覧 | ◎ | secret 必要 |
| 退会者の継続閲覧 | △ | rekey 必要 |
| メンバーシップ改竄 | ◎ | admin 署名 |
| 過去メッセージ流出 (退会者経由) | △ | rekey 後の新 message のみ守られる |

---

## 9.9 残存リスクの明示

本 Substrate v2 で **対応しないリスク**:

1. **交差攻撃全般**: 時刻相関、長期観測。Application 層で対処。
2. **IP 完全秘匿**: WebRTC 制約。隣人にはバレる。
3. **Browser/OS 脆弱性**: 設計外。
4. **物理アクセス**: device security の問題。
5. **法的圧力**: 鍵提出強制への対抗は設計外。
6. **量子コンピュータ**: 現代暗号原始を信頼する前提。将来 Hybrid KEM 導入で備える。
7. **アプリ層プライバシ**: 投稿内容のスタイル分析、メタデータ等。

---

## 9.10 セキュリティ監査チェックリスト

実装完了時に確認すべき項目:

### Layer 2 (Substrate)

- [ ] `validateSelfContained`（CHK+PoW+class+署名）が **SLOT_PUT と SLOT_RES の両方** で実行されているか (C2)
- [ ] PoW base / 署名 base が `slot_class, version, expires_at, created_at` を束縛しているか (H1)
- [ ] 封印形式 `payload = nonce(12)||ct` を全暗号化が使い、固定/ゼロ nonce が無いか (C3)
- [ ] `payload_hash = SHA256(payload)` が nonce を覆っているか (C3)
- [ ] IMMUTABLE は version=0 固定・上書き不可、異内容書き込みが `immutable_collision` で拒否されるか (C1)
- [ ] OWNED_POINTER は writer_pubkey/writer_sig 必須、同一 writer・version 単調が強制されるか
- [ ] GET の version 順位付けが **署名検証済み OWNED_POINTER のみ** を対象にしているか (C2)
- [ ] PoW フロア（slot 20 / hint 18 bit）が守られ、検証も同一 WASM 実装か (H2)
- [ ] LRU eviction が PoW 重み付け or ランダム化されているか（標的 eviction 防止 H2）
- [ ] Hint AEAD 復号失敗が secret leak しないか (timing safe)
- [ ] blind_tag の分内リンク可能性 (H3) を脅威モデルに明記、高匿名は unlinkable 購読か
- [ ] BlindTagIndex の memory 使用量が制限されているか

### Layer 3 (Capabilities)

- [ ] Capability の root_secret がメモリから消去可能か
- [ ] 全派生鍵が HKDF に統一され、slot label が長さ前置で衝突回避されているか (M4)
- [ ] OwnedPointer.resolve が owner 一致を確認し、署名は get 経由で検証済みか (C2)
- [ ] `Log` の各投稿が独立 IMMUTABLE slot（別鍵）で、並行投稿のデータ消失が無いか (C1)
- [ ] バンドルの省略（ソフト検閲）が union で緩和される設計になっているか

### Layer 4 (Applications)

- [ ] 各 application が独立 root_secret を使っているか
- [ ] BBS の anonymous mode で identity 漏洩がないか
- [ ] DM の Burn-on-Read が best-effort であることをドキュメント化しているか
- [ ] ファイル manifest の hash 検証が全 chunk について行われているか

### 全体

- [ ] Bound Identity が改竄不能になっているか (`peerId = SHA256(pubkey)` の検証)
- [ ] Sybil 抑制策が active になっているか (PoW Identity etc.)
- [ ] ReplicationManager が validated slot のみ送るか
- [ ] HintBus が seen キャッシュで重複排除しているか

---

## 9.11 次に読む

→ [10_migration.md](./10_migration.md): 実装移行戦略
→ [11_roadmap.md](./11_roadmap.md): 段階的導入計画
