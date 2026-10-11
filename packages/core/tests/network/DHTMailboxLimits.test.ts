import { describe, it, expect, beforeAll } from 'vitest';
import 'fake-indexeddb/auto';
import { sodiumReady } from '../../src/crypto/sodium';
import { IndexedDBStore } from '../../src/storage/IndexedDBStore';
import { DHTMailbox } from '../../src/network/mailbox/DHTMailbox';
import { MAILBOX_LIMITS } from '../../src/network/mailbox/MailboxEntry';
import { MessageDispatcher } from '../../src/network/MessageDispatcher';
import { WireType } from '../../src/network/wire/WireTypes';
import { JsonBinary } from '../../src/common/JsonBinary';
import { makePacket } from '../helpers/onionNet';

const ME = 'a'.repeat(32);
const PEER = 'b'.repeat(32);

async function setup() {
  const store = new IndexedDBStore(`limits_${Date.now()}_${Math.random()}`);
  await store.init();
  // 隣人が居ないので、どのトピックでも自分が K-nearest になる
  const pm: any = {
    peers: new Map(), myPeerId: ME, myPosition: 0, degree: 0,
    sendMessage: () => {}, on: () => {}, off: () => {},
  };
  const circuit: any = { onExit: () => {} };
  const dispatcher = new MessageDispatcher();
  const mailbox = new DHTMailbox(pm, dispatcher, store, circuit);
  return { store, mailbox, dispatcher };
}

const entry = (i: number) => new TextEncoder().encode(JsonBinary.stringify(makePacket([i, i, i])));
const TOPIC = 'c'.repeat(64);

describe('DHT 保管の上限 (H7)', () => {
  beforeAll(async () => {
    await sodiumReady;
  });

  it('1 トピックに積める件数は上限まで', async () => {
    const { store, dispatcher } = await setup();
    const entries = Array.from({ length: 12 }, (_, i) => entry(i));
    dispatcher.dispatch(PEER, WireType.DHT_PUT, { topicHash: TOPIC, entries });
    await new Promise(r => setTimeout(r, 100));
    expect((await store.get(TOPIC))?.length).toBe(MAILBOX_LIMITS.MAX_ENTRIES_PER_TOPIC);
  });

  it('1 ピアから 1 時間に受け入れる量に上限がある (他のピアには影響しない)', async () => {
    const { mailbox } = await setup();
    const m = mailbox as any;
    expect(m.chargePeerQuota(PEER, MAILBOX_LIMITS.MAX_BYTES_PER_PEER_PER_HOUR)).toBe(true);
    expect(m.chargePeerQuota(PEER, 1)).toBe(false);
    expect(m.chargePeerQuota('d'.repeat(32), 1)).toBe(true);
  });

  it('保持期限を過ぎたトピックは消える', async () => {
    const { store, mailbox } = await setup();
    await store.put(TOPIC, [entry(1)]);
    await mailbox.pruneExpired(Date.now() + MAILBOX_LIMITS.RETENTION_MS + 1000);
    expect(await store.get(TOPIC)).toBeUndefined();
  });
});
