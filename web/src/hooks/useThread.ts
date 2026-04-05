"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useP2P } from '@/providers/P2PProvider';
import { KeyManager } from '@/lib/crypto/KeyManager';
import { PacketBuilder } from '@/lib/crypto/PacketBuilder';
import { ThreadDAGManager } from '@/lib/logic/ThreadDAGManager';
import type { DAGPost } from '@/lib/logic/ThreadDAGManager';

export function useThread(boardId: string, threadId: string) {
  const { pm, mailbox, cryptoEng, db, syncProtocol, router, identity, powEng, keyMgr, zm, isReady } = useP2P();
  
  const [posts, setPosts] = useState<DAGPost[]>([]);
  const [status, setStatus] = useState<string>('初期化中...');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [powProgress, setPowProgress] = useState(0);
  const [postStatus, setPostStatus] = useState<string>('');

  const seenPacketIds = useRef(new Set<string>());
  const boardKey = useRef<Uint8Array | null>(null);
  const threadKey = useRef<Uint8Array | null>(null);
  const threadTopicHash = useRef<Uint8Array | null>(null);

  // スレッドが切り替わった時に古いレス状態をリセットする
  useEffect(() => {
    setPosts([]);
    setStatus('初期化中...');
    seenPacketIds.current.clear();
  }, [boardId, threadId]);

  // コンポーネントのライフサイクル外で DAG インスタンスを持つ
  // （React状態とは独立して構造計算するため）
  const dag = useRef(new ThreadDAGManager(threadId));

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const hashParams = new URLSearchParams(window.location.hash.substring(1));
      const base64Key = hashParams.get('key');

      if (base64Key) {
        boardKey.current = KeyManager.fromBase64(base64Key);
      } else if (boardId === 'vip') {
        boardKey.current = KeyManager.cryptoHash(new TextEncoder().encode('AETHER_LITE_VIP_DEFAULT_SEED')).slice(0, 32);
      }
      
      if (boardKey.current) {
        threadKey.current = KeyManager.deriveThreadKey(boardKey.current, threadId);
        threadTopicHash.current = KeyManager.deriveTopicHash(threadKey.current);
      }
    }
  }, [boardId, threadId]);

  const updatePostsFromDAG = useCallback(() => {
    // 描画のためにソート済みリストを State に押し込む
    setPosts(dag.current.getSortedPosts());
  }, []);

  const handleIncomingPacket = useCallback(async (packet: any, isFromDB: boolean) => {
    if (!threadKey.current || !cryptoEng || !db) return;
    if (seenPacketIds.current.has(packet.packet_id)) return;
    
    seenPacketIds.current.add(packet.packet_id);

    try {
      const post = await PacketBuilder.verifyAndDecrypt(packet, threadKey.current, cryptoEng);
      if (post && post.thread_id === threadId && post.post_type === 0) {
        
        const dagPost: DAGPost = {
          ...post,
          packet_id: packet.packet_id,
          parents: post.parents || [],
          cumulative_pow: post.cumulative_pow || 0,
          thread_root: post.thread_root || threadId
        };

        const isNew = dag.current.addPost(dagPost);
        if (isNew) {
          updatePostsFromDAG();
          
          if (!isFromDB) {
              const rawPacketData = new TextEncoder().encode(JSON.stringify(packet, (_k, v) => {
                 if (v instanceof Uint8Array) return { _type: 'Uint8Array', data: Array.from(v) };
                 return v;
              }));
              await db.save({ 
                boardId: boardId, 
                threadId: threadId, 
                payload: rawPacketData,
                dag: {
                  parents: dagPost.parents,
                  cumulative_pow: dagPost.cumulative_pow,
                  thread_root: dagPost.thread_root,
                  created_at: dagPost.created_at
                }
              }).catch(() => {});
          }
        }
      }
    } catch (e) {}
  }, [boardId, threadId, cryptoEng, db, updatePostsFromDAG]);

  const loadFromDB = useCallback(async () => {
    if (!db) return;
    const rawEntries = await db.getPosts(boardId, threadId).catch(() => []);
    for (const entry of rawEntries) {
      try {
        const packet = JSON.parse(new TextDecoder().decode(entry.payload), (_k, v) => {
          if (v && v._type === 'Uint8Array') return new Uint8Array(v.data);
          return v;
        });
        await handleIncomingPacket(packet, true);
      } catch (e) {}
    }
  }, [boardId, threadId, db, handleIncomingPacket]);

  useEffect(() => {
    if (!isReady || !db || !router || !pm || !syncProtocol || !boardKey.current) return;

    let isMounted = true;
    dag.current = new ThreadDAGManager(threadId); // Reset DAG

    setStatus('過去ログを読み込み中...');

    const bootstrapThread = async () => {
      // 1. DBから読み込み (タイムアウト付きで安全に)
      try {
        await Promise.race([
          loadFromDB(),
          new Promise((_, reject) => setTimeout(() => reject('DB_TIMEOUT'), 2000))
        ]);
      } catch (e) {
        console.warn('[useThread] Cache load timed out or failed:', e);
      }
      
      if (!isMounted) return;
      if (dag.current.getCount() === 0) {
         setStatus('隣人を探しています...');
      } else {
         setStatus(''); 
      }

      // 2. ネットワークの安定を待つ
      let isOnline = false;
      if (pm.degree > 0) {
        isOnline = true;
      } else {
        isOnline = await new Promise<boolean>((resolve) => {
          let resolved = false;
          const timer = setTimeout(() => {
            if (!resolved) { resolved = true; resolve(false); }
          }, 10000); // 10秒待機
          const onConn = () => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              if (typeof (pm as any).removeListener === 'function') (pm as any).removeListener('peer:connect', onConn);
              resolve(true);
            }
          };
          pm.on('peer:connect', onConn);
        });
      }

      if (!isMounted) return;

      if (isOnline) {
        setStatus('ピアと同期中 (DHT同期)...');
        // 3. 過去ログ同期依頼
        const recoveredCount = await syncProtocol.syncThread(boardId, threadId, boardKey.current!).catch(() => 0);
        
        if (!isMounted) return;
        if (recoveredCount > 0) {
          await loadFromDB().catch(() => {});
        }
        
        if (dag.current.getCount() === 0) {
          setStatus('レスが1件もありませんでした。あなたが最初の投稿者になりませんか？');
        } else {
          setStatus('');
        }
      } else {
        if (dag.current.getCount() === 0) {
          setStatus('ネット接続待機中... 他の人がレスをすれば自動で反映されます。');
        } else {
          setStatus('');
        }
      }
    };

    bootstrapThread();

    // 4. ゴシップリアルタイム監視
    const packetHandler = async (packet: any) => {
      if (!isMounted) return;
      await handleIncomingPacket(packet, false);
    };
    router.onMessage(packetHandler);

    return () => {
      isMounted = false;
    };
  }, [isReady, boardId, threadId, loadFromDB, handleIncomingPacket, pm, syncProtocol, router, db]);

  const submitReply = async (text: string) => {
    if (!text || !threadKey.current || !powEng || !identity || !cryptoEng || !keyMgr || !zm || !router || !mailbox || !db || !threadTopicHash.current) return;

    setIsSubmitting(true);
    setPowProgress(20);
    setPostStatus('PoW計算中...');

    try {
      const currentZoneId = KeyManager.computeZoneId(threadTopicHash.current, zm.depth);
      
      const tips = dag.current.getTips();
      const currentWeight = dag.current.getMaxCumulativePow();
      const nextWeight = currentWeight + 8; // 基底難易度を加算

      const packet = await PacketBuilder.build(
        text, threadKey.current, identity, cryptoEng,
        powEng, keyMgr, boardId, threadId,
        dag.current.getCount(), null, 8, currentZoneId, 0,
        tips, threadId, nextWeight
      );

      setPowProgress(100);
      setPostStatus('送信完了 (配信待機中...)');

      router.broadcast(packet).catch((err: any) => {
        alert('ゴシップ送信に失敗しました: ' + err);
      });
      
      const globalTopic = KeyManager.toHex(threadTopicHash.current);
      const rawPacketData = new TextEncoder().encode(JSON.stringify(packet, (_k, v) => {
          if (v instanceof Uint8Array) return { _type: 'Uint8Array', data: Array.from(v) };
          return v;
      }));
      
      mailbox.publish(globalTopic, rawPacketData).catch((err: any) => {
        console.warn('[useThread] Mailbox publish failed in background:', err);
      });

      setPowProgress(0);
      setPostStatus('計算完了！送信中...');
      setTimeout(() => setPostStatus(''), 3000);

    } catch (err: any) {
      console.error('Failed to prepare packet:', err);
      setPostStatus('🔴 失敗: ' + err.toString());
    } finally {
      setIsSubmitting(false);
    }
  };

  return {
    posts,
    status,
    isSubmitting,
    powProgress,
    postStatus,
    submitReply
  };
}
