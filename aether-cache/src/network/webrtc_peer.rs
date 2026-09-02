use crate::network::chunked::{ChunkedReceiver, ChunkedSender};
use crate::network::messages::P2PMessage;
use crate::network::wire::WireCodec;
use crate::NetworkEvent;
use crate::network::signaling_client::TrackerMessage;
use anyhow::Result;
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{error, info, warn};
use webrtc::data_channel::RTCDataChannel;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::api::APIBuilder;
use bytes::Bytes;

#[derive(Debug, Clone)]
pub enum PeerActorCommand {
    /// Process incoming WebRTC signaling data (SDP or ICE Candidates)
    HandleSignal(serde_json::Value),
    /// Send a protocol message to this peer
    Send(P2PMessage),
    /// Terminate connection and actor task
    Close,
}

/// DataChannel が開く前に積んでおける送信の上限
const MAX_PENDING_SENDS: usize = 32;

enum PeerInternalEvent {
    RawData(Vec<u8>),
    DataChannelOpened(Arc<RTCDataChannel>),
    IceCandidate(Option<RTCIceCandidate>),
    StateChanged(RTCPeerConnectionState),
}

pub struct WebRTCPeer {
    peer_id: String,
    /// この接続の世代。同じ peerId での張り直しを区別する。
    session: u64,
    initiator: bool,
    pc: Arc<RTCPeerConnection>,
    dc: Option<Arc<RTCDataChannel>>,
    event_tx: mpsc::UnboundedSender<NetworkEvent>,
    signal_tx: mpsc::UnboundedSender<TrackerMessage>,
    cmd_rx: mpsc::UnboundedReceiver<PeerActorCommand>,
    internal_rx: mpsc::UnboundedReceiver<PeerInternalEvent>,
    chunked_sender: ChunkedSender,
    chunked_receiver: ChunkedReceiver,
}

