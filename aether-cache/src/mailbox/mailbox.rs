use crate::gossip::validator::now_ms;
use crate::mailbox::entry::{
    filter_valid_entries, is_valid_topic_hash, MAX_ENTRIES_PER_MESSAGE, MAX_ENTRIES_PER_TOPIC,
    MAX_TOPICS,
};
use crate::network::messages::{JsonBytes, P2PMessage};
use crate::storage::StorageBackend;
use crate::{NetworkEvent, PeerManagerCommand};
use anyhow::Result;
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{error, info, warn};
use std::time::{Duration, Instant};

/// MailboxActor manages DHT PUT/GET messages and runs periodic database garbage collection.
pub struct MailboxActor {
    store: Arc<dyn StorageBackend>,
    mailbox_rx: mpsc::UnboundedReceiver<NetworkEvent>,
    pm_cmd_tx: mpsc::UnboundedSender<PeerManagerCommand>,
    cleanup_interval: Duration,
    last_cleanup: Instant,
}

impl MailboxActor {
    pub fn spawn(
        store: Arc<dyn StorageBackend>,
        mailbox_rx: mpsc::UnboundedReceiver<NetworkEvent>,
        pm_cmd_tx: mpsc::UnboundedSender<PeerManagerCommand>,
    ) -> tokio::task::JoinHandle<()> {
        let actor = Self {
            store,
            mailbox_rx,
            pm_cmd_tx,
            cleanup_interval: Duration::from_secs(3600), // 1 hour
            last_cleanup: Instant::now(),
        };
        tokio::spawn(actor.run())
    }

    async fn run(mut self) {
        info!("[MailboxActor] Actor started");
        
        loop {
            tokio::select! {
                Some(event) = self.mailbox_rx.recv() => {
                    if let NetworkEvent::MessageReceived { peer_id, message } = event {
                        if let Err(e) = self.handle_dht_message(peer_id, message).await {
                            error!("[MailboxActor] Error handling DHT message: {}", e);
                        }
                    }
                }
                // Periodic DB cleanups
                _ = tokio::time::sleep(Duration::from_secs(300)) => {
                    if self.last_cleanup.elapsed() >= self.cleanup_interval {
                        info!("[MailboxActor] Running background SQLite store cleanup...");
                        if let Err(e) = self.store.cleanup() {
                            error!("[MailboxActor] Cleanup error: {}", e);
                        }
                        self.last_cleanup = Instant::now();
                    }
                }
            }
        }
    }

    /// ★ PUT の検証 (旧実装はここが完全に素通しだった)
    ///
    /// 旧:
    /// ```ignore
    ///     let raw_entries = entries.into_iter().map(|jb| jb.bytes().to_vec()).collect();
    ///     self.store.put(&topic_hash, raw_entries)?;   // 無検証
    /// ```
    ///
    /// これにより誰でも「任意のスレッドの過去ログを捏造して差し込む」
    /// 「無関係なトピックに無制限に書いて SQLite を膨らませる」ができた
    /// (本家 18.7-⑦)。
    ///
    /// 現在は 3 段で縛る:
    ///   1. topicHash の形式
    ///   2. エントリ単位の PoW + CHK 検証 (鍵は不要)
    ///   3. 件数・トピック数の上限
    ///
    /// なお K-nearest 帰属検証はブラウザ側だけの制御である。キャッシュノードは
    /// 「広く保持する常駐ノード」という役割上、担当範囲で受け入れを絞らない。
    /// 代わりに容量上限が保護の主役になる。
    async fn handle_dht_message(&self, peer_id: String, msg: P2PMessage) -> Result<()> {
        match msg {
            P2PMessage::DhtPut { topic_hash, entries } => {
                if !is_valid_topic_hash(&topic_hash) {
                    warn!("[DHT] PUT rejected from {}: malformed topicHash", short(&peer_id));
                    return Ok(());
                }

                let raw: Vec<Vec<u8>> = entries
                    .into_iter()
                    .take(MAX_ENTRIES_PER_MESSAGE)
                    .map(|jb| jb.bytes().to_vec())
                    .collect();
                let (accepted, rejected) = filter_valid_entries(&raw, now_ms());

                if !rejected.is_empty() {
                    warn!(
                        "[DHT] PUT from {}: dropped {} invalid entries ({:?})",
                        short(&peer_id), rejected.len(), rejected.first()
                    );
                }
                if accepted.is_empty() {
                    return Ok(());
                }

                let existing = self.store.get(&topic_hash).unwrap_or_default();
                if existing.len() >= MAX_ENTRIES_PER_TOPIC {
                    warn!("[DHT] PUT rejected for {}: topic is full", &topic_hash[..8]);
                    return Ok(());
                }
                if existing.is_empty() && self.store.topic_count().unwrap_or(0) >= MAX_TOPICS {
                    warn!("[DHT] PUT rejected: topic capacity reached");
                    return Ok(());
                }

                let room = MAX_ENTRIES_PER_TOPIC - existing.len();
                let to_store: Vec<Vec<u8>> = accepted.into_iter().take(room).collect();
                info!(
                    "[DHT] Storing {} verified entries for {} from {}",
                    to_store.len(), &topic_hash[..8], short(&peer_id)
                );
                self.store.put(&topic_hash, to_store)?;
            }
            P2PMessage::DhtGet { topic_hash, req_id } => {
                if !is_valid_topic_hash(&topic_hash) || req_id.len() > 64 {
                    warn!("[DHT] GET rejected from {}: malformed request", short(&peer_id));
                    return Ok(());
                }
                info!("[DHT] Received DhtGet for {} from {}", &topic_hash[..8], short(&peer_id));
                let entries = self.store.get(&topic_hash)?;
                let json_entries: Vec<JsonBytes> = entries
                    .into_iter()
                    .take(MAX_ENTRIES_PER_MESSAGE)
                    .map(JsonBytes::from_vec)
                    .collect();

                let _ = self.pm_cmd_tx.send(PeerManagerCommand::SendMessage {
                    peer_id,
                    message: P2PMessage::DhtRes { topic_hash, req_id, entries: json_entries },
                });
            }
            // 検証済みの Gossip パケットを保管ノードとして受け取る経路。
            // GossipActor が既に CHK + PoW を通しているので、ここでは
            // シリアライズして保存するだけでよい。
            P2PMessage::Gossip { packet } => {
                if let Ok(bytes) = serde_json::to_vec(&packet) {
                    if bytes.len() <= crate::mailbox::entry::MAX_ENTRY_BYTES {
                        // zone_id ではなく packet_id をキーにすると分散しすぎるため、
                        // ここではアーカイブ用トピックにまとめる。
                        let _ = self.store.put(&archive_topic(&packet.packet_id), vec![bytes]);
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
}

fn short(id: &str) -> &str {
    if id.len() >= 8 { &id[..8] } else { id }
}

/// Gossip 由来のアーカイブ用トピック。packet_id の先頭 64 桁をそのまま使う。
fn archive_topic(packet_id: &str) -> String {
    packet_id.chars().take(64).collect()
}
