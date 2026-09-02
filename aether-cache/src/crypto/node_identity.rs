//! Bound Identity (本家 AETHER 18.5.3)。
//!
//! ブラウザ側 `web/src/lib/crypto/NodeIdentity.ts` と完全に一致させること。
//! 一致は `tests/interop_vectors.rs` が固定ベクタで検証している。
//!
//! ```text
//!   peerId   = SHA256("AETHER/v3/peerid"   ‖ pubkey)[0..16]
//!   position = SHA256("AETHER/v3/position" ‖ peerId)[0..8] / 2^64
//! ```
//!
//! position は peerId の純粋関数なので、ネットワーク上で座標を申告する必要が
//! ない。旧実装 (`RingPosition::random()` + JOIN で position を申告) では
//! 攻撃者が狙った座標に着地して K-nearest の保持者になれた。

use anyhow::{anyhow, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::crypto::pow::meets_difficulty;

const PEER_ID_DOMAIN: &[u8] = b"AETHER/v3/peerid";
const POSITION_DOMAIN: &[u8] = b"AETHER/v3/position";
const JOIN_DOMAIN: &[u8] = b"AETHER/v3/join";

/// Argon2id の salt (16 バイト固定)。libsodium の crypto_pwhash_SALTBYTES と同じ長さ。
const NODE_ID_SALT: &[u8; 16] = b"AETHER/v3/nodeid";

/// peerId のバイト長 (hex 表記では 32 文字)
pub const PEER_ID_BYTES: usize = 16;

/// チャレンジのバイト長
pub const CHALLENGE_BYTES: usize = 32;

/// NodeId PoW のパラメータ。ブラウザ側 NodeIdPowParams と対応する。
#[derive(Debug, Clone, Copy)]
pub struct NodeIdPowParams {
    /// 要求する先頭ゼロビット数
    pub difficulty: u32,
    /// Argon2id opslimit (t_cost)
    pub ops_limit: u32,
    /// Argon2id memlimit (**bytes**)。argon2 クレートへは KiB に直して渡す。
    pub mem_limit: u32,
}

/// 既定パラメータ。ブラウザ側 NODE_ID_POW と一致させること。
pub const NODE_ID_POW: NodeIdPowParams = NodeIdPowParams {
    difficulty: 10,
    ops_limit: 1,
    mem_limit: 1 << 20,
};

/// テスト・開発用の軽量パラメータ。ブラウザ側 NODE_ID_POW_FAST と一致。
pub const NODE_ID_POW_FAST: NodeIdPowParams = NodeIdPowParams {
    difficulty: 4,
    ops_limit: 1,
    mem_limit: 8192,
};

/// ネットワーク上でピアが自分を名乗るときの主張。position は含まない。
#[derive(Debug, Clone)]
pub struct NodeClaim {
    pub peer_id: String,
    pub pubkey: [u8; 32],
    pub pow_counter: u64,
}

/// peerId = hex(SHA256("AETHER/v3/peerid" ‖ pubkey)[0..16])
pub fn derive_peer_id(pubkey: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(PEER_ID_DOMAIN);
    hasher.update(pubkey);
    hex::encode(&hasher.finalize()[..PEER_ID_BYTES])
}

/// position = SHA256("AETHER/v3/position" ‖ peerIdBytes)[0..8] / 2^64
///
/// peerId が hex として不正な場合は 0.0 を返す (呼び出し側は形式検査済みの
/// peerId しか渡さないが、壊れた入力で panic しないようにしておく)。
pub fn derive_position(peer_id: &str) -> f64 {
    let Ok(id_bytes) = hex::decode(peer_id) else {
        return 0.0;
    };
    let mut hasher = Sha256::new();
    hasher.update(POSITION_DOMAIN);
    hasher.update(&id_bytes);
    let digest = hasher.finalize();

    let mut head = [0u8; 8];
    head.copy_from_slice(&digest[..8]);
    // JS 側は Number(u64) / 2^64。f64 に落とす順序を合わせる。
    u64::from_be_bytes(head) as f64 / 18446744073709551616.0
}

/// peerId の形式検査 (Bound Identity では hex 32 文字に固定される)
pub fn is_valid_peer_id(peer_id: &str) -> bool {
    peer_id.len() == PEER_ID_BYTES * 2 && peer_id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// NodeId PoW のハッシュ: Argon2id(pubkey ‖ counter, salt=固定)
///
/// libsodium の `crypto_pwhash(32, pwd, salt, opslimit, memlimit, ALG_ARGON2ID13)`
/// と同じ出力になるよう、m_cost は memlimit をバイト→KiB に直して渡し、
/// lanes / threads は 1 に固定する。
pub fn node_id_pow_hash(pubkey: &[u8], counter: u64, params: &NodeIdPowParams) -> Result<[u8; 32]> {
    let mut input = Vec::with_capacity(pubkey.len() + 8);
    input.extend_from_slice(pubkey);
    input.extend_from_slice(&counter.to_be_bytes());

    let m_cost_kib = params.mem_limit / 1024;
    let argon = Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(m_cost_kib, params.ops_limit, 1, Some(32))
            .map_err(|e| anyhow!("invalid argon2 params: {e}"))?,
    );

    let mut out = [0u8; 32];
    argon
        .hash_password_into(&input, NODE_ID_SALT, &mut out)
        .map_err(|e| anyhow!("argon2 failure: {e}"))?;
    Ok(out)
}

/// peerId が pubkey に束縛されており、かつ NodeId PoW を満たすかを検証する。
///
/// 所有証明 (署名) は含まないので [`verify_signed_claim`] と併用すること。
pub fn verify_claim(claim: &NodeClaim, params: &NodeIdPowParams) -> bool {
    if !is_valid_peer_id(&claim.peer_id) {
        return false;
    }
    if derive_peer_id(&claim.pubkey) != claim.peer_id {
        return false;
    }
    if params.difficulty == 0 {
        return true;
    }
    match node_id_pow_hash(&claim.pubkey, claim.pow_counter, params) {
        Ok(hash) => meets_difficulty(&hash, params.difficulty),
        Err(_) => false,
    }
}

/// 所有証明つきの検証。
///
/// `expected_challenge` は「検証する側がその接続で生成して送った乱数」で
/// なければならない。これが無いと、他人の JOIN を傍受して再生するだけで
/// なりすませてしまう。
pub fn verify_signed_claim(
    claim: &NodeClaim,
    challenge: &[u8],
    signature: &[u8],
    expected_challenge: &[u8],
    params: &NodeIdPowParams,
) -> bool {
    if !verify_claim(claim, params) {
        return false;
    }
    if challenge.len() != expected_challenge.len() || challenge != expected_challenge {
        return false;
    }
    let Ok(sig_bytes) = <[u8; 64]>::try_from(signature) else {
        return false;
    };
    let Ok(vk) = VerifyingKey::from_bytes(&claim.pubkey) else {
        return false;
    };

    let mut msg = Vec::with_capacity(JOIN_DOMAIN.len() + challenge.len());
    msg.extend_from_slice(JOIN_DOMAIN);
    msg.extend_from_slice(challenge);

    vk.verify(&msg, &Signature::from_bytes(&sig_bytes)).is_ok()
}

/// 自ノードの identity。秘密鍵を持つ。
pub struct NodeIdentity {
    pub peer_id: String,
    pub position: f64,
    pub pow_counter: u64,
    signing_key: SigningKey,
}

impl NodeIdentity {
    /// 新しい identity を採掘する。
    ///
    /// 鍵ペアは固定してカウンタを回す。こうすると秘密鍵が変わらないので
    /// 「一度採掘したら保存して使い回す」が成立する。
    pub fn mine(params: &NodeIdPowParams) -> Result<Self> {
        use rand::RngCore;
        let mut seed = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut seed);
        Self::from_seed(&seed, params)
    }

    /// 決定的な seed から identity を作る (永続化からの復元・テスト用)
    pub fn from_seed(seed: &[u8; 32], params: &NodeIdPowParams) -> Result<Self> {
        let signing_key = SigningKey::from_bytes(seed);
        let pubkey = signing_key.verifying_key().to_bytes();

        let pow_counter = if params.difficulty == 0 {
            0
        } else {
            let mut counter = 0u64;
            loop {
                if meets_difficulty(&node_id_pow_hash(&pubkey, counter, params)?, params.difficulty) {
                    break counter;
                }
                counter += 1;
                if counter > 1 << 32 {
                    return Err(anyhow!("NodeId PoW search exhausted"));
                }
            }
        };

        let peer_id = derive_peer_id(&pubkey);
        let position = derive_position(&peer_id);
        Ok(Self { peer_id, position, pow_counter, signing_key })
    }

    pub fn pubkey(&self) -> [u8; 32] {
        self.signing_key.verifying_key().to_bytes()
    }

    pub fn claim(&self) -> NodeClaim {
        NodeClaim {
            peer_id: self.peer_id.clone(),
            pubkey: self.pubkey(),
            pow_counter: self.pow_counter,
        }
    }

    /// 相手のチャレンジに署名する
    pub fn sign_challenge(&self, challenge: &[u8]) -> [u8; 64] {
        let mut msg = Vec::with_capacity(JOIN_DOMAIN.len() + challenge.len());
        msg.extend_from_slice(JOIN_DOMAIN);
        msg.extend_from_slice(challenge);
        self.signing_key.sign(&msg).to_bytes()
    }
}

