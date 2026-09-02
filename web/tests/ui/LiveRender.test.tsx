// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import sodium from 'libsodium-wrappers-sumo';

import BoardView from '@/components/BoardView';
import ThreadView from '@/components/ThreadView';
import { P2PContextForTest } from '@/providers/P2PProvider';
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
import { FakePeerManager, FakeZoneManager, FakeStore } from '../helpers/fakes';
import { syncPowEngine, keyMgr } from '../helpers/packets';

/**
 * ★ React の描画そのものを検証する。
 *
 * これまでオーケストレータ層までしかテストしておらず、
 * 「ストアは更新されたのに画面が変わらない」という経路が丸ごと素通しだった。
 * ここでは実際にコンポーネントをマウントし、
 * **開いたまま届いたゴシップが DOM に現れるか**を確認する。
 */

const ME = 'aa'.repeat(16);
const PEER = 'bb'.repeat(16);
const BOARD_ID = 'vip';
// sodium.ready より前に評価されないよう遅延させる
let BOARD_KEY: Uint8Array;

class FakeDb extends FakeStore {
  posts: any[] = [];
  async save(p: any) { this.posts.push({ ...p, timestamp: Date.now() }); }
  async getPosts() { return this.posts; }
  async getThreads() { return []; }
  async getRecentTimestamps() { return []; }
}

function makeCtx() {
  const pm = new FakePeerManager(ME);
  pm.addPeer(PEER, { verified: true, connected: true });
  const dispatcher = new MessageDispatcher();
  const zm = new FakeZoneManager();
  const router = new ZoneGossipRouter(pm, dispatcher, zm);
  const db = new FakeDb();
  const mailbox = new DHTMailbox(pm, dispatcher, db as any);
  const cryptoEng = new CryptoEngine();
  const identity = new Identity();
  const syncProtocol = new SyncProtocol(mailbox, cryptoEng, keyMgr, db as any);

  const boardOrchestrator = new BoardOrchestrator(
    pm as any, db as any, mailbox, router, cryptoEng, syncPowEngine, identity, zm, keyMgr,
  );
  const threadOrchestrator = new ThreadOrchestrator(
    pm as any, db as any, mailbox, router, cryptoEng, syncPowEngine, identity, zm, keyMgr, syncProtocol,
  );

  return {
    ctx: {
      pm: pm as any, db: db as any, identity, mailbox, cryptoEng,
      powEng: syncPowEngine, keyMgr, syncProtocol, router, zm,
      boardOrchestrator, threadOrchestrator, isReady: true,
    },
    dispatcher,
  };
}

function Wrap({ value, children }: { value: any; children: React.ReactNode }) {
  return <P2PContextForTest.Provider value={value}>{children}</P2PContextForTest.Provider>;
}

async function buildThreadMeta(threadId: string, title: string) {
  return PacketBuilder.build(
    title, BOARD_KEY, new Identity(), new CryptoEngine(),
    syncPowEngine, keyMgr, BOARD_ID, threadId, 0, null, 8, 0, 1, [], threadId, 8,
  );
}

