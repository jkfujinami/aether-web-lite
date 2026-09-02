"use client";

import { useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { useP2P } from '@/providers/P2PProvider';
import { KeyManager } from '@/lib/crypto/KeyManager';
import { ThreadRanker } from '@/lib/logic/ThreadRanker';
import { ThreadMeta, BoardStatus } from '@/lib/logic/types';

const EMPTY_THREADS: ThreadMeta[] = [];
const IDLE_STATUS: BoardStatus = { phase: 'idle', message: '初期化中...', isSubmitting: false, powProgress: 0 };

/**
 * useBoard
 *
 * ★ 購読を useSyncExternalStore に置き換えてある。
 *
 * 以前は `useEffect(() => orchestrator.subscribe(setThreads), [...])` という
 * 形だったが、これは React の外にあるストアを繋ぐ方法として取りこぼしが起きる。
 *
 *   - レンダーが走ってから effect が張られるまでの間に来た通知は失われる
 *   - StrictMode の二重実行や、購読の張り直しと通知の順序に結果が依存する
 *   - setState を「Reactの外」から呼ぶため、更新が落ちても何も警告が出ない
 *
 * useSyncExternalStore は購読直後にスナップショットを読み直すので、この窓が
 * 構造的に消える。代わりに getSnapshot は「変わらない限り同じ参照」を返す
 * 必要があり、その責任は BoardOrchestrator 側のキャッシュが負っている。
 */
export function useBoard(boardId: string) {
  const { boardOrchestrator, isReady } = useP2P();

  const boardKey = useRef<Uint8Array | null>(null);

  const subscribeThreads = useCallback(
    (onChange: () => void) => {
      console.log('[TRACE:7-useBoard] subscribeThreads: attaching listener');
      const wrapped = () => {
        console.log('[TRACE:8-useBoard] subscribeThreads: onChange fired -> React will re-render');
        onChange();
      };
      const unsub = boardOrchestrator?.subscribe(wrapped) ?? (() => {});
      return () => {
        console.log('[TRACE:7-useBoard] subscribeThreads: detaching listener');
        unsub();
      };
    },
    [boardOrchestrator],
  );
  const getThreads = useCallback(
    () => {
      const t = boardOrchestrator?.getThreads() ?? EMPTY_THREADS;
      console.log(`[TRACE:9-useBoard] getThreads snapshot read: ${t.length} threads`);
      return t;
    },
    [boardOrchestrator],
  );

  const subscribeStatus = useCallback(
    (onChange: () => void) => boardOrchestrator?.subscribeStatus(onChange) ?? (() => {}),
    [boardOrchestrator],
  );
  const getStatus = useCallback(
    () => boardOrchestrator?.getStatus() ?? IDLE_STATUS,
    [boardOrchestrator],
  );

  const threads = useSyncExternalStore(subscribeThreads, getThreads, () => EMPTY_THREADS);
  const status = useSyncExternalStore(subscribeStatus, getStatus, () => IDLE_STATUS);

  // BoardKey の解決 (レンダー結果に影響しないので ref のまま)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    const base64Key = hashParams.get('key');

    if (base64Key) {
      boardKey.current = KeyManager.fromBase64(base64Key);
    } else if (boardId === 'vip') {
      boardKey.current = KeyManager.cryptoHash(
        new TextEncoder().encode('AETHER_LITE_VIP_DEFAULT_SEED'),
      ).slice(0, 32);
    }
  }, [boardId]);

  // 板の活性化。アンマウント時に購読を畳む。
  useEffect(() => {
    if (!isReady || !boardOrchestrator || !boardKey.current) return;
    boardOrchestrator.activate(boardId, boardKey.current);
    return () => {
      boardOrchestrator.clear();
    };
  }, [boardId, boardOrchestrator, isReady]);

  const submitThread = async (title: string, onFail?: (m: string) => void) => {
    if (!boardOrchestrator || !boardKey.current) return;

    const threadId = await boardOrchestrator.submitThread(boardId, boardKey.current, title);

    if (threadId) {
      const keyB64 = KeyManager.toBase64(boardKey.current);
      window.location.hash = `#board=${boardId}&thread=${threadId}&key=${keyB64}`;
    } else if (onFail) {
      onFail('スレッドの作成に失敗しました');
    }
  };

  const sortedThreads = [...threads].sort((a, b) => {
    const scoreA = ThreadRanker.calculateScore(a.max_pow || 0, a.created_at);
    const scoreB = ThreadRanker.calculateScore(b.max_pow || 0, b.created_at);
    return scoreB - scoreA;
  });

  return {
    threads: sortedThreads,
    status: status.message,
    isSubmitting: status.isSubmitting ?? false,
    powProgress: status.powProgress ?? 0,
    submitThread,
    boardKeyBase64: boardKey.current ? KeyManager.toBase64(boardKey.current) : null,
  };
}
