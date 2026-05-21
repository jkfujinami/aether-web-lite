# WS-3: DataChannel Stream + Binary Wire Protocol + WS-4: NAT Traversal

> WS-3 と WS-4 は並行実施可能。どちらも WS-1 (Next.js 移植) 完了後に着手。
>
> **WS-3.5 (Binary Wire Protocol)** は WS-3 に統合して同時実装する。

---

# Part A: WS-3 DataChannel Stream

## 1. 問題

WebRTC DataChannel のメッセージサイズ制限：

| ブラウザ | SCTP最大 | 実測安全値 | 超過時 |
|:---------|:--------:|:---------:|:-------|
| Chrome | ~256KB | ~64KB | 無言で切断 or エラー |
| Firefox | ~1MB | ~64KB | 同上 |
| Safari | ~64KB | ~16KB | 特にシビア |
| Mobile Chrome | ~64KB | ~16KB | メモリ制約も |

現行コードは **メッセージ全体を 1 回の `send()` で送信** しており、
同期データ（スレッド全レスの一括応答）が 16KB を超えると Safari/Mobile で破壊される。

## 2. チャンクプロトコル設計

### 2.1 パケットフォーマット

```
┌─────────────────────────────────────┐
│  Byte 0: Protocol Version (0x01)   │
│  Bytes 1-4: Message ID (uint32)    │
│  Bytes 5-6: Sequence Number (uint16)│
│  Bytes 7-8: Total Chunks (uint16)  │
│  Bytes 9-10: Chunk Size (uint16)   │
│  Byte 11: Flags                    │
│    bit 0: FIN (last chunk)         │
│    bit 1: ABORT                    │
│    bit 2-7: reserved               │
├─────────────────────────────────────┤
│  Bytes 12+: Payload (max 4096B)    │
└─────────────────────────────────────┘

Header: 12 bytes (固定)
Payload: max 4096 bytes
Total per chunk: max 4108 bytes ← 全ブラウザで安全
```

### 2.2 なぜ 4KB か

```
Safari (iOS) の安全閾値: ~16KB
4KB payload + 12B header = 4108B ← 16KB の 1/4
→ 4チャンクまでバースト送信しても安全

通常のゴシップパケット: 200B - 2KB → チャンク不要（1発で送れる）
同期応答（100レス分）: 50KB - 200KB → 12-50チャンクに分割
```

### 2.3 小さなメッセージの最適化

```
4KB 以下のメッセージ:
  → チャンクヘッダなし。従来通り 1 回の send() で送信
  → 受信側は先頭バイトで判別:
     0x01 = チャンクプロトコル
     それ以外 = 従来のJSON or バイナリ
```

## 3. 実装

### 3.1 ChunkedSender

```typescript
// lib/network/stream/ChunkedSender.ts

const CHUNK_SIZE = 4096;
const HEADER_SIZE = 12;
const MAX_BUFFERED = 64 * 1024; // 64KB のバックプレッシャー閾値

export class ChunkedSender {
  private msgCounter = 0;

  async send(dc: RTCDataChannel, data: ArrayBuffer): Promise<void> {
    // 4KB以下はそのまま送信
    if (data.byteLength <= CHUNK_SIZE) {
      dc.send(data);
      return;
    }

    const msgId = this.msgCounter++;
    const totalChunks = Math.ceil(data.byteLength / CHUNK_SIZE);

    for (let seq = 0; seq < totalChunks; seq++) {
      // バックプレッシャー: バッファが溜まっていたら待機
      while (dc.bufferedAmount > MAX_BUFFERED) {
        await new Promise(r => setTimeout(r, 10));
      }

      const offset = seq * CHUNK_SIZE;
      const end = Math.min(offset + CHUNK_SIZE, data.byteLength);
      const payload = data.slice(offset, end);
      
      const chunk = new ArrayBuffer(HEADER_SIZE + payload.byteLength);
      const view = new DataView(chunk);
      
      view.setUint8(0, 0x01);                    // version
      view.setUint32(1, msgId);                   // msgId
      view.setUint16(5, seq);                     // seqNo
      view.setUint16(7, totalChunks);             // total
      view.setUint16(9, payload.byteLength);      // chunkSize
      view.setUint8(11, seq === totalChunks - 1 ? 0x01 : 0x00); // FIN flag
      
      new Uint8Array(chunk, HEADER_SIZE).set(new Uint8Array(payload));
      dc.send(chunk);
    }
  }
}
```

### 3.2 ChunkedReceiver

