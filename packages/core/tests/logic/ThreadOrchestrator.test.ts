import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { ThreadOrchestrator } from '../../src/logic/ThreadOrchestrator';
import { CryptoEngine } from '../../src/crypto/CryptoEngine';
import { Identity } from '../../src/crypto/Identity';
import { KeyManager } from '../../src/crypto/KeyManager';
import { PacketBuilder } from '../../src/crypto/PacketBuilder';
import { POW_POLICY } from '../../src/crypto/PowPolicy';
import { PacketValidator } from '../../src/network/gossip/PacketValidator';
import { VAULT_PARAMS_FAST } from '../../src/storage/SecretVault';
import type { IndexedDBStore } from '../../src/storage/IndexedDBStore';
import {
  FakePeerManager, FakeRouter, FakeSchrodinger, fakeZoneManager, keyMgr, syncPow,
  unlockedStore, customSigner, buildReplyPacket, buildThreadMetaPacket, encodeBody,
  waitFor, LOGIC_FAKE_TIMERS, zoneStack, keyOutsideRandomZones,
} from '../helpers/logicHarness';

const BOARD = 'news';
const THREAD = 'thr0000001';
const OTHER_THREAD = 'thr0000002';
const D = POW_POLICY.NETWORK_DIFFICULTY;

interface H {
  thread: ThreadOrchestrator;
  pm: FakePeerManager;
  router: FakeRouter;
  schrodinger: FakeSchrodinger;
  db: IndexedDBStore;
}

async function make(db?: IndexedDBStore, identity: Identity = new Identity(), deps: { pm?: any; router?: any; zm?: any } = {}): Promise<H> {
  const pm = deps.pm ?? new FakePeerManager();
  if (!deps.pm) pm.degreeOverride = 1; // 既定では隣人が居る (初回同期の 10 秒待ちを避ける)
  const router = deps.router ?? new FakeRouter();
  const schrodinger = new FakeSchrodinger();
  const store = db ?? await unlockedStore();
  const thread = new ThreadOrchestrator(
    pm as any, store, {} as any, router as any, new CryptoEngine(), syncPow, identity,
    deps.zm ?? fakeZoneManager() as any, keyMgr, {} as any, schrodinger as any,
  );
  return { thread, pm, router, schrodinger, db: store };
}

const contents = (h: H) => h.thread.getPosts().map(p => p.content);

