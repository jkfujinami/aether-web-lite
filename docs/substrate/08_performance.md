# Part 8: Performance Analysis — 速度評価とボトルネック

## 8.1 評価軸

Substrate v2 の速度評価は以下 4 軸で行う:

1. **レイテンシ**: 1 操作の完了時間
2. **スループット**: 1 秒あたりの処理数
3. **帯域消費**: 1 操作で送受信される bytes
4. **CPU/Memory**: クライアント側の計算リソース

ベースライン: 現状アーキテクチャの実測値
- WebRTC RTT: ~50-150ms (typical 100ms)
- BBS post: ~175ms
- BBS read: ~250ms
- 1 Dandelion stem hop: ~100ms

---

## 8.2 各層のレイテンシ予算

### 8.2.1 Layer 1 (既存): 変更なし

| 操作 | レイテンシ | 内訳 |
|---|---|---|
| WebRTC send | ~50-150ms RTT | DTLS-SRTP オーバヘッド込み |
| Dandelion stem 1 hop | ~100ms | WebRTC RTT |
| Dandelion fluff (zone 全配信) | ~200-400ms | 2-3 hops 平均 |

### 8.2.2 Layer 2: Slot 操作

| 操作 | レイテンシ | 内訳 |
|---|---|---|
| SLOT_PUT (fire-and-forget) | **~125ms** | K=5 並列送信、最初の ACK 受信前にリターン |
| SLOT_GET | **~250ms** | K=5 並列クエリ、最初の応答で返す (4s タイムアウト) |
| Slot validation (受信時) | **~5ms** | CHK + PoW + signature + 帰属 |
| PoW computation (post 時) | **~50-200ms** | 16-bit difficulty で平均 32K iteration |

### 8.2.3 Layer 2: Hint 操作

| 操作 | レイテンシ | 内訳 |
|---|---|---|
| Hint broadcast (Dandelion 経由) | **~50ms** | stem 投入、受信者へ届くのは後 |
| Hint 到達 (Dandelion 4 hops) | **~400ms** | 4 × 100ms (fluff 含む) |
| Hint 受信時 blind_tag lookup | **<1µs** | HashMap O(1) |
| Hint AEAD 復号 | **~100µs** | ChaCha20-Poly1305 (libsodium WASM) |
| BlindTagIndex 再構築 (1000 caps × 3 buckets) | **~3ms** | HMAC × 3000、1 分に 1 回 |

### 8.2.4 Layer 3: Capability 操作

| 操作 | レイテンシ |
|---|---|
| Log.publish (BBS post / DM send) | **~175ms** (1 PUT + Hint broadcast)。**衝突 retry なし**（独立鍵） |
| Log ライブ受信 (Hint→GET) | **~650ms** (Hint 到達 ~400ms + GET ~250ms) |
| Log.fetchHistory (バンドル N 個並列) | **~250-400ms**（64KB 制限を超えてスケール） |
| OwnedPointer.update | **~125ms** (PUT) |
| OwnedPointer.resolve | **~250ms** (GET) |
| ChunkSet.upload (1MB, 32KB chunks) | **~1.5-3s** (PoW 並列 + 32 PUT 並列) |
| ChunkSet.download (1MB) | **~1s** (32 GET 並列、concurrency=8) |

### 8.2.5 Layer 4: Application 全体

| 操作 | 旧 BBS | 新 BBS | 新 DM | 新 File |
|---|---|---|---|---|
| Post / Send | ~175ms | ~175ms | ~175ms | - |
| Read / Receive | ~250ms | ~250ms | ~650ms | - |
| Upload | - | - | - | ~1.5-3s (1MB) |
| Download | - | - | - | ~1s (1MB) |

---

## 8.3 ボトルネック分析

### 8.3.1 主要ボトルネック

| 順位 | ボトルネック | 影響操作 | 対策 |
|---|---|---|---|
| 1 | WebRTC RTT | 全操作 | 変更不可 (物理制約) |
| 2 | PoW 計算 | post, send, upload | WASM 化 (既存)、難易度動的調整 |
| 3 | Dandelion fluff 遅延 | Hint 到達 | hops 数調整、エコー機構 |
| 4 | Slot validation | 受信処理 | 並列化、検証順最適化 |
| 5 | Log 過去ログの並列 GET 本数 | コールド参加・大スレ | バンドルで集約、concurrency 制御 |

### 8.3.2 Log の書き込み衝突（v2.1: 解消）

