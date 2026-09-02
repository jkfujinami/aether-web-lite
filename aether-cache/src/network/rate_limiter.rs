//! 隣人ごとのトークンバケット。
//!
//! 本家 AETHER 18.11.3:
//!
//! > 「PoW は主役ではない。ゴシップ網の本来の防御は暗号ではなく、
//! >   隣人ごとのレート制限である。」
//!
//! 次数 d、隣人 1 人あたり R 件/秒に制限すると、受信レートの上限が d×R に
//! 構造的に頭打ちになる。攻撃者の資源 (ハッシュ能力・ASIC) がいくらあっても、
//! 注入口がコネクション数で決まるようになる。
//!
//! ブラウザ側 `web/src/lib/network/RateLimiter.ts` と同じ設計。

use std::collections::HashMap;
use std::time::Instant;

#[derive(Debug, Clone, Copy)]
pub struct RateLimitConfig {
    /// 定常レート (件/秒)
    pub rate_per_sec: f64,
    /// バースト許容量
    pub burst: f64,
}

/// メッセージ種別ごとの予算カテゴリ
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Category {
    Gossip,
    DhtPut,
    DhtGet,
    Pex,
    Handshake,
    Signaling,
}

impl Category {
    pub fn config(self) -> RateLimitConfig {
        match self {
            Category::Gossip => RateLimitConfig { rate_per_sec: 20.0, burst: 60.0 },
            Category::DhtPut => RateLimitConfig { rate_per_sec: 5.0, burst: 30.0 },
            Category::DhtGet => RateLimitConfig { rate_per_sec: 5.0, burst: 20.0 },
            Category::Pex => RateLimitConfig { rate_per_sec: 1.0, burst: 5.0 },
            // NodeId PoW の検証は Argon2id 1 回 (~0.3ms) と重いので特に絞る
            Category::Handshake => RateLimitConfig { rate_per_sec: 0.2, burst: 3.0 },
            Category::Signaling => RateLimitConfig { rate_per_sec: 10.0, burst: 40.0 },
        }
    }
}

struct Bucket {
    tokens: f64,
    last_refill: Instant,
}

/// ピア単位・カテゴリ単位で独立したバケットを持つ。
/// DHT_PUT を撃ち込まれても GOSSIP の予算は減らない。
pub struct RateLimiter {
    buckets: HashMap<(String, Category), Bucket>,
    dropped: HashMap<Category, u64>,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

impl RateLimiter {
    pub fn new() -> Self {
        Self { buckets: HashMap::new(), dropped: HashMap::new() }
    }

    /// 1 件分の予算を消費する。予算が無ければ false (=そのメッセージを捨てる)。
    pub fn allow(&mut self, peer_id: &str, category: Category) -> bool {
        self.allow_at(peer_id, category, Instant::now())
    }

    /// 時刻を明示するテスト用の入口
    pub fn allow_at(&mut self, peer_id: &str, category: Category, now: Instant) -> bool {
        let config = category.config();
        let key = (peer_id.to_string(), category);

        let bucket = self.buckets.entry(key).or_insert(Bucket {
            tokens: config.burst,
            last_refill: now,
        });

        let elapsed = now.saturating_duration_since(bucket.last_refill).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * config.rate_per_sec).min(config.burst);
        bucket.last_refill = now;

        if bucket.tokens < 1.0 {
            *self.dropped.entry(category).or_insert(0) += 1;
            return false;
        }
        bucket.tokens -= 1.0;
        true
    }

    /// ピア切断時に状態を捨てる
    pub fn forget(&mut self, peer_id: &str) {
        self.buckets.retain(|(id, _), _| id != peer_id);
    }

    pub fn dropped_count(&self, category: Category) -> u64 {
        self.dropped.get(&category).copied().unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn allows_up_to_burst() {
        let mut rl = RateLimiter::new();
        let now = Instant::now();
        let burst = Category::Pex.config().burst as usize;
        for i in 0..burst {
            assert!(rl.allow_at("peer", Category::Pex, now), "#{i}");
        }
        assert!(!rl.allow_at("peer", Category::Pex, now));
    }

    #[test]
    fn flood_is_capped() {
        let mut rl = RateLimiter::new();
        let now = Instant::now();
        let mut passed = 0;
        for _ in 0..100_000 {
            if rl.allow_at("attacker", Category::Gossip, now) {
                passed += 1;
            }
        }
        assert_eq!(passed, Category::Gossip.config().burst as usize);
        assert!(rl.dropped_count(Category::Gossip) > 0);
    }

    #[test]
    fn refills_over_time_up_to_burst() {
        let mut rl = RateLimiter::new();
        let start = Instant::now();
        let cfg = Category::Gossip.config();
        for _ in 0..cfg.burst as usize {
            rl.allow_at("peer", Category::Gossip, start);
        }
        assert!(!rl.allow_at("peer", Category::Gossip, start));

        // 1 秒後には rate_per_sec 個だけ回復する
        let later = start + Duration::from_secs(1);
        let mut passed = 0;
        for _ in 0..1000 {
            if rl.allow_at("peer", Category::Gossip, later) {
                passed += 1;
            }
        }
        assert_eq!(passed, cfg.rate_per_sec as usize);

        // どれだけ時間が経ってもバースト上限で頭打ち
        let much_later = start + Duration::from_secs(3600);
        let mut passed2 = 0;
        for _ in 0..1000 {
            if rl.allow_at("peer", Category::Gossip, much_later) {
                passed2 += 1;
            }
        }
        assert_eq!(passed2, cfg.burst as usize);
    }

    #[test]
    fn buckets_are_isolated_per_peer() {
        let mut rl = RateLimiter::new();
        let now = Instant::now();
        for _ in 0..1000 {
            rl.allow_at("attacker", Category::Gossip, now);
        }
        assert!(!rl.allow_at("attacker", Category::Gossip, now));
        assert!(rl.allow_at("honest", Category::Gossip, now));
    }

    #[test]
    fn buckets_are_isolated_per_category() {
        let mut rl = RateLimiter::new();
        let now = Instant::now();
        for _ in 0..1000 {
            rl.allow_at("peer", Category::DhtPut, now);
        }
        assert!(!rl.allow_at("peer", Category::DhtPut, now));
        // DHT を撃たれても Gossip の予算は無傷
        assert!(rl.allow_at("peer", Category::Gossip, now));
    }

    #[test]
    fn forget_releases_state() {
        let mut rl = RateLimiter::new();
        let now = Instant::now();
        for _ in 0..1000 {
            rl.allow_at("peer", Category::Gossip, now);
        }
        assert!(!rl.allow_at("peer", Category::Gossip, now));
        rl.forget("peer");
        assert!(rl.allow_at("peer", Category::Gossip, now));
    }
}
