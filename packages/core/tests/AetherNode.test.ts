import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AetherNode } from '../src/node/AetherNode';
import { IndexedDBStore } from '../src/storage/IndexedDBStore';
import 'fake-indexeddb/auto';

describe('AetherNode Facade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('AetherNode インスタンスが全サブシステムを自動配線して生成される', async () => {
    const db = new IndexedDBStore();
    await db.init();

    const node = await AetherNode.create({
      db,
      signalingUrl: 'ws://localhost:9999/ws',
      releaseMode: 'instant',
      autoStart: false,
    });

    expect(node).toBeDefined();
    expect(typeof node.peerId).toBe('string');
    expect(node.peerId.length).toBe(32); // Hex 32 文字 (16 バイト PeerId)
    expect(node.degree).toBe(0);
    expect(node.running).toBe(false);

    // 主要サブシステムが注入されているか
    expect(node.boardOrchestrator).toBeDefined();
    expect(node.threadOrchestrator).toBeDefined();
    expect(node.mailbox).toBeDefined();
    expect(node.schrodinger).toBeDefined();
    expect(node.dandelion).toBeDefined();
    expect(node.peerManager).toBeDefined();
    expect(node.zoneManager).toBeDefined();

    // 停止処理の呼び出し確認
    await node.stop();
    expect(node.running).toBe(false);
  });
});
