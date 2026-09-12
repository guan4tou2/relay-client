const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const { connectViaProxy, connectViaChain } = require('./src/proxy/connect');
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
const SocksRelay = require('./src/proxy/socks-relay');
const HttpBridge = require('./src/proxy/http-bridge');
const RouteManager = require('./src/proxy/route-manager');
const SingBoxEngine = require('./src/engine/singbox');
const { RuleSetStore } = require('./src/engine/ruleset');
const { HitParser } = require('./src/engine/hit-parser');
const platform = require('./src/platform').current;  // 平台差異一律走 adapter，main.js 不做 process.platform 判斷
const systemProxy = platform.systemProxy;            // 系統代理開關（Windows 登錄檔 / macOS networksetup / Linux gsettings）
const { execSync, spawn } = require('child_process');

let mainWindow = null;
let tray = null;
let socksRelay = null;
let httpBridge = null;
let routeManager = null;
let engine = null;
let ruleSets = null;
let proxyRunning = false;
let systemProxyEnabled = false;
let startTime = null;

// Debug log buffer（記憶體，供「紀錄」分頁即時顯示）
const LOG_MAX = 500;
const logBuffer = [];

// 持久化紀錄：每筆 log 同時落地到 userData/logs/app.log（自動輪替；只存本機、不外流）
const LOG_FILE_MAX = 1024 * 1024; // 單檔上限 1 MB
const LOG_FILE_KEEP = 2;          // 保留 app.log + app.1.log
let logDir = null;
let logFilePath = null;

function initFileLog() {
  try {
    logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    logFilePath = path.join(logDir, 'app.log');
    fileLog({ time: new Date().toISOString(), level: 'info', source: 'system',
      message: `===== 紀錄開始 v${app.getVersion()} · ${process.platform} =====` });
  } catch (e) { logFilePath = null; }
}

function rotateLogIfNeeded() {
  try {
    if (!logFilePath || !fs.existsSync(logFilePath)) return;
    if (fs.statSync(logFilePath).size < LOG_FILE_MAX) return;
    for (let i = LOG_FILE_KEEP - 1; i >= 1; i--) {
      const src = i === 1 ? logFilePath : path.join(logDir, `app.${i - 1}.log`);
      const dst = path.join(logDir, `app.${i}.log`);
      if (fs.existsSync(src)) { try { fs.renameSync(src, dst); } catch (e) {} }
    }
  } catch (e) { /* ignore */ }
}

