"use client";

import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import sodium from 'libsodium-wrappers';

import { PeerManager } from '@/lib/network/PeerManager';
import { SignalingClient } from '@/lib/network/SignalingClient';
import { BoardOrchestrator } from '@/lib/logic/BoardOrchestrator';
import { ThreadOrchestrator } from '@/lib/logic/ThreadOrchestrator';


import { MessageDispatcher } from '@/lib/network/MessageDispatcher';
import { RingPosition } from '@/lib/network/RingPosition';
import { PEXHandler } from '@/lib/network/PEXHandler';
import { RingMaintainer } from '@/lib/network/RingMaintainer';
import { Heartbeat } from '@/lib/network/Heartbeat';
import { ZoneGossipRouter } from '@/lib/network/gossip/ZoneGossipRouter';
import { ZoneManager } from '@/lib/network/ZoneManager';
import { IndexedDBStore } from '@/lib/storage/IndexedDBStore';
import { DHTMailbox } from '@/lib/network/mailbox/DHTMailbox';
import { ReplicationManager } from '@/lib/network/mailbox/ReplicationManager';
import { SyncProtocol } from '@/lib/network/mailbox/SyncProtocol';
import { CryptoEngine } from '@/lib/crypto/CryptoEngine';
import { PoWEngine } from '@/lib/crypto/PoWEngine';
import { Identity } from '@/lib/crypto/Identity';
import { KeyManager } from '@/lib/crypto/KeyManager';
import { Encoding } from '@/lib/common/Encoding';
import { CryptoUtils } from '@/lib/common/CryptoUtils';
import type { IPoWEngine, IKeyManager } from '@/lib/types';

interface P2PContextState {
  pm: PeerManager | null;
  db: IndexedDBStore | null;
  identity: Identity | null;
  mailbox: DHTMailbox | null;
  cryptoEng: CryptoEngine | null;
  powEng: IPoWEngine | null;
  keyMgr: IKeyManager | null;
  syncProtocol: SyncProtocol | null;
  router: ZoneGossipRouter | null;
  zm: ZoneManager | null;
  boardOrchestrator: BoardOrchestrator | null;
  threadOrchestrator: ThreadOrchestrator | null;
  isReady: boolean;

}

const P2PContext = createContext<P2PContextState>({
  pm: null,
  db: null,
  identity: null,
  mailbox: null,
  cryptoEng: null,
  powEng: null,
  keyMgr: null,
  syncProtocol: null,
  router: null,
  zm: null,
  boardOrchestrator: null,
  threadOrchestrator: null,
  isReady: false,

});

export const useP2P = () => useContext(P2PContext);

export function P2PProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<P2PContextState>({
    pm: null,
    db: null,
    identity: null,
    mailbox: null,
    cryptoEng: null,
    powEng: null,
    keyMgr: null,
    syncProtocol: null,
    router: null,
    zm: null,
    boardOrchestrator: null,
    threadOrchestrator: null,
    isReady: false,

  });

  // Strict mode 対策。初期化が2回走らないようにガードする
  const isInitializing = useRef(false);
  const backgroundProcesses = useRef<any[]>([]); // Heartbeat や Maintainer を保持

  useEffect(() => {
    if (isInitializing.current) return;
    isInitializing.current = true;

    async function bootstrap() {
      try {
        // 1. ノード情報の生成
        const ringPos = await RingPosition.loadOrCreate();
        const myPeerId = Encoding.toHex(CryptoUtils.randomBytes(16));
        
        console.log('Initializing AETHER Lite...', { myPeerId, pos: ringPos.value });

        // 2. エンジン群の初期化
        await sodium.ready;
        const cryptoEng = new CryptoEngine();
        
        const powEng: IPoWEngine = {
          compute: (data: Uint8Array, diff: number) => PoWEngine.compute(data, diff)
        };
        const keyMgr: IKeyManager = {
          deriveThreadKey: KeyManager.deriveThreadKey,
          deriveTopicHash: KeyManager.deriveTopicHash,
          computeZoneId: KeyManager.computeZoneId
        };

        // 3. ネットワーク・ストレージ基盤の初期化
        const dispatcher = new MessageDispatcher();
        const signaling = new SignalingClient();
        const pm = new PeerManager(myPeerId, ringPos.value, dispatcher, signaling);
        const zm = new ZoneManager(pm);
        pm.setZoneManager(zm); 
        
        const db = new IndexedDBStore();
        await db.init();

        const identity = new Identity();
        await identity.initTrip(db);
        
        const mailbox = new DHTMailbox(pm, dispatcher, db);
        const replicationMgr = new ReplicationManager(mailbox, pm, db);
        const syncProtocol = new SyncProtocol(mailbox, cryptoEng, keyMgr, db);

        const router = new ZoneGossipRouter(pm, dispatcher, zm);
        const pex = new PEXHandler(pm, dispatcher);
        const maintainer = new RingMaintainer(pm, pex);
        const heartbeat = new Heartbeat(pm, dispatcher);
        const boardOrchestrator = new BoardOrchestrator(pm, db, mailbox, router, cryptoEng, powEng, identity, zm, keyMgr);
        const threadOrchestrator = new ThreadOrchestrator(pm, db, mailbox, router, cryptoEng, powEng, identity, zm, keyMgr, syncProtocol);



        // バックグラウンドプロセスを Ref に保持
        backgroundProcesses.current = [heartbeat, maintainer, replicationMgr];

        // デバッグ用に露出（オリジナル処理の維持）
        Object.assign(window, { pm, pex, maintainer, router, db, mailbox, myIdentity: identity, syncProtocol, zm, KeyManager, signaling, boardOrchestrator, threadOrchestrator });



        setState({
          pm,
          db,
          identity,
          mailbox,
          cryptoEng,
          powEng,
          keyMgr,
          syncProtocol,
          router,
          zm: zm,
          boardOrchestrator: boardOrchestrator,
          threadOrchestrator: threadOrchestrator,
          isReady: true, // ここで UI 側がレンダリングを開始できる

        });

        // 4. バックグラウンドプロセスの開始
        heartbeat.start();
        replicationMgr.executeRebalance();

        // 5. 通信開始
        await pm.start();
        console.log('✅ Network signaling started.');
        
      } catch (err) {
        console.error('🔴 Network signaling failed:', err);
      }
    }

    bootstrap();

    // Cleanup関数 (コンポーネントアンマウント時)
    return () => {
      // 実際にはアプリ全体を包むProviderなのでアンマウントされることはほぼないが、
      // 開発時のリロード等でメモリリークを防ぐためクリーンアップ処理を記述
      if (state.pm) {
         // pm, heartbeat などのクローズ処理が必要ならここに書く
      }
    };
  }, []);

  if (!state.isReady) {
    return (
      <div style={{ padding: '50px', textAlign: 'center', fontFamily: 'monospace' }}>
        <h2>[ INITIALIZING AETHER NETWORK ]</h2>
        <p>Generating cryptographic keys and joining Ring-Mesh topology...</p>
      </div>
    );
  }

  return (
    <P2PContext.Provider value={state}>
      {children}
    </P2PContext.Provider>
  );
}
