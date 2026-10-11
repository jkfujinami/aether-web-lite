import { vi } from 'vitest';
import 'fake-indexeddb/auto';
import sodium from '../../src/crypto/sodium';
import { IndexedDBStore } from '../../src/storage/IndexedDBStore';
import { VAULT_PARAMS_FAST } from '../../src/storage/SecretVault';
import { CryptoEngine } from '../../src/crypto/CryptoEngine';
import { KeyManager } from '../../src/crypto/KeyManager';
import { PoWEngine } from '../../src/crypto/PoWEngine';
import { PacketBuilder } from '../../src/crypto/PacketBuilder';
import { POW_POLICY } from '../../src/crypto/PowPolicy';
import type { GossipPacket, IIdentity } from '../../src/types';
import { ZoneManager } from '../../src/network/ZoneManager';
import { ZoneGossipRouter } from '../../src/network/gossip/ZoneGossipRouter';
import { DandelionRouter } from '../../src/network/gossip/DandelionRouter';
import { MessageDispatcher } from '../../src/network/MessageDispatcher';
import { WireType } from '../../src/network/wire/WireTypes';

/**
 * オーケストレータ (BoardOrchestrator / ThreadOrchestrator) の単体テスト用の部品。
 * ネットワーク側 (PeerManager / ZoneGossipRouter / SchrodingerMailbox) は最小の代役にし、
 * 暗号・パケット・永続化 (暗号化 IndexedDB) は本物を使う。
 */

export const keyMgr = {
  deriveThreadKey: KeyManager.deriveThreadKey,
  deriveTopicHash: KeyManager.deriveTopicHash,
  computeZoneId: KeyManager.computeZoneId,
};

/** Worker を使わず同期で PoW を解く */
export const syncPow = { compute: async (h: any) => PoWEngine.computeSync(h) };

export const PASS = 'logic-test-passphrase';

let dbSeq = 0;
export async function unlockedStore(name = `logic_${Date.now()}_${dbSeq++}`, pass = PASS): Promise<IndexedDBStore> {
  const db = new IndexedDBStore(name);
  await db.init();
  await db.unlock(pass, VAULT_PARAMS_FAST);
  return db;
}

export class FakePeerManager {
  public peers = new Map<string, any>();
  public myPeerId = 'f'.repeat(32);
  public myPosition = 0.5;
  public degreeOverride: number | null = null;
  private handlers = new Map<string, Set<(...a: any[]) => void>>();
  public sendMessage = vi.fn();
  public connect = vi.fn();
  public disconnect = vi.fn();

  get degree(): number {
    return this.degreeOverride ?? this.peers.size;
  }
  on(ev: string, h: (...a: any[]) => void) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)!.add(h);
  }
  off(ev: string, h: (...a: any[]) => void) {
    this.handlers.get(ev)?.delete(h);
  }
  listenerCount(ev: string): number {
    return this.handlers.get(ev)?.size ?? 0;
  }
  emit(ev: string, ...args: any[]) {
    for (const h of Array.from(this.handlers.get(ev) ?? [])) h(...args);
  }
  /** 隣人を 1 人足して peer:connect を出す */
  addPeer(id = (this.peers.size + 1).toString(16).padStart(32, '0')) {
    const peer = { peerId: id, isConnected: true, isVerified: true, position: 0.1 };
    this.peers.set(id, peer);
    this.emit('peer:connect', peer);
    return peer;
  }
}

export class FakeRouter {
  public listeners = new Set<(p: any) => any>();
  public broadcast = vi.fn(async (_packet: GossipPacket, _opts?: any) => true);
  onMessage(h: (p: any) => any) { this.listeners.add(h); }
  offMessage(h: (p: any) => any) { this.listeners.delete(h); }
  /** 網から GOSSIP が届いたことにする (リスナーの完了まで待つ) */
  async deliver(packet: any) {
    await Promise.all(Array.from(this.listeners).map(l => l(packet)));
  }
}

export class FakeSchrodinger {
  public keys = new Map<string, Uint8Array>();
  public bodyListeners: Array<(body: Uint8Array, hint: any) => any> = [];
  public addKey = vi.fn((id: string, k: Uint8Array) => { this.keys.set(id, k); });
  public removeKey = vi.fn((id: string) => { this.keys.delete(id); });
  public releaseHint = vi.fn(async () => ({ released: true, release: {} }));
  public prepareSlot = vi.fn((_k: Uint8Array, messageId: number) => ({
    hint: { messageId },
    keyHex: 'ab'.repeat(32),
    exitSlot: { topicHash: 'ab'.repeat(32), hint: new Uint8Array([messageId & 0xff]) },
  }));
  onBody(cb: (body: Uint8Array, hint: any) => any) { this.bodyListeners.push(cb); }
  /** Hint から本体が取れたことにする */
  async emitBody(body: Uint8Array, keyId: string) {
    await Promise.all(this.bodyListeners.map(cb => cb(body, { keyId, payload: {} })));
  }
}

/**
 * 最小の ZoneManager 代役。watchTopic は参照カウント付きで記録する
 * (watched: トピック hex → 参照数)。
 */
