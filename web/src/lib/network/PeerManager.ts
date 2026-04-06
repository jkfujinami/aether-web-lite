import type { IPeerConnection, IPeerManager, PeerId, P2PMessage, IMessageDispatcher, ISignalingClient } from '../types';
import { WebRTCPeer } from './WebRTCPeer';
import { RingPosition } from './RingPosition';
import { RING_MESH } from '../constants';
import { ZoneManager } from './ZoneManager';
import { WireCodec } from './wire/WireCodec';
import { WireType } from './wire/WireTypes';

type BasePeerInfo = { peerId: PeerId; position: number; zones: number[] };

export class PeerManager implements IPeerManager {
  private _peers: Map<PeerId, WebRTCPeer> = new Map();
  private signaling: ISignalingClient;
  private eventListeners: Map<string, Array<(...args: any[]) => void>> = new Map();
  private pexRoutes: Map<PeerId, PeerId> = new Map();
  private pendingSignals: Map<PeerId, any[]> = new Map();
  private coolDowns: Map<PeerId, number> = new Map();

  public readonly myPeerId: PeerId;
  public readonly myPosition: number;
  private zoneManager: ZoneManager | null = null;
  private dispatcher: IMessageDispatcher;

  constructor(
    myPeerId: PeerId,
    myPosition: number,
    dispatcher: IMessageDispatcher,
    signaling: ISignalingClient
  ) {
    this.myPeerId = myPeerId;
    this.myPosition = myPosition;
    this.dispatcher = dispatcher;
    this.signaling = signaling;

    this.registerInternalHandlers();

    this.signaling.on('peers', (peers) => this.handleTrackerPeers(peers));
    this.signaling.on('relay', (senderId, payload) => this.handleRelay(senderId, payload));
  }

  private registerInternalHandlers() {
    // P2P Relay (SDP/ICE) の処理をディスパッチャに登録
    const handleRelay = (peerId: PeerId, msg: any, type: WireType) => {
      if (msg.targetPeerId === this.myPeerId) {
        const sender = msg.senderId;
        if (sender) {
          this.pexRoutes.set(sender, peerId);
          this.handleRelay(sender, msg);
        }
      } else if (this._peers.has(msg.targetPeerId)) {
        this.sendMessage(msg.targetPeerId, type, msg);
      }
    };

    this.dispatcher.register(WireType.SDP_RELAY, (peerId, payload) => handleRelay(peerId, payload, WireType.SDP_RELAY));
    this.dispatcher.register(WireType.ICE_RELAY, (peerId, payload) => handleRelay(peerId, payload, WireType.ICE_RELAY));

    // JOIN ハンドラ: 相手の自己紹介メッセージを受けて座標情報を更新
    this.dispatcher.register(WireType.JOIN, (peerId, msg) => {
      const peer = this._peers.get(peerId);
      if (peer) {
        if (msg.position !== undefined) peer.updatePosition(msg.position);
        if (msg.zones !== undefined) peer.updateZones(msg.zones);
        console.log(`[PeerManager] Peer ${peerId.substring(0,8)} joined/updated (pos: ${msg.position}, zones: ${JSON.stringify(msg.zones)})`);
      }
    });
  }

