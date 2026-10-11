import { describe, it, expect } from 'vitest';
import { encode, decode } from '@msgpack/msgpack';
import { WireCodec } from '../../src/network/wire/WireCodec';
import { WireType } from '../../src/network/wire/WireTypes';

const ALL_TYPES = Object.values(WireType).filter(
  (v): v is WireType => typeof v === 'number' && v !== WireType.UNKNOWN,
);

/** 各 WireType の代表的なペイロード (実際の送信側と同じ形) */
const SAMPLE_PAYLOADS: Record<number, any> = {
  [WireType.HELLO]: { challenge: new Uint8Array(32).fill(7) },
  [WireType.JOIN]: {
    peerId: 'a'.repeat(32), pubkey: new Uint8Array(32).fill(1), powCounter: 12345,
    challenge: new Uint8Array(32).fill(2), signature: new Uint8Array(64).fill(3),
  },
  [WireType.RING_INFO]: { neighbors: [{ id: 'b'.repeat(32) }] },
  [WireType.PING]: { ts: 4_000_000_000 },
  [WireType.PONG]: { ts: 1 },
  [WireType.LOCAL_LINK_REQ]: { from: 'c'.repeat(32) },
  [WireType.LOCAL_LINK_ACK]: { ok: true },
  [WireType.LOCAL_LINK_REJ]: { reason: 'full' },
  [WireType.PEX_REQUEST]: { minDistance: 0.25 },
  [WireType.PEX_RESPONSE]: { peers: [{ id: 'd'.repeat(32), pubkey: new Uint8Array(32), powCounter: 0 }] },
  [WireType.SDP_RELAY]: { targetPeerId: 'e'.repeat(32), senderId: 'f'.repeat(32), sdp: { type: 'answer', sdp: 'v=0' } },
  [WireType.ICE_RELAY]: { targetPeerId: 'e'.repeat(32), candidate: { candidate: 'candidate:x', sdpMid: '0' } },
  [WireType.GOSSIP]: {
    packet: {
      packet_id: '0'.repeat(64), hop_count: 2, pow_nonce: 99, pow_difficulty: 12,
      timestamp: 1_700_000_000_000, zone_id: 3, nonce: new Uint8Array(12), payload: new Uint8Array(100).fill(9),
    },
  },
  [WireType.STEM]: { zoneId: 3, packet: { packet_id: '1'.repeat(64), nonce: new Uint8Array(12), payload: new Uint8Array(1) } },
  [WireType.HINT]: { version: 1, ttl: 8, blind_tag: new Uint8Array(4), nonce: new Uint8Array(12), pow_nonce: 5, ciphertext: new Uint8Array(64) },
  [WireType.HINT_STEM]: { version: 1, ttl: 8, blind_tag: new Uint8Array(4), nonce: new Uint8Array(12), pow_nonce: 5, ciphertext: new Uint8Array(64) },
  [WireType.ONION_STEM]: { onionBytes: new Uint8Array(3800).fill(0xa5) },
  [WireType.DHT_PUT]: { topicHash: 'ab'.repeat(32), entries: [new Uint8Array([1, 2, 3])] },
  [WireType.DHT_PUT_STEM]: { topicHash: 'ab'.repeat(32), entries: [new Uint8Array([4, 5])] },
  [WireType.DHT_GET]: { topicHash: 'ab'.repeat(32), reqId: 'r1' },
  [WireType.DHT_RES]: { topicHash: 'ab'.repeat(32), reqId: 'r1', entries: [] },
};

describe('WireCodec.encode', () => {
  it('フレームは 1 バイトの WireType ヘッダ + MsgPack 本体', () => {
    const frame = WireCodec.encode(WireType.PING, { ts: 5 });
    expect(frame[0]).toBe(0x12);
    expect(decode(frame.subarray(1))).toEqual({ type: 'ping', ts: 5 });
  });

  it('Rust の internally tagged enum 用に {type: タグ} を先頭に注入する', () => {
    const frame = WireCodec.encode(WireType.DHT_GET, { topicHash: 'x', reqId: 'y' });
    // MsgPack の map はキーの挿入順で並ぶ。type が最初のキーであること
    expect(Object.keys(decode(frame.subarray(1)) as object)).toEqual(['type', 'topicHash', 'reqId']);
  });

  it('タグ表に無い型 (LOCAL_LINK_*) にはタグを付けない', () => {
    for (const t of [WireType.LOCAL_LINK_REQ, WireType.LOCAL_LINK_ACK, WireType.LOCAL_LINK_REJ]) {
      const frame = WireCodec.encode(t, { a: 1 });
      expect(decode(frame.subarray(1))).toEqual({ a: 1 });
    }
  });

  it('オブジェクト以外のペイロード (数値・文字列・null) はタグを付けずにそのまま符号化する', () => {
    expect(decode(WireCodec.encode(WireType.PING, 42).subarray(1))).toBe(42);
    expect(decode(WireCodec.encode(WireType.PING, 'x').subarray(1))).toBe('x');
    expect(decode(WireCodec.encode(WireType.PING, null).subarray(1))).toBeNull();
  });

  it('Uint8Array は bin 型で符号化される ({_type, data} や配列にならない)', () => {
    const frame = WireCodec.encode(WireType.HELLO, { challenge: new Uint8Array(32).fill(0xee) });
    const hex = Buffer.from(frame).toString('hex');
    expect(hex).toContain('c420' + 'ee'.repeat(32));
    expect(Buffer.from(frame).toString('latin1')).not.toContain('_type');
  });

  it('呼び出し側のペイロードを書き換えない', () => {
    const payload = { ts: 1 };
    WireCodec.encode(WireType.PING, payload);
    expect(payload).toEqual({ ts: 1 });
  });

  it('同じ入力からは常に同じバイト列 (決定的)', () => {
    for (const t of ALL_TYPES) {
      expect(WireCodec.encode(t, SAMPLE_PAYLOADS[t])).toEqual(WireCodec.encode(t, SAMPLE_PAYLOADS[t]));
    }
  });
});

