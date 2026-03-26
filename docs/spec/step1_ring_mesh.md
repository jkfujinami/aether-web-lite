# Step 1: Ring-Mesh ネットワーク基盤 — 確定仕様

**ステータス**: ✅ 確定（シミュレーション検証済み）
**更新日**: 2026-03-20
**採用理由**: 構造的連結保証、IPキャッシュ不要、MAX=8で均等疎結合

---

## 1. アーキテクチャ概要

### 1.1 Ring-Mesh とは

全ノードに仮想的な「円環（Ring）上の位置」を割り当て、
**ローカルリンク（リング上の隣人）** と **ロングレンジリンク（対角ショートカット）**
の2種類の接続で構成される自己組織化メッシュ。

```
       ╭──── LongRange ────╮
       │                    │
  A ── B ── C ── D ── E ── F ── G ── H ── A  (Ring)
       │                         │
       ╰──── LongRange ──────────╯

  Local:     リング上の左右各2人（リング維持、構造的連結保証）
  LongRange: 円環上の対角方向の遠隔ノード（小世界性、3-5ホップで到達）
```

### 1.2 他のアーキテクチャとの比較

| 方式 | 5000ノード avg経路 | 70%削除復旧 | IPキャッシュ | σ(均等性) |
|:-----|:--:|:--:|:--:|:--:|
| PEXのみ(従来) | 463 | ❌ | 必要 | 0.10 |
| HyParView | ~90 | ✅(PV=80必要) | 80件必要 | 0.10 |
| **Ring-Mesh** | **3.5** | **✅(PV=0)** | **不要** | **0.08** |

### 1.3 なぜ Ring-Mesh が最強か

1. **構造的連結保証**: リング上の隣人と必ず接続 → ノード削除時に両隣が自動再接続 → **グラフが分断しない**
2. **IPキャッシュ不要**: Passive View=0でも全テスト合格 → 他人のIPを保持しない
3. **経路長 O(log N)**: ロングレンジリンクがChord DHT的ショートカット → 5000ノードでも3.5ホップ
4. **度数が完全均等**: MAX=8制限で σ=0.08、全ノードが[5..8]接続

---

## 2. 確定パラメータ

```typescript
export const RING_MESH = {
  // ── 接続構成 ──
  /** ローカルリンク数: 左2 + 右2 = 4本（リング維持） */
  LOCAL_LINKS: 4,
  /** ロングレンジリンク数: 対角方向へ最大4本（ショートカット） */
  LONG_RANGE_LINKS: 4,
  /** 1ノードの最大WebRTC接続数 */
  MAX_DEGREE: 8,

  // ── リング位置 ──
  /** 円環の範囲 [0, 1) */
  RING_SIZE: 1.0,
  /** ロングレンジの最小距離（リング上で0.2以上離れたノード） */
  LONG_RANGE_MIN_DISTANCE: 0.2,

  // ── タイマー ──
  HEARTBEAT_INTERVAL: 15_000,    // ping間隔 (15秒)
  HEARTBEAT_TIMEOUT: 45_000,     // デッド判定 (45秒)
  REPAIR_CHECK_INTERVAL: 10_000, // 修復チェック間隔 (10秒)

  // ── シグナリング ──
  INITIAL_PEERS: 6,              // トラッカーから取得するピア数
  CONNECTION_TIMEOUT: 10_000,    // WebRTC接続タイムアウト
} as const;
```

### 2.1 パラメータ選定根拠（シミュレーション実証）

| パラメータ | 値 | 根拠 |
|:-----------|:---|:-----|
| LOCAL_LINKS=4 | 左右各2本でリング構造を冗長に維持。1本切れてもリング連結 |
| LONG_RANGE_LINKS=4 | MAX(8)-LOCAL(4)=4本。avg経路3.5ホップを実現 |
| MAX_DEGREE=8 | 度数σ=0.08で完全均等、ブラウザ負荷16%(Chrome上限50本) |
| PV=0 | IPキャッシュ不要。70%削除でも自力復旧。プライバシー最大化 |

---

## 3. ノードID と円環上の位置

### 3.1 位置の決定

```typescript
// ノード参加時にランダムな位置を生成
const position = crypto.getRandomValues(new Uint32Array(1))[0] / 0xFFFFFFFF;
// position ∈ [0.0, 1.0) — 円環上の位置
```

