import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  AetherNode,
  IndexedDBStore,
  WrongPassphraseError,
  parseTrackerUrl,
  describeTrackerUrlError,
  type BoardOrchestrator,
  type ThreadOrchestrator,
  type Identity,
  type PeerManager,
  createLogger,
} from '@aether/core';

import { loadTrackerUrl, saveTrackerUrl } from '@/lib/trackerSetting';

const log = createLogger('ui.p2p');

/** トラッカーの設定結果。ok でも、接続できなかった場合は notice に理由が入る */
export type TrackerSaveResult = { ok: true; notice?: string } | { ok: false; error: string };

/**
 * ロックの状態。
 *
 * - checking : 端末にパスワードが設定済みかを確かめている
 * - setup    : 初回起動。パスワードを決めてもらう
 * - locked   : パスワードの入力待ち
 * - starting : ロック解除してノードを起動中
 * - ready    : 起動済み
 */
export type LockState = 'checking' | 'setup' | 'locked' | 'starting' | 'ready';

/** 端末の全データの暗号化に使うパスワードの最小長 */
export const MIN_PASSPHRASE_LENGTH = 8;

interface P2PContextType {
  node: AetherNode | null;
  boardOrchestrator: BoardOrchestrator | null;
  threadOrchestrator: ThreadOrchestrator | null;
  pm: PeerManager | null;
  identity: Identity | null;
  /** 暗号化された端末データ (ロック解除後のみ) */
  db: IndexedDBStore | null;
  isReady: boolean;
  lockState: LockState;
  /** 直近のロック解除の失敗理由 */
  unlockError: string | null;
  /** パスワードでロックを解除して起動する (初回はこのパスワードで暗号化を始める) */
  unlock: (passphrase: string) => Promise<void>;
  /** パスワードを忘れた: 全データを消して作り直す */
  resetAll: () => Promise<void>;
  /** 緊急消去: 通信を止め、全データを即座に読めなくしてから消す */
  panicWipe: () => Promise<void>;
  /** ロック: データは消さずに通信を止め、メモリ上の鍵を消してパスワード画面に戻る */
  lock: () => Promise<void>;
  /** 接続先のトラッカー (未設定なら null) */
  trackerUrl: string | null;
  /** トラッカーを設定する (null で消す)。暗号化 DB に保存し、すぐ接続し直す */
  setTrackerUrl: (url: string | null) => Promise<TrackerSaveResult>;
}

const noop = async () => {};

export const P2PContext = createContext<P2PContextType>({
  node: null,
  boardOrchestrator: null,
  threadOrchestrator: null,
  pm: null,
  identity: null,
  db: null,
  isReady: false,
  lockState: 'checking',
  unlockError: null,
  unlock: noop,
  resetAll: noop,
  panicWipe: noop,
  lock: noop,
  trackerUrl: null,
  setTrackerUrl: async () => ({ ok: false, error: 'ロックを解除してください' }),
});

export const P2PContextForTest = P2PContext;
export const useP2P = () => useContext(P2PContext);

/**
 * P2PProvider
 *
 * ★ ノードはロック解除してから起動する。
 *
 *   端末の全データ (投稿・スレッド統計・板の鍵・保管中の Slot・鍵) はパスワードで
 *   暗号化してある。パスワードを受け取るまでは、何も読めず何も送らない。
 *   パスワードは起動に使った後は保持しない。
 */
