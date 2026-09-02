"use client";

import { useEffect, useCallback, useSyncExternalStore } from 'react';
import { useP2P } from '@/providers/P2PProvider';
import { KeyManager } from '@/lib/crypto/KeyManager';
import type { DAGPost } from '@/lib/logic/ThreadDAGManager';
import type { ThreadStatus } from '@/lib/logic/types';

const EMPTY_POSTS: DAGPost[] = [];
const IDLE_STATUS: ThreadStatus = { phase: 'idle', message: '初期化中...', isSubmitting: false, powProgress: 0 };

/**
 * useThread
 *
 * ★ 購読を useSyncExternalStore に置き換えてある (理由は useBoard 参照)。
 *
 * 以前の `useEffect + subscribe(setPosts)` は、レンダーから effect が
 * 張られるまでの間に来た通知を取りこぼす。ゴシップは非同期にいつでも来るので、
 * 「受信はできているのに画面が更新されない」という形で表面化する。
 */
export function useThread(boardId: string, threadId: string) {
  const { isReady, threadOrchestrator } = useP2P();

  const subscribePosts = useCallback(
    (onChange: () => void) => {
      console.log('[TRACE:7-useThread] subscribePosts: attaching listener');
      const wrapped = () => {
        console.log('[TRACE:8-useThread] subscribePosts: onChange fired -> React will re-render');
        onChange();
      };
      const unsub = threadOrchestrator?.subscribe(wrapped) ?? (() => {});
      return () => {
        console.log('[TRACE:7-useThread] subscribePosts: detaching listener');
        unsub();
      };
    },
    [threadOrchestrator],
  );
  const getPosts = useCallback(
    () => {
      const p = threadOrchestrator?.getPosts() ?? EMPTY_POSTS;
      console.log(`[TRACE:9-useThread] getPosts snapshot read: ${p.length} posts`);
      return p;
    },
    [threadOrchestrator],
  );

  const subscribeStatus = useCallback(
    (onChange: () => void) => threadOrchestrator?.subscribeStatus(onChange) ?? (() => {}),
    [threadOrchestrator],
  );
  const getStatus = useCallback(
    () => threadOrchestrator?.getStatus() ?? IDLE_STATUS,
    [threadOrchestrator],
  );

  const posts = useSyncExternalStore(subscribePosts, getPosts, () => EMPTY_POSTS);
  const statusObj = useSyncExternalStore(subscribeStatus, getStatus, () => IDLE_STATUS);

  // スレッドの活性化。アンマウント時に購読を畳む。
  useEffect(() => {
    if (!isReady || !threadOrchestrator || typeof window === 'undefined') return;

    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    const base64Key = hashParams.get('key');

    let bKey: Uint8Array | null = null;
    if (base64Key) {
      bKey = KeyManager.fromBase64(base64Key);
    } else if (boardId === 'vip') {
      bKey = KeyManager.cryptoHash(
        new TextEncoder().encode('AETHER_LITE_VIP_DEFAULT_SEED'),
      ).slice(0, 32);
    }

    if (!bKey) return;
    threadOrchestrator.activate(boardId, threadId, bKey);

    return () => {
      threadOrchestrator.clear();
    };
  }, [boardId, threadId, isReady, threadOrchestrator]);

  const submitReply = async (text: string) => {
    if (!text || !threadOrchestrator) return;
    await threadOrchestrator.submitReply(text);
  };

  const isSubmittingNow = statusObj.phase === 'submitting';

  return {
    posts,
    status: isSubmittingNow ? '' : statusObj.message,
    postStatus: isSubmittingNow ? statusObj.message : '',
    isSubmitting: statusObj.isSubmitting ?? false,
    powProgress: statusObj.powProgress ?? 0,
    submitReply,
  };
}