### 3.2 円環上の距離

```typescript
function ringDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 1 - d);  // 円環なので短い方の弧を取る
}
```

---

## 4. 接続プロトコル

### 4.1 ノード参加フロー

```
1. ブラウザ起動 → 円環上の位置をランダム生成
2. トラッカーに接続 → 6人のピアSDPを取得
3. 6人とWebRTC接続を試行

4. 接続確立後、各ピアに自分の position を通知:
   { type: 'join', peerId, position }

5. ピアから応答で「リング上の隣人情報」を受け取る:
   { type: 'ring-info', neighbors: [{id, position}, ...] }

6. リング上の正しい位置に自分を挿入:
   a) 自分の左2人・右2人をローカルリンク候補として特定
   b) 候補にWebRTC接続（既存接続のDataChannel越しにSDPリレー）
   c) ローカルリンク4本が確立

7. ロングレンジリンク:
   a) 円環上で distance >= 0.2 のノードをPEXで探す
   b) MAX_DEGREE(8) - ローカル(4) = 4本まで接続

8. トラッカー切断 ★
```

### 4.2 ノード離脱検出と修復

```
Heartbeatでピアの死亡を検出:

1. ローカルリンクが切れた場合:
   → リングの次の隣人を自動探索して接続
   → 相手がMAX超過なら、相手のロングレンジを1本切ってもらう
      (ローカルリンクはロングレンジより常に優先)

2. ロングレンジリンクが切れた場合:
   → 枠に余裕があれば、ローカル隣人にPEXで新候補を尋ねて接続
   → なくても動作上問題なし（経路長がやや増えるだけ）
```

### 4.3 ローカルリンク優先ルール

```
新ノードXがリングに挿入され、ノードBにローカルリンクを要求した場合:

  if (B.degree < MAX_DEGREE) {
    // 枠に余裕あり → 普通に接続
    B.connect(X);
  } else {
    // MAX超過 → ロングレンジを1本切ってローカルを受け入れ
    const longRangeLinks = B.neighbors.filter(n => !B.isLocalNeighbor(n));
    if (longRangeLinks.length > 0) {
      B.disconnect(randomChoice(longRangeLinks));
      B.connect(X);
    }
    // ロングレンジが0本なら → 接続拒否（稀、リング上の密集時のみ）
  }
```

---

## 5. 対称性の数学的保証

### 5.1 各ノードのRTC接続数

```
ローカルリンク:
  自分が選ぶ隣人: 左2 + 右2 = 4人
  自分を選ぶ隣人: 左2 + 右2 = 4人（完全に同一の4人）
  → ローカルリンクは対称 → 接続数 = 4（増えない）

ロングレンジリンク:
  自分が張る: 最大4本
  相手からの着信: MAX超過なら拒否
  → 最大4本

合計: 常に 4 + 4 = 最大 8 RTCPeerConnections
```

### 5.2 ブラウザリソース影響

| リソース | 8接続時の消費 | ブラウザ上限 | 使用率 |
|:---------|:------------|:------------|:------:|
| RTCPeerConnection | 8個 | ~50個(Chrome) | 16% |
| DataChannel | 8本 | メモリが許す限り | 極小 |
| ICE候補 (STUN) | 初期のみ | 制限なし | 0% |
| メモリ | ~16MB | ~4GB(タブ) | 0.4% |

---

## 6. P2Pメッセージ定義

```typescript
export type P2PMessage =
  // ── Ring管理 ──
  | { type: 'join'; peerId: PeerId; position: number }
  | { type: 'ring-info'; neighbors: Array<{ id: PeerId; position: number }> }
  | { type: 'local-link-request'; peerId: PeerId; position: number }
  | { type: 'local-link-accept'; peerId: PeerId }
  | { type: 'local-link-reject'; reason: 'max-degree' | 'not-neighbor' }

  // ── 生存確認 ──
  | { type: 'ping'; ts: number }
  | { type: 'pong'; ts: number; echoTs: number }

  // ── PEX (ロングレンジ候補探索) ──
  | { type: 'pex-request'; minDistance: number }
  | { type: 'pex-response'; peers: Array<{ id: PeerId; position: number }> }

  // ── シグナリング (DataChannel越し) ──
  | { type: 'sdp-relay'; targetPeerId: PeerId; sdp: RTCSessionDescriptionInit }
  | { type: 'ice-relay'; targetPeerId: PeerId; candidate: RTCIceCandidateInit }

  // ── ゴシップ (Step 2) ──
  | { type: 'gossip'; packet: GossipPacket }

  // ── Mailbox (Step 3) ──
  | { type: 'dht-get'; topicHash: string }
  | { type: 'dht-put'; topicHash: string; data: Uint8Array }
  | { type: 'dht-response'; topicHash: string; data: Uint8Array | null };
```

