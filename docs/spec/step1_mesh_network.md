> ⛔ **この仕様は廃止されました**
> Ring-Mesh + Adaptive Zone に移行済みです。
> 現行仕様: [`step1_ring_mesh.md`](./step1_ring_mesh.md), [`step1_ring_mesh_zone.md`](./step1_ring_mesh_zone.md)

# Step 1: メッシュネットワーク基盤 — 詳細仕様 (~~廃止: Ring-Meshに移行済み~~)

**ステータス**: ❌ 廃止（PEXベース → Ring-Meshに移行）
**依存**: なし
**目的**: WebRTCを用いた自己修復型P2Pメッシュネットワークの構築

---

## 1. 概要

ブラウザ間でWebRTC DataChannelによる疎結合メッシュを構築し、以下を保証する：

- **孤立防止**: いかなる状況でもノードが完全に孤立しない
- **自己修復**: ピアの離脱を自動検出し、接続度を自律回復する
- **均等な疎結合**: 全ノードが概ね同程度の接続数を維持する
- **撹拌**: 定期的な接続の入れ替えでネットワークの固着を防ぐ

---

## 2. 定数パラメータ

> ⚠️ 最終値はシミュレーション（後述）で確定する

```typescript
export const MESH = {
  MIN_DEGREE: 5,           // 最小接続数
  MAX_DEGREE: 8,           // 最大接続数
  TARGET_DEGREE: 6,        // 理想接続数
  PEX_INTERVAL: 30_000,    // PEXリクエスト間隔 (ms)
  PEX_MAX_PEERS: 4,        // PEX応答の最大ピア数
  SHUFFLE_INTERVAL: 120_000, // 撹拌間隔 (ms)
  SHUFFLE_DROP_COUNT: 1,   // 撹拌で切断するピア数
  HEARTBEAT_INTERVAL: 15_000, // ping間隔 (ms)
  HEARTBEAT_TIMEOUT: 45_000,  // デッド判定タイムアウト (ms)
  MAX_PENDING_CONNECTIONS: 3, // 並行接続試行数上限
  CONNECTION_TIMEOUT: 10_000, // WebRTC接続タイムアウト (ms)
  NODE_AGING_THRESHOLD: 600_000, // 新参者制限 (10分)
} as const;
```

---

## 3. 関連ファイルと責務

| ファイル | クラス/モジュール | 責務 |
|:---------|:-----------------|:-----|
| `WebRTCPeer.ts` | `WebRTCPeer` | 単一ピアとのWebRTC接続ラッパー |
| `PeerManager.ts` | `PeerManager` | 全ピアの管理、接続度維持 |
| `SignalingClient.ts` | `SignalingClient` | トラッカーWebSocket通信 |
| `PEX.ts` | `PEXHandler` | Peer Exchange プロトコル |
| `MeshStabilizer.ts` | `MeshStabilizer` | 自己修復・撹拌のスケジューラ |
| `NetworkEvents.ts` | (型定義) | ネットワークイベントの型 |

---

## 4. WebRTCPeer — 単一接続の管理

### 4.1 状態遷移

```
  Connecting ──→ Connected ──→ Disconnecting ──→ Disconnected
       │                              ↑
       └──────────────────────────────┘
              (タイムアウト or エラー)
```

### 4.2 DataChannel の設定

```typescript
const DC_CONFIG: RTCDataChannelInit = {
  ordered: false,      // 順序保証不要（ゴシップは順不同）
  maxRetransmits: 2,   // 再送は最大2回（リアルタイム性優先）
};
```

**理由**: ゴシップパケットは重複排除されるため、順序保証は不要。
再送を過度に行うと遅延が増大するため、最大2回に制限。

### 4.3 メッセージのシリアライズ

```typescript
// MessagePack でバイナリシリアライズ
// JSON比で 30-50% のサイズ削減
import { pack, unpack } from 'msgpackr';

send(msg: P2PMessage): void {
  if (this.dc?.readyState === 'open') {
    this.dc.send(pack(msg));
  }
}
```

