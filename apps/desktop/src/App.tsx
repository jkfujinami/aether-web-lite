import { useState, useEffect } from 'react';
import { P2PProvider, useP2P } from './providers/P2PProvider';
import { AppHeader } from './components/AppHeader';
import { UnlockScreen } from './components/UnlockScreen';
import BoardView from './components/BoardView';
import ThreadView from './components/ThreadView';
import { DEFAULT_BOARD_ID, parseShareCode } from './lib/boardKeys';

export function RouterView() {
  const { db } = useP2P();
  const [route, setRoute] = useState<{ boardId: string; threadId?: string }>({ boardId: DEFAULT_BOARD_ID });

  useEffect(() => {
    const parseHash = () => {
      const hash = window.location.hash;
      if (!hash || hash === '#') {
        window.location.hash = `#board=${DEFAULT_BOARD_ID}`;
        return;
      }

      const params = new URLSearchParams(hash.substring(1));
      const boardId = params.get('board') || DEFAULT_BOARD_ID;
      const threadId = params.get('thread') || undefined;

      // ★ 鍵付きのリンク (#board=..&key=..) は、暗号化 DB に取り込んでから
      //   URL から鍵を消す。鍵を URL に残すと履歴やスクリーンショットに残る。
      if (params.has('key')) {
        const shared = parseShareCode(hash);
        const clean = `#board=${boardId}${threadId ? `&thread=${threadId}` : ''}`;
        window.history.replaceState(null, '', `${window.location.pathname}${clean}`);
        if (shared && db) {
          // 保存が済んでから画面を切り替える (板の鍵の解決が先に走ると「鍵が無い」になる)
          db.saveBoard(shared.boardId, shared.key)
            .catch(() => {})
            .finally(() => setRoute({ boardId, threadId }));
          return;
        }
      }

      setRoute({ boardId, threadId });
    };

    window.addEventListener('hashchange', parseHash);
    parseHash();

    return () => window.removeEventListener('hashchange', parseHash);
  }, [db]);

  return (
    <div id="app">
      <AppHeader />
      <main>
        {route.threadId ? (
          <ThreadView boardId={route.boardId} threadId={route.threadId} />
        ) : (
          <BoardView boardId={route.boardId} />
        )}
      </main>
    </div>
  );
}

/** ロック解除が済むまでは、パスワード画面だけを出す */
function LockGate() {
  const { lockState } = useP2P();
  if (lockState !== 'ready') return <UnlockScreen />;
  return <RouterView />;
}

export default function App() {
  return (
    <P2PProvider>
      <LockGate />
    </P2PProvider>
  );
}
