import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { MessageDispatcher } from '../../src/network/MessageDispatcher';
import { WireType } from '../../src/network/wire/WireTypes';
import { HintRouter, type OpenedHint } from '../../src/network/hint/HintRouter';
import { buildHint } from '../../src/network/hint/HintCrypto';
import {
  encodeHint,
  HINT_INITIAL_TTL,
  hintId,
  verifyHintPow,
  type HintPacket,
} from '../../src/network/hint/HintPacket';
import { FakeCircuit, FakeDandelion, FakePeerManager, fixedHint } from '../helpers/hintMailboxFakes';

const ME = 'me'.padEnd(32, '0');
const A = 'aa'.padEnd(32, '1');
const B = 'bb'.padEnd(32, '2');
const C = 'cc'.padEnd(32, '3');
const UNVERIFIED = 'uv'.padEnd(32, '4');
const OFFLINE = 'of'.padEnd(32, '5');

let K: Uint8Array;
let OTHER: Uint8Array;
const routers: HintRouter[] = [];

function setup() {
  const pm = new FakePeerManager(ME);
  pm.addPeer(A, 0.1);
  pm.addPeer(B, 0.2);
  pm.addPeer(C, 0.3);
  pm.addPeer(UNVERIFIED, 0.4, { verified: false });
  pm.addPeer(OFFLINE, 0.5, { connected: false });
  const dispatcher = new MessageDispatcher();
  const dandelion = new FakeDandelion();
  const circuit = new FakeCircuit();
  const router = new HintRouter(pm as any, dispatcher, dandelion as any, circuit as any);
  routers.push(router);
  const opened: OpenedHint[] = [];
  router.onHint(h => opened.push(h));
  let anyCount = 0;
  router.onAnyHint(() => anyCount++);
  return {
    pm, dispatcher, dandelion, circuit, router, opened,
    anyCount: () => anyCount,
    hintsSent: () => pm.sentOfType(WireType.HINT),
  };
}

/** ワイヤ上の形 (MsgPack から復元されたオブジェクト相当) */
const wire = (h: HintPacket) => ({
  version: h.version, ttl: h.ttl, blind_tag: h.blind_tag, nonce: h.nonce, pow_nonce: h.pow_nonce, ciphertext: h.ciphertext,
});

function failingPow(h: HintPacket): HintPacket {
  for (let n = 0; ; n++) {
    const c = { ...h, pow_nonce: n };
    if (!verifyHintPow(c)) return c;
  }
}

function alternativePowSolution(h: HintPacket): HintPacket {
  for (let n = h.pow_nonce + 1; ; n++) {
    const c = { ...h, pow_nonce: n };
    if (verifyHintPow(c)) return c;
  }
}

beforeAll(async () => {
  await sodiumReady;
  K = new Uint8Array(32).fill(0x41);
  OTHER = new Uint8Array(32).fill(0x42);
});

afterEach(() => {
  while (routers.length) routers.pop()!.destroy();
});

