import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import 'fake-indexeddb/auto';

import { AetherNode } from '../src/node/AetherNode';
import { IndexedDBStore } from '../src/storage/IndexedDBStore';
import { KeyManager } from '../src/crypto/KeyManager';
import { installFakeWebRTC, resetFakeWebRTC } from './helpers/webrtc';
import { SignalingHub, HubSignalingClient } from './helpers/fakes';

describe('AetherNode Multi-Node End-to-End P2P Integration', () => {
  let hub: SignalingHub;

  beforeAll(async () => {
    await sodium.ready;
    installFakeWebRTC();
  });

  beforeEach(() => {
    resetFakeWebRTC();
    hub = new SignalingHub();
  });

  it('2つの完全な AetherNode (Alice & Bob) 間でスレッド作成とP2P同期が完結する', async () => {
    // 1. 各ノード専用の隔離された IndexedDB
    const dbAlice = new IndexedDBStore('AliceDB_' + Date.now());
    await dbAlice.init();
    const dbBob = new IndexedDBStore('BobDB_' + Date.now());
    await dbBob.init();

    // 2. 仮想シグナリングハブクライアントの準備
    let sigAlice: HubSignalingClient;
    let sigBob: HubSignalingClient;

    const nodeAlice = await AetherNode.create({
      db: dbAlice,
      releaseMode: 'instant',
      autoStart: false,
    });
    sigAlice = new HubSignalingClient(hub, nodeAlice.peerId);
    (nodeAlice.peerManager as any).signaling = sigAlice;
    sigAlice.on('relay', (sender: string, payload: any) => (nodeAlice.peerManager as any).handleRelay(sender, payload));

    const nodeBob = await AetherNode.create({
      db: dbBob,
      releaseMode: 'instant',
      autoStart: false,
    });
    sigBob = new HubSignalingClient(hub, nodeBob.peerId);
    (nodeBob.peerManager as any).signaling = sigBob;
    sigBob.on('relay', (sender: string, payload: any) => (nodeBob.peerManager as any).handleRelay(sender, payload));

    // PeerId が異なることを確認
    expect(nodeAlice.peerId).not.toBe(nodeBob.peerId);

    // 3. Alice から Bob へ P2P 接続要求
    nodeAlice.peerManager.connect(nodeBob.peerId, true);

    // ハンドシェイク完了を待機
    await new Promise((r) => setTimeout(r, 200));

    expect(nodeAlice.peerManager.peers.get(nodeBob.peerId)?.isConnected).toBe(true);
    expect(nodeBob.peerManager.peers.get(nodeAlice.peerId)?.isConnected).toBe(true);
    // DTLS 指紋に束縛された JOIN (v4) で相互に本人確認が済んでいること
    expect(nodeAlice.peerManager.peers.get(nodeBob.peerId)?.isVerified).toBe(true);
    expect(nodeBob.peerManager.peers.get(nodeAlice.peerId)?.isVerified).toBe(true);

    // 4. 板キーを共有して購読
    const boardId = 'vip';
    const boardKey = KeyManager.cryptoHash(new TextEncoder().encode('AETHER_LITE_VIP_DEFAULT_SEED')).slice(0, 32);

    nodeAlice.boardOrchestrator.activate(boardId, boardKey);
    nodeBob.boardOrchestrator.activate(boardId, boardKey);

    // 5. Alice がスレッドを投稿
    const threadTitle = 'AETHER P2P 統合テストスレッド (Alice発信)';
    const threadId = await nodeAlice.boardOrchestrator.submitThread(boardId, boardKey, threadTitle);
    expect(threadId).toBeTruthy();

    // 6. ゴシップ伝搬を待機
    await new Promise((r) => setTimeout(r, 400));

    // 7. Bob 側でスレッドが受信・検証され、BoardOrchestrator に反映されていることを確認
    const bobThreads = nodeBob.boardOrchestrator.getThreads();
    expect(bobThreads.some((t) => t.content === threadTitle)).toBe(true);

    // 8. 正常シャットダウン
    await nodeAlice.stop();
    await nodeBob.stop();
  });
});
