# Part 2: Threat Model — 脅威モデル

## 2.1 想定される敵性アクター

### 2.1.1 アクタークラス

| クラス | 略称 | 能力 | 想定攻撃 |
|---|---|---|---|
| **隣接観測者** | LO (Local Observer) | 自分の K-nearest 圏内の全 GET/PUT/Gossip パケットを観測 | メタデータ収集、相関分析、IP-pseudonym 紐付け |
| **大規模 Sybil 軍** | CS (Collusive Sybil) | 多数のピア立ち上げ、位置選択、結託、集合的観測 | Eclipse、検閲、メタデータ統合、global view 近似 |
| **過去ログ侵入者** | LJ (Late-Joiner Attacker) | ある時点で channel/conversation の秘密鍵を入手 → 過去履歴を遡る | 履歴掘り返し、pseudonym 連結 |
| **能動的偽造者** | AF (Active Forger) | 任意の PUT を発行可能、Gossip に偽パケット注入 | DB 汚染、ピア混乱、リソース枯渇 |
| **グローバル受動敵** | GPA (Global Passive Adversary) | 全ネットワークトラフィックを観測 (ISP 連合等) | 交差攻撃、タイミング相関 |

### 2.1.2 アクター能力の階層

```
        GPA (最強)
          │ (Web-lite では out-of-scope)
          ▼
        CS + LO 結託
          │
          ▼
        CS (Sybil 大量)
          │
          ▼
        AF (偽造能力)
          │
          ▼
        LO (隣接観測のみ)
          │
          ▼
        LJ (鍵入手後の遡及攻撃)
          │ (時間制約あり)
          ▼
```

本設計は **LO + AF + CS + LJ を主要防御対象**とする。GPA については Application 層で部分対応可。

---

## 2.2 攻撃カテゴリ

### 2.2.1 メタデータ攻撃 (Metadata Attacks)

「誰が何のデータに関与しているか」を観測から推定する攻撃。

| 攻撃名 | 説明 | 主要アクター |
|---|---|---|
| **GET fingerprinting** | 観測した GET から「読み手の興味プロファイル」構築 | LO, CS |
| **PUT origin tracing** | PUT パターンから「投稿者」推定 | LO, CS |
| **Storage census** | K-nearest が持つデータから「ネットワーク全体の活動度」推定 | CS |
| **Channel enumeration** | DHT 全鍵スキャンで存在する channel を列挙 | CS |

### 2.2.2 相関攻撃 (Correlation Attacks)

「複数の観測を結びつけて高次情報を抽出する」攻撃。

| 攻撃名 | 説明 | 主要アクター |
|---|---|---|
| **Per-channel correlation** | 同一 channel の複数 entry を同一投稿者に紐付け | LO, CS |
| **Cross-channel profiling** | 複数 channel の観測を統合して興味プロファイル化 | CS |
| **Position-identity linking** | Ring 上の固定 position から identity 推定 | LO, CS |
| **PoW fingerprinting** | PoW パターン (難易度、計算速度) から個体識別 | LO, CS |

### 2.2.3 検閲攻撃 (Censorship Attacks)

「特定のデータ・channel を消す/読めなくする」攻撃。

| 攻撃名 | 説明 | 主要アクター |
|---|---|---|
| **Targeted Eclipse** | 特定 slot の K-nearest を Sybil で固める | CS |
| **Channel takeover** | 板/会話の全 slot の K-nearest を制圧 | CS (大規模) |
| **PUT suppression** | 担当ノードが受信した PUT を捨てる | CS |
| **GET poisoning** | 担当ノードが偽データで応答する | CS, AF |

### 2.2.4 ストレージ攻撃 (Storage Attacks)

「保存ノードのリソースを枯渇させる」攻撃。

| 攻撃名 | 説明 | 主要アクター |
|---|---|---|
| **Bloat attack** | 任意 slot に大量データを詰める | AF |
| **Quota exhaustion** | IndexedDB の容量を使い切らせる | AF, CS |
| **Replication amplification** | 汚染データを ReplicationManager に拡散させる | AF |
| **PoW bypass** | PoW なしで PUT を通す | AF |

### 2.2.5 IDアイデンティティ攻撃 (Identity Attacks)

「ピア識別子を悪用する」攻撃。

| 攻撃名 | 説明 | 主要アクター |
|---|---|---|
| **Position spoofing** | 任意の Ring position を主張 | AF |
| **PeerId grinding** | 特定 position に来る公開鍵を計算 | AF, CS |
| **Sybil mass production** | 大量の独立 peerId 生成 | CS |
| **Identity replay** | 他者の peerId を主張 | AF |

### 2.2.6 交差攻撃 (Intersection Attacks) — **OUT OF SCOPE**

「複数時刻・複数観測の交差で個人特定」攻撃。

| 攻撃名 | 説明 | 主要アクター | 本設計の扱い |
|---|---|---|---|
| **Online-time intersection** | 「時刻 T1 にオンライン者」∩「投稿時刻 T1」 | GPA | 対応せず |
| **Long-term observation** | 長期観測で行動パターン抽出 | GPA | 対応せず |
| **Friend graph reconstruction** | 通信パターンから社会グラフ構築 | GPA | 対応せず |

