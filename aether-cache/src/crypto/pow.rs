//! Gossip パケットの PoW。
//!
//! ブラウザ側 `web/src/lib/crypto/PowPolicy.ts` とバイト単位で一致させること。
//! ずれると「片方が作ったパケットをもう片方が全部捨てる」という形で壊れる。
//! 一致は `tests/interop_vectors.rs` が固定ベクタで検証している。
//!
//! ハッシュ関数は SHA-256。本家 AETHER 18.11 の訂正どおり、
//! 全ノードが全件検証するのでメモリハード関数は使わない
//! (フラッド耐性は難易度 D だけで決まり、ハッシュ単価は約分で消える)。

use sha2::{Digest, Sha256};

/// ネットワークが受理する最小難易度。
/// `web/src/lib/crypto/PowPolicy.ts` の POW_POLICY.MIN_DIFFICULTY と一致させること。
pub const MIN_DIFFICULTY: u32 = 8;

/// 上限。
pub const MAX_DIFFICULTY: u32 = 32;

/// ペイロード上限 (bytes)
pub const MAX_PAYLOAD_SIZE: usize = 2 * 1024;

/// AEAD nonce 長 (ChaCha20-Poly1305 IETF)
pub const NONCE_SIZE: usize = 12;

/// 許容する時刻ドリフト (ms)
pub const MAX_TIME_DRIFT_MS: u64 = 15 * 60 * 1000;

/// 中継ホップ数の上限
pub const MAX_HOP_COUNT: u32 = 30;

/// プリイメージのドメイン分離子 (ちょうど 16 バイト)
const GOSSIP_DOMAIN: &[u8; 16] = b"AETHER/v3/gossip";

/// PoW と packet_id がコミットする不変フィールド群。
/// `hop_count` と `pow_nonce` は含まない (前者は中継で変化し、後者は探索変数)。
#[derive(Debug, Clone)]
pub struct PowCommittedHeader<'a> {
    pub timestamp: u64,
    pub zone_id: u32,
    pub pow_difficulty: u32,
    pub nonce: &'a [u8],
    pub payload: &'a [u8],
}

impl PowCommittedHeader<'_> {
    /// 正準プリイメージを組み立てる。
    ///
    /// レイアウト (すべてビッグエンディアン):
    /// ```text
    ///   domain          16 bytes
    ///   timestamp        8 bytes  u64
    ///   zone_id          4 bytes  u32
    ///   pow_difficulty   1 byte   u8
    ///   nonce_len        2 bytes  u16
    ///   nonce            nonce_len bytes
    ///   payload_len      4 bytes  u32
    ///   payload          payload_len bytes
    /// ```
    ///
    /// 長さ前置きにより、フィールド境界を動かした別の入力が
    /// 同じバイト列に潰れることを防ぐ。
    pub fn preimage(&self) -> Option<Vec<u8>> {
        if self.pow_difficulty > u8::MAX as u32 {
            return None;
        }
        if self.nonce.len() > u16::MAX as usize {
            return None;
        }
        if self.payload.len() > u32::MAX as usize {
            return None;
        }

        let mut buf = Vec::with_capacity(35 + self.nonce.len() + self.payload.len());
        buf.extend_from_slice(GOSSIP_DOMAIN);
        buf.extend_from_slice(&self.timestamp.to_be_bytes());
        buf.extend_from_slice(&self.zone_id.to_be_bytes());
        buf.push(self.pow_difficulty as u8);
        buf.extend_from_slice(&(self.nonce.len() as u16).to_be_bytes());
        buf.extend_from_slice(self.nonce);
        buf.extend_from_slice(&(self.payload.len() as u32).to_be_bytes());
        buf.extend_from_slice(self.payload);
        Some(buf)
    }

    /// packet_id = hex(SHA-256(preimage))  … CHK (Content Hash Key)
    pub fn packet_id(&self) -> Option<String> {
        let preimage = self.preimage()?;
        Some(hex::encode(Sha256::digest(preimage)))
    }

    /// PoW の検証。難易度の下限・上限もここで強制する。
    pub fn verify_pow(&self, pow_nonce: u64) -> bool {
        if self.pow_difficulty < MIN_DIFFICULTY || self.pow_difficulty > MAX_DIFFICULTY {
            return false;
        }
        let Some(preimage) = self.preimage() else {
            return false;
        };
        meets_difficulty(&pow_hash(&preimage, pow_nonce), self.pow_difficulty)
    }

    /// PoW を探索する (キャッシュノードが自分で投稿する用途は無いのでテスト向け)。
    pub fn solve_pow(&self, max_iterations: u64) -> Option<u64> {
        let preimage = self.preimage()?;
        (0..max_iterations)
            .find(|&n| meets_difficulty(&pow_hash(&preimage, n), self.pow_difficulty))
    }
}

/// PoW ハッシュ: SHA-256(preimage ‖ pow_nonce_be_u64)
pub fn pow_hash(preimage: &[u8], pow_nonce: u64) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(preimage);
    hasher.update(pow_nonce.to_be_bytes());
    hasher.finalize().into()
}