### 4.4 RTCPeerConnection の設定

```typescript
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.services.mozilla.com' },
  ],
  iceCandidatePoolSize: 2,
  bundlePolicy: 'max-bundle',
};
```

---

## 5. PeerManager — メッシュ管理の中核

### 5.1 接続ライフサイクル

```
1. [ブートストラップ]
   SignalingClient → トラッカーから6人のPeerId取得
   → 各ピアとWebRTC接続開始（並行3本まで）
   → MIN_DEGREE(5)人と接続完了 → トラッカー切断

2. [定常運用]
   Heartbeat (15s間隔) → デッドピア検出 → removePeer()
   PEX (30s間隔) → 隣人から新ピア候補を取得 → キャッシュ
   Shuffle (120s間隔) → 1本切って1本繋ぐ

3. [自己修復]
   degree < MIN → repairMesh() 発火
   degree == 0 → emergencyRecovery() 発火
```

### 5.2 接続受入ロジック

```typescript
/**
 * 新規接続要求を受けるかどうかの判定
 */
shouldAcceptConnection(fromPeerId: PeerId): boolean {
  // 既に接続中 → 拒否
  if (this.peers.has(fromPeerId)) return false;

  // MAX_DEGREE 以上 → 拒否
  if (this.degree >= MESH.MAX_DEGREE) return false;

  // 並行接続試行数が上限 → 拒否
  if (this.pendingCount >= MESH.MAX_PENDING_CONNECTIONS) return false;

  return true;
}
```

### 5.3 切断時の安全ルール

```
■ 自発的切断の条件（自分から切る場合）:

  1. degree > MIN_DEGREE であること（必須）
  2. 切断後も degree >= MIN_DEGREE が維持されること
  3. Shuffle の場合は「新接続確立後に旧接続を切断」

■ 切断対象の優先度（誰を切るか）:

  Shuffle時:
    age が最も古いピアを優先（長期固着の防止）

  MAX_DEGREE 超過時:
    age が最も新しいピアを優先（後から来た人を外す）

  手動切断:
    RTT が最も大きいピアを優先（品質最適化）
```

---

## 6. PEX (Peer Exchange) プロトコル

### 6.1 フロー

```
  [A] ── pex-request ──→ [B]

  [B] は自分の接続中ピアからランダムに最大4人選出:
    フィルタ条件:
      - Aと既に接続中のピアは除外
      - Node Age < 10分のピアは除外
      - 直近5分以内にPEX応答に含めたピアは除外

  [B] ── pex-response { peers: [C,D,E,F] } ──→ [A]

  [A] は C,D,E,F に対して接続試行:
    - A→B経由でSDPをリレー（Bが中継シグナリング）
    - 接続成功 → peers に追加
    - 接続失敗 → スキップ（次回PEXで別ピアを試行）
```

### 6.2 WebRTC越しのシグナリング（SDP Relay）

トラッカー離脱後、PEXで知った新ピアと接続するためのSDP交換を
既存のDataChannel上で行う。

```
  [A]                [B (中継)]            [C (新規)]
   │                    │                     │
   │ sdp-relay(C, offer)│                     │
   │ ──────────────────→│── sdp-relay(offer)→ │
   │                    │                     │
   │                    │← sdp-relay(answer)──│
   │← sdp-relay(C,ans) │                     │
   │                    │                     │
   │── ice-relay(C,ice)→│── ice-relay(ice) ──→│
   │← ice-relay(C,ice)──│← ice-relay(ice) ───│
   │                    │                     │
   │═══════ WebRTC直接接続確立 ═══════════════│
```

---

## 7. MeshStabilizer — 自己修復アルゴリズム

### 7.1 修復トリガーと優先度

