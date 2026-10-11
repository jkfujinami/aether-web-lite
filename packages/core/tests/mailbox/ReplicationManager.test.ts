import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { sodiumReady } from '../../src/crypto/sodium';
import { RingPosition } from '../../src/network/RingPosition';
import { MessageDispatcher } from '../../src/network/MessageDispatcher';
import { DHTMailbox } from '../../src/network/mailbox/DHTMailbox';
import { ReplicationManager } from '../../src/network/mailbox/ReplicationManager';
import {
  FakeCircuit,
  FakePeerManager,
  MemoryMailboxStore,
  flush,
  makeSlot,
  packetBytes,
  topicAt,
  topicPosition,
} from '../helpers/hintMailboxFakes';
import { makePacket } from '../helpers/onionNet';

const ME = 'me'.padEnd(32, '0');
const pid = (i: number) => `p${i}`.padEnd(32, '0');
const TOPIC0 = topicAt(0);
const DEBOUNCE_MS = 10_000;
const PERIOD_MS = 300_000;

const managers: ReplicationManager[] = [];

function setup(opts: { myPos?: number; peers?: Array<[number, { connected?: boolean; verified?: boolean }?]> } = {}) {
  const pm = new FakePeerManager(ME, opts.myPos ?? 0.5);
  (opts.peers ?? []).forEach(([pos, o], i) => pm.addPeer(pid(i), pos, o));
  const store = new MemoryMailboxStore();
  const mailbox = { fetch: vi.fn(async () => []), replicate: vi.fn() };
  const rm = new ReplicationManager(mailbox as any, pm as any, store as any);
  managers.push(rm);
  return { pm, store, mailbox, rm };
}

beforeAll(async () => {
  await sodiumReady;
});

afterEach(() => {
  while (managers.length) managers.pop()!.destroy();
  vi.useRealTimers();
});

