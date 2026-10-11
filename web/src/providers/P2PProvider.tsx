"use client";

import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { sodiumReady } from '@/lib/crypto/sodium';

import { PeerManager } from '@/lib/network/PeerManager';
import { SignalingClient } from '@/lib/network/SignalingClient';
import { BoardOrchestrator } from '@/lib/logic/BoardOrchestrator';
import { ThreadOrchestrator } from '@/lib/logic/ThreadOrchestrator';


import { MessageDispatcher } from '@/lib/network/MessageDispatcher';
import { NodeIdentityStore } from '@/lib/crypto/NodeIdentityStore';
import { RateLimiter } from '@/lib/network/RateLimiter';
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
import type { IPoWEngine, IKeyManager } from '@/lib/types';
import { installConsoleHandle, createLogger } from '@/lib/common/Logger';
import { DandelionRouter } from '@/lib/network/gossip/DandelionRouter';
import { HintRouter } from '@/lib/network/hint/HintRouter';
import { SchrodingerMailbox } from '@/lib/network/hint/SchrodingerMailbox';

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
  hintRouter: HintRouter | null;
  isReady: boolean;

}

export const P2PContext = createContext<P2PContextState>({
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
  hintRouter: null,
  isReady: false,

});

export const useP2P = () => useContext(P2PContext);

/**
 * テストから依存を差し込むための出口。
 * 本番コードは P2PProvider を使うこと。
 */
export const P2PContextForTest = P2PContext;

const log = createLogger('p2p');

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
    hintRouter: null,
    isReady: false,

  });

  // Strict mode 対策。初期化が2回走らないようにガードする
  const isInitializing = useRef(false);
  const backgroundProcesses = useRef<any[]>([]); // Heartbeat や Maintainer を保持

  useEffect(() => {
    if (isInitializing.current) return;
    isInitializing.current = true;

    // ブラウザのコンソールから実行中にログレベルを変えられるようにする。
    //   aetherLog.set('net.gossip', 'trace')
    //   aetherLog.show()
    // 実網のデバッグでは「今動いている状態のまま」上げたいので、
    // 再読み込み不要で効くことが重要。
    installConsoleHandle();

    async function bootstrap() {
      try {
        // 1. ストレージを先に開く (ノード identity の復元に必要)
        await sodiumReady;
        const db = new IndexedDBStore();
        await db.init();

        // 2. Bound Identity。
        //    peerId は Ed25519 公開鍵のハッシュ、リング座標は peerId のハッシュ。
        //    どちらも自己申告できないので、狙った座標への着地には
        //    NodeId PoW (Argon2id) を通した鍵グラインドが必要になる。
        //    採掘結果は封印して IndexedDB に保存し、次回以降は復元する。
        const nodeIdentity = await NodeIdentityStore.loadOrMine(db);
        const myPeerId = nodeIdentity.peerId;

        console.log('Initializing AETHER Lite...', { myPeerId, pos: nodeIdentity.position });

        // 3. エンジン群の初期化
        const cryptoEng = new CryptoEngine();

        const powEng: IPoWEngine = {
          compute: (header) => PoWEngine.compute(header)
        };
        const keyMgr: IKeyManager = {
          deriveThreadKey: KeyManager.deriveThreadKey,
          deriveTopicHash: KeyManager.deriveTopicHash,
          computeZoneId: KeyManager.computeZoneId
        };

        // 4. ネットワーク基盤の初期化
        const dispatcher = new MessageDispatcher();
        const signaling = new SignalingClient();
        const rateLimiter = new RateLimiter();
        const pm = new PeerManager(nodeIdentity, dispatcher, signaling, { rateLimiter });
        const zm = new ZoneManager(pm);
        pm.setZoneManager(zm);

        const identity = new Identity();
        await identity.initTrip(db);
        
        // ★ Dandelion は Gossip / Hint / PUT で共有する。
        //   別インスタンスにするとエポック対象が増え、観測者に渡す辺が
        //   その数だけ増えて §3.1 の前提が崩れる。
        const dandelion = new DandelionRouter(pm);
        const mailbox = new DHTMailbox(pm, dispatcher, db, dandelion);
        const replicationMgr = new ReplicationManager(mailbox, pm, db);
        const syncProtocol = new SyncProtocol(mailbox, cryptoEng, keyMgr, db);

        // ★ Dandelion は Gossip と Hint で共有する。
        //   別インスタンスにするとエポック対象が 2 つになり、
        //   観測者に渡す辺が 1 本増えて匿名性の前提が崩れる。
        const router = new ZoneGossipRouter(pm, dispatcher, zm, dandelion);
        const hintRouter = new HintRouter(pm, dispatcher, dandelion);
        // 時間分離は Adaptive 既定。網が小さいうちは遅延せず、
        // 育つと自動的に効き始める (§18.4.5)。
        const schrodinger = new SchrodingerMailbox(mailbox, hintRouter, pm, 'adaptive');
        // 保持者による Hint の再放流。これが無いと、後から参加した人が
        // 過去ログを一切発見できなくなる (§18.3-A)。
        schrodinger.startReflood();
        const pex = new PEXHandler(pm, dispatcher);
        const maintainer = new RingMaintainer(pm, pex);
        const heartbeat = new Heartbeat(pm, dispatcher);
        const boardOrchestrator = new BoardOrchestrator(pm, db, mailbox, router, cryptoEng, powEng, identity, zm, keyMgr, schrodinger);
        const threadOrchestrator = new ThreadOrchestrator(pm, db, mailbox, router, cryptoEng, powEng, identity, zm, keyMgr, syncProtocol, schrodinger);



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
          hintRouter,
          isReady: true, // ここで UI 側がレンダリングを開始できる

        });

        // 5. バックグラウンドプロセスの開始
        heartbeat.start();
        replicationMgr.executeRebalance();

        // 6. 通信開始
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
