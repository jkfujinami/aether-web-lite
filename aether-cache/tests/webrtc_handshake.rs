//! 実際に WebRTC を張って、ハンドシェイクが最後まで通ることを確認する。
//!
//! ★ このテストが無かったために起きたこと
//!
//! ユニットテストと結合テストは `NetworkEvent` を手で流し込んで検証していたため、
//! 「実際に DataChannel が open するか」「PeerConnected がいつ発火するか」という
//! 一番壊れやすい部分が一切カバーされていなかった。結果として
//!
//!   * `PeerConnected` が DataChannel オープンの 4ms 前に発火し、
//!     GossipActor が送る HELLO が `self.dc == None` の窓に落ちて捨てられる
//!
//! という不具合を、実網で動かすまで発見できなかった。
//!
//! ここでは 2 つの `WebRTCPeer` アクターをローカルで直結し、
//! ICE → DTLS → SCTP → DataChannel → PeerConnected → 実データ往復
//! までを通しで確認する。

use std::time::Duration;
use tokio::sync::mpsc;

use aether_cache::network::messages::{JsonBytes, P2PMessage};
use aether_cache::network::signaling_client::TrackerMessage;
use aether_cache::network::webrtc_peer::{PeerActorCommand, WebRTCPeer};
use aether_cache::NetworkEvent;

const A_ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B_ID: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

struct Node {
    cmd_tx: mpsc::UnboundedSender<PeerActorCommand>,
    events: mpsc::UnboundedReceiver<NetworkEvent>,
}

/// 2 ノードを立て、シグナリングを相互に橋渡しする。
async fn connect_pair() -> (Node, Node) {
    let (a_event_tx, a_events) = mpsc::unbounded_channel::<NetworkEvent>();
    let (b_event_tx, b_events) = mpsc::unbounded_channel::<NetworkEvent>();
    let (a_signal_tx, mut a_signal_rx) = mpsc::unbounded_channel::<TrackerMessage>();
    let (b_signal_tx, mut b_signal_rx) = mpsc::unbounded_channel::<TrackerMessage>();

    // A は B へ発信する側 (initiator)
    let a_cmd = WebRTCPeer::spawn(B_ID.to_string(), 1, true, a_event_tx, a_signal_tx)
        .await
        .expect("failed to spawn initiator");
    // B は受け側
    let b_cmd = WebRTCPeer::spawn(A_ID.to_string(), 1, false, b_event_tx, b_signal_tx)
        .await
        .expect("failed to spawn receiver");

    // A の出す SDP/ICE を B へ、B の出すものを A へ
    let b_cmd_for_bridge = b_cmd.clone();
    tokio::spawn(async move {
        while let Some(TrackerMessage::Relay { payload, .. }) = a_signal_rx.recv().await {
            let _ = b_cmd_for_bridge.send(PeerActorCommand::HandleSignal(payload));
        }
    });
    let a_cmd_for_bridge = a_cmd.clone();
    tokio::spawn(async move {
        while let Some(TrackerMessage::Relay { payload, .. }) = b_signal_rx.recv().await {
            let _ = a_cmd_for_bridge.send(PeerActorCommand::HandleSignal(payload));
        }
    });

    (Node { cmd_tx: a_cmd, events: a_events }, Node { cmd_tx: b_cmd, events: b_events })
}

/// 指定の条件を満たすイベントが来るまで待つ
async fn wait_for<F>(node: &mut Node, label: &str, mut pred: F) -> NetworkEvent
where
    F: FnMut(&NetworkEvent) -> bool,
{
    let deadline = Duration::from_secs(20);
    match tokio::time::timeout(deadline, async {
        while let Some(evt) = node.events.recv().await {
            if pred(&evt) {
                return Some(evt);
            }
        }
        None
    })
    .await
    {
        Ok(Some(evt)) => evt,
        Ok(None) => panic!("{label}: event channel closed before the expected event"),
        Err(_) => panic!("{label}: timed out after {deadline:?}"),
    }
}

fn is_connected(evt: &NetworkEvent) -> bool {
    matches!(evt, NetworkEvent::PeerConnected { .. })
}

/// ★ 回帰テスト: DataChannel が実際に open して両側が PeerConnected を出すこと。
#[tokio::test]
async fn both_sides_report_peer_connected() {
    let _ = tracing_subscriber::fmt::try_init();
    let (mut a, mut b) = connect_pair().await;

    wait_for(&mut a, "initiator PeerConnected", is_connected).await;
    wait_for(&mut b, "receiver PeerConnected", is_connected).await;
}

/// ★ 回帰テスト (本命): PeerConnected を受けた *直後* に送ったメッセージが届くこと。
///
/// これがこのファイルを書いた理由。以前は `PeerConnected` が
/// `RTCPeerConnectionState::Connected` で発火しており、DataChannel が open する
/// 数ミリ秒前だった。GossipActor はこのイベントで即座に HELLO を送るため、
/// `self.dc == None` の窓に落ちて黙って捨てられ、ハンドシェイクが永久に
/// 完了しなかった。
#[tokio::test]
async fn message_sent_immediately_after_peer_connected_is_delivered() {
    let _ = tracing_subscriber::fmt::try_init();
    let (mut a, mut b) = connect_pair().await;

    // A が PeerConnected を受けた瞬間に送る (実際の GossipActor と同じ挙動)
    wait_for(&mut a, "initiator PeerConnected", is_connected).await;
    let challenge = vec![0x42u8; 32];
    a.cmd_tx
        .send(PeerActorCommand::Send(P2PMessage::Hello {
            challenge: JsonBytes::from_vec(challenge.clone()),
        }))
        .unwrap();

    let evt = wait_for(&mut b, "receiver HELLO", |e| {
        matches!(e, NetworkEvent::MessageReceived { message: P2PMessage::Hello { .. }, .. })
    })
    .await;

    match evt {
        NetworkEvent::MessageReceived { peer_id, message: P2PMessage::Hello { challenge: got } } => {
            assert_eq!(peer_id, A_ID);
            assert_eq!(got.bytes(), &challenge[..], "challenge must survive the wire");
        }
        other => panic!("unexpected event: {other:?}"),
    }
}

