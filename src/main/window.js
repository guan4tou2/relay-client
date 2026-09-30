// 主視窗與系統匣。
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const config = require('../store/config');
const { state } = require('./state');
const systemProxy = require('./system-proxy');

const ROOT = path.join(__dirname, '..', '..');   // app 根目錄（assets/、preload.js 在這層）

function createWindow() {
  state.mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 800,
    minHeight: 550,
    frame: false,
    backgroundColor: '#f2f2f7',
    icon: path.join(ROOT, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true // preload 僅用 contextBridge/ipcRenderer，可在 sandbox 下運作
    }
  });

  state.mainWindow.loadFile('renderer/index.html');

  // 安全性：本 app 只載入本地頁面 → 擋掉所有新視窗開啟與離開本頁的導覽，
  // 避免被注入內容導向外部 URL 後在 app context 執行（縱深防禦）。
  state.mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  state.mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  state.mainWindow.on('close', (e) => {
    const settings = config.getSettings();
    if (settings.minimizeToTray) {
      e.preventDefault();
      state.mainWindow.hide();
    }
  });
}

function createTrayIcon(active = false) {
  // 用 PNG（SVG data URL 在 Windows nativeImage 不 render）。
  // 關鍵：createFromPath 讀不到 asar 封裝內的檔（回傳空圖）→ 用 fs.readFileSync（asar-aware）
  // 讀成 buffer 再 createFromBuffer，才能在打包後正常顯示 tray icon。
  const files = [active ? 'tray-active.png' : 'tray.png', 'tray.png', 'icon.png'];
  for (const f of files) {
    try {
      const buf = fs.readFileSync(path.join(ROOT, 'assets', f));
      const img = nativeImage.createFromBuffer(buf);
      if (img && !img.isEmpty()) return img;
    } catch (e) { /* try next */ }
  }
  return nativeImage.createEmpty();
}

function createTray() {
  const icon = createTrayIcon(false);
  state.tray = new Tray(icon);
  updateTrayMenu();
  state.tray.setToolTip('RelayClient');
  state.tray.on('double-click', () => showMainWindow());
}

function updateTrayMenu() {
  if (!state.tray) return;   // 匣還沒建好就被呼叫（啟動早期 / 測試）——下面每一行都要 tray
  const port = systemProxy.systemProxyPort();
  const proxyOn = systemProxy.isEnabled();
  state.tray.setImage(createTrayIcon(!!port));
  const menu = Menu.buildFromTemplate([
    { label: 'RelayClient', enabled: false },
    { type: 'separator' },
    {
      label: port ? `⬤ 路由執行中 · 127.0.0.1:${port}` : '○ 沒有路由在跑',
      enabled: false
    },
    {
      label: proxyOn ? '關閉系統代理' : '啟用系統代理',
      // 沒有路由在跑就不給開——跟主視窗那句「請先啟動路由」是同一個規則
      enabled: proxyOn || !!port,
      click: () => systemProxy.toggleFromTray(),
    },
    { type: 'separator' },
    {
      label: '顯示主視窗',
      click: () => showMainWindow()
    },
    {
      label: '結束',
      click: () => app.quit() // 走 before-quit 做完整清理（引擎 / 路由 / 系統代理），別用 app.exit 跳過
    }
  ]);
  state.tray.setContextMenu(menu);
}

// 顯示主視窗：若視窗已被銷毀（minimizeToTray 關閉時關窗會銷毀它）就重建，避免 show() 一個已銷毀物件而拋錯。
function showMainWindow() {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) createWindow();
  else { state.mainWindow.show(); state.mainWindow.focus(); }
}

function registerIpc(ipcMain) {
  // Window controls
  ipcMain.handle('window-minimize', () => state.mainWindow.minimize());
  ipcMain.handle('window-maximize', () => {
    if (state.mainWindow.isMaximized()) state.mainWindow.unmaximize();
    else state.mainWindow.maximize();
  });
  ipcMain.handle('window-close', () => state.mainWindow.close());
}

// 逐一掛在 module.exports 上、不重設它：模組之間互相 require（例如 engine ↔ killswitch），
// 重設的話先載入的那一方會拿到空物件。這種寫法 TypeScript（npm run typecheck）也推得出型別。
module.exports.createWindow = createWindow;
module.exports.showMainWindow = showMainWindow;
module.exports.createTray = createTray;
module.exports.updateTrayMenu = updateTrayMenu;
module.exports.registerIpc = registerIpc;
