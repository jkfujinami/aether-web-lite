//! TypeScript 実装との相互運用テスト。
//!
//! ブラウザ (web/) と キャッシュノード (aether-cache/) は同じ暗号プリミティブを
//! 独立に実装している。どこか 1 箇所でもバイト列の組み方がずれると、片方が
//! 作ったパケットをもう片方が「PoW 不正」として全部捨てたり、peerId から計算する
//! リング座標が食い違って DHT の担当がずれたりする。しかも通常のテストでは
//! 双方が「自分の実装内で整合」してしまうため気付けない。
//!
//! ベクタの出所:
//!     cd web && npx tsx tests/vectors/generate.ts
//!
//! ベクタを更新したら必ずこのテストを走らせること。

use aether_cache::crypto::node_identity::{
    derive_peer_id, derive_position, node_id_pow_hash, verify_signed_claim, NodeClaim,
    NodeIdPowParams, NodeIdentity,
};
use aether_cache::crypto::pow::{meets_difficulty, pow_hash, PowCommittedHeader};
use serde_json::Value;

const VECTORS: &str = include_str!("../../web/tests/vectors/interop_vectors.json");

fn vectors() -> Value {
    serde_json::from_str(VECTORS).expect("interop vectors must be valid JSON")
}

fn hex_of(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().expect("expected hex string")).expect("expected valid hex")
}

#[test]
fn gossip_pow_preimage_matches_typescript() {
    let v = vectors();
    let g = &v["gossipPow"];
    let nonce = hex_of(&g["header"]["nonce"]);
    let payload = hex_of(&g["header"]["payload"]);

    let header = PowCommittedHeader {
        timestamp: g["header"]["timestamp"].as_u64().unwrap(),
        zone_id: g["header"]["zone_id"].as_u64().unwrap() as u32,
        pow_difficulty: g["header"]["pow_difficulty"].as_u64().unwrap() as u32,
        nonce: &nonce,
        payload: &payload,
    };

    assert_eq!(
        hex::encode(header.preimage().unwrap()),
        g["preimage"].as_str().unwrap(),
        "PoW プリイメージが TS 実装と一致しない"
    );
}

#[test]
fn packet_id_matches_typescript() {
    let v = vectors();
    let g = &v["gossipPow"];
    let nonce = hex_of(&g["header"]["nonce"]);
    let payload = hex_of(&g["header"]["payload"]);

    let header = PowCommittedHeader {
        timestamp: g["header"]["timestamp"].as_u64().unwrap(),
        zone_id: g["header"]["zone_id"].as_u64().unwrap() as u32,
        pow_difficulty: g["header"]["pow_difficulty"].as_u64().unwrap() as u32,
        nonce: &nonce,
        payload: &payload,
    };

    assert_eq!(
        header.packet_id().unwrap(),
        g["packetId"].as_str().unwrap(),
        "packet_id (CHK) が TS 実装と一致しない"
    );
}

#[test]
fn pow_hash_matches_typescript() {
    let v = vectors();
    let g = &v["gossipPow"];
    let nonce = hex_of(&g["header"]["nonce"]);
    let payload = hex_of(&g["header"]["payload"]);

    let header = PowCommittedHeader {
        timestamp: g["header"]["timestamp"].as_u64().unwrap(),
        zone_id: g["header"]["zone_id"].as_u64().unwrap() as u32,
        pow_difficulty: g["header"]["pow_difficulty"].as_u64().unwrap() as u32,
        nonce: &nonce,
        payload: &payload,
    };
    let preimage = header.preimage().unwrap();

    assert_eq!(
        hex::encode(pow_hash(&preimage, 0)),
        g["powHashAtNonce0"].as_str().unwrap()
    );

    let solved = g["solvedNonce"].as_u64().unwrap();
    assert_eq!(
        hex::encode(pow_hash(&preimage, solved)),
        g["powHashAtSolvedNonce"].as_str().unwrap()
    );
}

#[test]
fn typescript_solved_nonce_verifies_in_rust() {
    // 「ブラウザが作ったパケットをキャッシュノードが受理する」ことの直接の確認。
    let v = vectors();
    let g = &v["gossipPow"];
    let nonce = hex_of(&g["header"]["nonce"]);
    let payload = hex_of(&g["header"]["payload"]);

    let header = PowCommittedHeader {
        timestamp: g["header"]["timestamp"].as_u64().unwrap(),
        zone_id: g["header"]["zone_id"].as_u64().unwrap() as u32,
        pow_difficulty: g["header"]["pow_difficulty"].as_u64().unwrap() as u32,
        nonce: &nonce,
        payload: &payload,
    };

    assert!(
        header.verify_pow(g["solvedNonce"].as_u64().unwrap()),
        "TS が解いた PoW を Rust が検証できない"
    );

    // 難易度も両実装で同じ意味であること
    let preimage = header.preimage().unwrap();
    let h = pow_hash(&preimage, g["solvedNonce"].as_u64().unwrap());
    assert!(meets_difficulty(&h, header.pow_difficulty));
}

