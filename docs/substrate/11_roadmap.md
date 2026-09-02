# Part 11: Roadmap — 段階的導入計画

## 11.1 全体スケジュール (概算)

```
Week  1   2   3   4   5   6   7   8   9   10
      │   │   │   │   │   │   │   │   │   │
Phase 1 ▓▓▓
Phase 2     ▓▓▓▓▓▓▓
Phase 3             ▓▓▓▓▓▓▓
Phase 4                     ▓▓▓▓▓▓▓
Phase 5                             ▓▓▓
将来                                     ▓▓▓▓▓
```

**総工数**: 約 8-10 週間 (Substrate 完成まで)。Phase 1 だけで現状脆弱性は塞がる。

---

## 11.2 Phase 1: 最小防御 (Week 1)

### 11.2.1 目的

既存アーキテクチャを変えず、致命的脆弱性 (Eclipse, PUT poisoning) を即座に塞ぐ。

### 11.2.2 タスク

| # | タスク | 工数 | 担当 |
|---|---|---|---|
| 1.1 | `RingPosition` を Bound Identity 化 | 0.5 day | - |
| 1.2 | `DHTMailbox.handlePut` に K-nearest 帰属検証追加 | 0.5 day | - |
| 1.3 | `DHTMailbox.handlePut` に PoW + CHK 検証追加 | 1 day | - |
| 1.4 | `DHTMailbox.handleRes` に CHK 自己検証追加 | 0.5 day | - |
| 1.5 | 単体テスト追加 (Sybil PUT 拒否、改竄 RES 拒否等) | 0.5 day | - |
| 1.6 | E2E 動作確認 (BBS の post-read が引き続き動く) | 0.5 day | - |
| 1.7 | 既存 `architecture_audit.md` を「Phase 1 で解消済み」マーク | 0.25 day | - |

合計: ~4 日

### 11.2.3 完了条件

- [ ] 全 単体テスト pass
- [ ] BBS 通常操作の動作確認 OK
- [ ] Sybil 攻撃シミュレーションで PUT が拒否されることを確認
- [ ] 改竄 RES が握りつぶされることを確認
- [ ] レイテンシ退化なし (post p99 ≤ 200ms 維持)

### 11.2.4 リスク

| リスク | 緩和策 |
|---|---|
| 既存 peer の localStorage に古い position が残っている | 起動時に新 position を計算、強制上書き |
| 既存ピアの PUT が新検証で弾かれる | feature flag で段階的 enable (production rollout 配慮) |

---

## 11.3 Phase 2: Slot プリミティブ導入 (Week 2-3)

### 11.3.1 目的

Substrate Layer 2 の `Slot` を完成させる。BBS はまだ旧プロトコル。

### 11.3.2 タスク

| # | タスク | 工数 |
|---|---|---|
| 2.1 | `substrate/slot/Slot.ts` 型定義 | 0.5 day |
| 2.2 | `substrate/slot/SlotValidator.ts` 実装 | 1 day |
| 2.3 | `substrate/slot/SlotStore.ts` インターフェース定義 | 0.5 day |
| 2.4 | `IndexedDBStore` に `slots` テーブル追加、`ISlotStore` 実装 | 1 day |
| 2.5 | `WireType.SLOT_PUT/GET/RES` 仕様確定、`WireCodec` 拡張 | 1 day |
| 2.6 | `MessageDispatcher` で SLOT_* を `SlotStore` にルーティング | 0.5 day |
| 2.7 | `SubstrateContext` (DI コンテナ) 実装 | 0.5 day |
| 2.8 | `substrate/capability/Capability.ts` 基底実装 | 1 day |
| 2.9 | 単体テスト + 統合テスト (Slot 単体での put/get) | 1 day |
| 2.10 | `simulation/` で 10 ノード Slot 操作の E2E テスト | 1 day |

合計: ~7 日

### 11.3.3 完了条件

- [ ] SLOT_PUT/GET/RES の wire レベル動作確認
- [ ] `SlotValidator` の全条件が単体テストでカバー
- [ ] 既存 BBS が動作し続ける (旧 DHT 経路維持)
- [ ] 新 wire 経由の Slot 操作 E2E pass

---

## 11.4 Phase 3: BBS を Log へ移行 (Week 4-5)

### 11.4.1 目的

BBS を `Log`（不変アイテム列）+ `OwnedPointer`（head）の上に乗せ直す。

### 11.4.2 タスク

