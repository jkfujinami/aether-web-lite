//! アクター間の結合テスト。
//!
//! 「GossipActor → MailboxActor → PeerManager コマンド」という実際の経路を
//! 通したうえで、Bound Identity のハンドシェイクと各種の攻撃シナリオを検証する。

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

use aether_cache::crypto::node_identity::{NodeIdentity, NODE_ID_POW_FAST};
use aether_cache::crypto::pow::{PowCommittedHeader, MIN_DIFFICULTY, NONCE_SIZE};
use aether_cache::gossip::router::GossipActor;
use aether_cache::mailbox::mailbox::MailboxActor;
use aether_cache::network::messages::{GossipPacket, JsonBytes, P2PMessage};
use aether_cache::network::peer_manager::PeerManagerControl;
use aether_cache::storage::sqlite_store::SqliteStore;
use aether_cache::storage::StorageBackend;
use aether_cache::NetworkEvent;
use aether_cache::PeerManagerCommand;

const PARAMS: aether_cache::crypto::node_identity::NodeIdPowParams = NODE_ID_POW_FAST;

/// 64 桁の hex な topicHash
fn topic_hash(tag: u8) -> String {
    hex::encode([tag; 32])
}

fn valid_packet_with(timestamp: u64, zone_id: u32, payload_byte: u8) -> GossipPacket {
    let nonce = vec![1u8; NONCE_SIZE];
    let payload = vec![payload_byte; 40];
    let header = PowCommittedHeader {
        timestamp,
        zone_id,
        pow_difficulty: MIN_DIFFICULTY,
        nonce: &nonce,
        payload: &payload,
    };
    let pow_nonce = header.solve_pow(5_000_000).expect("PoW must be solvable");
    GossipPacket {
        packet_id: header.packet_id().unwrap(),
        hop_count: 0,
        pow_nonce,
        pow_difficulty: header.pow_difficulty,
        timestamp,
        zone_id,
        nonce: JsonBytes::from_vec(nonce),
        payload: JsonBytes::from_vec(payload),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn valid_packet() -> GossipPacket {
    valid_packet_with(now_ms(), 0, 2)
}

/// PoW を払っていないパケット (packet_id は張り直してあるので CHK は通る)
fn forged_packet() -> GossipPacket {
    let mut p = valid_packet();
    p.pow_difficulty = 0;
    p.packet_id = p.committed_header().packet_id().unwrap();
    p
}

struct Harness {
    event_tx: mpsc::UnboundedSender<NetworkEvent>,
    pm_cmd_rx: mpsc::UnboundedReceiver<PeerManagerCommand>,
    pm_ctrl_rx: mpsc::UnboundedReceiver<PeerManagerControl>,
    store: Arc<SqliteStore>,
    _gossip: tokio::task::JoinHandle<()>,
    _mailbox: tokio::task::JoinHandle<()>,
}

fn spawn_node() -> Harness {
    let _ = tracing_subscriber::fmt::try_init();

    let (event_tx, event_rx) = mpsc::unbounded_channel::<NetworkEvent>();
    let (mailbox_tx, mailbox_rx) = mpsc::unbounded_channel::<NetworkEvent>();
    let (pm_cmd_tx, pm_cmd_rx) = mpsc::unbounded_channel::<PeerManagerCommand>();
    let (pm_ctrl_tx, pm_ctrl_rx) = mpsc::unbounded_channel::<PeerManagerControl>();

    let store = Arc::new(SqliteStore::new(":memory:").unwrap());
    let identity = Arc::new(NodeIdentity::from_seed(&[9u8; 32], &PARAMS).unwrap());

    let gossip = GossipActor::spawn(
        identity,
        PARAMS,
        event_rx,
        pm_cmd_tx.clone(),
        pm_ctrl_tx,
        mailbox_tx,
    );
    let mailbox = MailboxActor::spawn(store.clone(), mailbox_rx, pm_cmd_tx);

    Harness { event_tx, pm_cmd_rx, pm_ctrl_rx, store, _gossip: gossip, _mailbox: mailbox }
}

async fn recv_cmd(rx: &mut mpsc::UnboundedReceiver<PeerManagerCommand>) -> Option<PeerManagerCommand> {
    tokio::time::timeout(Duration::from_millis(500), rx.recv()).await.ok().flatten()
}

async fn recv_ctrl(rx: &mut mpsc::UnboundedReceiver<PeerManagerControl>) -> Option<PeerManagerControl> {
    tokio::time::timeout(Duration::from_millis(500), rx.recv()).await.ok().flatten()
}

/// 接続 → HELLO → JOIN までを通して、そのピアを verified にする。
async fn complete_handshake(h: &mut Harness, peer: &NodeIdentity) {
    h.event_tx
        .send(NetworkEvent::PeerConnected {
            peer_id: peer.peer_id.clone(),
            position: 0.0,
            zones: vec![],
        })
        .unwrap();

    // アクターが出した HELLO からチャレンジを取り出す
    let cmd = recv_cmd(&mut h.pm_cmd_rx).await.expect("expected HELLO");
    let challenge = match cmd {
        PeerManagerCommand::SendMessage { message: P2PMessage::Hello { challenge }, .. } => {
            challenge.bytes().to_vec()
        }
        other => panic!("expected HELLO, got {other:?}"),
    };
    // SetChallenge の通知も流れてくる
    let _ = recv_ctrl(&mut h.pm_ctrl_rx).await;

    let sig = peer.sign_challenge(&challenge);
    let claim = peer.claim();
    h.event_tx
        .send(NetworkEvent::MessageReceived {
            peer_id: peer.peer_id.clone(),
            message: P2PMessage::Join {
                peer_id: claim.peer_id,
                pubkey: JsonBytes::from_vec(claim.pubkey.to_vec()),
                pow_counter: claim.pow_counter,
                challenge: JsonBytes::from_vec(challenge),
                signature: JsonBytes::from_vec(sig.to_vec()),
            },
        })
        .unwrap();

    match recv_ctrl(&mut h.pm_ctrl_rx).await {
        Some(PeerManagerControl::MarkVerified { peer_id }) => {
            assert_eq!(peer_id, peer.peer_id);
        }
        other => panic!("expected MarkVerified, got {other:?}"),
    }
}

// ───────────────────────── ハンドシェイク ─────────────────────────

#[tokio::test]
async fn peer_connected_triggers_hello_challenge() {
    let mut h = spawn_node();
    let peer = NodeIdentity::from_seed(&[1u8; 32], &PARAMS).unwrap();

    h.event_tx
        .send(NetworkEvent::PeerConnected {
            peer_id: peer.peer_id.clone(),
            position: 0.0,
            zones: vec![],
        })
        .unwrap();

    match recv_cmd(&mut h.pm_cmd_rx).await {
        Some(PeerManagerCommand::SendMessage { message: P2PMessage::Hello { challenge }, .. }) => {
            assert_eq!(challenge.bytes().len(), 32, "challenge must be 32 bytes");
        }
        other => panic!("expected HELLO, got {other:?}"),
    }
}

#[tokio::test]
async fn valid_join_marks_peer_verified() {
    let mut h = spawn_node();
    let peer = NodeIdentity::from_seed(&[2u8; 32], &PARAMS).unwrap();
    complete_handshake(&mut h, &peer).await;
}

#[tokio::test]
async fn hello_is_answered_with_signed_join() {
    let mut h = spawn_node();
    let peer = NodeIdentity::from_seed(&[3u8; 32], &PARAMS).unwrap();
    let challenge = vec![0x5au8; 32];

    h.event_tx
        .send(NetworkEvent::MessageReceived {
            peer_id: peer.peer_id.clone(),
            message: P2PMessage::Hello { challenge: JsonBytes::from_vec(challenge.clone()) },
        })
        .unwrap();

    match recv_cmd(&mut h.pm_cmd_rx).await {
        Some(PeerManagerCommand::SendMessage {
            message: P2PMessage::Join { peer_id, pubkey, challenge: echoed, signature, pow_counter },
            ..
        }) => {
            assert_eq!(echoed.bytes(), &challenge[..], "challenge must be echoed verbatim");
            // 自分の主張が自己検証を通ること
            let claim = aether_cache::crypto::node_identity::NodeClaim {
                peer_id,
                pubkey: pubkey.bytes().try_into().unwrap(),
                pow_counter,
            };
            assert!(aether_cache::crypto::node_identity::verify_signed_claim(
                &claim,
                echoed.bytes(),
                signature.bytes(),
                &challenge,
                &PARAMS,
            ));
        }
        other => panic!("expected JOIN, got {other:?}"),
    }
}

/// ★ 別人になりすました JOIN。接続の相手と名乗った identity が食い違う。
#[tokio::test]
async fn join_with_mismatched_identity_disconnects_peer() {
    let mut h = spawn_node();
    let connected = NodeIdentity::from_seed(&[4u8; 32], &PARAMS).unwrap();
    let victim = NodeIdentity::from_seed(&[5u8; 32], &PARAMS).unwrap();

    h.event_tx
        .send(NetworkEvent::PeerConnected {
            peer_id: connected.peer_id.clone(),
            position: 0.0,
            zones: vec![],
        })
        .unwrap();
    let challenge = match recv_cmd(&mut h.pm_cmd_rx).await {
        Some(PeerManagerCommand::SendMessage { message: P2PMessage::Hello { challenge }, .. }) => {
            challenge.bytes().to_vec()
        }
        other => panic!("expected HELLO, got {other:?}"),
    };
    let _ = recv_ctrl(&mut h.pm_ctrl_rx).await; // SetChallenge

    // victim になりすました JOIN を送る
    let sig = victim.sign_challenge(&challenge);
    let claim = victim.claim();
    h.event_tx
        .send(NetworkEvent::MessageReceived {
            peer_id: connected.peer_id.clone(),
            message: P2PMessage::Join {
                peer_id: claim.peer_id,
                pubkey: JsonBytes::from_vec(claim.pubkey.to_vec()),
                pow_counter: claim.pow_counter,
                challenge: JsonBytes::from_vec(challenge),
                signature: JsonBytes::from_vec(sig.to_vec()),
            },
        })
        .unwrap();

    match recv_ctrl(&mut h.pm_ctrl_rx).await {
        Some(PeerManagerControl::DropPeer { peer_id }) => {
            assert_eq!(peer_id, connected.peer_id);
        }
        other => panic!("expected DropPeer, got {other:?}"),
    }
}

/// ★ 傍受した JOIN の再生。チャレンジが毎回違うので通らない。
#[tokio::test]
async fn replayed_join_is_rejected() {
    let mut h = spawn_node();
    let peer = NodeIdentity::from_seed(&[6u8; 32], &PARAMS).unwrap();

    h.event_tx
        .send(NetworkEvent::PeerConnected {
            peer_id: peer.peer_id.clone(),
            position: 0.0,
            zones: vec![],
        })
        .unwrap();
    let _ = recv_cmd(&mut h.pm_cmd_rx).await; // HELLO (チャレンジは使わない)
    let _ = recv_ctrl(&mut h.pm_ctrl_rx).await;

    // 別の場面で傍受した (=このアクターが出したものではない) チャレンジで署名
    let stale_challenge = vec![0xAAu8; 32];
    let sig = peer.sign_challenge(&stale_challenge);
    let claim = peer.claim();
    h.event_tx
        .send(NetworkEvent::MessageReceived {
            peer_id: peer.peer_id.clone(),
            message: P2PMessage::Join {
                peer_id: claim.peer_id,
                pubkey: JsonBytes::from_vec(claim.pubkey.to_vec()),
                pow_counter: claim.pow_counter,
                challenge: JsonBytes::from_vec(stale_challenge),
                signature: JsonBytes::from_vec(sig.to_vec()),
            },
        })
        .unwrap();

    match recv_ctrl(&mut h.pm_ctrl_rx).await {
        Some(PeerManagerControl::DropPeer { .. }) => {}
        other => panic!("expected DropPeer, got {other:?}"),
    }
}

/// ★ ハンドシェイク未完了のピアからのメッセージは一切処理しない。
#[tokio::test]
async fn unverified_peer_messages_are_dropped() {
    let mut h = spawn_node();

    h.event_tx
        .send(NetworkEvent::MessageReceived {
            peer_id: "ab".repeat(16),
            message: P2PMessage::Gossip { packet: valid_packet() },
        })
        .unwrap();

    assert!(
        recv_cmd(&mut h.pm_cmd_rx).await.is_none(),
        "unverified peer must not cause any relay"
    );
}

// ───────────────────────── Gossip の検証 ─────────────────────────

#[tokio::test]
async fn valid_gossip_is_relayed() {
    let mut h = spawn_node();
    let peer = NodeIdentity::from_seed(&[7u8; 32], &PARAMS).unwrap();
    complete_handshake(&mut h, &peer).await;

    let packet = valid_packet();
    h.event_tx
        .send(NetworkEvent::MessageReceived {
            peer_id: peer.peer_id.clone(),
            message: P2PMessage::Gossip { packet: packet.clone() },
        })
        .unwrap();

    match recv_cmd(&mut h.pm_cmd_rx).await {
        Some(PeerManagerCommand::Broadcast { exclude_peer_id, message }) => {
            assert_eq!(exclude_peer_id, Some(peer.peer_id.clone()));
            match message {
                P2PMessage::Gossip { packet: relayed } => {
                    assert_eq!(relayed.packet_id, packet.packet_id);
                }
                other => panic!("expected Gossip, got {other:?}"),
            }
        }
        other => panic!("expected Broadcast, got {other:?}"),
    }
}

/// ★ 旧実装最大の穴: pow_difficulty=0 のパケットが素通りしていた。
#[tokio::test]
async fn forged_gossip_is_not_relayed() {
    let mut h = spawn_node();
    let peer = NodeIdentity::from_seed(&[8u8; 32], &PARAMS).unwrap();
    complete_handshake(&mut h, &peer).await;

    h.event_tx
        .send(NetworkEvent::MessageReceived {
            peer_id: peer.peer_id.clone(),
            message: P2PMessage::Gossip { packet: forged_packet() },
        })
        .unwrap();

    assert!(
        recv_cmd(&mut h.pm_cmd_rx).await.is_none(),
        "packet without PoW must not be relayed"
    );
}

#[tokio::test]
async fn duplicate_gossip_is_relayed_only_once() {
    let mut h = spawn_node();
    let peer = NodeIdentity::from_seed(&[10u8; 32], &PARAMS).unwrap();
    complete_handshake(&mut h, &peer).await;

    let packet = valid_packet();
    for _ in 0..3 {
        h.event_tx
            .send(NetworkEvent::MessageReceived {
                peer_id: peer.peer_id.clone(),
                message: P2PMessage::Gossip { packet: packet.clone() },
            })
            .unwrap();
    }

    assert!(recv_cmd(&mut h.pm_cmd_rx).await.is_some(), "first must relay");
    assert!(
        recv_cmd(&mut h.pm_cmd_rx).await.is_none(),
        "SeenCache must suppress duplicates"
    );
}

/// 転送先の隣人が居ない Stem は必ず Fluff へ遷移する。
///
/// ★ ホップカウンタ (stem_ttl) は廃止済み。Fluff は各ホップの確率判定で
///   起きるが、「転送できる相手が居ない」ときだけは確定で Fluff になる。
///   ここを落とすと ForwardStem が宛先無しで消え、パケットが黙って失われる。
///
/// 除外ピアを指定しない (`exclude_peer_id: None`) のは意図的で、
/// Dandelion++ の「エコーバックで送信者に到達確認を返す」ために必要。
#[tokio::test]
async fn stem_without_forward_target_transitions_to_fluff() {
    let mut h = spawn_node();
    let peer = NodeIdentity::from_seed(&[11u8; 32], &PARAMS).unwrap();
    complete_handshake(&mut h, &peer).await;
    // 検証済みピアはこの 1 人だけ = 送り主以外に転送先が居ない

    let packet = valid_packet();
    h.event_tx
        .send(NetworkEvent::MessageReceived {
            peer_id: peer.peer_id.clone(),
            message: P2PMessage::Stem { zone_id: 1, packet: packet.clone() },
        })
        .unwrap();

    match recv_cmd(&mut h.pm_cmd_rx).await {
        Some(PeerManagerCommand::Broadcast { exclude_peer_id, message }) => {
            assert_eq!(
                exclude_peer_id, None,
                "エコーバックを送信者に届けるため除外しない"
            );
            match message {
                P2PMessage::Gossip { packet: relayed } => {
                    assert_eq!(relayed.packet_id, packet.packet_id);
                    assert_eq!(relayed.payload.bytes(), packet.payload.bytes());
                }
                other => panic!("expected Gossip, got {other:?}"),
            }
        }
        other => panic!("expected Broadcast, got {other:?}"),
    }
}

/// ★ Stem パケットにホップカウンタが載っていないこと。
///
/// カウンタを平文で持たせると、その上限値が「発信元しか出せない値」になり、
/// 受け取った中継者が発信元を 100% 確定できてしまう。型として持たないことを
/// ここで固定する (復活したらコンパイルが通らない)。
#[tokio::test]
async fn stem_message_carries_no_hop_counter() {
    let packet = valid_packet();
    let msg = P2PMessage::Stem { zone_id: 1, packet };
    let json = serde_json::to_value(&msg).unwrap();
    assert!(
        json.get("stemTtl").is_none() && json.get("stem_ttl").is_none(),
        "Stem にホップカウンタが載っている: {json}"
    );
}

/// ★ Stem 経路も検証する。ここを素通しにすると Fluff 地点が増幅器になる。
#[tokio::test]
async fn forged_stem_is_not_fluffed() {
    let mut h = spawn_node();
    let peer = NodeIdentity::from_seed(&[12u8; 32], &PARAMS).unwrap();
    complete_handshake(&mut h, &peer).await;

    h.event_tx
        .send(NetworkEvent::MessageReceived {
            peer_id: peer.peer_id.clone(),
            message: P2PMessage::Stem { zone_id: 1, packet: forged_packet() },
        })
        .unwrap();

    assert!(
        recv_cmd(&mut h.pm_cmd_rx).await.is_none(),
        "stem packet without PoW must not be fluffed"
    );
}

// ───────────────────────── DHT ─────────────────────────

#[tokio::test]
async fn dht_get_returns_stored_entries() {
    let mut h = spawn_node();
    let peer = NodeIdentity::from_seed(&[13u8; 32], &PARAMS).unwrap();
    complete_handshake(&mut h, &peer).await;

    let topic = topic_hash(0xab);
    let data = vec![1u8, 2, 3, 4];
    h.store.put(&topic, vec![data.clone()]).unwrap();

    h.event_tx
        .send(NetworkEvent::MessageReceived {
            peer_id: peer.peer_id.clone(),
            message: P2PMessage::DhtGet { topic_hash: topic.clone(), req_id: "req_42".into() },
        })
        .unwrap();

    match recv_cmd(&mut h.pm_cmd_rx).await {
        Some(PeerManagerCommand::SendMessage {
            peer_id,
            message: P2PMessage::DhtRes { topic_hash, req_id, entries },
        }) => {
            assert_eq!(peer_id, peer.peer_id);
            assert_eq!(topic_hash, topic);
            assert_eq!(req_id, "req_42");
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].bytes(), &data[..]);
        }
        other => panic!("expected DhtRes, got {other:?}"),
    }
}

