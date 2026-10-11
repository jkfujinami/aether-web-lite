import { describe, it, expect, beforeAll, vi } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { MessageDispatcher } from '@/lib/network/MessageDispatcher';
import { WireType } from '@/lib/network/wire/WireTypes';
import { DHTMailbox } from '@/lib/network/mailbox/DHTMailbox';
import { DandelionRouter } from '@/lib/network/gossip/DandelionRouter';
import { SeenCache } from '@/lib/network/gossip/SeenCache';
import { HintRouter } from '@/lib/network/hint/HintRouter';
import {
  SchrodingerMailbox,
  REFLOOD_PERIOD_MS,
  REFLOOD_TICK_MS,
} from '@/lib/network/hint/SchrodingerMailbox';
import { buildHint, mailboxKeyFromNonce, newMailboxSlot } from '@/lib/network/hint/HintCrypto';
import { hintId } from '@/lib/network/hint/HintPacket';
import { decodeSlotBlob, encodeSlotBlob, extractHint } from '@/lib/network/hint/SlotBlob';
import { Encoding } from '@/lib/common/Encoding';
import { FakePeerManager, FakeStore } from '../helpers/fakes';
import { RingPosition } from '@/lib/network/RingPosition';
import { buildValidPacket, testBoardKey } from '../helpers/packets';
import { JsonBinary } from '@/lib/common/JsonBinary';

const ME = 'aa'.repeat(16);
let K: Uint8Array;

beforeAll(async () => {
  await sodium.ready;
  K = sodium.randombytes_buf(32);
});

function setup(peerIds: string[] = []) {
  const pm = new FakePeerManager(ME);
  for (const id of peerIds) pm.addPeer(id, { verified: true, connected: true });
  const dispatcher = new MessageDispatcher();
  const store = new FakeStore();
  const dandelion = new DandelionRouter(pm as any);
  const mailbox = new DHTMailbox(pm, dispatcher, store as any, dandelion);
  const hintRouter = new HintRouter(pm, dispatcher, new DandelionRouter(pm));
  const sm = new SchrodingerMailbox(mailbox, hintRouter);
  return { pm, dispatcher, store, mailbox, hintRouter, sm };
}

describe('SlotBlob: 本体と索引を同じ Slot に入れる', () => {
  it('往復する', () => {
    const hint = buildHint(K, { ...newMailboxSlot(), message_id: 1, timestamp: 1 });
    const body = new TextEncoder().encode('hello body');
    const decoded = decodeSlotBlob(encodeSlotBlob(hint, body));

    expect(decoded).not.toBeNull();
    expect(new TextDecoder().decode(decoded!.body)).toBe('hello body');
    expect(hintId(decoded!.hint)).toBe(hintId(hint));
  });

  it('★本体に触れずに索引だけ取り出せる (保持者は中身を読めないまま再放流できる)', () => {
    const hint = buildHint(K, { ...newMailboxSlot(), message_id: 1, timestamp: 1 });
    const blob = encodeSlotBlob(hint, new Uint8Array(128));
    const extracted = extractHint(blob);
    expect(extracted).not.toBeNull();
    expect(hintId(extracted!)).toBe(hintId(hint));
  });

  it('空の本体でも壊れない', () => {
    const hint = buildHint(K, { ...newMailboxSlot(), message_id: 1, timestamp: 1 });
    const decoded = decodeSlotBlob(encodeSlotBlob(hint, new Uint8Array(0)));
    expect(decoded!.body).toHaveLength(0);
  });

  it('壊れた入力を null で返す (例外を投げない)', () => {
    for (const bad of [new Uint8Array(0), new Uint8Array(3), new Uint8Array(200)]) {
      expect(() => decodeSlotBlob(bad)).not.toThrow();
      expect(decodeSlotBlob(bad)).toBeNull();
    }
  });
});

