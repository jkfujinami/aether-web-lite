import sodium from '../../src/crypto/sodium';
import { Encoding } from '../../src/common/Encoding';
import { JsonBinary } from '../../src/common/JsonBinary';
import { buildHint, mailboxKeyFromNonce, type HintPayload } from '../../src/network/hint/HintCrypto';
import type { HintPacket } from '../../src/network/hint/HintPacket';
import { encodeSlotBlob } from '../../src/network/hint/SlotBlob';
import type { GossipPacket } from '../../src/types';
import { makePacket } from './onionNet';

/**
 * Hint / Mailbox テスト専用のフェイク群。
 * 既存の helpers (fakes.ts / onionNet.ts) は読み取り専用で再利用する。
 */

export interface FakePeer {
  peerId: string;
  position: number;
  rtt: number;
  isConnected: boolean;
  isVerified: boolean;
  send: (msg: any) => void;
  close: () => void;
}

export interface SentMessage {
  to: string;
  type: number;
  payload: any;
}

/** IPeerManager の最小実装。送信はすべて記録するだけ */
export class FakePeerManager {
  public peers = new Map<string, FakePeer>();
  public sent: SentMessage[] = [];
  private handlers = new Map<string, Set<(...args: any[]) => void>>();

  constructor(public myPeerId: string = 'me'.padEnd(32, '0'), public myPosition = 0) {}

  get degree(): number {
    return [...this.peers.values()].filter(p => p.isConnected && p.isVerified).length;
  }

  addPeer(peerId: string, position: number, opts: { connected?: boolean; verified?: boolean } = {}): FakePeer {
    const peer: FakePeer = {
      peerId,
      position,
      rtt: 0,
      isConnected: opts.connected ?? true,
      isVerified: opts.verified ?? true,
      send: () => {},
      close: () => {},
    };
    this.peers.set(peerId, peer);
    return peer;
  }

  sendMessage(to: string, type: number, payload: any): void {
    this.sent.push({ to, type, payload });
  }

  sentOfType(type: number): SentMessage[] {
    return this.sent.filter(m => m.type === type);
  }

  connect(): undefined {
    return undefined;
  }

  disconnect(): void {}

  on(event: string, handler: (...args: any[]) => void): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: (...args: any[]) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, ...args: any[]): void {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

/** OnionCircuit の最小実装。出口ハンドラを手で発火できる */
export class FakeCircuit {
  public handlers = new Map<string, Set<(payload: any, from: string) => void>>();
  public sends: Array<{ payload: any; echoId: string }> = [];
  public sendResult = true;

  onExit(type: string, handler: (payload: any, from: string) => void): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
  }

  async send(payload: any, echoId: string): Promise<boolean> {
    this.sends.push({ payload, echoId });
    return this.sendResult;
  }

  fireExit(type: string, payload: any, from = 'exit-prev'): void {
    for (const h of this.handlers.get(type) ?? []) h(payload, from);
  }
}

/** DandelionRouter のうち HintRouter が触る部分だけ */
export class FakeDandelion {
  public echoes: string[] = [];
  notifyEcho(id: string): void {
    this.echoes.push(id);
  }
}

/**
 * IndexedDBStore の Mailbox 部分を模したメモリストア。
 * `locked = true` で本物と同じく読み書きが例外になる (ロック後の挙動の検証用)。
 */
export class MemoryMailboxStore {
  public locked = false;
  public data = new Map<string, { entries: Uint8Array[]; lastUpdated: number }>();
  /** 指定するとトピック一覧をこの件数ぶん水増しして返す (MAX_TOPICS の検証用) */
  public phantomTopics = 0;
  /** 指定すると使用量をこの値で返す */
  public usageOverride: number | null = null;

  private check(): void {
    if (this.locked) throw new Error('IndexedDBStore is locked; call unlock(passphrase) first');
  }

