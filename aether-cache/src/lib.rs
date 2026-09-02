pub mod crypto;
pub mod network;
pub mod gossip;
pub mod storage;
pub mod mailbox;
pub mod node_key;

use network::messages::P2PMessage;

/// Network events emitted by the network layer (PeerManager / WebRTC Peers) 
/// and consumed by protocol actors (Gossip, Mailbox).
#[derive(Debug, Clone)]
pub enum NetworkEvent {
    /// A new WebRTC peer successfully connected and completed signaling.
    PeerConnected {
        peer_id: String,
        position: f64,
        zones: Vec<u32>,
    },
    /// A WebRTC peer disconnected or failed.
    ///
    /// `session` は「どの接続世代の切断か」を表す。同じ peerId で張り直したとき、
    /// 古い接続が遅れて出した切断通知が新しい接続を消してしまうのを防ぐ。
    PeerDisconnected {
        peer_id: String,
        session: u64,
    },
    /// 同じ peerId の相手がセッションを張り直した (ページリロード等)。
    ///
    /// プロトコルアクターは検証済みフラグ・チャレンジ・レート予算を破棄し、
    /// ハンドシェイクを最初からやり直させる。`PeerDisconnected` と違い
    /// PeerManager への削除通知を返さない —— 削除は PeerManager 自身が
    /// 既に済ませており、echo すると新しい接続を巻き込んで消してしまうため。
    PeerReset {
        peer_id: String,
    },
    /// Received a valid, fully reassembled P2P Message from a peer.
    MessageReceived {
        peer_id: String,
        message: P2PMessage,
    },
}

/// Commands sent to the PeerManagerActor to control peer connections and message delivery.
#[derive(Debug, Clone)]
pub enum PeerManagerCommand {
    /// Send a P2P message to a specific peer.
    SendMessage {
        peer_id: String,
        message: P2PMessage,
    },
    /// Broadcast a Gossip/Fluff message to all connected peers (excluding the original sender).
    Broadcast {
        exclude_peer_id: Option<String>,
        message: P2PMessage,
    },
    /// Forward a Stem phase message to a randomly selected neighbor (Dandelion++).
    ForwardStem {
        exclude_peer_id: String,
        message: P2PMessage,
    },
    /// Respond to a PEX request from a peer by providing up to 6 randomized active neighbors.
    SendPexResponse {
        peer_id: String,
    },
}
