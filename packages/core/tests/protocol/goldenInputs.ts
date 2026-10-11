/**
 * プロトコル適合ベクタ (golden vectors) の「入力」と「組み立て手順」。
 *
 * ★ これはテストファイルではない。
 *   - generateVectors.ts がこれを呼んで vectors/core_protocol_vectors.json を書き出す
 *   - ProtocolConformance.test.ts がこれを呼び直し、保存済みのバイト列と突き合わせる
 *
 * 入力はすべて固定値。乱数を使う箇所 (AEAD の nonce、セルのパディング) は
 * {@link withDeterministicRandom} で sodium.randombytes_buf を一時的に決定的な
 * 鍵ストリームへ差し替える。crypto_box_seal (オニオンの封印) は WASM 内部の
 * 乱数を使うので決定化できない。オニオンのセルは「保存したバイト列を復号できるか」
 * と構造 (長さ・マジック) だけで縛る。
 */
import { encode as msgpackEncode } from '@msgpack/msgpack';
import sodium from '../../src/crypto/sodium';
import { WireCodec } from '../../src/network/wire/WireCodec';
import { WireType } from '../../src/network/wire/WireTypes';
import {
  POW_POLICY,
  GOSSIP_DOMAIN,
  powPreimage,
  powHash,
  derivePacketId,
  solvePow,
  type PowCommittedHeader,
} from '../../src/crypto/PowPolicy';
import {
  NodeIdentity,
  NODE_ID_POW,
  NODE_ID_POW_FAST,
  PEER_ID_BYTES,
  CHALLENGE_BYTES,
  joinMessage,
  trackerJoinMessage,
  type JoinBinding,
  type NodeIdPowParams,
} from '../../src/crypto/NodeIdentity';
import { KeyManager } from '../../src/crypto/KeyManager';
import { CryptoEngine } from '../../src/crypto/CryptoEngine';
import { PacketBuilder } from '../../src/crypto/PacketBuilder';
import { OnionRouter, SEALED_EXIT_LAYER_SIZE } from '../../src/crypto/OnionRouter';
import { JsonBinary } from '../../src/common/JsonBinary';
import { buildHint } from '../../src/network/hint/HintCrypto';
import {
  hintId,
  encodeHint,
  ENCODED_HINT_SIZE,
  HINT_VERSION,
  BLIND_TAG_SIZE,
  HINT_NONCE_SIZE,
  HINT_PLAINTEXT_SIZE,
  HINT_CIPHERTEXT_SIZE,
  HINT_INITIAL_TTL,
  HINT_POW_DIFFICULTY,
  HINT_DOMAIN,
  type HintPacket,
} from '../../src/network/hint/HintPacket';
import { encodeSlotBlob } from '../../src/network/hint/SlotBlob';
import { RATE_LIMITS } from '../../src/network/RateLimiter';
import {
  TRACKER_PROTOCOL_VERSION,
  TRACKER_MAX_FRAME_BYTES,
  TRACKER_MAX_PEERS,
} from '../../src/network/TrackerProtocol';
import { SeenCache } from '../../src/network/gossip/SeenCache';
import { RING_MESH, RING_MESH_ZONE } from '../../src/constants';
import type { GossipPacket, IIdentity } from '../../src/types';

// ───────────────────────── 小道具 ─────────────────────────

export const toHex = (b: Uint8Array): string => sodium.to_hex(b);
export const fromHex = (h: string): Uint8Array => sodium.from_hex(h);
const ascii = (b: Uint8Array): string => new TextDecoder().decode(b);
const sha256Hex = (b: Uint8Array): string => toHex(sodium.crypto_hash_sha256(b));

/** 固定シードから作る Ed25519 鍵ペア */
export function seededKeyPair(byte: number) {
  return sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(byte));
}

/**
 * sodium.randombytes_buf を決定的な鍵ストリームに差し替えて fn を実行する。
 * 呼び出し回数ごとに nonce を変えるので、同じ長さを 2 回取っても別の値になる。
 */
export async function withDeterministicRandom<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
  const original = sodium.randombytes_buf;
  const key = sodium.crypto_hash_sha256(new TextEncoder().encode(`aether-golden-rng/${label}`));
  let call = 0;
  (sodium as any).randombytes_buf = (n: number) => {
    const nonce = new Uint8Array(12);
    new DataView(nonce.buffer).setUint32(8, call++, false);
    return sodium.crypto_stream_chacha20_ietf_xor_ic(new Uint8Array(n), nonce, 0, key);
  };
  try {
    return await fn();
  } finally {
    (sodium as any).randombytes_buf = original;
  }
}

