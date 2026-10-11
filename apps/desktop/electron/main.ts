import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain } from 'electron';
import path from 'node:path';

const APP_ROOT = app.getAppPath();
const RENDERER_DIST = path.join(APP_ROOT, 'dist');
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

function createTrayIcon(): Electron.NativeImage {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4, 0);
  for (let i = 0; i < size * size; i++) {
    buffer[i * 4] = 99;     // R
    buffer[i * 4 + 1] = 102; // G
    buffer[i * 4 + 2] = 241; // B
    buffer[i * 4 + 3] = 255; // A
  }
  return nativeImage.createFromBuffer(buffer, { width: size, height: size });
}

function createTray() {
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('AETHER Desktop Node');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'AETHER を表示',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: 'キャッシュノード: 稼働中',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '終了 (Quit)',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: true,
    title: 'AETHER Desktop',
    backgroundColor: '#020617', // slate-950
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false, // バックグラウンドでもWebRTC/タイマーを維持
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // レンダラープロセスのコンソール出力をターミナルに流す
  mainWindow.webContents.on('console-message', (_event, _level, message, line, sourceId) => {
    console.log(`[Renderer] ${message} (${sourceId}:${line})`);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`[Load Error] ${errorCode}: ${errorDescription}`);
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  const indexPath = path.join(RENDERER_DIST, 'index.html');
  console.log('[Main] Loading UI from:', VITE_DEV_SERVER_URL || indexPath);

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(indexPath);
  }

  // macOS で確実に前面に表示
  mainWindow.show();
  mainWindow.focus();
}

// Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else {
        mainWindow?.show();
        mainWindow?.focus();
      }
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });
}
