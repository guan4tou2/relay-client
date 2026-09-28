// 主行程進入點：只負責啟動順序、單一實例、結束清理。
// 各功能的狀態與 IPC 在 src/main/ 底下（log / window / system-proxy / servers / routes /
// launcher / engine / killswitch / rulesets / autostart / updater），共用狀態在 src/main/state.js。
const { app, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
// 一次性搬遷：舊 userData（開發代號 socks5-client）→ 現在的 app 名 RelayClient，
// 讓更名後不遺失既有 config（servers / routes / settings）。只在新位置尚無 config 時搬。
(function migrateLegacyUserData() {
  try {
    const newDir = app.getPath('userData');
    const oldDir = path.join(app.getPath('appData'), 'socks5-client');
    if (path.resolve(newDir) === path.resolve(oldDir)) return; // 名字沒變就免搬
    const newCfg = path.join(newDir, 'config.json');
    const oldCfg = path.join(oldDir, 'config.json');
    if (!fs.existsSync(newCfg) && fs.existsSync(oldCfg)) {
      fs.mkdirSync(newDir, { recursive: true });
      fs.copyFileSync(oldCfg, newCfg);
    }
  } catch (e) { /* 搬遷失敗就沿用預設，不影響啟動 */ }
})();

const config = require('./src/store/config');
const platform = require('./src/platform').current;  // 平台差異一律走 adapter，main 不做 process.platform 判斷
const { state, sleepSync } = require('./src/main/state');
const log = require('./src/main/log');
const { addLog } = log;
const win = require('./src/main/window');
const systemProxy = require('./src/main/system-proxy');
const servers = require('./src/main/servers');
const routes = require('./src/main/routes');
const launcher = require('./src/main/launcher');
const engineMod = require('./src/main/engine');
const ks = require('./src/main/killswitch');
const rulesets = require('./src/main/rulesets');
const autostart = require('./src/main/autostart');
const updater = require('./src/main/updater');

// 全域例外攔截：任何未捕捉錯誤都寫進 crash log（不要讓 app 直接死）。
process.on('uncaughtException', (err) => log.writeCrashLog('uncaughtException', err));
process.on('unhandledRejection', (reason) => log.writeCrashLog('unhandledRejection', reason));

for (const m of [log, win, systemProxy, servers, routes, launcher, engineMod, ks, rulesets, autostart, updater]) m.registerIpc(ipcMain);

ipcMain.handle('get-settings', () => config.getSettings());
ipcMain.handle('update-settings', (_e, updates) => {
  const before = config.getSettings();
  const saved = config.updateSettings(updates);
  if (updates && 'logConnections' in updates) log.setLogPersistDebug(updates.logConnections);
  // 斷線保護的開關與範圍變了 → 防火牆層跟著布防／解除
  const ksKey = st => JSON.stringify([!!st.killSwitch, st.killSwitchScope, st.killSwitchApps || []]);
  if (ksKey(before) !== ksKey(saved)) ks.syncKsFirewall();
  return saved;
});

// App 版本資訊（誠實版：取代先前假的「檢查更新」按鈕）
ipcMain.handle('get-app-info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
}));

// 單一實例鎖。除了避免兩個實例搶同一組本地埠，也是安裝程式能請我們「好好結束」的通道：
// NSIS 安裝前會跑 "RelayClient.exe --quit"，那個新實例拿不到鎖，
// 意圖會經由 second-instance 轉給正在執行的這個，走完整的 app.quit()（移除 TUN、還原系統代理）。
// 不讓安裝程式 taskkill /F 的理由就在這——強殺會跳過清理，使用者裝完會發現上不了網。
//
// 提權重啟進來的實例（帶 --engine-autostart）要肯等：舊實例是「先把我們拉起來，
// 700ms 後才自己退場」，我們比它早一步問鎖就拿不到 → app.exit(0) → 兩邊都退場，
// 使用者按下「啟動分流引擎」會看到整個 app 直接消失。
//
// 這不是「一定會發生」，是會飄的競態：實測讓舊實例分別在新實例啟動後
// 1295ms / 1700ms / 2129ms 退場，結果是 活 / 死 / 活 —— 新實例問鎖的時刻
// 剛好落在同一個區間，誰先誰後看當下的磁碟快取與負載。
// 所以這裡不是把延遲調大就好，要真的重試到拿得到為止。
function acquireSingleInstanceLock() {
  if (app.requestSingleInstanceLock()) return true;
  // 只有提權重啟這條路要等；一般情況下「已經有實例在跑」就是該退場。
  if (!process.argv.includes('--engine-autostart')) return false;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    sleepSync(250);
    if (app.requestSingleInstanceLock()) return true;
  }
  return false;
}