/** Date.now を固定して fn を実行する (PacketBuilder がヘッダ時刻に使う) */
export async function withFixedNow<T>(ms: number, fn: () => T | Promise<T>): Promise<T> {
  const original = Date.now;
  Date.now = () => ms;
  try {
    return await fn();
  } finally {
    Date.now = original;
  }
}

// ───────────────────────── 固定入力 ─────────────────────────

export const INPUTS = {
  /** PacketBuilder が分単位に丸めることを確かめるため、端数を持たせる */
  nowMs: 1_700_000_012_345,
  boardKeyByte: 0x42,
  threadId: 'golden-thread-0001',
  boardId: 'golden-board',
  nodeSeedByte: 0x11, // web/tests/vectors と同じ鍵 (peerId 9bf361b6...)
  verifierSeedByte: 0x22,
  relaySeedByte: 0x33,
  exitSeedByte: 0x44,
  sessionSeedByte: 0x5e,
  tripSeedByte: 0x7f,
  /** NodeId PoW の小さなパラメータ (Argon2id 8KiB, 1 pass) */
  tinyPow: { difficulty: 0, opsLimit: 1, memLimit: 8192 } as NodeIdPowParams,
  challenge: Uint8Array.from({ length: 32 }, (_, i) => (i * 3) & 0xff),
  signerFingerprint: 'sha-256 ' + Array.from({ length: 32 }, (_, i) => ((i * 7 + 1) & 0xff).toString(16).padStart(2, '0').toUpperCase()).join(':'),
  verifierFingerprint: 'sha-256 ' + Array.from({ length: 32 }, (_, i) => ((i * 11 + 5) & 0xff).toString(16).padStart(2, '0').toUpperCase()).join(':'),
  gossipHeader: {
    timestamp: 1_700_000_000_000,
    zone_id: 0x0abc,
    pow_difficulty: POW_POLICY.NETWORK_DIFFICULTY,
    nonce: Uint8Array.from({ length: 12 }, (_, i) => 0xf0 - i),
    payload: Uint8Array.from({ length: 64 }, (_, i) => (i * 13 + 7) & 0xff),
  } satisfies PowCommittedHeader,
  aeadPlaintext: new TextEncoder().encode('AETHER golden AEAD plaintext'),
  post: {
    content: 'ゴールデンベクタの投稿 / golden post',
    postNumber: 3,
    replyTo: 1,
    powDifficulty: POW_POLICY.MIN_DIFFICULTY,
    depth: 4,
    postType: 0,
    parents: ['aa'.repeat(32), 'bb'.repeat(32)],
    threadRoot: 'cc'.repeat(32),
    cumulativePow: 4096,
  },
  hint: {
    boardKeyByte: 0x5a,
    slotNonceByte: 0x3c,
    messageId: 7,
    timestamp: 1_700_000_000_000,
    fixedNonceByte: 0x11,
  },
  onionExitHint: Uint8Array.from({ length: 40 }, (_, i) => i),
  topicHashHex: 'ab'.repeat(32),
  slotTopicHashHex: 'cd'.repeat(32),
  reqId: 'req_golden_42',
  trackerNonce: Uint8Array.from({ length: 32 }, (_, i) => (0x80 + i * 5) & 0xff),
  /** 大文字混じりで渡し、署名側で小文字に正規化されることも固定する */
  trackerHost: 'Tracker.Example.org:8443',
} as const;

export function boardKey(): Uint8Array {
  return new Uint8Array(32).fill(INPUTS.boardKeyByte);
}

export function joinBinding(): JoinBinding {
  return {
    verifierId: NodeIdentity.derivePeerId(seededKeyPair(INPUTS.verifierSeedByte).publicKey),
    signerFingerprint: INPUTS.signerFingerprint,
    verifierFingerprint: INPUTS.verifierFingerprint,
  };
}

/** 決定的な IIdentity (セッション鍵・トリップ鍵ともに固定シード) */
export function seededIdentity(): IIdentity {
  const session = seededKeyPair(INPUTS.sessionSeedByte);
  const trip = seededKeyPair(INPUTS.tripSeedByte);
  return {
    sign: (data: Uint8Array) => ({
      sessionPubkey: session.publicKey,
      sessionSignature: sodium.crypto_sign_detached(data, session.privateKey),
      tripPubkey: trip.publicKey,
      tripSignature: sodium.crypto_sign_detached(data, trip.privateKey),
    }),
  };
}

