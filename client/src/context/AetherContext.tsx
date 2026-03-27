'use client';

import React, { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import sodium from 'libsodium-wrappers';
import { PeerManager } from '@/lib/aether/network/PeerManager';
import { RingPosition } from '@/lib/aether/network/RingPosition';
import { PEXHandler } from '@/lib/aether/network/PEXHandler';
import { RingMaintainer } from '@/lib/aether/network/RingMaintainer';
import { Heartbeat } from '@/lib/aether/network/Heartbeat';
import { ZoneGossipRouter } from '@/lib/aether/network/gossip/ZoneGossipRouter';
import { ZoneManager } from '@/lib/aether/network/ZoneManager';
import { IndexedDBStore } from '@/lib/aether/storage/IndexedDBStore';
import { DHTMailbox } from '@/lib/aether/network/mailbox/DHTMailbox';
import { ReplicationManager } from '@/lib/aether/network/mailbox/ReplicationManager';
import { SyncProtocol } from '@/lib/aether/network/mailbox/SyncProtocol';
import { CryptoEngine } from '@/lib/aether/crypto/CryptoEngine';
import { PoWEngine } from '@/lib/aether/crypto/PoWEngine';
import { Identity } from '@/lib/aether/crypto/Identity';
import { KeyManager } from '@/lib/aether/crypto/KeyManager';
import type { IPoWEngine, IKeyManager } from '@/lib/aether/types';

interface AetherContextType {
  isReady: boolean;
  peerManager: PeerManager | null;
  db: IndexedDBStore | null;
  identity: Identity | null;
  mailbox: DHTMailbox | null;
  syncProtocol: SyncProtocol | null;
  router: ZoneGossipRouter | null;
  zm: ZoneManager | null;
  cryptoEngine: CryptoEngine | null;
  powEngine: IPoWEngine | null;
  keyManager: IKeyManager | null;
  
  // リアルタイム統計
  peerCount: number;
}

const AetherContext = createContext<AetherContextType | undefined>(undefined);

export function AetherProvider({ children }: { children: ReactNode }) {
  const [isReady, setIsReady] = useState(false);
  const [peerCount, setPeerCount] = useState(0);
  
  // インスタンスを保持する refs
  const pmRef = useRef<PeerManager | null>(null);
  const dbRef = useRef<IndexedDBStore | null>(null);
  const idRef = useRef<Identity | null>(null);
  const mailboxRef = useRef<DHTMailbox | null>(null);
  const syncRef = useRef<SyncProtocol | null>(null);
  const routerRef = useRef<ZoneGossipRouter | null>(null);
  const zmRef = useRef<ZoneManager | null>(null);
  const cryptoRef = useRef<CryptoEngine | null>(null);

  const powEngine: IPoWEngine = {
    compute: (data: Uint8Array, diff: number) => PoWEngine.compute(data, diff)
  };

  const keyManager: IKeyManager = {
    deriveThreadKey: KeyManager.deriveThreadKey,
    deriveTopicHash: KeyManager.deriveTopicHash,
    computeZoneId: KeyManager.computeZoneId
  };

  useEffect(() => {
    async function initAether() {
      if (typeof window === 'undefined') return;

      console.log('🚀 Initializing Aether Engine...');
      
      // 1. WASM & ストレージ初期化
      await sodium.ready;
      const db = new IndexedDBStore();
      await db.init();
      dbRef.current = db;

      // 2. ノード情報の生成
      const ringPos = await RingPosition.loadOrCreate();
      const myPeerId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      // 3. エンジン群の構築
      const cryptoEng = new CryptoEngine();
      cryptoRef.current = cryptoEng;

      const pm = new PeerManager(myPeerId, ringPos.value);
      pmRef.current = pm;

      const zm = new ZoneManager(pm);
      zmRef.current = zm;
      pm.setZoneManager(zm);

      const identity = new Identity();
      await identity.initTrip(db);
      idRef.current = identity;

      const mailbox = new DHTMailbox(pm, db);
      mailboxRef.current = mailbox;

      const replicationMgr = new ReplicationManager(mailbox, pm, db);
      const syncProtocol = new SyncProtocol(mailbox, cryptoEng, keyManager, db);
      syncRef.current = syncProtocol;

      const router = new ZoneGossipRouter(pm, zm);
      routerRef.current = router;

      const pex = new PEXHandler(pm);
      const maintainer = new RingMaintainer(pm, pex);
      const heartbeat = new Heartbeat(pm);

      // 4. 通信開始
      heartbeat.start();
      replicationMgr.executeRebalance();
      
      try {
        console.log('📡 [AetherContext] Attempting to start PeerManager...');
        await pm.start();
        console.log('✅ [AetherContext] PeerManager.start() COMPLETED. Signaling should be active.');
      } catch (err) {
        console.error('🔴 [AetherContext] FATAL: Network start failed:', err);
      }

      // ピア数の監視
      const updatePeerCount = () => setPeerCount(pm.degree);
      pm.on('peer:connect', updatePeerCount);
      pm.on('peer:disconnect', updatePeerCount);

      // デバッグ用
      (window as any).aether = { pm, db, identity, mailbox, syncProtocol, router, KeyManager };

      setIsReady(true);
    }

    initAether();

    return () => {
      // 終了時のクリーンアップ処理（必要に応じて）
    };
  }, []);

  const value: AetherContextType = {
    isReady,
    peerManager: pmRef.current,
    db: dbRef.current,
    identity: idRef.current,
    mailbox: mailboxRef.current,
    syncProtocol: syncRef.current,
    router: routerRef.current,
    zm: zmRef.current,
    cryptoEngine: cryptoRef.current,
    powEngine,
    keyManager,
    peerCount
  };

  return (
    <AetherContext.Provider value={value}>
      {children}
    </AetherContext.Provider>
  );
}

export function useAether() {
  const context = useContext(AetherContext);
  if (context === undefined) {
    throw new Error('useAether must be used within an AetherProvider');
  }
  return context;
}