#[tokio::test]
async fn dht_get_with_malformed_topic_is_ignored() {
    let mut h = spawn_node();
    let peer = NodeIdentity::from_seed(&[14u8; 32], &PARAMS).unwrap();
    complete_handshake(&mut h, &peer).await;

    for bad in ["../../etc/passwd", "short", &"Z".repeat(64)] {
        h.event_tx
            .send(NetworkEvent::MessageReceived {
                peer_id: peer.peer_id.clone(),
                message: P2PMessage::DhtGet { topic_hash: bad.to_string(), req_id: "r".into() },
            })
            .unwrap();
    }

    assert!(
        recv_cmd(&mut h.pm_cmd_rx).await.is_none(),
        "malformed topicHash must not produce a response"
    );
}

/// ★ 旧実装は届いたバイト列を無検証で SQLite に書いていた (本家 18.7-⑦)。
#[tokio::test]
async fn dht_put_rejects_entries_without_pow() {
    let mut h = spawn_node();
    let peer = NodeIdentity::from_seed(&[15u8; 32], &PARAMS).unwrap();
    complete_handshake(&mut h, &peer).await;

    let topic = topic_hash(0xcd);
    let forged = serde_json::to_vec(&forged_packet()).unwrap();
    let garbage: Vec<JsonBytes> = (0..20)
        .map(|_| JsonBytes::from_vec(vec![0x41u8; 1024]))
        .chain(std::iter::once(JsonBytes::from_vec(forged)))
        .collect();

    h.event_tx
        .send(NetworkEvent::MessageReceived {
            peer_id: peer.peer_id.clone(),
            message: P2PMessage::DhtPut { topic_hash: topic.clone(), entries: garbage },
        })
        .unwrap();

    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        h.store.get(&topic).unwrap().is_empty(),
        "no invalid entry may be stored"
    );
}