describe('WireCodec.decode: 全 WireType の往復', () => {
  it('サンプルが全 WireType を網羅している', () => {
    for (const t of ALL_TYPES) expect(SAMPLE_PAYLOADS[t], `0x${t.toString(16)}`).toBeDefined();
  });

  for (const t of ALL_TYPES) {
    it(`0x${t.toString(16)} (${WireType[t]}) が型・中身ともに往復する`, () => {
      const payload = SAMPLE_PAYLOADS[t];
      const decoded = WireCodec.decode(WireCodec.encode(t, payload));
      expect(decoded.type).toBe(t);
      const { type: tag, ...rest } = decoded.payload;
      expect(rest).toEqual(payload);
      if (![WireType.LOCAL_LINK_REQ, WireType.LOCAL_LINK_ACK, WireType.LOCAL_LINK_REJ].includes(t)) {
        expect(typeof tag).toBe('string');
      }
    });
  }

  it('バイト列フィールドは Uint8Array として戻る', () => {
    const { payload } = WireCodec.decode(WireCodec.encode(WireType.JOIN, SAMPLE_PAYLOADS[WireType.JOIN]));
    expect(payload.pubkey).toBeInstanceOf(Uint8Array);
    expect(payload.signature).toBeInstanceOf(Uint8Array);
    expect(payload.signature.length).toBe(64);
  });

  it('ヘッダの WireType が優先され、本体のタグとは独立に識別される', () => {
    // 本体は ping のタグだが、ヘッダは GOSSIP
    const body = encode({ type: 'ping', ts: 1 });
    const frame = new Uint8Array([WireType.GOSSIP, ...body]);
    expect(WireCodec.decode(frame).type).toBe(WireType.GOSSIP);
  });

  it('subarray (オフセット付きビュー) でも正しく読める', () => {
    const frame = WireCodec.encode(WireType.PING, { ts: 7 });
    const big = new Uint8Array(frame.length + 10);
    big.set(frame, 5);
    expect(WireCodec.decode(big.subarray(5, 5 + frame.length))).toEqual({ type: WireType.PING, payload: { type: 'ping', ts: 7 } });
  });
});

