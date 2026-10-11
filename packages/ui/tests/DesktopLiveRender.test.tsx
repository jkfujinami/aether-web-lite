// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import sodium from 'libsodium-wrappers-sumo';
import 'fake-indexeddb/auto';

import BoardView from '../src/components/BoardView';
import ThreadView from '../src/components/ThreadView';
import { P2PContextForTest } from '../src/providers/P2PProvider';
import {
  BoardOrchestrator,
  ThreadOrchestrator,
  ZoneGossipRouter,
  DHTMailbox,
  SyncProtocol,
  MessageDispatcher,
  CryptoEngine,
  Identity,
  KeyManager,
  PacketBuilder,
  PoWEngine,
  WireType,
  HintRouter,
  DandelionRouter,
  SchrodingerMailbox,
  buildHint,
  newMailboxSlot,
  encodeSlotBlob,
  JsonBinary,
  type IPeerManager,
  type IZoneManager,
  type IPoWEngine,
  type IKeyManager,
} from '@aether/core';

const ME = 'aa'.repeat(16);
const PEER = 'bb'.repeat(16);
const BOARD_ID = 'vip';
let BOARD_KEY: Uint8Array;

class FakeStore {
  public topics = new Map<string, Uint8Array[]>();
  async get(topicHash: string): Promise<Uint8Array[] | undefined> {
    return this.topics.get(topicHash);
  }
  async put(topicHash: string, entries: Uint8Array[]): Promise<void> {
    const list = this.topics.get(topicHash) || [];
    list.push(...entries);
    this.topics.set(topicHash, list);
  }
  async getPosts() { return []; }
  async getThreads() { return []; }
}

class FakePeerManager {
  public myPeerId = ME;
  public myPosition = 0.5;
  public peers = new Map();
  public degree = 1;
  private listeners = new Map<string, Array<(...args: any[]) => void>>();

  constructor() {
    this.peers.set(PEER, { peerId: PEER, isConnected: true, isVerified: true });
  }
  sendMessage() {}
  on(event: string, cb: any) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(cb);
  }
  off(event: string, cb: any) {
    const list = this.listeners.get(event) || [];
    this.listeners.set(event, list.filter(l => l !== cb));
  }
}

class FakeZoneManager {
  public depth = 0;
  isMyZone() { return true; }
  isSubscribed(_zoneId: number): boolean { return true; }
  filterPeersInZone() { return []; }
}

const syncPowEngine: IPoWEngine = {
  compute: async (h: any) => PoWEngine.computeSync(h),
};

const fakeKeyMgr: IKeyManager = {
  deriveThreadKey: KeyManager.deriveThreadKey,
  deriveTopicHash: KeyManager.deriveTopicHash,
  computeZoneId: KeyManager.computeZoneId,
};

function setupHarness() {
  const pm = new FakePeerManager() as unknown as IPeerManager;
  const dispatcher = new MessageDispatcher();
  const zm = new FakeZoneManager() as unknown as IZoneManager;
  const db = new FakeStore();
  const dandelion = new DandelionRouter(pm);
  // 送信は検証の対象外 (受信して描画されることだけを見る)。回路は送信を受け付けるだけのスタブ
  const circuit: any = { onExit: () => {}, send: async () => true, start: () => {}, stop: () => {} };
  const mailbox = new DHTMailbox(pm, dispatcher, db as any, circuit);
  const router = new ZoneGossipRouter(pm, dispatcher, zm, dandelion, circuit);
  const cryptoEng = new CryptoEngine();
  const identity = new Identity();
  const syncProtocol = new SyncProtocol(mailbox, cryptoEng, fakeKeyMgr, db as any);
  const hintRouter = new HintRouter(pm, dispatcher, dandelion, circuit);
  const schrodinger = new SchrodingerMailbox(mailbox, hintRouter, pm, 'disabled');

  const boardOrchestrator = new BoardOrchestrator(
    pm,
    db as any,
    mailbox,
    router,
    cryptoEng,
    syncPowEngine,
    identity,
    zm,
    fakeKeyMgr,
    schrodinger,
  );

  const threadOrchestrator = new ThreadOrchestrator(
    pm,
    db as any,
    mailbox,
    router,
    cryptoEng,
    syncPowEngine,
    identity,
    zm,
    fakeKeyMgr,
    syncProtocol,
    schrodinger,
  );

  return {
    ctx: {
      node: null,
      boardOrchestrator,
      threadOrchestrator,
      pm: pm as any,
      identity,
      db: null,
      isReady: true,
      lockState: 'ready',
      unlockError: null,
      unlock: async () => {},
      resetAll: async () => {},
      panicWipe: async () => {},
      lock: async () => {},
    },
    dispatcher,
    hintRouter,
    schrodinger,
    mailbox,
    db,
    boardOrchestrator,
    threadOrchestrator,
  };
}

function Wrap({ value, children }: { value: any; children: React.ReactNode }) {
  return <P2PContextForTest.Provider value={value}>{children}</P2PContextForTest.Provider>;
}

beforeAll(async () => {
  await sodium.ready;
  BOARD_KEY = KeyManager.cryptoHash(
    new TextEncoder().encode('AETHER_LITE_VIP_DEFAULT_SEED'),
  ).slice(0, 32);

  for (const m of ['log', 'warn', 'debug', 'error'] as const) {
    vi.spyOn(console, m).mockImplementation(() => {});
  }
  window.location.hash = `#board=${BOARD_ID}`;
});

afterEach(() => {
  cleanup();
});

