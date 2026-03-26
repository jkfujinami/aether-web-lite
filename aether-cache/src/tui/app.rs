use std::collections::VecDeque;
use crate::network::signaling_client::PeerInfo;

pub struct App {
    pub peer_id: String,
    pub position: f64,
    pub connected_peers: Vec<PeerInfo>,
    pub logs: VecDeque<String>,
    pub storage_stats: StorageStats,
    pub should_quit: bool,
}

pub struct StorageStats {
    pub topic_count: usize,
    pub total_size_kb: f64,
}

impl App {
    pub fn new(peer_id: String, position: f64) -> Self {
        Self {
            peer_id,
            position,
            connected_peers: Vec::new(),
            logs: VecDeque::with_capacity(50),
            storage_stats: StorageStats {
                topic_count: 0,
                total_size_kb: 0.0,
            },
            should_quit: false,
        }
    }

    pub fn log(&mut self, message: String) {
        if self.logs.len() >= 50 {
            self.logs.pop_front();
        }
        self.logs.push_back(message);
    }
}
