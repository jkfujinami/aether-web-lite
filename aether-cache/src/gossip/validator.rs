//! 鍵を持たない中継ノードでも実行できるパケット検証。
//!
//! ブラウザ側 `web/src/lib/network/gossip/PacketValidator.ts` と同じ判定を行う。
//! どちらか片方だけが緩いと、そこが網の穴になる。
//!
//! 旧実装 (Rust 側) は GossipPacket を一切検証せずに中継・保存していた。
//! ブラウザ側も `pow_difficulty` の自己申告をそのまま信じていたため、
//! 攻撃者は `pow_difficulty: 0` と書くだけで全ノードに受理された。

use crate::crypto::pow::{
    PowCommittedHeader, MAX_HOP_COUNT, MAX_PAYLOAD_SIZE, MAX_TIME_DRIFT_MS, NONCE_SIZE,
};
use crate::network::messages::GossipPacket;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectReason {
    BadPacketId,
    BadPayloadSize,
    BadNonceSize,
    BadHopCount,
    TimeDrift,
    PacketIdMismatch,
    InsufficientPow,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ValidateOptions {
    /// 現在時刻 (Unix ms)。
    ///
    /// 0 は「時刻検査を省く」を意味する。固定ベクタのテストでのみ使うこと。
    /// 実運用の経路は必ず [`now_ms()`] を渡す。
    /// ブラウザ側 (`PacketValidator`) にこの抜け道は無いので、
    /// テストで 0 を使うと両実装の判定がずれる点に注意。
    pub now_ms: u64,
    /// 過去方向のドリフト検査を省く。
    ///
    /// DHT (Mailbox) は過去ログの保管庫なので、そこに入っているパケットは
    /// 何日も前のものが正当にあり得る。ライブのゴシップと同じ検査を掛けると
    /// 過去ログ同期が丸ごと壊れる。未来方向は省かない。
    pub allow_stale: bool,
}

impl GossipPacket {
    /// PoW と packet_id がコミットしているフィールドを取り出す
    pub fn committed_header(&self) -> PowCommittedHeader<'_> {
        PowCommittedHeader {
            timestamp: self.timestamp,
            zone_id: self.zone_id,
            pow_difficulty: self.pow_difficulty,
            nonce: self.nonce.bytes(),
            payload: self.payload.bytes(),
        }
    }
}

/// パケットを検証する。`Ok(())` なら中継・保存してよい。
pub fn check_packet(packet: &GossipPacket, opts: ValidateOptions) -> Result<(), RejectReason> {
    if packet.packet_id.len() != 64 || !packet.packet_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(RejectReason::BadPacketId);
    }

    let header = packet.committed_header();

    // 1. サイズ制約
    if header.payload.is_empty() || header.payload.len() > MAX_PAYLOAD_SIZE {
        return Err(RejectReason::BadPayloadSize);
    }
    if header.nonce.len() != NONCE_SIZE {
        return Err(RejectReason::BadNonceSize);
    }

    // 2. hop_count 上限 (無限ループ防止)。PoW のコミット対象ではないので範囲検査のみ。
    if packet.hop_count > MAX_HOP_COUNT {
        return Err(RejectReason::BadHopCount);
    }

    // 3. 時刻制約
    if opts.now_ms > 0 {
        // 未来日付は常に拒否する
        if packet.timestamp > opts.now_ms + MAX_TIME_DRIFT_MS {
            return Err(RejectReason::TimeDrift);
        }
        if !opts.allow_stale && opts.now_ms.saturating_sub(packet.timestamp) > MAX_TIME_DRIFT_MS {
            return Err(RejectReason::TimeDrift);
        }
    }

    // 4. CHK: packet_id はコミット済みヘッダのハッシュでなければならない
    let expected = header.packet_id().ok_or(RejectReason::BadPacketId)?;
    if expected != packet.packet_id {
        return Err(RejectReason::PacketIdMismatch);
    }

    // 5. PoW。難易度の下限・上限はここで強制される。
    if !header.verify_pow(packet.pow_nonce) {
        return Err(RejectReason::InsufficientPow);
    }

    Ok(())
}

