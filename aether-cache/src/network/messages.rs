use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
pub enum P2PMessage {
    #[serde(rename = "join")]
    Join {
        #[serde(rename = "peerId")]
        peer_id: String,
        position: f64,
    },
    #[serde(rename = "ring-info")]
    RingInfo {
        neighbors: Vec<PeerInfo>,
    },
    #[serde(rename = "gossip")]
    Gossip {
        packet: GossipPacket,
    },
    #[serde(rename = "stem")]
    Stem {
        #[serde(rename = "zoneId")]
        zone_id: u32,
        #[serde(rename = "stemTtl")]
        stem_ttl: u32,
        packet: GossipPacket,
    },
    #[serde(rename = "dht-put")]
    DhtPut {
        #[serde(rename = "topicHash")]
        topic_hash: String,
        entries: Vec<JsonBytes>,
    },
    #[serde(rename = "dht-get")]
    DhtGet {
        #[serde(rename = "topicHash")]
        topic_hash: String,
        #[serde(rename = "reqId")]
        req_id: String,
    },
    #[serde(rename = "dht-res")]
    DhtRes {
        #[serde(rename = "topicHash")]
        topic_hash: String,
        #[serde(rename = "reqId")]
        req_id: String,
        entries: Vec<JsonBytes>,
    },
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PeerInfo {
    pub id: String,
    pub position: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GossipPacket {
    pub packet_id: String,
    pub hop_count: u32,
    pub pow_nonce: u64,
    pub pow_difficulty: u32,
    pub timestamp: u64,
    pub zone_id: u32,
    pub nonce: JsonBytes,
    pub payload: JsonBytes,
}

/// JSON compatibility for Uint8Array sent from browser
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(untagged)]
pub enum JsonBytes {
    /// Browser sends `_type: 'Uint8Array', data: [...]`
    Tagged {
        #[serde(rename = "_type")]
        _type: String,
        data: Vec<u8>,
    },
    /// Raw array or other values (Fallback)
    Raw(Vec<u8>),
}

impl JsonBytes {
    pub fn bytes(&self) -> &[u8] {
        match self {
            JsonBytes::Tagged { data, .. } => data,
            JsonBytes::Raw(vec) => vec,
        }
    }
    
    pub fn from_vec(vec: Vec<u8>) -> Self {
        JsonBytes::Tagged {
            _type: "Uint8Array".to_string(),
            data: vec,
        }
    }
}
