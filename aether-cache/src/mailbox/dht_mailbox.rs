use crate::network::messages::{JsonBytes, P2PMessage};
use crate::storage::StorageBackend;
use anyhow::Result;
use std::sync::Arc;
use tracing::info;

pub struct DHTMailbox {
    store: Arc<dyn StorageBackend>,
}

impl DHTMailbox {
    pub fn new(store: Arc<dyn StorageBackend>) -> Self {
        Self { store }
    }

    pub async fn handle_message(
        &self,
        msg: P2PMessage,
        peer_id: &str,
    ) -> Result<Option<P2PMessage>> {
        match msg {
            P2PMessage::DhtPut {
                topic_hash,
                entries,
            } => {
                info!(
                    "[DHT] Received put for {} ({} items) from {}",
                    topic_hash,
                    entries.len(),
                    peer_id
                );
                let raw_entries: Vec<Vec<u8>> =
                    entries.into_iter().map(|jb| jb.bytes().to_vec()).collect();

                self.store.put(&topic_hash, raw_entries)?;
                Ok(None)
            }
            P2PMessage::DhtGet { topic_hash, req_id } => {
                info!("[DHT] Received get for {} from {}", topic_hash, peer_id);
                let entries = self.store.get(&topic_hash)?;
                let json_entries: Vec<JsonBytes> =
                    entries.into_iter().map(JsonBytes::from_vec).collect();

                Ok(Some(P2PMessage::DhtRes {
                    topic_hash,
                    req_id,
                    entries: json_entries,
                }))
            }
            _ => Ok(None),
        }
    }
}
