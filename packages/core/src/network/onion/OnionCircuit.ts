import type { IMessageDispatcher, IPeerManager, PeerId } from '../../types';
import { OnionRouter, SEALED_EXIT_LAYER_SIZE, type ExitPayload, type OnionHop } from '../../crypto/OnionRouter';
import { NodeIdentity, NODE_ID_POW, type NodeIdPowParams } from '../../crypto/NodeIdentity';
import sodium from '../../crypto/sodium';
import { toBytes } from '../../crypto/PowPolicy';
import { Encoding } from '../../common/Encoding';
import { createLogger } from '../../common/Logger';
import { WireType } from '../wire/WireTypes';
import { SeenCache } from '../gossip/SeenCache';
import { secureRandomIndex, type DandelionRouter } from '../gossip/DandelionRouter';

const log = createLogger('net.onion');

const PEER_ID_RE = /^[0-9a-f]{32}$/;

/**
 * 回路の既定パラメータ。
 *
 * レイテンシの内訳 (平均): cover の空き待ち COVER_INTERVAL/2 + 中継遅延 + 出口の混合遅延。
 * 既定値で投稿が網に現れるまで平均 3〜4 秒。掲示板としては許容範囲で、
 * 匿名性はこの遅延の大きさにほぼ比例して効く。
 */
export const CIRCUIT_CONFIG = {
  /** cover traffic の平均送出間隔 (ms, 指数分布 = ポアソン過程) */
  COVER_INTERVAL_MS: 2000,
  /** 中継ホップでの遅延の平均 (ms, 指数分布) */
  RELAY_DELAY_MS: 40,
  /** 出口での混合遅延の平均 (ms, 指数分布) */
  EXIT_DELAY_MS: 2500,
  /** 混合遅延の上限 (ms) */
  EXIT_DELAY_MAX_MS: 15_000,
  /** エコー待ちの上限 (ms)。cover 待ち + 混合遅延 + 伝播を十分に覆う値 */
  ECHO_TIMEOUT_MS: 45_000,
  /** 1 つの発信に使う出口の数 (同じ Guard のまま出口だけ替える) */
  MAX_ATTEMPTS: 2,
  /** Guard に隣人表 (PEX) を問い合わせる間隔 (ms) */
  GUARD_PEX_INTERVAL_MS: 30_000,
  /** Guard の隣人情報の有効期限 (ms) */
  GUARD_NEIGHBOR_TTL_MS: 10 * 60 * 1000,
  /** 中継・出口処理の保留上限 (全体 / 送信者ごと) */
  MAX_PENDING: 128,
  MAX_PENDING_PER_PEER: 16,
  /** 送信待ちの本物のセルの上限 */
  MAX_QUEUE: 64,
};

export interface OnionCircuitOptions {
  coverIntervalMs?: number;
  relayDelayMs?: number;
  exitDelayMs?: number;
  echoTimeoutMs?: number;
}

type ExitType = ExitPayload['type'];
type ExitHandler = (payload: ExitPayload, fromPeerId: PeerId) => void;

interface QueuedCell {
  payload: ExitPayload;
  exit: OnionHop;
  guardId: PeerId;
}

interface GuardNeighbor {
  pubkey: Uint8Array;
  seenAt: number;
}

/** 指数分布の乱数 (平均 mean)。上限 max で打ち切る */
export function exponentialDelay(mean: number, max: number = Number.POSITIVE_INFINITY): number {
  if (mean <= 0) return 0;
  const u = (crypto.getRandomValues(new Uint32Array(1))[0] + 1) / 0x100000001;
  return Math.min(max, Math.round(-Math.log(u) * mean));
}

