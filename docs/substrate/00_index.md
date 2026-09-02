# AETHER Web-Lite Substrate v2: Schrödinger Architecture

**ステータス**: 設計確定 (Draft → Approved)、**v2.1 低レイヤー脆弱性修正済み (2026-06-10)**
**最終更新**: 2026-06-10
**対象**: aether-web-lite (TypeScript + WebRTC + IndexedDB)
**前バージョン**: [aether_web_lite_design.md](../aether_web_lite_design.md)

---

## このドキュメント群について

本ディレクトリは、aether-web-lite を **「BBS 専用システム」から「匿名分散ストレージの汎用基盤 (Substrate)」へ再構築するための設計書**である。

BBS は最初のアプリケーションに過ぎず、同一基盤の上に **DM、ファイル共有、グループチャット、pub-sub** などを順次載せていく。

設計の核心:
- **Schrödinger Mailbox 原則**: 保存ノードは「何のデータか」を知らない
- **Speed-First**: 現状速度 (BBS read ~250ms, post ~175ms) を維持する
- **Capability-based**: 鍵の所有 = 権限。Tahoe-LAFS 流
- **Composable Primitives**: 少数のプリミティブを組み合わせて多用途に対応
- **交差攻撃は Application 層責務**: Substrate では扱わない (cover traffic 不採用)

---

## 目次

| # | ファイル | 内容 |
|:--|:--|:--|
| 1 | [01_overview.md](./01_overview.md) | 設計動機・ゴール・現状とのギャップ |
| 2 | [02_threat_model.md](./02_threat_model.md) | 脅威モデル・攻撃カテゴリ・スコープ |
| 3 | [03_layered_architecture.md](./03_layered_architecture.md) | 4 層アーキテクチャと責務分割 |
| 4 | [04_layer2_primitives.md](./04_layer2_primitives.md) | Slot, Hint プリミティブの完全仕様 |
| 5 | [05_layer3_capabilities.md](./05_layer3_capabilities.md) | OwnedPointer, Log, ChunkSet |
| 6 | [06_layer4_applications.md](./06_layer4_applications.md) | BBS / DM / File / GroupChat への適用 |
| 7 | [07_wire_protocol.md](./07_wire_protocol.md) | WireType・バイト構造・MsgPack スキーマ |
| 8 | [08_performance.md](./08_performance.md) | 速度評価とボトルネック分析 |
| 9 | [09_security_analysis.md](./09_security_analysis.md) | 攻撃別防御評価・残存リスク |
| 10 | [10_migration.md](./10_migration.md) | 既存コードからの移行マッピング |
| 11 | [11_roadmap.md](./11_roadmap.md) | Phase 1-5 段階導入計画 |
| 12 | [12_open_questions.md](./12_open_questions.md) | 未決事項と論点 |

---

## 関連ドキュメント

| 文書 | 関係 |
|:--|:--|
| [../aether_web_lite_design.md](../aether_web_lite_design.md) | 旧アーキテクチャ。本 Substrate v2 で置換 |
| [../architecture_audit.md](../architecture_audit.md) | 旧アーキの脆弱性監査。本 v2 で解消 |
| [../discovery_protocol_design_aether_core.md](../discovery_protocol_design_aether_core.md) | 本家 AETHER Core の discovery 設計 |
| [../AETHER_Core/detailed_implementation/11_schrodinger_mailbox.md](../AETHER_Core/detailed_implementation/11_schrodinger_mailbox.md) | Schrödinger Mailbox 原典 (本家 DM 版) |
| [../AETHER_Core/detailed_implementation/10_architecture_revision.md](../AETHER_Core/detailed_implementation/10_architecture_revision.md) | 本家 v2 改訂 (Relay + Schrödinger) |
| [../spec/step5_dandelion.md](../spec/step5_dandelion.md) | 既存 Dandelion 実装 (Substrate v2 で再利用) |

---

## 主要な設計判断のサマリ

| 判断 | 理由 |
|---|---|
| Cover Traffic 採用しない | 速度劣化が大きい。交差攻撃は application 層で対応 |
| Relay/Onion 採用しない | Web-lite の意図的トレードオフ。可用性優先 |
| Slot 鍵の Derived/Random 両モードサポート | BBS 速度維持 + DM 完全匿名の両立 |
| Bound Identity (`peerId = SHA256(pubkey)`) | Eclipse 攻撃の根本封じ |
| handlePut で PoW + CHK + 帰属検証必須 | ストレージ攻撃の根本封じ |
| 既存 Dandelion をそのまま再利用 | 速度と実装コストの最適点 |
| 多人数書き込みは不変 (IMMUTABLE) アイテムの `Log` に統合 | 中身を見ない保管ノードは共有 blob の追記を検証不能。並行書き込みのデータ消失も解消 |
| 可変は単一所有者の `OwnedPointer` のみ | 可変ロジックを 1 箇所に隔離し安全に |
| 過去ログは IMMUTABLE バンドル + gossip union | 64KB 制限を超えてスケール、偽造不能（省略のみ） |

---

## 用語集

| 用語 | 意味 |
|---|---|
| **Substrate** | Layer 2 までの汎用基盤。Application 非依存 |
| **Capability** | Layer 3 のアクセス権オブジェクト。鍵 + 派生関数の束 |
| **Slot** | ランダム or 導出鍵で識別される暗号化バイト列の保管単位 |
| **slot_class** | `IMMUTABLE`(write-once) / `OWNED_POINTER`(単一所有者可変) の区別。PoW/署名に束縛 |
| **IMMUTABLE** | write-once Slot。多人数 / 並行書き込みはすべてこれ |
| **OWNED_POINTER** | 単一署名者だけが version 単調増加で上書きできる Slot |
| **Hint** | Gossip 経由で配信される暗号化 slot_key 通知 |
| **Blind Tag** | Hint の高速フィルタ用 4 バイトタグ（分内リンク可能性あり H3） |
| **Log** | 不変アイテム追記列の抽象（BBS/DM/グループ/pub-sub 共通）。ライブ=Hint、過去=バンドル |
| **OwnedPointer** | 単一所有者の可変指標（head / manifest / member list） |
| **バンドル** | seq 範囲のアイテム鍵リストを 1 個の IMMUTABLE slot にまとめた過去ログキャッシュ |
| **封印形式** | `payload = nonce(12) || ciphertext+tag`。CHK が nonce を覆う（4.1.4） |
| **Mode A (Derived)** | slot_key = HMAC(secret, label)。fast、predictable |
| **Mode B (Random)** | slot_key = SHA256(random)。slow、unpredictable |
| **CHK** | Content Hash Key。`payload_hash == SHA256(payload)` 検証 |
| **K-nearest** | Ring 上で target に最も近い K (=5) 個のノード |
| **Bound Identity** | `peerId = SHA256(pubkey)`, `position = SHA256(peerId)` |

---

## 読む順序の推奨

- **初見**: 01 → 02 → 03 → 04 → 05 で全体感を掴む
- **実装者**: 03 → 04 → 07 → 10 → 11 で着手範囲を確認
- **セキュリティレビュアー**: 02 → 09 → 04 で攻撃面と防御を確認
- **アプリ開発者**: 03 → 05 → 06 で API を理解