function fileLog(entry) {
  if (!logFilePath) return; // 尚未初始化（如測試環境）→ 不落地
  try {
    rotateLogIfNeeded();
    const lvl = String(entry.level || 'info').toUpperCase().padEnd(5);
    const line = `${entry.time} ${lvl} ${entry.source}: ${entry.message}` +
      `${entry.detail ? ' | ' + entry.detail : ''}\n`;
    fs.appendFileSync(logFilePath, line);
  } catch (e) { /* 落地失敗不影響 app 運作 */ }
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
    height: 620,
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

function updateTrayMenu() {
  if (tray) tray.setImage(createTrayIcon(proxyRunning));
  const menu = Menu.buildFromTemplate([
    { label: 'RelayClient', enabled: false },
    { type: 'separator' },
    {
      label: proxyRunning ? '⬤ 已連線' : '○ 未連線',
      enabled: false
    },
    {
      label: proxyRunning ? '中斷連線' : '連線',
      click: async () => {
        if (proxyRunning) {
          await stopProxyServers();
        } else {
          const activeId = config.getActiveServerId();
          if (activeId) await startProxyServers(activeId);
        }
      }
    },
    {
      label: systemProxyEnabled ? '關閉系統代理' : '啟用系統代理',
      click: () => {
        if (systemProxyEnabled) {
          systemProxy.disable();
          systemProxyEnabled = false;
        } else {
          const settings = config.getSettings();
          systemProxy.enable(settings.httpPort);
          systemProxyEnabled = true;
        }
        updateTrayMenu();
        sendStatusToRenderer();
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

async function startProxyServers(serverId) {
  const server = config.getServer(serverId);
  if (!server) throw new Error('Server not found');

  const settings = config.getSettings();

  // 埠衝突守衛：兩個本地埠若被占用（其他程式或既有路由），彈告警並阻擋，不硬啟動
  const busy = [];
  if (!(await checkPortFree(settings.httpPort))) busy.push(settings.httpPort);
  if (!(await checkPortFree(settings.socksPort))) busy.push(settings.socksPort);
  if (busy.length) {
    const detail = `本地連接埠 ${busy.join('、')} 已被占用。\n請關閉占用該埠的程式，或到設定改用其他連接埠後再試。`;
    addLog('error', 'system', `port conflict on ${busy.join(', ')} — connection blocked`);
    showPortConflictDialog(detail);
    throw new Error(`Local port in use: ${busy.join(', ')}`);
  }

  const remoteProxy = {
    host: server.host,
    port: server.port,
    type: server.type || 'socks5',
    username: server.username || undefined,
    password: server.password || undefined
  };

  socksRelay = new SocksRelay();
  httpBridge = new HttpBridge();

  const onStats = (stats) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('proxy-stats', {
        ...stats,
        uptime: startTime ? Date.now() - startTime : 0
      });
    }
  };

  socksRelay.on('stats', onStats);
  httpBridge.on('stats', onStats);

  socksRelay.on('log', (level, msg, detail) => addLog(level, 'socks-relay', msg, detail));
  httpBridge.on('log', (level, msg, detail) => addLog(level, 'http-bridge', msg, detail));
  socksRelay.on('error', err => addLog('error', 'socks-relay', err.message));
  httpBridge.on('error', err => addLog('error', 'http-bridge', err.message));

  addLog('info', 'system', `Starting proxy to ${server.host}:${server.port}`);

  await httpBridge.start(settings.httpPort, remoteProxy);
  addLog('info', 'http-bridge', `Listening on 127.0.0.1:${settings.httpPort}`);

  await socksRelay.start(settings.socksPort, remoteProxy);
  addLog('info', 'socks-relay', `Listening on 127.0.0.1:${settings.socksPort}`);

  proxyRunning = true;
  startTime = Date.now();
  config.setActiveServerId(serverId);
  updateTrayMenu();
  sendStatusToRenderer();
}

async function stopProxyServers() {
  if (!proxyRunning && !socksRelay && !httpBridge) return;
  addLog('info', 'system', 'Stopping proxy servers');
  if (socksRelay) { await socksRelay.stop(); socksRelay = null; }
  if (httpBridge) { await httpBridge.stop(); httpBridge = null; }
  proxyRunning = false;
  startTime = null;
  updateTrayMenu();
  sendStatusToRenderer();
}

function sendStatusToRenderer() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('proxy-status-change', {
      proxyRunning,
      systemProxyEnabled,
      activeServerId: config.getActiveServerId()
    });
  }
}

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
      socket = tls.connect(server.port, server.host, { rejectUnauthorized: false }, onConnect);
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
    socket.once('error', (err) => { socket.destroy(); reject(err); });
  });
}

// IPC Handlers
ipcMain.handle('get-servers', () => config.getServers());
ipcMain.handle('add-server', (_e, server) => config.addServer(server));
ipcMain.handle('update-server', (_e, id, updates) => config.updateServer(id, updates));
ipcMain.handle('delete-server', (_e, id) => {
  config.deleteServer(id);
  return true;
});
ipcMain.handle('reorder-servers', (_e, ids) => config.reorderServers(ids));

