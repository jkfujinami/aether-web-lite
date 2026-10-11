import { describe, it, expect, vi, beforeEach } from 'vitest';

/** electron モジュールの代わり。preload が公開したものと登録したリスナを記録する */
const exposed: Record<string, any> = {};
const listeners = new Map<string, Set<(...args: any[]) => void>>();

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => { exposed[key] = api; },
  },
  ipcRenderer: {
    on: (channel: string, fn: (...args: any[]) => void) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)!.add(fn);
    },
    removeListener: (channel: string, fn: (...args: any[]) => void) => {
      listeners.get(channel)?.delete(fn);
    },
  },
}));

function emit(channel: string, ...args: unknown[]) {
  for (const fn of listeners.get(channel) ?? []) fn({}, ...args);
}

describe('Electron preload', () => {
  beforeEach(async () => {
    vi.resetModules();
    for (const k of Object.keys(exposed)) delete exposed[k];
    listeners.clear();
    await import('../electron/preload');
  });

  it('レンダラーへ公開するのは electronAPI だけで、ipcRenderer そのものは渡さない', () => {
    expect(Object.keys(exposed)).toEqual(['electronAPI']);
    const api = exposed.electronAPI;
    expect(Object.keys(api).sort()).toEqual(['isElectron', 'onCommand', 'platform']);
    for (const v of Object.values(api)) {
      expect(v).not.toHaveProperty('send');
      expect(v).not.toHaveProperty('invoke');
    }
  });

  it('トレイからの操作は lock と panic-wipe の 2 種類だけを通す', () => {
    const cb = vi.fn();
    exposed.electronAPI.onCommand(cb);
    emit('aether:command', 'lock');
    emit('aether:command', 'panic-wipe');
    emit('aether:command', 'rm -rf');
    emit('aether:command', { toString: () => 'lock' });
    emit('aether:command');
    expect(cb.mock.calls).toEqual([['lock'], ['panic-wipe']]);
  });

  it('解除関数を呼ぶと以後は受け取らない', () => {
    const cb = vi.fn();
    const off = exposed.electronAPI.onCommand(cb);
    off();
    emit('aether:command', 'lock');
    expect(cb).not.toHaveBeenCalled();
    expect(listeners.get('aether:command')?.size ?? 0).toBe(0);
  });
});
