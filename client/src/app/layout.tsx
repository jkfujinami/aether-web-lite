'use client';

import './globals.css';
import { AetherProvider, useAether } from '@/context/AetherContext';
import { MetadataPanelProvider } from '@/context/MetadataPanelContext';
import { AetherHeader } from '@/components/AetherHeader';
import { MetadataPanel } from '@/components/MetadataPanel';
import { useBoardRegistry, isDefaultBoard } from '@/hooks/useBoardRegistry';
import { useHashParams, navigateWithHash } from '@/hooks/useHashParams';
import { Suspense } from 'react';
import { useRouter } from 'next/navigation';

function LeftNavSidebar() {
  const { identity, peerCount, isReady } = useAether();
  const { boards } = useBoardRegistry();
  const hashParams = useHashParams();
  const router = useRouter();
  const activeBoardId = hashParams.get('board') || 'vip';

  const handleNavigate = (boardId: string, keyB64: string) => {
    if (isDefaultBoard(boardId)) {
      navigateWithHash('/', { board: boardId }, router);
    } else {
      navigateWithHash('/', { board: boardId, key: keyB64 }, router);
    }
  };

  return (
    <aside className="fixed left-0 top-12 bottom-0 w-64 bg-[#F2F4F3] border-r-[0.5px] border-[rgba(173,179,178,0.15)] z-40 flex flex-col font-['Space_Grotesk']">
      {/* Node Identity */}
      <div className="p-6 border-b-[0.5px] border-[rgba(173,179,178,0.15)]">
        <div className="flex flex-col gap-1">
          <div className="font-['Space_Mono'] text-[9px] text-[rgba(45,52,51,0.4)] uppercase tracking-[0.2em] mb-1">Authenticated_Node</div>
          <div className="font-['Space_Mono'] text-[14px] font-bold tracking-tight text-[#2D3433] truncate">
            {identity?.tripDisplay || 'ANONYMOUS_NODE'}
          </div>
          <div className="font-['Space_Mono'] text-[9px] flex items-center gap-1 mt-1">
            <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${isReady ? 'bg-[#66bb6a]' : 'bg-[#f44336]'}`}></span>
            <span className={isReady ? 'text-[#66bb6a]' : 'text-[#f44336]'}>{isReady ? 'SYNCHRONIZED' : 'BOOTSTRAPPING'}</span>
          </div>
        </div>
      </div>

      {/* Board Registry */}
      <nav className="flex-1 py-4 flex flex-col gap-0.5 overflow-y-auto">
        <div className="px-6 mb-2 text-[9px] font-['Space_Mono'] text-[rgba(45,52,51,0.4)] uppercase tracking-[0.2em]">Standard_Zones</div>
        
        {boards.filter(b => b.isDefault).map((board) => {
          const isActive = activeBoardId === board.boardId;
          return (
            <button
              key={board.boardId}
              onClick={() => handleNavigate(board.boardId, board.keyB64)}
              className={`flex items-center justify-between px-6 py-2.5 text-left font-['Space_Mono'] text-[11px] uppercase tracking-widest transition-all ${
                isActive
                  ? 'text-[#4A90E2] bg-[#F9F9F8] border-l-2 border-[#4A90E2]'
                  : 'text-[rgba(45,52,51,0.6)] hover:text-[#4A90E2] hover:bg-[#F9F9F8] border-l-2 border-transparent'
              }`}
            >
              <span className="truncate max-w-[160px]">/{board.label}/</span>
            </button>
          );
        })}

        {boards.some(b => !b.isDefault) && (
          <>
            <div className="px-6 mt-4 mb-2 text-[9px] font-['Space_Mono'] text-[rgba(45,52,51,0.4)] uppercase tracking-[0.2em]">Private_Zones</div>
            {boards.filter(b => !b.isDefault).map((board) => {
              const isActive = activeBoardId === board.boardId;
              return (
                <button
                  key={board.boardId}
                  onClick={() => handleNavigate(board.boardId, board.keyB64)}
                  className={`flex items-center justify-between px-6 py-2.5 text-left font-['Space_Mono'] text-[11px] uppercase tracking-widest transition-all ${
                    isActive
                      ? 'text-[#4A90E2] bg-[#F9F9F8] border-l-2 border-[#4A90E2]'
                      : 'text-[rgba(45,52,51,0.6)] hover:text-[#4A90E2] hover:bg-[#F9F9F8] border-l-2 border-transparent'
                  }`}
                >
                  <span className="truncate max-w-[160px]">/{board.label}/</span>
                  <span className="text-[8px] text-[rgba(45,52,51,0.3)]">🔒</span>
                </button>
              );
            })}
          </>
        )}
      </nav>

      {/* Footer */}
      <div className="mt-auto p-6 border-t-[0.5px] border-[rgba(173,179,178,0.15)]">
        <div className="flex flex-col gap-3">
           <div className="font-['Space_Mono'] text-[9px] text-[rgba(45,52,51,0.6)] flex justify-between">
              <span>PEER_DEGREE</span>
              <span className="font-bold text-[#66bb6a]">{peerCount}</span>
           </div>
           <div className="h-[1px] bg-[rgba(173,179,178,0.15)] w-full overflow-hidden">
             <div className="h-full bg-[#4A90E2] transition-all" style={{ width: isReady ? '100%' : '30%' }}></div>
           </div>
           <div className="text-[8px] font-['Space_Mono'] text-[rgba(45,52,51,0.4)] uppercase tracking-wider">
             Protocol: Aether_Lite_v1.7
           </div>
        </div>
      </div>
    </aside>
  );
}

function InnerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col overflow-x-hidden">
      <Suspense fallback={null}>
        <AetherHeader />
      </Suspense>
      <div className="flex flex-1">
        <Suspense fallback={null}>
          <LeftNavSidebar />
        </Suspense>
        <main className="flex-1 ml-64 mt-12 mb-32 min-h-screen flex">
          <Suspense fallback={<div className="p-10 font-['Space_Mono'] text-[11px]">INITIALIZING_FLOW...</div>}>
            {children}
          </Suspense>
        </main>
      </div>
      <Suspense fallback={null}>
        <MetadataPanel />
      </Suspense>
    </div>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="antialiased bg-[#F9F9F8] text-[#2D3433] selection:bg-[rgba(74,144,226,0.1)] selection:text-[#4A90E2]">
        <AetherProvider>
          <MetadataPanelProvider>
            <InnerLayout>{children}</InnerLayout>
          </MetadataPanelProvider>
        </AetherProvider>
      </body>
    </html>
  );
}
