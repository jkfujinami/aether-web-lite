import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { ZoneManager } from '../../src/network/ZoneManager';
import { KeyManager } from '../../src/crypto/KeyManager';
import { RING_MESH_ZONE } from '../../src/constants';

/** 指定した座標に隣人を並べた最小の PeerManager */
function fakePm(myPosition = 0.5) {
  const peers = new Map<string, any>();
  return {
    peers,
    myPosition,
    myPeerId: 'f'.repeat(32),
    get degree() { return peers.size; },
    sendMessage: vi.fn(), on: vi.fn(), off: vi.fn(),
    place(positions: number[]) {
      peers.clear();
      positions.forEach((position, i) => {
        const id = i.toString(16).padStart(32, '0');
        peers.set(id, { peerId: id, position, isConnected: true, isVerified: true });
      });
    },
  };
}

/** 平均距離 d で n 人を配置する (推定規模 ≈ 1 / (2d)) */
const around = (my: number, d: number, n = 10) =>
  Array.from({ length: n }, (_, i) => (my + (i % 2 === 0 ? d : -d) + 1) % 1);

/** 推定規模が ceil(log2(N/500)) = depth にちょうど収まる配置 (境界から離した 1.5 倍) */
const forDepth = (depth: number, my = 0.5) => around(my, 1 / (2 * 500 * Math.pow(2, depth - 1) * 1.5));

const RECOMPUTE_MS = 60_000;
const DECREASE_DELAY_MS = 5 * 60 * 1000;