export function P2PProvider({ children }: { children: React.ReactNode }) {
  const [node, setNode] = useState<AetherNode | null>(null);
  const [lockState, setLockState] = useState<LockState>('checking');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [trackerUrl, setTrackerUrlState] = useState<string | null>(null);
  const storeRef = useRef<IndexedDBStore | null>(null);
  const nodeRef = useRef<AetherNode | null>(null);

  const store = () => {
    if (!storeRef.current) storeRef.current = new IndexedDBStore();
    return storeRef.current;
  };

  useEffect(() => {
    let cancelled = false;
    store()
      .hasVault()
      .then((has) => { if (!cancelled) setLockState(has ? 'locked' : 'setup'); })
      .catch((err) => {
        log.error('Failed to open local storage', err);
        if (!cancelled) setLockState('setup');
      });
    return () => {
      cancelled = true;
      nodeRef.current?.stop().catch((e) => log.warn('Error stopping node', e));
    };
  }, []);

  const unlock = useCallback(async (passphrase: string) => {
    setUnlockError(null);
    const previous = lockState;
    setLockState('starting');
    try {
      log.info(() => 'Unlocking local data and starting Desktop AetherNode...');
      const aether = await AetherNode.create({
        db: store(),
        passphrase,
        releaseMode: 'adaptive',
        autoStart: false,
      });
      try {
        // トラッカーの設定は暗号化 DB にあるので、ロック解除後に読んでから起動する
        const url = await loadTrackerUrl(aether.db);
        if (url) await aether.setTrackerUrl(url);
        await aether.start();
      } catch (err) {
        await aether.stop().catch(() => {});
        throw err;
      }
      setTrackerUrlState(aether.trackerUrl);
      nodeRef.current = aether;
      setNode(aether);
      setLockState('ready');
      log.info(() => 'Desktop AetherNode ready');
    } catch (err) {
      // 鍵をメモリに残さない (次の試行で必ずパスワードを照合させる)
      storeRef.current?.lock();
      if (err instanceof WrongPassphraseError) {
        setUnlockError('パスワードが違います');
      } else {
        log.error('Failed to initialize Desktop AetherNode', err);
        setUnlockError('起動に失敗しました');
      }
      setLockState(previous === 'setup' ? 'setup' : 'locked');
    }
  }, [lockState]);

  const resetAll = useCallback(async () => {
    await nodeRef.current?.stop().catch(() => {});
    nodeRef.current = null;
    setNode(null);
    await store().wipeAll();
    storeRef.current = null;
    setUnlockError(null);
    setLockState('setup');
  }, []);

  const panicWipe = useCallback(async () => {
    const current = nodeRef.current;
    nodeRef.current = null;
    setNode(null);
    if (current) {
      await current.panicWipe();
    } else {
      await store().wipeAll();
    }
    storeRef.current = null;
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', window.location.pathname);
    }
    setLockState('setup');
  }, []);

  const lock = useCallback(async () => {
    const current = nodeRef.current;
    nodeRef.current = null;
    setNode(null);
    await current?.stop().catch(() => {}); // stop() はメモリ上のデータ鍵も消す
    storeRef.current?.lock();
    setLockState('locked');
  }, []);

  const setTrackerUrl = useCallback(async (input: string | null): Promise<TrackerSaveResult> => {
    const current = nodeRef.current;
    if (!current) return { ok: false, error: 'ロックを解除してください' };
    let url: string | null = null;
    if (input !== null) {
      const parsed = parseTrackerUrl(input);
      if (!parsed.ok) return { ok: false, error: describeTrackerUrlError(parsed.reason) };
      url = parsed.url;
    }
    await saveTrackerUrl(current.db, url);
    try {
      await current.setTrackerUrl(url);
    } catch {
      // 設定は済んでいる。到達できなければ、ノードが定期的に再試行する
      setTrackerUrlState(current.trackerUrl);
      return { ok: true, notice: '保存しました。いまは接続できませんでした (自動で再試行します)' };
    }
    setTrackerUrlState(current.trackerUrl);
    return { ok: true };
  }, []);

  // トレイ (Electron のメインプロセス) からのロック / 緊急消去
  useEffect(() => {
    const api = (typeof window !== 'undefined' ? (window as any).electronAPI : undefined);
    if (!api?.onCommand) return;
    return api.onCommand((command: 'lock' | 'panic-wipe') => {
      if (command === 'lock') void lock();
      else void panicWipe();
    });
  }, [lock, panicWipe]);

  return (
    <P2PContext.Provider
      value={{
        node,
        boardOrchestrator: node?.boardOrchestrator || null,
        threadOrchestrator: node?.threadOrchestrator || null,
        pm: node?.peerManager || null,
        identity: node?.identity || null,
        db: node ? node.db : null,
        isReady: lockState === 'ready' && node !== null,
        lockState,
        unlockError,
        unlock,
        resetAll,
        panicWipe,
        lock,
        trackerUrl: node ? trackerUrl : null,
        setTrackerUrl,
      }}
    >
      {children}
    </P2PContext.Provider>
  );
}