#[tokio::test]
async fn dht_put_accepts_valid_entries() {
    let mut h = spawn_node();
    let peer = NodeIdentity::from_seed(&[16u8; 32], &PARAMS).unwrap();
    complete_handshake(&mut h, &peer).await;

    let topic = topic_hash(0xef);
    let packet = valid_packet();
    let entry = serde_json::to_vec(&packet).unwrap();

    h.event_tx
        .send(NetworkEvent::MessageReceived {
            peer_id: peer.peer_id.clone(),
            message: P2PMessage::DhtPut {
                topic_hash: topic.clone(),
                entries: vec![JsonBytes::from_vec(entry)],
            },
        })
        .unwrap();

    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(h.store.get(&topic).unwrap().len(), 1);
}

#[tokio::test]
async fn dht_put_with_malformed_topic_is_rejected() {
    let mut h = spawn_node();
    let peer = NodeIdentity::from_seed(&[17u8; 32], &PARAMS).unwrap();
    complete_handshake(&mut h, &peer).await;

    let entry = serde_json::to_vec(&valid_packet()).unwrap();
    h.event_tx
        .send(NetworkEvent::MessageReceived {
            peer_id: peer.peer_id.clone(),
            message: P2PMessage::DhtPut {
                topic_hash: "../../etc/passwd".into(),
                entries: vec![JsonBytes::from_vec(entry)],
            },
        })
        .unwrap();

    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(h.store.topic_count().unwrap(), 0);
}

