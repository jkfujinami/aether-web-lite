# Part 12: Open Questions — 未決事項と論点

設計上で意図的に未決にしている、または将来の議論対象となる項目をまとめる。実装前に解決すべきもの、運用しながら判断するもの、長期検討事項に分類する。

---

## 12.1 実装前に解決すべき

### Q1: PoW 難易度の動的調整パラメータ

現状の `DifficultyEstimator` (WINDOW=128) をそのまま流用する想定だが:

- Slot PoW 用、Hint PoW 用、Chunk PoW 用で別 windows が必要か?
- Hint と Slot で同じ window を共有すると、Hint レートが Slot 難易度を歪める可能性
- Application 別 (BBS vs DM vs File) で別調整するか?

**判断要件**: Phase 2 開始前
**暫定**: Slot/Hint で共通、固定差分 (`HINT_DIFFICULTY = SLOT_DIFFICULTY - 4`)
**残課題**: Phase 5 で実測ベースでチューニング

---

### Q2: Log の writer ポリシー（v2.1 で整理済み）

旧 BundledChannel の「誰が 1 slot を上書きするか」問題は、`Log`（各投稿が独立 IMMUTABLE slot）で消滅した。投稿者ポリシーは `Log` のオプションで表現:

- **A. anonymous**: writer 無し（署名なし）。BBS 板の既定
- **B. allowed_writers**: pubkey allowlist。グループチャット（member list 経由）
- **C. signed (任意)**: writer_sig は付けるが allowlist 無し。トリップ/cap名の真正性用

採用:
- BBS: A or C（誰でも投稿、署名は任意）
- Group chat: B
- `OwnedPointer`（head/member list）のみ単一 owner_pubkey を要求

**ステータス**: v2.1 で解決済み（[05](./05_layer3_capabilities.md) `Log`）

---

### Q3: Hint Catchup の認可ポリシー

`HINT_CATCHUP_REQ` を受け取ったとき、無条件に応答していいか?

リスク:
- 攻撃者が大量 catchup_req でリソース消費
- 自分のキャッシュを全部送る = リーク

緩和案:
- リクエスト元ピアあたり 1 分 1 回まで
- レスポンス上限 100 hints
- 自分が保管中の Hint のみ送る (中継した hint は別カウント)

**判断要件**: Phase 4 開始前

---

### Q3b: JOIN ハンドシェイクの pubkey 所有証明 (M2)

Bound Identity（`position = SHA256(SHA256(pubkey))`）は「接続ピアが当該 pubkey の秘密鍵を保有する」ことを **JOIN 時に challenge-response で証明する**前提で初めて意味を持つ。現状の substrate docs はこの challenge を規定しておらず、Layer 1（`network/` の JOIN プロトコル）側の責務。

リスク: freshness challenge が無いと、他人の JOIN 署名を録って **identity replay** が可能。Bound Identity の強度はこのハンドシェイク認証以上にはならない。

**判断要件**: Phase 1（Bound Identity 化）と同時。JOIN に「サーバ/相手が出す nonce への署名」を含めること。
**ステータス**: 未解決。Layer 1 プロトコル仕様で定義が必要。

### Q4: Slot 保管クォータ

1 ノードあたりどれくらいのストレージを Slot 保管に使う?

- IndexedDB のクォータは ~1GB が現実的上限
- BBS だけなら 100MB で十分
- ファイル共有が乗ると数 GB ほしくなる

選択肢:
- **固定**: 100MB ハードコード
- **動的**: 起動時にユーザーに尋ねる
- **設定**: 設定画面で調整可能

採用案: デフォルト 100MB、設定画面で 1GB まで上げられる

**判断要件**: Phase 2 開始前

---

### Q5: Capability URI 形式

URI 仕様を確定する必要あり。

提案:
```
aether://cap/<type>/v<version>?<key>=<value>&...
```

未決:
- フラグメント (`#`) 部分の意味 (secret 部を含めるか、metadata だけか)
- base64url vs base32
- DM 招待 URL の特殊フォーマット
- QR コードでの最適化 (短さ重視か)

**判断要件**: Phase 3 完了前 (export 機能実装前)

---

### Q6: 旧データマイグレーション

Phase 3 で旧 BBS データをどう Substrate へ移すか?

