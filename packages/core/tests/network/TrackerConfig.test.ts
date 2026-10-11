import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { parseTrackerUrl, TRACKER_URL_MAX_LENGTH } from '../../src/network/TrackerUrl';
import { SignalingClient, TrackerNotConfiguredError } from '../../src/network/SignalingClient';
import { PeerManager } from '../../src/network/PeerManager';
import { MessageDispatcher } from '../../src/network/MessageDispatcher';
import { NodeIdentity } from '../../src/crypto/NodeIdentity';
import { AetherNode } from '../../src/node/AetherNode';
import { IndexedDBStore } from '../../src/storage/IndexedDBStore';
import { VAULT_PARAMS_FAST } from '../../src/storage/SecretVault';
import type { WireNodeClaim } from '../../src/types';

const FAST = { difficulty: 0, opsLimit: 1, memLimit: 8192 };

/** 本物の WebSocket の代わり。開く・閉じる・届く を手で起こす */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.());
  }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  static last(): FakeWebSocket { return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]; }
}
const WS = FakeWebSocket as unknown as typeof WebSocket;

const claim = (peerId = 'a'.repeat(32)): WireNodeClaim =>
  ({ peerId, pubkey: new Uint8Array(32), powCounter: 0 }) as WireNodeClaim;

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.useRealTimers();
});

