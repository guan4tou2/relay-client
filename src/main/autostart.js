// 開機自動啟動（登入項目）。
const fs = require('fs');
const { app } = require('electron');
const platform = require('../platform').current;
const { addLog } = require('./log');

// 開機自動啟動（Windows 登入項目）。可攜版須指回外層 exe（PORTABLE_EXECUTABLE_FILE），
// 否則會登記到 %TEMP% 的解壓路徑，重開機後失效。
function appLaunchPath() { return platform.autostart.launchPath(); }
// 舊名字（productName 改名前）留下的登入項目也算數 —— 否則設定頁顯示「關」，
// OS 每次登入卻照樣去啟動舊的那顆，而且使用者從這個開關永遠關不掉。
// 查舊登入項目要跑一次 PowerShell（冷啟動約 300ms）。同步做的話主行程就凍住
// 那麼久，而 renderer 一開機就會問「開機自動啟動」開著沒有 —— 等於每次啟動
// 都固定卡一下。一律走非同步版，沒有非同步版才退回同步的。
const legacyLoginItems = () => (platform.autostart.listLegacyAsync
  ? platform.autostart.listLegacyAsync()
  : Promise.resolve(platform.autostart.listLegacy ? platform.autostart.listLegacy() : []));
const clearLegacyLoginItems = (names) => (platform.autostart.clearLegacyAsync
  ? platform.autostart.clearLegacyAsync(names)
  : Promise.resolve(platform.autostart.clearLegacy ? platform.autostart.clearLegacy(names) : 0));

// 啟動時清掉「指向已不存在的檔案」的舊登入項目。那種一定是垃圾（檔案都沒了，
// 開機時 OS 也只會安靜地失敗），收掉不會動到任何還有用的設定。
// 還指得到檔案的就留著 —— 那代表使用者真的有設過，交給上面的開關處理。
// 非同步，而且不擋啟動：這件事一年也用不到一次，沒有理由讓它排在
// 「使用者看到視窗」前面。原本是同步跑 PowerShell，等於每次啟動固定多 300ms。
async function sweepDeadLegacyLoginItems() {
  try {
    if (!platform.autostart.entryTarget) return;
    const dead = (await legacyLoginItems()).filter(it => {
      const target = platform.autostart.entryTarget(it.data);
      return target && !fs.existsSync(target);   // 解析不出路徑就不動它
    });
    if (!dead.length) return;
    await clearLegacyLoginItems(dead.map(d => d.name));
    addLog('info', 'system', `清掉 ${dead.length} 筆失效的舊開機啟動項目（指向已刪除的檔案）`);
  } catch (e) { /* 清不掉不影響啟動 */ }
}

function registerIpc(ipcMain) {
  ipcMain.handle('get-login-item', async () => {
    try {
      if (!platform.autostart.usesElectronLoginItem) return platform.autostart.get();
      if (app.getLoginItemSettings({ path: appLaunchPath() }).openAtLogin) return true;
      return (await legacyLoginItems()).length > 0;
    } catch (e) { return false; }
  });
  ipcMain.handle('set-login-item', async (_e, enable) => {
    try {
      // Electron 的 setLoginItemSettings 在 Linux 沒有實作 → adapter 自己寫 XDG autostart .desktop
      if (!platform.autostart.usesElectronLoginItem) return platform.autostart.set(!!enable);
      app.setLoginItemSettings({ openAtLogin: !!enable, path: appLaunchPath(), args: [] });
      // 開或關都把舊名字那一筆收掉：開的時候避免同時存在兩筆（會開兩個實例），
      // 關的時候使用者要的就是「別再自動啟動」，不能只關掉新的那一筆。
      await clearLegacyLoginItems();
      return { ok: true, enabled: !!enable };
    } catch (e) { addLog('error', 'system', `set-login-item failed: ${e.message}`); return { ok: false, error: e.message }; }
  });
}

// 逐一掛在 module.exports 上、不重設它：模組之間互相 require（例如 engine ↔ killswitch），
// 重設的話先載入的那一方會拿到空物件。這種寫法 TypeScript（npm run typecheck）也推得出型別。
module.exports.sweepDeadLegacyLoginItems = sweepDeadLegacyLoginItems;
module.exports.registerIpc = registerIpc;
