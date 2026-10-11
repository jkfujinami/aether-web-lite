import type {
  IPeerConnection,
  IPeerManager,
  PeerId,
  IMessageDispatcher,
  ISignalingClient,
  IZoneManager,
} from '../types';
import { WebRTCPeer } from './WebRTCPeer';
import { RingPosition } from './RingPosition';
import { RING_MESH } from '../constants';
import { WireCodec } from './wire/WireCodec';
import { WireType } from './wire/WireTypes';
import { RateLimiter } from './RateLimiter';
import { PeerMisbehaviorManager, ViolationType } from './PeerMisbehaviorManager';
import {
  NodeIdentity,
  NODE_ID_POW,
  CHALLENGE_BYTES,
  type NodeIdPowParams,
  type SignedNodeClaim,
} from '../crypto/NodeIdentity';
import { toBytes } from '../crypto/PowPolicy';
import { createLogger } from '../common/Logger';

const log = createLogger('net.peer');

/** peerId は Bound Identity なので hex 32 文字に固定されている */
const PEER_ID_RE = /^[0-9a-f]{32}$/;

/** WireType → レートリミッタのカテゴリ */
const RATE_CATEGORY: Partial<Record<WireType, string>> = {
  [WireType.HELLO]: 'handshake',
  [WireType.JOIN]: 'handshake',
  [WireType.GOSSIP]: 'gossip',
  [WireType.STEM]: 'gossip',
  [WireType.ONION_STEM]: 'gossip',
  [WireType.DHT_PUT]: 'dhtPut',
  [WireType.DHT_GET]: 'dhtGet',
  [WireType.DHT_RES]: 'dhtGet',
  [WireType.PEX_REQUEST]: 'pex',
  [WireType.PEX_RESPONSE]: 'pex',
  [WireType.SDP_RELAY]: 'signaling',
  [WireType.ICE_RELAY]: 'signaling',
};

/**
 * ハンドシェイク完了前でも通す WireType。
 * これ以外は Bound Identity の検証が済むまで一切ディスパッチしない。
 */
const PRE_HANDSHAKE_TYPES = new Set<WireType>([WireType.HELLO, WireType.JOIN]);

/** ハンドシェイク未完了の接続の同時上限 */
const MAX_PENDING_PEERS = 8;
/** 未接続ピアから先行して届いたシグナルのバッファ上限 (1 送信者あたり / 送信者数) */
const MAX_SIGNALS_PER_SENDER = 32;
const MAX_SIGNAL_SENDERS = 32;

export class PeerManager implements IPeerManager {
  private _peers: Map<PeerId, WebRTCPeer> = new Map();
  private signaling: ISignalingClient;
  private eventListeners: Map<string, Array<(...args: any[]) => void>> = new Map();
  private pexRoutes: Map<PeerId, PeerId> = new Map();
  private pendingSignals: Map<PeerId, any[]> = new Map();
  private coolDowns: Map<PeerId, number> = new Map();
  private rateLimiter: RateLimiter;
  private powParams: NodeIdPowParams;
  private identity: NodeIdentity;
  public readonly misbehavior: PeerMisbehaviorManager;
  private reannounceTimer: any = null;
  private readonly allowMissingDtlsFingerprint: boolean;

  public readonly myPeerId: PeerId;
  public readonly myPosition: number;
  private zoneManager: IZoneManager | null = null;
  private dispatcher: IMessageDispatcher;

