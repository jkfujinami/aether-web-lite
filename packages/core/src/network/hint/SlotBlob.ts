import { u32be } from '../../crypto/PowPolicy';
import { ENCODED_HINT_SIZE, decodeHint, encodeHint, type HintPacket } from './HintPacket';

/**
 * Slot に保管するバイト列 = `[hint_blob] ‖ [body_blob]`
 *
 * ★ なぜ本体と索引を同じ Slot に入れるのか (§18.3-A)
 *
 * Hint を受け取れなかったノードは `mailbox_key` を永久に計算できない。
 * したがって **Hint が一度きりの放流だと、後から参加した人は
 * 過去ログを一切発見できない。**
 *
 * 保持者が索引を再投入できるようにするため、本体と一緒に hint_blob を置く。
 * 保持者は hint_blob を**復号できない**が、バイト列としてそのまま
 * Gossip へ再投入することはできる。
 *
 * 匿名性への効果は可用性より大きい。Winny の主要検挙経路だった
 * 「新規キーの初出ノード = 一次放流者」は t=0 の一瞬しか観測機会がなく、
 * 再放流が始まると以降 Hint を流しているのは**コンテンツと無関係な
 * ランダムな保持者**になる。
 */

export interface SlotBlob {
  hint: HintPacket;
  body: Uint8Array;
}

/** 形式: u32be(hintLen) ‖ hint ‖ body */
export function encodeSlotBlob(hint: HintPacket, body: Uint8Array): Uint8Array {
  const hintBytes = encodeHint(hint);
  const out = new Uint8Array(4 + hintBytes.length + body.length);
  out.set(u32be(hintBytes.length), 0);
  out.set(hintBytes, 4);
  out.set(body, 4 + hintBytes.length);
  return out;
}

export function decodeSlotBlob(bytes: Uint8Array): SlotBlob | null {
  if (bytes.length < 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hintLen = view.getUint32(0);
  // 長さは固定なので、違う値は壊れた入力として扱う
  if (hintLen !== ENCODED_HINT_SIZE) return null;
  if (bytes.length < 4 + hintLen) return null;

  const hint = decodeHint(bytes.slice(4, 4 + hintLen));
  if (!hint) return null;

  return { hint, body: bytes.slice(4 + hintLen) };
}

/**
 * 保管されたバイト列から hint_blob だけを取り出す。
 *
 * 再放流はこれだけを使う。**本体には一切触れない**ので、
 * 保持者が中身を読めないという性質はそのまま保たれる。
 */
export function extractHint(bytes: Uint8Array): HintPacket | null {
  return decodeSlotBlob(bytes)?.hint ?? null;
}
