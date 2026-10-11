import { describe, it, expect, beforeAll, vi } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { MessageDispatcher } from '@/lib/network/MessageDispatcher';
import { WireType } from '@/lib/network/wire/WireTypes';
import { HintRouter, type OpenedHint } from '@/lib/network/hint/HintRouter';
import { buildHint, newMailboxSlot } from '@/lib/network/hint/HintCrypto';
import { hintId, HINT_INITIAL_TTL, type HintPacket } from '@/lib/network/hint/HintPacket';
import { FakePeerManager } from '../helpers/fakes';
import { DandelionRouter } from '@/lib/network/gossip/DandelionRouter';

const ME = 'aa'.repeat(16);
const PEERS = ['bb', 'cc', 'dd'].map(p => p.repeat(16));

let K: Uint8Array;
let OTHER_K: Uint8Array;

beforeAll(async () => {
  await sodium.ready;
  K = sodium.randombytes_buf(32);
  OTHER_K = sodium.randombytes_buf(32);
});

function payload() {
  return { ...newMailboxSlot(), message_id: 1, timestamp: Date.now() };
}
function makeHint(k: Uint8Array = K): HintPacket {
  const { nonce } = newMailboxSlot();
  return buildHint(k, { nonce, message_id: 1, timestamp: Date.now() });
}

function setup(keys: Array<[string, Uint8Array]> = []) {
  const pm = new FakePeerManager(ME);
  for (const id of PEERS) pm.addPeer(id, { verified: true, connected: true });
  const dispatcher = new MessageDispatcher();
  const router = new HintRouter(pm, dispatcher, new DandelionRouter(pm));
  const opened: OpenedHint[] = [];
  router.onHint(h => opened.push(h));
  for (const [id, k] of keys) router.addKey(id, k);
  return { pm, dispatcher, router, opened };
}

describe('★Broadcast Veil: 中継は無条件', () => {
  it('自分の鍵で開けない Hint も全隣人へ中継する', () => {
    const { pm, dispatcher, opened } = setup([['mine', K]]);
    dispatcher.dispatch(PEERS[0], WireType.HINT, makeHint(OTHER_K));

    // 開けないが、中継はする —— ここで分岐すると購読宣言になる
    expect(opened).toHaveLength(0);
    expect(pm.messagesOfType(WireType.HINT).length).toBe(PEERS.length - 1);
  });

  it('鍵を 1 つも持たなくても中継する', () => {
    const { pm, dispatcher } = setup();
    dispatcher.dispatch(PEERS[0], WireType.HINT, makeHint());
    expect(pm.messagesOfType(WireType.HINT).length).toBe(PEERS.length - 1);
  });

  it('★開けた場合と開けなかった場合で中継の挙動が変わらない', () => {
    const a = setup([['mine', K]]);
    a.dispatcher.dispatch(PEERS[0], WireType.HINT, makeHint(K));       // 開ける
    const b = setup([['mine', K]]);
    b.dispatcher.dispatch(PEERS[0], WireType.HINT, makeHint(OTHER_K)); // 開けない

    expect(a.opened).toHaveLength(1);
    expect(b.opened).toHaveLength(0);
    // 外から観測できる送信は同一でなければならない
    expect(a.pm.messagesOfType(WireType.HINT).length)
      .toBe(b.pm.messagesOfType(WireType.HINT).length);
  });

  it('送り主には送り返さない', () => {
    const { pm, dispatcher } = setup();
    dispatcher.dispatch(PEERS[0], WireType.HINT, makeHint());
    const targets = pm.messagesOfType(WireType.HINT).map(m => m.to);
    expect(targets).not.toContain(PEERS[0]);
  });

  it('未検証ピアには中継しない', () => {
    const pm = new FakePeerManager(ME);
    pm.addPeer(PEERS[0], { verified: true, connected: true });
    pm.addPeer(PEERS[1], { verified: false, connected: true });
    const dispatcher = new MessageDispatcher();
    new HintRouter(pm, dispatcher, new DandelionRouter(pm));

    dispatcher.dispatch(PEERS[0], WireType.HINT, makeHint());
    expect(pm.messagesOfType(WireType.HINT)).toHaveLength(0);
  });
});