```typescript
// lib/network/stream/ChunkedReceiver.ts

const REASSEMBLY_TIMEOUT = 10_000; // 10秒以内に全チャンク着信しなければ廃棄

interface PendingMessage {
  chunks: Map<number, ArrayBuffer>;
  totalChunks: number;
  totalSize: number;
  createdAt: number;
}

export class ChunkedReceiver {
  private pending = new Map<number, PendingMessage>();
  private onMessage: (data: ArrayBuffer) => void;

  constructor(onMessage: (data: ArrayBuffer) => void) {
    this.onMessage = onMessage;
    // 定期的にタイムアウトした未完成メッセージを掃除
    setInterval(() => this.cleanup(), 5000);
  }

  receive(raw: ArrayBuffer): void {
    const view = new DataView(raw);
    
    // プロトコルバージョンチェック
    if (view.getUint8(0) !== 0x01) {
      // 非チャンクメッセージ → そのまま通過
      this.onMessage(raw);
      return;
    }

    const msgId = view.getUint32(1);
    const seqNo = view.getUint16(5);
    const totalChunks = view.getUint16(7);
    const chunkSize = view.getUint16(9);

    let pm = this.pending.get(msgId);
    if (!pm) {
      pm = { chunks: new Map(), totalChunks, totalSize: 0, createdAt: Date.now() };
      this.pending.set(msgId, pm);
    }

    const payload = raw.slice(HEADER_SIZE, HEADER_SIZE + chunkSize);
    pm.chunks.set(seqNo, payload);
    pm.totalSize += payload.byteLength;

    // 全チャンク揃ったら再組み立て
    if (pm.chunks.size === pm.totalChunks) {
      const assembled = new ArrayBuffer(pm.totalSize);
      const dst = new Uint8Array(assembled);
      let offset = 0;
      
      for (let i = 0; i < pm.totalChunks; i++) {
        const chunk = new Uint8Array(pm.chunks.get(i)!);
        dst.set(chunk, offset);
        offset += chunk.byteLength;
      }

      this.pending.delete(msgId);
      this.onMessage(assembled);
    }
  }

  private cleanup() {
    const now = Date.now();
    for (const [msgId, pm] of this.pending) {
      if (now - pm.createdAt > REASSEMBLY_TIMEOUT) {
        console.warn(`[ChunkedReceiver] Timeout: msgId=${msgId}, got ${pm.chunks.size}/${pm.totalChunks}`);
        this.pending.delete(msgId);
      }
    }
  }
}
```

### 3.3 WebRTCPeer への統合

```typescript
// WebRTCPeer.ts の変更点

import { ChunkedSender } from './stream/ChunkedSender';
import { ChunkedReceiver } from './stream/ChunkedReceiver';

// コンストラクタ内:
this.chunkedSender = new ChunkedSender();
this.chunkedReceiver = new ChunkedReceiver((assembled) => {
  // 既存の onData コールバックに流す
  this.opts.onData(assembled);
});

// send() の変更:
async send(data: Uint8Array | string): Promise<void> {
  const buf = typeof data === 'string' 
    ? new TextEncoder().encode(data).buffer 
    : data.buffer;
  await this.chunkedSender.send(this.dc!, buf);
}

// DataChannel の onmessage:
this.dc.onmessage = (ev) => {
  if (ev.data instanceof ArrayBuffer) {
    this.chunkedReceiver.receive(ev.data);
  } else if (typeof ev.data === 'string') {
    // 従来の JSON メッセージ
    this.opts.onData(ev.data);
  }
};
```

---

# Part A.5: WS-3.5 Binary Wire Protocol（JSON 膨張の根絶）

## 1. 問題：JSON シリアライズによる 4 倍膨張

現行コードでは **全ての P2P メッセージを `JSON.stringify()` で文字列化** して送信している。
バイナリデータ（暗号文、nonce、署名）は `Array.from(Uint8Array)` で `number[]` に変換されるため、
ワイヤ上のサイズが **約 4 倍** に膨張する。

### 犯行現場（3箇所）

| 場所 | コード | 膨張パターン |
|:-----|:-------|:------------|
| `PacketBuilder.build()` L82-83 | `Array.from(nonce)`, `Array.from(ciphertext)` | `Uint8Array` → `number[]` → JSON |
| `ZoneGossipRouter.flood()` L123-127 | `JSON.stringify` + `{ _type: 'Uint8Array', data: Array.from(value) }` | 型タグ + 数値配列 |
| `DHTMailbox.sendToPeer()` L199-201 | 同上 | 同上 |

