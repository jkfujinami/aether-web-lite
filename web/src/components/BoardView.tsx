"use client";

import { use, useState } from "react";
import { useBoard, ThreadMeta } from "@/hooks/useBoard";

import { ThreadRanker } from "@/lib/logic/ThreadRanker";

export default function BoardView({
  boardId,
  boardKeyBase64
}: {
  boardId: string;
  boardKeyBase64?: string;
}) {
  const { threads, status, submitThread, powProgress, isSubmitting, boardKeyBase64: loadedKey } = useBoard(boardId);
  const [showForm, setShowForm] = useState(false);
  const [titleInput, setTitleInput] = useState('');

  const currentKey = loadedKey || boardKeyBase64;

  return (
    <div className="column-content">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h1 style={{ fontSize: '20px' }}>板: {boardId}</h1>
        <button className="btn" style={{ fontSize: '12px' }} onClick={() => setShowForm(true)}>新スレを立てる</button>
      </div>

      {showForm && (
        <div className="card" style={{ marginBottom: '20px' }}>
          <h3>新規スレッド作成</h3>
          <div className="input-group" style={{ marginTop: '15px' }}>
            <textarea
              placeholder="スレッドタイトル..."
              rows={2}
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              disabled={isSubmitting}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
              <button className="btn" onClick={() => setShowForm(false)} disabled={isSubmitting}>中止</button>
              <button
                className="btn"
                disabled={isSubmitting || !titleInput.trim()}
                onClick={() => submitThread(titleInput)}
              >
                作成
              </button>
            </div>
            {isSubmitting && (
              <div style={{ marginTop: '10px' }}>
                <div style={{ fontSize: '11px', color: 'var(--accent)' }}>PoW計算中...</div>
                <div style={{ background: '#333', height: '4px', width: '100%' }}>
                  <div style={{ background: 'var(--accent)', height: '100%', width: `${powProgress}%`, transition: 'width 0.2s' }}></div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div>
        {status && <div style={{ color: 'var(--text-dim)', padding: '20px 0' }}>{status}</div>}

        {threads.map((t: ThreadMeta) => {
          const url = `#board=${boardId}&thread=${t.thread_id}${currentKey ? `&key=${currentKey}` : ''}`;
          const heat = Math.floor(t.max_pow || 0);
          const score = ThreadRanker.calculateScore(t.max_pow || 0, t.created_at);

          return (
            <a
              key={t.thread_id}
              href={url}
              className="card"
              style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', textDecoration: 'none', color: 'inherit', marginBottom: '10px' }}
            >
              <div>
                <div style={{ fontWeight: 700, fontSize: '14px', marginBottom: '4px' }}>{t.content}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                  {new Date(t.created_at).toLocaleString()} | ID:{t.thread_id.substring(0, 8)} | Heat: {heat}
                </div>
              </div>
              <div style={{ fontSize: '18px', fontWeight: 900, color: 'var(--accent)', opacity: 0.7 }}>
                {score > 0.1 ? score.toFixed(1) : '0.1'}
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