export const syncPowEngine = {
  compute: async (h: PowCommittedHeader) => {
    const n = solvePow(h);
    if (n === null) throw new Error('PoW not found');
    return n;
  },
};

export const keyManager = {
  deriveThreadKey: KeyManager.deriveThreadKey,
  deriveTopicHash: KeyManager.deriveTopicHash,
  computeZoneId: KeyManager.computeZoneId,
};

/** GossipPacket を hex 表現にする (JSON 保存用) */
export function packetToJson(p: GossipPacket) {
  return {
    packet_id: p.packet_id,
    hop_count: p.hop_count,
    pow_nonce: p.pow_nonce,
    pow_difficulty: p.pow_difficulty,
    timestamp: p.timestamp,
    zone_id: p.zone_id,
    nonce: toHex(p.nonce),
    payload: toHex(p.payload),
  };
}

export function packetFromJson(j: ReturnType<typeof packetToJson>): GossipPacket {
  return { ...j, nonce: fromHex(j.nonce), payload: fromHex(j.payload) };
}

export function hintToJson(h: HintPacket) {
  return {
    version: h.version,
    ttl: h.ttl,
    blind_tag: toHex(h.blind_tag),
    nonce: toHex(h.nonce),
    pow_nonce: h.pow_nonce,
    ciphertext: toHex(h.ciphertext),
  };
}

export function hintFromJson(j: ReturnType<typeof hintToJson>): HintPacket {
  return { ...j, blind_tag: fromHex(j.blind_tag), nonce: fromHex(j.nonce), ciphertext: fromHex(j.ciphertext) };
}

// ───────────────────────── セクション別の組み立て ─────────────────────────

export function buildConstants() {
  const wireTypes: Record<string, number> = {};
  for (const [name, value] of Object.entries(WireType)) {
    if (typeof value === 'number') wireTypes[name] = value;
  }
  // WireCodec が注入する内部タグ (Rust の internally tagged enum と一致させる値)
  const wireTags: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(wireTypes)) {
    if (value === WireType.UNKNOWN) continue;
    const decoded = WireCodec.decode(WireCodec.encode(value, {}));
    wireTags[name] = typeof decoded.payload?.type === 'string' ? decoded.payload.type : null;
  }
  const emptyCell = OnionRouter.padCell(new Uint8Array(0));
  return {
    wireTypes,
    wireTags,
    onion: {
      CELL_SIZE: OnionRouter.CELL_SIZE,
      EXIT_LAYER_SIZE: OnionRouter.EXIT_LAYER_SIZE,
      SEALED_EXIT_LAYER_SIZE,
      cellMagic: toHex(emptyCell.subarray(0, 2)),
    },
    powPolicy: { ...POW_POLICY },
    gossipDomain: ascii(GOSSIP_DOMAIN),
    hint: {
      HINT_VERSION,
      BLIND_TAG_SIZE,
      HINT_NONCE_SIZE,
      HINT_PLAINTEXT_SIZE,
      HINT_CIPHERTEXT_SIZE,
      HINT_INITIAL_TTL,
      HINT_POW_DIFFICULTY,
      HINT_DOMAIN: ascii(HINT_DOMAIN),
      ENCODED_HINT_SIZE,
    },
    nodeIdentity: {
      PEER_ID_BYTES,
      CHALLENGE_BYTES,
      NODE_ID_POW: { ...NODE_ID_POW },
      NODE_ID_POW_FAST: { ...NODE_ID_POW_FAST },
    },
    ringMesh: { ...RING_MESH },
    ringMeshZone: { ...RING_MESH_ZONE },
    rateLimits: JSON.parse(JSON.stringify(RATE_LIMITS)) as Record<string, { ratePerSec: number; burst: number }>,
    seenCacheTtlMs: SeenCache.TTL_MS,
    cryptoEngineMagic: 'AETH',
  };
}

export function buildKeyManagerSection() {
  const threadKey = KeyManager.deriveThreadKey(boardKey(), INPUTS.threadId);
  const topicHash = KeyManager.deriveTopicHash(threadKey);
  const zoneIds: number[] = [];
  for (let depth = 0; depth <= 16; depth++) zoneIds.push(KeyManager.computeZoneId(topicHash, depth));
  return {
    boardKey: toHex(boardKey()),
    threadId: INPUTS.threadId,
    threadKey: toHex(threadKey),
    topicHash: toHex(topicHash),
    zoneIds,
  };
}

