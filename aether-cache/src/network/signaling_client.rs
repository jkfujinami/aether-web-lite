use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use tracing::{warn, error};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TrackerMessage {
    #[serde(rename = "join")]
    Join {
        #[serde(rename = "peerId")]
        peer_id: String,
        position: f64,
        zones: Vec<u32>,
    },
    #[serde(rename = "peers")]
    Peers {
        peers: Vec<PeerInfo>,
    },
    #[serde(rename = "relay")]
    Relay {
        #[serde(rename = "targetPeerId")]
        target_peer_id: String,
        payload: serde_json::Value,
    },
    #[serde(rename = "error")]
    Error {
        message: String,
    },
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PeerInfo {
    #[serde(rename = "peerId")]
    pub peer_id: String,
    pub position: f64,
    pub zones: Vec<u32>,
}

pub struct SignalingClient {
    tx: mpsc::UnboundedSender<TrackerMessage>,
}

impl SignalingClient {
    pub async fn connect(
        url: &str,
        peer_id: String,
        position: f64,
        on_peers: mpsc::UnboundedSender<Vec<PeerInfo>>,
        on_signal: mpsc::UnboundedSender<serde_json::Value>,
    ) -> Result<Self> {
        let (ws_stream, _) = connect_async(url).await?;
        let (mut ws_tx, mut ws_rx) = ws_stream.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<TrackerMessage>();

        // Join
        let join = TrackerMessage::Join {
            peer_id: peer_id.clone(),
            position,
            zones: vec![0], // Default zone 0
        };
        ws_tx.send(Message::Text(serde_json::to_string(&join)?)).await?;

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
