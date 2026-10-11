import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { RingPosition } from '../../src/network/RingPosition';
import { IndexedDBStore } from '../../src/storage/IndexedDBStore';
import { VAULT_PARAMS_FAST } from '../../src/storage/SecretVault';
import { MessageDispatcher } from '../../src/network/MessageDispatcher';
import { WireType } from '../../src/network/wire/WireTypes';
import { DHTMailbox } from '../../src/network/mailbox/DHTMailbox';
import { MAILBOX_LIMITS } from '../../src/network/mailbox/MailboxEntry';
import { encodeHint, verifyHintPow, type HintPacket } from '../../src/network/hint/HintPacket';
import { decodeSlotBlob, encodeSlotBlob } from '../../src/network/hint/SlotBlob';
import { makePacket } from '../helpers/onionNet';
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

const ME = 'me'.padEnd(32, '0');
const pid = (i: number) => `p${i}`.padEnd(32, '0');
const SENDER = 'sender'.padEnd(32, '0');

/** リング座標 0 の topicHash (先頭 8 桁 0) */
const TOPIC0 = topicAt(0);
let K: Uint8Array;

function setup(opts: { myPos?: number; store?: any } = {}) {
  const pm = new FakePeerManager(ME, opts.myPos ?? 0);
  const dispatcher = new MessageDispatcher();
  const store = opts.store ?? new MemoryMailboxStore();
  const circuit = new FakeCircuit();
  const mailbox = new DHTMailbox(pm as any, dispatcher, store, circuit as any);
  const slotEvents: Array<{ entry: Uint8Array; topic: string }> = [];
  mailbox.onSlotStored((entry, topic) => slotEvents.push({ entry, topic }));
  const put = async (from: string, msg: any) => {
    dispatcher.dispatch(from, WireType.DHT_PUT, msg);
    await flush();
  };
  return { pm, dispatcher, store, circuit, mailbox, slotEvents, put };
}

function failingPow(h: HintPacket): HintPacket {
  for (let n = 0; ; n++) {
    const c = { ...h, pow_nonce: n };
    if (!verifyHintPow(c)) return c;
  }
}

beforeAll(async () => {
  await sodiumReady;
  K = new Uint8Array(32).fill(0x81);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DHTMailbox: PUT の入力検証', () => {
  it('★壊れた PUT で例外を投げず、何も保管しない', async () => {
    const { put, store, pm, slotEvents } = setup();
    const e = packetBytes();
    for (const msg of [
      null, undefined, 'x', 1, [], {},
      { topicHash: 'zz', entries: [e] },
      { topicHash: topicAt(0xabcdef01).toUpperCase(), entries: [e] },
      { topicHash: TOPIC0 },
      { topicHash: TOPIC0, entries: null },
      { topicHash: TOPIC0, entries: 'abc' },
      { topicHash: TOPIC0, entries: [null, 1, 'x', {}] },
      { topicHash: TOPIC0, entries: { 0: e, length: 1 } },
    ]) {
      await put(SENDER, msg);
    }
    expect(store.data.size).toBe(0);
    expect(pm.sent).toHaveLength(0);
    expect(slotEvents).toHaveLength(0);
  });

  it('★改竄されたエントリは捨て、正当なものだけを保管する', async () => {
    const { put, store } = setup();
    const good = packetBytes(makePacket([1]));
    const p = makePacket([2]);
    const tampered = packetBytes({ ...p, payload: Uint8Array.from([3]) });
    const badHint = encodeSlotBlob(failingPow(makeSlot(K).hint), packetBytes());
    await put(SENDER, { topicHash: TOPIC0, entries: [tampered, good, badHint] });
    const stored = await store.get(TOPIC0);
    expect(stored).toHaveLength(1);
    expect(Array.from(stored![0])).toEqual(Array.from(good));
  });

  it('全部が不正なら何も書かない (トピックも作らない)', async () => {
    const { put, store } = setup();
    await put(SENDER, { topicHash: TOPIC0, entries: [new TextEncoder().encode('junk')] });
    expect(store.data.has(TOPIC0)).toBe(false);
  });

  it('保管した Slot ごとに onSlotStored が (エントリ, topicHash) で呼ばれる', async () => {
    const { put, slotEvents } = setup();
    const s1 = makeSlot(K);
    const s2 = makeSlot(K);
    await put(SENDER, { topicHash: s1.keyHex, entries: [s1.entry, s2.entry] });
    expect(slotEvents).toHaveLength(2);
    expect(slotEvents.every(e => e.topic === s1.keyHex)).toBe(true);
    expect(decodeSlotBlob(slotEvents[0].entry)).not.toBeNull();
  });

  it('★送信側でも受信側でも 1 メッセージあたりの件数上限を超えた分は見ない', async () => {
    const { mailbox, pm } = setup();
    const entries = Array.from({ length: 130 }, (_, i) => packetBytes(makePacket([i])));
    mailbox.replicate(pid(1), TOPIC0, entries);
    const puts = pm.sentOfType(WireType.DHT_PUT);
    expect(puts.map(m => m.payload.entries.length)).toEqual([64, 64, 2]);
    expect(puts.every(m => m.to === pid(1) && m.payload.topicHash === TOPIC0)).toBe(true);
  });

  it('replicate に空配列を渡しても何も送らない', () => {
    const { mailbox, pm } = setup();
    mailbox.replicate(pid(1), TOPIC0, []);
    expect(pm.sent).toHaveLength(0);
  });
});