// ───────────────────────── レート制限 ─────────────────────────

/// ★ 隣人 1 人からのフラッドが構造的に頭打ちになる (本家 18.11.3)。
#[tokio::test]
async fn gossip_flood_from_one_peer_is_capped() {
    let mut h = spawn_node();
    let peer = NodeIdentity::from_seed(&[18u8; 32], &PARAMS).unwrap();
    complete_handshake(&mut h, &peer).await;

    // それぞれ異なる (= SeenCache で潰れない) 正当なパケットを大量に送る
    let base = now_ms();
    for i in 0..200u32 {
        let packet = valid_packet_with(base - i as u64, 0, (i % 251) as u8);
        h.event_tx
            .send(NetworkEvent::MessageReceived {
                peer_id: peer.peer_id.clone(),
                message: P2PMessage::Gossip { packet },
            })
            .unwrap();
    }

    tokio::time::sleep(Duration::from_millis(300)).await;

    let mut relayed = 0;
    while let Ok(Some(_)) = tokio::time::timeout(Duration::from_millis(50), h.pm_cmd_rx.recv()).await {
        relayed += 1;
    }

    // Gossip カテゴリの burst は 60。ハンドシェイク分を含めても大きく超えない。
    assert!(relayed <= 70, "expected flood to be capped, relayed {relayed}");
    assert!(relayed > 0, "legitimate traffic must still get through");
}

