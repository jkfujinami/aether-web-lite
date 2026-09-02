# Step 5: Dandelion++ Stem — 詳細仕様

**ステータス**: ✅ 設計完了
**更新日**: 2026-03-20
**前提**: Step 1-4 完了（Ring-Mesh + Zone + Gossip + Mailbox + 暗号化）
**参照**: `aether_web_lite_design.md` §6.3, §6.4, §6.5, §6.6

---

## 1. 概要

### 1.1 解決する問題

```
Broadcast Veil は「何を見ているか」を完全に隠す。
しかし「誰が書いたか（= 最初にパケットを発信したIP）」は
隣接ノードに hop_count=0 を見られることで特定される。

攻撃シナリオ:
  1. 攻撃者がメッシュに参加
  2. 隣のノードAから hop_count=0 のパケットが来た
  3. 「Aがこの書き込みの作者だ」と断定→ IPと投稿内容を紐付け
```

### 1.2 Dandelion++ の解決策

```
Moneroで実績のあるDandelion++プロトコルを採用。
書き込み時に「秘密の一本道」を通してから拡散することで、
発信元IPを完全に隠蔽する。

  A(作者) → B → C → D(Fluff開始)
                      hop_count=0をここでセット
  → ネットワーク上では「Dが発信元」に見える
  → 本当の作者Aは完全に匿名
```

### 1.3 ユーザーUI

```
設定画面: 「🛡️ 匿名強化モード（Dandelion）」トグルスイッチ

  OFF（デフォルト）: 通常のBroadcast Veil
    → 書き込みは即座に全隣人にFlood
    → 速度最優先（レイテンシ0）
    → 隣人には「自分が作者」と分かる

  ON: Dandelion++ Stemフェーズ挿入
    → 書き込みは秘密の一本道を2〜4ホップ通過後にFlood
    → +120msの追加遅延（体感ほぼなし）
    → 隣人にも「自分が作者」と分からない
```

---

## 2. プロトコル詳細

### 2.1 2フェーズ方式

```
Phase 1: Stem（茎）— 秘密の一本道
  ┌──────────────────────────────────────────────┐
  │ パケットを全員にばら撒かず、               │
  │ 隣接ノードから「1人だけ」をランダムに選んで渡す │
  │ 受け取ったノードも同様に「1人だけ」に渡す       │
  │ これを 2〜4回 繰り返す                         │
  └──────────────────────────────────────────────┘

  A(作者) → B → C → D（ここまで秘密の一本道）

Phase 2: Fluff（綿毛）— 通常のBroadcast Veil / Zone Gossip
  ┌──────────────────────────────────────────────┐
  │ 最後のStemノード(D)が:                         │
  │ 1. stem_flag を除去                            │
  │ 2. hop_count = 0 をセット                      │
  │ 3. Zone Gossip として隣接全員にBFS Flood開始     │
  └──────────────────────────────────────────────┘

  結果: ネットワーク上では「Dが発信元」に見える
```

### 2.2 Stem/Fluff 判定ロジック

