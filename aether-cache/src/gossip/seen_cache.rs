use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 重複パケットの配信を防ぐための LRU キャッシュ
pub struct SeenCache {
    cache: Mutex<HashMap<String, Instant>>,
    order: Mutex<VecDeque<String>>,
    max_size: usize,
    ttl: Duration,
}

impl SeenCache {
    pub fn new(max_size: usize, ttl_secs: u64) -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
            order: Mutex::new(VecDeque::new()),
            max_size,
            ttl: Duration::from_secs(ttl_secs),
        }
    }

    pub fn has(&self, id: &str) -> bool {
        let mut cache = self.cache.lock().unwrap();
        if let Some(timestamp) = cache.get(id) {
            if timestamp.elapsed() < self.ttl {
                return true;
            } else {
                // 期限切れ
                cache.remove(id);
                // order からの削除は cleanup でまとめて行う
            }
        }
        false
    }

    pub fn add(&self, id: String) {
        let mut cache = self.cache.lock().unwrap();
        let mut order = self.order.lock().unwrap();

        if cache.contains_key(&id) {
            return;
        }

        cache.insert(id.clone(), Instant::now());
        order.push_back(id);

        if order.len() > self.max_size {
            if let Some(oldest) = order.pop_front() {
                cache.remove(&oldest);
            }
        }
    }

    pub fn cleanup(&self) {
        let mut cache = self.cache.lock().unwrap();
        let mut order = self.order.lock().unwrap();
        
        while let Some(oldest) = order.front() {
            if let Some(ts) = cache.get(oldest) {
                if ts.elapsed() > self.ttl {
                    let id = order.pop_front().unwrap();
                    cache.remove(&id);
                } else {
                    break;
                }
            } else {
                order.pop_front();
            }
        }
    }
}
