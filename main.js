const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const { connectViaProxy, connectViaChain, tlsOptions, explainTlsError } = require('./src/proxy/connect');
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
const RouteManager = require('./src/proxy/route-manager');   // SocksRelay / HttpBridge 由它持有，main.js 不直接碰
const SingBoxEngine = require('./src/engine/singbox');
const { RuleSetStore } = require('./src/engine/ruleset');
const { HitParser } = require('./src/engine/hit-parser');
const { Launcher } = require('./src/launcher');
const updateCache = require('./src/update-cache');
const platform = require('./src/platform').current;  // 平台差異一律走 adapter，main.js 不做 process.platform 判斷
const systemProxy = platform.systemProxy;            // 系統代理開關（Windows 登錄檔 / macOS networksetup / Linux gsettings）
const { execSync, spawn } = require('child_process');

let mainWindow = null;
let tray = null;
let routeManager = null;
let engine = null;
let ruleSets = null;
let systemProxyEnabled = false;
let systemProxyTargetPort = null;   // 系統代理目前指向哪個本地埠（停掉那條路由時要跟著處理）
let startTime = null;
let _quitting = false;             // before-quit 清理中：計時器、exit 事件都不該再拉起任何東西

// Debug log buffer（記憶體，供「紀錄」分頁即時顯示）
const LOG_MAX = 500;
const logBuffer = [];

// 持久化紀錄：log 批次落地到 userData/logs/app.log（自動輪替；只存本機、不外流）
//
// 這裡每一個設計都是為了同一件事：relay 跑在 main process，而每條連線都會產生
// 一筆 log。舊版每筆做 existsSync + statSync + appendFileSync 三個同步 syscall，
// 實測 318µs —— 那不只是寫 log 慢，是整個事件迴圈停 318µs，連帶卡住當下所有
// 正在轉送的 socket。開一個網頁幾十條並行連線，就是十幾毫秒的主迴圈停頓。
//
//   常開 fd（省掉每筆 open/close）           318µs → 7.9µs
//   記憶體追蹤檔案大小（取代每筆 statSync）  省掉兩個 syscall
//   批次 flush（最多 LOG_PENDING_MAX 行一次）攤到每筆趨近於零
const LOG_FILE_MAX = 1024 * 1024; // 單檔上限 1 MB
const LOG_FILE_KEEP = 2;          // 保留 app.log + app.1.log
const LOG_FLUSH_MS = 150;         // 批次落地間隔
const LOG_PENDING_MAX = 256;      // 累積到這麼多行就不等計時器，直接寫
let logDir = null;
let logFilePath = null;
let logFd = null;                 // 常開的 append fd
let logSize = 0;                  // 記憶體裡追蹤的檔案大小，取代每筆 statSync
let logPending = [];              // 還沒落地的行
let logFlushTimer = null;
let logPersistDebug = false;      // 要不要把逐連線的 debug 訊息也寫進檔案

function openLogFile() {
  try {
    logSize = fs.existsSync(logFilePath) ? fs.statSync(logFilePath).size : 0;
    logFd = fs.openSync(logFilePath, 'a');
  } catch (e) { logFd = null; }
}

function initFileLog() {
  try {
    logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    logFilePath = path.join(logDir, 'app.log');
    openLogFile();
    try { logPersistDebug = !!config.getSettings().logConnections; } catch (e) {}
    fileLog({ time: new Date().toISOString(), level: 'info', source: 'system',
      message: `===== 紀錄開始 v${app.getVersion()} · ${process.platform} =====` });
    flushLog();
  } catch (e) { logFilePath = null; }
}

function setLogPersistDebug(on) {
  const next = !!on;
  if (next === logPersistDebug) return;
  logPersistDebug = next;
  addLog('info', 'system', next ? '已開始把每條連線寫入紀錄檔' : '已停止把每條連線寫入紀錄檔');
}

// 換檔要先把 fd 關掉：Windows 不讓你 rename 一個還開著 handle 的檔案。
function rotateLog() {
  try { if (logFd !== null) fs.closeSync(logFd); } catch (e) {}
  logFd = null;
  try {
    for (let i = LOG_FILE_KEEP - 1; i >= 1; i--) {
      const src = i === 1 ? logFilePath : path.join(logDir, `app.${i - 1}.log`);
      const dst = path.join(logDir, `app.${i}.log`);
      if (fs.existsSync(src)) { try { fs.renameSync(src, dst); } catch (e) {} }
    }
  } catch (e) { /* ignore */ }
  openLogFile();
}

function flushLog() {
  if (logFlushTimer) { clearTimeout(logFlushTimer); logFlushTimer = null; }
  if (!logPending.length) return;
  const chunk = logPending.join('');
  logPending = [];
  if (logFd === null) return;   // 開檔失敗 → 丟掉，不影響 app 運作
  try {
    fs.writeSync(logFd, chunk);
    logSize += Buffer.byteLength(chunk);
    if (logSize >= LOG_FILE_MAX) rotateLog();
  } catch (e) { /* 落地失敗不影響 app 運作 */ }
}

// 一筆記錄就是一行：訊息裡的換行要轉義掉。舊版沒處理，結果 stack trace 的續行
// 變成沒有時間戳的孤行，任何逐行解析都會把 "    at updateSplit (...)" 當成一筆
// 記錄、把 updateSplit 當成等級 —— 既有的 app.1.log 裡就有 6 行是這樣壞掉的。
const logOneLine = (v) => String(v).replace(/\r\n|[\r\n]/g, '\\n').replace(/\t/g, '\\t');

function fileLog(entry) {
  if (!logFilePath) return; // 尚未初始化（如測試環境）→ 不落地
  // 逐連線的 CONNECT 是 debug，預設不落地。實測使用者的紀錄檔 12038 行裡有
  // 12035 行是 CONNECT（99.98%），正常瀏覽約三天就把所有診斷訊息輪替掉了。
  if (entry.level === 'debug' && !logPersistDebug) return;
  const lvl = String(entry.level || 'info').toUpperCase().padEnd(5);
  logPending.push(`${entry.time} ${lvl} ${entry.source}: ${logOneLine(entry.message)}` +
    `${entry.detail ? ' | ' + logOneLine(entry.detail) : ''}\n`);
  if (logPending.length >= LOG_PENDING_MAX) { flushLog(); return; }
  if (!logFlushTimer) { logFlushTimer = setTimeout(flushLog, LOG_FLUSH_MS); logFlushTimer.unref(); }
}

function addLog(level, source, message, detail, meta) {
  const entry = {
    time: new Date().toISOString(),
    level,
    source,
    message,
    detail: detail || null,
    ...(meta ? { meta } : {})   // 結構化附加資料（例如命中了哪一條規則）
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  fileLog(entry);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log-entry', entry);
  }
}