ipcMain.handle('start-proxy', async (_e, serverId) => {
  try {
    if (proxyRunning) await stopProxyServers();
    await startProxyServers(serverId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('stop-proxy', async () => {
  await stopProxyServers();
  if (systemProxyEnabled) {
    systemProxy.disable();
    systemProxyEnabled = false;
  }
  return { success: true };
});

ipcMain.handle('get-proxy-status', () => ({
  proxyRunning,
  systemProxyEnabled,
  activeServerId: config.getActiveServerId()
}));

ipcMain.handle('toggle-system-proxy', (_e, enable, port) => {
  const settings = config.getSettings();
  if (enable) {
    systemProxy.enable(port || settings.httpPort);
    systemProxyEnabled = true;
  } else {
    systemProxy.disable();
    systemProxyEnabled = false;
  }
  updateTrayMenu();
  return { systemProxyEnabled };
});

ipcMain.handle('get-system-proxy-state', () => systemProxy.get());

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
      const proxy = { host: server.host, port: server.port, type: proxyType, username: server.username, password: server.password };
      const sock = await connectViaProxy(proxy, { host: target.host, port: target.port });
      sock.destroy();
      latency = Date.now() - start;
    } else {
      addLog('info', 'test', `Testing ${proxyType} handshake ${server.host}:${server.port}`);
      latency = await testProxyHandshake(server);
    }
    config.updateServer(serverId, { latency, lastTest: Date.now(), status: 'ok' });
    addLog('info', 'test', `SUCCESS ${server.host}:${server.port} — ${latency}ms`);
    return { success: true, latency };
  } catch (err) {
    config.updateServer(serverId, { latency: -1, lastTest: Date.now(), status: 'error' });
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
ipcMain.handle('update-settings', (_e, updates) => config.updateSettings(updates));

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
ipcMain.handle('get-login-item', () => {
  try {
    return platform.autostart.usesElectronLoginItem
      ? app.getLoginItemSettings({ path: appLaunchPath() }).openAtLogin
      : platform.autostart.get();
  } catch (e) { return false; }
});
ipcMain.handle('set-login-item', (_e, enable) => {
  try {
    // Electron 的 setLoginItemSettings 在 Linux 沒有實作 → adapter 自己寫 XDG autostart .desktop
    if (!platform.autostart.usesElectronLoginItem) return platform.autostart.set(!!enable);
    app.setLoginItemSettings({ openAtLogin: !!enable, path: appLaunchPath(), args: [] });
    return { ok: true, enabled: !!enable };
  } catch (e) { addLog('error', 'system', `set-login-item failed: ${e.message}`); return { ok: false, error: e.message }; }
});

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
  setTimeout(() => { try { ensureAutoUpdater().checkForUpdates().catch(() => {}); } catch (e) {} }, 4000);
}

// ===== 多端口路由（每個 localPort → 各自的 proxy 或多跳串鏈）=====
function serverToProxy(s) {
  if (!s) return null;
  return {
    host: s.host, port: s.port, type: s.type || 'socks5',
    username: s.username || undefined, password: s.password || undefined
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

  const settings = config.getSettings();
  const primaryPorts = proxyRunning ? [settings.httpPort, settings.socksPort] : [];
  const enabled = config.getRoutes().filter(r => r.enabled !== false);

  // 先解析路由並剔除無跳點者（不算衝突，僅記錄）
  const resolved = [];
  for (const def of enabled) {
    const r = resolveRoute(def);
    r._name = def.label || r.id;
    if (r.hops.length === 0) { addLog('warn', `route:${r.id}`, 'no valid hops (server missing)'); continue; }
    resolved.push(r);
  }

  // 純邏輯偵測「與主連線埠衝突 / 路由間重複」（已抽成可測試的 RouteManager.detectPortConflicts）
  const { clear, conflicts: portConflicts } = RouteManager.detectPortConflicts(resolved, primaryPorts);
  const nameOf = id => { const r = resolved.find(x => x.id === id); return r ? r._name : id; };
  const conflicts = portConflicts.map(c => c.reason === 'primary'
    ? `• ${nameOf(c.id)}：埠 ${c.port} 與主連線衝突`
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
}

ipcMain.handle('get-routes', () => config.getRoutes());
ipcMain.handle('save-routes', async (_e, routes) => {
  config.setRoutes(routes);
  const results = await applyRoutes();
  return { results, status: routeManager ? routeManager.status() : [] };
});
ipcMain.handle('get-route-status', () => (routeManager ? routeManager.status() : []));

// 找已安裝的 Chromium 系瀏覽器（Chrome 優先、再 Edge），供「用路由開瀏覽器」用
function findBrowser() {
  for (const c of platform.browserCandidates()) { try { if (fs.existsSync(c.path)) return c; } catch (e) {} }
  return null;
}

// 用某條路由開一個「隔離 profile + 指向該路由本地埠」的瀏覽器實例：
// 只有這個視窗走代理，其餘系統瀏覽照常。免 TUN、免提權——TUN 分流的替代做法。
ipcMain.handle('launch-browser', async (_e, routeId) => {
  try {
    const def = config.getRoutes().find(r => r.id === routeId);
    if (!def) return { ok: false, error: '找不到該路由' };
    const r = resolveRoute(def);
    if (!r.hops || r.hops.length === 0) return { ok: false, error: '此路由沒有有效跳點（先在路由裡加伺服器）' };

    // 確保路由在跑（本地埠有在聽），瀏覽器才連得上
    setupRouteManager();
    if (!routeManager.isRunning(routeId)) {
      if (!(await checkPortFree(r.localPort))) return { ok: false, error: `本地埠 ${r.localPort} 已被占用，無法啟動路由` };
      try { await routeManager.start(r); sendRouteStatus(); }
      catch (e) { return { ok: false, error: '路由啟動失敗：' + e.message }; }
    }

    const browser = findBrowser();
    if (!browser) return { ok: false, error: '找不到 Chrome / Edge，請確認已安裝' };

    const scheme = def.kind === 'http' ? 'http' : 'socks5';
    const profileDir = path.join(app.getPath('userData'), 'browser-profiles', String(routeId).replace(/[^\w.-]/g, '_'));
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch (e) {}
    const args = [
      `--proxy-server=${scheme}://127.0.0.1:${r.localPort}`,
      `--user-data-dir=${profileDir}`,
      // 防洩漏（這兩個是安全性，不是體感功能）：
      //   host-resolver-rules：不讓瀏覽器自己用系統 DNS 解析，全部交給代理解析。
      //     少了它，即使連線走代理，DNS 查詢仍會從真實 IP 發出，等於暴露你在看哪些網站。
      //     EXCLUDE 127.0.0.1 是必要的——否則連本地中繼自己都解析不到。
      //   force-webrtc-ip-handling-policy：擋掉 WebRTC 的非代理 UDP 通道，
      //     那是繞過 proxy 直接洩漏真實 IP 最經典的一條路。
      '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--no-first-run', '--no-default-browser-check', 'about:blank',
    ];
    const child = spawn(browser.path, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => {}); // spawn 失敗別變成未處理錯誤
    child.unref();
    addLog('info', 'launch', `用路由「${def.label || routeId}」開啟 ${browser.name}`, `${scheme}://127.0.0.1:${r.localPort}`);
    return { ok: true, browser: browser.name };
  } catch (e) { return { ok: false, error: e.message }; }
});

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
  sendRouteStatus();
  return { ok: true, status: routeManager ? routeManager.status() : [] };
});

// 新增/更新單一路由（只 persist，不自動啟動；由 renderer 決定啟停）
ipcMain.handle('save-route', (_e, route) => {
  const routes = config.getRoutes();
  const i = routes.findIndex(r => r.id === route.id);
  if (i >= 0) routes[i] = route; else routes.push(route);
  config.setRoutes(routes);
  return routes;
});

ipcMain.handle('delete-route', async (_e, id) => {
  if (routeManager) await routeManager.stop(id);
  config.setRoutes(config.getRoutes().filter(r => r.id !== id));
  // 這條路由的瀏覽器 profile（cookie / 登入狀態）也一併清掉，避免遺留可識別的資料
  try {
    const dir = path.join(app.getPath('userData'), 'browser-profiles', String(id).replace(/[^\w.-]/g, '_'));
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
  if (info && info.kind === 'self') return;   // app 自己的流量不記
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
let killSwitchState = { tripped: false, reason: '', blocking: false, retries: 0, reconnecting: false };
let ksRetryTimer = null;
// 自動重連（settings.killSwitchAutoReconnect，預設開）
function scheduleKillSwitchRetry() {
  clearTimeout(ksRetryTimer);
  if (!config.getSettings().killSwitchAutoReconnect) return;
  if (killSwitchState.retries >= KS_MAX_RETRY) {
    addLog('warn', 'killswitch', `已自動重試 ${KS_MAX_RETRY} 次仍失敗，請手動處理`);
    return;
  }
  ksRetryTimer = setTimeout(async () => {
    if (!killSwitchState.tripped) return;
    killSwitchState.retries += 1;
    killSwitchState.reconnecting = true;
    sendKillSwitch();
    addLog('info', 'killswitch', `自動重連第 ${killSwitchState.retries} 次…`);
    try {
      await engine.stop();
      await ensureSplitRoutesStarted();
      const r = await engine.start(engineParams());
      if (r && r.ok) {
        clearTimeout(ksRetryTimer);
        killSwitchState = { tripped: false, reason: '', blocking: false, retries: 0, reconnecting: false };
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
async function triggerKillSwitch(code) {
  const retries = killSwitchState.tripped ? killSwitchState.retries : 0;
  killSwitchState = { tripped: true, reason: `分流引擎異常中止（code ${code}）`, blocking: false, retries, reconnecting: false };
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
  const r = await engine.start(engineParams());
  if (r && r.ok) killSwitchState = { tripped: false, reason: '', blocking: false, retries: 0, reconnecting: false };
  sendKillSwitch(); sendEngineStatus();
  return r;
});
ipcMain.handle('killswitch-clear', async () => {
  clearTimeout(ksRetryTimer);
  setupEngine();
  await engine.stop();               // 移除 TUN，恢復正常網路（使用者明確接受直連）
  killSwitchState = { tripped: false, reason: '', blocking: false, retries: 0, reconnecting: false };
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
  };
}

function sendEngineStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('engine-status', engine ? engine.status() : { state: 'off', elevated: false, tun: null, health: [] });
}

// 列舉執行中的程式（含完整路徑），供規則挑選器用
ipcMain.handle('get-split', () => config.getSplit());
ipcMain.handle('save-split', async (_e, patch) => {
  const s = config.saveSplit(patch);
  if (engine && engine.state === 'running') { await engine.stop(); await ensureSplitRoutesStarted(); await engine.start(engineParams()); sendEngineStatus(); } // 立即套用（先帶起規則要用的路由）
  return s;
});
ipcMain.handle('list-processes', () => platform.listProcesses());
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
  });
  const rt = config.getRoutes().find(r => r.id === res.target);
  return { ...res, targetLabel: res.target === 'direct' ? '直接連線' : res.target === 'block' ? '封鎖' : (rt ? rt.label || rt.id : '（路由已刪除）') };
});

// 規則庫變動 → 引擎在跑就重載設定（等同 save-split 的即時套用）
async function reloadEngineIfRunning() {
  if (!(engine && engine.state === 'running')) return;
  await engine.stop();
  await ensureSplitRoutesStarted();
  await engine.start(engineParams());
  sendEngineStatus();
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
  if (engine) await engine.stop();
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
        if (code === 0) { finish({ ok: true }); setTimeout(() => app.exit(0), 700); }
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

app.whenReady().then(async () => {
  initFileLog();
  createWindow();
  createTray();

  const settings = config.getSettings();
  if (settings.autoConnect) {
    const activeId = config.getActiveServerId();
    if (activeId) { try { await startProxyServers(activeId); } catch (e) {} } // 先把主連線起好，applyRoutes 的埠衝突檢查才看得到 primaryPorts
  }

  // 啟動 config 中定義的多端口路由（各自綁定 proxy/串鏈，獨立於主連線）
  // 受「啟動時自動套用路由」開關控制（settings.autoStartRoutes，預設開）
  if (settings.autoStartRoutes !== false) {
    applyRoutes().catch(err => addLog('error', 'route', err.message));
  } else {
    setupRouteManager(); // 仍建立 route manager（只是不自動起路由），避免其他路徑存取 null
    addLog('info', 'route', '「啟動時自動套用路由」已關閉，略過自動啟動（可到「總覽」手動啟用）');
  }

  // 若是「用到才提權」重啟進來的（帶 --engine-autostart），提權後自動把分流引擎帶起來
  if (process.argv.includes('--engine-autostart')) {
    setTimeout(() => autoStartEngineElevated().catch(err => addLog('error', 'engine', err.message)), 1800);
  }

  checkUpdatesOnStartup(); // 啟動後靜默檢查更新（僅安裝版）
  // 規則庫自動更新（預設關閉；開啟時才連網，延後執行避免拖慢啟動）
  setTimeout(() => maybeAutoUpdateRuleSets().catch(err => addLog('warn', 'ruleset', err.message)), 8000);
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
let _quitting = false;
app.on('before-quit', (e) => {
  if (_quitting) return;                              // 第二次進來（清理已完成）→ 放行結束
  _quitting = true;
  e.preventDefault();
  const force = setTimeout(() => app.exit(0), 5000);  // 保險：清理逾時也一定結束
  (async () => {
    try { if (engine) await engine.stop(); } catch (err) {}          // 先關引擎 → 讓 sing-box 移除 TUN
    try { if (routeManager) await routeManager.stopAll(); } catch (err) {}
    try { if (proxyRunning) await stopProxyServers(); } catch (err) {}
    try { if (systemProxyEnabled) systemProxy.disable(); } catch (err) {}
  })().finally(() => { clearTimeout(force); app.exit(0); });
});