これらは Application 層で以下のような対策を講じる責務:
- ランダム化されたオンライン時刻
- パッシブモード (受信のみ参加)
- 専用デバイスでの利用
- Cover 投稿の application-level 発行

Substrate はこれらをサポートする API は提供する (例: silent receive モード) が、デフォルト対策はしない。

---

## 2.3 防御目標の優先順位

各攻撃に対する設計上の目標水準:

| 攻撃カテゴリ | 目標 | 達成手段 (概要) |
|---|---|---|
| メタデータ攻撃 | **完全防御** | Slot 鍵のランダム化/HMAC 化 + Hint 暗号化 |
| 相関攻撃 (per-channel) | **強い防御** | Mode B で完全分離。Mode A でも 第三者からは結びつかない |
| 相関攻撃 (cross-channel) | **完全防御** | application 独立 Capability |
| 相関攻撃 (position-linking) | **部分防御** | Bound Identity + Dandelion stem |
| 検閲攻撃 (targeted) | **完全防御** | Slot 鍵の予測不能化 |
| 検閲攻撃 (channel-level) | **強い防御** | Mode A では derive 鍵が秘密のうちは防御 |
| ストレージ攻撃 | **完全防御** | PoW + CHK + 帰属検証 |
| Identity 攻撃 | **強い防御** | Bound Identity + (option) PoW Identity |
| 交差攻撃 | **out-of-scope** | Application 責務 |

「完全防御」= 計算量的に不可能、「強い防御」= 攻撃コストを実用的に困難なレベルに上げる、「部分防御」= ある程度緩和。

---

## 2.4 信頼仮定

### 2.4.1 信頼するもの

- **暗号原始**: SHA-256, HMAC-SHA-256, ChaCha20-Poly1305, Ed25519, X25519 の安全性
- **乱数生成器**: `crypto.getRandomValues()` の予測不能性
- **ブラウザのサンドボックス**: 同一オリジン内の整合性
- **WebRTC の DTLS-SRTP**: 隣接ピア間の通信秘匿性
- **STUN サーバー**: NAT 越えの補助 (自分の IP を学ぶ目的のみ。信頼最小)

### 2.4.2 信頼しないもの

- **隣接ピア**: 任意の挙動を取り得る
- **K-nearest ノード**: 任意の挙動を取り得る
- **シグナリングサーバー**: ピア発見の補助のみ。マッチング以外信頼しない
- **localStorage**: 同一ユーザーが改竄可能。整合性は他ノードが検証
- **過去の Identity**: peerId の継続使用を強制しない

### 2.4.3 信頼境界線

```
         信頼境界
            │
   自分     │     他者 (全て不信)
            │
  ┌─────────┼───────────────────────────┐
  │ JS code │  WebRTC peer (隣人)        │
  │ Crypto  │  K-nearest                 │
  │ Random  │  Bootstrap peer            │
  │ Keys    │  Signaling server          │
  │ State   │  STUN server               │
  └─────────┼───────────────────────────┘
            │
```

自分の JS 環境と暗号鍵以外は **全て敵性アクターであり得る**前提で設計する。

---

## 2.5 想定外の攻撃 (本設計では扱わない)

明示しておくべき射程外:

| 攻撃 | 理由 |
|---|---|
| ブラウザ脆弱性経由の RCE | OS/Browser の責務 |
| サイドチャネル (タイミング、電力) | application 層で個別対処 |
| 物理アクセス攻撃 | デバイスセキュリティの責務 |
| 暗号原始の量子破り | Hybrid KEM の導入は将来検討 |
| シグナリングサーバー完全乗っ取り | bootstrap 多様化で緩和、完全対策は無理 |
| DoS at WebRTC level | ブラウザ/WebRTC スタックの責務 |
| 法的圧力 (鍵提出強制) | 暗号設計外の問題 |

---

## 2.6 脅威モデルの可視化

```
┌────────────────────────────────────────────────────────────────────┐
│  本 Substrate が防御する範囲                                       │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  確実に防御 (計算量的不可能化)                                │ │
│  │  - Targeted Eclipse (Slot 鍵予測不能)                        │ │
│  │  - Storage poisoning (PoW + CHK + 帰属)                      │ │
│  │  - Cross-channel correlation                                 │ │
│  │  - Metadata leak (第三者から)                                │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  コスト引き上げで実質防御                                     │ │
│  │  - Sybil (Bound Identity + PoW)                              │ │
│  │  - Position-identity linking                                 │ │
│  │  - Channel-level censorship (Mode A 秘密保持時)              │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  Application 層に委譲する範囲                                       │
│  - Intersection attacks                                             │
│  - Long-term traffic analysis                                       │
│  - Online presence patterns                                         │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  設計外 (本ドキュメントでは扱わない)                                │
│  - IP 完全秘匿 (Relay/Onion 必要)                                  │
│  - Browser/OS 脆弱性                                                │
│  - 物理攻撃                                                          │
│  - 量子攻撃                                                          │
└────────────────────────────────────────────────────────────────────┘
```

---

## 2.7 次に読む

→ [03_layered_architecture.md](./03_layered_architecture.md): 防御を実装する 4 層アーキテクチャ
→ [09_security_analysis.md](./09_security_analysis.md): 攻撃別の防御評価詳細