// 結束請求的備援通道：userData 底下的一個檔案。
//
// 為什麼需要它：second-instance 那條路走的是視窗訊息，而 Windows 的 UIPI
// 不讓低完整性的行程送訊息給高完整性的行程。分流引擎一開，app 就是提權的，
// 於是安裝程式（一般權限）的 "RelayClient.exe --quit" 根本到不了 ——
// 實測確認過。安裝程式因此會在「app 還開著、TUN 還在、系統代理還開著」
// 的情況下繼續裝，裝完使用者就上不了網。檔案沒有這個限制。
const QUIT_SENTINEL = () => path.join(app.getPath('userData'), 'quit-request');
function requestQuitViaFile() {
  try { fs.writeFileSync(QUIT_SENTINEL(), String(Date.now())); return true; } catch (e) { return false; }
}
function watchQuitSentinel() {
  try { fs.unlinkSync(QUIT_SENTINEL()); } catch (e) {}   // 開機先清掉上一輪留下的（沒對象的請求）
  setInterval(() => {
    try {
      if (!fs.existsSync(QUIT_SENTINEL())) return;
      fs.unlinkSync(QUIT_SENTINEL());
      addLog('info', 'system', '收到結束請求（檔案通道）');
      app.quit();
    } catch (e) {}
  }, 800).unref();
}

const gotSingleInstanceLock = acquireSingleInstanceLock();
if (process.argv.includes('--quit')) {
  // 兩條路都走：拿不到鎖時 requestSingleInstanceLock 已經把意圖送給執行中的實例了
  // （同完整性等級才到得了），檔案通道則是提權實例唯一收得到的那條。
  // 沒有任何實例在跑的話，檔案會留著，由下一次啟動清掉。
  requestQuitViaFile();
  app.exit(0);
} else if (!gotSingleInstanceLock) {
  // 拿不到鎖通常就是「已經有一個在跑」，Electron 會把既有視窗叫出來，安靜退場即可。
  // 但也可能是「被強制結束的殭屍主行程還握著鎖」—— 那種情況下使用者點圖示
  // 不會有任何反應，也不會有任何訊息，只會以為 app 壞了。只在「找不到任何
  // 活著的同伴」時才出聲，正常的重複啟動不受影響。
  try {
    if (platform.liveMainInstances && platform.liveMainInstances() <= 1) {
      dialog.showErrorBox('RelayClient 無法啟動',
        '偵測到先前的 RelayClient 被強制結束，殘留的行程還佔著單一實例鎖，'
        + '但它已經沒有在運作了。\n\n請等一下再試，或到工作管理員把殘留的 RelayClient 結束後重開。');
    }
  } catch (e) {}
  app.exit(0);   // 用 exit 不用 quit：這個實例什麼都還沒起，不需要跑清理
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--quit')) { addLog('info', 'system', '收到結束請求（安裝程式或外部呼叫）'); app.quit(); return; }
    win.showMainWindow();   // 使用者重複點捷徑 → 把既有視窗叫出來
  });
}