async function buildPost(threadId: string, content: string) {
  const threadKey = KeyManager.deriveThreadKey(BOARD_KEY, threadId);
  return PacketBuilder.build(
    content, threadKey, new Identity(), new CryptoEngine(),
    syncPowEngine, keyMgr, BOARD_ID, threadId, 0, null, 8, 0, 0, [], threadId, 8,
  );
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

afterEach(() => cleanup());

describe('★BoardView: 開いたまま届いたスレッドが画面に出る', () => {
  it('★ゴシップで届いたスレッドが DOM に現れる', async () => {
    const { ctx, dispatcher } = makeCtx();
    render(<Wrap value={ctx}><BoardView boardId={BOARD_ID} /></Wrap>);

    // 最初は何も無い
    expect(screen.queryByText('ライブで来たスレ')).toBeNull();

    const packet = await buildThreadMeta('t-live', 'ライブで来たスレ');
    await act(async () => {
      dispatcher.dispatch(PEER, WireType.GOSSIP, { packet });
      await new Promise((r) => setTimeout(r, 30));
    });

    // ★ 再マウントせずに DOM へ反映されること
    await waitFor(() => expect(screen.getByText('ライブで来たスレ')).toBeTruthy());
  });

  it('★続けて届いた 2 件目も追加で表示される', async () => {
    const { ctx, dispatcher } = makeCtx();
    render(<Wrap value={ctx}><BoardView boardId={BOARD_ID} /></Wrap>);

    for (const [id, title] of [['t1', '1本目'], ['t2', '2本目']] as const) {
      const packet = await buildThreadMeta(id, title);
      await act(async () => {
        dispatcher.dispatch(PEER, WireType.GOSSIP, { packet });
        await new Promise((r) => setTimeout(r, 30));
      });
    }

    await waitFor(() => {
      expect(screen.getByText('1本目')).toBeTruthy();
      expect(screen.getByText('2本目')).toBeTruthy();
    });
  });

  it('★偽造パケットは画面に出ない', async () => {
    const { ctx, dispatcher } = makeCtx();
    render(<Wrap value={ctx}><BoardView boardId={BOARD_ID} /></Wrap>);

    const packet = await buildThreadMeta('t-bad', 'にせもの');
    await act(async () => {
      dispatcher.dispatch(PEER, WireType.GOSSIP, { packet: { ...packet, pow_difficulty: 0 } });
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(screen.queryByText('にせもの')).toBeNull();
  });
});

describe('★ThreadView: 開いたまま届いたレスが画面に出る', () => {
  it('★ゴシップで届いたレスが DOM に現れる', async () => {
    const { ctx, dispatcher } = makeCtx();
    render(<Wrap value={ctx}><ThreadView boardId={BOARD_ID} threadId="t1" /></Wrap>);

    expect(screen.queryByText('ライブで来たレス')).toBeNull();

    const packet = await buildPost('t1', 'ライブで来たレス');
    await act(async () => {
      dispatcher.dispatch(PEER, WireType.GOSSIP, { packet });
      await new Promise((r) => setTimeout(r, 30));
    });

    await waitFor(() => expect(screen.getByText('ライブで来たレス')).toBeTruthy());
  });

  it('★複数のレスが順に積み上がる', async () => {
    const { ctx, dispatcher } = makeCtx();
    render(<Wrap value={ctx}><ThreadView boardId={BOARD_ID} threadId="t1" /></Wrap>);

    for (const text of ['いちばん', 'にばん', 'さんばん']) {
      const packet = await buildPost('t1', text);
      await act(async () => {
        dispatcher.dispatch(PEER, WireType.GOSSIP, { packet });
        await new Promise((r) => setTimeout(r, 30));
      });
    }

    await waitFor(() => {
      expect(screen.getByText('いちばん')).toBeTruthy();
      expect(screen.getByText('にばん')).toBeTruthy();
      expect(screen.getByText('さんばん')).toBeTruthy();
    });
  });

  it('★別スレッド宛のレスは混ざらない', async () => {
    const { ctx, dispatcher } = makeCtx();
    render(<Wrap value={ctx}><ThreadView boardId={BOARD_ID} threadId="t1" /></Wrap>);

    const packet = await buildPost('t2', 'よそのスレのレス');
    await act(async () => {
      dispatcher.dispatch(PEER, WireType.GOSSIP, { packet });
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(screen.queryByText('よそのスレのレス')).toBeNull();
  });
});

describe('★購読の張り直し', () => {
  it('★アンマウント → 再マウント後もライブ更新が届く', async () => {
    const { ctx, dispatcher } = makeCtx();

    const first = render(<Wrap value={ctx}><BoardView boardId={BOARD_ID} /></Wrap>);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    first.unmount();

    render(<Wrap value={ctx}><BoardView boardId={BOARD_ID} /></Wrap>);

    const packet = await buildThreadMeta('t-remount', '再マウント後のスレ');
    await act(async () => {
      dispatcher.dispatch(PEER, WireType.GOSSIP, { packet });
      await new Promise((r) => setTimeout(r, 30));
    });

    await waitFor(() => expect(screen.getByText('再マウント後のスレ')).toBeTruthy());
  });

  it('★StrictMode の二重マウントでも 1 回だけ表示される', async () => {
    const { ctx, dispatcher } = makeCtx();
    render(
      <React.StrictMode>
        <Wrap value={ctx}><BoardView boardId={BOARD_ID} /></Wrap>
      </React.StrictMode>,
    );

    const packet = await buildThreadMeta('t-strict', 'StrictMode のスレ');
    await act(async () => {
      dispatcher.dispatch(PEER, WireType.GOSSIP, { packet });
      await new Promise((r) => setTimeout(r, 30));
    });

    await waitFor(() => expect(screen.getAllByText('StrictMode のスレ')).toHaveLength(1));
  });
});
