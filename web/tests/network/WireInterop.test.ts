import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sodium from 'libsodium-wrappers-sumo';
import { WireCodec } from '@/lib/network/wire/WireCodec';
import { WireType } from '@/lib/network/wire/WireTypes';
import { toBytes } from '@/lib/crypto/PowPolicy';
import { NodeIdentity, NODE_ID_POW_FAST } from '@/lib/crypto/NodeIdentity';
import { PacketValidator } from '@/lib/network/gossip/PacketValidator';
import { checkEntry } from '@/lib/network/mailbox/MailboxEntry';

/**
 * Rust → TypeScript のワイヤ相互運用テスト。
 *
 * 逆方向 (TS → Rust) は `aether-cache/tests/wire_interop.rs` が担う。
 * この 2 つで両方向のフレーム符号化が縛られる。
 *
 * ここが無かったために、`JsonBytes` の untagged enum が MsgPack の bin 型を
 * 読めず「バイト列を含むメッセージが Rust 側で 1 通も復号できない」状態を
 * 長期間見逃していた。暗号プリミティブの一致だけでは足りない。
 *
 * ベクタの再生成:
 *     cd aether-cache && cargo test --test wire_interop
 */

const VECTOR_PATH = join(__dirname, '../vectors/rust_wire_frames.json');

let frames: Record<string, string>;
let expected: Record<string, string | number>;

beforeAll(async () => {
  await sodium.ready;

  if (!existsSync(VECTOR_PATH)) {
    throw new Error(
      `rust_wire_frames.json が見つかりません。` +
      `\`cd aether-cache && cargo test --test wire_interop\` を実行して生成してください。`,
    );
  }
  const raw = JSON.parse(readFileSync(VECTOR_PATH, 'utf8'));
  expected = raw.expected;
  frames = raw;
});

function decode(name: string) {
  const hex = frames[name];
  expect(hex, `missing Rust frame \`${name}\``).toBeTypeOf('string');
  return WireCodec.decode(sodium.from_hex(hex));
}

