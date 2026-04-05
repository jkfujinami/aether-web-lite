"use client";

import { useState, useEffect } from "react";
import BoardView from "@/components/BoardView";
import ThreadView from "@/components/ThreadView";

export default function SPAHashRouter() {
  const [route, setRoute] = useState<{ boardId: string; threadId?: string; key?: string }>({ boardId: 'vip' });

  useEffect(() => {
    const parseHash = () => {
      const hash = window.location.hash;
      if (!hash || hash === '#') {
        window.location.hash = '#board=vip';
        return;
      }

      // #board=XXX&thread=YYY&key=ZZZ
      const params = new URLSearchParams(hash.substring(1));
      const boardId = params.get('board') || 'vip';
      const threadId = params.get('thread') || undefined;
      const key = params.get('key') || undefined;

      setRoute({ boardId, threadId, key });
    };

    window.addEventListener('hashchange', parseHash);
    parseHash(); // 初回実行

    return () => window.removeEventListener('hashchange', parseHash);
  }, []);

  if (route.threadId) {
    return <ThreadView boardId={route.boardId} threadId={route.threadId} boardKeyBase64={route.key} />;
  }

  return <BoardView boardId={route.boardId} boardKeyBase64={route.key} />;
}
