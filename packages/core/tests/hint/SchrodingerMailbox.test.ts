import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { Encoding } from '../../src/common/Encoding';
import { KeyManager } from '../../src/crypto/KeyManager';
import { MessageDispatcher } from '../../src/network/MessageDispatcher';
import { WireType } from '../../src/network/wire/WireTypes';
import { DHTMailbox } from '../../src/network/mailbox/DHTMailbox';
import { HintRouter } from '../../src/network/hint/HintRouter';
import { SeenCache } from '../../src/network/gossip/SeenCache';
import {
  BACKLOG_LIMIT,
  REFLOOD_PERIOD_MS,
  REFLOOD_TICK_MS,
  SchrodingerMailbox,
} from '../../src/network/hint/SchrodingerMailbox';
import { mailboxKeyFromNonce, openHint } from '../../src/network/hint/HintCrypto';
import { decodeHint, hintId } from '../../src/network/hint/HintPacket';
import { decodeSlotBlob, encodeSlotBlob } from '../../src/network/hint/SlotBlob';
import type { ReleaseMode } from '../../src/network/hint/HintRelease';
import { makePacket } from '../helpers/onionNet';
import {
  FakeCircuit,
  FakeDandelion,
  FakePeerManager,
  MemoryMailboxStore,
  flush,
  makeSlot,
  packetBytes,
} from '../helpers/hintMailboxFakes';

const ME = 'me'.padEnd(32, '0');
const A = 'aa'.padEnd(32, '1');
const B = 'bb'.padEnd(32, '2');
const UNVERIFIED = 'uv'.padEnd(32, '4');

let K: Uint8Array;
let OTHER: Uint8Array;
const cleanups: Array<() => void> = [];

function setup(opts: { peers?: string[]; mode?: ReleaseMode; withPm?: boolean } = {}) {
  const pm = new FakePeerManager(ME, 0);
  (opts.peers ?? []).forEach((id, i) => pm.addPeer(id, 0.1 + i * 0.1));
  const dispatcher = new MessageDispatcher();
  const store = new MemoryMailboxStore();
  const circuit = new FakeCircuit();
  const dandelion = new FakeDandelion();
  const mailbox = new DHTMailbox(pm as any, dispatcher, store as any, circuit as any);
  const router = new HintRouter(pm as any, dispatcher, dandelion as any, circuit as any);
  const sm = new SchrodingerMailbox(mailbox, router, opts.withPm === false ? undefined : (pm as any), opts.mode ?? 'disabled');
  const bodies: Array<{ body: Uint8Array; keyId: string }> = [];
  sm.onBody((body, hint) => bodies.push({ body, keyId: hint.keyId }));
  cleanups.push(() => {
    sm.destroy();
    router.destroy();
    mailbox.stopMaintenance();
  });
  return { pm, dispatcher, store, circuit, dandelion, mailbox, router, sm, bodies };
}

/** isDueNow と同じ式で、この Slot の再放流時刻を求める */
function dueAtFor(keyHex: string, around: number): number {
  const offset = Number.parseInt(keyHex.substring(0, 8), 16) % REFLOOD_PERIOD_MS;
  return Math.floor((around - offset) / REFLOOD_PERIOD_MS) * REFLOOD_PERIOD_MS + offset;
}

beforeAll(async () => {
  await sodiumReady;
  K = new Uint8Array(32).fill(0x61);
  OTHER = new Uint8Array(32).fill(0x62);
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.useRealTimers();
});

