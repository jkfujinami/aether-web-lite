use crate::crypto::node_identity::is_valid_peer_id;
use crate::network::messages::P2PMessage;
use crate::network::ring_position::RingPosition;
use crate::network::signaling_client::TrackerMessage;
use crate::network::webrtc_peer::{PeerActorCommand, WebRTCPeer};
use crate::{NetworkEvent, PeerManagerCommand};
use rand::seq::SliceRandom;
use std::collections::HashMap;
use tokio::sync::mpsc;
use tracing::{error, info, warn};

pub struct PeerMetadata {
    pub peer_id: String,
    /// この接続の世代
    pub session: u64,
    /// peerId から導出した座標。相手の申告ではない。
    pub position: f64,
    /// HELLO/JOIN のハンドシェイクで Bound Identity を検証済みか
    pub verified: bool,
    /// この接続で自分が送ったチャレンジ (JOIN の署名検証に使う)
    pub challenge: Option<Vec<u8>>,
    pub cmd_tx: mpsc::UnboundedSender<PeerActorCommand>,
}

impl PeerMetadata {
    fn new(peer_id: String, session: u64, cmd_tx: mpsc::UnboundedSender<PeerActorCommand>) -> Self {
        let position = RingPosition::for_peer(&peer_id);
        Self { peer_id, session, position, verified: false, challenge: None, cmd_tx }
    }
}

#[derive(Debug, Clone)]
pub enum PeerManagerControl {
    /// Initiate a connection to a remote peer (as initiator).
    ///
    /// position は渡さない。peerId から導出できるため。
    InitiateConnection { peer_id: String },
    /// Route incoming signaling (SDP or ICE) from tracker to peer actor
    HandleIncomingSignal {
        sender_id: String,
        payload: serde_json::Value,
    },
    /// Notify peer manager that a peer has disconnected.
    ///
    /// `session` が現在のものと一致するときだけ削除する。張り直しの直前に
    /// 飛んだ古い接続の切断通知で、新しい接続を消さないため。
    PeerDisconnected {
        peer_id: String,
        session: u64,
    },
    /// ポリシー違反による即時切断 (Bound Identity の検証失敗など)。
    ///
    /// 世代に関係なく落とす。「今この peerId を名乗っている接続は信用できない」
    /// という判断なので、どの世代であっても残してはいけない。
    DropPeer { peer_id: String },
    /// この接続で送出したチャレンジを記録する (HELLO 送信時)
    SetChallenge { peer_id: String, challenge: Vec<u8> },
    /// Bound Identity の検証に成功した印を付ける
    MarkVerified { peer_id: String },
}

pub struct PeerManager {
    my_peer_id: String,
    peers: HashMap<String, PeerMetadata>,
    /// 接続世代の採番。張り直しのたびに増える。
    next_session: u64,
    event_tx: mpsc::UnboundedSender<NetworkEvent>,
    signal_tx: mpsc::UnboundedSender<TrackerMessage>,
    cmd_rx: mpsc::UnboundedReceiver<PeerManagerCommand>,
    control_rx: mpsc::UnboundedReceiver<PeerManagerControl>,
}

impl PeerManager {
    pub fn spawn(
        my_peer_id: String,
        event_tx: mpsc::UnboundedSender<NetworkEvent>,
        signal_tx: mpsc::UnboundedSender<TrackerMessage>,
    ) -> (mpsc::UnboundedSender<PeerManagerCommand>, mpsc::UnboundedSender<PeerManagerControl>) {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let (control_tx, control_rx) = mpsc::unbounded_channel();
        
        let actor = Self {
            my_peer_id,
            peers: HashMap::new(),
            next_session: 1,
            event_tx,
            signal_tx,
            cmd_rx,
            control_rx,
        };
        
        tokio::spawn(actor.run());
        (cmd_tx, control_tx)
    }

