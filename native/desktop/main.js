'use strict';

const { app, BrowserWindow, shell } = require('electron');

function serverUrl() {
  const raw = String(process.env.VCHAT_SERVER_URL || '').trim();
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '');
  return 'http://127.0.0.1:3000';
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 420,
    minHeight: 640,
    backgroundColor: '#071428',
    autoHideMenuBar: true,
    webPreferences: {
      preload: require('path').join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const url = serverUrl();
  win.loadURL(url, {
    userAgent: `${win.webContents.getUserAgent()} VChatNative/1.0 Desktop`,
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
