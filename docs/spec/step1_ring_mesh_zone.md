# Ring-Mesh + Adaptive Zone — 確定アーキテクチャ仕様

**ステータス**: ✅ 確定（シミュレーション全テスト100%到達）
**更新日**: 2026-03-20
**前提ドキュメント**: `step1_ring_mesh.md`（Ring-Mesh基盤仕様）

---

## 1. アーキテクチャ概要

### 1.1 二層構造

```
┌─────────────────────────────────────────────────┐
│  Layer 2: Adaptive Zone Gossip                  │
│  ・CIDRサブネッティング方式のゾーン自動分割       │
│  ・ゾーン内BFS Floodゴシップ（到達率100%）       │
│  ・K-Anonymous 購読（16ゾーン購読、ダミー含む）   │
│  ・Dandelion++ Stem 越境インジェクション          │
├─────────────────────────────────────────────────┤
│  Layer 1: Ring-Mesh Backbone                    │
│  ・円環上のローカルリンク（構造的連結保証）        │
│  ・Zone-aware ロングレンジリンク                  │
│  ・DHT Mailbox（K=5冗長）                        │
│  ・Heartbeat / 自動修復                           │
└─────────────────────────────────────────────────┘
```

### 1.2 同時に達成する3つの要件

| 要件 | 実現方法 |
|:-----|:---------|
| **完全匿名** | Broadcast Veil（購読の概念を排除）+ K=16匿名ゾーン + Dandelion++ |
| **無限スケーラビリティ** | Adaptive Zone Depth（10人〜1000万人まで同一プロトコル） |
| **サーバーレス** | Ring-Mesh 構造的連結保証 + DHT Mailbox（トラッカーは初期接続のみ） |

---

## 2. 確定パラメータ

```typescript
export const RING_MESH_ZONE = {
  // ── Ring-Mesh 基盤 ──
  RING_LOCAL: 4,              // ローカルリンク: 左2 + 右2（リング維持）
  MAX_DEGREE: 16,             // 1ノードの最大WebRTC接続数
  // 内訳: Ring 4本 + Zone-aware 最大12本

  // ── Adaptive Zone ──
  MAX_DEPTH: 12,              // ゾーン深度の上限（2^12 = 4096ゾーン）
  TARGET_ZONE_POP: 500,       // 1ゾーンあたりの目標人口
  SUBSCRIBE_COUNT: 16,        // 常に16ゾーン購読（実際 + ダミー）

  // ── タイマー ──
  HEARTBEAT_INTERVAL: 15_000,
  HEARTBEAT_TIMEOUT: 45_000,
  REPAIR_CHECK_INTERVAL: 10_000,
  DEPTH_RECOMPUTE_INTERVAL: 60_000,  // 1分ごとにdepth再計算

  // ── シグナリング ──
  INITIAL_PEERS: 8,           // トラッカーから取得（多めに）
  CONNECTION_TIMEOUT: 10_000,
} as const;
```

### 2.1 パラメータ選定根拠

| パラメータ | 値 | 根拠 |
|:-----------|:---|:-----|
| MAX_DEGREE=16 | Zone-aware接続でゾーン内度数を確保。Chrome上限50の32%。16connections ≈ 32MBメモリ |
| MAX_DEPTH=12 | 最大4096ゾーン。1000万ノードでも1ゾーン2441人 → 帯域26KB/s |
| TARGET_ZONE_POP=500 | ゾーン内度数≥3を確保する最小人口。500人×MAX16接続で十分な密度 |
| SUBSCRIBE_COUNT=16 | K=16匿名性。攻撃者が本命ゾーンを特定する確率 = 1/16 = 6.25% |

---

## 3. Adaptive Zone Depth（CIDRサブネッティング）

### 3.1 ゾーンIDの決定

```typescript
/**
 * スレッドのゾーンIDを計算
 * thread_keyのSHA256ハッシュの先頭 depth ビットがゾーン住所
 */
function getZoneId(threadKey: Uint8Array, depth: number): number {
  const hash = SHA256(threadKey);
  if (depth === 0) return 0;
  // 先頭 depth ビットを抽出
  // depth <= 8 の場合: hash[0]の上位ビット
  // depth > 8 の場合: hash[0]全部 + hash[1]の上位ビット
  const bits = (hash[0] << 8 | hash[1]) >> (16 - depth);
  return bits;
}

// 例: hash = 10110100_01010011...
// depth=0: Zone 0         (全体)
// depth=1: Zone 1         (先頭1bit = 1)
// depth=2: Zone 2 (=0b10) (先頭2bit = 10)
// depth=3: Zone 5 (=0b101)(先頭3bit = 101)
// depth=4: Zone 11(=0b1011)
// ...
// depth=8: Zone 180(=0b10110100)
```

### 3.2 depth の自動計算

