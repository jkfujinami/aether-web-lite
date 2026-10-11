export const RING_MESH = {
  // ── 接続構成 ──
  /** ローカルリンク数: 左2 + 右2 = 4本（リング維持） */
  LOCAL_LINKS: 4,
  /** ロングレンジリンク数: 対角方向へ最大12本（ショートカット＋Zone-aware） */
  LONG_RANGE_LINKS: 12,
  /** 1ノードの最大WebRTC接続数 (§2.45) */
  MAX_DEGREE: 16,
  /**
   * 自分で選んで張る (outbound) 接続の目標数。
   * これに満たない間は、次数が上限に達していても outbound を張りに行き、
   * inbound の枠と入れ替える (inbound だけで隣人を埋め尽くされないように)。
   */
  OUTBOUND_TARGET: 8,

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
  INITIAL_PEERS: 8,              // トラッカーから取得するピア数
  CONNECTION_TIMEOUT: 10_000,    // WebRTC接続タイムアウト
} as const;

export const RING_MESH_ZONE = {
  MAX_DEPTH: 12,              // ゾーン深度の上限（2^12 = 4096ゾーン）
  TARGET_ZONE_POP: 500,       // 1ゾーンあたりの目標人口
  SUBSCRIBE_COUNT: 16,        // 常に16ゾーン購読（実際 + ダミー）
  DEPTH_RECOMPUTE_INTERVAL: 60_000,
} as const;

// トラッカーの URL は固定しない (公式のトラッカーは無い)。network/TrackerUrl.ts と
// AetherNodeConfig.trackerUrl を参照。