// 全域例外攔截：任何未捕捉錯誤都寫進 crash log（不要讓 app 直接死）。
function writeCrashLog(tag, err) {
  try {
    const line = `${new Date().toISOString()} [${tag}] ${(err && err.stack) || err}\n`;
    require('fs').appendFileSync(require('path').join(require('os').tmpdir(), 'proxyclient-crash.log'), line);
  } catch (e) { /* ignore */ }
  try { addLog('error', 'system', `${tag}: ${(err && err.message) || err}`); } catch (e) {}
}
process.on('uncaughtException', (err) => writeCrashLog('uncaughtException', err));
process.on('unhandledRejection', (reason) => writeCrashLog('unhandledRejection', reason));

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 800,
    minHeight: 550,
    frame: false,
    backgroundColor: '#f2f2f7',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true // preload 僅用 contextBridge/ipcRenderer，可在 sandbox 下運作
    }
  });

  mainWindow.loadFile('renderer/index.html');

  // 安全性：本 app 只載入本地頁面 → 擋掉所有新視窗開啟與離開本頁的導覽，
  // 避免被注入內容導向外部 URL 後在 app context 執行（縱深防禦）。
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  mainWindow.on('close', (e) => {
    const settings = config.getSettings();
    if (settings.minimizeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTrayIcon(active = false) {
  // 用 PNG（SVG data URL 在 Windows nativeImage 不 render）。
  // 關鍵：createFromPath 讀不到 asar 封裝內的檔（回傳空圖）→ 用 fs.readFileSync（asar-aware）
  // 讀成 buffer 再 createFromBuffer，才能在打包後正常顯示 tray icon。
  const fs = require('fs');
  const files = [active ? 'tray-active.png' : 'tray.png', 'tray.png', 'icon.png'];
  for (const f of files) {
    try {
      const buf = fs.readFileSync(path.join(__dirname, 'assets', f));
      const img = nativeImage.createFromBuffer(buf);
      if (img && !img.isEmpty()) return img;
    } catch (e) { /* try next */ }
  }
  return nativeImage.createEmpty();
}

function createTray() {
  const icon = createTrayIcon(false);
  tray = new Tray(icon);
  updateTrayMenu();
  tray.setToolTip('RelayClient');
  tray.on('double-click', () => showMainWindow());
}

// 系統代理該指向哪個埠：跑著的路由裡挑一個，優先 http（Windows 的系統代理欄位
// 是 HTTP 代理，指到 socks5 埠的話瀏覽器連不上）。沒有路由在跑就回 null。
//
// 以前系統匣是寫死 settings.httpPort（10808，舊的單一主連線用的埠）。
// 主視窗早就改成用「當下路由的埠」了，兩邊對「系統代理」的定義不一樣 ——
// 從系統匣按下去會把整台機器指到一個沒人在聽的埠，然後就全部上不了網。
function systemProxyPort() {
  const running = routeManager ? routeManager.status().filter(r => r.running) : [];
  if (!running.length) return null;
  return (running.find(r => r.kind === 'http') || running[0]).localPort;
}

// 啟動時 systemProxyEnabled 一律是 false，但上一輪可能是當機、或提權重啟（app.exit 跳過清理）結束的，
// 系統代理其實還開著、指向我們的埠。沒讀回來的話介面顯示「關」，結束時也不會去還原。
// 只認得出「127.0.0.1 + 我們某條路由的埠」這種；別人設的代理不碰。
function syncSystemProxyFromOS() {
  try {
    const s = systemProxy.get();
    const m = s && s.enabled && /^(?:https?:\/\/)?127\.0\.0\.1:(\d+)$/.exec(String(s.server || '').trim());
    if (!m) return;
    const port = Number(m[1]);
    if (!config.getRoutes().some(r => Number(r.localPort) === port)) return;
    systemProxyEnabled = true;
    systemProxyTargetPort = port;
  } catch (e) { /* 讀不到就維持預設 */ }
}

// 系統代理指向的那條路由不在跑了：改指另一條還在跑的，一條都沒有就關掉 —— 否則整台機器上不了網。
function reconcileSystemProxy() {
  if (!systemProxyEnabled || _quitting) return;
  const running = routeManager ? routeManager.status().filter(r => r.running) : [];
  if (systemProxyTargetPort && running.some(r => r.localPort === systemProxyTargetPort)) return;
  try {
    const next = systemProxyPort();
    if (next) {
      systemProxy.enable(next);
      systemProxyTargetPort = next;
      addLog('warn', 'win-proxy', `系統代理原本指向的路由已停止，改指向 127.0.0.1:${next}`);
    } else {
      systemProxy.disable();
      systemProxyEnabled = false;
      systemProxyTargetPort = null;
      addLog('warn', 'win-proxy', '系統代理指向的路由已停止，已關閉系統代理（避免整台機器上不了網）');
    }
  } catch (e) { addLog('error', 'win-proxy', `調整系統代理失敗：${e.message}`); }
  sendSystemProxyState();
  updateTrayMenu();
}

function resolveSystemProxyPort(requested) {
  const n = Number(requested);
  const running = routeManager ? routeManager.status().filter(r => r.running) : [];
  if (Number.isInteger(n) && running.some(r => r.localPort === n)) return n;
  return systemProxyPort();
}

// 系統代理狀態變了就告訴視窗一聲。少了這個，從系統匣切換之後主視窗的開關
// 還停在舊狀態，使用者看到的跟實際的不一樣。
function sendSystemProxyState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('system-proxy', { enabled: systemProxyEnabled });
  }
}

function updateTrayMenu() {
  if (!tray) return;   // 匣還沒建好就被呼叫（啟動早期 / 測試）——下面每一行都要 tray
  const port = systemProxyPort();
  tray.setImage(createTrayIcon(!!port));
  const menu = Menu.buildFromTemplate([
    { label: 'RelayClient', enabled: false },
    { type: 'separator' },
    {
      label: port ? `⬤ 路由執行中 · 127.0.0.1:${port}` : '○ 沒有路由在跑',
      enabled: false
    },
    {
      label: systemProxyEnabled ? '關閉系統代理' : '啟用系統代理',
      // 沒有路由在跑就不給開——跟主視窗那句「請先啟動路由」是同一個規則
      enabled: systemProxyEnabled || !!port,
      click: () => {
        try {
          if (systemProxyEnabled) { systemProxy.disable(); systemProxyEnabled = false; systemProxyTargetPort = null; }
          else if (port) { systemProxy.enable(port); systemProxyEnabled = true; systemProxyTargetPort = port; }
        } catch (e) { addLog('error', 'system', `系統匣切換系統代理失敗：${e.message}`); }
        updateTrayMenu();
        sendSystemProxyState();
      }
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
  tray.setContextMenu(menu);
}

// 檢查本地埠是否可用（能綁定 = 空的）
function checkPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, '127.0.0.1');
  });
}

// 彈出原生告警視窗（埠衝突）
function showPortConflictDialog(detail) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '連接埠衝突',
      message: '偵測到本地連接埠衝突，已阻擋連線',
      detail,
      buttons: ['確定'],
      defaultId: 0,
      noLink: true
    });
  }
}

// 舊的「單一主連線」路徑（socksRelay + httpBridge 綁 settings.httpPort / socksPort）
// 在這裡整段拿掉了。介面早就改成「每條路由各自一個本地埠」，主視窗沒有這個概念，
// 唯一還叫得到它的是系統匣那個「連線 / 中斷連線」——而它啟動的東西主視窗看不到、
// 也顯示不出來。留著只會讓人以為還有一條主連線。
// SocksRelay / HttpBridge 本身沒有消失，是 RouteManager 在用。

