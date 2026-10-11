import { describe, it, expect, beforeAll, vi } from 'vitest';
import { sodiumReady } from '../../src/crypto/sodium';
import { PacketValidator, GOSSIP_RULES } from '../../src/network/gossip/PacketValidator';
import { POW_POLICY, derivePacketId, solvePow, type PowCommittedHeader } from '../../src/crypto/PowPolicy';
import { JsonBinary } from '../../src/common/JsonBinary';
import { WireCodec } from '../../src/network/wire/WireCodec';
import { WireType } from '../../src/network/wire/WireTypes';
import type { GossipPacket } from '../../src/types';

const NOW = 1_700_000_000_000;
const DRIFT = POW_POLICY.MAX_TIME_DRIFT;

/** 有効なパケットを作る (難易度 8 = 平均 256 回の SHA-256) */
function makePacket(over: Partial<PowCommittedHeader> = {}, hop = 0): GossipPacket {
  const header: PowCommittedHeader = {
    timestamp: NOW,
    zone_id: 5,
    pow_difficulty: POW_POLICY.MIN_DIFFICULTY,
    nonce: new Uint8Array(12).fill(3),
    payload: new Uint8Array(100).fill(0x42),
    ...over,
  };
  const n = solvePow(header);
  if (n === null) throw new Error('no pow');
  return {
    packet_id: derivePacketId(header),
    hop_count: hop,
    pow_nonce: Number(n),
    pow_difficulty: header.pow_difficulty,
    timestamp: header.timestamp,
    zone_id: header.zone_id,
    nonce: header.nonce,
    payload: header.payload,
  };
}

/** PoW を満たさない nonce を探す */
function badNonce(p: GossipPacket): number {
  for (let n = 0; ; n++) {
    if (PacketValidator.check({ ...p, pow_nonce: n }, { now: NOW }).ok === false) return n;
  }
}

let valid: GossipPacket;
beforeAll(async () => {
  await sodiumReady;
  valid = makePacket();
});

const check = (p: any, opts: any = {}) => PacketValidator.check(p, { now: NOW, ...opts });

describe('PacketValidator: 正当なパケット', () => {
  it('正しく作ったパケットを受理する', () => {
    expect(check(valid)).toEqual({ ok: true });
  });

  it('hop_count は PoW / packet_id のコミット対象外なので、中継で変わっても受理する', () => {
    for (const hop of [0, 1, 15, POW_POLICY.MAX_HOP_COUNT]) {
      expect(check({ ...valid, hop_count: hop }), `hop=${hop}`).toEqual({ ok: true });
    }
  });

  it('MsgPack (WireCodec) を往復しても受理する', () => {
    const { payload } = WireCodec.decode(WireCodec.encode(WireType.GOSSIP, { packet: valid }));
    expect(check(payload.packet)).toEqual({ ok: true });
  });

  it('JSON (JsonBinary) を往復した {_type, data} 形式や素の配列でも受理する (表現の揺れを正規化)', () => {
    expect(check(JsonBinary.parse(JsonBinary.stringify(valid)))).toEqual({ ok: true });
    expect(check(JSON.parse(JSON.stringify({ ...valid, nonce: Array.from(valid.nonce), payload: Array.from(valid.payload) })))).toEqual({ ok: true });
    expect(check(JSON.parse(JSON.stringify({ ...valid, nonce: { data: Array.from(valid.nonce) }, payload: { data: Array.from(valid.payload) } })))).toEqual({ ok: true });
  });

  it('ペイロード上限ちょうど (2048 バイト) は受理する', () => {
    expect(check(makePacket({ payload: new Uint8Array(POW_POLICY.MAX_PAYLOAD_SIZE).fill(1) }))).toEqual({ ok: true });
  });

  it('上限 MAX_DIFFICULTY (32) より低い高難易度 (例: 9) も受理する', () => {
    expect(check(makePacket({ pow_difficulty: 9 }))).toEqual({ ok: true });
  });

  it('GOSSIP_RULES は POW_POLICY と同じ値', () => {
    expect(GOSSIP_RULES).toEqual({
      MAX_PAYLOAD_SIZE: POW_POLICY.MAX_PAYLOAD_SIZE,
      MAX_HOP_COUNT: POW_POLICY.MAX_HOP_COUNT,
      MAX_TIME_DRIFT: POW_POLICY.MAX_TIME_DRIFT,
      MIN_DIFFICULTY: POW_POLICY.MIN_DIFFICULTY,
    });
    expect(PacketValidator.MAX_HOP_COUNT).toBe(30);
  });
});