impl WebRTCPeer {
    #[allow(clippy::too_many_arguments)]
    pub async fn spawn(
        peer_id: String,
        session: u64,
        initiator: bool,
        event_tx: mpsc::UnboundedSender<NetworkEvent>,
        signal_tx: mpsc::UnboundedSender<TrackerMessage>,
    ) -> Result<mpsc::UnboundedSender<PeerActorCommand>> {
        let mut m = webrtc::api::media_engine::MediaEngine::default();
        m.register_default_codecs()?;
        let api = APIBuilder::new().with_media_engine(m).build();

        let config = RTCConfiguration {
            ice_servers: vec![RTCIceServer {
                urls: vec![
                    "stun:stun.l.google.com:19302".to_owned(),
                    "stun:stun1.l.google.com:19302".to_owned(),
                    "stun:stun2.l.google.com:19302".to_owned(),
                ],
                ..Default::default()
            }],
            ..Default::default()
        };

        let pc = Arc::new(api.new_peer_connection(config).await?);
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let (internal_tx, internal_rx) = mpsc::unbounded_channel();

        // 1. Setup candidate handler
        let int_tx_c = internal_tx.clone();
        pc.on_ice_candidate(Box::new(move |c: Option<RTCIceCandidate>| {
            let int_tx = int_tx_c.clone();
            Box::pin(async move {
                let _ = int_tx.send(PeerInternalEvent::IceCandidate(c));
            })
        }));

        // 2. Setup connection state handler
        let int_tx_c2 = internal_tx.clone();
        pc.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
            let int_tx = int_tx_c2.clone();
            Box::pin(async move {
                let _ = int_tx.send(PeerInternalEvent::StateChanged(s));
            })
        }));

        let mut dc = None;

        if initiator {
            let dc_init = RTCDataChannelInit {
                ordered: Some(true),
                ..Default::default()
            };
            let new_dc = pc.create_data_channel("aether", Some(dc_init)).await?;
            let int_tx_c3 = internal_tx.clone();
            let new_dc_clone = Arc::clone(&new_dc);
            new_dc.on_open(Box::new(move || {
                let int_tx = int_tx_c3.clone();
                let dc_clone = Arc::clone(&new_dc_clone);
                Box::pin(async move {
                    info!("DataChannel opened as Initiator");
                    let _ = int_tx.send(PeerInternalEvent::DataChannelOpened(dc_clone));
                })
            }));

            let int_tx_c4 = internal_tx.clone();
            new_dc.on_message(Box::new(move |msg: DataChannelMessage| {
                let int_tx = int_tx_c4.clone();
                Box::pin(async move {
                    let _ = int_tx.send(PeerInternalEvent::RawData(msg.data.to_vec()));
                })
            }));

            dc = Some(new_dc);

            // Create Offer
            let offer = pc.create_offer(None).await?;
            pc.set_local_description(offer.clone()).await?;

            let _ = signal_tx.send(TrackerMessage::Relay {
                target_peer_id: peer_id.clone(),
                payload: serde_json::json!({
                    "type": "sdp-relay",
                    "sdp": offer
                }),
            });
        } else {
            let int_tx_c5 = internal_tx.clone();
            pc.on_data_channel(Box::new(move |new_dc: Arc<RTCDataChannel>| {
                let int_tx = int_tx_c5.clone();

                let int_tx_for_msg = int_tx.clone();
                new_dc.on_message(Box::new(move |msg: DataChannelMessage| {
                    let int_tx_inner = int_tx_for_msg.clone();
                    Box::pin(async move {
                        let _ = int_tx_inner.send(PeerInternalEvent::RawData(msg.data.to_vec()));
                    })
                }));

                // on_data_channel の時点ではまだ open していない。
                // ここで送ると readyState が connecting のまま送信することになるため、
                // 送信側 (initiator) と同じく on_open を待つ。
                let int_tx_for_open = int_tx.clone();
                let dc_for_open = Arc::clone(&new_dc);
                new_dc.on_open(Box::new(move || {
                    let int_tx_inner = int_tx_for_open.clone();
                    let dc_inner = Arc::clone(&dc_for_open);
                    Box::pin(async move {
                        let _ = int_tx_inner.send(PeerInternalEvent::DataChannelOpened(dc_inner));
                    })
                }));

                Box::pin(async move {})
            }));
        }

        let actor = Self {
            peer_id,
            session,
            initiator,
            pc,
            dc,
            event_tx,
            signal_tx,
            cmd_rx,
            internal_rx,
            chunked_sender: ChunkedSender::new(),
            chunked_receiver: ChunkedReceiver::new(),
        };

        tokio::spawn(actor.run());
        Ok(cmd_tx)
    }

    /// 実際の送信。DataChannel が開いている前提。
    async fn send_message(&mut self, msg: &P2PMessage) {
        let Some(dc) = self.dc.clone() else { return };
        match WireCodec::encode_v2(msg) {
            Ok(encoded) => {
                for chunk in self.chunked_sender.encode(&encoded) {
                    if let Err(e) = dc.send(&Bytes::copy_from_slice(&chunk)).await {
                        error!("[WebRTC {}] Send error: {}", self.peer_id, e);
                    }
                }
            }
            Err(e) => error!("[WebRTC {}] Encode error: {}", self.peer_id, e),
        }
    }

    async fn run(mut self) {
        info!("[WebRTC {}] Actor started (initiator={})", self.peer_id, self.initiator);
        let mut handshake_announced = false;
        let mut pending_sends: Vec<P2PMessage> = Vec::new();
        
        loop {
            tokio::select! {
                // Handle external commands
                Some(cmd) = self.cmd_rx.recv() => {
                    match cmd {
                        PeerActorCommand::HandleSignal(payload) => {
                            if let Err(e) = self.handle_signal_payload(payload).await {
                                error!("[WebRTC {}] Error handling signal: {}", self.peer_id, e);
                            }
                        }
                        PeerActorCommand::Send(msg) => {
                            if self.dc.is_some() {
                                self.send_message(&msg).await;
                            } else if pending_sends.len() < MAX_PENDING_SENDS {
                                // DataChannel が開く前に来た送信は捨てずに積む。
                                // 上限を設けて、開かないまま溜まり続けるのを防ぐ。
                                pending_sends.push(msg);
                            } else {
                                warn!("[WebRTC {}] Dropping message: send queue full", self.peer_id);
                            }
                        }
                        PeerActorCommand::Close => {
                            break;
                        }
                    }
                }
                // Handle internal events from WebRTC callbacks
                Some(evt) = self.internal_rx.recv() => {
                    match evt {
                        PeerInternalEvent::RawData(raw) => {
                            if let Some(assembled) = self.chunked_receiver.receive(raw) {
                                // ★ デコード失敗を握り潰さない。
                                //   以前は `if let Ok(..)` で黙って捨てていたため、
                                //   ワイヤ形式の不一致 (JsonBytes が MsgPack の bin 型を
                                //   読めなかった件) がログに一切現れず発見が遅れた。
                                match WireCodec::decode_v2(&assembled) {
                                    Ok(msg) => {
                                        let _ = self.event_tx.send(NetworkEvent::MessageReceived {
                                            peer_id: self.peer_id.clone(),
                                            message: msg,
                                        });
                                    }
                                    Err(e) => {
                                        warn!(
                                            "[WebRTC {}] Failed to decode {} byte frame (type=0x{:02x}): {}",
                                            self.peer_id,
                                            assembled.len(),
                                            assembled.first().copied().unwrap_or(0),
                                            e
                                        );
                                    }
                                }
                            }
                        }
                        PeerInternalEvent::DataChannelOpened(new_dc) => {
                            info!("[WebRTC {}] DataChannel opened", self.peer_id);
                            self.dc = Some(new_dc);

                            // ★ PeerConnected はここで出す。
                            //
                            //   以前は RTCPeerConnectionState::Connected で出していたが、
                            //   それは DataChannel が open する数ミリ秒前に起きる。
                            //   GossipActor はこのイベントを受けて即座に HELLO を送るため、
                            //   `self.dc` がまだ None の間に送信が来て黙って捨てられ、
                            //   ハンドシェイクが永久に完了しなかった。
                            if !handshake_announced {
                                handshake_announced = true;
                                let _ = self.event_tx.send(NetworkEvent::PeerConnected {
                                    peer_id: self.peer_id.clone(),
                                    position: 0.0, // 座標は peerId から導出する (申告しない)
                                    zones: vec![],
                                });
                            }

                            // DataChannel が開く前に積まれた送信を流す
                            let queued = std::mem::take(&mut pending_sends);
                            for msg in queued {
                                self.send_message(&msg).await;
                            }
                        }
                        PeerInternalEvent::IceCandidate(c) => {
                            if let Some(candidate) = c {
                                if let Ok(json) = candidate.to_json() {
                                    let _ = self.signal_tx.send(TrackerMessage::Relay {
                                        target_peer_id: self.peer_id.clone(),
                                        payload: serde_json::json!({
                                           "type": "ice-relay",
                                           "candidate": json
                                        }),
                                    });
                                }
                            }
                        }
                        PeerInternalEvent::StateChanged(state) => {
                            info!("[WebRTC {}] State: {:?}", self.peer_id, state);
                            match state {
                                RTCPeerConnectionState::Connected => {
                                    // PeerConnected はここではなく DataChannelOpened で出す。
                                    // ICE が繋がっただけでは、まだ 1 バイトも送れない。
                                }
                                RTCPeerConnectionState::Disconnected |
                                RTCPeerConnectionState::Failed |
                                RTCPeerConnectionState::Closed => {
                                    info!("[WebRTC {}] Connection lost", self.peer_id);
                                    let _ = self.event_tx.send(NetworkEvent::PeerDisconnected {
                                        peer_id: self.peer_id.clone(),
                                        session: self.session,
                                    });
                                    break;
                                }
                                _ => {}
                            }
                        }
                    }
                }
                else => break,
            }
        }

        // Clean up connections
        if let Some(dc) = self.dc.take() {
            let _ = dc.close().await;
        }
        let _ = self.pc.close().await;
        info!("[WebRTC {}] Actor stopped", self.peer_id);
    }

    async fn handle_signal_payload(&self, signal: serde_json::Value) -> Result<()> {
        if let Some(sdp_val) = signal.get("sdp") {
            let sdp: RTCSessionDescription = serde_json::from_value(sdp_val.clone())?;
            self.pc.set_remote_description(sdp.clone()).await?;

            if sdp.sdp_type == webrtc::peer_connection::sdp::sdp_type::RTCSdpType::Offer {
                let answer = self.pc.create_answer(None).await?;
                self.pc.set_local_description(answer.clone()).await?;
                let _ = self.signal_tx.send(TrackerMessage::Relay {
                    target_peer_id: self.peer_id.clone(),
                    payload: serde_json::json!({
                        "type": "sdp-relay",
                        "sdp": answer
                    }),
                });
            }
        } else if let Some(candidate_val) = signal.get("candidate") {
            let candidate: RTCIceCandidateInit = serde_json::from_value(candidate_val.clone())?;
            self.pc.add_ice_candidate(candidate).await?;
        }
        Ok(())
    }
}
