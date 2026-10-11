import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { MessageDispatcher } from '../../src/network/MessageDispatcher';
import { WireType } from '../../src/network/wire/WireTypes';
import { HintRouter, RECENT_HINT_BUFFER, type OpenedHint } from '../../src/network/hint/HintRouter';
import { HINT_CIPHERTEXT_SIZE, HINT_VERSION, type HintPacket } from '../../src/network/hint/HintPacket';
import { FakeCircuit, FakeDandelion, FakePeerManager, fixedHint } from '../helpers/hintMailboxFakes';

/**
 * 保持バッファの上限を数千件の Hint で確かめるため、このファイルでだけ
 * Hint の PoW 検証を無効化する (難易度 12 を数千回解くと遅すぎる)。
 * PoW の拒否そのものは HintRouter.test.ts / HintPacket.test.ts で検証している。
 */
vi.mock('../../src/network/hint/HintPacket', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/network/hint/HintPacket')>();
  return { ...mod, verifyHintPow: () => true };
});

const ME = 'me'.padEnd(32, '0');
const A = 'aa'.padEnd(32, '1');
let K: Uint8Array;
const routers: HintRouter[] = [];

/** 誰の鍵でも開かない、形だけ正しいランダムな Hint */
function randomHint(): HintPacket {
  return {
    version: HINT_VERSION,
    ttl: 8,
    blind_tag: sodium.randombytes_buf(4),
    nonce: sodium.randombytes_buf(12),
    pow_nonce: 0,
    ciphertext: sodium.randombytes_buf(HINT_CIPHERTEXT_SIZE),
  };
}

function setup() {
  const pm = new FakePeerManager(ME);
  pm.addPeer(A, 0.1);
  const dispatcher = new MessageDispatcher();
  const router = new HintRouter(pm as any, dispatcher, new FakeDandelion() as any, new FakeCircuit() as any);
  routers.push(router);
  const opened: OpenedHint[] = [];
  router.onHint(h => opened.push(h));
  return { dispatcher, router, opened };
}

beforeAll(async () => {
  await sodiumReady;
  K = new Uint8Array(32).fill(0x51);
});

afterEach(() => {
  while (routers.length) routers.pop()!.destroy();
});

describe('HintRouter: 開けなかった Hint の保持バッファ', () => {
  it(`保持は最大 ${RECENT_HINT_BUFFER} 件で、古いものから捨てる`, () => {
    const { dispatcher, router, opened } = setup();
    const oldest = fixedHint(K, 1).hint;
    dispatcher.dispatch(A, WireType.HINT, oldest);
    for (let i = 0; i < RECENT_HINT_BUFFER; i++) dispatcher.dispatch(A, WireType.HINT, randomHint());
    const newest = fixedHint(K, 2).hint;
    dispatcher.dispatch(A, WireType.HINT, newest);

    expect((router as any).recentHints.length).toBe(RECENT_HINT_BUFFER);

    router.addKey('k', K);
    // 最古の 1 件は押し出され、最新の 1 件だけが開き直される
    expect(opened).toHaveLength(1);
    expect(opened[0].payload.nonce[0]).toBe(2);
  });

  it('上限ちょうどまでなら最古の Hint も開き直せる', () => {
    const { dispatcher, router, opened } = setup();
    dispatcher.dispatch(A, WireType.HINT, fixedHint(K, 3).hint);
    for (let i = 0; i < RECENT_HINT_BUFFER - 1; i++) dispatcher.dispatch(A, WireType.HINT, randomHint());
    router.addKey('k', K);
    expect(opened).toHaveLength(1);
  });

  it('ingestLocal で取り込んだ Hint も同じ上限に従う', () => {
    const { router } = setup();
    for (let i = 0; i < RECENT_HINT_BUFFER + 50; i++) router.ingestLocal(randomHint());
    expect((router as any).recentHints.length).toBe(RECENT_HINT_BUFFER);
  });

  it('★[回帰] 正当な Hint 1 つを上限回数ぶん再送しても、他の Hint はバッファから押し出されない', () => {
    const { dispatcher, router, opened } = setup();
    const target = fixedHint(K, 10).hint;
    const filler = fixedHint(new Uint8Array(32).fill(0x52), 11).hint;
    dispatcher.dispatch(A, WireType.HINT, target);
    for (let i = 0; i < RECENT_HINT_BUFFER; i++) dispatcher.dispatch(A, WireType.HINT, filler);
    expect((router as any).recentHints).toHaveLength(2);
    router.addKey('k', K);
    expect(opened).toHaveLength(1);
    expect(opened[0].payload.nonce[0]).toBe(10);
  });
});
