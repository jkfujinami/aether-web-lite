//! ワイヤ符号化の相互運用テスト。
//!
//! ★ このファイルが無かったために起きたこと
//!
//! `JsonBytes` は `#[serde(untagged)]` の enum で、`Tagged {_type, data}` と
//! `Raw(Vec<u8>)` を受け分ける想定だった。しかし untagged は `deserialize_any`
//! を通るため **MsgPack の bin 型を受け取れなかった**。ブラウザの
//! `@msgpack/msgpack` は `Uint8Array` を bin 型で符号化するので、結果として
//! HELLO / JOIN / Gossip の nonce・payload / DHT のエントリ —— つまり
//! **バイト列を含むメッセージが Rust 側で 1 通も復号できていなかった**。
//!
//! 数値と文字列だけの PING/PONG は通っていたこと、そして受信側が
//! `if let Ok(msg) = decode_v2(..)` とエラーを握り潰していたことが重なり、
//! ログに一切の痕跡が残らなかった。
//!
//! 暗号プリミティブが両実装で一致していても (interop_vectors.rs は全部通っていた)、
//! フレームが解けなければ何も動かない。符号化そのものを固定ベクタで縛る。
//!
//! ベクタの出所:
//!     cd web && npx tsx tests/vectors/generate.ts

use aether_cache::network::messages::P2PMessage;
use aether_cache::network::wire::WireCodec;
use serde_json::Value;

const VECTORS: &str = include_str!("../../web/tests/vectors/interop_vectors.json");

fn vectors() -> Value {
    serde_json::from_str(VECTORS).expect("interop vectors must be valid JSON")
}

fn frame(name: &str) -> Vec<u8> {
    let v = vectors();
    let hex_str = v["wire"]["tsFrames"][name]
        .as_str()
        .unwrap_or_else(|| panic!("missing wire.tsFrames.{name}"));
    hex::decode(hex_str).expect("frame must be valid hex")
}

/// ベクタのパケットは固定時刻なので、検証はその時刻基準で行う
fn now_ms_for_vectors() -> u64 {
    let P2PMessage::Gossip { packet } = decode("gossip") else {
        panic!("expected Gossip");
    };
    packet.timestamp
}

fn decode(name: &str) -> P2PMessage {
    WireCodec::decode_v2(&frame(name))
        .unwrap_or_else(|e| panic!("failed to decode TS frame `{name}`: {e}"))
}

fn expected(key: &str) -> String {
    vectors()["wire"]["expected"][key]
        .as_str()
        .unwrap_or_else(|| panic!("missing wire.expected.{key}"))
        .to_string()
}

// ───────────────── TS → Rust (壊れていた方向) ─────────────────

#[test]
fn decodes_ping_from_typescript() {
    match decode("ping") {
        P2PMessage::Ping { ts } => {
            assert_eq!(ts, vectors()["wire"]["expected"]["pingTs"].as_f64().unwrap());
        }
        other => panic!("expected Ping, got {other:?}"),
    }
}

/// ★ 回帰テスト: MsgPack bin 型のバイト列を読めること
#[test]
fn decodes_hello_with_binary_challenge() {
    match decode("hello") {
        P2PMessage::Hello { challenge } => {
            assert_eq!(hex::encode(challenge.bytes()), expected("challenge"));
            assert_eq!(challenge.len(), 32);
        }
        other => panic!("expected Hello, got {other:?}"),
    }
}

/// ★ 回帰テスト: 複数のバイト列フィールドを含むメッセージ
#[test]
fn decodes_join_with_binary_fields() {
    match decode("join") {
        P2PMessage::Join { peer_id, pubkey, pow_counter, challenge, signature } => {
            assert_eq!(peer_id, expected("peerId"));
            assert_eq!(hex::encode(pubkey.bytes()), expected("pubkey"));
            assert_eq!(
                pow_counter,
                vectors()["wire"]["expected"]["powCounter"].as_u64().unwrap()
            );
            assert_eq!(hex::encode(challenge.bytes()), expected("challenge"));
            assert_eq!(hex::encode(signature.bytes()), expected("signature"));
            assert_eq!(signature.len(), 64, "Ed25519 signature must survive intact");
        }
        other => panic!("expected Join, got {other:?}"),
    }
}

