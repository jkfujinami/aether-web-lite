> ⛔ **この仕様は廃止されました**
> Ring-Mesh + Adaptive Zone に移行済みです。Passive View(80件のIPキャッシュ)が不要になりました。
> 現行仕様: [`step1_ring_mesh.md`](./step1_ring_mesh.md), [`step1_ring_mesh_zone.md`](./step1_ring_mesh_zone.md)

# メッシュアーキテクチャ: HyParView 強化モデル（~~廃止: Ring-Meshに移行済み~~）

**ステータス**: ❌ 廃止（HyParView → Ring-Meshに移行。PV=0で動作確認済み）
**更新日**: 2026-03-20

---

## 1. 背景と動機

従来のPEX（Peer Exchange）のみのメッシュでは、
大規模ノード離脱（30-50%）時にネットワークが複数の「島」に分断され、
**トラッカー（中央サーバー）に再接続しないと復旧できない** という問題があった。

AETHERの設計思想「中央サーバーへの依存を最小化」に反するため、
**HyParView プロトコル** をベースにした自律的な分断復旧メカニズムを導入する。

---

## 2. アーキテクチャ: Active View + Passive View

### 2.1 2層構造

```
┌─────────────────────────────────────────────┐
│ Active View (実接続)                         │
│  = WebRTC DataChannel で繋がっているピア      │
│  サイズ: 5〜8 (MIN_DEGREE〜MAX_DEGREE)       │
│  用途: ゴシップ中継、PEX、データ通信          │
├─────────────────────────────────────────────┤
│ Passive View (知識キャッシュ)                 │
│  = 存在は知っているが接続はしていないピア      │
│  サイズ: 最大80件                            │
│  用途: Active不足時の接続候補（分断回復の橋） │
│  蓄積: Passive Shuffle で全ネットワークから   │
└─────────────────────────────────────────────┘
```

### 2.2 Passive Viewが分断回復に効く理由

```
         PEXの限界:  
            島A          島B
         ┌──────┐    ┌──────┐
         │ a1─a2│    │ b1─b2│
         │ a3─a4│    │ b3─b4│
         └──────┘    └──────┘
         PEXは「友達の友達」しか知らない
         → 島Aのノードは島Bの存在を知らない → 復旧不能

         Passive Viewの効果:
            島A          島B
         ┌──────┐    ┌──────┐
         │ a1─a2│    │ b1─b2│
         │ a3─a4│    │ b3─b4│
         └──────┘    └──────┘
              ↑              ↑
         a2のPV = [..., b3]  (分断前にShuffleで蓄積済み)
         → a2がb3に直接接続 → 橋が架かる → 島統合
```

---

## 3. 確定パラメータ

```typescript
export const MESH = {
  // ── Active View ──
  MIN_DEGREE: 5,
  MAX_DEGREE: 8,
  TARGET_DEGREE: 6,

  // ── Passive View ──
  PASSIVE_VIEW_SIZE: 80,        // ★ 80以上で30%削除からの自力復旧を保証
  SHUFFLE_EXCHANGE_COUNT: 8,    // Shuffle時に交換するエントリ数

  // ── Long-Range Links ──
  LONG_RANGE_RATIO: 0.5,        // 新規接続の50%をランダム遠隔ノードに

  // ── タイマー ──
  PEX_INTERVAL: 30_000,         // PEX間隔 (30秒)
  PASSIVE_SHUFFLE_INTERVAL: 60_000, // Passive View交換間隔 (60秒)
  ACTIVE_SHUFFLE_INTERVAL: 120_000, // Active接続の撹拌間隔 (120秒)
  HEARTBEAT_INTERVAL: 15_000,    // ping間隔
  HEARTBEAT_TIMEOUT: 45_000,     // デッド判定

  // ── 修復 ──
  REPAIR_DELAY: 3_000,           // 修復開始までの待機 (3秒)
  MAX_REPAIR_RETRIES: 5,         // 修復リトライ回数
} as const;
```

### 3.1 パラメータ選定根拠

| パラメータ | 値 | 根拠 |
|:-----------|:---|:-----|
| `MIN_DEGREE: 5` | シミュレーション全シナリオで孤立ノード0を達成 |
| `MAX_DEGREE: 8` | 帯域コストと冗長性のバランス。度数σ=0.10で均等 |
| `PASSIVE_VIEW_SIZE: 80` | 30%削除からの自力復旧に必要な最小サイズ |
| `LONG_RANGE_RATIO: 0.5` | チェーン型成長を防ぎ、小世界性を付与 |
| `PASSIVE_SHUFFLE_INTERVAL: 60s` | Churnテストで30ステップ全て完全連結を維持 |

---

## 4. プロトコル詳細

### 4.1 ノード参加時