/// ハッシュの先頭ゼロビット数が difficulty 以上かを判定する。
pub fn meets_difficulty(hash: &[u8], difficulty: u32) -> bool {
    if difficulty == 0 {
        return true;
    }
    if difficulty as usize > hash.len() * 8 {
        return false;
    }

    let full_bytes = (difficulty / 8) as usize;
    if hash[..full_bytes].iter().any(|&b| b != 0) {
        return false;
    }

    let remain_bits = difficulty % 8;
    if remain_bits > 0 {
        let mask = 0xffu8 << (8 - remain_bits);
        if hash[full_bytes] & mask != 0 {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header<'a>(nonce: &'a [u8], payload: &'a [u8]) -> PowCommittedHeader<'a> {
        PowCommittedHeader {
            timestamp: 1_700_000_000_000,
            zone_id: 3,
            pow_difficulty: MIN_DIFFICULTY,
            nonce,
            payload,
        }
    }

    #[test]
    fn difficulty_counts_leading_zero_bits() {
        assert!(meets_difficulty(&[0x00, 0xff], 8));
        assert!(!meets_difficulty(&[0x00, 0xff], 9));
        assert!(meets_difficulty(&[0x0f], 4));
        assert!(!meets_difficulty(&[0x0f], 5));
        assert!(meets_difficulty(&[0x07], 5));
        assert!(!meets_difficulty(&[0x07], 6));
        assert!(meets_difficulty(&[0xff], 0));
        assert!(!meets_difficulty(&[0u8; 32], 257));
    }

    #[test]
    fn preimage_is_deterministic_and_field_sensitive() {
        let nonce = [1u8; 12];
        let payload = [2u8; 40];
        let base = header(&nonce, &payload).preimage().unwrap();
        assert_eq!(base, header(&nonce, &payload).preimage().unwrap());

        let mut h = header(&nonce, &payload);
        h.timestamp += 1;
        assert_ne!(base, h.preimage().unwrap());

        let mut h = header(&nonce, &payload);
        h.zone_id += 1;
        assert_ne!(base, h.preimage().unwrap());

        let mut h = header(&nonce, &payload);
        h.pow_difficulty += 1;
        assert_ne!(base, h.preimage().unwrap());
    }

    #[test]
    fn length_prefix_removes_boundary_ambiguity() {
        let a = PowCommittedHeader {
            timestamp: 1,
            zone_id: 0,
            pow_difficulty: 8,
            nonce: b"ab",
            payload: b"cd",
        };
        let b = PowCommittedHeader {
            timestamp: 1,
            zone_id: 0,
            pow_difficulty: 8,
            nonce: b"abc",
            payload: b"d",
        };
        assert_ne!(a.preimage().unwrap(), b.preimage().unwrap());
    }

    #[test]
    fn solved_nonce_verifies() {
        let nonce = [1u8; 12];
        let payload = [2u8; 40];
        let h = header(&nonce, &payload);
        let solved = h.solve_pow(1_000_000).unwrap();
        assert!(h.verify_pow(solved));
        assert!(!h.verify_pow(solved.wrapping_add(1)));
    }

    /// 旧実装最大の穴: difficulty を 0 と申告するだけで PoW を回避できた。
    #[test]
    fn rejects_declared_difficulty_below_minimum() {
        let nonce = [1u8; 12];
        let payload = [2u8; 40];
        for d in 0..MIN_DIFFICULTY {
            let h = PowCommittedHeader {
                pow_difficulty: d,
                ..header(&nonce, &payload)
            };
            // その難易度としては正当な解を与えても、ポリシー違反なので拒否
            let solved = h.solve_pow(200_000).unwrap_or(0);
            assert!(!h.verify_pow(solved), "difficulty {d} must be rejected");
        }
    }

    #[test]
    fn rejects_difficulty_above_maximum() {
        let nonce = [1u8; 12];
        let payload = [2u8; 40];
        let h = PowCommittedHeader {
            pow_difficulty: MAX_DIFFICULTY + 1,
            ..header(&nonce, &payload)
        };
        assert!(!h.verify_pow(0));
    }

    /// 旧実装は PoW が ciphertext だけを覆っていたため、timestamp を
    /// 書き換えるだけで再放流できた。
    #[test]
    fn timestamp_tampering_invalidates_pow() {
        let nonce = [1u8; 12];
        let payload = [2u8; 40];
        let h = header(&nonce, &payload);
        let solved = h.solve_pow(1_000_000).unwrap();

        let replayed = PowCommittedHeader {
            timestamp: h.timestamp + 20 * 60 * 1000,
            ..header(&nonce, &payload)
        };
        assert!(!replayed.verify_pow(solved));
    }

    #[test]
    fn packet_id_changes_with_any_committed_field() {
        let nonce = [1u8; 12];
        let payload = [2u8; 40];
        let base = header(&nonce, &payload).packet_id().unwrap();

        let mut h = header(&nonce, &payload);
        h.zone_id += 1;
        assert_ne!(base, h.packet_id().unwrap());

        let other_payload = [3u8; 40];
        assert_ne!(base, header(&nonce, &other_payload).packet_id().unwrap());
    }
}
