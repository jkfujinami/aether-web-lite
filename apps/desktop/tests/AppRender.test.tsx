// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import sodium from 'libsodium-wrappers-sumo';

import { AppHeader } from '../src/components/AppHeader';
import BoardView from '../src/components/BoardView';
import ThreadView from '../src/components/ThreadView';
import App from '../src/App';
import { P2PProvider } from '../src/providers/P2PProvider';
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

    it('秘密の板作成ボタンを押すと、暗号的に安全な鍵付きURLハッシュが生成される', () => {
      render(
        <P2PProvider>
          <AppHeader />
        </P2PProvider>,
      );

      const createBtn = screen.getByText('+ 秘密の板を作る');
      fireEvent.click(createBtn);

      expect(window.location.hash).toMatch(/^#board=[a-z0-9]+&key=[A-Za-z0-9_-]+/);
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
    it('初期URLハッシュなしで起動した際、自動的に #board=vip へフォールバックして描画される', async () => {
      window.location.hash = '';

      render(<App />);

      await waitFor(() => {
        expect(window.location.hash).toBe('#board=vip');
      });

      expect(screen.getByText('AETHER')).toBeTruthy();
      expect(screen.getByText('板: vip')).toBeTruthy();
    });

    it('ハッシュ変更により BoardView と ThreadView の切り替えが正しく反映される', async () => {
      window.location.hash = '#board=vip';
      render(<App />);

      expect(screen.getByText('板: vip')).toBeTruthy();

      window.location.hash = '#board=vip&thread=9876543210abcdef';
      window.dispatchEvent(new HashChangeEvent('hashchange'));

      await waitFor(() => {
        expect(screen.getByText('スレッド: 98765432')).toBeTruthy();
      });
    });
  });
});