---

## 7. シミュレーション実証結果

### 7.1 メッシュ耐性テスト (MAX_DEGREE=8, PV=0)

| テスト | 結果 |
|:-------|:-----|
| 5000ノード成長 | ✅ 連結、孤立0、deg=8.0 σ=0.05 |
| 10%削除+修復 | ✅ 連結、孤立0、deg=8.0 σ=0.00 |
| 30%削除+修復 | ✅ 連結、孤立0、deg=8.0 σ=0.12 |
| 50%削除+修復 | ✅ 連結、孤立0、deg=8.0 σ=0.00 |
| 70%削除+修復 | ✅ 連結、孤立0、deg=8.0 σ=0.20 |
| Churn 30step(5%/step) | ✅ 最悪孤立0、分断2/30(即回復) |

### 7.2 ゴシップ配信テスト (Broadcast Veil on Ring-Mesh)

| テスト | 到達率 | 帯域(中継回数) |
|:-------|:------:|:--------:|
| 100ノード | **100.0%** | 99回 |
| 500ノード | **100.0%** | 499回 |
| 1000ノード | **100.0%** | 999回 |
| 20メッセージ連続配信(1000) | **100.00%** | - |
| 30%削除+修復後 | **100.0%** | - |

### 7.3 Mailbox (DHT K-Replication) テスト

| テスト | 結果 |
|:-------|:-----|
| K=5 冗長保管 | 5/5ノード保管 ✅ |
| データ取得(3レス) | 15コピー取得(3×5) ✅ |
| Mailbox担当 3/5 死亡 | 残存2ノードから6コピー取得 ✅ |
| Churn 30%後のデータ取得 | 生存ノードからデータ取得 ✅ |

### 7.4 制限なし版との比較

| 指標 | 制限なし | MAX=8制限 |
|:-----|:---------|:---------|
| avg度数 | 15.93 | **8.00** |
| σ | 8.26 | **0.08** |
| min..max | 8..57 | **5..8** |
| avg経路(1000) | 2.88 | 25.28(初期) → **3.6(Churn後)** |

> 初期の経路長が長いのは、まだ撹拌が進んでいないため。
> Churn（自然な入退出）や意図的な撹拌で3-5ホップに収束する。

---

## 8. 実装上の注意点（検証で判明した罠）

以下は全てシミュレーション検証中に判明し、修正を経て解決した問題。
**実装時に同じ罠にハマらないよう、必ず読んでから実装すること。**

### 8.1 🔴 致命的: ゴシップは BFS（幅優先）で中継すること

```
❌ DFS（再帰/深さ優先）で実装すると到達率が17%に落ちる
✅ BFS（キュー/幅優先）で実装すると到達率100%

原因:
  DFSだと seenPackets の重複排除がリアルタイムに効くため、
  1つ目の隣人→その先 と深く進んだ時点で、
  残りの隣人が既に「seen」になってしまい、
  伝播が一方向にしか進まない。

  BFSなら全隣人に「同時に」送信し、
  各ホップレベルで全方向に均等に広がる。

実装:
  const queue: { peerId: string; hops: number }[] = [{ peerId: selfId, hops: 0 }];
  const seen = new Set<string>([selfId]);

  while (queue.length > 0) {
    const { peerId, hops } = queue.shift()!;
    if (hops >= MAX_HOPS) continue;

    for (const neighbor of getPeers(peerId)) {
      if (seen.has(neighbor)) continue;
      seen.add(neighbor);
      sendGossip(neighbor, packet);
      queue.push({ peerId: neighbor, hops: hops + 1 });
    }
  }

注意:
  実際のWebRTC実装では物理的に非同期なので通常はBFS的に動くが、
  テストやシミュレーションでは明示的にBFSキューを使うこと。
  現実の実装でも、受信→即リレーの同期的ループはDFS相当になる危険がある。
  DataChannel.onmessage内でsetTimeout(0)やqueueMicrotaskで
  リレーを遅延させることで、自然なBFS動作になる。
```