describe('ThreadOrchestrator', () => {
  let boardKey: Uint8Array;
  let threadKey: Uint8Array;
  let h: H;

  beforeAll(async () => {
    await sodiumReady;
  });

  beforeEach(async () => {
    boardKey = sodium.randombytes_buf(32);
    threadKey = KeyManager.deriveThreadKey(boardKey, THREAD);
    h = await make();
  });

  afterEach(() => {
    h.thread.clear();
    vi.useRealTimers();
  });

  describe('返信の投稿', () => {
    beforeEach(async () => {
      await h.thread.activate(BOARD, THREAD, boardKey);
    });

    it('Hint の試行復号には (板の鍵ではなく) 派生したスレッド鍵を渡す', () => {
      expect(h.schrodinger.addKey).toHaveBeenCalledWith(`thread:${THREAD}`, threadKey);
    });

    it('返信は即座に DAG に載り、スレッド鍵で暗号化された正当なパケットとして回路へ送られる', async () => {
      await h.thread.submitReply('こんにちは');

      const posts = h.thread.getPosts();
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ content: 'こんにちは', parents: [], cumulative_pow: D, thread_id: THREAD, board_id: BOARD });

      expect(h.router.broadcast).toHaveBeenCalledTimes(1);
      const [packet, opts] = h.router.broadcast.mock.calls[0];
      expect(posts[0].packet_id).toBe(packet.packet_id);
      expect(opts.slot).toBeDefined();
      expect(PacketValidator.check(packet)).toEqual({ ok: true });
      expect(packet.timestamp % 60_000).toBe(0);

      const decoded = await PacketBuilder.verifyAndDecrypt(packet, threadKey, new CryptoEngine());
      expect(decoded).toMatchObject({ post_type: 0, content: 'こんにちは', thread_id: THREAD, post_number: 0 });
      expect(await PacketBuilder.verifyAndDecrypt(packet, boardKey, new CryptoEngine())).toBeNull();

      await waitFor(() => h.schrodinger.releaseHint.mock.calls.length === 1);
      expect(h.pm.sendMessage).not.toHaveBeenCalled();
    });

    it('続く返信は直前の先端を親に持ち、累積 PoW が積み上がる。post_number は常に 0 (閲覧状況を漏らさない)', async () => {
      await h.thread.submitReply('1');
      await h.thread.submitReply('2');
      await h.thread.submitReply('3');

      const posts = h.thread.getPosts();
      expect(posts.map(p => p.content)).toEqual(['1', '2', '3']);
      expect(posts[1].parents).toEqual([posts[0].packet_id]);
      expect(posts[2].parents).toEqual([posts[1].packet_id]);
      expect(posts.map(p => p.cumulative_pow)).toEqual([D, 2 * D, 3 * D]);

      const third = h.router.broadcast.mock.calls[2][0];
      const decoded = await PacketBuilder.verifyAndDecrypt(third, threadKey, new CryptoEngine());
      expect(decoded.parents).toEqual([posts[1].packet_id]);
      expect(decoded.cumulative_pow).toBe(3 * D);
      expect(decoded.post_number).toBe(0);
    });

    it('返信は暗号化 DB にスレッド単位で保存される', async () => {
      await h.thread.submitReply('保存');
      expect(await h.db.getPosts(BOARD, THREAD)).toHaveLength(1);
      expect(await h.db.getPosts(BOARD, OTHER_THREAD)).toHaveLength(0);
      const stats = await h.db.getThreads(BOARD);
      expect(stats).toEqual([expect.objectContaining({ threadId: THREAD, max_pow: D })]);
    });

    it('回路で届かなかったら平文に落とさずエラー表示にする', async () => {
      h.router.broadcast.mockResolvedValueOnce(false);
      await h.thread.submitReply('届かない');
      await waitFor(() => h.thread.getStatus().phase === 'error');
      expect(h.thread.getStatus().message).toContain('平文での送信は行っていません');
      expect(h.schrodinger.releaseHint).not.toHaveBeenCalled();
    });

    it('投稿後の表示は 3 秒で通常に戻る', async () => {
      vi.useFakeTimers(LOGIC_FAKE_TIMERS);
      await h.thread.submitReply('x');
      expect(h.thread.getStatus()).toMatchObject({ phase: 'idle', isSubmitting: false });
      expect(h.thread.getStatus().message).not.toBe('');
      await vi.advanceTimersByTimeAsync(3000);
      expect(h.thread.getStatus()).toMatchObject({ phase: 'idle', message: '' });
    });

    it('空文字の返信は何もしない', async () => {
      await h.thread.submitReply('');
      expect(h.router.broadcast).not.toHaveBeenCalled();
      expect(h.thread.getPosts()).toHaveLength(0);
    });
  });

  it('スレッドを開く前の返信は何もしない', async () => {
    await h.thread.submitReply('早すぎる');
    expect(h.router.broadcast).not.toHaveBeenCalled();
  });

  describe('網からの受信', () => {
    beforeEach(async () => {
      await h.thread.activate(BOARD, THREAD, boardKey);
    });

    it('このスレッドの鍵で開ける返信は DAG に載り、DB に保存される', async () => {
      await h.router.deliver(await buildReplyPacket(threadKey, BOARD, THREAD, '他人のレス', customSigner()));
      expect(contents(h)).toEqual(['他人のレス']);
      expect(await h.db.getPosts(BOARD, THREAD)).toHaveLength(1);
    });

    it('同じ板の別スレッドの返信は (鍵が違うので) 取り込まない', async () => {
      const otherKey = KeyManager.deriveThreadKey(boardKey, OTHER_THREAD);
      await h.router.deliver(await buildReplyPacket(otherKey, BOARD, OTHER_THREAD, '別スレ', customSigner()));
      expect(h.thread.getPosts()).toHaveLength(0);
      expect(await h.db.getPosts(BOARD, OTHER_THREAD)).toHaveLength(0);
    });

    it('スレッド鍵で開けても、中の thread_id が違う返信は取り込まない', async () => {
      await h.router.deliver(await buildReplyPacket(threadKey, BOARD, OTHER_THREAD, '偽のスレッド ID', customSigner()));
      expect(h.thread.getPosts()).toHaveLength(0);
    });

    it('スレッド鍵で開けても、スレッド作成 (post_type=1) は返信として取り込まない', async () => {
      await h.router.deliver(await buildReplyPacket(threadKey, BOARD, THREAD, 'メタ', customSigner(), { postType: 1 }));
      expect(h.thread.getPosts()).toHaveLength(0);
    });

    it('板の鍵で暗号化された板メタは、スレッドには現れない', async () => {
      await h.router.deliver(await buildThreadMetaPacket(boardKey, BOARD, THREAD, 'スレタイ', customSigner()));
      expect(h.thread.getPosts()).toHaveLength(0);
    });

    it('同じパケットが何度届いても通知は 1 回', async () => {
      const notified = vi.fn();
      h.thread.subscribe(notified);
      const pkt = await buildReplyPacket(threadKey, BOARD, THREAD, '重複', customSigner());
      await h.router.deliver(pkt);
      await h.router.deliver(pkt);
      expect(notified).toHaveBeenCalledTimes(1);
      expect(await h.db.getPosts(BOARD, THREAD)).toHaveLength(1);
    });

    it('子が親より先に届いても、表示は親が先', async () => {
      const parent = await buildReplyPacket(threadKey, BOARD, THREAD, '親', customSigner());
      const child = await buildReplyPacket(threadKey, BOARD, THREAD, '子', customSigner(), { parents: [parent.packet_id], cumulativePow: 2 * D });
      await h.router.deliver(child);
      expect(contents(h)).toEqual(['子']);
      await h.router.deliver(parent);
      expect(contents(h)).toEqual(['親', '子']);
    });

    it('並行して書かれた返信が両方届くと、次の自分の返信はその両方を親にする', async () => {
      const a = await buildReplyPacket(threadKey, BOARD, THREAD, 'A', customSigner(), { cumulativePow: D });
      const b = await buildReplyPacket(threadKey, BOARD, THREAD, 'B', customSigner(), { cumulativePow: 2 * D });
      await h.router.deliver(a);
      await h.router.deliver(b);

      await h.thread.submitReply('合流');
      const mine = h.thread.getPosts().find(p => p.content === '合流')!;
      expect(mine.parents).toEqual([b.packet_id, a.packet_id]); // 重い先端から
      expect(mine.cumulative_pow).toBe(2 * D + D);
      expect(h.thread.getPosts().at(-1)!.content).toBe('合流');
    });

    it('Hint 経由の本体は、このスレッドの鍵 ID のものだけ取り込む', async () => {
      const pkt = await buildReplyPacket(threadKey, BOARD, THREAD, 'Hint 経由', customSigner());
      await h.schrodinger.emitBody(encodeBody(pkt), `thread:${OTHER_THREAD}`);
      await h.schrodinger.emitBody(encodeBody(pkt), `board:${BOARD}`);
      expect(h.thread.getPosts()).toHaveLength(0);
      await h.schrodinger.emitBody(encodeBody(pkt), `thread:${THREAD}`);
      expect(contents(h)).toEqual(['Hint 経由']);
    });

    it('スレッドを切り替えると DAG は空になり、前のスレッドの返信は取り込まない', async () => {
      await h.router.deliver(await buildReplyPacket(threadKey, BOARD, THREAD, '前', customSigner()));
      await h.thread.activate(BOARD, OTHER_THREAD, boardKey);
      expect(h.thread.getPosts()).toHaveLength(0);
      expect(h.schrodinger.removeKey).toHaveBeenCalledWith(`thread:${THREAD}`);
      expect(h.router.listeners.size).toBe(1);

      await h.router.deliver(await buildReplyPacket(threadKey, BOARD, THREAD, '前 2', customSigner()));
      expect(h.thread.getPosts()).toHaveLength(0);
      const otherKey = KeyManager.deriveThreadKey(boardKey, OTHER_THREAD);
      await h.router.deliver(await buildReplyPacket(otherKey, BOARD, OTHER_THREAD, '新', customSigner()));
      expect(contents(h)).toEqual(['新']);
    });
  });

  describe('板の鍵の扱い', () => {
    it('違う板の鍵でスレッドを開くと、正しい板のスレッドの返信は読めない', async () => {
      const wrongBoardKey = sodium.randombytes_buf(32);
      await h.thread.activate(BOARD, THREAD, wrongBoardKey);
      await h.router.deliver(await buildReplyPacket(threadKey, BOARD, THREAD, '読めないはず', customSigner()));
      expect(h.thread.getPosts()).toHaveLength(0);
    });

    it('スレッド鍵は板の鍵とスレッド ID の両方に依存する', () => {
      expect(KeyManager.deriveThreadKey(boardKey, THREAD)).toEqual(threadKey);
      expect(KeyManager.deriveThreadKey(boardKey, OTHER_THREAD)).not.toEqual(threadKey);
      expect(KeyManager.deriveThreadKey(sodium.randombytes_buf(32), THREAD)).not.toEqual(threadKey);
    });
  });

  describe('トリップ署名', () => {
    beforeEach(async () => {
      await h.thread.activate(BOARD, THREAD, boardKey);
    });

    it('正しいトリップ署名付きの返信はトリップ公開鍵つきで載る', async () => {
      const author = new Identity();
      await author.generateTrip(h.db, 'author-pass', VAULT_PARAMS_FAST);
      await h.router.deliver(await buildReplyPacket(threadKey, BOARD, THREAD, 'トリップ', author));
      const p = h.thread.getPosts()[0];
      expect(Array.from(p.trip_pubkey!)).toEqual(Array.from(author.sign(new Uint8Array()).tripPubkey!));
    });

    it('他人のトリップを偽った返信 (不正な署名 / 署名無し) は載せない', async () => {
      const victim = sodium.crypto_sign_keypair();
      await h.router.deliver(await buildReplyPacket(threadKey, BOARD, THREAD, '偽 1', customSigner({ trip: victim, forgeTripSig: true })));
      await h.router.deliver(await buildReplyPacket(threadKey, BOARD, THREAD, '偽 2', customSigner({ tripPubkeyOnly: victim.publicKey })));
      expect(h.thread.getPosts()).toHaveLength(0);
      expect(await h.db.getPosts(BOARD, THREAD)).toHaveLength(0);
    });

    it('別人のトリップ鍵で署名したものを自分のトリップ公開鍵と偽っても通らない', async () => {
      const victim = sodium.crypto_sign_keypair();
      const attacker = sodium.crypto_sign_keypair();
      const session = sodium.crypto_sign_keypair();
      const signer = {
        sign: (data: Uint8Array) => ({
          sessionPubkey: session.publicKey,
          sessionSignature: sodium.crypto_sign_detached(data, session.privateKey),
          tripPubkey: victim.publicKey,
          tripSignature: sodium.crypto_sign_detached(data, attacker.privateKey),
        }),
      };
      await h.router.deliver(await buildReplyPacket(threadKey, BOARD, THREAD, '乗っ取り', signer));
      expect(h.thread.getPosts()).toHaveLength(0);
    });
  });

  describe('暗号化 DB による永続化', () => {
    it('パスワードを解除し直した別インスタンスで、返信が DAG の順序どおりに復元される', async () => {
      const name = `thread_persist_${Date.now()}`;
      const db1 = await unlockedStore(name);
      const first = await make(db1);
      await first.thread.activate(BOARD, THREAD, boardKey);
      await first.thread.submitReply('一');
      const remote = await buildReplyPacket(threadKey, BOARD, THREAD, '二', customSigner(), {
        parents: [first.thread.getPosts()[0].packet_id], cumulativePow: 2 * D,
      });
      await first.router.deliver(remote);
      await first.thread.submitReply('三');
      const expectedOrder = first.thread.getPosts().map(p => p.packet_id);
      first.thread.clear();
      db1.lock();

      const db2 = await unlockedStore(name);
      const second = await make(db2);
      await second.thread.activate(BOARD, THREAD, boardKey);
      expect(second.thread.getPosts().map(p => p.packet_id)).toEqual(expectedOrder);
      expect(contents(second)).toEqual(['一', '二', '三']);
      // DB から読んだ分は書き戻さない
      expect(await db2.getPosts(BOARD, THREAD)).toHaveLength(3);
      second.thread.clear();
    });

    it('別スレッドを開いても、保存済みの他スレッドの返信は混ざらない', async () => {
      await h.thread.activate(BOARD, THREAD, boardKey);
      await h.thread.submitReply('このスレ');
      h.thread.clear();

      const again = await make(h.db);
      await again.thread.activate(BOARD, OTHER_THREAD, boardKey);
      expect(again.thread.getPosts()).toHaveLength(0);
      again.thread.clear();
    });
  });

  describe('初回同期と状態表示', () => {
    it('隣人が居なければ最大 10 秒だけ待ち、来なければ「待機中」と表示する', async () => {
      vi.useFakeTimers(LOGIC_FAKE_TIMERS);
      h.pm.degreeOverride = 0;
      let done = false;
      const p = h.thread.activate(BOARD, THREAD, boardKey).then(() => { done = true; });
      await waitFor(() => h.thread.getStatus().message === '隣人を探しています...');
      expect(h.thread.getStatus().phase).toBe('loading');

      await vi.advanceTimersByTimeAsync(9_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(h.thread.getStatus()).toMatchObject({ phase: 'idle' });
      expect(h.thread.getStatus().message).toContain('ネット接続待機中');
    });

    it('待っている間に隣人が来れば即座に同期へ進み、8 秒の猶予の後で「1 件も無い」と出す', async () => {
      vi.useFakeTimers(LOGIC_FAKE_TIMERS);
      h.pm.degreeOverride = null; // 実際の隣人数
      const p = h.thread.activate(BOARD, THREAD, boardKey);
      await waitFor(() => h.thread.getStatus().phase === 'loading' && h.pm.listenerCount('peer:connect') === 2);
      h.pm.addPeer();
      await p;
      expect(h.thread.getStatus().phase).toBe('syncing');
      // 待機用の一時リスナーは外れている
      expect(h.pm.listenerCount('peer:connect')).toBe(1);

      await vi.advanceTimersByTimeAsync(8000);
      expect(h.thread.getStatus().message).toContain('レスが1件もありませんでした');
    });

    it('clear() で全タイマーとリスナーが外れる', async () => {
      vi.useFakeTimers(LOGIC_FAKE_TIMERS);
      await h.thread.activate(BOARD, THREAD, boardKey);
      h.pm.addPeer(); // デバウンス
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      h.thread.clear();
      expect(vi.getTimerCount()).toBe(0);
      expect(h.router.listeners.size).toBe(0);
      expect(h.pm.listenerCount('peer:connect')).toBe(0);
      expect(h.schrodinger.removeKey).toHaveBeenCalledWith(`thread:${THREAD}`);
      expect(h.thread.getPosts()).toEqual([]);
    });
  });
});