| トリガー | アクション | 優先度 |
|:---------|:-----------|:------:|
| `degree == 0` | `emergencyRecovery()` → トラッカー即時再接続 | CRITICAL |
| `degree < MIN(5)` | `repairMesh()` → PEXキャッシュ → PEX要求 → トラッカー | HIGH |
| `degree > MAX(8)` | `gracefulDisconnect()` → 最新ピアを1つ切断 | MEDIUM |
| 定期 (120s) | `shufflePeers()` → 1つ切って1つ繋ぐ | LOW |

### 7.2 repairMesh() の詳細フロー

```
1. PEXキャッシュ(最大20件)からランダムに3件選択
   → WebRTC接続試行（並行、タイムアウト10s）
   → 成功 → degree確認 → MIN以上なら終了

2. キャッシュ枯渇 or 全失敗
   → 全接続中ピアにpex-request送信
   → 応答待ち (5s)
   → 候補から接続試行

3. PEXでも不足
   → トラッカーに一時再接続（指数バックオフ）
   → 新規ピア取得 → 接続
   → MIN以上になったらトラッカー切断
```

### 7.3 emergencyRecovery() の詳細

```
完全孤立（degree == 0）からの復帰:

1. 即時: トラッカーに接続（バックオフなし）
2. トラッカーから INITIAL_PEERS(6) 人取得
3. 全員に並行で接続試行
4. 1人でも接続完了 → PEXで追加拡張
5. トラッカーが応答しない場合:
   → 5秒待機 → リトライ（最大5回）
   → 全失敗 → UIに「ネットワーク接続不可」表示
```

### 7.4 shufflePeers() の詳細

```
1. degree <= MIN_DEGREE → シャッフルスキップ（安全優先）

2. PEXキャッシュから新ピア候補を1人選出
   → キャッシュ空なら隣人にpex-request → 応答待ち

3. 新ピアとWebRTC接続を試行
   → タイムアウト(10s)したらシャッフルを中止

4. 新接続が confirmed:
   → 旧ピア（age最古）を graceful close
   → 結果: degree は変化なし（+1 -1）

5. 新接続が failed:
   → 何もしない（旧ピアは切断しない）
```

---

## 8. Heartbeat — 死活監視

```
■ 送信側（15秒間隔）:
  各ピアに { type: 'ping', ts: Date.now() } を送信

■ 受信側:
  ping を受け取ったら即座に
  { type: 'pong', ts: Date.now(), echoTs: msg.ts } を返す

■ 判定:
  lastHeartbeat = pong受信時刻を記録
  Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT(45s)
    → ピアを dead と判定 → removePeer()

■ RTT計算:
  rtt = Date.now() - msg.echoTs  (pong受信時)
```

---

## 9. ネットワークイベント定義

```typescript
export interface NetworkEvents {
  'peer:connected': (peer: PeerInfo) => void;
  'peer:disconnected': (peerId: PeerId, reason: string) => void;
  'peer:message': (peerId: PeerId, message: P2PMessage) => void;
  'mesh:repaired': (newDegree: number) => void;
  'mesh:shuffled': (dropped: PeerId, added: PeerId) => void;
  'mesh:isolated': () => void;          // degree == 0
  'mesh:recovered': () => void;         // 孤立から回復
  'signaling:connected': () => void;
  'signaling:disconnected': () => void;
  'pex:received': (count: number) => void;
}
```

---

## 10. テスト方針

### 10.1 ユニットテスト

| 対象 | テスト内容 |
|:-----|:-----------|
| `WebRTCPeer` | 状態遷移、DataChannel送受信のモック |
| `PeerManager` | 接続度の維持ロジック、受入判定 |
| `PEXHandler` | フィルタリング、キャッシュ管理 |
| `MeshStabilizer` | 各トリガーでの正しいアクション発火 |

### 10.2 統合テスト（シミュレーション）

→ `simulation/` ディレクトリで実施。次セクション参照。