// ───────────────── 同一 peerId での張り直し ─────────────────

/// ★ 回帰テスト: ピアがセッションを張り直したら検証済みフラグを必ず落とす。
///
/// Bound Identity により peerId が端末ごとに永続化されたため、ブラウザが
/// リロードすると同じ peerId で戻ってくるようになった。ここで検証済みフラグを
/// 残したままにすると、**ハンドシェイクを一度も通っていない新しい接続が
/// 「検証済み」として扱われる**。なりすましの入口になる。
#[tokio::test]
async fn peer_reset_clears_verified_state() {
    let mut h = spawn_node();
    let peer = NodeIdentity::from_seed(&[20u8; 32], &PARAMS).unwrap();
    complete_handshake(&mut h, &peer).await;

    // 検証済みなので Gossip が中継される
    h.event_tx
        .send(NetworkEvent::MessageReceived {
            peer_id: peer.peer_id.clone(),
            message: P2PMessage::Gossip { packet: valid_packet() },
        })
        .unwrap();
    assert!(recv_cmd(&mut h.pm_cmd_rx).await.is_some(), "verified peer should relay");

    // 相手が張り直した
    h.event_tx
        .send(NetworkEvent::PeerReset { peer_id: peer.peer_id.clone() })
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;

    // 新しいパケットは、再ハンドシェイクが済むまで通らない
    h.event_tx
        .send(NetworkEvent::MessageReceived {
            peer_id: peer.peer_id.clone(),
            message: P2PMessage::Gossip { packet: valid_packet_with(now_ms() - 1, 0, 9) },
        })
        .unwrap();
    assert!(
        recv_cmd(&mut h.pm_cmd_rx).await.is_none(),
        "reset peer must be treated as unverified"
    );
}