describe('DHTMailbox: 帰属判定 (自分が K-nearest 圏内か)', () => {
  it('★自分より近い検証済みピアが 7 人までなら受け付ける (K=5 + 許容 3)', async () => {
    const { pm, put, store } = setup({ myPos: 0.5 });
    for (let i = 1; i <= 7; i++) pm.addPeer(pid(i), i * 0.01);
    await put(pid(1), { topicHash: TOPIC0, entries: [packetBytes()] });
    expect(store.data.has(TOPIC0)).toBe(true);
  });

  it('★自分より近い検証済みピアが 8 人居れば、無関係なノードとして拒否する', async () => {
    const { pm, put, store, slotEvents } = setup({ myPos: 0.5 });
    for (let i = 1; i <= 8; i++) pm.addPeer(pid(i), i * 0.01);
    const s = makeSlot(K);
    await put(pid(1), { topicHash: TOPIC0, entries: [s.entry] });
    expect(store.data.size).toBe(0);
    expect(slotEvents).toHaveLength(0);
  });

  it('未検証・未接続のピアは帰属判定の母集団に入らない', async () => {
    const { pm, put, store } = setup({ myPos: 0.5 });
    for (let i = 1; i <= 7; i++) pm.addPeer(pid(i), i * 0.01);
    pm.addPeer(pid(8), 0.001, { verified: false });
    pm.addPeer(pid(9), 0.002, { connected: false });
    await put(pid(1), { topicHash: TOPIC0, entries: [packetBytes()] });
    expect(store.data.has(TOPIC0)).toBe(true);
  });

  it('★リングは 1.0 で 0.0 に巻き戻る (0.99 付近のトピックには 0.01 のピアが近い)', async () => {
    // topic ≒ 0.99。自分は 0.02 (距離 0.03)。0.9 側のピア 8 人は自分より遠い (距離 0.04 以上)
    const topic = topicAt(Math.floor(0.99 * 0xffffffff));
    expect(topicPosition(topic)).toBeCloseTo(0.99, 5);
    const { pm, put, store } = setup({ myPos: 0.02 });
    for (let i = 1; i <= 8; i++) pm.addPeer(pid(i), 0.95 - i * 0.01);
    await put(pid(1), { topicHash: topic, entries: [packetBytes()] });
    expect(store.data.has(topic)).toBe(true);
  });
});

