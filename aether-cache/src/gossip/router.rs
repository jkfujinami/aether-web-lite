use crate::crypto::node_identity::{
    new_challenge, verify_signed_claim, NodeClaim, NodeIdPowParams, NodeIdentity,
};
use crate::gossip::seen_cache::SeenCache;
use crate::gossip::validator::{check_packet, now_ms, ValidateOptions};
use crate::network::messages::{JsonBytes, P2PMessage};
use crate::network::peer_manager::PeerManagerControl;
use crate::network::rate_limiter::{Category, RateLimiter};
use crate::protocol::hint::{HintView, HINT_POW_DIFFICULTY};
use crate::{NetworkEvent, PeerManagerCommand};
use rand::Rng;

/// 各ホップで Fluff に移行する確率。
///
/// ブラウザ側 DANDELION_CONFIG.FLUFF_PROBABILITY と必ず一致させること。
/// 経路長は幾何分布 (平均 1/p ホップ) に従い、p=0.3 で平均 3.33 ホップ。
///
/// ★ ホップカウンタ (stemTtl) は廃止した。カウンタを平文でワイヤに載せると
///   上限値が「発信元しか出せない値」になり、それを受け取った中継者が
///   発信元を確定できてしまう。幾何分布は無記憶なので、確率判定だけなら
///   経路上の位置は一切漏れない。
const FLUFF_PROBABILITY: f64 = 0.3;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{debug, info, trace, warn};

/// GossipActor は経路制御・重複排除・Dandelion++ (Stem/Fluff) を担当する。
///
/// 併せて 2 つの関門をここで通す:
///   1. Bound Identity のハンドシェイク (HELLO → JOIN)
///   2. 受信パケットの検証 (CHK + PoW) とレート制限
pub struct GossipActor {
    identity: Arc<NodeIdentity>,
    pow_params: NodeIdPowParams,
    /// 全隣人へ中継済みか。フラッディングの増幅を止める。
    flooded: SeenCache,
    /// Hint を中継済みか。Gossip の `flooded` とは名前空間を分ける
    /// (id の計算式が別なので混ぜる理由が無い)。
    hint_seen: SeenCache,
    /// Mailbox へ引き渡し済みか。中継の可否とは独立に判定する。
    ///
    /// ★ 旧実装はこの 3 つを seen_cache ひとつで兼用しており、
    ///   「Stem を転送しただけ」で seen 扱いになったパケットは、
    ///   その後 Fluff されて Gossip として届いても
    ///   `seen_cache.has()` の一点で弾かれ、Mailbox に一度も
    ///   保存されなかった。ブラウザ側とまったく同じ壊れ方。
    delivered: SeenCache,
    rate_limiter: RateLimiter,
    /// 接続ごとに自分が送ったチャレンジ。JOIN の署名検証に使う。
    challenges: HashMap<String, Vec<u8>>,
    /// ハンドシェイク済みのピア
    verified: HashMap<String, ()>,
    event_rx: mpsc::UnboundedReceiver<NetworkEvent>,
    pm_cmd_tx: mpsc::UnboundedSender<PeerManagerCommand>,
    pm_ctrl_tx: mpsc::UnboundedSender<PeerManagerControl>,
    mailbox_tx: mpsc::UnboundedSender<NetworkEvent>,
}

impl GossipActor {
    pub fn spawn(
        identity: Arc<NodeIdentity>,
        pow_params: NodeIdPowParams,
        event_rx: mpsc::UnboundedReceiver<NetworkEvent>,
        pm_cmd_tx: mpsc::UnboundedSender<PeerManagerCommand>,
        pm_ctrl_tx: mpsc::UnboundedSender<PeerManagerControl>,
        mailbox_tx: mpsc::UnboundedSender<NetworkEvent>,
    ) -> tokio::task::JoinHandle<()> {
        let actor = Self {
            identity,
            pow_params,
            flooded: SeenCache::new(50_000, 900),
            hint_seen: SeenCache::new(50_000, 900),
            delivered: SeenCache::new(50_000, 900),
            rate_limiter: RateLimiter::new(),
            challenges: HashMap::new(),
            verified: HashMap::new(),
            event_rx,
            pm_cmd_tx,
            pm_ctrl_tx,
            mailbox_tx,
        };
        tokio::spawn(actor.run())
    }