/// ★ 回帰テスト: ブラウザが作った JOIN を Rust が実際に検証できること。
/// 符号化と暗号検証をまたいだ、いちばん実運用に近い確認。
#[test]
fn typescript_join_frame_passes_signature_verification() {
    use aether_cache::crypto::node_identity::{verify_signed_claim, NodeClaim, NODE_ID_POW_FAST};

    let P2PMessage::Join { peer_id, pubkey, pow_counter, challenge, signature } = decode("join")
    else {
        panic!("expected Join");
    };

    let claim = NodeClaim {
        peer_id,
        pubkey: pubkey.bytes().try_into().expect("pubkey must be 32 bytes"),
        pow_counter,
    };

    assert!(
        verify_signed_claim(
            &claim,
            challenge.bytes(),
            signature.bytes(),
            challenge.bytes(),
            &NODE_ID_POW_FAST,
        ),
        "ブラウザが署名した JOIN を Rust が検証できない"
    );
}

/// ★ 回帰テスト: Gossip の nonce / payload が bin 型で往復すること
#[test]
fn decodes_gossip_packet_with_binary_payload() {
    match decode("gossip") {
        P2PMessage::Gossip { packet } => {
            assert_eq!(packet.packet_id, expected("gossipPacketId"));
            assert_eq!(hex::encode(packet.payload.bytes()), expected("gossipPayload"));
            assert_eq!(hex::encode(packet.nonce.bytes()), expected("gossipNonce"));
            assert_eq!(packet.hop_count, 3);
        }
        other => panic!("expected Gossip, got {other:?}"),
    }
}

/// ★ 回帰テスト: ブラウザが作ったパケットを Rust の検証器が受理すること
#[test]
fn typescript_gossip_frame_passes_validation() {
    use aether_cache::gossip::validator::{check_packet, ValidateOptions};

    let P2PMessage::Gossip { packet } = decode("gossip") else {
        panic!("expected Gossip");
    };

    // 時刻検査は固定ベクタなので省く (allow_stale + now=timestamp)
    let opts = ValidateOptions { now_ms: packet.timestamp, allow_stale: true };
    assert_eq!(
        check_packet(&packet, opts),
        Ok(()),
        "ブラウザが作ったパケットを Rust が拒否している"
    );
}

#[test]
fn decodes_dht_put_with_entries() {
    match decode("dhtPut") {
        P2PMessage::DhtPut { topic_hash, entries } => {
            assert_eq!(topic_hash, expected("dhtTopicHash"));
            assert_eq!(entries.len(), 1);
            assert_eq!(hex::encode(entries[0].bytes()), expected("dhtEntry"));
        }
        other => panic!("expected DhtPut, got {other:?}"),
    }
}

/// ★ ブラウザが DHT に入れた過去ログを Rust が検証できること。
/// エントリは `JsonBinary.stringify` された GossipPacket なので、
/// `{_type: "Uint8Array", data: [...]}` 形式の入れ子を解けなければならない。
#[test]
fn typescript_dht_entry_is_accepted_by_rust() {
    use aether_cache::mailbox::entry::check_entry;

    let P2PMessage::DhtPut { entries, .. } = decode("dhtPut") else {
        panic!("expected DhtPut");
    };

    let packet = check_entry(entries[0].bytes(), 0)
        .expect("ブラウザが保存した DHT エントリを Rust が検証できない");
    assert_eq!(packet.packet_id, expected("gossipPacketId"));
    assert_eq!(hex::encode(packet.payload.bytes()), expected("gossipPayload"));
}

#[test]
fn decodes_pex_response_without_position_or_zones() {
    match decode("pexResponse") {
        P2PMessage::PexResponse { peers } => {
            assert_eq!(peers.len(), 1);
            assert_eq!(peers[0].id, expected("peerId"));
        }
        other => panic!("expected PexResponse, got {other:?}"),
    }
}

// ───────────────── Rust → Rust の往復 ─────────────────