describe('ZoneManager: Adaptive Zone の深さと購読セット', () => {
  beforeAll(async () => {
    await sodiumReady;
  });

  let pm: ReturnType<typeof fakePm>;
  let zm: ZoneManager;

  beforeEach(() => {
    vi.useFakeTimers();
    pm = fakePm(0.5);
    zm = new ZoneManager(pm as any);
  });
  afterEach(() => {
    zm.destroy();
    vi.useRealTimers();
  });

  it('初期状態は depth 0 で、全ゾーン (=1 つ) を購読し、どのゾーンも購読扱い', () => {
    expect(zm.depth).toBe(0);
    expect(Array.from(zm.subscribedZones)).toEqual([0]);
    for (const z of [0, 1, 17, 4095]) expect(zm.isSubscribed(z)).toBe(true);
  });

  it('隣人が少ない (8 人未満) うちは、どれだけ密でも depth を上げない', () => {
    pm.place(around(0.5, 1e-7, 7));
    vi.advanceTimersByTime(RECOMPUTE_MS * 3);
    expect(zm.depth).toBe(0);
  });

  it('網が小さい (推定 500 以下) なら depth 0 のまま', () => {
    pm.place(around(0.5, 0.01)); // 推定 50
    vi.advanceTimersByTime(RECOMPUTE_MS);
    expect(zm.depth).toBe(0);
  });

  it('推定規模に応じて depth が即座に上がる (ceil(log2(N/500)))', () => {
    pm.place(around(0.5, 1 / 3000)); // 推定 1500 → ceil(log2(3)) = 2
    vi.advanceTimersByTime(RECOMPUTE_MS);
    expect(zm.depth).toBe(2);
    // 総ゾーン数 4 ≦ 16 の間は全ゾーン購読 (Broadcast Veil)
    for (let z = 0; z < 4; z++) expect(zm.isSubscribed(z)).toBe(true);
  });

  it('リング座標の折り返し (0 と 1 の境目) を跨いだ距離を正しく扱う', () => {
    pm = fakePm(0.0);
    zm.destroy();
    zm = new ZoneManager(pm as any);
    pm.place(around(0.0, 1 / 3000)); // 半分は 0.99975 付近に置かれる
    vi.advanceTimersByTime(RECOMPUTE_MS);
    expect(zm.depth).toBe(2);
  });

  it('depth は MAX_DEPTH を超えない', () => {
    pm.place(around(0.5, 1e-12));
    vi.advanceTimersByTime(RECOMPUTE_MS);
    expect(zm.depth).toBe(RING_MESH_ZONE.MAX_DEPTH);
  });

  it('総ゾーン数が 16 を超えると、購読セットはちょうど 16 個になり isSubscribed はそれだけを通す', () => {
    pm.place(around(0.5, 1 / 48_000)); // 推定 24000 → depth 6 (64 ゾーン)
    vi.advanceTimersByTime(RECOMPUTE_MS);
    expect(zm.depth).toBe(6);

    const total = 1 << zm.depth;
    const subs = zm.subscribedZones;
    expect(subs.size).toBe(RING_MESH_ZONE.SUBSCRIBE_COUNT);
    for (const z of subs) {
      expect(z).toBeGreaterThanOrEqual(0);
      expect(z).toBeLessThan(total);
    }
    let accepted = 0;
    for (let z = 0; z < total; z++) {
      expect(zm.isSubscribed(z)).toBe(subs.has(z));
      if (zm.isSubscribed(z)) accepted++;
    }
    expect(accepted).toBe(RING_MESH_ZONE.SUBSCRIBE_COUNT);
  });

  it('1 段の上昇では、既存の購読ゾーンの子ゾーンを引き継ぐ', () => {
    pm.place(around(0.5, 1 / 48_000)); // depth 6
    vi.advanceTimersByTime(RECOMPUTE_MS);
    expect(zm.depth).toBe(6);
    const before = Array.from(zm.subscribedZones);

    pm.place(around(0.5, 1 / 96_000)); // 推定 48000 → depth 7
    vi.advanceTimersByTime(RECOMPUTE_MS);
    expect(zm.depth).toBe(7);

    const after = zm.subscribedZones;
    expect(after.size).toBe(RING_MESH_ZONE.SUBSCRIBE_COUNT);
    // 新しい購読ゾーンは、どれも前の購読ゾーンの子 (z >> 1 が前の集合に入る)
    for (const z of after) expect(before).toContain(z >> 1);
  });

  it('下降はヒステリシス付き: 5 分待ってから 1 段だけ下げる', () => {
    pm.place(around(0.5, 1 / 3000)); // depth 2
    vi.advanceTimersByTime(RECOMPUTE_MS);
    expect(zm.depth).toBe(2);

    pm.place(around(0.5, 0.01)); // 小さい網 → 目標 0
    vi.advanceTimersByTime(RECOMPUTE_MS);
    expect(zm.depth).toBe(2); // 即座には下げない

    vi.advanceTimersByTime(DECREASE_DELAY_MS - 1);
    expect(zm.depth).toBe(2); // 下降判定から 5 分経つまでは据え置き
    vi.advanceTimersByTime(1);
    expect(zm.depth).toBe(1); // 5 分後に 1 段だけ
    expect(Array.from(zm.subscribedZones).sort()).toEqual([0, 1]);

    // 次の段は、次の再計算で改めて 5 分待つ
    vi.advanceTimersByTime(DECREASE_DELAY_MS);
    expect(zm.depth).toBe(1);
    vi.advanceTimersByTime(RECOMPUTE_MS);
    expect(zm.depth).toBe(0);
  });

  it('下降待ちの間に規模が戻れば、下降は取り消される', () => {
    pm.place(around(0.5, 1 / 3000)); // depth 2
    vi.advanceTimersByTime(RECOMPUTE_MS);

    pm.place(around(0.5, 0.01));
    vi.advanceTimersByTime(RECOMPUTE_MS); // 下降タイマー開始

    pm.place(around(0.5, 1 / 3000)); // 同じ depth に戻る
    vi.advanceTimersByTime(RECOMPUTE_MS);
    vi.advanceTimersByTime(DECREASE_DELAY_MS * 2);
    expect(zm.depth).toBe(2);
  });

  it('隣人が 8 人を割っても、それだけでは depth を変えない (標本不足は判断しない)', () => {
    pm.place(around(0.5, 1 / 3000));
    vi.advanceTimersByTime(RECOMPUTE_MS);
    expect(zm.depth).toBe(2);
    pm.place(around(0.5, 0.2, 3));
    vi.advanceTimersByTime(DECREASE_DELAY_MS * 2);
    expect(zm.depth).toBe(2);
  });

  it('旧版が localStorage に残した購読セットは消す (端末に痕跡を残さない)', () => {
    const removeItem = vi.fn();
    vi.stubGlobal('localStorage', { removeItem, getItem: vi.fn(), setItem: vi.fn() });
    try {
      const z2 = new ZoneManager(fakePm() as any);
      expect(removeItem).toHaveBeenCalledWith('aether_subscribed_zones');
      z2.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('destroy() で再計算タイマーも下降タイマーも残らない', () => {
    pm.place(around(0.5, 1 / 3000));
    vi.advanceTimersByTime(RECOMPUTE_MS);
    pm.place(around(0.5, 0.01));
    vi.advanceTimersByTime(RECOMPUTE_MS); // 下降タイマーが仕掛かっている
    zm.destroy();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(DECREASE_DELAY_MS * 3);
    expect(zm.depth).toBe(2);
  });

  describe('depth 上昇時の購読セット (回帰テスト)', () => {
    const climb = (depth: number) => {
      pm.place(forDepth(depth));
      vi.advanceTimersByTime(RECOMPUTE_MS);
      expect(zm.depth).toBe(depth);
    };

    it('購読数は常にちょうど 16 (depth 5 → 12 まで 1 段ずつ上げても)', () => {
      for (let d = 5; d <= RING_MESH_ZONE.MAX_DEPTH; d++) {
        climb(d);
        expect(zm.subscribedZones.size).toBe(RING_MESH_ZONE.SUBSCRIBE_COUNT);
        for (const z of zm.subscribedZones) expect(z).toBeLessThan(1 << d);
      }
    });

    it('1 段の上昇: 前の 16 ゾーンそれぞれから子をちょうど 1 つずつ引き継ぐ', () => {
      climb(6);
      const before = new Set(zm.subscribedZones);
      climb(7);
      const parents = Array.from(zm.subscribedZones, z => z >> 1);
      expect(new Set(parents)).toEqual(before);
    });

    it('複数段の上昇 (6 → 9): 新しいゾーンは前のゾーンの本当の子孫で、前の各ゾーンから 1 つずつ', () => {
      climb(6);
      const before = new Set(zm.subscribedZones);
      climb(9);
      expect(zm.subscribedZones.size).toBe(RING_MESH_ZONE.SUBSCRIBE_COUNT);
      const ancestors = Array.from(zm.subscribedZones, z => z >> 3);
      expect(new Set(ancestors)).toEqual(before);
    });

    it('複数段の上昇 (5 → 12)', () => {
      climb(5);
      const before = new Set(zm.subscribedZones);
      climb(12);
      expect(new Set(Array.from(zm.subscribedZones, z => z >> 7))).toEqual(before);
    });

    it('全ゾーン購読の段階 (depth 2) から大きく上がると、前の各ゾーンの子孫を少なくとも 1 つ含み、残りを補充して 16 にする', () => {
      climb(2);
      expect(Array.from(zm.subscribedZones).sort()).toEqual([0, 1, 2, 3]);
      climb(8);
      expect(zm.subscribedZones.size).toBe(RING_MESH_ZONE.SUBSCRIBE_COUNT);
      const tops = new Set(Array.from(zm.subscribedZones, z => z >> 6));
      for (const old of [0, 1, 2, 3]) expect(tops.has(old)).toBe(true);
    });

    it('上昇後も総ゾーン数が 16 以下なら全ゾーンを購読する', () => {
      climb(2);
      climb(4);
      expect(Array.from(zm.subscribedZones).sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    });

    it('下降後 (depth ≥ 5) も購読数はちょうど 16', () => {
      climb(7);
      pm.place(forDepth(6));
      vi.advanceTimersByTime(RECOMPUTE_MS + DECREASE_DELAY_MS);
      expect(zm.depth).toBe(6);
      expect(zm.subscribedZones.size).toBe(RING_MESH_ZONE.SUBSCRIBE_COUNT);
    });

    it('ダミーの選択に Math.random を使わない (CSPRNG)', () => {
      const spy = vi.spyOn(Math, 'random');
      climb(6);
      climb(9);
      pm.place(forDepth(8));
      vi.advanceTimersByTime(RECOMPUTE_MS + DECREASE_DELAY_MS);
      expect(zm.depth).toBe(8);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('watchTopic (開いている板・スレッドのゾーン)', () => {
    /** depth 8 でランダム購読に入っていないトピック */
    function unsubscribedTopic(): Uint8Array {
      for (;;) {
        const t = sodium.randombytes_buf(64);
        if (!zm.subscribedZones.has(KeyManager.computeZoneId(t, zm.depth))) return t;
      }
    }
    const zoneOf = (t: Uint8Array) => KeyManager.computeZoneId(t, zm.depth);

    beforeEach(() => {
      pm.place(forDepth(8));
      vi.advanceTimersByTime(RECOMPUTE_MS);
      expect(zm.depth).toBe(8);
    });

    it('watch している間だけ、そのトピックのゾーンが購読扱いになる (ランダム 16 個は変えない)', () => {
      const t = unsubscribedTopic();
      const subs = new Set(zm.subscribedZones);
      expect(zm.isSubscribed(zoneOf(t))).toBe(false);
      const release = zm.watchTopic(t);
      expect(zm.isSubscribed(zoneOf(t))).toBe(true);
      expect(zm.subscribedZones).toEqual(subs);
      release();
      expect(zm.isSubscribed(zoneOf(t))).toBe(false);
    });

    it('参照カウント: 2 か所で watch したら、両方外すまで残る。同じ解除関数を 2 回呼んでも 1 回分', () => {
      const t = unsubscribedTopic();
      const r1 = zm.watchTopic(t);
      const r2 = zm.watchTopic(t.slice());
      r1();
      r1();
      expect(zm.isSubscribed(zoneOf(t))).toBe(true);
      r2();
      expect(zm.isSubscribed(zoneOf(t))).toBe(false);
    });

    it('トピックの先頭 32 バイトで同一視する (SHA-512 そのままでも 32 バイトに切ったものでも同じ)', () => {
      const t = unsubscribedTopic();
      const release = zm.watchTopic(t);
      const r2 = zm.watchTopic(t.slice(0, 32));
      release();
      expect(zm.isSubscribed(zoneOf(t))).toBe(true);
      r2();
      expect(zm.isSubscribed(zoneOf(t))).toBe(false);
    });

    it('watch したトピックのゾーンは depth が変わっても追随する', () => {
      const t = sodium.randombytes_buf(32);
      zm.watchTopic(t);
      for (const d of [9, 11, 12]) {
        pm.place(forDepth(d));
        vi.advanceTimersByTime(RECOMPUTE_MS);
        expect(zm.depth).toBe(d);
        expect(zm.isSubscribed(KeyManager.computeZoneId(t, d))).toBe(true);
      }
    });

    it('watch を外しても、無関係なゾーンが購読扱いになることはない', () => {
      const a = unsubscribedTopic();
      const b = unsubscribedTopic();
      const release = zm.watchTopic(a);
      if (zoneOf(a) !== zoneOf(b)) expect(zm.isSubscribed(zoneOf(b))).toBe(false);
      release();
      let accepted = 0;
      for (let z = 0; z < 1 << zm.depth; z++) if (zm.isSubscribed(z)) accepted++;
      expect(accepted).toBe(RING_MESH_ZONE.SUBSCRIBE_COUNT);
    });
  });
});