旧 BundledChannel は 1 slot を全員で上書きするため、高活発 channel で version 衝突が多発した（100 人 / post 間隔 10 秒で衝突確率 ~50%）。

**v2.1 の `Log` では各投稿が独立 IMMUTABLE スロット（ランダム鍵）なので、書き込み衝突は原理的に発生しない。** 残るコストは過去ログ読み込み時の並列 GET 本数のみ（バンドルで集約）。決定論 seq 鍵を使う場合のみ claim 競合があるが、末尾付近に局所化され read-after-write で解決（[04](./04_layer2_primitives.md) 4.1.9）。

### 8.3.3 ChunkSet スループット

PoW がボトルネック。1 chunk あたり ~50ms × 32 chunks = 1.6s が直列なら理論値。

並列化:
- WebWorker で 4 並列 PoW → ~400ms
- 並列 PUT 32 → ~250ms

合計 **~700ms for 1MB**。実用範囲。

---

## 8.4 帯域消費

### 8.4.1 1 操作あたり (上り)

| 操作 | サイズ |
|---|---|
| SLOT_PUT (1KB payload) | 1.2KB × 5 (K=5) = 6KB |
| SLOT_PUT (64KB payload) | 64.2KB × 5 = 321KB |
| SLOT_GET | 50B × 5 = 250B |
| Hint broadcast | 100B + Dandelion fan-out (~5 peers) = 500B |

### 8.4.2 1 操作あたり (下り)

| 操作 | サイズ |
|---|---|
| SLOT_RES (最初の応答, 1KB slot) | 1.1KB |
| Hint 受信 | 100B per Hint |
| HINT_CATCHUP_RES (100 hints) | ~10KB |

### 8.4.3 定常 traffic

| 操作 | 帯域 |
|---|---|
| Heartbeat (Ping/Pong) | ~50B × 8 peers × 1/30s = ~13B/s |
| Hint 中継 (gossip) | 平均 100B × Hint レート (例: 10/s) = 1KB/s |
| 自分の Hint 購読 (BlindTagIndex) | CPU のみ、帯域 0 |
| ピア接続維持 | WebRTC keep-alive ~100B/s |

→ **定常 ~2-5KB/s**。実用範囲。

### 8.4.4 大規模ネットワーク化

ネットワーク 1000 ノード、平均 10 channel/peer 購読の場合:

- Hint レート (全体): 100 投稿/分 × 各 1 hint = ~2 hints/s
- 各ピアの受信 hint: 2/s (全配信なので)
- 帯域: 2 × 100B = 200 B/s

→ **小規模なら問題なし**。10000+ ピアでは zone 階層化が必要。

---

## 8.5 CPU / Memory

### 8.5.1 起動時コスト

| 処理 | コスト |
|---|---|
| Identity 生成 | ~10ms (Ed25519 鍵生成) |
| libsodium 初期化 | ~50ms (WASM load) |
| IndexedDB 初期化 | ~20ms |
| WebRTC PeerConnection 作成 | ~5ms |
| 既知 peer への接続確立 | ~500-1000ms (Signaling + ICE) |

### 8.5.2 定常 CPU

| 処理 | コスト |
|---|---|
| Hint 受信処理 (decode + lookup + decrypt) | ~200µs per Hint |
| BlindTagIndex 再構築 (1000 caps) | ~3ms / 30s = 0.01% |
| Heartbeat | <0.1% |
| WebRTC データチャネル維持 | <1% |

→ **定常 1-2% CPU**。バックグラウンドタブでも問題なし。

### 8.5.3 メモリ

| 用途 | サイズ |
|---|---|
| Capability キャッシュ (1000 caps) | ~100KB |
| BlindTagIndex (3000 entries) | ~150KB |
| pendingRequests (短期) | ~10KB |
| Slot キャッシュ (Log active items) | ~1MB per active channel |
| Hint LRU (10000 entries) | ~1.5MB |
| IndexedDB バッファ | OS 管理 |

→ **総計 ~5-20MB**。Web ブラウザ環境として軽量。

---

## 8.6 スループット限界

### 8.6.1 1 クライアントあたり

| 操作 | 限界 |
|---|---|
| Post (Log.publish) | ~5-10/秒 (PoW 律速) |
| Read | ~10-20/秒 (RTT 律速) |
| Hint 受信処理 | ~500-1000/秒 (decode + decrypt) |
| Slot 保管 (K-nearest として) | IndexedDB write ~100/秒 |

### 8.6.2 ネットワーク全体 (1000 ノード)

