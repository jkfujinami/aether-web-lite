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
  
  UNKNOWN       = 0xFF
}