/**
 * OnionCircuit — 作者が網へ出すものを、すべて固定長セルで運ぶ。
 *
 * ★ なぜ cover traffic が要るのか (C2)
 *
 *   旧実装の回路は [Guard, Exit] の 2 ホップで、relay 層を受け取るのは常に Guard
 *   だけだった。しかもセルは作者が投稿したときにしか出ないので、
 *   「relay 層を剥けた = 送ってきた隣人が作者」「直後に Exit から Fluff されたもの
 *   = その投稿」が Guard にとって確定していた。
 *
 *   現在は全ノードが平均 COVER_INTERVAL_MS のポアソン過程で常にセルを出し続け、
 *   本物の発信は次の送出枠を drop セルの代わりに使うだけである。
 *   出口層は固定長なので、Guard から見て drop と本物はビット単位で区別できない。
 *   Guard に分かるのは「この隣人がオンラインである」ことだけになる。
 *
 * ★ 出口の選び方
 *
 *   出口は「Guard の隣人で、自分の隣人ではないノード」から選ぶ。
 *   旧実装は出口も作者の直接の隣人だったため、出口は
 *   「作者 ∈ N(Guard) ∩ N(Exit)」と候補を数人に絞り込めた。
 *   Guard の隣人表は Guard への PEX で得る。各エントリは peerId ↔ pubkey の束縛と
 *   NodeId PoW を検証してから使う。
 *
 * ★ 残る限界 (正直に書いておく)
 *
 *   - Guard と Exit が結託すれば時刻相関で作者が分かる (Tor と同じ end-to-end 相関)。
 *   - 出口候補は Guard の申告に依存する。悪意ある Guard は自分の仲間だけを
 *     申告して出口を誘導できる。Guard を長期固定しているのは、この位置を
 *     攻撃者が得る機会そのものを減らすため。
 */
export class OnionCircuit {
  private readonly coverIntervalMs: number;
  private readonly relayDelayMs: number;
  private readonly exitDelayMs: number;
  public readonly echoTimeoutMs: number;

  private exitHandlers = new Map<ExitType, Set<ExitHandler>>();
  private queue: QueuedCell[] = [];
  private guardNeighbors = new Map<PeerId, GuardNeighbor>();
  private seenCells = new SeenCache();

  private pending = new Set<ReturnType<typeof setTimeout>>();
  private pendingPerPeer = new Map<PeerId, number>();

  private coverTimer: ReturnType<typeof setTimeout> | null = null;
  private pexTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private curveKeys: { pk: Uint8Array; sk: Uint8Array } | null = null;

  constructor(
    private peerManager: IPeerManager,
    dispatcher: IMessageDispatcher,
    private dandelion: DandelionRouter,
    options: OnionCircuitOptions = {},
  ) {
    this.coverIntervalMs = options.coverIntervalMs ?? CIRCUIT_CONFIG.COVER_INTERVAL_MS;
    this.relayDelayMs = options.relayDelayMs ?? CIRCUIT_CONFIG.RELAY_DELAY_MS;
    this.exitDelayMs = options.exitDelayMs ?? CIRCUIT_CONFIG.EXIT_DELAY_MS;
    this.echoTimeoutMs = options.echoTimeoutMs ?? CIRCUIT_CONFIG.ECHO_TIMEOUT_MS;

    dispatcher.register(WireType.ONION_STEM, (senderId, msg) => this.handleCell(senderId, msg));
    dispatcher.register(WireType.PEX_RESPONSE, (senderId, msg) => this.handleGuardPex(senderId, msg));

    // Guard が変わったら、前の Guard の隣人表は使えない
    this.dandelion.onGuardChange((guard) => {
      this.guardNeighbors.clear();
      if (guard && this.running) this.requestGuardNeighbors();
    });
  }

  // ── 出口ハンドラ ──

  public onExit(type: ExitType, handler: ExitHandler): void {
    if (!this.exitHandlers.has(type)) this.exitHandlers.set(type, new Set());
    this.exitHandlers.get(type)!.add(handler);
  }

  // ── ライフサイクル ──