    async fn run(mut self) {
        info!("[GossipActor] Actor started");

        loop {
            tokio::select! {
                Some(event) = self.event_rx.recv() => {
                    match event {
                        NetworkEvent::PeerConnected { peer_id, .. } => {
                            self.begin_handshake(peer_id);
                        }
                        NetworkEvent::PeerDisconnected { peer_id, session } => {
                            self.forget_peer(&peer_id);
                            let _ = self.pm_ctrl_tx.send(PeerManagerControl::PeerDisconnected {
                                peer_id,
                                session,
                            });
                        }
                        NetworkEvent::PeerReset { peer_id } => {
                            // 相手が同じ peerId で張り直した。検証済みフラグを
                            // 必ず落とす —— 残したままだと、ハンドシェイクを
                            // 一度も通っていない新しい接続が「検証済み」として
                            // 扱われてしまう。
                            info!("[Gossip] Peer {} reset; requiring a fresh handshake", short(&peer_id));
                            self.forget_peer(&peer_id);
                        }
                        NetworkEvent::MessageReceived { peer_id, message } => {
                            self.handle_message(peer_id, message).await;
                        }
                    }
                }
                else => break,
            }
        }
    }

    /// ピアに紐づく状態をすべて破棄する
    fn forget_peer(&mut self, peer_id: &str) {
        self.challenges.remove(peer_id);
        self.verified.remove(peer_id);
        self.rate_limiter.forget(peer_id);
    }

    /// 接続が開いたら即座にチャレンジを送る。相手はこれに署名した JOIN を返す。
    fn begin_handshake(&mut self, peer_id: String) {
        let challenge = new_challenge().to_vec();
        self.challenges.insert(peer_id.clone(), challenge.clone());
        let _ = self.pm_ctrl_tx.send(PeerManagerControl::SetChallenge {
            peer_id: peer_id.clone(),
            challenge: challenge.clone(),
        });
        let _ = self.pm_cmd_tx.send(PeerManagerCommand::SendMessage {
            peer_id,
            message: P2PMessage::Hello { challenge: JsonBytes::from_vec(challenge) },
        });
    }

    /// メッセージ種別に対応するレート制限カテゴリ
    fn category_of(msg: &P2PMessage) -> Option<Category> {
        match msg {
            P2PMessage::Hello { .. } | P2PMessage::Join { .. } => Some(Category::Handshake),
            P2PMessage::Gossip { .. }
            | P2PMessage::Stem { .. }
            | P2PMessage::Hint { .. }
            | P2PMessage::HintStem { .. } => {
                Some(Category::Gossip)
            }
            P2PMessage::DhtPut { .. } | P2PMessage::DhtPutStem { .. } => Some(Category::DhtPut),
            P2PMessage::DhtGet { .. } | P2PMessage::DhtRes { .. } => Some(Category::DhtGet),
            P2PMessage::PexRequest { .. } | P2PMessage::PexResponse { .. } => Some(Category::Pex),
            P2PMessage::SdpRelay { .. } | P2PMessage::IceRelay { .. } => Some(Category::Signaling),
            _ => None,
        }
    }

    /// ハンドシェイク完了前でも処理してよいメッセージか
    fn is_pre_handshake(msg: &P2PMessage) -> bool {
        matches!(msg, P2PMessage::Hello { .. } | P2PMessage::Join { .. })
    }