選択肢:
- **A. 自動マイグレーション**: 起動時に変換、ユーザーに見えない
- **B. 手動エクスポート/インポート**: ユーザーが明示
- **C. 並存**: 旧データは旧 UI で読み出し、新規は新 UI

採用案: A + 旧 UI フォールバック保持 (Phase 5 で削除)

**判断要件**: Phase 3 開始前

---

## 12.2 運用しながら判断する

### Q7: Log 過去ログのバンドル range 粒度

書き込み衝突は v2.1 の `Log`（独立 IMMUTABLE slot）で消滅したため、旧「sub-slot 化のタイミング」問題は解消。残る調整対象は **過去ログのバンドル range 粒度**:

- range が大きすぎ: 1 バンドルが 64KB（アイテム鍵 ~2000 個）に近づき分割が必要
- range が小さすぎ: コールド参加時の並列 GET 本数が増える

**判断要件**: Phase 3 リリース後、実測ベース
**暫定**: 1 バンドル = 256 アイテム鍵（~8KB）で開始、活発度に応じ調整

---

### Q8: Hint 配信のゾーン化

Phase 4 で Hint は全ピアに flood するが、規模化したら zone-aware にする必要あり。

- 何ノードを超えたら zone 分割?
- 1 hint あたり何 zone に配信?
- HintBus の subscriber がどの zone に対応するか管理が必要

**判断要件**: Phase 5 リリース後、ノード数増加時
**暫定**: 最大 1000 ノードまで全配信、それ以降に zone 化

---

### Q9: TTL のデフォルト値

各 application で適切な TTL:

| Application | 暫定 TTL | 検討事項 |
|---|---|---|
| BBS post | 30 日 | スレ落ちタイミング |
| DM | 7 日 | 受信確認後の短縮? |
| File chunk | 永続 (90 日) | manifest が生きてれば |
| Group chat | 30 日 | 退会 member の継続閲覧防止 |
| Pointer | 365 日 | 長期参照 |

**判断要件**: Phase 5 リリース後、ストレージ使用量見て調整

---

### Q10: PoW Identity の必要性

Phase 1 で Bound Identity を入れるが、追加で PoW Identity (`leading_zeros(SHA256(pubkey)) >= D_id`) を要求するか?

- 利点: Sybil 抑制効果が桁違いに上がる
- 欠点: 起動時の鍵生成が遅くなる (~30 秒)
- ユーザー体験との両立が難しい

**判断要件**: Phase 1-2 で観測。Sybil 攻撃の頻度次第
**暫定**: Phase 1 では Bound Identity のみ、Phase 4 以降で必要なら追加

---

## 12.3 長期検討事項

### Q11: 完全な X3DH

DM の鍵交換を簡易版 (X25519 鍵交換 + signed exchange) から本格 X3DH (ID Key + Signed Prekey + Onetime Prekey) に移行するか?

- Forward secrecy 確保
- Asynchronous key agreement
- 但しブラウザ実装コスト大

**判断要件**: DM 機能の利用実績次第
**Phase**: 8 以降

---

### Q12: Double Ratchet 統合

DM に Double Ratchet (Signal 風) を統合するか?

- 利点: Per-message forward secrecy
- 欠点: BBS と思想が違う (BBS は永続前提、DM は ephemeral)

**判断要件**: DM の本格運用次第
**Phase**: 9 以降

---

### Q13: Hybrid KEM (耐量子)

現状 X25519 + Ed25519 だが、Kyber 等のハイブリッドに移行?

- 利点: 量子耐性
- 欠点: WASM ビルドサイズ +500KB、性能影響

**判断要件**: 量子コンピュータの脅威レベル次第 (NIST 標準化進捗)
**Phase**: 9 以降

---

### Q14: Reed-Solomon ChunkSet

ChunkSet を 3+2 erasure coding にするか?

- 利点: 5 chunks のうち 3 個で復元、可用性向上
- 欠点: ストレージ 1.67x、エンコード/デコード CPU 増

**判断要件**: ファイル共有の運用ニーズ
**Phase**: 6 以降

---

### Q15: pseudonym rotation

Long-term identity と short-term pseudonym を分離するか?

