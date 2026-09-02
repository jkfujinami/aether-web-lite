import type { GossipPacket } from '../../types';
import { PacketBuilder } from '../../crypto/PacketBuilder';
import { POW_POLICY, derivePacketId, verifyPow } from '../../crypto/PowPolicy';

/**
 * 互換用エイリアス。値は {@link POW_POLICY} を単一の出所とする。
 */
export const GOSSIP_RULES = {
  MAX_PAYLOAD_SIZE: POW_POLICY.MAX_PAYLOAD_SIZE,
  MAX_HOP_COUNT: POW_POLICY.MAX_HOP_COUNT,
  MAX_TIME_DRIFT: POW_POLICY.MAX_TIME_DRIFT,
  MIN_DIFFICULTY: POW_POLICY.MIN_DIFFICULTY,
} as const;

/** 拒否理由。ログとテストの両方で使う */
export type RejectReason =
  | 'malformed'
  | 'bad-packet-id-type'
  | 'bad-timestamp'
  | 'bad-payload-size'
  | 'bad-nonce-size'
  | 'bad-hop-count'
  | 'bad-pow-nonce'
  | 'time-drift'
  | 'packet-id-mismatch'
  | 'insufficient-pow';

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: RejectReason };

export interface ValidateOptions {
  /** テスト用に現在時刻を差し替えるためのフック */
  now?: number;
  /**
   * 過去方向のドリフト検査を省く。
   *
   * DHT (Mailbox) は「過去ログの保管庫」なので、そこに入っているパケットは
   * 15 分どころか何日も前のものが正当にあり得る。ライブのゴシップと同じ
   * 検査を掛けると過去ログ同期が丸ごと壊れる。
   *
   * 未来方向のドリフトは省かない (未来日付での順序操作を防ぐため)。
   * PoW と CHK は変わらず全件に掛かるので、偽造は依然として不可能。
   */
  allowStale?: boolean;
}

const OK: ValidationResult = { ok: true };
const fail = (reason: RejectReason): ValidationResult => ({ ok: false, reason });

/**
 * PacketValidator — 鍵を持たない中継ノードでも実行できる検証。
 *
 * 旧実装の致命的欠陥:
 *   `PoWEngine.verify(payload, nonce, packet.pow_difficulty)` と、
 *   受信パケットが *自己申告* した難易度をそのまま使っていた。
 *   PoWEngine.verify は difficulty===0 で即 true を返していたため、
 *   攻撃者は `pow_difficulty: 0` と書くだけで PoW を一切計算せずに
 *   全ノードに受理された。スパム対策が事実上ゼロだった。
 *
 * 現在は 2 段構えで縛る:
 *   1. CHK — packet_id が「コミット済みヘッダの SHA-256」と一致するか。
 *      ヘッダを 1 ビットでも書き換えれば必ず落ちる。
 *   2. PoW — {@link verifyPow} が MIN_DIFFICULTY / MAX_DIFFICULTY を強制する。
 *      申告値が下限未満なら、その難易度としては正当な解を持っていても拒否。
 *
 * 全体が同期関数であることも重要。旧実装は Worker 越しの非同期検証だったため、
 * 攻撃者はゴミパケットを流すだけで単一 Worker を占有し、正当なパケットの
 * 処理を詰まらせられた。SHA-256 なら 1 回 1.3us なので直接呼んでよい。
 */
export class PacketValidator {
  /** ZoneGossipRouter が中継打ち切りに使う */
  public static readonly MAX_HOP_COUNT = POW_POLICY.MAX_HOP_COUNT;

  public static check(packet: GossipPacket, opts: ValidateOptions = {}): ValidationResult {
    const now = opts.now ?? Date.now();
    if (!packet || typeof packet !== 'object') return fail('malformed');
    if (typeof packet.packet_id !== 'string' || packet.packet_id.length !== 64) {
      return fail('bad-packet-id-type');
    }
    if (typeof packet.timestamp !== 'number' || !Number.isSafeInteger(packet.timestamp) || packet.timestamp < 0) {
      return fail('bad-timestamp');
    }

    const header = PacketBuilder.committedHeaderOf(packet);

    // 1. サイズ制約
    if (header.payload.length === 0 || header.payload.length > POW_POLICY.MAX_PAYLOAD_SIZE) {
      return fail('bad-payload-size');
    }
    if (header.nonce.length !== POW_POLICY.NONCE_SIZE) {
      return fail('bad-nonce-size');
    }

    // 2. hop_count 上限 (無限ループ防止)。PoW のコミット対象ではないので
    //    範囲チェックのみ。攻撃者が 0 に戻しても SeenCache が重複を弾く。
    if (
      typeof packet.hop_count !== 'number' ||
      !Number.isInteger(packet.hop_count) ||
      packet.hop_count < 0 ||
      packet.hop_count > POW_POLICY.MAX_HOP_COUNT
    ) {
      return fail('bad-hop-count');
    }

    // 3. pow_nonce の型。BigInt() が例外を投げる値をここで落とす。
    if (
      typeof packet.pow_nonce !== 'number' ||
      !Number.isSafeInteger(packet.pow_nonce) ||
      packet.pow_nonce < 0
    ) {
      return fail('bad-pow-nonce');
    }

    // 4. 時刻制約 (SeenCache TTL との二重防御)
    //    15分以内の再送は LRU が、それ以前は時刻検査が弾く。
    if (packet.timestamp - now > POW_POLICY.MAX_TIME_DRIFT) {
      return fail('time-drift'); // 未来日付は常に拒否
    }
    if (!opts.allowStale && now - packet.timestamp > POW_POLICY.MAX_TIME_DRIFT) {
      return fail('time-drift');
    }

    // 5. CHK: packet_id はコミット済みヘッダのハッシュでなければならない
    let expectedId: string;
    try {
      expectedId = derivePacketId(header);
    } catch {
      return fail('malformed');
    }
    if (expectedId !== packet.packet_id) return fail('packet-id-mismatch');

    // 6. PoW。難易度の下限・上限はここで強制される。
    if (!verifyPow(header, packet.pow_nonce)) return fail('insufficient-pow');

    return OK;
  }

  /** boolean だけ欲しい呼び出し側向け。理由はログに出す。 */
  public static validate(packet: GossipPacket, opts: ValidateOptions = {}): boolean {
    const result = PacketValidator.check(packet, opts);
    if (!result.ok) {
      const id = typeof packet?.packet_id === 'string' ? packet.packet_id.substring(0, 8) : '????????';
      console.warn(`[PacketValidator] Dropped ${id} (${result.reason})`);
    }
    return result.ok;
  }
}