/// 検証する側が送るチャレンジを生成する
pub fn new_challenge() -> [u8; CHALLENGE_BYTES] {
    use rand::RngCore;
    let mut buf = [0u8; CHALLENGE_BYTES];
    rand::thread_rng().fill_bytes(&mut buf);
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: NodeIdPowParams = NODE_ID_POW_FAST;

    fn identity(seed_byte: u8) -> NodeIdentity {
        NodeIdentity::from_seed(&[seed_byte; 32], &P).unwrap()
    }

    #[test]
    fn peer_id_is_bound_to_pubkey() {
        let a = identity(1);
        assert_eq!(derive_peer_id(&a.pubkey()), a.peer_id);
        assert!(is_valid_peer_id(&a.peer_id));
    }

    #[test]
    fn position_is_derived_and_in_range() {
        let a = identity(1);
        assert_eq!(derive_position(&a.peer_id), a.position);
        assert!((0.0..1.0).contains(&a.position));
    }

    #[test]
    fn valid_claim_is_accepted() {
        let a = identity(2);
        assert!(verify_claim(&a.claim(), &P));
    }

    /// 旧実装では peerId が乱数だったので、狙った座標の ID を自由に名乗れた。
    #[test]
    fn rejects_peer_id_not_bound_to_pubkey() {
        let a = identity(3);
        let b = identity(4);
        let forged = NodeClaim { peer_id: b.peer_id.clone(), ..a.claim() };
        assert!(!verify_claim(&forged, &P));

        let target = NodeClaim { peer_id: "ff".repeat(PEER_ID_BYTES), ..a.claim() };
        assert!(!verify_claim(&target, &P));
    }

    #[test]
    fn rejects_malformed_peer_id() {
        let a = identity(5);
        for bad in ["short", &"ZZ".repeat(16), &"ab".repeat(20), ""] {
            let claim = NodeClaim { peer_id: bad.to_string(), ..a.claim() };
            assert!(!verify_claim(&claim, &P), "{bad} must be rejected");
        }
    }

    #[test]
    fn rejects_claim_without_node_id_pow() {
        // PoW を解いていない鍵を探す
        for seed in 0u8..=255 {
            let sk = SigningKey::from_bytes(&[seed; 32]);
            let pubkey = sk.verifying_key().to_bytes();
            let claim = NodeClaim { peer_id: derive_peer_id(&pubkey), pubkey, pow_counter: 0 };
            if !verify_claim(&claim, &P) {
                return; // 期待どおり拒否された
            }
        }
        panic!("expected at least one key that fails NodeId PoW at counter 0");
    }

    #[test]
    fn signed_claim_round_trip() {
        let a = identity(6);
        let challenge = new_challenge();
        let sig = a.sign_challenge(&challenge);
        assert!(verify_signed_claim(&a.claim(), &challenge, &sig, &challenge, &P));
    }

    /// 傍受した JOIN をそのまま別の接続で流す攻撃。
    #[test]
    fn rejects_replayed_join() {
        let a = identity(7);
        let captured_challenge = new_challenge();
        let captured_sig = a.sign_challenge(&captured_challenge);

        let fresh_challenge = new_challenge();
        assert!(!verify_signed_claim(
            &a.claim(),
            &captured_challenge,
            &captured_sig,
            &fresh_challenge,
            &P
        ));
    }

    /// 他人の公開鍵を貼り付けただけ (秘密鍵を持っていない) の JOIN。
    #[test]
    fn rejects_signature_from_another_key() {
        let a = identity(8);
        let b = identity(9);
        let challenge = new_challenge();
        let sig_from_b = b.sign_challenge(&challenge);
        assert!(!verify_signed_claim(&a.claim(), &challenge, &sig_from_b, &challenge, &P));
    }

    #[test]
    fn rejects_tampered_signature() {
        let a = identity(10);
        let challenge = new_challenge();
        let mut sig = a.sign_challenge(&challenge);
        sig[0] ^= 0xff;
        assert!(!verify_signed_claim(&a.claim(), &challenge, &sig, &challenge, &P));
    }

    #[test]
    fn rejects_short_signature() {
        let a = identity(11);
        let challenge = new_challenge();
        assert!(!verify_signed_claim(&a.claim(), &challenge, &[0u8; 10], &challenge, &P));
    }

    #[test]
    fn from_seed_is_deterministic() {
        let a = NodeIdentity::from_seed(&[42u8; 32], &P).unwrap();
        let b = NodeIdentity::from_seed(&[42u8; 32], &P).unwrap();
        assert_eq!(a.peer_id, b.peer_id);
        assert_eq!(a.position, b.position);
        assert_eq!(a.pow_counter, b.pow_counter);
    }

    #[test]
    fn positions_spread_over_the_ring() {
        let mut buckets = [0usize; 10];
        for seed in 0u8..=200 {
            let sk = SigningKey::from_bytes(&[seed; 32]);
            let pid = derive_peer_id(&sk.verifying_key().to_bytes());
            buckets[(derive_position(&pid) * 10.0) as usize] += 1;
        }
        // どのバケットにも入らない、という極端な偏りがないこと
        assert!(buckets.iter().all(|&c| c > 0), "buckets: {buckets:?}");
    }

    #[test]
    fn derive_position_does_not_panic_on_garbage() {
        // hex として読めない入力は 0.0 にフォールバックする。
        // 空文字は hex としては妥当 (0 バイト) なので通常のハッシュ経路を通る。
        // いずれにせよ panic せず [0, 1) に収まることが要件。
        for bad in ["not-hex", "", "zz", "abc"] {
            let pos = derive_position(bad);
            assert!((0.0..1.0).contains(&pos), "{bad} -> {pos}");
        }
        assert_eq!(derive_position("not-hex"), 0.0);
        // 形式検査は is_valid_peer_id が担う
        assert!(!is_valid_peer_id(""));
        assert!(!is_valid_peer_id("not-hex"));
    }
}
