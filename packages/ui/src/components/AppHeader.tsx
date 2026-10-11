import { useState, useEffect, useCallback } from 'react';
import { useP2P } from '../providers/P2PProvider';
import { KeyManager, type BoardRecord } from '@aether/core';
import { DEFAULT_BOARD_ID, newBoardId, parseShareCode } from '../lib/boardKeys';
import { SecurityInfo } from './SecurityInfo';
import { TrackerSettings } from './TrackerSettings';
import { useAppConfig } from '../providers/AppConfig';

export function AppHeader() {
  const { node, identity, db, panicWipe, lock, trackerUrl } = useP2P();
  const { badge } = useAppConfig();
  const [peerCount, setPeerCount] = useState(0);
  const [boards, setBoards] = useState<BoardRecord[]>([]);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [showSecurity, setShowSecurity] = useState(false);
  const [showTracker, setShowTracker] = useState(false);

  useEffect(() => {
    if (!node) return;
    setPeerCount(node.degree);
    const timer = setInterval(() => {
      setPeerCount(node.degree);
    }, 2000);
    return () => clearInterval(timer);
  }, [node]);

  const refreshBoards = useCallback(() => {
    if (!db) return;
    db.listBoards().then(setBoards).catch(() => setBoards([]));
  }, [db]);

  useEffect(() => {
    refreshBoards();
  }, [refreshBoards]);

  /**
   * 秘密の板を作る。
   * ★ 鍵は暗号化された端末 DB にだけ保存し、URL には板 ID だけを載せる。
   */
  const handleCreatePrivateBoard = async () => {
    if (!db) return;
    const id = newBoardId();
    await db.saveBoard(id, KeyManager.generateBoardKey());
    refreshBoards();
    window.location.hash = `#board=${id}`;
  };

  const handleImport = async () => {
    if (!db) return;
    const parsed = parseShareCode(importText);
    if (!parsed) {
      setImportError('共有コードの形式が正しくありません');
      return;
    }
    await db.saveBoard(parsed.boardId, parsed.key);
    setImportText('');
    setImportError(null);
    setShowImport(false);
    refreshBoards();
    window.location.hash = `#board=${parsed.boardId}`;
  };

  /** 緊急消去。誤操作を防ぐため 2 回押させる */
  const handlePanicWipe = async () => {
    if (!confirmWipe) {
      setConfirmWipe(true);
      setTimeout(() => setConfirmWipe(false), 5000);
      return;
    }
    setConfirmWipe(false);
    await panicWipe();
  };

  return (
    <header>
      <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
        <a
          href={`#board=${DEFAULT_BOARD_ID}`}
          className="nav-logo"
          style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '8px' }}
        >
          <span>AETHER</span>
          <span style={{ fontSize: '10px', background: '#1e293b', color: 'var(--accent)', padding: '2px 6px', borderRadius: '3px', border: '1px solid #334155' }}>
            {badge}
          </span>
        </a>
        <button
          className="btn"
          onClick={handleCreatePrivateBoard}
          disabled={!db}
          style={{ padding: '3px 10px', fontSize: '11px' }}
        >
          + 秘密の板を作る
        </button>
        <button
          className="btn"
          onClick={() => setShowImport((v) => !v)}
          disabled={!db}
          style={{ padding: '3px 10px', fontSize: '11px' }}
        >
          共有コードで参加
        </button>
        {boards.length > 0 && (
          <select
            aria-label="保存済みの板"
            value=""
            onChange={(e) => { if (e.target.value) window.location.hash = `#board=${e.target.value}`; }}
            style={{ fontSize: '11px' }}
          >
            <option value="">保存済みの板 ({boards.length})</option>
            {boards.map((b) => (
              <option key={b.boardId} value={b.boardId}>{b.boardId}</option>
            ))}
          </select>
        )}
      </div>

      <div className="nav-stats" style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: peerCount > 0 ? 'var(--success)' : 'var(--text-dim)' }}>
          <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: peerCount > 0 ? 'var(--success)' : '#eab308' }} />
          <span>Peers: {peerCount}</span>
        </div>

        {identity && (
          <div style={{ color: 'var(--text-dim)', fontFamily: 'monospace' }}>
            Trip: <span style={{ color: '#d1a65d' }}>{identity.tripDisplay || '名無し'}</span>
            {identity.hasTrip && (
              <span
                role="note"
                title="トリップを付けた投稿同士は、同じ人物のものとして紐付きます。継続して投稿すると、オンラインだった時間帯との突き合わせで候補を絞られる材料にもなります。"
                style={{ marginLeft: '6px', color: '#eab308' }}
              >
                ⚠ 投稿同士が紐付きます
              </span>
            )}
          </div>
        )}

        <button
          className="btn"
          onClick={() => setShowTracker((v) => !v)}
          disabled={!node}
          title={trackerUrl ? 'トラッカーの設定' : 'トラッカーが未設定です'}
          style={{ padding: '3px 10px', fontSize: '11px', ...(node && !trackerUrl ? { borderColor: '#eab308', color: '#eab308' } : {}) }}
        >
          {node && !trackerUrl ? 'トラッカー未設定' : 'トラッカー'}
        </button>

        <button
          className="btn"
          onClick={() => setShowSecurity((v) => !v)}
          style={{ padding: '3px 10px', fontSize: '11px' }}
        >
          安全性について
        </button>

        <button
          className="btn"
          onClick={() => { void lock(); }}
          title="通信を止め、パスワード画面に戻ります (データは消えません)"
          style={{ padding: '3px 10px', fontSize: '11px' }}
        >
          ロック
        </button>

        <button
          className="btn"
          onClick={handlePanicWipe}
          title="通信を止め、この端末のデータをすべて読めなくしてから消去します (元に戻せません)"
          style={{ padding: '3px 10px', fontSize: '11px', borderColor: '#ef4444', color: '#ef4444' }}
        >
          {confirmWipe ? 'もう一度押すと全消去' : '緊急消去'}
        </button>
      </div>

      {showSecurity && (
        <div className="card" style={{ position: 'absolute', top: '50px', right: '15px', zIndex: 10, width: '420px' }}>
          <SecurityInfo />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10px' }}>
            <button className="btn" onClick={() => setShowSecurity(false)}>閉じる</button>
          </div>
        </div>
      )}

      {showTracker && (
        <div className="card" style={{ position: 'absolute', top: '50px', right: '15px', zIndex: 10, width: '420px' }}>
          <TrackerSettings onClose={() => setShowTracker(false)} />
        </div>
      )}

      {showImport && (
        <div className="card" style={{ position: 'absolute', top: '50px', left: '15px', zIndex: 10, width: '360px' }}>
          <div className="input-group">
            <input
              aria-label="共有コード"
              placeholder="board=...&key=..."
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
              <button className="btn" onClick={() => { setShowImport(false); setImportError(null); }}>中止</button>
              <button className="btn" onClick={handleImport} disabled={!importText.trim()}>追加</button>
            </div>
            {importError && <div role="alert" style={{ color: '#ef4444', fontSize: '11px', marginTop: '6px' }}>{importError}</div>}
          </div>
        </div>
      )}
    </header>
  );
}