  constructor(
    identity: NodeIdentity,
    dispatcher: IMessageDispatcher,
    signaling: ISignalingClient,
    options: {
      rateLimiter?: RateLimiter;
      powParams?: NodeIdPowParams;
      misbehavior?: PeerMisbehaviorManager;
      /**
       * ★ テスト専用。SDP に a=fingerprint が無い環境 (偽の WebRTC 等) で
       *   JOIN の DTLS 束縛を省略する。実運用では絶対に true にしないこと
       *   (中継型 MITM による ID 乗っ取りが再び可能になる)。
       */
      allowMissingDtlsFingerprint?: boolean;
    } = {},
  ) {
    this.allowMissingDtlsFingerprint = options.allowMissingDtlsFingerprint ?? false;
    this.identity = identity;
    this.myPeerId = identity.peerId;
    this.myPosition = identity.position;
    this.dispatcher = dispatcher;
    this.signaling = signaling;
    this.rateLimiter = options.rateLimiter ?? new RateLimiter();
    this.powParams = options.powParams ?? NODE_ID_POW;
    this.misbehavior = options.misbehavior ?? new PeerMisbehaviorManager();

    this.registerInternalHandlers();

    this.signaling.on('peers', (peers) => this.handleTrackerPeers(peers));
    this.signaling.on('relay', (senderId, payload) => this.handleRelay(senderId, payload));
  }

  private registerInternalHandlers() {
    // ── SDP / ICE の P2P リレー ──
    const handleRelay = (peerId: PeerId, msg: any, type: WireType) => {
      if (msg?.targetPeerId === this.myPeerId) {
        // ★ senderId は中継経路上の誰でも名乗れる値である (認証されていない)。
        //   ここで pexRoutes を書き換えると、既存の正規接続のシグナリング経路まで
        //   乗っ取られる。経路は「新しく接続を作るとき」にだけ handleRelay が記録する。
        const sender = msg.senderId;
        if (typeof sender === 'string' && PEER_ID_RE.test(sender)) {
          this.handleRelay(sender, msg, peerId);
        }
      } else if (typeof msg?.targetPeerId === 'string' && this._peers.has(msg.targetPeerId)) {
        this.sendMessage(msg.targetPeerId, type, msg);
      }
    };

    this.dispatcher.register(WireType.SDP_RELAY, (peerId, payload) => handleRelay(peerId, payload, WireType.SDP_RELAY));
    this.dispatcher.register(WireType.ICE_RELAY, (peerId, payload) => handleRelay(peerId, payload, WireType.ICE_RELAY));

    // ── ハンドシェイク ──
    this.dispatcher.register(WireType.HELLO, (peerId, msg) => this.handleHello(peerId, msg));
    this.dispatcher.register(WireType.JOIN, (peerId, msg) => this.handleJoin(peerId, msg));
  }

  /**
   * HELLO を受けたら、その challenge に署名した JOIN を返す。
   */
  private handleHello(peerId: PeerId, msg: any) {
    const challenge = toBytes(msg?.challenge);
    if (challenge.length !== CHALLENGE_BYTES) {
      log.warn(`HELLO from ${peerId.substring(0, 8)} with malformed challenge`);
      return;
    }
    const peer = this._peers.get(peerId);
    if (!peer) return;

    // 自分 (署名者) の視点: 自分の指紋 = local、検証者の指紋 = remote
    const fp = peer.dtlsFingerprints();
    if (!this.fingerprintsUsable(fp)) {
      log.warn(`Refusing to sign JOIN for ${peerId.substring(0, 8)}: DTLS fingerprint unavailable`);
      return;
    }
    this.sendMessage(peerId, WireType.JOIN, this.identity.signClaim(challenge, {
      verifierId: peerId,
      signerFingerprint: fp.local,
      verifierFingerprint: fp.remote,
    }));
  }

  /**
   * 指紋が JOIN の束縛に使えるか。
   * 実ブラウザの WebRTC では必ず存在する。欠けている場合は束縛が成立しないので、
   * 明示的に許可されていない限りハンドシェイクを進めない (fail-closed)。
   */
  private fingerprintsUsable(fp: { local: string; remote: string }): boolean {
    if (fp.local && fp.remote) return true;
    return this.allowMissingDtlsFingerprint;
  }

