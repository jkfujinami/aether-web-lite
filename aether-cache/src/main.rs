mod mailbox;
mod network;
mod storage;

use anyhow::Result;
use mailbox::dht_mailbox::DHTMailbox;
use network::messages::P2PMessage;
use network::ring_position::RingPosition;
use network::signaling_client::{PeerInfo as SignalingPeerInfo, SignalingClient};
use network::webrtc_peer::WebRTCPeer;
use std::collections::HashMap;
use std::sync::Arc;
use storage::sqlite_store::SqliteStore;
use tokio::sync::mpsc;
use tracing::info;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();

    let tracker_url = "ws://localhost:3000";
    let my_peer_id = format!(
        "cache_{}",
        uuid::Uuid::new_v4().to_string()[..8].to_string()
    );
    let ring_pos = RingPosition::random(); // Use RingPosition properly

    let store = Arc::new(SqliteStore::new("./mailbox.db")?);
    let mailbox = Arc::new(DHTMailbox::new(Arc::clone(&store)));

    let (peers_tx, mut peers_rx) = mpsc::unbounded_channel::<Vec<SignalingPeerInfo>>();
    let (signal_rx_tx, mut signal_rx_rx) = mpsc::unbounded_channel::<serde_json::Value>();
    let (data_tx, mut data_rx) = mpsc::unbounded_channel::<(String, String)>();

    let signaling = Arc::new(
        SignalingClient::connect(
            tracker_url,
            my_peer_id.clone(),
            ring_pos.value,
            peers_tx,
            signal_rx_tx,
        )
        .await?,
    );

    let mut peers: HashMap<String, Arc<WebRTCPeer>> = HashMap::new();

    info!(
        "[CacheNode] Started as {} at pos {}",
        my_peer_id, ring_pos.value
    );

    loop {
        tokio::select! {
            Some(peer_list) = peers_rx.recv() => {
                for peer in peer_list {
                    if peer.peer_id != my_peer_id && !peers.contains_key(&peer.peer_id) {
                        info!("[CacheNode] Initiating connection to {}", peer.peer_id);
                        if let Ok(rtc) = WebRTCPeer::new(
                            peer.peer_id.clone(),
                            true,
                            signaling.get_tx(),
                            data_tx.clone(),
                        ).await {
                            peers.insert(peer.peer_id.clone(), rtc);
                        }
                    }
                }
            }
            Some(signal) = signal_rx_rx.recv() => {
                let sender_id = signal.get("senderId").and_then(|v| v.as_str()).map(|s| s.to_string());
                if let Some(sid) = sender_id {
                    let rtc = if let Some(rtc) = peers.get(&sid) {
                        rtc.clone()
                    } else {
                        info!("[CacheNode] Responding to connection from {}", sid);
                        let rtc = WebRTCPeer::new(
                            sid.clone(),
                            false,
                            signaling.get_tx(),
                            data_tx.clone(),
                        ).await?;
                        let arc_rtc = rtc.clone();
                        peers.insert(sid.clone(), rtc);
                        arc_rtc
                    };
                    let sig_val = signal.clone();
                    let sig_tx = signaling.get_tx();
                    let _ = rtc.handle_signal(sig_val, sid, sig_tx).await;
                }
            }
            Some((peer_id, data)) = data_rx.recv() => {
                if let Ok(msg) = serde_json::from_str::<P2PMessage>(&data) {
                    match msg {
                        P2PMessage::Gossip { packet } => {
                            info!("[Gossip] Relay {} from {}", packet.packet_id, peer_id);
                            for (pid, rtc) in &peers {
                                if pid != &peer_id {
                                    let relay_msg = P2PMessage::Gossip { packet: packet.clone() };
                                    if let Ok(json) = serde_json::to_string(&relay_msg) {
                                        let _ = rtc.send(&json).await;
                                    }
                                }
                            }
                        }
                        _ => {
                            let response = mailbox.handle_message(msg, &peer_id).await?;
                            if let Some(resp) = response {
                                if let Ok(json_resp) = serde_json::to_string(&resp) {
                                   if let Some(rtc) = peers.get(&peer_id) {
                                       let _ = rtc.send(&json_resp).await;
                                   }
                                }
                            }
                        }
                    }
                }
            }
            else => break,
        }
    }

    Ok(())
}
