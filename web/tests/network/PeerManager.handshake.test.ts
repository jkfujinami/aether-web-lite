import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { PeerManager } from '@/lib/network/PeerManager';
import { MessageDispatcher } from '@/lib/network/MessageDispatcher';
import { NodeIdentity, NODE_ID_POW_FAST } from '@/lib/crypto/NodeIdentity';
import { RingPosition } from '@/lib/network/RingPosition';
import { RateLimiter } from '@/lib/network/RateLimiter';
import { WireType } from '@/lib/network/wire/WireTypes';
import { WireCodec } from '@/lib/network/wire/WireCodec';
import { SignalingHub, HubSignalingClient } from '../helpers/fakes';
import { installFakeWebRTC, resetFakeWebRTC } from '../helpers/webrtc';

const PARAMS = NODE_ID_POW_FAST;

interface Node {
  identity: NodeIdentity;
  pm: PeerManager;
  dispatcher: MessageDispatcher;
  signaling: HubSignalingClient;
  received: Array<{ from: string; type: number; payload: any }>;
}

let hub: SignalingHub;
let alice: NodeIdentity;
let bob: NodeIdentity;
let mallory: NodeIdentity;

beforeAll(async () => {
  await sodium.ready;
  installFakeWebRTC();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  alice = await NodeIdentity.mine(PARAMS);
  bob = await NodeIdentity.mine(PARAMS);
  mallory = await NodeIdentity.mine(PARAMS);
});