describe('DesktopLiveRender: ネットワークから届いたパケットが DOM に描画されることの保証', () => {
  it('★Schrödinger Mailbox (Hint + Slot) 経由で届いたスレッドが確実に開封され DOM に現れる', async () => {
    const { ctx, hintRouter, db } = setupHarness();

    // 板の鍵の解決は非同期なので、描画に伴う effect の完了まで act の中で待つ
    await act(async () => {
      render(
        <Wrap value={ctx}>
          <BoardView boardId={BOARD_ID} />
        </Wrap>,
      );
    });

    expect(screen.queryByText('P2P Hint経由で受信した重要スレッド')).toBeNull();

    // 1. スレッドパケット本体を構築
    const packet = await PacketBuilder.build(
      'P2P Hint経由で受信した重要スレッド',
      BOARD_KEY,
      new Identity(),
      new CryptoEngine(),
      syncPowEngine,
      fakeKeyMgr,
      BOARD_ID,
      'thread-live-hint-001',
      0,
      null,
      8,
      0,
      1,
      [],
      'thread-live-hint-001',
      8,
    );
    const rawBody = new TextEncoder().encode(JsonBinary.stringify(packet));

    // 2. Mailbox Slot と Hint を作成
    const { nonce, mailboxKey } = newMailboxSlot();
    const payload = {
      nonce,
      message_id: 11223344,
      timestamp: Date.now(),
    };
    const hint = buildHint(BOARD_KEY, payload);

    // 3. 本体を Mailbox に保管 (ピアから Slot 複製が届いた状況)
    const slotBlob = encodeSlotBlob(hint, rawBody);
    const slotHashHex = KeyManager.toHex(mailboxKey);
    await db.put(slotHashHex, [slotBlob]);

    // 4. HintRouter に Hint が到着 (ingestLocal)
    await act(async () => {
      const opened = hintRouter.ingestLocal(hint);
      expect(opened).toBe(true); // 鍵が合っていれば確実に true
      await new Promise((r) => setTimeout(r, 60));
    });

    // 5. BoardView の DOM 上にスレッドタイトルが確実に描画されることを検証！
    await waitFor(() => {
      expect(screen.getByText('P2P Hint経由で受信した重要スレッド')).toBeTruthy();
    });
  });

  it('★鍵が異なる (別板/不正) Hint は開封されず DOM に現れない', async () => {
    const { ctx, hintRouter, db } = setupHarness();

    // 板の鍵の解決は非同期なので、描画に伴う effect の完了まで act の中で待つ
    await act(async () => {
      render(
        <Wrap value={ctx}>
          <BoardView boardId={BOARD_ID} />
        </Wrap>,
      );
    });

    const wrongKey = new Uint8Array(BOARD_KEY);
    wrongKey[0] ^= 0xaa; // 意図的に鍵を破壊

    const packet = await PacketBuilder.build(
      '不正な鍵のスレッド',
      wrongKey,
      new Identity(),
      new CryptoEngine(),
      syncPowEngine,
      fakeKeyMgr,
      BOARD_ID,
      'thread-bad-key',
      0,
      null,
      8,
      0,
      1,
      [],
      'thread-bad-key',
      8,
    );
    const rawBody = new TextEncoder().encode(JsonBinary.stringify(packet));

    const { nonce, mailboxKey } = newMailboxSlot();
    const hint = buildHint(wrongKey, { nonce, message_id: 999, timestamp: Date.now() });
    const slotBlob = encodeSlotBlob(hint, rawBody);
    await db.put(KeyManager.toHex(mailboxKey), [slotBlob]);

    await act(async () => {
      const opened = hintRouter.ingestLocal(hint);
      expect(opened).toBe(false); // 鍵が違えば絶対に開封されない
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(screen.queryByText('不正な鍵のスレッド')).toBeNull();
  });

  it('★Gossip で流れてきた新着スレッドがリアルタイムに DOM に反映される', async () => {
    const { ctx, dispatcher } = setupHarness();

    // 板の鍵の解決は非同期なので、描画に伴う effect の完了まで act の中で待つ
    await act(async () => {
      render(
        <Wrap value={ctx}>
          <BoardView boardId={BOARD_ID} />
        </Wrap>,
      );
    });

    const packet = await PacketBuilder.build(
      'Gossip生中継スレッド',
      BOARD_KEY,
      new Identity(),
      new CryptoEngine(),
      syncPowEngine,
      fakeKeyMgr,
      BOARD_ID,
      'thread-gossip-live',
      0,
      null,
      8,
      0,
      1,
      [],
      'thread-gossip-live',
      8,
    );

    await act(async () => {
      dispatcher.dispatch(PEER, WireType.GOSSIP, { packet });
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(screen.getByText('Gossip生中継スレッド')).toBeTruthy();
    });
  });

  it('★ThreadView において、後から届いたレスがリアルタイムに DOM に積み上がる', async () => {
    const { ctx, dispatcher } = setupHarness();
    const threadId = 'thread-live-target';
    const threadKey = KeyManager.deriveThreadKey(BOARD_KEY, threadId);

    // 板の鍵の解決は非同期なので、描画に伴う effect の完了まで act の中で待つ
    await act(async () => {
      render(
        <Wrap value={ctx}>
          <ThreadView boardId={BOARD_ID} threadId={threadId} />
        </Wrap>,
      );
    });

    const postPacket = await PacketBuilder.build(
      'リアルタイム着信レス: こんにちは',
      threadKey,
      new Identity(),
      new CryptoEngine(),
      syncPowEngine,
      fakeKeyMgr,
      BOARD_ID,
      threadId,
      0,
      null,
      8,
      0,
      0,
      [],
      threadId,
      8,
    );

    await act(async () => {
      dispatcher.dispatch(PEER, WireType.GOSSIP, { packet: postPacket });
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(screen.getByText(/リアルタイム着信レス/)).toBeTruthy();
    });
  });
});