```typescript
function computeDepth(estimatedNetworkSize: number): number {
  if (estimatedNetworkSize <= TARGET_ZONE_POP) return 0;
  const raw = Math.ceil(Math.log2(estimatedNetworkSize / TARGET_ZONE_POP));
  return Math.max(0, Math.min(MAX_DEPTH, raw));
}
```

| ネットワーク規模 | depth | ゾーン数 | 1ゾーン人口 |
|:---------:|:-----:|:------:|:------:|
| ~500 | 0 | 1 | 全員 |
| ~1000 | 1 | 2 | ~500 |
| ~2000 | 2 | 4 | ~500 |
| ~8000 | 4 | 16 | ~500 |
| ~16000 | 5 | 32 | ~500 |
| ~128000 | 8 | 256 | ~500 |
| ~1000000 | 11 | 2048 | ~488 |
| ~10000000 | 12(MAX) | 4096 | ~2441 |

### 3.3 ゾーン分割の不変性（スレッドは移動しない）

```
depth=2 のとき:
  VIPスレ (hash=10110100...) → Zone "10" (=2)

ネットワークが成長し depth=3 に変化:
  Zone "10" が "100" と "101" に分割
  VIPスレ (hash=101...) → Zone "101" (=5)

  ★ ハッシュは変わらない → ゾーンIDが自動的に細分化される
  ★ クライアントはdepth値を更新するだけ
  ★ スレッドの「引っ越し」は発生しない（CIDRと同じ原理）
```

### 3.4 ネットワークサイズの推定方法

```
各ノードは以下の情報から推定:

1. Ring上の隣人密度:
   自分の左右のローカル隣人のposition差から、
   全体のノード数を推定
   estimated_N ≈ 1 / avg_neighbor_distance

2. トラッカーからのヒント（初回のみ）:
   トラッカーが現在の接続数を通知

3. PEXで得られるピア数の統計:
   新しいピアが見つかる速度から推定

4. depth合意:
   各ノードが推定したdepthをPing/Pongに含めて交換
   中央値を採用 → 全ノードで自然に合意
```

---

## 4. ゾーン購読とK-匿名性

### 4.1 購読ルール

```typescript
function computeSubscribedZones(
  myRealZones: number[],  // 自分が読みたいスレッドのゾーンID
  depth: number,
): Set<number> {
  const totalZones = 1 << depth;
  const zones = new Set<number>();

  // 全ゾーン数 ≤ 16 → 全購読（Full Flood = Broadcast Veil）
  if (totalZones <= SUBSCRIBE_COUNT) {
    for (let i = 0; i < totalZones; i++) zones.add(i);
    return zones;
  }

  // 実際に読みたいゾーンを追加
  for (const z of myRealZones) zones.add(z);

  // ダミーゾーンを追加して合計16個にする
  while (zones.size < SUBSCRIBE_COUNT) {
    zones.add(Math.floor(Math.random() * totalZones));
  }

  return zones;
  // ★ 一度確定したらセッション中は変更しない（交差攻撃防止）
}
```

### 4.2 プライバシー保証

```
depth=0〜4 (ゾーン数 ≤ 16):
  全ゾーン購読 = Broadcast Veil（完全匿名）
  → 何を読んでるか一切バレない（最強）

depth=5以上 (ゾーン数 > 16):
  16ゾーン購読 = K-Anonymous Zone Routing
  → 攻撃者が見える情報: 「このIPは16個のゾーンを購読している」
  → 本命ゾーン特定確率: 最大6.25%（1/16）
  → 交差攻撃防止: ゾーンセットはセッション中固定（再抽選禁止）
```

### 4.3 プライバシーの段階

| 人数 | depth | 方式 | プライバシーレベル |
|:------:|:------:|:------:|:------:|
| ~8000 | 0-4 | **Broadcast Veil** | ★★★ 完璧（購読概念が存在しない） |
| ~8000+ | 5+ | **K=16 Anonymous** | ★★☆ 強い（6.25%で特定、交差攻撃不可） |

---

## 5. Zone-aware 接続管理

### 5.1 接続の構成

```
MAX_DEGREE = 16 の内訳:

  Ring ローカルリンク: 4本（左2+右2, リング構造維持）
  Zone-aware リンク: 最大12本（ゾーンメイトを優先選択）

Zone-aware リンクの選択基準:
  1. 候補ピアとの「共有ゾーン数」を計算
  2. 共有ゾーン数が多い順に接続
  3. 1本の接続で複数ゾーンのゴシップを運べるため、
     共有ゾーンが多い相手ほど効率が良い
```

### 5.2 ゾーン内ゴシップの伝搬

