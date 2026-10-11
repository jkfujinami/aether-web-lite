import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { BoardOrchestrator } from '../../src/logic/BoardOrchestrator';
import { BOARD_META_THREAD_ID } from '../../src/logic/types';
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
  unlockedStore, customSigner, buildThreadMetaPacket, buildReplyPacket, encodeBody,
  waitFor, flush, LOGIC_FAKE_TIMERS, PASS, zoneStack, keyOutsideRandomZones,
} from '../helpers/logicHarness';

const BOARD = 'news';
const OTHER_BOARD = 'other';

interface H {
  board: BoardOrchestrator;
  pm: FakePeerManager;
  router: FakeRouter;
  schrodinger: FakeSchrodinger;
  db: IndexedDBStore;
  identity: Identity;
}

async function make(db?: IndexedDBStore, identity?: Identity, deps: { pm?: any; router?: any; zm?: any } = {}): Promise<H> {
  const pm = deps.pm ?? new FakePeerManager();
  const router = deps.router ?? new FakeRouter();
  const schrodinger = new FakeSchrodinger();
  const store = db ?? await unlockedStore();
  const id = identity ?? new Identity();
  const board = new BoardOrchestrator(
    pm as any, store, {} as any, router as any, new CryptoEngine(), syncPow, id,
    deps.zm ?? fakeZoneManager() as any, keyMgr, schrodinger as any,
  );
  return { board, pm, router, schrodinger, db: store, identity: id };
}

