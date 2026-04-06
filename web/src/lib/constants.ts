export const RING_MESH = {
  // ── 接続構成 ──
  /** ローカルリンク数: 左2 + 右2 = 4本（リング維持） */
  LOCAL_LINKS: 4,
  /** ロングレンジリンク数: 対角方向へ最大12本（ショートカット＋Zone-aware） */
  LONG_RANGE_LINKS: 12,
  /** 1ノードの最大WebRTC接続数 (§2.45) */
  MAX_DEGREE: 16,

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

export const TRACKER = {
  // Next.js カスタムサーバーの /ws で WebSocket シグナリングに接続
  // HTTP と WS が同一ポート (3000) で動作するため、ngrok 1つで公開可能
  URL: typeof location !== 'undefined' 
    ? `ws${location.protocol === 'https:' ? 's' : ''}://${location.host}/ws`
    : 'ws://localhost:3000/ws'
} as const;
