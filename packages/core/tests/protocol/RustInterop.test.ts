import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { WireCodec } from '../../src/network/wire/WireCodec';
import { WireType } from '../../src/network/wire/WireTypes';
import { toBytes, powPreimage, powHash, derivePacketId, solvePow } from '../../src/crypto/PowPolicy';
import { NodeIdentity, NODE_ID_POW_FAST } from '../../src/crypto/NodeIdentity';
import { PacketValidator } from '../../src/network/gossip/PacketValidator';
import { checkEntry } from '../../src/network/mailbox/MailboxEntry';
import { hintId, parseHintPacket, verifyHintPow } from '../../src/network/hint/HintPacket';
import { buildHint } from '../../src/network/hint/HintCrypto';
import { encodeSlotBlob } from '../../src/network/hint/SlotBlob';
import { JsonBinary } from '../../src/common/JsonBinary';

/**
 * Rust 実装 (aether-cache) とのワイヤ相互運用。
 *
 * ベクタは web/tests/vectors からの複製:
 *   - rust_wire_frames.json : Rust が符号化したフレーム (Rust → TS)
 *   - interop_vectors.json  : TS (旧 web 実装) が符号化したフレームと暗号プリミティブ。
 *                             aether-cache/tests/wire_interop.rs と interop_vectors.rs が
 *                             これを Rust 側で読む (TS → Rust)
 *
 * @aether/core の WireCodec がこの 2 つと今もバイト単位で一致することを固定する。
 * 一致していれば、Rust 側のテストが core の出力も保証していることになる。
 *
 * ★ 既知の非互換 (このファイルで明示的に固定する):
 *   - JOIN の署名ドメイン: Rust は "AETHER/v3/join" ‖ challenge、core は v4 (接続束縛)。
 *     Rust の JOIN は core の検証器を通らない (core 側の fail-closed は意図どおり)。
 */

const VECTOR_DIR = join(__dirname, 'vectors');
let rust: Record<string, any>;
let iv: Record<string, any>;

beforeAll(async () => {
  await sodiumReady;
  rust = JSON.parse(readFileSync(join(VECTOR_DIR, 'rust_wire_frames.json'), 'utf8'));
  iv = JSON.parse(readFileSync(join(VECTOR_DIR, 'interop_vectors.json'), 'utf8'));
});

const hex = (b: Uint8Array) => sodium.to_hex(b);
function decodeRust(name: string) {
  const h = rust[name];
  expect(h, `missing Rust frame \`${name}\``).toBeTypeOf('string');
  return WireCodec.decode(sodium.from_hex(h));
}