export function buildNodeIdentitySection() {
  const kp = seededKeyPair(INPUTS.nodeSeedByte);
  const peerId = NodeIdentity.derivePeerId(kp.publicKey);
  const counter = NodeIdentity.solveNodeIdPow(kp.publicKey, NODE_ID_POW_FAST);
  return {
    seed: toHex(new Uint8Array(32).fill(INPUTS.nodeSeedByte)),
    pubkey: toHex(kp.publicKey),
    peerId,
    position: NodeIdentity.derivePosition(peerId),
    nodeIdPowFast: {
      params: { ...NODE_ID_POW_FAST },
      counter,
      hashAtCounter0: toHex(NodeIdentity.nodeIdPowHash(kp.publicKey, 0, NODE_ID_POW_FAST)),
      hashAtSolvedCounter: toHex(NodeIdentity.nodeIdPowHash(kp.publicKey, counter, NODE_ID_POW_FAST)),
    },
    nodeIdPowTiny: {
      params: { ...INPUTS.tinyPow },
      hashAtCounter0: toHex(NodeIdentity.nodeIdPowHash(kp.publicKey, 0, INPUTS.tinyPow)),
    },
  };
}

export function buildJoinSection() {
  const kp = seededKeyPair(INPUTS.nodeSeedByte);
  const counter = NodeIdentity.solveNodeIdPow(kp.publicKey, NODE_ID_POW_FAST);
  const identity = NodeIdentity.fromKeyPair(kp.publicKey, kp.privateKey, counter);
  const binding = joinBinding();
  const claim = identity.signClaim(new Uint8Array(INPUTS.challenge), binding);
  return {
    domain: 'AETHER/v4/join',
    challenge: toHex(INPUTS.challenge),
    signerId: identity.peerId,
    binding: { ...binding },
    message: toHex(joinMessage(new Uint8Array(INPUTS.challenge), identity.peerId, binding)),
    signature: toHex(claim.signature),
    powCounter: claim.powCounter,
  };
}

/** トラッカー登録 (v2) の署名対象と署名 */
export function buildTrackerSection() {
  const kp = seededKeyPair(INPUTS.nodeSeedByte);
  const counter = NodeIdentity.solveNodeIdPow(kp.publicKey, NODE_ID_POW_FAST);
  const identity = NodeIdentity.fromKeyPair(kp.publicKey, kp.privateKey, counter);
  const nonce = new Uint8Array(INPUTS.trackerNonce);
  return {
    domain: 'AETHER/v1/tracker-join',
    protocolVersion: TRACKER_PROTOCOL_VERSION,
    maxFrameBytes: TRACKER_MAX_FRAME_BYTES,
    maxPeers: TRACKER_MAX_PEERS,
    nonce: toHex(nonce),
    peerId: identity.peerId,
    host: INPUTS.trackerHost,
    message: toHex(trackerJoinMessage(nonce, identity.peerId, INPUTS.trackerHost)),
    signature: toHex(identity.signTrackerJoin(nonce, INPUTS.trackerHost)),
    powCounter: counter,
  };
}

export function buildGossipPowSection() {
  const header = INPUTS.gossipHeader;
  const preimage = powPreimage(header);
  const solved = solvePow(header)!;
  return {
    header: {
      timestamp: header.timestamp,
      zone_id: header.zone_id,
      pow_difficulty: header.pow_difficulty,
      nonce: toHex(header.nonce),
      payload: toHex(header.payload),
    },
    preimage: toHex(preimage),
    packetId: derivePacketId(header),
    powHashAtNonce0: toHex(powHash(preimage, 0n)),
    solvedNonce: Number(solved),
    powHashAtSolvedNonce: toHex(powHash(preimage, solved)),
  };
}

export async function buildCryptoEngineSection() {
  const threadKey = KeyManager.deriveThreadKey(boardKey(), INPUTS.threadId);
  const enc = await withDeterministicRandom('crypto-engine', () =>
    CryptoEngine.encrypt(threadKey, new Uint8Array(INPUTS.aeadPlaintext)),
  );
  return {
    threadKey: toHex(threadKey),
    plaintext: toHex(INPUTS.aeadPlaintext),
    nonce: toHex(enc.nonce),
    ciphertext: toHex(enc.ciphertext),
  };
}

