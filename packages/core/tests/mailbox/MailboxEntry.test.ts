import { describe, it, expect, beforeAll } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { JsonBinary } from '../../src/common/JsonBinary';
import { PacketBuilder } from '../../src/crypto/PacketBuilder';
import { derivePacketId, verifyPow, POW_POLICY } from '../../src/crypto/PowPolicy';
import {
  checkEntry,
  filterValidEntries,
  isValidTopicHash,
  MAILBOX_LIMITS,
} from '../../src/network/mailbox/MailboxEntry';
import { verifyHintPow, type HintPacket } from '../../src/network/hint/HintPacket';
import { encodeSlotBlob } from '../../src/network/hint/SlotBlob';
import type { GossipPacket } from '../../src/types';
import { makePacket } from '../helpers/onionNet';
import { fixedHint, packetBytes } from '../helpers/hintMailboxFakes';

let K: Uint8Array;
let HINT: HintPacket;

/** 任意の難易度・時刻で CHK と PoW が整合したパケット */
function packetWith(opts: { difficulty?: number; timestamp?: number; payload?: Uint8Array } = {}): GossipPacket {
  const header = {
    timestamp: opts.timestamp ?? Date.now(),
    zone_id: 1,
    pow_difficulty: opts.difficulty ?? 8,
    nonce: sodium.randombytes_buf(12),
    payload: opts.payload ?? Uint8Array.from([1, 2, 3]),
  };
  let pow_nonce = 0;
  // verifyPow は MIN_DIFFICULTY 未満を常に拒否するので、低難易度は自前で解く
  if (header.pow_difficulty >= POW_POLICY.MIN_DIFFICULTY) {
    while (!verifyPow(header, pow_nonce)) pow_nonce++;
  }
  return {
    packet_id: derivePacketId(header),
    hop_count: 0,
    pow_nonce,
    pow_difficulty: header.pow_difficulty,
    timestamp: header.timestamp,
    zone_id: header.zone_id,
    nonce: header.nonce,
    payload: header.payload,
  };
}

function failingPow(h: HintPacket): HintPacket {
  for (let n = 0; ; n++) {
    const c = { ...h, pow_nonce: n };
    if (!verifyHintPow(c)) return c;
  }
}

beforeAll(async () => {
  await sodiumReady;
  K = new Uint8Array(32).fill(0x71);
  HINT = fixedHint(K, 1).hint;
});

describe('MailboxEntry: topicHash の形式', () => {
  it('SHA-256 (64 桁) と SHA-512 (128 桁) の小文字 hex だけを受け付ける', () => {
    expect(isValidTopicHash('a'.repeat(64))).toBe(true);
    expect(isValidTopicHash('0123456789abcdef'.repeat(8))).toBe(true);
    expect(isValidTopicHash('f'.repeat(128))).toBe(true);
  });

  it('それ以外はすべて拒否する', () => {
    const bad: unknown[] = [
      'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'a'.repeat(96), 'a'.repeat(127), 'a'.repeat(129),
      'g'.repeat(64), ' ' + 'a'.repeat(63), 'a'.repeat(64) + '\n', '', null, undefined, 123, {}, ['a'.repeat(64)],
      '../'.padEnd(64, 'a'),
    ];
    for (const b of bad) expect(isValidTopicHash(b)).toBe(false);
  });
});

