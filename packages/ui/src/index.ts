/**
 * @aether/ui — Desktop と Web で共通の画面。
 *
 * プロトコルは @aether/core にだけ置き、ここは画面と端末データの扱い (ロック・板の鍵・
 * トラッカー設定) だけを持つ。各アプリはこのパッケージの AetherApp を描画する。
 */
export { default as AetherApp, RouterView, type AetherAppProps } from './App';
export {
  P2PProvider,
  P2PContext,
  P2PContextForTest,
  useP2P,
  MIN_PASSPHRASE_LENGTH,
  type LockState,
  type TrackerSaveResult,
} from './providers/P2PProvider';
export { AppConfigContext, useAppConfig, type AppConfig } from './providers/AppConfig';
export { AppHeader } from './components/AppHeader';
export { default as BoardView } from './components/BoardView';
export { default as ThreadView } from './components/ThreadView';
export { SecurityInfo } from './components/SecurityInfo';
export { SecurityLevelSettings } from './components/SecurityLevelSettings';
export { TrackerSettings } from './components/TrackerSettings';
export { UnlockScreen } from './components/UnlockScreen';
export { useBoard } from './hooks/useBoard';
export { useThread } from './hooks/useThread';
export * from './lib/boardKeys';
export * from './lib/trackerSetting';