    async fn run(mut self) {
        info!("[PeerManager] Actor started (my_peer_id={})", self.my_peer_id);
        
        loop {
            tokio::select! {
                // Command Channel (High-level message distribution)
                Some(cmd) = self.cmd_rx.recv() => {
                    match cmd {
                        PeerManagerCommand::SendMessage { peer_id, message } => {
                            if let Some(meta) = self.peers.get(&peer_id) {
                                let _ = meta.cmd_tx.send(PeerActorCommand::Send(message));
                            }
                        }
                        PeerManagerCommand::Broadcast { exclude_peer_id, message } => {
                            // ハンドシェイク未完了のピアには流さない。
                            // 座標が Bound Identity で検証されていない相手に
                            // 中継すると、そこが観測点になる。
                            for (pid, meta) in &self.peers {
                                if !meta.verified { continue; }
                                if Some(pid.clone()) != exclude_peer_id {
                                    let _ = meta.cmd_tx.send(PeerActorCommand::Send(message.clone()));
                                }
                            }
                        }
                        PeerManagerCommand::ForwardStem { exclude_peer_id, message } => {
                            let mut rng = rand::thread_rng();
                            let candidates: Vec<&PeerMetadata> = self.peers.values()
                                .filter(|meta| meta.verified && meta.peer_id != exclude_peer_id)
                                .collect();

                            // 転送先が居ない場合の分岐はここには置かない。
                            // 「Stem を続けるか Fluff に落とすか」は Dandelion++ の
                            // 判断であり GossipActor が握っている。ここで別扱いすると
                            // Stem のまま撒き直すことになり、Fluff への移行 (hop_count=0
                            // のリセットと Mailbox への保管) が行われない。
                            // GossipActor 側で候補の有無を見て Fluff に落としてある。
                            if let Some(target) = candidates.choose(&mut rng) {
                                let _ = target.cmd_tx.send(PeerActorCommand::Send(message));
                            }
                        }
                        PeerManagerCommand::SendPexResponse { peer_id } => {
                            // 検証済みピアだけを、position も zones も付けずに紹介する。
                            // position は peerId から導出でき、zones は購読宣言そのもの。
                            let mut info_list: Vec<crate::network::messages::PeerRef> = self.peers.values()
                                .filter(|meta| meta.verified && meta.peer_id != peer_id)
                                .map(|meta| crate::network::messages::PeerRef { id: meta.peer_id.clone() })
                                .collect();

                            // 先頭 N 件固定だと早期に接続した攻撃者ノードが
                            // 永久に紹介され続ける (本家 18.7-④)。必ずシャッフルする。
                            let mut rng = rand::thread_rng();
                            info_list.shuffle(&mut rng);
                            info_list.truncate(6);

                            let resp = P2PMessage::PexResponse { peers: info_list };
                            if let Some(meta) = self.peers.get(&peer_id) {
                                let _ = meta.cmd_tx.send(PeerActorCommand::Send(resp));
                            }
                        }
                    }
                }
                // Control Channel (Signaling, peer spawn and status updates)
                Some(ctrl) = self.control_rx.recv() => {
                    match ctrl {
                        PeerManagerControl::InitiateConnection { peer_id } => {
                            // Bound Identity では peerId は hex 32 文字に固定される。
                            // 壊れた ID は座標計算も壊れるのでここで確実に落とす。
                            if !is_valid_peer_id(&peer_id) {
                                warn!("[PeerManager] Refusing to connect to malformed peerId");
                                continue;
                            }
                            if peer_id != self.my_peer_id && !self.peers.contains_key(&peer_id) {
                                info!("[PeerManager] Initiating connection to {}", &peer_id[..8]);
                                let session = self.next_session;
                                self.next_session += 1;
                                match WebRTCPeer::spawn(
                                    peer_id.clone(),
                                    session,
                                    true,
                                    self.event_tx.clone(),
                                    self.signal_tx.clone(),
                                ).await {
                                    Ok(cmd_tx) => {
                                        self.peers.insert(
                                            peer_id.clone(),
                                            PeerMetadata::new(peer_id, session, cmd_tx),
                                        );
                                    }
                                    Err(e) => {
                                        error!("[PeerManager] Failed to spawn peer {}: {}", &peer_id[..8], e);
                                    }
                                }
                            }
                        }
                        PeerManagerControl::HandleIncomingSignal { sender_id, payload } => {
                            if !is_valid_peer_id(&sender_id) {
                                warn!("[PeerManager] Rejecting signaling from malformed peerId");
                                continue;
                            }

                            // ★ 相手が同じ peerId でセッションを張り直した場合の処理。
                            //
                            //   Bound Identity を入れたことで peerId が端末ごとに
                            //   永続化された。以前は peerId が起動のたびに乱数で
                            //   変わっていたので、ブラウザがリロードすれば必ず
                            //   別ピアとして扱われていた。今は同じ ID で戻ってくる。
                            //
                            //   ここで古いアクターに新しい offer を流し込むと、
                            //   既に死んでいる RTCPeerConnection に対して
                            //   set_remote_description することになり、
                            //   ICE は繋がるのに DataChannel が二度と open しない
                            //   (送信は「DataChannel is not opened」で落ち続ける)。
                            //
                            //   offer は「セッションを張り直したい」という意思表示なので、
                            //   古いアクターを畳んで作り直す。
                            let is_offer = payload
                                .get("sdp")
                                .and_then(|sdp| sdp.get("type"))
                                .and_then(|t| t.as_str())
                                == Some("offer");

                            if is_offer && self.peers.contains_key(&sender_id) {
                                info!(
                                    "[PeerManager] Peer {} re-offered; replacing stale connection",
                                    &sender_id[..8]
                                );
                                if let Some(meta) = self.peers.remove(&sender_id) {
                                    let _ = meta.cmd_tx.send(PeerActorCommand::Close);
                                }
                                // ハンドシェイク状態を落とさせる。PeerDisconnected ではなく
                                // PeerReset を使うのは、前者だと GossipActor が
                                // PeerManagerControl::PeerDisconnected を返してきて、
                                // これから作る新しいピアを消してしまうため。
                                let _ = self.event_tx.send(NetworkEvent::PeerReset {
                                    peer_id: sender_id.clone(),
                                });
                            }

                            if let Some(meta) = self.peers.get(&sender_id) {
                                let _ = meta.cmd_tx.send(PeerActorCommand::HandleSignal(payload));
                            } else {
                                info!("[PeerManager] Accepting incoming signaling from peer {}", &sender_id[..8]);
                                // payload の position / zones は読まない。座標は peerId から導出する。
                                let session = self.next_session;
                                self.next_session += 1;
                                match WebRTCPeer::spawn(
                                    sender_id.clone(),
                                    session,
                                    false,
                                    self.event_tx.clone(),
                                    self.signal_tx.clone(),
                                ).await {
                                    Ok(cmd_tx) => {
                                        let _ = cmd_tx.send(PeerActorCommand::HandleSignal(payload));
                                        self.peers.insert(
                                            sender_id.clone(),
                                            PeerMetadata::new(sender_id, session, cmd_tx),
                                        );
                                    }
                                    Err(e) => {
                                        error!("[PeerManager] Failed to spawn receiver peer {}: {}", &sender_id[..8], e);
                                    }
                                }
                            }
                        }
                        PeerManagerControl::DropPeer { peer_id } => {
                            if let Some(meta) = self.peers.remove(&peer_id) {
                                let _ = meta.cmd_tx.send(PeerActorCommand::Close);
                                info!("[PeerManager] Peer {} dropped by policy", &peer_id[..8]);
                            }
                        }
                        PeerManagerControl::PeerDisconnected { peer_id, session } => {
                            // 世代が一致するときだけ消す。張り直し直前に飛んだ
                            // 古い接続の切断通知で新しい接続を巻き込まないため。
                            let is_current = self
                                .peers
                                .get(&peer_id)
                                .map(|meta| meta.session == session)
                                .unwrap_or(false);
                            if is_current {
                                self.peers.remove(&peer_id);
                                info!("[PeerManager] Peer {} disconnected and removed", &peer_id[..8]);
                            } else {
                                info!(
                                    "[PeerManager] Ignoring stale disconnect for {} (session {})",
                                    &peer_id[..8], session
                                );
                            }
                        }
                        PeerManagerControl::SetChallenge { peer_id, challenge } => {
                            if let Some(meta) = self.peers.get_mut(&peer_id) {
                                meta.challenge = Some(challenge);
                            }
                        }
                        PeerManagerControl::MarkVerified { peer_id } => {
                            if let Some(meta) = self.peers.get_mut(&peer_id) {
                                meta.verified = true;
                                info!(
                                    "[PeerManager] Peer {} verified (bound position: {:.6})",
                                    &peer_id[..8], meta.position
                                );
                            }
                        }
                    }
                }
                else => break,
            }
        }
    }
}