describe('BoardOrchestrator', () => {
  let boardKey: Uint8Array;
  let otherKey: Uint8Array;
  let h: H;

  beforeAll(async () => {
    await sodiumReady;
  });

  beforeEach(async () => {
    boardKey = sodium.randombytes_buf(32);
    otherKey = sodium.randombytes_buf(32);
    h = await make();
  });

  afterEach(() => {
    h.board.clear();
    vi.useRealTimers();
  });

  describe('スレッドの作成', () => {
    it('スレッドを立てると即座に一覧へ載り、オニオン回路経由の送信と Hint の放流が行われる', async () => {
      await h.board.activate(BOARD, boardKey);
      const notified = vi.fn();
      h.board.subscribe(notified);

      const threadId = await h.board.submitThread(BOARD, boardKey, '最初のスレッド');

      expect(threadId).toMatch(/^[0-9a-z]{10}$/);
      const threads = h.board.getThreads();
      expect(threads).toHaveLength(1);
      expect(threads[0]).toMatchObject({ thread_id: threadId, content: '最初のスレッド', max_pow: POW_POLICY.NETWORK_DIFFICULTY });
      expect(notified).toHaveBeenCalled();
      expect(h.board.getStatus()).toMatchObject({ phase: 'idle', isSubmitting: false });

      // 送出はオニオン回路 (router.broadcast) だけ。Slot は同じセルに同梱される
      expect(h.router.broadcast).toHaveBeenCalledTimes(1);
      const [packet, opts] = h.router.broadcast.mock.calls[0];
      expect(threads[0].packet_id).toBe(packet.packet_id);
      expect(opts.slot).toEqual(h.schrodinger.prepareSlot.mock.results[0].value.exitSlot);
      expect(h.pm.sendMessage).not.toHaveBeenCalled();

      // Hint は本体が網に現れた (broadcast が true) 後で放流される
      await waitFor(() => h.schrodinger.releaseHint.mock.calls.length === 1);
      const [hint, bodyBytes] = h.schrodinger.releaseHint.mock.calls[0] as any[];
      expect(hint).toBe(h.schrodinger.prepareSlot.mock.results[0].value.hint);
      expect(bodyBytes).toBeGreaterThan(0);
    });

    it('送出されるパケットは網の検証 (CHK + PoW) を通り、板の鍵でだけ開ける', async () => {
      const threadId = await h.board.submitThread(BOARD, boardKey, 'タイトル');
      const packet = h.router.broadcast.mock.calls[0][0];

      expect(PacketValidator.check(packet)).toEqual({ ok: true });
      expect(packet.pow_difficulty).toBe(POW_POLICY.NETWORK_DIFFICULTY);
      // 網に出す時刻は分単位に丸める (A5)
      expect(packet.timestamp % 60_000).toBe(0);
      expect(h.board.getThreads()[0].created_at).toBe(packet.timestamp);

      const meta = await PacketBuilder.verifyAndDecrypt(packet, boardKey, new CryptoEngine());
      expect(meta).toMatchObject({ post_type: 1, content: 'タイトル', thread_id: threadId, board_id: BOARD, thread_root: threadId });
      expect(await PacketBuilder.verifyAndDecrypt(packet, otherKey, new CryptoEngine())).toBeNull();
      // スレッド鍵 (板の鍵からの派生) でも開けない: 板のメタは板の鍵でしか読めない
      expect(await PacketBuilder.verifyAndDecrypt(packet, KeyManager.deriveThreadKey(boardKey, threadId!), new CryptoEngine())).toBeNull();
    });

    it('立てたスレッドは暗号化 DB に保存され、スレッド統計も更新される', async () => {
      const threadId = await h.board.submitThread(BOARD, boardKey, '保存されるスレッド');

      const rows = await h.db.getPosts(BOARD, BOARD_META_THREAD_ID);
      expect(rows).toHaveLength(1);
      const stats = await h.db.getThreads(BOARD);
      expect(stats).toEqual([expect.objectContaining({ threadId, boardId: BOARD, max_pow: POW_POLICY.NETWORK_DIFFICULTY })]);
      expect(await h.db.getThreads(OTHER_BOARD)).toEqual([]);
    });

    it('回路で届かなかったら、平文に落とさずエラー表示にして Hint も出さない', async () => {
      h.router.broadcast.mockResolvedValueOnce(false);
      const threadId = await h.board.submitThread(BOARD, boardKey, '届かないスレッド');
      expect(threadId).toBeTruthy();

      await waitFor(() => h.board.getStatus().phase === 'error');
      expect(h.board.getStatus().message).toContain('平文での送信は行っていません');
      expect(h.schrodinger.releaseHint).not.toHaveBeenCalled();
      expect(h.pm.sendMessage).not.toHaveBeenCalled();
    });

    it('空のタイトルでは何もしない', async () => {
      expect(await h.board.submitThread(BOARD, boardKey, '')).toBeNull();
      expect(h.router.broadcast).not.toHaveBeenCalled();
      expect(h.board.getThreads()).toHaveLength(0);
    });

    it('PoW の計算に失敗したらエラー表示にして null を返す', async () => {
      const failing = new BoardOrchestrator(
        h.pm as any, h.db, {} as any, h.router as any, new CryptoEngine(),
        { compute: async () => { throw new Error('pow failed'); } }, h.identity,
        fakeZoneManager() as any, keyMgr, h.schrodinger as any,
      );
      expect(await failing.submitThread(BOARD, boardKey, 'x')).toBeNull();
      expect(failing.getStatus()).toMatchObject({ phase: 'error', isSubmitting: false });
      expect(h.router.broadcast).not.toHaveBeenCalled();
    });

    it('連続して立てたスレッドの ID は重複しない', async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 5; i++) ids.add((await h.board.submitThread(BOARD, boardKey, `t${i}`))!);
      expect(ids.size).toBe(5);
      expect(h.board.getThreads()).toHaveLength(5);
    });
  });

  describe('網からの受信と板の鍵', () => {
    beforeEach(async () => {
      await h.board.activate(BOARD, boardKey);
    });

    it('板の鍵で開けるスレッド作成パケットは一覧に載り、DB に保存される', async () => {
      const pkt = await buildThreadMetaPacket(boardKey, BOARD, 'remote0001', '他人のスレ', customSigner());
      await h.router.deliver(pkt);

      expect(h.board.getThreads().map(t => t.content)).toEqual(['他人のスレ']);
      expect(h.board.getThreads()[0].packet_id).toBe(pkt.packet_id);
      expect(await h.db.getPosts(BOARD, BOARD_META_THREAD_ID)).toHaveLength(1);
    });

    it('別の板の鍵で暗号化されたパケットは無視し、保存もしない', async () => {
      const notified = vi.fn();
      h.board.subscribe(notified);
      const pkt = await buildThreadMetaPacket(otherKey, OTHER_BOARD, 'foreign001', 'よその板', customSigner());
      await h.router.deliver(pkt);

      expect(h.board.getThreads()).toHaveLength(0);
      expect(notified).not.toHaveBeenCalled();
      expect(await h.db.getPosts(BOARD, BOARD_META_THREAD_ID)).toHaveLength(0);
      expect(await h.db.getPosts(OTHER_BOARD, BOARD_META_THREAD_ID)).toHaveLength(0);
    });

    it('板の鍵で暗号化されていても、レス (post_type=0) はスレッド一覧に載せない', async () => {
      const pkt = await buildReplyPacket(boardKey, BOARD, 'thread0001', 'レス', customSigner());
      await h.router.deliver(pkt);
      expect(h.board.getThreads()).toHaveLength(0);
    });

    it('同じパケットが何度届いても通知は 1 回', async () => {
      const notified = vi.fn();
      h.board.subscribe(notified);
      const pkt = await buildThreadMetaPacket(boardKey, BOARD, 'dup0000001', '重複', customSigner());
      await h.router.deliver(pkt);
      await h.router.deliver(pkt);
      await h.router.deliver({ ...pkt });
      expect(notified).toHaveBeenCalledTimes(1);
      expect(await h.db.getPosts(BOARD, BOARD_META_THREAD_ID)).toHaveLength(1);
    });

    it('購読解除した listener には通知しない', async () => {
      const notified = vi.fn();
      const unsubscribe = h.board.subscribe(notified);
      unsubscribe();
      await h.router.deliver(await buildThreadMetaPacket(boardKey, BOARD, 'unsub00001', 'x', customSigner()));
      expect(notified).not.toHaveBeenCalled();
    });

    it('getThreads は変更が無い限り同じ参照を返す (useSyncExternalStore の契約)', async () => {
      const before = h.board.getThreads();
      expect(h.board.getThreads()).toBe(before);
      await h.router.deliver(await buildThreadMetaPacket(boardKey, BOARD, 'snap000001', 's', customSigner()));
      const after = h.board.getThreads();
      expect(after).not.toBe(before);
      expect(h.board.getThreads()).toBe(after);
    });

    it('同じスレッドの別パケットが重い PoW で届くと max_pow だけ更新し、作成時刻は最初のものを保つ', async () => {
      const first = await buildThreadMetaPacket(boardKey, BOARD, 'merge00001', 'merge', customSigner());
      await h.router.deliver(first);
      const createdAt = h.board.getThreads()[0].created_at;

      const heavier = await PacketBuilder.build(
        'merge', boardKey, customSigner(), new CryptoEngine(), syncPow, keyMgr, BOARD, 'merge00001',
        0, null, POW_POLICY.MIN_DIFFICULTY, 0, 1, [], 'merge00001', 500,
      );
      await h.router.deliver(heavier);

      const t = h.board.getThreads();
      expect(t).toHaveLength(1);
      expect(t[0].max_pow).toBe(500);
      expect(t[0].created_at).toBe(createdAt);
    });

    it('Hint 経由で取れた本体は、この板の鍵 ID のものだけ取り込む', async () => {
      const pkt = await buildThreadMetaPacket(boardKey, BOARD, 'hint000001', 'Hint 経由', customSigner());
      expect(h.schrodinger.addKey).toHaveBeenCalledWith(`board:${BOARD}`, boardKey);

      await h.schrodinger.emitBody(encodeBody(pkt), `board:${OTHER_BOARD}`);
      await h.schrodinger.emitBody(encodeBody(pkt), 'thread:hint000001');
      expect(h.board.getThreads()).toHaveLength(0);

      await h.schrodinger.emitBody(encodeBody(pkt), `board:${BOARD}`);
      expect(h.board.getThreads().map(t => t.content)).toEqual(['Hint 経由']);
    });

    it('壊れた本体 (JSON でない) が来ても落ちない', async () => {
      await expect(h.schrodinger.emitBody(new Uint8Array([0xff, 0x00, 0x7b]), `board:${BOARD}`)).resolves.not.toThrow();
      expect(h.board.getThreads()).toHaveLength(0);
    });

    it('板を切り替えると一覧は空になり、前の板のパケットは取り込まない', async () => {
      await h.router.deliver(await buildThreadMetaPacket(boardKey, BOARD, 'before0001', '前の板', customSigner()));
      expect(h.board.getThreads()).toHaveLength(1);

      await h.board.activate(OTHER_BOARD, otherKey);
      expect(h.board.getThreads()).toHaveLength(0);
      expect(h.schrodinger.removeKey).toHaveBeenCalledWith(`board:${BOARD}`);
      expect(h.schrodinger.addKey).toHaveBeenLastCalledWith(`board:${OTHER_BOARD}`, otherKey);
      // リスナーは張り替えられ、重複登録されない
      expect(h.router.listeners.size).toBe(1);
      expect(h.pm.listenerCount('peer:connect')).toBe(1);

      await h.router.deliver(await buildThreadMetaPacket(boardKey, BOARD, 'before0002', '前の板 2', customSigner()));
      expect(h.board.getThreads()).toHaveLength(0);
      await h.router.deliver(await buildThreadMetaPacket(otherKey, OTHER_BOARD, 'after00001', '新しい板', customSigner()));
      expect(h.board.getThreads().map(t => t.content)).toEqual(['新しい板']);
    });

    it('同じ板で activate し直しても一覧は消えず、リスナーも増えない', async () => {
      await h.router.deliver(await buildThreadMetaPacket(boardKey, BOARD, 'again00001', 'x', customSigner()));
      await h.board.activate(BOARD, boardKey);
      expect(h.board.getThreads()).toHaveLength(1);
      expect(h.router.listeners.size).toBe(1);
      expect(h.pm.listenerCount('peer:connect')).toBe(1);
    });
  });

  describe('トリップ署名', () => {
    beforeEach(async () => {
      await h.board.activate(BOARD, boardKey);
    });

    it('正しいトリップ署名付きのスレッドは、トリップ公開鍵つきで載る', async () => {
      const author = new Identity();
      await author.generateTrip(h.db, 'author-pass', VAULT_PARAMS_FAST);
      const expected = author.sign(new Uint8Array([1])).tripPubkey!;

      await h.router.deliver(await buildThreadMetaPacket(boardKey, BOARD, 'trip000001', 'トリップ付き', author));
      const t = h.board.getThreads();
      expect(t).toHaveLength(1);
      expect(Array.from(t[0].trip_pubkey)).toEqual(Array.from(expected));
    });

    it('トリップ無しのスレッドは trip_pubkey=null で載る', async () => {
      await h.router.deliver(await buildThreadMetaPacket(boardKey, BOARD, 'notrip0001', '名無し', customSigner()));
      expect(h.board.getThreads()[0].trip_pubkey).toBeNull();
    });

    it('他人のトリップ公開鍵を偽の署名で名乗ったスレッドは載せない', async () => {
      const victim = sodium.crypto_sign_keypair();
      await h.router.deliver(await buildThreadMetaPacket(boardKey, BOARD, 'forge00001', '偽トリップ', customSigner({ trip: victim, forgeTripSig: true })));
      await h.router.deliver(await buildThreadMetaPacket(boardKey, BOARD, 'forge00002', '署名無しトリップ', customSigner({ tripPubkeyOnly: victim.publicKey })));
      expect(h.board.getThreads()).toHaveLength(0);
      expect(await h.db.getPosts(BOARD, BOARD_META_THREAD_ID)).toHaveLength(0);
    });

    it('自分がトリップ付きで立てたスレッドは、他のノードでもトリップ付きで検証される', async () => {
      const me = new Identity();
      await me.generateTrip(h.db, PASS, VAULT_PARAMS_FAST);
      const mine = await make(h.db, me);
      await mine.board.submitThread(BOARD, boardKey, '自分のトリップ');
      const packet = mine.router.broadcast.mock.calls[0][0];

      await h.router.deliver(packet);
      const t = h.board.getThreads().find(x => x.content === '自分のトリップ')!;
      expect(Array.from(t.trip_pubkey)).toEqual(Array.from(me.sign(new Uint8Array()).tripPubkey!));
      mine.board.clear();
    });
  });

  describe('暗号化 DB による永続化', () => {
    it('別インスタンスでパスワードを解除し直しても、板を開けば保存済みのスレッドが復元される', async () => {
      const name = `board_persist_${Date.now()}`;
      const db1 = await unlockedStore(name);
      const first = await make(db1);
      await first.board.activate(BOARD, boardKey);
      await first.board.submitThread(BOARD, boardKey, '自分のスレ');
      await first.router.deliver(await buildThreadMetaPacket(boardKey, BOARD, 'persist001', '受信したスレ', customSigner()));
      await first.router.deliver(await buildThreadMetaPacket(otherKey, OTHER_BOARD, 'persist002', 'よその板', customSigner()));
      first.board.clear();
      db1.lock();

      const db2 = await unlockedStore(name);
      const second = await make(db2);
      await second.board.activate(BOARD, boardKey);
      expect(second.board.getThreads().map(t => t.content).sort()).toEqual(['受信したスレ', '自分のスレ']);
      // DB から読んだ分は書き戻さない
      expect(await db2.getPosts(BOARD, BOARD_META_THREAD_ID)).toHaveLength(2);
      second.board.clear();
    });

    it('DB に保存済みでも、違う板の鍵で開くと何も復元されない', async () => {
      await h.board.activate(BOARD, boardKey);
      await h.router.deliver(await buildThreadMetaPacket(boardKey, BOARD, 'wrongkey01', 'x', customSigner()));
      h.board.clear();

      const again = await make(h.db);
      await again.board.activate(BOARD, otherKey);
      expect(again.board.getThreads()).toHaveLength(0);
      again.board.clear();
    });

    it('ロックされた DB では復元も保存もできないが、例外で止まらない', async () => {
      h.db.lock();
      await expect(h.board.activate(BOARD, boardKey)).resolves.toBeUndefined();
      await h.router.deliver(await buildThreadMetaPacket(boardKey, BOARD, 'locked0001', 'ロック中', customSigner()));
      expect(h.board.getThreads()).toHaveLength(0);
    });
  });

  describe('状態表示とタイマー', () => {
    it('隣人が居なければ「接続中」', async () => {
      await h.board.activate(BOARD, boardKey);
      expect(h.board.getStatus().phase).toBe('loading');
    });

    it('隣人が居てスレッドが無ければ、8 秒の猶予の後で初めて「見つかりませんでした」と出す', async () => {
      vi.useFakeTimers(LOGIC_FAKE_TIMERS);
      h.pm.degreeOverride = 2;
      await h.board.activate(BOARD, boardKey);
      expect(h.board.getStatus()).toMatchObject({ phase: 'syncing' });

      await vi.advanceTimersByTimeAsync(7999);
      expect(h.board.getStatus().phase).toBe('syncing');
      await vi.advanceTimersByTimeAsync(1);
      expect(h.board.getStatus()).toMatchObject({ phase: 'idle' });
      expect(h.board.getStatus().message).toContain('見つかりませんでした');
    });

    it('猶予中にスレッドが届けば「無い」とは出さない', async () => {
      vi.useFakeTimers(LOGIC_FAKE_TIMERS);
      h.pm.degreeOverride = 1;
      await h.board.activate(BOARD, boardKey);
      await h.router.deliver(await buildThreadMetaPacket(boardKey, BOARD, 'grace00001', '間に合った', customSigner()));
      expect(h.board.getStatus()).toMatchObject({ phase: 'idle', message: '' });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.board.getStatus().message).toBe('');
    });

    it('新しい隣人が来ると猶予を引き直し、同期はデバウンスして 1 本に畳む', async () => {
      vi.useFakeTimers(LOGIC_FAKE_TIMERS);
      await h.board.activate(BOARD, boardKey);
      const sync = vi.spyOn(h.board, 'fullSync');

      h.pm.addPeer();
      await vi.advanceTimersByTimeAsync(300);
      h.pm.addPeer();
      await vi.advanceTimersByTimeAsync(300);
      h.pm.addPeer();
      expect(sync).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(sync).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(7000);
      expect(h.board.getStatus().phase).toBe('syncing');
      await vi.advanceTimersByTimeAsync(1100);
      expect(h.board.getStatus().message).toContain('見つかりませんでした');
    });

    it('DB のスレッド統計 (max_pow) は 5 秒ごとに一覧へ反映される', async () => {
      vi.useFakeTimers(LOGIC_FAKE_TIMERS);
      h.pm.degreeOverride = 1;
      await h.board.activate(BOARD, boardKey);
      await h.router.deliver(await buildThreadMetaPacket(boardKey, BOARD, 'stats00001', 'stats', customSigner()));
      expect(h.board.getThreads()[0].max_pow).toBe(POW_POLICY.MIN_DIFFICULTY);

      // 同じスレッドへのレスが重い累積 PoW で保存された (ThreadOrchestrator 相当)
      await h.db.save({
        boardId: BOARD, threadId: 'stats00001', payload: new Uint8Array([1]),
        dag: { parents: [], cumulative_pow: 999, thread_root: 'stats00001', created_at: Date.now() },
      });
      await vi.advanceTimersByTimeAsync(5000);
      await waitFor(() => h.board.getThreads()[0].max_pow === 999);
    });

    it('clear() で全タイマーとリスナーが外れる', async () => {
      vi.useFakeTimers(LOGIC_FAKE_TIMERS);
      h.pm.degreeOverride = 1;
      await h.board.activate(BOARD, boardKey);
      h.pm.addPeer(); // デバウンスタイマーも仕掛ける
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      h.board.clear();
      expect(vi.getTimerCount()).toBe(0);
      expect(h.router.listeners.size).toBe(0);
      expect(h.pm.listenerCount('peer:connect')).toBe(0);
      expect(h.schrodinger.removeKey).toHaveBeenCalledWith(`board:${BOARD}`);
      expect(h.board.getThreads()).toEqual([]);
    });
  });
});