/// Rust が再符号化したものを Rust が読み戻せること。
/// bin 型で送るようになったので、この往復が壊れると TS 側も読めなくなる。
#[test]
fn rust_reencoding_round_trips() {
    for name in ["ping", "hello", "join", "gossip", "dhtPut", "pexResponse"] {
        let original = decode(name);
        let reencoded = WireCodec::encode_v2(&original)
            .unwrap_or_else(|e| panic!("failed to re-encode `{name}`: {e}"));
        let decoded = WireCodec::decode_v2(&reencoded)
            .unwrap_or_else(|e| panic!("failed to decode Rust-encoded `{name}`: {e}"));

        // 意味が保存されていること
        match (&original, &decoded) {
            (P2PMessage::Hello { challenge: a }, P2PMessage::Hello { challenge: b }) => {
                assert_eq!(a.bytes(), b.bytes(), "{name}");
            }
            (
                P2PMessage::Join { signature: a, pubkey: pa, .. },
                P2PMessage::Join { signature: b, pubkey: pb, .. },
            ) => {
                assert_eq!(a.bytes(), b.bytes(), "{name}");
                assert_eq!(pa.bytes(), pb.bytes(), "{name}");
            }
            (P2PMessage::Gossip { packet: a }, P2PMessage::Gossip { packet: b }) => {
                assert_eq!(a, b, "{name}");
            }
            (P2PMessage::DhtPut { entries: a, .. }, P2PMessage::DhtPut { entries: b, .. }) => {
                assert_eq!(a, b, "{name}");
            }
            _ => {}
        }
    }
}

/// Rust の符号化がバイト列を MsgPack bin 型で出すこと。
///
/// 旧実装は `{_type: "Uint8Array", data: [...]}` のマップで送っていた。
/// 本家 18.6.2 が「バイナリが約 2 倍に膨らむ」として不採用にした形式であり、
/// ここが戻るとブラウザ↔Rust の帯域が倍になる。
#[test]
fn rust_encodes_byte_arrays_as_msgpack_bin() {
    let hello = decode("hello");
    let encoded = WireCodec::encode_v2(&hello).unwrap();

    // bin8 (0xc4) + len 32 (0x20) が現れること
    assert!(
        encoded.windows(2).any(|w| w == [0xc4, 0x20]),
        "challenge must be encoded as MsgPack bin, got: {}",
        hex::encode(&encoded)
    );
    // 旧形式のキー "_type" が含まれないこと
    assert!(
        !encoded.windows(5).any(|w| w == b"_type"),
        "must not fall back to the {{_type, data}} representation"
    );
}

/// 旧 `{_type, data}` 形式も引き続き読めること (IndexedDB の過去データ対策)
#[test]
fn still_accepts_legacy_tagged_byte_representation() {
    #[derive(serde::Serialize)]
    struct LegacyHello {
        #[serde(rename = "type")]
        ty: &'static str,
        challenge: LegacyBytes,
    }
    #[derive(serde::Serialize)]
    struct LegacyBytes {
        #[serde(rename = "_type")]
        ty: &'static str,
        data: Vec<u8>,
    }

    let legacy = LegacyHello {
        ty: "hello",
        challenge: LegacyBytes { ty: "Uint8Array", data: vec![7u8; 32] },
    };
    let mut buf = vec![0x17u8]; // WireType::Hello
    buf.extend_from_slice(&rmp_serde::to_vec_named(&legacy).unwrap());

    match WireCodec::decode_v2(&buf).expect("legacy representation must still decode") {
        P2PMessage::Hello { challenge } => assert_eq!(challenge.bytes(), &[7u8; 32]),
        other => panic!("expected Hello, got {other:?}"),
    }
}

/// JSON 経由 (トラッカー中継) でもバイト列が往復すること
#[test]
fn json_transport_round_trips_byte_arrays() {
    let hello = decode("hello");
    let json = serde_json::to_string(&hello).unwrap();
    // serde_json は serialize_bytes を配列にフォールバックする
    let back: P2PMessage = serde_json::from_str(&json).unwrap();
    match (hello, back) {
        (P2PMessage::Hello { challenge: a }, P2PMessage::Hello { challenge: b }) => {
            assert_eq!(a.bytes(), b.bytes());
        }
        _ => panic!("expected Hello"),
    }
}

// ───────────────── Rust → TS ─────────────────

