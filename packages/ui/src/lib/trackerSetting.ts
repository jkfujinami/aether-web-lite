import { parseTrackerUrl, type IndexedDBStore } from '@aether/core';

/**
 * トラッカー URL の保存。
 *
 * 公式のトラッカーは無いので、利用者が設定した値を暗号化された端末 DB に保存する
 * (どのネットワークに参加しているかの手掛かりになるため、平文では置かない)。
 *
 *   - 保存値が { url: 文字列 } → その URL
 *   - 保存値が { url: null }   → 利用者が明示的に消した。既定値にも戻さない
 *   - 保存値が無い             → アプリが渡した既定値 (fallback) があればそれ、無ければ未設定
 *
 * 既定値はアプリごとに決める (AetherApp の defaultTrackerUrl):
 *   - Desktop: ビルド時の VITE_AETHER_TRACKER_URL (開発用。配布物に入れると全利用者が
 *     その相手に接続するので、入れるなら運営者と配布元を明示すること)
 *   - Web: ページを配信したサーバ自身の /ws (ページの取得時点でそのサーバには IP が見えている)
 * どちらも検証を通らなければ使わない。
 */
export const TRACKER_SETTING = 'trackerUrl';

function validOrNull(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const parsed = parseTrackerUrl(url);
  return parsed.ok ? parsed.url : null;
}

/** 保存形式。null をそのまま保存すると「未保存」と区別できないので包む */
interface StoredTracker {
  url: string | null;
}

export async function loadTrackerUrl(
  db: Pick<IndexedDBStore, 'getSetting'>,
  fallback: string | null = null,
): Promise<string | null> {
  const saved = await db.getSetting<StoredTracker>(TRACKER_SETTING);
  if (saved === undefined) return validOrNull(fallback);
  return typeof saved === 'object' && saved !== null ? validOrNull(saved.url) : null;
}

export async function saveTrackerUrl(db: Pick<IndexedDBStore, 'setSetting'>, url: string | null): Promise<void> {
  const value: StoredTracker = { url };
  await db.setSetting(TRACKER_SETTING, value);
}
