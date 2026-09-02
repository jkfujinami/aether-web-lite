use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

/// A memory-efficient LRU cache with TTL for deduplicating packet IDs.
/// Because it is owned entirely inside the GossipActor, it requires no internal Mutex/Locks.
pub struct SeenCache {
    cache: HashMap<String, Instant>,
    order: VecDeque<String>,
    max_size: usize,
    ttl: Duration,
}

impl SeenCache {
    pub fn new(max_size: usize, ttl_secs: u64) -> Self {
        Self {
            cache: HashMap::new(),
            order: VecDeque::new(),
            max_size,
            ttl: Duration::from_secs(ttl_secs),
        }
    }

    pub fn has(&mut self, id: &str) -> bool {
        if let Some(timestamp) = self.cache.get(id) {
            if timestamp.elapsed() < self.ttl {
                return true;
            } else {
                self.cache.remove(id);
            }
        }
        false
    }

    pub fn add(&mut self, id: String) {
        if self.cache.contains_key(&id) {
            return;
        }

        self.cache.insert(id.clone(), Instant::now());
        self.order.push_back(id);

        if self.order.len() > self.max_size {
            if let Some(oldest) = self.order.pop_front() {
                self.cache.remove(&oldest);
            }
        }
    }

    pub fn cleanup(&mut self) {
        while let Some(oldest) = self.order.front() {
            if let Some(ts) = self.cache.get(oldest) {
                if ts.elapsed() > self.ttl {
                    let id = self.order.pop_front().unwrap();
                    self.cache.remove(&id);
                } else {
                    break;
                }
            } else {
                self.order.pop_front();
            }
        }
    }
}