| # | タスク | 工数 |
|---|---|---|
| 3.1 | `caps/OwnedPointer.ts` 実装 | 1 day |
| 3.2 | `caps/Log.ts` 実装 (publish/subscribe/fetchHistory) | 2 day |
| 3.3 | `caps/Log.ts` バンドル封印 + 過去ログ union | 1 day |
| 3.4 | `apps/bbs/BBSBoard.ts` (旧 `BoardOrchestrator` 置換) | 1.5 day |
| 3.5 | `apps/bbs/BBSThread.ts` (旧 `ThreadOrchestrator` 置換) | 1.5 day |
| 3.6 | 旧 BBS データのマイグレーション (起動時 1 回) | 1 day |
| 3.7 | UI フック (`useBoard`, `useThread`) 調整 | 1 day |
| 3.8 | E2E ブラウザテスト | 1 day |

合計: ~10 日

### 11.4.3 完了条件

- [ ] 全 BBS 機能が新 Capability 経由で動作
- [ ] 旧データの読み込みは互換維持
- [ ] Log の並行投稿でデータ消失が起きない（独立鍵）
- [ ] レイテンシ退化なし

### 11.4.4 リスク

| リスク | 緩和策 |
|---|---|
| 高活発スレで衝突 retry 連鎖 | retry 上限 + 警告ログ + sub-slot 化を Phase 4-5 で検討 |
| 旧データ移行で失敗 | rollback 用に旧 mailbox テーブルを残す |
| UI 退化 | feature flag で旧 UI に戻せる |

---

## 11.5 Phase 4: Hint + DM (Week 6-7)

### 11.5.1 目的

Hint 配信基盤を追加し、DM 機能（`Log` の 2 者 cap / unlinkable 構成）を実装する。

### 11.5.2 タスク

| # | タスク | 工数 |
|---|---|---|
| 4.1 | `substrate/hint/Hint.ts` 型定義 | 0.5 day |
| 4.2 | `substrate/hint/BlindTagIndex.ts` 実装 | 1 day |
| 4.3 | `substrate/hint/HintBus.ts` 実装 | 1.5 day |
| 4.4 | `substrate/hint/HintBuilder.ts` ヘルパー | 0.5 day |
| 4.5 | `WireType.HINT/HINT_CATCHUP_REQ/RES` 仕様確定 | 0.5 day |
| 4.6 | `ZoneGossipRouter` に Hint 配送統合 | 1 day |
| 4.7 | Hint catchup メカニズム (LRU + req/res) | 1 day |
| 4.8 | `Log` の unlinkable 購読（trial-decrypt）経路実装 | 1.5 day |
| 4.9 | (オプション) `apps/dm/DirectMessage.ts` 試作 | 2 day |
| 4.10 | 単体テスト + 統合テスト | 1.5 day |

合計: ~10 day

### 11.5.3 完了条件

- [ ] Hint が Dandelion 経由で配信される
- [ ] BlindTagIndex のルックアップが O(1)
- [ ] DM（Log 2 者 cap）send/receive E2E 動作
- [ ] 既存 BBS が引き続き動作
- [ ] Hint 帯域消費が予測内 (1KB/s 以下)

---

## 11.6 Phase 5: 仕上げ (Week 8)

### 11.6.1 目的

旧プロトコル削除と final cleanup。

### 11.6.2 タスク

| # | タスク | 工数 |
|---|---|---|
| 5.1 | 旧 `DHTMailbox`, `SyncProtocol` 削除 | 1 day |
| 5.2 | 旧 `BoardOrchestrator`, `ThreadOrchestrator` 削除 | 0.5 day |
| 5.3 | 旧 `PacketBuilder` の BBS 固有部分削除 | 0.5 day |
| 5.4 | レガシー wire (GOSSIP 等) handling 削除 | 0.5 day |
| 5.5 | ドキュメント全体の更新 | 1 day |
| 5.6 | パフォーマンスチューニング (ボトルネック対処) | 1-2 day |

合計: ~5 day

### 11.6.3 完了条件

- [ ] 旧コード完全削除
- [ ] テストカバレッジ 80% 以上
- [ ] ドキュメント整合性
- [ ] 全 application のパフォーマンス目標達成

---

## 11.7 将来の拡張 (Phase 6+)

### 11.7.1 Phase 6: ChunkSet + File Sharing (2 週間)

| タスク | 工数 |
|---|---|
| `caps/ChunkSet.ts` 実装 | 2 day |
| `apps/files/ImmutableFile.ts`, `MutableFile.ts` | 2 day |
| ファイル共有 UI | 3 day |
| Reed-Solomon (3+2) 実装 | 3 day |

### 11.7.2 Phase 7: Group Chat (2 週間)

| タスク | 工数 |
|---|---|
| `apps/groupchat/GroupChat.ts` 実装 | 3 day |
| Member rekey プロトコル | 3 day |
| UI 統合 | 4 day |