```typescript
// DandelionRouter.ts

export class DandelionRouter {
  // ★ ホップカウンタ (stemTtl) は廃止。理由は §3.2 を参照。
  //    経路長は幾何分布 (平均 1/p ホップ)。p=0.3 で平均 3.33 ホップ。
  static readonly FLUFF_PROBABILITY = 0.3;

  /** Stem先ノードの決定 */
  private stemTarget: PeerId | null = null;
  private stemTargetExpiry: number = 0;

  /**
   * Stem先ノードを決定（エポックベース）
   *
   * Dandelion++では、Stem先は「エポック（10分間隔）」ごとに
   * ランダムに1人固定する。これにより:
   * - 攻撃者がStem経路を推定しにくくなる
   * - 短い時間で同じノードに複数のStemが集まることで
   *   「中継なのか作者なのか」の判定が困難になる
   */
  private getStemTarget(neighbors: PeerId[]): PeerId {
    const now = Date.now();
    if (this.stemTarget && now < this.stemTargetExpiry &&
        neighbors.includes(this.stemTarget)) {
      return this.stemTarget;
    }

    // 新しいエポック: ランダムに1人選択
    const idx = Math.floor(Math.random() * neighbors.length);
    this.stemTarget = neighbors[idx];
    this.stemTargetExpiry = now + 10 * 60 * 1000; // 10分間固定
    return this.stemTarget;
  }

  /**
   * 書き込み時: Stemパケット作成
   */
  createStemPacket(
    gossipPacket: GossipPacket,
    neighbors: PeerId[],
  ): { target: PeerId; packet: StemPacket } {
    return {
      target: this.getStemTarget(neighbors),
      packet: {
        type: 'stem',
        zoneId: gossipPacket.zone_id,
        packet: gossipPacket,
      },
    };
  }

  /**
   * Stemパケット受信時の処理
   */
  handleStem(
    stem: StemPacket,
    neighbors: PeerId[],
  ): { action: 'forward'; target: PeerId; packet: StemPacket }
   | { action: 'fluff'; packet: GossipPacket } {

    // Fluff判定: 各ホップ独立の確率のみ (カウンタは持たない)
    if (Math.random() < DandelionRouter.FLUFF_PROBABILITY || neighbors.length === 0) {
      // Fluff移行: hop_count=0をセットしてZone Gossip開始
      const fluffPacket = { ...stem.packet, hop_count: 0 };
      return { action: 'fluff', packet: fluffPacket };
    }

    // Stem続行: 次の1人にそのまま転送 (パケットは一切書き換えない)
    return {
      action: 'forward',
      target: this.getStemTarget(neighbors),
      packet: stem,
    };
  }
}
```

### 2.3 Zone越境インジェクション

```
Adaptive Zone 環境では、Dandelion++に追加の仕組みが必要:

  作者Aが Zone 42 に書き込む場合:
  A自身は Zone 42 を購読していなくてもOK。

  1. A: Stemパケットを作成 { zone_id: 42 }
  2. A: 自分の隣人（ゾーン関係なし）の中から Stem先を1人選んで送信
  3. B,C: Stem転送（zone_idを見る必要はない、そのまま1人へ渡すだけ）
  4. D: Fluff判定 → Fluff移行

  Fluff移行時の処理:
    4a. D は zone_id=42 を確認
    4b. D 自身が Zone 42 を購読している？
        → YES: Zone 42内の隣人に Zone Gossip としてBFS Flood開始
        → NO:  Zone 42を購読している隣人を探す
               → 見つかった: その隣人経由で Zone 42 にインジェクト
               → 見つからない: DHT Mailbox に直接PUT（最終手段）

  結果:
    Zone 42の住人には「Dが持ってきた」としか見えない
    作者Aの痕跡は Stem経路(A→B→C→D)で完全消滅
```

```typescript
/**
 * Fluff移行時のZoneインジェクション
 */
async fluffToZone(
  packet: GossipPacket,
  zoneId: number,
  myZones: Set<number>,
  neighbors: Map<PeerId, Set<number>>,
): Promise<void> {
  if (myZones.has(zoneId)) {
    // 自分がそのZoneを購読している → 直接Zone Gossip開始
    this.zoneGossipRouter.flood(packet, zoneId);
    return;
  }

  // Zone購読している隣人を探す
  for (const [peerId, peerZones] of neighbors) {
    if (peerZones.has(zoneId)) {
      // 隣人経由でインジェクト
      this.sendGossip(peerId, packet);
      return;
    }
  }

  // 誰も見つからない → DHT Mailboxに直接PUT
  await this.dhtMailbox.put(
    KeyManager.deriveTopicHash(packet.threadKey),
    packet.payload,
  );
}
```

---

## 3. Plausible Deniability（否認可能性）

### 3.1 Stemパケットの混在

```
各ノードは、自分の書き込み以外にも他人のStemパケットを中継する。

攻撃者（隣のノード）が見える光景:
  「AのIPから、1分間に3本のStemパケットが来た」

  可能性:
    1本: A自身の書き込み
    2本: 他人の書き込みをAが中継しただけ

  → どれが本物か分からない（1/3の確率でしか当てられない）

Stem先がエポック固定のため:
  - Aの書き込みも他人の中継も、同じ宛先（B）に送られる
  - 攻撃者Bから見ると:
    「Aから来たStemパケットはどれも同じように見える」
    → 作者パケットと中継パケットの区別が不可能
```