  /**
   * JOIN の検証。ここが Eclipse 攻撃を止める要。
   *
   * 旧実装は `peer.updatePosition(msg.position)` と、相手が名乗った座標を
   * 無検証で採用していた。現在は
   *   1. 主張された peerId が、この接続の相手 peerId と一致するか
   *   2. peerId = SHA256("AETHER/v3/peerid" ‖ pubkey)[0..16] か  (束縛)
   *   3. NodeId PoW (Argon2id) を満たすか                        (グラインド耐性)
   *   4. 自分がこの接続で送った challenge への署名が正しいか      (所有証明・リプレイ耐性)
   * をすべて通ったときだけ verified にする。座標はそもそも受け取らない。
   */
  private handleJoin(peerId: PeerId, msg: any) {
    const peer = this._peers.get(peerId);
    if (!peer) return;

    if (peer.isVerified) {
      // ハンドシェイクは 1 接続 1 回。再送は無視する (PoW 検証の再実行を避ける)
      return;
    }

    const expected = peer.challenge;
    if (!expected) {
      log.warn(`JOIN from ${peerId.substring(0, 8)} before HELLO was sent`);
      return;
    }

    const claim: SignedNodeClaim = {
      peerId: typeof msg?.peerId === 'string' ? msg.peerId : '',
      pubkey: toBytes(msg?.pubkey),
      powCounter: typeof msg?.powCounter === 'number' ? msg.powCounter : -1,
      challenge: toBytes(msg?.challenge),
      signature: toBytes(msg?.signature),
    };

    // 名乗った peerId と、この接続の相手として認識している peerId が
    // 一致しなければならない。ここが緩いと「別人になりすました JOIN」が通る。
    // ★ ハンドシェイク失敗では違反を記録しない (切断だけ)。
    //
    //   この接続の peerId は、シグナリングで「相手が名乗っただけ」の値である。
    //   旧実装はここで名乗られた ID に 100 点 (即 BAN) を付けていたため、
    //   攻撃者は正規ノード V を名乗って接続し、わざと JOIN に失敗するだけで
    //   V を 1 時間 BAN させられた。隣人ごとに繰り返せば Eclipse が完成する。
    if (claim.peerId !== peerId) {
      log.warn(
        `[PeerManager] JOIN identity mismatch: connection=${peerId.substring(0, 8)} claimed=${String(claim.peerId).substring(0, 8)}`,
      );
      this.disconnect(peerId);
      return;
    }

    // 自分 (検証者) の視点: 署名者の指紋 = remote、自分の指紋 = local
    const fp = peer.dtlsFingerprints();
    if (!this.fingerprintsUsable(fp)) {
      log.warn(`JOIN from ${peerId.substring(0, 8)} rejected: DTLS fingerprint unavailable`);
      this.disconnect(peerId);
      return;
    }
    const binding = {
      verifierId: this.myPeerId,
      signerFingerprint: fp.remote,
      verifierFingerprint: fp.local,
    };

    if (!NodeIdentity.verifySignedClaim(claim, expected, binding, this.powParams)) {
      log.warn(`JOIN verification failed for ${peerId.substring(0, 8)} — dropping peer`);
      this.disconnect(peerId);
      return;
    }

    peer.markVerified(claim.pubkey);
    log.debug(
      `[PeerManager] Peer ${peerId.substring(0, 8)} verified (bound position: ${peer.position.toFixed(6)})`,
    );
    this.emit('peer:verified', peer);

    // 次数の調整は「検証が済んだ後」にだけ行う (未認証の offer で既存リンクを追い出させない)
    this.enforceDegree(peerId);
  }

