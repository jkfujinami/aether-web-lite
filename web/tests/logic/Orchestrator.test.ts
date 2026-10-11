import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { BoardOrchestrator } from '@/lib/logic/BoardOrchestrator';
import { ThreadOrchestrator } from '@/lib/logic/ThreadOrchestrator';
import { ZoneGossipRouter } from '@/lib/network/gossip/ZoneGossipRouter';
import { DHTMailbox } from '@/lib/network/mailbox/DHTMailbox';
import { SyncProtocol } from '@/lib/network/mailbox/SyncProtocol';
import { MessageDispatcher } from '@/lib/network/MessageDispatcher';
import { CryptoEngine } from '@/lib/crypto/CryptoEngine';
import { Identity } from '@/lib/crypto/Identity';
import { KeyManager } from '@/lib/crypto/KeyManager';
import { PacketBuilder } from '@/lib/crypto/PacketBuilder';
import { WireType } from '@/lib/network/wire/WireTypes';
import { JsonBinary } from '@/lib/common/JsonBinary';
import type { ThreadMeta } from '@/lib/logic/types';
import type { DAGPost } from '@/lib/logic/ThreadDAGManager';
import { FakePeerManager, FakeZoneManager, FakeStore } from '../helpers/fakes';
import { syncPowEngine, keyMgr } from '../helpers/packets';
import { HintRouter } from '@/lib/network/hint/HintRouter';
import { DandelionRouter } from '@/lib/network/gossip/DandelionRouter';
import { SchrodingerMailbox } from '@/lib/network/hint/SchrodingerMailbox';
import { buildHint, newMailboxSlot } from '@/lib/network/hint/HintCrypto';
import { encodeSlotBlob } from '@/lib/network/hint/SlotBlob';
import { Encoding } from '@/lib/common/Encoding';

const ME = 'aa'.repeat(16);
const PEER = 'bb'.repeat(16);
const BOARD_ID = 'vip';
const BOARD_KEY = new Uint8Array(32).fill(42);

/** IndexedDBStore の最小代役 (orchestrator が使う分だけ) */
class FakeDb extends FakeStore {
  public posts: any[] = [];
  public threadStats = new Map<string, any>();

  async save(post: { boardId: string; threadId: string; payload: Uint8Array; dag?: any }) {
    this.posts.push({ ...post, timestamp: Date.now() });
    if (post.dag) {
      const key = post.dag.thread_root || post.threadId;
      const prev = this.threadStats.get(key);
      this.threadStats.set(key, {
        threadId: key,
        boardId: post.boardId,
        max_pow: Math.max(prev?.max_pow ?? 0, post.dag.cumulative_pow ?? 0),
        created_at: prev?.created_at ?? post.dag.created_at ?? Date.now(),
      });
    }
  }
  async getPosts(boardId: string, threadId: string) {
    return this.posts.filter((p) => p.boardId === boardId && p.threadId === threadId);
  }
  async getThreads(boardId: string) {
    return Array.from(this.threadStats.values()).filter((t) => t.boardId === boardId);
  }
  async getRecentTimestamps() {
    return this.posts.map((p) => p.timestamp);
  }
}

interface Node {
  pm: FakePeerManager;
  dispatcher: MessageDispatcher;
  router: ZoneGossipRouter;
  mailbox: DHTMailbox;
  db: FakeDb;
  board: BoardOrchestrator;
  thread: ThreadOrchestrator;
  hintRouter: HintRouter;
  schrodinger: SchrodingerMailbox;
}

function makeNode(peerId: string): Node {
  const pm = new FakePeerManager(peerId);
  const dispatcher = new MessageDispatcher();
  const zm = new FakeZoneManager();
  const router = new ZoneGossipRouter(pm, dispatcher, zm);
  const db = new FakeDb();
  const dandelion = new DandelionRouter(pm as any);
  const mailbox = new DHTMailbox(pm, dispatcher, db as any, dandelion);
  const cryptoEng = new CryptoEngine();
  const identity = new Identity();
  const sync = new SyncProtocol(mailbox, cryptoEng, keyMgr, db as any);

  const hintRouter = new HintRouter(pm as any, dispatcher, new DandelionRouter(pm as any));
  const schrodinger = new SchrodingerMailbox(mailbox, hintRouter, pm as any);

  const board = new BoardOrchestrator(
    pm as any, db as any, mailbox, router, cryptoEng, syncPowEngine, identity, zm, keyMgr, schrodinger,
  );
  const thread = new ThreadOrchestrator(
    pm as any, db as any, mailbox, router, cryptoEng, syncPowEngine, identity, zm, keyMgr, sync, schrodinger,
  );
  return { pm, dispatcher, router, mailbox, db, board, thread, hintRouter, schrodinger };
}

