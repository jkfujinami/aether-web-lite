'use client';

import { useAether } from '@/context/AetherContext';
import { ThreadRanker } from '@/lib/aether/logic/ThreadRanker';
import { KeyManager } from '@/lib/aether/crypto/KeyManager';
import { PacketBuilder } from '@/lib/aether/crypto/PacketBuilder';
import { useHashParams, navigateWithHash } from '@/hooks/useHashParams';
import { isDefaultBoard, getDefaultBoardSeed } from '@/hooks/useBoardRegistry';
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { CreateThreadModal } from '@/components/CreateThreadModal';
import { ThreadView } from '@/components/ThreadView';

interface Thread {
  thread_id: string;
  content: string;
  created_at: number;
  max_pow: number;
  packet_id: string;
}

// ─── SPA Router: hash の "thread" パラメータで表示を切り替え ───
export default function AppRouter() {
  const hashParams = useHashParams();
  const threadId = hashParams.get('thread');
  const boardId = hashParams.get('board') || 'vip';
  const keyB64 = hashParams.get('key');

  // thread= があればスレッド詳細、なければ板一覧
  if (threadId) {
    return <ThreadView threadId={threadId} boardId={boardId} boardKeyB64={keyB64} />;
  }

  return <BoardView boardId={boardId} keyB64={keyB64} />;
}

