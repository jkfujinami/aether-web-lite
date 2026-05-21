"use client";

import { useState, useEffect } from 'react';
import { useP2P } from '@/providers/P2PProvider';
import { KeyManager } from '@/lib/crypto/KeyManager';
import type { DAGPost } from '@/lib/logic/ThreadDAGManager';

/**
 * useThread Hook
 * 特定のスレッドの状態管理と投稿ロジックを、ThreadOrchestrator と同期して提供する
 */
export function useThread(boardId: string, threadId: string) {
  const { isReady, threadOrchestrator } = useP2P();

  const [posts, setPosts] = useState<DAGPost[]>([]);
  const [status, setStatus] = useState<string>('初期化中...');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [powProgress, setPowProgress] = useState(0);
  const [postStatus, setPostStatus] = useState<string>('');

  // --- Orchestrator 状態購読 ---
  useEffect(() => {
    if (!threadOrchestrator) return;
    return threadOrchestrator.subscribe(setPosts);
  }, [threadOrchestrator]);

  useEffect(() => {
    if (!threadOrchestrator) return;
    return threadOrchestrator.subscribeStatus((statusObj) => {
      // マッピングルール: 投稿中なら postStatus、それ以外は全体 status
      if (statusObj.phase === 'submitting') {
        setPostStatus(statusObj.message);
        setIsSubmitting(statusObj.isSubmitting ?? false);
        setPowProgress(statusObj.powProgress ?? 0);
      } else {
        setStatus(statusObj.message);
        // 投稿フェーズが終わった際などは postStatus をリセット
        if (statusObj.phase !== 'submitting') {
          setPostStatus('');
        }
      }
    });
  }, [threadOrchestrator]);

  // --- スレッド活性化ライフサイクル ---
  useEffect(() => {
    if (!isReady || !threadOrchestrator) return;

    if (typeof window !== 'undefined') {
      const hashParams = new URLSearchParams(window.location.hash.substring(1));
      const base64Key = hashParams.get('key');

      let bKey: Uint8Array | null = null;
      if (base64Key) {
        bKey = KeyManager.fromBase64(base64Key);
      } else if (boardId === 'vip') {
        bKey = KeyManager.cryptoHash(new TextEncoder().encode('AETHER_LITE_VIP_DEFAULT_SEED')).slice(0, 32);
      }
      
      if (bKey) {
        // Orchestrator 側に板・スレッド・鍵を渡し、同期・監視を開始させる
        threadOrchestrator.activate(boardId, threadId, bKey);
      }
    }
  }, [boardId, threadId, isReady, threadOrchestrator]);

  /**
   * 返信の投稿
   * Orchestrator に委譲し、進捗はステータス購読経由で取得する
   */
  const submitReply = async (text: string) => {
    if (!text || !threadOrchestrator) return;
    await threadOrchestrator.submitReply(text);
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
