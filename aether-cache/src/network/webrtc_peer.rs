use anyhow::Result;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
use webrtc::data_channel::RTCDataChannel;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::ice_transport::ice_server::RTCIceServer;
use tracing::info;
use crate::network::signaling_client::TrackerMessage;

pub struct WebRTCPeer {
    pc: Arc<RTCPeerConnection>,
    data_channel: Arc<Mutex<Option<Arc<RTCDataChannel>>>>,
}

impl WebRTCPeer {
    pub async fn new(
        remote_id: String,
        initiator: bool,
        signal_tx: mpsc::UnboundedSender<TrackerMessage>,
        data_tx: mpsc::UnboundedSender<(String, String)>,
    ) -> Result<Arc<Self>> {
        let mut m = webrtc::api::media_engine::MediaEngine::default();
        m.register_default_codecs()?;
        
        let api = APIBuilder::new()
            .with_media_engine(m)
            .build();

        let config = RTCConfiguration {
            ice_servers: vec![RTCIceServer {
                urls: vec!["stun:stun.l.google.com:19302".to_owned()],
                ..Default::default()
            }],
            ..Default::default()
        };

        let pc = Arc::new(api.new_peer_connection(config).await?);
        let data_channel = Arc::new(Mutex::new(Option::<Arc<RTCDataChannel>>::None));

        let rid = Arc::new(remote_id);
        let signal_tx_clone = signal_tx.clone();
        let rid_c = Arc::clone(&rid);

        pc.on_ice_candidate(Box::new(move |c: Option<RTCIceCandidate>| {
            let signal_tx = signal_tx_clone.clone();
            let rid = Arc::clone(&rid_c);
            Box::pin(async move {
                if let Some(candidate) = c {
                    if let Ok(json) = candidate.to_json() {
                        let _ = signal_tx.send(TrackerMessage::Relay {
                            target_peer_id: (*rid).clone(),
                            payload: serde_json::json!({
                               "type": "ice-relay",
                               "candidate": json
                            })
                        });
                    }
                }
            })
        }));

        let rid_c2 = Arc::clone(&rid);
        pc.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
            let rid = Arc::clone(&rid_c2);
            Box::pin(async move {
                info!("[WebRTC {}] State changed: {}", *rid, s);
            })
        }));

        if initiator {
            let dc_init = RTCDataChannelInit {
                ordered: Some(true),
                ..Default::default()
            };
            let dc = pc.create_data_channel("aether", Some(dc_init)).await?;
            Self::setup_data_channel(Arc::clone(&dc), (*rid).clone(), data_tx.clone(), Arc::clone(&data_channel)).await;
            
            let offer = pc.create_offer(None).await?;
            pc.set_local_description(offer.clone()).await?;
            
            let _ = signal_tx.send(TrackerMessage::Relay {
                target_peer_id: (*rid).clone(),
                payload: serde_json::json!({
                    "type": "sdp-relay",
                    "sdp": offer
                })
            });
        } else {
            let data_channel_clone = Arc::clone(&data_channel);
            let rid_c3 = Arc::clone(&rid);
            pc.on_data_channel(Box::new(move |d: Arc<RTCDataChannel>| {
                let data_tx = data_tx.clone();
                let rid = Arc::clone(&rid_c3);
                let data_channel = Arc::clone(&data_channel_clone);
                Box::pin(async move {
                    Self::setup_data_channel(d, (*rid).clone(), data_tx, data_channel).await;
                })
            }));
        }

        Ok(Arc::new(Self { pc, data_channel }))
    }

    async fn setup_data_channel(
        dc: Arc<RTCDataChannel>,
        remote_id: String,
        data_tx: mpsc::UnboundedSender<(String, String)>,
        data_channel_slot: Arc<Mutex<Option<Arc<RTCDataChannel>>>>,
    ) {
        let rid = Arc::new(remote_id);
        let rid_c = Arc::clone(&rid);
        dc.on_open(Box::new(move || {
            let rid = Arc::clone(&rid_c);
            Box::pin(async move {
                info!("[WebRTC {}] DataChannel opened", *rid);
            })
        }));

        let rid_c2 = Arc::clone(&rid);
        dc.on_message(Box::new(move |msg: DataChannelMessage| {
            let rid = Arc::clone(&rid_c2);
            let data_tx = data_tx.clone();
            let data = String::from_utf8_lossy(&msg.data).to_string();
            Box::pin(async move {
                let _ = data_tx.send(((*rid).clone(), data));
            })
        }));

        let mut slot = data_channel_slot.lock().await;
        *slot = Some(dc);
    }

    pub async fn handle_signal(&self, signal: serde_json::Value, remote_id: String, signal_tx: mpsc::UnboundedSender<TrackerMessage>) -> Result<()> {
        if let Some(sdp_val) = signal.get("sdp") {
            let sdp: RTCSessionDescription = serde_json::from_value(sdp_val.clone())?;
            self.pc.set_remote_description(sdp.clone()).await?;

            if sdp.sdp_type == webrtc::peer_connection::sdp::sdp_type::RTCSdpType::Offer {
                let answer = self.pc.create_answer(None).await?;
                self.pc.set_local_description(answer.clone()).await?;
                let _ = signal_tx.send(TrackerMessage::Relay {
                    target_peer_id: remote_id,
                    payload: serde_json::json!({
                        "type": "sdp-relay",
                        "sdp": answer
                    })
                });
            }
        } else if let Some(candidate_val) = signal.get("candidate") {
            let candidate: RTCIceCandidateInit = serde_json::from_value(candidate_val.clone())?;
            self.pc.add_ice_candidate(candidate).await?;
        }
        Ok(())
    }

    pub async fn send(&self, msg: &str) -> Result<()> {
        let slot = self.data_channel.lock().await;
        if let Some(dc) = &*slot {
            dc.send_text(msg.to_string()).await?;
        }
        Ok(())
    }
}
