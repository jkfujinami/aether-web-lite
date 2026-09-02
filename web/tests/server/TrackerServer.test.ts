import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import sodium from 'libsodium-wrappers-sumo';
import { TrackerServer } from '@/server/TrackerServer';
import { NodeIdentity, NODE_ID_POW_FAST } from '@/lib/crypto/NodeIdentity';
import { RateLimiter } from '@/lib/network/RateLimiter';

const PARAMS = NODE_ID_POW_FAST;

let http: Server;
let tracker: TrackerServer;
let url: string;

let alice: NodeIdentity;
let bob: NodeIdentity;
let mallory: NodeIdentity;

beforeAll(async () => {
  await sodium.ready;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  alice = await NodeIdentity.mine(PARAMS);
  bob = await NodeIdentity.mine(PARAMS);
  mallory = await NodeIdentity.mine(PARAMS);
});

beforeEach(async () => {
  http = createServer();
  tracker = new TrackerServer(http, {
    powParams: PARAMS,
    // レート制限はここでは無効相当に緩める (専用のテストで別途検証する)
    rateLimiter: new RateLimiter({ join: { ratePerSec: 1000, burst: 1000 }, relay: { ratePerSec: 1000, burst: 1000 } }),
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  url = `ws://127.0.0.1:${port}/ws`;
});

afterEach(async () => {
  tracker.shutdown();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

/** 接続して、受信メッセージを蓄積するクライアント */
class Client {
  public messages: any[] = [];
  private constructor(public ws: WebSocket) {}

  static async open(): Promise<Client> {
    const ws = new WebSocket(url);
    const client = new Client(ws);
    ws.on('message', (raw) => {
      try { client.messages.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return client;
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  joinAs(identity: NodeIdentity, overrides: Record<string, unknown> = {}): void {
    this.send({
      type: 'join',
      peerId: identity.peerId,
      pubkey: sodium.to_hex(identity.pubkey),
      powCounter: identity.powCounter,
      ...overrides,
    });
  }

  async next(predicate: (m: any) => boolean, timeoutMs = 2000): Promise<any> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = this.messages.find(predicate);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout waiting for message; got ${JSON.stringify(this.messages)}`);
  }

  close(): void {
    this.ws.close();
  }
}

describe('join の Bound Identity 検証', () => {
  it('正当な claim を受理してピアリストを返す', async () => {
    const c = await Client.open();
    c.joinAs(alice);
    const peers = await c.next((m) => m.type === 'peers');
    expect(Array.isArray(peers.peers)).toBe(true);
    c.close();
  });

  it('★他人の peerId を名乗る join を拒否する', async () => {
    const c = await Client.open();
    // alice の公開鍵で bob の peerId を名乗る
    c.joinAs(alice, { peerId: bob.peerId });
    const err = await c.next((m) => m.type === 'error');
    expect(err.message).toBe('Invalid identity claim');
    c.close();
  });

  it('★NodeId PoW を解いていない identity を拒否する (Sybil の関門)', async () => {
    const c = await Client.open();

    let bad: NodeIdentity | null = null;
    for (let i = 0; i < 300; i++) {
      const kp = sodium.crypto_sign_keypair();
      const candidate = NodeIdentity.fromKeyPair(kp.publicKey, kp.privateKey, 0);
      if (!NodeIdentity.verifyClaim(candidate.claim(), PARAMS)) { bad = candidate; break; }
    }
    expect(bad).not.toBeNull();

    c.joinAs(bad!);
    const err = await c.next((m) => m.type === 'error');
    expect(err.message).toBe('Invalid identity claim');
    c.close();
  });

  it('形式不正な join を拒否する', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['peerId が不正', { peerId: 'nope' }],
      ['pubkey が hex でない', { pubkey: 'zz'.repeat(32) }],
      ['pubkey の長さ違い', { pubkey: 'ab' }],
      ['powCounter が負', { powCounter: -1 }],
      ['powCounter が小数', { powCounter: 1.5 }],
    ];
    for (const [name, overrides] of cases) {
      const c = await Client.open();
      c.joinAs(alice, overrides);
      const err = await c.next((m) => m.type === 'error');
      expect(err.type, name).toBe('error');
      c.close();
    }
  });

  it('壊れた JSON でもサーバーが落ちない', async () => {
    const c = await Client.open();
    c.ws.send('{{{not json');
    const err = await c.next((m) => m.type === 'error');
    expect(err.message).toBe('Message parsing failed');
    // その後も正常に join できる
    c.joinAs(alice);
    await c.next((m) => m.type === 'peers');
    c.close();
  });
});

describe('★S級#5: セッション乗っ取り', () => {
  it('★生きているセッションの peerId を奪えない', async () => {
    // 旧実装: SessionManager が peerId を無条件に上書きしていたため、
    // 攻撃者は被害者の peerId で join するだけで、被害者宛の
    // SDP/ICE リレーを全部自分に向けられた。
    const victim = await Client.open();
    victim.joinAs(alice);
    await victim.next((m) => m.type === 'peers');

    const attacker = await Client.open();
    // 正しい identity 検証を通すため、alice の claim をそのまま流用する
    // (公開情報なので攻撃者も入手できる)
    attacker.joinAs(alice);
    const err = await attacker.next((m) => m.type === 'error');
    expect(err.message).toBe('peerId already in use');

    victim.close();
    attacker.close();
  });

  it('★奪取に失敗した攻撃者にはリレーが向かない', async () => {
    const victim = await Client.open();
    victim.joinAs(alice);
    await victim.next((m) => m.type === 'peers');

    const attacker = await Client.open();
    attacker.joinAs(alice);
    await attacker.next((m) => m.type === 'error');

    // 第三者が alice 宛にリレーを送る
    const sender = await Client.open();
    sender.joinAs(bob);
    await sender.next((m) => m.type === 'peers');
    sender.send({ type: 'relay', targetPeerId: alice.peerId, payload: { type: 'sdp-relay', sdp: { type: 'offer', sdp: 'x' } } });

    // 本人に届き、攻撃者には届かない
    const got = await victim.next((m) => m.type === 'sdp-relay');
    expect(got.senderId).toBe(bob.peerId);
    expect(attacker.messages.some((m) => m.type === 'sdp-relay')).toBe(false);

    victim.close(); attacker.close(); sender.close();
  });

  it('切断された peerId は再取得できる', async () => {
    const first = await Client.open();
    first.joinAs(alice);
    await first.next((m) => m.type === 'peers');
    first.close();
    await new Promise((r) => setTimeout(r, 100));

    const second = await Client.open();
    second.joinAs(alice);
    await second.next((m) => m.type === 'peers');
    second.close();
  });
});

describe('relay の送信元詐称', () => {
  it('★payload に書かれた senderId をサーバーが上書きする', async () => {
    const a = await Client.open();
    a.joinAs(alice);
    await a.next((m) => m.type === 'peers');

    const m = await Client.open();
    m.joinAs(mallory);
    await m.next((m2) => m2.type === 'peers');

    // mallory が bob を名乗って alice にリレーを送る
    m.send({
      type: 'relay',
      targetPeerId: alice.peerId,
      payload: { type: 'sdp-relay', senderId: bob.peerId, from: bob.peerId, sdp: { type: 'offer', sdp: 'x' } },
    });

    const got = await a.next((x) => x.type === 'sdp-relay');
    expect(got.senderId).toBe(mallory.peerId);
    expect(got.from).toBe(mallory.peerId);

    a.close(); m.close();
  });

  it('join していない接続からのリレーを中継しない', async () => {
    const a = await Client.open();
    a.joinAs(alice);
    await a.next((x) => x.type === 'peers');

    const anon = await Client.open();
    anon.send({ type: 'relay', targetPeerId: alice.peerId, payload: { type: 'sdp-relay', sdp: {} } });

    await new Promise((r) => setTimeout(r, 150));
    expect(a.messages.some((x) => x.type === 'sdp-relay')).toBe(false);

    a.close(); anon.close();
  });

  it('不正な targetPeerId を拒否する', async () => {
    const a = await Client.open();
    a.joinAs(alice);
    await a.next((x) => x.type === 'peers');

    a.send({ type: 'relay', targetPeerId: '../etc/passwd', payload: { sdp: {} } });
    const err = await a.next((x) => x.type === 'error');
    expect(err.message).toBe('Invalid relay target');
    a.close();
  });

  it('自分自身へのリレーを無視する (ループ防止)', async () => {
    const a = await Client.open();
    a.joinAs(alice);
    await a.next((x) => x.type === 'peers');
    const before = a.messages.length;

    a.send({ type: 'relay', targetPeerId: alice.peerId, payload: { sdp: {} } });
    await new Promise((r) => setTimeout(r, 150));
    expect(a.messages.length).toBe(before);
    a.close();
  });
});

describe('購読ゾーンを受け取らない / 配らない', () => {
  it('peers 応答に position も zones も含まれない', async () => {
    const a = await Client.open();
    a.joinAs(alice);
    await a.next((x) => x.type === 'peers');

    const b = await Client.open();
    // 旧クライアントのつもりで zones と position を送りつけてみる
    b.joinAs(bob, { position: 0.42, zones: [1, 2, 3] });
    const peers = await b.next((x) => x.type === 'peers');

    expect(peers.peers.length).toBeGreaterThan(0);
    for (const p of peers.peers) {
      expect(Object.keys(p)).toEqual(['peerId']);
    }

    a.close(); b.close();
  });
});

describe('レート制限', () => {
  it('★join のフラッドを頭打ちにする', async () => {
    // このテストだけ既定のレート制限で立て直す
    tracker.shutdown();
    await new Promise<void>((resolve) => http.close(() => resolve()));

    http = createServer();
    tracker = new TrackerServer(http, { powParams: PARAMS });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/ws`;

    const c = await Client.open();
    for (let i = 0; i < 30; i++) c.joinAs(alice);
    await new Promise((r) => setTimeout(r, 300));

    const rateErrors = c.messages.filter((m) => m.type === 'error' && m.message === 'Rate limit exceeded');
    expect(rateErrors.length).toBeGreaterThan(0);
    c.close();
  });
});