beforeEach(() => {
  resetFakeWebRTC();
  hub = new SignalingHub();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeNode(identity: NodeIdentity, rateLimiter?: RateLimiter): Node {
  const dispatcher = new MessageDispatcher();
  const signaling = new HubSignalingClient(hub, identity.peerId);
  const pm = new PeerManager(identity, dispatcher, signaling, { powParams: PARAMS, rateLimiter });
  const received: Node['received'] = [];
  for (const type of [WireType.GOSSIP, WireType.PEX_REQUEST, WireType.DHT_PUT]) {
    dispatcher.register(type, (from, payload) => received.push({ from, type, payload }));
  }
  return { identity, pm, dispatcher, signaling, received };
}

/** マイクロタスクとタイマーを流し切る */
async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('Bound Identity ハンドシェイク (正常系)', () => {
  it('2 ノードが接続し、双方が相手を verified にする', async () => {
    const a = makeNode(alice);
    const b = makeNode(bob);

    a.pm.connect(bob.peerId, true);
    await settle();

    const aSeesB = a.pm.peers.get(bob.peerId);
    const bSeesA = b.pm.peers.get(alice.peerId);

    expect(aSeesB?.isConnected).toBe(true);
    expect(bSeesA?.isConnected).toBe(true);
    expect(aSeesB?.isVerified).toBe(true);
    expect(bSeesA?.isVerified).toBe(true);
  });

  it('★座標は申告ではなく peerId から導出される', async () => {
    const a = makeNode(alice);
    makeNode(bob);

    a.pm.connect(bob.peerId, true);
    await settle();

    const aSeesB = a.pm.peers.get(bob.peerId)!;
    expect(aSeesB.position).toBe(RingPosition.forPeer(bob.peerId));
    expect(aSeesB.position).toBe(bob.position);
  });

  it('ハンドシェイク後は通常メッセージが通る', async () => {
    const a = makeNode(alice);
    const b = makeNode(bob);

    a.pm.connect(bob.peerId, true);
    await settle();

    a.pm.sendMessage(bob.peerId, WireType.PEX_REQUEST, { minDistance: 0 });
    await settle(5);

    expect(b.received.some((m) => m.type === WireType.PEX_REQUEST)).toBe(true);
  });

  it('SDP リレーに position / zones が載っていない', async () => {
    const a = makeNode(alice);
    makeNode(bob);

    a.pm.connect(bob.peerId, true);
    await settle();

    expect(hub.relayed.length).toBeGreaterThan(0);
    for (const { payload } of hub.relayed) {
      expect(payload).not.toHaveProperty('position');
      expect(payload).not.toHaveProperty('zones');
    }
  });
});

describe('★A級#6: Eclipse / なりすまし', () => {
  it('★他人の peerId を名乗る JOIN を拒否して切断する', async () => {
    const a = makeNode(alice);
    const m = makeNode(mallory);

    // mallory が alice に接続する
    m.pm.connect(alice.peerId, true);
    await settle();
    expect(a.pm.peers.get(mallory.peerId)?.isVerified).toBe(true);

    // その接続の上で bob になりすました JOIN を送り込む
    const peer = a.pm.peers.get(mallory.peerId)!;
    const challenge = (peer as any).challenge as Uint8Array;
    const forged = { ...bob.signClaim(challenge) };

    a.dispatcher.dispatch(mallory.peerId, WireType.JOIN, forged);
    await settle(3);

    // 接続の相手 (mallory) と名乗った identity (bob) が食い違うので切断される。
    // 重要なのは「bob として登録されない」こと。
    expect(a.pm.peers.has(bob.peerId)).toBe(false);
  });

  it('★他人の公開鍵を貼り付けただけの JOIN を拒否する (秘密鍵を持っていない)', async () => {
    const a = makeNode(alice);

    // bob 宛の接続を作り、こちらが出したチャレンジを確定させる
    const peer = a.pm.connect(bob.peerId, true)!;
    const challenge = NodeIdentity.newChallenge();
    peer.setChallenge(challenge);

    // 公開鍵と peerId は bob のものだが、署名は mallory の鍵で作る
    const forged = {
      peerId: bob.peerId,
      pubkey: bob.pubkey,
      powCounter: bob.powCounter,
      challenge,
      signature: mallory.signClaim(challenge).signature,
    };

    a.dispatcher.dispatch(bob.peerId, WireType.JOIN, forged);
    await settle(3);

    expect(a.pm.peers.get(bob.peerId)).toBeUndefined();
  });

  it('★傍受した JOIN の再生 (replay) を拒否する', async () => {
    const a = makeNode(alice);
    const b = makeNode(bob);

    // 正規の接続を作り、そこで使われた JOIN を「傍受」する
    a.pm.connect(bob.peerId, true);
    await settle();
    const capturedChallenge = (a.pm.peers.get(bob.peerId) as any).challenge as Uint8Array;
    const capturedJoin = bob.signClaim(capturedChallenge);

    // 別の接続 (mallory → alice) でその JOIN をそのまま流す
    const a2 = makeNode(alice);
    const m = makeNode(mallory);
    m.pm.connect(alice.peerId, true);
    await settle();

    a2.dispatcher.dispatch(mallory.peerId, WireType.JOIN, capturedJoin);
    await settle(3);

    expect(a2.pm.peers.has(bob.peerId)).toBe(false);
    void b;
  });

  it('★NodeId PoW を満たさない identity を拒否する', async () => {
    const a = makeNode(alice);

    // PoW を解いていない鍵ペアを作る
    let bad: NodeIdentity | null = null;
    for (let i = 0; i < 300; i++) {
      const kp = sodium.crypto_sign_keypair();
      const candidate = NodeIdentity.fromKeyPair(kp.publicKey, kp.privateKey, 0);
      if (!NodeIdentity.verifyClaim(candidate.claim(), PARAMS)) { bad = candidate; break; }
    }
    expect(bad).not.toBeNull();

    const peer = a.pm.connect(bad!.peerId, true)!;
    const challenge = NodeIdentity.newChallenge();
    peer.setChallenge(challenge);

    // 署名も peerId も正しいが、NodeId PoW を解いていない
    a.dispatcher.dispatch(bad!.peerId, WireType.JOIN, bad!.signClaim(challenge));
    await settle(3);

    expect(a.pm.peers.get(bad!.peerId)).toBeUndefined();
  });

  it('★形式が不正な peerId への接続を拒否する', () => {
    const a = makeNode(alice);
    expect(a.pm.connect('short', true)).toBeUndefined();
    expect(a.pm.connect('ZZ'.repeat(16), true)).toBeUndefined();
    expect(a.pm.connect('ab'.repeat(20), true)).toBeUndefined();
    expect(a.pm.connect(alice.peerId, true)).toBeUndefined(); // 自分自身
    expect(a.pm.peers.size).toBe(0);
  });

  it('★トラッカーから壊れた peerId を渡されても接続しない', async () => {
    const a = makeNode(alice);
    a.signaling.emitPeers([
      { peerId: 'not-a-peer-id' },
      { peerId: '' },
      { peerId: 'ff'.repeat(40) },
    ] as any);
    await settle(3);
    expect(a.pm.peers.size).toBe(0);
  });
});

describe('★ハンドシェイク未完了ピアの遮断', () => {
  it('検証前のピアからの GOSSIP はディスパッチされない', async () => {
    const a = makeNode(alice);

    // 接続だけ作り、JOIN を返さない相手を用意する
    a.pm.connect(bob.peerId, true);
    await settle(2);
    const peer = a.pm.peers.get(bob.peerId);
    if (!peer) return;
    expect(peer.isVerified).toBe(false);

    // 検証前に GOSSIP を撃ち込む
    const frame = WireCodec.encode(WireType.GOSSIP, { packet: { packet_id: 'x' } });
    (a.pm as any).handleData(bob.peerId, frame);
    await settle(2);

    expect(a.received).toHaveLength(0);
  });

  it('HELLO と JOIN は検証前でも通る (でないとハンドシェイクが成立しない)', async () => {
    const a = makeNode(alice);
    const peer = a.pm.connect(bob.peerId, true)!;
    const challenge = NodeIdentity.newChallenge();
    peer.setChallenge(challenge);
    expect(peer.isVerified).toBe(false);

    // handleData を通す = レート制限と「未検証は遮断」の両方を通過させる
    const frame = WireCodec.encode(WireType.JOIN, bob.signClaim(challenge));
    (a.pm as any).handleData(bob.peerId, frame);
    await settle(2);

    expect(a.pm.peers.get(bob.peerId)?.isVerified).toBe(true);
  });

  it('HELLO を受けたら署名済み JOIN を返す', async () => {
    const a = makeNode(alice);
    const b = makeNode(bob);
    a.pm.connect(bob.peerId, true);
    await settle();

    // 双方が verified になっている = 互いに HELLO→JOIN が成立した
    expect(a.pm.peers.get(bob.peerId)?.isVerified).toBe(true);
    expect(b.pm.peers.get(alice.peerId)?.isVerified).toBe(true);
  });
});

describe('★A級#8: レート制限', () => {
  it('隣人 1 人からのフラッドが頭打ちになる', async () => {
    const limiter = new RateLimiter({ gossip: { ratePerSec: 1, burst: 5 } }, () => 1000);
    const a = makeNode(alice, limiter);
    const b = makeNode(bob);

    a.pm.connect(bob.peerId, true);
    await settle();
    expect(a.pm.peers.get(bob.peerId)?.isVerified).toBe(true);

    const frame = WireCodec.encode(WireType.GOSSIP, { packet: { packet_id: 'x' } });
    for (let i = 0; i < 1000; i++) {
      (a.pm as any).handleData(bob.peerId, frame);
    }
    await settle(3);

    // burst=5 を超えて処理されない
    expect(a.received.length).toBeLessThanOrEqual(5);
    void b;
  });

  it('攻撃者がゴシップを使い切っても、別カテゴリの正常な通信は通る', async () => {
    const limiter = new RateLimiter(
      { gossip: { ratePerSec: 1, burst: 2 }, pex: { ratePerSec: 1, burst: 5 } },
      () => 1000,
    );
    const a = makeNode(alice, limiter);
    makeNode(bob);

    a.pm.connect(bob.peerId, true);
    await settle();

    const gossipFrame = WireCodec.encode(WireType.GOSSIP, { packet: { packet_id: 'x' } });
    for (let i = 0; i < 100; i++) (a.pm as any).handleData(bob.peerId, gossipFrame);

    const pexFrame = WireCodec.encode(WireType.PEX_REQUEST, { minDistance: 0 });
    (a.pm as any).handleData(bob.peerId, pexFrame);
    await settle(3);

    expect(a.received.filter((m) => m.type === WireType.PEX_REQUEST)).toHaveLength(1);
  });

  it('切断でレートリミッタの状態が解放される', async () => {
    const limiter = new RateLimiter({ gossip: { ratePerSec: 1, burst: 2 } }, () => 1000);
    const a = makeNode(alice, limiter);
    a.pm.connect(bob.peerId, true);
    await settle();

    expect(limiter.allow(bob.peerId, 'gossip')).toBe(true);
    expect(limiter.allow(bob.peerId, 'gossip')).toBe(true);
    expect(limiter.allow(bob.peerId, 'gossip')).toBe(false);

    a.pm.disconnect(bob.peerId);
    expect(limiter.allow(bob.peerId, 'gossip')).toBe(true);
  });
});

describe('トラッカーへの join', () => {
  it('claim だけを送り、position / zones は送らない', async () => {
    const a = makeNode(alice);
    await a.pm.start();

    const sent = a.signaling.connectedWith;
    expect(sent?.claim.peerId).toBe(alice.peerId);
    expect(sent?.claim.pubkey).toEqual(alice.pubkey);
    expect(sent?.claim).not.toHaveProperty('position');
    expect(sent?.claim).not.toHaveProperty('zones');
  });
});

describe('★同一 peerId での張り直し (Bound Identity の副作用)', () => {
  it('★再 offer が来たら古い接続を畳んで作り直す', async () => {
    const a = makeNode(alice);

    // 1 回目の接続 (bob からの offer)
    a.pm['handleRelay'](bob.peerId, {
      type: 'sdp-relay',
      senderId: bob.peerId,
      sdp: { type: 'offer', sdp: 'v=0 first' },
    });
    await settle(2);
    const first = a.pm.peers.get(bob.peerId);
    expect(first).toBeTruthy();

    // bob がリロードして同じ peerId で再 offer
    a.pm['handleRelay'](bob.peerId, {
      type: 'sdp-relay',
      senderId: bob.peerId,
      sdp: { type: 'offer', sdp: 'v=0 second' },
    });
    await settle(2);
    const second = a.pm.peers.get(bob.peerId);

    expect(second).toBeTruthy();
    // 古いインスタンスは捨てられ、別のオブジェクトになっている
    expect(second).not.toBe(first);
  });

  it('★張り直した接続は未検証から始まる', async () => {
    // ここが緩いと、ハンドシェイクを一度も通していない新しい接続が
    // 「検証済み」として扱われ、なりすましの入口になる。
    const a = makeNode(alice);

    const peer = a.pm.connect(bob.peerId, true)!;
    const challenge = NodeIdentity.newChallenge();
    peer.setChallenge(challenge);
    a.dispatcher.dispatch(bob.peerId, WireType.JOIN, bob.signClaim(challenge));
    await settle(2);
    expect(a.pm.peers.get(bob.peerId)?.isVerified).toBe(true);

    // 同じ peerId で再 offer
    a.pm['handleRelay'](bob.peerId, {
      type: 'sdp-relay',
      senderId: bob.peerId,
      sdp: { type: 'offer', sdp: 'v=0 restart' },
    });
    await settle(2);

    expect(a.pm.peers.get(bob.peerId)?.isVerified).toBe(false);
  });

  it('ICE candidate では張り直さない (offer のときだけ)', async () => {
    const a = makeNode(alice);
    a.pm['handleRelay'](bob.peerId, {
      type: 'sdp-relay',
      senderId: bob.peerId,
      sdp: { type: 'offer', sdp: 'v=0' },
    });
    await settle(2);
    const first = a.pm.peers.get(bob.peerId);

    a.pm['handleRelay'](bob.peerId, {
      type: 'ice-relay',
      senderId: bob.peerId,
      candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 1 typ host' },
    });
    await settle(2);

    expect(a.pm.peers.get(bob.peerId)).toBe(first);
  });

  it('answer では張り直さない (自分が出した offer への応答なので)', async () => {
    const a = makeNode(alice);
    const first = a.pm.connect(bob.peerId, true);

    a.pm['handleRelay'](bob.peerId, {
      type: 'sdp-relay',
      senderId: bob.peerId,
      sdp: { type: 'answer', sdp: 'v=0 answer' },
    });
    await settle(2);

    expect(a.pm.peers.get(bob.peerId)).toBe(first);
  });

  it('張り直し時にクールダウンで弾かれない', async () => {
    const a = makeNode(alice);
    a.pm['handleRelay'](bob.peerId, {
      type: 'sdp-relay',
      senderId: bob.peerId,
      sdp: { type: 'offer', sdp: 'v=0 first' },
    });
    await settle(2);

    // 立て続けに再 offer しても毎回作り直せる
    for (let i = 0; i < 3; i++) {
      a.pm['handleRelay'](bob.peerId, {
        type: 'sdp-relay',
        senderId: bob.peerId,
        sdp: { type: 'offer', sdp: `v=0 retry${i}` },
      });
      await settle(2);
      expect(a.pm.peers.get(bob.peerId), `retry ${i}`).toBeTruthy();
    }
  });
});