```
メッセージ受信時:

  1. ゾーンIDを確認
  2. 自分がそのゾーンを購読しているか？
     → No: メッセージを破棄（中継しない）★ 帯域削減の核心
     → Yes: 処理続行

  3. seenPacketsで重複チェック
     → 既に見た: 破棄
     → 初見: 以下を実行

  4. 復号を試みる（自分が持つ全thread_keyで）
     → 成功: UIに表示

  5. 同じゾーンを購読している隣人にのみリレー
     → 全隣人ではなく、ゾーンメイトにだけ送信
     → これにより帯域が 購読数/ゾーン総数 に削減される
```

### 5.3 Dandelion++ 越境インジェクション

```
作者AがZone 42に書き込む場合:

1. A自身はZone 42を購読していなくてもOK
2. Stemパケットを作成: { zone_id: 42, stem_ttl: 3, payload: encrypted }
3. ランダムな隣人にStem転送（ゾーン無関係に1人だけ）
4. Stem ホップ × 3-4回
5. Fluff判定を引き当てたノードFが:
   a) Zone 42を購読している隣人を探す
   b) 見つかれば → そこからZone 42内ゴシップ開始
   c) 見つからなければ → DHT経由でZone 42のMailboxに直接PUT
6. Zone 42の住人には「Fが持ってきた」としか見えない
   → 作者Aの痕跡は完全消滅
```

---

## 6. シミュレーション実証結果

### 6.1 段階的成長テスト（MAX=16, TARGET_POP=500）

| ノード数 | depth | Zone数 | 購読 | 到達率 | 帯域 |
|:------:|:------:|:------:|:------:|:------:|:------:|
| 50 | 0 | 1 | Full Flood | **100%** | 0.1KB/s |
| 500 | 0 | 1 | Full Flood | **100%** | 1.3KB/s |
| 1000 | 1 | 2 | Full Flood | **100%** | 2.7KB/s |
| 2000 | 2 | 4 | Full Flood | **100%** | 5.3KB/s |
| 5000 | 4 | 16 | Full Flood | **100%** | 13.3KB/s |
| 10000 | 5 | 32 | 16/32 | **100%** | **13.3KB/s** |

> ★ 5000→10000で帯域が横ばい = Zone分割が自動で効いている

### 6.2 Churn中のdepth自動変化

| イベント | ノード数 | depth | Zone数 | 到達率 | 連結 |
|:------:|:------:|:------:|:------:|:------:|:------:|
| 初期 | 2000 | 2 | 4 | — | ✅ |
| +3000 | 5000 | 4 | 16 | **100%** | ✅ |
| +5000 | 10000 | 5 | 32 | **100%** | ✅ |
| 70%離脱 | 5882 | 4 | 16(自動縮退) | **100%** | ✅ |

> ★ 急増も急減もdepthが自動調整し、到達率100%を維持

### 6.3 帯域推定（計算値）

| 規模 | depth | Zone | 購読 | 帯域/ノード |
|:------:|:------:|:------:|:------:|:------:|
| 100 | 0 | 1 | Full Flood | 0.3KB/s |
| 10,000 | 5 | 32 | 16/32 | 13.3KB/s |
| 100,000 | 8 | 256 | 16/256 | 16.7KB/s |
| 1,000,000 | 11 | 2048 | 16/2048 | 20.8KB/s |
| 10,000,000 | 12 | 4096 | 16/4096 | **26.0KB/s** |

> ★ 1000万ノードでも26KB/s。現代のモバイル回線でも余裕。

---

## 7. 実装上の注意点

### 7.1 depth合意のタイミング

```
❌ 全ノードが常に同じdepthである必要はない
✅ 隣接ノード間でdepthが1-2ずれても動作する

理由:
  depthが異なる場合、「浅い方」のゾーンは「深い方」のゾーンの親。
  depth=4のノード(Zone "1011") と depth=5のノード(Zone "10110" or "10111") は、
  depth=4の範囲では同じゾーン"1011"として通信できる。

  ゴシップは「自分のdepthでのゾーンID」でフィルタリングするため、
  depth違いのノード同士でも「浅い方のdepth」で互換性がある。

推奨:
  - 1分ごとにdepthを再計算
  - Ping/Pongに自分のdepthを含める
  - 隣接ノードのdepthの中央値を記録（参考値として）
  - depth変更は「上がるときは即座に」「下がるときは5分待機」（ヒステリシス）
```

### 7.2 ゾーンセットの再抽選禁止

```
🔴 致命的: ゾーン購読セットを頻繁に変えると交差攻撃が成立する

  攻撃:
    t=0: IPアドレスAは {3,7,12,15,18,22,...} を購読
    t=1: IPアドレスAは {3,5,12,15,20,25,...} を購読
    → 交差 = {3,12,15} → 本命ゾーンの候補が絞れる！

  対策:
    セッション中（タブが開いている間）は購読セットを変えない。
    depth変更時も:
      - 既存ゾーンの「子ゾーン」をそのまま購読（分割に追随）
      - 新しいダミーは追加するが、既存ダミーは維持
```