// 主行程的開機時間點。跟 renderer 那組（window.__boot）配起來看，才分得出
// 「首屏慢」是 renderer 自己慢，還是主行程忙著別的、IPC 排不進去。
const mainMarks = { t0: Date.now() };
const mainMark = (k) => { mainMarks[k] = Date.now() - mainMarks.t0; };
ipcMain.handle('perf-marks', () => mainMarks);

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  mainMark('ready');
  log.initFileLog();
  mainMark('fileLog');
  servers.initSecretStorage();          // 要在任何路由啟動（會讀伺服器密碼）之前
  ks.serialFw(ks.cleanupStaleKsFirewall).catch(() => {});   // 排在任何布防之前（同一條序列）
  const routeIdsFixed = config.migrateRouteIds();
  if (routeIdsFixed) addLog('info', 'route', `已修正 ${routeIdsFixed} 條路由的 id／類型（舊版匯入留下的格式）`);
  const tlsMigrated = config.migrateTlsDefaults();
  if (tlsMigrated) addLog('warn', 'system', `${tlsMigrated} 台 HTTPS 伺服器沿用舊版行為：不驗證代理的憑證。可在伺服器設定關閉「略過憑證驗證」`);
  if (config.recoveredFrom()) {
    addLog('error', 'system', '設定檔損毀，已改用預設值重建', `損毀的檔案保留在：${config.recoveredFrom()}`);
  }
  win.createWindow();
  mainMark('window');
  win.createTray();
  mainMark('tray');

  const settings = config.getSettings();
  mainMark('settings');

  // 啟動 config 中定義的多端口路由（各自綁定 proxy/串鏈）
  // 受「啟動時自動套用路由」開關控制（settings.autoStartRoutes，預設開）
  // 系統代理的實際狀態：路由起完之後才判斷，指向的路由沒起來就關掉（見 reconcileSystemProxy）
  const afterRoutes = () => { systemProxy.syncSystemProxyFromOS(); systemProxy.reconcileSystemProxy(); systemProxy.sendSystemProxyState(); win.updateTrayMenu(); };
  if (settings.autoStartRoutes !== false) {
    routes.applyRoutes().then(() => mainMark('routesApplied')).catch(err => addLog('error', 'route', err.message)).finally(afterRoutes);
  } else {
    routes.setupRouteManager(); // 仍建立 route manager（只是不自動起路由），避免其他路徑存取 null
    addLog('info', 'route', '「啟動時自動套用路由」已關閉，略過自動啟動（可到「總覽」手動啟用）');
    afterRoutes();
  }

  // 若是「用到才提權」重啟進來的（帶 --engine-autostart），提權後自動把分流引擎帶起來
  if (process.argv.includes('--engine-autostart')) {
    setTimeout(() => engineMod.autoStartEngineElevated().catch(err => addLog('error', 'engine', err.message)), 1800);
  }

  watchQuitSentinel();         // 結束請求的備援通道（提權時 UIPI 擋掉視窗訊息，只剩這條）
  // 這兩件事都不急，也都會 spawn 子行程 —— 排在視窗畫出來之後，不要擋啟動
  setTimeout(() => { autostart.sweepDeadLegacyLoginItems().catch(() => {}); }, 3000);
  updater.checkUpdatesOnStartup(); // 啟動後靜默檢查更新（僅安裝版）
  updater.sweepStaleUpdateCache();  // 更新裝完之後 pending 會留著上百 MB 的安裝檔
  // 規則庫自動更新（預設關閉；開啟時才連網，延後執行避免拖慢啟動）
  setTimeout(() => rulesets.maybeAutoUpdateRuleSets().catch(err => addLog('warn', 'ruleset', err.message)), 8000);
  mainMark('readyDone');
});


app.on('window-all-closed', () => {
  // minimizeToTray 關閉時：關窗＝結束整個 app（否則視窗被銷毀但行程還在 → 匣點擊會開不出來）。
  if (!config.getSettings().minimizeToTray) app.quit();
  // 開啟時：保留在系統匣背景執行。
});

// Electron 不會 await before-quit 的 async handler，所以先擋下結束、把清理做完再真正退出。
// 特別是要讓 engine.stop() 有時間移除 TUN、systemProxy.disable() 一定要跑到（否則結束後上不了網）。
app.on('before-quit', (e) => {
  log.flushLog();                                         // 批次寫入：結束前把還沒落地的行寫完
  if (state.quitting) return;                              // 第二次進來（清理已完成）→ 放行結束
  state.quitting = true;
  e.preventDefault();
  const force = setTimeout(() => app.exit(0), 8000);  // 保險：清理逾時也一定結束
  ks.resetKillSwitch();                                  // 重試計時器在清理途中觸發會重新拉起 sing-box
  (async () => {
    // 系統代理最先還原：它是同步的、很快，而且漏掉的代價最大（整台機器上不了網）。
    // 放在最後的話，Windows 上引擎收尾最壞要 7 秒多，加上中繼的 2 秒就會撞到 8 秒的強制結束。
    if (systemProxy.isEnabled()) systemProxy.restoreSystemProxy();
    try { const engine = engineMod.getEngine(); if (engine) await engine.stop(); } catch (err) {}          // 再關引擎 → 讓 sing-box 移除 TUN
    // 防火牆層：引擎關了就要拆，否則結束 app 之後受保護的程式永遠連不出去
    try { await ks.disarmFirewall(); } catch (err) {}
    try { const rm = routes.getRouteManager(); if (rm) await rm.stopAll(); } catch (err) {}
  })().finally(() => { clearTimeout(force); app.exit(0); });
});

