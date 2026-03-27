'use client';

import { useAether } from '@/context/AetherContext';
import { KeyManager } from '@/lib/aether/crypto/KeyManager';
import { PacketBuilder } from '@/lib/aether/crypto/PacketBuilder';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { navigateWithHash } from '@/hooks/useHashParams';

interface Props {
  boardId: string;
  boardKey: Uint8Array;
  isOpen: boolean;
  onClose: () => void;
}

export function CreateThreadModal({ boardId, boardKey, isOpen, onClose }: Props) {
  const { identity, cryptoEngine, powEngine, keyManager, zm, router: p2pRouter, mailbox, db } = useAether();
  const [title, setTitle] = useState('');
  const [isPosting, setIsPosting] = useState(false);
  const [progress, setProgress] = useState(0);
  const router = useRouter();

  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  const handleSubmit = async () => {
    if (!title.trim() || !identity || !cryptoEngine || !powEngine || !keyManager || !zm || !p2pRouter || !mailbox || !db) return;
    setIsPosting(true);
    setProgress(30);
    try {
      const threadId = Math.random().toString(36).substring(2, 12);
      const threadKey = KeyManager.deriveThreadKey(boardKey, threadId);
      const threadTopicHash = KeyManager.deriveTopicHash(threadKey);
      const currentZoneId = KeyManager.computeZoneId(threadTopicHash, zm.depth);
      const packet = await PacketBuilder.build(title, boardKey, identity, cryptoEngine, powEngine, keyManager, boardId, threadId, 0, null, 10, currentZoneId, 1);
      setProgress(100);
      await p2pRouter.broadcast(packet);
      const boardTopicHash = KeyManager.toHex(KeyManager.cryptoHash(boardKey));
      const raw = new TextEncoder().encode(JSON.stringify(packet, (_k, v) => (v instanceof Uint8Array ? { _type: 'Uint8Array', data: Array.from(v) } : v)));
      mailbox.publish(boardTopicHash, raw).catch(console.error);
      await db.save({ boardId, threadId: '__board_meta__', payload: raw, dag: { thread_root: threadId, cumulative_pow: 10 } });
      setTitle(''); setIsPosting(false); setProgress(0); onClose();
      navigateWithHash('/', { board: boardId, key: KeyManager.toBase64(boardKey), thread: threadId });
    } catch (err) { alert('Failed to archive: ' + err); setIsPosting(false); }
  };

  if (!isOpen) return null;

  return (
    <div 
      className="fixed inset-0 bg-[rgba(45,52,51,0.1)] backdrop-blur-[20px] flex items-center justify-center z-[1000]"
      onClick={onClose}
    >
      <div 
        className="bg-[#F9F9F8] border-[0.5px] border-[rgba(173,179,178,0.15)] p-[26px] w-[600px] max-w-[90%] flex flex-col gap-[26px]" 
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[11px] uppercase tracking-[0.2em] text-[rgba(45,52,51,0.6)] font-light">INITIALIZE_ARCHIVE</h2>
        
        <div className="flex flex-col gap-[13px]">
          <textarea 
            autoFocus
            className="w-full bg-white border-[0.5px] border-[rgba(173,179,178,0.15)] p-[13px] text-[14px] min-h-[100px] font-['Space_Grotesk'] focus:outline-none focus:border-[#4A90E2]"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={isPosting}
            placeholder="Archive Title..." 
          />
          <div className="flex justify-end gap-[26px] items-center">
            <button 
              className="text-[11px] font-['Space_Mono'] text-[rgba(45,52,51,0.6)] hover:text-black uppercase" 
              onClick={onClose}
            >
              DISCARD
            </button>
            <button 
              className="bg-[#4A90E2] text-white font-['Space_Grotesk'] font-bold text-[11px] uppercase tracking-[0.1em] px-[26px] py-[8px] rounded-[2px] disabled:opacity-50" 
              onClick={handleSubmit} 
              disabled={isPosting || !title.trim()}
            >
              {isPosting ? 'SIGNING...' : 'SIGN & ARCHIVE'}
            </button>
          </div>
          {isPosting && (
            <div className="h-[1px] bg-[rgba(173,179,178,0.15)] w-full overflow-hidden">
              <div className="h-full bg-[#4A90E2] transition-all duration-300" style={{ width: `${progress}%` }} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
