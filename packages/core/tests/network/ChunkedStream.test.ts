import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChunkedSender } from '../../src/network/stream/ChunkedSender';
import { ChunkedReceiver } from '../../src/network/stream/ChunkedReceiver';

/**
 * チャンク形式 (12 バイトヘッダ, ビッグエンディアン):
 *   [0]     0x00 (チャンクの印)
 *   [1..4]  msgId    u32
 *   [5..6]  seq      u16
 *   [7..8]  total    u16
 *   [9..10] size     u16
 *   [11]    last     u8 (最後のチャンクなら 1)
 */
const CHUNK = 4096;
const HEADER = 12;

/** 送られたものを記録する偽の RTCDataChannel */
function fakeChannel() {
  const sent: Uint8Array[] = [];
  const dc: any = {
    bufferedAmount: 0,
    send: vi.fn((d: Uint8Array) => { sent.push(new Uint8Array(d)); }),
  };
  return { dc, sent };
}

/** ワイヤに乗ったバイト列を受信側が受け取る ArrayBuffer にする */
const toBuf = (u: Uint8Array): ArrayBuffer => u.slice().buffer;

function pattern(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; out[i] = x >>> 24; }
  return out;
}

/** 手でチャンクを作る (攻撃的な入力用) */
function chunk(msgId: number, seq: number, total: number, payload: Uint8Array, opts: { size?: number; marker?: number } = {}) {
  const out = new Uint8Array(HEADER + payload.length);
  const v = new DataView(out.buffer);
  v.setUint8(0, opts.marker ?? 0);
  v.setUint32(1, msgId);
  v.setUint16(5, seq);
  v.setUint16(7, total);
  v.setUint16(9, opts.size ?? payload.length);
  v.setUint8(11, seq === total - 1 ? 1 : 0);
  out.set(payload, HEADER);
  return out.buffer;
}

describe('ChunkedSender', () => {
  it('4096 バイト以下はそのまま 1 回で送る (ヘッダを付けない)', async () => {
    const s = new ChunkedSender();
    for (const n of [1, 100, CHUNK]) {
      const { dc, sent } = fakeChannel();
      const data = pattern(n);
      await s.send(dc, data);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual(data);
    }
  });

  it('4097 バイトは 2 チャンクに分け、ヘッダの各欄が正しい', async () => {
    const s = new ChunkedSender();
    const { dc, sent } = fakeChannel();
    const data = pattern(CHUNK + 1);
    await s.send(dc, data);
    expect(sent).toHaveLength(2);

    const v0 = new DataView(sent[0].buffer);
    expect(v0.getUint8(0)).toBe(0);
    expect(v0.getUint16(5)).toBe(0);
    expect(v0.getUint16(7)).toBe(2);
    expect(v0.getUint16(9)).toBe(CHUNK);
    expect(v0.getUint8(11)).toBe(0);
    expect(sent[0].length).toBe(HEADER + CHUNK);

    const v1 = new DataView(sent[1].buffer);
    expect(v1.getUint32(1)).toBe(v0.getUint32(1));
    expect(v1.getUint16(5)).toBe(1);
    expect(v1.getUint16(7)).toBe(2);
    expect(v1.getUint16(9)).toBe(1);
    expect(v1.getUint8(11)).toBe(1);
    expect(sent[1].length).toBe(HEADER + 1);

    expect(sent[0].subarray(HEADER)).toEqual(data.subarray(0, CHUNK));
    expect(sent[1].subarray(HEADER)).toEqual(data.subarray(CHUNK));
  });

  it('ちょうど 4096 の倍数ならチャンク数は割り切れた数', async () => {
    const { dc, sent } = fakeChannel();
    await new ChunkedSender().send(dc, pattern(CHUNK * 3));
    expect(sent).toHaveLength(3);
    expect(new DataView(sent[2].buffer).getUint16(9)).toBe(CHUNK);
  });

  it('msgId はメッセージごとに 1 ずつ増える (分割しない送信では消費しない)', async () => {
    const s = new ChunkedSender();
    const { dc, sent } = fakeChannel();
    await s.send(dc, pattern(CHUNK + 1));
    await s.send(dc, pattern(10));
    await s.send(dc, pattern(CHUNK + 1));
    const id0 = new DataView(sent[0].buffer).getUint32(1);
    const id1 = new DataView(sent[3].buffer).getUint32(1);
    expect(id1).toBe(id0 + 1);
  });

  describe('バックプレッシャ', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('bufferedAmount が 64KB を超えている間は次のチャンクを送らずに待つ', async () => {
      const { dc, sent } = fakeChannel();
      dc.bufferedAmount = 64 * 1024 + 1;
      const p = new ChunkedSender().send(dc, pattern(CHUNK * 2));
      await vi.advanceTimersByTimeAsync(100);
      expect(sent).toHaveLength(0);
      dc.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(10);
      await p;
      expect(sent).toHaveLength(2);
    });

    it('ちょうど 64KB なら待たない', async () => {
      const { dc, sent } = fakeChannel();
      dc.bufferedAmount = 64 * 1024;
      await new ChunkedSender().send(dc, pattern(CHUNK * 2));
      expect(sent).toHaveLength(2);
    });
  });
});

