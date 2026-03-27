'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Legacy route fallback.
 * 旧URL /thread/[id]?board=x&key=y にアクセスされた場合、
 * 新しいフラグメントベースのルーティング /#board=x&key=y&thread=id にリダイレクトする。
 */
export default function LegacyThreadRedirect() {
  const { id: threadId } = useParams() as { id: string };
  const searchParams = useSearchParams();

  useEffect(() => {
    const board = searchParams.get('board') || 'vip';
    const key = searchParams.get('key') || '';
    const params = [`board=${board}`];
    if (key) params.push(`key=${key}`);
    params.push(`thread=${threadId}`);
    window.location.href = `/#${params.join('&')}`;
  }, [threadId, searchParams]);

  return (
    <div className="p-10 font-['Space_Mono'] text-[11px] text-[rgba(45,52,51,0.6)]">
      REDIRECTING_TO_SECURE_FRAGMENT_ROUTE...
    </div>
  );
}