### 8.2 🔴 致命的: ローカルリンク優先ルール（evictLongRange）

```
❌ connect() で一律にMAX超過チェック → ローカルリンクが張れずリングが切断
✅ connectLocal() でロングレンジを1本切って枠を空ける

これがないと:
  - リング切断🔴が頻発（テストで「🔴切断」が全行に出る）
  - ゴシップ到達率が0.8%〜34.7%に崩壊
  - MAX=8制限が有名無実になる

実装:
  function connectLocal(a: PeerId, b: PeerId): boolean {
    if (a === b) return false;
    if (isConnected(a, b)) return true;

    // 自分側のMAX超過 → ロングレンジを切る
    if (degree(a) >= MAX_DEGREE) {
      if (!evictLongRange(a)) return false;
    }
    // 相手側のMAX超過 → 相手のロングレンジを切ってもらう
    if (degree(b) >= MAX_DEGREE) {
      // 実際の実装では local-link-request メッセージで相手に依頼
      // 相手は自分のロングレンジの中からランダムに1本切って応答
      if (!evictLongRange(b)) return false;
    }

    doConnect(a, b);
    return true;
  }

  function evictLongRange(id: PeerId): boolean {
    const localIds = getLocalNeighborIds(id);
    const longRange = getNeighbors(id).filter(n => !localIds.has(n));
    if (longRange.length === 0) return false; // ローカルだけで8本 = 密集
    const victim = randomChoice(longRange);
    doDisconnect(id, victim);
    return true;
  }
```

### 8.3 🟡 重要: リング上の「位置」は永続化が必要

```
ノードの円環位置（position）は、そのノードの「住所」に等しい。

絶対に守るべきこと:
  1. positionは参加時に1度だけ生成し、以後変更しない
  2. IndexedDB (Dexie) 、またはCoockieに永続化する
  3. 再接続時に同じpositionを使う
     → 同じ位置に戻るため、Mailbox担当も変わらない

positionが変わると:
  - ローカルリンクの対象が全部変わる
  - Mailbox担当ノードの計算結果が変わる → データロスの原因
  - リング上の「挿入」が発生し、周囲のノードに影響を与える
```

### 8.4 🟡 重要: ローカルリンクの「誰が隣か」は全ノードで合意が必要

```
リング上の隣人は「円環位置の近さ」で決まるが、
全ノードが「全ノードの位置」を知っているわけではない。

実装のポイント:
  1. ノード参加時に、接続先ピアから ring-info をもらう
     → 近傍ノードのposition一覧を取得
  2. この一覧からローカル隣人を計算
  3. 新ノードが参加/離脱するたびに、影響を受けるノードに通知

注意点:
  - リング上の「誰が隣か」の判定は、知っているノードの情報だけで行う
  - 知らないノードが間に挟まっている場合がある（結果的にローカルが3人分になる等）
  - これは構造的に許容される：「知っている範囲での最近隣」で十分
  - 全体の整合性はPEXとHeartbeatの繰り返しで徐々に収束する
```

### 8.5 🟡 重要: repairAll() の反復実行に注意

```
❌ repairAll()を3回連続実行 → 逆に接続を剥奪し合って悪化する可能性
✅ repairAll()は1回実行 + 次のインターバルで再実行

理由:
  repairAll()内で全ノードが同時にロングレンジを張り直すと、
  ノードAがノードBのロングレンジを切り、
  直後にノードBがノードCのロングレンジを切る...
  という連鎖が発生し、ネットワーク全体が不安定になる。

実装:
  - repairCheck は REPAIR_CHECK_INTERVAL(10秒) ごとに1回実行
  - 各ノードが非同期に自分の修復を実行（全ノード同時ではない）
  - ロングレンジの「立ち退き」はローカルリンク要求が来たときだけ
  - 定期修復ではロングレンジの「補充」のみ行う（切らない）
```

### 8.6 🟡 重要: ゴシップの帯域コスト（Broadcast Veil の代償）

