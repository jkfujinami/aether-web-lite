mod mailbox;
mod network;
mod storage;
mod tui;
mod gossip;

use anyhow::Result;
use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use network::messages::P2PMessage;
use network::ring_position::RingPosition;
use network::signaling_client::{PeerInfo as SignalingPeerInfo, SignalingClient};
use network::webrtc_peer::WebRTCPeer;
use crate::network::wire::WireCodec;
use ratatui::{backend::CrosstermBackend, Terminal};
use std::collections::HashMap;
use std::io;
use std::sync::Arc;
use storage::sqlite_store::SqliteStore;
use storage::StorageBackend;
use tokio::sync::{mpsc, Mutex};
use tui::app::App;
use mailbox::dht_mailbox::DHTMailbox;
use tokio::time::{self, Duration};
use gossip::seen_cache::SeenCache;
use rand::seq::SliceRandom;
use std::sync::OnceLock;
use rand::Rng; // Added for gen_bool

static SEEN_CACHE: OnceLock<SeenCache> = OnceLock::new();

fn get_seen_cache() -> &'static SeenCache {
    SEEN_CACHE.get_or_init(|| SeenCache::new(50_000, 900))
}

struct PeerMetadata {
    peer_id: String,
    position: f64,
    zones: Vec<u32>,
    rtc: Arc<WebRTCPeer>,
}

