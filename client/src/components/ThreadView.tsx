'use client';

import { useAether } from '@/context/AetherContext';
import { KeyManager } from '@/lib/aether/crypto/KeyManager';
import { PacketBuilder } from '@/lib/aether/crypto/PacketBuilder';
import { ThreadDAGManager, DAGPost } from '@/lib/aether/logic/ThreadDAGManager';
import { navigateWithHash } from '@/hooks/useHashParams';
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';

interface ThreadViewProps {
  threadId: string;
  boardId: string;
  boardKeyB64: string | null;
}

export function ThreadView({ threadId, boardId, boardKeyB64 }: ThreadViewProps) {
  const { isReady, peerManager, mailbox, cryptoEngine, identity, db, syncProtocol, router: p2pRouter, zm, powEngine, keyManager } = useAether();

  const [mounted, setMounted] = useState(false);
  const [posts, setPosts] = useState<DAGPost[]>([]);
  const [status, setStatus] = useState('Syncing Archive Logs...');
  const [replyText, setReplyText] = useState('');
  const [isPosting, setIsPosting] = useState(false);
  const [powProgress, setPowProgress] = useState(0);

  useEffect(() => { setMounted(true); }, []);

  const dagRef = useRef<ThreadDAGManager>(new ThreadDAGManager(threadId));
  const seenPacketIds = useRef(new Set<string>());

  useEffect(() => {
    dagRef.current = new ThreadDAGManager(threadId);
    seenPacketIds.current.clear();
    setPosts([]);
    setStatus('Syncing Archive Logs...');
  }, [threadId]);

  const boardKey = useMemo(() => {
    if (!mounted || !boardKeyB64) return null;
    try { return KeyManager.fromBase64(boardKeyB64); } catch (e) { return null; }
  }, [mounted, boardKeyB64]);
  const threadKey = useMemo(() => (boardKey && threadId) ? KeyManager.deriveThreadKey(boardKey, threadId) : null, [boardKey, threadId]);
  const threadTopicHash = useMemo(() => threadKey ? KeyManager.deriveTopicHash(threadKey) : null, [threadKey]);

  const handlePacket = useCallback(async (packet: any, isFromDB: boolean) => {
    if (!threadKey || !cryptoEngine) return;
    if (seenPacketIds.current.has(packet.packet_id)) return;
    seenPacketIds.current.add(packet.packet_id);

    try {
      const post = await PacketBuilder.verifyAndDecrypt(packet, threadKey, cryptoEngine);
      if (post && post.thread_id === threadId && post.post_type === 0) {
        const dagPost: DAGPost = {
          ...post,
          packetId: packet.packet_id,
          parents: post.parents || [],
          cumulativePow: post.cumulative_pow || 0,
          threadRoot: post.thread_root || threadId
        };
        const isNew = dagRef.current.addPost(dagPost);
        if (isNew) {
          setPosts(dagRef.current.getSortedPosts());
          if (!isFromDB && db) {
            const raw = new TextEncoder().encode(JSON.stringify(packet, (_k, v) => (v instanceof Uint8Array ? { _type: 'Uint8Array', data: Array.from(v) } : v)));
            await db.save({ boardId, threadId, payload: raw, dag: { parents: dagPost.parents, cumulative_pow: dagPost.cumulative_pow, thread_root: dagPost.thread_root } });
          }
        }
      }
    } catch (e) {}
  }, [threadKey, cryptoEngine, threadId, db, boardId]);

  const syncContent = useCallback(async () => {
    if (!db || !syncProtocol || !boardKey || !mounted || !threadId) return;
    if (peerManager && peerManager.degree > 0) {
      setStatus(`Synchronizing: ${peerManager.degree} nodes`);
      await syncProtocol.syncThread(boardId, threadId, boardKey).catch(() => {});
      // Sync may have added data to DB, re-read
      const finalEntries = await db.getPosts(boardId, threadId).catch(() => []);
      for (const entry of finalEntries) {
        try {
          const packet = JSON.parse(new TextDecoder().decode(entry.payload), (_k, v) => (v?._type==='Uint8Array' ? new Uint8Array(v.data):v));
          await handlePacket(packet, true);
        } catch (e) {}
      }
      setStatus('Connected');
    }
  }, [db, syncProtocol, boardKey, mounted, threadId, boardId, handlePacket, peerManager]);

  // waitForPeers: バックアップと同じ — ピア接続を待機してから同期開始
  const waitForPeers = useCallback((timeout: number): Promise<boolean> => {
    if (!peerManager) return Promise.resolve(false);
    if (peerManager.degree > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) { resolved = true; resolve(false); }
      }, timeout);
      const handler = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          peerManager.off('peer:connect', handler);
          resolve(true);
        }
      };
      peerManager.on('peer:connect', handler);
    });
  }, [peerManager]);

  // Init sequence: backup と同じ順序
  // 1. ゴシップ購読 (最速) → useEffect[p2pRouter] で処理
  // 2. DBからローカルキャッシュ復元
  // 3. ピア接続待機 (waitForPeers)
  // 4. syncThread でDHT同期
  useEffect(() => {
    if (!isReady || !threadKey || !db || !mounted) return;
    const init = async () => {
      // Step 1: DB から過去ログ復元
      setStatus('Loading local archive...');
      const rawEntries = await db!.getPosts(boardId, threadId).catch(() => []);
      for (const entry of rawEntries) {
        try {
          const packet = JSON.parse(new TextDecoder().decode(entry.payload), (_k, v) => (v?._type==='Uint8Array' ? new Uint8Array(v.data):v));
          await handlePacket(packet, true);
        } catch (e) {}
      }

      // Step 2: ピア接続を待機 (最大10秒)
      const isOnline = await waitForPeers(10000);

      if (isOnline) {
        // Step 3: ネットワーク同期
        await syncContent();
      } else {
        setStatus('Waiting for peers... Gossip will auto-update.');
      }
    };
    init();
  }, [isReady, threadId, boardId, boardKey, threadKey, db, mounted, syncContent, handlePacket, waitForPeers]);

  // Reactive: peer:connect でデバウンス付き再同期 (backup の debouncedRefresh と同等)
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSyncTimeRef = useRef(0);
  useEffect(() => {
    if (!isReady || !peerManager || !mounted) return;
    const SYNC_INTERVAL = 3000;
    const handler = () => {
      if (syncTimerRef.current) return; // already scheduled
      const timeSinceLast = Date.now() - lastSyncTimeRef.current;
      const delay = Math.max(500, SYNC_INTERVAL - timeSinceLast);
      syncTimerRef.current = setTimeout(async () => {
        syncTimerRef.current = null;
        lastSyncTimeRef.current = Date.now();
        await syncContent();
      }, delay);
    };
    peerManager.on('peer:connect', handler);
    return () => {
      peerManager.off('peer:connect', handler);
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, [isReady, peerManager, mounted, syncContent]);

  // 🌟 Direct gossip subscription (最速起動 — backup と同様)
  useEffect(() => {
    if (!isReady || !p2pRouter) return;
    const unsubscribe = p2pRouter.onMessage(async (packet: any) => handlePacket(packet, false));
    return () => { if (typeof unsubscribe === 'function') unsubscribe(); };
  }, [isReady, p2pRouter, handlePacket]);

  const handleSubmit = async () => {
    if (!replyText.trim() || !threadKey || !identity || !cryptoEngine || !powEngine || !keyManager || !zm || !p2pRouter || !mailbox || !threadTopicHash) return;
    setIsPosting(true);
    setPowProgress(30);
    try {
      const currentZoneId = KeyManager.computeZoneId(threadTopicHash, zm.depth);
      const tips = dagRef.current.getTips();
      const currentWeight = dagRef.current.getMaxCumulativePow();
      const nextWeight = currentWeight + 8;
      const packet = await PacketBuilder.build(replyText, threadKey, identity, cryptoEngine, powEngine, keyManager, boardId, threadId, dagRef.current.getCount(), null, 8, zm.depth, 0, tips, threadId, nextWeight);
      setPowProgress(100);
      await p2pRouter.broadcast(packet);
      const raw = new TextEncoder().encode(JSON.stringify(packet, (_k, v) => (v instanceof Uint8Array ? { _type: 'Uint8Array', data: Array.from(v) } : v)));
      mailbox.publish(KeyManager.toHex(threadTopicHash), raw).catch(() => {});
      setReplyText('');
      setTimeout(() => { setIsPosting(false); setPowProgress(0); }, 500);
    } catch (e) { alert('Archival failure: ' + e); setIsPosting(false); }
  };

  const handleBack = () => {
    const params: Record<string, string> = { board: boardId };
    if (boardKeyB64) params.key = boardKeyB64;
    navigateWithHash('/', params);
  };

  const formatContent = (content: string) => {
    const parts = content.split(/(>>\d+)/g);
    return parts.map((part, i) => {
      if (part.match(/^>>\d+$/)) {
        return <span key={i} className="text-[#4A90E2] font-bold">{part}</span>;
      }
      return part;
    });
  };

  if (!boardKey) return <div className="p-10 text-center font-['Space_Mono'] text-[11px] w-full">Forbidden. Archive Key Missing.</div>;

  return (
    <div className="flex-1 flex flex-col w-full font-['Space_Grotesk']">
      
      {/* Main Content (Full Width) */}
      <div className="flex-1 flex flex-col">
        {/* Thread Header */}
        <div className="p-10 border-b-[0.5px] border-[rgba(173,179,178,0.15)] bg-[#F2F4F3]/30">
          <div className="font-['Space_Mono'] text-[9px] text-[rgba(45,52,51,0.6)] uppercase tracking-[0.2em] mb-4 flex justify-between">
            <span>ROOT / {boardId.toUpperCase()} / <span className="text-[#4A90E2]">{threadId.substring(0, 12).toUpperCase()}</span></span>
            <button className="text-[11px] font-bold text-[rgba(45,52,51,0.6)] hover:text-[#4A90E2] uppercase" onClick={handleBack}>← BACK</button>
          </div>
          <h1 className="text-[36.6px] font-bold tracking-tighter leading-[1.1] mb-6">
            STREAM_DATA: <br/>
            <span className="text-[#4A90E2]">{threadId.substring(0, 16)}</span>
          </h1>
          <div className="flex flex-wrap gap-10 font-['Space_Mono'] text-[9px] text-[rgba(45,52,51,0.6)]">
            <span className="flex items-center gap-1">TOTAL_REFS: {posts.length}</span>
            <span className="flex items-center gap-1">THREAD_HASH: {threadId.substring(0, 8)}</span>
          </div>
        </div>

        {/* Posts Feed */}
        <div className="p-10 flex flex-col gap-10 mb-[200px]">
          {posts.map((post, index) => {
            const id = post.session_pubkey ? KeyManager.toBase64(KeyManager.cryptoHash(post.session_pubkey).slice(0, 4)) : '???';
            const trip = post.trip_pubkey ? KeyManager.toBase64(KeyManager.cryptoHash(post.trip_pubkey).slice(0, 5)) : null;

            return (
              <article key={post.packet_id || index} className="relative group">
                <div className="flex justify-between items-center mb-1">
                  <div className="flex items-center gap-3">
                    <span className="text-[#4A90E2] font-bold text-[14px]">#{String(index + 1).padStart(3, '0')}</span>
                    <span className="font-['Space_Mono'] text-[11px] font-bold uppercase">{trip ? `◆${trip}` : '[ANONYMOUS]'}</span>
                    <span className="font-['Space_Mono'] text-[9px] text-[rgba(45,52,51,0.4)] uppercase">IDENT:{id}</span>
                  </div>
                  <span className="font-['Space_Mono'] text-[9px] text-[rgba(45,52,51,0.4)] ml-auto">{new Date(post.created_at).toISOString()}</span>
                </div>
                <div className="text-[14px] text-[#2D3433] leading-[1.618] whitespace-pre-wrap pl-0 border-l-[0.5px] border-transparent transition-colors group-hover:border-[#4A90E2] group-hover:pl-4">
                  {formatContent(post.content)}
                </div>
              </article>
            );
          })}
        </div>
      </div>

      {/* Bottom Footer Fixed (Reply/Compose) */}
      <footer className="fixed bottom-0 left-64 right-0 z-50 bg-[#F9F9F8]/90 backdrop-blur-xl border-t-[0.5px] border-[rgba(173,179,178,0.15)]">
        <div className="max-w-[1000px] mx-auto px-6 py-4 flex flex-col md:flex-row gap-4 items-center">
          <div className="flex-1 w-full bg-[#F2F4F3] border-[0.5px] border-[rgba(173,179,178,0.15)] rounded-[2px] px-4 py-2 flex items-center gap-3">
            <span className="font-['Space_Mono'] text-[9px] text-[#4A90E2] font-bold">REPLY_MODE:</span>
            <input 
              className="flex-1 bg-transparent border-none focus:ring-0 text-[14px] p-0 placeholder:text-[rgba(45,52,51,0.3)] font-['Space_Grotesk']" 
              placeholder="Input protocol response data..."
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              disabled={isPosting}
            />
          </div>
          <button 
            className="w-full md:w-auto px-10 py-3 bg-[#2D3433] text-white font-['Space_Mono'] text-[9px] font-bold tracking-widest uppercase hover:bg-[#4A90E2] transition-all flex items-center justify-center gap-2 rounded-[2px] disabled:opacity-50"
            onClick={handleSubmit}
            disabled={isPosting || !replyText.trim()}
          >
            {isPosting ? 'SIGNING...' : 'SIGN_&_POST'}
          </button>
        </div>
        {isPosting && (
          <div className="fixed bottom-[72px] left-64 right-0 h-[1px] bg-[rgba(173,179,178,0.15)]">
            <div className="h-full bg-[#4A90E2] transition-all" style={{ width: `${powProgress}%` }} />
          </div>
        )}
        <div className="px-6 py-1 border-t-[0.5px] border-[rgba(173,179,178,0.15)] bg-[#F2F4F3]/50 flex justify-between items-center text-[8px] font-['Space_Mono'] uppercase text-[rgba(45,52,51,0.6)] tracking-widest">
          <div>©2024 HARMONIC_NODE // CLUSTER_X71</div>
          <div className="flex gap-10">
            <span>PoW_PROGRESS: {powProgress}%</span>
            <span className="text-[#4A90E2]">PROTOCOL: STABLE</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
