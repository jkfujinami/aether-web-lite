import type { GossipPacket } from '../../types';
import { JsonBinary } from '../../common/JsonBinary';
import { PacketValidator, type RejectReason } from '../gossip/PacketValidator';

/**
 * DHT に保存されるエントリの検証。
 *
 * エントリの中身は「JsonBinary で直列化した GossipPacket」である
 * (BoardOrchestrator / ThreadOrchestrator が publish しているもの)。
 * したがって保管ノードは鍵を持っていなくても
 *
 *   - CHK: packet_id == SHA256(コミット済みヘッダ)
 *   - PoW: 難易度が MIN_DIFFICULTY 以上で、実際に解けている
 *   - サイズ・型・未来日付
 *
 * を検証できる。中身が何かは分からないまま (Schrödinger)、
 * 「少なくとも PoW を払った、改竄されていない構造物である」ことだけを保証する。
 *
 * 旧実装は handlePut / handleRes のどちらでもこれを一切やらず、
 * 届いたバイト列をそのまま IndexedDB に書いていた。
 */

export const MAILBOX_LIMITS = {
  /** 1 エントリのバイト長上限。GossipPacket 1 個 (payload 2KB) が JSON 化された分の余裕を見る */
  MAX_ENTRY_BYTES: 16 * 1024,
  /** 1 メッセージで受け付けるエントリ数 */
  MAX_ENTRIES_PER_MESSAGE: 64,
  /** 1 トピックあたりの保持エントリ数 */
  MAX_ENTRIES_PER_TOPIC: 512,
  /** 保持するトピック総数 */
  MAX_TOPICS: 2048,
} as const;

export type EntryRejectReason = RejectReason | 'too-large' | 'not-json' | 'not-a-packet';

export interface EntryCheck {
  ok: boolean;
  packet?: GossipPacket;
  reason?: EntryRejectReason;
}

/** topicHash は SHA-256(64桁) か SHA-512(128桁) の hex */
const TOPIC_HASH_RE = /^[0-9a-f]{64}(?:[0-9a-f]{64})?$/;

export function isValidTopicHash(topicHash: unknown): topicHash is string {
  return typeof topicHash === 'string' && TOPIC_HASH_RE.test(topicHash);
}

/**
 * 1 エントリを検証する。
 *
 * `allowStale: true` で検証するのが要点。DHT は過去ログの保管庫なので、
 * 何日も前のパケットが正当に入っている。ライブゴシップと同じ 15 分の
 * ドリフト検査を掛けると過去ログ同期が丸ごと壊れる。
 * 未来日付・PoW・CHK は変わらず全件に掛かる。
 */
export function checkEntry(entry: Uint8Array, now: number = Date.now()): EntryCheck {
  if (!(entry instanceof Uint8Array)) return { ok: false, reason: 'not-a-packet' };
  if (entry.length === 0 || entry.length > MAILBOX_LIMITS.MAX_ENTRY_BYTES) {
    return { ok: false, reason: 'too-large' };
  }

  let packet: GossipPacket;
  try {
    packet = JsonBinary.parse<GossipPacket>(new TextDecoder().decode(entry));
  } catch {
    return { ok: false, reason: 'not-json' };
  }

  if (!packet || typeof packet !== 'object') return { ok: false, reason: 'not-a-packet' };

  const result = PacketValidator.check(packet, { now, allowStale: true });
  if (!result.ok) return { ok: false, reason: result.reason };

  return { ok: true, packet };
}

/**
 * エントリ配列をふるいに掛け、通ったものだけを返す。
 *
 * @returns 受理したエントリと、拒否件数の内訳
 */
export function filterValidEntries(
  entries: unknown,
  now: number = Date.now(),
): { accepted: Uint8Array[]; rejected: Map<EntryRejectReason, number> } {
  const accepted: Uint8Array[] = [];
  const rejected = new Map<EntryRejectReason, number>();

  if (!Array.isArray(entries)) return { accepted, rejected };

  const seen = new Set<string>();

  for (const raw of entries.slice(0, MAILBOX_LIMITS.MAX_ENTRIES_PER_MESSAGE)) {
    const entry = raw instanceof Uint8Array
      ? raw
      : ArrayBuffer.isView(raw)
        ? new Uint8Array((raw as ArrayBufferView).buffer, (raw as ArrayBufferView).byteOffset, (raw as ArrayBufferView).byteLength)
        : null;

    if (!entry) {
      rejected.set('not-a-packet', (rejected.get('not-a-packet') ?? 0) + 1);
      continue;
    }

    const check = checkEntry(entry, now);
    if (!check.ok) {
      const reason = check.reason ?? 'not-a-packet';
      rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
      continue;
    }

    // 同一メッセージ内の重複は 1 件に畳む (水増しの防止)
    const id = check.packet!.packet_id;
    if (seen.has(id)) continue;
    seen.add(id);

    accepted.push(entry);
  }

  return { accepted, rejected };
}