describe('試行復号', () => {
  it('自分宛ての Hint を開いて通知する', () => {
    const { dispatcher, opened } = setup([['vip', K]]);
    const p = payload();
    dispatcher.dispatch(PEERS[0], WireType.HINT, buildHint(K, p));

    expect(opened).toHaveLength(1);
    expect(opened[0].keyId).toBe('vip');
    expect(Array.from(opened[0].payload.nonce)).toEqual(Array.from(p.nonce));
  });

  it('複数の鍵から正しいものを選ぶ', () => {
    const k3 = sodium.randombytes_buf(32);
    const { dispatcher, opened } = setup([['a', OTHER_K], ['b', K], ['c', k3]]);
    dispatcher.dispatch(PEERS[0], WireType.HINT, buildHint(K, payload()));
    expect(opened[0].keyId).toBe('b');
  });

  it('鍵を外すと開かなくなる', () => {
    const { dispatcher, router, opened } = setup([['vip', K]]);
    router.removeKey('vip');
    dispatcher.dispatch(PEERS[0], WireType.HINT, buildHint(K, payload()));
    expect(opened).toHaveLength(0);
  });

  it('★鍵を持つ前に届いた Hint も、鍵を足した時点で開き直される', () => {
    // ★ これが無いと、板を開く前に流れてきた Hint が永久に失われる。
    //   Broadcast Veil で全 Hint は常に流れてくるが、その時点で鍵が無ければ
    //   開けない。再放流を待つと最大 20 分かかる。
    const { dispatcher, router, opened } = setup();
    dispatcher.dispatch(PEERS[0], WireType.HINT, buildHint(K, payload()));
    expect(opened, '鍵が無い間は開けない').toHaveLength(0);

    router.addKey('vip', K);
    expect(opened, '鍵を足した時点で遡って開く').toHaveLength(1);

    // 以降に届くものも当然開ける
    dispatcher.dispatch(PEERS[1], WireType.HINT, buildHint(K, payload()));
    expect(opened).toHaveLength(2);
  });

  it('遡って開くのは自分宛てのものだけ', () => {
    const { dispatcher, router, opened } = setup();
    dispatcher.dispatch(PEERS[0], WireType.HINT, buildHint(OTHER_K, payload()));
    router.addKey('vip', K);
    expect(opened).toHaveLength(0);
  });

  it('同じ Hint を二度通知しない', () => {
    const { dispatcher, opened } = setup([['vip', K]]);
    const h = buildHint(K, payload());
    dispatcher.dispatch(PEERS[0], WireType.HINT, h);
    dispatcher.dispatch(PEERS[1], WireType.HINT, h);
    expect(opened).toHaveLength(1);
  });
});