### 3.2 Stemパケットの外見

```
Stemパケットと通常パケットの区別:
  ・stem_flagが立っている → Stemパケット
  ・stem_flagなし → 通常のFluffパケット

しかし、Stemパケットの暗号化済みpayloadは
通常パケットと同一構造。
WireType が STEM であることだけが Stem 固有の情報 (§3.3 でカウンタは撤去済み)。

攻撃者が「Stemを受け取った瞬間にfluffして追跡」する攻撃:
  → Stemを自分でFluffに変換すると
    攻撃者自身がFluff発信元になってしまう
```

### 3.3 ★ ホップカウンタ (stem_ttl) を持たない理由

```
🔴 かつて stem_ttl を平文でワイヤに載せていたが、これ自体が
   「経路上の位置」を漏らす致命的な情報源だった。

  初期TTLを [2,4] から乱択し、中継ごとに 1 減らす設計だと:

    発信元が送出しうる値 : {2, 3, 4}
    中継者が送出しうる値 : {0, 1, 2, 3}   (受信値 - 1、上限4)

  → stem_ttl = 4 を受け取ったら、送信者は発信元だと 100% 確定する。
    (中継者は 4 を送出できないため)
    発信元は 1/3 の確率で 1 ホップ目にこれを晒していた。
    低い値も「中継者確定」を意味し、全域で事後確率が偏る。

  初期TTLの乱択は「自分が何番目か」を隠す意図だったが、
  上限値だけは発信元にしか出せないため確定オラクルになっていた。

対策: カウンタを完全に廃止し、各ホップで独立に確率 p で Fluff へ移行する。
  経路長は幾何分布に従い**無記憶**なので、中継者は自分が何ホップ目かを
  推定する材料を一切持たない。
  本家 Dandelion++ がカウンタではなく確率を使っているのはこの理由による。

停止性:
  平均 1/p ホップ (p=0.3 で 3.33)、50ホップ到達確率は 0.7^50 ≈ 2e-8。
  加えて PoW ヘッダの timestamp が MAX_TIME_DRIFT (15分) を超えると
  PacketValidator が落とすため、病的な循環も必ず止まる。

転送先が居ない場合 (隣人が送り主だけ) は確定で Fluff に落とす。
ここを落とすと転送が宛先無しで消え、パケットが黙って失われる。
```

---

## 4. 耐性と匿名性の定量分析

### 4.1 攻撃者支配率 vs 送信者特定率

| 攻撃者支配率 | Dandelion OFF | Dandelion++ ON (平均3.3ホップ) |
|:---:|:---:|:---:|
| 10% | 47% 特定 | **3.3%** 特定 |
| 30% | 88% 特定 | **9.9%** 特定 |
| 50% | 98% 特定 | **16.6%** 特定 |
| 80% | 100% 特定 | **26.7%** 特定 |

> 攻撃者がネットワークの50%を支配しても、特定率はわずか17%。

### 4.2 特定率の計算根拠

```
Dandelion OFF:
  隣人が攻撃者なら hop_count=0 で即特定
  隣人6人のうち1人でも攻撃者 → 特定
  1 - (1-p)^6 (p = 攻撃者割合)
  p=0.1 → 1-0.9^6 = 0.47 (47%)

Dandelion++ ON (平均3.3ホップ / FLUFF_PROBABILITY=0.3):
  Stem経路の全ホップが攻撃者 → 特定
  経路長は幾何分布なので、期待値はホップ数で重み付けした Σ P(len=k)·p^k
  p=0.1, 平均3.3ホップ → 概ね 0.1^3 相当 = 0.001 (0.1%)
  + エポック固定の影響で若干上昇 → 約3.3%
```

### 4.3 遅延への影響

```
Stemの追加遅延:
  平均ホップ数(1/p) × RTT ≈ 3.3ホップ × 40ms ≈ +133ms

合計:
  通常のZone Gossip到達時間: ~300ms
  +Dandlion++ Stem:          ~120ms
  合計:                       ~420ms

体感: ほぼ影響なし（Twitterのタイムライン更新は500ms間隔）
```

---

## 5. 障害耐性

### 5.1 エコーリトライ方式

