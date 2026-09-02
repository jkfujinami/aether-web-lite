use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use tracing::{error, warn};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TrackerMessage {
    /// Bound Identity の主張。
    ///
    /// position と zones は送らない:
    ///   - position は peerId の純粋関数なので、トラッカーも各ピアも自分で計算する
    ///   - zones (購読ゾーン) を申告するとトラッカー 1 箇所に
    ///     「誰が何に興味があるか」が集まり、交差攻撃の材料になる (本家 18.6.2)
    #[serde(rename = "join")]
    Join {
        #[serde(rename = "peerId")]
        peer_id: String,
        /// hex 64 文字 (Ed25519 公開鍵)
        pubkey: String,
        #[serde(rename = "powCounter")]
        pow_counter: u64,
        #[serde(rename = "isSeed")]
        is_seed: bool,
        #[serde(rename = "isCache")]
        is_cache: bool,
    },
    #[serde(rename = "peers")]
    Peers { peers: Vec<PeerInfo> },
    #[serde(rename = "relay")]
    Relay {
        #[serde(rename = "targetPeerId")]
        target_peer_id: String,
        payload: serde_json::Value,
    },
    #[serde(rename = "error")]
    Error { message: String },
}

/// トラッカーが返すブートストラップ候補。
/// position は peerId から導出するので受け取らない。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PeerInfo {
    #[serde(rename = "peerId")]
    pub peer_id: String,
}

pub struct SignalingClient {
    tx: mpsc::UnboundedSender<TrackerMessage>,
}

impl SignalingClient {
    #[allow(clippy::too_many_arguments)]
    pub async fn connect(
        url: &str,
        peer_id: String,
        pubkey_hex: String,
        pow_counter: u64,
        is_seed: bool,
        is_cache: bool,
        on_peers: mpsc::UnboundedSender<Vec<PeerInfo>>,
        on_signal: mpsc::UnboundedSender<serde_json::Value>,
    ) -> Result<Self> {
        let (ws_stream, _) = connect_async(url).await?;
        let (mut ws_tx, mut ws_rx) = ws_stream.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<TrackerMessage>();

        // Join
        let join = TrackerMessage::Join {
            peer_id: peer_id.clone(),
            pubkey: pubkey_hex,
            pow_counter,
            is_seed,
            is_cache,
        };
        ws_tx
            .send(Message::Text(serde_json::to_string(&join)?))
            .await?;

        // WS Receiver + Sender loops
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    Some(msg) = rx.recv() => {
                        if let Ok(text) = serde_json::to_string(&msg) {
                            if let Err(e) = ws_tx.send(Message::Text(text)).await {
                                error!("[Signaling] Send error: {}", e);
                                break;
                            }
                        }
                    }
                    Some(Ok(msg)) = ws_rx.next() => {
                        if let Message::Text(text) = msg {
                            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) {
                                match data.get("type").and_then(|v| v.as_str()) {
                                    Some("peers") => {
                                        if let Ok(TrackerMessage::Peers { peers }) = serde_json::from_value(data) {
                                            let _ = on_peers.send(peers);
                                        }
                                    }
                                    Some("error") => {
                                        warn!("[Signaling] Server error: {:?}", data.get("message"));
                                    }
                                    _ => {
                                        // Relay messages or others
                                        let _ = on_signal.send(data);
                                    }
                                }
                            }
                        }
                    }
                    else => break,
                }
            }
        });

        Ok(Self { tx })
    }

    pub fn send_relay(&self, target: String, payload: serde_json::Value) {
        let _ = self.tx.send(TrackerMessage::Relay {
            target_peer_id: target,
            payload,
        });
    }

    pub fn get_tx(&self) -> mpsc::UnboundedSender<TrackerMessage> {
        self.tx.clone()
    }
}
