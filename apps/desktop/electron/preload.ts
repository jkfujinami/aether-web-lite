import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

type Command = 'lock' | 'panic-wipe';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,
  /**
   * トレイからの操作 (ロック / 緊急消去) を受け取る。解除関数を返す。
   * 受け付けるのは決まった 2 種類だけ (それ以外の文字列は捨てる)。
   */
  onCommand: (cb: (command: Command) => void) => {
    const listener = (_event: IpcRendererEvent, command: unknown) => {
      if (command === 'lock' || command === 'panic-wipe') cb(command);
    };
    ipcRenderer.on('aether:command', listener);
    return () => { ipcRenderer.removeListener('aether:command', listener); };
  },
});