  /**
   * cover traffic を開始する。ノード起動時に必ず呼ぶこと。
   *
   * ★ 「最初の投稿のときに起動する」は不可。セルの出始めがそのまま
   *   「この端末が今投稿した」という合図になる。
   */
  public start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleCover();
    this.requestGuardNeighbors();
    this.pexTimer = setInterval(() => this.requestGuardNeighbors(), CIRCUIT_CONFIG.GUARD_PEX_INTERVAL_MS);
  }

  public stop(): void {
    this.running = false;
    if (this.coverTimer) clearTimeout(this.coverTimer);
    this.coverTimer = null;
    if (this.pexTimer) clearInterval(this.pexTimer);
    this.pexTimer = null;
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
    this.pendingPerPeer.clear();
    this.queue = [];
  }

  public destroy(): void {
    this.stop();
    this.seenCells.destroy();
    this.exitHandlers.clear();
  }

  // ── 発信 ──

  /**
   * 出口への指示を回路に載せ、エコー (網に現れたこと) を待つ。
   *
   * ★ Fail-Closed: 回路が組めない・エコーが返らない場合は false を返すだけで、
   *   平文の送信には決して落ちない。
   *
   * 失敗時は同じ Guard のまま出口だけを替えて 1 回だけやり直す。
   * セルは cover traffic に混ざるので、やり直しは Guard から見て通常の送出と区別できない。
   *
   * @param echoId 網に現れたことを確かめる識別子 (packet_id / hint id)
   */
  public async send(payload: ExitPayload, echoId: string): Promise<boolean> {
    if (!this.running) {
      log.warn(`circuit not running; refusing to send ${echoId.substring(0, 8)}`);
      return false;
    }
    const triedExits = new Set<PeerId>();

    for (let attempt = 0; attempt < CIRCUIT_CONFIG.MAX_ATTEMPTS; attempt++) {
      const guard = this.currentGuard();
      if (!guard) {
        log.warn(`no guard available; dropping ${echoId.substring(0, 8)} (fail-closed)`);
        return false;
      }
      const exit = this.pickExit(guard.peerId, triedExits);
      if (!exit) {
        log.warn(`no exit candidate behind guard; dropping ${echoId.substring(0, 8)} (fail-closed)`);
        return false;
      }
      triedExits.add(exit.peerId);

      if (this.queue.length >= CIRCUIT_CONFIG.MAX_QUEUE) {
        log.warn(`circuit queue full; dropping ${echoId.substring(0, 8)}`);
        return false;
      }
      const echo = this.dandelion.awaitEcho(echoId, this.echoTimeoutMs);
      this.queue.push({ payload, exit, guardId: guard.peerId });

      if (await echo) return true;
      log.debug(() => `no echo for ${echoId.substring(0, 8)} (attempt ${attempt + 1}); trying another exit`);
    }
    return false;
  }

  /** テスト・診断用: 次の送出枠を待たずに 1 枠ぶん送出する */
  public flushOnce(): void {
    this.emitCell();
  }

  private scheduleCover(): void {
    if (!this.running) return;
    const delay = Math.max(1, exponentialDelay(this.coverIntervalMs, this.coverIntervalMs * 10));
    this.coverTimer = setTimeout(() => {
      this.emitCell();
      this.scheduleCover();
    }, delay);
  }

  /**
   * 送出枠 1 つぶんのセルを出す。本物があればそれを、無ければ drop を載せる。
   */
  private emitCell(): void {
    const guard = this.currentGuard();
    if (!guard) return;

    // Guard が替わった後に残っている本物は、新しい Guard の背後の出口を選び直す
    let item = this.queue.shift();
    while (item && item.guardId !== guard.peerId) {
      const exit = this.pickExit(guard.peerId, new Set());
      if (exit) {
        item = { ...item, exit, guardId: guard.peerId };
        break;
      }
      item = this.queue.shift();
    }

    let payload: ExitPayload;
    let exit: OnionHop | null;
    if (item) {
      payload = item.payload;
      exit = item.exit;
    } else {
      payload = { type: 'drop' };
      exit = this.pickExit(guard.peerId, new Set());
    }
    if (!exit) return;

    let cell: Uint8Array;
    try {
      cell = OnionRouter.wrapCircuit(payload, [guard, exit]);
    } catch (err) {
      log.error(`failed to wrap onion cell: ${err}`);
      return;
    }
    this.peerManager.sendMessage(guard.peerId, WireType.ONION_STEM, { onionBytes: cell });
  }

  private currentGuard(): OnionHop | null {
    const candidates = this.verifiedNeighbors();
    return this.dandelion.getPinnedGuard(candidates);
  }

  private verifiedNeighbors(): OnionHop[] {
    const list = (this.peerManager as any)?.verifiedPeersWithKeys as OnionHop[] | undefined;
    return Array.isArray(list) ? list : [];
  }

  /**
   * 出口を選ぶ。Guard の隣人であることが前提 (Guard が直接転送できる相手)。
   *
   * 優先: 自分の隣人ではないノード (出口が作者の候補を N(Guard) ∩ N(Exit) に絞れない)
   * 次点: 自分の隣人でもあるノード (小さな網では避けられない)
   */
  private pickExit(guardId: PeerId, exclude: Set<PeerId>): OnionHop | null {
    const now = Date.now();
    const me = this.peerManager.myPeerId;
    const fresh: OnionHop[] = [];
    for (const [peerId, info] of this.guardNeighbors) {
      if (now - info.seenAt > CIRCUIT_CONFIG.GUARD_NEIGHBOR_TTL_MS) {
        this.guardNeighbors.delete(peerId);
        continue;
      }
      if (peerId === me || peerId === guardId || exclude.has(peerId)) continue;
      fresh.push({ peerId, pubkey: info.pubkey });
    }
    if (fresh.length === 0) return null;

    const nonAdjacent = fresh.filter(h => !this.peerManager.peers.has(h.peerId));
    const pool = nonAdjacent.length > 0 ? nonAdjacent : fresh;
    return pool[secureRandomIndex(pool.length)];
  }

  // ── Guard の隣人表 ──

  private requestGuardNeighbors(): void {
    const guard = this.currentGuard();
    if (!guard) return;
    this.peerManager.sendMessage(guard.peerId, WireType.PEX_REQUEST, { minDistance: 0 });
  }

  /**
   * Guard からの PEX 応答で隣人表を更新する。
   * 他の隣人からの応答は出口選びに使わない (Guard が直接転送できる相手とは限らない)。
   */
  private handleGuardPex(senderId: PeerId, msg: any): void {
    if (senderId !== this.dandelion.getPinnedGuardId()) return;
    if (!msg || !Array.isArray(msg.peers)) return;

    const powParams: NodeIdPowParams = (this.peerManager as any)?.nodeIdPowParams ?? NODE_ID_POW;
    const now = Date.now();
    for (const entry of msg.peers.slice(0, 16)) {
      const peerId = entry?.id;
      if (typeof peerId !== 'string' || !PEER_ID_RE.test(peerId)) continue;
      if (peerId === this.peerManager.myPeerId) continue;

      const known = this.guardNeighbors.get(peerId);
      const pubkey = toBytes(entry?.pubkey);
      if (known && sodium.memcmp(known.pubkey, pubkey)) {
        known.seenAt = now;
        continue;
      }
      // peerId ↔ pubkey の束縛と NodeId PoW を確かめる。束縛が無いと
      // Guard は任意の公開鍵を差し込める (=出口のセルを自分で復号できる)。
      const claim = { peerId, pubkey, powCounter: entry?.powCounter };
      if (!NodeIdentity.verifyClaim(claim, powParams)) continue;
      this.guardNeighbors.set(peerId, { pubkey, seenAt: now });
    }
  }

  // ── 受信 (中継 / 出口) ──

  private myCurveKeys(): { pk: Uint8Array; sk: Uint8Array } | null {
    if (this.curveKeys) return this.curveKeys;
    const identity = (this.peerManager as any)?.nodeIdentity;
    if (!identity) return null;
    const secret = identity.exportSecret();
    this.curveKeys = {
      pk: OnionRouter.toCurvePublicKey(secret.pubkey),
      sk: OnionRouter.toCurvePrivateKey(secret.privkey),
    };
    return this.curveKeys;
  }

  private handleCell(senderId: PeerId, msg: any): void {
    const cell = msg?.onionBytes;
    if (!(cell instanceof Uint8Array) || cell.byteLength !== OnionRouter.CELL_SIZE) return;

    // 同じセルの再送 (リプレイ) は処理しない。出口での二重 Fluff や、
    // 同じセルを流し直して下流の反応を見るタグ付けを防ぐ。
    const cellId = Encoding.toHex(sodium.crypto_generichash(16, cell, null));
    if (this.seenCells.has(cellId)) return;
    this.seenCells.add(cellId);

    const keys = this.myCurveKeys();
    if (!keys) return;
    const result = OnionRouter.unwrapWithCurveKeys(cell, keys.pk, keys.sk);
    if (!result) {
      log.trace(() => `ONION_STEM unwrap failed from=${senderId.substring(0, 8)}`);
      return;
    }

    if (result.type === 'relay') {
      this.relay(senderId, result.nextHop, result.innerOnion);
      return;
    }
    if (result.type === 'drop') return;

    // 出口: 混合遅延を置いてから処理する。セルの到着と Fluff の時刻を切り離す。
    this.defer(senderId, exponentialDelay(this.exitDelayMs, CIRCUIT_CONFIG.EXIT_DELAY_MAX_MS), () => {
      const handlers = this.exitHandlers.get(result.type);
      if (!handlers) return;
      for (const h of handlers) {
        try {
          h(result, senderId);
        } catch (err) {
          log.error(`exit handler for ${result.type} failed`, err);
        }
      }
    });
  }

  private relay(senderId: PeerId, nextHop: PeerId, innerOnion: Uint8Array): void {
    // 送り主へ送り返さない・自分宛てにしない (反射・ループの防止)
    if (nextHop === senderId || nextHop === this.peerManager.myPeerId) return;
    // 正規の回路 (Guard → Exit) の内側は常に固定長の出口層。それ以外は作られたセル
    if (innerOnion.byteLength !== SEALED_EXIT_LAYER_SIZE) return;

    let padded: Uint8Array;
    try {
      padded = OnionRouter.padCell(innerOnion);
    } catch {
      return;
    }

    this.defer(senderId, exponentialDelay(this.relayDelayMs, this.relayDelayMs * 10), () => {
      const peer = this.peerManager.peers.get(nextHop);
      if (!peer || !peer.isConnected || !peer.isVerified) return;
      this.peerManager.sendMessage(nextHop, WireType.ONION_STEM, { onionBytes: padded });
    });
  }

  /**
   * 遅延実行。保留数に全体と送信者ごとの上限を置く。
   * 全体の上限だけだと、隣人 1 人がキューを埋めて他人の中継を落とせる。
   */
  private defer(senderId: PeerId, delay: number, fn: () => void): void {
    const perPeer = this.pendingPerPeer.get(senderId) ?? 0;
    if (this.pending.size >= CIRCUIT_CONFIG.MAX_PENDING || perPeer >= CIRCUIT_CONFIG.MAX_PENDING_PER_PEER) {
      log.debug(() => `onion work dropped: pending limit (from=${senderId.substring(0, 8)})`);
      return;
    }
    this.pendingPerPeer.set(senderId, perPeer + 1);

    const timer = setTimeout(() => {
      this.pending.delete(timer);
      const n = (this.pendingPerPeer.get(senderId) ?? 1) - 1;
      if (n > 0) this.pendingPerPeer.set(senderId, n);
      else this.pendingPerPeer.delete(senderId);
      fn();
    }, delay);
    this.pending.add(timer);
  }
}