export function fakeZoneManager(depth = 0) {
  const watched = new Map<string, number>();
  const hex = (t: Uint8Array) => Array.from(t.subarray(0, 32), b => b.toString(16).padStart(2, '0')).join('');
  return {
    depth,
    subscribedZones: new Set<number>([0]),
    isSubscribed: () => true,
    watched,
    watchTopic: vi.fn((topic: Uint8Array) => {
      const k = hex(topic);
      watched.set(k, (watched.get(k) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const n = (watched.get(k) ?? 1) - 1;
        if (n <= 0) watched.delete(k);
        else watched.set(k, n);
      };
    }),
    hex,
  };
}

/** 任意のトリップ鍵・署名を持たせられる署名者 (なりすましの再現用) */
export function customSigner(opts: {
  trip?: { publicKey: Uint8Array; privateKey: Uint8Array } | null;
  forgeTripSig?: boolean;
  tripPubkeyOnly?: Uint8Array;
} = {}): IIdentity {
  const session = sodium.crypto_sign_keypair();
  return {
    sign: (data: Uint8Array) => ({
      sessionPubkey: session.publicKey,
      sessionSignature: sodium.crypto_sign_detached(data, session.privateKey),
      tripPubkey: opts.tripPubkeyOnly ?? opts.trip?.publicKey ?? null,
      tripSignature: opts.forgeTripSig
        ? new Uint8Array(64)
        : opts.trip
          ? sodium.crypto_sign_detached(data, opts.trip.privateKey)
          : null,
    }),
  };
}

/** 板のスレッド作成パケット (post_type=1) を作る。boardKey で暗号化される */
export async function buildThreadMetaPacket(
  boardKey: Uint8Array,
  boardId: string,
  threadId: string,
  title: string,
  signer: IIdentity,
  depth = 0,
): Promise<GossipPacket> {
  return PacketBuilder.build(
    title, boardKey, signer, new CryptoEngine(), syncPow, keyMgr, boardId, threadId,
    0, null, POW_POLICY.MIN_DIFFICULTY, depth, 1, [], threadId, POW_POLICY.MIN_DIFFICULTY,
  );
}

/** スレッドへの返信パケット (post_type=0) を作る。threadKey で暗号化される */
export async function buildReplyPacket(
  threadKey: Uint8Array,
  boardId: string,
  threadId: string,
  text: string,
  signer: IIdentity,
  dag: { parents?: string[]; cumulativePow?: number; postType?: number; depth?: number } = {},
): Promise<GossipPacket> {
  return PacketBuilder.build(
    text, threadKey, signer, new CryptoEngine(), syncPow, keyMgr, boardId, threadId,
    0, null, POW_POLICY.MIN_DIFFICULTY, dag.depth ?? 0, dag.postType ?? 0, dag.parents ?? [], threadId, dag.cumulativePow ?? POW_POLICY.MIN_DIFFICULTY,
  );
}

/** Slot 本体と同じ形 (Uint8Array を {_type,data} で包んだ JSON) にする */
export function encodeBody(packet: any): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(packet, (_k, v) =>
    v instanceof Uint8Array ? { _type: 'Uint8Array', data: Array.from(v) } : v));
}

/**
 * 条件が満たされるまで待つ。固定 sleep は使わない。
 * setTimeout / Date を偽装しているテストでも動くよう、setImmediate と performance.now で回す。
 */
export async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!cond()) {
    if (performance.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise(r => setImmediate(r));
  }
}

/** IndexedDB を止めずに偽装するタイマー (fake-indexeddb は setImmediate で動く) */
export const LOGIC_FAKE_TIMERS = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as any };

/** 未処理のマイクロタスク / IndexedDB のコールバックを流す */
export async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r));
}

/**
 * 本物の ZoneManager + ZoneGossipRouter を、指定の depth まで育てて組む。
 * 隣人 10 人を推定規模が depth にちょうど収まる密度で並べ、再計算を 1 回走らせる。
 * (オーケストレータに渡す pm / router / zm と、GOSSIP を流し込む dispatcher を返す)
 */
export function zoneStack(depth: number) {
  const pm = new FakePeerManager();
  // 推定規模 = 1/(2d)。500·2^(depth-1)·1.5 にすると ceil(log2(N/500)) = depth
  const size = 500 * Math.pow(2, depth - 1) * 1.5;
  const d = 1 / (2 * size);
  for (let i = 0; i < 10; i++) {
    const id = (0x100 + i).toString(16).padStart(32, '0');
    const position = (pm.myPosition + (i % 2 === 0 ? d : -d) + 1) % 1;
    pm.peers.set(id, { peerId: id, position, isConnected: true, isVerified: true });
  }
  const zm = new ZoneManager(pm as any);
  (zm as any).recomputeDepth();
  const dispatcher = new MessageDispatcher();
  const circuit: any = { onExit: vi.fn(), send: vi.fn().mockResolvedValue(true) };
  const router = new ZoneGossipRouter(pm as any, dispatcher, zm, new DandelionRouter(pm as any), circuit);
  const observed: GossipPacket[] = [];
  router.onMessage(p => observed.push(p));
  const sender = pm.peers.keys().next().value as string;
  const gossip = (packet: GossipPacket) => dispatcher.dispatch(sender, WireType.GOSSIP, { packet });
  const relayed = (packetId: string) =>
    pm.sendMessage.mock.calls.some(c => c[1] === WireType.GOSSIP && c[2]?.packet?.packet_id === packetId);
  const destroy = () => { router.destroy(); zm.destroy(); };
  return { pm, zm, router, dispatcher, observed, gossip, relayed, destroy };
}

/** 鍵からトピック → ゾーンを求め、そのゾーンが「たまたま」ランダム購読に入っていない鍵を返す */
export function keyOutsideRandomZones(zm: { subscribedZones: ReadonlySet<number>; depth: number }, toTopic: (k: Uint8Array) => Uint8Array): Uint8Array {
  for (;;) {
    const k = sodium.randombytes_buf(32);
    if (!zm.subscribedZones.has(KeyManager.computeZoneId(toTopic(k), zm.depth))) return k;
  }
}