describe('ReplicationManager: 再配分のきっかけ', () => {
  it('★接続の変化から 10 秒待ってから再配分する', async () => {
    vi.useFakeTimers();
    const { pm, store, mailbox } = setup({ peers: [[0.1]] });
    await store.put(TOPIC0, [packetBytes()]);
    pm.emit('peer:connect', pid(0));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    expect(mailbox.replicate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mailbox.replicate).toHaveBeenCalledTimes(1);
  });

  it('★短時間に続く接続変化は 1 回の再配分にまとめる (バースト防止)', async () => {
    vi.useFakeTimers();
    const { pm, store, mailbox } = setup({ peers: [[0.1]] });
    await store.put(TOPIC0, [packetBytes()]);
    pm.emit('peer:connect', 'x');
    await vi.advanceTimersByTimeAsync(5_000);
    pm.emit('peer:disconnect', 'y');
    await vi.advanceTimersByTimeAsync(9_000);
    pm.emit('peer:connect', 'z');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    expect(mailbox.replicate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mailbox.replicate).toHaveBeenCalledTimes(1);
  });

  it('切断でも再配分が走る', async () => {
    vi.useFakeTimers();
    const { pm, store, mailbox } = setup({ peers: [[0.1]] });
    await store.put(TOPIC0, [packetBytes()]);
    pm.emit('peer:disconnect', 'gone');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(mailbox.replicate).toHaveBeenCalledTimes(1);
  });

  it('接続変化が無くても 5 分ごとに再配分する', async () => {
    vi.useFakeTimers();
    const { store, mailbox } = setup({ peers: [[0.1]] });
    await store.put(TOPIC0, [packetBytes()]);
    await vi.advanceTimersByTimeAsync(PERIOD_MS + DEBOUNCE_MS - 1);
    expect(mailbox.replicate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mailbox.replicate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PERIOD_MS);
    expect(mailbox.replicate).toHaveBeenCalledTimes(2);
  });

  it('★destroy 後は接続変化でも周期でも再配分しない (保留中のものも取り消す)', async () => {
    vi.useFakeTimers();
    const { pm, store, mailbox, rm } = setup({ peers: [[0.1]] });
    await store.put(TOPIC0, [packetBytes()]);
    pm.emit('peer:connect', 'x');
    rm.destroy();
    pm.emit('peer:connect', 'y');
    await vi.advanceTimersByTimeAsync(PERIOD_MS * 3);
    expect(mailbox.replicate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('ReplicationManager: 再配分の中身', () => {
  it('隣人が居なければ何もしない (ストアにも触らない)', async () => {
    const { store, mailbox, rm } = setup();
    const spy = vi.spyOn(store, 'getAllTopicHashes');
    await rm.executeRebalance();
    expect(spy).not.toHaveBeenCalled();
    expect(mailbox.replicate).not.toHaveBeenCalled();
  });

  it('★各トピックを、自分以外の近い順 5 人 (検証済み・接続中) へ複製する', async () => {
    const positions = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07];
    const { pm, store, mailbox, rm } = setup({
      myPos: 0.0, // 自分が一番近いが、自分は対象外
      peers: positions.map(p => [p] as [number]),
    });
    pm.addPeer('unverified'.padEnd(32, '0'), 0.001, { verified: false });
    pm.addPeer('offline'.padEnd(32, '0'), 0.002, { connected: false });
    const entries = [packetBytes()];
    await store.put(TOPIC0, entries);
    await rm.executeRebalance();
    const targets = mailbox.replicate.mock.calls.map(c => c[0]);
    expect(targets).toEqual([pid(0), pid(1), pid(2), pid(3), pid(4)]);
    for (const c of mailbox.replicate.mock.calls) {
      expect(c[1]).toBe(TOPIC0);
      expect(c[2]).toHaveLength(1);
    }
  });

  it('近さはリングの巻き戻りを含む距離で測る', async () => {
    const topic = topicAt(Math.floor(0.98 * 0xffffffff));
    const tpos = topicPosition(topic);
    const positions = [0.5, 0.01, 0.9, 0.97, 0.3, 0.6, 0.05, 0.99];
    const { store, mailbox, rm } = setup({ peers: positions.map(p => [p] as [number]) });
    await store.put(topic, [packetBytes()]);
    await rm.executeRebalance();
    const expected = positions
      .map((p, i) => ({ id: pid(i), d: RingPosition.distance(tpos, p) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 5)
      .map(x => x.id);
    expect(mailbox.replicate.mock.calls.map(c => c[0])).toEqual(expected);
  });

  it('中身の無いトピックは飛ばす', async () => {
    const { store, mailbox, rm } = setup({ peers: [[0.1]] });
    store.phantomTopics = 3; // 一覧には出るが get は undefined
    await store.put(TOPIC0, [packetBytes()]);
    await rm.executeRebalance();
    expect(mailbox.replicate).toHaveBeenCalledTimes(1);
  });

  it('1 人への送信が失敗しても、残りの相手には送る', async () => {
    const { store, mailbox, rm } = setup({ peers: [[0.1], [0.2], [0.3]] });
    await store.put(TOPIC0, [packetBytes()]);
    mailbox.replicate.mockImplementationOnce(() => { throw new Error('send failed'); });
    await expect(rm.executeRebalance()).resolves.toBeUndefined();
    expect(mailbox.replicate).toHaveBeenCalledTimes(3);
  });

  it('保管が空なら何もしない', async () => {
    const { mailbox, rm } = setup({ peers: [[0.1]] });
    await rm.executeRebalance();
    expect(mailbox.replicate).not.toHaveBeenCalled();
  });
});

describe('ReplicationManager: 停止・ロック中の再配分 [回帰]', () => {
  it('★ストアがロックされていても executeRebalance は reject しない', async () => {
    const { store, mailbox, rm } = setup({ peers: [[0.1]] });
    store.locked = true;
    await expect(rm.executeRebalance()).resolves.toBeUndefined();
    expect(mailbox.replicate).not.toHaveBeenCalled();
  });

  it('★タイマーから走った再配分がロック中のストアに当たっても、未処理の reject を出さない', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    vi.useFakeTimers();
    try {
      const { pm, store } = setup({ peers: [[0.1]] });
      store.locked = true;
      pm.emit('peer:connect', 'x');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await vi.advanceTimersByTimeAsync(PERIOD_MS + DEBOUNCE_MS);
      vi.useRealTimers();
      await flush(5);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('★再配分の途中で停止 (destroy → lock) されたら、残りのトピックには進まない', async () => {
    const { store, mailbox, rm } = setup({ peers: [[0.1], [0.2]] });
    for (let i = 1; i <= 4; i++) await store.put(topicAt(i), [packetBytes(makePacket([i]))]);
    const realGet = store.get.bind(store);
    let calls = 0;
    store.get = async (t: string) => {
      calls++;
      const r = await realGet(t);
      // AetherNode.stop() と同じ順序: replication を止めてからストアをロック
      rm.destroy();
      store.locked = true;
      return r;
    };
    await expect(rm.executeRebalance()).resolves.toBeUndefined();
    expect(calls).toBe(1);
    const topics = new Set(mailbox.replicate.mock.calls.map(c => c[1]));
    expect(topics.size).toBeLessThanOrEqual(1);
  });

  it('★ロックがループの途中で起きても (destroy 無し) reject せず止まる', async () => {
    const { store, mailbox, rm } = setup({ peers: [[0.1]] });
    for (let i = 1; i <= 3; i++) await store.put(topicAt(i), [packetBytes(makePacket([i]))]);
    const realGet = store.get.bind(store);
    store.get = async (t: string) => {
      const r = await realGet(t);
      store.locked = true;
      return r;
    };
    await expect(rm.executeRebalance()).resolves.toBeUndefined();
    expect(mailbox.replicate).toHaveBeenCalledTimes(1);
  });

  it('destroy 済みなら executeRebalance を直接呼んでも何もしない', async () => {
    const { store, mailbox, rm } = setup({ peers: [[0.1]] });
    await store.put(TOPIC0, [packetBytes()]);
    rm.destroy();
    await rm.executeRebalance();
    expect(mailbox.replicate).not.toHaveBeenCalled();
  });
});

describe('ReplicationManager × DHTMailbox: 複製は受け手の検証を通る', () => {
  it('★保管している Slot が、担当の隣人の DHTMailbox に PUT として届いて保管される', async () => {
    // 2 ノードを MessageDispatcher 同士で直結する
    const A = 'nodeA'.padEnd(32, '0');
    const B = 'nodeB'.padEnd(32, '0');
    const pmA = new FakePeerManager(A, 0.5);
    const pmB = new FakePeerManager(B, 0.01);
    pmA.addPeer(B, 0.01);
    pmB.addPeer(A, 0.5);
    const dA = new MessageDispatcher();
    const dB = new MessageDispatcher();
    pmA.sendMessage = (to, type, payload) => { if (to === B) dB.dispatch(A, type, payload); };
    pmB.sendMessage = (to, type, payload) => { if (to === A) dA.dispatch(B, type, payload); };
    const storeA = new MemoryMailboxStore();
    const storeB = new MemoryMailboxStore();
    const mbA = new DHTMailbox(pmA as any, dA, storeA as any, new FakeCircuit() as any);
    const mbB = new DHTMailbox(pmB as any, dB, storeB as any, new FakeCircuit() as any);
    const rm = new ReplicationManager(mbA, pmA as any, storeA as any);
    managers.push(rm);

    const s = makeSlot(new Uint8Array(32).fill(0x91));
    const raw = packetBytes(makePacket([1, 1]));
    await storeA.put(s.keyHex, [s.entry]);
    await storeA.put(TOPIC0, [raw]);
    await rm.executeRebalance();
    await flush();

    expect((await storeB.get(s.keyHex))!.map(e => Array.from(e))).toEqual([Array.from(s.entry)]);
    expect((await storeB.get(TOPIC0))!).toHaveLength(1);

    // ★[回帰] 定期的な再複製 (同じものの再送) で受け手の使用量・枠が膨らまない
    //   (初回の値そのものは、並行 PUT の競合で過少計上されうるので比較しない — 報告済み)
    const usageAfterFirst = (mbB as any).usageBytes;
    const quotaAfterFirst = (mbB as any).peerQuota.get(A).bytes;
    for (let i = 0; i < 5; i++) {
      await rm.executeRebalance();
      await flush();
    }
    expect((mbB as any).usageBytes).toBe(usageAfterFirst);
    expect((mbB as any).peerQuota.get(A).bytes).toBe(quotaAfterFirst);
  });

  it('★[回帰] 1 トピックだけなら、何度再複製しても受け手の使用量・枠はエントリ 1 件ぶんのまま', async () => {
    const A = 'nodeA'.padEnd(32, '0');
    const B = 'nodeB'.padEnd(32, '0');
    const pmA = new FakePeerManager(A, 0.5);
    const pmB = new FakePeerManager(B, 0.01);
    pmA.addPeer(B, 0.01);
    pmB.addPeer(A, 0.5);
    const dB = new MessageDispatcher();
    pmA.sendMessage = (to, type, payload) => { if (to === B) dB.dispatch(A, type, payload); };
    const storeA = new MemoryMailboxStore();
    const storeB = new MemoryMailboxStore();
    const mbA = new DHTMailbox(pmA as any, new MessageDispatcher(), storeA as any, new FakeCircuit() as any);
    const mbB = new DHTMailbox(pmB as any, dB, storeB as any, new FakeCircuit() as any);
    const stored: Uint8Array[] = [];
    mbB.onSlotStored(e => stored.push(e));
    const rm = new ReplicationManager(mbA, pmA as any, storeA as any);
    managers.push(rm);

    const s = makeSlot(new Uint8Array(32).fill(0x92));
    await storeA.put(s.keyHex, [s.entry]);
    for (let i = 0; i < 6; i++) {
      await rm.executeRebalance();
      await flush();
    }
    expect((await storeB.get(s.keyHex))!).toHaveLength(1);
    expect((mbB as any).usageBytes).toBe(s.entry.length);
    expect((mbB as any).peerQuota.get(A).bytes).toBe(s.entry.length);
    expect(stored).toHaveLength(1);
  });
});
