# AETHER Web-Lite 全ファイル完全実装リファレンス・パラメータ台帳

> **対象リポジトリ**: `aether-web-lite/web`
> **最終更新**: 2026-10-11
> **目的**: WebLite の全 TypeScript ソースファイル（64ファイル）の役割、内部ロジック、アルゴリズム、定数パラメータ、依存関係を完全網羅し、今後の改修・保守・アーキテクチャ拡張（Electron 移行、逆経路 GET、大容量ファイル共有等）における決定打となる恒久設計仕様台帳。

---

## 目次

1. [全体アーキテクチャ俯瞰図](#1-全体アーキテクチャ俯瞰図)
2. [モジュール別・全ファイル完全解説](#2-モジュール別全ファイル完全解説)
   - [カテゴリ 1: コア設定・型定義・共通基盤](#カテゴリ-1-コア設定型定義共通基盤)
   - [カテゴリ 2: 暗号・身元・PoW 層](#カテゴリ-2-暗号身元pow-層)
   - [カテゴリ 3: ワイヤ形式・バイナリコーデック層](#カテゴリ-3-ワイヤ形式バイナリコーデック層)
   - [カテゴリ 4: P2P 接続・トポロジ・シグナリング層](#カテゴリ-4-p2p-接続トポロジシグナリング層)
   - [カテゴリ 5: Gossip・Dandelion++・検証層](#カテゴリ-5-gossipdandelion検証層)
   - [カテゴリ 6: Schrödinger Mailbox・Hint・匿名保管層](#カテゴリ-6-schrödinger-mailboxhint匿名保管層)
   - [カテゴリ 7: ローカル永続化・秘密鍵封印層](#カテゴリ-7-ローカル永続化秘密鍵封印層)
   - [カテゴリ 8: オーケストレーション・DAG・掲示板ロジック層](#カテゴリ-8-オーケストレーションdag掲示板ロジック層)
   - [カテゴリ 9: サーバー・プロバイダー・フック・UI 層](#カテゴリ-9-サーバープロバイダーフックui-層)
3. [システム全域パラメータ・定数総覧](#3-システム全域パラメータ定数総覧)
4. [WireType 一覧 & メッセージフロー対応表](#4-wiretype-一覧--メッセージフロー対応表)

---

## 1. 全体アーキテクチャ俯瞰図

```
[UI 層 (Next.js / React)]
  page.tsx ──▶ BoardView / ThreadView ──▶ useBoard / useThread
                     │
[オーケストレーション層]
  BoardOrchestrator / ThreadOrchestrator ──▶ ThreadDAGManager / ThreadRanker
         │                                       │
         ├───────────────────────────────────────┴───────────────┐
         ▼                                                       ▼
[匿名保管・ルーティング層]                                  [ゴシップ拡散層]
  SchrodingerMailbox (ランダム SlotKey)                      ZoneGossipRouter
    ├── HintRouter (Broadcast Veil 試行復号)                  ├── DandelionRouter (Stem/Fluff)
    ├── HintRelease (時間差相関の遮断)                        ├── PacketValidator (CHK / PoW)
    └── DHTMailbox (K-nearest DHT 保管)                      └── SeenCache (TTL 重複排除)
         │                                                       │
         └───────────────────────────┬───────────────────────────┘
                                     ▼
[P2P メッシュ・トポロジ層]
  PeerManager ──▶ WebRTCPeer (DataChannel / ChunkedStream)
    ├── RingMaintainer (ローカル 4 本 + ロングレンジ 12 本 / リング座標 [0, 1))
    ├── ZoneManager (Adaptive Zone / K=16 匿名購読)
    ├── PEXHandler (ピア交換 / SDP・ICE リレー)
    └── RateLimiter (隣人別トークンバケット)
         │
         ├──▶ SignalingClient ──(初期 15 秒のみ)──▶ TrackerServer (相乗り WebSocket)
         └──▶ IndexedDBStore / SecretVault (Argon2id 秘密鍵封印)
```

---

## 2. モジュール別・全ファイル完全解説

---

### カテゴリ 1: コア設定・型定義・共通基盤

#### 1. [`web/src/lib/constants.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/constants.ts)
- **役割**: システム全域で共有する物理定数、ネットワーク接続上限、タイマー、トポロジ制約を一元定義。
- **主要定数**:
  - `RING_MESH.LOCAL_LINKS = 4`: 左2 + 右2 のリング維持隣接リンク数。
  - `RING_MESH.LONG_RANGE_LINKS = 12`: 対角方向の小世界（Small-World）ショートカット最大数。
  - `RING_MESH.MAX_DEGREE = 16`: 1 ノードあたりの WebRTC 接続上限。ブラウザ負荷のハードリミット。
  - `RING_MESH.RING_SIZE = 1.0`: 円環座標空間 $[0, 1)$。
  - `RING_MESH.LONG_RANGE_MIN_DISTANCE = 0.2`: ショートカット候補とみなす最小円環距離。
  - `RING_MESH.HEARTBEAT_INTERVAL = 15_000` (15秒): Ping 間隔。
  - `RING_MESH.HEARTBEAT_TIMEOUT = 45_000` (45秒): 無応答時のピア切断閾値。
  - `RING_MESH_ZONE.MAX_DEPTH = 12`: ゾーン分割の最大深度（$2^{12} = 4096$ ゾーン）。
  - `RING_MESH_ZONE.TARGET_ZONE_POP = 500`: 1 ゾーンあたりの目標ノード人口。
  - `RING_MESH_ZONE.SUBSCRIBE_COUNT = 16`: 常時購読するゾーン数（真のゾーン 1 ＋ ダミー 15）。
  - `TRACKER.URL`: WebSocket シグナリング接続先（同一ポート相乗り `/ws`）。

#### 2. [`web/src/lib/types.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/types.ts)
- **役割**: ノード主張、パケット、ワイヤメッセージ、インターフェース群の根本型定義。
- **主要型**:
  - `PeerId = string`: 32 文字の Hex 文字列（公開鍵ハッシュ先頭 16 バイト）。
  - `WireNodeClaim`: トラッカー/隣人に提示する Bound Identity（peerId, pubkey, powCounter）。
  - `GossipPacket`: `packet_id`, `hop_count`, `pow_nonce`, `pow_difficulty`, `timestamp`, `zone_id`, `nonce`, `payload`。
  - `StemPacket`: Dandelion++ の Stem フェーズパケット。ホップカウンタ（`stemTtl`）は発信元特定オラクルになるため意図的に排除。
  - `P2PMessage`: DataChannel 越しに流れるメッセージの Union 型（HELLO, JOIN, PING, PEX, SDP_RELAY, GOSSIP, DHT_*）。
  - `IPeerConnection`, `IPeerManager`, `IMailbox`, `ICryptoEngine`, `IPoWEngine`, `IKeyManager`, `IZoneManager`: レイヤ間結合を疎にするための抽象インターフェース。

#### 3. [`web/src/lib/common/CryptoUtils.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/common/CryptoUtils.ts)
- **役割**: 乱数 ID 生成および暗号論的セキュアなバイト列生成ユーティリティ。
- **主要メソッド**:
  - `generateId(length = 10): string`: Math.random 由来の一時リクエスト ID 生成。
  - `randomBytes(length: number): Uint8Array`: `crypto.getRandomValues` によるセキュア乱数取得。

#### 4. [`web/src/lib/common/Encoding.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/common/Encoding.ts)
- **役割**: バイト列と文字列（Hex / Base64URL）の相互変換。
- **主要メソッド**:
  - `toHex(bytes: Uint8Array): string`: 2文字パディング Hex 変換。
  - `fromHex(hex: string): Uint8Array`: Hex 文字列のパース。
  - `toBase64(bytes: Uint8Array): string`: Base64URL（`+`→`-`, `/`→`_`, パディング除去）エンコード。
  - `fromBase64(b64: string): Uint8Array`: Base64URL デコード。

#### 5. [`web/src/lib/common/JsonBinary.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/common/JsonBinary.ts)
- **役割**: JSON シリアライズ時に `Uint8Array` および `BigInt` を透過的に変換・復元するシリアライザ。
- **主要メソッド**:
  - `replacer(_key, value)`: `Uint8Array` を `{ _type: 'Uint8Array', data: [...] }`、`BigInt` を `{ _type: 'BigInt', value: '...' }` に変換。
  - `reviver(_key, value)`: 上記タグを検出して元の型へ復元。
  - `stringify(obj)`, `parse(json)`: 上記 replacer/reviver を組み込んだ JSON 処理。

#### 6. [`web/src/lib/common/Logger.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/common/Logger.ts)
- **役割**: スコープ付き階層レベル制御ロガー。経路情報漏洩の防止とホットパスの文字列構築オーバーヘッド排除。
- **設計特性**:
  - スコープ階層: `net.gossip` は `net` や `*` のレベルを継承。
  - 遅延評価: `log.trace(() => ...)` により、レベル未到達時は文字列組み立て関数を実行しない。
  - ログレベル: `SILENT(0)`, `ERROR(1)`, `WARN(2)`, `INFO(3)`, `DEBUG(4)`, `TRACE(5)`。
  - 動的切り替え: ブラウザコンソールから `aetherLog.set('net.gossip', 'trace')` で localStorage に永続化して即時反映。

---

### カテゴリ 2: 暗号・身元・PoW 層

#### 7. [`web/src/lib/crypto/sodium.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/crypto/sodium.ts)
- **役割**: `libsodium-wrappers-sumo`（WASM）の初期化とシングルトン提供。
- **内部動作**: `sodium.ready` プロミスをエクスポートし、全暗号処理の実行前に WASM ランタイムのロードを保証。

#### 8. [`web/src/lib/crypto/NodeIdentity.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/crypto/NodeIdentity.ts)
- **役割**: Bound Identity（身元と座標の暗号学的束縛）の実装。Eclipse 攻撃および位置グラインディング攻撃を遮断。
- **数学的仕様**:
  - `peerId = SHA256("AETHER/v3/peerid" ‖ pubkey)[0..16]` (Hex 32文字)。
  - `position = SHA256("AETHER/v3/position" ‖ peerId)[0..8] / 2^64` (純粋関数)。
  - 座標は自己申告させず、受信ノードが相手の peerId から直接算出。
- **NodeId PoW (Argon2id)**:
  - 鍵グラインド攻撃を防止するため、Ed25519 鍵生成時に Argon2id による PoW を課す。
  - パラメータ `NODE_ID_POW`: `opsLimit = 3`, `memLimit = 32MB`, `difficulty = 8`。
  - プリイメージ: `"AETHER/v3/nodeid_pow" ‖ pubkey ‖ u64be(counter)`。
  - `signClaim(challenge)`: 接続相手のチャレンジに Ed25519 で署名し、所有証明（Proof of Possession）を生成。

#### 9. [`web/src/lib/crypto/NodeIdentityStore.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/crypto/NodeIdentityStore.ts)
- **役割**: 採掘に数秒を要する `NodeIdentity` の永続化と復元。
- **内部動作**: 秘密鍵を生でディスクに置かず、[`SecretVault`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/storage/SecretVault.ts) を介して Argon2id + XSalsa20-Poly1305 で封印して保存。次回起動時は採掘をスキップして即復元。

#### 10. [`web/src/lib/crypto/Identity.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/crypto/Identity.ts)
- **役割**: ユーザーの投稿用身元管理。エフェメラルなセッション鍵と、永続的なトリップ鍵を分離管理。
- **内部構造**:
  - `sessionKeyPair`: タブごとに生成される使い捨て Ed25519 鍵ペア。
  - `tripKeyPair`: トリップパスフレーズから導出、または封印ストアから復元される永続署名鍵。
  - `sign(message)`: セッション鍵で常時署名し、トリップ有効時はトリップ鍵でも二重署名。

#### 11. [`web/src/lib/crypto/KeyManager.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/crypto/KeyManager.ts)
- **役割**: 階層的鍵導出（KDF: Key Derivation Function）。
- **数式仕様**:
  - `threadKey = HMAC-SHA256(boardKey, "thread:" ‖ threadId)` (32バイト)。
  - `topicHash = SHA256(threadKey)[0..32]`。
  - `computeZoneId(topicHash, depth)`: topicHash の先頭 16 ビットから深度 `depth` に応じたプレフィックスビットを抽出。

#### 12. [`web/src/lib/crypto/CryptoEngine.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/crypto/CryptoEngine.ts)
- **役割**: ペイロード本体の共通鍵暗号化・復号。
- **アルゴリズム**: ChaCha20-Poly1305 (IETF)。24 バイト乱数 nonce（`crypto_aead_chacha20poly1305_ietf_encrypt`）による AEAD 封印。改ざん検知（INT-CTXT）を保証。

#### 13. [`web/src/lib/crypto/DifficultyEstimator.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/crypto/DifficultyEstimator.ts)
- **役割**: ネットワークの投稿熱量に応じた Gossip パケット PoW 難易度の動的調整。
- **パラメータ & ロジック**:
  - `WINDOW = 100`: 直近 100 件のタイムスタンプを参照。
  - `TARGET_INTERVAL = 3000` (3秒/件)。
  - `BASE_DIFFICULTY = 12` (~0.5秒)、`MIN_DIFFICULTY = 8` (~0.1秒)、`MAX_DIFFICULTY = 24` (~30秒)。
  - 数式: $D = \operatorname{clamp}\left(\operatorname{round}\left(D_{base} + \log_2 \frac{\text{TARGET\_INTERVAL}}{\Delta t_{actual}}\right), 8, 24\right)$。
  - 投稿が集中するほど自動的に計算コストが跳ね上がり、ボットのフラッドを物理的計算量で減速させる。

#### 14. [`web/src/lib/crypto/PoWEngine.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/crypto/PoWEngine.ts)
- **役割**: Gossip パケットの SHA-256 PoW 探索・検証エンジン。
- **設計思想**:
  - 検証（`verify`）: メインスレッドで同期実行（SHA-256 1回 ≒ 1.3μs）。受信ホットパスのブロックを完全排除。
  - 探索（`compute`）: UI をブロックさせないため、WebWorker（`WorkerBridge`）にバックグラウンド委譲。

#### 15. [`web/src/lib/crypto/PowPolicy.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/crypto/PowPolicy.ts)
- **役割**: PoW のコミット対象ヘッダと難易度検証ルールの固定化。
- **プリイメージ設計**:
  - `preimage = "AETHER/v3/pow____"(16) ‖ u64be(timestamp) ‖ u16be(zone_id) ‖ u8(pow_difficulty) ‖ nonce(24) ‖ payload`。
  - `packet_id = SHA256(preimage)` (Hex 64文字)。
  - `powHash = SHA256(preimage ‖ u64be(pow_nonce))`。
  - 可変な `hop_count` は意図的に除外し、それ以外の全ヘッダを SHA-256 にコミット。タイムスタンプ改ざんによるリプレイ攻撃を防止。
  - `meetsDifficulty(hash, difficulty)`: ビットレベルで先頭連続ゼロ数を判定。

#### 16. [`web/src/lib/crypto/MagicFilter.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/crypto/MagicFilter.ts)
- **役割**: Broadcast Veil 用の超高速部分復号スクリーニング。
- **アルゴリズム**:
  - 平文の先頭 4 バイトにマジック定数 `0x41455448` ("AETH") を埋め込む。
  - ChaCha20-Poly1305 IETF において、平文暗号化ブロックは初期カウンタ `ic = 1` から開始する性質を利用し、キーストリームの先頭 4 バイトのみを生成して XOR 判定。
  - AEAD のタグ検証（Poly1305）を走らせることなく、他スレッドのパケットを数マイクロ秒で破棄。

#### 17. [`web/src/lib/crypto/PacketBuilder.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/crypto/PacketBuilder.ts)
- **役割**: 掲示板投稿の多重カプセル化と、受信パケットの多重検証・復号。
- **3層ビルド手順**:
  1. Inner: 本文、DAG 親ノード、累積 PoW、タイムスタンプ、トリップ署名を MessagePack 符号化。
  2. Crypto: "AETH" マジックを前置し、ChaCha20-Poly1305 で暗号化。
  3. Outer: PoW コミットヘッダを組み立て、PoW 探索を完了させて `GossipPacket` を出力。
- **検証手順**:
  `MagicFilter.quickCheck` ──▶ `cryptoEngine.decrypt` ──▶ Ed25519 署名検証 ──▶ MessagePack デコード。

#### 18. [`web/src/lib/worker/WorkerBridge.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/worker/WorkerBridge.ts)
- **役割**: メインスレッドと WebWorker 間の非同期 RPC ブリッジ。
- **機能**: WebWorker が未サポートの環境ではメインスレッドの同期実行へフォールバック。進行状況（ハッシュ試行回数）をコールバックで UI にストリーミング通知。

#### 19. [`web/src/lib/worker/pow.worker.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/worker/pow.worker.ts)
- **役割**: PoW 探索専用の WebWorker スクリプト。メインスレッドから渡されたプリイメージに対し、ループ内で `pow_nonce` をインクリメントしながら SHA-256 を探索。

---

### カテゴリ 3: ワイヤ形式・バイナリコーデック層

#### 20. [`web/src/lib/network/wire/WireTypes.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/wire/WireTypes.ts)
- **役割**: ネットワーク上の 1 バイトパケット識別子（タグ）の列挙。
- **タグ一覧**:
  - `0x10` JOIN / `0x11` RING_INFO / `0x12` PING / `0x13` PONG / `0x17` HELLO
  - `0x20` PEX_REQUEST / `0x21` PEX_RESPONSE
  - `0x30` SDP_RELAY / `0x31` ICE_RELAY
  - `0x40` GOSSIP / `0x41` STEM / `0x42` HINT / `0x43` HINT_STEM
  - `0x50` DHT_PUT / `0x51` DHT_GET / `0x52` DHT_RES / `0x53` DHT_PUT_STEM

#### 21. [`web/src/lib/network/wire/WireCodec.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/wire/WireCodec.ts)
- **役割**: バイナリワイヤフレームのエンコード・デコード。
- **ワイヤ構造**:
  - `[WireType (1 byte)][MessagePack Payload (N bytes)]`。
  - Rust 側（`aether-cache`）の serde internally tagged enum 互換を保つため、MessagePack ペイロード内に `{"type": "タグ文字列"}` を自動注入。
  - 受信時は先頭 1 バイトから `KNOWN_WIRE_TYPES` を検証し、未知の型は例外で遮断。

#### 22. [`web/src/lib/network/stream/ChunkedSender.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/stream/ChunkedSender.ts)
- **役割**: WebRTC DataChannel のバッファ溢れ（SCTP バッファドロップ）を防ぐパケット分割送信器。
- **仕様**:
  - `CHUNK_SIZE = 4096`: 4KB 単位に分割。
  - `HEADER_SIZE = 12`: `[flags 1B][msgId 4B][seq 2B][totalChunks 2B][payloadLen 2B][isLast 1B]`。
  - `MAX_BUFFERED = 64KB`: `dc.bufferedAmount` が 64KB を超えた場合、10ms 待機するバックプレッシャー制御。

#### 23. [`web/src/lib/network/stream/ChunkedReceiver.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/stream/ChunkedReceiver.ts)
- **役割**: 分割受信されたチャンクの再組み立て器。
- **セキュリティ防御**:
  - `MAX_MESSAGE_BYTES = 1MB`: 1 メッセージあたりの上限。
  - `MAX_PENDING_MESSAGES = 64`: 同時再組み立てメッセージ数の上限。
  - `REASSEMBLY_TIMEOUT = 10_000` (10秒): 未完了チャンクのメモリリークをタイマーで定期破棄。隣人ノードによるメモリ枯渇 DoS を防止。

---

### カテゴリ 4: P2P 接続・トポロジ・シグナリング層

#### 24. [`web/src/lib/network/WebRTCPeer.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/WebRTCPeer.ts)
- **役割**: 単一の対向ノードに対する WebRTC（RTCPeerConnection + RTCDataChannel）の接続ライフサイクル管理。
- **仕様**:
  - STUN: Google 公開 STUN（`stun.l.google.com:19302` 等）。
  - DataChannel: ラベル `'aether'`, `ordered: true`。
  - ハンドシェイク: 接続開通直後にランダムチャレンジを生成・送信し、相手からの署名付き JOIN を待機。
  - チャンク化ストリーム: `ChunkedSender` / `ChunkedReceiver` を介して送受信。

#### 25. [`web/src/lib/network/PeerManager.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/PeerManager.ts)
- **役割**: ネットワーク全体のピア管理、ハンドシェイク検証、シグナリング離脱制御の中枢。
- **主要ロジック**:
  - **トラッカー切断**: 接続開始 15 秒後に `this.signaling.disconnect()` を実行し、完全自律分散モードへ移行。
  - **P2P シグナリングリレー**: 未知ピアとの SDP/ICE 交換を、既存ピア経由で `WireType.SDP_RELAY` / `WireType.ICE_RELAY` で中継。
  - **JOIN 検証 (Eclipse 対策)**:
    1. 主張された peerId が接続先 ID と一致するか。
    2. `peerId == SHA256(pubkey)[0..16]`。
    3. NodeId PoW（Argon2id）を満たしているか。
    4. 自分が送ったチャレンジに対する Ed25519 署名が一致するか。

#### 26. [`web/src/lib/network/RingPosition.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/RingPosition.ts)
- **役割**: リング空間 $[0, 1)$ における純粋関数計算ユーティリティ。
- **数式**:
  - `forPeer(peerId)`: `SHA256("AETHER/v3/position" ‖ peerId)[0..8] / 2^64`。
  - `distance(posA, posB)`: $\min(|A - B|, 1.0 - |A - B|)$。円環上の最短距離。

#### 27. [`web/src/lib/network/RingMaintainer.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/RingMaintainer.ts)
- **役割**: トポロジの自律修復（Kleinberg の小世界ネットワーク構築）。
- **ロジック**:
  - 10 秒周期（`REPAIR_CHECK_INTERVAL`）で全ピアの座標距離を評価。
  - ローカルリンク（時計回り・反時計回りの最近傍 2 ノードずつ計 4 ノード）を最優先で維持。
  - 接続に余裕がある場合、距離 0.2 以上の遠隔ノードをロングレンジリンク（最大 12 ノード）として PEX 経由で探索・接続。

#### 28. [`web/src/lib/network/ZoneManager.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/ZoneManager.ts)
- **役割**: Adaptive Zone の自律深度合意と、K=16 の匿名購読セット維持。
- **ロジック**:
  - 密度推定: 隣人ノードとの平均リング距離から全体人口 $\hat{N} \approx 1 / (2 \times \text{avgDist})$ を推定（最小ピア数 8）。
  - 深度決定: 目標人口 500 ノードに基づき $D = \log_2(\hat{N} / 500)$ を算出。
  - ヒステリシス制御: 深度の上昇は即時反映。下降は 5 分間の安定待機タイマーを経て 1 段階ずつ引き下げ（振動防止）。
  - `isSubscribed(zoneId)`: 全ゾーン数が 16 以下の小規模時は無条件 true（Broadcast Veil）。分割時は真のゾーン 1 つ＋ランダム 15 ゾーンの計 16 ゾーンを判定。

#### 29. [`web/src/lib/network/PEXHandler.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/PEXHandler.ts)
- **役割**: トラッカー非依存のピア交換（PEX）プロトコル。
- **仕様**:
  - `MAX_PEX_ENTRIES = 8`: 1 回のレスポンスで返すピア数を最大 8 件に制限。
  - 購読ゾーンや座標は載せず、Bound Identity（hex 32文字の peerId）のみを交換。

#### 30. [`web/src/lib/network/SignalingClient.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/SignalingClient.ts)
- **役割**: 初期ブートストラップ用 WebSocket クライアント。
- **仕様**: 接続時に `WireNodeClaim`（peerId, pubkey, powCounter）を提出。トラッカーから初期ピアリストを受信し、初期オファーの `relay` を仲介。

#### 31. [`web/src/lib/network/MessageDispatcher.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/MessageDispatcher.ts)
- **役割**: WireType ごとの受信ハンドラ登録・配信ルーター（ホットパス）。

#### 32. [`web/src/lib/network/Heartbeat.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/Heartbeat.ts)
- **役割**: 15 秒周期の Ping/Pong による死活監視と RTT（往復遅延）計測。

#### 33. [`web/src/lib/network/RateLimiter.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/RateLimiter.ts)
- **役割**: 隣人ピアごとのトークンバケット式受信レートリミッタ。
- **定数設定**:
  - `gossip`: 20 件/秒、バースト 60。
  - `dhtPut`: 5 件/秒、バースト 30。
  - `pex`: 2 件/秒、バースト 10。
  - `signaling`: 5 件/秒、バースト 15。
  - 攻撃者のハッシュ能力に関わらず、接続次数 $d \times R$ で受信パケット総量を構造的に頭打ちにする。

---

### カテゴリ 5: Gossip・Dandelion++・検証層

#### 34. [`web/src/lib/network/gossip/ZoneGossipRouter.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/gossip/ZoneGossipRouter.ts)
- **役割**: Gossip プロトコルの配送中枢。
- **仕様**:
  - 購読宣言の撤去: 中継（フラッディング）は隣人ピア全員へ無条件に行う。ゾーン判定は「自分の UI に渡すか」のローカル判定にのみ使用。
  - 重複排除: `SeenCache` による転送ループ遮断。

#### 35. [`web/src/lib/network/gossip/DandelionRouter.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/gossip/DandelionRouter.ts)
- **役割**: Dandelion++ による発信元秘匿ルーティング。
- **仕様**:
  - `FLUFF_PROBABILITY = 0.3`: 各ホップで 30% の確率で Fluff（全域拡散）へ移行。平均経路長は 3.33 ホップ。
  - ホップカウンタ廃止: 経路長は幾何分布（無記憶性）に従い、中継者は自分が何番目かを特定不能。
  - `EPOCH_DURATION = 10分`: 同一 Stem 転送先を 10 分間維持。
  - `jitteredEchoTimeout()`: 再送エコー待ち時間（5000ms）に $\pm 20\%$ のジッターをかけ、作者特有の周期フィンガープリントを破壊。
  - 汎用化 API: `publishVia` / `decideStem` により、Gossip だけでなく `HINT_STEM` や `DHT_PUT_STEM` も同一インスタンスでルーティング。

#### 36. [`web/src/lib/network/gossip/PacketValidator.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/gossip/PacketValidator.ts)
- **役割**: パケットの形式、暗号、PoW、タイムスタンプ検証。
- **ルール**:
  - `MAX_PAYLOAD_SIZE = 2048` (2KB)。
  - `MAX_HOP_COUNT = 32`。
  - `MAX_TIME_DRIFT = 15分`: 未来/過去に 15 分以上ずれたパケットを破棄。
  - `MIN_DIFFICULTY = 8`。
  - `packet_id == SHA256(preimage)` の整合性検証。

#### 37. [`web/src/lib/network/gossip/SeenCache.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/gossip/SeenCache.ts)
- **役割**: パケット ID の重複排除キャッシュ。
- **仕様**:
  - `MAX_SIZE = 50,000` 件。メモリ消費は約 1.6MB。
  - `TTL_MS = 15分`: 15 分経過したエントリを 5 分周期でパージ。

---

### カテゴリ 6: Schrödinger Mailbox・Hint・匿名保管層

#### 38. [`web/src/lib/network/hint/HintPacket.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/hint/HintPacket.ts)
- **役割**: 索引配布用パケットのワイヤ形式・PoW・識別子計算。
- **ワイヤ形式**:
  - `[version 1B (1)][blind_tag 4B][hint_nonce 12B][ciphertext 60B (固定長)][ttl 1B][pow_nonce 8B]`。合計 86 バイト。
- **識別子**:
  - `preimage = "AETHER/v3/hint__"(16) ‖ version ‖ blind_tag ‖ hint_nonce ‖ u32be(len) ‖ ciphertext`。
  - `id = SHA256(preimage)`。中継で変化する `ttl` と探索変数 `pow_nonce` は除外して固定。
  - `sealHintPow`: 難易度 8 の SHA-256 PoW を付与。

#### 39. [`web/src/lib/network/hint/HintCrypto.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/hint/HintCrypto.ts)
- **役割**: Hint の鍵導出、封印、試行復号、SlotKey 計算。
- **数式**:
  - `hint_key = HMAC-SHA256(K, "aether_hint_v1")`。
  - `blind_tag = HMAC-SHA256(K, hint_nonce)[0..4]`。
  - `newMailboxSlot()`: `nonce = randombytes(32)`, `mailboxKey = SHA256(nonce)`。
  - ペイロード暗号化: ChaCha20-Poly1305 (IETF)。

#### 40. [`web/src/lib/network/hint/HintRouter.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/hint/HintRouter.ts)
- **役割**: Broadcast Veil への搭載、中継、ローカル試行復号。
- **仕様**:
  - `RECENT_HINT_BUFFER = 2000`: 未開封 Hint を不透明なまま 2000 件保持。スレッド鍵が後から追加された際に遡及して試行復号。
  - `originate`: 送出時は必ず Dandelion Stem（`HINT_STEM`）を経由。
  - `reflood`: 保持者による再放流時は Stem を通さず通常フラッド。

#### 41. [`web/src/lib/network/hint/HintRelease.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/hint/HintRelease.ts)
- **役割**: PUT アップロードと Hint 放流の時間分離（エンベロープ相関遮断）。
- **ロジック**:
  - 相関窓計算: $W = \min(\max(W_1, W_2), \text{patience})$。
    - $W_1 = \text{targetSet} / \text{hintRate}$ (匿名集合から逆算)。
    - $W_2 = 10 \times \text{uploadDuration}$ (通信所要時間から逆算)。
    - $\text{patience} = \max(60\text{秒}, 2 \times \text{uploadDuration})$。
  - モード: `adaptive`（既定）、`strict`、`disabled`。
  - ブートストラップ保護: 観測レートが低すぎる場合や小パケット（中継雑音に沈む量）では遅延をゼロにし、網の立ち上がりを阻害しない。

#### 42. [`web/src/lib/network/hint/SlotBlob.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/hint/SlotBlob.ts)
- **役割**: 本体と索引を一体化した Slot バイナリフォーマット。
- **構造**: `[u32be(hintLen) 4B][hint_blob][body_blob]`。
- **目的**: 保持ノードは中身を復号できないが、同梱された `hint_blob` をバイト列として取り出して 20 分周期で再放流可能。

#### 43. [`web/src/lib/network/hint/SchrodingerMailbox.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/hint/SchrodingerMailbox.ts)
- **役割**: ランダム SlotKey への保管、Hint 駆動取得、保持者再放流のオーケストレーション。
- **主要機能**:
  - `REFLOOD_PERIOD_MS = 20分`: 保持者による Hint 再放流周期。SeenCache の TTL（15分）より長く設定。
  - `BACKLOG_LIMIT = 200`: 新規接続ピアへ保管中の全 Hint を要求なしで push。
  - `fetchBody`: 手元に Slot があればネットワークに問い合わせず短絡（0パケット・0漏洩）。
  - `refloodDue`: `mailbox_key` から決定論的に送出窓を導出し、K 人の保持者が同一時間窓で撒くことで SeenCache に畳ませて帯域を節約。

#### 44. [`web/src/lib/network/mailbox/DHTMailbox.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/mailbox/DHTMailbox.ts)
- **役割**: K-nearest DHT ストレージ。
- **仕様**:
  - `K_NEAREST = 5`。
  - `publish`: 直接 PUT せず、Dandelion Stem（`WireType.DHT_PUT_STEM`）に載せて多段中継。最終ホップが代理で K-nearest へ配置。
  - `fetch`: 最も近い K 人に問い合わせるが、全台待たず最初の応答から `FETCH_GRACE_MS = 300ms` の猶予で確定。
  - `handlePut`: 帰属チェック（自分が K-nearest 圏内か）、PoW、形式検証をパスしたエントリのみ格納。

#### 45. [`web/src/lib/network/mailbox/MailboxEntry.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/mailbox/MailboxEntry.ts)
- **役割**: DHT 格納エントリのバリデータ。
- **制限**: `MAX_ENTRY_BYTES = 16KB`, `MAX_ENTRIES_PER_MESSAGE = 64`, `MAX_ENTRIES_PER_TOPIC = 512`, `MAX_TOPICS = 10000`。

#### 46. [`web/src/lib/network/mailbox/ReplicationManager.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/mailbox/ReplicationManager.ts)
- **役割**: ピアの離脱・参加を検知し、K=5 の冗長性を維持するための再配分ループ（5分周期）。

#### 47. [`web/src/lib/network/mailbox/SyncProtocol.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/mailbox/SyncProtocol.ts)
- **役割**: レガシーな過去ログ一括取得プロトコル（※スレッド閲覧では匿名性保護のため使用を停止し、Hint 駆動に移行済み）。

---

### カテゴリ 7: ローカル永続化・秘密鍵封印層

#### 48. [`web/src/lib/storage/IndexedDBStore.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/storage/IndexedDBStore.ts)
- **役割**: ブラウザローカルの IndexedDB ラッパー（`AetherLiteDB`, バージョン 6）。
- **ストア構造**:
  - `mailbox`: `topicHash` を主キーとする生パケット保管（DHT キャッシュ）。
  - `posts`: 復号・検証済みの投稿データ（板/スレ/タイムスタンプのインデックス付き）。
  - `secrets`: 封印された秘密鍵（トリップ鍵、ノード identity 鍵）。

#### 49. [`web/src/lib/storage/SecretVault.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/storage/SecretVault.ts)
- **役割**: 秘密鍵の保存時暗号化（At-Rest Encryption）。押収・フォレンジック対策。
- **仕様**:
  - `KEK = Argon2id(passphrase, salt)` (`opsLimit = 3`, `memLimit = 64MB`)。
  - `ciphertext = XSalsa20-Poly1305(secret, KEK)` (`crypto_secretbox`)。
  - パスフレーズ未設定時も同一フォーマットで保存し、`protected: false` を明示記録。

---

### カテゴリ 8: オーケストレーション・DAG・掲示板ロジック層

#### 50. [`web/src/lib/logic/BoardOrchestrator.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/logic/BoardOrchestrator.ts)
- **役割**: 板（スレッド一覧）の購読、スレッド作成、同期、メモリ状態管理。
- **仕様**:
  - メタスレッド: `__board_meta__` を特殊スレッドとして扱い、スレッド一覧を管理。
  - Hint 駆動: 板鍵を `SchrodingerMailbox` に登録し、Hint 経由でスレッドメタデータを受信・更新。
  - 空判定猶予: `EMPTY_VERDICT_GRACE_MS = 2500ms`。接続直後に「スレッドがありません」と誤判定させないための猶予時間。

#### 51. [`web/src/lib/logic/ThreadOrchestrator.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/logic/ThreadOrchestrator.ts)
- **役割**: スレッド内の投稿、DAG 構築、同期、レス表示の統合管理。
- **仕様**:
  - スレッド活性化（`activate`）: スレッド鍵を導出し、`SchrodingerMailbox` に登録。手元の未開封 Hint バッファを一気に開封。
  - 投稿（`submitPost`）: 親レス（DAG parents）を指定し、`DifficultyEstimator` から難易度を取得。`PacketBuilder` でカプセル化後、`SchrodingerMailbox.publish` で Stem PUT と Hint 放流を実行。

#### 52. [`web/src/lib/logic/ThreadDAGManager.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/logic/ThreadDAGManager.ts)
- **役割**: レス間の因果関係有向非巡回グラフ（DAG）の管理と決定論的トポロジカルソート。
- **ソート規則**:
  1. 累積 PoW（高い順）
  2. 生成タイムスタンプ（古い順）
  3. packet_id（辞書順）
- タイムスタンプ詐称やネットワーク遅延によるレス順の乱れを、累積 PoW と DAG の親子関係で確定。

#### 53. [`web/src/lib/logic/ThreadRanker.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/logic/ThreadRanker.ts)
- **役割**: スレッド一覧の熱量スコアリング（Hacker News / Reddit 流アルゴリズム）。
- **数式**:
  $$\text{Score} = \frac{\text{maxCumulativePow} + 16}{(\text{hoursSinceCreated} + 2)^{1.8}}$$
- 経過時間とともに重力（$G=1.8$）で減衰し、新しい活発なスレッドが上位に浮上。

#### 54. [`web/src/lib/logic/types.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/logic/types.ts)
- **役割**: スレッドメタデータ（`ThreadMeta`）、状態フェーズ（`BoardStatus`, `ThreadStatus`）の型定義。

---

### カテゴリ 9: サーバー・プロバイダー・フック・UI 層

#### 55. [`web/server.ts`](file:///Users/fujinami/github/aether-web-lite/web/server.ts)
- **役割**: カスタム Node.js サーバーエントリーポイント。
- **構成**: ポート 3000（`0.0.0.0`）上で Next.js HTTP サーバーと、WebSocket シグナリングサーバー（`TrackerServer`）を相乗り稼働。

#### 56. [`web/src/server/TrackerServer.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/server/TrackerServer.ts)
- **役割**: 初期ブートストラップ専用シグナリングサーバー。
- **セキュリティ防御**:
  - `MAX_FRAME_BYTES = 64KB`。
  - レート制限: `join`（0.2回/秒、バースト 3）、`relay`（20回/秒、バースト 60）。
  - 参加時に `WireNodeClaim` の NodeId PoW（Argon2id）を検証。無効な主張や既存セッションの上書き（乗っ取り）を拒否。

#### 57. [`web/src/server/SessionManager.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/server/SessionManager.ts)
- **役割**: トラッカー内の接続セッション管理。
- **仕様**:
  - `MAX_SESSIONS = 5000`。
  - `getRandomPeers`: Fisher-Yates シャッフルにより最大 6 ピアをランダム返却。
  - 2 分間 ping 応答のないセッションを強制切断。

#### 58. [`web/src/providers/P2PProvider.tsx`](file:///Users/fujinami/github/aether-web-lite/web/src/providers/P2PProvider.tsx)
- **役割**: React コンテキスト経由で P2P スタック全体の初期化・ライフサイクル・インスタンス提供。
- **初期化チェーン**:
  `Identity` / `NodeIdentityStore` ──▶ `IndexedDBStore` ──▶ `PeerManager` ──▶ `ZoneManager` ──▶ `DandelionRouter` ──▶ `ZoneGossipRouter` ──▶ `DHTMailbox` ──▶ `HintRouter` ──▶ `SchrodingerMailbox` ──▶ `BoardOrchestrator` / `ThreadOrchestrator`。

#### 59. [`web/src/hooks/useBoard.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/hooks/useBoard.ts)
- **役割**: 板ビュー用カスタムフック。`useSyncExternalStore` により `BoardOrchestrator` の状態と再描画を同期。デフォルト VIP 板のシード（`AETHER_LITE_VIP_DEFAULT_SEED`）から板鍵を生成。

#### 60. [`web/src/hooks/useThread.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/hooks/useThread.ts)
- **役割**: スレッドビュー用カスタムフック。`ThreadOrchestrator` の DAG 投稿配列と投稿ステータスを購読。

#### 61. [`web/src/components/AppHeader.tsx`](file:///Users/fujinami/github/aether-web-lite/web/src/components/AppHeader.tsx)
- **役割**: ヘッダー UI。接続ピア数、推定ネットワーク規模、ゾーン深度、ノード ID のリアルタイム表示。

#### 62. [`web/src/components/BoardView.tsx`](file:///Users/fujinami/github/aether-web-lite/web/src/components/BoardView.tsx)
- **役割**: スレッド一覧画面。スレッド作成モーダル、ランキング順ソート表示。

#### 63. [`web/src/components/ThreadView.tsx`](file:///Users/fujinami/github/aether-web-lite/web/src/components/ThreadView.tsx)
- **役割**: スレッド詳細画面。レス一覧描画、アンカーリンク、レス投稿フォーム、PoW 計算進行バーの表示。

#### 64. [`web/src/app/page.tsx`](file:///Users/fujinami/github/aether-web-lite/web/src/app/page.tsx)
- **役割**: メインページ。URL ハッシュおよび状態に応じた `BoardView` と `ThreadView` の切り替え。

#### 65. [`web/src/app/layout.tsx`](file:///Users/fujinami/github/aether-web-lite/web/src/app/layout.tsx)
- **役割**: ルートレイアウト。フォント読み込み、`P2PProvider` のマウント。

---

## 3. システム全域パラメータ・定数総覧

今後のチューニングや改修で参照すべき全パラメータの台帳。

| パラメータ名 | 定義箇所 | 既定値 | 意味と役割 |
|---|---|---|---|
| `MAX_DEGREE` | [`constants.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/constants.ts) | 16 | 1 ノードあたりの WebRTC 接続上限数 |
| `LOCAL_LINKS` | [`constants.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/constants.ts) | 4 | リング維持用の最近傍リンク数（左右 2 本ずつ） |
| `LONG_RANGE_LINKS` | [`constants.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/constants.ts) | 12 | 小世界ネットワークを構成するロングレンジリンク数 |
| `SUBSCRIBE_COUNT` | [`constants.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/constants.ts) | 16 | 常に購読するゾーン数（$K=16$、K-Anonymous 購読） |
| `TARGET_ZONE_POP` | [`constants.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/constants.ts) | 500 | ゾーン分割を行う基準となる 1 ゾーン人口 |
| `FLUFF_PROBABILITY`| [`DandelionRouter.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/gossip/DandelionRouter.ts) | 0.3 | Dandelion++ で各ホップが拡散へ移行する確率（平均 3.33 ホップ） |
| `EPOCH_DURATION` | [`DandelionRouter.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/gossip/DandelionRouter.ts) | 10分 | 同一 Stem ルートを固定する期間 |
| `REFLOOD_PERIOD_MS`| [`SchrodingerMailbox.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/hint/SchrodingerMailbox.ts) | 20分 | 保持ノードが Hint を再放流する周期（SeenCache TTL より大） |
| `TTL_MS` (SeenCache)| [`SeenCache.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/gossip/SeenCache.ts) | 15分 | 重複パケット排除の保持期間 |
| `K_NEAREST` | [`DHTMailbox.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/mailbox/DHTMailbox.ts) | 5 | DHT でデータを保持・取得する担当ピア数 |
| `FETCH_GRACE_MS` | [`DHTMailbox.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/mailbox/DHTMailbox.ts) | 300ms | 最初の DHT 応答受信後、結果を確定させるまでの猶予時間 |
| `MIN_DIFFICULTY` | [`PowPolicy.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/crypto/PowPolicy.ts) | 8 | ネットワークが受け付ける Gossip パケットの最小 SHA-256 難易度 |
| `BASE_DIFFICULTY` | [`DifficultyEstimator.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/crypto/DifficultyEstimator.ts) | 12 | 投稿難易度の基準値（~0.5秒） |
| `MAX_DIFFICULTY` | [`DifficultyEstimator.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/crypto/DifficultyEstimator.ts) | 24 | 炎上・フラッド時の最大難易度（~30秒） |
| `NODE_ID_POW` | [`NodeIdentity.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/crypto/NodeIdentity.ts) | diff=8, mem=32MB | ノード ID 生成時に課す Argon2id PoW |
| `RECENT_HINT_BUFFER`| [`HintRouter.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/hint/HintRouter.ts) | 2000 | 後から開いたスレッド用にメモリ保持する未開封 Hint の上限 |
| `BACKLOG_LIMIT` | [`SchrodingerMailbox.ts`](file:///Users/fujinami/github/aether-web-lite/web/src/lib/network/hint/SchrodingerMailbox.ts) | 200 | 新規接続ピアへプッシュする保持 Hint の上限件数 |

---

## 4. WireType 一覧 & メッセージフロー対応表

| 値 (Hex) | 名前 | 用途 | 配送方式 | 発信元秘匿 |
|---|---|---|---|---|
| `0x10` | `JOIN` | ハンドシェイク署名提出 | 1対1 (直接) | なし |
| `0x11` | `RING_INFO` | 隣接ピアリスト通知 | 1対1 (直接) | なし |
| `0x12` | `PING` | 死活監視 / RTT 測定 | 1対1 (直接) | なし |
| `0x13` | `PONG` | Ping 応答 | 1対1 (直接) | なし |
| `0x17` | `HELLO` | チャレンジ要求 | 1対1 (直接) | なし |
| `0x20` | `PEX_REQUEST` | ピア紹介要求 | 1対1 (直接) | なし |
| `0x21` | `PEX_RESPONSE` | ピア紹介応答 (最大8件) | 1対1 (直接) | なし |
| `0x30` | `SDP_RELAY` | P2P 経由の WebRTC Offer/Answer | 多段リレー | 紹介ピアが中継 |
| `0x31` | `ICE_RELAY` | P2P 経由の ICE Candidate | 多段リレー | 紹介ピアが中継 |
| `0x40` | `GOSSIP` | 投稿・メタのブロードキャスト | 全域フラッディング | なし (Fluff 済み) |
| `0x41` | `STEM` | Gossip の Dandelion Stem | 1対1 直線転送 | **あり** ($p=0.3$ で Fluff) |
| `0x42` | `HINT` | Schrödinger 索引の配布 | 全域フラッディング | 再放流ノードから送出 |
| `0x43` | `HINT_STEM` | Hint の Dandelion Stem | 1対1 直線転送 | **あり** (一次放流元を隠蔽) |
| `0x50` | `DHT_PUT` | K-nearest への Slot 配置 | 1対1 (直接) | なし |
| `0x51` | `DHT_GET` | K-nearest からの Slot 取得 | 1対1 (直接) | 現状なし (要改修) |
| `0x52` | `DHT_RES` | DHT 取得応答 | 1対1 (直接) | なし |
| `0x53` | `DHT_PUT_STEM` | PUT の Dandelion Stem | 1対1 直線転送 | **あり** (最終ホップが代行 PUT) |