async function buildThreadMeta(threadId: string, title: string) {
  return PacketBuilder.build(
    title, BOARD_KEY, new Identity(), new CryptoEngine(),
    syncPowEngine, keyMgr, BOARD_ID, threadId,
    0, null, 8, 0, /* postType */ 1, [], threadId, 8,
  );
}

async function buildPost(threadId: string, content: string) {
  const threadKey = KeyManager.deriveThreadKey(BOARD_KEY, threadId);
  return PacketBuilder.build(
    content, threadKey, new Identity(), new CryptoEngine(),
    syncPowEngine, keyMgr, BOARD_ID, threadId,
    0, null, 8, 0, /* postType */ 0, [], threadId, 8,
  );
}

beforeAll(async () => {
  await sodium.ready;
  for (const m of ['log', 'warn', 'debug', 'error'] as const) {
    vi.spyOn(console, m).mockImplementation(() => {});
  }
});

describe('BoardOrchestrator: スレッド一覧が画面に反映される', () => {
  it('スレッドメタのパケットを処理すると購読者に通知される', async () => {
    const n = makeNode(ME);
    const seen: ThreadMeta[][] = [];
    n.board.subscribe(() => seen.push(n.board.getThreads()));

    const packet = await buildThreadMeta('t1', 'はじめてのスレ');
    await n.board.handlePacketObject(BOARD_ID, BOARD_KEY, packet, false);

    const last = seen[seen.length - 1];
    expect(last).toHaveLength(1);
    expect(last[0].thread_id).toBe('t1');
    expect(last[0].content).toBe('はじめてのスレ');
  });

  it('通知のたびに新しい配列参照を渡す (React が再描画できる)', async () => {
    const n = makeNode(ME);
    const seen: ThreadMeta[][] = [];
    n.board.subscribe(() => seen.push(n.board.getThreads()));

    await n.board.handlePacketObject(BOARD_ID, BOARD_KEY, await buildThreadMeta('t1', 'A'), false);
    await n.board.handlePacketObject(BOARD_ID, BOARD_KEY, await buildThreadMeta('t2', 'B'), false);

    // subscribe は即時に呼ばない (初期値は getSnapshot が返す)。通知は 2 件分。
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[seen.length - 1]).not.toBe(seen[seen.length - 2]);
    expect(seen[seen.length - 1]).toHaveLength(2);
  });

  it('post_type が 0 (通常投稿) のパケットは板一覧に出さない', async () => {
    const n = makeNode(ME);
    const seen: ThreadMeta[][] = [];
    n.board.subscribe(() => seen.push(n.board.getThreads()));

    // 板鍵で暗号化された post_type=0 のパケット
    const packet = await PacketBuilder.build(
      'reply', BOARD_KEY, new Identity(), new CryptoEngine(),
      syncPowEngine, keyMgr, BOARD_ID, 't1', 0, null, 8, 0, 0, [], 't1', 8,
    );
    await n.board.handlePacketObject(BOARD_ID, BOARD_KEY, packet, false);

    expect(n.board.getThreads()).toHaveLength(0);
  });

  it('同じパケットを二度渡しても重複しない', async () => {
    const n = makeNode(ME);
    const packet = await buildThreadMeta('t1', 'A');
    await n.board.handlePacketObject(BOARD_ID, BOARD_KEY, packet, false);
    await n.board.handlePacketObject(BOARD_ID, BOARD_KEY, packet, false);
    expect(n.board.getThreads()).toHaveLength(1);
  });
});

