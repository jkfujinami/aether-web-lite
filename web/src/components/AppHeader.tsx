"use client";

import { useState, useEffect } from 'react';
import { useP2P } from '@/providers/P2PProvider';
import { KeyManager } from '@/lib/crypto/KeyManager';
import { useRouter } from 'next/navigation';

export function AppHeader() {
  const { pm, identity } = useP2P();
  const router = useRouter();
  const [peerCount, setPeerCount] = useState(0);

  useEffect(() => {
    if (!pm) return;
    setPeerCount(pm.degree);
    const timer = setInterval(() => {
      setPeerCount(pm.degree);
    }, 2000);
    return () => clearInterval(timer);
  }, [pm]);

  const handleCreatePrivateBoard = () => {
    const newKey = KeyManager.generateBoardKey();
    const newBoardId = Math.random().toString(36).substring(2, 10);
    const keyB64 = KeyManager.toBase64(newKey);
    window.location.hash = `#board=${newBoardId}&key=${keyB64}`;
  };

  return (
    <header>
      <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
        <div 
          className="nav-logo" 
          style={{ cursor: 'pointer' }} 
          onClick={() => { window.location.hash = '#board=vip'; }}
        >
          AETHER LITE
        </div>
        <button 
          className="btn" 
          onClick={handleCreatePrivateBoard}
          style={{ padding: '2px 10px', fontSize: '11px' }}
        >
          秘密の板を作る
        </button>
      </div>
      <div className="nav-stats">
        <div className="stat-item" style={{ color: 'var(--success)' }}>
          Peers: {peerCount}
        </div>
        <div className="stat-item" style={{ color: 'var(--warning)', fontFamily: 'monospace' }}>
          {identity?.tripDisplay || '名無し'}
        </div>
      </div>
    </header>
  );
}
