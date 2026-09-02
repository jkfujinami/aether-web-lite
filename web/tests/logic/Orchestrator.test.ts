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
}

function makeNode(peerId: string): Node {
  const pm = new FakePeerManager(peerId);
  const dispatcher = new MessageDispatcher();
  const zm = new FakeZoneManager();
  const router = new ZoneGossipRouter(pm, dispatcher, zm);
  const db = new FakeDb();
  const mailbox = new DHTMailbox(pm, dispatcher, db as any);
  const cryptoEng = new CryptoEngine();
  const identity = new Identity();
  const sync = new SyncProtocol(mailbox, cryptoEng, keyMgr, db as any);

  const board = new BoardOrchestrator(
    pm as any, db as any, mailbox, router, cryptoEng, syncPowEngine, identity, zm, keyMgr,
  );
  const thread = new ThreadOrchestrator(
    pm as any, db as any, mailbox, router, cryptoEng, syncPowEngine, identity, zm, keyMgr, sync,
  );
  return { pm, dispatcher, router, mailbox, db, board, thread };
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
  it('★DHT から取得したスレッドメタが一覧に出る', async () => {
    const n = makeNode(ME);
    const peer = n.pm.addPeer(PEER, { verified: true, connected: true });
    void peer;

    // 隣人が持っている過去ログを用意する
    const packet = await buildThreadMeta('t-past', '過去のスレ');
    const entry = new TextEncoder().encode(JsonBinary.stringify(packet));

    const seen: ThreadMeta[][] = [];
    n.board.subscribe(() => seen.push(n.board.getThreads()));

    const boardTopicHash = KeyManager.toHex(KeyManager.cryptoHash(BOARD_KEY));

    // fullSync が DHT_GET を投げるので、それに応答する
    const syncPromise = n.board.fullSync(BOARD_ID, BOARD_KEY);
    await new Promise((r) => setTimeout(r, 20));

    const get = n.pm.messagesOfType(WireType.DHT_GET)[0];
    expect(get, 'fullSync must issue a DHT_GET').toBeTruthy();
    n.dispatcher.dispatch(get.to, WireType.DHT_RES, {
      topicHash: boardTopicHash,
      reqId: get.payload.reqId,
      entries: [entry],
    });

    await syncPromise;
    await new Promise((r) => setTimeout(r, 20));

    const last = seen[seen.length - 1];
    expect(last.map((t) => t.thread_id)).toContain('t-past');
  });

  it('★DHT から取得したレスがスレッド画面に出る', async () => {
    const n = makeNode(ME);
    n.pm.addPeer(PEER, { verified: true, connected: true });

    const packet = await buildPost('t1', '過去のレス');
    const entry = new TextEncoder().encode(JsonBinary.stringify(packet));

    const seen: DAGPost[][] = [];
    await n.thread.activate(BOARD_ID, 't1', BOARD_KEY);
    n.thread.subscribe(() => seen.push(n.thread.getPosts()));
    n.pm.clearSent();

    const threadKey = KeyManager.deriveThreadKey(BOARD_KEY, 't1');
    const topicHash = KeyManager.toHex(KeyManager.deriveTopicHash(threadKey));

    const syncPromise = n.thread.fullSync(BOARD_ID, 't1', BOARD_KEY);
    await new Promise((r) => setTimeout(r, 20));

    const get = n.pm.messagesOfType(WireType.DHT_GET)[0];
    expect(get, 'fullSync must issue a DHT_GET').toBeTruthy();
    n.dispatcher.dispatch(get.to, WireType.DHT_RES, {
      topicHash,
      reqId: get.payload.reqId,
      entries: [entry],
    });

    await syncPromise;
    await new Promise((r) => setTimeout(r, 50));

    const last = seen[seen.length - 1];
    expect(last.map((p) => p.content)).toContain('過去のレス');
  });
});

describe('★UI をネットワーク待ちでブロックしない', () => {
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

    // 同時に 5 本呼んでも DHT_GET は 1 セットしか出ない
    const all = [
      n.board.fullSync(BOARD_ID, BOARD_KEY),
      n.board.fullSync(BOARD_ID, BOARD_KEY),
      n.board.fullSync(BOARD_ID, BOARD_KEY),
      n.board.fullSync(BOARD_ID, BOARD_KEY),
      n.board.fullSync(BOARD_ID, BOARD_KEY),
    ];
    await new Promise((r) => setTimeout(r, 20));
    expect(n.pm.messagesOfType(WireType.DHT_GET)).toHaveLength(1);
    await Promise.all(all);
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