#[tokio::main]
async fn main() -> Result<()> {
    // ... Existing TUI/Init code ...
    // (Rest of the bootstrap remains similar, just adding logic in the data loop)
    // Setup terminal
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let tracker_url = std::env::var("SIGNALING_URL").unwrap_or_else(|_| "ws://localhost:3000/ws".to_string());
    let my_peer_id = format!("cache_{}", &uuid::Uuid::new_v4().to_string()[..8]);
    let ring_pos = RingPosition::random();

    let store: Arc<dyn StorageBackend> = Arc::new(SqliteStore::new("./mailbox.db")?);
    let mailbox = Arc::new(DHTMailbox::new(Arc::clone(&store)));

    let mut app = App::new(my_peer_id.clone(), ring_pos.value);
    
    let (peers_tx, mut peers_rx) = mpsc::unbounded_channel::<Vec<SignalingPeerInfo>>();
    let (signal_rx_tx, mut signal_rx_rx) = mpsc::unbounded_channel::<serde_json::Value>();
    let (data_tx, mut data_rx) = mpsc::unbounded_channel::<(String, Vec<u8>)>();

    let is_seed = true; // Set to true for this node to act as an entry point
    let is_cache = true;

    let signaling = Arc::new(SignalingClient::connect(
        &tracker_url,
        my_peer_id.clone(),
        ring_pos.value,
        is_seed,
        is_cache,
        peers_tx,
        signal_rx_tx,
    ).await?);

    let peers: Arc<Mutex<HashMap<String, PeerMetadata>>> = Arc::new(Mutex::new(HashMap::new()));
    let app_peers = Arc::clone(&peers);

    let mut interval = time::interval(Duration::from_millis(100));
    let mut cleanup_interval = time::interval(Duration::from_secs(3600)); // 1 hour
    app.log(format!("Started as {} at pos {:.4}", my_peer_id, ring_pos.value));

    loop {
        terminal.draw(|f| tui::ui::render(&mut app, f))?;

        tokio::select! {
            _ = cleanup_interval.tick() => {
                let _ = store.cleanup();
                get_seen_cache().cleanup();
            }
            _ = interval.tick() => {
                // Background update
                if let Ok(count) = store.topic_count() {
                    app.storage_stats.topic_count = count;
                }
                
                let p_map = app_peers.lock().await;
                app.connected_peers = p_map.values().map(|m| {
                    SignalingPeerInfo {
                        peer_id: m.peer_id.clone(),
                        position: m.position, 
                        zones: m.zones.clone(),
                    }
                }).collect();

                // Poll for terminal events without blocking
                if event::poll(Duration::from_millis(0))? {
                    if let Event::Key(key) = event::read()? {
                        if let KeyCode::Char('q') = key.code {
                            break;
                        }
                    }
                }
            }
            Some(peer_list) = peers_rx.recv() => {
                let mut p_map = peers.lock().await;
                for peer in peer_list {
                    if peer.peer_id != my_peer_id && !p_map.contains_key(&peer.peer_id) {
                        app.log(format!("Attempting link to {}", &peer.peer_id[..8]));
                        if let Ok(rtc) = WebRTCPeer::new(
                            peer.peer_id.clone(),
                            true,
                            signaling.get_tx(),
                            data_tx.clone(),
                        ).await {
                            p_map.insert(peer.peer_id.clone(), PeerMetadata {
                                peer_id: peer.peer_id.clone(),
                                position: peer.position,
                                zones: peer.zones.clone(),
                                rtc,
                            });
                        }
                    }
                }
            }
            Some(signal) = signal_rx_rx.recv() => {
                if let Some(sid) = signal.get("senderId").and_then(|v| v.as_str()) {
                    let mut p_map = peers.lock().await;
                    let rtc = if let Some(m) = p_map.get(sid) {
                        m.rtc.clone()
                    } else {
                        app.log(format!("Accepting link from {}", &sid[..8.min(sid.len())]));
                        match WebRTCPeer::new(
                            sid.to_string(),
                            false,
                            signaling.get_tx(),
                            data_tx.clone(),
                        ).await {
                            Ok(new_rtc) => {
                                let position = signal.get("position").and_then(|v| v.as_f64()).unwrap_or(0.0);
                                let zones = signal.get("zones").and_then(|v| v.as_array())
                                    .map(|a| a.iter().filter_map(|v| v.as_u64().map(|u| u as u32)).collect())
                                    .unwrap_or(vec![0]);
                                let cloned = new_rtc.clone();
                                p_map.insert(sid.to_string(), PeerMetadata {
                                    peer_id: sid.to_string(),
                                    position,
                                    zones,
                                    rtc: new_rtc,
                                });
                                cloned
                            }
                            Err(e) => {
                                app.log(format!("[ERR] Failed to create peer for {}: {}", &sid[..8.min(sid.len())], e));
                                continue;
                            }
                        }
                    };
                    drop(p_map);
                    let sig_val = signal.clone();
                    let sig_tx = signaling.get_tx();
                    let _ = rtc.handle_signal(sig_val, sid.to_string(), sig_tx).await;
                }
            }
            Some((peer_id, data)) = data_rx.recv() => {
                // Handle disconnection sentinel
                if data == b"__disconnected" {
                    let mut p_map = peers.lock().await;
                    if p_map.remove(&peer_id).is_some() {
                        app.log(format!("[DC] Peer {} disconnected", &peer_id[..8.min(peer_id.len())]));
                    }
                    continue;
                }

                if let Ok(msg) = WireCodec::decode_v2(&data) {
                    match msg {
                        P2PMessage::Join { peer_id: pid, position } => {
                            let mut p_map = peers.lock().await;
                            if let Some(m) = p_map.get_mut(&pid) {
                                m.position = position;
                            }
                        }
                        P2PMessage::Gossip { packet } => {
                            let cache = get_seen_cache();
                            if !cache.has(&packet.packet_id) {
                                cache.add(packet.packet_id.clone());
                                app.log(format!("[GOSSIP] Relay {}", &packet.packet_id[..8]));
                                let p_map = peers.lock().await;
                                for (pid, m) in p_map.iter() {
                                    if pid != &peer_id { // Exclude sender from relay
                                        let relay_msg = P2PMessage::Gossip { packet: packet.clone() };
                                        if let Ok(bin_data) = WireCodec::encode_v2(&relay_msg) {
                                            let _ = m.rtc.send(&bin_data).await;
                                        }
                                    }
                                }
                            }
                        }
                        P2PMessage::Stem { mut stem_ttl, packet, zone_id } => {
                            // Dandelion++: Stem phase handling
                            let mut rng = rand::thread_rng();
                            let should_fluff = stem_ttl == 0 || rng.gen_bool(0.1); // 10% chance to fluff

                            if should_fluff {
                                app.log(format!("[STEM->FLUFF] {}", &packet.packet_id[..8]));
                                let p_map = peers.lock().await;
                                for (pid, m) in p_map.iter() {
                                    if pid != &peer_id { // Exclude sender from relay
                                        let relay_msg = P2PMessage::Gossip { packet: packet.clone() };
                                        if let Ok(bin_data) = WireCodec::encode_v2(&relay_msg) {
                                            let _ = m.rtc.send(&bin_data).await;
                                        }
                                    }
                                }
                            } else {
                                stem_ttl -= 1;
                                let p_map = peers.lock().await;
                                let neighbors: Vec<&PeerMetadata> = p_map.values()
                                    .filter(|m| m.peer_id != peer_id) // Exclude sender from potential targets
                                    .collect();
                                
                                if let Some(target) = neighbors.choose(&mut rng) {
                                    app.log(format!("[STEM] Forwarding {} -> {}", &packet.packet_id[..8], &target.peer_id[..8]));
                                    let relay_msg = P2PMessage::Stem { stem_ttl, packet, zone_id };
                                    if let Ok(bin_data) = WireCodec::encode_v2(&relay_msg) {
                                        let _ = target.rtc.send(&bin_data).await;
                                    }
                                } else {
                                    // No other neighbors to forward to, forced fluff
                                    app.log(format!("[STEM->FLUFF] No neighbors for {}. Forced fluff.", &packet.packet_id[..8]));
                                    let relay_msg = P2PMessage::Gossip { packet: packet.clone() };
                                    if let Ok(bin_data) = WireCodec::encode_v2(&relay_msg) {
                                        for (pid, m) in p_map.iter() {
                                            if pid != &peer_id { let _ = m.rtc.send(&bin_data).await; }
                                        }
                                    }
                                }
                            }
                        }
                        P2PMessage::PexRequest { .. } => {
                            app.log(format!("[PEX] Request from {}", &peer_id[..8.min(peer_id.len())]));
                            let p_map = peers.lock().await;
                            
                            // Filter: exclude the requester themselves
                            let mut info_list: Vec<crate::network::messages::PeerInfo> = p_map.values()
                                .filter(|m| m.peer_id != peer_id)
                                .map(|m| crate::network::messages::PeerInfo {
                                    id: m.peer_id.clone(),
                                    position: m.position,
                                    zones: m.zones.clone(),
                                })
                                .collect();
                            
                            // Shuffle and limit to 6 to prevent hotspot formation
                            let mut rng = rand::thread_rng();
                            info_list.shuffle(&mut rng);
                            info_list.truncate(6);
                            
                            let resp = P2PMessage::PexResponse { peers: info_list };
                            if let Ok(bin_data) = WireCodec::encode_v2(&resp) {
                                if let Some(m) = p_map.get(&peer_id) {
                                    let _ = m.rtc.send(&bin_data).await;
                                }
                            }
                        }
                        P2PMessage::SdpRelay { target_peer_id, .. } | P2PMessage::IceRelay { target_peer_id, .. } => {
                            let p_map = peers.lock().await;
                            if let Some(target) = p_map.get(&target_peer_id) {
                                let _ = target.rtc.send(&data).await;
                            }
                        }
                        P2PMessage::Ping { ts } => {
                            // Automatically respond to Ping with Pong
                            let resp = P2PMessage::Pong { ts, echo_ts: ts };
                            if let Ok(bin_data) = WireCodec::encode_v2(&resp) {
                                let p_map = peers.lock().await;
                                if let Some(m) = p_map.get(&peer_id) {
                                    let _ = m.rtc.send(&bin_data).await;
                                }
                            }
                        }
                        _ => {
                            let response = mailbox.handle_message(msg, &peer_id).await?;
                            if let Some(resp) = response {
                                if let Ok(bin_data) = WireCodec::encode_v2(&resp) {
                                   let p_map = peers.lock().await;
                                   if let Some(m) = p_map.get(&peer_id) {
                                       let _ = m.rtc.send(&bin_data).await;
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

    // Restore terminal
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture
    )?;
    terminal.show_cursor()?;

    Ok(())
}