  /**
   * 検証済みピアが MAX_DEGREE を超えたときの調整。
   *
   * 確立済みの接続を優先して守る。新顔が自分のローカルリンク (最近接 LOCAL_LINKS 人)
   * に入る場合だけ、最も遠いロングレンジリンクを譲る。それ以外は新顔の方を切る。
   * こうしないと、PoW を払った Sybil が次々に接続するだけで正規のリンクが入れ替わる。
   */
  private enforceDegree(newcomerId: PeerId): void {
    const verified = this.verifiedPeers;
    if (verified.length <= RING_MESH.MAX_DEGREE) return;

    const byDistance = [...verified].sort(
      (a, b) => RingPosition.distance(this.myPosition, a.position) - RingPosition.distance(this.myPosition, b.position),
    );
    const isLocal = byDistance.slice(0, RING_MESH.LOCAL_LINKS).some(p => p.peerId === newcomerId);
    if (!isLocal) {
      this.disconnect(newcomerId);
      return;
    }
    const victim = byDistance.reverse().find(p => p.peerId !== newcomerId);
    if (victim) {
      this.coolDowns.set(victim.peerId, Date.now());
      this.disconnect(victim.peerId);
    }
  }

  /** ハンドシェイクが済んでいない接続 (接続中 + 接続済み未検証) の数 */
  private get pendingCount(): number {
    let n = 0;
    for (const p of this._peers.values()) if (!p.isVerified) n++;
    return n;
  }

  public setZoneManager(zm: IZoneManager) {
    this.zoneManager = zm;
  }

  public get peers(): ReadonlyMap<PeerId, IPeerConnection> {
    return this._peers;
  }

  public get degree(): number {
    let count = 0;
    for (const peer of this._peers.values()) {
      if (peer.isConnected) count++;
    }
    return count;
  }

  /** ハンドシェイク済みのピアだけを返す。DHT の K-nearest 等はこちらを使う。 */
  public get verifiedPeers(): WebRTCPeer[] {
    return Array.from(this._peers.values()).filter((p) => p.isConnected && p.isVerified);
  }

  /** 公開鍵が判明している検証済みピアのリスト (Onion Circuit 構築用) */
  public get verifiedPeersWithKeys(): Array<{ peerId: PeerId; pubkey: Uint8Array }> {
    return this.verifiedPeers
      .filter((p): p is WebRTCPeer & { pubkey: Uint8Array } => p.pubkey !== null)
      .map((p) => ({ peerId: p.peerId, pubkey: p.pubkey }));
  }

  public get nodeIdentity(): NodeIdentity {
    return this.identity;
  }

  public async start(): Promise<void> {
    log.debug(`Starting as ${this.myPeerId} (bound position: ${this.myPosition.toFixed(6)})`);

    // 購読ゾーンは送らない。トラッカーに申告すると、そのピアが何に興味を
    // 持っているかをトラッカーと全ピアに晒すことになる (本家 18.6.2 の交差攻撃)。
    await this.signaling.connect({ claim: this.identity.claim() });

    setTimeout(() => {
      log.debug(`Detaching from Tracker Server! Entering Fully Decentralized Mode.`);
      this.signaling.disconnect();
    }, 15_000);

    // 接続数低下時または孤立防止の動的再アナウンス (Adaptive Re-announce)
    if (this.reannounceTimer) clearInterval(this.reannounceTimer);
    this.reannounceTimer = setInterval(() => {
      if (this.degree < 4 && !this.signaling.isConnected) {
        log.info(`Degree dropped to ${this.degree} (< 4). Reconnecting to tracker for network repair.`);
        this.signaling.connect({ claim: this.identity.claim() }).catch((err) => {
          log.warn(`Adaptive tracker reconnect failed: ${err}`);
        });
      }
    }, 30_000);
  }

  public stop(): void {
    if (this.reannounceTimer) {
      clearInterval(this.reannounceTimer);
      this.reannounceTimer = null;
    }
    this.signaling.disconnect();
    for (const peerId of Array.from(this._peers.keys())) {
      this.disconnect(peerId);
    }
  }

  private handleTrackerPeers(peers: Array<{ peerId: PeerId }>): void {
    if (!Array.isArray(peers)) return;
    log.debug(`Received ${peers.length} peers from tracker`);

    // 旧実装はここで「共有ゾーン数が多い順」に並べ替えていた。
    // これはトラッカーに購読ゾーンを申告している前提の処理で、
    // 交差攻撃の材料そのものだったため撤去した。
    for (const p of peers) {
      if (!p || typeof p.peerId !== 'string') continue;
      if (!this._peers.has(p.peerId) && this.degree < RING_MESH.MAX_DEGREE) {
        this.connect(p.peerId, true);
      }
    }
  }

