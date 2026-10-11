import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { WireCodec } from '../../src/network/wire/WireCodec';
import { WireType } from '../../src/network/wire/WireTypes';
import { NodeIdentity, NODE_ID_POW_FAST, joinMessage, trackerJoinMessage } from '../../src/crypto/NodeIdentity';
import { TRACKER_PROTOCOL_VERSION, TRACKER_MAX_FRAME_BYTES, TRACKER_MAX_PEERS } from '../../src/network/TrackerProtocol';
import { KeyManager } from '../../src/crypto/KeyManager';
import { CryptoEngine } from '../../src/crypto/CryptoEngine';
import { PacketBuilder } from '../../src/crypto/PacketBuilder';
import { MagicFilter } from '../../src/crypto/MagicFilter';
import { OnionRouter, SEALED_EXIT_LAYER_SIZE } from '../../src/crypto/OnionRouter';
import { POW_POLICY, GOSSIP_DOMAIN, powPreimage, derivePacketId, verifyPow } from '../../src/crypto/PowPolicy';
import { PacketValidator } from '../../src/network/gossip/PacketValidator';
import { hintId, parseHintPacket, verifyHintPow, HINT_DOMAIN, ENCODED_HINT_SIZE } from '../../src/network/hint/HintPacket';
import { openHint } from '../../src/network/hint/HintCrypto';
import { checkEntry } from '../../src/network/mailbox/MailboxEntry';
import { toBytes } from '../../src/crypto/PowPolicy';
import { Encoding } from '../../src/common/Encoding';
import {
  buildGoldenVectors,
  packetFromJson,
  hintFromJson,
  seededKeyPair,
  toHex,
  fromHex,
  INPUTS,
  type GoldenVectors,
} from './goldenInputs';

/**
 * プロトコル適合テスト (golden vectors)。
 *
 * vectors/core_protocol_vectors.json は generateVectors.ts で一度だけ生成して
 * 固定したもの。ここでは
 *   (1) 保存済みのバイト列を今のコードで復号し、中身を確かめる
 *   (2) 同じ固定入力から今のコードで組み立て直し、保存済みのバイト列と完全一致を求める
 * の両方向で縛る。どちらかが落ちたら、既存ノードとのワイヤ互換性が壊れている。
 *
 * ★ 落ちたときにベクタを再生成して「直す」のは誤り。意図的な形式変更
 *   (ドメイン文字列の版を上げる等) のときだけ再生成すること。
 */

const VECTOR_PATH = join(__dirname, 'vectors/core_protocol_vectors.json');
let stored: GoldenVectors;
let fresh: GoldenVectors;

const enc = new TextEncoder();
const concatBytes = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

beforeAll(async () => {
  await sodiumReady;
  stored = JSON.parse(readFileSync(VECTOR_PATH, 'utf8'));
  // オニオンのセルは封印に WASM 内部の乱数を使うので再現できない。
  // ONION_STEM フレームは保存済みのセルから組み立て直す。
  fresh = await buildGoldenVectors({ onionCell: fromHex(stored.onion.cell) });
});

function frame(name: string): Uint8Array {
  const f = stored.wire.frames[name];
  expect(f, `missing frame ${name}`).toBeDefined();
  return fromHex(f.hex);
}

// ───────────────────────── (2) 再符号化 ─────────────────────────

describe('固定入力から組み立て直した結果が保存済みベクタと 1 ビットも違わない', () => {
  it('定数表 (WireType 番号・内部タグ・セル長・PoW 方針・各ドメイン)', () => {
    expect(fresh.constants).toEqual(stored.constants);
  });

  it('KeyManager: thread key / topic hash / zone id', () => {
    expect(fresh.keyManager).toEqual(stored.keyManager);
  });

  it('NodeIdentity: pubkey → peerId → position、NodeId PoW (Argon2id)', () => {
    expect(fresh.nodeIdentity).toEqual(stored.nodeIdentity);
  });

  it('JOIN v4: 正準メッセージと Ed25519 署名', () => {
    expect(fresh.join).toEqual(stored.join);
  });

  it('トラッカー登録 (v2): 署名対象と署名', () => {
    expect(fresh.tracker).toEqual(stored.tracker);
  });

  it('Gossip PoW: プリイメージ / packet_id / PoW 解', () => {
    expect(fresh.gossipPow).toEqual(stored.gossipPow);
  });

  it('CryptoEngine: AEAD 暗号文 (nonce 固定)', () => {
    expect(fresh.cryptoEngine).toEqual(stored.cryptoEngine);
  });

  it('PacketBuilder: 時刻・nonce・鍵を固定すると外側パケットが完全に再現される', () => {
    expect(fresh.packetBuilder).toEqual(stored.packetBuilder);
  });

  it('Hint: パケット / id / 保管用バイト列', () => {
    expect(fresh.hint).toEqual(stored.hint);
  });

  it('OnionRouter: 回路の鍵とパディング (封印部分を除く)', () => {
    const { cell: _freshCell, ...f } = fresh.onion;
    const { cell: _storedCell, ...s } = stored.onion;
    expect(f).toEqual(s);
  });

  it('全 WireType のフレームが保存済みのバイト列と一致する', () => {
    expect(Object.keys(fresh.wire.frames).sort()).toEqual(Object.keys(stored.wire.frames).sort());
    for (const [name, f] of Object.entries(stored.wire.frames)) {
      expect(fresh.wire.frames[name], name).toEqual(f);
    }
  });

  it('UNKNOWN を除く全 WireType がフレームベクタで網羅されている', () => {
    const covered = new Set(Object.values(stored.wire.frames).map(f => f.type));
    const all = Object.values(WireType).filter((v): v is number => typeof v === 'number' && v !== WireType.UNKNOWN);
    for (const t of all) expect(covered.has(t), `WireType 0x${t.toString(16)} のベクタが無い`).toBe(true);
  });
});

