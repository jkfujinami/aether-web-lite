import sodium from 'libsodium-wrappers';
import { PeerManager } from './network/PeerManager';
import { RingPosition } from './network/RingPosition';
import { PEXHandler } from './network/PEXHandler';
import { RingMaintainer } from './network/RingMaintainer';
import { Heartbeat } from './network/Heartbeat';
import { ZoneGossipRouter } from './network/gossip/ZoneGossipRouter';
import { ZoneManager } from './network/ZoneManager';
import { IndexedDBStore } from './storage/IndexedDBStore';
import { DHTMailbox } from './network/mailbox/DHTMailbox';
import { ReplicationManager } from './network/mailbox/ReplicationManager';
import { SyncProtocol } from './network/mailbox/SyncProtocol';
import { CryptoEngine } from './crypto/CryptoEngine';
import { PoWEngine } from './crypto/PoWEngine';
import { Identity } from './crypto/Identity';
import { App } from './ui/App';
import { KeyManager } from './crypto/KeyManager';
import type { IPoWEngine, IKeyManager } from './types';

async function bootstrap() {
  // 1. ノード情報の生成
  const ringPos = await RingPosition.loadOrCreate();
  const myPeerId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
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
  const pm = new PeerManager(myPeerId, ringPos.value);
  const zm = new ZoneManager(pm);
  pm.setZoneManager(zm); 
  
  const db = new IndexedDBStore();
  await db.init();

  const myIdentity = new Identity();
  await myIdentity.initTrip(db);
  
  const mailbox = new DHTMailbox(pm, db);
  const replicationMgr = new ReplicationManager(mailbox, pm, db);
  const syncProtocol = new SyncProtocol(mailbox, cryptoEng, keyMgr, db);

  const router = new ZoneGossipRouter(pm, zm);
  const pex = new PEXHandler(pm);
  const maintainer = new RingMaintainer(pm, pex);
  const heartbeat = new Heartbeat(pm);

  // 4. アプリケーション（UI）の起動
  const app = new App(
    pm, db, myIdentity, mailbox, cryptoEng, powEng, syncProtocol, router, zm
  );
  app.mount(document.body);

  // 5. バックグラウンドプロセスの開始
  heartbeat.start();
  replicationMgr.executeRebalance();

  // デバッグ用に露出
  Object.assign(window, { pm, pex, maintainer, router, db, mailbox, myIdentity, syncProtocol, zm, KeyManager });

  // 通信開始
  try {
    await pm.start();
    console.log('✅ Network signaling started.');
  } catch (err) {
    console.error('🔴 Network signaling failed:', err);
  }
}

bootstrap();

// Vite HMR Support
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    location.reload();
  });
}