describe('DHTMailbox: 保管の上限', () => {
  it('★既に満杯のトピックには追加しない', async () => {
    const { put, store } = setup();
    await store.put(TOPIC0, Array.from({ length: MAILBOX_LIMITS.MAX_ENTRIES_PER_TOPIC }, (_, i) => packetBytes(makePacket([i]))));
    await put(SENDER, { topicHash: TOPIC0, entries: [packetBytes(makePacket([99]))] });
    expect((await store.get(TOPIC0))!).toHaveLength(MAILBOX_LIMITS.MAX_ENTRIES_PER_TOPIC);
  });

  it('空きの分だけ受け付ける', async () => {
    const { put, store, slotEvents } = setup();
    const room = 1;
    await store.put(TOPIC0, Array.from({ length: MAILBOX_LIMITS.MAX_ENTRIES_PER_TOPIC - room }, (_, i) => packetBytes(makePacket([i]))));
    await put(SENDER, { topicHash: TOPIC0, entries: [10, 11, 12].map(i => packetBytes(makePacket([i]))) });
    expect((await store.get(TOPIC0))!).toHaveLength(MAILBOX_LIMITS.MAX_ENTRIES_PER_TOPIC);
    expect(slotEvents).toHaveLength(room);
  });

  it('★トピック数が上限なら新しいトピックは作らないが、既存トピックへの追加はできる', async () => {
    const { put, store } = setup();
    const existing = topicAt(1);
    await store.put(existing, [packetBytes(makePacket([1]))]);
    store.phantomTopics = MAILBOX_LIMITS.MAX_TOPICS;
    await put(SENDER, { topicHash: TOPIC0, entries: [packetBytes(makePacket([2]))] });
    expect(store.data.has(TOPIC0)).toBe(false);
    await put(SENDER, { topicHash: existing, entries: [packetBytes(makePacket([3]))] });
    expect((await store.get(existing))!).toHaveLength(2);
  });

  it('★保管の総量が上限を超えるなら受け付けない', async () => {
    const { put, store } = setup();
    const e = packetBytes();
    store.usageOverride = MAILBOX_LIMITS.MAX_TOTAL_BYTES - e.length + 1;
    await put(SENDER, { topicHash: TOPIC0, entries: [e] });
    expect(store.data.size).toBe(0);
  });

  it('総量の上限ちょうどまでは受け付ける', async () => {
    const { put, store } = setup();
    const e = packetBytes();
    store.usageOverride = MAILBOX_LIMITS.MAX_TOTAL_BYTES - e.length;
    await put(SENDER, { topicHash: TOPIC0, entries: [e] });
    expect(store.data.has(TOPIC0)).toBe(true);
  });

  it('★1 時間の受け入れ量を使い切った送り主は弾かれ、他の送り主は影響を受けない', async () => {
    const { put, store, mailbox } = setup();
    (mailbox as any).peerQuota.set(pid(1), { windowStart: Date.now(), bytes: MAILBOX_LIMITS.MAX_BYTES_PER_PEER_PER_HOUR });
    await put(pid(1), { topicHash: TOPIC0, entries: [packetBytes(makePacket([1]))] });
    expect(store.data.has(TOPIC0)).toBe(false);
    await put(pid(2), { topicHash: TOPIC0, entries: [packetBytes(makePacket([2]))] });
    expect(store.data.has(TOPIC0)).toBe(true);
  });

  it('受け入れ量の窓は 1 時間で戻る', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_700_000_000_000);
    const { put, store, mailbox } = setup();
    (mailbox as any).peerQuota.set(pid(1), { windowStart: Date.now(), bytes: MAILBOX_LIMITS.MAX_BYTES_PER_PEER_PER_HOUR });
    vi.setSystemTime(1_700_000_000_000 + 60 * 60 * 1000 + 1);
    await put(pid(1), { topicHash: TOPIC0, entries: [packetBytes()] });
    expect(store.data.has(TOPIC0)).toBe(true);
  });

  it('受け入れた分だけ送り主の枠と総使用量が増える', async () => {
    const { put, mailbox } = setup();
    const e = packetBytes();
    await put(pid(1), { topicHash: TOPIC0, entries: [e] });
    expect((mailbox as any).peerQuota.get(pid(1)).bytes).toBe(e.length);
    expect((mailbox as any).usageBytes).toBe(e.length);
  });

  it('★[回帰] 既に保管しているエントリの再 PUT は使用量にも送り主の枠にも数えない', async () => {
    const { put, store, mailbox } = setup();
    const s = makeSlot(K);
    for (let i = 0; i < 10; i++) {
      await put(pid(1), { topicHash: s.keyHex, entries: [s.entry] });
    }
    expect((await store.get(s.keyHex))!).toHaveLength(1);
    expect((mailbox as any).usageBytes).toBe(s.entry.length);
    expect((mailbox as any).usageBytes).toBe(await store.mailboxUsageBytes());
    expect((mailbox as any).peerQuota.get(pid(1)).bytes).toBe(s.entry.length);
    // 別の送り主から同じものが来ても、その送り主の枠は消費されない
    await put(pid(2), { topicHash: s.keyHex, entries: [s.entry] });
    expect((mailbox as any).peerQuota.get(pid(2))?.bytes ?? 0).toBe(0);
    expect((mailbox as any).usageBytes).toBe(s.entry.length);
  });

  it('★[回帰] 既に保管しているエントリの再 PUT では onSlotStored を呼び直さない', async () => {
    const { put, slotEvents } = setup();
    const s = makeSlot(K);
    await put(pid(1), { topicHash: s.keyHex, entries: [s.entry] });
    await put(pid(1), { topicHash: s.keyHex, entries: [s.entry] });
    await put(pid(2), { topicHash: s.keyHex, entries: [s.entry.slice()] });
    expect(slotEvents).toHaveLength(1);
  });

  it('★[回帰] 既存と新規が混ざった PUT は、新規の分だけ数えて保管する', async () => {
    const { put, store, mailbox, slotEvents } = setup();
    const a = packetBytes(makePacket([1]));
    const b = packetBytes(makePacket([2]));
    await put(pid(1), { topicHash: TOPIC0, entries: [a] });
    await put(pid(1), { topicHash: TOPIC0, entries: [a, b] });
    expect((await store.get(TOPIC0))!).toHaveLength(2);
    expect((mailbox as any).usageBytes).toBe(a.length + b.length);
    expect((mailbox as any).peerQuota.get(pid(1)).bytes).toBe(a.length + b.length);
    expect(slotEvents.map(e => e.entry.length)).toEqual([a.length, b.length]);
  });

  it('★[回帰] 重複を空きとして数えない: 満杯近くでも既存の再送が新規の枠を食わない', async () => {
    const { put, store } = setup();
    const olds = Array.from({ length: MAILBOX_LIMITS.MAX_ENTRIES_PER_TOPIC - 1 }, (_, i) => packetBytes(makePacket([i])));
    await store.put(TOPIC0, olds);
    const fresh = packetBytes(makePacket([200]));
    // 既存 3 件を先頭に並べても、空き 1 件には新規が入る
    await put(pid(1), { topicHash: TOPIC0, entries: [...olds, fresh] });
    const got = (await store.get(TOPIC0))!;
    expect(got).toHaveLength(MAILBOX_LIMITS.MAX_ENTRIES_PER_TOPIC);
    expect(got.some((e: Uint8Array) => Array.from(e).join() === Array.from(fresh).join())).toBe(true);
  });

  it('★[回帰] 使用量が上限近くでも、既存エントリの再 PUT 自体は拒否理由にならず何も変えない', async () => {
    const { put, store, mailbox } = setup();
    const e = packetBytes();
    await put(pid(1), { topicHash: TOPIC0, entries: [e] });
    (mailbox as any).usageBytes = MAILBOX_LIMITS.MAX_TOTAL_BYTES; // 満杯
    await put(pid(1), { topicHash: TOPIC0, entries: [e] });
    expect((mailbox as any).usageBytes).toBe(MAILBOX_LIMITS.MAX_TOTAL_BYTES);
    expect((await store.get(TOPIC0))!).toHaveLength(1);
  });

  it('★[回帰] fetch の応答で手元と同じものが返ってきても、使用量・枠を増やさない', async () => {
    vi.useFakeTimers();
    const ctx = setup({ myPos: 0.5 });
    ctx.pm.addPeer(pid(1), 0.01);
    const s = makeSlot(K);
    await ctx.store.put(TOPIC0, [s.entry]);
    for (let round = 0; round < 3; round++) {
      const p = ctx.mailbox.fetch(TOPIC0);
      await vi.advanceTimersByTimeAsync(0);
      const g = ctx.pm.sentOfType(WireType.DHT_GET).at(-1)!;
      ctx.dispatcher.dispatch(g.to, WireType.DHT_RES, { topicHash: TOPIC0, reqId: g.payload.reqId, entries: [s.entry] });
      await vi.advanceTimersByTimeAsync(0);
      expect(await p).toHaveLength(1);
    }
    expect((ctx.mailbox as any).peerQuota.get(pid(1))?.bytes ?? 0).toBe(0);
    expect(ctx.slotEvents).toHaveLength(0);
  });

  it('保持期限切れの掃除で使用量の記録を捨て、古い受け入れ枠も消す', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_700_000_000_000);
    const { put, mailbox, store } = setup();
    await put(pid(1), { topicHash: TOPIC0, entries: [packetBytes()] });
    expect((mailbox as any).usageBytes).not.toBeNull();
    const later = Date.now() + MAILBOX_LIMITS.RETENTION_MS + 1;
    vi.setSystemTime(later);
    await mailbox.pruneExpired(later);
    expect(store.data.size).toBe(0);
    expect((mailbox as any).usageBytes).toBeNull();
    expect((mailbox as any).peerQuota.size).toBe(0);
  });
});

