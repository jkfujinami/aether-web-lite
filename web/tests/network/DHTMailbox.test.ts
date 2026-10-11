import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import type { GossipPacket } from '@/lib/types';
import { DHTMailbox } from '@/lib/network/mailbox/DHTMailbox';
import { MAILBOX_LIMITS, checkEntry, isValidTopicHash, filterValidEntries } from '@/lib/network/mailbox/MailboxEntry';
import { MessageDispatcher } from '@/lib/network/MessageDispatcher';
import { WireType } from '@/lib/network/wire/WireTypes';
import { RingPosition } from '@/lib/network/RingPosition';
import { POW_POLICY, derivePacketId } from '@/lib/crypto/PowPolicy';
import { PacketBuilder } from '@/lib/crypto/PacketBuilder';
import { JsonBinary } from '@/lib/common/JsonBinary';
import { FakePeerManager, FakeStore } from '../helpers/fakes';
import { DandelionRouter } from '@/lib/network/gossip/DandelionRouter';
import {
  buildValidPacket,
  forgePacketWithoutPow,
  toMailboxEntry,
  testBoardKey,
} from '../helpers/packets';

const ME = 'aa'.repeat(16);

/** 指定したリング座標に対応する topicHash (64 hex) を作る */
function topicHashAt(position: number): string {
  const intVal = Math.min(0xfffffffe, Math.max(0, Math.round(position * 0xffffffff)));
  return intVal.toString(16).padStart(8, '0') + '0'.repeat(56);
}

function positionOf(topicHash: string): number {
  return (parseInt(topicHash.substring(0, 8), 16) || 0) / 0xffffffff;
}

let validPacket: GossipPacket;
let validEntry: Uint8Array;

beforeAll(async () => {
  await sodium.ready;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  validPacket = await buildValidPacket(testBoardKey());
  validEntry = toMailboxEntry(validPacket);
});

function setup(peerIds: string[] = []) {
  const pm = new FakePeerManager(ME);
  for (const id of peerIds) pm.addPeer(id, { verified: true, connected: true });
  const dispatcher = new MessageDispatcher();
  const store = new FakeStore();
  const dandelion = new DandelionRouter(pm as any);
  const mailbox = new DHTMailbox(pm, dispatcher, store as any, dandelion);
  return { pm, dispatcher, store, mailbox };
}

/** 私が K-nearest 圏内に入る topicHash (自分の座標のすぐ隣) */
function topicNearMe(): string {
  return topicHashAt(RingPosition.forPeer(ME));
}

