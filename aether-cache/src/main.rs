use anyhow::Result;
use tracing::info;
use std::sync::Arc;
use tokio::sync::mpsc;
use aether_cache::storage::sqlite_store::SqliteStore;
use aether_cache::storage::StorageBackend;
use aether_cache::network::signaling_client::{SignalingClient, PeerInfo as SignalingPeerInfo};
use aether_cache::network::peer_manager::{PeerManager, PeerManagerControl};
use aether_cache::crypto::node_identity::{NodeIdentity, NODE_ID_POW};
use aether_cache::gossip::router::GossipActor;
use aether_cache::node_key::load_or_create_seed;
use aether_cache::mailbox::mailbox::MailboxActor;
use aether_cache::NetworkEvent;

#[tokio::main]
async fn main() -> Result<()> {
    // 1. Initialize logging
    use tracing_subscriber::{EnvFilter, fmt};
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,webrtc_mdns=off,webrtc_ice=warn,webrtc_sctp=warn,webrtc=warn"));
    fmt().with_env_filter(filter).init();
    info!("Aether Cache starting up...");

    // 2. Setup Database and Storage
    let store: Arc<dyn StorageBackend> = Arc::new(SqliteStore::new("./mailbox.db")?);
    info!("SQLite storage backend initialized");

    // 3. Bound Identity。
    //
    //    旧実装は peer_id を uuid、座標を乱数で決めて申告していた。
    //    座標が自己申告だと、狙った topicHash の隣に着地して K-nearest の
    //    保持者になったり、特定ノードを取り囲んで eclipse したりが無コストで
    //    できる (本家 AETHER 18.5.3)。
    //
    //    peerId は Ed25519 公開鍵のハッシュ、座標は peerId のハッシュとし、
    //    NodeId PoW (Argon2id) で鍵グラインドのコストを立てる。
    let tracker_url = std::env::var("SIGNALING_URL").unwrap_or_else(|_| "ws://localhost:3000/ws".to_string());
    let pow_params = NODE_ID_POW;
    let seed = load_or_create_seed()?;
    let identity = Arc::new(NodeIdentity::from_seed(&seed, &pow_params)?);
    let my_peer_id = identity.peer_id.clone();

    info!(
        "System initialized. Peer ID: {}, bound ring position: {:.6}",
        my_peer_id, identity.position
    );

    // 4. Create Core Event & Routing Channels
    let (event_tx, event_rx) = mpsc::unbounded_channel::<NetworkEvent>();
    let (mailbox_tx, mailbox_rx) = mpsc::unbounded_channel::<NetworkEvent>();
    
    let (peers_tx, mut peers_rx) = mpsc::unbounded_channel::<Vec<SignalingPeerInfo>>();
    let (signal_rx_tx, mut signal_rx_rx) = mpsc::unbounded_channel::<serde_json::Value>();

    // 5. Connect to Signaling Tracker Server
    let is_seed = true;
    let is_cache = true;
    let signaling = Arc::new(SignalingClient::connect(
        &tracker_url,
        my_peer_id.clone(),
        hex::encode(identity.pubkey()),
        identity.pow_counter,
        is_seed,
        is_cache,
        peers_tx,
        signal_rx_tx,
    ).await?);
    
    info!("Established connection to tracker server at {}", tracker_url);

    // 6. Spawn PeerManager Actor
    let (pm_cmd_tx, pm_ctrl_tx) = PeerManager::spawn(
        my_peer_id.clone(),
        event_tx,
        signaling.get_tx(),
    );

    // 7. Spawn Gossip and Mailbox Core Actors
    let _gossip_handle = GossipActor::spawn(
        identity.clone(),
        pow_params,
        event_rx,
        pm_cmd_tx.clone(),
        pm_ctrl_tx.clone(),
        mailbox_tx,
    );
    
    let _mailbox_handle = MailboxActor::spawn(
        store,
        mailbox_rx,
        pm_cmd_tx,
    );

    info!("All core actors (PeerManager, Gossip, Mailbox) running successfully");

    // 8. Event Translator Loop
    // Listens to raw signals from the tracker and maps them to clean actor control messages.
    loop {
        tokio::select! {
            // New peer candidates returned by the tracker
            Some(peer_list) = peers_rx.recv() => {
                for peer in peer_list {
                    // position は渡さない。PeerManager が peerId から導出する。
                    let _ = pm_ctrl_tx.send(PeerManagerControl::InitiateConnection {
                        peer_id: peer.peer_id,
                    });
                }
            }
            // Raw SDP/ICE relay frames from peers routed through the tracker
            Some(signal) = signal_rx_rx.recv() => {
                if let Some(sid) = signal.get("senderId").and_then(|v| v.as_str()) {
                    let _ = pm_ctrl_tx.send(PeerManagerControl::HandleIncomingSignal {
                        sender_id: sid.to_string(),
                        payload: signal,
                    });
                }
            }
            // Graceful shutdown handling
            _ = tokio::signal::ctrl_c() => {
                info!("Shutdown signal received. Terminating Aether Cache gracefully...");
                break;
            }
        }
    }

    Ok(())
}
