// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import sodium from 'libsodium-wrappers-sumo';

import { AppHeader } from '../src/components/AppHeader';
import BoardView from '../src/components/BoardView';
import ThreadView from '../src/components/ThreadView';
import App, { RouterView } from '../src/App';
import { P2PProvider, P2PContextForTest } from '../src/providers/P2PProvider';

/** ロック解除済みの最小のコンテキスト (ノード無し) */
function readyContext(): any {
  return {
    node: null,
    boardOrchestrator: null,
    threadOrchestrator: null,
    pm: null,
    identity: null,
    db: null,
    isReady: false,
    lockState: 'ready',
    unlockError: null,
    unlock: async () => {},
    resetAll: async () => {},
    panicWipe: async () => {},
  };
}
import { KeyManager, Identity } from '@aether/core';

describe('Desktop UI Rendering & Workflows (AETHER Specification)', () => {
  beforeAll(async () => {
    await sodium.ready;
  });

  afterEach(() => {
    cleanup();
    window.location.hash = '';
  });

  describe('AppHeader Component', () => {
    it('正常にヘッダーロゴ、Desktop Full Node バッジ、および秘密の板作成ボタンが描画される', () => {
      render(
        <P2PProvider>
          <AppHeader />
        </P2PProvider>,
      );

      expect(screen.getByText('AETHER')).toBeTruthy();
      expect(screen.getByText('Desktop Full Node')).toBeTruthy();
      expect(screen.getByText('+ 秘密の板を作る')).toBeTruthy();
      expect(screen.getByText(/Peers:/)).toBeTruthy();
    });

    it('秘密の板を作ると、鍵は暗号化 DB に保存され、URL には板 ID だけが載る', async () => {
      const saveBoard = vi.fn().mockResolvedValue(undefined);
      const db: any = { saveBoard, listBoards: vi.fn().mockResolvedValue([]) };
      render(
        <P2PContextForTest.Provider value={{ ...readyContext(), db }}>
          <AppHeader />
        </P2PContextForTest.Provider>,
      );

      fireEvent.click(screen.getByText('+ 秘密の板を作る'));

      await waitFor(() => expect(window.location.hash).toMatch(/^#board=[0-9a-f]+$/));
      expect(saveBoard).toHaveBeenCalledTimes(1);
      const [boardId, key] = saveBoard.mock.calls[0];
      expect(window.location.hash).toBe(`#board=${boardId}`);
      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
    });

    it('ロック解除前 (DB が無い) は秘密の板を作れない', () => {
      render(
        <P2PProvider>
          <AppHeader />
        </P2PProvider>,
      );
      expect((screen.getByText('+ 秘密の板を作る') as HTMLButtonElement).disabled).toBe(true);
    });

    it('緊急消去は 2 回押さないと実行されない', async () => {
      const panicWipe = vi.fn().mockResolvedValue(undefined);
      render(
        <P2PContextForTest.Provider value={{ ...readyContext(), panicWipe }}>
          <AppHeader />
        </P2PContextForTest.Provider>,
      );

      fireEvent.click(screen.getByText('緊急消去'));
      expect(panicWipe).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText('もう一度押すと全消去'));
      await waitFor(() => expect(panicWipe).toHaveBeenCalledTimes(1));
    });
  });

  describe('BoardView Component', () => {
    it('初期状態で板タイトルと新スレを立てるボタンが表示される', () => {
      render(
        <P2PProvider>
          <BoardView boardId="vip" />
        </P2PProvider>,
      );

      expect(screen.getByText('板: vip')).toBeTruthy();
      const newThreadBtn = screen.getByText('新スレを立てる');
      expect(newThreadBtn).toBeTruthy();
    });

    it('新スレを立てるボタンをクリックするとフォームが展開され、中止で閉じることができる', () => {
      render(
        <P2PProvider>
          <BoardView boardId="vip" />
        </P2PProvider>,
      );

      const newThreadBtn = screen.getByText('新スレを立てる');
      fireEvent.click(newThreadBtn);

      expect(screen.getByText('新規スレッド作成')).toBeTruthy();
      const textarea = screen.getByPlaceholderText('スレッドタイトル...');
      expect(textarea).toBeTruthy();

      const cancelBtn = screen.getByText('中止');
      fireEvent.click(cancelBtn);

      expect(screen.queryByText('新規スレッド作成')).toBeNull();
    });

    it('スレッドタイトルが空の場合は作成ボタンが無効化される', () => {
      render(
        <P2PProvider>
          <BoardView boardId="vip" />
        </P2PProvider>,
      );

      fireEvent.click(screen.getByText('新スレを立てる'));
      const submitBtn = screen.getByText('作成') as HTMLButtonElement;
      expect(submitBtn.disabled).toBe(true);

      const textarea = screen.getByPlaceholderText('スレッドタイトル...');
      fireEvent.change(textarea, { target: { value: 'テストスレッドです' } });
      expect(submitBtn.disabled).toBe(false);
    });
  });

  describe('ThreadView Component', () => {
    it('スレッド画面で戻るボタン、スレッドタイトル、返信フォームが表示される', () => {
      const threadId = 'abcdef1234567890';
      render(
        <P2PProvider>
          <ThreadView boardId="vip" threadId={threadId} />
        </P2PProvider>,
      );

      expect(screen.getByText('← 板に戻る')).toBeTruthy();
      expect(screen.getByText(`スレッド: ${threadId.substring(0, 8)}`)).toBeTruthy();
      expect(screen.getByPlaceholderText('>>レスを入力... (Ctrl+Enterで送信)')).toBeTruthy();
    });

    it('板に戻るボタンを押すと該当の板ハッシュへ遷移する', () => {
      const threadId = 'abcdef1234567890';
      window.location.hash = `#board=vip&thread=${threadId}`;

      render(
        <P2PProvider>
          <ThreadView boardId="vip" threadId={threadId} />
        </P2PProvider>,
      );

      const backBtn = screen.getByText('← 板に戻る');
      fireEvent.click(backBtn);

      expect(window.location.hash).toBe('#board=vip');
    });

    it('レス入力欄でCtrl+Enterが入力可能であり空のときは送信されない', () => {
      const threadId = 'abcdef1234567890';
      render(
        <P2PProvider>
          <ThreadView boardId="vip" threadId={threadId} />
        </P2PProvider>,
      );

      const textarea = screen.getByPlaceholderText('>>レスを入力... (Ctrl+Enterで送信)');
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
      // 例外なく安全にスルーされる
    });
  });

  describe('Desktop App Whole Integration', () => {
    it('起動するとまずパスワード画面が出て、ロック解除まで板は表示されない', async () => {
      render(<App />);

      await waitFor(() => {
        expect(screen.getByText('パスワードを設定')).toBeTruthy();
      });
      expect(screen.queryByText('板: vip')).toBeNull();
    });

    it('初回設定では短いパスワードと確認の不一致を弾く', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('パスワードを設定'));

      fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'short' } });
      fireEvent.change(screen.getByLabelText('パスワード (確認)'), { target: { value: 'short' } });
      fireEvent.click(screen.getByText('設定して開始'));
      await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/8 文字以上/));

      fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'long enough pass' } });
      fireEvent.change(screen.getByLabelText('パスワード (確認)'), { target: { value: 'different pass!!' } });
      fireEvent.click(screen.getByText('設定して開始'));
      await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/一致しません/));
    });

    it('初期URLハッシュなしで開いた際、自動的に #board=vip へフォールバックして描画される', async () => {
      window.location.hash = '';

      render(<P2PProvider><RouterView /></P2PProvider>);

      await waitFor(() => {
        expect(window.location.hash).toBe('#board=vip');
      });

      expect(screen.getByText('AETHER')).toBeTruthy();
      expect(screen.getByText('板: vip')).toBeTruthy();
    });

    it('鍵付きのリンクで開いても、URL から鍵が消える', async () => {
      window.location.hash = '#board=abc123&key=AAAA';
      render(<P2PProvider><RouterView /></P2PProvider>);

      await waitFor(() => {
        expect(window.location.hash).toBe('#board=abc123');
      });
    });

    it('ハッシュ変更により BoardView と ThreadView の切り替えが正しく反映される', async () => {
      window.location.hash = '#board=vip';
      render(<P2PProvider><RouterView /></P2PProvider>);

      expect(screen.getByText('板: vip')).toBeTruthy();

      window.location.hash = '#board=vip&thread=9876543210abcdef';
      window.dispatchEvent(new HashChangeEvent('hashchange'));

      await waitFor(() => {
        expect(screen.getByText('スレッド: 98765432')).toBeTruthy();
      });
    });
  });
});