### 具体的な膨張例

```
元データ: 暗号文 500 bytes (Uint8Array)

現行 (JSON):
  Array.from() → [145, 23, 7, 255, ...] (number配列)
  JSON.stringify → "[145,23,7,255,...]" 
  = 約 2000 bytes (各数字が1-3文字 + カンマ + 空白)
  さらにラッパー: { "_type": "Uint8Array", "data": [...] }
  = 約 2050 bytes

膨張率: 2050 / 500 = 4.1倍 ❌

バイナリ直送:
  そのまま ArrayBuffer で送信
  = 500 bytes

膨張率: 1.0倍 ✅
```

## 2. 選択肢の比較

| 方式 | サイズ効率 | 依存 | 実装コスト | スキーマ管理 | 下位互換 |
|:-----|:---------:|:----:|:---------:|:-----------:|:--------:|
| **Protocol Buffers** | ★★★ 最小 | `protobufjs` (~150KB) | 大 | `.proto` ファイル必要 | ★★★ |
| **MessagePack** | ★★☆ 小さい | `@msgpack/msgpack` **(既存)** | 小 | 不要（JSON互換） | ★★☆ |
| **カスタムバイナリ** | ★★★ 最小 | なし | 中 | 手動管理 | ★☆☆ |
| 現行 JSON | ★☆☆ 4倍膨張 | なし | — | — | — |

### 判定

> [!IMPORTANT]
> **推奨: MessagePack + バイナリフレーミングのハイブリッド**
>
> - `@msgpack/msgpack` は **すでに依存関係に存在する**（PacketBuilder.ts が使用中）
> - MsgPack は `Uint8Array` をネイティブにバイナリとして扱う（JSON のように展開しない）
> - 制御メッセージ（ping/pong, PEX）: MsgPack 化で十分
> - データメッセージ（gossip, DHT）: MsgPack + チャンク分割
> - protobuf は `.proto` スキーマ管理のオーバーヘッドが P2P 掲示板には過剰

### なぜ protobuf を採用しないか

```
Protobuf の利点が活きる場面:
  ✅ サーバー-クライアント間で異なる言語（Go ↔ JS 等）
  ✅ API のバージョニングが頻繁
  ✅ 大規模チームでスキーマの厳密管理が必要

AETHER の実態:
  ❌ 両端とも同じ TypeScript コードが動く（ブラウザ P2P）
  ❌ スキーマ変更 = コード変更 = 同時デプロイ
  ❌ .proto ファイル + コード生成パイプライン = 不要な複雑性
  ✅ MsgPack なら既存の encode/decode をそのまま使える
```

## 3. Binary Wire Protocol 設計

### 3.1 メッセージタイプ列挙

```typescript
// lib/network/wire/WireTypes.ts

export enum WireType {
  // Control (0x1x)
  JOIN          = 0x10,
  RING_INFO     = 0x11,
  PING          = 0x12,
  PONG          = 0x13,
  LOCAL_LINK_REQ = 0x14,
  LOCAL_LINK_ACK = 0x15,
  LOCAL_LINK_REJ = 0x16,

  // PEX (0x2x)
  PEX_REQUEST   = 0x20,
  PEX_RESPONSE  = 0x21,

  // Signaling Relay (0x3x)
  SDP_RELAY     = 0x30,
  ICE_RELAY     = 0x31,

  // Gossip (0x4x)
  GOSSIP        = 0x40,
  STEM          = 0x41,

  // DHT Mailbox (0x5x)
  DHT_PUT       = 0x50,
  DHT_GET       = 0x51,
  DHT_RES       = 0x52,
}
```

### 3.2 ワイヤフォーマット

```
┌───────────────────────────────────────┐
│  Byte 0: WireType (uint8)            │  ← メッセージ種別
│  Bytes 1+: MsgPack encoded payload   │  ← 本体
└───────────────────────────────────────┘

合計オーバーヘッド: 1 byte のみ

受信側:
  1. 先頭 1 byte で WireType を判定
  2. 残りを MsgPack.decode() でデコード
  3. WireType に応じたハンドラに渡す
```

### 3.3 WireCodec