/// PeerReset は PeerManager への削除通知を返さない。
///
/// 返してしまうと、PeerManager が「張り直しのために作った新しいピア」を
/// 削除してしまい、再接続が成立しなくなる。
#[tokio::test]
async fn peer_reset_does_not_echo_a_removal() {
    let mut h = spawn_node();
    let peer = NodeIdentity::from_seed(&[21u8; 32], &PARAMS).unwrap();
    complete_handshake(&mut h, &peer).await;

    h.event_tx
        .send(NetworkEvent::PeerReset { peer_id: peer.peer_id.clone() })
        .unwrap();

    assert!(
        recv_ctrl(&mut h.pm_ctrl_rx).await.is_none(),
        "PeerReset must not send PeerManagerControl::PeerDisconnected back"
    );
}

/// 通常の切断は従来どおり PeerManager へ削除を通知する
#[tokio::test]
async fn peer_disconnected_still_echoes_a_removal() {
    let mut h = spawn_node();
    let peer = NodeIdentity::from_seed(&[22u8; 32], &PARAMS).unwrap();
    complete_handshake(&mut h, &peer).await;

    h.event_tx
        .send(NetworkEvent::PeerDisconnected { peer_id: peer.peer_id.clone(), session: 7 })
        .unwrap();

    match recv_ctrl(&mut h.pm_ctrl_rx).await {
        Some(PeerManagerControl::PeerDisconnected { peer_id, session }) => {
            assert_eq!(peer_id, peer.peer_id);
            assert_eq!(session, 7, "session must be carried through untouched");
        }
        other => panic!("expected PeerDisconnected, got {other:?}"),
    }
}