describe('★リアルタイム反映: ゴシップ受信 → 画面', () => {
  it('★隣人から届いたスレッドメタが即座に購読者へ届く', async () => {
    const n = makeNode(ME);
    n.pm.addPeer(PEER, { verified: true, connected: true });

    const seen: ThreadMeta[][] = [];
    await n.board.activate(BOARD_ID, BOARD_KEY);
    n.board.subscribe(() => seen.push(n.board.getThreads()));

    // 隣人からゴシップが到着する (PeerManager → dispatcher → ZoneGossipRouter)
    const packet = await buildThreadMeta('t-live', 'ライブ配信されたスレ');
    n.dispatcher.dispatch(PEER, WireType.GOSSIP, { packet });
    await new Promise((r) => setTimeout(r, 20));

    const last = seen[seen.length - 1];
    expect(last.map((t) => t.thread_id)).toContain('t-live');
  });

  it('★隣人から届いたレスが即座にスレッド画面へ届く', async () => {
    const n = makeNode(ME);
    n.pm.addPeer(PEER, { verified: true, connected: true });

    const seen: DAGPost[][] = [];
    await n.thread.activate(BOARD_ID, 't1', BOARD_KEY);
    n.thread.subscribe(() => seen.push(n.thread.getPosts()));

    const packet = await buildPost('t1', 'ライブ配信されたレス');
    n.dispatcher.dispatch(PEER, WireType.GOSSIP, { packet });
    await new Promise((r) => setTimeout(r, 20));

    const last = seen[seen.length - 1];
    expect(last.map((p) => p.content)).toContain('ライブ配信されたレス');
  });

  it('★自分の投稿は送信直後に自分の画面へ出る', async () => {
    const n = makeNode(ME);
    n.pm.addPeer(PEER, { verified: true, connected: true });

    const seen: ThreadMeta[][] = [];
    await n.board.activate(BOARD_ID, BOARD_KEY);
    n.board.subscribe(() => seen.push(n.board.getThreads()));

    const threadId = await n.board.submitThread(BOARD_ID, BOARD_KEY, '自分で立てたスレ');
    expect(threadId).toBeTruthy();

    const last = seen[seen.length - 1];
    expect(last.map((t) => t.thread_id)).toContain(threadId!);
  });

  it('★偽造パケットは画面に出ない', async () => {
    const n = makeNode(ME);
    n.pm.addPeer(PEER, { verified: true, connected: true });

    const seen: ThreadMeta[][] = [];
    await n.board.activate(BOARD_ID, BOARD_KEY);
    n.board.subscribe(() => seen.push(n.board.getThreads()));

    const packet = await buildThreadMeta('t-forged', 'にせもの');
    // PoW を無効化する (packet_id はそのままなので CHK でも落ちる)
    n.dispatcher.dispatch(PEER, WireType.GOSSIP, {
      packet: { ...packet, pow_difficulty: 0 },
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(n.board.getThreads().map((t) => t.thread_id)).not.toContain('t-forged');
  });

  it('clear() 後は購読が解除され、ゴシップが届かない', async () => {
    const n = makeNode(ME);
    n.pm.addPeer(PEER, { verified: true, connected: true });
    await n.board.activate(BOARD_ID, BOARD_KEY);
    n.board.clear();

    const seen: ThreadMeta[][] = [];
    n.board.subscribe(() => seen.push(n.board.getThreads()));

    n.dispatcher.dispatch(PEER, WireType.GOSSIP, { packet: await buildThreadMeta('t2', 'B') });
    await new Promise((r) => setTimeout(r, 20));

    expect(n.board.getThreads()).toHaveLength(0);
  });

  it('activate → clear → activate で購読が復活する (StrictMode の二重実行)', async () => {
    const n = makeNode(ME);
    n.pm.addPeer(PEER, { verified: true, connected: true });

    await n.board.activate(BOARD_ID, BOARD_KEY);
    n.board.clear();
    await n.board.activate(BOARD_ID, BOARD_KEY);

    const seen: ThreadMeta[][] = [];
    n.board.subscribe(() => seen.push(n.board.getThreads()));

    n.dispatcher.dispatch(PEER, WireType.GOSSIP, { packet: await buildThreadMeta('t3', 'C') });
    await new Promise((r) => setTimeout(r, 20));

    expect(seen[seen.length - 1].map((t) => t.thread_id)).toContain('t3');
  });
});

describe('★DHT 経由の過去ログが画面に反映される', () => {
  it('★Hint 経由で届いた過去のスレッドメタが一覧に出る', async () => {
    // ★ 旧実装は `mailbox.fetch(SHA512(boardKey))` で一括取得していた。
    //   その topicHash は板の鍵から誰でも計算できるため、GET を受けた K 人に
    //   「この IP はこの板を読んでいる」が直接漏れていた。
    //   現在は本体がランダムな Slot にあり、在り処は Hint でしか分からない。
    const n = makeNode(ME);
    n.pm.addPeer(PEER, { verified: true, connected: true });
    await n.board.activate(BOARD_ID, BOARD_KEY);

    const seen: ThreadMeta[][] = [];
    n.board.subscribe(() => seen.push(n.board.getThreads()));

    // 別ノードが Schrödinger 経由で公開した状態を作る
    const packet = await buildThreadMeta('t-past', '過去のスレ');
    const body = new TextEncoder().encode(JsonBinary.stringify(packet));
    const { nonce, mailboxKey } = newMailboxSlot();
    const hint = buildHint(BOARD_KEY, { nonce, message_id: 1, timestamp: Date.now() });
    // 本体は既に自分の Slot に保管されている状態を作る
    // (publish() は Stem を通るので、ここでは保管結果だけを直接用意する)
    await n.db.put(Encoding.toHex(mailboxKey), [encodeSlotBlob(hint, body)]);

    // その Hint が Gossip で届く
    n.dispatcher.dispatch(PEER, WireType.HINT, hint);
    await vi.waitFor(() => {
      const last = seen[seen.length - 1] ?? [];
      expect(last.map((t) => t.thread_id)).toContain('t-past');
    });
  });

  it('★板の鍵を登録する前に届いていた Hint も、開いた時点で反映される', async () => {
    // Broadcast Veil で Hint は常に流れてくるが、鍵を持つ前は開けない。
    // 後から板を開いたときに開き直せないと、その分の履歴が永久に失われる。
    const n = makeNode(ME);
    n.pm.addPeer(PEER, { verified: true, connected: true });

    const packet = await buildThreadMeta('t-early', '鍵を持つ前に流れたスレ');
    const body = new TextEncoder().encode(JsonBinary.stringify(packet));
    const { nonce, mailboxKey } = newMailboxSlot();
    const hint = buildHint(BOARD_KEY, { nonce, message_id: 1, timestamp: Date.now() });
    await n.db.put(Encoding.toHex(mailboxKey), [encodeSlotBlob(hint, body)]);

    // ★ まだ activate していない = 鍵を持っていない状態で Hint が流れる
    n.dispatcher.dispatch(PEER, WireType.HINT, hint);
    await new Promise((r) => setTimeout(r, 20));

    const seen: ThreadMeta[][] = [];
    n.board.subscribe(() => seen.push(n.board.getThreads()));
    await n.board.activate(BOARD_ID, BOARD_KEY);

    await vi.waitFor(() => {
      const last = seen[seen.length - 1] ?? [];
      expect(last.map((t) => t.thread_id)).toContain('t-early');
    });
  });

  it('★Hint 経由で届いた過去のレスがスレッド画面に出る', async () => {
    // 旧実装は SyncProtocol が `deriveTopicHash(threadKey)` へ GET していた。
    // その座標はスレッド鍵を持つ者なら誰でも計算できるため、
    // 受けた K 人に「この IP はこのスレを読んでいる」が漏れていた。
    const n = makeNode(ME);
    n.pm.addPeer(PEER, { verified: true, connected: true });
    await n.thread.activate(BOARD_ID, 't1', BOARD_KEY);

    const seen: DAGPost[][] = [];
    n.thread.subscribe(() => seen.push(n.thread.getPosts()));

    const threadKey = KeyManager.deriveThreadKey(BOARD_KEY, 't1');
    const packet = await buildPost('t1', '過去のレス');
    const body = new TextEncoder().encode(JsonBinary.stringify(packet));
    const { nonce, mailboxKey } = newMailboxSlot();
    const hint = buildHint(threadKey, { nonce, message_id: 1, timestamp: Date.now() });
    await n.db.put(Encoding.toHex(mailboxKey), [encodeSlotBlob(hint, body)]);

    n.dispatcher.dispatch(PEER, WireType.HINT, hint);
    await vi.waitFor(() => {
      const last = seen[seen.length - 1] ?? [];
      expect(last.map((p) => p.content)).toContain('過去のレス');
    });
  });

  it('★submitThread が Dandelion のエコー待ちで固まらない', async () => {
    // 以前は `await router.broadcast(packet)` していたため、
    // ECHO_TIMEOUT(5秒) × 3回 = 最大 15 秒 UI が固まり、
    // 立てたスレッドが画面に出なかった。
    const n = makeNode(ME);
    n.pm.addPeer(PEER, { verified: true, connected: true });
    await n.board.activate(BOARD_ID, BOARD_KEY);

    const started = Date.now();
    const threadId = await n.board.submitThread(BOARD_ID, BOARD_KEY, 'すぐ出るスレ');
    const elapsed = Date.now() - started;

    expect(threadId).toBeTruthy();
    // PoW を含めても 1 秒あれば返るはず (エコー待ちに入っていない証拠)
    expect(elapsed).toBeLessThan(2000);
    expect(n.board.getThreads().map((t) => t.thread_id)).toContain(threadId!);
  });

  it('★submitThread はステータスを submitting のまま残さない', async () => {
    const n = makeNode(ME);
    n.pm.addPeer(PEER, { verified: true, connected: true });
    await n.board.activate(BOARD_ID, BOARD_KEY);

    const statuses: any[] = [];
    n.board.subscribeStatus(() => statuses.push(n.board.getStatus()));

    await n.board.submitThread(BOARD_ID, BOARD_KEY, 'ステータス確認');

    const last = statuses[statuses.length - 1];
    expect(last.isSubmitting).toBe(false);
  });

  it('★fullSync を同時に何本も走らせない', async () => {
    const n = makeNode(ME);
    n.pm.addPeer(PEER, { verified: true, connected: true });
    n.pm.clearSent();

    // 実際に本体が走った回数を、syncing ステータスの発生数で測る
    let syncingCount = 0;
    n.board.subscribeStatus(() => {
      if (n.board.getStatus().phase === 'syncing') syncingCount++;
    });

    // 同時に 5 本呼んでも、走るのは 1 本だけ
    await Promise.all([
      n.board.fullSync(BOARD_ID, BOARD_KEY),
      n.board.fullSync(BOARD_ID, BOARD_KEY),
      n.board.fullSync(BOARD_ID, BOARD_KEY),
      n.board.fullSync(BOARD_ID, BOARD_KEY),
      n.board.fullSync(BOARD_ID, BOARD_KEY),
    ]);
    expect(syncingCount, '同時実行が畳まれていない').toBe(1);
  });

  it('★ピア接続が連続しても fullSync が重ならない', async () => {
    const n = makeNode(ME);
    n.pm.addPeer(PEER, { verified: true, connected: true });
    await n.board.activate(BOARD_ID, BOARD_KEY);
    n.pm.clearSent();

    for (let i = 0; i < 10; i++) n.pm.emit('peer:connect');
    await new Promise((r) => setTimeout(r, 700));

    expect(n.pm.messagesOfType(WireType.DHT_GET).length).toBeLessThanOrEqual(1);
  });
});

/**
 * ★ 旧経路 (固定 topicHash) が本当に消えたことを確かめる。
 *
 * 「新経路が動く」だけを見ていると、旧経路が並存したまま漏れ続けていても
 * 気付けない。**漏洩そのものが起きないこと**を直接固定する。
 */
describe('★固定 topicHash による漏洩経路の消滅', () => {
  it('★スレ立てが板の固定 topicHash へ PUT しない', async () => {
    const n = makeNode(ME);
    n.pm.addPeer(PEER, { verified: true, connected: true });
    await n.board.activate(BOARD_ID, BOARD_KEY);
    n.pm.clearSent();

    await n.board.submitThread(BOARD_ID, BOARD_KEY, '新スレ');
    await new Promise((r) => setTimeout(r, 50));

    const boardTopicHash = KeyManager.toHex(KeyManager.cryptoHash(BOARD_KEY));
    // Stem 経由でも直接でも、いずれにせよ固定座標が現れてはならない
    const puts = [
      ...n.pm.messagesOfType(WireType.DHT_PUT),
      ...n.pm.messagesOfType(WireType.DHT_PUT_STEM),
    ];
    for (const put of puts) {
      expect(
        put.payload.topicHash,
        '板の鍵から誰でも計算できる座標に置いている',
      ).not.toBe(boardTopicHash);
    }
  });

  it('★板を開いても固定 topicHash へ GET しない', async () => {
    const n = makeNode(ME);
    n.pm.addPeer(PEER, { verified: true, connected: true });
    n.pm.clearSent();

    await n.board.activate(BOARD_ID, BOARD_KEY);
    await new Promise((r) => setTimeout(r, 50));

    const boardTopicHash = KeyManager.toHex(KeyManager.cryptoHash(BOARD_KEY));
    const gets = n.pm.messagesOfType(WireType.DHT_GET);
    for (const get of gets) {
      expect(
        get.payload.topicHash,
        '「この IP はこの板を読んでいる」を隣人に直接渡している',
      ).not.toBe(boardTopicHash);
    }
  });

  it('★レス投稿がスレッドの固定 topicHash へ PUT しない', async () => {
    const n = makeNode(ME);
    n.pm.addPeer(PEER, { verified: true, connected: true });
    await n.thread.activate(BOARD_ID, 't1', BOARD_KEY);
    n.pm.clearSent();

    await n.thread.submitReply('レス本文');
    await new Promise((r) => setTimeout(r, 50));

    const threadKey = KeyManager.deriveThreadKey(BOARD_KEY, 't1');
    const threadTopicHash = KeyManager.toHex(KeyManager.deriveTopicHash(threadKey));
    const puts = [
      ...n.pm.messagesOfType(WireType.DHT_PUT),
      ...n.pm.messagesOfType(WireType.DHT_PUT_STEM),
    ];
    expect(puts.length, 'PUT が 1 件も出ていない (テストが何も検証していない)').toBeGreaterThan(0);
    for (const put of puts) {
      expect(put.payload.topicHash).not.toBe(threadTopicHash);
    }
  });

  it('★スレを開いても固定 topicHash へ GET しない', async () => {
    // ★ 板側は Phase 2 で塞いだが、スレッド側は SyncProtocol 経由で
    //   `deriveTopicHash(threadKey)` の GET が残っていた (実網ログで発覚)。
    //   スレッド鍵を持つ者なら誰でも計算できる座標なので、
    //   受けた K 人に「この IP はこのスレを読んでいる」が直接漏れる。
    const n = makeNode(ME);
    n.pm.addPeer(PEER, { verified: true, connected: true });
    n.pm.clearSent();

    await n.thread.activate(BOARD_ID, 't1', BOARD_KEY);
    await new Promise((r) => setTimeout(r, 50));

    const threadKey = KeyManager.deriveThreadKey(BOARD_KEY, 't1');
    const threadTopicHash = KeyManager.toHex(KeyManager.deriveTopicHash(threadKey));
    for (const get of n.pm.messagesOfType(WireType.DHT_GET)) {
      expect(
        get.payload.topicHash,
        '「この IP はこのスレを読んでいる」を隣人に直接渡している',
      ).not.toBe(threadTopicHash);
    }
  });

  it('★投稿ごとに違う Slot に入る (板から座標が導けない)', async () => {
    const n = makeNode(ME);
    n.pm.addPeer(PEER, { verified: true, connected: true });
    await n.board.activate(BOARD_ID, BOARD_KEY);
    n.pm.clearSent();

    await n.board.submitThread(BOARD_ID, BOARD_KEY, 'スレ1');
    await n.board.submitThread(BOARD_ID, BOARD_KEY, 'スレ2');
    await new Promise((r) => setTimeout(r, 50));

    const topics = new Set(
      [
        ...n.pm.messagesOfType(WireType.DHT_PUT),
        ...n.pm.messagesOfType(WireType.DHT_PUT_STEM),
      ].map((m) => m.payload.topicHash),
    );
    expect(topics.size, '同じ座標に積まれている = 固定鍵になっている').toBeGreaterThan(1);
  });

  it('★Hint は Stem で出る (発信元を隣人に晒さない)', async () => {
    const n = makeNode(ME);
    n.pm.addPeer(PEER, { verified: true, connected: true });
    await n.board.activate(BOARD_ID, BOARD_KEY);
    n.pm.clearSent();

    await n.board.submitThread(BOARD_ID, BOARD_KEY, 'スレ');
    await vi.waitFor(() =>
      expect(n.pm.messagesOfType(WireType.HINT_STEM).length).toBeGreaterThan(0),
    );
    expect(n.pm.messagesOfType(WireType.HINT), '直接 flood している').toHaveLength(0);
  });
});

/**
 * ★ 繋がった直後に「1 件も無い」と言わない。
 *
 * Schrödinger 化後、履歴は非同期にしか届かない
 * (バックログ → Hint → 本体取得というネットワーク往復を挟む)。
 * 同期的に `threads.size === 0` を見て断定すると、**繋がった直後は必ず
 * 「無い」と表示される**。その後スレッドが届いても文言が残り、
 * 一覧と表示が食い違う。
 */
describe('★空の判定を即断しない', () => {
  it('★隣人が居ない間は「探しています」であって「無い」ではない', async () => {
    const n = makeNode(ME);
    await n.board.activate(BOARD_ID, BOARD_KEY);
    const st = n.board.getStatus();

    expect(st.message).not.toContain('見つかりませんでした');
    expect(st.message).toContain('隣人');
  });

  it('★繋がった直後は同期中であって「無い」ではない', async () => {
    const n = makeNode(ME);
    n.pm.addPeer(PEER, { verified: true, connected: true });
    await n.board.activate(BOARD_ID, BOARD_KEY);

    expect(
      n.board.getStatus().message,
      '繋がった直後に「無い」と断定している',
    ).not.toContain('見つかりませんでした');
  });

  it('★猶予を過ぎて初めて「無い」と言う', async () => {
    vi.useFakeTimers();
    try {
      const n = makeNode(ME);
      n.pm.addPeer(PEER, { verified: true, connected: true });
      await n.board.activate(BOARD_ID, BOARD_KEY);
      expect(n.board.getStatus().message).not.toContain('見つかりませんでした');

      await vi.advanceTimersByTimeAsync(10_000);
      expect(n.board.getStatus().message).toContain('見つかりませんでした');
    } finally {
      vi.useRealTimers();
    }
  });

  it('★猶予中にスレッドが届けば「無い」とは言わない', async () => {
    vi.useFakeTimers();
    try {
      const n = makeNode(ME);
      n.pm.addPeer(PEER, { verified: true, connected: true });
      await n.board.activate(BOARD_ID, BOARD_KEY);

      const packet = await buildThreadMeta('t-late', '遅れて届いたスレ');
      await n.board.handlePacketObject(BOARD_ID, BOARD_KEY, packet, false);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(n.board.getStatus().message).not.toContain('見つかりませんでした');
      expect(n.board.getStatus().message).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('★「無い」と出た後に隣人が増えたら、判定をやり直す', async () => {
    // 新しい隣人は履歴を持っているかもしれない。
    // 一度「無い」と出したまま固定してしまうと、その隣人から届く分を
    // 待たずに諦めたことになる。
    vi.useFakeTimers();
    try {
      const n = makeNode(ME);
      n.pm.addPeer(PEER, { verified: true, connected: true });
      await n.board.activate(BOARD_ID, BOARD_KEY);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(n.board.getStatus().message).toContain('見つかりませんでした');

      // 新しい隣人が繋がる
      n.pm.addPeer('dd'.repeat(16), { verified: true, connected: true });
      n.pm.emit('peer:connect', 'dd'.repeat(16));

      expect(
        n.board.getStatus().message,
        '新しい隣人が来ても諦めたままになっている',
      ).not.toContain('見つかりませんでした');
    } finally {
      vi.useRealTimers();
    }
  });

  it('★スレッド側も同じ (即断しない)', async () => {
    const n = makeNode(ME);
    n.pm.addPeer(PEER, { verified: true, connected: true });
    await n.thread.activate(BOARD_ID, 't1', BOARD_KEY);

    expect(n.thread.getStatus().message).not.toContain('1件もありませんでした');
  });
});