/// 現在時刻 (Unix ms)
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::pow::MIN_DIFFICULTY;
    use crate::network::messages::JsonBytes;

    fn valid_packet() -> GossipPacket {
        let nonce = vec![1u8; NONCE_SIZE];
        let payload = vec![2u8; 40];
        let header = PowCommittedHeader {
            timestamp: 1_700_000_000_000,
            zone_id: 3,
            pow_difficulty: MIN_DIFFICULTY,
            nonce: &nonce,
            payload: &payload,
        };
        let pow_nonce = header.solve_pow(5_000_000).unwrap();
        GossipPacket {
            packet_id: header.packet_id().unwrap(),
            hop_count: 0,
            pow_nonce,
            pow_difficulty: header.pow_difficulty,
            timestamp: header.timestamp,
            zone_id: header.zone_id,
            nonce: JsonBytes::from_vec(nonce),
            payload: JsonBytes::from_vec(payload),
        }
    }

    fn opts_at(now: u64) -> ValidateOptions {
        ValidateOptions { now_ms: now, allow_stale: false }
    }

    #[test]
    fn accepts_valid_packet() {
        let p = valid_packet();
        assert_eq!(check_packet(&p, opts_at(p.timestamp)), Ok(()));
    }

    /// 旧実装最大の穴。
    #[test]
    fn rejects_declared_difficulty_zero() {
        let mut p = valid_packet();
        p.pow_difficulty = 0;
        // packet_id も張り直して CHK は通してやる
        p.packet_id = p.committed_header().packet_id().unwrap();
        assert_eq!(
            check_packet(&p, opts_at(p.timestamp)),
            Err(RejectReason::InsufficientPow)
        );
    }

    #[test]
    fn rejects_tampered_packet_id() {
        let mut p = valid_packet();
        p.packet_id = "a".repeat(64);
        assert_eq!(
            check_packet(&p, opts_at(p.timestamp)),
            Err(RejectReason::PacketIdMismatch)
        );
    }

    #[test]
    fn rejects_tampered_payload() {
        let mut p = valid_packet();
        let mut bytes = p.payload.bytes().to_vec();
        bytes[0] ^= 0xff;
        p.payload = JsonBytes::from_vec(bytes);
        assert!(check_packet(&p, opts_at(p.timestamp)).is_err());
    }

    /// timestamp を書き換えて再放流する攻撃。
    #[test]
    fn rejects_timestamp_replay() {
        let mut p = valid_packet();
        let new_ts = p.timestamp + 20 * 60 * 1000;
        p.timestamp = new_ts;
        assert_eq!(
            check_packet(&p, opts_at(new_ts)),
            Err(RejectReason::PacketIdMismatch)
        );

        // packet_id もつじつま合わせした場合は PoW で落ちる
        p.packet_id = p.committed_header().packet_id().unwrap();
        assert_eq!(
            check_packet(&p, opts_at(new_ts)),
            Err(RejectReason::InsufficientPow)
        );
    }

    #[test]
    fn rejects_bad_sizes() {
        let mut p = valid_packet();
        p.payload = JsonBytes::from_vec(vec![]);
        assert_eq!(check_packet(&p, opts_at(0)), Err(RejectReason::BadPayloadSize));

        let mut p = valid_packet();
        p.payload = JsonBytes::from_vec(vec![0u8; MAX_PAYLOAD_SIZE + 1]);
        assert_eq!(check_packet(&p, opts_at(0)), Err(RejectReason::BadPayloadSize));

        let mut p = valid_packet();
        p.nonce = JsonBytes::from_vec(vec![0u8; 11]);
        assert_eq!(check_packet(&p, opts_at(0)), Err(RejectReason::BadNonceSize));
    }

    #[test]
    fn rejects_excessive_hop_count() {
        let mut p = valid_packet();
        p.hop_count = MAX_HOP_COUNT + 1;
        assert_eq!(check_packet(&p, opts_at(0)), Err(RejectReason::BadHopCount));
    }

    #[test]
    fn hop_count_within_limit_is_fine() {
        let mut p = valid_packet();
        p.hop_count = MAX_HOP_COUNT;
        assert_eq!(check_packet(&p, opts_at(p.timestamp)), Ok(()));
    }

    #[test]
    fn rejects_stale_live_packet_but_allows_stored_one() {
        let p = valid_packet();
        let much_later = p.timestamp + 30 * 24 * 60 * 60 * 1000;

        assert_eq!(
            check_packet(&p, opts_at(much_later)),
            Err(RejectReason::TimeDrift)
        );
        // DHT の過去ログとしては正当
        assert_eq!(
            check_packet(&p, ValidateOptions { now_ms: much_later, allow_stale: true }),
            Ok(())
        );
    }

    #[test]
    fn rejects_future_dated_packet_even_when_stale_allowed() {
        let p = valid_packet();
        let earlier = p.timestamp - MAX_TIME_DRIFT_MS - 1000;
        assert_eq!(
            check_packet(&p, ValidateOptions { now_ms: earlier, allow_stale: true }),
            Err(RejectReason::TimeDrift)
        );
    }

    #[test]
    fn rejects_malformed_packet_id() {
        let mut p = valid_packet();
        p.packet_id = "zz".repeat(32);
        assert_eq!(check_packet(&p, opts_at(0)), Err(RejectReason::BadPacketId));

        let mut p = valid_packet();
        p.packet_id = "abc".to_string();
        assert_eq!(check_packet(&p, opts_at(0)), Err(RejectReason::BadPacketId));
    }
}