describe('ThreadOrchestrator: ゾーン (depth > 0) の回帰テスト', () => {
  beforeAll(async () => {
    await sodiumReady;
  });

  it('返信パケットの zone_id は、スレッド鍵のトピックを現在の depth で切ったゾーン (存在する範囲) になる', async () => {
    for (const depth of [0, 3, 5, 9, 12]) {
      for (let i = 0; i < 3; i++) {
        const h = await make(undefined, undefined, { zm: fakeZoneManager(depth) });
        const boardKey = sodium.randombytes_buf(32);
        await h.thread.activate(BOARD, THREAD, boardKey);
        await h.thread.submitReply(`depth ${depth}`);
        const packet = h.router.broadcast.mock.calls[0][0];
        const threadTopic = KeyManager.deriveTopicHash(KeyManager.deriveThreadKey(boardKey, THREAD));
        expect(packet.zone_id).toBe(KeyManager.computeZoneId(threadTopic, depth));
        expect(packet.zone_id).toBeLessThan(1 << depth);
        expect(PacketValidator.check(packet)).toEqual({ ok: true });
        h.thread.clear();
      }
    }
  });

  it('スレッドを開くと (板ではなく) スレッドのトピックを watch し、切替・clear() で外す', async () => {
    const zm = fakeZoneManager(6);
    const h = await make(undefined, undefined, { zm });
    const boardKey = sodium.randombytes_buf(32);
    const topic = (t: string) => zm.hex(KeyManager.deriveTopicHash(KeyManager.deriveThreadKey(boardKey, t)));

    await h.thread.activate(BOARD, THREAD, boardKey);
    expect(Array.from(zm.watched.entries())).toEqual([[topic(THREAD), 1]]);
    expect(zm.watched.has(zm.hex(KeyManager.deriveTopicHash(boardKey)))).toBe(false);
    await h.thread.activate(BOARD, THREAD, boardKey);
    expect(Array.from(zm.watched.entries())).toEqual([[topic(THREAD), 1]]);

    await h.thread.activate(BOARD, OTHER_THREAD, boardKey);
    expect(Array.from(zm.watched.entries())).toEqual([[topic(OTHER_THREAD), 1]]);
    h.thread.clear();
    expect(zm.watched.size).toBe(0);
  });

  it('depth ≥ 5 の網でも、開いているスレッドの返信は ZoneGossipRouter 経由で届き、clear() 後は画面に渡らない (中継は続く)', async () => {
    const net = zoneStack(7);
    try {
      expect(net.zm.depth).toBe(7);
      const boardKey = keyOutsideRandomZones(net.zm, k => KeyManager.deriveTopicHash(KeyManager.deriveThreadKey(k, THREAD)));
      const threadKey = KeyManager.deriveThreadKey(boardKey, THREAD);
      const zone = KeyManager.computeZoneId(KeyManager.deriveTopicHash(threadKey), 7);
      const h = await make(undefined, undefined, { pm: net.pm, router: net.router, zm: net.zm });

      const before = await buildReplyPacket(threadKey, BOARD, THREAD, '開く前', customSigner(), { depth: 7 });
      expect(before.zone_id).toBe(zone);
      net.gossip(before);
      expect(net.observed).toHaveLength(0);

      await h.thread.activate(BOARD, THREAD, boardKey);
      const during = await buildReplyPacket(threadKey, BOARD, THREAD, '開いている間', customSigner(), { depth: 7 });
      net.gossip(during);
      expect(net.observed.map(p => p.packet_id)).toEqual([during.packet_id]);
      await waitFor(() => h.thread.getPosts().length === 1);
      expect(h.thread.getPosts()[0].content).toBe('開いている間');

      h.thread.clear();
      expect(net.zm.isSubscribed(zone)).toBe(false);
      const after = await buildReplyPacket(threadKey, BOARD, THREAD, '閉じた後', customSigner(), { depth: 7 });
      net.gossip(after);
      expect(net.observed.map(p => p.packet_id)).toEqual([during.packet_id]);
      expect(net.relayed(after.packet_id)).toBe(true);
    } finally {
      net.destroy();
    }
  });

  it('板とスレッドを同時に開くと両方のゾーンが購読され、スレッドを閉じても板のゾーンは残る', async () => {
    const net = zoneStack(8);
    try {
      const boardKey = sodium.randombytes_buf(32);
      const boardZone = KeyManager.computeZoneId(KeyManager.deriveTopicHash(boardKey), 8);
      const threadZone = KeyManager.computeZoneId(KeyManager.deriveTopicHash(KeyManager.deriveThreadKey(boardKey, THREAD)), 8);
      const { BoardOrchestrator } = await import('../../src/logic/BoardOrchestrator');
      const board = new BoardOrchestrator(
        net.pm as any, await unlockedStore(), {} as any, net.router as any, new CryptoEngine(), syncPow, new Identity(),
        net.zm, keyMgr, new FakeSchrodinger() as any,
      );
      const h = await make(undefined, undefined, { pm: net.pm, router: net.router, zm: net.zm });
      await board.activate(BOARD, boardKey);
      await h.thread.activate(BOARD, THREAD, boardKey);
      expect(net.zm.isSubscribed(boardZone)).toBe(true);
      expect(net.zm.isSubscribed(threadZone)).toBe(true);

      h.thread.clear();
      expect(net.zm.isSubscribed(boardZone)).toBe(true);
      board.clear();
      if (!net.zm.subscribedZones.has(boardZone)) expect(net.zm.isSubscribed(boardZone)).toBe(false);
    } finally {
      net.destroy();
    }
  });
});