/// Rust が符号化したフレームを `web/tests/vectors/rust_wire_frames.json` に書き出す。
///
/// TypeScript 側の `web/tests/network/WireInterop.test.ts` がこれを読んで
/// デコードできることを確認する。逆方向 (TS → Rust) は上のテスト群が担うので、
/// この 2 つで両方向が縛られる。
///
/// 生成物はコミットしておくこと。Rust の符号化を変えると
/// `cargo test` がここを書き換え、続く `npm test` が差分を検出する。
#[test]
fn emit_rust_wire_frames_for_typescript() {
    use aether_cache::network::messages::{JsonBytes, PeerRef};

    let P2PMessage::Gossip { packet } = decode("gossip") else {
        panic!("expected Gossip");
    };
    let P2PMessage::Join { peer_id, pubkey, pow_counter, challenge, signature } = decode("join")
    else {
        panic!("expected Join");
    };

    let frames: Vec<(&str, P2PMessage)> = vec![
        ("ping", P2PMessage::Ping { ts: 1_700_000_000_000.0 }),
        ("pong", P2PMessage::Pong { ts: 1_700_000_000_000.0, echo_ts: 1_700_000_000_000.0 }),
        ("hello", P2PMessage::Hello { challenge: challenge.clone() }),
        (
            "join",
            P2PMessage::Join { peer_id: peer_id.clone(), pubkey, pow_counter, challenge, signature },
        ),
        ("gossip", P2PMessage::Gossip { packet: packet.clone() }),
        (
            "stem",
            P2PMessage::Stem { zone_id: packet.zone_id, packet: packet.clone() },
        ),
        (
            "dhtRes",
            P2PMessage::DhtRes {
                topic_hash: expected("dhtTopicHash"),
                req_id: "req_42".to_string(),
                entries: vec![JsonBytes::from_vec(
                    hex::decode(expected("dhtEntry")).unwrap(),
                )],
            },
        ),
        ("pexResponse", P2PMessage::PexResponse { peers: vec![PeerRef { id: peer_id }] }),
        // Hint は Rust 側が中継のときに再符号化する。TS が読めることを保証する。
        (
            "hint",
            P2PMessage::Hint {
                version: 1,
                ttl: 7,
                blind_tag: JsonBytes::from_vec(hex::decode(expected("hintBlindTag")).unwrap()),
                nonce: JsonBytes::from_vec(hex::decode(expected("hintNonce")).unwrap()),
                pow_nonce: vectors()["wire"]["expected"]["hintPowNonce"].as_u64().unwrap(),
                ciphertext: JsonBytes::from_vec(hex::decode(expected("hintCiphertext")).unwrap()),
            },
        ),
    ];

    let mut out = serde_json::Map::new();
    out.insert(
        "_comment".into(),
        Value::String(
            "Generated by `cargo test --test wire_interop` in aether-cache. \
             Consumed by web/tests/network/WireInterop.test.ts. Do not edit by hand."
                .into(),
        ),
    );
    for (name, msg) in frames {
        let encoded = WireCodec::encode_v2(&msg)
            .unwrap_or_else(|e| panic!("failed to encode `{name}`: {e}"));
        out.insert(name.to_string(), Value::String(hex::encode(encoded)));
    }

    // 期待値も添える (TS 側が中身を照合できるように)
    let mut exp = serde_json::Map::new();
    exp.insert("challenge".into(), Value::String(expected("challenge")));
    exp.insert("peerId".into(), Value::String(expected("peerId")));
    exp.insert("pubkey".into(), Value::String(expected("pubkey")));
    exp.insert("signature".into(), Value::String(expected("signature")));
    exp.insert("gossipPacketId".into(), Value::String(expected("gossipPacketId")));
    exp.insert("gossipPayload".into(), Value::String(expected("gossipPayload")));
    exp.insert("gossipNonce".into(), Value::String(expected("gossipNonce")));
    exp.insert("dhtTopicHash".into(), Value::String(expected("dhtTopicHash")));
    exp.insert("dhtEntry".into(), Value::String(expected("dhtEntry")));
    exp.insert("gossipHopCount".into(), Value::Number(packet.hop_count.into()));
    exp.insert("hintId".into(), Value::String(expected("hintId")));
    exp.insert("hintBlindTag".into(), Value::String(expected("hintBlindTag")));
    exp.insert("hintNonce".into(), Value::String(expected("hintNonce")));
    exp.insert("hintCiphertext".into(), Value::String(expected("hintCiphertext")));
    out.insert("expected".into(), Value::Object(exp));

    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../web/tests/vectors/rust_wire_frames.json");
    std::fs::write(path, serde_json::to_string_pretty(&Value::Object(out)).unwrap() + "\n")
        .expect("failed to write rust_wire_frames.json");
}

