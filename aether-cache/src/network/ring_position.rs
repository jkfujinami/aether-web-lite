use serde::{Deserialize, Serialize};

use crate::crypto::node_identity::derive_position;

/// リング座標。
///
/// 旧実装の `RingPosition::random()` は座標を乱数で決めており、JOIN で相手に
/// 申告していた。つまり座標は自己申告であり、「狙った topicHash の隣に着地して
/// K-nearest の保持者になる」「特定ノードを取り囲んで eclipse する」が
/// 無コストで可能だった (本家 AETHER 18.5.3)。
///
/// 現在は Bound Identity に置き換えてある:
///
/// ```text
///     position = SHA256("AETHER/v3/position" ‖ peerId)
///     peerId   = SHA256("AETHER/v3/peerid"   ‖ pubkey)[0..16]  (+ NodeId PoW)
/// ```
///
/// 座標は peerId の純粋関数なので、ネットワーク上で座標を送る必要が無い。
/// 受信側は相手の peerId から自分で計算する。
#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
pub struct RingPosition {
    pub value: f64,
}

impl RingPosition {
    pub fn new(value: f64) -> Self {
        Self { value }
    }

    /// peerId からリング座標を導出する。
    ///
    /// ネットワークから受け取ったピアの座標は必ずこれで計算すること。
    /// 相手が名乗った数値をそのまま使ってはならない。
    pub fn for_peer(peer_id: &str) -> f64 {
        derive_position(peer_id)
    }

    pub fn of(peer_id: &str) -> Self {
        Self { value: Self::for_peer(peer_id) }
    }

    /// リング上の 2 点間の最短距離 [0, 0.5]
    pub fn distance(a: f64, b: f64) -> f64 {
        let diff = (a - b).abs();
        if diff > 0.5 {
            1.0 - diff
        } else {
            diff
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn position_is_deterministic_from_peer_id() {
        let id = "9bf361b6706d6251f49efbe9f02823fa";
        assert_eq!(RingPosition::for_peer(id), RingPosition::for_peer(id));
        assert_eq!(RingPosition::of(id).value, RingPosition::for_peer(id));
    }

    #[test]
    fn distance_wraps_around_the_ring() {
        assert!((RingPosition::distance(0.1, 0.2) - 0.1).abs() < 1e-12);
        assert!((RingPosition::distance(0.95, 0.05) - 0.1).abs() < 1e-12);
        assert!((RingPosition::distance(0.0, 0.5) - 0.5).abs() < 1e-12);
        assert_eq!(RingPosition::distance(0.42, 0.42), 0.0);
    }

    #[test]
    fn distance_is_symmetric() {
        for (a, b) in [(0.1, 0.9), (0.25, 0.75), (0.0, 0.3)] {
            assert_eq!(RingPosition::distance(a, b), RingPosition::distance(b, a));
        }
    }
}
