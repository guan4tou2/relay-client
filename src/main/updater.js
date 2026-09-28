// 自動更新（electron-updater → GitHub Releases）。
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const updateCache = require('../update-cache');
const { send } = require('./state');
const { addLog } = require('./log');

// 延遲載入：electron-updater 一 require 就會實例化並呼叫 app.getVersion()，
// 在非 Electron 環境（單元測試 require main.js）會炸。故只在實際用到時才載入。
let autoUpdater = null;
function sendUpdateStatus(payload) {
  send('update-status', payload);
}
function ensureAutoUpdater() {
  if (autoUpdater) return autoUpdater;
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = false;         // 讓使用者決定何時下載
  autoUpdater.autoInstallOnAppQuit = true;  // 下載後於結束時安裝
  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => sendUpdateStatus({ status: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => sendUpdateStatus({ status: 'none' }));
  autoUpdater.on('error', (err) => { addLog('error', 'update', String((err && err.message) || err)); sendUpdateStatus({ status: 'error', error: String((err && err.message) || err) }); });
  autoUpdater.on('download-progress', (p) => sendUpdateStatus({ status: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => { addLog('info', 'update', `更新已下載 v${info.version}，將於結束時安裝`); sendUpdateStatus({ status: 'downloaded', version: info.version }); });
  return autoUpdater;
}

// 啟動時靜默檢查（僅安裝版；失敗不擾民）
function checkUpdatesOnStartup() {
  if (!app.isPackaged) return;
  // 沒有 app-update.yml 就代表這不是安裝版（--dir 打包出來的、或可攜版解壓後）。
  // 少了這個判斷，每次啟動都會在紀錄裡留一則紅色的 ENOENT —— 看起來像壞了，
  // 其實只是「這種包本來就不支援自動更新」。
  try { if (!fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return; } catch (e) { return; }
  setTimeout(() => { try { ensureAutoUpdater().checkForUpdates().catch(() => {}); } catch (e) {} }, 4000);
}

// 更新裝完之後，pending 底下那支一百多 MB 的安裝檔會一直留著。
// 實測過它不會害使用者「關掉 app 又裝一次」——下次啟動檢查到已是最新版，
// 就不會把它排進 will-quit 的安裝流程 —— 但一直佔著磁碟也沒有道理。
function sweepStaleUpdateCache() {
  try {
    if (!app.isPackaged) return;
    const dir = updateCache.cacheDirFrom(
      path.join(process.resourcesPath, 'app-update.yml'), process.env.LOCALAPPDATA);
    const removed = updateCache.clearStaleUpdateCache(dir, app.getVersion());
    if (removed.length) addLog('info', 'update', `清掉已安裝完成的更新快取（${removed.length} 個檔案）`);
  } catch (e) { /* 清不掉不影響任何功能 */ }
}

function registerIpc(ipcMain) {
  ipcMain.handle('check-for-updates', async () => {
    if (!app.isPackaged) return { ok: false, error: '開發模式不檢查更新（需安裝版）' };
    try { const r = await ensureAutoUpdater().checkForUpdates(); return { ok: true, version: r && r.updateInfo && r.updateInfo.version }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('download-update', async () => {
    try { await ensureAutoUpdater().downloadUpdate(); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('quit-and-install', () => { try { ensureAutoUpdater().quitAndInstall(); } catch (e) {} });
}

// 用 Object.assign 而不是重設 module.exports：模組之間互相 require（例如 engine ↔ killswitch），
// 重設的話先載入的那一方會拿到空物件。
Object.assign(module.exports, { checkUpdatesOnStartup, sweepStaleUpdateCache, registerIpc });
