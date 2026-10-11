import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import {
  AetherNode,
  type BoardOrchestrator,
  type ThreadOrchestrator,
  type Identity,
  type PeerManager,
  createLogger,
} from '@aether/core';

const log = createLogger('ui.p2p');

interface P2PContextType {
  node: AetherNode | null;
  boardOrchestrator: BoardOrchestrator | null;
  threadOrchestrator: ThreadOrchestrator | null;
  pm: PeerManager | null;
  identity: Identity | null;
  isReady: boolean;
}

export const P2PContext = createContext<P2PContextType>({
  node: null,
  boardOrchestrator: null,
  threadOrchestrator: null,
  pm: null,
  identity: null,
  isReady: false,
});

export const P2PContextForTest = P2PContext;
export const useP2P = () => useContext(P2PContext);

export function P2PProvider({ children }: { children: React.ReactNode }) {
  const [node, setNode] = useState<AetherNode | null>(null);
  const [isReady, setIsReady] = useState(false);
  const initializingRef = useRef(false);

  useEffect(() => {
    if (initializingRef.current) return;
    initializingRef.current = true;

    async function initNode() {
      try {
        log.info(() => 'Initializing Desktop AetherNode...');
        const aether = await AetherNode.create({
          releaseMode: 'adaptive',
          autoStart: true,
        });

        setNode(aether);
        setIsReady(true);
        log.info(() => `Desktop AetherNode ready! PeerId: ${aether.peerId}`);

        // デバッグ用グローバル露出
        (window as any).aetherNode = aether;
      } catch (err) {
        log.error('Failed to initialize Desktop AetherNode', err);
      }
    }

    initNode();

    return () => {
      // クリーンアップ
      node?.stop().catch((e) => log.warn('Error stopping node', e));
    };
  }, []);

  return (
    <P2PContext.Provider
      value={{
        node,
        boardOrchestrator: node?.boardOrchestrator || null,
        threadOrchestrator: node?.threadOrchestrator || null,
        pm: node?.peerManager || null,
        identity: node?.identity || null,
        isReady,
      }}
    >
      {children}
    </P2PContext.Provider>
  );
}
