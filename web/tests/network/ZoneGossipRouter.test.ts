import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import type { GossipPacket } from '@/lib/types';
import { ZoneGossipRouter } from '@/lib/network/gossip/ZoneGossipRouter';
import { MessageDispatcher } from '@/lib/network/MessageDispatcher';
import { WireType } from '@/lib/network/wire/WireTypes';
import { PacketBuilder } from '@/lib/crypto/PacketBuilder';
import { derivePacketId, solvePow, POW_POLICY } from '@/lib/crypto/PowPolicy';
import {
  DandelionRouter,
  DANDELION_CONFIG,
  jitteredEchoTimeout,
  ECHO_TIMEOUT_JITTER,
} from '@/lib/network/gossip/DandelionRouter';
import { FakePeerManager, FakeZoneManager } from '../helpers/fakes';
import { buildValidPacket, forgePacketWithoutPow, testBoardKey } from '../helpers/packets';

const ME = 'aa'.repeat(16);
const PEERS = ['bb', 'cc', 'dd', 'ee'].map((p) => p.repeat(16));

let packetZone0: GossipPacket;
let packetZone3: GossipPacket;

beforeAll(async () => {
  await sodium.ready;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  packetZone0 = await buildValidPacket(testBoardKey(), { depth: 0 });
  packetZone3 = withZone(packetZone0, 3);
});

/** zone_id を変えて PoW と packet_id を張り直した正当なパケットを作る */
function withZone(base: GossipPacket, zoneId: number): GossipPacket {
  const header = { ...PacketBuilder.committedHeaderOf(base), zone_id: zoneId };
  // PoW を解き直す (ヘッダを変えたら必ず必要になる、というのがそもそもの設計)
  const nonce = solvePow(header)!;
  return {
    ...base,
    zone_id: zoneId,
    pow_nonce: Number(nonce),
    packet_id: derivePacketId(header),
  };
}

function setup(subscribed: Set<number> | null = null) {
  const pm = new FakePeerManager(ME);
  for (const id of PEERS) pm.addPeer(id, { verified: true, connected: true });
  const dispatcher = new MessageDispatcher();
  const zm = new FakeZoneManager(4, subscribed);
  const router = new ZoneGossipRouter(pm, dispatcher, zm);
  const delivered: GossipPacket[] = [];
  router.onMessage((p) => delivered.push(p));
  return { pm, dispatcher, zm, router, delivered };
}

describe('★A級#7: 購読宣言による交差攻撃', () => {
  it('★購読していないゾーンのパケットも全隣人へ中継する', () => {
    // 旧実装は購読外のパケットを握り潰していたため、攻撃者は
    // ゾーン Z のプローブを送り「転送されるか」を見るだけで
    // 「この隣人は Z を購読しているか」を判定できた。
    const { pm, dispatcher, delivered } = setup(new Set([0])); // zone 3 は購読していない

    dispatcher.dispatch(PEERS[0], WireType.GOSSIP, { packet: packetZone3 });

    // ローカルには配信されない (購読外なので)
    expect(delivered).toHaveLength(0);
    // しかし中継はする → 購読状態が外から観測できない
    const relayed = pm.messagesOfType(WireType.GOSSIP);
    expect(relayed.map((m) => m.to).sort()).toEqual(PEERS.slice(1).sort());
  });

  it('★購読しているゾーンと購読していないゾーンで中継の挙動が変わらない', () => {
    const subscribed = new Set([0]);

    const a = setup(subscribed);
    a.dispatcher.dispatch(PEERS[0], WireType.GOSSIP, { packet: packetZone0 });
    const relayedSubscribed = a.pm.messagesOfType(WireType.GOSSIP).map((m) => m.to).sort();

    const b = setup(subscribed);
    b.dispatcher.dispatch(PEERS[0], WireType.GOSSIP, { packet: packetZone3 });
    const relayedUnsubscribed = b.pm.messagesOfType(WireType.GOSSIP).map((m) => m.to).sort();

    // 観測可能な振る舞いが完全に一致する = 購読集合が漏れない
    expect(relayedUnsubscribed).toEqual(relayedSubscribed);
  });

  it('購読しているゾーンのパケットはローカルにも配信される', () => {
    const { dispatcher, delivered } = setup(new Set([0]));
    dispatcher.dispatch(PEERS[0], WireType.GOSSIP, { packet: packetZone0 });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].packet_id).toBe(packetZone0.packet_id);
  });

  it('★送信先を購読ゾーンで絞らない (旧 peer.zones.has による申告依存の撤去)', () => {
    const { pm, dispatcher } = setup(null);
    dispatcher.dispatch(PEERS[0], WireType.GOSSIP, { packet: packetZone3 });

    // 送信元を除く全隣人へ。zones フィールドは参照すらしない。
    expect(pm.messagesOfType(WireType.GOSSIP)).toHaveLength(PEERS.length - 1);
  });

  it('IPeerConnection に zones が存在しない (型と実体の両方から撤去済み)', () => {
    const { pm } = setup();
    const peer = pm.peers.get(PEERS[0])!;
    expect((peer as any).zones).toBeUndefined();
  });
});