describe('SchrodingerMailbox: Slot の用意 (prepareSlot)', () => {
  it('★mailbox_key は Hint の中の nonce からしか導けない', () => {
    const { sm } = setup();
    const slot = sm.prepareSlot(K, 12);
    const opened = openHint(K, slot.hint)!;
    expect(opened.message_id).toBe(12);
    expect(Encoding.toHex(mailboxKeyFromNonce(opened.nonce))).toBe(slot.keyHex);
    expect(slot.keyHex).toMatch(/^[0-9a-f]{64}$/);
    // 鍵を持たない者には開けない
    expect(openHint(OTHER, slot.hint)).toBeNull();
  });

  it('★同じ鍵・同じ message_id でも毎回別の Slot・別の Hint になる (投稿同士を紐づけられない)', () => {
    const { sm } = setup();
    const a = sm.prepareSlot(K, 1);
    const b = sm.prepareSlot(K, 1);
    expect(a.keyHex).not.toBe(b.keyHex);
    expect(hintId(a.hint)).not.toBe(hintId(b.hint));
    expect(Encoding.toHex(a.hint.blind_tag)).not.toBe(Encoding.toHex(b.hint.blind_tag));
  });

  it('★Slot は板/スレッドの鍵からの固定座標ではない', () => {
    const { sm } = setup();
    const slot = sm.prepareSlot(K, 1);
    expect(slot.keyHex).not.toBe(Encoding.toHex(sodium.crypto_hash_sha256(K)));
    expect(slot.keyHex).not.toBe(Encoding.toHex(KeyManager.deriveTopicHash(K)));
  });

  it('出口に渡す exitSlot は Slot の鍵と索引だけを持つ (本体も作者情報も含まない)', () => {
    const { sm } = setup();
    const slot = sm.prepareSlot(K, 3);
    expect(Object.keys(slot.exitSlot).sort()).toEqual(['hint', 'topicHash']);
    expect(slot.exitSlot.topicHash).toBe(slot.keyHex);
    expect(hintId(decodeHint(slot.exitSlot.hint)!)).toBe(hintId(slot.hint));
  });

  it('Hint の時刻は分単位に丸められる', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-02T03:04:56.789Z'));
    const { sm } = setup();
    const opened = openHint(K, sm.prepareSlot(K, 1).hint)!;
    expect(opened.timestamp).toBe(Date.parse('2026-01-02T03:04:00.000Z'));
  });

  it('prepareSlot は何も送らない (PUT も Hint も出口任せ)', () => {
    const { sm, pm, circuit } = setup({ peers: [A, B] });
    sm.prepareSlot(K, 1);
    expect(pm.sent).toHaveLength(0);
    expect(circuit.sends).toHaveLength(0);
  });
});

