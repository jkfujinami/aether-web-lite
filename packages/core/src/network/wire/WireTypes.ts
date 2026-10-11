export enum WireType {
  // Control (0x1x)
  JOIN          = 0x10,
  RING_INFO     = 0x11,
  PING          = 0x12,
  PONG          = 0x13,
  LOCAL_LINK_REQ = 0x14,
  LOCAL_LINK_ACK = 0x15,
  LOCAL_LINK_REJ = 0x16,
  /** 接続直後のチャレンジ。相手はこれに署名して JOIN を返す (Bound Identity の所有証明) */
  HELLO         = 0x17,

  // PEX (0x2x)
  PEX_REQUEST   = 0x20,
  PEX_RESPONSE  = 0x21,

  // Signaling Relay (0x3x)
  SDP_RELAY     = 0x30,
  ICE_RELAY     = 0x31,

  // Gossip (0x4x)
  GOSSIP        = 0x40,
  STEM          = 0x41,
  /**
   * Dandelion++ とは独立に全ノードへ配る索引 (Schrödinger Mailbox)。
   * 中身は鍵を持つ者にしか復号できず、中継ノードには不透明なバイト列に見える。
   */
  HINT          = 0x42,
  /**
   * Hint の Stem フェーズ。1 対 1 で数ホップ運んでから HINT の全体配信へ移る。
   * 発信元を隣人から隠すために存在する (Gossip の STEM と同じ役割)。
   */
  HINT_STEM     = 0x43,
  /**
   * 多段オニオン暗号化された Stem パケット (Onion Stem Routing)。
   * 中継ノードは平文パケットIDも内容も読めず、全ホップ共謀時以外特定不能。
   */
  ONION_STEM    = 0x44,

  // DHT Mailbox (0x5x)
  DHT_PUT       = 0x50,
  /**
   * PUT の Stem フェーズ。1 対 1 で数ホップ運んでから、
   * 最後のホップが自分の代わりに K-nearest へ PUT する。
   * 保管者が見る IP を発信元のものにしないために存在する。
   */
  DHT_PUT_STEM  = 0x53,
  DHT_GET       = 0x51,
  DHT_RES       = 0x52,
  
  UNKNOWN       = 0xFF
}