describe('トラッカー URL の検証', () => {
  it('wss:// を受け付け、パスを省略したら /ws にする', () => {
    expect(parseTrackerUrl('wss://tracker.example.org')).toEqual({ ok: true, url: 'wss://tracker.example.org/ws' });
    expect(parseTrackerUrl('  wss://tracker.example.org/  ')).toEqual({ ok: true, url: 'wss://tracker.example.org/ws' });
    expect(parseTrackerUrl('wss://tracker.example.org:8443/signal')).toEqual({ ok: true, url: 'wss://tracker.example.org:8443/signal' });
  });

  it('平文の ws:// は自分の端末 (localhost / 127.0.0.0/8 / ::1) に限る', () => {
    expect(parseTrackerUrl('ws://localhost:3000').ok).toBe(true);
    expect(parseTrackerUrl('ws://127.0.0.1:3000/ws').ok).toBe(true);
    expect(parseTrackerUrl('ws://127.1.2.3/ws').ok).toBe(true);
    expect(parseTrackerUrl('ws://[::1]:3000/ws').ok).toBe(true);

    for (const bad of [
      'ws://tracker.example.org/ws',
      'ws://192.168.1.10:3000/ws',
      'ws://localhost.evil.example/ws',
      'ws://127.0.0.1.evil.example/ws',
      'ws://[::ffff:8.8.8.8]/ws',
    ]) {
      expect(parseTrackerUrl(bad), bad).toEqual({ ok: false, reason: 'insecure' });
    }
  });

  it('ws/wss 以外の方式は拒否する', () => {
    for (const bad of ['https://tracker.example.org', 'http://localhost:3000', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(parseTrackerUrl(bad).ok, bad).toBe(false);
    }
  });

  it('認証情報・クエリ・フラグメントを含む URL は拒否する', () => {
    expect(parseTrackerUrl('wss://user:pw@tracker.example.org/ws')).toEqual({ ok: false, reason: 'credentials' });
    expect(parseTrackerUrl('wss://user@tracker.example.org/ws')).toEqual({ ok: false, reason: 'credentials' });
    expect(parseTrackerUrl('wss://tracker.example.org/ws?id=123')).toEqual({ ok: false, reason: 'query' });
    expect(parseTrackerUrl('wss://tracker.example.org/ws?')).toEqual({ ok: false, reason: 'query' });
    expect(parseTrackerUrl('wss://tracker.example.org/ws#x')).toEqual({ ok: false, reason: 'fragment' });
    expect(parseTrackerUrl('wss://tracker.example.org/ws#')).toEqual({ ok: false, reason: 'fragment' });
  });

  it('空・壊れた値・長すぎる値は拒否する', () => {
    expect(parseTrackerUrl('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseTrackerUrl('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(parseTrackerUrl('tracker.example.org')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseTrackerUrl(undefined as unknown as string)).toEqual({ ok: false, reason: 'empty' });
    expect(parseTrackerUrl('wss://t.example/' + 'a'.repeat(TRACKER_URL_MAX_LENGTH))).toEqual({ ok: false, reason: 'too-long' });
  });
});

describe('SignalingClient: 接続先を推測しない', () => {
  it('URL が未設定なら接続を試みずに失敗する', async () => {
    const client = new SignalingClient(null, { WebSocketImpl: WS });
    expect(client.url).toBeNull();
    await expect(client.connect({ claim: claim() })).rejects.toBeInstanceOf(TrackerNotConfiguredError);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('不正な URL は生成時・変更時ともに例外にし、以前の設定を残す', () => {
    expect(() => new SignalingClient('ws://tracker.example.org/ws', { WebSocketImpl: WS })).toThrow(/insecure/);
    const client = new SignalingClient('wss://a.example', { WebSocketImpl: WS });
    expect(() => client.setUrl('http://b.example')).toThrow();
    expect(client.url).toBe('wss://a.example/ws');
  });

  it('設定した URL にだけ接続し、自分の claim で登録する', async () => {
    const client = new SignalingClient('wss://a.example', { WebSocketImpl: WS });
    const p = client.connect({ claim: claim('b'.repeat(32)) });
    const ws = FakeWebSocket.last();
    expect(ws.url).toBe('wss://a.example/ws');
    ws.open();
    await p;
    expect(client.isConnected).toBe(true);
    expect(ws.sent).toEqual([expect.objectContaining({ type: 'join', peerId: 'b'.repeat(32) })]);
    // 購読ゾーンや位置は送らない
    expect(ws.sent[0]).not.toHaveProperty('zones');
    expect(ws.sent[0]).not.toHaveProperty('position');
  });

  it('接続中に重ねて connect しても、ソケットは 1 本だけ (同じ ID を二重登録しない)', async () => {
    const client = new SignalingClient('wss://a.example', { WebSocketImpl: WS });
    const p1 = client.connect({ claim: claim() });
    const p2 = client.connect({ claim: claim() });
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.last().open();
    await Promise.all([p1, p2]);
    await client.connect({ claim: claim() }); // 接続済みなら何もしない
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.last().sent).toHaveLength(1);
  });

  it('接続先を変えたら古い接続を閉じ、古いトラッカーからの通知は無視する', async () => {
    const client = new SignalingClient('wss://old.example', { WebSocketImpl: WS });
    const peers = vi.fn();
    client.on('peers', peers);
    const p = client.connect({ claim: claim() });
    const old = FakeWebSocket.last();
    old.open();
    await p;

    client.setUrl('wss://new.example');
    expect(old.readyState).toBe(3);
    expect(client.isConnected).toBe(false);
    old.receive({ type: 'peers', peers: [{ peerId: 'c'.repeat(32) }] });
    expect(peers).not.toHaveBeenCalled();

    const p2 = client.connect({ claim: claim() });
    const fresh = FakeWebSocket.last();
    expect(fresh.url).toBe('wss://new.example/ws');
    fresh.open();
    await p2;
    fresh.receive({ type: 'peers', peers: [{ peerId: 'd'.repeat(32) }] });
    expect(peers).toHaveBeenCalledWith([{ peerId: 'd'.repeat(32) }]);
  });

  it('接続待ちの間に URL を変えたら、その接続は失敗として終わる', async () => {
    const client = new SignalingClient('wss://old.example', { WebSocketImpl: WS });
    const p = client.connect({ claim: claim() });
    client.setUrl('wss://new.example');
    await expect(p).rejects.toThrow();
    // 遅れて開いても登録しない
    FakeWebSocket.instances[0].open();
    expect(FakeWebSocket.instances[0].sent).toHaveLength(0);
  });

  it('開く前に閉じられたら失敗する。応答が無ければ時間切れで失敗する', async () => {
    const client = new SignalingClient('wss://a.example', { WebSocketImpl: WS, connectTimeoutMs: 50 });
    const p = client.connect({ claim: claim() });
    FakeWebSocket.last().close();
    await expect(p).rejects.toThrow(/closed/);

    vi.useFakeTimers();
    const p2 = client.connect({ claim: claim() });
    const check = expect(p2).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(60);
    await check;
    expect(FakeWebSocket.last().readyState).toBe(3);
  });
});

describe('PeerManager: トラッカーへの再試行', () => {
  let identity: NodeIdentity;
  beforeAll(async () => {
    identity = await NodeIdentity.mine(FAST);
  });

  it('起動時にトラッカーへ届かなくても、後で再試行する', async () => {
    vi.useFakeTimers();
    const signaling = {
      connect: vi.fn().mockRejectedValueOnce(new Error('unreachable')).mockResolvedValue(undefined),
      disconnect: vi.fn(),
      sendRelay: vi.fn(),
      on: vi.fn(),
      isConnected: false,
    };
    const pm = new PeerManager(identity, new MessageDispatcher(), signaling as any);
    await expect(pm.start()).rejects.toThrow('unreachable');
    expect(signaling.connect).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(signaling.connect).toHaveBeenCalledTimes(2);
    // 再接続できたら、しばらくして切り離す (トラッカーに見られる期間を短く保つ)
    await vi.advanceTimersByTimeAsync(15_000);
    expect(signaling.disconnect).toHaveBeenCalled();
    pm.stop();
  });

  it('停止後は再試行しない', async () => {
    vi.useFakeTimers();
    const signaling = {
      connect: vi.fn().mockRejectedValue(new TrackerNotConfiguredError()),
      disconnect: vi.fn(),
      sendRelay: vi.fn(),
      on: vi.fn(),
      isConnected: false,
    };
    const pm = new PeerManager(identity, new MessageDispatcher(), signaling as any);
    await expect(pm.start()).rejects.toBeInstanceOf(TrackerNotConfiguredError);
    pm.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(signaling.connect).toHaveBeenCalledTimes(1);
    await pm.reconnectTracker();
    expect(signaling.connect).toHaveBeenCalledTimes(1);
  });
});

describe('AetherNode: トラッカーの設定', () => {
  const makeNode = async (signalingClient: SignalingClient) => {
    const db = new IndexedDBStore(`tracker-${Math.random()}`);
    await db.init();
    return AetherNode.create({
      db,
      signalingClient,
      passphrase: 'test-passphrase',
      vaultParams: VAULT_PARAMS_FAST,
      releaseMode: 'disabled',
      autoStart: false,
    });
  };

  it('不正なトラッカー URL では起動しない', async () => {
    const db = new IndexedDBStore(`tracker-bad-${Math.random()}`);
    await db.init();
    await expect(AetherNode.create({
      db,
      trackerUrl: 'ws://tracker.example.org/ws',
      passphrase: 'test-passphrase',
      vaultParams: VAULT_PARAMS_FAST,
      autoStart: false,
    })).rejects.toThrow(/insecure/);
  });

  it('未設定でも起動でき、後から設定するとそのトラッカーへ接続する', async () => {
    const client = new SignalingClient(null, { WebSocketImpl: WS });
    const node = await makeNode(client);
    await node.start();
    expect(node.trackerUrl).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(0);

    const p = node.setTrackerUrl('wss://tracker.example.org');
    expect(node.trackerUrl).toBe('wss://tracker.example.org/ws');
    const ws = FakeWebSocket.last();
    ws.open();
    await p;
    expect(ws.sent[0]).toMatchObject({ type: 'join', peerId: node.peerId });

    // 不正な URL は拒否し、設定は変えない
    await expect(node.setTrackerUrl('ws://tracker.example.org')).rejects.toThrow(/insecure/);
    expect(node.trackerUrl).toBe('wss://tracker.example.org/ws');

    // 未設定に戻すと接続を切る
    await node.setTrackerUrl(null);
    expect(node.trackerUrl).toBeNull();
    expect(ws.readyState).toBe(3);
    await node.stop();
  });

  it('停止中のノードでは設定を保存するだけで接続しない', async () => {
    const client = new SignalingClient(null, { WebSocketImpl: WS });
    const node = await makeNode(client);
    await node.setTrackerUrl('wss://tracker.example.org');
    expect(FakeWebSocket.instances).toHaveLength(0);
    await node.stop();
    await expect(node.setTrackerUrl('wss://other.example')).rejects.toThrow(/stopped/);
  });
});