  public setZoneManager(zm: ZoneManager) {
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

  public async start(): Promise<void> {
    // ゾーン情報がまだ無い場合はデフォルト [0] で接続開始
    const zones = this.zoneManager 
      ? Array.from(this.zoneManager.subscribedZones)
      : [0];
      
    console.log(`[PeerManager] Starting as ${this.myPeerId} (pos: ${this.myPosition}) with ${zones.length} zones`);
    
    await this.signaling.connect({
      peerId: this.myPeerId,
      position: this.myPosition,
      zones: zones,
    });

    setTimeout(() => {
      console.log(`[PeerManager] Detaching from Tracker Server! Entering Fully Decentralized Mode.`);
      this.signaling.disconnect();
    }, 15_000);
  }

  private handleTrackerPeers(peers: BasePeerInfo[]): void {
    console.log(`[PeerManager] Received ${peers.length} peers from tracker`);
    
    // 🌟 Zone-aware 接続選択 (§5.1) 🌟
    const myZones = this.zoneManager?.subscribedZones ?? new Set([0]);
    peers.sort((a, b) => {
        const sharedA = a.zones.filter(z => myZones.has(z)).length;
        const sharedB = b.zones.filter(z => myZones.has(z)).length;
        return sharedB - sharedA;
    });

    for (const p of peers) {
      if (!this._peers.has(p.peerId) && this.degree < RING_MESH.MAX_DEGREE) {
        this.connect(p.peerId, p.position, p.zones, true);
      }
    }
  }

  private handleRelay(senderId: PeerId, msg: any): void {
    let peer = this._peers.get(senderId);

    if (!peer) {
      // ── オファーを受け取った場合は新規接続を作成 ──
      // msg.sdp?.type (内部タグ) または msg.type (V1/フラット) を確認
      const isOffer = msg.sdp?.type === 'offer' || msg.type === 'offer' || msg.type === 'sdp-relay';
      
      if (isOffer) {
        console.log(`[PeerManager] Received Offer via relay from ${senderId.substring(0,8)}`);
        if (this.degree >= RING_MESH.MAX_DEGREE) {
          const evicted = this.evictLongRangeLink();
          if (!evicted) return;
        }
        
        const remotePos = msg.position ?? 0;
        const remoteZones = msg.zones ?? [];
        const viaPeerId = this.pexRoutes.get(senderId);
        peer = this.connect(senderId, remotePos, remoteZones, false, viaPeerId);
        
        if (!peer) return;
        peer.signal(msg);
        
        const buffered = this.pendingSignals.get(senderId) || [];
        for (const sig of buffered) {
          peer.signal(sig);
        }
        this.pendingSignals.delete(senderId);
      } else {
        // オファー以外（ICE等）が先に来た場合は一旦バッファ
        if (this.coolDowns.has(senderId) && Date.now() - this.coolDowns.get(senderId)! < 30_000) return;
        const buffered = this.pendingSignals.get(senderId) || [];
        buffered.push(msg);
        this.pendingSignals.set(senderId, buffered);
      }
      return;
    }

    peer.signal(msg);
  }

  public connect(peerId: PeerId, position: number, zones: number[], initiator: boolean = true, viaPeerId?: PeerId): WebRTCPeer | undefined {
    const existing = this._peers.get(peerId);
    if (existing) {
      if (existing.isConnected || existing.isConnecting) {
        return existing;
      }
      // ゾンビ排除: Mapに存在するが死んでいるエントリを破棄して再試行を許可する
      console.log(`[PeerManager] Cleaning up zombie peer ${peerId.substring(0,8)} before reconnect`);
      this.disconnect(peerId);
    }

    const lastEvicted = this.coolDowns.get(peerId);
    if (lastEvicted && Date.now() - lastEvicted < 30_000) return undefined;

    if (viaPeerId) {
      this.pexRoutes.set(peerId, viaPeerId);
    }

    const peer = new WebRTCPeer({
      localId: this.myPeerId,
      remoteId: peerId,
      position,
      zones,
      initiator,
      onSignal: (payload) => {
        const myZones = this.zoneManager 
          ? Array.from(this.zoneManager.subscribedZones) 
          : [0];
          
        let relayMsg: any;
        if (payload.renegotiate || payload.type === 'offer' || payload.type === 'answer' || payload.type === 'rollback') {
          // RTCSessionDescription をプレーンオブジェクトに変換
          const sdpPlain = (typeof payload.toJSON === 'function') ? payload.toJSON() : { type: payload.type, sdp: payload.sdp };
          
          relayMsg = {
            type: 'sdp-relay',
            targetPeerId: peerId,
            senderId: this.myPeerId,
            position: this.myPosition,
            zones: myZones,
            sdp: sdpPlain
          };
        } else if (payload.candidate) {
          // RTCIceCandidate をプレーンオブジェクトに変換
          const icePlain = (typeof payload.toJSON === 'function') ? payload.toJSON() : payload;
          
          relayMsg = {
            type: 'ice-relay',
            targetPeerId: peerId,
            senderId: this.myPeerId,
            candidate: icePlain
          };
        }

        if (!relayMsg) return;

        const via = this.pexRoutes.get(peerId);
        if (via && this._peers.has(via)) {
          // P2P Relay
          this.sendMessage(via, relayMsg.type === 'sdp-relay' ? WireType.SDP_RELAY : WireType.ICE_RELAY, relayMsg);
        } else {
          // Tracker Relay
          this.signaling.sendRelay(peerId, relayMsg);
        }
      },
      onConnect: () => {
        this.emit('peer:connect', peer);
        // Wire V2 Join 送信
        this.sendMessage(peerId, WireType.JOIN, { peerId: this.myPeerId, position: this.myPosition });
      },
      onDisconnect: () => {
        this.disconnect(peerId);
      },
      onData: (data) => {
        console.log(`[PeerManager] onData from ${peerId.substring(0,8)}: size=${data instanceof Uint8Array ? data.length : (data as any).byteLength}`);
        // 1. WireCodec でのデコード試行
        const decoded = (data instanceof Uint8Array) 
          ? WireCodec.decode(data) 
          : WireCodec.decode(new TextEncoder().encode(data)); // String 互換

        if (decoded.type !== WireType.UNKNOWN) {
          console.log(`[PeerManager] Routing message 0x${decoded.type.toString(16)} to dispatcher`);
          // ── Dispatcher への配信 ──
          this.dispatcher.dispatch(peerId, decoded.type, decoded.payload);
        } else {
          console.warn(`[PeerManager] Dropped unknown wire message from ${peerId.substring(0,8)}`);
        }

        // 2. 既存の peer:data も継続して発火（後位互換）
        this.emit('peer:data', peerId, data);
      }
    });

    this._peers.set(peerId, peer);

    setTimeout(() => {
      const p = this._peers.get(peerId);
      if (p && !p.isConnected) {
        this.disconnect(peerId);
      }
    }, 15_000);

    return peer;
  }

  /**
   * 特定のピアにメッセージを送信する (Wire V2)
   */
  public sendMessage(peerId: PeerId, type: WireType, payload: any): void {
    const peer = this._peers.get(peerId);
    if (peer && peer.isConnected) {
      const binary = WireCodec.encode(type, payload);
      peer.send(binary);
    }
  }

  private evictLongRangeLink(): boolean {
    const connected = Array.from(this._peers.values()).filter(p => p.isConnected);
    if (connected.length === 0) return false;
    
    connected.sort((a, b) => {
      const dA = RingPosition.distance(this.myPosition, a.position);
      const dB = RingPosition.distance(this.myPosition, b.position);
      return dB - dA;
    });

    if (connected.length > RING_MESH.LOCAL_LINKS) {
      const victim = connected[0];
      this.coolDowns.set(victim.peerId, Date.now());
      this.disconnect(victim.peerId);
      return true;
    }
    return false;
  }

  public disconnect(peerId: PeerId): void {
    const peer = this._peers.get(peerId);
    if (peer) {
      peer.close();
      this._peers.delete(peerId);
      this.pexRoutes.delete(peerId);
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

  private emit(event: string, ...args: any[]): void {
    const handlers = this.eventListeners.get(event);
    if (handlers) {
      handlers.forEach((h) => h(...args));
    }
  }
}