describe('ChunkedReceiver', () => {
  let got: ArrayBuffer[];
  let rx: ChunkedReceiver;

  beforeEach(() => {
    vi.useFakeTimers();
    got = [];
    rx = new ChunkedReceiver(d => got.push(d));
  });
  afterEach(() => {
    rx.destroy();
    vi.useRealTimers();
  });

  async function sendThrough(data: Uint8Array) {
    const { dc, sent } = fakeChannel();
    await new ChunkedSender().send(dc, data);
    return sent;
  }

  it('Sender が分割したものを元どおりに組み立てる (大きさいろいろ)', async () => {
    for (const n of [CHUNK + 1, CHUNK * 2, CHUNK * 5 + 123, 200_000]) {
      const data = pattern(n, n);
      for (const c of await sendThrough(data)) rx.receive(toBuf(c));
      expect(new Uint8Array(got.pop()!)).toEqual(data);
      expect(rx.pendingCount).toBe(0);
    }
  });

  it('順不同で届いても組み立てる', async () => {
    const data = pattern(CHUNK * 4 + 7);
    const chunks = await sendThrough(data);
    for (const i of [3, 0, 4, 2, 1]) rx.receive(toBuf(chunks[i]));
    expect(got).toHaveLength(1);
    expect(new Uint8Array(got[0])).toEqual(data);
  });

  it('同じ seq の重複は無視し、二重に数えない', async () => {
    const data = pattern(CHUNK * 3);
    const chunks = await sendThrough(data);
    rx.receive(toBuf(chunks[0]));
    rx.receive(toBuf(chunks[0]));
    rx.receive(toBuf(chunks[1]));
    expect(got).toHaveLength(0);
    rx.receive(toBuf(chunks[2]));
    expect(got).toHaveLength(1);
    expect(new Uint8Array(got[0])).toEqual(data);
  });

  it('重複チャンクで中身を差し替えられない (最初に届いたものが残る)', () => {
    rx.receive(chunk(9, 0, 2, new Uint8Array([1, 1])));
    rx.receive(chunk(9, 0, 2, new Uint8Array([6, 6])));
    rx.receive(chunk(9, 1, 2, new Uint8Array([2])));
    expect(Array.from(new Uint8Array(got[0]))).toEqual([1, 1, 2]);
  });

  it('複数のメッセージが交互に届いても混ざらない', () => {
    const a = [pattern(10, 1), pattern(10, 2)];
    const b = [pattern(5, 3), pattern(5, 4), pattern(5, 5)];
    rx.receive(chunk(1, 0, 2, a[0]));
    rx.receive(chunk(2, 2, 3, b[2]));
    rx.receive(chunk(2, 0, 3, b[0]));
    rx.receive(chunk(1, 1, 2, a[1]));
    rx.receive(chunk(2, 1, 3, b[1]));
    expect(got.map(g => Array.from(new Uint8Array(g)))).toEqual([
      [...a[0], ...a[1]],
      [...b[0], ...b[1], ...b[2]],
    ]);
  });

  it('チャンクでないもの (先頭が 0x00 以外、または 12 バイト未満) はそのまま渡す', () => {
    const frame = new Uint8Array([0x12, 0x82, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    rx.receive(toBuf(frame));
    rx.receive(toBuf(new Uint8Array([0x00, 1, 2])));
    expect(got).toHaveLength(2);
    expect(new Uint8Array(got[0])).toEqual(frame);
    expect(rx.pendingCount).toBe(0);
  });

  it('total=0 や seq ≥ total のヘッダはチャンクとして扱わない (素通し)', () => {
    rx.receive(chunk(1, 0, 0, new Uint8Array(4)));
    rx.receive(chunk(1, 3, 3, new Uint8Array(4)));
    expect(got).toHaveLength(2);
    expect(rx.pendingCount).toBe(0);
  });

  it('total=1 のチャンクは即座に 1 メッセージになる', () => {
    rx.receive(chunk(5, 0, 1, new Uint8Array([7, 8, 9])));
    expect(Array.from(new Uint8Array(got[0]))).toEqual([7, 8, 9]);
  });

  it('★宣言チャンク数が上限 (1MB / 4096 = 256) を超えるものは組み立てを始めずに捨てる', () => {
    rx.receive(chunk(1, 0, 257, new Uint8Array(10)));
    rx.receive(chunk(2, 0, 65535, new Uint8Array(10)));
    expect(got).toHaveLength(0);
    expect(rx.pendingCount).toBe(0);
    rx.receive(chunk(3, 0, 256, new Uint8Array(10)));
    expect(rx.pendingCount).toBe(1);
  });

  it('★size 欄が実際のバイト数より大きいものは捨てる', () => {
    rx.receive(chunk(1, 0, 2, new Uint8Array(10), { size: 11 }));
    expect(rx.pendingCount).toBe(0);
    expect(got).toHaveLength(0);
  });

  it('size 欄より実データが長ければ size 分だけ使う', () => {
    rx.receive(chunk(1, 0, 1, new Uint8Array([1, 2, 3, 4]), { size: 2 }));
    expect(Array.from(new Uint8Array(got[0]))).toEqual([1, 2]);
  });

  it('★同じ msgId で total を変えてきたら、組み立て中のものごと捨てる', () => {
    rx.receive(chunk(1, 0, 3, new Uint8Array(4)));
    expect(rx.pendingCount).toBe(1);
    rx.receive(chunk(1, 1, 4, new Uint8Array(4)));
    expect(rx.pendingCount).toBe(0);
    // その後に元の続きが来ても完成しない (新しい組み立てとして始まる)
    rx.receive(chunk(1, 1, 3, new Uint8Array(4)));
    rx.receive(chunk(1, 2, 3, new Uint8Array(4)));
    expect(got).toHaveLength(0);
  });

  it('★1 メッセージの合計が 1MB を超えたら捨てる (size 欄は最大 65535 なので 256 チャンク以内でも超えうる)', () => {
    const big = new Uint8Array(60_000);
    const total = 20; // 20 × 60000 = 1.2MB
    for (let seq = 0; seq < 17; seq++) rx.receive(chunk(1, seq, total, big));
    // 17 × 60000 = 1,020,000 ≤ 1MB (1,048,576) なのでまだ保持
    expect(rx.pendingCount).toBe(1);
    rx.receive(chunk(1, 17, total, big));
    expect(rx.pendingCount).toBe(0);
    for (let seq = 18; seq < total; seq++) rx.receive(chunk(1, seq, total, big));
    expect(got).toHaveLength(0);
  });

  it('ちょうど 1MB のメッセージは組み立てられる', async () => {
    const data = pattern(1024 * 1024);
    for (const c of await sendThrough(data)) rx.receive(toBuf(c));
    expect(got).toHaveLength(1);
    expect(got[0].byteLength).toBe(1024 * 1024);
  });

  it('★同時に組み立てる数は 64 まで。超えたら最も古いものを捨てる', () => {
    for (let id = 0; id < 64; id++) rx.receive(chunk(id, 0, 2, new Uint8Array([id])));
    expect(rx.pendingCount).toBe(64);
    rx.receive(chunk(1000, 0, 2, new Uint8Array([0xff])));
    expect(rx.pendingCount).toBe(64);
    // id=1 は残っている
    rx.receive(chunk(1, 1, 2, new Uint8Array([9])));
    expect(got.map(g => Array.from(new Uint8Array(g)))).toEqual([[1, 9]]);
    // 最古 (id=0) は消えているので、続きが来ても完成しない (新しい組み立てとして始まるだけ)
    rx.receive(chunk(0, 1, 2, new Uint8Array([0])));
    expect(got).toHaveLength(1);
  });

  it('★組み立てが 10 秒以上終わらないものは定期掃除で捨てる', () => {
    rx.receive(chunk(1, 0, 2, new Uint8Array([1])));
    vi.advanceTimersByTime(10_000);
    // 10 秒ちょうどの掃除 (5 秒刻み) ではまだ消えない
    expect(rx.pendingCount).toBe(1);
    vi.advanceTimersByTime(5_000);
    expect(rx.pendingCount).toBe(0);
    rx.receive(chunk(1, 1, 2, new Uint8Array([2])));
    expect(got).toHaveLength(0);
  });

  it('期限内に揃えば掃除の影響を受けない', () => {
    rx.receive(chunk(1, 0, 2, new Uint8Array([1])));
    vi.advanceTimersByTime(9_000);
    rx.receive(chunk(1, 1, 2, new Uint8Array([2])));
    expect(Array.from(new Uint8Array(got[0]))).toEqual([1, 2]);
  });

  it('destroy で保留を捨て、タイマーも止まる', () => {
    rx.receive(chunk(1, 0, 2, new Uint8Array([1])));
    rx.destroy();
    expect(rx.pendingCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