describe('Rust が符号化したフレームを core が読める (Rust → TS)', () => {
  it('PING / PONG (ts は f64 で届く)', () => {
    const ping = decodeRust('ping');
    expect(ping.type).toBe(WireType.PING);
    expect(ping.payload.ts).toBe(1_700_000_000_000);
    const pong = decodeRust('pong');
    expect(pong.type).toBe(WireType.PONG);
    expect(pong.payload.ts).toBe(1_700_000_000_000);
    expect(pong.payload.echoTs).toBe(1_700_000_000_000);
  });

  it('HELLO の challenge が bin として 32 バイトで復元される', () => {
    const { type, payload } = decodeRust('hello');
    expect(type).toBe(WireType.HELLO);
    expect(payload.challenge).toBeInstanceOf(Uint8Array);
    expect(hex(payload.challenge)).toBe(rust.expected.challenge);
  });

  it('JOIN の全フィールドが復元される', () => {
    const { type, payload } = decodeRust('join');
    expect(type).toBe(WireType.JOIN);
    expect(payload.peerId).toBe(rust.expected.peerId);
    expect(hex(toBytes(payload.pubkey))).toBe(rust.expected.pubkey);
    expect(hex(toBytes(payload.signature))).toBe(rust.expected.signature);
    expect(payload.powCounter).toBe(16);
    // Bound Identity の束縛と NodeId PoW は Rust/TS で一致している
    expect(NodeIdentity.verifyClaim({ peerId: payload.peerId, pubkey: payload.pubkey, powCounter: payload.powCounter }, NODE_ID_POW_FAST)).toBe(true);
  });

  it('★既知の非互換: Rust の JOIN は v3 署名なので core (v4) の検証器では受理されない', () => {
    const { payload } = decodeRust('join');
    const challenge = toBytes(payload.challenge);
    // 署名そのものは v3 の正準メッセージに対して正しい
    const v3 = new Uint8Array([...new TextEncoder().encode('AETHER/v3/join'), ...challenge]);
    expect(sodium.crypto_sign_verify_detached(toBytes(payload.signature), v3, toBytes(payload.pubkey))).toBe(true);
    // core は v4 (接続束縛) しか受け付けない。どんな束縛を仮定しても通らない
    const claim = { peerId: payload.peerId, pubkey: payload.pubkey, powCounter: payload.powCounter, challenge, signature: payload.signature };
    for (const binding of [
      { verifierId: '', signerFingerprint: '', verifierFingerprint: '' },
      { verifierId: '0'.repeat(32), signerFingerprint: 'x', verifierFingerprint: 'y' },
    ]) {
      expect(NodeIdentity.verifySignedClaim(claim, challenge, binding, NODE_ID_POW_FAST)).toBe(false);
    }
  });

  it('GOSSIP: Rust が中継したパケットを core の検証器が受理する', () => {
    const { type, payload } = decodeRust('gossip');
    expect(type).toBe(WireType.GOSSIP);
    const packet = payload.packet;
    expect(packet.packet_id).toBe(rust.expected.gossipPacketId);
    expect(hex(toBytes(packet.payload))).toBe(rust.expected.gossipPayload);
    expect(hex(toBytes(packet.nonce))).toBe(rust.expected.gossipNonce);
    expect(packet.hop_count).toBe(rust.expected.gossipHopCount);
    expect(PacketValidator.check(packet, { now: packet.timestamp })).toEqual({ ok: true });
  });

  it('STEM: ホップカウンタを持たない', () => {
    const { type, payload } = decodeRust('stem');
    expect(type).toBe(WireType.STEM);
    expect(payload.packet.packet_id).toBe(rust.expected.gossipPacketId);
    expect(payload).not.toHaveProperty('stemTtl');
    expect(payload).not.toHaveProperty('stem_ttl');
  });

  it('HINT: 形式・id・PoW が core と一致する (Rust が TTL を減らしても id は不変)', () => {
    const { type, payload } = decodeRust('hint');
    expect(type).toBe(WireType.HINT);
    const hint = parseHintPacket(payload);
    expect(hint).not.toBeNull();
    expect(hint!.ttl).toBe(7);
    expect(hex(hint!.blind_tag)).toBe(rust.expected.hintBlindTag);
    expect(hex(hint!.nonce)).toBe(rust.expected.hintNonce);
    expect(hex(hint!.ciphertext)).toBe(rust.expected.hintCiphertext);
    expect(hintId(hint!)).toBe(rust.expected.hintId);
    expect(verifyHintPow(hint!)).toBe(true);
  });

  it('DHT_RES: Rust が返した過去ログのエントリが core の検証を通る', () => {
    const { type, payload } = decodeRust('dhtRes');
    expect(type).toBe(WireType.DHT_RES);
    expect(payload.topicHash).toBe(rust.expected.dhtTopicHash);
    expect(payload.reqId).toBe('req_42');
    const entry = toBytes(payload.entries[0]);
    expect(hex(entry)).toBe(rust.expected.dhtEntry);
    const gossip = decodeRust('gossip').payload.packet;
    const check = checkEntry(entry, gossip.timestamp);
    expect(check.ok, check.reason).toBe(true);
    expect(check.packet!.packet_id).toBe(rust.expected.gossipPacketId);
  });

  it('PEX_RESPONSE: id だけ (position / zones は無い)', () => {
    const { type, payload } = decodeRust('pexResponse');
    expect(type).toBe(WireType.PEX_RESPONSE);
    expect(payload.peers).toEqual([{ id: rust.expected.peerId }]);
  });

  it('Rust はバイト列を bin 型で送る ({_type, data} 形式に戻っていない)', () => {
    for (const name of ['hello', 'join', 'gossip', 'hint']) {
      const text = new TextDecoder('latin1').decode(sodium.from_hex(rust[name]));
      expect(text, name).not.toContain('_type');
    }
  });

  it('core が再符号化したフレームは Rust のフレームと同じバイト列になる (数値表現が同じものに限る)', () => {
    // Rust は ts を f64 で送るので PING/PONG は除く (core は整数として符号化する)
    for (const name of ['hello', 'join', 'gossip', 'stem', 'hint', 'dhtRes', 'pexResponse']) {
      const { type, payload } = decodeRust(name);
      expect(hex(WireCodec.encode(type, payload)), name).toBe(rust[name]);
    }
  });
});