/// 受け側が PeerConnected 直後に送っても届くこと (逆方向)
#[tokio::test]
async fn receiver_can_send_immediately_after_peer_connected() {
    let _ = tracing_subscriber::fmt::try_init();
    let (mut a, mut b) = connect_pair().await;

    wait_for(&mut b, "receiver PeerConnected", is_connected).await;
    b.cmd_tx
        .send(PeerActorCommand::Send(P2PMessage::Ping { ts: 1234.0 }))
        .unwrap();

    wait_for(&mut a, "initiator PING", |e| {
        matches!(e, NetworkEvent::MessageReceived { message: P2PMessage::Ping { .. }, .. })
    })
    .await;
}

/// ★ HELLO → JOIN のハンドシェイクが実際の DataChannel 上で往復すること。
/// バイト列 (pubkey / signature) が bin 型で往復するかもここで効いてくる。
#[tokio::test]
async fn full_handshake_round_trip_over_real_datachannel() {
    use aether_cache::crypto::node_identity::{
        verify_signed_claim, NodeClaim, NodeIdentity, NODE_ID_POW_FAST,
    };

    let _ = tracing_subscriber::fmt::try_init();
    let (mut a, mut b) = connect_pair().await;

    let identity = NodeIdentity::from_seed(&[5u8; 32], &NODE_ID_POW_FAST).unwrap();

    // A → HELLO
    wait_for(&mut a, "initiator PeerConnected", is_connected).await;
    let challenge = vec![0x77u8; 32];
    a.cmd_tx
        .send(PeerActorCommand::Send(P2PMessage::Hello {
            challenge: JsonBytes::from_vec(challenge.clone()),
        }))
        .unwrap();

    // B が HELLO を受けて JOIN を返す
    wait_for(&mut b, "receiver HELLO", |e| {
        matches!(e, NetworkEvent::MessageReceived { message: P2PMessage::Hello { .. }, .. })
    })
    .await;

    let claim = identity.claim();
    b.cmd_tx
        .send(PeerActorCommand::Send(P2PMessage::Join {
            peer_id: claim.peer_id.clone(),
            pubkey: JsonBytes::from_vec(claim.pubkey.to_vec()),
            pow_counter: claim.pow_counter,
            challenge: JsonBytes::from_vec(challenge.clone()),
            signature: JsonBytes::from_vec(identity.sign_challenge(&challenge).to_vec()),
        }))
        .unwrap();

    // A が JOIN を受けて検証できる
    let evt = wait_for(&mut a, "initiator JOIN", |e| {
        matches!(e, NetworkEvent::MessageReceived { message: P2PMessage::Join { .. }, .. })
    })
    .await;

    let NetworkEvent::MessageReceived {
        message: P2PMessage::Join { peer_id, pubkey, pow_counter, challenge: echoed, signature },
        ..
    } = evt
    else {
        panic!("expected Join");
    };

    let received = NodeClaim {
        peer_id,
        pubkey: pubkey.bytes().try_into().expect("pubkey must be 32 bytes"),
        pow_counter,
    };
    assert!(
        verify_signed_claim(
            &received,
            echoed.bytes(),
            signature.bytes(),
            &challenge,
            &NODE_ID_POW_FAST
        ),
        "実 DataChannel 越しの JOIN が検証を通らない"
    );
}

/// 4KB を超えるメッセージがチャンク分割されて復元されること
#[tokio::test]
async fn large_message_is_chunked_and_reassembled() {
    use aether_cache::network::messages::GossipPacket;

    let _ = tracing_subscriber::fmt::try_init();
    let (mut a, mut b) = connect_pair().await;

    wait_for(&mut a, "initiator PeerConnected", is_connected).await;

    // DHT の応答を模した大きめのメッセージ
    let entries: Vec<JsonBytes> =
        (0..8).map(|i| JsonBytes::from_vec(vec![i as u8; 2048])).collect();
    a.cmd_tx
        .send(PeerActorCommand::Send(P2PMessage::DhtRes {
            topic_hash: "ab".repeat(32),
            req_id: "big".into(),
            entries: entries.clone(),
        }))
        .unwrap();

    let evt = wait_for(&mut b, "receiver DhtRes", |e| {
        matches!(e, NetworkEvent::MessageReceived { message: P2PMessage::DhtRes { .. }, .. })
    })
    .await;

    let NetworkEvent::MessageReceived { message: P2PMessage::DhtRes { entries: got, .. }, .. } = evt
    else {
        panic!("expected DhtRes");
    };
    assert_eq!(got.len(), entries.len());
    for (i, e) in got.iter().enumerate() {
        assert_eq!(e.bytes(), entries[i].bytes(), "entry {i} corrupted");
    }
    let _ = std::mem::size_of::<GossipPacket>();
}