export async function buildPacketBuilderSection() {
  const threadKey = KeyManager.deriveThreadKey(boardKey(), INPUTS.threadId);
  const p = INPUTS.post;
  const packet = await withFixedNow(INPUTS.nowMs, () =>
    withDeterministicRandom('packet-builder', () =>
      PacketBuilder.build(
        p.content, threadKey, seededIdentity(), new CryptoEngine(), syncPowEngine, keyManager,
        INPUTS.boardId, INPUTS.threadId, p.postNumber, p.replyTo, p.powDifficulty, p.depth,
        p.postType, [...p.parents], p.threadRoot, p.cumulativePow,
      ),
    ),
  );
  return {
    nowMs: INPUTS.nowMs,
    threadKey: toHex(threadKey),
    sessionPubkey: toHex(seededKeyPair(INPUTS.sessionSeedByte).publicKey),
    tripPubkey: toHex(seededKeyPair(INPUTS.tripSeedByte).publicKey),
    packet: packetToJson(packet),
  };
}

export function buildHintSection() {
  const h = INPUTS.hint;
  const packet = buildHint(
    new Uint8Array(32).fill(h.boardKeyByte),
    { nonce: new Uint8Array(32).fill(h.slotNonceByte), message_id: h.messageId, timestamp: h.timestamp },
    { unsafeFixedNonceForVectors: new Uint8Array(HINT_NONCE_SIZE).fill(h.fixedNonceByte) },
  );
  return {
    packet: hintToJson(packet),
    id: hintId(packet),
    encoded: toHex(encodeHint(packet)),
  };
}

/**
 * オニオン: パディングは決定化できるが、封印 (crypto_box_seal) は決定化できない。
 * 回路は実運用 (OnionCircuit) と同じ 2 ホップ [Guard, Exit]。
 */
export async function buildOnionSection() {
  const hops = [INPUTS.verifierSeedByte, INPUTS.exitSeedByte].map(b => {
    const kp = seededKeyPair(b);
    return { seed: toHex(new Uint8Array(32).fill(b)), peerId: NodeIdentity.derivePeerId(kp.publicKey), pubkey: toHex(kp.publicKey) };
  });
  const padded = await withDeterministicRandom('onion-pad', () =>
    OnionRouter.padCell(new TextEncoder().encode('golden cell payload')),
  );
  const cell = OnionRouter.wrapCircuit(
    { type: 'exit_hint', hint: new Uint8Array(INPUTS.onionExitHint) },
    hops.map(h => ({ peerId: h.peerId, pubkey: fromHex(h.pubkey) })),
  );
  return {
    hops,
    exitHint: toHex(INPUTS.onionExitHint),
    /** 2 ホップ回路の外殻 (Guard に送るセル)。乱数入りなので再生成のたびに変わる */
    cell: toHex(cell),
    paddedCellPrefix: toHex(padded.subarray(0, 4 + 'golden cell payload'.length)),
    paddedCellSha256: sha256Hex(padded),
  };
}