```
1. トラッカーから INITIAL_PEERS(6) 人のSDPを取得
2. 6人とWebRTC接続を確立
3. ★ トラッカー切断（以降は自律運用）

4. 接続確立した6人に対して:
   a) PEX-request → 隣人の隣人を知る → Passive Viewに追加
   b) Passive-Shuffle-request → Passive Viewエントリを交換

5. 初期Passive Viewの構築:
   - PEX応答から: ~24件 (6人 × 4件/人)
   - Shuffle応答から: ~48件 (6人 × 8件/人)
   → 合計 ~72件 → Passive View(80件)がほぼ満杯

6. Active View が TARGET_DEGREE(6) に達していなければ:
   Passive Viewからランダムに選んで接続試行
```

### 4.2 ノード離脱検出時

```
Heartbeat TIMEOUT (45秒未応答)
  ↓
1. Dead ピアを Active View から除去
2. Dead ピアを全ノードの Passive View からも除去
   (Shuffleの次回ラウンドで自然に伝播)

3. degree < MIN_DEGREE(5) ?
   ├─ YES → 修復開始 (3秒待機後)
   │   Step 1: PEX (友達の友達から候補取得)
   │   Step 2: Passive View Promotion
   │           → Passive View からランダムにピアを選び、直接接続試行
   │           → 成功したらPassive→Activeに昇格
   │   Step 3: それでも不足 → Passive Shuffleを即時実行
   │           → 新しいエントリ取得 → 再度Promotion
   └─ NO → 何もしない
```

### 4.3 Passive View Shuffle プロトコル

```
定期実行（60秒間隔）:

  [ノードA]                [ノードB (Aの隣人)]
     │                        │
     │ passive-shuffle-req    │
     │ { entries: [c,d,e...] }│  ← AのPassive Viewからランダムに8件
     │ ───────────────────→    │
     │                        │
     │                        B は受信したエントリを自分のPassive Viewに追加
     │                        （既に知っているものは除外、上限80件を超えたら古いものを破棄）
     │                        │
     │ passive-shuffle-resp   │
     │ { entries: [f,g,h...] }│  ← BのPassive Viewからランダムに8件
     │ ←───────────────────    │
     │                        │
     A も受信したエントリを自分のPassive Viewに追加

  ★ 重要: Shuffleは Active 接続を通じて行われるため、
     同じ連結成分内のノード間でのみ情報が伝播する。
     しかし、分断前に蓄積されたエントリは生き残るため、
     分断後の「橋」として機能する。
```

### 4.4 Active View Shuffle（撹拌）

```
定期実行（120秒間隔）:

1. degree <= MIN_DEGREE → スキップ
2. Passive View からランダムに1ピアを選択 (候補P)
3. P とWebRTC接続を試行
4. 接続成功 → P を Active View に追加、Passive View から除去
5. Active View で最もageが古いピア Q を選択
   - Q の degree > MIN_DEGREE であること確認
   - Q を Active View から除去 → Passive View に移動
   - Q との WebRTC 接続を切断
6. 接続失敗 → 何もしない
```

---

## 5. シミュレーション検証結果サマリ

### 5.1 Churn耐性（トラッカー完全不使用）

```
1000ノード、毎ステップ5%入替、30ステップ:
  最悪孤立数: 0
  分断ステップ: 0/30
  定常状態: deg=6.8 path=4.3 直径=7
  → トラッカーなしでも完全連結を維持 ✅
```

### 5.2 大規模削除からの復旧

```
PV=80, 1000ノード:
  30%削除: ラウンド1で完全復旧 ✅
  50%削除: ラウンド1で完全復旧 ✅
  70%削除: ラウンド1で完全復旧 ✅
  → Passive View Promotionでトラッカー不要 ✅
```

### 5.3 撹拌効果

```
1000ノード、撹拌なし → 撹拌20回:
  平均経路長: 90.6 → 10.5 (88%削減)
  直径: 277 → 23 (92%削減)
  → 小世界性の付与に必須 ✅
```

---

## 6. トラッカーの役割の再定義

| 従来の役割 | 新しい役割 |
|:-----------|:-----------|
| 初期接続 + 分断時の緊急回復 | **初期接続のみ** |
| 常にフォールバック先として待機 | 起動後は完全に不要 |

```
トラッカーの存在意義:
  → WebRTCの制約（最初の1人目と出会う手段がない）を補うためだけに存在
  → 一度メッシュに参加すれば、Passive View が「記憶」として機能し、
     以降は完全自律運用が可能
```

---

## 7. P2Pメッセージ拡張

```typescript
// Step 1 の P2PMessage に追加
export type P2PMessage =
  | { type: 'ping'; ts: number }
  | { type: 'pong'; ts: number; echoTs: number }
  | { type: 'pex-request' }
  | { type: 'pex-response'; peers: PeerAdvertisement[] }
  | { type: 'passive-shuffle-request'; entries: PeerId[] }   // ★ 追加
  | { type: 'passive-shuffle-response'; entries: PeerId[] }  // ★ 追加
  | { type: 'gossip'; packet: GossipPacket }
  | { type: 'sdp-relay'; targetPeerId: PeerId; sdp: RTCSessionDescriptionInit }
  | { type: 'ice-relay'; targetPeerId: PeerId; candidate: RTCIceCandidateInit };
```