describe('SchrodingerMailbox: 出口保管から本体取得まで', () => {
  it('★出口が作者の代わりに保管した Slot を、Hint を開いた受信者が手元から読める', async () => {
    const { sm, circuit, store } = setup();
    const slot = sm.prepareSlot(K, 1);
    const packet = makePacket([9, 9, 9]);
    circuit.fireExit('exit_fluff', { type: 'exit_fluff', slot: slot.exitSlot, packet });
    await flush();

    const stored = await store.get(slot.keyHex);
    expect(stored).toHaveLength(1);
    // 保管物は索引と本体の組。保持者には Hint は開けない (鍵が無い)
    const blob = decodeSlotBlob(stored![0])!;
    expect(hintId(blob.hint)).toBe(hintId(slot.hint));
    expect(openHint(OTHER, blob.hint)).toBeNull();

    const body = await sm.fetchBody(openHint(K, slot.hint)!);
    expect(new TextDecoder().decode(body!)).toBe(new TextDecoder().decode(packetBytes(packet)));
  });

  it('★Slot を PUT で受け取って保管したら、鍵があればその場で開いて本体を通知する (GET を出さない)', async () => {
    const { sm, dispatcher, bodies, pm } = setup({ peers: [A, B] });
    sm.addKey('thread:x', K);
    const s = makeSlot(K);
    dispatcher.dispatch(A, WireType.DHT_PUT, { topicHash: s.keyHex, entries: [s.entry] });
    await flush();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].keyId).toBe('thread:x');
    expect(Array.from(bodies[0].body)).toEqual(Array.from(s.body));
    expect(pm.sentOfType(WireType.DHT_GET)).toHaveLength(0);
  });

  it('鍵が無ければ保管しても通知しない。後から鍵を足すと開き直して本体を通知する', async () => {
    const { sm, dispatcher, bodies } = setup({ peers: [A] });
    const s = makeSlot(K);
    dispatcher.dispatch(A, WireType.DHT_PUT, { topicHash: s.keyHex, entries: [s.entry] });
    await flush();
    expect(bodies).toHaveLength(0);
    sm.addKey('late', K);
    await flush();
    expect(bodies).toHaveLength(1);
  });

  it('removeKey 後に届いた Slot は開かない', async () => {
    const { sm, dispatcher, bodies } = setup({ peers: [A] });
    sm.addKey('k', K);
    sm.removeKey('k');
    const s = makeSlot(K);
    dispatcher.dispatch(A, WireType.DHT_PUT, { topicHash: s.keyHex, entries: [s.entry] });
    await flush();
    expect(bodies).toHaveLength(0);
  });

  it('Hint を開いたが手元に本体が無ければ K-nearest へ GET し、正しい応答から本体を得る', async () => {
    const { sm, dispatcher, pm, bodies } = setup({ peers: [A] });
    sm.addKey('k', K);
    const s = makeSlot(K);
    // Hint だけがネットワークから届く
    dispatcher.dispatch(A, WireType.HINT, s.hint);
    await flush(1);
    const gets = pm.sentOfType(WireType.DHT_GET);
    expect(gets).toHaveLength(1);
    expect(gets[0].to).toBe(A);
    expect(gets[0].payload.topicHash).toBe(s.keyHex);
    dispatcher.dispatch(A, WireType.DHT_RES, { topicHash: s.keyHex, reqId: gets[0].payload.reqId, entries: [s.entry] });
    await flush();
    expect(bodies).toHaveLength(1);
    expect(Array.from(bodies[0].body)).toEqual(Array.from(s.body));
  });

  it('GET の応答に Slot 形式のものが無ければ本体は null (素のパケットは本体として扱わない)', async () => {
    const { sm, dispatcher, pm } = setup({ peers: [A] });
    const s = makeSlot(K);
    const p = sm.fetchBody(s.payload);
    await flush(1);
    const get = pm.sentOfType(WireType.DHT_GET)[0];
    dispatcher.dispatch(A, WireType.DHT_RES, { topicHash: s.keyHex, reqId: get.payload.reqId, entries: [packetBytes()] });
    expect(await p).toBeNull();
  });

  it('隣人が居らず手元にも無ければ null', async () => {
    const { sm } = setup();
    expect(await sm.fetchBody(makeSlot(K).payload)).toBeNull();
  });

  it('★別の Slot に入っている偽の本体は返らない (Slot は内容アドレス指定)', async () => {
    const { sm, store } = setup();
    const real = makeSlot(K);
    const decoy = makeSlot(K);
    // 本物の Slot の鍵の下には何も無く、別の鍵の下に別の本体がある
    await store.put(decoy.keyHex, [decoy.entry]);
    expect(await sm.fetchBody(real.payload)).toBeNull();
    expect(Array.from((await sm.fetchBody(decoy.payload))!)).toEqual(Array.from(decoy.body));
  });

  it('★ストアがロックされていても fetchBody は例外を投げず null を返す', async () => {
    const { sm, store } = setup();
    const s = makeSlot(K);
    await store.put(s.keyHex, [s.entry]);
    store.locked = true;
    await expect(sm.fetchBody(s.payload)).resolves.toBeNull();
  });
});

describe('SchrodingerMailbox: 索引の放流 (releaseHint)', () => {
  it('disabled なら待たずにオニオン回路で放流し、結果をそのまま返す', async () => {
    const { sm, circuit, pm } = setup({ peers: [A], mode: 'disabled' });
    const slot = sm.prepareSlot(K, 1);
    const r = await sm.releaseHint(slot.hint, 10_000);
    expect(r.released).toBe(true);
    expect(r.release.delayMs).toBe(0);
    expect(circuit.sends).toHaveLength(1);
    expect(circuit.sends[0].echoId).toBe(hintId(slot.hint));
    expect(pm.sentOfType(WireType.HINT)).toHaveLength(0); // 直接 flood しない
  });

  it('回路で届かなければ released=false (平文に落ちない)', async () => {
    const { sm, circuit, pm } = setup({ peers: [A] });
    circuit.sendResult = false;
    const r = await sm.releaseHint(sm.prepareSlot(K, 1).hint, 10);
    expect(r.released).toBe(false);
    expect(pm.sentOfType(WireType.HINT)).toHaveLength(0);
  });

  it('★adaptive で網に Hint が流れていれば、計画した時間が経つまで放流しない', async () => {
    vi.useFakeTimers();
    const { sm, circuit } = setup({ mode: 'adaptive' });
    for (let i = 0; i < 300; i++) sm.release.noteHintSeen(); // 1 件/秒 → 8 秒
    const slot = sm.prepareSlot(K, 1);
    const p = sm.releaseHint(slot.hint, 4096);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(circuit.sends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(circuit.sends).toHaveLength(1);
    expect((await p).release.delayMs).toBe(8_000);
  });

  it('網を流れる Hint は (開けなくても) 放流タイミングの観測に数えられる', () => {
    const { dispatcher, sm } = setup({ peers: [A] });
    expect(sm.release.hintRate()).toBe(0);
    dispatcher.dispatch(A, WireType.HINT, makeSlot(OTHER).hint);
    expect(sm.release.hintRate()).toBeGreaterThan(0);
  });

  it('★[回帰] 同じ Hint の再送で観測レートが水増しされない (放流の遅延が不当に縮まない)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_700_000_000_000);
    const { dispatcher, sm } = setup({ peers: [A, B], mode: 'adaptive' });
    const h1 = makeSlot(OTHER).hint;
    const h2 = makeSlot(OTHER).hint;
    for (let i = 0; i < 300; i++) {
      dispatcher.dispatch(i % 2 ? A : B, WireType.HINT, h1);
      dispatcher.dispatch(i % 2 ? A : B, WireType.HINT, h2);
    }
    // 異なる Hint は 2 件だけ → 2 / 300 件/秒
    expect(sm.release.hintRate()).toBeCloseTo(2 / 300, 10);
    // 2 件ぶんの観測では匿名集合が作れないので adaptive は待たない (水増しされていれば 8 秒待つ)
    const plan = sm.release.plan(4096);
    expect(plan.delayMs).toBe(0);
    expect(plan.targetMet).toBe(false);
  });
});

