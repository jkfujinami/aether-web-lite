import { describe, it, expect, beforeAll } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { DandelionRouter } from '../../src/network/gossip/DandelionRouter';
import { HintRouter } from '../../src/network/hint/HintRouter';
import { MessageDispatcher } from '../../src/network/MessageDispatcher';
import { buildHint } from '../../src/network/hint/HintCrypto';
import { hintId } from '../../src/network/hint/HintPacket';
import { WireType } from '../../src/network/wire/WireTypes';
import { PeerMisbehaviorManager } from '../../src/network/PeerMisbehaviorManager';

/** 送ったものを記録するだけで、何も中継・エコーしない隣人群 */
function silentPeerManager(ids: string[]) {
  const sent: Array<{ to: string; type: number }> = [];
  const peers = new Map(ids.map(id => [id, {
    peerId: id, position: 0, rtt: 0, isConnected: true, isVerified: true,
    send: () => {}, close: () => {},
  }]));
  return {
    sent,
    misbehavior: new PeerMisbehaviorManager(),
    pm: {
      peers, myPeerId: 'f'.repeat(32), myPosition: 0,
      get degree() { return peers.size; },
      connect: () => undefined, disconnect: () => {},
      sendMessage: (to: string, type: number) => { sent.push({ to, type }); },
      on: () => {}, off: () => {},
    } as any,
  };
}

const IDS = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];

describe('Stem の Fail-Closed (C4 / H1)', () => {
  beforeAll(async () => {
    await sodiumReady;
  });

  it('Hint の Stem が失敗しても直接 HINT を flood しない', async () => {
    const env = silentPeerManager(IDS);
    const dandelion = new DandelionRouter(env.pm);
    dandelion.echoTimeoutMs = 20;
    const router = new HintRouter(env.pm, new MessageDispatcher(), dandelion);

    const hint = buildHint(sodium.randombytes_buf(32), {
      nonce: sodium.randombytes_buf(32), message_id: 1, timestamp: Date.now(),
    });
    const ok = await router.originate(hint, hintId(hint));

    expect(ok).toBe(false);
    expect(env.sent.filter(s => s.type === WireType.HINT)).toHaveLength(0);
    expect(env.sent.filter(s => s.type === WireType.HINT_STEM)).toHaveLength(1);
  });

  it('平文 Stem は再送せず、Stem 先を罰せず、エポックも引き直さない', async () => {
    const env = silentPeerManager(IDS);
    env.pm.misbehavior = env.misbehavior;
    const dandelion = new DandelionRouter(env.pm);
    dandelion.echoTimeoutMs = 20;

    const targets: string[] = [];
    expect(await dandelion.publishVia('x'.repeat(64), t => targets.push(t))).toBe(false);
    expect(await dandelion.publishVia('y'.repeat(64), t => targets.push(t))).toBe(false);

    // 1 回の発信につき 1 通だけ
    expect(targets).toHaveLength(2);
    // 失敗してもエポック対象は変わらない
    expect(targets[0]).toBe(targets[1]);
    // 無実の Stem 先にペナルティを付けない
    for (const id of IDS) expect(env.misbehavior.getScore(id)).toBe(0);
  });
});
