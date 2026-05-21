"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import { useP2P } from '@/providers/P2PProvider';
import { KeyManager } from '@/lib/crypto/KeyManager';
import { PacketBuilder } from '@/lib/crypto/PacketBuilder';
import { ThreadRanker } from '@/lib/logic/ThreadRanker';
import { useRouter } from 'next/navigation';
import { ThreadMeta, BOARD_META_THREAD_ID } from '@/lib/logic/types';


export function useBoard(boardId: string) {
  const { pm, mailbox, cryptoEng, db, router, identity, powEng, zm, keyMgr, boardOrchestrator, isReady } = useP2P();

  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [status, setStatus] = useState<string>('初期化中...');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [powProgress, setPowProgress] = useState(0);

  const boardKey = useRef<Uint8Array | null>(null);



  // Orchestrator の状態（スレッドリスト、同期ステータス）を購読
  useEffect(() => {
    if (!boardOrchestrator) return;
    const unsubscribeThreads = boardOrchestrator.subscribe(setThreads);
    const unsubscribeStatus = boardOrchestrator.subscribeStatus((s) => {
      setStatus(s.message);
      setIsSubmitting(s.isSubmitting || false);
      setPowProgress(s.powProgress || 0);
    });

    return () => {
      unsubscribeThreads();
      unsubscribeStatus();
    };
  }, [boardOrchestrator]);


  // 板が切り替わった時に状態を完全にリセットする
  useEffect(() => {
    if (boardOrchestrator) boardOrchestrator.clear();
    setThreads([]);
    setStatus('初期化中...');
  }, [boardId, boardOrchestrator]);


  // BoardKey の解決
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



  useEffect(() => {
    if (isReady && boardOrchestrator && boardKey.current) {
        boardOrchestrator.activate(boardId, boardKey.current);
    }
  }, [boardId, boardOrchestrator, isReady]);


  const submitThread = async (title: string, onFail?: (m:string)=>void) => {
    if (!boardOrchestrator || !boardKey.current) return;

    const threadId = await boardOrchestrator.submitThread(boardId, boardKey.current, title);
    
    if (threadId) {
      const keyB64 = KeyManager.toBase64(boardKey.current);
      // 成功時のみ画面遷移を行う
      window.location.hash = `#board=${boardId}&thread=${threadId}&key=${keyB64}`;
    } else {
      if (onFail) onFail('スレッドの作成に失敗しました');
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