### 7.3 MAX_DEGREE=16 のリソース影響

```
| リソース | 16接続 | ブラウザ上限 | 使用率 |
|:---------|:-------|:-----------|:------:|
| RTCPeerConnection | 16個 | ~50個(Chrome) | 32% |
| DataChannel | 16本 | 制限なし | 極小 |
| メモリ | ~32MB | ~4GB(タブ) | 0.8% |
| CPU (DTLS) | 微小 | — | <1% |
```

### 7.4 Zone-aware接続の維持

```
depth変更時に接続を全部張り替える必要はない。

depthが上がったとき（ゾーン分割）:
  1. 既存の接続のゾーン共有を再計算
  2. 共有がなくなった接続は徐々にロングレンジに降格
  3. 新しいサブゾーンのメイトをPEXで探して接続
  → 数分かけて自然に遷移する

depthが下がったとき（ゾーン統合）:
  1. 子ゾーン同士が統合されるため、共有ゾーンが増える
  2. 接続は減らす必要なし（効率が上がるだけ）
```

### 7.5 `step1_ring_mesh.md` から継承する注意点

以下は Ring-Mesh 基盤の注意点としてそのまま適用される:

- 🔴 ゴシップは BFS で中継（§8.1）
- 🔴 ローカルリンク優先ルール / evictLongRange（§8.2）
- 🟡 position 永続化（§8.3）
- 🟡 repairAll の反復注意（§8.5）
- 🟢 Mailbox 再レプリケーション（§8.7）
- 🟢 WebRTC 固有問題（§8.8）
- 🟢 レースコンディション（§8.9）
- 🟢 セキュリティ（§8.10）

---

## 8. 設計の独自性

### 8.1 既存技術との比較

| | Tor | I2P | libp2p GossipSub | **AETHER Ring-Mesh+Zone** |
|:--|:--:|:--:|:--:|:--:|
| ブラウザ完結 | ❌ | ❌ | △ | **✅** |
| 匿名性 | ✅(3hop) | ✅ | ❌(購読バレ) | **✅(K=16+Dandelion)** |
| スケーラビリティ | △(遅い) | △ | ✅ | **✅(自動Zone)** |
| 自律分散 | ❌(Dir) | ✅ | ✅ | **✅(Ring構造保証)** |
| リアルタイム | ❌ | ❌ | ✅ | **✅** |
| 帯域効率 | ❌ | ❌ | △ | **✅(20KB/s@1M)** |
| 適応的スケール | ❌ | ❌ | ❌ | **✅(10人→1000万人)** |

### 8.2 技術的新規性

1. **Ring-Mesh + Zone-aware接続選択**: DHT的リング構造にゾーン親和性を持つ接続を重ねることで、構造的連結保証とゾーン内ゴシップ効率を両立
2. **Adaptive Zone Depth**: CIDRサブネッティングの原理をP2Pゴシップに応用。ハッシュの先頭ビットで階層的にゾーンを分割し、ノード数に応じて自動的にdepthが変化
3. **Broadcast Veil → K-Anonymous Zone の自動遷移**: 小規模時はFull Flood（完全匿名）、大規模時は自動的にK-Anonymous Zone（効率的匿名）に遷移。プロトコル変更なし

---

## 9. ファイル構成（更新）

```
client/src/network/
├── RingPosition.ts        # 円環位置の生成・永続化・距離計算
├── WebRTCPeer.ts          # 単一WebRTC接続の抽象化
├── PeerManager.ts         # 全ピア管理・ローカルリンク優先・Zone-aware接続選択
├── RingMaintainer.ts      # リング構造の維持・修復
├── ZoneManager.ts         # ★ Adaptive Zone Depth管理・購読セット・depth合意
├── ZoneGossipRouter.ts    # ★ ゾーン内BFS Flood・ゾーンフィルタリング
├── DandelionRouter.ts     # ★ Stem/Fluff切替・越境インジェクション
├── DHTMailbox.ts          # K最近接ノード・PUT/GET・再レプリケーション
├── PEXHandler.ts          # ロングレンジ候補 + ゾーンメイト探索
├── SignalingClient.ts     # トラッカーWebSocket（初期接続のみ）
├── Heartbeat.ts           # 死活監視 (Web Worker)
└── NetworkEvents.ts       # イベント型定義
```

---

## 10. シミュレーション再現

```bash
# 基本Ring-Meshテスト
cd simulation && npx tsx src/run_gossip_mailbox.ts

# Adaptive Zone テスト
cd simulation && npx tsx src/run_adaptive_zone.ts

# Zone + MAX接続数スイープ
cd simulation && npx tsx src/run_zone_ring.ts
```