/// リセット後に再ハンドシェイクすれば、また通るようになること
#[tokio::test]
async fn peer_can_rehandshake_after_reset() {
    let mut h = spawn_node();
    let peer = NodeIdentity::from_seed(&[23u8; 32], &PARAMS).unwrap();
    complete_handshake(&mut h, &peer).await;

    h.event_tx
        .send(NetworkEvent::PeerReset { peer_id: peer.peer_id.clone() })
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;

    // もう一度 HELLO → JOIN を通す
    complete_handshake(&mut h, &peer).await;

    h.event_tx
        .send(NetworkEvent::MessageReceived {
            peer_id: peer.peer_id.clone(),
            message: P2PMessage::Gossip { packet: valid_packet_with(now_ms() - 2, 0, 11) },
        })
        .unwrap();
    assert!(
        recv_cmd(&mut h.pm_cmd_rx).await.is_some(),
        "peer should work again after re-handshaking"
    );
}

// ──────────── Stem 経路が閉じたときの復帰 (回帰) ────────────

/// ★ Stem は既読判定で黙って捨てない (仕様 §8.2)。
///
/// 同じパケットが再訪しても、通常どおり裁定して中継を続ける。
/// ここで「既に見た」を理由に分岐すると、攻撃者が Stem を送りつけて
/// 相手の反応を見るだけで「既に知っていたか」を判定できるオラクルになる。
#[tokio::test]
async fn revisited_stem_is_processed_normally_not_dropped() {
    let mut h = spawn_node();
    let sender = NodeIdentity::from_seed(&[21u8; 32], &PARAMS).unwrap();
    let other = NodeIdentity::from_seed(&[24u8; 32], &PARAMS).unwrap();
    complete_handshake(&mut h, &sender).await;
    complete_handshake(&mut h, &other).await; // 転送先を用意して forward 経路を通す

    let packet = valid_packet();
    const ROUNDS: usize = 20;
    for _ in 0..ROUNDS {
        h.event_tx
            .send(NetworkEvent::MessageReceived {
                peer_id: sender.peer_id.clone(),
                message: P2PMessage::Stem { zone_id: 1, packet: packet.clone() },
            })
            .unwrap();
    }

    let mut emitted = 0;
    while recv_cmd(&mut h.pm_cmd_rx).await.is_some() {
        emitted += 1;
    }

    // 旧実装は既読判定で 2 通目以降を黙って捨てていたため、ここは必ず 1 だった。
    // 現在は毎回裁定するので、Fluff 済み (= flooded で抑制) 以外は必ず中継が出る。
    assert!(
        emitted > 1,
        "再訪した Stem が黙って捨てられている (emitted={emitted})"
    );
}