  /**
   * @param viaPeerId DataChannel 越しに中継されてきた場合、その中継者
   */
  private handleRelay(senderId: PeerId, msg: any, viaPeerId?: PeerId): void {
    if (this.misbehavior.isBanned(senderId)) {
      return;
    }
    if (!PEER_ID_RE.test(senderId)) {
      log.warn(`Rejecting relay from malformed peerId`);
      return;
    }

    const isOffer = msg?.sdp?.type === 'offer';

    // ★ 相手が同じ peerId でセッションを張り直した場合の処理。
    //
    //   Bound Identity により peerId が端末ごとに永続化された。以前は
    //   起動のたびに乱数で変わっていたので、相手がリロードすれば必ず
    //   別ピアとして扱われた。今は同じ ID で戻ってくる。
    //
    //   古い WebRTCPeer に新しい offer を流し込むと、既に死んでいる
    //   RTCPeerConnection に setRemoteDescription することになり、
    //   ICE は connected になるのに DataChannel が二度と open しない。
    //   offer は「張り直したい」という意思表示なので、古い接続を畳む。
    //
    //   ★ ただし検証済みで生きている接続は置き換えない。
    //     senderId は中継経路上の誰でも名乗れるので、旧実装では
    //     「正規隣人 V を名乗る offer」1 通で V との接続を切らせ、
    //     攻撃者の端点に V の名前で繋ぎ直させることができた。
    //     本物の V が張り直す場合、古い接続は ICE 切断 / onclose で先に畳まれる。
    if (isOffer && this._peers.has(senderId)) {
      const existing = this._peers.get(senderId)!;
      if (existing.isVerified && existing.isConnected) {
        log.warn(`Ignoring re-offer for live verified peer ${senderId.substring(0, 8)}`);
        return;
      }
      log.debug(`Peer ${senderId.substring(0, 8)} re-offered; replacing stale connection`);
      this.disconnect(senderId);
      // disconnect のクールダウンには入れない (正当な再接続なので)
      this.coolDowns.delete(senderId);
    }

    let peer = this._peers.get(senderId);

    if (!peer) {
      const isNewSession = isOffer || msg?.type === 'offer' || msg?.type === 'sdp-relay';

      if (isNewSession) {
        log.debug(`Received Offer via relay from ${senderId.substring(0, 8)}`);
        // ★ 未認証の offer で既存リンクを追い出さない。
        //   旧実装は MAX_DEGREE に達していると offer 1 通ごとに正規の
        //   ロングレンジリンクを切り、30 秒のクールダウンに入れていた。
        //   次数の調整は検証後に enforceDegree() が行う。
        peer = this.connect(senderId, false, viaPeerId);

        if (!peer) return;
        peer.signal(msg);

        const buffered = this.pendingSignals.get(senderId) || [];
        for (const sig of buffered) peer.signal(sig);
        this.pendingSignals.delete(senderId);
      } else {
        // オファー以外（ICE等）が先に来た場合は一旦バッファ
        if (this.coolDowns.has(senderId) && Date.now() - this.coolDowns.get(senderId)! < 30_000) return;
        const buffered = this.pendingSignals.get(senderId) || [];
        // 未接続ピアのバッファは無制限に伸ばさない (メモリ枯渇の防止)
        if (buffered.length >= MAX_SIGNALS_PER_SENDER) return;
        // 送信者の数にも上限を置く。senderId は自由に名乗れるので、
        // 1 人あたりの上限だけでは乱数 ID を変えながら無限に積める。
        if (!this.pendingSignals.has(senderId) && this.pendingSignals.size >= MAX_SIGNAL_SENDERS) {
          const oldest = this.pendingSignals.keys().next().value;
          if (oldest !== undefined) this.pendingSignals.delete(oldest);
        }
        buffered.push(msg);
        this.pendingSignals.set(senderId, buffered);
      }
      return;
    }

    peer.signal(msg);
  }