```typescript
// lib/network/wire/WireCodec.ts

import { encode, decode } from '@msgpack/msgpack';
import { WireType } from './WireTypes';

export class WireCodec {
  /**
   * メッセージをバイナリにエンコード
   * GossipPacket 内の nonce/payload は Uint8Array のまま MsgPack に渡す
   * → MsgPack が bin format (0xc4-0xc6) でそのままバイナリ保存
   * → JSON の 4 倍膨張が完全に消える
   */
  static encode(type: WireType, payload: any): Uint8Array {
    const body = encode(payload); // MsgPack: Uint8Array をバイナリのまま格納
    const frame = new Uint8Array(1 + body.byteLength);
    frame[0] = type;
    frame.set(body, 1);
    return frame;
  }

  /**
   * バイナリフレームをデコード
   */
  static decode(frame: Uint8Array): { type: WireType; payload: any } {
    const type = frame[0] as WireType;
    const payload = decode(frame.subarray(1));
    return { type, payload };
  }
}
```

### 3.4 GossipPacket の変更

```typescript
// 変更前（現行）:
interface GossipPacket {
  packet_id: string;
  hop_count: number;
  pow_nonce: number;
  pow_difficulty: number;
  timestamp: number;
  zone_id: number;
  nonce: number[];      // ❌ Uint8Array を number[] に変換
  payload: number[];    // ❌ 同上
}

// 変更後:
interface GossipPacket {
  packet_id: string;
  hop_count: number;
  pow_nonce: number;
  pow_difficulty: number;
  timestamp: number;
  zone_id: number;
  nonce: Uint8Array;    // ✅ そのまま
  payload: Uint8Array;  // ✅ そのまま
}
```

### 3.5 送信パスの変更

```typescript
// ZoneGossipRouter.flood() の変更

// 変更前:
private flood(packet: GossipPacket, excludePeerId: PeerId) {
  const msg = JSON.stringify({ type: 'gossip', packet }, (_key, value) => {
     if (typeof value === 'bigint') return { _type: 'BigInt', value: value.toString() };
     if (value instanceof Uint8Array) return { _type: 'Uint8Array', data: Array.from(value) };
     return value;
  });
  for (const peer of this.peerManager.peers.values()) {
    if (peer.peerId === excludePeerId) continue;
    if (peer.zones.has(packet.zone_id)) {
      peer.send(msg);  // string 送信
    }
  }
}

// 変更後:
private flood(packet: GossipPacket, excludePeerId: PeerId) {
  const frame = WireCodec.encode(WireType.GOSSIP, packet);
  //                              ↑ 1 byte header
  //                                         ↑ MsgPack: Uint8Array はバイナリのまま
  for (const peer of this.peerManager.peers.values()) {
    if (peer.peerId === excludePeerId) continue;
    if (peer.zones.has(packet.zone_id)) {
      peer.send(frame);  // Uint8Array 送信 → DataChannel の binaryType: 'arraybuffer'
    }
  }
}
```

## 4. サイズ比較（実測予想）

```
ゴシップパケット（暗号文 500B の投稿）:

  現行 JSON:
    {"type":"gossip","packet":{"packet_id":"abc...",
    "nonce":[145,23,...24個],"payload":[23,55,...500個], ...}}
    ≈ 2,800 bytes

  MsgPack + WireCodec:
    [0x40] + msgpack({ packet_id: "abc...", nonce: <24B binary>,
                       payload: <500B binary>, ... })
    ≈ 620 bytes

  削減率: 78% (2800 → 620)

DHT 同期応答（100レス分、各500B暗号文）:

  現行 JSON: ≈ 280,000 bytes (280KB) → SafariでDataChannel破壊
  MsgPack:   ≈ 62,000 bytes (62KB)  → チャンク分割で安全に送信
  
  削減率: 78%
```

## 5. 移行戦略

```
Phase 1: WireCodec + WireTypes を実装
Phase 2: GossipPacket の nonce/payload を Uint8Array に変更
Phase 3: ZoneGossipRouter.flood() を WireCodec.encode() に差し替え
Phase 4: DHTMailbox.sendToPeer() を WireCodec.encode() に差し替え
Phase 5: PeerManager.handleData() を WireCodec.decode() に差し替え
Phase 6: PacketBuilder.build() の Array.from() を削除
Phase 7: 受信側 JSON.parse() の _type: 'Uint8Array' ハックを削除
Phase 8: ChunkedSender/Receiver と統合テスト
```

---

# Part B: WS-4 NAT Traversal 戦略

## 1. 方針

```
TURN = 絶対不使用
STUN = v4/v6 両対応で使用（NAT タイプ検出 + Server Reflexive 候補取得）
v6   = NAT がないため直接接続。モバイルの主戦場
v4   = STUN で NAT 超えを試みる。Symmetric NAT なら諦めて v6 へ
```

