import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { sodiumReady } from '../../src/crypto/sodium';
import { ZoneGossipRouter } from '../../src/network/gossip/ZoneGossipRouter';
import { DandelionRouter } from '../../src/network/gossip/DandelionRouter';
import { MessageDispatcher } from '../../src/network/MessageDispatcher';
import { WireType } from '../../src/network/wire/WireTypes';
import { POW_POLICY } from '../../src/crypto/PowPolicy';
import type { GossipPacket } from '../../src/types';
import { makePacket } from '../helpers/onionNet';

const ME = 'f'.repeat(32);
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);
const D = 'd'.repeat(32);

interface Harness {
  router: ZoneGossipRouter;
  dispatcher: MessageDispatcher;
  dandelion: DandelionRouter;
  pm: any;
  circuit: any;
  zm: { isSubscribed: ReturnType<typeof vi.fn>; depth: number; subscribedZones: Set<number> };
  delivered: GossipPacket[];
  sent: Array<{ to: string; type: number; payload: any }>;
  exit: (payload: any) => void;
}

function harness(opts: { subscribed?: (z: number) => boolean; circuitResult?: boolean } = {}): Harness {
  const peers = new Map<string, any>([
    [A, { peerId: A, isConnected: true, isVerified: true }],
    [B, { peerId: B, isConnected: true, isVerified: true }],
    // 未検証・切断済みの隣人には中継しない
    [C, { peerId: C, isConnected: true, isVerified: false }],
    [D, { peerId: D, isConnected: false, isVerified: true }],
  ]);
  const sent: Harness['sent'] = [];
  const pm: any = {
    myPeerId: ME,
    myPosition: 0,
    peers,
    get degree() { return peers.size; },
    sendMessage: vi.fn((to: string, type: number, payload: any) => sent.push({ to, type, payload })),
    on: vi.fn(),
    off: vi.fn(),
  };
  let exitHandler: ((payload: any, from: string) => void) | null = null;
  const circuit: any = {
    onExit: vi.fn((type: string, h: any) => {
      if (type === 'exit_fluff') exitHandler = h;
    }),
    send: vi.fn().mockResolvedValue(opts.circuitResult ?? true),
  };
  const zm = {
    isSubscribed: vi.fn(opts.subscribed ?? (() => true)),
    depth: 0,
    subscribedZones: new Set<number>(),
  };
  const dispatcher = new MessageDispatcher();
  const dandelion = new DandelionRouter(pm);
  const router = new ZoneGossipRouter(pm, dispatcher, zm as any, dandelion, circuit);
  const delivered: GossipPacket[] = [];
  router.onMessage(p => delivered.push(p));
  return {
    router, dispatcher, dandelion, pm, circuit, zm, delivered, sent,
    exit: (payload: any) => exitHandler!(payload, A),
  };
}

const gossipFrom = (h: Harness, from: string, packet: any) =>
  h.dispatcher.dispatch(from, WireType.GOSSIP, { packet });

