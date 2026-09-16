// electron-updater 的待安裝快取清理。
//
// 為什麼要自己來：更新裝完之後，%LOCALAPPDATA%\<updaterCacheDirName>\pending\
// 底下那支 100 MB 出頭的安裝檔會一直留著。實測過它不會害使用者「關掉 app 又裝一次」
// （下次啟動檢查到已是最新版，就不會把它排進 will-quit 的安裝流程），
// 所以不是功能問題 —— 但一直佔著一百多 MB 也沒有道理。
//
// 抽成獨立模組是為了測得到：main.js 在 Electron 外面 require 不動。

const fs = require('fs');
const path = require('path');

// app-update.yml 裡的 updaterCacheDirName 決定快取目錄叫什麼。
// 讀不到就回 null —— 寧可不清，也不要亂猜一個目錄去刪東西。
function cacheDirFrom(appUpdateYmlPath, localAppData) {
  try {
    const txt = fs.readFileSync(appUpdateYmlPath, 'utf8');
    const m = txt.match(/^updaterCacheDirName:\s*(.+)$/m);
    if (!m || !localAppData) return null;
    const name = m[1].trim().replace(/^["']|["']$/g, '');
    if (!name || /[\\/]/.test(name)) return null;   // 只接受單一層目錄名
    return path.join(localAppData, name);
  } catch (e) { return null; }
}

// 從安裝檔名取版本：RelayClient-Setup-1.3.4.exe → 1.3.4
function versionFromFileName(name) {
  const m = String(name || '').match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

// a <= b ？只比三段數字，比不出來就回 false（＝不清）
function notNewerThan(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  if (pa.length < 3 || pb.length < 3 || pa.concat(pb).some(n => !Number.isFinite(n))) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i];
  }
  return true;   // 完全相同 → 已經裝上去了
}

// 快取根目錄一律不碰，尤其是 installer.exe。
//
// 它看起來最像殘留：跟 pending 裡那支一樣大（各七十幾 MB）、裝完也不會再執行。
// 但 electron-updater 的差分下載就是拿它當基底 ——
//   AppUpdater.differentialDownloadInstaller() 的 oldFile 是
//   path.join(cacheDir, CURRENT_APP_INSTALLER_FILE_NAME)，而那個常數就是 "installer.exe"。
// 沒有它，下一次更新只能整包重抓。
//
// 這一點我連錯兩次，兩次都是「看起來像垃圾就刪」：
//   v1.3.5 把 installer.exe 跟 blockmap 一起刪了。
//   v1.3.6 只補回 blockmap —— 實測 1.3.5 → 1.3.6 仍然整包下載
//          （網卡收到 79.0 MB，檔案 76.8 MB）。
// 真正該刪的只有 pending 裡那支「已經裝完」的安裝檔，它跟 installer.exe
// 是同一份位元組，留著純粹是重複。
const ROOT_LEFTOVERS = [];

// pending 裡的 .blockmap 也留著：不佔空間，而且是更新流程的一部分。
const KEEP_IN_PENDING = (f) => /\.blockmap$/i.test(f);

// 待安裝的那份「不比現在新」就清掉。回傳刪掉的檔名。
// 任何一步判斷不出來都選擇不動手 —— 這裡刪的是別的模組管的檔案。
function clearStaleUpdateCache(cacheDir, currentVersion) {
  const removed = [];
  const sweepRoot = () => {
    // 安裝正在跑的話 installer.exe 會被鎖住，unlink 失敗 —— 那就留著，下次再收。
    for (const f of ROOT_LEFTOVERS) {
      const p = path.join(cacheDir, f);
      try { if (fs.existsSync(p)) { fs.unlinkSync(p); removed.push(f); } } catch (e) {}
    }
  };
  try {
    if (!cacheDir || !currentVersion) return removed;
    const pending = path.join(cacheDir, 'pending');
    const info = path.join(pending, 'update-info.json');
    if (!fs.existsSync(info)) {
      // 連「有沒有待安裝的東西」都沒記錄 → 根目錄那兩個是孤兒，沒有對象了
      if (fs.existsSync(cacheDir)) sweepRoot();
      return removed;
    }

    const fileName = JSON.parse(fs.readFileSync(info, 'utf8')).fileName;
    const pendingVersion = versionFromFileName(fileName);
    if (!pendingVersion) return removed;                       // 看不懂檔名 → 不動
    if (!notNewerThan(pendingVersion, currentVersion)) return removed;  // 比現在新 → 是還沒裝的更新，留著

    for (const f of fs.readdirSync(pending)) {
      if (KEEP_IN_PENDING(f)) continue;
      try { fs.unlinkSync(path.join(pending, f)); removed.push(f); } catch (e) {}
    }
    sweepRoot();
  } catch (e) { /* 清不掉不影響任何功能 */ }
  return removed;
}

module.exports = { cacheDirFrom, versionFromFileName, notNewerThan, clearStaleUpdateCache };