describe('★Schrödinger 化: mailbox_key が板から導出できない', () => {
  it('★同じ鍵・同じ本体でも毎回違う Slot に入る', async () => {
    const { sm, store } = setup();
    const body = new TextEncoder().encode('same body');
    await sm.publish(K, body, 1);
    await sm.publish(K, body, 2);

    const keys = await store.getAllTopicHashes();
    expect(keys.length, '同じ座標に積まれている = 固定鍵になっている').toBe(2);
  });

  it('★Slot 鍵は Hint の nonce からしか導けない', async () => {
    const { sm, store } = setup();
    const hint = await sm.publish(K, new TextEncoder().encode('body'), 1);

    // Hint を開いて初めて nonce が得られ、そこから鍵が決まる
    const { openHint } = await import('@/lib/network/hint/HintCrypto');
    const payload = openHint(K, hint)!;
    const keyHex = Encoding.toHex(mailboxKeyFromNonce(payload.nonce));

    expect(await store.getAllTopicHashes()).toContain(keyHex);
  });

  it('本体を保管して Hint 経由で取り戻せる', async () => {
    const { sm } = setup();
    const body = new TextEncoder().encode('the real body');
    const hint = await sm.publish(K, body, 7);

    const { openHint } = await import('@/lib/network/hint/HintCrypto');
    const payload = openHint(K, hint)!;
    const got = await sm.fetchBody(payload);

    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got!)).toBe('the real body');
  });

  it('存在しない Slot は null を返す', async () => {
    const { sm } = setup();
    const got = await sm.fetchBody({ ...newMailboxSlot(), message_id: 0, timestamp: 0 });
    expect(got).toBeNull();
  });
});

describe('★発信は Stem を通る', () => {
  it('★publish は HINT ではなく HINT_STEM を出す', async () => {
    const { sm, pm } = setup(['bb'.repeat(16), 'cc'.repeat(16)]);
    void sm.publish(K, new TextEncoder().encode('x'), 1);
    await vi.waitFor(() => expect(pm.messagesOfType(WireType.HINT_STEM).length).toBeGreaterThan(0));
    expect(pm.messagesOfType(WireType.HINT), '直接 flood している').toHaveLength(0);
  });
});

describe('★Hint 再放流 (§18.3-A)', () => {
  it('★再放流の周期は SeenCache の TTL より長い', () => {
    // 短いと受け手の重複排除に畳まれ、2 回目以降が 1 ホップも進まない。
    // それでは「後から参加した人が過去ログを発見できる」目的を果たせない。
    expect(REFLOOD_PERIOD_MS).toBeGreaterThan(SeenCache.TTL_MS);
  });

  it('★保管している Slot の索引を撒き直す', async () => {
    const { sm, pm, store } = setup(['bb'.repeat(16)]);
    // 自分が担当になる座標へ直接置く
    const { nonce, mailboxKey } = newMailboxSlot();
    const hint = buildHint(K, { nonce, message_id: 1, timestamp: Date.now() });
    const keyHex = Encoding.toHex(mailboxKey);
    await store.put(keyHex, [encodeSlotBlob(hint, new Uint8Array(16))]);

    pm.clearSent();
    // その Slot の窓に合わせて時刻を選ぶ
    const offset = Number.parseInt(keyHex.substring(0, 8), 16) % REFLOOD_PERIOD_MS;
    const now = REFLOOD_PERIOD_MS * 100 + offset;
    const sent = await sm.refloodDue(now);

    expect(sent).toBe(1);
    expect(pm.messagesOfType(WireType.HINT).length).toBeGreaterThan(0);
  });

  it('★再放流は Stem を通さない (保持者は発信元ではない)', async () => {
    const { sm, pm, store } = setup(['bb'.repeat(16)]);
    const { nonce, mailboxKey } = newMailboxSlot();
    const hint = buildHint(K, { nonce, message_id: 1, timestamp: Date.now() });
    const keyHex = Encoding.toHex(mailboxKey);
    await store.put(keyHex, [encodeSlotBlob(hint, new Uint8Array(16))]);

    pm.clearSent();
    const offset = Number.parseInt(keyHex.substring(0, 8), 16) % REFLOOD_PERIOD_MS;
    await sm.refloodDue(REFLOOD_PERIOD_MS * 100 + offset);

    expect(pm.messagesOfType(WireType.HINT_STEM)).toHaveLength(0);
    expect(pm.messagesOfType(WireType.HINT).length).toBeGreaterThan(0);
  });

  it('窓の外では撒かない', async () => {
    const { sm, store } = setup(['bb'.repeat(16)]);
    const { nonce, mailboxKey } = newMailboxSlot();
    const hint = buildHint(K, { nonce, message_id: 1, timestamp: Date.now() });
    const keyHex = Encoding.toHex(mailboxKey);
    await store.put(keyHex, [encodeSlotBlob(hint, new Uint8Array(16))]);

    const offset = Number.parseInt(keyHex.substring(0, 8), 16) % REFLOOD_PERIOD_MS;
    // 窓の直後をわざと外す
    const outside = REFLOOD_PERIOD_MS * 100 + offset + REFLOOD_TICK_MS * 5;
    expect(await sm.refloodDue(outside)).toBe(0);
  });

  it('★送出窓が mailbox_key から決定論的に決まる (K 人が同じ窓で撒く)', async () => {
    // 同じ鍵を持つ別ノードは、必ず同じ時刻に撒く = 受け手が畳める
    const a = setup(['bb'.repeat(16)]);
    const b = setup(['cc'.repeat(16)]);
    const { nonce, mailboxKey } = newMailboxSlot();
    const hint = buildHint(K, { nonce, message_id: 1, timestamp: Date.now() });
    const keyHex = Encoding.toHex(mailboxKey);
    await a.store.put(keyHex, [encodeSlotBlob(hint, new Uint8Array(8))]);
    await b.store.put(keyHex, [encodeSlotBlob(hint, new Uint8Array(8))]);

    const offset = Number.parseInt(keyHex.substring(0, 8), 16) % REFLOOD_PERIOD_MS;
    const now = REFLOOD_PERIOD_MS * 100 + offset;
    expect(await a.sm.refloodDue(now)).toBe(1);
    expect(await b.sm.refloodDue(now)).toBe(1);
  });

  it('壊れた保管データがあっても落ちない', async () => {
    const { sm, store } = setup(['bb'.repeat(16)]);
    const keyHex = Encoding.toHex(newMailboxSlot().mailboxKey);
    await store.put(keyHex, [new Uint8Array([1, 2, 3])]);
    const offset = Number.parseInt(keyHex.substring(0, 8), 16) % REFLOOD_PERIOD_MS;
    await expect(sm.refloodDue(REFLOOD_PERIOD_MS * 100 + offset)).resolves.toBe(0);
  });
});