describe('ZoneGossipRouter: 受信と中継 (Broadcast Veil)', () => {
  let h: Harness;

  beforeAll(async () => {
    await sodiumReady;
  });
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => {
    h.router.destroy();
    vi.useRealTimers();
  });

  it('正当な GOSSIP は送り主以外の「接続中かつ検証済み」の隣人全員へ中継される', () => {
    const p = makePacket([1, 2, 3]);
    gossipFrom(h, A, p);

    const targets = h.sent.filter(s => s.type === WireType.GOSSIP).map(s => s.to);
    expect(targets).toEqual([B]); // A (送り主), C (未検証), D (切断) には送らない
    expect(h.delivered.map(d => d.packet_id)).toEqual([p.packet_id]);
  });

  it('中継では hop_count を増やさず常に 0 で送る (出口の位置を漏らさない)', () => {
    const p = { ...makePacket([9]), hop_count: 7 };
    gossipFrom(h, A, p);

    const relayed = h.sent.find(s => s.type === WireType.GOSSIP)!;
    expect(relayed.payload.packet.hop_count).toBe(0);
    // 他のフィールドは書き換えない (CHK が壊れない)
    expect(relayed.payload.packet.packet_id).toBe(p.packet_id);
    expect(relayed.payload.packet.payload).toEqual(p.payload);
  });

  it('同じパケットを複数の隣人から受けても、中継も UI 配信も 1 回だけ', () => {
    const p = makePacket([5, 5]);
    gossipFrom(h, A, p);
    gossipFrom(h, B, p);
    gossipFrom(h, A, p);

    expect(h.sent.filter(s => s.type === WireType.GOSSIP)).toHaveLength(1);
    expect(h.delivered).toHaveLength(1);
  });

  it('購読していないゾーンでも中継は行う。UI には渡さない', () => {
    h.router.destroy();
    h = harness({ subscribed: () => false });
    const p = makePacket([4, 4]);
    gossipFrom(h, A, p);

    expect(h.zm.isSubscribed).toHaveBeenCalledWith(p.zone_id);
    expect(h.delivered).toHaveLength(0);
    expect(h.sent.filter(s => s.type === WireType.GOSSIP).map(s => s.to)).toEqual([B]);
  });

  it('中継の有無はゾーン購読に依存しない (購読の有無で外から見える挙動が同じ)', () => {
    const sub = harness({ subscribed: () => true });
    const unsub = harness({ subscribed: () => false });
    const p = makePacket([8, 8, 8]);
    gossipFrom(sub, A, p);
    gossipFrom(unsub, A, p);

    const strip = (x: Harness) => x.sent.map(s => ({ to: s.to, type: s.type, id: s.payload.packet.packet_id, hop: s.payload.packet.hop_count }));
    expect(strip(sub)).toEqual(strip(unsub));
    sub.router.destroy();
    unsub.router.destroy();
  });

  describe('検証に通らないパケットは中継もエコーもしない', () => {
    const cases: Array<[string, (p: GossipPacket) => any]> = [
      ['packet_id が CHK と一致しない', p => ({ ...p, packet_id: 'ab'.repeat(32) })],
      ['ヘッダの zone_id を改竄 (CHK 破れ)', p => ({ ...p, zone_id: p.zone_id + 1 })],
      ['自己申告の難易度を 0 にする', p => ({ ...p, pow_difficulty: 0 })],
      ['payload が空', p => ({ ...p, payload: new Uint8Array(0) })],
      ['payload が上限超え', p => ({ ...p, payload: new Uint8Array(POW_POLICY.MAX_PAYLOAD_SIZE + 1) })],
      ['nonce 長が違う', p => ({ ...p, nonce: new Uint8Array(5) })],
      ['hop_count が上限超え', p => ({ ...p, hop_count: POW_POLICY.MAX_HOP_COUNT + 1 })],
      ['pow_nonce が負', p => ({ ...p, pow_nonce: -1 })],
      ['packet 自体が無い', () => undefined],
      ['packet が文字列', () => 'garbage'],
    ];
    for (const [name, mutate] of cases) {
      it(name, async () => {
        const p = makePacket([3, 1, 4]);
        const bad = mutate(p);
        const echo = h.dandelion.awaitEcho(p.packet_id, 10);
        expect(() => gossipFrom(h, A, bad)).not.toThrow();
        expect(h.sent).toHaveLength(0);
        expect(h.delivered).toHaveLength(0);
        expect(await echo).toBe(false);
      });
    }

    it('15 分より古いパケットは拒否する (リプレイの打ち切り)', () => {
      const p = makePacket([7, 7]);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + POW_POLICY.MAX_TIME_DRIFT + 60_000);
      gossipFrom(h, A, p);
      expect(h.sent).toHaveLength(0);
      expect(h.delivered).toHaveLength(0);
    });

    it('15 分より先の未来日付のパケットは拒否する', () => {
      const p = makePacket([7, 8]);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() - POW_POLICY.MAX_TIME_DRIFT - 60_000);
      gossipFrom(h, A, p);
      expect(h.sent).toHaveLength(0);
    });
  });

  it('正当な GOSSIP の到着は自分の発信のエコーとして通知される', async () => {
    const p = makePacket([2, 2]);
    const echo = h.dandelion.awaitEcho(p.packet_id, 10_000);
    gossipFrom(h, B, p);
    expect(await echo).toBe(true);
  });

  it('offMessage したリスナーには配信しない', () => {
    const extra: GossipPacket[] = [];
    const listener = (p: GossipPacket) => extra.push(p);
    h.router.onMessage(listener);
    h.router.offMessage(listener);
    gossipFrom(h, A, makePacket([6]));
    expect(extra).toHaveLength(0);
    expect(h.delivered).toHaveLength(1);
  });
});