### 11.7.3 Phase 8: 完全な X3DH (3 週間)

| タスク | 工数 |
|---|---|
| Prekey Bundle 実装 | 3 day |
| Signed PreKey ローテーション | 3 day |
| Identity Key 階層構造 | 5 day |
| DM の X3DH 経路統合 | 4 day |

### 11.7.4 Phase 9: Hybrid KEM (耐量子) (4 週間)

| タスク | 工数 |
|---|---|
| Kyber-768 の WASM ビルド | 5 day |
| X25519 + Kyber Hybrid 実装 | 5 day |
| Capability の Hybrid 化 | 5 day |
| マイグレーションプロトコル | 5 day |

---

## 11.8 優先度と現実的なスタートライン

### 11.8.1 最低限のスタート: Phase 1 のみ (1 週間)

「ちょっとした改修で済むなら今すぐやりたい」場合:
- 既存 BBS のまま、Eclipse + Poisoning を完全防御
- 4 日でリリース可能

### 11.8.2 BBS の基盤更新: Phase 1-3 (5 週間)

「BBS を本格的に Substrate 化したい」場合:
- BBS は Capability ベースに
- DM 等の追加は後でできる構造
- 中間目標として有意義

### 11.8.3 DM 追加までフル: Phase 1-4 (7 週間)

「DM 機能までほしい」場合:
- BBS 健全化 + DM 追加
- 多くのユースケースをカバー

### 11.8.4 完全な Substrate: Phase 1-5 (8 週間)

「完全に clean な状態にしたい」場合:
- 旧コード全削除
- ドキュメント完備

### 11.8.5 ファイル・グループも: Phase 1-7 (12 週間)

将来の野心的な状態。

---

## 11.9 各 Phase のリリース戦略

### 11.9.1 Phase 1: ホットフィックス相当

- 既存ユーザーに自動配信
- migration なし
- 起動時の position 再計算のみ

### 11.9.2 Phase 2: 内部実装変更

- ユーザー体感変化なし
- Slot 機能はまだ使われない

### 11.9.3 Phase 3: BBS UI 一時切替

- A/B テスト推奨
- 一部ユーザーで新 BBS UI 試験 → 1 週間問題なければ全展開

### 11.9.4 Phase 4: DM beta 開始

- 試験機能として公開
- フィードバック収集

### 11.9.5 Phase 5: 安定化

- DM 正式リリース
- 旧コード削除

---

## 11.10 リスクとコンティンジェンシー

### 11.10.1 主要リスク

| リスク | 確率 | 影響度 | 緩和策 |
|---|---|---|---|
| Log 過去ログの並列 GET 本数が予想以上 | 中 | 中 | バンドル range 粒度を活発度で動的調整 |
| Hint catchup の負荷が高い | 低 | 中 | Bundle Hint を Phase 4.5 で追加 |
| Slot 検証がメインスレッドブロック | 中 | 低 | Web Worker 化 |
| ブラウザ間互換性問題 (Safari 等) | 低 | 高 | Phase 2 で複数ブラウザテスト |
| ストレージクォータ枯渇 | 中 | 中 | LRU evict + TTL チューニング |

### 11.10.2 コンティンジェンシープラン

- Phase 1 が当初予測を超える → Phase 2 開始遅延、Phase 1 のみで stable リリース
- Phase 3 で BBS 退化検出 → 旧 UI rollback、Phase 4 で再挑戦
- Phase 4 で Hint 配信が想定外の負荷 → Cover hint を廃止 (元々 cover なし設計)、TTL 短縮で対処
- パフォーマンス目標未達 → Phase 5 を遅延、ボトルネック調査専念

---

## 11.11 マイルストーン定義

実装の進行度を測るマイルストーン:

### M1: 防御完了 (Phase 1 end)
- 既存 BBS が動作
- Sybil PUT 拒否確認
- Eclipse 攻撃シミュレーション通過

### M2: Substrate 完成 (Phase 2 end)
- Slot プリミティブが汎用基盤として動作
- WireType.SLOT_* で通信
- 既存 BBS 並存

### M3: BBS 移行完了 (Phase 3 end)
- BBS が新 Capability 上で動作
- 旧データ読み込み互換
- レイテンシ要求達成

### M4: DM ベータ (Phase 4 end)
- DM が動作
- Hint 配信効率確認
- BlindTagIndex 性能達成

### M5: Substrate v2 正式リリース (Phase 5 end)
- 旧コード削除
- ドキュメント整合
- 全 application 安定動作

---

## 11.12 次に読む

→ [12_open_questions.md](./12_open_questions.md): 未決事項
→ [00_index.md](./00_index.md): ドキュメント全体目次