    pub(crate) async fn handle_message(&mut self, peer_id: String, msg: P2PMessage) {
        // 1. レート制限 (本家 18.11.3 —「実際の防御はレート制限」)
        if let Some(category) = Self::category_of(&msg) {
            if !self.rate_limiter.allow(&peer_id, category) {
                // 静かに捨てる。ログを出すとログ自体が増幅路になる。
                return;
            }
        }

        // 2. ハンドシェイク未完了ピアの遮断
        if !Self::is_pre_handshake(&msg) && !self.verified.contains_key(&peer_id) {
            debug!("[Gossip] Dropped message from unverified peer {}", short(&peer_id));
            return;
        }

        match msg {
            P2PMessage::Hello { challenge } => {
                let challenge = challenge.bytes().to_vec();
                if challenge.is_empty() {
                    warn!("[Gossip] HELLO from {} without challenge", short(&peer_id));
                    return;
                }
                let signature = self.identity.sign_challenge(&challenge);
                let claim = self.identity.claim();
                let _ = self.pm_cmd_tx.send(PeerManagerCommand::SendMessage {
                    peer_id,
                    message: P2PMessage::Join {
                        peer_id: claim.peer_id,
                        pubkey: JsonBytes::from_vec(claim.pubkey.to_vec()),
                        pow_counter: claim.pow_counter,
                        challenge: JsonBytes::from_vec(challenge),
                        signature: JsonBytes::from_vec(signature.to_vec()),
                    },
                });
            }

            P2PMessage::Join { peer_id: claimed_id, pubkey, pow_counter, challenge, signature } => {
                self.handle_join(peer_id, claimed_id, pubkey, pow_counter, challenge, signature);
            }

            P2PMessage::Gossip { packet } => {
                if let Err(reason) = check_packet(
                    &packet,
                    ValidateOptions { now_ms: now_ms(), allow_stale: false },
                ) {
                    warn!("[Gossip] Dropped packet from {}: {:?}", short(&peer_id), reason);
                    return;
                }

                // 保管ノードなので、検証済みパケットは Mailbox にも渡す。
                // ★ 中継の可否とは独立に判定する。Stem を転送しただけの
                //   パケットが後から Fluff されて届いたとき、ここで
                //   取りこぼすと保管ノードなのに保管できない。
                self.deliver_to_mailbox(&peer_id, &packet);

                self.flood(Some(peer_id), packet);
            }

            // ★ Hint は中身を読まずに中継する (Broadcast Veil)。
            //   板/スレッドの鍵を持たないので復号はできないし、する必要もない。
            //   中継するかどうかを内容で分岐させないことが、
            //   受信者匿名性の土台になっている。
            P2PMessage::Hint { version, ttl, blind_tag, nonce, pow_nonce, ciphertext } => {
                let view = HintView {
                    version,
                    blind_tag: blind_tag.bytes(),
                    nonce: nonce.bytes(),
                    pow_nonce,
                    ciphertext: ciphertext.bytes(),
                };

                // PoW は中継より先に検証する。素通しにすると
                // 検証していないものを自分が増幅して撒くことになる。
                if let Err(reason) = view.check(HINT_POW_DIFFICULTY) {
                    debug!("[Hint] Dropped from {}: {:?}", short(&peer_id), reason);
                    return;
                }

                let Some(id) = view.id() else { return };
                if self.hint_seen.has(&id) {
                    return;
                }
                self.hint_seen.add(id.clone());

                // TTL を 1 減らして中継。0 になったらここで止める。
                if ttl == 0 {
                    trace!("[Hint] ttl exhausted for {}", &id[..8]);
                    return;
                }
                debug!("[Hint] Relaying {} (ttl {} -> {})", &id[..8], ttl, ttl - 1);
                let _ = self.pm_cmd_tx.send(PeerManagerCommand::Broadcast {
                    exclude_peer_id: Some(peer_id),
                    message: P2PMessage::Hint {
                        version,
                        ttl: ttl - 1,
                        blind_tag,
                        nonce,
                        pow_nonce,
                        ciphertext,
                    },
                });
            }

            // Hint の Stem。1 人へ転送を続けるか、Fluff (全体配信) へ移すか。
            //
            // ★ ここで「見たことがあるか」で分岐してはいけない。
            //   分岐させると、攻撃者が Hint を送りつけて相手の反応を見るだけで
            //   「既に知っていたか」を判定できるオラクルになる。
            P2PMessage::HintStem { version, ttl, blind_tag, nonce, pow_nonce, ciphertext } => {
                let view = HintView {
                    version,
                    blind_tag: blind_tag.bytes(),
                    nonce: nonce.bytes(),
                    pow_nonce,
                    ciphertext: ciphertext.bytes(),
                };
                if let Err(reason) = view.check(HINT_POW_DIFFICULTY) {
                    debug!("[Hint] Dropped stem from {}: {:?}", short(&peer_id), reason);
                    return;
                }

                // 転送できる隣人が居ないなら Fluff に落とすしかない。
                // ここを見落とすと転送が宛先無しで消え、Hint が黙って失われる。
                let has_forward_target = self.verified.keys().any(|pid| pid != &peer_id);
                let should_fluff =
                    !has_forward_target || rand::thread_rng().gen_bool(FLUFF_PROBABILITY);

                if should_fluff {
                    let Some(id) = view.id() else { return };
                    debug!("[Hint] Stem -> Fluff for {}", &id[..8]);
                    self.hint_seen.add(id);
                    // 全体配信へ。エコーを送信者に届けるため除外しない。
                    let _ = self.pm_cmd_tx.send(PeerManagerCommand::Broadcast {
                        exclude_peer_id: None,
                        message: P2PMessage::Hint {
                            version, ttl, blind_tag, nonce, pow_nonce, ciphertext,
                        },
                    });
                } else {
                    // 書き換えずにそのまま次の 1 人へ。書き換える値があると、
                    // それが経路上の位置を示す手がかりになる。
                    let _ = self.pm_cmd_tx.send(PeerManagerCommand::ForwardStem {
                        exclude_peer_id: peer_id,
                        message: P2PMessage::HintStem {
                            version, ttl, blind_tag, nonce, pow_nonce, ciphertext,
                        },
                    });
                }
            }

            P2PMessage::Stem { packet, zone_id } => {
                // Stem 経路にも同じ検証を掛ける。ここを素通しにすると
                // Fluff 地点が増幅器になる。
                if let Err(reason) = check_packet(
                    &packet,
                    ValidateOptions { now_ms: now_ms(), allow_stale: false },
                ) {
                    warn!("[Gossip] Dropped stem packet from {}: {:?}", short(&peer_id), reason);
                    return;
                }
                // ★ Stem では packet_id による重複排除をしない (仕様 §8.2)。
                //
                //   停止性は各ホップの確率判定が担保する。経路長は幾何分布に
                //   従い平均 1/FLUFF_PROBABILITY ホップ、加えて timestamp が
                //   MAX_TIME_DRIFT を超えると検証が落とすため必ず止まる。
                //
                //   ここで既読判定を入れると、攻撃者が任意のパケットを Stem
                //   として送りつけ、相手が即 Fluff (全隣人へのブロードキャスト)
                //   を返すかどうかを見るだけで「既に知っていたか」を判定できる
                //   オラクルになる。Stem 経路は 2〜4 ノードしかないため、
                //   これは発信元特定に直結する。ブラウザ側と対称。
                // 転送できる隣人が居ないなら Fluff に落とすしかない。
                // ここを見落とすと ForwardStem が宛先無しで消え、パケットが
                // 黙って失われる (ブラウザ側 neighbors.length === 0 と対称)。
                let has_forward_target =
                    self.verified.keys().any(|pid| pid != &peer_id);
                let should_fluff =
                    !has_forward_target || rand::thread_rng().gen_bool(FLUFF_PROBABILITY);

                if should_fluff {
                    debug!("[Gossip] Stem -> Fluff transition for packet {}", &packet.packet_id[..8]);
                    self.deliver_to_mailbox(&peer_id, &packet);
                    // Dandelion++ のエコー確認を送信者に届けるため除外しない
                    self.flood(None, packet);
                } else {
                    // ★ 転送先は出さない。Stem 先は経路情報そのもので、
                    //   ログに残すと発信元追跡の材料になる。
                    trace!("[Gossip] Stem forwarding packet {}", &packet.packet_id[..8]);
                    // パケットは一切書き換えずにそのまま転送する。書き換える値が
                    // あると、それが経路上の位置を示す手がかりになる。
                    let _ = self.pm_cmd_tx.send(PeerManagerCommand::ForwardStem {
                        exclude_peer_id: peer_id,
                        message: P2PMessage::Stem { packet, zone_id },
                    });
                }
            }

            P2PMessage::PexRequest { .. } => {
                debug!("[Gossip] Received PEX Request from {}", short(&peer_id));
                let _ = self.pm_cmd_tx.send(PeerManagerCommand::SendPexResponse { peer_id });
            }

            P2PMessage::Ping { ts } => {
                let _ = self.pm_cmd_tx.send(PeerManagerCommand::SendMessage {
                    peer_id,
                    message: P2PMessage::Pong { ts, echo_ts: ts },
                });
            }

            // PUT の Stem。転送を続けるか、自分が実行地点になるかを決める。
            //
            // ★ 実行地点になった場合は「全隣人へ DhtPut を撒く」形にする。
            //   受け取った側はそれぞれ K-nearest 帰属検証を通すので、
            //   担当外のノードは自分で弾く。ここで K-nearest を計算しないのは、
            //   その判断がこのアクターの持ち物ではないため。
            P2PMessage::DhtPutStem { topic_hash, entries } => {
                // 転送できる隣人が居ないなら自分が実行地点になるしかない。
                // ここを見落とすと転送が宛先無しで消え、PUT が黙って失われる。
                let has_forward_target = self.verified.keys().any(|pid| pid != &peer_id);
                let should_execute =
                    !has_forward_target || rand::thread_rng().gen_bool(FLUFF_PROBABILITY);

                if should_execute {
                    debug!("[DHT] PUT stem -> executing for {}", &topic_hash[..8.min(topic_hash.len())]);
                    let _ = self.pm_cmd_tx.send(PeerManagerCommand::Broadcast {
                        exclude_peer_id: None,
                        message: P2PMessage::DhtPut { topic_hash, entries },
                    });
                } else {
                    // 書き換えずにそのまま次の 1 人へ
                    trace!("[DHT] PUT stem forwarding");
                    let _ = self.pm_cmd_tx.send(PeerManagerCommand::ForwardStem {
                        exclude_peer_id: peer_id,
                        message: P2PMessage::DhtPutStem { topic_hash, entries },
                    });
                }
            }

            dht_msg @ (P2PMessage::DhtPut { .. } | P2PMessage::DhtGet { .. } | P2PMessage::DhtRes { .. }) => {
                let _ = self.mailbox_tx.send(NetworkEvent::MessageReceived { peer_id, message: dht_msg });
            }

            P2PMessage::SdpRelay { target_peer_id, sender_id, sdp } => {
                // 送信元は「このメッセージが実際に届いた接続」から決める。
                // ペイロードの senderId を採用すると詐称できる。
                let _ = sender_id;
                debug!("[Gossip] Relaying SDP from {} to {}", short(&peer_id), short(&target_peer_id));
                let _ = self.pm_cmd_tx.send(PeerManagerCommand::SendMessage {
                    peer_id: target_peer_id.clone(),
                    message: P2PMessage::SdpRelay {
                        target_peer_id,
                        sender_id: Some(peer_id),
                        sdp,
                    },
                });
            }

            P2PMessage::IceRelay { target_peer_id, sender_id, candidate } => {
                let _ = sender_id;
                debug!("[Gossip] Relaying ICE from {} to {}", short(&peer_id), short(&target_peer_id));
                let _ = self.pm_cmd_tx.send(PeerManagerCommand::SendMessage {
                    peer_id: target_peer_id.clone(),
                    message: P2PMessage::IceRelay {
                        target_peer_id,
                        sender_id: Some(peer_id),
                        candidate,
                    },
                });
            }

            _ => {}
        }
    }

