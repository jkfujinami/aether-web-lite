import sodium, { sodiumReady } from '../crypto/sodium';
import { IndexedDBStore } from '../storage/IndexedDBStore';
import { NodeIdentityStore } from '../crypto/NodeIdentityStore';
import type { NodeIdentity } from '../crypto/NodeIdentity';
import { CryptoEngine } from '../crypto/CryptoEngine';
import { PoWEngine } from '../crypto/PoWEngine';
import { KeyManager } from '../crypto/KeyManager';
import { Identity } from '../crypto/Identity';
import { MessageDispatcher } from '../network/MessageDispatcher';
import { SignalingClient } from '../network/SignalingClient';
import { RateLimiter } from '../network/RateLimiter';
import { PeerManager } from '../network/PeerManager';
import { ZoneManager } from '../network/ZoneManager';
import { DandelionRouter } from '../network/gossip/DandelionRouter';
import { ZoneGossipRouter } from '../network/gossip/ZoneGossipRouter';
import { DHTMailbox } from '../network/mailbox/DHTMailbox';
import { ReplicationManager } from '../network/mailbox/ReplicationManager';
import { SyncProtocol } from '../network/mailbox/SyncProtocol';
import { HintRouter } from '../network/hint/HintRouter';
import { SchrodingerMailbox } from '../network/hint/SchrodingerMailbox';
import type { ReleaseMode } from '../network/hint/HintRelease';
import { PEXHandler } from '../network/PEXHandler';
import { RingMaintainer } from '../network/RingMaintainer';
import { Heartbeat } from '../network/Heartbeat';
import { BoardOrchestrator } from '../logic/BoardOrchestrator';
import { ThreadOrchestrator } from '../logic/ThreadOrchestrator';
import type { IPoWEngine, IKeyManager, ISignalingClient } from '../types';
import { createLogger } from '../common/Logger';

const log = createLogger('node.facade');

export interface AetherNodeConfig {
  signalingUrl?: string;
  signalingClient?: ISignalingClient;
  turnstileToken?: string;
  releaseMode?: ReleaseMode;
  db?: IndexedDBStore;
  autoStart?: boolean;
}

/**
 * AetherNode — WebLite プロトコルスタック全体をカプセル化する統合ノードファサード。
 *
 * 内部で 15 以上のサブシステム (PeerManager, ZoneManager, Dandelion++,
 * SchrodingerMailbox, DHT, Orchestrators 等) を自動配線し、
 * 単一のエントリポイントとして提供する。
 */
export class AetherNode {
  public readonly db: IndexedDBStore;
  public readonly nodeIdentity: NodeIdentity;
  public readonly identity: Identity;
  public readonly cryptoEngine: CryptoEngine;
  public readonly keyManager: IKeyManager;
  public readonly powEngine: IPoWEngine;

  public readonly dispatcher: MessageDispatcher;
  public readonly signaling: ISignalingClient;
  public readonly rateLimiter: RateLimiter;
  public readonly peerManager: PeerManager;
  public readonly zoneManager: ZoneManager;
  public readonly dandelion: DandelionRouter;
  public readonly mailbox: DHTMailbox;
  public readonly replicationManager: ReplicationManager;
  public readonly syncProtocol: SyncProtocol;
  public readonly gossipRouter: ZoneGossipRouter;
  public readonly hintRouter: HintRouter;
  public readonly schrodinger: SchrodingerMailbox;
  public readonly pex: PEXHandler;
  public readonly maintainer: RingMaintainer;
  public readonly heartbeat: Heartbeat;

  public readonly boardOrchestrator: BoardOrchestrator;
  public readonly threadOrchestrator: ThreadOrchestrator;

  private isStarted = false;

  private constructor(
    params: {
      db: IndexedDBStore;
      nodeIdentity: NodeIdentity;
      identity: Identity;
      cryptoEngine: CryptoEngine;
      keyManager: IKeyManager;
      powEngine: IPoWEngine;
      dispatcher: MessageDispatcher;
      signaling: ISignalingClient;
      rateLimiter: RateLimiter;
      peerManager: PeerManager;
      zoneManager: ZoneManager;
      dandelion: DandelionRouter;
      mailbox: DHTMailbox;
      replicationManager: ReplicationManager;
      syncProtocol: SyncProtocol;
      gossipRouter: ZoneGossipRouter;
      hintRouter: HintRouter;
      schrodinger: SchrodingerMailbox;
      pex: PEXHandler;
      maintainer: RingMaintainer;
      heartbeat: Heartbeat;
      boardOrchestrator: BoardOrchestrator;
      threadOrchestrator: ThreadOrchestrator;
    },
  ) {
    this.db = params.db;
    this.nodeIdentity = params.nodeIdentity;
    this.identity = params.identity;
    this.cryptoEngine = params.cryptoEngine;
    this.keyManager = params.keyManager;
    this.powEngine = params.powEngine;
    this.dispatcher = params.dispatcher;
    this.signaling = params.signaling;
    this.rateLimiter = params.rateLimiter;
    this.peerManager = params.peerManager;
    this.zoneManager = params.zoneManager;
    this.dandelion = params.dandelion;
    this.mailbox = params.mailbox;
    this.replicationManager = params.replicationManager;
    this.syncProtocol = params.syncProtocol;
    this.gossipRouter = params.gossipRouter;
    this.hintRouter = params.hintRouter;
    this.schrodinger = params.schrodinger;
    this.pex = params.pex;
    this.maintainer = params.maintainer;
    this.heartbeat = params.heartbeat;
    this.boardOrchestrator = params.boardOrchestrator;
    this.threadOrchestrator = params.threadOrchestrator;
  }

