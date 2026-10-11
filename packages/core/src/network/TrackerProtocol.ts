/**
 * トラッカー (シグナリングサーバ) とノードの間のプロトコル。
 *
 * ★ クライアント (SignalingClient) とサーバ (@aether/tracker) の両方がこのファイルの
 *   型と検証関数を使う。片方だけ形式を変えて食い違う、ということが起きないようにするため。
 *
 * 流れ (v2):
 *   1. 接続直後、サーバが hello { nonce } を送る (接続ごとに新しい乱数)。
 *   2. ノードが join { peerId, pubkey, powCounter, host, sig } を送る。
 *        sig = Ed25519(trackerJoinMessage(nonce, peerId, host))
 *      サーバは Bound Identity (peerId = hash(pubkey) + NodeId PoW) と署名を検証する。
 *      host は「ノードが接続したつもりのトラッカー」で、サーバは自分のホスト名と照合する。
 *   3. サーバが peers { peers } を返す。以後 relay で SDP/ICE を中継する。
 *
 * v1 (署名なしの join) は受け付けない。peerId・pubkey・powCounter は P2P の JOIN で
 * 全隣人に渡る公開情報なので、署名が無いと誰でも他人の ID で登録できた。
 */
import { CHALLENGE_BYTES } from '../crypto/NodeIdentity';

export const TRACKER_PROTOCOL_VERSION = 2;

/** 1 フレームの上限 (サーバ・クライアント共通) */
export const TRACKER_MAX_FRAME_BYTES = 64 * 1024;
/** peers で返す最大件数 */
export const TRACKER_MAX_PEERS = 32;

const PEER_ID_RE = /^[0-9a-f]{32}$/;
const PUBKEY_RE = /^[0-9a-f]{64}$/;
const NONCE_RE = new RegExp(`^[0-9a-f]{${CHALLENGE_BYTES * 2}}$`);
const SIG_RE = /^[0-9a-f]{128}$/;
/** ホスト名 (小文字)・IPv4・[IPv6]、任意でポート */
const HOST_RE = /^(?:[a-z0-9.-]{1,253}|\[[0-9a-f:.]{2,45}\])(?::\d{1,5})?$/;

export type TrackerErrorCode =
  | 'bad-message'
  | 'unsupported-version'
  | 'invalid-identity'
  | 'bad-signature'
  | 'bad-host'
  | 'rate-limited'
  | 'capacity'
  | 'not-joined'
  | 'invalid-target'
  | 'too-large'
  | 'timeout';

const ERROR_CODES: ReadonlySet<string> = new Set<TrackerErrorCode>([
  'bad-message', 'unsupported-version', 'invalid-identity', 'bad-signature', 'bad-host',
  'rate-limited', 'capacity', 'not-joined', 'invalid-target', 'too-large', 'timeout',
]);

// ── サーバ → ノード ──

export interface TrackerHello { type: 'hello'; v: number; nonce: string }
export interface TrackerPeers { type: 'peers'; peers: Array<{ peerId: string }> }
export interface TrackerRelayIn { type: 'relay'; senderId: string; payload: Record<string, unknown> }
export interface TrackerError { type: 'error'; code: TrackerErrorCode }
export type TrackerServerMessage = TrackerHello | TrackerPeers | TrackerRelayIn | TrackerError;

// ── ノード → サーバ ──

export interface TrackerJoin {
  type: 'join';
  v: number;
  peerId: string;
  /** Ed25519 公開鍵 (hex 64) */
  pubkey: string;
  powCounter: number;
  /** ノードが接続したつもりのトラッカーのホスト (小文字、既定以外のポートを含む) */
  host: string;
  /** Ed25519 署名 (hex 128) */
  sig: string;
}
export interface TrackerRelayOut { type: 'relay'; targetPeerId: string; payload: Record<string, unknown> }
export type TrackerClientMessage = TrackerJoin | TrackerRelayOut;

export function isPeerId(v: unknown): v is string {
  return typeof v === 'string' && PEER_ID_RE.test(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJson(raw: unknown): unknown {
  const text = typeof raw === 'string' ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : null;
  if (text === null || text.length > TRACKER_MAX_FRAME_BYTES) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** WebSocket の URL から、署名に含めるホストを取り出す (URL の正規化に従う) */
export function trackerHostOf(url: string): string {
  return new URL(url).host.toLowerCase();
}

/** HTTP の Host ヘッダの値を、署名のホストと同じ形に揃える */
export function normalizeHostHeader(host: string | undefined): string | null {
  if (typeof host !== 'string') return null;
  const h = host.trim().toLowerCase();
  if (!HOST_RE.test(h)) return null;
  // 既定のポートは URL の正規化で消えるので、Host ヘッダ側も消して揃える
  return h.replace(/:(80|443)$/, '');
}

/** サーバ側: ノードからのメッセージを検証する。不正なら null (例外は投げない) */
export function parseTrackerClientMessage(raw: unknown): TrackerClientMessage | null {
  const d = parseJson(raw);
  if (!isPlainObject(d)) return null;
  if (d.type === 'join') {
    if (
      !Number.isSafeInteger(d.v) ||
      !isPeerId(d.peerId) ||
      typeof d.pubkey !== 'string' || !PUBKEY_RE.test(d.pubkey) ||
      !Number.isSafeInteger(d.powCounter) || (d.powCounter as number) < 0 ||
      typeof d.host !== 'string' || !HOST_RE.test(d.host) ||
      typeof d.sig !== 'string' || !SIG_RE.test(d.sig)
    ) {
      return null;
    }
    return {
      type: 'join',
      v: d.v as number,
      peerId: d.peerId,
      pubkey: d.pubkey,
      powCounter: d.powCounter as number,
      host: d.host,
      sig: d.sig,
    };
  }
  if (d.type === 'relay') {
    if (!isPeerId(d.targetPeerId) || !isPlainObject(d.payload)) return null;
    return { type: 'relay', targetPeerId: d.targetPeerId, payload: d.payload };
  }
  return null;
}

/** ノード側: トラッカーからのメッセージを検証する。不正なら null (例外は投げない) */
export function parseTrackerServerMessage(raw: unknown): TrackerServerMessage | null {
  const d = parseJson(raw);
  if (!isPlainObject(d)) return null;
  switch (d.type) {
    case 'hello':
      if (!Number.isSafeInteger(d.v) || typeof d.nonce !== 'string' || !NONCE_RE.test(d.nonce)) return null;
      return { type: 'hello', v: d.v as number, nonce: d.nonce };
    case 'peers': {
      if (!Array.isArray(d.peers)) return null;
      const peers = d.peers
        .slice(0, TRACKER_MAX_PEERS)
        .filter((p): p is { peerId: string } => isPlainObject(p) && isPeerId(p.peerId))
        .map((p) => ({ peerId: p.peerId }));
      return { type: 'peers', peers };
    }
    case 'relay':
      if (!isPeerId(d.senderId) || !isPlainObject(d.payload)) return null;
      return { type: 'relay', senderId: d.senderId, payload: d.payload };
    case 'error':
      return { type: 'error', code: typeof d.code === 'string' && ERROR_CODES.has(d.code) ? (d.code as TrackerErrorCode) : 'bad-message' };
    default:
      return null;
  }
}
