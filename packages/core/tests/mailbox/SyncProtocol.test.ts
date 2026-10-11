import { describe, it, expect, beforeAll, vi } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { PacketBuilder } from '../../src/crypto/PacketBuilder';
import { CryptoEngine } from '../../src/crypto/CryptoEngine';
import { KeyManager } from '../../src/crypto/KeyManager';
import { PoWEngine } from '../../src/crypto/PoWEngine';
import { JsonBinary } from '../../src/common/JsonBinary';
import { SyncProtocol } from '../../src/network/mailbox/SyncProtocol';
import { encodeSlotBlob } from '../../src/network/hint/SlotBlob';
import type { GossipPacket, IIdentity } from '../../src/types';
import { fixedHint } from '../helpers/hintMailboxFakes';

const keyManager = {
  deriveThreadKey: KeyManager.deriveThreadKey,
  deriveTopicHash: KeyManager.deriveTopicHash,
  computeZoneId: KeyManager.computeZoneId,
};
const powEngine = { compute: async (h: any) => PoWEngine.computeSync(h) };

let BOARD_KEY: Uint8Array;
const BOARD = 'board-1';
const THREAD = 'thread-1';

function identity(): IIdentity {
  const session = sodium.crypto_sign_keypair();
  return {
    sign: (data: Uint8Array) => ({
      sessionPubkey: session.publicKey,
      sessionSignature: sodium.crypto_sign_detached(data, session.privateKey),
      tripPubkey: null,
      tripSignature: null,
    }),
  };
}

async function buildPost(threadKey: Uint8Array, content: string, threadId = THREAD): Promise<GossipPacket> {
  return PacketBuilder.build(content, threadKey, identity(), new CryptoEngine(), powEngine, keyManager, BOARD, threadId, 1, null, 8, 0);
}

const bytesOf = (p: unknown) => new TextEncoder().encode(JsonBinary.stringify(p));

function setup(entries: Uint8Array[]) {
  const mailbox = { fetch: vi.fn(async (_t: string) => entries), replicate: vi.fn() };
  const store = { save: vi.fn(async (_p: any) => {}), getPosts: vi.fn(async () => []) };
  const sync = new SyncProtocol(mailbox as any, new CryptoEngine(), keyManager, store as any);
  return { mailbox, store, sync };
}

beforeAll(async () => {
  await sodiumReady;
  BOARD_KEY = sodium.randombytes_buf(32);
});

describe('SyncProtocol: スレッドの過去ログ同期', () => {
  it('スレッド鍵から導いた topicHash で DHT に問い合わせる', async () => {
    const { sync, mailbox } = setup([]);
    expect(await sync.syncThread(BOARD, THREAD, BOARD_KEY)).toBe(0);
    const threadKey = KeyManager.deriveThreadKey(BOARD_KEY, THREAD);
    expect(mailbox.fetch).toHaveBeenCalledWith(KeyManager.toHex(KeyManager.deriveTopicHash(threadKey)));
  });

  it('★正しいスレッド鍵で開けて署名も通る投稿だけを保存する', async () => {
    const threadKey = KeyManager.deriveThreadKey(BOARD_KEY, THREAD);
    const good = bytesOf(await buildPost(threadKey, 'hello'));
    const { sync, store } = setup([good]);
    expect(await sync.syncThread(BOARD, THREAD, BOARD_KEY)).toBe(1);
    expect(store.save).toHaveBeenCalledTimes(1);
    const saved = store.save.mock.calls[0][0];
    expect(saved.boardId).toBe(BOARD);
    expect(saved.threadId).toBe(THREAD);
    expect(saved.payload).toBe(good);
    expect(saved.dag).toEqual({ parents: [], cumulative_pow: 0, thread_root: THREAD });
  });

  it('★別のスレッドの鍵で封じた投稿は保存しない (横取り・混入を防ぐ)', async () => {
    const otherKey = KeyManager.deriveThreadKey(BOARD_KEY, 'thread-2');
    const { sync, store } = setup([bytesOf(await buildPost(otherKey, 'other', 'thread-2'))]);
    expect(await sync.syncThread(BOARD, THREAD, BOARD_KEY)).toBe(0);
    expect(store.save).not.toHaveBeenCalled();
  });

  it('★改竄された暗号文は保存しない', async () => {
    const threadKey = KeyManager.deriveThreadKey(BOARD_KEY, THREAD);
    const p = await buildPost(threadKey, 'hello');
    const payload = (p.payload as Uint8Array).slice();
    payload[payload.length - 1] ^= 1;
    const { sync, store } = setup([bytesOf({ ...p, payload })]);
    expect(await sync.syncThread(BOARD, THREAD, BOARD_KEY)).toBe(0);
    expect(store.save).not.toHaveBeenCalled();
  });

  it('★壊れたエントリ・Slot 形式のエントリが混ざっていても例外を投げず、正当なものだけ数える', async () => {
    const threadKey = KeyManager.deriveThreadKey(BOARD_KEY, THREAD);
    const good = bytesOf(await buildPost(threadKey, 'ok'));
    const slot = encodeSlotBlob(fixedHint(new Uint8Array(32).fill(1), 1).hint, good);
    const entries = [
      new Uint8Array(0),
      new TextEncoder().encode('not json'),
      new TextEncoder().encode('null'),
      new TextEncoder().encode('{"payload":"x"}'),
      sodium.randombytes_buf(64),
      slot,
      good,
    ];
    const { sync, store } = setup(entries);
    await expect(sync.syncThread(BOARD, THREAD, BOARD_KEY)).resolves.toBe(1);
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it('保存に失敗しても同期全体は止まらない', async () => {
    const threadKey = KeyManager.deriveThreadKey(BOARD_KEY, THREAD);
    const a = bytesOf(await buildPost(threadKey, 'a'));
    const b = bytesOf(await buildPost(threadKey, 'b'));
    const { sync, store } = setup([a, b]);
    store.save.mockRejectedValueOnce(new Error('locked'));
    await expect(sync.syncThread(BOARD, THREAD, BOARD_KEY)).resolves.toBeTypeOf('number');
    expect(store.save).toHaveBeenCalledTimes(2);
  });
});