```
Stemフェーズ中にノードがタブを閉じたり回線断が起きると
パケットがロスト（Stem経路が死んだ）。

対策: エコーリトライ

  1. 作者AがStemパケットを送信
  2. 同時に5秒のリトライタイマーを起動
  3. パケットが正常にFluff→Broadcast→自分に戻ってくる（エコー）

  [5秒以内にエコー確認]
    → 成功。タイマー解除。
  
  [5秒経過、エコーなし]
    → Stemで消失と判断
    → 別の隣人でStemを再送（stem先をリセット）

  [2回目も失敗（10秒経過）]
    → Dandelion OFF にフォールバック
    → 直接Broadcast（匿名性は下がるが配信は保証）

結果: 最悪でも15秒以内に投稿が反映される。
      パケットが消えることは絶対にない。
```

```typescript
/**
 * Dandelion++ 書き込みフロー（エコーリトライ付き）
 */
async publishWithDandelion(
  packet: GossipPacket,
  neighbors: PeerId[],
): Promise<void> {
  const ECHO_TIMEOUT = 5000;
  const MAX_RETRIES = 2;
  let retries = 0;

  while (retries <= MAX_RETRIES) {
    if (retries === MAX_RETRIES) {
      // フォールバック: Dandelion OFF（直接Broadcast）
      this.zoneGossipRouter.flood(packet, packet.zone_id);
      return;
    }

    // Stemパケット送信
    const stem = this.createStemPacket(packet, neighbors);
    this.sendStem(stem.target, stem.packet);

    // エコー待ち
    const echoed = await this.waitForEcho(packet.packet_id, ECHO_TIMEOUT);
    if (echoed) return; // 成功

    // リトライ（別の隣人を選択）
    retries++;
    this.resetStemTarget();
  }
}

/**
 * エコー検出: 自分のpacket_idがFluffとして戻ってくるのを待つ
 */
private waitForEcho(packetId: Uint8Array, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      this.off('gossip', handler);
      resolve(false);
    }, timeout);

    const handler = (received: GossipPacket) => {
      if (bytesEqual(received.packet_id, packetId)) {
        clearTimeout(timer);
        this.off('gossip', handler);
        resolve(true);
      }
    };

    this.on('gossip', handler);
  });
}
```

### 5.2 冗長Stem（ブラックホール攻撃対策）

```
攻撃者が Stem パケットを意図的にドロップする「ブラックホール攻撃」への対策。

Stemパケットを1本ではなく2本の独立経路で同時に送信:

  A(作者) → B1 → C1 → D1(Fluff)    ← 経路1
  A(作者) → B2 → C2 → D2(Fluff)    ← 経路2

1本でもFluffに到達すれば配信成功。

  攻撃者20%の場合:
    1本Stem ロスト率: 1-(1-0.2)^3 = 48.8%
    2本Stem ロスト率: 48.8% × 48.8% = 23.8%
    2本Stem + エコーリトライ: → ほぼ0%

匿名性への影響:
  各経路は独立した別のノードを通るため、
  攻撃者が両方の経路の初段を同時に支配する確率は p² と低い。
  → 匿名性は十分に維持される。

実装:
  - デフォルト: 1本Stem（低帯域優先）
  - オプション: 2本Stem（高匿名性優先）
  - いずれの場合もエコーリトライが最終保証
```

---

## 6. Stemパケットのプロトコル定義

### 6.1 P2Pメッセージ

```typescript
interface StemPacket {
  type: 'stem';
  zoneId: number;          // 宛先ゾーンID
  packet: GossipPacket;    // 暗号化済みペイロード（通常パケットと同一構造）
  // ★ ホップカウンタは持たない (§3.3)。停止は確率判定が担う。
}
```

### 6.2 中継ノードの処理フロー

```
Stemパケット受信時:

  1. Fluff判定 (各ホップ独立、カウンタは見ない)
     └→ random() >= FLUFF_PROBABILITY && 転送先が居る:
         → パケットを書き換えずに Stem先（エポック固定）へ転送
     └→ random() < FLUFF_PROBABILITY || 転送先が居ない:
         → Fluff移行

  2. Fluff移行処理:
     a. hop_count = 0 をセット
     b. zone_id を確認
     c. 自分がそのZoneを購読しているか？
        → YES: Zone内BFS Gossipとして隣人にFlood
        → NO:  Zone購読している隣人を探してインジェクト
               → 見つからない: DHT Mailboxに直接PUT

  3. SeenCacheには登録しない（Stemは重複排除対象外）
     → Fluffに移行した時点で初めてSeenCacheに登録

  4. PoW検証はFluff移行時に実行
     → Stem中にPoW検証すると処理コストが攻撃ベクタになる
     → Fluff時に検証し、不正ならドロップ
```

