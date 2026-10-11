import { useState, useEffect } from 'react';
import { useP2P } from '@/providers/P2PProvider';
import { KeyManager } from '@aether/core';

export function AppHeader() {
  const { node, identity } = useP2P();
  const [peerCount, setPeerCount] = useState(0);

  useEffect(() => {
    if (!node) return;
    setPeerCount(node.degree);
    const timer = setInterval(() => {
      setPeerCount(node.degree);
    }, 2000);
    return () => clearInterval(timer);
  }, [node]);

  const handleCreatePrivateBoard = () => {
    const newKey = KeyManager.generateBoardKey();
    const newBoardId = Math.random().toString(36).substring(2, 10);
    const keyB64 = KeyManager.toBase64(newKey);
    window.location.hash = `#board=${newBoardId}&key=${encodeURIComponent(keyB64)}`;
  };

  return (
    <header>
      <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
        <a
          href="#board=vip"
          className="nav-logo"
          style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '8px' }}
        >
          <span>AETHER</span>
          <span style={{ fontSize: '10px', background: '#1e293b', color: 'var(--accent)', padding: '2px 6px', borderRadius: '3px', border: '1px solid #334155' }}>
            Desktop Full Node
          </span>
        </a>
        <button
          className="btn"
          onClick={handleCreatePrivateBoard}
          style={{ padding: '3px 10px', fontSize: '11px' }}
        >
          + 秘密の板を作る
        </button>
      </div>

      <div className="nav-stats" style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: peerCount > 0 ? 'var(--success)' : 'var(--text-dim)' }}>
          <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: peerCount > 0 ? 'var(--success)' : '#eab308' }} />
          <span>Peers: {peerCount}</span>
        </div>

        {identity && (
          <div style={{ color: 'var(--text-dim)', fontFamily: 'monospace' }}>
            Trip: <span style={{ color: '#d1a65d' }}>{identity.tripDisplay || '名無し'}</span>
          </div>
        )}
      </div>
    </header>
  );
}