describe('SchrodingerMailbox: 保持者による再放流 (§18.3-A)', () => {
  it('★再放流の周期は SeenCache の TTL より長い (短いと受け手の重複排除に畳まれる)', () => {
    expect(REFLOOD_PERIOD_MS).toBeGreaterThan(SeenCache.TTL_MS);
    expect(REFLOOD_TICK_MS).toBeLessThan(REFLOOD_PERIOD_MS);
  });

  it('★Slot ごとに決まった窓でだけ再放流する (窓の外では撒かない)', async () => {
    const { sm, store, pm } = setup({ peers: [A, B] });
    const s = makeSlot(K);
    await store.put(s.keyHex, [s.entry]);
    const due = dueAtFor(s.keyHex, 1_700_000_000_000);

    expect(await sm.refloodDue(due - 1)).toBe(0);
    expect(await sm.refloodDue(due + REFLOOD_TICK_MS)).toBe(0);
    expect(pm.sentOfType(WireType.HINT)).toHaveLength(0);

    expect(await sm.refloodDue(due)).toBe(1);
    const sent = pm.sentOfType(WireType.HINT);
    expect(sent.map(m => m.to).sort()).toEqual([A, B].sort());
    expect(hintId(sent[0].payload)).toBe(hintId(s.hint));
  });

  it('★同じ Slot を持つ別々の保持者は、同じ窓で再放流する (帯域が K 倍にならない)', async () => {
    const h1 = setup({ peers: [A] });
    const h2 = setup({ peers: [B] });
    const s = makeSlot(K);
    await h1.store.put(s.keyHex, [s.entry]);
    await h2.store.put(s.keyHex, [s.entry]);
    const due = dueAtFor(s.keyHex, 1_800_000_000_000);
    for (const t of [due - 30_000, due, due + 30_000, due + 59_999, due + 60_000]) {
      expect(await h1.sm.refloodDue(t)).toBe(await h2.sm.refloodDue(t));
    }
  });

  it('再放流は保管物の索引だけを撒く。Slot でないエントリは飛ばす', async () => {
    const { sm, store, pm } = setup({ peers: [A] });
    const s = makeSlot(K);
    await store.put(s.keyHex, [packetBytes(), s.entry]);
    expect(await sm.refloodDue(dueAtFor(s.keyHex, 1_700_000_000_000))).toBe(1);
    // 本体 (JSON パケット) は撒かない
    for (const m of pm.sent) expect(m.type).toBe(WireType.HINT);
  });

  it('★startReflood は 1 周期に 1 回だけ各 Slot を撒き、stopReflood で止まる', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { sm, store, router } = setup({ peers: [A] });
    const s = makeSlot(K);
    await store.put(s.keyHex, [s.entry]);
    const spy = vi.spyOn(router, 'reflood');

    sm.startReflood();
    await vi.advanceTimersByTimeAsync(REFLOOD_PERIOD_MS);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REFLOOD_PERIOD_MS);
    expect(spy).toHaveBeenCalledTimes(2);

    sm.stopReflood();
    await vi.advanceTimersByTimeAsync(REFLOOD_PERIOD_MS * 2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('startReflood を二重に呼んでもタイマーは 1 本', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { sm, store, router } = setup({ peers: [A] });
    const s = makeSlot(K);
    await store.put(s.keyHex, [s.entry]);
    const spy = vi.spyOn(router, 'reflood');
    sm.startReflood();
    sm.startReflood();
    await vi.advanceTimersByTimeAsync(REFLOOD_PERIOD_MS);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('★ストアがロックされていても再放流は 0 件で終わり、例外を投げない', async () => {
    const { sm, store } = setup({ peers: [A] });
    const s = makeSlot(K);
    await store.put(s.keyHex, [s.entry]);
    store.locked = true;
    await expect(sm.refloodDue(dueAtFor(s.keyHex, 1_700_000_000_000))).resolves.toBe(0);
  });
});

describe('SchrodingerMailbox: 新規接続へのバックログ', () => {
  it('★繋がった相手に、保管している Slot の索引を送る (本体は送らない)', async () => {
    const { pm, store } = setup({ peers: [A, B] });
    const slots = [makeSlot(K), makeSlot(OTHER), makeSlot(K)];
    for (const s of slots) await store.put(s.keyHex, [s.entry]);
    await store.put(makeSlot(K).keyHex, [packetBytes()]); // Slot でないものは飛ばす

    pm.emit('peer:connect', pm.peers.get(B));
    await flush();
    const sent = pm.sent.filter(m => m.to === B);
    expect(sent).toHaveLength(3);
    for (const m of sent) expect(m.type).toBe(WireType.HINT);
    expect(sent.map(m => hintId(m.payload)).sort()).toEqual(slots.map(s => hintId(s.hint)).sort());
    // 他の隣人には送らない
    expect(pm.sent.filter(m => m.to === A)).toHaveLength(0);
  });

  it('peerId 文字列だけのイベントでも送る。壊れたイベントは無視する', async () => {
    const { pm, store } = setup({ peers: [A] });
    const s = makeSlot(K);
    await store.put(s.keyHex, [s.entry]);
    pm.emit('peer:connect', A);
    pm.emit('peer:connect', undefined);
    pm.emit('peer:connect', {});
    await flush();
    expect(pm.sent.filter(m => m.to === A)).toHaveLength(1);
  });

  it('上限を超えては送らない', async () => {
    const { sm, pm, store } = setup({ peers: [A] });
    for (let i = 0; i < 5; i++) {
      const s = makeSlot(K);
      await store.put(s.keyHex, [s.entry]);
    }
    expect(await sm.sendBacklogTo(A, 2)).toBe(2);
    expect(pm.sentOfType(WireType.HINT)).toHaveLength(2);
    expect(BACKLOG_LIMIT).toBe(200);
  });

  it('未検証の相手には送らない', async () => {
    const { sm, pm, store } = setup({ peers: [A] });
    pm.addPeer(UNVERIFIED, 0.9, { verified: false });
    const s = makeSlot(K);
    await store.put(s.keyHex, [s.entry]);
    await sm.sendBacklogTo(UNVERIFIED);
    expect(pm.sent).toHaveLength(0);
  });

  it('★ストアがロックされていてもバックログは 0 件で終わる', async () => {
    const { sm, store } = setup({ peers: [A] });
    store.locked = true;
    await expect(sm.sendBacklogTo(A)).resolves.toBe(0);
  });

  it('peerManager を渡さなくても構築できる', () => {
    expect(() => setup({ withPm: false })).not.toThrow();
  });
});

describe('SchrodingerMailbox: 破棄', () => {
  it('destroy で接続イベントの購読・再放流タイマー・本体通知が外れる', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { sm, pm, store, dispatcher, bodies } = setup({ peers: [A] });
    sm.addKey('k', K);
    sm.startReflood();
    expect(pm.listenerCount('peer:connect')).toBe(1);
    sm.destroy();
    expect(pm.listenerCount('peer:connect')).toBe(0);
    expect((sm as any).refloodTimer).toBeNull();

    const s = makeSlot(K);
    await store.put('0'.repeat(64), [encodeSlotBlob(s.hint, s.body)]);
    vi.useRealTimers();
    dispatcher.dispatch(A, WireType.DHT_PUT, { topicHash: s.keyHex, entries: [s.entry] });
    await flush();
    expect(bodies).toHaveLength(0);
  });
});