describe('MailboxEntry: 1 エントリの検証 (鍵無しでできる範囲)', () => {
  it('JSON 化した正当な GossipPacket は通る', () => {
    const p = makePacket();
    const r = checkEntry(packetBytes(p));
    expect(r.ok).toBe(true);
    expect(r.packet!.packet_id).toBe(p.packet_id);
  });

  it('★Slot 形式 (hint_blob ‖ body) も通る (素の JSON として解釈して捨てない)', () => {
    const r = checkEntry(encodeSlotBlob(HINT, packetBytes()));
    expect(r.ok).toBe(true);
  });

  it('★索引の PoW が無い Slot は bad-hint-pow', () => {
    const r = checkEntry(encodeSlotBlob(failingPow(HINT), packetBytes()));
    expect(r).toEqual({ ok: false, reason: 'bad-hint-pow' });
  });

  it('★Slot の本体を改竄すると CHK で落ちる', () => {
    const p = makePacket([1, 2, 3, 4]);
    const tampered = { ...p, payload: Uint8Array.from([1, 2, 3, 5]) };
    expect(checkEntry(encodeSlotBlob(HINT, packetBytes(tampered))).reason).toBe('packet-id-mismatch');
    expect(checkEntry(packetBytes(tampered)).reason).toBe('packet-id-mismatch');
  });

  it('packet_id だけ差し替えても CHK で落ちる', () => {
    const p = makePacket();
    expect(checkEntry(packetBytes({ ...p, packet_id: 'f'.repeat(64) })).reason).toBe('packet-id-mismatch');
  });

  it('★PoW を解いていない / 下限未満の難易度は insufficient-pow', () => {
    const p = makePacket();
    const header = PacketBuilder.committedHeaderOf(p);
    let n = 0;
    while (verifyPow(header, n)) n++;
    expect(checkEntry(packetBytes({ ...p, pow_nonce: n })).reason).toBe('insufficient-pow');
    // CHK は整合しているが、申告難易度が下限未満
    expect(checkEntry(packetBytes(packetWith({ difficulty: POW_POLICY.MIN_DIFFICULTY - 1 }))).reason).toBe('insufficient-pow');
    expect(checkEntry(packetBytes(packetWith({ difficulty: 0 }))).reason).toBe('insufficient-pow');
  });

  it('★過去ログは古くても受け付ける (allowStale) が、未来日付は拒否する', () => {
    const now = Date.now();
    expect(checkEntry(packetBytes(packetWith({ timestamp: now - 20 * 24 * 3600 * 1000 })), now).ok).toBe(true);
    expect(checkEntry(packetBytes(packetWith({ timestamp: now + POW_POLICY.MAX_TIME_DRIFT + 60_000 })), now).reason)
      .toBe('time-drift');
  });

  it('空・上限超過は too-large、型違いは not-a-packet', () => {
    expect(checkEntry(new Uint8Array(0)).reason).toBe('too-large');
    expect(checkEntry(new Uint8Array(MAILBOX_LIMITS.MAX_ENTRY_BYTES + 1)).reason).toBe('too-large');
    expect(checkEntry('{}' as any).reason).toBe('not-a-packet');
    expect(checkEntry([1, 2, 3] as any).reason).toBe('not-a-packet');
  });

  it('サイズ上限はちょうど MAX_ENTRY_BYTES まで (JSON の末尾空白で水増しして境界を確認)', () => {
    const base = JsonBinary.stringify(makePacket());
    const exact = new TextEncoder().encode(base.padEnd(MAILBOX_LIMITS.MAX_ENTRY_BYTES, ' '));
    const over = new TextEncoder().encode(base.padEnd(MAILBOX_LIMITS.MAX_ENTRY_BYTES + 1, ' '));
    expect(exact.length).toBe(MAILBOX_LIMITS.MAX_ENTRY_BYTES);
    expect(checkEntry(exact).ok).toBe(true);
    expect(checkEntry(over).reason).toBe('too-large');
  });

  it('JSON でないものは not-json、JSON でもパケットでないものは拒否', () => {
    expect(checkEntry(new TextEncoder().encode('not json')).reason).toBe('not-json');
    expect(checkEntry(new TextEncoder().encode('{"_type":"BigInt","value":"zz"}')).reason).toBe('not-json');
    expect(checkEntry(new TextEncoder().encode('null')).reason).toBe('not-a-packet');
    expect(checkEntry(new TextEncoder().encode('42')).reason).toBe('not-a-packet');
    expect(checkEntry(new TextEncoder().encode('[]')).ok).toBe(false);
    expect(checkEntry(new TextEncoder().encode('{}')).ok).toBe(false);
  });

  it('Slot の索引は正しいが本体が JSON でなければ not-json', () => {
    expect(checkEntry(encodeSlotBlob(HINT, new Uint8Array([0xff, 0x00, 0x01]))).reason).toBe('not-json');
    expect(checkEntry(encodeSlotBlob(HINT, new Uint8Array(0))).reason).toBe('not-json');
  });

  it('★壊れた入力・型の崩れたパケットで例外を投げない', () => {
    const p: any = makePacket();
    const variants: any[] = [
      { ...p, pow_difficulty: 'x' }, { ...p, pow_difficulty: 1e9 }, { ...p, zone_id: -1 }, { ...p, zone_id: 2 ** 40 },
      { ...p, timestamp: -5 }, { ...p, timestamp: 1.5 }, { ...p, hop_count: -1 }, { ...p, hop_count: 9999 },
      { ...p, nonce: 'abc' }, { ...p, payload: null }, { ...p, pow_nonce: 'n' }, { ...p, pow_nonce: -1 },
      { ...p, packet_id: 5 }, { ...p, payload: new Uint8Array(POW_POLICY.MAX_PAYLOAD_SIZE + 1) },
    ];
    for (const v of variants) {
      const bytes = packetBytes(v);
      expect(() => checkEntry(bytes)).not.toThrow();
      expect(checkEntry(bytes).ok).toBe(false);
    }
    for (let i = 0; i < 200; i++) {
      const junk = sodium.randombytes_buf(1 + (i % 300));
      expect(() => checkEntry(junk)).not.toThrow();
      expect(checkEntry(junk).ok).toBe(false);
    }
  });
});