  public connect(peerId: PeerId, initiator: boolean = true, viaPeerId?: PeerId): WebRTCPeer | undefined {
    if (this.misbehavior.isBanned(peerId)) {
      log.warn(`Refusing connection to banned peer ${peerId.substring(0, 8)}`);
      return undefined;
    }

    // Bound Identity なので peerId の形式は固定。壊れた ID は座標計算も
    // 壊れるため、ここで確実に落とす。
    if (!PEER_ID_RE.test(peerId)) {
      log.warn(`Refusing to connect to malformed peerId`);
      return undefined;
    }
    if (peerId === this.myPeerId) return undefined;

    const existing = this._peers.get(peerId);
    if (existing) {
      if (existing.isConnected || existing.isConnecting) return existing;
      log.debug(`Cleaning up zombie peer ${peerId.substring(0, 8)} before reconnect`);
      this.disconnect(peerId);
    }

    const lastEvicted = this.coolDowns.get(peerId);
    if (lastEvicted && Date.now() - lastEvicted < 30_000) return undefined;
    if (lastEvicted) this.coolDowns.delete(peerId);

    // ★ ハンドシェイク未完了の接続数に上限を置く。
    //   degree は接続済みしか数えないため、旧実装では乱数 senderId の offer を
    //   送るたびに RTCPeerConnection が無制限に増え、ブラウザの上限で
    //   ノードが機能停止した。
    if (this.pendingCount >= MAX_PENDING_PEERS) {
      log.warn(`Refusing connection to ${peerId.substring(0, 8)}: too many pending handshakes`);
      return undefined;
    }

    if (viaPeerId) this.pexRoutes.set(peerId, viaPeerId);

    // 下の各コールバックは「自分がまだ登録されている本人か」を確認してから
    // 破棄処理を行う。同じ peerId で張り直したとき、古いインスタンスの
    // onclose やタイムアウトが遅れて発火し、差し替わった新しい接続を
    // 巻き込んで消してしまうのを防ぐ (RTCDataChannel.onclose は非同期に来る)。
    let created: WebRTCPeer | undefined;
    const isStillCurrent = () => created !== undefined && this._peers.get(peerId) === created;

    const peer = new WebRTCPeer({
      localId: this.myPeerId,
      remoteId: peerId,
      initiator,
      onSignal: (payload) => {
        let relayMsg: any;
        if (payload.renegotiate || payload.type === 'offer' || payload.type === 'answer' || payload.type === 'rollback') {
          const sdpPlain = (typeof payload.toJSON === 'function')
            ? payload.toJSON()
            : { type: payload.type, sdp: payload.sdp };

          // position / zones は載せない (peerId から導出できる / 漏らしてはいけない)
          relayMsg = {
            type: 'sdp-relay',
            targetPeerId: peerId,
            senderId: this.myPeerId,
            sdp: sdpPlain,
          };
        } else if (payload.candidate) {
          const icePlain = (typeof payload.toJSON === 'function') ? payload.toJSON() : payload;
          relayMsg = {
            type: 'ice-relay',
            targetPeerId: peerId,
            senderId: this.myPeerId,
            candidate: icePlain,
          };
        }

        if (!relayMsg) return;

        const via = this.pexRoutes.get(peerId);
        if (via && this._peers.has(via)) {
          this.sendMessage(via, relayMsg.type === 'sdp-relay' ? WireType.SDP_RELAY : WireType.ICE_RELAY, relayMsg);
        } else {
          this.signaling.sendRelay(peerId, relayMsg);
        }
      },
      onConnect: () => {
        this.emit('peer:connect', peer);
        // 接続が開いたら即座にチャレンジを送る。相手はこれに署名した JOIN を返す。
        const challenge = NodeIdentity.newChallenge();
        peer.setChallenge(challenge);
        this.sendMessage(peerId, WireType.HELLO, { challenge });
      },
      onDisconnect: () => {
        if (isStillCurrent()) this.disconnect(peerId);
      },
      onData: (data) => this.handleData(peerId, data),
    });

    created = peer;
    this._peers.set(peerId, peer);

    setTimeout(() => {
      if (isStillCurrent() && !peer.isConnected) this.disconnect(peerId);
    }, 15_000);

    // ハンドシェイクが完了しないピアは居座らせない
    setTimeout(() => {
      if (isStillCurrent() && !peer.isVerified) {
        log.warn(`Handshake timeout for ${peerId.substring(0, 8)} — dropping`);
        this.disconnect(peerId);
      }
    }, 30_000);

    return peer;
  }