| 指標 | 限界 |
|---|---|
| 同時アクティブ channel | ~10000 (各ノード 10 ch 購読仮定) |
| 全 post レート | ~100 posts/秒 (各ノード 0.1 post/s) |
| 全 Hint レート | ~200 hints/秒 (post + 更新通知) |

---

## 8.7 最適化戦略

### 8.7.1 即効性のある最適化

1. **Slot キャッシュの強化**: Log の active item / バンドルの cache hit 率を上げる
2. **PoW WebWorker 並列化**: ChunkSet upload で 4-8 並列
3. **Hint dedup の効率化**: SHA256 by nonce を `Set<string>` で管理
4. **BlindTagIndex の Web Worker 化**: メインスレッドブロックを避ける

### 8.7.2 中期的最適化

1. **バンドル分割の最適化**: Log 過去ログの range 粒度を活発度で調整
2. **Bundle Hint**: 複数 hint を 1 つにまとめて配信効率化
3. **Zone-aware Hint flood**: 全ピアではなく関連ゾーンのみ（H2 増幅対策）
4. **Reed-Solomon for ChunkSet**: 一部 chunk loss でも復元可能、再送削減

### 8.7.3 長期的最適化

1. **WebRTC SCTP の direct 設定**: 4KB チャンクサイズの最適化
2. **QUIC 移行**: WebTransport API 普及次第
3. **Compression**: payload を zstd 圧縮 (Slot.payload を encode 前)

---

## 8.8 ベンチマーク方法

### 8.8.1 ローカルベンチマーク

```typescript
// web/src/__bench__/substrate_bench.ts

describe('Slot operations', () => {
  it('PUT throughput', async () => {
    const start = performance.now()
    const promises = []
    for (let i = 0; i < 100; i++) {
      promises.push(slotStore.put(makeRandomSlot()))
    }
    await Promise.all(promises)
    const elapsed = performance.now() - start
    console.log(`PUT 100 slots: ${elapsed}ms (${(100 / elapsed * 1000).toFixed(1)} ops/s)`)
  })

  it('GET latency', async () => {
    const samples = 100
    const latencies: number[] = []
    for (let i = 0; i < samples; i++) {
      const start = performance.now()
      await slotStore.get(randomSlotKey())
      latencies.push(performance.now() - start)
    }
    latencies.sort((a, b) => a - b)
    console.log(`GET p50: ${latencies[50]}ms, p99: ${latencies[99]}ms`)
  })
})
```

### 8.8.2 E2E ベンチマーク

`simulation/` の既存 multi-node simulation を流用:

```typescript
// simulation/src/bench_substrate.ts
// 10 ノード起動して BBS post-read のレイテンシ計測
```

### 8.8.3 ブラウザ実機

- Lighthouse Performance Score 維持
- Long Tasks (>50ms) を monitor
- React DevTools Profiler で re-render コスト確認

---

## 8.9 退化検出

### 8.9.1 観測指標

| 指標 | 閾値 |
|---|---|
| BBS post レイテンシ p99 | ≤500ms |
| BBS read レイテンシ p99 | ≤800ms |
| BlindTagIndex 再構築時間 | ≤10ms |
| Slot validation 時間 | ≤20ms |
| Hint 受信処理時間 | ≤2ms |

これを CI に組み込み、PR で違反検出。

### 8.9.2 退化シナリオ

| シナリオ | 検出方法 |
|---|---|
| PoW 難易度上昇による遅延 | DifficultyEstimator のログ監視 |
| 過去ログ並列 GET 本数の増加 | バンドル range 粒度の集計 |
| Hint catchup の遅延 | 起動時 catchup 時間の計測 |
| K-nearest 不安定化 | trace に GET 失敗率を記録 |

---

## 8.10 まとめ

Substrate v2 は **既存 BBS の速度を維持しつつ**、新規 application (DM、ファイル、グループチャット) を追加できる。

主要トレードオフ:
- **BBS**: 速度不変 (~175ms post / ~250ms read)
- **DM**: 新規。Signal 並 (~175ms send / ~650ms receive)
- **ファイル**: 新規。1MB ~1.5s upload / ~1s download

ボトルネックは主に WebRTC RTT と PoW で、ネットワーク規模 1000 ノードまでは余裕。

---

## 8.11 次に読む

→ [09_security_analysis.md](./09_security_analysis.md): セキュリティ評価
→ [10_migration.md](./10_migration.md): 移行戦略
