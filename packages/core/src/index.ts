// ============================================================================
// @aether/core — AETHER P2P Anonymity Hardened Core Protocol Library
// ============================================================================

// ── Types & Constants ──
export * from './types';
export * from './constants';

// ── Facade Node ──
export { AetherNode, type AetherNodeConfig } from './node/AetherNode';

// ── Common ──
export { Encoding } from './common/Encoding';
export { JsonBinary } from './common/JsonBinary';
export {
  createLogger,
  Logger,
  LogLevel,
  setLevel,
  resetLevels,
  currentLevels,
} from './common/Logger';

// ── Crypto & Identity ──
export { default as sodium, sodiumReady } from './crypto/sodium';
export { CryptoEngine } from './crypto/CryptoEngine';
export { Identity } from './crypto/Identity';
export { KeyManager } from './crypto/KeyManager';
export { PoWEngine } from './crypto/PoWEngine';
export { DifficultyEstimator } from './crypto/DifficultyEstimator';
export {
  POW_POLICY,
  GOSSIP_DOMAIN,
  type PowCommittedHeader,
  powPreimage,
  powHash,
  meetsDifficulty,
  derivePacketId,
  verifyPow,
  solvePow,
  toBytes,
} from './crypto/PowPolicy';
export {
  NodeIdentity,
  type NodeClaim,
  NODE_ID_POW,
} from './crypto/NodeIdentity';
export { NodeIdentityStore } from './crypto/NodeIdentityStore';
export { PacketBuilder } from './crypto/PacketBuilder';

// ── Wire & Stream ──
export { WireType } from './network/wire/WireTypes';
export { WireCodec, type DecodedWireMessage } from './network/wire/WireCodec';
export { ChunkedSender } from './network/stream/ChunkedSender';
export { ChunkedReceiver } from './network/stream/ChunkedReceiver';

// ── Network & Routing ──
export { PeerManager } from './network/PeerManager';
export { WebRTCPeer } from './network/WebRTCPeer';
export { SignalingClient, TrackerNotConfiguredError } from './network/SignalingClient';
export {
  parseTrackerUrl,
  describeTrackerUrlError,
  TRACKER_URL_MAX_LENGTH,
  type TrackerUrlError,
  type TrackerUrlResult,
} from './network/TrackerUrl';
export { MessageDispatcher } from './network/MessageDispatcher';
export { ZoneManager } from './network/ZoneManager';
export { ZoneGossipRouter } from './network/gossip/ZoneGossipRouter';
export { DandelionRouter, DANDELION_CONFIG } from './network/gossip/DandelionRouter';
export { OnionRouter, type OnionHop, type OnionPayload, type ExitPayload } from './crypto/OnionRouter';
export { OnionCircuit, CIRCUIT_CONFIG, type OnionCircuitOptions } from './network/onion/OnionCircuit';
export { SeenCache } from './network/gossip/SeenCache';
export { PEXHandler } from './network/PEXHandler';
export { Heartbeat } from './network/Heartbeat';
export { RingMaintainer } from './network/RingMaintainer';
export { RateLimiter } from './network/RateLimiter';
export { PeerMisbehaviorManager, ViolationType } from './network/PeerMisbehaviorManager';
export { PacketValidator } from './network/gossip/PacketValidator';

// ── Mailbox & Schrödinger Hint System ──
export { DHTMailbox } from './network/mailbox/DHTMailbox';
export { ReplicationManager } from './network/mailbox/ReplicationManager';
export { SchrodingerMailbox, REFLOOD_PERIOD_MS, BACKLOG_LIMIT } from './network/hint/SchrodingerMailbox';
export { HintRouter, type OpenedHint } from './network/hint/HintRouter';
export { hintId, type HintPacket } from './network/hint/HintPacket';
export {
  buildHint,
  openHint,
  mailboxKeyFromNonce,
  newMailboxSlot,
  type HintPayload,
} from './network/hint/HintCrypto';
export {
  encodeSlotBlob,
  decodeSlotBlob,
  extractHint,
  type SlotBlob,
} from './network/hint/SlotBlob';
export {
  HintReleaseScheduler,
  type ReleaseMode,
  type ReleaseStatus,
} from './network/hint/HintRelease';

// ── Logic & Orchestration ──
export { BoardOrchestrator } from './logic/BoardOrchestrator';
export { ThreadOrchestrator } from './logic/ThreadOrchestrator';
export { ThreadRanker } from './logic/ThreadRanker';
export { ThreadDAGManager, type DAGPost } from './logic/ThreadDAGManager';
export type { ThreadMeta, BoardStatus, ThreadStatus } from './logic/types';
export { BOARD_META_THREAD_ID } from './logic/types';
export { SyncProtocol } from './network/mailbox/SyncProtocol';

// ── Storage ──
export { SecretVault, VAULT_PARAMS, VAULT_PARAMS_FAST, type SealedSecret, type VaultParams } from './storage/SecretVault';
export { IndexedDBStore, type MailboxEntry, type PostEntry, type BoardRecord } from './storage/IndexedDBStore';
export { DataVault, WrongPassphraseError } from './storage/DataVault';

// Trusted guards
export {
  createGuardString,
  parseGuardString,
  signGuardList,
  verifyGuardList,
  maintainerKeyId,
  keyFingerprint,
  GUARD_STRING_PREFIX,
  GUARD_LIST_PREFIX,
  TRUSTED_GUARD_LIMITS,
  type MaintainerKeySet,
  type TrustedGuard,
  type GuardListContent,
  type GuardListResult,
} from './trust/TrustedGuards';
