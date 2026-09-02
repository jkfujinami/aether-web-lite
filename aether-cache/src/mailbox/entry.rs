//! DHT に保存されるエントリの検証。
//!
//! エントリの中身は「JsonBinary で直列化した GossipPacket」である
//! (ブラウザ側 BoardOrchestrator / ThreadOrchestrator が publish しているもの)。
//! したがって保管ノードは鍵を持っていなくても
//!
//!   - CHK: packet_id == SHA256(コミット済みヘッダ)
//!   - PoW: 難易度が MIN_DIFFICULTY 以上で、実際に解けている
//!   - サイズ・未来日付
//!
//! を検証できる。中身が何かは分からないまま (Schrödinger)、
//! 「少なくとも PoW を払った、改竄されていない構造物である」ことだけを保証する。
//!
//! 旧実装は handle_dht_message で届いたバイト列をそのまま SQLite に書いていた
//! (本家 18.7-⑦ が「任意の相手が無制限に書けるためディスク枯渇 DoS が成立」
//! として指摘した状態)。
//!
//! ブラウザ側 `web/src/lib/network/mailbox/MailboxEntry.ts` と対応する。

use crate::gossip::validator::{check_packet, RejectReason, ValidateOptions};
use crate::network::messages::GossipPacket;

/// 1 エントリのバイト長上限
pub const MAX_ENTRY_BYTES: usize = 16 * 1024;
/// 1 メッセージで受け付けるエントリ数
pub const MAX_ENTRIES_PER_MESSAGE: usize = 64;
/// 1 トピックあたりの保持エントリ数
pub const MAX_ENTRIES_PER_TOPIC: usize = 512;
/// 保持するトピック総数
pub const MAX_TOPICS: usize = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryReject {
    TooLarge,
    NotJson,
    Packet(RejectReason),
}

/// topicHash は SHA-256(64桁) か SHA-512(128桁) の小文字 hex
pub fn is_valid_topic_hash(topic_hash: &str) -> bool {
    (topic_hash.len() == 64 || topic_hash.len() == 128)
        && topic_hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 1 エントリを検証する。
///
/// `allow_stale: true` で検証するのが要点。DHT は過去ログの保管庫なので、
/// 何日も前のパケットが正当に入っている。ライブゴシップと同じ 15 分の
/// ドリフト検査を掛けると過去ログ同期が丸ごと壊れる。
pub fn check_entry(entry: &[u8], now_ms: u64) -> Result<GossipPacket, EntryReject> {
    if entry.is_empty() || entry.len() > MAX_ENTRY_BYTES {
        return Err(EntryReject::TooLarge);
    }

    let packet: GossipPacket = serde_json::from_slice(entry).map_err(|_| EntryReject::NotJson)?;

    check_packet(&packet, ValidateOptions { now_ms, allow_stale: true })
        .map_err(EntryReject::Packet)?;

    Ok(packet)
}

/// エントリ配列をふるいに掛け、通ったものだけを返す。
///
/// 同一メッセージ内の重複 (packet_id 単位) は 1 件に畳む。
pub fn filter_valid_entries(entries: &[Vec<u8>], now_ms: u64) -> (Vec<Vec<u8>>, Vec<EntryReject>) {
    let mut accepted = Vec::new();
    let mut rejected = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for entry in entries.iter().take(MAX_ENTRIES_PER_MESSAGE) {
        match check_entry(entry, now_ms) {
            Ok(packet) => {
                if seen.insert(packet.packet_id) {
                    accepted.push(entry.clone());
                }
            }
            Err(reason) => rejected.push(reason),
        }
    }

    (accepted, rejected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::pow::{PowCommittedHeader, MIN_DIFFICULTY, NONCE_SIZE};
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

    fn serialize(p: &GossipPacket) -> Vec<u8> {
        serde_json::to_vec(p).unwrap()
    }

    #[test]
    fn accepts_valid_entry() {
        let p = valid_packet();
        let entry = serialize(&p);
        assert!(check_entry(&entry, p.timestamp).is_ok());
    }

    /// 旧実装はここが完全に素通しだった。
    #[test]
    fn rejects_entry_without_pow() {
        let mut p = valid_packet();
        p.pow_difficulty = 0;
        p.packet_id = p.committed_header().packet_id().unwrap();
        assert_eq!(
            check_entry(&serialize(&p), p.timestamp),
            Err(EntryReject::Packet(RejectReason::InsufficientPow))
        );
    }

    #[test]
    fn rejects_tampered_entry() {
        let p = valid_packet();
        let mut tampered = p.clone();
        let mut bytes = tampered.payload.bytes().to_vec();
        bytes[0] ^= 0xff;
        tampered.payload = JsonBytes::from_vec(bytes);
        assert!(check_entry(&serialize(&tampered), p.timestamp).is_err());
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(check_entry(b"", 0), Err(EntryReject::TooLarge));
        assert_eq!(check_entry(&vec![0u8; MAX_ENTRY_BYTES + 1], 0), Err(EntryReject::TooLarge));
        assert_eq!(check_entry(b"{not json", 0), Err(EntryReject::NotJson));
        assert_eq!(check_entry(b"\"just a string\"", 0), Err(EntryReject::NotJson));
    }

    #[test]
    fn accepts_old_entries_but_not_future_dated() {
        let p = valid_packet();
        let entry = serialize(&p);
        // 30 日前の投稿でも過去ログとしては正当
        assert!(check_entry(&entry, p.timestamp + 30 * 24 * 3600 * 1000).is_ok());
        // 未来日付は拒否
        assert_eq!(
            check_entry(&entry, p.timestamp - 3600 * 1000),
            Err(EntryReject::Packet(RejectReason::TimeDrift))
        );
    }

    #[test]
    fn filters_and_dedupes() {
        let good = serialize(&valid_packet());
        let mut bad_packet = valid_packet();
        bad_packet.pow_difficulty = 0;
        bad_packet.packet_id = bad_packet.committed_header().packet_id().unwrap();
        let bad = serialize(&bad_packet);

        let now = valid_packet().timestamp;
        let (accepted, rejected) =
            filter_valid_entries(&[good.clone(), good.clone(), bad, vec![]], now);

        assert_eq!(accepted.len(), 1, "duplicates must collapse to one");
        assert_eq!(rejected.len(), 2);
    }

    #[test]
    fn caps_entries_per_message() {
        let good = serialize(&valid_packet());
        let now = valid_packet().timestamp;
        let many: Vec<Vec<u8>> = (0..MAX_ENTRIES_PER_MESSAGE + 100).map(|_| good.clone()).collect();
        let (accepted, _) = filter_valid_entries(&many, now);
        assert_eq!(accepted.len(), 1); // 全部同じ packet_id なので 1 件
    }

    #[test]
    fn validates_topic_hash_format() {
        assert!(is_valid_topic_hash(&"a".repeat(64)));
        assert!(is_valid_topic_hash(&"0".repeat(128)));
        assert!(!is_valid_topic_hash(&"a".repeat(63)));
        assert!(!is_valid_topic_hash(&"A".repeat(64)));
        assert!(!is_valid_topic_hash("../../etc/passwd"));
        assert!(!is_valid_topic_hash(""));
        assert!(!is_valid_topic_hash(&"g".repeat(64)));
    }
}