#[test]
fn rust_solved_nonce_would_verify_in_typescript() {
    // 逆方向。Rust が探索した nonce が同じプリイメージで成立する
    // (TS 側は同じ preimage と同じ判定式を使うので、これで十分)。
    let v = vectors();
    let g = &v["gossipPow"];
    let nonce = hex_of(&g["header"]["nonce"]);
    let payload = hex_of(&g["header"]["payload"]);

    let header = PowCommittedHeader {
        timestamp: g["header"]["timestamp"].as_u64().unwrap(),
        zone_id: g["header"]["zone_id"].as_u64().unwrap() as u32,
        pow_difficulty: g["header"]["pow_difficulty"].as_u64().unwrap() as u32,
        nonce: &nonce,
        payload: &payload,
    };

    let solved = header.solve_pow(5_000_000).expect("Rust must find a nonce");
    // TS の探索も 0 から昇順なので、最初に見つかる解は一致する
    assert_eq!(solved, g["solvedNonce"].as_u64().unwrap());
}

#[test]
fn bound_identity_matches_typescript() {
    let v = vectors();
    let b = &v["boundIdentity"];
    let pubkey = hex_of(&b["pubkey"]);

    assert_eq!(
        derive_peer_id(&pubkey),
        b["peerId"].as_str().unwrap(),
        "peerId の導出が TS 実装と一致しない"
    );

    let expected_position = b["position"].as_f64().unwrap();
    let actual_position = derive_position(b["peerId"].as_str().unwrap());
    assert_eq!(
        actual_position, expected_position,
        "リング座標が TS 実装と一致しない (DHT の担当がずれる)"
    );
}

#[test]
fn seed_derived_keypair_matches_typescript() {
    // libsodium の crypto_sign_seed_keypair と ed25519-dalek の
    // SigningKey::from_bytes が同じ公開鍵を出すことの確認。
    let v = vectors();
    let b = &v["boundIdentity"];
    let seed: [u8; 32] = hex_of(&b["seed"]).try_into().unwrap();

    let params = NodeIdPowParams { difficulty: 0, ops_limit: 1, mem_limit: 8192 };
    let identity = NodeIdentity::from_seed(&seed, &params).unwrap();

    assert_eq!(hex::encode(identity.pubkey()), b["pubkey"].as_str().unwrap());
    assert_eq!(identity.peer_id, b["peerId"].as_str().unwrap());
}

#[test]
fn node_id_pow_matches_typescript() {
    // libsodium crypto_pwhash(ALG_ARGON2ID13) と argon2 クレートの
    // パラメータ対応 (memlimit バイト → m_cost KiB, lanes=1) の確認。
    let v = vectors();
    let n = &v["nodeIdPow"];
    let pubkey = hex_of(&v["boundIdentity"]["pubkey"]);

    let params = NodeIdPowParams {
        difficulty: n["params"]["difficulty"].as_u64().unwrap() as u32,
        ops_limit: n["params"]["opsLimit"].as_u64().unwrap() as u32,
        mem_limit: n["params"]["memLimit"].as_u64().unwrap() as u32,
    };

    assert_eq!(
        hex::encode(node_id_pow_hash(&pubkey, 0, &params).unwrap()),
        n["hashAtCounter0"].as_str().unwrap(),
        "Argon2id の出力が TS (libsodium) と一致しない"
    );

    let counter = n["counter"].as_u64().unwrap();
    assert_eq!(
        hex::encode(node_id_pow_hash(&pubkey, counter, &params).unwrap()),
        n["hashAtSolvedCounter"].as_str().unwrap()
    );
}

#[test]
fn typescript_node_id_claim_verifies_in_rust() {
    // ブラウザが採掘した identity を、キャッシュノードが受理できること。
    let v = vectors();
    let n = &v["nodeIdPow"];
    let b = &v["boundIdentity"];

    let params = NodeIdPowParams {
        difficulty: n["params"]["difficulty"].as_u64().unwrap() as u32,
        ops_limit: n["params"]["opsLimit"].as_u64().unwrap() as u32,
        mem_limit: n["params"]["memLimit"].as_u64().unwrap() as u32,
    };

    let claim = NodeClaim {
        peer_id: b["peerId"].as_str().unwrap().to_string(),
        pubkey: hex_of(&b["pubkey"]).try_into().unwrap(),
        pow_counter: n["counter"].as_u64().unwrap(),
    };

    let j = &v["joinSignature"];
    let challenge = hex_of(&j["challenge"]);
    let signature = hex_of(&j["signature"]);

    assert!(
        verify_signed_claim(&claim, &challenge, &signature, &challenge, &params),
        "TS が署名した JOIN を Rust が検証できない"
    );
}

#[test]
fn rust_signature_matches_typescript() {
    // 逆方向。同じ seed / challenge から同じ署名が出ること
    // (Ed25519 は決定的署名なのでバイト一致する)。
    let v = vectors();
    let b = &v["boundIdentity"];
    let j = &v["joinSignature"];

    let seed: [u8; 32] = hex_of(&b["seed"]).try_into().unwrap();
    let params = NodeIdPowParams { difficulty: 0, ops_limit: 1, mem_limit: 8192 };
    let identity = NodeIdentity::from_seed(&seed, &params).unwrap();

    let challenge = hex_of(&j["challenge"]);
    assert_eq!(
        hex::encode(identity.sign_challenge(&challenge)),
        j["signature"].as_str().unwrap(),
        "JOIN 署名のドメイン分離子かメッセージ組み立てがずれている"
    );
}

#[test]
fn join_domain_separator_is_stable() {
    // ドメイン分離子を変えると署名が通らなくなる = 全ピアが繋がらなくなる。
    // 値そのものをテストに書いておき、うっかり変更したら気付けるようにする。
    let v = vectors();
    assert_eq!(v["joinSignature"]["domain"].as_str().unwrap(), "AETHER/v3/join");
}