describe('HintRouter: 受信と試行復号', () => {
  it('自分の鍵で開ける Hint は通知される (keyId と中身つき)', () => {
    const { dispatcher, router, opened } = setup();
    router.addKey('board:1', K);
    const { hint, payload } = fixedHint(K, 1, 77);
    dispatcher.dispatch(A, WireType.HINT, wire(hint));
    expect(opened).toHaveLength(1);
    expect(opened[0].keyId).toBe('board:1');
    expect(opened[0].payload.message_id).toBe(77);
    expect(Array.from(opened[0].payload.nonce)).toEqual(Array.from(payload.nonce));
    expect(hintId(opened[0].packet)).toBe(hintId(hint));
  });

  it('★開けない Hint も (中身を知らないまま) 全隣人へ中継される — Broadcast Veil', () => {
    const { dispatcher, router, opened, hintsSent } = setup();
    router.addKey('mine', OTHER);
    dispatcher.dispatch(A, WireType.HINT, wire(fixedHint(K, 2).hint));
    expect(opened).toHaveLength(0);
    expect(hintsSent().map(m => m.to).sort()).toEqual([B, C].sort());
  });

  it('★開けた Hint も同じように中継される (受信者が中継をやめると誰宛てか分かる)', () => {
    const { dispatcher, router, opened, hintsSent } = setup();
    router.addKey('k', K);
    dispatcher.dispatch(A, WireType.HINT, wire(fixedHint(K, 3).hint));
    expect(opened).toHaveLength(1);
    expect(hintsSent().map(m => m.to).sort()).toEqual([B, C].sort());
  });

  it('送り主・未検証・未接続のピアには中継しない', () => {
    const { dispatcher, hintsSent } = setup();
    dispatcher.dispatch(A, WireType.HINT, wire(fixedHint(K, 4).hint));
    const to = hintsSent().map(m => m.to);
    expect(to).not.toContain(A);
    expect(to).not.toContain(UNVERIFIED);
    expect(to).not.toContain(OFFLINE);
    expect(to).not.toContain(ME);
  });

  it('★中継する TTL は受信値に依らず常に初期値 (出口までの距離を漏らさない)', () => {
    const { dispatcher, hintsSent } = setup();
    const h = fixedHint(K, 5).hint;
    dispatcher.dispatch(A, WireType.HINT, { ...wire(h), ttl: 0 });
    for (const m of hintsSent()) expect(m.payload.ttl).toBe(HINT_INITIAL_TTL);
  });

  it('中継するパケットは Hint のフィールドだけを持つ (余計な情報を付け足さない)', () => {
    const { dispatcher, hintsSent } = setup();
    dispatcher.dispatch(A, WireType.HINT, { ...wire(fixedHint(K, 6).hint), from: 'leak', path: [A] });
    for (const m of hintsSent()) {
      expect(Object.keys(m.payload).sort()).toEqual(['blind_tag', 'ciphertext', 'nonce', 'pow_nonce', 'ttl', 'version']);
    }
  });

  it('エコー通知と onAnyHint は開けたかどうかに関わらず発火する', () => {
    const { dispatcher, dandelion, anyCount } = setup();
    const h = fixedHint(K, 7).hint;
    dispatcher.dispatch(A, WireType.HINT, wire(h));
    expect(dandelion.echoes).toEqual([hintId(h)]);
    expect(anyCount()).toBe(1);
  });

  it('複数の鍵を持っていれば、合う鍵の keyId で通知される', () => {
    const { dispatcher, router, opened } = setup();
    router.addKey('a', OTHER);
    router.addKey('b', K);
    dispatcher.dispatch(A, WireType.HINT, wire(fixedHint(K, 8).hint));
    expect(opened.map(o => o.keyId)).toEqual(['b']);
  });

  it('offHint で外したハンドラには通知されない', () => {
    const { dispatcher, router, opened } = setup();
    const extra: OpenedHint[] = [];
    const h = (o: OpenedHint) => extra.push(o);
    router.onHint(h);
    router.offHint(h);
    router.addKey('k', K);
    dispatcher.dispatch(A, WireType.HINT, wire(fixedHint(K, 9).hint));
    expect(opened).toHaveLength(1);
    expect(extra).toHaveLength(0);
  });
});

