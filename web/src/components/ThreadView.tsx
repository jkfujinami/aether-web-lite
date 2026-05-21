"use client";

import { use, useState, KeyboardEvent } from "react";
import { useThread } from "@/hooks/useThread";
import { KeyManager } from "@/lib/crypto/KeyManager";

export default function ThreadView({
  boardId,
  threadId,
  boardKeyBase64
}: {
  boardId: string;
  threadId: string;
  boardKeyBase64?: string;
}) {
  const {
    posts, status, submitReply,
    powProgress, isSubmitting, postStatus
  } = useThread(boardId, threadId);

  const [replyInput, setReplyInput] = useState('');

  const formatContent = (content: string) => {
    // 従来の置き換えロジック: sanitize してから >>1 などを着色
    // React では dangerouslySetInnerHTML を使う必要がある点に注意
    const sanitized = content
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const withLinks = sanitized.replace(
      /&gt;&gt;(\d+)/g,
      '<span style="color:var(--accent-primary); cursor:pointer;">&gt;&gt;$1</span>'
    );
    return withLinks;
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.ctrlKey && e.key === 'Enter') {
      handleSubmit();
    }
  };

  const handleSubmit = async () => {
    if (!replyInput.trim() || isSubmitting) return;
    await submitReply(replyInput);
    if (!status.startsWith('🔴')) {
      setReplyInput('');
    }
  };

  return (
    <div className="view-container thread-view column-content">
      <div style={{ marginBottom: '20px' }}>
        <button
          onClick={() => { window.location.hash = `#board=${boardId}${boardKeyBase64 ? `&key=${boardKeyBase64}` : ''}`; }}
          style={{ background: 'none', border: 'none', padding: 0, color: 'var(--text-dim)', textDecoration: 'none', cursor: 'pointer', fontSize: 'inherit' }}
        >
          ← 板に戻る
        </button>
        <h1 id="thread-title" style={{ marginTop: '10px', fontSize: '24px' }}>
          スレッド: {threadId.substring(0, 8)}
        </h1>
      </div>

      <div id="posts-container">
        {status && <div id="loading-status" style={{ color: 'var(--text-dim)', padding: '20px', textAlign: 'center' }}>{status}</div>}

        {posts.map((p, index) => {
          const trip = p.trip_pubkey ? '◆' + KeyManager.toBase64(KeyManager.cryptoHash(p.trip_pubkey).slice(0, 5)) : '';
          const id = p.session_pubkey ? KeyManager.toBase64(KeyManager.cryptoHash(p.session_pubkey).slice(0, 4)) : '???';

          return (
            <div className="post" key={p.packet_id || index}>
              <div className="post-header">
                <span className="res-no">{index + 1}</span>
                <span className="author-name">名無しさん {trip}</span>
                <span className="author-id">ID:{id}</span>
                <span className="post-time">{new Date(p.created_at).toLocaleString()}</span>
              </div>
              <div
                className="post-body"
                dangerouslySetInnerHTML={{ __html: formatContent(p.content || '') }}
              />
            </div>
          );
        })}
      </div>

      <div className="compose-box">
        <textarea
          id="reply-input"
          placeholder=">>レスを入力... (Ctrl+Enterで送信)"
          rows={3}
          value={replyInput}
          onChange={e => setReplyInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isSubmitting}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '10px' }}>
          <div id="post-status" style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
            {postStatus}
          </div>
          <button
            className="btn"
            id="btn-send-reply"
            onClick={handleSubmit}
            disabled={isSubmitting || !replyInput.trim()}
          >
            書き込む
          </button>
        </div>
        {isSubmitting && (
          <div className="progress-container" id="pow-progress" style={{ marginTop: '10px' }}>
            <div className="progress-bar" id="pow-bar" style={{ width: `${powProgress}%` }}></div>
          </div>
        )}
      </div>
    </div>
  );
}
