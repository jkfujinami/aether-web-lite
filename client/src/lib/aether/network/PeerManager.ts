import type { IPeerConnection, IPeerManager, PeerId, P2PMessage } from '../types';
import { SignalingClient } from './SignalingClient';
import { WebRTCPeer } from './WebRTCPeer';
import { RingPosition } from './RingPosition';
import { RING_MESH } from '../constants';
import { ZoneManager } from './ZoneManager';

type BasePeerInfo = { peerId: PeerId; position: number; zones: number[] };

export class PeerManager implements IPeerManager {
  private _peers: Map<PeerId, WebRTCPeer> = new Map();
  private signaling: SignalingClient;
  private eventListeners: Map<string, Array<(...args: any[]) => void>> = new Map();
  private pexRoutes: Map<PeerId, PeerId> = new Map();
  private pendingSignals: Map<PeerId, any[]> = new Map();
  private coolDowns: Map<PeerId, number> = new Map();

  public readonly myPeerId: PeerId;
  public readonly myPosition: number;
  private zoneManager: ZoneManager | null = null;

  constructor(
    myPeerId: PeerId,
    myPosition: number
  ) {
    this.myPeerId = myPeerId;
    this.myPosition = myPosition;
    this.signaling = new SignalingClient();

    this.signaling.on('peers', (peers) => this.handleTrackerPeers(peers));
    this.signaling.on('relay', (senderId, payload) => this.handleRelay(senderId, payload));
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
    }, 180_000); // 3 minutes safety margin for P2P settlement
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
      // msg.sdp?.type (ネスト) または msg.type (フラット) を確認
      const isOffer = msg.sdp?.type === 'offer' || msg.type === 'offer';
      
      if (isOffer) {
        if (this.degree >= RING_MESH.MAX_DEGREE) {
          const evicted = this.evictLongRangeLink();
          if (!evicted) return;
        }
        
        const remotePos = msg.position ?? 0;
        const remoteZones = msg.zones ?? [];
        const viaPeerId = this.pexRoutes.get(senderId);
        peer = this.connect(senderId, remotePos, remoteZones, false, viaPeerId);
        
        if (!peer) return;
        // WebRTCPeer.signal() は msg.sdp / msg.candidate を内部で処理する
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
    if (this._peers.has(peerId)) {
      return this._peers.get(peerId)!;
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
          relayMsg = {
            type: 'sdp-relay',
            targetPeerId: peerId,
            senderId: this.myPeerId,
            position: this.myPosition,
            zones: myZones,
            sdp: payload
          };
        } else if (payload.candidate) {
          relayMsg = {
            type: 'ice-relay',
            targetPeerId: peerId,
            senderId: this.myPeerId,
            candidate: payload
          };
        }

        if (!relayMsg) return;

        const via = this.pexRoutes.get(peerId);
        if (via && this._peers.has(via)) {
          // P2P Relay (via existing neighbor)
          this._peers.get(via)!.send(JSON.stringify(relayMsg));
        } else {
          // Tracker Relay
          this.signaling.sendRelay(peerId, relayMsg);
        }
      },
      onConnect: () => {
        this.emit('peer:connect', peer);
        const msg: P2PMessage = { type: 'join', peerId: this.myPeerId, position: this.myPosition };
        peer.send(JSON.stringify(msg));
      },
      onDisconnect: () => {
        this.disconnect(peerId);
      },
      onData: (data) => {
        if (typeof data === 'string') {
          try {
            const msg = JSON.parse(data) as P2PMessage;
            if (msg.type === 'sdp-relay' || msg.type === 'ice-relay') {
              if (msg.targetPeerId === this.myPeerId) {
                const sender = msg.senderId;
                if (sender) {
                  this.pexRoutes.set(sender, peerId);
                  this.handleRelay(sender, msg);
                }
              } else if (this._peers.has(msg.targetPeerId)) {
                this._peers.get(msg.targetPeerId)!.send(data);
              }
              return;
            }
          } catch (e) { }
        }
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
  
  public off(event: string, handler: (...args: any[]) => void): void {
    const handlers = this.eventListeners.get(event);
    if (handlers) {
      this.eventListeners.set(event, handlers.filter(h => h !== handler));
    }
  }

  private emit(event: string, ...args: any[]): void {
    const handlers = this.eventListeners.get(event);
    if (handlers) {
      handlers.forEach((h) => h(...args));
    }
  }
}
