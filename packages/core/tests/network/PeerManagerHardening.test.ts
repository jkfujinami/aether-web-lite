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

  it('検証済みピアが壊れたワイヤデータを送ったら即座にBANし切断する', () => {
    const verifiedPeer: any = { isVerified: true, isConnected: true, close: vi.fn() };
    (peerManagerA as any)._peers.set(BAD_PEER_ID, verifiedPeer);

    (peerManagerA as any).handleData(BAD_PEER_ID, new Uint8Array([0x99, 0xff, 0x00]));

    expect(peerManagerA.misbehavior.isBanned(BAD_PEER_ID)).toBe(true);
    expect(peerManagerA.peers.has(BAD_PEER_ID)).toBe(false);
  });

  it('未検証の接続が壊れたデータを送っても、名乗られた ID は BAN せず切断だけする', () => {
    const unverified: any = { isVerified: false, isConnected: true, close: vi.fn() };
    (peerManagerA as any)._peers.set(BAD_PEER_ID, unverified);

    (peerManagerA as any).handleData(BAD_PEER_ID, new Uint8Array([0x99, 0xff, 0x00]));

    expect(peerManagerA.misbehavior.isBanned(BAD_PEER_ID)).toBe(false);
    expect(peerManagerA.peers.has(BAD_PEER_ID)).toBe(false);
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

  it('JOIN時に名乗りと接続IDが不一致なら切断するが、名乗られた ID は BAN しない', () => {
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

    expect(fakePeer.markVerified).not.toHaveBeenCalled();
    expect(peerManagerA.peers.has(BAD_PEER_ID)).toBe(false);
    // 接続の peerId はシグナリングで名乗られただけの値。第三者を陥れられないこと
    expect(peerManagerA.misbehavior.isBanned(BAD_PEER_ID)).toBe(false);
  });

  it('検証済みの生きた接続は、同じ ID を名乗る offer で置き換えられない', () => {
    const VICTIM = 'abc00000000000000000000000000001';
    const live: any = { peerId: VICTIM, isVerified: true, isConnected: true, close: vi.fn(), signal: vi.fn() };
    (peerManagerA as any)._peers.set(VICTIM, live);

    (peerManagerA as any).handleRelay(VICTIM, { type: 'sdp-relay', sdp: { type: 'offer', sdp: 'x' } });

    expect(live.close).not.toHaveBeenCalled();
    expect(peerManagerA.peers.get(VICTIM)).toBe(live);
  });

  it('ハンドシェイク未完了の接続数に上限があり、乱数 ID の offer で無制限に増えない', () => {
    (globalThis as any).RTCPeerConnection = class {
      createDataChannel() { return {}; }
      createOffer() { return new Promise(() => {}); }
      close() {}
    };
    for (let i = 0; i < 50; i++) {
      peerManagerA.connect(i.toString(16).padStart(32, '0'), true);
    }
    expect(peerManagerA.peers.size).toBeLessThanOrEqual(8);
    delete (globalThis as any).RTCPeerConnection;
  });
});