- 用途: 同じ device で複数の identity を切り替え
- 設計: signing key の階層化、device key で sub-key を派生

**判断要件**: ユーザーフィードバック
**Phase**: 7 以降

---

### Q16: Application 間の相互運用

将来:
- BBS の投稿をファイルとして export
- DM 履歴をグループ chat に変換
- ファイルを BBS に添付

これらを substrate レベルでサポートするか?

**判断要件**: ユースケースの蓄積
**Phase**: 不定

---

## 12.4 設計上のオープン論点

### D1: Cover Traffic を後から足せるか?

本設計は cover traffic 不採用だが、将来オプション機能として足せるか?

設計上の答え: **足せる**。
- HintBus に dummy hint を交ぜる API
- SlotStore に cover get を交ぜる API
- どちらも application 側で発動

ただし発動方針 (頻度、対象) は application 責務。Substrate は仕組みだけ提供。

---

### D2: 中央 Bootstrap への依存度

Substrate は完全 P2P を目指すが、起動時の Bootstrap (Signaling, Tracker) は中央集権的。

- 完全分散化への道筋: Nostr Relay 等を bootstrap として複数列挙
- DNS Seed パターン
- 既存ピアからのリレー (PEX)

**未決**: Phase 1-5 では既存 SignalingClient + Tracker 構成を維持。完全分散化は別 work stream。

---

### D3: Identity の export / import

別 device で同じ identity を使いたい:
- 秘密鍵を QR で移行
- パスフレーズで暗号化したバックアップ
- マルチデバイス同期 (=要 server)

完全分散化との両立が難しい。

**未決**: ユーザー要望次第。Phase 8 以降で検討。

---

### D4: Substrate API の安定性 (Versioning)

Substrate v2 の API が固まったあと、v3 への移行はどうする?

- WireType の version field 必須化
- Capability の version field
- Migration tools

**未決**: v2 リリース後、v3 議論開始時に決める。

---

## 12.5 既知の trade-off (再確認)

設計確定した妥協点。後から「これって本当に正しかった?」と再考する可能性あり。

### T1: Cover Traffic 不採用

→ 交差攻撃に対する根本対策が無い。Application 層で対処する前提。
**再考タイミング**: 交差攻撃の実例が観測されたとき。

### T2: 過去ログの完全性は非保証（v2.1 で性質が変化）

→ 旧 BundledChannel の「1 slot 集中・衝突」は `Log` で解消したが、代わりに **過去ログの完全性は保証しない**。バンドル提供者はアイテムを省略でき（ソフト検閲）、完全な履歴は複数 provider の union + ライブ gossip でしか近似できない（偽造は不能）。これは匿名 P2P BBS の本質的限界で、旧設計も truncate 上書きで同等以上に脆かった。
**再考タイミング**: 履歴完全性が要件化したとき（署名付き連鎖バンドル等を検討）。

### T3: Hint の time_bucket 1 分粒度

→ 時刻情報が漏れる。
**再考タイミング**: メタデータ漏洩の問題化時。粒度を 5 分等に粗くする検討。

### T3b: blind_tag の分内リンク可能性 (H3)

→ blind_tag は「同一 cap・同一 time_bucket で同値」なので、観測者は復号できなくても同一受信者宛 Hint を 1 分単位で束ねられる。「予測可能 tag による O(1) 発見」と「非リンク性」が原理的に両立しないトレードオフ。
**現状の立場**: 分内リンクは許容。高匿名 cap（DM）は `unlinkable: true`（blind_tag 不使用・trial-decrypt O(N_caps)）で回避。
**再考タイミング**: 高匿名 cap が大量化し trial-decrypt コストが問題化したとき。

### T4: Forward secrecy なし

→ Capability 流出時に過去全 entries が復号可能。
**再考タイミング**: BBS で sensitive な内容を扱うニーズが出たとき。Capability epoch 化で対応。

### T5: Burn-on-Read の best-effort

→ DM の完全削除は保証できない。
**再考タイミング**: DM の本格運用時。Application 層の disclaimer。

### T6: Hint の zone 化遅延

→ 大規模化したときの帯域問題。
**再考タイミング**: 1000+ ノード到達時。

---

## 12.6 議論記録のため (FYI)

このセクションは将来「なぜこう決めたか」を振り返るための記録。

