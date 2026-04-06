use crate::network::messages::P2PMessage;
use anyhow::{anyhow, Result};
use rmp_serde::{decode, encode};

#[derive(Debug, Clone, Copy, PartialEq)]
#[repr(u8)]
pub enum WireType {
    // Control (0x1x)
    Join = 0x10,
    RingInfo = 0x11,
    Ping = 0x12,
    Pong = 0x13,
    
    // PEX (0x2x)
    PexRequest = 0x20,
    PexResponse = 0x21,
    
    // Signaling Relay (0x3x)
    SdpRelay = 0x30,
    IceRelay = 0x31,
    
    // Gossip (0x4x)
    Gossip = 0x40,
    Stem = 0x41,
    
    // DHT Mailbox (0x5x)
    DhtPut = 0x50,
    DhtGet = 0x51,
    DhtRes = 0x52,
    
    Unknown = 0xFF,
}

impl From<u8> for WireType {
    fn from(v: u8) -> Self {
        match v {
            0x10 => WireType::Join,
            0x11 => WireType::RingInfo,
            0x12 => WireType::Ping,
            0x13 => WireType::Pong,
            0x20 => WireType::PexRequest,
            0x21 => WireType::PexResponse,
            0x30 => WireType::SdpRelay,
            0x31 => WireType::IceRelay,
            0x40 => WireType::Gossip,
            0x41 => WireType::Stem,
            0x50 => WireType::DhtPut,
            0x51 => WireType::DhtGet,
            0x52 => WireType::DhtRes,
            _ => WireType::Unknown,
        }
    }
}

pub struct WireCodec;

impl WireCodec {
    /// V2: 1-byte header (WireType) + MsgPack payload
    pub fn encode_v2(msg: &P2PMessage) -> Result<Vec<u8>> {
        let wire_type = match msg {
            P2PMessage::Join { .. } => WireType::Join,
            P2PMessage::Ping { .. } => WireType::Ping,
            P2PMessage::Pong { .. } => WireType::Pong,
            P2PMessage::RingInfo { .. } => WireType::RingInfo,
            P2PMessage::Gossip { .. } => WireType::Gossip,
            P2PMessage::Stem { .. } => WireType::Stem,
            P2PMessage::DhtPut { .. } => WireType::DhtPut,
            P2PMessage::DhtGet { .. } => WireType::DhtGet,
            P2PMessage::DhtRes { .. } => WireType::DhtRes,
            P2PMessage::PexRequest { .. } => WireType::PexRequest,
            P2PMessage::PexResponse { .. } => WireType::PexResponse,
            P2PMessage::SdpRelay { .. } => WireType::SdpRelay,
            P2PMessage::IceRelay { .. } => WireType::IceRelay,
        };

        let mut buf = Vec::new();
        buf.push(wire_type as u8);
        let body = encode::to_vec_named(msg)?;
        buf.extend_from_slice(&body);
        Ok(buf)
    }

    pub fn decode_v2(data: &[u8]) -> Result<P2PMessage> {
        if data.is_empty() {
            return Err(anyhow!("Empty wire frame"));
        }
        
        // Skip header byte for MsgPack decode (it's redundant if we use internal tags, 
        // but helps with protocol versioning and early rejection)
        let _wire_type = WireType::from(data[0]);
        if _wire_type == WireType::Unknown {
            // Check if it's plain JSON (Fallback)
             if let Ok(text) = std::str::from_utf8(data) {
                 if let Ok(msg) = serde_json::from_str::<P2PMessage>(text) {
                     return Ok(msg);
                 }
             }
             return Err(anyhow!("Unsupported wire type: 0x{:02x}", data[0]));
        }

        let msg: P2PMessage = decode::from_slice(&data[1..])?;
        Ok(msg)
    }
}
