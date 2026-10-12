import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { createSimNode, link, startAll, stopAll, sleep, type SimNode } from '../helpers/onionNet';
import { KeyManager } from '../../src/crypto/KeyManager';
import { ThreadOrchestrator } from '../../src/logic/ThreadOrchestrator';
import { BoardOrchestrator } from '../../src/logic/BoardOrchestrator';
import { CryptoEngine } from '../../src/crypto/CryptoEngine';
import { PoWEngine } from '../../src/crypto/PoWEngine';
import { Identity } from '../../src/crypto/Identity';
import { IndexedDBStore } from '../../src/storage/IndexedDBStore';
import { DHTMailbox } from '../../src/network/mailbox/DHTMailbox';
import { SchrodingerMailbox } from '../../src/network/hint/SchrodingerMailbox';
import { CIRCUIT_CONFIG } from '../../src/network/onion/OnionCircuit';

describe('Layer 1: 高速 Gossip 配信 & 非同期 Hint 放流 統合テスト', () => {
  let nodes: SimNode[] = [];
  const cleanups: Array<() => void> = [];
  const syncPow: any = { compute: (h: any) => PoWEngine.compute(h) };
  const keyMgr: any = {
    deriveThreadKey: KeyManager.deriveThreadKey,
    deriveTopicHash: KeyManager.deriveTopicHash,
    computeZoneId: KeyManager.computeZoneId,
  };

  beforeAll(async () => {
    await sodiumReady;
  });

  afterEach(async () => {
    for (const c of cleanups) {
      try { c(); } catch {}
    }
    cleanups.length = 0;
    stopAll(nodes);
    nodes = [];
    await sleep(50);
  });

  async function createAppContext(node: SimNode, dbName: string) {
    const db = new IndexedDBStore(dbName);
    await db.init();
    await db.unlock('test_password_123');
    const mailbox = new DHTMailbox(node.peerManager, node.dispatcher, db, node.circuit);
    const schrodinger = new SchrodingerMailbox(mailbox, node.hints, node.peerManager, 'adaptive');
    cleanups.push(() => schrodinger.destroy());
    return { db, mailbox, schrodinger };
  }

  it('CIRCUIT_CONFIG の高速化定数が仕様値 (COVER 300ms, EXIT 500ms, ECHO 5000ms) に設定されていること', () => {
    expect(CIRCUIT_CONFIG.COVER_INTERVAL_MS).toBe(300);
    expect(CIRCUIT_CONFIG.EXIT_DELAY_MS).toBe(500);
    expect(CIRCUIT_CONFIG.EXIT_DELAY_MAX_MS).toBe(2000);
    expect(CIRCUIT_CONFIG.ECHO_TIMEOUT_MS).toBe(5000);
  });

  it('送信側の releaseHint が遅延しても、会話パケットはオニオン Exit から直接 Fluff され即時に受信側 DAG に到達する', async () => {
    // 4ノード網: 送信者 (0) -> Guard (1) -> Exit (2) -> 受信者 (3)
    const n0 = await createSimNode('n0');
    const n1 = await createSimNode('n1');
    const n2 = await createSimNode('n2');
    const n3 = await createSimNode('n3');
    nodes = [n0, n1, n2, n3];

    link(n0, n1);
    link(n1, n2);
    link(n2, n3);
    link(n1, n3);

    startAll(nodes);
    // Guard の隣人表 (PEX) が伝播するまで待機
    await sleep(100);

    const boardKey = sodium.randombytes_buf(32);
    const boardId = 'news';
    const threadId = 'thread_fast_01';

    const ctx0 = await createAppContext(n0, 'fast_db_0');
    const ctx3 = await createAppContext(n3, 'fast_db_3');

    const cryptoEngine = new CryptoEngine();
    const senderIdentity = new Identity();
    const receiverIdentity = new Identity();

    const senderOrch = new ThreadOrchestrator(
      n0.peerManager,
      ctx0.db,
      ctx0.mailbox,
      n0.gossip,
      cryptoEngine,
      syncPow,
      senderIdentity,
      { isSubscribed: () => true, depth: 0 } as any,
      keyMgr,
      {} as any,
      ctx0.schrodinger,
    );

    const receiverOrch = new ThreadOrchestrator(
      n3.peerManager,
      ctx3.db,
      ctx3.mailbox,
      n3.gossip,
      cryptoEngine,
      syncPow,
      receiverIdentity,
      { isSubscribed: () => true, depth: 0 } as any,
      keyMgr,
      {} as any,
      ctx3.schrodinger,
    );

    await receiverOrch.activate(boardId, threadId, boardKey);
    await senderOrch.activate(boardId, threadId, boardKey);

    // 送信側の releaseHint に意図的な遅延 (5秒) を注入
    let releaseHintCalled = false;
    const origReleaseHint = ctx0.schrodinger.releaseHint.bind(ctx0.schrodinger);
    ctx0.schrodinger.releaseHint = async (hint: any, bytes: number) => {
      releaseHintCalled = true;
      await new Promise(r => setTimeout(r, 5000));
      return origReleaseHint(hint, bytes);
    };

    const receivedPromise = new Promise<string>((resolve) => {
      const unsub = receiverOrch.subscribe(() => {
        const posts = receiverOrch.getPosts();
        const found = posts.find(p => p.content === '爆速テストメッセージ');
        if (found) {
          unsub();
          resolve(found.content);
        }
      });
    });

    const startTime = performance.now();

    // 送信実行
    await senderOrch.submitReply('爆速テストメッセージ');
    const sendDuration = performance.now() - startTime;

    // 1. 送信処理自体が releaseHint の 5秒スリープでブロックされず即時完了したか
    expect(sendDuration).toBeLessThan(2000);

    // 2. 受信側への到達 (Gossip 直接配信経由) を待機
    const receivedContent = await Promise.race([
      receivedPromise,
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for gossip post')), 4000)),
    ]);

    const totalDuration = performance.now() - startTime;

    expect(receivedContent).toBe('爆速テストメッセージ');
    // releaseHint の 5秒を待たずに 3.5秒以内 (オニオン経由) で受信完了していること
    expect(totalDuration).toBeLessThan(3500);

    // エコー受信後にバックグラウンドで releaseHint が起動されたことを検証
    await new Promise<void>((resolve) => {
      if (releaseHintCalled) return resolve();
      const interval = setInterval(() => {
        if (releaseHintCalled) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
      setTimeout(() => { clearInterval(interval); resolve(); }, 1500);
    });
    expect(releaseHintCalled).toBe(true);

    senderOrch.clear();
    receiverOrch.clear();
  }, 10_000);

  it('BoardOrchestrator においても、スレッド作成パケットが releaseHint をブロックせず即時伝播する', async () => {
    const n0 = await createSimNode('n0');
    const n1 = await createSimNode('n1');
    const n2 = await createSimNode('n2');
    const n3 = await createSimNode('n3');
    nodes = [n0, n1, n2, n3];

    link(n0, n1);
    link(n1, n2);
    link(n2, n3);
    link(n1, n3);

    startAll(nodes);
    await sleep(100);

    const boardKey = sodium.randombytes_buf(32);
    const boardId = 'vip';

    const ctx0 = await createAppContext(n0, 'fast_board_db_0');
    const ctx3 = await createAppContext(n3, 'fast_board_db_3');

    const cryptoEngine = new CryptoEngine();
    const senderIdentity = new Identity();
    const receiverIdentity = new Identity();

    const senderBoard = new BoardOrchestrator(
      n0.peerManager,
      ctx0.db,
      ctx0.mailbox,
      n0.gossip,
      cryptoEngine,
      syncPow,
      senderIdentity,
      { isSubscribed: () => true, depth: 0 } as any,
      keyMgr,
      ctx0.schrodinger,
    );

    const receiverBoard = new BoardOrchestrator(
      n3.peerManager,
      ctx3.db,
      ctx3.mailbox,
      n3.gossip,
      cryptoEngine,
      syncPow,
      receiverIdentity,
      { isSubscribed: () => true, depth: 0 } as any,
      keyMgr,
      ctx3.schrodinger,
    );

    await receiverBoard.activate(boardId, boardKey);
    await senderBoard.activate(boardId, boardKey);

    // 送信側の releaseHint に意図的な遅延 (5秒) を注入
    let releaseHintCalled = false;
    const origReleaseHint = ctx0.schrodinger.releaseHint.bind(ctx0.schrodinger);
    ctx0.schrodinger.releaseHint = async (hint: any, bytes: number) => {
      releaseHintCalled = true;
      await new Promise(r => setTimeout(r, 5000));
      return origReleaseHint(hint, bytes);
    };

    const receivedThreadPromise = new Promise<string>((resolve) => {
      const unsub = receiverBoard.subscribe(() => {
        const threads = receiverBoard.getThreads();
        const found = threads.find(t => t.content === '新板テストスレ');
        if (found) {
          unsub();
          resolve(found.content);
        }
      });
    });

    const startTime = performance.now();

    const createdThreadId = await senderBoard.submitThread(boardId, boardKey, '新板テストスレ');
    const sendDuration = performance.now() - startTime;

    expect(createdThreadId).toBeDefined();
    expect(sendDuration).toBeLessThan(2000);

    const title = await Promise.race([
      receivedThreadPromise,
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for board thread')), 4000)),
    ]);

    expect(title).toBe('新板テストスレ');
    expect(performance.now() - startTime).toBeLessThan(3500);

    await new Promise<void>((resolve) => {
      if (releaseHintCalled) return resolve();
      const interval = setInterval(() => {
        if (releaseHintCalled) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
      setTimeout(() => { clearInterval(interval); resolve(); }, 1500);
    });
    expect(releaseHintCalled).toBe(true);

    senderBoard.clear();
    receiverBoard.clear();
  }, 10_000);
});