describe('中継時の検証', () => {
  it('★PoW を満たさないパケットを中継しない', () => {
    const { pm, dispatcher, delivered } = setup();
    dispatcher.dispatch(PEERS[0], WireType.GOSSIP, {
      packet: forgePacketWithoutPow({ pow_difficulty: 0 }),
    });
    expect(pm.messagesOfType(WireType.GOSSIP)).toHaveLength(0);
    expect(delivered).toHaveLength(0);
  });

  it('★Stem 経路でも検証する (Fluff 地点を増幅器にしない)', () => {
    // 旧実装は handleStem で PacketValidator を呼んでおらず、
    // 不正パケットが無検査で Fluff 地点まで運ばれていた。
    const { pm, dispatcher } = setup();
    dispatcher.dispatch(PEERS[0], WireType.STEM, {
      type: 'stem',
      zoneId: 0,
      packet: forgePacketWithoutPow({ pow_difficulty: 0 }),
    });
    expect(pm.sentMessages).toHaveLength(0);
  });

  it('★Stem 経由で Fluff に移行したパケットはローカルにも配信される (回帰: seenCache 二重判定)', () => {
    // 旧実装は handleStem() が packet_id を seenCache に先に追加してから
    // fluffToZone() を呼び、fluffToZone() 側にも同じ seenCache チェックが
    // あったため、常に「既読」と判定されて deliverLocal
    // (= onMessage リスナーへの通知、つまり UI への反映) が一度も
    // 呼ばれなかった。Fluff を確定させて、その経路を検証する。
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.01); // < FLUFF_PROBABILITY
    try {
      const { dispatcher, delivered } = setup();
      dispatcher.dispatch(PEERS[0], WireType.STEM, {
        type: 'stem',
        zoneId: 0,
        packet: packetZone0,
      });
      expect(delivered).toHaveLength(1);
      expect(delivered[0].packet_id).toBe(packetZone0.packet_id);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('★Stem 転送しかしていないノードでも、後から届く Gossip は画面に配信される (回帰: 中継とローカル配信のキャッシュ混同)', () => {
    // 実網ログで観測された壊れ方の再現。
    //
    //   1. このノードが STEM を受け取り、Fluff せず forward しただけの場合、
    //      中継用 seenCache には packet_id が入るが、まだ一度も
    //      deliverLocal は呼ばれていない。
    //   2. その後、ネットワークのどこか別の地点で同じパケットが Fluff され、
    //      GOSSIP として巡り巡ってこのノードに戻ってくる。
    //   3. 中継用とローカル配信用のキャッシュが同じ Set を共有していると、
    //      「seenCache に既にある」の一点だけで即 return してしまい、
    //      deliverLocal が永久に呼ばれない (= 中継役を担っただけの
    //      ノードの画面には、そのスレ/レスが二度と表示されない)。
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.99); // FLUFF_PROBABILITY(0.1) を確実に外し forward させる
    try {
      const { dispatcher, delivered, pm } = setup();
      dispatcher.dispatch(PEERS[0], WireType.STEM, {
        type: 'stem',
        zoneId: 0,
        packet: packetZone0,
      });
      // forward しただけなので、まだローカルには一切配信されていない
      expect(delivered).toHaveLength(0);
      expect(pm.messagesOfType(WireType.STEM).length).toBeGreaterThan(0);

      // 同じパケットが、別ノードでの Fluff を経て GOSSIP として戻ってくる
      dispatcher.dispatch(PEERS[1], WireType.GOSSIP, { packet: packetZone0 });

      expect(delivered).toHaveLength(1);
      expect(delivered[0].packet_id).toBe(packetZone0.packet_id);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('壊れたペイロードでも例外を投げない', () => {
    const { dispatcher } = setup();
    for (const bad of [undefined, null, {}, { packet: null }, { packet: 'x' }]) {
      expect(() => dispatcher.dispatch(PEERS[0], WireType.GOSSIP, bad)).not.toThrow();
      expect(() => dispatcher.dispatch(PEERS[0], WireType.STEM, bad)).not.toThrow();
    }
  });
});

describe('重複排除と hop_count', () => {
  it('同じパケットを二度中継しない', () => {
    const { pm, dispatcher } = setup();
    dispatcher.dispatch(PEERS[0], WireType.GOSSIP, { packet: packetZone0 });
    const first = pm.messagesOfType(WireType.GOSSIP).length;
    dispatcher.dispatch(PEERS[1], WireType.GOSSIP, { packet: packetZone0 });
    expect(pm.messagesOfType(WireType.GOSSIP)).toHaveLength(first);
  });

  it('中継時に hop_count を 1 増やす', () => {
    const { pm, dispatcher } = setup();
    dispatcher.dispatch(PEERS[0], WireType.GOSSIP, { packet: { ...packetZone0, hop_count: 5 } });
    for (const m of pm.messagesOfType(WireType.GOSSIP)) {
      expect(m.payload.packet.hop_count).toBe(6);
    }
  });

  it('hop_count 上限に達したパケットは中継しない', () => {
    const { pm, dispatcher, delivered } = setup();
    dispatcher.dispatch(PEERS[0], WireType.GOSSIP, {
      packet: { ...packetZone0, hop_count: POW_POLICY.MAX_HOP_COUNT },
    });
    // ローカル配信はされるが、そこで止まる
    expect(delivered).toHaveLength(1);
    expect(pm.messagesOfType(WireType.GOSSIP)).toHaveLength(0);
  });

  it('上限超過の hop_count は検証段階で落ちる', () => {
    const { pm, dispatcher, delivered } = setup();
    dispatcher.dispatch(PEERS[0], WireType.GOSSIP, {
      packet: { ...packetZone0, hop_count: POW_POLICY.MAX_HOP_COUNT + 1 },
    });
    expect(delivered).toHaveLength(0);
    expect(pm.messagesOfType(WireType.GOSSIP)).toHaveLength(0);
  });
});

describe('未検証ピアへの送信抑止', () => {
  it('ハンドシェイク未完了のピアには中継しない', () => {
    const pm = new FakePeerManager(ME);
    pm.addPeer(PEERS[0], { verified: true });
    pm.addPeer(PEERS[1], { verified: false });
    const dispatcher = new MessageDispatcher();
    new ZoneGossipRouter(pm, dispatcher, new FakeZoneManager());

    dispatcher.dispatch(PEERS[0], WireType.GOSSIP, { packet: packetZone0 });

    const targets = pm.messagesOfType(WireType.GOSSIP).map((m) => m.to);
    expect(targets).not.toContain(PEERS[1]);
  });
});

describe('自己発信', () => {
  it('broadcast したパケットは即座にローカル配信される', async () => {
    const { router, delivered } = setup();
    await router.broadcast(packetZone0, false);
    expect(delivered).toHaveLength(1);
  });

  it('自分が流したパケットが戻ってきても再配信しない', async () => {
    const { router, dispatcher, delivered } = setup();
    await router.broadcast(packetZone0, false);
    dispatcher.dispatch(PEERS[0], WireType.GOSSIP, { packet: packetZone0 });
    expect(delivered).toHaveLength(1);
  });
});

describe('★Dandelion++ のホップカウンタ廃止 (仕様: docs/spec/step5_dandelion.md)', () => {
  it('★STEM パケットにホップカウンタを載せない', async () => {
    // カウンタを平文で載せると、その上限値は「発信元しか出せない値」になる。
    //   発信元が出しうる値 {2,3,4} / 中継者が出しうる値 {0,1,2,3}
    //   → stemTtl=4 を受け取ったら送信者は発信元だと 100% 確定する。
    // 廃止したことをワイヤ形式として固定する。
    const { pm, router } = setup();
    void router.broadcast(packetZone0, true);

    const stems = pm.messagesOfType(WireType.STEM);
    expect(stems.length).toBeGreaterThan(0);
    for (const s of stems) {
      expect(s.payload).not.toHaveProperty('stemTtl');
      expect(s.payload).not.toHaveProperty('stem_ttl');
    }
  });

  it('★中継時にパケットを一切書き換えない (位置の手がかりを残さない)', () => {
    const pm = new FakePeerManager(ME);
    for (const id of PEERS) pm.addPeer(id, { verified: true, connected: true });
    const router = new DandelionRouter(pm);

    const stem = { type: 'stem' as const, zoneId: 0, packet: packetZone0 };
    let forwarded = 0;
    for (let i = 0; i < 200; i++) {
      const d = router.handleStemPacket(PEERS[0], stem);
      if (d.action === 'forward') {
        // 転送されるパケットは受信したものと完全に同一であること。
        // 書き換わる値があると、それが経路上の位置を示す手がかりになる。
        expect(d.packet).toEqual(stem);
        forwarded++;
      }
    }
    expect(forwarded).toBeGreaterThan(0);
  });

  it('★Fluff は各ホップ独立の確率で起きる (幾何分布 = 無記憶)', () => {
    const pm = new FakePeerManager(ME);
    for (const id of PEERS) pm.addPeer(id, { verified: true, connected: true });
    const router = new DandelionRouter(pm);

    const stem = { type: 'stem' as const, zoneId: 0, packet: packetZone0 };
    const N = 20000;
    let fluffs = 0;
    for (let i = 0; i < N; i++) {
      if (router.handleStemPacket(PEERS[0], stem).action === 'fluff') fluffs++;
    }

    // 実測の Fluff 率が設定値に一致すること (何ホップ目かに依存しない)
    const rate = fluffs / N;
    expect(rate).toBeGreaterThan(DANDELION_CONFIG.FLUFF_PROBABILITY - 0.02);
    expect(rate).toBeLessThan(DANDELION_CONFIG.FLUFF_PROBABILITY + 0.02);
  });

  it('★転送先が居なければ必ず Fluff へ落とす (パケットを消さない)', () => {
    const pm = new FakePeerManager(ME);
    pm.addPeer(PEERS[0], { verified: true, connected: true }); // 送り主のみ
    const router = new DandelionRouter(pm);

    for (let i = 0; i < 50; i++) {
      const d = router.handleStemPacket(PEERS[0], {
        type: 'stem', zoneId: 0, packet: packetZone0,
      });
      expect(d.action).toBe('fluff');
    }
  });

  it('★Fluff 確率が Rust 側 (aether-cache) と一致している', () => {
    // 片側だけ変えると経路長が非対称になり、匿名性の見積もりが崩れる。
    expect(DANDELION_CONFIG.FLUFF_PROBABILITY).toBe(0.3);
  });
});

describe('★3 ノードを実際に繋いだ Stem → Fluff の収束', () => {
  const A = '11'.repeat(16);
  const B = '22'.repeat(16);
  const C = '33'.repeat(16);

  /** 相互に配線された 3 ノードのメッシュを組む */
  function buildMesh() {
    const ids = [A, B, C];
    const nodes = new Map<string, {
      id: string;
      pm: FakePeerManager;
      dispatcher: MessageDispatcher;
      router: ZoneGossipRouter;
      delivered: GossipPacket[];
    }>();

    for (const id of ids) {
      const pm = new FakePeerManager(id);
      for (const other of ids) {
        if (other !== id) pm.addPeer(other, { verified: true, connected: true });
      }
      const dispatcher = new MessageDispatcher();
      const router = new ZoneGossipRouter(pm, dispatcher, new FakeZoneManager());
      const delivered: GossipPacket[] = [];
      router.onMessage((p) => delivered.push(p));
      nodes.set(id, { id, pm, dispatcher, router, delivered });
    }

    // sendMessage を相手ノードの dispatcher へ直結する。
    // 無限再帰を避けるため、送信はキューに積んで pump() で順に流す。
    const queue: Array<{ from: string; to: string; type: number; payload: any }> = [];
    for (const node of nodes.values()) {
      node.pm.sendMessage = (to: string, type: number, payload: any) => {
        node.pm.sentMessages.push({ to, type, payload });
        queue.push({ from: node.id, to, type, payload });
      };
    }

    /** 配送が落ち着くまで回す */
    const pump = (maxSteps = 200) => {
      let steps = 0;
      while (queue.length > 0 && steps++ < maxSteps) {
        const m = queue.shift()!;
        nodes.get(m.to)?.dispatcher.dispatch(m.from, m.type, m.payload);
      }
      return steps;
    };

    return { nodes, pump, queue };
  }

  it('★発信したパケットが 3 ノード全員の画面に届く (回帰: Stem が発信元へ戻って死ぬ)', async () => {
    // 旧実装は Stem が発信元へ一周して戻ると seenCache で黙って捨てられ、
    // 誰も Fluff しないままパケットが消滅していた。
    // 乱数はモックしない —— Fluff は確率で起きるので、実際の分布のまま
    // 収束することを確かめる (平均 3.33 ホップ、50 ホップ未到達は 2e-8)。
    const { nodes, pump } = buildMesh();
    const a = nodes.get(A)!;

    void a.router.broadcast(packetZone0, true);
    pump();

    for (const id of [A, B, C]) {
      expect(
        nodes.get(id)!.delivered.map((p) => p.packet_id),
        `node ${id.substring(0, 4)} に届いていない`,
      ).toContain(packetZone0.packet_id);
    }
  });

  it('★各ノードは同じパケットを一度しか画面へ渡さない', async () => {
    const { nodes, pump } = buildMesh();
    void nodes.get(A)!.router.broadcast(packetZone0, true);
    pump();

    for (const [id, node] of nodes) {
      const hits = node.delivered.filter((p) => p.packet_id === packetZone0.packet_id);
      expect(hits, `node ${id.substring(0, 4)}`).toHaveLength(1);
    }
  });

  it('★配送が有限ステップで収束する (フラッディングが暴走しない)', async () => {
    const { nodes, pump, queue } = buildMesh();
    void nodes.get(A)!.router.broadcast(packetZone0, true);
    const steps = pump(2000);

    expect(queue).toHaveLength(0);      // 打ち止めになっている
    expect(steps).toBeLessThan(2000);   // 上限に張り付いていない
  });

  it('★Fluff が起きたらエコーが確定し、リトライが打ち切られる', async () => {
    const { nodes, pump } = buildMesh();
    const a = nodes.get(A)!;

    const published = a.router.broadcast(packetZone0, true);
    pump();
    // エコーが返れば publish() は 5 秒のタイムアウトを待たずに解決する
    await expect(
      Promise.race([
        published.then(() => 'resolved'),
        new Promise((r) => setTimeout(() => r('timeout'), 300)),
      ]),
    ).resolves.toBe('resolved');
  });
});

/**
 * ★ 匿名性 (Dandelion++ の本来の目的) の回帰テスト。
 *
 * 「配信されるか」だけを見ていると、匿名性を壊す修正が素通りする。
 * ここでは発信元が特定されうる観測可能な振る舞いを直接検証する。
 */
describe('★Stem の匿名性: 発信元特定につながる観測点', () => {
  const A = '11'.repeat(16);
  const B = '22'.repeat(16);
  const C = '33'.repeat(16);

  it('★既に中継した Stem を送り返されても、即 Fluff で応答しない (既知パケットのオラクル化を防ぐ)', () => {
    // 攻撃: 攻撃者は任意のパケットを Stem として送りつけ、相手が即座に
    // Fluff (= 全隣人へのブロードキャスト) を返すかどうかを見るだけで
    // 「この相手はそのパケットを既に知っていたか」を判定できてしまう。
    // Stem 経路は 2〜4 ノードしかないため、これは発信元特定に直結する。
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.99); // 確率 Fluff を確実に外す
    try {
      const { pm, dispatcher } = setup();

      const send = () => dispatcher.dispatch(PEERS[0], WireType.STEM, {
        type: 'stem', zoneId: 0, packet: packetZone0,
      });

      send();
      const afterFirst = {
        stem: pm.messagesOfType(WireType.STEM).length,
        gossip: pm.messagesOfType(WireType.GOSSIP).length,
      };

      // 同じパケットをもう一度 Stem として送りつける (攻撃者の探り)
      send();
      const afterSecond = {
        stem: pm.messagesOfType(WireType.STEM).length,
        gossip: pm.messagesOfType(WireType.GOSSIP).length,
      };

      // 2 回目も 1 回目と同じ「Stem 転送」で応答すること。
      expect(afterSecond.stem).toBe(afterFirst.stem + 1);
      // ★ ブロードキャストに化けないこと (化けると既知/未知が丸見えになる)
      expect(afterSecond.gossip).toBe(afterFirst.gossip);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('★Fluff 地点が発信元に偏らない (Fluff 地点は作者を指し示さない)', () => {
    // Fluff 地点 = hop_count=0 の出所であり、ネットワークからは
    // 「そこが発信元」に見える。発信元が系統的に自分で Fluff していると
    // Dandelion++ の目的そのものが無効になる。
    //
    // 無記憶方式では発信元も他ノードと同じ確率で Fluff 地点になりうる
    // (それこそが「区別できない」ということ)。ここで固定したいのは
    // 「発信元に偏っていない」という分布の性質。
    const ids = [A, B, C];
    const ROUNDS = 300;
    const fluffCount = new Map<string, number>(ids.map((id) => [id, 0]));

    for (let round = 0; round < ROUNDS; round++) {
      const nodes = new Map<string, { dispatcher: MessageDispatcher; router: ZoneGossipRouter }>();
      const pms = new Map<string, FakePeerManager>();
      for (const id of ids) {
        const pm = new FakePeerManager(id);
        for (const other of ids) if (other !== id) pm.addPeer(other, { verified: true, connected: true });
        const dispatcher = new MessageDispatcher();
        pms.set(id, pm);
        nodes.set(id, { dispatcher, router: new ZoneGossipRouter(pm, dispatcher, new FakeZoneManager()) });
      }

      const queue: Array<{ from: string; to: string; type: number; payload: any }> = [];
      for (const [id, pm] of pms) {
        pm.sendMessage = (to: string, type: number, payload: any) => {
          queue.push({ from: id, to, type, payload });
        };
      }

      void nodes.get(A)!.router.broadcast(packetZone0, true);

      let fluffOrigin: string | null = null;
      let steps = 0;
      while (queue.length > 0 && steps++ < 2000) {
        const m = queue.shift()!;
        if (m.type === WireType.GOSSIP && fluffOrigin === null) fluffOrigin = m.from;
        nodes.get(m.to)!.dispatcher.dispatch(m.from, m.type, m.payload);
      }

      expect(fluffOrigin, `round ${round}: 誰も Fluff しなかった`).not.toBeNull();
      fluffCount.set(fluffOrigin!, fluffCount.get(fluffOrigin!)! + 1);
    }

    // 3 ノードすべてが Fluff 地点になりうること
    for (const id of ids) {
      expect(
        fluffCount.get(id)!,
        `node ${id.substring(0, 4)} が一度も Fluff 地点になっていない`,
      ).toBeGreaterThan(0);
    }

    // 発信元に偏っていないこと。
    // 理論値は A ≈ 22% (経路が A に戻るのは 3 ホップ目以降のため)。
    const originShare = fluffCount.get(A)! / ROUNDS;
    expect(originShare, 'Fluff 地点が発信元に偏っている').toBeLessThan(0.4);
  });
});

describe('★Dandelion エポックの堅牢性', () => {
  it('★Stem を送りつけられてもエポック (10分固定の Stem 先) が破壊されない', () => {
    // 攻撃: エポック破壊 (Epoch Churn)
    //   エポック固定こそが「作者パケットと中継パケットの区別不可能性」の
    //   土台 (仕様 §3.1)。攻撃者が自分宛に Stem を送りつけるだけで
    //   相手のエポックを再抽選させられると、「自分が Stem 先に選ばれる」まで
    //   引き直しを強制でき、first-spy 攻撃の成功率が跳ね上がる。
    const ids = Array.from({ length: 8 }, (_, i) => String(i + 10).repeat(16));

    for (let round = 0; round < 20; round++) {
      const pm = new FakePeerManager(ME);
      for (const id of ids) pm.addPeer(id, { verified: true, connected: true });
      const router = new DandelionRouter(pm);

      const stem = { type: 'stem' as const, zoneId: 0, packet: packetZone0 };
      const forwardTarget = (sender: string): string | null => {
        const d = router.handleStemPacket(sender, stem);
        return d.action === 'forward' ? d.target! : null;
      };

      // エポックを確立する (同じ送り主からは常に同じ宛先が返るはず)
      let epochTarget: string | null = null;
      for (let i = 0; i < 30 && epochTarget === null; i++) epochTarget = forwardTarget(ids[0]);
      if (epochTarget === null) continue; // 全部 Fluff だった (稀) ので次のラウンドへ
      expect(forwardTarget(ids[0]) ?? epochTarget).toBe(epochTarget);

      // 攻撃: エポック対象本人が Stem を送りつけてくる
      for (let i = 0; i < 50; i++) forwardTarget(epochTarget);

      // 攻撃後もエポックが保たれていること
      const after = forwardTarget(ids[0]);
      if (after !== null) {
        expect(after, `round ${round}: エポックが破壊された`).toBe(epochTarget);
      }
    }
  });

  it('★エポック対象本人からの Stem は、その相手には送り返さない', () => {
    const ids = Array.from({ length: 5 }, (_, i) => String(i + 10).repeat(16));
    const pm = new FakePeerManager(ME);
    for (const id of ids) pm.addPeer(id, { verified: true, connected: true });
    const router = new DandelionRouter(pm);

    const stem = { type: 'stem' as const, zoneId: 0, packet: packetZone0 };
    for (const sender of ids) {
      for (let i = 0; i < 20; i++) {
        const d = router.handleStemPacket(sender, stem);
        if (d.action === 'forward') {
          expect(d.target, '送り主に送り返している (§5.2 違反)').not.toBe(sender);
        }
      }
    }
  });
});

describe('★リトライ指紋 (発信元しか行わない振る舞い)', () => {
  it('★Stem の再送回数は仕様どおり 2 回まで', () => {
    // 再送するのは発信元だけ。回数が多いほど攻撃者に与える
    // 「同じ packet_id を繰り返し送ってくる = 作者」のサンプルが増える。
    expect(DANDELION_CONFIG.MAX_RETRIES).toBe(2);
  });

  it('★エコー待ちにジッタが掛かる (きっかり 5 秒周期を指紋にさせない)', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(jitteredEchoTimeout());

    expect(seen.size, 'ジッタが効いていない (常に同じ値)').toBeGreaterThan(50);
    const base = DANDELION_CONFIG.ECHO_TIMEOUT;
    for (const v of seen) {
      expect(v).toBeGreaterThanOrEqual(Math.floor(base * (1 - ECHO_TIMEOUT_JITTER)));
      expect(v).toBeLessThanOrEqual(Math.ceil(base * (1 + ECHO_TIMEOUT_JITTER)));
    }
  });
});