describe('ZoneGossipRouter: 自己発信 (Fail-Closed)', () => {
  let h: Harness;

  beforeAll(async () => {
    await sodiumReady;
  });
  afterEach(() => h.router.destroy());

  it('broadcast は先に自分の UI へ渡し、回路に exit_fluff として載せる。平文は送らない', async () => {
    h = harness();
    const p = makePacket([1, 1]);
    const slot = { topicHash: 'aa'.repeat(32), hint: new Uint8Array([1, 2]) };

    expect(await h.router.broadcast(p, { slot })).toBe(true);

    expect(h.delivered.map(x => x.packet_id)).toEqual([p.packet_id]);
    expect(h.circuit.send).toHaveBeenCalledTimes(1);
    const [payload, echoId] = h.circuit.send.mock.calls[0];
    expect(payload).toEqual({ type: 'exit_fluff', zoneId: p.zone_id, packet: p, slot });
    expect(echoId).toBe(p.packet_id);
    expect(h.pm.sendMessage).not.toHaveBeenCalled();
  });

  it('自分の UI にはゾーン購読に関係なく必ず見える', async () => {
    h = harness({ subscribed: () => false });
    const p = makePacket([1, 9]);
    await h.router.broadcast(p);
    expect(h.delivered).toHaveLength(1);
  });

  it('回路で届かなかったら false を返し、平文の GOSSIP には落ちない', async () => {
    h = harness({ circuitResult: false });
    const p = makePacket([2, 9]);
    expect(await h.router.broadcast(p)).toBe(false);
    expect(h.pm.sendMessage).not.toHaveBeenCalled();
  });

  it('自分の発信が網から戻ってきたとき、UI には二重に出さないが中継はする (小規模網の Stem ループ対策)', async () => {
    h = harness();
    const p = makePacket([3, 9]);
    await h.router.broadcast(p);
    expect(h.delivered).toHaveLength(1);

    gossipFrom(h, A, p);

    expect(h.delivered).toHaveLength(1);
    expect(h.sent.filter(s => s.type === WireType.GOSSIP).map(s => s.to)).toEqual([B]);
  });
});

describe('ZoneGossipRouter: 出口としての Fluff', () => {
  let h: Harness;

  beforeAll(async () => {
    await sodiumReady;
  });
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.router.destroy());

  it('exit_fluff を受けた出口は、エコーを通知し、UI に渡し、全隣人へ Fluff する', async () => {
    const p = makePacket([4, 2]);
    const echo = h.dandelion.awaitEcho(p.packet_id, 10_000);
    h.exit({ type: 'exit_fluff', zoneId: p.zone_id, packet: p });

    expect(await echo).toBe(true);
    expect(h.delivered).toHaveLength(1);
    // 出口は送り主が居ないので、検証済みで接続中の隣人全員へ
    expect(h.sent.filter(s => s.type === WireType.GOSSIP).map(s => s.to).sort()).toEqual([A, B]);
  });

  it('出口に届いた不正なパケットは Fluff しない', () => {
    const p = makePacket([4, 3]);
    h.exit({ type: 'exit_fluff', zoneId: p.zone_id, packet: { ...p, timestamp: p.timestamp + 1 } });
    expect(h.sent).toHaveLength(0);
    expect(h.delivered).toHaveLength(0);
  });

  it('同じパケットが出口と GOSSIP の両方から来ても、Fluff は 1 回だけ', () => {
    const p = makePacket([4, 4]);
    h.exit({ type: 'exit_fluff', zoneId: p.zone_id, packet: p });
    gossipFrom(h, A, p);
    expect(h.sent.filter(s => s.type === WireType.GOSSIP)).toHaveLength(2); // A と B へ 1 回ずつ
    expect(h.delivered).toHaveLength(1);
  });
});

describe('ZoneGossipRouter: 後始末', () => {
  it('destroy() で重複排除キャッシュのタイマーが残らない', async () => {
    await sodiumReady;
    vi.useFakeTimers();
    try {
      const h = harness();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      h.router.destroy();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