/** 全 WireType の決定的なペイロード */
export function wirePayloads(ctx: {
  join: ReturnType<typeof buildJoinSection>;
  node: ReturnType<typeof buildNodeIdentitySection>;
  gossipPacket: GossipPacket;
  hint: HintPacket;
  onionCell: Uint8Array;
}): Array<[string, WireType, any]> {
  const challenge = new Uint8Array(INPUTS.challenge);
  const pubkey = fromHex(ctx.node.pubkey);
  const mailboxEntry = new TextEncoder().encode(JsonBinary.stringify(ctx.gossipPacket));
  const other = NodeIdentity.derivePeerId(seededKeyPair(INPUTS.relaySeedByte).publicKey);
  return [
    ['hello', WireType.HELLO, { challenge }],
    ['join', WireType.JOIN, {
      peerId: ctx.join.signerId,
      pubkey,
      powCounter: ctx.join.powCounter,
      challenge,
      signature: fromHex(ctx.join.signature),
    }],
    ['ringInfo', WireType.RING_INFO, { neighbors: [{ id: ctx.node.peerId }, { id: other }] }],
    ['ping', WireType.PING, { ts: 0xdeadbeef }],
    ['pong', WireType.PONG, { ts: 0xdeadbeef }],
    ['localLinkReq', WireType.LOCAL_LINK_REQ, {}],
    ['localLinkAck', WireType.LOCAL_LINK_ACK, {}],
    ['localLinkRej', WireType.LOCAL_LINK_REJ, {}],
    ['pexRequest', WireType.PEX_REQUEST, { minDistance: 0 }],
    ['pexResponse', WireType.PEX_RESPONSE, {
      peers: [{ id: ctx.node.peerId, pubkey, powCounter: ctx.node.nodeIdPowFast.counter }, { id: other }],
    }],
    ['sdpRelay', WireType.SDP_RELAY, {
      targetPeerId: other,
      senderId: ctx.node.peerId,
      sdp: { type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' },
    }],
    ['iceRelay', WireType.ICE_RELAY, {
      targetPeerId: other,
      senderId: ctx.node.peerId,
      candidate: { candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    }],
    ['gossip', WireType.GOSSIP, { packet: ctx.gossipPacket }],
    ['stem', WireType.STEM, { zoneId: ctx.gossipPacket.zone_id, packet: ctx.gossipPacket }],
    ['hint', WireType.HINT, ctx.hint],
    ['hintStem', WireType.HINT_STEM, ctx.hint],
    ['onionStem', WireType.ONION_STEM, { onionBytes: ctx.onionCell }],
    ['dhtPut', WireType.DHT_PUT, { topicHash: INPUTS.topicHashHex, entries: [mailboxEntry] }],
    ['dhtPutSlot', WireType.DHT_PUT, { topicHash: INPUTS.slotTopicHashHex, entries: [encodeSlotBlob(ctx.hint, mailboxEntry)] }],
    ['dhtPutStem', WireType.DHT_PUT_STEM, { topicHash: INPUTS.topicHashHex, entries: [mailboxEntry] }],
    ['dhtGet', WireType.DHT_GET, { topicHash: INPUTS.topicHashHex, reqId: INPUTS.reqId }],
    ['dhtRes', WireType.DHT_RES, { topicHash: INPUTS.topicHashHex, reqId: INPUTS.reqId, entries: [mailboxEntry] }],
  ];
}

export function buildWireSection(ctx: Parameters<typeof wirePayloads>[0]) {
  const frames: Record<string, { type: number; hex: string }> = {};
  for (const [name, type, payload] of wirePayloads(ctx)) {
    frames[name] = { type, hex: toHex(WireCodec.encode(type, payload)) };
  }
  return { frames };
}

/** gossip ベクタのパケット (hop_count=3 の中継途中のもの) */
export function gossipPacketFrom(section: ReturnType<typeof buildGossipPowSection>): GossipPacket {
  return {
    packet_id: section.packetId,
    hop_count: 3,
    pow_nonce: section.solvedNonce,
    pow_difficulty: section.header.pow_difficulty,
    timestamp: section.header.timestamp,
    zone_id: section.header.zone_id,
    nonce: fromHex(section.header.nonce),
    payload: fromHex(section.header.payload),
  };
}

export const VECTORS_COMMENT =
  'Generated by packages/core/tests/protocol/generateVectors.ts — do not edit by hand. ' +
  'Consumed by ProtocolConformance.test.ts. Regenerate ONLY for an intentional, versioned wire/crypto format change.';

/**
 * 全セクションを組み立てる。
 * onionCell を渡すと、ONION_STEM フレームはそのセルで組み立てる
 * (テストで「保存済みのセル」から決定的に再符号化するため)。
 */
export async function buildGoldenVectors(opts: { onionCell?: Uint8Array } = {}) {
  await sodium.ready;
  const constants = buildConstants();
  const keyManagerSection = buildKeyManagerSection();
  const node = buildNodeIdentitySection();
  const join = buildJoinSection();
  const tracker = buildTrackerSection();
  const gossipPow = buildGossipPowSection();
  const cryptoEngine = await buildCryptoEngineSection();
  const packetBuilder = await buildPacketBuilderSection();
  const hint = buildHintSection();
  const onion = await buildOnionSection();
  const onionCell = opts.onionCell ?? fromHex(onion.cell);
  const wire = buildWireSection({
    join,
    node,
    gossipPacket: gossipPacketFrom(gossipPow),
    hint: hintFromJson(hint.packet),
    onionCell,
  });
  return {
    _comment: VECTORS_COMMENT,
    constants,
    keyManager: keyManagerSection,
    nodeIdentity: node,
    join,
    tracker,
    gossipPow,
    cryptoEngine,
    packetBuilder,
    hint,
    onion: { ...onion, cell: toHex(onionCell) },
    wire,
  };
}

export type GoldenVectors = Awaited<ReturnType<typeof buildGoldenVectors>>;

// msgpackEncode は再エクスポートだけ (テストで期待バイト列を別経路で作るため)
export { msgpackEncode };