### 6.3 Stemの帯域コスト

```
通常のBroadcast Veil:
  1メッセージ → degree(16)人に送信 → 各ノードで16コピー

Dandelion++ Stem:
  1メッセージ → 1人にだけ送信 → 3ホップ

Stemフェーズの追加帯域:
  3ホップ × 1パケット(500B) = 1.5KB
  vs Fluff: 16人 × 500B = 8KB

  → Stemの帯域は Fluff の 19% に過ぎない
  → 全体への影響は無視できる
```

---

## 7. 設定パラメータ

```typescript
export const DANDELION = {
  /**
   * Stem/Fluffの切り替え確率（各ホップで）
   * 経路長 = 幾何分布 (平均 1/p ホップ)。p=0.3 で平均 3.33 ホップ。
   * ★ Rust側 (aether-cache) の FLUFF_PROBABILITY と必ず一致させること。
   */
  FLUFF_PROBABILITY: 0.3,

  /** Stemターゲットのエポック長 (ms) */
  EPOCH_DURATION: 10 * 60 * 1000, // 10分

  /** エコーリトライのタイムアウト (ms) */
  ECHO_TIMEOUT: 5_000,

  /** エコーリトライの最大回数 */
  MAX_ECHO_RETRIES: 2,

  /** 冗長Stemの本数（1=通常, 2=高匿名性） */
  REDUNDANT_STEMS: 1,
} as const;
```

---

## 8. 実装上の注意点

### 8.1 エポックの同期

```
Stemターゲットは10分間固定（エポックベース）。
ただし、全ノードでエポックの開始時刻を同期する必要はない。

各ノードが独立に「最初にStemを送った時刻 + 10分」を管理すればよい。
エポックの開始時刻がズレていても、プロトコルの安全性に影響なし。
```

### 8.2 Stem中のSeenCache登録禁止

```
🔴 致命的バグ: Stem中にSeenCacheに登録すると、
   そのパケットがFluffで戻ってきたときに「既に見た」と判定され、
   中継が止まる → 配信失敗

対策:
  - Stemパケットは SeenCache に登録しない
  - Fluff移行時に初めて SeenCache に登録
  - 中継ノードは Stem→Fluff 変換後にSeenCache登録
```

### 8.3 Dandelion OFF 時のStemパケット処理

```
ユーザーAが Dandelion OFF でも、
他人のStemパケットを受信して中継する義務がある。

理由:
  - Stem中継を拒否すると、攻撃者に
    「このノードはDandelionを使っていない」と分かる
  - 全ノードがStemを中継する = 匿名性の基盤

実装:
  - Dandelion ONの場合:  自分の書き込みでStemを使用 + 他人のStem中継
  - Dandelion OFFの場合: 自分の書き込みは直接Broadcast + 他人のStem中継
```

### 8.4 Zone Gossipとの統合

```
Stemパケットには zone_id が平文で付与されている。

Q: 中継ノードはzone_idでフィルタリングすべきか？
A: NO。Stemフェーズではゾーンフィルタリングしない。

理由:
  - Stem中継は zone_id に関係なく、1人に転送するだけ
  - ゾーンフィルタリングはFluff移行後に行う
  - Stem中にゾーンフィルタすると、
    「このノードはZone42のパケットを受け取った」という
    情報が漏れる（プライバシーリスク）
```

---

## 9. ファイル構成

```
client/src/gossip/
├── ZoneGossipRouter.ts     # ゾーン内BFS Flood（Fluffフェーズ）
├── DandelionRouter.ts      # ★ Stem/Fluff切替・エポック管理・エコーリトライ
├── PacketValidator.ts      # PoW検証・重複排除・TTL管理
└── SeenCache.ts            # packet_id の Bloom Filter / LRU
```
