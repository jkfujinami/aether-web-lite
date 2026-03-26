# AETHER Core: Consensus & Annihilation Specification

**ステータス**: 実装設計完了 (v1.0.0-draft)
**基盤スタック**: Rust Native (`aetherd`), Stealth-QUIC, 3-Hop Onion, PQ-E2EE
**最終更新**: 2026-03-21

---

## 1. デザイン・フィロソフィ：極限のミニマリズム

AETHER Core ($aetherd$) は、複雑なスマートコントラクトやグローバルな状態（ステート）を管理しない。「End-to-Endの原則」に基づき、暗号学的に安全かつ匿名な「送金・着金・検証」のプリミティブのみを提供する。

- **Protocol Layer**: メタデータの完全秘匿、パケットのQUIC隠蔽、送金API。
- **Economic Layer**: Schrödinger's Consensus による二重支払い排除とマイナーへの報酬設計。
- **Application Layer**: 掲示板、匿名SNS、DEX等は、ローカルデーモンに接続する外部App（Web-Lite等）がAPI経由で実現する。

---

## 2. Schrödinger's Consensus (シュレーディンガーの合意)

このアルゴリズムは、世界を同期させる「正の合意」ではなく、不正を排除し資産を消滅させる**「負の合意（Negative Consensus）」**を基盤とする。

### 2.1 資産の消費：Single-Use Seal と非リンク化
各 $AETH$ コインは、一度だけ消費可能な「封印（Single-Use Seal）」として機能する。
ブロックチェーン分析によるトランザクションの追跡（リンク）を物理的に不可能にするため、ユーザーの固定アイデンティティ（身元）ではなく、**コイン（UTXO）生成時に作成される使い捨ての秘密鍵（$sk_{UTXO}$）**によって消費の署名が行われる。

消費の証明（Proof of Burn: PoB）は以下のデータ構造を持つ。
$$PoB = \text{Sign}(sk_{UTXO}, [\text{Coin\_Hash}, \text{Target\_Zone}, \text{Nonce}, \text{Fee}])$$

※ $Fee$ は、後述するMailbox担当ノードへのストレージおよび監視代行報酬である。

### 2.2 検証の特異点：Mailbox Singularity とインセンティブ
- **保存**: 全ての $PoB$ は、Ring-Mesh上の `Hash(Coin\_Hash)` に位置する **Blind Mailbox Swarm (K=5)** に提出される。
- **経済的インセンティブ**: Mailbox担当ノードはボランティアではない。彼らは $PoB$ に設定された $Fee$ が高いものを優先的に処理・保存し、正当な消費が確定した際にその $Fee$ を獲得する。
- **衝突**: 同一のコインに対して異なる $PoB$ が提出された場合、Mailbox担当ノードはそれを即座に検知する。

### 2.3 不正の報い：対消滅（Annihilation）
二重支払いが試行された（矛盾する $PoB_1, PoB_2$ が同一 Mailbox に届いた）瞬間、以下の処置がとられる。
1. **Fraud Proof 生成**: Mailbox担当ノードが $[PoB_1, PoB_2]$ を結合した不正証明を生成し、全域へ Gossip（Broadcast Veil）する。
2. **対消滅**: この証明を受信したすべての $aetherd$ は、該当するコインを「消滅（Annihilated）」ステートに変更する。二重支払いを企てた者の資産は、システムから永遠に失われる。

---

## 3. 技術的実装要件 (Rust Native Architecture)

AETHERの絶対的な匿名性とパフォーマンス（MAX_DEGREE=32等）を維持するため、ネットワーク参加のコアはブラウザのサンドボックス制約を受けない **Rust Native Daemon (`aetherd`)** とする。

| レイヤー | 技術 / クレート | 役割 |
| :--- | :--- | :--- |
| **トランスポート** | `quinn` (QUIC) | ノード間通信。WebRTC (Zoom等) へのトラフィック擬態およびステルス通信。 |
| **ルーティング** | 3-Hop Onion | 送信元・受信元IPの多層隠蔽（Dandelion++ と併用）。 |
| **暗号** | `kyberlib` + `ed25519-dalek` | 耐量子鍵交換および高速な署名生成・検証。 |
| **合意形成** | Annihilation Logic | `aetherd` 内部での Fraud Proof 検証とローカルUTXO更新。 |
| **API** | Local RPC (WebSocket) | `Web-Lite`（ブラウザ上のローカルGUIウォレット・掲示板）との安全なブリッジ。 |

---

## 4. セキュリティ・プロトコル：Active Pull

Eclipse Attack（分断攻撃）対策として、受信者はパッシブな待機を排し、以下のアクティブな検証を行う。

1. **Mint前の Pull**: 受信者は Mint（新しいコインの発行）を確定する前に、3-Hop Onion 経由で Mailbox (K=5) に直接アクセスする。
2. **確認の強制**:
   - **接続成功**: 正当な $PoB$ のみが存在することを確認し、Mint 完了。
   - **接続失敗/遅延**: ネットワーク分断（攻撃または障害）と判断し、安全のため Mint を「保留（Pending）」とする。
3. **結論**: 「繋がっていれば不正は即座にバレて消滅し、分断されていれば価値は移動できない（盗めない）」。

---

## 5. 価値の源泉

AETHER Core が作り出す価値は、単なる「通貨」ではない。
国家レベルの検閲や DPI による遮断すら無効化する **「不可視の経済インフラ（Invisible Infrastructure）」** そのものである。多数決という「脆弱な民主主義」を捨て、純粋な「数学的物理法則」によって資産の正当性を担保する。

---