describe('検証と重複排除', () => {
  it('★PoW を満たさない Hint は中継しない (増幅器にならない)', () => {
    const { pm, dispatcher } = setup();
    const h = makeHint();
    dispatcher.dispatch(PEERS[0], WireType.HINT, { ...h, pow_nonce: h.pow_nonce + 1 });
    expect(pm.messagesOfType(WireType.HINT)).toHaveLength(0);
  });

  it('壊れたペイロードでも例外を投げない', () => {
    const { dispatcher, pm } = setup();
    for (const bad of [undefined, null, {}, { version: 1 }, 'x', 42]) {
      expect(() => dispatcher.dispatch(PEERS[0], WireType.HINT, bad)).not.toThrow();
    }
    expect(pm.messagesOfType(WireType.HINT)).toHaveLength(0);
  });

  it('同じ Hint を二度中継しない', () => {
    const { pm, dispatcher } = setup();
    const h = makeHint();
    dispatcher.dispatch(PEERS[0], WireType.HINT, h);
    const first = pm.messagesOfType(WireType.HINT).length;
    dispatcher.dispatch(PEERS[1], WireType.HINT, h);
    expect(pm.messagesOfType(WireType.HINT)).toHaveLength(first);
  });

  it('中継時に TTL を 1 減らす', () => {
    const { pm, dispatcher } = setup();
    dispatcher.dispatch(PEERS[0], WireType.HINT, makeHint());
    expect(pm.messagesOfType(WireType.HINT)[0].payload.ttl).toBe(HINT_INITIAL_TTL - 1);
  });

  it('TTL 0 の Hint は中継しない', () => {
    const { pm, dispatcher } = setup();
    dispatcher.dispatch(PEERS[0], WireType.HINT, { ...makeHint(), ttl: 0 });
    expect(pm.messagesOfType(WireType.HINT)).toHaveLength(0);
  });

  it('★TTL が違っても同一 Hint として重複排除される', () => {
    const { pm, dispatcher } = setup();
    const h = makeHint();
    dispatcher.dispatch(PEERS[0], WireType.HINT, h);
    const first = pm.messagesOfType(WireType.HINT).length;
    // 中継で TTL が減ったものが別経路から戻ってくる状況
    dispatcher.dispatch(PEERS[1], WireType.HINT, { ...h, ttl: h.ttl - 3 });
    expect(pm.messagesOfType(WireType.HINT)).toHaveLength(first);
  });
});

