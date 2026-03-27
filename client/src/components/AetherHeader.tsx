'use client';

import { KeyManager } from '@/lib/aether/crypto/KeyManager';
import { useBoardRegistry } from '@/hooks/useBoardRegistry';
import { useHashParams, navigateWithHash } from '@/hooks/useHashParams';
import { useMetadataPanel } from '@/context/MetadataPanelContext';
import { useAether } from '@/context/AetherContext';
import { useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';

export function AetherHeader() {
  const router = useRouter();
  const hashParams = useHashParams();
  const boardId = hashParams.get('board') || 'vip';
  const { registerBoard } = useBoardRegistry();
  const { isOpen, toggle } = useMetadataPanel();
  const { peerCount, isReady } = useAether();
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const handleCreateBoard = () => {
    const newKey = KeyManager.generateBoardKey();
    const newBoardId = Math.random().toString(36).substring(2, 10);
    const keyB64 = KeyManager.toBase64(newKey);
    const label = `ZONE_${newBoardId.substring(0, 6).toUpperCase()}`;

    registerBoard(newBoardId, keyB64, label);
    navigateWithHash('/', { board: newBoardId, key: keyB64 }, router);
  };

  if (!mounted) return <header className="h-12 w-full bg-[#F9F9F8] border-b-[0.5px] border-[rgba(173,179,178,0.15)] flex items-center px-6"></header>;

  return (
    <header className="fixed top-0 left-0 right-0 z-[100] h-12 w-full bg-[#F9F9F8]/80 backdrop-blur-md border-b-[0.5px] border-[rgba(173,179,178,0.15)] flex items-center justify-between px-6 font-['Space_Grotesk']">
      <div className="flex items-center gap-8">
        <div 
          className="text-[14px] font-bold tracking-tighter text-[#2D3433] cursor-pointer uppercase"
          onClick={() => navigateWithHash('/', { board: 'vip' }, router)}
        >
          HARMONIC ARCHIVE
        </div>
        <div className="font-['Space_Mono'] text-[9px] uppercase tracking-widest text-[#4A90E2]">
          /ZONE_{boardId.toUpperCase()}/
        </div>
      </div>

      <div className="flex items-center gap-4">
        {/* Compact network status indicator */}
        <div className="hidden sm:flex items-center gap-3 border-r-[0.5px] border-[rgba(173,179,178,0.15)] pr-4 mr-1">
          <span className={`w-1.5 h-1.5 rounded-full ${isReady ? 'bg-[#66bb6a] animate-pulse' : 'bg-[#f44336]'}`}></span>
          <span className="font-['Space_Mono'] text-[9px] text-[rgba(45,52,51,0.6)]">{peerCount} NODES</span>
        </div>

        <button 
          className="bg-[#4A90E2] text-[#F9F9F8] px-4 py-1.5 font-['Space_Mono'] text-[9px] font-bold tracking-widest uppercase hover:opacity-90 transition-opacity rounded-[2px]"
          onClick={handleCreateBoard}
        >
          INIT_ZONE
        </button>

        {/* Metadata Panel Toggle */}
        <button 
          onClick={toggle}
          className={`px-3 py-1.5 font-['Space_Mono'] text-[9px] font-bold tracking-widest uppercase rounded-[2px] border-[0.5px] transition-all ${
            isOpen 
              ? 'bg-[#2D3433] text-white border-[#2D3433]' 
              : 'bg-transparent text-[rgba(45,52,51,0.6)] border-[rgba(173,179,178,0.15)] hover:text-[#4A90E2] hover:border-[#4A90E2]'
          }`}
        >
          {isOpen ? '✕ METRICS' : '▸ METRICS'}
        </button>
      </div>
    </header>
  );
}