// ───────────────────────── 定数 (明示値) ─────────────────────────

describe('ワイヤに現れる定数 (明示値で固定)', () => {
  it('WireType の番号', () => {
    expect(stored.constants.wireTypes).toEqual({
      JOIN: 0x10, RING_INFO: 0x11, PING: 0x12, PONG: 0x13,
      LOCAL_LINK_REQ: 0x14, LOCAL_LINK_ACK: 0x15, LOCAL_LINK_REJ: 0x16, HELLO: 0x17,
      PEX_REQUEST: 0x20, PEX_RESPONSE: 0x21,
      SDP_RELAY: 0x30, ICE_RELAY: 0x31,
      GOSSIP: 0x40, STEM: 0x41, HINT: 0x42, HINT_STEM: 0x43, ONION_STEM: 0x44,
      DHT_PUT: 0x50, DHT_GET: 0x51, DHT_RES: 0x52, DHT_PUT_STEM: 0x53,
      UNKNOWN: 0xff,
    });
  });

  it('内部タグ (Rust の #[serde(tag = "type")] と同じ綴り)', () => {
    expect(stored.constants.wireTags).toEqual({
      JOIN: 'join', RING_INFO: 'ring-info', PING: 'ping', PONG: 'pong',
      LOCAL_LINK_REQ: null, LOCAL_LINK_ACK: null, LOCAL_LINK_REJ: null,
      HELLO: 'hello', PEX_REQUEST: 'pex-request', PEX_RESPONSE: 'pex-response',
      SDP_RELAY: 'sdp-relay', ICE_RELAY: 'ice-relay',
      GOSSIP: 'gossip', STEM: 'stem', HINT: 'hint', HINT_STEM: 'hint-stem', ONION_STEM: 'onion-stem',
      DHT_PUT: 'dht-put', DHT_PUT_STEM: 'dht-put-stem', DHT_GET: 'dht-get', DHT_RES: 'dht-res',
    });
  });

  it('オニオンのセル長・出口層長・マジック', () => {
    expect(OnionRouter.CELL_SIZE).toBe(3800);
    expect(OnionRouter.EXIT_LAYER_SIZE).toBe(3400);
    expect(SEALED_EXIT_LAYER_SIZE).toBe(3400 + 48);
    expect(stored.constants.onion.cellMagic).toBe('a55a');
  });

  it('Gossip PoW の方針値', () => {
    expect(POW_POLICY).toEqual({
      MIN_DIFFICULTY: 8,
      MAX_DIFFICULTY: 32,
      NETWORK_DIFFICULTY: 12,
      MAX_PAYLOAD_SIZE: 2048,
      NONCE_SIZE: 12,
      MAX_TIME_DRIFT: 15 * 60 * 1000,
      MAX_HOP_COUNT: 30,
    });
  });

  it('ドメイン分離子 (Gossip / Hint はちょうど 16 バイト)', () => {
    expect(new TextDecoder().decode(GOSSIP_DOMAIN)).toBe('AETHER/v3/gossip');
    expect(GOSSIP_DOMAIN.length).toBe(16);
    expect(new TextDecoder().decode(HINT_DOMAIN)).toBe('AETHER/v3/hint__');
    expect(HINT_DOMAIN.length).toBe(16);
    expect(stored.constants.cryptoEngineMagic).toBe('AETH');
  });

  it('NodeId PoW の既定パラメータ', () => {
    expect(stored.constants.nodeIdentity).toEqual({
      PEER_ID_BYTES: 16,
      CHALLENGE_BYTES: 32,
      NODE_ID_POW: { difficulty: 10, opsLimit: 1, memLimit: 1 << 20 },
      NODE_ID_POW_FAST: { difficulty: 4, opsLimit: 1, memLimit: 8192 },
    });
  });
});