describe('MailboxEntry: エントリ列のふるい分け (filterValidEntries)', () => {
  it('配列でなければ空 (例外を投げない)', () => {
    for (const x of [undefined, null, 'x', 5, {}, { length: 3, 0: packetBytes() }, new Uint8Array(4)]) {
      const r = filterValidEntries(x);
      expect(r.accepted).toHaveLength(0);
      expect(r.rejected.size).toBe(0);
    }
  });

  it('正当なものだけを通し、拒否理由ごとに件数を数える', () => {
    const good1 = packetBytes(makePacket([1]));
    const good2 = encodeSlotBlob(HINT, packetBytes(makePacket([2])));
    const entries = [
      good1, 'string', 12, null, new TextEncoder().encode('garbage'), new Uint8Array(0),
      encodeSlotBlob(failingPow(HINT), packetBytes()), good2,
    ];
    const { accepted, rejected } = filterValidEntries(entries);
    expect(accepted).toEqual([good1, good2]);
    expect(rejected.get('not-a-packet')).toBe(3);
    expect(rejected.get('not-json')).toBe(1);
    expect(rejected.get('too-large')).toBe(1);
    expect(rejected.get('bad-hint-pow')).toBe(1);
  });

  it('★同じメッセージ内の同一パケットは 1 件に畳む (Slot 包みでも packet_id で同一視)', () => {
    const p = makePacket([7]);
    const raw = packetBytes(p);
    const slotted = encodeSlotBlob(HINT, packetBytes(p));
    const { accepted } = filterValidEntries([raw, raw, slotted, raw.slice()]);
    expect(accepted).toHaveLength(1);
  });

  it(`1 メッセージで見るのは先頭 ${MAILBOX_LIMITS.MAX_ENTRIES_PER_MESSAGE} 件まで`, () => {
    const N = MAILBOX_LIMITS.MAX_ENTRIES_PER_MESSAGE;
    const entries = Array.from({ length: N + 6 }, (_, i) => packetBytes(makePacket([i & 0xff, i >> 8, 1])));
    const { accepted } = filterValidEntries(entries);
    expect(accepted).toHaveLength(N);
    expect(accepted[N - 1]).toBe(entries[N - 1]);
  });

  it('TypedArray ビュー (Buffer / DataView) も受け付けるが、生の ArrayBuffer や数値配列は受け付けない', () => {
    const bytes = packetBytes(makePacket([3]));
    const asBuffer = Buffer.from(bytes);
    const asView = new DataView(bytes.slice().buffer);
    expect(filterValidEntries([asBuffer]).accepted).toHaveLength(1);
    expect(filterValidEntries([asView]).accepted).toHaveLength(1);
    const r = filterValidEntries([bytes.slice().buffer, Array.from(bytes)]);
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected.get('not-a-packet')).toBe(2);
  });
});