describe('Rust が符号化したフレームを TypeScript が読める', () => {
  it('PING', () => {
    const { type, payload } = decode('ping');
    expect(type).toBe(WireType.PING);
    expect(payload.ts).toBe(1_700_000_000_000);
  });

  it('PONG', () => {
    const { type, payload } = decode('pong');
    expect(type).toBe(WireType.PONG);
    expect(payload.ts).toBe(1_700_000_000_000);
  });

  it('★HELLO の challenge がバイト列として復元される', () => {
    const { type, payload } = decode('hello');
    expect(type).toBe(WireType.HELLO);
    const challenge = toBytes(payload.challenge);
    expect(challenge.length).toBe(32);
    expect(sodium.to_hex(challenge)).toBe(expected.challenge);
  });

  it('★JOIN の全バイト列フィールドが復元される', () => {
    const { type, payload } = decode('join');
    expect(type).toBe(WireType.JOIN);
    expect(payload.peerId).toBe(expected.peerId);
    expect(sodium.to_hex(toBytes(payload.pubkey))).toBe(expected.pubkey);
    expect(sodium.to_hex(toBytes(payload.signature))).toBe(expected.signature);
    expect(toBytes(payload.signature).length).toBe(64);
    expect(typeof payload.powCounter).toBe('number');
  });

  it('★Rust が署名した JOIN を TypeScript が検証できる', () => {
    const { payload } = decode('join');
    const challenge = toBytes(payload.challenge);
    const claim = {
      peerId: payload.peerId,
      pubkey: toBytes(payload.pubkey),
      powCounter: payload.powCounter,
      challenge,
      signature: toBytes(payload.signature),
    };
    expect(NodeIdentity.verifySignedClaim(claim, challenge, NODE_ID_POW_FAST)).toBe(true);
  });

  it('★GOSSIP の nonce / payload が復元される', () => {
    const { type, payload } = decode('gossip');
    expect(type).toBe(WireType.GOSSIP);
    const packet = payload.packet;
    expect(packet.packet_id).toBe(expected.gossipPacketId);
    expect(sodium.to_hex(toBytes(packet.payload))).toBe(expected.gossipPayload);
    expect(sodium.to_hex(toBytes(packet.nonce))).toBe(expected.gossipNonce);
    expect(packet.hop_count).toBe(expected.gossipHopCount);
  });

  it('★Rust が中継したパケットを TypeScript の検証器が受理する', () => {
    const { payload } = decode('gossip');
    const packet = payload.packet;
    const result = PacketValidator.check(packet, { now: packet.timestamp, allowStale: true });
    expect(result).toEqual({ ok: true });
  });

  it('STEM', () => {
    const { type, payload } = decode('stem');
    expect(type).toBe(WireType.STEM);
    expect(payload.packet.packet_id).toBe(expected.gossipPacketId);
    // ★ ホップカウンタは載っていないこと。
    //   載せると上限値が「発信元しか出せない値」になり、受け取った中継者が
    //   発信元を 100% 確定できてしまう (詳細は DandelionRouter.ts)。
    expect(payload).not.toHaveProperty('stemTtl');
    expect(payload).not.toHaveProperty('stem_ttl');
  });

  it('★DHT_RES のエントリが TypeScript の検証を通る', () => {
    const { type, payload } = decode('dhtRes');
    expect(type).toBe(WireType.DHT_RES);
    expect(payload.topicHash).toBe(expected.dhtTopicHash);
    expect(payload.reqId).toBe('req_42');
    expect(payload.entries).toHaveLength(1);

    const entry = toBytes(payload.entries[0]);
    expect(sodium.to_hex(entry)).toBe(expected.dhtEntry);

    // Rust が返した過去ログをそのまま検証できること。
    // DHT は保管庫なので古いエントリは正当だが、未来日付は拒否される。
    // 固定ベクタなので「パケットと同時刻」を現在時刻として渡す。
    const { payload: gossipPayload } = decode('gossip');
    const check = checkEntry(entry, gossipPayload.packet.timestamp);
    expect(check.ok, `rejected: ${check.reason}`).toBe(true);
    expect(check.packet!.packet_id).toBe(expected.gossipPacketId);
  });

  it('PEX_RESPONSE に position も zones も含まれない', () => {
    const { type, payload } = decode('pexResponse');
    expect(type).toBe(WireType.PEX_RESPONSE);
    expect(payload.peers).toHaveLength(1);
    expect(payload.peers[0].id).toBe(expected.peerId);
    expect(payload.peers[0]).not.toHaveProperty('position');
    expect(payload.peers[0]).not.toHaveProperty('zones');
  });
});

describe('Rust 側がバイト列を bin 型で送っている', () => {
  it('★{_type, data} 形式へのフォールバックが起きていない', () => {
    // 旧形式はバイナリが約 2 倍に膨らむ (本家 18.6.2 が不採用にした形式)。
    // ここが戻るとブラウザ↔Rust の帯域が倍になる。
    for (const name of ['hello', 'join', 'gossip']) {
      const bytes = sodium.from_hex(frames[name]);
      const text = new TextDecoder('latin1').decode(bytes);
      expect(text, `${name} must not contain the legacy tag`).not.toContain('_type');
    }
  });

  it('HELLO の challenge が bin8 (0xc4 0x20) で符号化されている', () => {
    const bytes = sodium.from_hex(frames.hello);
    let found = false;
    for (let i = 0; i < bytes.length - 1; i++) {
      if (bytes[i] === 0xc4 && bytes[i + 1] === 0x20) { found = true; break; }
    }
    expect(found).toBe(true);
  });
});

describe('往復', () => {
  it('TypeScript が再符号化したものを TypeScript が読み戻せる', () => {
    for (const name of ['hello', 'join', 'gossip', 'pexResponse']) {
      const { type, payload } = decode(name);
      const reencoded = WireCodec.encode(type, payload);
      const back = WireCodec.decode(reencoded);
      expect(back.type, name).toBe(type);
    }
  });
});