function testProxyHandshake(server) {
  const type = server.type || 'socks5';

  if (type === 'socks5') {
    return testRawHandshake(server, false, (socket) => {
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    }, (data) => {
      if (data[0] !== 0x05) throw new Error('Not a SOCKS5 proxy');
    });
  }

  if (type === 'socks4') {
    return testRawHandshake(server, false, (socket) => {
      socket.write(Buffer.from([0x04, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00]));
    }, (data) => {
      if (data[0] !== 0x00) throw new Error('Not a SOCKS4 proxy');
    });
  }

  if (type === 'http' || type === 'https') {
    const useTls = type === 'https';
    let header = 'CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n';
    if (server.username) {
      const cred = Buffer.from(`${server.username}:${server.password || ''}`).toString('base64');
      header += `Proxy-Authorization: Basic ${cred}\r\n`;
    }
    header += '\r\n';
    return testRawHandshake(server, useTls, (socket) => {
      socket.write(header);
    }, (data) => {
      if (!data.toString().startsWith('HTTP/')) throw new Error('Not an HTTP proxy');
    });
  }

  return Promise.reject(new Error(`Unsupported proxy type: ${type}`));
}

function testRawHandshake(server, useTls, sendFn, validateFn) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const onConnect = () => sendFn(socket);
    let socket;
    if (useTls) {
      socket = tls.connect({ ...tlsOptions(server), port: server.port, host: server.host }, onConnect);
    } else {
      socket = net.connect(server.port, server.host, onConnect);
    }
    socket.setTimeout(10000);
    socket.once('data', (data) => {
      socket.destroy();
      try {
        validateFn(data);
        resolve(Date.now() - start);
      } catch (err) {
        reject(err);
      }
    });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Connection timeout')); });
    socket.once('error', (err) => { socket.destroy(); reject(explainTlsError(err)); });
  });
}

// 伺服器密碼與憑證庫用 OS 的加密儲存（Windows DPAPI / macOS Keychain / Linux libsecret）。
// 只能在 app ready 之後呼叫。
function initSecretStorage() {
  try {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      addLog('warn', 'system', '這台機器不支援系統加密，伺服器密碼與憑證仍以明文存放');
      return;
    }
    // Linux 沒有 keyring 時 Electron 退回 basic_text（寫死的金鑰），等於沒有加密 —— 照實記一筆
    let backend = '';
    try { backend = safeStorage.getSelectedStorageBackend ? safeStorage.getSelectedStorageBackend() : ''; } catch (e) {}
    if (backend === 'basic_text') addLog('warn', 'system', '找不到系統金鑰圈（keyring），密碼加密的保護力有限');
    config.setCipher({ encrypt: v => safeStorage.encryptString(v), decrypt: b => safeStorage.decryptString(b) });
    const n = config.migrateSecrets();
    if (n) addLog('info', 'system', `已把 ${n} 筆儲存的密碼改為加密存放`);
    config.getServers(); config.getCreds();   // 試解一次，看有沒有解不開的
    if (config.decryptFailures()) addLog('warn', 'system', '有儲存的密碼無法解密（設定檔可能來自另一台電腦），請重新輸入');
  } catch (e) { addLog('warn', 'system', `無法啟用密碼加密：${e.message}`); }
}

// IPC Handlers
ipcMain.handle('get-servers', () => config.getServers());
ipcMain.handle('get-creds', () => config.getCreds());
ipcMain.handle('save-creds', (_e, list) => config.saveCreds(list));
ipcMain.handle('add-server', (_e, server) => config.addServer(server));
ipcMain.handle('update-server', (_e, id, updates) => config.updateServer(id, updates));
ipcMain.handle('delete-server', (_e, id) => {
  config.deleteServer(id);
  return true;
});
ipcMain.handle('toggle-system-proxy', (_e, enable, port) => {
  try {
    if (enable) {
      // 只接受「正在跑的路由」的埠：這個值會寫進系統設定（Windows 還是拼進 reg 指令），
      // 而且指到沒人在聽的埠整台機器就上不了網。不合的一律改用自己挑的那條。
      const target = resolveSystemProxyPort(port);
      if (!target) return { systemProxyEnabled, error: '沒有路由在跑' };
      systemProxy.enable(target);
      systemProxyEnabled = true;
      systemProxyTargetPort = target;
    } else {
      systemProxy.disable();
      systemProxyEnabled = false;
      systemProxyTargetPort = null;
    }
  } catch (e) {
    addLog('error', 'win-proxy', `切換系統代理失敗：${e.message}`);
    return { systemProxyEnabled, error: e.message };
  } finally {
    sendSystemProxyState();
    updateTrayMenu();
  }
  return { systemProxyEnabled };
});