    /// 検証済みパケットを Mailbox へ引き渡す。
    ///
    /// 「保管したか」の判定はここだけが行う (`delivered`)。呼び出し元は
    /// 中継状態を気にせず毎回呼んでよい。ブラウザ側 `deliverLocal()` と対称。
    fn deliver_to_mailbox(&mut self, peer_id: &str, packet: &crate::network::messages::GossipPacket) {
        if self.delivered.has(&packet.packet_id) {
            return;
        }
        self.delivered.add(packet.packet_id.clone());
        let _ = self.mailbox_tx.send(NetworkEvent::MessageReceived {
            peer_id: peer_id.to_string(),
            message: P2PMessage::Gossip { packet: packet.clone() },
        });
    }

    /// 全隣人へ中継する。
    ///
    /// 「同じパケットを二度中継しない」判定はここだけが行う (`flooded`)。
    /// ブラウザ側 `flood()` と対称。
    fn flood(
        &mut self,
        exclude_peer_id: Option<String>,
        packet: crate::network::messages::GossipPacket,
    ) {
        if self.flooded.has(&packet.packet_id) {
            return;
        }
        self.flooded.add(packet.packet_id.clone());
        debug!("[Gossip] Relaying packet {} (Fluff)", &packet.packet_id[..8]);
        let _ = self.pm_cmd_tx.send(PeerManagerCommand::Broadcast {
            exclude_peer_id,
            message: P2PMessage::Gossip { packet },
        });
    }