// ───────────────────────── (1) 保存済みバイト列の復号 ─────────────────────────

describe('派生関数の定義そのもの (ドメイン文字列を独立に再計算)', () => {
  it('peerId = SHA256("AETHER/v3/peerid" ‖ pubkey)[0..16]', () => {
    const pk = fromHex(stored.nodeIdentity.pubkey);
    expect(toHex(seededKeyPair(INPUTS.nodeSeedByte).publicKey)).toBe(stored.nodeIdentity.pubkey);
    const expected = toHex(sodium.crypto_hash_sha256(concatBytes(enc.encode('AETHER/v3/peerid'), pk)).slice(0, 16));
    expect(stored.nodeIdentity.peerId).toBe(expected);
    expect(stored.nodeIdentity.peerId).toBe('9bf361b6706d6251f49efbe9f02823fa');
  });

  it('position = SHA256("AETHER/v3/position" ‖ peerIdBytes)[0..8] / 2^64', () => {
    const h = sodium.crypto_hash_sha256(concatBytes(enc.encode('AETHER/v3/position'), fromHex(stored.nodeIdentity.peerId)));
    const v = new DataView(h.buffer, h.byteOffset, 8).getBigUint64(0, false);
    expect(stored.nodeIdentity.position).toBe(Number(v) / 2 ** 64);
    expect(stored.nodeIdentity.position).toBeGreaterThanOrEqual(0);
    expect(stored.nodeIdentity.position).toBeLessThan(1);
  });

  it('NodeId PoW = Argon2id13(pubkey ‖ u64be(counter), salt="AETHER/v3/nodeid")', () => {
    const pk = fromHex(stored.nodeIdentity.pubkey);
    const { params, counter, hashAtSolvedCounter } = stored.nodeIdentity.nodeIdPowFast;
    const counterBytes = new Uint8Array(8);
    new DataView(counterBytes.buffer).setBigUint64(0, BigInt(counter), false);
    const h = sodium.crypto_pwhash(
      32, concatBytes(pk, counterBytes), enc.encode('AETHER/v3/nodeid'),
      params.opsLimit, params.memLimit, sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
    expect(toHex(h)).toBe(hashAtSolvedCounter);
    // 先頭 4 ビットが 0 (difficulty 4)
    expect(h[0] & 0xf0).toBe(0);
    expect(NodeIdentity.verifyClaim({ peerId: stored.nodeIdentity.peerId, pubkey: pk, powCounter: counter }, NODE_ID_POW_FAST)).toBe(true);
  });

  it('JOIN v4 の正準メッセージ = "AETHER/v4/join" ‖ challenge ‖ len16 で区切った 4 文字列', () => {
    const j = stored.join;
    const lp = (s: string) => {
      const b = enc.encode(s);
      return concatBytes(Uint8Array.of(b.length >> 8, b.length & 0xff), b);
    };
    const expected = concatBytes(
      enc.encode('AETHER/v4/join'),
      fromHex(j.challenge),
      lp(j.binding.verifierId),
      lp(j.signerId),
      lp(j.binding.signerFingerprint),
      lp(j.binding.verifierFingerprint),
    );
    expect(j.message).toBe(toHex(expected));
    expect(toHex(joinMessage(fromHex(j.challenge), j.signerId, j.binding))).toBe(j.message);
    expect(sodium.crypto_sign_verify_detached(fromHex(j.signature), expected, fromHex(stored.nodeIdentity.pubkey))).toBe(true);
  });

  it('トラッカー登録の正準メッセージ = "AETHER/v1/tracker-join" ‖ nonce(32) ‖ lp(peerId) ‖ lp(小文字の host)', () => {
    const t = stored.tracker;
    const lp = (str: string) => {
      const b = enc.encode(str);
      return concatBytes(Uint8Array.of(b.length >> 8, b.length & 0xff), b);
    };
    const expected = concatBytes(
      enc.encode('AETHER/v1/tracker-join'),
      fromHex(t.nonce),
      lp(t.peerId),
      lp(t.host.toLowerCase()),
    );
    expect(t.domain).toBe('AETHER/v1/tracker-join');
    expect(t.message).toBe(toHex(expected));
    // host の大文字小文字は署名に影響しない
    expect(toHex(trackerJoinMessage(fromHex(t.nonce), t.peerId, t.host.toLowerCase()))).toBe(t.message);
    expect(toHex(trackerJoinMessage(fromHex(t.nonce), t.peerId, t.host.toUpperCase()))).toBe(t.message);
    expect(() => trackerJoinMessage(new Uint8Array(31), t.peerId, t.host)).toThrow(RangeError);
  });

  it('トラッカー登録の署名が保存済みの鍵で検証でき、ドメインが JOIN (P2P) と分離されている', () => {
    const t = stored.tracker;
    const pubkey = fromHex(stored.nodeIdentity.pubkey);
    const claim = { peerId: t.peerId, pubkey, powCounter: t.powCounter };
    expect(sodium.crypto_sign_verify_detached(fromHex(t.signature), fromHex(t.message), pubkey)).toBe(true);
    expect(NodeIdentity.verifyTrackerJoin(claim, fromHex(t.nonce), t.host, fromHex(t.signature), NODE_ID_POW_FAST)).toBe(true);
    // 別のトラッカー・別の nonce 向けとしては通らない
    expect(NodeIdentity.verifyTrackerJoin(claim, fromHex(t.nonce), 'other.example.org:8443', fromHex(t.signature), NODE_ID_POW_FAST)).toBe(false);
    expect(NodeIdentity.verifyTrackerJoin(claim, new Uint8Array(32), t.host, fromHex(t.signature), NODE_ID_POW_FAST)).toBe(false);
    // P2P の JOIN 署名とは別物 (先頭のドメインが違う)
    expect(t.message.startsWith(toHex(enc.encode('AETHER/v4/join')))).toBe(false);
  });

  it('トラッカープロトコルの定数', () => {
    expect(TRACKER_PROTOCOL_VERSION).toBe(2);
    expect(TRACKER_MAX_FRAME_BYTES).toBe(64 * 1024);
    expect(TRACKER_MAX_PEERS).toBe(32);
    expect(stored.tracker.protocolVersion).toBe(2);
  });

  it('thread key = HMAC-SHA512/256(boardKey, "thread:" ‖ threadId), topic hash = SHA512[0..32]', () => {
    const k = stored.keyManager;
    expect(toHex(sodium.crypto_auth(enc.encode(`thread:${k.threadId}`), fromHex(k.boardKey)))).toBe(k.threadKey);
    expect(toHex(sodium.crypto_hash(fromHex(k.threadKey)).slice(0, 32))).toBe(k.topicHash);
  });

  it('zone id は topic hash の先頭 depth ビット', () => {
    const th = fromHex(stored.keyManager.topicHash);
    const top16 = (th[0] << 8) | th[1];
    stored.keyManager.zoneIds.forEach((z, depth) => {
      expect(z, `depth=${depth}`).toBe(depth === 0 ? 0 : top16 >>> (16 - depth));
      expect(KeyManager.computeZoneId(th, depth)).toBe(z);
    });
  });

  it('Gossip のプリイメージ = domain ‖ u64 ts ‖ u32 zone ‖ u8 diff ‖ u16 len ‖ nonce ‖ u32 len ‖ payload', () => {
    const g = stored.gossipPow;
    const pre = fromHex(g.preimage);
    const view = new DataView(pre.buffer, pre.byteOffset, pre.byteLength);
    expect(new TextDecoder().decode(pre.subarray(0, 16))).toBe('AETHER/v3/gossip');
    expect(Number(view.getBigUint64(16, false))).toBe(g.header.timestamp);
    expect(view.getUint32(24, false)).toBe(g.header.zone_id);
    expect(pre[28]).toBe(g.header.pow_difficulty);
    expect(view.getUint16(29, false)).toBe(12);
    expect(toHex(pre.subarray(31, 43))).toBe(g.header.nonce);
    expect(view.getUint32(43, false)).toBe(64);
    expect(toHex(pre.subarray(47))).toBe(g.header.payload);
    expect(g.packetId).toBe(toHex(sodium.crypto_hash_sha256(pre)));
    const header = {
      ...g.header, nonce: fromHex(g.header.nonce), payload: fromHex(g.header.payload),
    };
    expect(toHex(powPreimage(header))).toBe(g.preimage);
    expect(derivePacketId(header)).toBe(g.packetId);
    expect(verifyPow(header, g.solvedNonce)).toBe(true);
    // 難易度 12 → 先頭 12 ビットが 0
    const h = fromHex(g.powHashAtSolvedNonce);
    expect(h[0]).toBe(0);
    expect(h[1] & 0xf0).toBe(0);
  });
});

describe('保存済みのバイト列を今のコードで復号できる', () => {
  it('CryptoEngine: 保存済みの暗号文が復号でき、"AETH" マジック + Poly1305 タグの長さ', () => {
    const c = stored.cryptoEngine;
    const ct = fromHex(c.ciphertext);
    expect(ct.length).toBe(fromHex(c.plaintext).length + 4 + 16);
    expect(fromHex(c.nonce).length).toBe(12);
    const pt = CryptoEngine.decrypt(fromHex(c.threadKey), { ciphertext: ct, nonce: fromHex(c.nonce) });
    expect(pt && toHex(pt)).toBe(c.plaintext);
    expect(MagicFilter.quickCheck(fromHex(c.threadKey), ct, fromHex(c.nonce))).toBe(true);
  });

  it('PacketBuilder: 保存済みパケットがヘッダ検証・復号・署名検証を通る', async () => {
    const pb = stored.packetBuilder;
    const packet = packetFromJson(pb.packet);
    expect(PacketValidator.check(packet, { now: packet.timestamp })).toEqual({ ok: true });
    // ヘッダ時刻は分単位に丸められている
    expect(packet.timestamp).toBe(Math.floor(pb.nowMs / 60_000) * 60_000);
    expect(packet.hop_count).toBe(0);
    expect(packet.pow_difficulty).toBe(INPUTS.post.powDifficulty);
    const threadKey = fromHex(pb.threadKey);
    expect(packet.zone_id).toBe(KeyManager.computeZoneId(KeyManager.deriveTopicHash(threadKey), INPUTS.post.depth));

    const post = await PacketBuilder.verifyAndDecrypt(packet, threadKey, new CryptoEngine());
    expect(post).not.toBeNull();
    expect(post.content).toBe(INPUTS.post.content);
    expect(post.post_number).toBe(INPUTS.post.postNumber);
    expect(post.reply_to).toBe(INPUTS.post.replyTo);
    expect(post.created_at).toBe(packet.timestamp);
    expect(post.board_id).toBe(INPUTS.boardId);
    expect(post.thread_id).toBe(INPUTS.threadId);
    expect(post.parents).toEqual(INPUTS.post.parents);
    expect(post.cumulative_pow).toBe(INPUTS.post.cumulativePow);
    expect(post.thread_root).toBe(INPUTS.post.threadRoot);
    expect(post.post_type).toBe(INPUTS.post.postType);
    expect(toHex(toBytes(post.session_pubkey))).toBe(pb.sessionPubkey);
    expect(toHex(post.trip_pubkey)).toBe(pb.tripPubkey);
  });

  it('PacketBuilder: 別のスレッド鍵では MagicFilter の段階で弾かれる', async () => {
    const packet = packetFromJson(stored.packetBuilder.packet);
    const wrongKey = KeyManager.deriveThreadKey(fromHex(stored.keyManager.boardKey), 'other-thread');
    expect(MagicFilter.quickCheck(wrongKey, packet.payload, packet.nonce)).toBe(false);
    expect(await PacketBuilder.verifyAndDecrypt(packet, wrongKey, new CryptoEngine())).toBeNull();
  });

  it('Hint: 保存済みの Hint が形式・PoW・id を満たし、鍵を持つ者だけが開ける', () => {
    const h = hintFromJson(stored.hint.packet);
    expect(parseHintPacket(h)).not.toBeNull();
    expect(verifyHintPow(h)).toBe(true);
    expect(hintId(h)).toBe(stored.hint.id);
    expect(fromHex(stored.hint.encoded).length).toBe(ENCODED_HINT_SIZE);
    const opened = openHint(new Uint8Array(32).fill(INPUTS.hint.boardKeyByte), h);
    expect(opened).not.toBeNull();
    expect(opened!.message_id).toBe(INPUTS.hint.messageId);
    expect(opened!.timestamp).toBe(INPUTS.hint.timestamp);
    expect(toHex(opened!.nonce)).toBe(toHex(new Uint8Array(32).fill(INPUTS.hint.slotNonceByte)));
    expect(openHint(new Uint8Array(32).fill(0x00), h)).toBeNull();
  });

  it('Onion: 保存済みセルを Guard → Exit の順に剥がすと出口の指示が出てくる', () => {
    const o = stored.onion;
    const cell = fromHex(o.cell);
    expect(cell.length).toBe(OnionRouter.CELL_SIZE);
    expect(toHex(cell.subarray(0, 2))).toBe('a55a');
    expect(o.hops).toHaveLength(2);

    const [guard, exit] = o.hops.map(h => sodium.crypto_sign_seed_keypair(fromHex(h.seed)));
    const layer1 = OnionRouter.unwrap(cell, guard.publicKey, guard.privateKey);
    expect(layer1?.type).toBe('relay');
    if (layer1?.type !== 'relay') throw new Error('unreachable');
    expect(layer1.nextHop).toBe(o.hops[1].peerId);
    // Guard に見える内側は常に固定長の封印済み出口層
    expect(layer1.innerOnion.byteLength).toBe(SEALED_EXIT_LAYER_SIZE);
    // ★ 実データ長 (ヘッダの L) も中身に依らず固定: cover (drop) と同じ長さ
    const cover = OnionRouter.wrapCircuit({ type: 'drop' }, o.hops.map(h => ({ peerId: h.peerId, pubkey: fromHex(h.pubkey) })));
    expect(cellInnerLength(cell)).toBe(cellInnerLength(cover));

    const layer2 = OnionRouter.unwrap(OnionRouter.padCell(layer1.innerOnion), exit.publicKey, exit.privateKey);
    expect(layer2).toEqual({ type: 'exit_hint', hint: fromHex(o.exitHint) });

    // 出口の鍵で外殻は開けない (順序が逆)
    expect(OnionRouter.unwrap(cell, exit.publicKey, exit.privateKey)).toBeNull();
  });

  it('Onion: 決定的パディングの先頭はマジック + 長さ + 実データ', () => {
    expect(stored.onion.paddedCellPrefix).toBe(
      'a55a' + (19).toString(16).padStart(4, '0') + toHex(enc.encode('golden cell payload')),
    );
  });
});

/** セルの長さフィールドを返す (読みやすさのため) */
function cellInnerLength(cell: Uint8Array): number {
  return (cell[2] << 8) | cell[3];
}

describe('保存済みフレームを WireCodec.decode で読める', () => {
  it('全フレームの先頭バイトが WireType、内部タグが既定の綴り', () => {
    const tagByType = new Map<number, string | null>();
    for (const [name, value] of Object.entries(stored.constants.wireTypes)) {
      if (name !== 'UNKNOWN') tagByType.set(value, stored.constants.wireTags[name]);
    }
    for (const [name, f] of Object.entries(stored.wire.frames)) {
      const bytes = fromHex(f.hex);
      expect(bytes[0], name).toBe(f.type);
      const decoded = WireCodec.decode(bytes);
      expect(decoded.type, name).toBe(f.type);
      const tag = tagByType.get(f.type);
      if (tag) expect(decoded.payload.type, name).toBe(tag);
      else expect(decoded.payload, name).not.toHaveProperty('type');
    }
  });

  it('HELLO: challenge が bin8 (0xc4 0x20) の 32 バイト', () => {
    const { payload } = WireCodec.decode(frame('hello'));
    expect(payload.challenge).toBeInstanceOf(Uint8Array);
    expect(toHex(payload.challenge)).toBe(stored.join.challenge);
    expect(stored.wire.frames.hello.hex).toContain('c420' + stored.join.challenge);
  });

  it('JOIN: v4 署名付きの claim が今の検証器で受理される (position は載らない)', () => {
    const { type, payload } = WireCodec.decode(frame('join'));
    expect(type).toBe(WireType.JOIN);
    expect(payload).not.toHaveProperty('position');
    expect(Object.keys(payload).sort()).toEqual(['challenge', 'peerId', 'powCounter', 'pubkey', 'signature', 'type']);
    const claim = {
      peerId: payload.peerId,
      pubkey: payload.pubkey,
      powCounter: payload.powCounter,
      challenge: payload.challenge,
      signature: payload.signature,
    };
    const binding = stored.join.binding;
    expect(NodeIdentity.verifySignedClaim(claim, fromHex(stored.join.challenge), binding, NODE_ID_POW_FAST)).toBe(true);
    // 束縛 (DTLS 指紋) が 1 文字でも違えば受理しない
    expect(NodeIdentity.verifySignedClaim(
      claim, fromHex(stored.join.challenge), { ...binding, verifierFingerprint: binding.signerFingerprint }, NODE_ID_POW_FAST,
    )).toBe(false);
  });

  it('PING / PONG: ts は数値 (時計ではなく nonce)', () => {
    expect(WireCodec.decode(frame('ping')).payload).toEqual({ type: 'ping', ts: 0xdeadbeef });
    expect(WireCodec.decode(frame('pong')).payload).toEqual({ type: 'pong', ts: 0xdeadbeef });
  });

  it('LOCAL_LINK_*: タグ無しの空マップ (1 バイトヘッダ + 0x80)', () => {
    expect(stored.wire.frames.localLinkReq.hex).toBe('1480');
    expect(stored.wire.frames.localLinkAck.hex).toBe('1580');
    expect(stored.wire.frames.localLinkRej.hex).toBe('1680');
  });

  it('PEX_RESPONSE: id と (あれば) pubkey / powCounter のみ。position も zones も無い', () => {
    const { payload } = WireCodec.decode(frame('pexResponse'));
    expect(payload.peers).toHaveLength(2);
    for (const p of payload.peers) {
      expect(p).not.toHaveProperty('position');
      expect(p).not.toHaveProperty('zones');
    }
    expect(payload.peers[0].id).toBe(stored.nodeIdentity.peerId);
    expect(toHex(payload.peers[0].pubkey)).toBe(stored.nodeIdentity.pubkey);
    expect(payload.peers[0].powCounter).toBe(stored.nodeIdentity.nodeIdPowFast.counter);
  });

  it('GOSSIP / STEM: 中継途中のパケットが検証器を通り、STEM にホップカウンタが無い', () => {
    const g = WireCodec.decode(frame('gossip')).payload.packet;
    expect(g.packet_id).toBe(stored.gossipPow.packetId);
    expect(g.hop_count).toBe(3);
    expect(PacketValidator.check(g, { now: g.timestamp })).toEqual({ ok: true });

    const s = WireCodec.decode(frame('stem')).payload;
    expect(s.zoneId).toBe(stored.gossipPow.header.zone_id);
    expect(s).not.toHaveProperty('stemTtl');
    expect(s).not.toHaveProperty('stem_ttl');
    expect(PacketValidator.check(s.packet, { now: s.packet.timestamp })).toEqual({ ok: true });
  });

  it('HINT / HINT_STEM: 中身は同一で、id と PoW が保たれる', () => {
    for (const name of ['hint', 'hintStem']) {
      const hint = parseHintPacket(WireCodec.decode(frame(name)).payload);
      expect(hint, name).not.toBeNull();
      expect(hintId(hint!)).toBe(stored.hint.id);
      expect(verifyHintPow(hint!)).toBe(true);
    }
  });

  it('ONION_STEM: onionBytes が CELL_SIZE ちょうど', () => {
    const { payload } = WireCodec.decode(frame('onionStem'));
    expect(payload.onionBytes).toBeInstanceOf(Uint8Array);
    expect(payload.onionBytes.byteLength).toBe(OnionRouter.CELL_SIZE);
    expect(toHex(payload.onionBytes)).toBe(stored.onion.cell);
  });

  it('DHT_PUT / DHT_PUT_STEM / DHT_RES: エントリが過去ログ検証を通る (Slot 形式を含む)', () => {
    const now = stored.gossipPow.header.timestamp;
    for (const name of ['dhtPut', 'dhtPutSlot', 'dhtPutStem', 'dhtRes']) {
      const { payload } = WireCodec.decode(frame(name));
      expect(payload.entries, name).toHaveLength(1);
      const check = checkEntry(toBytes(payload.entries[0]), now);
      expect(check.ok, `${name}: ${check.reason}`).toBe(true);
      expect(check.packet!.packet_id).toBe(stored.gossipPow.packetId);
    }
    const res = WireCodec.decode(frame('dhtRes')).payload;
    expect(res.reqId).toBe(INPUTS.reqId);
    expect(res.topicHash).toBe(INPUTS.topicHashHex);
    expect(WireCodec.decode(frame('dhtGet')).payload).toEqual({ type: 'dht-get', topicHash: INPUTS.topicHashHex, reqId: INPUTS.reqId });
  });

  it('SDP_RELAY / ICE_RELAY / RING_INFO の中身', () => {
    const sdp = WireCodec.decode(frame('sdpRelay')).payload;
    expect(sdp.sdp).toEqual({ type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' });
    expect(sdp.type).toBe('sdp-relay');
    const ice = WireCodec.decode(frame('iceRelay')).payload;
    expect(ice.candidate.sdpMLineIndex).toBe(0);
    const ring = WireCodec.decode(frame('ringInfo')).payload;
    expect(ring.neighbors.map((n: any) => n.id)).toContain(stored.nodeIdentity.peerId);
  });
});

/**
 * フレーム長の予算。
 *
 * PeerManager は WireType ごとにフレーム長の上限を持ち (MAX_FRAME_BYTES, 非公開)、
 * ChunkedSender は 4096 バイトを超えるものを分割する。正規のメッセージが
 * これらに収まらないと、送った瞬間に相手に捨てられる / セルが分割されて
 * 固定長セルの意味が無くなる。値は src の定数を写したもの。
 */
describe('正規のフレームが上限に収まる', () => {
  const LIMITS = { HELLO: 256, JOIN: 1024, PING: 256, PONG: 256, ONION_STEM: 4096, GOSSIP: 8192, STEM: 8192, HINT: 1024, HINT_STEM: 1024, PEX_REQUEST: 256, PEX_RESPONSE: 4096, DHT_GET: 1024 };
  const CHUNK_SIZE = 4096;

  it('ベクタの各フレームが WireType ごとの上限以下', () => {
    for (const [name, f] of Object.entries(stored.wire.frames)) {
      const typeName = Object.entries(stored.constants.wireTypes).find(([, v]) => v === f.type)![0];
      const limit = (LIMITS as Record<string, number>)[typeName];
      if (limit !== undefined) expect(f.hex.length / 2, name).toBeLessThanOrEqual(limit);
    }
  });

  it('★ONION_STEM は 1 フレームに収まり、分割されない (固定長セルの前提)', () => {
    const len = stored.wire.frames.onionStem.hex.length / 2;
    expect(len).toBeLessThanOrEqual(CHUNK_SIZE);
    // 中身に依らずフレーム長は一定 (セルが固定長なので)
    expect(len).toBe(WireCodec.encode(WireType.ONION_STEM, { onionBytes: new Uint8Array(OnionRouter.CELL_SIZE) }).length);
  });

  it('最大サイズの投稿 (payload 2KB) を載せた GOSSIP / STEM も上限以下', () => {
    const pkt = {
      packet_id: 'f'.repeat(64), hop_count: 30, pow_nonce: Number.MAX_SAFE_INTEGER, pow_difficulty: 32,
      timestamp: 4_102_444_800_000, zone_id: 0xffffffff,
      nonce: new Uint8Array(12), payload: new Uint8Array(POW_POLICY.MAX_PAYLOAD_SIZE),
    };
    expect(WireCodec.encode(WireType.GOSSIP, { packet: pkt }).length).toBeLessThanOrEqual(LIMITS.GOSSIP);
    expect(WireCodec.encode(WireType.STEM, { zoneId: pkt.zone_id, packet: pkt }).length).toBeLessThanOrEqual(LIMITS.STEM);
  });

  it('上限件数 (8 件) の PEX_RESPONSE も上限以下', () => {
    const peers = Array.from({ length: 8 }, () => ({ id: 'f'.repeat(32), pubkey: new Uint8Array(32), powCounter: Number.MAX_SAFE_INTEGER }));
    expect(WireCodec.encode(WireType.PEX_RESPONSE, { peers }).length).toBeLessThanOrEqual(LIMITS.PEX_RESPONSE);
  });

  it('最大の出口指示 (payload 2KB の投稿 + Slot) が出口層に収まり、回路が組める', () => {
    const kps = [0x61, 0x62].map(b => seededKeyPair(b));
    const hops = kps.map(kp => ({ peerId: NodeIdentity.derivePeerId(kp.publicKey), pubkey: kp.publicKey }));
    const pkt = {
      packet_id: 'f'.repeat(64), hop_count: 0, pow_nonce: Number.MAX_SAFE_INTEGER, pow_difficulty: 32,
      timestamp: 4_102_444_800_000, zone_id: 0xffffffff,
      nonce: new Uint8Array(12), payload: new Uint8Array(POW_POLICY.MAX_PAYLOAD_SIZE),
    };
    const cell = OnionRouter.wrapCircuit(
      { type: 'exit_fluff', zoneId: pkt.zone_id, packet: pkt, slot: { topicHash: 'a'.repeat(128), hint: new Uint8Array(ENCODED_HINT_SIZE) } },
      hops,
    );
    expect(cell.length).toBe(OnionRouter.CELL_SIZE);
    const outer = OnionRouter.unwrap(cell, kps[0].publicKey, kps[0].privateKey);
    expect(outer?.type).toBe('relay');
    const exit = OnionRouter.unwrap(OnionRouter.padCell((outer as any).innerOnion), kps[1].publicKey, kps[1].privateKey);
    expect(exit?.type).toBe('exit_fluff');
  });
});

describe('Base64URL (鍵の URL 表現)', () => {
  it('板鍵の Base64URL 表現が固定値 (パディング無し・URL 安全)', () => {
    const key = fromHex(stored.keyManager.boardKey);
    expect(KeyManager.toBase64(key)).toBe('QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI');
    expect(toHex(KeyManager.fromBase64('QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI'))).toBe(stored.keyManager.boardKey);
  });

  it('★回帰: 大きな入力 (1MB, 0x8000 区切りの境界を含む) でもスタックを使い切らずに往復する', () => {
    for (const n of [0x8000 - 1, 0x8000, 0x8000 + 1, 0x8000 * 3, 1024 * 1024 + 7]) {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = (i * 131 + (i >> 8)) & 0xff;
      const b64 = Encoding.toBase64(bytes);
      expect(b64.length, `n=${n}`).toBe(Math.ceil((n * 4) / 3));
      expect(b64).toMatch(/^[A-Za-z0-9_-]*$/);
      // 大きな配列の toEqual は遅いので Buffer で比べる
      expect(Buffer.from(Encoding.fromBase64(b64)).equals(Buffer.from(bytes)), `n=${n}`).toBe(true);
      // 区切って変換しても、標準の Base64 と同じ内容になる
      expect(b64).toBe(Buffer.from(bytes).toString('base64url'));
    }
  });
});