  /**
   * 受信データの入口。ここで
   *   1. レート制限 (本家 18.11.3 —「実際の防御はレート制限」)
   *   2. ハンドシェイク未完了ピアの遮断
   * を掛けてからディスパッチする。
   */
  private handleData(peerId: PeerId, data: Uint8Array | string): void {
    if (this.misbehavior.isBanned(peerId)) {
      this.disconnect(peerId);
      return;
    }

    const decoded = (data instanceof Uint8Array)
      ? WireCodec.decode(data)
      : WireCodec.decode(new TextEncoder().encode(data));

    const peer = this._peers.get(peerId);
    // 違反点は「本人確認が済んだ peerId」にだけ付ける。未検証の接続の
    // peerId は名乗りに過ぎず、そこに点を付けると第三者を陥れられる。
    const authenticated = peer?.isVerified === true;

    if (decoded.type === WireType.UNKNOWN) {
      log.warn(`Dropped unknown wire message from ${peerId.substring(0, 8)}`);
      if (authenticated) {
        this.misbehavior.recordViolation(peerId, ViolationType.MALFORMED_WIRE, 'Unknown wire message');
      }
      this.disconnect(peerId);
      return;
    }

    const category = RATE_CATEGORY[decoded.type];
    if (category && !this.rateLimiter.allow(peerId, category)) {
      if (authenticated &&
          this.misbehavior.recordViolation(peerId, ViolationType.RATE_LIMIT_EXCEEDED, 'Rate limit exceeded')) {
        this.disconnect(peerId);
      }
      return;
    }

    if (!PRE_HANDSHAKE_TYPES.has(decoded.type) && !peer?.isVerified) {
      return;
    }

    this.dispatcher.dispatch(peerId, decoded.type, decoded.payload);
    this.emit('peer:data', peerId, data);
  }

  public sendMessage(peerId: PeerId, type: WireType, payload: any): void {
    const peer = this._peers.get(peerId);
    if (peer && peer.isConnected) {
      peer.send(WireCodec.encode(type, payload));
    }
  }

  public disconnect(peerId: PeerId): void {
    const peer = this._peers.get(peerId);
    if (peer) {
      peer.close();
      this._peers.delete(peerId);
      this.pexRoutes.delete(peerId);
      this.pendingSignals.delete(peerId);
      this.rateLimiter.forget(peerId);
      this.emit('peer:disconnect', peerId);
    }
  }

  public broadcast(msg: Uint8Array | string): void {
    for (const peer of this._peers.values()) {
      if (peer.isConnected) peer.send(msg);
    }
  }

  public on(event: string, handler: (...args: any[]) => void): void {
    const handlers = this.eventListeners.get(event) || [];
    handlers.push(handler);
    this.eventListeners.set(event, handlers);
  }

  public off(event: string, handler: (...args: any[]) => void): void {
    const handlers = this.eventListeners.get(event);
    if (handlers) {
      this.eventListeners.set(event, handlers.filter(h => h !== handler));
    }
  }

  private emit(event: string, ...args: any[]): void {
    const handlers = this.eventListeners.get(event);
    if (handlers) handlers.forEach((h) => h(...args));
  }
}