describe('HintRouter: 重複と再送', () => {
  it('★[回帰] 隣人の数だけ届いた同じ Hint は、観測 (onAnyHint) に 1 回しか数えない', () => {
    const { dispatcher, anyCount } = setup();
    const h = fixedHint(K, 40).hint;
    dispatcher.dispatch(A, WireType.HINT, wire(h));
    dispatcher.dispatch(B, WireType.HINT, { ...wire(h), ttl: 2 });
    dispatcher.dispatch(C, WireType.HINT, wire(alternativePowSolution(h)));
    for (let i = 0; i < 50; i++) dispatcher.dispatch(A, WireType.HINT, wire(h));
    expect(anyCount()).toBe(1);
    // 別の Hint はちゃんと数える
    dispatcher.dispatch(A, WireType.HINT, wire(fixedHint(K, 41).hint));
    expect(anyCount()).toBe(2);
  });

  it('★[回帰] 同じ Hint の再送は保持バッファに積み増さない', () => {
    const { dispatcher, router } = setup();
    const h = fixedHint(K, 42).hint;
    for (let i = 0; i < 100; i++) dispatcher.dispatch(i % 2 ? A : B, WireType.HINT, wire(h));
    expect((router as any).recentHints).toHaveLength(1);
  });

  it('重複を捨てても、エコー通知 (発信元の再送停止) は届く', () => {
    const { dispatcher, dandelion } = setup();
    const h = fixedHint(K, 43).hint;
    dispatcher.dispatch(A, WireType.HINT, wire(h));
    dispatcher.dispatch(B, WireType.HINT, wire(h));
    expect(dandelion.echoes.length).toBeGreaterThanOrEqual(1);
    expect(new Set(dandelion.echoes)).toEqual(new Set([hintId(h)]));
  });

  it('★同じ Hint は二度中継せず、二度通知しない (TTL が変わっていても同一)', () => {
    const { dispatcher, router, opened, hintsSent } = setup();
    router.addKey('k', K);
    const h = fixedHint(K, 10).hint;
    dispatcher.dispatch(A, WireType.HINT, wire(h));
    const first = hintsSent().length;
    dispatcher.dispatch(B, WireType.HINT, { ...wire(h), ttl: 3 });
    dispatcher.dispatch(C, WireType.HINT, wire(h));
    expect(hintsSent()).toHaveLength(first);
    expect(opened).toHaveLength(1);
  });

  it('★同じ中身に別の PoW 解を付けても新しい Hint として再フラッドされない', () => {
    const { dispatcher, hintsSent } = setup();
    const h = fixedHint(K, 11).hint;
    dispatcher.dispatch(A, WireType.HINT, wire(h));
    const first = hintsSent().length;
    dispatcher.dispatch(B, WireType.HINT, wire(alternativePowSolution(h)));
    expect(hintsSent()).toHaveLength(first);
  });

  it('別々の Hint はそれぞれ中継される', () => {
    const { dispatcher, hintsSent } = setup();
    dispatcher.dispatch(A, WireType.HINT, wire(fixedHint(K, 12).hint));
    dispatcher.dispatch(A, WireType.HINT, wire(fixedHint(K, 13).hint));
    expect(hintsSent()).toHaveLength(4); // B, C × 2
  });
});

describe('HintRouter: 不正な入力', () => {
  it('★PoW を満たさない Hint は中継も通知もしない (エコーも onAnyHint も起きない)', () => {
    const { dispatcher, router, opened, dandelion, hintsSent, anyCount } = setup();
    router.addKey('k', K);
    dispatcher.dispatch(A, WireType.HINT, wire(failingPow(fixedHint(K, 14).hint)));
    expect(hintsSent()).toHaveLength(0);
    expect(opened).toHaveLength(0);
    expect(dandelion.echoes).toHaveLength(0);
    expect(anyCount()).toBe(0);
  });

  it('改竄された暗号文 (PoW が外れる) は拒否される', () => {
    const { dispatcher, router, opened, hintsSent } = setup();
    router.addKey('k', K);
    const h = fixedHint(K, 1).hint; // 固定ベクタなので、先頭バイトの反転で PoW が外れるかは決定論的
    const ct = h.ciphertext.slice();
    ct[0] ^= 1;
    dispatcher.dispatch(A, WireType.HINT, { ...wire(h), ciphertext: ct });
    expect(hintsSent()).toHaveLength(0);
    expect(opened).toHaveLength(0);
  });

  it('★壊れたメッセージで例外を投げず、何も送らない', () => {
    const { dispatcher, router, hintsSent, dandelion } = setup();
    const handler = (router as any).handleHint.bind(router);
    const h = wire(fixedHint(K, 15).hint);
    const junk: any[] = [
      null, undefined, 0, 'HINT', [], [h], { ...h, version: 9 }, { ...h, ttl: 999 },
      { ...h, nonce: new Uint8Array(1) }, { ...h, ciphertext: new Uint8Array(10_000) },
      { ...h, pow_nonce: -5 }, { ...h, blind_tag: null }, new Uint8Array(94),
    ];
    for (const j of junk) {
      expect(() => handler(A, j)).not.toThrow();
      expect(() => dispatcher.dispatch(A, WireType.HINT, j)).not.toThrow();
    }
    expect(hintsSent()).toHaveLength(0);
    expect(dandelion.echoes).toHaveLength(0);
  });
});