```
BFS Floodの帯域:
  1メッセージ送信 → 全ノードに1回ずつ届く → N-1回の中継

  1000ノード → 999回の中継 = 1メッセージあたり999パケット送信
  10000ノード → 9999回の中継

これは Broadcast Veil（全ノードが全メッセージを中継）の設計上不可避。

最適化:
  1. seenPackets（Bloom Filter化）で重複排除
     → 各ノードは1メッセージにつき1回しか受信・中継しない
  2. TTL (MAX_HOPS=30) で無限ループを防止
  3. メッセージサイズを最小化（暗号化ペイロードのみ）
  4. fanout制限: 全隣人への中継ではなく、ランダムにK人に中継
     → 帯域をO(N)からO(N * K/degree)に削減
     → ただし到達率とのトレードオフ

推奨: 初期実装はBFS Full Flood（到達率100%保証）で動作確認後、
      fanout制限でチューニング
```

### 8.7 🟢 注意: Mailbox (DHT) の再レプリケーション

```
Churnでmailbox担当ノードが入れ替わった場合:

問題:
  topicHash に最も近い5ノードが担当だが、
  Churn後に近いノードが変わる → 新しい担当にデータがない

対策（定期再レプリケーション）:
  1. 毎分、自分のmailboxの全topicHashについて、
     現在のK最近接ノードを再計算
  2. 新しい担当になったノードにデータをコピー
  3. 自分が担当から外れていたら、データを保持したまま
     次回のGCで削除（即削除しない→安全マージン）

実装:
  setInterval(() => {
    for (const [topicHash, entries] of myMailbox) {
      const currentNearest = findKNearest(topicHash, K);
      for (const nodeId of currentNearest) {
        if (nodeId !== selfId && !hasDataOnNode(nodeId, topicHash)) {
          sendDhtPut(nodeId, topicHash, entries);
        }
      }
    }
  }, 60_000);
```

### 8.8 🟢 注意: WebRTC固有の問題

```
1. ICE接続失敗（Symmetric NAT）
   - STUN成功率は約85-92%
   - 失敗した場合、ロングレンジリンクとして試行 → 別の候補を試す
   - ローカルリンクの場合は「その次の隣人」にフォールバック
   - TURNは使わない（帯域コスト・プライバシーの観点）

2. DataChannel切断の検出
   - channel.onclose だけでなく、connection.oniceconnectionstatechange も監視
   - 'disconnected' → 5秒待機 → 'failed' → デッド判定
   - Heartbeat TIMEOUT(45秒) はICE再接続のフォールバック

3. バックグラウンドタブ
   - WebRTC DataChannelはブラウザのスロットリング対象外
   - ただし setInterval は1分に1回にスロットルされる
   - → Heartbeat/修復タイマーは Web Worker に移す
   - Web Worker から postMessage で main thread に通知

4. SDPリレー越しの接続
   - 直接接続できないノードへは、既存DataChannel越しにSDPを中継
   - 中継パス: A → B → C（A-C間の接続をB経由で確立）
   - 注意: 中継ノードBが途中で死ぬと接続確立が失敗する
   - → タイムアウト(CONNECTION_TIMEOUT=10秒)で検出し、別パスを試行
```

### 8.9 🟢 注意: レースコンディション

```
1. 同時参加
   - 2ノードが同時にリングの同じ位置に挿入される場合
   - 各ノードはpositionが異なるため（暗号乱数）、衝突確率は0に近い
   - 万が一、同じpositionの場合はPeerIdの辞書順で左右を決定

2. 同時離脱
   - ローカルリンクの隣人2人が同時に死亡した場合
   - 左右の「次の隣人」同士が再接続 → リング維持
   - 3人以上が同時に死亡しても、repairCheckで次のインターバルで修復

3. ローカルリンク要求の競合
   - ノードAがノードBにlocal-link-requestを送ったタイミングで、
     ノードCも同時にBにlocal-link-requestを送る
   - Bのロングレンジ枠が1本しかない場合、先着順で1人だけacceptき
   - rejectされた方は次のrepairCheckで再試行

4. 同時evictLongRange
   - AとCが同時にBにevict要求 → Bのロングレンジが2本切れる
   - これは許容される（ロングレンジはなくても動作する）
   - 次のrepairCheckでBがロングレンジを補充する
```