describe('WireCodec.decode: 壊れたフレームの拒否', () => {
  it('空のフレームは UNKNOWN (例外を投げない)', () => {
    expect(WireCodec.decode(new Uint8Array(0))).toEqual({ type: WireType.UNKNOWN, payload: null });
  });

  it('ヘッダだけ (本体なし) は UNKNOWN', () => {
    for (const t of ALL_TYPES) {
      expect(WireCodec.decode(new Uint8Array([t])).type).toBe(WireType.UNKNOWN);
    }
  });

  it('途中で切れたフレームは、どこで切っても UNKNOWN', () => {
    for (const t of [WireType.JOIN, WireType.GOSSIP, WireType.ONION_STEM, WireType.DHT_PUT]) {
      const frame = WireCodec.encode(t, SAMPLE_PAYLOADS[t]);
      for (const cut of [2, 3, Math.floor(frame.length / 2), frame.length - 1]) {
        const d = WireCodec.decode(frame.subarray(0, cut));
        expect(d.type, `type=0x${t.toString(16)} cut=${cut}`).toBe(WireType.UNKNOWN);
        expect(d.payload).toBeNull();
      }
    }
  });

  it('末尾にゴミが付いたフレームは UNKNOWN (余剰バイトを黙って無視しない)', () => {
    const frame = WireCodec.encode(WireType.PING, { ts: 1 });
    const padded = new Uint8Array([...frame, 0x00]);
    expect(WireCodec.decode(padded).type).toBe(WireType.UNKNOWN);
  });

  it('宣言長が実データより大きい (巨大確保を誘う) bin32 は確保せずに UNKNOWN', () => {
    // map{ "onionBytes": bin32(len=0xFFFFFFF0) } だが実データは 4 バイトだけ
    const frame = new Uint8Array([
      WireType.ONION_STEM, 0x81, 0xaa, ...new TextEncoder().encode('onionBytes'),
      0xc6, 0xff, 0xff, 0xff, 0xf0, 1, 2, 3, 4,
    ]);
    expect(WireCodec.decode(frame)).toEqual({ type: WireType.UNKNOWN, payload: null });
  });

  it('宣言要素数が巨大な array32 / map32 も UNKNOWN', () => {
    expect(WireCodec.decode(new Uint8Array([WireType.DHT_PUT, 0xdd, 0xff, 0xff, 0xff, 0xff, 0x01])).type).toBe(WireType.UNKNOWN);
    expect(WireCodec.decode(new Uint8Array([WireType.DHT_PUT, 0xdf, 0xff, 0xff, 0xff, 0xff, 0xa1, 0x61])).type).toBe(WireType.UNKNOWN);
  });

  it('MsgPack の予約バイト (0xc1) を含む本体は UNKNOWN', () => {
    expect(WireCodec.decode(new Uint8Array([WireType.PING, 0xc1])).type).toBe(WireType.UNKNOWN);
  });

  it('未知の先頭バイトは既知の型と誤認しない', () => {
    for (const b of [0x00, 0x01, 0x0f, 0x18, 0x1f, 0x22, 0x32, 0x45, 0x4f, 0x54, 0x60, 0xf0, 0xfe, 0xff]) {
      const frame = new Uint8Array([b, ...encode({ type: 'ping', ts: 1 })]);
      expect(WireCodec.decode(frame).type, `0x${b.toString(16)}`).toBe(WireType.UNKNOWN);
    }
  });

  it('0xFF (UNKNOWN) の先頭バイトに正しい MsgPack を続けても既知の型にならない', () => {
    const frame = new Uint8Array([0xff, ...encode({ type: 'gossip', packet: {} })]);
    expect(WireCodec.decode(frame).type).toBe(WireType.UNKNOWN);
  });

  it('本体が MsgPack として正しければ、map 以外 (数値など) でもそのまま返す (検証は各ハンドラの責務)', () => {
    const frame = new Uint8Array([WireType.PING, 0x05]);
    expect(WireCodec.decode(frame)).toEqual({ type: WireType.PING, payload: 5 });
  });
});

describe('WireCodec.decode: JSON フォールバック (旧形式)', () => {
  const json = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

  it('JSON 文字列の type を WireType に写す', () => {
    const cases: Array<[string, WireType]> = [
      ['hello', WireType.HELLO], ['join', WireType.JOIN], ['ping', WireType.PING], ['pong', WireType.PONG],
      ['gossip', WireType.GOSSIP], ['stem', WireType.STEM], ['onion-stem', WireType.ONION_STEM],
      ['dht-put', WireType.DHT_PUT], ['dht-get', WireType.DHT_GET], ['dht-res', WireType.DHT_RES],
      ['pex-request', WireType.PEX_REQUEST], ['pex-response', WireType.PEX_RESPONSE],
      ['sdp-relay', WireType.SDP_RELAY], ['ice-relay', WireType.ICE_RELAY],
    ];
    for (const [tag, type] of cases) {
      const d = WireCodec.decode(json({ type: tag, x: 1 }));
      expect(d.type, tag).toBe(type);
      expect(d.payload).toEqual({ type: tag, x: 1 });
    }
  });

  it('知らない type や type 無しの JSON は UNKNOWN (payload は残す)', () => {
    expect(WireCodec.decode(json({ type: 'evil' })).type).toBe(WireType.UNKNOWN);
    expect(WireCodec.decode(json({ foo: 1 })).type).toBe(WireType.UNKNOWN);
    expect(WireCodec.decode(json([1, 2])).type).toBe(WireType.UNKNOWN);
  });

  it('★回帰: Object.prototype のキー名を type にしても既知の型にならない (UNKNOWN)', () => {
    for (const tag of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
      const d = WireCodec.decode(new TextEncoder().encode(`{"type":"${tag}"}`));
      expect(d.type, tag).toBe(WireType.UNKNOWN);
    }
  });

  it('★回帰: type が文字列でない JSON (数値・配列・オブジェクト) は UNKNOWN', () => {
    for (const t of [0x12, ['ping'], { toString: 'ping' }, null, true]) {
      expect(WireCodec.decode(json({ type: t })).type, JSON.stringify(t)).toBe(WireType.UNKNOWN);
    }
  });

  it('JSON でも MsgPack でもないものは UNKNOWN / null', () => {
    expect(WireCodec.decode(new TextEncoder().encode('{not json'))).toEqual({ type: WireType.UNKNOWN, payload: null });
    expect(WireCodec.decode(new Uint8Array([0xf0, 0x01, 0x02]))).toEqual({ type: WireType.UNKNOWN, payload: null });
  });

  it('先頭が既知の型番号と同じ文字 ("@" = 0x40) でも、MsgPack で読めなければ JSON として読み直す', () => {
    // " {...}" — 先頭の空白 0x20 は PEX_REQUEST と同じ値
    const d = WireCodec.decode(new TextEncoder().encode(' {"type":"ping","ts":1}'));
    expect(d.type).toBe(WireType.PING);
    expect(d.payload).toEqual({ type: 'ping', ts: 1 });
  });
});
