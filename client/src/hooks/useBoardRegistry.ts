'use client';

import { useState, useEffect, useCallback } from 'react';

export interface BoardEntry {
  boardId: string;
  keyB64: string;       // Base64 encoded board key (empty for well-known boards)
  label: string;        // Display name
  createdAt: number;
  isDefault?: boolean;  // true for standard boards
}

const STORAGE_KEY = 'aether_board_registry';

/**
 * Standard (well-known) boards.
 * Keys are derived from deterministic seeds, so keyB64 is empty.
 * All seeds follow the pattern: AETHER_LITE_{BOARDID}_DEFAULT_SEED
 */
export const DEFAULT_BOARDS: BoardEntry[] = [
  {
    boardId: 'terminal',
    keyB64: '',
    label: 'Terminal',
    createdAt: 0,
    isDefault: true,
  },
  {
    boardId: 'vip',
    keyB64: '',
    label: 'VIP',
    createdAt: 0,
    isDefault: true,
  },
  {
    boardId: 'news',
    keyB64: '',
    label: 'Breaking News',
    createdAt: 0,
    isDefault: true,
  },
  {
    boardId: 'tech',
    keyB64: '',
    label: 'Tech & Dev',
    createdAt: 0,
    isDefault: true,
  },
  {
    boardId: 'entertainment',
    keyB64: '',
    label: 'Entertainment',
    createdAt: 0,
    isDefault: true,
  },
];

/**
 * Derive a deterministic key for a well-known board.
 * Uses: SHA-256( "AETHER_LITE_{BOARDID}_DEFAULT_SEED" )[0..32]
 */
export function getDefaultBoardSeed(boardId: string): string {
  return `AETHER_LITE_${boardId.toUpperCase()}_DEFAULT_SEED`;
}

/**
 * Check if a boardId is a well-known default board.
 */
export function isDefaultBoard(boardId: string): boolean {
  return DEFAULT_BOARDS.some(b => b.boardId === boardId);
}

function loadRegistry(): BoardEntry[] {
  if (typeof window === 'undefined') return [...DEFAULT_BOARDS];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULT_BOARDS];
    const parsed: BoardEntry[] = JSON.parse(raw);
    // Ensure all default boards are present (merge)
    const merged = [...DEFAULT_BOARDS];
    for (const entry of parsed) {
      if (!merged.some(b => b.boardId === entry.boardId)) {
        merged.push(entry);
      }
    }
    return merged;
  } catch {
    return [...DEFAULT_BOARDS];
  }
}

function saveRegistry(entries: BoardEntry[]) {
  if (typeof window === 'undefined') return;
  // Only save non-default boards (defaults are always injected)
  const userBoards = entries.filter(b => !b.isDefault);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(userBoards));
}

export function useBoardRegistry() {
  const [boards, setBoards] = useState<BoardEntry[]>([...DEFAULT_BOARDS]);

  useEffect(() => {
    setBoards(loadRegistry());
  }, []);

  const registerBoard = useCallback((boardId: string, keyB64: string, label?: string) => {
    setBoards(prev => {
      if (prev.some(b => b.boardId === boardId)) return prev; // already registered
      const newEntry: BoardEntry = {
        boardId,
        keyB64,
        label: label || `ZONE_${boardId.substring(0, 6).toUpperCase()}`,
        createdAt: Date.now(),
      };
      const updated = [...prev, newEntry];
      saveRegistry(updated);
      return updated;
    });
  }, []);

  const removeBoard = useCallback((boardId: string) => {
    if (isDefaultBoard(boardId)) return; // Default boards cannot be removed
    setBoards(prev => {
      const updated = prev.filter(b => b.boardId !== boardId);
      saveRegistry(updated);
      return updated;
    });
  }, []);

  return { boards, registerBoard, removeBoard };
}
