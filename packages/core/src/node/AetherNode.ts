import sodium, { sodiumReady } from '../crypto/sodium';
import { IndexedDBStore } from '../storage/IndexedDBStore';
import type { VaultParams } from '../storage/SecretVault';
import { NodeIdentityStore } from '../crypto/NodeIdentityStore';
import type { NodeIdentity } from '../crypto/NodeIdentity';
import { CryptoEngine } from '../crypto/CryptoEngine';
import { PoWEngine } from '../crypto/PoWEngine';
import { KeyManager } from '../crypto/KeyManager';
import { Identity } from '../crypto/Identity';
import { MessageDispatcher } from '../network/MessageDispatcher';
import { SignalingClient, TrackerNotConfiguredError } from '../network/SignalingClient';
import { parseTrackerUrl } from '../network/TrackerUrl';
import { RateLimiter } from '../network/RateLimiter';
import { PeerManager } from '../network/PeerManager';
import { ZoneManager } from '../network/ZoneManager';
import { DandelionRouter } from '../network/gossip/DandelionRouter';
import { OnionCircuit, type OnionCircuitOptions, type AnonymityLevel } from '../network/onion/OnionCircuit';
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
  /**
   * トラッカー (シグナリングサーバ) の URL。公式のトラッカーは無いので利用者が設定する。
   * wss:// のみ (ws:// は localhost に限る)。未設定 (null / 省略) なら接続しない。
   * 起動後の変更は {@link AetherNode.setTrackerUrl}。
   */
  trackerUrl?: string | null;
  signalingClient?: ISignalingClient;
  turnstileToken?: string;
  releaseMode?: ReleaseMode;
  db?: IndexedDBStore;
  autoStart?: boolean;
  /** オニオン回路の匿名性レベル ('standard' | 'safer' | 'safest') */
  anonymityLevel?: AnonymityLevel;
  /** オニオン回路のパラメータ (テスト用に遅延を縮めるときなど) */
  circuit?: OnionCircuitOptions;
  /**
   * ノード identity (peerId) の扱い。
   *
   * - 'ephemeral' (既定): 起動ごとに採掘し直し、保存しない。セッションを跨いで
   *   同一端末だと紐付けられない。起動時に数秒の採掘が掛かる。
   * - 'persistent': パスフレーズで封印して保存する。`passphrase` が必須。
   */
  identityMode?: 'ephemeral' | 'persistent';
  /**
   * 端末に保存する全データ (投稿・スレッド統計・板の鍵・保管中の Slot・ノード鍵・トリップ鍵)
   * の暗号化に使うパスワード。**必須**。
   *
   * 忘れた場合の復元手段は無い。{@link IndexedDBStore.wipeAll} で全消去して作り直す。
   */
  passphrase?: string;
  /** パスワードからの鍵導出 (Argon2id) のパラメータ。テストで軽くするときだけ指定する */
  vaultParams?: VaultParams;
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
  public readonly circuit: OnionCircuit;
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
  private isDestroyed = false;

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
      circuit: OnionCircuit;
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
    this.circuit = params.circuit;
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

    // 不正なトラッカー URL は、鍵の導出やデータの解錠より前に拒否する
    if (config.trackerUrl && !config.signalingClient) {
      const parsed = parseTrackerUrl(config.trackerUrl);
      if (!parsed.ok) throw new Error(`invalid tracker URL: ${parsed.reason}`);
    }

    // 1. ストレージ (パスワード必須。ロックを解除しない限りデータは読み書きできない)
    const passphrase = config.passphrase ?? '';
    if (passphrase.length === 0) {
      throw new RangeError('AetherNode.create: a non-empty passphrase is required (local data is encrypted with it)');
    }
    const db = config.db || new IndexedDBStore();
    await db.init();
    await db.unlock(passphrase, config.vaultParams);
    try {
      return await AetherNode.wire(db, passphrase, config);
    } catch (err) {
      // 起動が途中で失敗したら鍵をメモリに残さない。残すと、次の試行が
      // パスワードを照合せずに「解除済み」として通ってしまう。
      db.lock();
      throw err;
    }
  }

  private static async wire(db: IndexedDBStore, passphrase: string, config: AetherNodeConfig): Promise<AetherNode> {

    // 2. Bound Identity
    const nodeIdentity = config.identityMode === 'persistent'
      ? await NodeIdentityStore.loadOrMine(db, passphrase)
      : await NodeIdentityStore.mineEphemeral(db);
    log.debug(() => `Node identity initialized (${config.identityMode ?? 'ephemeral'})`);

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
    const signaling = config.signalingClient || new SignalingClient(config.trackerUrl ?? null);
    const rateLimiter = new RateLimiter();
    const peerManager = new PeerManager(nodeIdentity, dispatcher, signaling, { rateLimiter });
    const zoneManager = new ZoneManager(peerManager);
    peerManager.setZoneManager(zoneManager);

    const identity = new Identity();
    await identity.initTrip(db, passphrase);

    const dandelion = new DandelionRouter(peerManager);
    const circuitOptions: OnionCircuitOptions = {
      level: config.anonymityLevel,
      ...config.circuit,
    };
    const circuit = new OnionCircuit(peerManager, dispatcher, dandelion, circuitOptions);
    const mailbox = new DHTMailbox(peerManager, dispatcher, db, circuit);
    const replicationManager = new ReplicationManager(mailbox, peerManager, db);
    const syncProtocol = new SyncProtocol(mailbox, cryptoEngine, keyManager, db);

    const gossipRouter = new ZoneGossipRouter(peerManager, dispatcher, zoneManager, dandelion, circuit);
    const hintRouter = new HintRouter(peerManager, dispatcher, dandelion, circuit);
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
      circuit,
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
    if (this.isDestroyed) {
      throw new Error('AetherNode: a stopped node cannot be restarted; create a new one');
    }
    if (this.isStarted) return;
    this.isStarted = true;

    this.schrodinger.startReflood();
    this.heartbeat.start();
    // cover traffic は投稿の有無に関係なく起動直後から流す (OnionCircuit.start 参照)
    this.circuit.start();
    this.mailbox.startMaintenance();
    this.replicationManager.executeRebalance();

    try {
      await this.peerManager.start();
    } catch (err) {
      if (err instanceof TrackerNotConfiguredError) {
        log.info(() => 'No tracker configured; waiting for one to be set');
      } else {
        // URL はログに出さない (どのネットワークに参加しているかの手掛かりになる)
        log.warn(() => 'Could not reach the tracker on start; will retry periodically');
      }
    }
    log.info(() => 'AetherNode started');
  }

  /**
   * ノードの全通信を停止し、リソースを解放する。
   */
  /**
   * ノードの全通信を止め、全タイマーを解放する。停止は終端で、再開はできない。
   *
   * ★ 旧実装は Schrödinger の再放流を止めて接続を切るだけだった。
   *   PeerManager の再アナウンスタイマーが生き残り、停止後も 30 秒ごとに
   *   トラッカーへ peerId と IP を再登録して接続を張り直していた。
   *   heartbeat / maintainer / replication / zone / 各ルータのタイマーも残っていた。
   */
  public async stop(): Promise<void> {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.isStarted = false;

    this.boardOrchestrator.clear();
    this.threadOrchestrator.clear();
    this.schrodinger.destroy();
    this.circuit.destroy();
    this.heartbeat.stop();
    this.maintainer.destroy();
    this.replicationManager.destroy();
    this.mailbox.stopMaintenance();
    this.zoneManager.destroy();
    this.gossipRouter.destroy();
    this.hintRouter.destroy();
    this.peerManager.stop(); // 再アナウンス停止・トラッカー切断・全ピア切断
    this.db.lock(); // メモリ上のデータ鍵を消す
    log.info(() => 'AetherNode stopped');
  }

  /**
   * 緊急消去 (パニックワイプ)。
   *
   * 通信を止め、データ鍵の封印を消してからデータベースごと削除する。
   * 鍵の封印を消した時点で、残りのデータは誰にも読めなくなる。元には戻せない。
   */
  public async panicWipe(): Promise<void> {
    await this.stop();
    await this.db.wipeAll();
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

  /** 現在のトラッカー URL (未設定なら null) */
  public get trackerUrl(): string | null {
    return this.signaling.url ?? null;
  }

  /** トラッカーへ接続中か (登録後しばらくすると切り離すので、普段は false) */
  public get trackerConnected(): boolean {
    return this.signaling.isConnected === true;
  }

  /**
   * トラッカーを変更する (null で未設定に戻す)。不正な URL は例外で、設定は変わらない。
   * 起動中なら新しいトラッカーへ接続し直し、到達できなければ例外を返す
   * (設定自体は変わっており、以後は定期的に再試行する)。
   */
  public async setTrackerUrl(url: string | null): Promise<void> {
    if (this.isDestroyed) throw new Error('AetherNode: node is stopped');
    if (!this.signaling.setUrl) throw new Error('signaling client does not support changing the tracker');
    let normalized: string | null = null;
    if (url !== null) {
      const parsed = parseTrackerUrl(url);
      if (!parsed.ok) throw new Error(`invalid tracker URL: ${parsed.reason}`);
      normalized = parsed.url;
    }
    this.signaling.setUrl(normalized);
    if (this.isStarted && normalized) await this.peerManager.reconnectTracker();
  }

  /** 現在のオニオン回路匿名レベル (standard / safer / safest) */
  public getAnonymityLevel(): AnonymityLevel {
    return this.circuit.getLevel();
  }

  /** オニオン回路の匿名レベルを変更する (Tor 準拠) */
  public setAnonymityLevel(level: AnonymityLevel): void {
    this.circuit.setLevel(level);
  }
}