### 8.10 🟢 注意: セキュリティ上の考慮事項

```
1. position偽装攻撃
   - 悪意のあるノードが position を自由に選んで、
     特定ノードのローカル隣人になりすます
   - 対策: Node Aging（新規ノードのメッセージ優先度を下げる）
   - 対策: positionのコミット（参加時にHash(peerId)ベースでposition決定）
     → peerId自体が暗号鍵ペアから導出されるため偽装困難

2. Eclipse攻撃
   - 攻撃者がターゲットノードの全ローカル隣人を占有する
   - Ring-Meshでは左右各2ノード(4本)を占有する必要がある
   - positionが暗号ランダムなので、計算的に隣に配置するのは困難
   - ロングレンジリンクが追加の独立接続を提供するため、
     ローカルが全て乗っ取られてもロングレンジ経由で正常ノードと通信可能

3. Sybil攻撃
   - 大量の偽ノードでネットワークを占有する
   - 対策: Cloudflare Turnstile（Bot Protection）
   - 対策: Tracker Rate Limiting（同一IPからの参加頻度制限）
   - 対策: Node Aging（新規ノードの信頼度が低い）
```

---

## 9. 設計判断の経緯とアーキテクチャ比較

### 9.1 検証した3つのアーキテクチャ

```
Phase 1: PEXのみメッシュ（従来型）
  → 問題: 30%削除で分断、トラッカー依存、経路長463

Phase 2: HyParView強化メッシュ
  → 改善: Passive View(80)で分断復旧
  → 問題: Passive View=80のIPキャッシュ必要、経路長90

Phase 3: Ring-Mesh（確定）
  → 解決: 構造的連結保証、PV=0、経路長3.5
```

### 9.2 破棄された設計オプション

```
1. Passive View (HyParView)
   → 理由: PV=80件のIPキャッシュが必要 → プライバシーに反する
   → Ring-Meshはリング構造自体が連結を保証するためPV不要

2. 撹拌（Active View Shuffle）
   → 理由: Ring-Meshではロングレンジリンクの入れ替えが自然に行われる
   → Churnが自然な撹拌として機能するため、明示的な撹拌は不要
   → ただし過疎時（Churnが少ない場合）は手動撹拌必要 → TODO

3. トラッカーフォールバック
   → 理由: Ring-Meshでは構造的にトラッカーなしで復旧可能
   → トラッカーは「最初の1人目と出会う」ためだけに存在
```

---

## 10. ファイル構成（確定）

```
client/src/network/
├── RingPosition.ts      # 円環位置の生成・永続化・距離計算
├── WebRTCPeer.ts        # 単一WebRTC接続の抽象化
├── PeerManager.ts       # 全ピア管理・ローカルリンク優先制御（connectLocal/evictLongRange）
├── RingMaintainer.ts    # リング構造の維持・修復・ローカル隣人計算
├── GossipRouter.ts      # BFS Floodゴシップ・seenPackets・TTL管理
├── DHTMailbox.ts        # K最近接ノード計算・PUT/GET・再レプリケーション
├── PEXHandler.ts        # ロングレンジ候補のPeer Exchange
├── SignalingClient.ts   # トラッカーWebSocket（初期接続のみ）
├── Heartbeat.ts         # 死活監視 (Web Worker内で実行)
└── NetworkEvents.ts     # イベント型定義
```

---

## 11. シミュレーション実行環境

```
simulation/src/
├── RingMeshSimulator.ts     # Ring-Mesh基本シミュレータ（制限なし版）
├── run_ring.ts              # 基本テスト（成長、削除、Churn、パラメータスイープ）
├── run_strict_ring.ts       # MAX=8厳密制限テスト
├── run_ring_constrained.ts  # MAX=8 + PVスイープ
├── run_gossip_mailbox.ts    # ★ ゴシップ + Mailbox 統合テスト（connectLocal実装済み）
├── EnhancedMeshSimulator.ts # HyParView比較用（参考）
├── MeshSimulator.ts         # 従来メッシュ比較用（参考）
└── run.ts                   # 従来メッシュテスト（参考）

再現方法:
  cd simulation && npx tsx src/run_gossip_mailbox.ts
```