describe('PacketValidator: 形式の拒否', () => {
  it('オブジェクトでないものは malformed', () => {
    for (const p of [null, undefined, 42, 'x', true]) expect(check(p)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('packet_id が 64 文字の文字列でなければ bad-packet-id-type', () => {
    for (const id of [undefined, 123, '', 'a'.repeat(63), 'a'.repeat(65), ['x']]) {
      expect(check({ ...valid, packet_id: id }).ok === false && (check({ ...valid, packet_id: id }) as any).reason).toBe('bad-packet-id-type');
    }
  });

  it('timestamp が安全な非負整数でなければ bad-timestamp', () => {
    for (const ts of [undefined, '1700000000000', -1, 1.5, NaN, Infinity, 2 ** 53, BigInt(NOW)]) {
      expect((check({ ...valid, timestamp: ts }) as any).reason, String(ts)).toBe('bad-timestamp');
    }
  });

  it('ペイロードが空、または 2048 バイト超なら bad-payload-size', () => {
    expect((check({ ...valid, payload: new Uint8Array(0) }) as any).reason).toBe('bad-payload-size');
    expect((check({ ...valid, payload: new Uint8Array(POW_POLICY.MAX_PAYLOAD_SIZE + 1) }) as any).reason).toBe('bad-payload-size');
    // バイト列として解釈できないもの (文字列など) は長さ 0 として扱われる
    expect((check({ ...valid, payload: 'hello' }) as any).reason).toBe('bad-payload-size');
  });

  it('nonce が 12 バイトでなければ bad-nonce-size', () => {
    for (const n of [new Uint8Array(0), new Uint8Array(11), new Uint8Array(13), new Uint8Array(24)]) {
      expect((check({ ...valid, nonce: n }) as any).reason).toBe('bad-nonce-size');
    }
  });

  it('hop_count が 0..30 の整数でなければ bad-hop-count', () => {
    for (const h of [-1, 31, 1.5, '3', undefined, NaN]) {
      expect((check({ ...valid, hop_count: h }) as any).reason, String(h)).toBe('bad-hop-count');
    }
  });

  it('pow_nonce が安全な非負整数でなければ bad-pow-nonce (BigInt() が投げる値をここで落とす)', () => {
    for (const n of [-1, 1.5, '7', undefined, NaN, Infinity, 2 ** 53, 7n]) {
      expect((check({ ...valid, pow_nonce: n }) as any).reason, String(n)).toBe('bad-pow-nonce');
    }
  });

  it('pow_difficulty が u8 に収まらない値なら (プリイメージが組めず) malformed', () => {
    for (const d of [256, -1, 1.5, '8']) {
      expect((check({ ...valid, pow_difficulty: d }) as any).reason, String(d)).toBe('malformed');
    }
  });

  it('zone_id が u32 に収まらない値なら malformed', () => {
    for (const z of [-1, 2 ** 32, 0.5, undefined]) {
      expect((check({ ...valid, zone_id: z }) as any).reason, String(z)).toBe('malformed');
    }
  });
});

describe('PacketValidator: 時刻', () => {
  it('未来方向は MAX_TIME_DRIFT (15 分) ちょうどまで受理し、それを超えたら time-drift', () => {
    const p = valid;
    expect(check(p, { now: p.timestamp - DRIFT })).toEqual({ ok: true });
    expect(check(p, { now: p.timestamp - DRIFT - 1 })).toEqual({ ok: false, reason: 'time-drift' });
  });

  it('過去方向も 15 分ちょうどまで受理し、それを超えたら time-drift', () => {
    expect(check(valid, { now: valid.timestamp + DRIFT })).toEqual({ ok: true });
    expect(check(valid, { now: valid.timestamp + DRIFT + 1 })).toEqual({ ok: false, reason: 'time-drift' });
  });

  it('allowStale は過去方向だけを緩める (DHT の過去ログ用)。未来日付は依然として拒否', () => {
    expect(check(valid, { now: valid.timestamp + 30 * 24 * 3600_000, allowStale: true })).toEqual({ ok: true });
    expect(check(valid, { now: valid.timestamp - DRIFT - 1, allowStale: true })).toEqual({ ok: false, reason: 'time-drift' });
  });

  it('now を渡さなければ Date.now を使う', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(valid.timestamp + 1000);
      expect(PacketValidator.check(valid)).toEqual({ ok: true });
      vi.setSystemTime(valid.timestamp + DRIFT + 1);
      expect(PacketValidator.check(valid)).toEqual({ ok: false, reason: 'time-drift' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PacketValidator: CHK (packet_id = コミット済みヘッダのハッシュ)', () => {
  it('コミット対象のどのフィールドを 1 つ書き換えても packet-id-mismatch', () => {
    const tampered: Array<[string, any]> = [
      ['timestamp', { timestamp: valid.timestamp + 60_000 }],
      ['zone_id', { zone_id: valid.zone_id + 1 }],
      ['pow_difficulty', { pow_difficulty: valid.pow_difficulty + 1 }],
      ['nonce', { nonce: Uint8Array.from(valid.nonce, (b, i) => (i === 0 ? b ^ 1 : b)) }],
      ['payload', { payload: Uint8Array.from(valid.payload, (b, i) => (i === 99 ? b ^ 0x80 : b)) }],
    ];
    for (const [name, over] of tampered) {
      expect(check({ ...valid, ...over }), name).toEqual({ ok: false, reason: 'packet-id-mismatch' });
    }
  });

  it('packet_id を大文字にしただけでも一致しない (正準形は小文字 hex)', () => {
    expect(check({ ...valid, packet_id: valid.packet_id.toUpperCase() })).toEqual({ ok: false, reason: 'packet-id-mismatch' });
  });

  it('★timestamp を書き換えて packet_id も計算し直しても、PoW をやり直さない限り通らない (リプレイ対策)', () => {
    const replay = { ...valid, timestamp: valid.timestamp + 60_000 };
    replay.packet_id = derivePacketId({ ...replay });
    const r = check(replay, { now: replay.timestamp });
    // 確率 1/256 で偶然 PoW を満たすので、その場合は別の時刻で試す
    if (r.ok) {
      const r2 = { ...valid, timestamp: valid.timestamp + 120_000 };
      r2.packet_id = derivePacketId({ ...r2 });
      expect(check(r2, { now: r2.timestamp })).toEqual({ ok: false, reason: 'insufficient-pow' });
    } else {
      expect(r).toEqual({ ok: false, reason: 'insufficient-pow' });
    }
  });
});

describe('PacketValidator: PoW', () => {
  it('解でない pow_nonce は insufficient-pow', () => {
    expect(check({ ...valid, pow_nonce: badNonce(valid) })).toEqual({ ok: false, reason: 'insufficient-pow' });
  });

  it('★自己申告の難易度が MIN_DIFFICULTY 未満なら、その難易度の正しい解でも拒否する', () => {
    for (const d of [0, 1, 7]) {
      const weak = makePacket({ pow_difficulty: d });
      expect(check(weak), `difficulty=${d}`).toEqual({ ok: false, reason: 'insufficient-pow' });
    }
  });

  it('MAX_DIFFICULTY (32) を超える申告は拒否する', () => {
    const p = { ...valid, pow_difficulty: 33 };
    p.packet_id = derivePacketId({ ...p });
    expect(check(p)).toEqual({ ok: false, reason: 'insufficient-pow' });
  });
});

describe('PacketValidator.validate', () => {
  it('結果を boolean で返し、壊れた入力でも例外を投げない', () => {
    expect(PacketValidator.validate(valid, { now: NOW })).toBe(true);
    expect(PacketValidator.validate({ ...valid, hop_count: 99 }, { now: NOW })).toBe(false);
    expect(() => PacketValidator.validate(null as any)).not.toThrow();
    expect(PacketValidator.validate(null as any)).toBe(false);
    expect(PacketValidator.validate({ packet_id: 5 } as any)).toBe(false);
  });
});