describe('★発信は必ず Stem を通る (発信元を隣人に晒さない)', () => {
  it('★originate は HINT ではなく HINT_STEM を送る', async () => {
    const { pm, router } = setup([['vip', K]]);
    const h = makeHint();
    void router.originate(h, hintId(h));
    // publishVia は同期的に 1 通目を送る
    await vi.waitFor(() => expect(pm.sentMessages.length).toBeGreaterThan(0));

    // ★ 直接 flood していたら、ここに HINT が並ぶ = 隣人全員に発信元が割れる
    expect(pm.messagesOfType(WireType.HINT), '直接 flood している').toHaveLength(0);
    expect(pm.messagesOfType(WireType.HINT_STEM).length).toBe(1);
  });

  it('★Stem は 1 人にだけ送る (全体には撒かない)', async () => {
    const { pm, router } = setup();
    const h = makeHint();
    void router.originate(h, hintId(h));
    await vi.waitFor(() => expect(pm.sentMessages.length).toBeGreaterThan(0));

    const targets = new Set(pm.messagesOfType(WireType.HINT_STEM).map(m => m.to));
    expect(targets.size).toBe(1);
  });

  it('★Stem 経由で届いた Hint も最終的に全体配信される', () => {
    const { pm, dispatcher, opened } = setup([['vip', K]]);
    // 確率 Fluff を確実に引かせる
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.01);
    try {
      dispatcher.dispatch(PEERS[0], WireType.HINT_STEM, buildHint(K, payload()));
      expect(opened, 'Fluff 地点は自分にも配信する').toHaveLength(1);
      expect(pm.messagesOfType(WireType.HINT).length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('★Stem 転送時はパケットを書き換えない (位置の手がかりを残さない)', () => {
    const { pm, dispatcher } = setup();
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.99); // 確率 Fluff を外す
    try {
      const h = buildHint(K, payload());
      dispatcher.dispatch(PEERS[0], WireType.HINT_STEM, h);
      const fwd = pm.messagesOfType(WireType.HINT_STEM);
      expect(fwd).toHaveLength(1);
      expect(fwd[0].payload.ttl).toBe(h.ttl);
      expect(hintId(fwd[0].payload)).toBe(hintId(h));
    } finally {
      spy.mockRestore();
    }
  });

  it('壊れた HINT_STEM でも例外を投げない', () => {
    const { dispatcher, pm } = setup();
    for (const bad of [undefined, null, {}, 'x', 42]) {
      expect(() => dispatcher.dispatch(PEERS[0], WireType.HINT_STEM, bad)).not.toThrow();
    }
    expect(pm.sentMessages).toHaveLength(0);
  });

  it('★PoW を満たさない HINT_STEM は転送しない', () => {
    const { dispatcher, pm } = setup();
    const h = makeHint();
    dispatcher.dispatch(PEERS[0], WireType.HINT_STEM, { ...h, pow_nonce: h.pow_nonce + 1 });
    expect(pm.sentMessages).toHaveLength(0);
  });
});

describe('★3 ノードを実際に繋いだ Hint の伝播', () => {
  const A = '11'.repeat(16);
  const B = '22'.repeat(16);
  const C = '33'.repeat(16);

  function buildMesh(keyHolders: string[]) {
    const ids = [A, B, C];
    const nodes = new Map<string, {
      pm: FakePeerManager; dispatcher: MessageDispatcher;
      router: HintRouter; opened: OpenedHint[];
    }>();

    for (const id of ids) {
      const pm = new FakePeerManager(id);
      for (const other of ids) if (other !== id) pm.addPeer(other, { verified: true, connected: true });
      const dispatcher = new MessageDispatcher();
      const router = new HintRouter(pm, dispatcher, new DandelionRouter(pm));
      const opened: OpenedHint[] = [];
      router.onHint(h => opened.push(h));
      if (keyHolders.includes(id)) router.addKey('vip', K);
      nodes.set(id, { pm, dispatcher, router, opened });
    }

    const queue: Array<{ from: string; to: string; type: number; payload: any }> = [];
    for (const [id, node] of nodes) {
      node.pm.sendMessage = (to: string, type: number, p: any) => {
        node.pm.sentMessages.push({ to, type, payload: p });
        queue.push({ from: id, to, type, payload: p });
      };
    }

    const pump = (max = 200) => {
      let steps = 0;
      while (queue.length > 0 && steps++ < max) {
        const m = queue.shift()!;
        nodes.get(m.to)!.dispatcher.dispatch(m.from, m.type, m.payload);
      }
      return steps;
    };
    return { nodes, pump, queue };
  }

  it('★発信した Hint が全ノードへ届く', () => {
    const { nodes, pump } = buildMesh([A, B, C]);
    const h = buildHint(K, payload());
    nodes.get(A)!.router.originate(h, hintId(h));
    pump();

    // 発信者は自分で通知しない (自分が作ったものなので既知)
    expect(nodes.get(B)!.opened).toHaveLength(1);
    expect(nodes.get(C)!.opened).toHaveLength(1);
  });

  it('★鍵を持たないノードも中継に加わる (被覆になる)', () => {
    // B だけが鍵を持たない。それでも C まで届かなければならない。
    const { nodes, pump } = buildMesh([A, C]);
    const h = buildHint(K, payload());
    nodes.get(A)!.router.originate(h, hintId(h));
    pump();

    expect(nodes.get(B)!.opened).toHaveLength(0);
    expect(nodes.get(C)!.opened, 'B が鍵を持たないと C まで届かない').toHaveLength(1);
  });

  it('★伝播が有限ステップで収束する', () => {
    const { nodes, pump, queue } = buildMesh([A, B, C]);
    const h = buildHint(K, payload());
    nodes.get(A)!.router.originate(h, hintId(h));
    const steps = pump(500);

    expect(queue).toHaveLength(0);
    expect(steps).toBeLessThan(500);
  });

  it('★各ノードは同じ Hint を一度しか開かない', () => {
    const { nodes, pump } = buildMesh([A, B, C]);
    const h = buildHint(K, payload());
    nodes.get(A)!.router.originate(h, hintId(h));
    pump();
    for (const [id, n] of nodes) {
      expect(n.opened.length, `node ${id.substring(0, 4)}`).toBeLessThanOrEqual(1);
    }
  });
});