describe('HintRouter: 鍵を後から得たとき', () => {
  it('★鍵を持つ前に流れた Hint を、addKey の時点で開き直す', () => {
    const { dispatcher, router, opened } = setup();
    const h = fixedHint(K, 16).hint;
    dispatcher.dispatch(A, WireType.HINT, wire(h));
    expect(opened).toHaveLength(0);
    router.addKey('late', K);
    expect(opened).toHaveLength(1);
    expect(opened[0].keyId).toBe('late');
  });

  it('開き直しでも二重には通知しない', () => {
    const { dispatcher, router, opened } = setup();
    router.addKey('k', K);
    dispatcher.dispatch(A, WireType.HINT, wire(fixedHint(K, 17).hint));
    router.addKey('k2', K);
    router.addKey('k', K);
    expect(opened).toHaveLength(1);
  });

  it('開き直しは中継を伴わない', () => {
    const { dispatcher, router, hintsSent } = setup();
    dispatcher.dispatch(A, WireType.HINT, wire(fixedHint(K, 18).hint));
    const before = hintsSent().length;
    router.addKey('k', K);
    expect(hintsSent()).toHaveLength(before);
  });

  it('removeKey した鍵ではもう開かない', () => {
    const { dispatcher, router, opened } = setup();
    router.addKey('k', K);
    router.removeKey('k');
    router.removeKey('unknown'); // 無い鍵を外しても問題ない
    dispatcher.dispatch(A, WireType.HINT, wire(fixedHint(K, 19).hint));
    expect(opened).toHaveLength(0);
  });
});

describe('HintRouter: 手元の Hint (ingestLocal / reflood / sendTo)', () => {
  it('ingestLocal は開けるか試すだけで、中継しない', () => {
    const { router, opened, hintsSent } = setup();
    router.addKey('k', K);
    expect(router.ingestLocal(fixedHint(K, 20).hint)).toBe(true);
    expect(opened).toHaveLength(1);
    expect(hintsSent()).toHaveLength(0);
  });

  it('ingestLocal は開けなければ false、PoW 不正なら false で保持もしない', () => {
    const { router, opened } = setup();
    expect(router.ingestLocal(fixedHint(K, 21).hint)).toBe(false);
    const bad = failingPow(fixedHint(K, 22).hint);
    expect(router.ingestLocal(bad)).toBe(false);
    router.addKey('k', K);
    // 保持していた正当な方だけが開き直される
    expect(opened).toHaveLength(1);
    expect(opened[0].payload.nonce[0]).toBe(21);
  });

  it('ingestLocal で開いた Hint がその後ネットワークから来ても二重通知しない (中継はする)', () => {
    const { dispatcher, router, opened, hintsSent } = setup();
    router.addKey('k', K);
    const h = fixedHint(K, 23).hint;
    router.ingestLocal(h);
    dispatcher.dispatch(A, WireType.HINT, wire(h));
    expect(opened).toHaveLength(1);
    expect(hintsSent().length).toBeGreaterThan(0);
  });

  it('★reflood は全隣人 (検証済み・接続中) に初期 TTL で撒き、2 回目は畳む', () => {
    const { router, hintsSent } = setup();
    const h = { ...fixedHint(K, 24).hint, ttl: 1 };
    router.reflood(h);
    expect(hintsSent().map(m => m.to).sort()).toEqual([A, B, C].sort());
    for (const m of hintsSent()) expect(m.payload.ttl).toBe(HINT_INITIAL_TTL);
    router.reflood(h);
    expect(hintsSent()).toHaveLength(3);
  });

  it('既にネットワークから受けて中継した Hint は reflood しても撒き直さない', () => {
    const { dispatcher, router, hintsSent } = setup();
    const h = fixedHint(K, 25).hint;
    dispatcher.dispatch(A, WireType.HINT, wire(h));
    const n = hintsSent().length;
    router.reflood(h);
    expect(hintsSent()).toHaveLength(n);
  });

  it('sendTo は検証済み・接続中の相手にだけ送り、全体中継の記録は触らない', () => {
    const { router, hintsSent } = setup();
    const h = fixedHint(K, 26).hint;
    router.sendTo(UNVERIFIED, h);
    router.sendTo(OFFLINE, h);
    router.sendTo('nobody'.padEnd(32, '0'), h);
    expect(hintsSent()).toHaveLength(0);
    router.sendTo(A, h);
    expect(hintsSent().map(m => m.to)).toEqual([A]);
    // sendTo 後でも reflood は全体へ撒ける
    router.reflood(h);
    expect(hintsSent()).toHaveLength(4);
  });
});