describe('MailboxEntry: エントリ単位の検証', () => {
  it('正当なエントリを受理する', () => {
    expect(checkEntry(validEntry).ok).toBe(true);
  });

  it('★PoW を払っていないエントリを拒否する', () => {
    const entry = toMailboxEntry(forgePacketWithoutPow({ pow_difficulty: 0 }));
    expect(checkEntry(entry)).toMatchObject({ ok: false, reason: 'insufficient-pow' });
  });

  it('JSON として壊れているエントリを拒否する', () => {
    expect(checkEntry(new TextEncoder().encode('{not json'))).toMatchObject({ ok: false, reason: 'not-json' });
  });

  it('GossipPacket でないエントリを拒否する', () => {
    expect(checkEntry(new TextEncoder().encode('"just a string"'))).toMatchObject({ ok: false, reason: 'not-a-packet' });
  });

  it('巨大なエントリを拒否する', () => {
    const huge = new Uint8Array(MAILBOX_LIMITS.MAX_ENTRY_BYTES + 1);
    expect(checkEntry(huge)).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('空エントリを拒否する', () => {
    expect(checkEntry(new Uint8Array(0))).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('過去ログ (15分以上前) は受理する', () => {
    // DHT は保管庫なので古いのが正当。ここを弾くと過去ログ同期が壊れる。
    const now = validPacket.timestamp + 30 * 24 * 60 * 60 * 1000;
    expect(checkEntry(validEntry, now).ok).toBe(true);
  });

  it('未来日付のエントリは拒否する', () => {
    const now = validPacket.timestamp - POW_POLICY.MAX_TIME_DRIFT - 1000;
    expect(checkEntry(validEntry, now)).toMatchObject({ ok: false, reason: 'time-drift' });
  });

  it('topicHash の形式を検証する', () => {
    expect(isValidTopicHash('a'.repeat(64))).toBe(true);
    expect(isValidTopicHash('a'.repeat(128))).toBe(true);
    expect(isValidTopicHash('a'.repeat(63))).toBe(false);
    expect(isValidTopicHash('A'.repeat(64))).toBe(false); // 大文字は不可
    expect(isValidTopicHash('../../etc/passwd')).toBe(false);
    expect(isValidTopicHash(null)).toBe(false);
    expect(isValidTopicHash(123)).toBe(false);
  });
});

describe('filterValidEntries', () => {
  it('正当なものだけを通し、拒否理由を集計する', () => {
    const bad = toMailboxEntry(forgePacketWithoutPow({ pow_difficulty: 0 }));
    const { accepted, rejected } = filterValidEntries([validEntry, bad, new Uint8Array(0)]);
    expect(accepted).toHaveLength(1);
    expect(rejected.get('insufficient-pow')).toBe(1);
    expect(rejected.get('too-large')).toBe(1);
  });

  it('1 メッセージあたりの件数上限で切る', () => {
    const many = new Array(MAILBOX_LIMITS.MAX_ENTRIES_PER_MESSAGE + 50).fill(validEntry);
    const { accepted } = filterValidEntries(many);
    // 同一 packet_id は 1 件に畳まれるので 1 件だけ通る
    expect(accepted.length).toBe(1);
  });

  it('同一メッセージ内の重複を 1 件に畳む (水増しの防止)', () => {
    const { accepted } = filterValidEntries([validEntry, validEntry, validEntry]);
    expect(accepted).toHaveLength(1);
  });

  it('配列でない入力でも例外を投げない', () => {
    expect(filterValidEntries(null).accepted).toEqual([]);
    expect(filterValidEntries('nope').accepted).toEqual([]);
    expect(filterValidEntries({ length: 3 }).accepted).toEqual([]);
  });
});

describe('★S級#3: DHT PUT の無検証', () => {
  it('正当なエントリを保存する', async () => {
    const { dispatcher, store } = setup();
    const topic = topicNearMe();
    dispatcher.dispatch('peer1', WireType.DHT_PUT, { topicHash: topic, entries: [validEntry] });
    await vi.waitFor(() => expect(store.topics.get(topic)).toHaveLength(1));
  });

  it('★PoW を払っていない偽の過去ログを保存しない', async () => {
    // 旧実装: handlePut は届いたものを無検証で store.put していた。
    // 誰でも任意のスレッドの過去ログを捏造できた。
    const { dispatcher, store } = setup();
    const topic = topicNearMe();
    const forged = toMailboxEntry(forgePacketWithoutPow({ pow_difficulty: 0 }));

    dispatcher.dispatch('attacker', WireType.DHT_PUT, { topicHash: topic, entries: [forged] });
    await new Promise((r) => setTimeout(r, 20));
    expect(store.topics.get(topic) ?? []).toHaveLength(0);
  });

  it('★ゴミバイト列を保存しない (ディスク枯渇 DoS)', async () => {
    const { dispatcher, store } = setup();
    const topic = topicNearMe();
    const garbage = Array.from({ length: 50 }, () => new Uint8Array(1024).fill(0x41));

    dispatcher.dispatch('attacker', WireType.DHT_PUT, { topicHash: topic, entries: garbage });
    await new Promise((r) => setTimeout(r, 20));
    expect(store.topics.get(topic) ?? []).toHaveLength(0);
  });

  it('★K-nearest 圏外のトピックへの書き込みを拒否する (帰属検証)', async () => {
    // 攻撃者はリング上のどこにいる誰からでも、任意のトピックに書けてはいけない。
    // 自分より近いピアが十分にいる座標を選ぶ。
    const peerIds = Array.from({ length: 40 }, (_, i) =>
      sodium.to_hex(sodium.crypto_hash_sha256(new TextEncoder().encode(`peer-${i}`)).slice(0, 16)),
    );
    const { dispatcher, store, mailbox } = setup(peerIds);

    // 自分から最も遠い座標を狙う (そこには自分より近いピアが必ず 8 人以上いる)
    const myPos = RingPosition.forPeer(ME);
    const farPos = (myPos + 0.5) % 1;
    const topic = topicHashAt(farPos);

    // 前提の確認: 自分は担当ではない
    expect((mailbox as any).isResponsibleFor(topic)).toBe(false);

    dispatcher.dispatch('attacker', WireType.DHT_PUT, { topicHash: topic, entries: [validEntry] });
    await new Promise((r) => setTimeout(r, 20));
    expect(store.topics.get(topic) ?? []).toHaveLength(0);
  });

  it('担当範囲内のトピックなら受理する', async () => {
    const peerIds = Array.from({ length: 40 }, (_, i) =>
      sodium.to_hex(sodium.crypto_hash_sha256(new TextEncoder().encode(`peer-${i}`)).slice(0, 16)),
    );
    const { dispatcher, store, mailbox } = setup(peerIds);
    const topic = topicHashAt(RingPosition.forPeer(ME));

    expect((mailbox as any).isResponsibleFor(topic)).toBe(true);
    dispatcher.dispatch('peer1', WireType.DHT_PUT, { topicHash: topic, entries: [validEntry] });
    await vi.waitFor(() => expect(store.topics.get(topic)).toHaveLength(1));
  });

  it('不正な topicHash を拒否する (パストラバーサル的な入力を含む)', async () => {
    const { dispatcher, store } = setup();
    for (const bad of ['../../etc/passwd', '', 'zz'.repeat(32), 'a'.repeat(200)]) {
      dispatcher.dispatch('attacker', WireType.DHT_PUT, { topicHash: bad, entries: [validEntry] });
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(store.topics.size).toBe(0);
  });

  it('1 トピックあたりの保持上限を超えて書き込めない', async () => {
    const { dispatcher, store } = setup();
    const topic = topicNearMe();

    // 上限まで埋めておく
    const filler = Array.from({ length: MAILBOX_LIMITS.MAX_ENTRIES_PER_TOPIC }, (_, i) =>
      new TextEncoder().encode(`filler-${i}`),
    );
    await store.put(topic, filler);

    dispatcher.dispatch('peer1', WireType.DHT_PUT, { topicHash: topic, entries: [validEntry] });
    await new Promise((r) => setTimeout(r, 20));
    expect(store.topics.get(topic)).toHaveLength(MAILBOX_LIMITS.MAX_ENTRIES_PER_TOPIC);
  });

  it('トピック総数の上限を超えて新規トピックを作れない', async () => {
    const { dispatcher, store } = setup();
    for (let i = 0; i < MAILBOX_LIMITS.MAX_TOPICS; i++) {
      store.topics.set(`${i.toString(16).padStart(64, '0')}`, [new Uint8Array([1])]);
    }
    const topic = topicNearMe();
    dispatcher.dispatch('peer1', WireType.DHT_PUT, { topicHash: topic, entries: [validEntry] });
    await new Promise((r) => setTimeout(r, 20));
    expect(store.topics.has(topic)).toBe(false);
  });
});

describe('★S級#4: DHT RES の無検証', () => {
  it('★問い合わせていない相手からの応答を受け取らない', async () => {
    const { pm, dispatcher, mailbox } = setup(['bb'.repeat(16)]);
    const topic = topicHashAt(0.5);

    const fetchPromise = mailbox.fetch(topic);
    await new Promise((r) => setTimeout(r, 10));

    const sentGet = pm.messagesOfType(WireType.DHT_GET)[0];
    expect(sentGet).toBeTruthy();
    const reqId = sentGet.payload.reqId;

    // 別のピアが同じ reqId で割り込み応答する
    dispatcher.dispatch('cc'.repeat(16), WireType.DHT_RES, {
      topicHash: topic,
      reqId,
      entries: [validEntry],
    });

    // 正規の相手からは空応答
    dispatcher.dispatch(sentGet.to, WireType.DHT_RES, { topicHash: topic, reqId, entries: [] });

    const result = await fetchPromise;
    expect(result).toHaveLength(0);
  });

  it('★topicHash が食い違う応答を受け取らない', async () => {
    const { pm, dispatcher, mailbox } = setup(['bb'.repeat(16)]);
    const topic = topicHashAt(0.5);

    const fetchPromise = mailbox.fetch(topic);
    await new Promise((r) => setTimeout(r, 10));
    const sentGet = pm.messagesOfType(WireType.DHT_GET)[0];

    dispatcher.dispatch(sentGet.to, WireType.DHT_RES, {
      topicHash: topicHashAt(0.9),
      reqId: sentGet.payload.reqId,
      entries: [validEntry],
    });
    dispatcher.dispatch(sentGet.to, WireType.DHT_RES, {
      topicHash: topic,
      reqId: sentGet.payload.reqId,
      entries: [],
    });

    expect(await fetchPromise).toHaveLength(0);
  });

  it('★担当ノードが返した偽の過去ログを握り潰す', async () => {
    // 旧実装: handleRes は entries をそのまま resolve し、store.put でローカルにも
    // 焼き付けていた。K=5 のうち 1 台が悪意を持てば偽の過去ログが正史になった。
    const { pm, dispatcher, store, mailbox } = setup(['bb'.repeat(16)]);
    const topic = topicHashAt(0.5);

    const fetchPromise = mailbox.fetch(topic);
    await new Promise((r) => setTimeout(r, 10));
    const sentGet = pm.messagesOfType(WireType.DHT_GET)[0];

    const forged = toMailboxEntry(forgePacketWithoutPow({ pow_difficulty: 0 }));
    dispatcher.dispatch(sentGet.to, WireType.DHT_RES, {
      topicHash: topic,
      reqId: sentGet.payload.reqId,
      entries: [forged, validEntry],
    });

    const result = await fetchPromise;
    // 偽物は落ち、正当な 1 件だけが残る
    expect(result).toHaveLength(1);
    expect(store.topics.get(topic) ?? []).not.toContainEqual(forged);
  });

  it('★改竄した過去ログ (payload 書き換え) を握り潰す', async () => {
    const { pm, dispatcher, mailbox } = setup(['bb'.repeat(16)]);
    const topic = topicHashAt(0.5);

    const fetchPromise = mailbox.fetch(topic);
    await new Promise((r) => setTimeout(r, 10));
    const sentGet = pm.messagesOfType(WireType.DHT_GET)[0];

    const tampered = { ...validPacket, payload: Uint8Array.from(validPacket.payload) };
    tampered.payload[0] ^= 0xff;

    dispatcher.dispatch(sentGet.to, WireType.DHT_RES, {
      topicHash: topic,
      reqId: sentGet.payload.reqId,
      entries: [toMailboxEntry(tampered)],
    });

    expect(await fetchPromise).toHaveLength(0);
  });

  it('★packet_id までつじつまを合わせた改竄も PoW で落ちる', async () => {
    const { pm, dispatcher, mailbox } = setup(['bb'.repeat(16)]);
    const topic = topicHashAt(0.5);

    const fetchPromise = mailbox.fetch(topic);
    await new Promise((r) => setTimeout(r, 10));
    const sentGet = pm.messagesOfType(WireType.DHT_GET)[0];

    const payload = Uint8Array.from(validPacket.payload);
    payload[0] ^= 0xff;
    const header = { ...PacketBuilder.committedHeaderOf(validPacket), payload };
    const tampered = { ...validPacket, payload, packet_id: derivePacketId(header) };

    dispatcher.dispatch(sentGet.to, WireType.DHT_RES, {
      topicHash: topic,
      reqId: sentGet.payload.reqId,
      entries: [toMailboxEntry(tampered)],
    });

    expect(await fetchPromise).toHaveLength(0);
  });

  it('身に覚えのない reqId は無視する', async () => {
    const { dispatcher, store } = setup();
    dispatcher.dispatch('attacker', WireType.DHT_RES, {
      topicHash: topicNearMe(),
      reqId: 'never-requested',
      entries: [validEntry],
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(store.topics.size).toBe(0);
  });
});

describe('DHT GET', () => {
  it('不正な topicHash / reqId には応答しない', async () => {
    const { pm, dispatcher } = setup();
    dispatcher.dispatch('peer1', WireType.DHT_GET, { topicHash: 'bad', reqId: 'r1' });
    dispatcher.dispatch('peer1', WireType.DHT_GET, { topicHash: topicNearMe(), reqId: 123 });
    dispatcher.dispatch('peer1', WireType.DHT_GET, { topicHash: topicNearMe(), reqId: 'x'.repeat(100) });
    await new Promise((r) => setTimeout(r, 20));
    expect(pm.messagesOfType(WireType.DHT_RES)).toHaveLength(0);
  });

  it('応答件数に上限を掛ける', async () => {
    const { pm, dispatcher, store } = setup();
    const topic = topicNearMe();
    await store.put(topic, Array.from({ length: 300 }, (_, i) => new TextEncoder().encode(`e${i}`)));

    dispatcher.dispatch('peer1', WireType.DHT_GET, { topicHash: topic, reqId: 'r1' });
    await vi.waitFor(() => expect(pm.messagesOfType(WireType.DHT_RES)).toHaveLength(1));
    expect(pm.messagesOfType(WireType.DHT_RES)[0].payload.entries.length)
      .toBeLessThanOrEqual(MAILBOX_LIMITS.MAX_ENTRIES_PER_MESSAGE);
  });
});

describe('★fetch は最遅のピアを待たない (Phase 0.1)', () => {
  /** peerId を K-nearest に必ず入れるため、その座標上の topicHash を作る */
  const RESPONDER = 'cc'.repeat(16);
  const SILENT_A = 'dd'.repeat(16);
  const SILENT_B = 'ee'.repeat(16);

  it('★1 人でも応答すれば、残りの沈黙を 4 秒待たずに確定する', async () => {
    const { pm, dispatcher, mailbox } = setup([RESPONDER, SILENT_A, SILENT_B]);
    const topic = topicNearMe();

    const started = Date.now();
    const pending = mailbox.fetch(topic);

    // 送られた GET のうち、1 人分にだけ応答を返す
    await vi.waitFor(() => expect(pm.messagesOfType(WireType.DHT_GET).length).toBeGreaterThan(0));
    const req = pm.messagesOfType(WireType.DHT_GET)[0];
    dispatcher.dispatch(req.to, WireType.DHT_RES, {
      topicHash: topic,
      reqId: req.payload.reqId,
      entries: [validEntry],
    });

    const result = await pending;
    const elapsed = Date.now() - started;

    expect(result).toHaveLength(1);
    // 旧実装は全員の応答を待ち、4 秒のハードタイムアウトまで引きずられていた
    expect(elapsed, `4 秒のタイムアウトまで待ってしまっている (${elapsed}ms)`).toBeLessThan(2000);
  });

  it('誰も応答しなければハードタイムアウトで空を返す', async () => {
    const { mailbox } = setup([SILENT_A, SILENT_B]);
    const result = await mailbox.fetch(topicNearMe());
    expect(result).toEqual([]);
  }, 10_000);

  it('全員が応答した場合は猶予を待たずに即確定する', async () => {
    const { pm, dispatcher, mailbox } = setup([RESPONDER]);
    const topic = topicNearMe();

    const started = Date.now();
    const pending = mailbox.fetch(topic);

    await vi.waitFor(() => expect(pm.messagesOfType(WireType.DHT_GET).length).toBe(1));
    const req = pm.messagesOfType(WireType.DHT_GET)[0];
    dispatcher.dispatch(req.to, WireType.DHT_RES, {
      topicHash: topic,
      reqId: req.payload.reqId,
      entries: [validEntry],
    });

    await pending;
    // 唯一の相手が応答したので猶予 (300ms) すら待たない
    expect(Date.now() - started).toBeLessThan(250);
  });
});

describe('K-nearest は検証済みピアのみを使う', () => {
  it('未検証ピアは担当集合に入らない', () => {
    const pm = new FakePeerManager(ME);
    pm.addPeer('bb'.repeat(16), { verified: false });
    pm.addPeer('cc'.repeat(16), { verified: true });
    const mailbox = new DHTMailbox(pm, new MessageDispatcher(), new FakeStore() as any, new DandelionRouter(pm));

    const nearest: string[] = (mailbox as any).findKNearest(0.5, 10);
    expect(nearest).not.toContain('bb'.repeat(16));
    expect(nearest).toContain('cc'.repeat(16));
    expect(nearest).toContain(ME);
  });
});

describe('publish', () => {
  it('不正な topicHash では publish しない', async () => {
    const { mailbox } = setup();
    await expect(mailbox.publish('bad', new Uint8Array([1]))).rejects.toThrow(RangeError);
  });

  it('★publish は直接 PUT せず Stem に載せる (発信元を保管者に晒さない)', async () => {
    // ★ 直接 PUT すると保管者は「この IP が置いた」を確実に知る。
    //   Gossip と違い「中継しただけかも」という否認可能性が無く、
    //   保管者が板の参加者なら本体も復号できてしまう。
    const peerIds = Array.from({ length: 10 }, (_, i) =>
      sodium.to_hex(sodium.crypto_hash_sha256(new TextEncoder().encode(`p-${i}`)).slice(0, 16)),
    );
    const { pm, mailbox } = setup(peerIds);
    await mailbox.publish(topicHashAt(0.3), validEntry);

    expect(pm.messagesOfType(WireType.DHT_PUT), '直接 PUT している').toHaveLength(0);
    expect(pm.messagesOfType(WireType.DHT_PUT_STEM)).toHaveLength(1);
  });

  it('★Stem は 1 人にだけ送る (全体には撒かない)', async () => {
    const peerIds = Array.from({ length: 10 }, (_, i) =>
      sodium.to_hex(sodium.crypto_hash_sha256(new TextEncoder().encode(`q-${i}`)).slice(0, 16)),
    );
    const { pm, mailbox } = setup(peerIds);
    await mailbox.publish(topicHashAt(0.3), validEntry);
    const targets = new Set(pm.messagesOfType(WireType.DHT_PUT_STEM).map(m => m.to));
    expect(targets.size).toBe(1);
  });

  it('隣人が居なければ自分で置く (届かないより匿名性が下がる方がまし)', async () => {
    const { mailbox, store } = setup();
    const topic = topicNearMe();
    await mailbox.publish(topic, validEntry);
    expect((await store.get(topic))?.length).toBe(1);
  });
});

describe('★Stem で運ばれてきた PUT', () => {
  const PEERS10 = Array.from({ length: 10 }, (_, i) =>
    sodium.to_hex(sodium.crypto_hash_sha256(new TextEncoder().encode(`s-${i}`)).slice(0, 16)),
  );

  it('★最終ホップが発信元の代わりに K-nearest へ置く', () => {
    const { pm, dispatcher } = setup(PEERS10);
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.01); // 確実に Fluff (実行地点)
    try {
      dispatcher.dispatch(PEERS10[0], WireType.DHT_PUT_STEM, {
        topicHash: topicHashAt(0.3), entries: [validEntry],
      });
      const puts = pm.messagesOfType(WireType.DHT_PUT);
      expect(puts.length).toBeGreaterThan(0);
      expect(puts.length).toBeLessThanOrEqual(5);
    } finally {
      spy.mockRestore();
    }
  });

  it('★転送時はそのまま次の 1 人へ (書き換えない)', () => {
    const { pm, dispatcher } = setup(PEERS10);
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.99); // Fluff を外す
    try {
      const topic = topicHashAt(0.3);
      dispatcher.dispatch(PEERS10[0], WireType.DHT_PUT_STEM, {
        topicHash: topic, entries: [validEntry],
      });
      const fwd = pm.messagesOfType(WireType.DHT_PUT_STEM);
      expect(fwd).toHaveLength(1);
      expect(fwd[0].payload.topicHash).toBe(topic);
      expect(pm.messagesOfType(WireType.DHT_PUT), '転送中に置いてしまっている').toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('★送り主には転送し返さない', () => {
    const { pm, dispatcher } = setup(PEERS10);
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    try {
      dispatcher.dispatch(PEERS10[0], WireType.DHT_PUT_STEM, {
        topicHash: topicHashAt(0.3), entries: [validEntry],
      });
      const targets = pm.messagesOfType(WireType.DHT_PUT_STEM).map(m => m.to);
      expect(targets).not.toContain(PEERS10[0]);
    } finally {
      spy.mockRestore();
    }
  });

  it('★PoW を満たさないエントリは運ばない (増幅器にならない)', () => {
    const { pm, dispatcher } = setup(PEERS10);
    dispatcher.dispatch(PEERS10[0], WireType.DHT_PUT_STEM, {
      topicHash: topicHashAt(0.3),
      entries: [toMailboxEntry(forgePacketWithoutPow({ pow_difficulty: 0 }))],
    });
    expect(pm.sentMessages).toHaveLength(0);
  });

  it('壊れた PUT_STEM でも例外を投げない', () => {
    const { pm, dispatcher } = setup(PEERS10);
    for (const bad of [undefined, null, {}, { topicHash: 'bad' }, 'x', 42]) {
      expect(() => dispatcher.dispatch(PEERS10[0], WireType.DHT_PUT_STEM, bad)).not.toThrow();
    }
    expect(pm.sentMessages).toHaveLength(0);
  });
});