describe('★保管した Slot は、その場で索引を開く', () => {
  it('★複製で届いた Slot が即座に本体として通知される', async () => {
    // ★ 実網で出た症状:
    //     [net.mailbox] stored 1 entries for 78188a9c (slot=true)
    //   と本体は保管されているのに、Hint が一度も開かれず画面に出なかった。
    //   Slot には索引が同梱されているので、鍵を持っているならその場で開ける。
    //   これが無いと、索引が別経路で届くまで (再放流なら最大 20 分) 見えない。
    const { sm, dispatcher, mailbox } = setup(['bb'.repeat(16)]);

    const bodies: Uint8Array[] = [];
    sm.onBody((b) => bodies.push(b));
    sm.addKey('vip', K);

    // 隣人からの複製として Slot が届く
    const packet = await buildValidPacket(testBoardKey(), { depth: 0 });
    const body = new TextEncoder().encode(JsonBinary.stringify(packet));
    const { nonce, mailboxKey } = newMailboxSlot();
    const hint = buildHint(K, { nonce, message_id: 1, timestamp: Date.now() });
    const keyHex = Encoding.toHex(mailboxKey);

    dispatcher.dispatch('bb'.repeat(16), WireType.DHT_PUT, {
      topicHash: keyHex,
      entries: [encodeSlotBlob(hint, body)],
    });

    await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    expect(new TextDecoder().decode(bodies[0])).toContain(packet.packet_id);
    void mailbox;
  });

  it('鍵を持たない Slot は開かない (中身は分からないまま保管する)', async () => {
    const { sm, dispatcher } = setup(['bb'.repeat(16)]);
    const bodies: Uint8Array[] = [];
    sm.onBody((b) => bodies.push(b));
    sm.addKey('vip', K);

    const other = sodium.randombytes_buf(32);
    const packet = await buildValidPacket(testBoardKey(), { depth: 0 });
    const body = new TextEncoder().encode(JsonBinary.stringify(packet));
    const { nonce, mailboxKey } = newMailboxSlot();
    const hint = buildHint(other, { nonce, message_id: 1, timestamp: Date.now() });

    dispatcher.dispatch('bb'.repeat(16), WireType.DHT_PUT, {
      topicHash: Encoding.toHex(mailboxKey),
      entries: [encodeSlotBlob(hint, body)],
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(bodies).toHaveLength(0);
  });

  it('★手元で取り込んだ索引は撒き直さない (二重配信を避ける)', async () => {
    const { sm, pm, dispatcher } = setup(['bb'.repeat(16)]);
    sm.addKey('vip', K);
    pm.clearSent();

    const packet = await buildValidPacket(testBoardKey(), { depth: 0 });
    const body = new TextEncoder().encode(JsonBinary.stringify(packet));
    const { nonce, mailboxKey } = newMailboxSlot();
    const hint = buildHint(K, { nonce, message_id: 1, timestamp: Date.now() });

    dispatcher.dispatch('bb'.repeat(16), WireType.DHT_PUT, {
      topicHash: Encoding.toHex(mailboxKey),
      entries: [encodeSlotBlob(hint, body)],
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(pm.messagesOfType(WireType.HINT), '取り込んだ索引を撒き直している').toHaveLength(0);
  });
});

describe('★時間分離が publish に効いている (§18.4.5)', () => {
  // 注: publish() 全体は Dandelion のエコー待ち (最大 10 秒) を含む。
  //     呼び出し側 (オーケストレータ) は fire-and-forget なので UI は待たない。
  //     ここで見たいのは「時間分離が何 ms 足したか」なので release を直接見る。

  it('★立ち上げ期は遅延を足さない', () => {
    // 観測レート 0 = 待っても匿名集合が生まれない。
    // ここで待たせると、最も離脱されやすい時期に利益ゼロのコストを払わせ、
    // 網が育つ経路そのものを塞ぐ。
    const { sm } = setup(['bb'.repeat(16)]);
    const st = sm.release.plan(4 * 1024 * 1024);
    expect(st.delayMs).toBe(0);
    expect(st.reason).toContain('unreachable');
  });

  it('★チャット規模は網が育っていても遅延しない', () => {
    const { sm } = setup(['bb'.repeat(16)]);
    for (let i = 0; i < 3000; i++) sm.release.noteHintSeen();
    sm.release.noteRelayBytes(125 * 1024 * 300);

    const st = sm.release.plan(10 * 1024);
    expect(st.delayMs).toBe(0);
    expect(st.reason).toContain('noise');
  });

  it('★網が育つと大きい送信には遅延が入る', () => {
    const { sm } = setup(['bb'.repeat(16)]);
    for (let i = 0; i < 3000; i++) sm.release.noteHintSeen();
    sm.release.noteRelayBytes(125 * 1024 * 300);

    expect(sm.release.plan(64 * 1024 * 1024).delayMs).toBeGreaterThan(0);
  });

  it('モードを disabled にすれば必ず即時', () => {
    const { sm } = setup(['bb'.repeat(16)]);
    sm.release.setMode('disabled');
    for (let i = 0; i < 3000; i++) sm.release.noteHintSeen();
    expect(sm.release.plan(4 * 1024 * 1024).delayMs).toBe(0);
  });

  it('★受信した Hint が観測レートに乗る (ローカルで直接測れる)', () => {
    // Broadcast Veil で全 Hint が自分に届くので、放流タイミングの逆算に
    // 必要な観測レートをローカルだけで測れる。他の設計では得られない性質。
    const { sm, dispatcher } = setup(['bb'.repeat(16)]);
    expect(sm.release.hintRate()).toBe(0);

    // 自分宛てでない Hint でもレートには乗る
    const other = sodium.randombytes_buf(32);
    dispatcher.dispatch('bb'.repeat(16), WireType.HINT, buildHint(other, {
      ...newMailboxSlot(), message_id: 1, timestamp: Date.now(),
    }));

    expect(sm.release.hintRate()).toBeGreaterThan(0);
  });

  it('★立ち上げ期の publish が時間分離で足踏みしない', async () => {
    // 実際に publish を通して、遅延ゼロで Hint 放流まで到達することを見る
    const { sm } = setup();  // 隣人なし = Stem できずエコー待ちも無い
    const started = Date.now();
    const { release } = await sm.publishWithStatus(K, new Uint8Array(4 * 1024 * 1024), 1);
    expect(release.delayMs).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