describe('DHTMailbox: GET への応答', () => {
  it('同じ reqId・topicHash で、保管しているエントリを返す', async () => {
    const { dispatcher, store, pm } = setup();
    const e = packetBytes();
    await store.put(TOPIC0, [e]);
    dispatcher.dispatch(pid(1), WireType.DHT_GET, { topicHash: TOPIC0, reqId: 'r1' });
    await flush();
    const res = pm.sentOfType(WireType.DHT_RES);
    expect(res).toHaveLength(1);
    expect(res[0].to).toBe(pid(1));
    expect(res[0].payload.reqId).toBe('r1');
    expect(res[0].payload.topicHash).toBe(TOPIC0);
    expect(res[0].payload.entries).toHaveLength(1);
  });

  it('持っていないトピックには空で応答する', async () => {
    const { dispatcher, pm } = setup();
    dispatcher.dispatch(pid(1), WireType.DHT_GET, { topicHash: TOPIC0, reqId: 'r' });
    await flush();
    expect(pm.sentOfType(WireType.DHT_RES)[0].payload.entries).toEqual([]);
  });

  it('★壊れた GET には応答しない (例外も投げない)', async () => {
    const { dispatcher, pm } = setup();
    for (const msg of [
      null, {}, { topicHash: TOPIC0 }, { topicHash: TOPIC0, reqId: 5 }, { topicHash: TOPIC0, reqId: 'x'.repeat(65) },
      { topicHash: 'nothex', reqId: 'r' }, { reqId: 'r' },
    ]) {
      dispatcher.dispatch(pid(1), WireType.DHT_GET, msg);
    }
    await flush();
    expect(pm.sent).toHaveLength(0);
  });

  it('reqId は 64 文字までなら受け付ける', async () => {
    const { dispatcher, pm } = setup();
    dispatcher.dispatch(pid(1), WireType.DHT_GET, { topicHash: TOPIC0, reqId: 'x'.repeat(64) });
    await flush();
    expect(pm.sentOfType(WireType.DHT_RES)).toHaveLength(1);
  });
});

