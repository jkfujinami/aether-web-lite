import { useState, useEffect } from 'react';
import { P2PProvider } from './providers/P2PProvider';
import { AppHeader } from './components/AppHeader';
import BoardView from './components/BoardView';
import ThreadView from './components/ThreadView';

function RouterView() {
  const [route, setRoute] = useState<{ boardId: string; threadId?: string; key?: string }>({ boardId: 'vip' });

  useEffect(() => {
    const parseHash = () => {
      const hash = window.location.hash;
      if (!hash || hash === '#') {
        window.location.hash = '#board=vip';
        return;
      }

      const params = new URLSearchParams(hash.substring(1));
      const boardId = params.get('board') || 'vip';
      const threadId = params.get('thread') || undefined;
      const key = params.get('key') || undefined;

      setRoute({ boardId, threadId, key });
    };

    window.addEventListener('hashchange', parseHash);
    parseHash();

    return () => window.removeEventListener('hashchange', parseHash);
  }, []);

  return (
    <div id="app">
      <AppHeader />
      <main>
        {route.threadId ? (
          <ThreadView boardId={route.boardId} threadId={route.threadId} boardKeyBase64={route.key} />
        ) : (
          <BoardView boardId={route.boardId} boardKeyBase64={route.key} />
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <P2PProvider>
      <RouterView />
    </P2PProvider>
  );
}