/// ★ 同じパケットが何度 Stem として届いても、Fluff の増幅を起こさない。
///
/// 中継の重複排除は `flooded` が担うため、攻撃者が同じパケットを
/// 何度送りつけても Broadcast は 1 回きりになる。
#[tokio::test]
async fn repeated_stem_floods_only_once() {
    let mut h = spawn_node();
    let peer = NodeIdentity::from_seed(&[23u8; 32], &PARAMS).unwrap();
    complete_handshake(&mut h, &peer).await;
    // 転送先が居ないので、届いた Stem は必ず Fluff に落ちる

    let packet = valid_packet();
    for _ in 0..10 {
        h.event_tx
            .send(NetworkEvent::MessageReceived {
                peer_id: peer.peer_id.clone(),
                message: P2PMessage::Stem { zone_id: 1, packet: packet.clone() },
            })
            .unwrap();
    }

    let mut broadcasts = 0;
    while let Some(cmd) = recv_cmd(&mut h.pm_cmd_rx).await {
        if matches!(cmd, PeerManagerCommand::Broadcast { .. }) {
            broadcasts += 1;
        }
    }
    assert_eq!(broadcasts, 1, "同じパケットの Fluff は 1 回きり (増幅させない)");
}

/// ★ Stem を転送しただけのパケットが、後から Gossip として届いたら
///   ちゃんと Mailbox に保管される。
///
/// 旧実装は「中継したか」と「保管したか」を `seen_cache` ひとつで
/// 兼用していたため、Stem 転送で seen 扱いになったパケットは
/// その後 Fluff されて Gossip で届いても保管されなかった。
/// 保管ノードなのに保管できない、という壊れ方。
#[tokio::test]
async fn packet_relayed_as_stem_is_still_stored_when_it_arrives_as_gossip() {
    let mut h = spawn_node();
    let peer = NodeIdentity::from_seed(&[22u8; 32], &PARAMS).unwrap();
    complete_handshake(&mut h, &peer).await;

    let packet = valid_packet();

    // 1. Stem として受け取る (ここでは保管されないこともある)
    h.event_tx
        .send(NetworkEvent::MessageReceived {
            peer_id: peer.peer_id.clone(),
            message: P2PMessage::Stem { zone_id: 1, packet: packet.clone() },
        })
        .unwrap();
    let _ = recv_cmd(&mut h.pm_cmd_rx).await;

    // 2. 別ノードで Fluff された同じパケットが Gossip として届く
    h.event_tx
        .send(NetworkEvent::MessageReceived {
            peer_id: peer.peer_id.clone(),
            message: P2PMessage::Gossip { packet: packet.clone() },
        })
        .unwrap();

    // 3. Mailbox に届いていること (保管ノードとしての本分)
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        h.store.topic_count().unwrap() > 0,
        "Stem 中継済みでも、Gossip で届いたパケットは保管されなければならない"
    );
}
