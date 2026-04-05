"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import { useP2P } from '@/providers/P2PProvider';
import { KeyManager } from '@/lib/crypto/KeyManager';
import { PacketBuilder } from '@/lib/crypto/PacketBuilder';
import { ThreadRanker } from '@/lib/logic/ThreadRanker';
import { useRouter } from 'next/navigation';

export interface ThreadMeta {
  thread_id: string;
  packet_id: string;
  content: string;
  created_at: number;
  max_pow: number;
  [key: string]: any;
}

export function useBoard(boardId: string) {
  const { pm, mailbox, cryptoEng, db, router, identity, powEng, zm, keyMgr, isReady } = useP2P();

  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [status, setStatus] = useState<string>('初期化中...');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [powProgress, setPowProgress] = useState(0);

  const seenPacketIds = useRef(new Set<string>());
  const boardKey = useRef<Uint8Array | null>(null);

  const lastRefreshTime = useRef(0);
  const refreshTimer = useRef<any>(null);

  // 板が切り替わった時に状態を完全にリセットする
  useEffect(() => {
    setThreads([]);
    setStatus('初期化中...');
    seenPacketIds.current.clear();
  }, [boardId]);

  // BoardKey の解決 (フロントエンドでの安全な参照のため window.location.hash から抽出)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const hashParams = new URLSearchParams(window.location.hash.substring(1));
      const base64Key = hashParams.get('key');

      if (base64Key) {
        boardKey.current = KeyManager.fromBase64(base64Key);
      } else if (boardId === 'vip') {
        boardKey.current = KeyManager.cryptoHash(new TextEncoder().encode('AETHER_LITE_VIP_DEFAULT_SEED')).slice(0, 32);
      }
    }
  }, [boardId]);

  const handlePacketObject = useCallback(async (packet: any, isFromDB: boolean, rawData?: Uint8Array) => {
    if (!boardKey.current || !cryptoEng || !db) return;

    try {
      if (seenPacketIds.current.has(packet.packet_id)) return;
      seenPacketIds.current.add(packet.packet_id);

      const meta = await PacketBuilder.verifyAndDecrypt(packet, boardKey.current, cryptoEng);
      if (meta && meta.post_type === 1) { 
        let max_pow = Number(meta.cumulative_pow || 0);
        // created_at を安全に数値化。無効値なら Date.now() にフォールバック
        const rawCreatedAt = Number(meta.created_at);
        const created_at = (isFinite(rawCreatedAt) && rawCreatedAt > 0) ? rawCreatedAt : Date.now();
        
        if (db) {
          const stats = await db.getThreads(boardId).then((list: any[]) => list.find(s => s.threadId === meta.thread_id));
          if (stats) {
            max_pow = Math.max(max_pow, stats.max_pow || 0);
          }
        }

        console.log(`[useBoard] Thread ${meta.thread_id.substring(0,8)}: max_pow=${max_pow}, created_at=${created_at}, content="${(meta.content || '').substring(0,20)}"`);

        setThreads(prev => {
          const existingIndex = prev.findIndex(t => t.thread_id === meta.thread_id);
          if (existingIndex !== -1) {
            const existing = prev[existingIndex];
            // 既存スレの max_pow と created_at の両方を修復的にマージ
            const mergedPow = Math.max(existing.max_pow || 0, max_pow);
            // created_at: 既存値が壊れていたらパケットの値で上書き
            const mergedCreatedAt = (isFinite(existing.created_at) && existing.created_at > 0) 
              ? existing.created_at 
              : created_at;
            if (mergedPow === existing.max_pow && mergedCreatedAt === existing.created_at) return prev;
            const next = [...prev];
            next[existingIndex] = { ...existing, max_pow: mergedPow, created_at: mergedCreatedAt };
            return next;
          }
          return [...prev, {
            ...meta,
            packet_id: packet.packet_id,
            max_pow,
            created_at
          }];
        });

        if (!isFromDB && db) {
          const dataToSave = rawData || new TextEncoder().encode(JSON.stringify(packet, (_k, v) => {
            if (v instanceof Uint8Array) return { _type: 'Uint8Array', data: Array.from(v) };
            return v;
          }));
          await db.save({
            boardId: boardId,
            threadId: '__board_meta__',
            payload: dataToSave,
            dag: {
              parents: meta.parents || [],
              cumulative_pow: meta.cumulative_pow || 0,
              thread_root: meta.thread_id,
              created_at: meta.created_at
            }
          }).catch(() => {});
        }
      }
    } catch (e) {
      // 復号失敗や検証失敗は無視
    }
  }, [boardId, cryptoEng, db]);

  const handleRawPacket = useCallback(async (rawPacket: Uint8Array, isFromDB: boolean) => {
    try {
      const packet = JSON.parse(new TextDecoder().decode(rawPacket), (_k, v) => {
        if (v && v._type === 'Uint8Array') return new Uint8Array(v.data);
        return v;
      });
      await handlePacketObject(packet, isFromDB, rawPacket);
    } catch (e) {}
  }, [handlePacketObject]);

  const refresh = useCallback(async () => {
    if (!pm || !mailbox || !boardKey.current) return;

    try {
      if (pm.degree === 0) {
        setStatus('隣人を探しています (接続中)...');
        return;
      }

      setStatus(`${pm.degree}人の隣人から最新のスレッドを取得中...`);
      const boardTopicHash = KeyManager.toHex(KeyManager.cryptoHash(boardKey.current));
      const entries = await mailbox.fetch(boardTopicHash);
      
      for (const entry of entries) {
        try {
          await handleRawPacket((entry as any).payload || entry, false);
        } catch (e) { }
      }

      setThreads(current => {
        if (current.length === 0) setStatus('スレッドが見つかりませんでした。一番乗りで立ててみませんか？');
        else setStatus('');
        return current;
      });
    } catch (err) {
      console.error('[useBoard] Remote fetch error:', err);
      setStatus('最新スレッドの取得に失敗しました');
    }
  }, [pm, mailbox, handleRawPacket]);

  const debouncedRefresh = useCallback(() => {
    const REFRESH_INTERVAL = 3000;
    if (refreshTimer.current) return;

    const now = Date.now();
    const timeSinceLast = now - lastRefreshTime.current;
    const delay = Math.max(500, REFRESH_INTERVAL - timeSinceLast);
    
    refreshTimer.current = setTimeout(async () => {
      refreshTimer.current = null;
      lastRefreshTime.current = Date.now();
      await refresh();
    }, delay);
  }, [refresh]);

  useEffect(() => {
    if (!isReady || !db || !router || !pm) return;
    if (!boardKey.current) {
      setStatus('板の鍵がありません。URLを確認してください。');
      return;
    }

    let isMounted = true;

    // 1. ローカルキャッシュの復元
    const loadFromDB = async () => {
      if (!db) return;
      const rawEntries = await db.getPosts(boardId, '__board_meta__').catch(() => []);
      if (rawEntries.length === 0) return;
      for (const entry of rawEntries) {
        if (!isMounted) break;
        await handleRawPacket(entry.payload, true);
      }
    };

    loadFromDB().then(() => {
      if (!isMounted) return;
      // 2. 最初の問い合わせ
      refresh();
    });

    // 3. 隣人が増えた時の再検索
    const onConnect = () => debouncedRefresh();
    pm.on('peer:connect', onConnect);

    // 4. リアルタイムゴシップ購読
    const packetHandler = async (packet: any) => {
      if (!isMounted) return;
      await handlePacketObject(packet, false);
    };
    
    // router.onMessage は内部で push(cb) しているはず（旧実装依存）
    // 完全に安全に外す手段がない場合を考慮し isMounted でガード
    router.onMessage(packetHandler);

    // 5. 定期的なDB統計の同期 (max_pow と created_at の両方を拾う)
    const statsTimer = setInterval(async () => {
      if (!isMounted || !db) return;
      const allStats = await db.getThreads(boardId).catch(() => []);
      if (allStats.length === 0) return;

      setThreads(prev => {
        let changed = false;
        const next = prev.map(t => {
          const s = allStats.find((item: any) => item.threadId === t.thread_id);
          if (!s) return t;
          const newPow = Math.max(s.max_pow || 0, t.max_pow || 0);
          // created_at も壊れていたらDBから修復
          const currentCreatedAt = (isFinite(t.created_at) && t.created_at > 0) ? t.created_at : 0;
          const dbCreatedAt = (isFinite(s.created_at) && s.created_at > 0) ? s.created_at : 0;
          const bestCreatedAt = currentCreatedAt > 0 ? currentCreatedAt : (dbCreatedAt > 0 ? dbCreatedAt : Date.now());
          if (newPow !== t.max_pow || bestCreatedAt !== t.created_at) {
            changed = true;
            return { ...t, max_pow: newPow, created_at: bestCreatedAt };
          }
          return t;
        });
        return changed ? next : prev;
      });
    }, 5000);

    return () => {
      isMounted = false;
      clearInterval(statsTimer);
      // pmには off や removeListener がある想定
      if (typeof (pm as any).removeListener === 'function') (pm as any).removeListener('peer:connect', onConnect);
    };
  }, [isReady, boardId, db, router, pm, handleRawPacket, refresh, debouncedRefresh, handlePacketObject]);

  const submitThread = async (title: string, onFail?: (m:string)=>void) => {
    if (!title || !boardKey.current || !powEng || !identity || !cryptoEng || !keyMgr || !zm || !router || !mailbox || !db) return;

    setIsSubmitting(true);
    setPowProgress(30);

    try {
      const threadId = Math.random().toString(36).substring(2, 12);
      const threadKey = KeyManager.deriveThreadKey(boardKey.current, threadId);
      const threadTopicHash = KeyManager.deriveTopicHash(threadKey);
      const currentZoneId = KeyManager.computeZoneId(threadTopicHash, zm.depth);
      
      const packet = await PacketBuilder.build(
        title, boardKey.current, identity, cryptoEng,
        powEng, keyMgr, boardId, threadId,
        0, null, 10, currentZoneId, 1, 
        [], threadId, 10 // Initial Heat (cumulative_pow) is 10
      );

      setPowProgress(100);

      await router.broadcast(packet);

      const boardB64TopicHash = KeyManager.toHex(KeyManager.cryptoHash(boardKey.current));
      const rawPacketData = new TextEncoder().encode(JSON.stringify(packet, (_k, v) => {
          if (v instanceof Uint8Array) return { _type: 'Uint8Array', data: Array.from(v) };
          return v;
      }));
      
      mailbox.publish(boardB64TopicHash, rawPacketData).catch((e: any) => console.error(e));
      
      await db.save({ 
        boardId: boardId, 
        threadId: '__board_meta__', 
        payload: rawPacketData,
        dag: {
            parents: [],
            cumulative_pow: 10, // スレ立て時の基本難易度を初期Heatとして刻む
            thread_root: threadId,
            created_at: Date.now()
        }
      }).catch(() => {});
      
      const keyB64 = KeyManager.toBase64(boardKey.current);
      // 機密情報をサーバーに送らないためSPAのハッシュを用いる
      window.location.hash = `#board=${boardId}&thread=${threadId}&key=${keyB64}`;
    } catch (err: any) {
      if (onFail) onFail(err.toString());
    } finally {
      setIsSubmitting(false);
      setPowProgress(0);
    }
  };

  const sortedThreads = [...threads].sort((a, b) => {
    const scoreA = ThreadRanker.calculateScore(a.max_pow || 0, a.created_at);
    const scoreB = ThreadRanker.calculateScore(b.max_pow || 0, b.created_at);
    return scoreB - scoreA;
  });

  return {
    threads: sortedThreads,
    status,
    isSubmitting,
    powProgress,
    submitThread,
    boardKeyBase64: boardKey.current ? KeyManager.toBase64(boardKey.current) : null
  };
}
