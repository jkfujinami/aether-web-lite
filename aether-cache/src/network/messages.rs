use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
pub enum P2PMessage {
    /// 接続直後に双方が送るチャレンジ。相手はこれに署名した Join を返す。
    #[serde(rename = "hello")]
    Hello { challenge: JsonBytes },
    /// Bound Identity の主張 + 所有証明。
    ///
    /// position は載せない。peerId から導出できるため、載せると
    /// 「座標の詐称」という攻撃面が生まれる (本家 18.5.3)。
    #[serde(rename = "join")]
    Join {
        #[serde(rename = "peerId")]
        peer_id: String,
        pubkey: JsonBytes,
        #[serde(rename = "powCounter")]
        pow_counter: u64,
        challenge: JsonBytes,
        signature: JsonBytes,
    },
    #[serde(rename = "ping")]
    Ping { ts: f64 },
    #[serde(rename = "pong")]
    Pong {
        ts: f64,
        #[serde(rename = "echoTs")]
        echo_ts: f64,
    },
    #[serde(rename = "ring-info")]
    RingInfo { neighbors: Vec<PeerRef> },
    #[serde(rename = "gossip")]
    Gossip { packet: GossipPacket },
    #[serde(rename = "stem")]
    /// Dandelion++ の Stem (茎) フェーズ。
    ///
    /// ★ ホップカウンタ (stemTtl) は意図的に持たない。
    ///   カウンタを平文で載せると上限値が「発信元しか出せない値」になり、
    ///   受け取った中継者が発信元を確定できてしまう。停止は各ホップの
    ///   確率判定 (FLUFF_PROBABILITY) が担う。詳細は gossip/router.rs 参照。
    Stem {
        #[serde(rename = "zoneId")]
        zone_id: u32,
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
    #[serde(rename = "pex-request")]
    PexRequest {
        #[serde(rename = "minDistance")]
        min_distance: f64,
    },
    #[serde(rename = "pex-response")]
    PexResponse { peers: Vec<PeerRef> },
    #[serde(rename = "sdp-relay")]
    SdpRelay {
        #[serde(rename = "targetPeerId")]
        target_peer_id: String,
        #[serde(rename = "senderId")]
        sender_id: Option<String>,
        sdp: serde_json::Value,
    },
    #[serde(rename = "ice-relay")]
    IceRelay {
        #[serde(rename = "targetPeerId")]
        target_peer_id: String,
        #[serde(rename = "senderId")]
        sender_id: Option<String>,
        candidate: serde_json::Value,
    },
    #[serde(other)]
    Ignored,
}

/// PEX / RingInfo で運ぶピア参照。
///
/// position と zones は載せない:
///   - position は peerId の純粋関数なので受け取る側が自分で計算する
///   - zones (購読ゾーン) を流すと「誰が何に興味があるか」が漏れ、
///     交差攻撃の材料になる (本家 18.6.2)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PeerRef {
    pub id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
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

/// ワイヤ上のバイト列。
///
/// ★ 修正前の致命的な欠陥
///
/// 以前は `#[serde(untagged)]` の enum で
/// `Tagged { _type: "Uint8Array", data: Vec<u8> }` と `Raw(Vec<u8>)` を
/// 受け分けようとしていた。しかし untagged は `deserialize_any` を通るため、
/// **MsgPack の bin 型を受け取れなかった**。`Vec<u8>` は seq を期待するのに対し、
/// bin は `visit_bytes` を呼ぶためどちらの variant にもマッチしない。
///
/// ブラウザの `@msgpack/msgpack` は `Uint8Array` を bin 型で符号化するので、
/// 結果として **バイト列を含むメッセージ (HELLO / JOIN / Gossip の nonce・payload /
/// DHT のエントリ) が Rust 側で 1 通も復号できていなかった**。
/// 数値と文字列だけの PING/PONG が通っていたため気付きにくかった。
///
/// 現在は手書きの Visitor で 3 つの表現をすべて受け付ける:
///   * MsgPack bin      … ブラウザの `Uint8Array` (本命)
///   * 配列             … JSON 経由や MsgPack array
///   * `{_type, data}`  … 旧 `JsonBinary.stringify` 形式 (IndexedDB の過去データ)
///
/// 送信は常に `serialize_bytes`。MsgPack では bin 型になり、JSON では配列に
/// フォールバックする。どちらもブラウザ側の `toBytes()` が受け取れる。
/// 旧 `{_type, data}` 形式で送るのはやめた —— 本家 18.6.2 が
/// 「バイナリが約 2 倍に膨らむ」として不採用にした形式そのものだったため。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct JsonBytes(Vec<u8>);

impl JsonBytes {
    pub fn bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn from_vec(vec: Vec<u8>) -> Self {
        JsonBytes(vec)
    }

    pub fn into_vec(self) -> Vec<u8> {
        self.0
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Serialize for JsonBytes {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bytes(&self.0)
    }
}

impl<'de> Deserialize<'de> for JsonBytes {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(JsonBytesVisitor)
    }
}

struct JsonBytesVisitor;

impl<'de> serde::de::Visitor<'de> for JsonBytesVisitor {
    type Value = JsonBytes;

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a byte string, an array of bytes, or {_type: \"Uint8Array\", data: [...]}")
    }

    fn visit_bytes<E: serde::de::Error>(self, v: &[u8]) -> Result<Self::Value, E> {
        Ok(JsonBytes(v.to_vec()))
    }

    fn visit_byte_buf<E: serde::de::Error>(self, v: Vec<u8>) -> Result<Self::Value, E> {
        Ok(JsonBytes(v))
    }

    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut out = Vec::with_capacity(seq.size_hint().unwrap_or(0));
        while let Some(b) = seq.next_element::<u8>()? {
            out.push(b);
        }
        Ok(JsonBytes(out))
    }

    /// 旧 `JsonBinary.stringify` 形式 `{_type: "Uint8Array", data: [...]}`
    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut data: Option<Vec<u8>> = None;
        while let Some(key) = map.next_key::<String>()? {
            if key == "data" {
                data = Some(map.next_value()?);
            } else {
                let _ = map.next_value::<serde::de::IgnoredAny>()?;
            }
        }
        data.map(JsonBytes)
            .ok_or_else(|| serde::de::Error::custom("Uint8Array object without `data`"))
    }

    fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        Ok(JsonBytes(Vec::new()))
    }

    fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        Ok(JsonBytes(Vec::new()))
    }
}
