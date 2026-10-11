import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PeerManager } from '../../src/network/PeerManager';
import { MessageDispatcher } from '../../src/network/MessageDispatcher';
import { NodeIdentity } from '../../src/crypto/NodeIdentity';
import { ViolationType } from '../../src/network/PeerMisbehaviorManager';
import { WireType } from '../../src/network/wire/WireTypes';
import { WireCodec } from '../../src/network/wire/WireCodec';

describe('PeerManager 要塞化 (Hardening Integration Tests)', () => {
  let identityA: NodeIdentity;
  let dispatcherA: MessageDispatcher;
  let mockSignaling: any;
  let peerManagerA: PeerManager;

  const BAD_PEER_ID = 'bad00000000000000000000000000001';

  beforeEach(async () => {
    identityA = await NodeIdentity.mine({ difficulty: 0, opsLimit: 1, memLimit: 8192 });
    dispatcherA = new MessageDispatcher();
    mockSignaling = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      sendRelay: vi.fn(),
      on: vi.fn(),
      isConnected: false,
    };

    peerManagerA = new PeerManager(identityA, dispatcherA, mockSignaling, {
      powParams: { timeCost: 1, memoryCostKiB: 64, parallelism: 1, difficultyBits: 0 },
    });
  });

  it('壊れたワイヤデータ (MALFORMED_WIRE) を受信したピアを即座にBANし切断する', () => {
    expect(peerManagerA.misbehavior.isBanned(BAD_PEER_ID)).toBe(false);

    // 未知のワイヤメッセージ (WireType.UNKNOWN = 0) を送信
    const invalidData = new Uint8Array([0x99, 0xff, 0x00]); // 壊れたエンコーディング

    (peerManagerA as any).handleData(BAD_PEER_ID, invalidData);

    // 即時BANされていること
    expect(peerManagerA.misbehavior.isBanned(BAD_PEER_ID)).toBe(true);
  });

  it('BANされたピアに対する新規接続の試行を拒絶する', () => {
    peerManagerA.misbehavior.banPeer(BAD_PEER_ID, 10000, 'Test pre-ban');
    expect(peerManagerA.misbehavior.isBanned(BAD_PEER_ID)).toBe(true);

    const peer = peerManagerA.connect(BAD_PEER_ID, true);
    expect(peer).toBeUndefined();
  });

  it('BANされたピアからのリレーメッセージをサイレントに無視する', () => {
    peerManagerA.misbehavior.banPeer(BAD_PEER_ID, 10000, 'Test ban');

    // handleRelay を呼んでも接続処理が走らないこと
    (peerManagerA as any).handleRelay(BAD_PEER_ID, {
      type: 'offer',
      sdp: { type: 'offer', sdp: 'fake-sdp' },
    });

    expect(peerManagerA.peers.has(BAD_PEER_ID)).toBe(false);
  });

  it('JOIN時に名乗りと接続IDが不一致のピアを即時BANする', () => {
    const fakePeer: any = {
      isVerified: false,
      challenge: new Uint8Array(32),
      markVerified: vi.fn(),
      close: vi.fn(),
    };
    (peerManagerA as any)._peers.set(BAD_PEER_ID, fakePeer);

    (peerManagerA as any).handleJoin(BAD_PEER_ID, {
      peerId: 'spoofed0000000000000000000000002', // 詐称ID
      pubkey: new Uint8Array(32),
      powCounter: 0,
      challenge: new Uint8Array(32),
      signature: new Uint8Array(64),
    });

    expect(peerManagerA.misbehavior.isBanned(BAD_PEER_ID)).toBe(true);
  });
});