## 2. NAT タイプ検出

### 2.1 StrandDetector

```typescript
// lib/network/StrandDetector.ts

export type StrandType = 'alpha' | 'beta' | 'bridge';

export interface StrandInfo {
  type: StrandType;
  hasV4: boolean;
  hasV6: boolean;
  natType: 'full-cone' | 'restricted' | 'port-restricted' | 'symmetric' | 'unknown';
  v4Reachable: boolean; // STUN で Server Reflexive 取れたか
  v6Reachable: boolean;
}

export async function detectStrand(): Promise<StrandInfo> {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },       // v4
      { urls: 'stun:stun.nextcloud.com:443' },         // v4/v6
    ]
  });

  const candidates: RTCIceCandidate[] = [];
  
  return new Promise((resolve) => {
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        candidates.push(ev.candidate);
      } else {
        // ICE gathering 完了
        pc.close();
        resolve(analyzeCandidate(candidates));
      }
    };

    // ダミーの DataChannel を作成して ICE 収集を開始
    pc.createDataChannel('probe');
    pc.createOffer().then(o => pc.setLocalDescription(o));
    
    // タイムアウト
    setTimeout(() => {
      pc.close();
      resolve(analyzeCandidate(candidates));
    }, 5000);
  });
}

function analyzeCandidate(candidates: RTCIceCandidate[]): StrandInfo {
  let hasV4Host = false, hasV6Host = false;
  let hasV4Srflx = false, hasV6Srflx = false;

  for (const c of candidates) {
    if (!c.address) continue;
    const isV6 = c.address.includes(':');
    const isV4 = !isV6;

    if (c.type === 'host') {
      if (isV4) hasV4Host = true;
      if (isV6) hasV6Host = true;
    }
    if (c.type === 'srflx') {
      if (isV4) hasV4Srflx = true;
      if (isV6) hasV6Srflx = true;
    }
  }

  const hasV4 = hasV4Host || hasV4Srflx;
  const hasV6 = hasV6Host || hasV6Srflx;
  
  let type: StrandType;
  if (hasV4 && hasV6) type = 'bridge';
  else if (hasV4)     type = 'alpha';
  else                type = 'beta';

  return {
    type,
    hasV4, hasV6,
    natType: detectNatType(candidates),
    v4Reachable: hasV4Srflx,
    v6Reachable: hasV6Srflx || hasV6Host, // v6 は Host だけで直接到達可能
  };
}
```

### 2.2 NAT タイプ判定ロジック

```typescript
function detectNatType(candidates: RTCIceCandidate[]): StrandInfo['natType'] {
  const srflx = candidates.filter(c => c.type === 'srflx' && !c.address?.includes(':'));
  
  if (srflx.length === 0) return 'unknown';
  if (srflx.length === 1) return 'unknown'; // 1つのSTUNだけでは判定困難
  
  // 異なる STUN サーバーからの srflx を比較
  // 同じ mapped address → Full Cone or Restricted
  // 異なる mapped address → Symmetric NAT
  const addresses = new Set(srflx.map(c => c.address));
  
  if (addresses.size === 1) return 'full-cone'; // 簡易判定
  return 'symmetric'; // 異なるアドレスが返ってきた → Symmetric
}
```

## 3. ICE 戦略

### 3.1 v6 優先 ICE 候補設定

```typescript
// WebRTCPeer.ts の ICE 設定変更

function createPeerConnection(strandInfo: StrandInfo): RTCPeerConnection {
  const config: RTCConfiguration = {
    iceServers: [
      // v6 対応 STUN (優先)
      { urls: 'stun:stun.nextcloud.com:443' },
      // v4 STUN
      { urls: 'stun:stun.l.google.com:19302' },
    ],
    // v6を優先する候補ポリシー
    iceCandidatePoolSize: 4,
  };

  // Symmetric NAT 検出済みの場合、v4 候補を除外
  if (strandInfo.natType === 'symmetric' && strandInfo.hasV6) {
    // v4 候補をフィルタリング
    // → 自然と v6 候補のみで ICE ネゴシエーション
  }

  return new RTCPeerConnection(config);
}
```

### 3.2 ICE 候補フィルタリング