### R1: なぜ Cover Traffic を捨てたか (2026-06-04)

- 速度劣化が許容範囲を超える (post 175ms → 200ms+, read 250ms → 5-30s)
- 交差攻撃は application 層で対応する判断
- BBS / DM の主要ニーズは「メタデータ秘匿」であり「交差耐性」ではない
- Web-lite の哲学 (シンプル、高速、現実的) に合う

### R2: なぜ Mode A と Mode B を両方サポートするか (2026-06-04)

- BBS と DM で必要な性質が違う
- BBS は速度優先 → Mode A
- DM は匿名性優先 → Mode B
- 1 つの substrate で両方サポートすることでコード重複を防ぐ
- Application が選択責任を負うことで柔軟性を確保

### R3: なぜ Capability ベースにしたか (2026-06-04)

- Tahoe-LAFS の実績を参考
- 鍵の所有 = 権限という model がシンプル
- Application 間で権限を渡せる (URI / QR)
- Reading capability と Writing capability を分離可能
- Object-capability security の思想と整合

### R5: なぜ BundledChannel を廃止し IMMUTABLE Log に再構成したか (2026-06-10)

低レイヤーのセキュリティ検証で、骨格に致命的な矛盾が見つかったため:

- **C1（致命）**: SlotValidator の上書きルール（既存があれば同一 writer 署名必須）と、BundledChannel の「1 slot を全員で上書き蓄積」が矛盾。**スレの 2 人目が投稿できない**（匿名なら初回以降誰も書けない）。
- **64KB 制限**: 1 slot に全 entry を詰める設計は ~130 投稿で `payload_too_large`。そもそもスケールしない。
- **根本原因**: 中身を見ない保管ノード（Schrödinger node）は、暗号化された多人数共有 blob の「追記のみ」を検証できない。よって **多人数 / 並行で書くものは不変 (write-once) でなければならない**。可変は単一署名者が所有する `OwnedPointer` のみ安全。
- **解**: 投稿 = 独立 IMMUTABLE slot（衝突なし）、発見 = Hint（ライブ）+ バンドル（過去ログ）。DM の `HintedInbox` が偶然この正しい形をしていたので、BBS を DM 側に寄せ、両者を `Log` に統合。コードも減った。

あわせて C2（GET 応答の署名未検証）、C3（AEAD nonce 未仕様）、H1（TTL/created_at 無認証）、H2（PoW フロア過小）、H3（blind_tag 分内リンク）、M1/M4 を修正。詳細は各 Part の v2.1 改訂ノート。

### R4: なぜ Layer 構造を明示したか (2026-06-04)

- 旧アーキテクチャは BBS 概念が core まで漏れていた
- 新 application 追加コストが線形に保てる
- テスト容易性
- 各層の責務が明確で、レビューしやすい

---

## 12.7 まとめ

本ドキュメント群はあくまで **設計の出発点**。実装過程で得た知見、運用データ、ユーザーフィードバックを反映して継続的に更新する。

未決事項の解決優先度:
1. **実装前に解決すべき** (Q1-Q6): Phase 開始前に判断必須
2. **運用しながら判断** (Q7-Q10): 実測データを集めてから
3. **長期検討** (Q11-Q16): 将来の要件次第
4. **設計論点** (D1-D4): 継続議論

---

## 12.8 ドキュメント終わりに

本 Substrate v2 設計書 (Part 1-12) は、aether-web-lite を BBS 専用システムから **「匿名分散ストレージの汎用基盤」へ進化させる**ための完全な指針である。

設計の核心:
- **Schrödinger 原則**: 保存ノードは内容を知らない
- **Speed-First**: 現状の速度を犠牲にしない
- **Capability-based**: 鍵の所有 = 権限
- **Composable Primitives**: 少数のプリミティブで多用途
- **Application-agnostic Substrate**: 用途拡張が線形

次のアクション:
1. 本ドキュメントを reviewer に展開、フィードバック収集
2. Phase 1 着手 (1 週間で現状脆弱性を塞ぐ)
3. 並行して Phase 2 の詳細仕様レビュー
4. 段階的に Phase 2-5 を進めて Substrate v2 完成

---

→ [00_index.md](./00_index.md) に戻る