// ─── Board View (スレッド一覧) ───
function BoardView({ boardId, keyB64 }: { boardId: string; keyB64: string | null }) {
  const { isReady, peerManager, mailbox, cryptoEngine, db, router: p2pRouter, peerCount } = useAether();

  const [mounted, setMounted] = useState(false);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [status, setStatus] = useState('Archive Initializing...');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const seenPacketIds = useRef(new Set<string>());

  useEffect(() => { setMounted(true); }, []);

  // Reset state when boardId changes
  useEffect(() => {
    setThreads([]);
    setStatus('Archive Initializing...');
    seenPacketIds.current.clear();
  }, [boardId]);

  const boardKey = useMemo(() => {
    if (!mounted) return null;
    if (keyB64) {
      try { return KeyManager.fromBase64(keyB64); } catch (e) { return null; }
    }
    // Well-known default boards use deterministic seeds
    if (isDefaultBoard(boardId)) {
      return KeyManager.cryptoHash(new TextEncoder().encode(getDefaultBoardSeed(boardId))).slice(0, 32);
    }
    return null;
  }, [mounted, boardId, keyB64]);

  const handlePacketObject = useCallback(async (packet: any, isFromDB: boolean) => {
    if (!boardKey || !cryptoEngine || !db) return;
    if (seenPacketIds.current.has(packet.packet_id)) return;
    seenPacketIds.current.add(packet.packet_id);

    try {
      const meta = await PacketBuilder.verifyAndDecrypt(packet, boardKey, cryptoEngine);
      if (meta && meta.post_type === 1) {
        const newPow = packet.cumulative_pow || 0;
        setThreads(prev => {
          const existingIdx = prev.findIndex(t => t.thread_id === meta.thread_id);
          if (existingIdx >= 0) {
            // Thread exists — update WEIGHT if new packet has higher PoW
            if (newPow > prev[existingIdx].max_pow) {
              const updated = [...prev];
              updated[existingIdx] = { ...updated[existingIdx], max_pow: newPow };
              return updated;
            }
            return prev; // no update needed
          }
          // New thread
          return [...prev, {
            thread_id: meta.thread_id,
            content: meta.content,
            created_at: meta.created_at,
            max_pow: newPow,
            packet_id: packet.packet_id
          }];
        });

        if (!isFromDB) {
          const raw = new TextEncoder().encode(JSON.stringify(packet, (_k, v) => (v instanceof Uint8Array ? { _type: 'Uint8Array', data: Array.from(v) } : v)));
          await db.save({ boardId, threadId: '__board_meta__', payload: raw, dag: { thread_root: meta.thread_id, cumulative_pow: newPow } });
        }
      }
    } catch (e) {}
  }, [boardKey, cryptoEngine, db, boardId]);

  const refresh = useCallback(async () => {
    if (!db || !mailbox || !boardKey || !peerManager || !mounted) return;
    if (peerManager.degree === 0) {
      setStatus('Waiting for Network Node Discovery...');
      return;
    }
    setStatus(`Synchronized: ${peerManager.degree} nodes`);
    const boardTopicHash = KeyManager.toHex(KeyManager.cryptoHash(boardKey));
    const entries = await mailbox.fetch(boardTopicHash).catch(() => []);
    for (const entry of entries) {
      try {
        const payload = (entry as any).payload || entry;
        const packet = JSON.parse(new TextDecoder().decode(payload), (_k, v) => (v?._type==='Uint8Array' ? new Uint8Array(v.data):v));
        await handlePacketObject(packet, false);
      } catch (e) {}
    }
  }, [db, mailbox, boardKey, peerManager, handlePacketObject, mounted]);

  useEffect(() => {
    if (!isReady || !boardKey || !db || !mounted) return;
    async function init() {
      const rawEntries = await db!.getPosts(boardId, '__board_meta__').catch(() => []);
      for (const entry of rawEntries) {
        try {
          const packet = JSON.parse(new TextDecoder().decode(entry.payload), (_k, v) => (v?._type==='Uint8Array' ? new Uint8Array(v.data):v));
          await handlePacketObject(packet, true);
        } catch (e) {}
      }
      await refresh();
    }
    init();
  }, [isReady, boardKey, db, mounted, boardId, handlePacketObject, refresh]);

  // Reactive refresh: subscribe to peer:connect event with debounce
  // (same pattern as client-backup — no polling needed)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRefreshTimeRef = useRef(0);
  useEffect(() => {
    if (!isReady || !peerManager || !mounted) return;
    const REFRESH_INTERVAL = 3000;
    const handler = () => {
      if (refreshTimerRef.current) return; // already scheduled
      const timeSinceLast = Date.now() - lastRefreshTimeRef.current;
      const delay = Math.max(500, REFRESH_INTERVAL - timeSinceLast);
      refreshTimerRef.current = setTimeout(async () => {
        refreshTimerRef.current = null;
        lastRefreshTimeRef.current = Date.now();
        await refresh();
      }, delay);
    };
    peerManager.on('peer:connect', handler);
    return () => {
      peerManager.off('peer:connect', handler);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [isReady, peerManager, mounted, refresh]);

  // Direct gossip subscription
  useEffect(() => {
    if (!isReady || !p2pRouter) return;
    const unsubscribe = p2pRouter.onMessage(async (packet: any) => handlePacketObject(packet, false));
    return () => { if (typeof unsubscribe === 'function') unsubscribe(); };
  }, [isReady, p2pRouter, handlePacketObject]);

  const sortedThreads = useMemo(() => ThreadRanker.sortThreadsByScore(threads), [threads]);

  if (!boardKey) return <div className="p-10 font-['Space_Mono'] text-[11px] text-center w-full">Forbidden. Archive Key Missing.</div>;

  return (
    <div className="flex-1 flex flex-col w-full font-['Space_Grotesk']">
      
      {/* Main Content (Full Width) */}
      <div className="flex-1 flex flex-col">
        <div className="p-10 border-b-[0.5px] border-[rgba(173,179,178,0.15)] bg-[#F2F4F3]/30">
          <div className="font-['Space_Mono'] text-[9px] text-[rgba(45,52,51,0.6)] uppercase tracking-[0.2em] mb-4">
            ROOT / <span className="text-[#4A90E2]">{boardId.toUpperCase()}</span>
          </div>
          <h1 className="text-[36.6px] font-bold tracking-tighter leading-[1.1] mb-6">
            ZONE_ARCHIVE: <br/>
            <span className="text-[#4A90E2]">{boardId}</span>
          </h1>
          <div className="flex flex-wrap gap-10 font-['Space_Mono'] text-[9px] text-[rgba(45,52,51,0.6)]">
            <span className="flex items-center gap-1">HASH: {boardId.substring(0, 8)}</span>
            <span className="flex items-center gap-1">CAPACITY: {threads.length} ITEMS</span>
          </div>
        </div>

        <div className="p-10 flex flex-col">
          {threads.length === 0 && (
            <div className="text-[11px] font-['Space_Mono'] text-[rgba(45,52,51,0.6)] py-6">{status}</div>
          )}
          
          {sortedThreads.map((thread) => {
            const score = ThreadRanker.calculateScore(thread.max_pow || 0, thread.created_at);

            return (
              <div 
                key={thread.thread_id}
                className="py-6 border-b-[0.5px] border-[rgba(173,179,178,0.15)] cursor-pointer hover:bg-[#F2F4F3] transition-colors flex justify-between items-start group"
                onClick={() => {
                  const params: Record<string, string> = { board: boardId, thread: thread.thread_id, key: KeyManager.toBase64(boardKey) };
                  navigateWithHash('/', params);
                }}
              >
                <div className="flex-1">
                  <h3 className="text-[14px] font-[500] text-[#2D3433] leading-[1.618] mb-1 group-hover:text-[#4A90E2] transition-colors">{thread.content}</h3>
                  <div className="font-['Space_Mono'] text-[9px] text-[rgba(45,52,51,0.6)] uppercase flex gap-10">
                    <span>ID: {thread.thread_id.substring(0, 16).toUpperCase()}</span>
                    <span>LOG: {new Date(thread.created_at).toISOString()}</span>
                  </div>
                </div>
                <div className="text-right min-w-[80px]">
                  <div className="text-[22.6px] font-bold text-[#4A90E2] leading-none">{score > 0.1 ? score.toFixed(1) : '0.1'}</div>
                  <div className="text-[9px] font-['Space_Mono'] text-[rgba(45,52,51,0.6)] tracking-widest mt-1">WEIGHT</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bottom Footer Fixed */}
      <footer className="fixed bottom-0 left-64 right-0 z-50 bg-[#F9F9F8]/90 backdrop-blur-xl border-t-[0.5px] border-[rgba(173,179,178,0.15)]">
        <div className="max-w-[1000px] mx-auto px-6 py-4 flex flex-col md:flex-row gap-4 items-center">
          <div 
            className="flex-1 w-full bg-[#F2F4F3] border-[0.5px] border-[rgba(173,179,178,0.15)] rounded-[2px] px-4 py-2 flex items-center gap-3 cursor-pointer hover:bg-white transition-all"
            onClick={() => setIsModalOpen(true)}
          >
            <span className="font-['Space_Mono'] text-[9px] text-[#4A90E2] font-bold">INITIALIZE_THREAD_MODE:</span>
            <span className="text-[14px] text-[rgba(45,52,51,0.3)]">Enter protocol metadata for new thread...</span>
          </div>
          <button 
            className="w-full md:w-auto px-10 py-3 bg-[#2D3433] text-white font-['Space_Mono'] text-[9px] font-bold tracking-widest uppercase hover:bg-[#4A90E2] transition-all flex items-center justify-center gap-2 rounded-[2px]"
            onClick={() => setIsModalOpen(true)}
          >
            SIGN_&_POST
          </button>
        </div>
        <div className="px-6 py-1 border-t-[0.5px] border-[rgba(173,179,178,0.15)] bg-[#F2F4F3]/50 flex justify-between items-center text-[8px] font-['Space_Mono'] uppercase text-[rgba(45,52,51,0.6)] tracking-widest">
          <div>©2024 HARMONIC_NODE // CLUSTER_X71</div>
          <div className="flex gap-10">
            <span>SYNC_LEVEL: {isReady ? '100%' : 'BUSY'}</span>
            <span className="text-[#4A90E2]">PHASE: SYNCHRONIZED</span>
          </div>
        </div>
      </footer>

      <CreateThreadModal 
        boardId={boardId}
        boardKey={boardKey}
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
      />
    </div>
  );
}