```typescript
// 不要な ICE 候補をフィルタリングして高速化

pc.onicecandidate = (ev) => {
  if (!ev.candidate) return;
  
  const addr = ev.candidate.address;
  if (!addr) return;

  // Symmetric NAT の v4 Host 候補は無駄 → 除外
  if (strandInfo.natType === 'symmetric' && !addr.includes(':') && ev.candidate.type === 'host') {
    return; // 送信しない
  }

  // リンクローカル IPv6 (fe80::) は除外
  if (addr.startsWith('fe80:')) {
    return;
  }

  // 有効な候補のみ相手に送信
  sendCandidate(ev.candidate);
};
```

## 4. モバイルネットワーク切替

### 4.1 検出

```typescript
// lib/network/MobileNetworkMonitor.ts

export class MobileNetworkMonitor {
  private currentType: StrandType;
  private onChange: (newType: StrandType) => void;

  constructor(initialType: StrandType, onChange: (t: StrandType) => void) {
    this.currentType = initialType;
    this.onChange = onChange;

    // Network Information API（対応ブラウザ）
    if ('connection' in navigator) {
      (navigator as any).connection.addEventListener('change', () => {
        this.redetect();
      });
    }

    // フォールバック: 全接続断を検出
    // PeerManager から 'all-peers-disconnected' イベントを受け取る
  }

  private async redetect() {
    const newInfo = await detectStrand();
    
    if (newInfo.type !== this.currentType) {
      console.log(`[MobileNetworkMonitor] Strand changed: ${this.currentType} → ${newInfo.type}`);
      this.currentType = newInfo.type;
      this.onChange(newInfo.type);
    }
  }
}
```

### 4.2 Strand Migration フロー

```
検出: Wi-Fi (v4) → セルラー (v6)
  1. MobileNetworkMonitor が strandType 変更を検出
  2. PeerManager に StrandMigration を通知
  3. PeerManager:
     a. 旧 Strand (α) の接続 → タイムアウトで自然消滅を待つ
     b. TrackerServer に再接続（新 strandType = beta を通知）
     c. 新 Strand (β) のローカル隣人を発見・接続
     d. position は維持（変更しない）
  4. SyncProtocol で不足データを補完
```

## 5. STUN サーバー選定基準

| サーバー | v4 | v6 | 備考 |
|:---------|:--:|:--:|:-----|
| stun.l.google.com:19302 | ✅ | ❌ | 最も安定だが v4 のみ |
| stun.nextcloud.com:443 | ✅ | ✅ | Dual-stack |
| stun.cloudflare.com:3478 | ✅ | ✅ | Dual-stack |
| stun.stunprotocol.org:3478 | ✅ | ❓ | 可用性やや不安 |

> [!IMPORTANT]
> v6 対応の STUN サーバーを最低 2 つは設定する。
> Symmetric NAT 判定には「異なる STUN サーバーからの srflx 比較」が必要。

---

## 統合チェックリスト

### WS-3: DataChannel Stream
- [ ] チャンクプロトコルのヘッダ構造確定
- [ ] ChunkedSender 実装
- [ ] ChunkedReceiver 実装（タイムアウト・エラー処理含む）
- [ ] WebRTCPeer への統合（send / onData 差し替え）
- [ ] バックプレッシャー制御（bufferedAmount 監視）
- [ ] 小メッセージ（4KB以下）のバイパス最適化
- [ ] Safari iOS / Android Chrome での動作検証

### WS-3.5: Binary Wire Protocol
- [ ] WireTypes enum 定義（メッセージタイプ列挙）
- [ ] WireCodec 実装（MsgPack ベースの encode/decode）
- [ ] GossipPacket 型定義変更（`number[]` → `Uint8Array`）
- [ ] PacketBuilder.build() から `Array.from()` を削除
- [ ] ZoneGossipRouter.flood() を WireCodec に差し替え
- [ ] DandelionRouter の送信パスを WireCodec に差し替え
- [ ] DHTMailbox.sendToPeer() を WireCodec に差し替え
- [ ] PeerManager.handleData() の受信パスを WireCodec.decode() に統一
- [ ] 全ファイルから JSON.parse + `_type: 'Uint8Array'` ハックを削除
- [ ] 帯域削減の実測検証（78% 削減目標）

### WS-4: NAT Traversal
- [ ] StrandDetector 実装（ICE 候補分析）
- [ ] NAT タイプ判定ロジック
- [ ] v6 優先 ICE 候補設定
- [ ] Symmetric NAT 検出時の v4 候補除外
- [ ] MobileNetworkMonitor 実装
- [ ] Strand Migration フロー（PeerManager 連携）
- [ ] STUN サーバーリストの選定・検証
