'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { usePathname } from 'next/navigation';

/**
 * URL fragment (#) からパラメータを読み取るフック。
 * フラグメントはHTTPリクエストに含まれないため、鍵などの機密情報の受け渡しに安全。
 * 
 * 例: http://localhost:3000/thread/abc#board=vip&key=xxx
 *   → get('board') = 'vip', get('key') = 'xxx'
 */
export function useHashParams() {
  const pathname = usePathname();
  const [hashStr, setHashStr] = useState('');

  useEffect(() => {
    const update = () => {
      const raw = window.location.hash;
      setHashStr(raw.startsWith('#') ? raw.slice(1) : raw);
    };
    update();
    window.addEventListener('hashchange', update);
    window.addEventListener('popstate', update);
    return () => {
      window.removeEventListener('hashchange', update);
      window.removeEventListener('popstate', update);
    };
  }, [pathname]); // pathname が変わったときも再読み取り

  const params = useMemo(() => new URLSearchParams(hashStr), [hashStr]);

  const get = useCallback((key: string): string | null => params.get(key), [params]);

  return { get, params };
}

/**
 * ハッシュベースのナビゲーションユーティリティ。
 * 同一ページ内ではhashchangeイベントで反応し、
 * 異なるページへは window.location を使って遷移する。
 */
export function navigateWithHash(
  path: string, 
  hashParams: Record<string, string>,
  router?: { push: (url: string) => void }
) {
  // Build clean hash string (no encoding needed for base64url-safe chars)
  const pairs = Object.entries(hashParams)
    .filter(([, v]) => v !== '' && v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`);
  const hash = pairs.join('&');
  const fullUrl = `${path}#${hash}`;

  if (window.location.pathname === path) {
    // Same page: direct hash change triggers hashchange event
    window.location.hash = hash;
  } else if (router) {
    // Cross-page via Next.js router
    router.push(fullUrl);
  } else {
    // Fallback
    window.location.href = fullUrl;
  }
}