describe('BoardOrchestrator: ゾーン (depth > 0) の回帰テスト', () => {
  beforeAll(async () => {
    await sodiumReady;
  });

  it('スレッド作成パケットの zone_id は、板の鍵のトピックを現在の depth で切ったゾーン (存在する範囲) になる', async () => {
    for (const depth of [0, 1, 4, 5, 8, 12]) {
      for (let i = 0; i < 4; i++) {
        const zm = fakeZoneManager(depth);
        const h = await make(undefined, undefined, { zm });
        const key = sodium.randombytes_buf(32);
        await h.board.submitThread(BOARD, key, `depth ${depth}`);
        const packet = h.router.broadcast.mock.calls[0][0];
        expect(packet.zone_id).toBe(KeyManager.computeZoneId(KeyManager.deriveTopicHash(key), depth));
        expect(packet.zone_id).toBeGreaterThanOrEqual(0);
        expect(packet.zone_id).toBeLessThan(1 << depth);
        expect(PacketValidator.check(packet)).toEqual({ ok: true });
        h.board.clear();
      }
    }
  });

  it('板を開くとそのトピックを watch し、板の切替・clear() で外す。同じ板を開き直しても二重に watch しない', async () => {
    const zm = fakeZoneManager(6);
    const h = await make(undefined, undefined, { zm });
    const keyA = sodium.randombytes_buf(32);
    const keyB = sodium.randombytes_buf(32);
    const topicA = zm.hex(KeyManager.deriveTopicHash(keyA));
    const topicB = zm.hex(KeyManager.deriveTopicHash(keyB));

    await h.board.activate(BOARD, keyA);
    expect(Array.from(zm.watched.entries())).toEqual([[topicA, 1]]);
    await h.board.activate(BOARD, keyA);
    expect(Array.from(zm.watched.entries())).toEqual([[topicA, 1]]);

    await h.board.activate(OTHER_BOARD, keyB);
    expect(Array.from(zm.watched.entries())).toEqual([[topicB, 1]]);

    h.board.clear();
    expect(zm.watched.size).toBe(0);
    h.board.clear(); // 二重の clear でも参照数を壊さない
    expect(zm.watched.size).toBe(0);
  });

  it('watchTopic を持たない ZoneManager でも動く (任意のメソッド)', async () => {
    const zm = { depth: 6, subscribedZones: new Set([0]), isSubscribed: () => true };
    const h = await make(undefined, undefined, { zm });
    const key = sodium.randombytes_buf(32);
    await expect(h.board.activate(BOARD, key)).resolves.toBeUndefined();
    expect(await h.board.submitThread(BOARD, key, 'x')).toBeTruthy();
    h.board.clear();
  });

  it('depth ≥ 5 の網でも、開いている板のスレッドは ZoneGossipRouter 経由で届き、clear() 後は画面に渡らない (中継は続く)', async () => {
    const net = zoneStack(8);
    try {
      expect(net.zm.depth).toBe(8);
      const key = keyOutsideRandomZones(net.zm, k => KeyManager.deriveTopicHash(k));
      const zone = KeyManager.computeZoneId(KeyManager.deriveTopicHash(key), 8);
      const h = await make(undefined, undefined, { pm: net.pm, router: net.router, zm: net.zm });

      // 対照: 板を開く前は、そのゾーンは購読外 (修正前はこの状態のままだった)
      const before = await buildThreadMetaPacket(key, BOARD, 'zone000000', '開く前', customSigner(), 8);
      expect(before.zone_id).toBe(zone);
      net.gossip(before);
      expect(net.observed).toHaveLength(0);
      expect(net.relayed(before.packet_id)).toBe(true);

      await h.board.activate(BOARD, key);
      expect(net.zm.isSubscribed(zone)).toBe(true);
      const during = await buildThreadMetaPacket(key, BOARD, 'zone000001', '開いている間', customSigner(), 8);
      net.gossip(during);
      expect(net.observed.map(p => p.packet_id)).toEqual([during.packet_id]);
      await waitFor(() => h.board.getThreads().length === 1);
      expect(h.board.getThreads()[0].content).toBe('開いている間');

      h.board.clear();
      expect(net.zm.isSubscribed(zone)).toBe(false);
      const after = await buildThreadMetaPacket(key, BOARD, 'zone000002', '閉じた後', customSigner(), 8);
      net.gossip(after);
      expect(net.observed.map(p => p.packet_id)).toEqual([during.packet_id]);
      expect(net.relayed(after.packet_id)).toBe(true); // 中継は購読と無関係 (Broadcast Veil)
    } finally {
      net.destroy();
    }
  });

  it('自分が立てたスレッドは、同じ depth の別ノードの開いている板に届く (送信側と受信側のゾーンが一致する)', async () => {
    const net = zoneStack(6);
    try {
      const key = keyOutsideRandomZones(net.zm, k => KeyManager.deriveTopicHash(k));
      const author = await make(undefined, undefined, { zm: fakeZoneManager(net.zm.depth) });
      await author.board.submitThread(BOARD, key, '作者のスレ');
      const packet = author.router.broadcast.mock.calls[0][0];

      const reader = await make(undefined, undefined, { pm: net.pm, router: net.router, zm: net.zm });
      await reader.board.activate(BOARD, key);
      net.gossip(packet);
      await waitFor(() => reader.board.getThreads().length === 1);
      author.board.clear();
      reader.board.clear();
    } finally {
      net.destroy();
    }
  });
});

describe('BoardOrchestrator: 状態通知', () => {
  beforeAll(async () => {
    await sodiumReady;
  });

  it('同じ状態への更新では status listener を呼ばない', async () => {
    const h = await make();
    const statusCb = vi.fn();
    h.board.subscribeStatus(statusCb);
    const key = sodium.randombytes_buf(32);
    await h.board.activate(BOARD, key); // loading
    const calls = statusCb.mock.calls.length;
    await h.board.fullSync(BOARD, key); // 同じ loading
    expect(statusCb.mock.calls.length).toBe(calls);
    await flush();
    h.board.clear();
  });
});