  /**
   * ノードを非同期生成・初期化する。
   */
  public static async create(config: AetherNodeConfig = {}): Promise<AetherNode> {
    await sodiumReady;

    // 1. ストレージ
    const db = config.db || new IndexedDBStore();
    if (!config.db) {
      await db.init();
    }

    // 2. Bound Identity
    const nodeIdentity = await NodeIdentityStore.loadOrMine(db);
    log.info(() => `Node identity initialized: ${nodeIdentity.peerId} pos=${nodeIdentity.position}`);

    // 3. エンジン群
    const cryptoEngine = new CryptoEngine();
    const powEngine: IPoWEngine = {
      compute: (header) => PoWEngine.compute(header),
    };
    const keyManager: IKeyManager = {
      deriveThreadKey: KeyManager.deriveThreadKey,
      deriveTopicHash: KeyManager.deriveTopicHash,
      computeZoneId: KeyManager.computeZoneId,
    };

    // 4. 通信・ルーティング
    const dispatcher = new MessageDispatcher();
    const signaling = config.signalingClient || new SignalingClient(config.signalingUrl);
    const rateLimiter = new RateLimiter();
    const peerManager = new PeerManager(nodeIdentity, dispatcher, signaling, { rateLimiter });
    const zoneManager = new ZoneManager(peerManager);
    peerManager.setZoneManager(zoneManager);

    const identity = new Identity();
    await identity.initTrip(db);

    const dandelion = new DandelionRouter(peerManager);
    const mailbox = new DHTMailbox(peerManager, dispatcher, db, dandelion);
    const replicationManager = new ReplicationManager(mailbox, peerManager, db);
    const syncProtocol = new SyncProtocol(mailbox, cryptoEngine, keyManager, db);

    const gossipRouter = new ZoneGossipRouter(peerManager, dispatcher, zoneManager, dandelion);
    const hintRouter = new HintRouter(peerManager, dispatcher, dandelion);
    const schrodinger = new SchrodingerMailbox(
      mailbox,
      hintRouter,
      peerManager,
      config.releaseMode || 'adaptive',
    );

    const pex = new PEXHandler(peerManager, dispatcher);
    const maintainer = new RingMaintainer(peerManager, pex);
    const heartbeat = new Heartbeat(peerManager, dispatcher);

    const boardOrchestrator = new BoardOrchestrator(
      peerManager,
      db,
      mailbox,
      gossipRouter,
      cryptoEngine,
      powEngine,
      identity,
      zoneManager,
      keyManager,
      schrodinger,
    );

    const threadOrchestrator = new ThreadOrchestrator(
      peerManager,
      db,
      mailbox,
      gossipRouter,
      cryptoEngine,
      powEngine,
      identity,
      zoneManager,
      keyManager,
      syncProtocol,
      schrodinger,
    );

    const node = new AetherNode({
      db,
      nodeIdentity,
      identity,
      cryptoEngine,
      keyManager,
      powEngine,
      dispatcher,
      signaling,
      rateLimiter,
      peerManager,
      zoneManager,
      dandelion,
      mailbox,
      replicationManager,
      syncProtocol,
      gossipRouter,
      hintRouter,
      schrodinger,
      pex,
      maintainer,
      heartbeat,
      boardOrchestrator,
      threadOrchestrator,
    });

    if (config.autoStart) {
      await node.start();
    }

    return node;
  }

  /**
   * P2P ネットワークへ参加し、バックグラウンドメンテナを起動する。
   */
  public async start(): Promise<void> {
    if (this.isStarted) return;
    this.isStarted = true;

    this.schrodinger.startReflood();
    this.heartbeat.start();
    this.replicationManager.executeRebalance();

    try {
      await this.peerManager.start();
    } catch (err) {
      log.warn('Could not connect to signaling tracker on start, continuing in local/p2p mode', err);
    }
    log.info(() => `AetherNode started. PeerId: ${this.nodeIdentity.peerId}`);
  }

  /**
   * ノードの全通信を停止し、リソースを解放する。
   */
  public async stop(): Promise<void> {
    if (!this.isStarted) return;
    this.isStarted = false;

    this.schrodinger.destroy();
    for (const peerId of this.peerManager.peers.keys()) {
      this.peerManager.disconnect(peerId);
    }
    this.signaling.disconnect();
    log.info(() => 'AetherNode stopped');
  }

  public get peerId(): string {
    return this.nodeIdentity.peerId;
  }

  public get degree(): number {
    return this.peerManager.degree;
  }

  public get running(): boolean {
    return this.isStarted;
  }
}