  async get(topicHash: string): Promise<Uint8Array[] | undefined> {
    this.check();
    const rec = this.data.get(topicHash);
    return rec ? rec.entries.map(e => e.slice()) : undefined;
  }

  async put(topicHash: string, newEntries: Uint8Array[]): Promise<void> {
    this.check();
    const rec = this.data.get(topicHash);
    if (!rec) {
      this.data.set(topicHash, { entries: newEntries.map(e => e.slice()), lastUpdated: Date.now() });
      return;
    }
    const have = new Set(rec.entries.map(e => Encoding.toHex(e)));
    let changed = false;
    for (const e of newEntries) {
      if (!have.has(Encoding.toHex(e))) {
        rec.entries.push(e.slice());
        changed = true;
      }
    }
    if (changed) rec.lastUpdated = Date.now();
  }

  async getAllTopicHashes(): Promise<string[]> {
    this.check();
    const real = [...this.data.keys()];
    const phantom = Array.from({ length: this.phantomTopics }, (_, i) => `phantom${i}`);
    return [...real, ...phantom];
  }

  async mailboxUsageBytes(): Promise<number> {
    this.check();
    if (this.usageOverride !== null) return this.usageOverride;
    let n = 0;
    for (const rec of this.data.values()) for (const e of rec.entries) n += e.byteLength;
    return n;
  }

  async pruneMailbox(cutoff: number): Promise<{ topics: number; bytes: number }> {
    this.check();
    let topics = 0;
    let bytes = 0;
    for (const [k, rec] of this.data) {
      if (rec.lastUpdated < cutoff) {
        topics++;
        bytes += rec.entries.reduce((a, e) => a + e.byteLength, 0);
        this.data.delete(k);
      }
    }
    return { topics, bytes };
  }
}

/** 決定論的な Hint を作る (同じ seed なら毎回同じバイト列) */
export function fixedHint(k: Uint8Array, seed: number, messageId = 1, timestamp = 1_700_000_040_000): {
  hint: HintPacket;
  payload: HintPayload;
} {
  const payload: HintPayload = {
    nonce: new Uint8Array(32).fill(seed & 0xff),
    message_id: messageId,
    timestamp,
  };
  const hint = buildHint(k, payload, { unsafeFixedNonceForVectors: new Uint8Array(12).fill((seed + 1) & 0xff) });
  return { hint, payload };
}

/** JSON 化した (CHK・PoW が整合した) GossipPacket のバイト列 */
export function packetBytes(packet: GossipPacket = makePacket()): Uint8Array {
  return new TextEncoder().encode(JsonBinary.stringify(packet));
}

/** 正当な Slot (hint_blob ‖ body_blob) を 1 つ作る */
export function makeSlot(k: Uint8Array, opts: { messageId?: number; packet?: GossipPacket } = {}) {
  const nonce = sodium.randombytes_buf(32);
  const payload: HintPayload = { nonce, message_id: opts.messageId ?? 1, timestamp: 1_700_000_040_000 };
  const hint = buildHint(k, payload);
  const packet = opts.packet ?? makePacket(sodium.randombytes_buf(16));
  const body = packetBytes(packet);
  const entry = encodeSlotBlob(hint, body);
  const keyHex = Encoding.toHex(mailboxKeyFromNonce(nonce));
  return { hint, payload, packet, body, entry, keyHex };
}

/** topicHash の先頭 8 桁からリング座標を求める (DHTMailbox と同じ式) */
export function topicPosition(topicHashHex: string): number {
  return (parseInt(topicHashHex.substring(0, 8), 16) || 0) / 0xffffffff;
}

/** 任意の 32bit 先頭値を持つ topicHash */
export function topicAt(prefix32: number, fill = '0'): string {
  return (prefix32 >>> 0).toString(16).padStart(8, '0') + fill.repeat(56);
}

/** マイクロタスクと即時タイマーを数回流す (fake timers 非使用時) */
export const flush = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0));
};