ipcMain.handle('test-server', async (_e, serverId, testTarget) => {
  const server = config.getServer(serverId);
  if (!server) return { success: false, error: 'Server not found' };

  const settings = config.getSettings();
  const target = testTarget || settings.testTarget || null;
  const proxyType = server.type || 'socks5';

  const start = Date.now();
  try {
    let latency;
    if (target) {
      addLog('info', 'test', `Testing ${server.host}:${server.port} [${proxyType}] → ${target.host}:${target.port}`);
      const proxy = serverToProxy(server);
      const sock = await connectViaProxy(proxy, { host: target.host, port: target.port });
      sock.destroy();
      latency = Date.now() - start;
    } else {
      addLog('info', 'test', `Testing ${proxyType} handshake ${server.host}:${server.port}`);
      latency = await testProxyHandshake(server);
    }
    config.updateServer(serverId, { latency, lastTest: Date.now(), status: 'ok', lastError: null });
    addLog('info', 'test', `SUCCESS ${server.host}:${server.port} — ${latency}ms`);
    return { success: true, latency };
  } catch (err) {
    // 失敗原因存起來：伺服器列表原本只寫「測試失敗」，看不出是被拒、逾時還是驗證錯
    config.updateServer(serverId, { latency: -1, lastTest: Date.now(), status: 'error', lastError: err.message });
    addLog('error', 'test', `FAILED ${server.host}:${server.port} — ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-logs', () => logBuffer);
ipcMain.handle('clear-logs', () => { logBuffer.length = 0; return true; });
ipcMain.handle('open-logs-folder', async () => {
  try {
    if (!logDir) return { ok: false, error: '紀錄檔尚未初始化' };
    const err = await shell.openPath(logDir);
    return err ? { ok: false, error: err } : { ok: true, path: logDir };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('get-settings', () => config.getSettings());
ipcMain.handle('update-settings', (_e, updates) => {
  const saved = config.updateSettings(updates);
  if (updates && 'logConnections' in updates) setLogPersistDebug(updates.logConnections);
  return saved;
});

// App 版本資訊（誠實版：取代先前假的「檢查更新」按鈕）
ipcMain.handle('get-app-info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
}));

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

// ===== 自動更新（electron-updater → GitHub Releases）=====
// 延遲載入：electron-updater 一 require 就會實例化並呼叫 app.getVersion()，
// 在非 Electron 環境（單元測試 require main.js）會炸。故只在實際用到時才載入。
let autoUpdater = null;
function sendUpdateStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', payload);
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

// ===== 多端口路由（每個 localPort → 各自的 proxy 或多跳串鏈）=====
function serverToProxy(s) {
  if (!s) return null;
  return {
    host: s.host, port: s.port, type: s.type || 'socks5',
    username: s.username || undefined, password: s.password || undefined,
    tlsInsecure: !!s.tlsInsecure,
  };
}

// route.hops 存的是 serverId；解析成 relay 需要的 proxy 物件陣列
function resolveRoute(route) {
  const hops = (route.hops || []).map(id => serverToProxy(config.getServer(id))).filter(Boolean);
  return {
    id: route.id, localPort: route.localPort, kind: route.kind || 'socks5',
    hops, enabled: route.enabled !== false
  };
}

function setupRouteManager() {
  if (routeManager) return;
  routeManager = new RouteManager();
  routeManager.on('log', (routeId, level, msg, detail) => addLog(level, `route:${routeId}`, msg, detail));
  routeManager.on('error', (routeId, err) => addLog('error', `route:${routeId}`, err.message));
  routeManager.on('stats', (routeId, stats) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('route-stats', { routeId, ...stats });
    }
  });
  routeManager.on('started', () => sendRouteStatus());
  routeManager.on('stopped', () => sendRouteStatus());
}

async function applyRoutes() {
  setupRouteManager();
  await routeManager.stopAll(); // 乾淨重來，便於重新做埠衝突檢查

  const enabled = config.getRoutes().filter(r => r.enabled !== false);

  // 先解析路由並剔除無跳點者（不算衝突，僅記錄）
  const resolved = [];
  for (const def of enabled) {
    const r = resolveRoute(def);
    r._name = def.label || r.id;
    if (r.hops.length === 0) { addLog('warn', `route:${r.id}`, 'no valid hops (server missing)'); continue; }
    resolved.push(r);
  }

  // 純邏輯偵測「路由間埠重複」（已抽成可測試的 RouteManager.detectPortConflicts）。
  // 第二個參數是「主連線占用的埠」——舊的單一主連線拿掉之後就沒有那種東西了，
  // 但函式簽名保留（有單元測試守著 primary 那條分支，將來要再加保留埠也用得上）。
  const { clear, conflicts: portConflicts } = RouteManager.detectPortConflicts(resolved, []);
  const nameOf = id => { const r = resolved.find(x => x.id === id); return r ? r._name : id; };
  const conflicts = portConflicts.map(c => c.reason === 'primary'
    ? `• ${nameOf(c.id)}：埠 ${c.port} 已被保留`
    : `• ${nameOf(c.id)}：埠 ${c.port} 與路由「${nameOf(c.with)}」重複`);

  const started = [];
  // 通過純邏輯檢查者，再做「外部程式占用」的 I/O 檢查與實際啟動
  for (const r of clear) {
    if (!(await checkPortFree(r.localPort))) { conflicts.push(`• ${r._name}：埠 ${r.localPort} 已被其他程式占用`); continue; }
    try {
      await routeManager.start(r);
      started.push(r.id);
    } catch (e) {
      conflicts.push(`• ${r._name}：埠 ${r.localPort} 啟動失敗（${e.message}）`);
    }
  }

  if (conflicts.length) {
    addLog('warn', 'route', `${conflicts.length} route(s) blocked by port conflict`);
    showPortConflictDialog('以下路由因連接埠衝突未啟動：\n\n' + conflicts.join('\n'));
  }
  sendRouteStatus();
  return { started, conflicts };
}

function sendRouteStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('route-status', routeManager ? routeManager.status() : []);
  }
  // 系統匣的「路由執行中」與「啟用系統代理」是依路由狀態算的；只在切換代理時重建的話，
  // 開機後路由非同步起來，選單會一直停在「沒有路由在跑」、代理選項也一直是灰的。
  updateTrayMenu();
}

ipcMain.handle('get-routes', () => config.getRoutes());
ipcMain.handle('get-route-status', () => (routeManager ? routeManager.status() : []));

// 找已安裝的 Chromium 系瀏覽器（Chrome 優先、再 Edge），供「用路由開瀏覽器」用
function findBrowser() {
  for (const c of platform.browserCandidates()) { try { if (fs.existsSync(c.path)) return c; } catch (e) {} }
  return null;
}

// 啟動單一路由（runtime）；衝突時回傳 {ok:false, conflict:{title,body}} 讓 renderer 顯示 in-app alert
ipcMain.handle('route-start', async (_e, id) => {
  setupRouteManager();
  const def = config.getRoutes().find(r => r.id === id);
  if (!def) return { ok: false, error: 'route not found' };
  const r = resolveRoute(def);
  if (r.hops.length === 0) {
    return { ok: false, conflict: { kind: 'nohop', title: '路由缺少跳點', body: `「${def.label || id}」沒有任何上游跳點，無法建立連線。請至少加入一個伺服器作為出口。` } };
  }
  const hitInternal = routeManager.status().find(s => s.id !== id && s.localPort === r.localPort);
  if (hitInternal) {
    const other = config.getRoutes().find(x => x.id === hitInternal.id);
    return { ok: false, conflict: { kind: 'conflict', title: '本地端口衝突', body: `端口 ${r.localPort} 已被路由「${(other && other.label) || hitInternal.id}」占用。同一個端口無法同時服務兩條路由，請改用其他端口或先停止該路由。` } };
  }
  if (!routeManager.isRunning(id) && !(await checkPortFree(r.localPort))) {
    return { ok: false, conflict: { kind: 'conflict', title: '本地端口衝突', body: `端口 ${r.localPort} 已被其他程式占用，無法啟動。請改用其他端口，或關閉占用該埠的程式。` } };
  }
  try {
    await routeManager.start(r);
    addLog('info', `route:${id}`, `route started`, `127.0.0.1:${r.localPort} · ${r.hops.length} hop(s)`);
    sendRouteStatus();
    return { ok: true, status: routeManager.status() };
  } catch (e) {
    return { ok: false, conflict: { kind: 'conflict', title: '啟動失敗', body: `端口 ${r.localPort}：${e.message}` } };
  }
});

ipcMain.handle('route-stop', async (_e, id) => {
  if (routeManager) await routeManager.stop(id);
  reconcileSystemProxy();
  sendRouteStatus();
  return { ok: true, status: routeManager ? routeManager.status() : [] };
});

// 新增/更新單一路由（只 persist，不自動啟動；由 renderer 決定啟停）
ipcMain.handle('save-route', (_e, input) => {
  const route = RouteManager.normalizeRouteDef(input);
  const routes = config.getRoutes();
  const i = routes.findIndex(r => r.id === route.id);
  if (i >= 0) routes[i] = route; else routes.push(route);
  config.setRoutes(routes);
  return routes;
});

// MERGE §4：找不到 Chrome/Edge 時按鈕要 disabled，所以 UI 得先知道有沒有
// 實例分流（設計稿 v5）。延遲建立：要等 app ready 才有 userData 路徑。
let launcher = null;
function setupLauncher() {
  if (launcher) return launcher;
  launcher = new Launcher({
    platform,
    userDataDir: app.getPath('userData'),
    mkdirp: (d) => fs.mkdirSync(d, { recursive: true }),
    log: (lvl, src, msg, detail) => addLog(lvl, src, msg, detail),
    onChange: (list) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('instances', list); },
  });
  return launcher;
}

ipcMain.handle('list-browsers', () => setupLauncher().browsers().map(b => ({ name: b.name, found: b.found })));
ipcMain.handle('list-instances', () => setupLauncher().list());
ipcMain.handle('kill-instance', (_e, id) => setupLauncher().kill(id));

ipcMain.handle('launch-preview', (_e, d = {}) => {
  const def = config.getRoutes().find(r => r.id === d.routeId);
  if (!def) return '';
  return setupLauncher().preview({
    mode: d.mode, route: def, localPort: def.localPort,
    browserName: d.browserName, exePath: d.exePath, exeArgs: d.exeArgs,
  });
});

// 實際啟動。兩種模式都會先把路由拉起來（沒路由就沒有代理可連）。
ipcMain.handle('launch-instance', async (_e, d = {}) => {
  try {
    const def = config.getRoutes().find(r => r.id === d.routeId);
    if (!def) return { ok: false, error: '找不到該路由' };
    const r = resolveRoute(def);
    if (!r.hops || r.hops.length === 0) return { ok: false, error: '此路由沒有有效跳點（先在路由裡加伺服器）' };
    if (d.mode !== 'browser') {
      // exePath 來自 renderer，交給 spawn 之前至少確認它是一個實際存在的絕對路徑
      const exePath = typeof d.exePath === 'string' ? d.exePath.trim() : '';
      if (!exePath || !platform.path.isAbsolute(exePath) || !fs.existsSync(exePath)) {
        return { ok: false, error: '找不到這支程式，請重新選擇' };
      }
      d.exePath = exePath;
    }
    setupRouteManager();
    if (!routeManager.isRunning(def.id)) {
      if (!(await checkPortFree(r.localPort))) return { ok: false, error: `本地埠 ${r.localPort} 已被占用，無法啟動路由` };
      try { await routeManager.start(r); sendRouteStatus(); }
      catch (e) { return { ok: false, error: '路由啟動失敗：' + e.message }; }
    }
    const L = setupLauncher();
    if (d.mode === 'browser') return L.launchBrowser({ route: def, localPort: r.localPort, browserName: d.browserName });

    // 其他程式：sing-box 比的是 process_name / process_path，沒有 PID 規則，
    // 所以「只有這次」做不到。要讓它走代理，就得登記成程式規則。
    const res = L.launchProgram({ route: def, exePath: d.exePath, exeArgs: d.exeArgs });
    if (res.ok && d.remember !== false) {
      const split = config.getSplit();
      const exe = require('path').basename(d.exePath);
      const dup = (split.rules || []).some(x => x.when && x.when.app && x.when.app.value === exe);
      if (!dup) {
        const rules = [{ id: 'r' + Date.now(), on: true, name: exe, target: def.id,
                         when: { app: { match: 'name', value: exe } } }, ...(split.rules || [])];
        config.saveSplit({ rules });
        await reloadEngineIfRunning();
        res.ruleAdded = exe;
      }
    }
    return res;
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('browser-info', () => { const b = findBrowser(); return b ? { name: b.name, path: b.path } : null; });

// 這條路由有沒有留下瀏覽器 profile（沒有就不用多問一句）
ipcMain.handle('route-profile-info', (_e, id) => {
  try {
    if (!RouteManager.isValidRouteId(id)) return { exists: false };
    return { exists: fs.existsSync(setupLauncher().profileDir(id)) };
  } catch (e) { return { exists: false }; }
});

ipcMain.handle('delete-route', async (_e, id, opts) => {
  if (routeManager) await routeManager.stop(id);
  reconcileSystemProxy();
  config.setRoutes(config.getRoutes().filter(r => r.id !== id));
  // 這條路由的瀏覽器 profile（cookie / 登入狀態）。MERGE §4：要問過才能刪，
  // 不問就刪等於連帶把使用者在那個視窗裡的登入狀態一起清掉。
  if (opts && opts.keepProfile) { sendRouteStatus(); return config.getRoutes(); }
  try {
    if (!RouteManager.isValidRouteId(id)) throw new Error(`路由 id 不合法，不清除 profile：${String(id).slice(0, 80)}`);
    const dir = setupLauncher().profileDir(id);
    if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); addLog('info', 'launch', `已清除路由 ${id} 的瀏覽器 profile`); }
  } catch (e) { addLog('warn', 'launch', `清除瀏覽器 profile 失敗：${e.message}`); }
  sendRouteStatus();
  return config.getRoutes();
});

// ===== Per-app 分流引擎（sing-box TUN）=====
// sing-box 的良性噪音：http/socks 上游本就不帶 UDP，QUIC/UDP 會被拒並記 ERROR，但不影響功能 → 不進紀錄。
const ENGINE_LOG_NOISE = /UDP is not supported by outbound/i;
// ===== 命中追蹤 =====
// 解析器在 src/engine/hit-parser.js（抽出去才測得到——main.js 需要 electron 才能載入）。
// 它吃引擎的 debug log，把「這條連線命中第幾條規則」還原出來；這些行只統計不落地，
// 否則 debug 每條連線三四行會把 app.log 灌爆。
const hitParser = new HitParser({
  getRuleIndex: () => (engine && engine.ruleIndex) || [],
  onHit: (conn) => recordHit(conn),
});
const consumeEngineLine = line => hitParser.consume(line);
function resetHits() { hitParser.reset(); }

function recordHit(conn) {
  const info = conn.info;
  // app 自己的流量不記；DNS 拦截也不記（每查一次就一行，會把紀錄灌爆）
  if (info && (info.kind === 'self' || info.kind === 'dns')) return;
  const split = config.getSplit();
  const rule = info && info.kind === 'rule' ? split.rules.find(r => r.id === info.id) : null;
  addLog('info', 'split', `連線 ${conn.host}`, null, {
    matched: !!info,
    ruleId: rule ? rule.id : null,
    ruleName: !info ? '預設' : info.kind === 'lan' ? '本機與內網' : (rule && rule.name) || '未命名規則',
    ruleIndex: rule ? split.rules.indexOf(rule) + 1 : 0,
    target: info ? (info.kind === 'lan' ? 'direct' : info.target) : split.defaultTarget,
  });
}

function setupEngine() {
  if (engine) return;
  engine = new SingBoxEngine();
  engine.on('status', (s) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('engine-status', s); });
  engine.on('log', (chunk) => {
    // sing-box 一個 data 事件常含多行；逐行處理並濾掉已知的良性噪音（見 ENGINE_LOG_NOISE）。
    for (const raw of String(chunk).split(/\r?\n/)) {
      const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (!line || ENGINE_LOG_NOISE.test(line)) continue;
      if (consumeEngineLine(line)) continue;   // 命中 / 連線相關 → 只統計，不進紀錄
      addLog('debug', 'engine', line.slice(0, 400));
    }
  });
  engine.on('exit', (code) => {
    if (_quitting) return;
    // block（斷線保護）模式自己中止 → 不遞迴再觸發，只記錄並回報
    if (engine._blocking) { addLog('error', 'killswitch', `斷線保護的封鎖模式也中止了（code ${code}）——受保護程式已失去保護`); killSwitchState.blocking = false; sendKillSwitch(); sendEngineStatus(); return; }
    addLog('warn', 'engine', `分流引擎異常結束（code ${code}）`);
    if (config.getSettings().killSwitch) triggerKillSwitch(code);
    else sendEngineStatus();
  });
}

// ===== 斷線保護 =====
// 分流引擎「非使用者主動」中止時，若已啟用，立即以封鎖模式重建 TUN，
// 先擋住受保護程式的連線，避免它們繞過代理外洩；並通知 UI 顯示告警。
const KS_MAX_RETRY = 3, KS_RETRY_DELAY = 4000;
const ksIdle = () => ({ tripped: false, reason: '', blocking: false, retries: 0, reconnecting: false, at: 0 });
let killSwitchState = ksIdle();
let ksRetryTimer = null;
// 使用者主動停止引擎或結束程式時一定要呼叫：不清掉的話，4 秒內重試計時器
// 看到 tripped 還是 true，就會違背使用者的意思把引擎重新拉起來（結束時則會殘留 TUN）。
function resetKillSwitch() {
  clearTimeout(ksRetryTimer);
  ksRetryTimer = null;
  killSwitchState = ksIdle();
}
// 自動重連（settings.killSwitchAutoReconnect，預設開）
function scheduleKillSwitchRetry() {
  clearTimeout(ksRetryTimer);
  if (!config.getSettings().killSwitchAutoReconnect) return;
  if (killSwitchState.retries >= KS_MAX_RETRY) {
    addLog('warn', 'killswitch', `已自動重試 ${KS_MAX_RETRY} 次仍失敗，請手動處理`);
    return;
  }
  ksRetryTimer = setTimeout(async () => {
    if (_quitting || !killSwitchState.tripped) return;
    killSwitchState.retries += 1;
    killSwitchState.reconnecting = true;
    sendKillSwitch();
    addLog('info', 'killswitch', `自動重連第 ${killSwitchState.retries} 次…`);
    try {
      await engine.stop();
      await ensureSplitRoutesStarted();
      if (_quitting || !killSwitchState.tripped) return;   // 停止期間使用者按了停止／結束
      const r = await engine.start(engineParams());
      if (r && r.ok) {
        resetKillSwitch();
        addLog('info', 'killswitch', '自動重連成功，受保護程式已恢復連線');
        sendKillSwitch(); sendEngineStatus();
        return;
      }
    } catch (e) { addLog('warn', 'killswitch', `自動重連失敗：${e.message}`); }
    killSwitchState.reconnecting = false;
    sendKillSwitch();
    scheduleKillSwitchRetry();
  }, KS_RETRY_DELAY);
}

function sendKillSwitch() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('killswitch', { ...killSwitchState, enabled: !!config.getSettings().killSwitch });
}
async function triggerKillSwitch(code, reason) {
  if (_quitting) return;
  const retries = killSwitchState.tripped ? killSwitchState.retries : 0;
  killSwitchState = { tripped: true, reason: reason || `分流引擎異常中止（code ${code}）`, blocking: false, retries, reconnecting: false, at: Date.now() };
  addLog('error', 'killswitch', '斷線保護啟動：已暫停受保護程式的連線，避免它們繞過代理');
  try {
    const r = await engine.startBlock(engineParams());
    killSwitchState.blocking = !!(r && r.ok);
    if (!(r && r.ok)) addLog('error', 'killswitch', `block 模式啟動失敗：${(r && r.error) || '未知'}`);
  } catch (e) { addLog('error', 'killswitch', `封鎖模式例外：${e.message}`); }
  scheduleKillSwitchRetry();
  sendKillSwitch();
  sendEngineStatus();
}
ipcMain.handle('get-killswitch', () => ({ ...killSwitchState, enabled: !!config.getSettings().killSwitch }));
ipcMain.handle('killswitch-reconnect', async () => {
  clearTimeout(ksRetryTimer);
  setupEngine();
  await engine.stop();               // 先收掉 block 模式
  await ensureSplitRoutesStarted();  // 跟自動重連一樣：引擎要用的路由先帶起來，否則 TUN 往死掉的埠送
  const r = await engine.start(engineParams());
  if (r && r.ok) resetKillSwitch();
  sendKillSwitch(); sendEngineStatus();
  return r;
});
ipcMain.handle('killswitch-clear', async () => {
  resetKillSwitch();
  setupEngine();
  await engine.stop();               // 移除 TUN，恢復正常網路（使用者明確接受直連）
  sendKillSwitch(); sendEngineStatus();
  return { ok: true };
});

// ===== 規則庫（依網域 / 地區(GeoIP) 分流的資料來源）=====
// 存在 userData/rulesets/；預設不連網，使用者按「下載」才會抓，且可指定經由某條路由下載。
function setupRuleSets() {
  if (ruleSets) return ruleSets;
  ruleSets = new RuleSetStore({
    dir: path.join(app.getPath('userData'), 'rulesets'),
    connectChain: (hops, dest) => connectViaChain(hops, dest),
  });
  return ruleSets;
}

// 規則庫下載的出口：設定裡指定的路由 → 取它的 hops（串鏈）；沒指定就直連
function rulesetDetourHops() {
  const id = config.getSettings().rulesetDetourRouteId;
  if (!id) return [];
  const def = config.getRoutes().find(r => r.id === id);
  return def ? resolveRoute(def).hops : [];
}

// 目前規則實際引用到的規則庫 tag（只有這些會寫進 sing-box 設定）
function referencedSetTags(rules) {
  const tags = new Set();
  for (const r of rules || []) {
    const dest = r && r.on !== false && r.when && r.when.dest;
    if (!dest || dest.match !== 'ruleset') continue;
    const vals = Array.isArray(dest.value) ? dest.value : String(dest.value == null ? '' : dest.value).split(/[\n,;]+/);
    for (const v of vals.map(x => String(x).trim()).filter(Boolean)) tags.add(v);
  }
  return Array.from(tags);
}

function engineParams() {
  const split = config.getSplit();
  const self = require('path').basename(process.execPath); // dev: electron.exe；打包: RelayClient.exe
  return {
    rules: split.rules,
    ruleSets: setupRuleSets().resolveForEngine(referencedSetTags(split.rules)),
    defaultTarget: split.defaultTarget, udp: split.udp,
    mode: split.mode, globalTarget: split.globalTarget, lanDirect: split.lanDirect,
    routes: config.getRoutes(), selfNames: [self],
    // TUN 拉起來前先抓系統 DNS，當成 sing-box 的上游（不能讓它自己讀系統清單，那裡面有 TUN 自己）
    dnsServers: platform.systemDnsServers ? platform.systemDnsServers() : [],
    // 只在「只有以下程式」模式下才傳，空陣列 = 所有走代理的程式（依規則表）
    scopeApps: (() => { const st = config.getSettings();
      return st.killSwitchScope === 'apps' ? (st.killSwitchApps || []) : []; })(),
  };
}

function sendEngineStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('engine-status', engine ? engine.status() : { state: 'off', elevated: false, tun: null, health: [] });
}

// 列舉執行中的程式（含完整路徑），供規則挑選器用
ipcMain.handle('get-split', () => config.getSplit());
ipcMain.handle('save-split', async (_e, patch) => {
  const s = config.saveSplit(patch);
  const r = await reloadEngineIfRunning();   // 立即套用（先帶起規則要用的路由）
  return r && !r.ok ? { ...s, engineError: r.error || r.message || '分流引擎無法以新設定啟動' } : s;
});
// 列舉行程要跑 PowerShell（實測 448ms）。同步做的話整個 app 會凍住那麼久。
ipcMain.handle('list-processes', () => (platform.listProcessesAsync ? platform.listProcessesAsync() : platform.listProcesses()));
ipcMain.handle('browse-exe', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { title: '選擇程式', filters: platform.exeFilters, properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  // 執行檔名的正規化（是否小寫、是否去 .exe、.app bundle 怎麼取名）由 adapter 決定
  const picked = platform.normalizeApp(r.filePaths[0]);
  return { name: picked.label, exe: picked.name, path: picked.path };
});
// ---- 規則庫（rule-set）管理 ----
ipcMain.handle('ruleset-catalog', () => setupRuleSets().catalog());
ipcMain.handle('ruleset-list', () => setupRuleSets().list());

ipcMain.handle('ruleset-install', async (_e, tag) => {
  const r = await setupRuleSets().install(tag, { hops: rulesetDetourHops() });
  addLog(r.ok ? 'info' : 'error', 'ruleset', r.ok ? `規則庫已下載：${tag}（${r.entry.bytes} bytes）` : `規則庫下載失敗：${tag} — ${r.error}`);
  if (r.ok) await reloadEngineIfRunning();
  return r;
});

ipcMain.handle('ruleset-update', async (_e, tag) => {
  const r = await setupRuleSets().update(tag, { hops: rulesetDetourHops() });
  addLog(r.ok ? 'info' : 'warn', 'ruleset', r.ok ? `規則庫已更新：${tag}` : `規則庫更新失敗：${tag} — ${r.error}`);
  if (r.ok) await reloadEngineIfRunning();
  return r;
});

ipcMain.handle('ruleset-update-all', async () => {
  const results = await setupRuleSets().updateAll({ hops: rulesetDetourHops() });
  config.updateSettings({ rulesetLastCheck: Date.now() });
  const bad = results.filter(r => !r.ok);
  addLog(bad.length ? 'warn' : 'info', 'ruleset', `規則庫更新完成：成功 ${results.length - bad.length} / ${results.length}`);
  if (results.some(r => r.ok)) await reloadEngineIfRunning();
  return results;
});

ipcMain.handle('ruleset-import', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '匯入規則庫',
    filters: [{ name: '規則庫', extensions: ['srs', 'json'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const res = setupRuleSets().importFile(r.filePaths[0]);
  addLog(res.ok ? 'info' : 'error', 'ruleset', res.ok ? `規則庫已匯入：${res.entry.tag}` : `規則庫匯入失敗：${res.error}`);
  if (res.ok) await reloadEngineIfRunning();
  return res;
});

ipcMain.handle('ruleset-remove', async (_e, tag) => {
  const res = setupRuleSets().remove(tag);
  addLog('info', 'ruleset', `規則庫已移除：${tag}`);
  await reloadEngineIfRunning();
  return res;
});

// 規則模擬器：「這個網址／IP（可選：這支程式）會走哪一條？」——不需啟動引擎
ipcMain.handle('rule-match', async (_e, { host, exe, port, network } = {}) => {
  setupEngine();
  const split = config.getSplit();
  const res = await engine.matchTarget({
    host, exe, port, network,
    rules: split.rules,
    ruleSets: setupRuleSets().resolveForEngine(referencedSetTags(split.rules)),
    defaultTarget: split.defaultTarget,
    lanDirect: split.lanDirect !== false,
  });
  const rt = config.getRoutes().find(r => r.id === res.target);
  return { ...res, targetLabel: res.target === 'direct' ? '直接連線' : res.target === 'block' ? '封鎖' : (rt ? rt.label || rt.id : '（路由已刪除）') };
});

// 規則庫變動 → 引擎在跑就重載設定（等同 save-split 的即時套用）
// 重啟失敗不能安靜吞掉：這是使用者主動的 stop，斷線保護不會自己觸發，
// 引擎就這樣關著、介面不知道，受保護的程式全部直連出去。
async function reloadEngineIfRunning() {
  if (!(engine && engine.state === 'running')) return null;
  const wasBlocking = !!engine._blocking;
  await engine.stop();
  await ensureSplitRoutesStarted();
  const r = wasBlocking ? await engine.startBlock(engineParams()) : await engine.start(engineParams());
  if (!(r && r.ok) && !(r && r.cancelled)) {
    const why = (r && (r.error || r.message)) || '未知原因';
    addLog('error', 'engine', `套用新設定後分流引擎無法啟動：${why}`);
    if (config.getSettings().killSwitch && !wasBlocking) await triggerKillSwitch(0, `套用新設定後分流引擎無法啟動：${why}`);
  }
  sendEngineStatus();
  return r;
}

// 開機後的規則庫自動更新（預設關閉；開啟才會連網，且照設定的間隔天數）
async function maybeAutoUpdateRuleSets() {
  const s = config.getSettings();
  if (!s.rulesetAutoUpdate) return;
  const days = Math.max(1, Number(s.rulesetUpdateDays) || 7);
  if (Date.now() - (Number(s.rulesetLastCheck) || 0) < days * 86400000) return;
  if (!setupRuleSets().list().length) return;
  const results = await setupRuleSets().updateAll({ hops: rulesetDetourHops() });
  config.updateSettings({ rulesetLastCheck: Date.now() });
  addLog('info', 'ruleset', `規則庫自動更新：${results.filter(r => r.ok).length}/${results.length} 成功`);
  if (results.some(r => r.ok)) await reloadEngineIfRunning();
}

ipcMain.handle('engine-start', async () => {
  setupEngine();
  await ensureSplitRoutesStarted(); // 引擎要用的路由先帶起來，避免 TUN 往死掉的本地埠送流量
  resetHits();
  const r = await engine.start(engineParams());
  sendEngineStatus();
  return r;
});
ipcMain.handle('engine-stop', async () => {
  resetHits();
  const wasTripped = killSwitchState.tripped;
  resetKillSwitch();
  if (engine) await engine.stop();
  if (wasTripped) sendKillSwitch();
  sendEngineStatus();
  return { ok: true };
});
ipcMain.handle('get-engine-status', () => { setupEngine(); return engine.status(); });

// 用到才提權。提權方式因平台而異（adapter 的 engineElevation.strategy）：
//   relaunch-app（Windows）：以系統管理員重啟自己，帶旗標讓新實例自動啟動引擎與上游路由
//   setcap（Linux）：對 sing-box 授一次 CAP_NET_ADMIN 即可，不必用 root 跑 app
//   unsupported（macOS）：需要簽章的特權助手，本版未提供 → 回報說明而不是假裝成功
function relaunchElevated() {
  const el = platform.engineElevation;
  if (el.strategy === 'setcap') {
    const bin = engine ? engine.binPath : '';
    return Promise.resolve(el.isSatisfied(bin) ? { ok: true } : { ok: false, error: el.instructions(bin) });
  }
  if (el.strategy !== 'relaunch-app') return Promise.resolve({ ok: false, error: el.instructions() });
  // 用 powershell 的 Start-Process -Verb RunAs 觸發 UAC，並「等它結束」判斷結果：
  //   exit 0 = 使用者同意、提權實例已啟動 → 才收掉目前這個（避免埠衝突、避免像 crash）
  //   非 0 / error = 被拒或被公司政策封鎖 → 不關閉，回報錯誤，其餘功能照常
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      // Portable 會解壓到 temp 再跑；舊實例結束會刪那個 temp → 必須重啟「原始 portable exe」
      // （PORTABLE_EXECUTABLE_FILE，會重新解壓到新 temp），否則新提權實例的檔案被刪會 crash。
      const { cmd, args } = el.relaunchCommand(platform.autostart.launchPath(), ['--engine-autostart']);
      const cp = spawn(cmd, args, { windowsHide: true });
      cp.on('exit', (code) => {
        if (code === 0) {
          finish({ ok: true });
          // 先把鎖放掉，再等 700ms 退場。提權實例會在它自己啟動後一兩秒問鎖，
          // 我們還握著的話它就會自己退場 —— 使用者眼中是 app 整個消失。
          // 提權實例那邊也有重試（見 acquireSingleInstanceLock），兩邊各做一半。
          try { app.releaseSingleInstanceLock(); } catch (e) {}
          setTimeout(() => app.exit(0), 700);
        }
        else { finish({ ok: false, error: '提權被拒或被公司政策封鎖，分流引擎無法啟動（app 其餘功能不受影響）。' }); }
      });
      cp.on('error', (e) => finish({ ok: false, error: e.message }));
      setTimeout(() => finish({ ok: false, error: '提權逾時' }), 60000);
    } catch (e) { finish({ ok: false, error: e.message }); }
  });
}
ipcMain.handle('engine-elevate', () => relaunchElevated());
ipcMain.handle('is-elevated', () => { setupEngine(); return engine.isElevated(); });

// 分流引擎需要它引用的路由是「活的」（本地端口在聽），否則 TUN 會把流量送往死掉的埠。
// 啟動引擎前先把 split 規則會用到的路由帶起來（與「啟動時自動套用路由」launch 開關無關）。
async function ensureSplitRoutesStarted() {
  setupRouteManager();
  const split = config.getSplit();
  // 規則模式要帶起規則表與預設走向用到的路由；全域模式只需要那一條
  const wanted = new Set((split.mode === 'global'
    ? [split.globalTarget]
    : split.mode === 'direct'
    ? []
    : [split.defaultTarget, ...split.rules.filter(r => r.on !== false).map(r => r.target)]
  ).filter(t => t && t !== 'direct' && t !== 'block'));
  for (const rid of wanted) {
    const def = config.getRoutes().find(r => r.id === rid);
    if (def && !routeManager.isRunning(rid)) {
      const rr = resolveRoute(def);
      if (rr.hops.length && await checkPortFree(rr.localPort)) { try { await routeManager.start(rr); } catch (e) {} }
    }
  }
  sendRouteStatus();
}

// 提權重啟後自動啟動引擎（先把規則會用到的路由帶起來）
async function autoStartEngineElevated() {
  setupEngine();
  await ensureSplitRoutesStarted();
  const r = await engine.start(engineParams());
  sendEngineStatus();
  addLog(r.ok ? 'info' : 'error', 'engine', r.ok ? '分流引擎已自動啟動（提權後）' : ('引擎自動啟動失敗：' + (r.error || r.message || '')));
}

// Window controls
ipcMain.handle('window-minimize', () => mainWindow.minimize());
ipcMain.handle('window-maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('window-close', () => mainWindow.close());

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
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {} };
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
    showMainWindow();   // 使用者重複點捷徑 → 把既有視窗叫出來
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
  initFileLog();
  mainMark('fileLog');
  initSecretStorage();          // 要在任何路由啟動（會讀伺服器密碼）之前
  const tlsMigrated = config.migrateTlsDefaults();
  if (tlsMigrated) addLog('warn', 'system', `${tlsMigrated} 台 HTTPS 伺服器沿用舊版行為：不驗證代理的憑證。可在伺服器設定關閉「略過憑證驗證」`);
  if (config.recoveredFrom()) {
    addLog('error', 'system', '設定檔損毀，已改用預設值重建', `損毀的檔案保留在：${config.recoveredFrom()}`);
  }
  createWindow();
  mainMark('window');
  createTray();
  mainMark('tray');

  const settings = config.getSettings();
  mainMark('settings');

  // 啟動 config 中定義的多端口路由（各自綁定 proxy/串鏈）
  // 受「啟動時自動套用路由」開關控制（settings.autoStartRoutes，預設開）
  // 系統代理的實際狀態：路由起完之後才判斷，指向的路由沒起來就關掉（見 reconcileSystemProxy）
  const afterRoutes = () => { syncSystemProxyFromOS(); reconcileSystemProxy(); sendSystemProxyState(); updateTrayMenu(); };
  if (settings.autoStartRoutes !== false) {
    applyRoutes().then(() => mainMark('routesApplied')).catch(err => addLog('error', 'route', err.message)).finally(afterRoutes);
  } else {
    setupRouteManager(); // 仍建立 route manager（只是不自動起路由），避免其他路徑存取 null
    addLog('info', 'route', '「啟動時自動套用路由」已關閉，略過自動啟動（可到「總覽」手動啟用）');
    afterRoutes();
  }

  // 若是「用到才提權」重啟進來的（帶 --engine-autostart），提權後自動把分流引擎帶起來
  if (process.argv.includes('--engine-autostart')) {
    setTimeout(() => autoStartEngineElevated().catch(err => addLog('error', 'engine', err.message)), 1800);
  }

  watchQuitSentinel();         // 結束請求的備援通道（提權時 UIPI 擋掉視窗訊息，只剩這條）
  // 這兩件事都不急，也都會 spawn 子行程 —— 排在視窗畫出來之後，不要擋啟動
  setTimeout(() => { sweepDeadLegacyLoginItems().catch(() => {}); }, 3000);
  checkUpdatesOnStartup(); // 啟動後靜默檢查更新（僅安裝版）
  sweepStaleUpdateCache();  // 更新裝完之後 pending 會留著上百 MB 的安裝檔
  // 規則庫自動更新（預設關閉；開啟時才連網，延後執行避免拖慢啟動）
  setTimeout(() => maybeAutoUpdateRuleSets().catch(err => addLog('warn', 'ruleset', err.message)), 8000);
  mainMark('readyDone');
});

// 顯示主視窗：若視窗已被銷毀（minimizeToTray 關閉時關窗會銷毀它）就重建，避免 show() 一個已銷毀物件而拋錯。
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  else { mainWindow.show(); mainWindow.focus(); }
}

app.on('window-all-closed', () => {
  // minimizeToTray 關閉時：關窗＝結束整個 app（否則視窗被銷毀但行程還在 → 匣點擊會開不出來）。
  if (!config.getSettings().minimizeToTray) app.quit();
  // 開啟時：保留在系統匣背景執行。
});

// Electron 不會 await before-quit 的 async handler，所以先擋下結束、把清理做完再真正退出。
// 特別是要讓 engine.stop() 有時間移除 TUN、systemProxy.disable() 一定要跑到（否則結束後上不了網）。
app.on('before-quit', (e) => {
  flushLog();                                         // 批次寫入：結束前把還沒落地的行寫完
  if (_quitting) return;                              // 第二次進來（清理已完成）→ 放行結束
  _quitting = true;
  e.preventDefault();
  const force = setTimeout(() => app.exit(0), 8000);  // 保險：清理逾時也一定結束
  resetKillSwitch();                                  // 重試計時器在清理途中觸發會重新拉起 sing-box
  (async () => {
    // 系統代理最先還原：它是同步的、很快，而且漏掉的代價最大（整台機器上不了網）。
    // 放在最後的話，Windows 上引擎收尾最壞要 7 秒多，加上中繼的 2 秒就會撞到 8 秒的強制結束。
    if (systemProxyEnabled) restoreSystemProxy();
    try { if (engine) await engine.stop(); } catch (err) {}          // 再關引擎 → 讓 sing-box 移除 TUN
    try { if (routeManager) await routeManager.stopAll(); } catch (err) {}
  })().finally(() => { clearTimeout(force); app.exit(0); });
});

// 結束時把系統代理關回去。這一步失敗的後果是「關掉 app 之後整台機器上不了網」，
// 所以不能像其他清理那樣 try/catch 吞掉就算了 —— 失敗是要讓使用者知道的。
//
// 三件事：寫完讀回來確認（不信回傳值）、失敗就重試、最後真的不行就留下
// 一則寫得出手動步驟的紀錄。同一類的安靜失敗已經在 refresh() 上咬過一次。
function restoreSystemProxy() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { systemProxy.disable(); } catch (e) { addLog('warn', 'system', `還原系統代理第 ${attempt} 次失敗：${e.message}`); }
    try {
      if (!systemProxy.get().enabled) { systemProxyEnabled = false; return true; }
    } catch (e) { /* 讀不回來就當沒成功，繼續重試 */ }
    sleepSync(250);
  }
  addLog('error', 'system',
    '結束時無法關閉系統代理 —— 這台機器可能會上不了網',
    '請手動關閉：Windows 設定 → 網路和網際網路 → Proxy → 手動設定 Proxy → 關閉；'
    + '或執行 reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f');
  return false;
}