describe('HintRouter: 作者の放流 (originate) と出口', () => {
  it('★originate は必ずオニオン回路に載せ、隣人へ直接 flood しない', async () => {
    const { router, circuit, hintsSent } = setup();
    const h = fixedHint(K, 27).hint;
    const id = hintId(h);
    expect(await router.originate(h, id)).toBe(true);
    expect(circuit.sends).toHaveLength(1);
    expect(circuit.sends[0].echoId).toBe(id);
    expect(circuit.sends[0].payload.type).toBe('exit_hint');
    expect(Array.from(circuit.sends[0].payload.hint)).toEqual(Array.from(encodeHint(h)));
    expect(hintsSent()).toHaveLength(0);
  });

  it('★回路で届かなくても平文の flood に落ちない (fail-closed)', async () => {
    const { router, circuit, hintsSent } = setup();
    circuit.sendResult = false;
    const h = fixedHint(K, 28).hint;
    expect(await router.originate(h, hintId(h))).toBe(false);
    expect(hintsSent()).toHaveLength(0);
  });

  it('自分の Hint が網から戻ってきても自分には通知しない', async () => {
    const { dispatcher, router, opened } = setup();
    router.addKey('k', K);
    const h = fixedHint(K, 29).hint;
    await router.originate(h, hintId(h));
    dispatcher.dispatch(A, WireType.HINT, wire(h));
    expect(opened).toHaveLength(0);
  });

  it('出口として受けた Hint はエコーを確定させ、全隣人へ撒き、鍵があれば開く', () => {
    const { router, circuit, dandelion, opened, hintsSent } = setup();
    router.addKey('k', K);
    const h = fixedHint(K, 30).hint;
    circuit.fireExit('exit_hint', { type: 'exit_hint', hint: encodeHint(h) });
    expect(dandelion.echoes).toEqual([hintId(h)]);
    expect(hintsSent().map(m => m.to).sort()).toEqual([A, B, C].sort());
    expect(opened).toHaveLength(1);
  });

  it('出口で壊れた / PoW 不正な Hint は撒かない (例外も投げない)', () => {
    const { circuit, dandelion, hintsSent } = setup();
    const bad = encodeHint(failingPow(fixedHint(K, 31).hint));
    expect(() => circuit.fireExit('exit_hint', { type: 'exit_hint', hint: bad })).not.toThrow();
    expect(() => circuit.fireExit('exit_hint', { type: 'exit_hint', hint: new Uint8Array(5) })).not.toThrow();
    expect(() => circuit.fireExit('exit_hint', { type: 'exit_hint', hint: sodium.randombytes_buf(94) })).not.toThrow();
    expect(hintsSent()).toHaveLength(0);
    expect(dandelion.echoes).toHaveLength(0);
  });

  it('種類の違う出口ペイロードは無視する', () => {
    const { circuit, hintsSent } = setup();
    circuit.fireExit('exit_hint', { type: 'exit_fluff', hint: encodeHint(fixedHint(K, 32).hint) });
    expect(hintsSent()).toHaveLength(0);
  });
});

describe('HintRouter: 破棄', () => {
  it('destroy 後は鍵もハンドラも消え、届いた Hint で例外を投げない', () => {
    const { dispatcher, router, opened } = setup();
    router.addKey('k', K);
    router.destroy();
    expect(() => dispatcher.dispatch(A, WireType.HINT, wire(fixedHint(K, 33).hint))).not.toThrow();
    expect(opened).toHaveLength(0);
  });

  it('ランダムな鍵で作った Hint (buildHint) も受け取れる', () => {
    const { dispatcher, router, opened } = setup();
    const k = sodium.randombytes_buf(32);
    router.addKey('r', k);
    dispatcher.dispatch(A, WireType.HINT, wire(buildHint(k, { nonce: sodium.randombytes_buf(32), message_id: 5, timestamp: 0 })));
    expect(opened[0]?.payload.message_id).toBe(5);
  });
});