describe('core が符号化したフレームが旧 TS ベクタと一致する (TS → Rust)', () => {
  // aether-cache/tests/wire_interop.rs はこのバイト列を Rust で decode している。
  // core の出力が同一なら、Rust 側のテストが core の出力も保証する。
  it('全 tsFrames を core の WireCodec がバイト単位で再現する', () => {
    const header = {
      timestamp: iv.gossipPow.header.timestamp,
      zone_id: iv.gossipPow.header.zone_id,
      pow_difficulty: iv.gossipPow.header.pow_difficulty,
      nonce: sodium.from_hex(iv.gossipPow.header.nonce),
      payload: sodium.from_hex(iv.gossipPow.header.payload),
    };
    const kp = sodium.crypto_sign_seed_keypair(sodium.from_hex(iv.boundIdentity.seed));
    const peerId = NodeIdentity.derivePeerId(kp.publicKey);
    const challenge = sodium.from_hex(iv.wire.expected.challenge);
    const signature = sodium.from_hex(iv.wire.expected.signature);
    const gossipPacket = {
      packet_id: derivePacketId(header),
      hop_count: 3,
      pow_nonce: iv.gossipPow.solvedNonce,
      pow_difficulty: header.pow_difficulty,
      timestamp: header.timestamp,
      zone_id: header.zone_id,
      nonce: header.nonce,
      payload: header.payload,
    };
    const mailboxEntry = new TextEncoder().encode(JsonBinary.stringify(gossipPacket));
    const hintPacket = buildHint(
      new Uint8Array(32).fill(0x5a),
      { nonce: new Uint8Array(32).fill(0x3c), message_id: 7, timestamp: 1_700_000_000_000 },
      { unsafeFixedNonceForVectors: new Uint8Array(12).fill(0x11) },
    );
    expect(hintId(hintPacket)).toBe(iv.wire.expected.hintId);

    const frames: Record<string, Uint8Array> = {
      ping: WireCodec.encode(WireType.PING, { ts: iv.wire.expected.pingTs }),
      hello: WireCodec.encode(WireType.HELLO, { challenge }),
      join: WireCodec.encode(WireType.JOIN, { peerId, pubkey: kp.publicKey, powCounter: iv.wire.expected.powCounter, challenge, signature }),
      gossip: WireCodec.encode(WireType.GOSSIP, { packet: gossipPacket }),
      stem: WireCodec.encode(WireType.STEM, { zoneId: gossipPacket.zone_id, packet: gossipPacket }),
      hint: WireCodec.encode(WireType.HINT, hintPacket),
      hintStem: WireCodec.encode(WireType.HINT_STEM, hintPacket),
      dhtPutSlot: WireCodec.encode(WireType.DHT_PUT, { topicHash: 'cd'.repeat(32), entries: [encodeSlotBlob(hintPacket, mailboxEntry)] }),
      dhtPutStem: WireCodec.encode(WireType.DHT_PUT_STEM, { topicHash: 'ab'.repeat(32), entries: [mailboxEntry] }),
      dhtPut: WireCodec.encode(WireType.DHT_PUT, { topicHash: 'ab'.repeat(32), entries: [mailboxEntry] }),
      pexResponse: WireCodec.encode(WireType.PEX_RESPONSE, { peers: [{ id: peerId }] }),
    };
    expect(Object.keys(frames).sort()).toEqual(Object.keys(iv.wire.tsFrames).sort());
    for (const [name, bytes] of Object.entries(frames)) {
      expect(hex(bytes), name).toBe(iv.wire.tsFrames[name]);
    }
    expect(hex(mailboxEntry)).toBe(iv.wire.expected.dhtEntry);
  });

  it('暗号プリミティブ: Gossip PoW / Bound Identity / NodeId PoW が一致する', () => {
    const g = iv.gossipPow;
    const header = { ...g.header, nonce: sodium.from_hex(g.header.nonce), payload: sodium.from_hex(g.header.payload) };
    const pre = powPreimage(header);
    expect(hex(pre)).toBe(g.preimage);
    expect(derivePacketId(header)).toBe(g.packetId);
    expect(hex(powHash(pre, 0n))).toBe(g.powHashAtNonce0);
    expect(Number(solvePow(header))).toBe(g.solvedNonce);
    expect(hex(powHash(pre, BigInt(g.solvedNonce)))).toBe(g.powHashAtSolvedNonce);

    const b = iv.boundIdentity;
    const kp = sodium.crypto_sign_seed_keypair(sodium.from_hex(b.seed));
    expect(hex(kp.publicKey)).toBe(b.pubkey);
    expect(NodeIdentity.derivePeerId(kp.publicKey)).toBe(b.peerId);
    expect(NodeIdentity.derivePosition(b.peerId)).toBe(b.position);

    const n = iv.nodeIdPow;
    expect(NodeIdentity.solveNodeIdPow(kp.publicKey, n.params)).toBe(n.counter);
    expect(hex(NodeIdentity.nodeIdPowHash(kp.publicKey, 0, n.params))).toBe(n.hashAtCounter0);
    expect(hex(NodeIdentity.nodeIdPowHash(kp.publicKey, n.counter, n.params))).toBe(n.hashAtSolvedCounter);
  });
});

describe('WireType 番号の対応 (aether-cache/src/network/wire.rs と同じ意味)', () => {
  // Rust 側の enum WireType を写したもの。Rust に存在しない
  // ONION_STEM (0x44) と LOCAL_LINK_* (0x14-0x16) は Rust では Unknown になる。
  const RUST_WIRE_TYPES: Record<string, number> = {
    JOIN: 0x10, RING_INFO: 0x11, PING: 0x12, PONG: 0x13, HELLO: 0x17,
    PEX_REQUEST: 0x20, PEX_RESPONSE: 0x21, SDP_RELAY: 0x30, ICE_RELAY: 0x31,
    GOSSIP: 0x40, STEM: 0x41, HINT: 0x42, HINT_STEM: 0x43,
    DHT_PUT: 0x50, DHT_GET: 0x51, DHT_RES: 0x52, DHT_PUT_STEM: 0x53,
  };

  it('Rust が知っている番号はすべて core でも同じ名前・同じ値', () => {
    for (const [name, value] of Object.entries(RUST_WIRE_TYPES)) {
      expect((WireType as any)[name], name).toBe(value);
    }
  });
});