    /// JOIN の検証。ここが Eclipse 攻撃を止める要。
    ///
    /// 旧実装は `UpdatePeerInfo { position }` と、相手が名乗った座標を
    /// 無検証で採用していた。
    fn handle_join(
        &mut self,
        peer_id: String,
        claimed_id: String,
        pubkey: JsonBytes,
        pow_counter: u64,
        challenge: JsonBytes,
        signature: JsonBytes,
    ) {
        if self.verified.contains_key(&peer_id) {
            // ハンドシェイクは 1 接続 1 回。再送は無視する (PoW 再検証を避ける)。
            return;
        }

        let Some(expected) = self.challenges.get(&peer_id).cloned() else {
            warn!("[Gossip] JOIN from {} before HELLO was sent", short(&peer_id));
            return;
        };

        // 名乗った peerId と、この接続の相手として認識している peerId が
        // 一致しなければならない。緩いと「別人になりすました JOIN」が通る。
        if claimed_id != peer_id {
            warn!(
                "[Gossip] JOIN identity mismatch: connection={} claimed={}",
                short(&peer_id), short(&claimed_id)
            );
            self.forget_peer(&peer_id);
            let _ = self.pm_ctrl_tx.send(PeerManagerControl::DropPeer { peer_id });
            return;
        }

        let Ok(pubkey_arr) = <[u8; 32]>::try_from(pubkey.bytes()) else {
            warn!("[Gossip] JOIN from {} with malformed pubkey", short(&peer_id));
            self.forget_peer(&peer_id);
            let _ = self.pm_ctrl_tx.send(PeerManagerControl::DropPeer { peer_id });
            return;
        };

        let claim = NodeClaim { peer_id: claimed_id, pubkey: pubkey_arr, pow_counter };

        if !verify_signed_claim(
            &claim,
            challenge.bytes(),
            signature.bytes(),
            &expected,
            &self.pow_params,
        ) {
            warn!("[Gossip] JOIN verification failed for {} — dropping peer", short(&peer_id));
            self.forget_peer(&peer_id);
            let _ = self.pm_ctrl_tx.send(PeerManagerControl::DropPeer { peer_id });
            return;
        }

        self.verified.insert(peer_id.clone(), ());
        let _ = self.pm_ctrl_tx.send(PeerManagerControl::MarkVerified { peer_id });
    }
}

fn short(id: &str) -> &str {
    if id.len() >= 8 { &id[..8] } else { id }
}