/// ★ 回帰テスト: ブラウザが送る STEM を Rust が読めること。
///
/// TS 側の Dandelion 実装が仕様 (docs/spec/step5_dandelion.md) から逸脱して
/// ワイヤ形式がズレていたため、Rust が
/// STEM を 1 通も復号できていなかった。TS→Rust の STEM テストが
/// 無かったので、実網で `Failed to decode ... (type=0x41)` が出るまで
/// 気付けなかった。
#[test]
fn decodes_stem_from_typescript() {
    let v = vectors();
    match decode("stem") {
        P2PMessage::Stem { zone_id, packet } => {
            assert_eq!(
                zone_id,
                v["wire"]["expected"]["stemZoneId"].as_u64().unwrap() as u32
            );
            assert_eq!(packet.packet_id, expected("gossipPacketId"));
            assert_eq!(hex::encode(packet.payload.bytes()), expected("gossipPayload"));
        }
        other => panic!("expected Stem, got {other:?}"),
    }
}

/// ★ TypeScript が作った HINT を Rust が読めるか。
///
/// キャッシュノードは板/スレッドの鍵を持たないため復号はできない。
/// 「形式が読める・id が一致する・PoW が通る」ところまでを確認する。
#[test]
fn decodes_hint_from_typescript() {
    use aether_cache::protocol::hint::{HintView, HINT_POW_DIFFICULTY};

    let v = vectors();
    match decode("hint") {
        P2PMessage::Hint { version, ttl, blind_tag, nonce, pow_nonce, ciphertext } => {
            assert_eq!(version, 1);
            assert!(ttl > 0, "放流直後の TTL は正");
            assert_eq!(hex::encode(blind_tag.bytes()), expected("hintBlindTag"));
            assert_eq!(hex::encode(nonce.bytes()), expected("hintNonce"));
            assert_eq!(hex::encode(ciphertext.bytes()), expected("hintCiphertext"));
            assert_eq!(pow_nonce, v["wire"]["expected"]["hintPowNonce"].as_u64().unwrap());

            let view = HintView {
                version,
                blind_tag: blind_tag.bytes(),
                nonce: nonce.bytes(),
                pow_nonce,
                ciphertext: ciphertext.bytes(),
            };

            // ★ id が TS 側と 1 ビットも違わないこと。
            //   ここがズレると重複排除が効かず、同じ Hint が無限に往復する。
            assert_eq!(view.id().unwrap(), expected("hintId"), "hint id が TS と一致しない");

            // ★ TS が解いた PoW を Rust が受理すること
            assert_eq!(
                view.check(HINT_POW_DIFFICULTY),
                Ok(()),
                "TS が解いた Hint の PoW を Rust が弾いている"
            );
        }
        other => panic!("expected Hint, got {other:?}"),
    }
}

/// ★ TypeScript が作った HINT_STEM を Rust が読めるか。
///
/// 中身は HINT と同一で運び方だけが違う。ここがズレると
/// 発信元の隠蔽 (Stem) が丸ごと落ちて直接 flood にフォールバックしてしまう。
#[test]
fn decodes_hint_stem_from_typescript() {
    use aether_cache::protocol::hint::{HintView, HINT_POW_DIFFICULTY};

    match decode("hintStem") {
        P2PMessage::HintStem { version, blind_tag, nonce, pow_nonce, ciphertext, .. } => {
            assert_eq!(hex::encode(blind_tag.bytes()), expected("hintBlindTag"));
            let view = HintView {
                version,
                blind_tag: blind_tag.bytes(),
                nonce: nonce.bytes(),
                pow_nonce,
                ciphertext: ciphertext.bytes(),
            };
            // HINT と同じ id になること (Stem→Fluff で同一物として扱われる)
            assert_eq!(view.id().unwrap(), expected("hintId"));
            assert_eq!(view.check(HINT_POW_DIFFICULTY), Ok(()));
        }
        other => panic!("expected HintStem, got {other:?}"),
    }
}

