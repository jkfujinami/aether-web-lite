import { describe, it, expect, afterEach } from 'vitest';
import { ChunkedReceiver } from '@/lib/network/stream/ChunkedReceiver';
import { ChunkedSender } from '@/lib/network/stream/ChunkedSender';

const HEADER_SIZE = 12;

function chunkFrame(opts: {
  msgId: number;
  seq: number;
  totalChunks: number;
  payload: Uint8Array;
  declaredSize?: number;
}): ArrayBuffer {
  const { msgId, seq, totalChunks, payload } = opts;
  const declared = opts.declaredSize ?? payload.byteLength;
  const buf = new Uint8Array(HEADER_SIZE + payload.byteLength);
  const view = new DataView(buf.buffer);
  view.setUint8(0, 0x00);
  view.setUint32(1, msgId);
  view.setUint16(5, seq);
  view.setUint16(7, totalChunks);
  view.setUint16(9, declared);
  view.setUint8(11, seq === totalChunks - 1 ? 0x01 : 0x00);
  buf.set(payload, HEADER_SIZE);
  return buf.buffer;
}

/** ChunkedSender が使う RTCDataChannel の代役 */
function fakeChannel() {
  const frames: Uint8Array[] = [];
  return {
    bufferedAmount: 0,
    send(data: Uint8Array) { frames.push(data.slice()); },
    frames,
  };
}

let receivers: ChunkedReceiver[] = [];
function makeReceiver() {
  const out: ArrayBuffer[] = [];
  const r = new ChunkedReceiver((d) => out.push(d));
  receivers.push(r);
  return { r, out };
}

afterEach(() => {
  for (const r of receivers) r.destroy();
  receivers = [];
});

describe('往復', () => {
  it('4KB 以下はそのまま 1 フレームで送る', async () => {
    const ch = fakeChannel();
    await new ChunkedSender().send(ch as any, new Uint8Array(1000).fill(7));
    expect(ch.frames).toHaveLength(1);

    const { r, out } = makeReceiver();
    r.receive(ch.frames[0].buffer.slice(0) as ArrayBuffer);
    expect(new Uint8Array(out[0])).toEqual(new Uint8Array(1000).fill(7));
  });

  it('大きいメッセージを分割して復元できる', async () => {
    const original = new Uint8Array(20_000);
    for (let i = 0; i < original.length; i++) original[i] = i & 0xff;

    const ch = fakeChannel();
    await new ChunkedSender().send(ch as any, original);
    expect(ch.frames.length).toBeGreaterThan(1);

    const { r, out } = makeReceiver();
    for (const f of ch.frames) r.receive(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) as ArrayBuffer);

    expect(out).toHaveLength(1);
    expect(new Uint8Array(out[0])).toEqual(original);
  });

  it('順序が入れ替わっても復元できる', async () => {
    const original = new Uint8Array(20_000).map((_, i) => i & 0xff);
    const ch = fakeChannel();
    await new ChunkedSender().send(ch as any, original);

    const { r, out } = makeReceiver();
    for (const f of [...ch.frames].reverse()) {
      r.receive(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) as ArrayBuffer);
    }
    expect(new Uint8Array(out[0])).toEqual(original);
  });
});

describe('★再組み立てのメモリ枯渇', () => {
  it('★未完了メッセージを無制限に溜め込まない', () => {
    // 攻撃: msgId を変えながら「1/1000」のチャンクだけを送り続ける。
    // 旧実装では 10 秒間ずっと保持され続けた。
    const { r, out } = makeReceiver();
    for (let i = 0; i < 10_000; i++) {
      r.receive(chunkFrame({ msgId: i, seq: 0, totalChunks: 100, payload: new Uint8Array(4096) }));
    }
    expect(r.pendingCount).toBeLessThanOrEqual(64);
    expect(out).toHaveLength(0);
  });

  it('★1 メッセージのサイズ上限を超えたら捨てる', () => {
    const { r, out } = makeReceiver();
    const total = 300; // 300 * 4096 ≒ 1.2MB > 1MB
    for (let seq = 0; seq < total; seq++) {
      r.receive(chunkFrame({ msgId: 1, seq, totalChunks: total, payload: new Uint8Array(4096) }));
    }
    expect(out).toHaveLength(0);
    expect(r.pendingCount).toBe(0);
  });

  it('★totalChunks が上限を超える宣言を組み立てない', () => {
    const { r, out } = makeReceiver();
    r.receive(chunkFrame({ msgId: 1, seq: 0, totalChunks: 65535, payload: new Uint8Array(10) }));
    expect(r.pendingCount).toBe(0);
    expect(out).toHaveLength(0);
  });

  it('★同じ seq を繰り返し送ってサイズを水増しできない', () => {
    const { r } = makeReceiver();
    for (let i = 0; i < 1000; i++) {
      r.receive(chunkFrame({ msgId: 1, seq: 0, totalChunks: 2, payload: new Uint8Array(4096) }));
    }
    expect(r.pendingCount).toBe(1);
  });

  it('★途中で totalChunks を変えてくる送信者を切る', () => {
    const { r, out } = makeReceiver();
    r.receive(chunkFrame({ msgId: 1, seq: 0, totalChunks: 3, payload: new Uint8Array(10) }));
    expect(r.pendingCount).toBe(1);
    r.receive(chunkFrame({ msgId: 1, seq: 1, totalChunks: 5, payload: new Uint8Array(10) }));
    expect(r.pendingCount).toBe(0);
    expect(out).toHaveLength(0);
  });

  it('★ヘッダのサイズ欄が実体と食い違うフレームを捨てる', () => {
    const { r, out } = makeReceiver();
    r.receive(chunkFrame({
      msgId: 1, seq: 0, totalChunks: 1,
      payload: new Uint8Array(10),
      declaredSize: 60000, // 実体より遥かに大きいと申告する
    }));
    expect(out).toHaveLength(0);
    expect(r.pendingCount).toBe(0);
  });
});

describe('非チャンクフレームの素通し', () => {
  it('先頭バイトが 0x00 でなければそのまま渡す', () => {
    const { r, out } = makeReceiver();
    const frame = new Uint8Array(20).fill(0x40); // WireType.GOSSIP
    r.receive(frame.buffer);
    expect(out).toHaveLength(1);
  });

  it('ヘッダ長未満のフレームはそのまま渡す', () => {
    const { r, out } = makeReceiver();
    r.receive(new Uint8Array(5).buffer);
    expect(out).toHaveLength(1);
  });
});
