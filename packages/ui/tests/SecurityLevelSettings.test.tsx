// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

import { AppHeader } from '../src/components/AppHeader';
import { SecurityLevelSettings } from '../src/components/SecurityLevelSettings';
import { P2PContextForTest } from '../src/providers/P2PProvider';

function context(over: Record<string, unknown> = {}): any {
  return {
    node: null,
    boardOrchestrator: null,
    threadOrchestrator: null,
    pm: null,
    identity: null,
    db: null,
    isReady: true,
    lockState: 'ready',
    unlockError: null,
    unlock: async () => {},
    resetAll: async () => {},
    panicWipe: async () => {},
    lock: async () => {},
    trackerUrl: null,
    setTrackerUrl: vi.fn().mockResolvedValue({ ok: true }),
    anonymityLevel: 'standard',
    setAnonymityLevel: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

afterEach(() => cleanup());

describe('セキュリティレベル設定画面 (Tor 準拠)', () => {
  it('3つのセキュリティレベル (標準, より安全, 最も安全) が表示される', () => {
    render(
      <P2PContextForTest.Provider value={context()}>
        <SecurityLevelSettings />
      </P2PContextForTest.Provider>,
    );

    expect(screen.getByText(/標準 \(Standard - 最低\/最速\)/)).toBeTruthy();
    expect(screen.getByText(/より安全 \(Safer - バランス\)/)).toBeTruthy();
    expect(screen.getByText(/最も安全 \(Safest - 最高匿名性\)/)).toBeTruthy();
  });

  it('レベルを選択すると setAnonymityLevel が正しい引数で呼ばれる', () => {
    const setAnonymityLevel = vi.fn().mockResolvedValue(undefined);
    render(
      <P2PContextForTest.Provider value={context({ setAnonymityLevel })}>
        <SecurityLevelSettings />
      </P2PContextForTest.Provider>,
    );

    // 「より安全」をクリック
    fireEvent.click(screen.getByText(/より安全 \(Safer - バランス\)/));
    expect(setAnonymityLevel).toHaveBeenCalledWith('safer');

    // 「最も安全」をクリック
    fireEvent.click(screen.getByText(/最も安全 \(Safest - 最高匿名性\)/));
    expect(setAnonymityLevel).toHaveBeenCalledWith('safest');

    // 「標準」をクリック
    fireEvent.click(screen.getByText(/標準 \(Standard - 最低\/最速\)/));
    expect(setAnonymityLevel).toHaveBeenCalledWith('standard');
  });

  it('閉じるボタンを押すと onClose が呼ばれる', () => {
    const onClose = vi.fn();
    render(
      <P2PContextForTest.Provider value={context()}>
        <SecurityLevelSettings onClose={onClose} />
      </P2PContextForTest.Provider>,
    );

    fireEvent.click(screen.getByText('閉じる'));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('AppHeader のセキュリティレベル表示とトグル', () => {
  it('ノード起動時に現在のレベル (既定: 標準) がヘッダーに表示される', () => {
    render(
      <P2PContextForTest.Provider value={context({ node: { degree: 0 }, anonymityLevel: 'standard' })}>
        <AppHeader />
      </P2PContextForTest.Provider>,
    );

    expect(screen.getByText('標準')).toBeTruthy();
  });

  it('レベルが safest の場合は「最も安全」と表示される', () => {
    render(
      <P2PContextForTest.Provider value={context({ node: { degree: 0 }, anonymityLevel: 'safest' })}>
        <AppHeader />
      </P2PContextForTest.Provider>,
    );

    expect(screen.getByText('最も安全')).toBeTruthy();
  });

  it('ヘッダーのレベルボタンをクリックすると設定モーダルが開く', () => {
    render(
      <P2PContextForTest.Provider value={context({ node: { degree: 0 } })}>
        <AppHeader />
      </P2PContextForTest.Provider>,
    );

    expect(screen.queryByText(/オニオン回路のトラフィック混合遅延/)).toBeNull();

    // ボタンをクリックしてモーダルを開く
    fireEvent.click(screen.getByText('標準'));
    expect(screen.getByText(/オニオン回路のトラフィック混合遅延/)).toBeTruthy();

    // 閉じるボタンで閉じる
    fireEvent.click(screen.getByText('閉じる'));
    expect(screen.queryByText(/オニオン回路のトラフィック混合遅延/)).toBeNull();
  });
});