describe('DHTMailbox: fetch (GET と応答の照合)', () => {
  /** 自分 (0.5) と 7 人のピア。TOPIC0 (=0) に近い順は p1..p7, 自分は最後 */
  function sevenPeers() {
    const ctx = setup({ myPos: 0.5 });
    for (let i = 1; i <= 7; i++) ctx.pm.addPeer(pid(i), i * 0.05);
    return ctx;
  }

  it('不正な topicHash では何も送らず空を返す', async () => {
    const { mailbox, pm } = sevenPeers();
    expect(await mailbox.fetch('nope')).toEqual([]);
    expect(pm.sent).toHaveLength(0);
  });

  it('隣人が居なければ手元のものだけを返す', async () => {
    const { mailbox, store } = setup();
    const e = packetBytes();
    await store.put(TOPIC0, [e]);
    const r = await mailbox.fetch(TOPIC0);
    expect(r).toHaveLength(1);
  });

  it('★K-nearest (検証済み・近い順 5 人) にだけ GET を出す', async () => {
    vi.useFakeTimers();
    const { mailbox, pm } = sevenPeers();
    pm.addPeer(pid(90), 0.0001, { verified: false }); // 最も近いが未検証
    pm.addPeer(pid(91), 0.0002, { connected: false });
    const p = mailbox.fetch(TOPIC0);
    await vi.advanceTimersByTimeAsync(0);
    const targets = pm.sentOfType(WireType.DHT_GET).map(m => m.to);
    expect(targets).toEqual([pid(1), pid(2), pid(3), pid(4), pid(5)]);
    await vi.advanceTimersByTimeAsync(5000);
    await p;
  });

  it('★自分が K-nearest に入っていれば、その枠は自分自身で使われ GET は K-1 人に出る', async () => {
    vi.useFakeTimers();
    const ctx = setup({ myPos: 0.001 });
    for (let i = 1; i <= 7; i++) ctx.pm.addPeer(pid(i), i * 0.05);
    const p = ctx.mailbox.fetch(TOPIC0);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.pm.sentOfType(WireType.DHT_GET).map(m => m.to)).toEqual([pid(1), pid(2), pid(3), pid(4)]);
    await vi.advanceTimersByTimeAsync(5000);
    await p;
  });

  it('K-nearest の選び方は RingPosition.distance の昇順と一致する (巻き戻りを含む)', async () => {
    vi.useFakeTimers();
    const topic = topicAt(Math.floor(0.97 * 0xffffffff));
    const tpos = topicPosition(topic);
    const ctx = setup({ myPos: 0.5 });
    const positions = [0.01, 0.02, 0.9, 0.93, 0.99, 0.3, 0.7, 0.05];
    positions.forEach((pos, i) => ctx.pm.addPeer(pid(i), pos));
    const expected = positions
      .map((pos, i) => ({ id: pid(i), d: RingPosition.distance(tpos, pos) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 5)
      .map(x => x.id);
    const p = ctx.mailbox.fetch(topic);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.pm.sentOfType(WireType.DHT_GET).map(m => m.to)).toEqual(expected);
    await vi.advanceTimersByTimeAsync(5000);
    await p;
  });

  it('★全員が応答すれば猶予を待たずに確定し、応答と手元を重複なしでまとめる', async () => {
    vi.useFakeTimers();
    const { mailbox, pm, dispatcher, store } = sevenPeers();
    const a = packetBytes(makePacket([1]));
    const b = packetBytes(makePacket([2]));
    await store.put(TOPIC0, [a]);
    let result: Uint8Array[] | null = null;
    mailbox.fetch(TOPIC0).then(r => { result = r; });
    await vi.advanceTimersByTimeAsync(0);
    for (const g of pm.sentOfType(WireType.DHT_GET)) {
      dispatcher.dispatch(g.to, WireType.DHT_RES, { topicHash: TOPIC0, reqId: g.payload.reqId, entries: [a, b] });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(result).not.toBeNull();
    expect(result!).toHaveLength(2);
    expect((mailbox as any).pendingRequests.size).toBe(0);
  });

  it('最初の応答から猶予 (300ms) の間に来た応答も拾い、それ以降に来たものは無視する', async () => {
    vi.useFakeTimers();
    const { mailbox, pm, dispatcher } = sevenPeers();
    let result: Uint8Array[] | null = null;
    mailbox.fetch(TOPIC0).then(r => { result = r; });
    await vi.advanceTimersByTimeAsync(0);
    const gets = pm.sentOfType(WireType.DHT_GET);
    const reply = (i: number, e: Uint8Array) =>
      dispatcher.dispatch(gets[i].to, WireType.DHT_RES, { topicHash: TOPIC0, reqId: gets[i].payload.reqId, entries: [e] });

    reply(0, packetBytes(makePacket([1])));
    await vi.advanceTimersByTimeAsync(200);
    reply(1, packetBytes(makePacket([2])));
    await vi.advanceTimersByTimeAsync(99);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(result!).toHaveLength(2);

    expect(() => reply(2, packetBytes(makePacket([3])))).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(result!).toHaveLength(2);
    expect((mailbox as any).pendingRequests.size).toBe(0);
  });

  it('誰も応答しなければ 4 秒で手元のものだけを返す', async () => {
    vi.useFakeTimers();
    const { mailbox, store } = sevenPeers();
    await store.put(TOPIC0, [packetBytes()]);
    let result: Uint8Array[] | null = null;
    mailbox.fetch(TOPIC0).then(r => { result = r; });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(result!).toHaveLength(1);
    expect((mailbox as any).pendingRequests.size).toBe(0);
  });

  it('★問い合わせた相手以外からの応答 (割り込み) は受け取らない', async () => {
    vi.useFakeTimers();
    const { mailbox, pm, dispatcher } = sevenPeers();
    let result: Uint8Array[] | null = null;
    mailbox.fetch(TOPIC0).then(r => { result = r; });
    await vi.advanceTimersByTimeAsync(0);
    const g = pm.sentOfType(WireType.DHT_GET)[0];
    dispatcher.dispatch(pid(7), WireType.DHT_RES, { topicHash: TOPIC0, reqId: g.payload.reqId, entries: [packetBytes()] });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(result).toEqual([]);
  });

  it('★topicHash が問い合わせと違う応答は受け取らない', async () => {
    vi.useFakeTimers();
    const { mailbox, pm, dispatcher } = sevenPeers();
    let result: Uint8Array[] | null = null;
    mailbox.fetch(TOPIC0).then(r => { result = r; });
    await vi.advanceTimersByTimeAsync(0);
    const g = pm.sentOfType(WireType.DHT_GET)[0];
    dispatcher.dispatch(g.to, WireType.DHT_RES, { topicHash: topicAt(5), reqId: g.payload.reqId, entries: [packetBytes()] });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(result).toEqual([]);
  });

  it('★応答中の改竄エントリは捨て、正当なものだけを返す', async () => {
    vi.useFakeTimers();
    const { mailbox, pm, dispatcher } = sevenPeers();
    let result: Uint8Array[] | null = null;
    mailbox.fetch(TOPIC0).then(r => { result = r; });
    await vi.advanceTimersByTimeAsync(0);
    const good = packetBytes(makePacket([1]));
    const p = makePacket([2]);
    const forged = packetBytes({ ...p, payload: Uint8Array.from([9]) });
    for (const g of pm.sentOfType(WireType.DHT_GET)) {
      dispatcher.dispatch(g.to, WireType.DHT_RES, { topicHash: TOPIC0, reqId: g.payload.reqId, entries: [forged, good, 'x'] });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(result!.map(e => Array.from(e))).toEqual([Array.from(good)]);
  });

  it('★知らない reqId・壊れた応答で例外を投げない', async () => {
    const { dispatcher } = sevenPeers();
    for (const msg of [null, {}, { reqId: 5 }, { reqId: 'unknown', topicHash: TOPIC0, entries: [packetBytes()] }]) {
      expect(() => dispatcher.dispatch(pid(1), WireType.DHT_RES, msg)).not.toThrow();
    }
    await flush();
  });

  it('同じ reqId への 2 回目の応答は無視する', async () => {
    vi.useFakeTimers();
    const { mailbox, pm, dispatcher } = sevenPeers();
    let result: Uint8Array[] | null = null;
    mailbox.fetch(TOPIC0).then(r => { result = r; });
    await vi.advanceTimersByTimeAsync(0);
    const g = pm.sentOfType(WireType.DHT_GET)[0];
    dispatcher.dispatch(g.to, WireType.DHT_RES, { topicHash: TOPIC0, reqId: g.payload.reqId, entries: [packetBytes(makePacket([1]))] });
    dispatcher.dispatch(g.to, WireType.DHT_RES, { topicHash: TOPIC0, reqId: g.payload.reqId, entries: [packetBytes(makePacket([2]))] });
    await vi.advanceTimersByTimeAsync(300);
    expect(result!).toHaveLength(1);
  });

  it('★担当範囲のトピックなら、検証済みの応答をローカルにも保管して onSlotStored を呼ぶ', async () => {
    vi.useFakeTimers();
    const { mailbox, pm, dispatcher, store, slotEvents } = sevenPeers();
    const s = makeSlot(K);
    const topic = TOPIC0;
    mailbox.fetch(topic);
    await vi.advanceTimersByTimeAsync(0);
    const g = pm.sentOfType(WireType.DHT_GET)[0];
    dispatcher.dispatch(g.to, WireType.DHT_RES, { topicHash: topic, reqId: g.payload.reqId, entries: [s.entry] });
    await vi.advanceTimersByTimeAsync(0);
    expect((await store.get(topic))!).toHaveLength(1);
    expect(slotEvents).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
  });

  it('担当範囲外のトピックの応答は返すだけで、ローカルには保管しない', async () => {
    vi.useFakeTimers();
    const ctx = setup({ myPos: 0.5 });
    for (let i = 1; i <= 8; i++) ctx.pm.addPeer(pid(i), i * 0.01);
    let result: Uint8Array[] | null = null;
    ctx.mailbox.fetch(TOPIC0).then(r => { result = r; });
    await vi.advanceTimersByTimeAsync(0);
    const g = ctx.pm.sentOfType(WireType.DHT_GET)[0];
    ctx.dispatcher.dispatch(g.to, WireType.DHT_RES, { topicHash: TOPIC0, reqId: g.payload.reqId, entries: [packetBytes()] });
    await vi.advanceTimersByTimeAsync(300);
    expect(result!).toHaveLength(1);
    expect(ctx.store.data.size).toBe(0);
    expect(ctx.slotEvents).toHaveLength(0);
  });
});

describe('DHTMailbox: 出口としての Slot 保管 (storeSlotAsExit)', () => {
  it('★正当な Slot は K-nearest の他人へ PUT し、自分が圏内なら自分にも保管する', async () => {
    const { mailbox, pm, store } = setup({ myPos: 0.001 });
    for (let i = 1; i <= 7; i++) pm.addPeer(pid(i), i * 0.05);
    const s = makeSlot(K);
    const topic = TOPIC0;
    await mailbox.storeSlotAsExit(topic, encodeHint(s.hint), s.packet);
    const puts = pm.sentOfType(WireType.DHT_PUT);
    expect(puts.map(m => m.to)).toEqual([pid(1), pid(2), pid(3), pid(4)]);
    for (const m of puts) {
      expect(m.payload.topicHash).toBe(topic);
      expect(m.payload.entries).toHaveLength(1);
      expect(decodeSlotBlob(m.payload.entries[0])).not.toBeNull();
    }
    expect((await store.get(topic))!).toHaveLength(1);
  });

  it('自分が K-nearest 外なら自分には保管しない', async () => {
    const { mailbox, pm, store } = setup({ myPos: 0.5 });
    for (let i = 1; i <= 7; i++) pm.addPeer(pid(i), i * 0.05);
    const s = makeSlot(K);
    await mailbox.storeSlotAsExit(TOPIC0, encodeHint(s.hint), s.packet);
    expect(pm.sentOfType(WireType.DHT_PUT)).toHaveLength(5);
    expect(store.data.size).toBe(0);
  });

  it('★出口自身の保管は送り主の受け入れ枠を消費しない', async () => {
    const { mailbox, store } = setup();
    const s = makeSlot(K);
    await mailbox.storeSlotAsExit(TOPIC0, encodeHint(s.hint), s.packet);
    expect(store.data.size).toBe(1);
    expect((mailbox as any).peerQuota.size).toBe(0);
  });

  it('★不正な入力 (topicHash / 索引 / 索引の PoW / パケット) なら何も送らず何も保管しない', async () => {
    const { mailbox, pm, store } = setup({ myPos: 0.001 });
    pm.addPeer(pid(1), 0.01);
    const s = makeSlot(K);
    const p = makePacket([4]);
    await mailbox.storeSlotAsExit('bad', encodeHint(s.hint), s.packet);
    await mailbox.storeSlotAsExit(TOPIC0, new Uint8Array(10), s.packet);
    await mailbox.storeSlotAsExit(TOPIC0, sodium.randombytes_buf(94), s.packet);
    await mailbox.storeSlotAsExit(TOPIC0, encodeHint(failingPow(s.hint)), s.packet);
    await mailbox.storeSlotAsExit(TOPIC0, encodeHint(s.hint), { ...p, payload: Uint8Array.from([5]) });
    await mailbox.storeSlotAsExit(TOPIC0, encodeHint(s.hint), { ...p, pow_difficulty: 0 } as any);
    await mailbox.storeSlotAsExit(TOPIC0, encodeHint(s.hint), null as any);
    expect(pm.sent).toHaveLength(0);
    expect(store.data.size).toBe(0);
  });

  it('出口セル経由 (exit_fluff) でも同じく保管される。slot の無いセルは無視する', async () => {
    const { circuit, store } = setup();
    const s = makeSlot(K);
    circuit.fireExit('exit_fluff', { type: 'exit_fluff', packet: s.packet });
    circuit.fireExit('exit_fluff', { type: 'exit_hint', slot: { topicHash: TOPIC0, hint: encodeHint(s.hint) }, packet: s.packet });
    await flush();
    expect(store.data.size).toBe(0);
    circuit.fireExit('exit_fluff', { type: 'exit_fluff', slot: { topicHash: TOPIC0, hint: encodeHint(s.hint) }, packet: s.packet });
    await flush();
    expect(store.data.has(TOPIC0)).toBe(true);
  });

  it('★ストアがロックされた後に届いた出口セルで未処理の reject を出さない', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { circuit, store } = setup();
      store.locked = true;
      const s = makeSlot(K);
      circuit.fireExit('exit_fluff', { type: 'exit_fluff', slot: { topicHash: TOPIC0, hint: encodeHint(s.hint) }, packet: s.packet });
      await flush(10);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('DHTMailbox: 保守タイマー', () => {
  it('startMaintenance は即時に 1 回、以後 1 時間ごとに掃除し、stopMaintenance で止まる', async () => {
    vi.useFakeTimers();
    const { mailbox } = setup();
    const spy = vi.spyOn(mailbox, 'pruneExpired');
    mailbox.startMaintenance();
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(spy).toHaveBeenCalledTimes(2);
    mailbox.startMaintenance(); // 二重起動でもタイマーは 1 本
    expect(spy).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(spy).toHaveBeenCalledTimes(4);
    mailbox.stopMaintenance();
    await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('ロック中の掃除は何もせず例外も投げない', async () => {
    const { mailbox, store } = setup();
    store.locked = true;
    await expect(mailbox.pruneExpired()).resolves.toBeUndefined();
  });
});

describe('DHTMailbox: ロックされた本物のストア (IndexedDBStore)', () => {
  async function lockedReal() {
    const store = new IndexedDBStore(`dhtmb_${Date.now()}_${Math.random()}`);
    await store.init();
    await store.unlock('test-passphrase', VAULT_PARAMS_FAST);
    const e = packetBytes();
    await store.put(TOPIC0, [e]);
    store.lock();
    return { store, e };
  }

  it('★ロック後は PUT / GET / fetch / stored が例外を投げずに空振りする', async () => {
    const { store } = await lockedReal();
    const { dispatcher, pm, mailbox, slotEvents } = setup({ store });
    dispatcher.dispatch(pid(1), WireType.DHT_PUT, { topicHash: topicAt(7), entries: [packetBytes()] });
    dispatcher.dispatch(pid(1), WireType.DHT_GET, { topicHash: TOPIC0, reqId: 'r' });
    await flush(10);
    expect(pm.sent).toHaveLength(0); // GET に応答しない (中身を漏らさない)
    expect(slotEvents).toHaveLength(0);
    expect(await mailbox.fetch(TOPIC0)).toEqual([]);
    expect(await mailbox.stored(TOPIC0)).toEqual([]);
    expect(await mailbox.storedKeys()).toEqual([]);
    await expect(mailbox.pruneExpired()).resolves.toBeUndefined();
  });

  it('アンロック中は保管したものを stored / storedKeys で読める', async () => {
    const store = new IndexedDBStore(`dhtmb_${Date.now()}_${Math.random()}`);
    await store.init();
    await store.unlock('test-passphrase', VAULT_PARAMS_FAST);
    const { put, mailbox } = setup({ store });
    const s = makeSlot(K);
    await put(pid(1), { topicHash: s.keyHex, entries: [s.entry] });
    await flush(10);
    expect(await mailbox.storedKeys()).toEqual([s.keyHex]);
    const got = await mailbox.stored(s.keyHex);
    expect(got).toHaveLength(1);
    expect(Array.from(got[0])).toEqual(Array.from(s.entry));
    expect(await mailbox.stored('invalid')).toEqual([]);
    store.lock();
  });
});
