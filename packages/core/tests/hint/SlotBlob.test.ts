import { describe, it, expect, beforeAll } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { ENCODED_HINT_SIZE, hintId, encodeHint, type HintPacket } from '../../src/network/hint/HintPacket';
import { decodeSlotBlob, encodeSlotBlob, extractHint } from '../../src/network/hint/SlotBlob';
import { openHint } from '../../src/network/hint/HintCrypto';
import { fixedHint } from '../helpers/hintMailboxFakes';

let K: Uint8Array;
let H: HintPacket;

beforeAll(async () => {
  await sodiumReady;
  K = new Uint8Array(32).fill(0x22);
  H = fixedHint(K, 9).hint;
});

describe('SlotBlob: [hint_blob] ‖ [body_blob]', () => {
  it('往復する (先頭 4 バイトは索引の長さ)', () => {
    const body = new TextEncoder().encode('本体のバイト列');
    const bytes = encodeSlotBlob(H, body);
    expect(bytes).toHaveLength(4 + ENCODED_HINT_SIZE + body.length);
    expect(new DataView(bytes.buffer).getUint32(0)).toBe(ENCODED_HINT_SIZE);
    const back = decodeSlotBlob(bytes)!;
    expect(hintId(back.hint)).toBe(hintId(H));
    expect(new TextDecoder().decode(back.body)).toBe('本体のバイト列');
  });

  it('空の本体でも往復する', () => {
    const back = decodeSlotBlob(encodeSlotBlob(H, new Uint8Array(0)))!;
    expect(back.body).toHaveLength(0);
  });

  it('★索引だけ取り出せる。取り出した索引は鍵を持つ者だけが開ける', () => {
    const bytes = encodeSlotBlob(H, sodium.randombytes_buf(500));
    const hint = extractHint(bytes)!;
    expect(hintId(hint)).toBe(hintId(H));
    expect(openHint(K, hint)).not.toBeNull();
    expect(openHint(new Uint8Array(32).fill(0x33), hint)).toBeNull();
  });

  it('★索引のバイト列は本体に依存しない (本体を見ても索引と紐づかない)', () => {
    const a = encodeSlotBlob(H, new Uint8Array([1, 2, 3]));
    const b = encodeSlotBlob(H, new Uint8Array(1000).fill(9));
    expect(Array.from(a.subarray(0, 4 + ENCODED_HINT_SIZE))).toEqual(Array.from(b.subarray(0, 4 + ENCODED_HINT_SIZE)));
    expect(Array.from(a.subarray(4, 4 + ENCODED_HINT_SIZE))).toEqual(Array.from(encodeHint(H)));
  });

  it('本体は書き換えずにそのまま返る (保持者が中身を解釈しない)', () => {
    const body = sodium.randombytes_buf(256);
    const back = decodeSlotBlob(encodeSlotBlob(H, body))!;
    expect(Array.from(back.body)).toEqual(Array.from(body));
  });

  it('オフセット付きのビューからでも読める', () => {
    const inner = encodeSlotBlob(H, new Uint8Array([7, 7]));
    const outer = new Uint8Array(inner.length + 3);
    outer.set(inner, 3);
    const back = decodeSlotBlob(outer.subarray(3))!;
    expect(hintId(back.hint)).toBe(hintId(H));
    expect(Array.from(back.body)).toEqual([7, 7]);
  });

  it('★壊れた入力は null (例外を投げない)', () => {
    const good = encodeSlotBlob(H, new Uint8Array([1]));

    const wrongLen = good.slice();
    new DataView(wrongLen.buffer).setUint32(0, ENCODED_HINT_SIZE + 1);
    const hugeLen = good.slice();
    new DataView(hugeLen.buffer).setUint32(0, 0xffffffff);
    const badVersion = good.slice();
    badVersion[4] = 0x7f;

    const cases = [
      new Uint8Array(0),
      new Uint8Array(3),
      new Uint8Array(4),
      good.slice(0, 4 + ENCODED_HINT_SIZE - 1), // 索引が途中で切れている
      wrongLen,
      hugeLen,
      badVersion,
      new TextEncoder().encode('{"packet_id":"x"}'), // 素の JSON パケット
    ];
    for (const c of cases) {
      expect(() => decodeSlotBlob(c)).not.toThrow();
      expect(decodeSlotBlob(c)).toBeNull();
      expect(extractHint(c)).toBeNull();
    }
  });

  it('ランダムなバイト列でも例外を投げない', () => {
    for (let i = 0; i < 300; i++) {
      const junk = sodium.randombytes_buf(i % 150);
      expect(() => decodeSlotBlob(junk)).not.toThrow();
    }
  });
});