/// ★ TypeScript が作った DHT_PUT_STEM を Rust が読めるか。
///
/// 中身は DHT_PUT と同一で運び方だけが違う。ここがズレると
/// 発信元の隠蔽が丸ごと落ち、保管者に「この IP が置いた」が渡る。
#[test]
fn decodes_dht_put_stem_from_typescript() {
    match decode("dhtPutStem") {
        P2PMessage::DhtPutStem { topic_hash, entries } => {
            assert_eq!(topic_hash, expected("dhtTopicHash"));
            assert_eq!(entries.len(), 1);
            assert_eq!(hex::encode(entries[0].bytes()), expected("dhtEntry"));
        }
        other => panic!("expected DhtPutStem, got {other:?}"),
    }
}

/// ★ TypeScript が作った Slot (`hint_blob ‖ body_blob`) を Rust が受理するか。
///
/// ここが噛み合っていないと、**Schrödinger の PUT が受信側の検証で
/// 全部 NotJson として捨てられ、履歴が一切保管されない**。
/// ローカル保管は検証を通らないため単体テストでは表面化せず、
/// 実網ログの `dropped 1 invalid entries (Some(NotJson))` で初めて出た。
#[test]
fn accepts_slot_blob_from_typescript() {
    use aether_cache::mailbox::entry::check_entry;
    use aether_cache::protocol::hint::slot;

    let P2PMessage::DhtPut { entries, .. } = decode("dhtPutSlot") else {
        panic!("expected DhtPut");
    };
    assert_eq!(entries.len(), 1);
    let bytes = entries[0].bytes();

    // Slot として解釈できること
    let parsed = slot::decode(bytes).expect("TS の Slot を Rust が解釈できない");
    assert_eq!(parsed.hint.blind_tag.len(), 4);

    // 索引の PoW が通り、本体も検証を通ること
    let packet = check_entry(bytes, now_ms_for_vectors())
        .expect("TS が作った Slot を Rust が受理しない");
    assert_eq!(packet.packet_id, expected("gossipPacketId"));
}

/// 索引の PoW を壊した Slot は受理しない
#[test]
fn rejects_slot_with_forged_hint_pow() {
    use aether_cache::mailbox::entry::{check_entry, EntryReject};

    let P2PMessage::DhtPut { entries, .. } = decode("dhtPutSlot") else {
        panic!("expected DhtPut");
    };
    let mut bytes = entries[0].bytes().to_vec();
    // pow_nonce は hint_blob の中: 4 + 1 + 1 + 4 + 12 の位置から 8 バイト
    let pow_off = 4 + 1 + 1 + 4 + 12;
    bytes[pow_off] ^= 0xFF;

    assert_eq!(
        check_entry(&bytes, now_ms_for_vectors()),
        Err(EntryReject::BadHintPow),
    );
}

/// ★ Hint は鍵無しでは中身が読めない (ワイヤ表現の確認)。
///
/// `P2PMessage::Hint` は不透明なバイト列しか持たず、
/// Rust 側に復号の手段が無いことを型として固定する。
#[test]
fn hint_is_opaque_without_the_key() {
    match decode("hint") {
        P2PMessage::Hint { ciphertext, blind_tag, .. } => {
            let ct = ciphertext.bytes();
            // 平文が素通しなら印字可能文字が多くを占めるはず、という粗い確認
            let printable = ct.iter().filter(|&&b| (0x20..0x7f).contains(&b)).count();
            assert!(printable * 2 < ct.len(), "ciphertext に平文らしきものが混じっている");
            assert_eq!(blind_tag.bytes().len(), 4);
        }
        other => panic!("expected Hint, got {other:?}"),
    }
}

/// Dandelion のパラメータが両実装で一致していること。
///
/// ずれると「片方だけ Stem が長い/短い」状態になり、匿名性の前提が崩れる。
#[test]
fn dandelion_parameters_match_the_spec() {
    // 仕様: docs/spec/step5_dandelion.md
    //
    // ★ stemTtl (ホップカウンタ) は廃止済み。ワイヤに載っていないことを
    //   ここで固定する。カウンタが復活すると、その上限値が
    //   「発信元しか出せない値」になり発信元特定に直結する。
    match decode("stem") {
        P2PMessage::Stem { .. } => {}
        other => panic!("expected Stem, got {other:?}"),
    }
    assert!(
        vectors()["wire"]["expected"].get("stemTtl").is_none(),
        "stemTtl はワイヤから撤去されていなければならない"
    );
}
