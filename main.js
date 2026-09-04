const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const net = require('net');
const tls = require('tls');
const { connectViaProxy } = require('./src/proxy/connect');
const config = require('./src/store/config');
const SocksRelay = require('./src/proxy/socks-relay');
const HttpBridge = require('./src/proxy/http-bridge');
const RouteManager = require('./src/proxy/route-manager');
const SingBoxEngine = require('./src/engine/singbox');
const winProxy = require('./src/system/win-proxy');
const { execSync, spawn } = require('child_process');

let mainWindow = null;
let tray = null;
let socksRelay = null;
let httpBridge = null;
let routeManager = null;
let engine = null;
let proxyRunning = false;
let systemProxyEnabled = false;
let startTime = null;

// Debug log buffer
const LOG_MAX = 500;
const logBuffer = [];

function addLog(level, source, message, detail) {
  const entry = {
    time: new Date().toISOString(),
    level,
    source,
    message,
    detail: detail || null
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
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
  tray.setToolTip('代理客戶端');
  tray.on('double-click', () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

function updateTrayMenu() {
  if (tray) tray.setImage(createTrayIcon(proxyRunning));
  const menu = Menu.buildFromTemplate([
    { label: '代理客戶端', enabled: false },
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
          winProxy.disableProxy();
          systemProxyEnabled = false;
        } else {
          const settings = config.getSettings();
          winProxy.enableProxy(settings.httpPort);
          systemProxyEnabled = true;
        }
        updateTrayMenu();
        sendStatusToRenderer();
      }
    },
    { type: 'separator' },
    {
      label: '顯示主視窗',
      click: () => { mainWindow.show(); mainWindow.focus(); }
    },
    {
      label: '結束',
      click: async () => {
        await stopProxyServers();
        if (systemProxyEnabled) winProxy.disableProxy();
        app.exit(0);
      }
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
    winProxy.disableProxy();
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
    winProxy.enableProxy(port || settings.httpPort);
    systemProxyEnabled = true;
  } else {
    winProxy.disableProxy();
    systemProxyEnabled = false;
  }
  updateTrayMenu();
  return { systemProxyEnabled };
});

ipcMain.handle('get-system-proxy-state', () => winProxy.getProxyState());

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
function appLaunchPath() { return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath; }
ipcMain.handle('get-login-item', () => {
  try { return app.getLoginItemSettings({ path: appLaunchPath() }).openAtLogin; }
  catch (e) { return false; }
});
ipcMain.handle('set-login-item', (_e, enable) => {
  try {
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
  sendRouteStatus();
  return config.getRoutes();
});

// ===== Per-app 分流引擎（sing-box TUN）=====
function setupEngine() {
  if (engine) return;
  engine = new SingBoxEngine();
  engine.on('status', (s) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('engine-status', s); });
  engine.on('log', (line) => addLog('debug', 'engine', String(line).replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 400)));
  engine.on('exit', (code) => {
    // block（斷線保護）模式自己中止 → 不遞迴再觸發，只記錄並回報
    if (engine._blocking) { addLog('error', 'killswitch', `斷線保護(block)模式也中止了（code ${code}）——受保護程式已無 TUN`); killSwitchState.blocking = false; sendKillSwitch(); sendEngineStatus(); return; }
    addLog('warn', 'engine', `分流引擎異常結束（code ${code}）`);
    if (config.getSettings().killSwitch) triggerKillSwitch(code);
    else sendEngineStatus();
  });
}

// ===== 斷線保護（Kill-switch）=====
// 分流引擎「非使用者主動」中止時，若已啟用，立即以 fail-closed block 模式重建 TUN，
// 讓受保護程式無法以真實 IP 外洩；並通知 UI 顯示告警與「重新連線 / 停用保護」。
let killSwitchState = { tripped: false, reason: '', blocking: false };
function sendKillSwitch() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('killswitch', { ...killSwitchState, enabled: !!config.getSettings().killSwitch });
}
async function triggerKillSwitch(code) {
  killSwitchState = { tripped: true, reason: `分流引擎異常中止（code ${code}）`, blocking: false };
  addLog('error', 'killswitch', '斷線保護啟動：以 fail-closed 模式封鎖受保護程式，防止流量以真實 IP 外洩');
  try {
    const r = await engine.startBlock(engineParams());
    killSwitchState.blocking = !!(r && r.ok);
    if (!(r && r.ok)) addLog('error', 'killswitch', `block 模式啟動失敗：${(r && r.error) || '未知'}`);
  } catch (e) { addLog('error', 'killswitch', `block 模式例外：${e.message}`); }
  sendKillSwitch();
  sendEngineStatus();
}
ipcMain.handle('get-killswitch', () => ({ ...killSwitchState, enabled: !!config.getSettings().killSwitch }));
ipcMain.handle('killswitch-reconnect', async () => {
  setupEngine();
  await engine.stop();               // 先收掉 block 模式
  const r = await engine.start(engineParams());
  if (r && r.ok) killSwitchState = { tripped: false, reason: '', blocking: false };
  sendKillSwitch(); sendEngineStatus();
  return r;
});
ipcMain.handle('killswitch-clear', async () => {
  setupEngine();
  await engine.stop();               // 移除 TUN，恢復正常網路（使用者明確接受直連）
  killSwitchState = { tripped: false, reason: '', blocking: false };
  sendKillSwitch(); sendEngineStatus();
  return { ok: true };
});

function engineParams() {
  const split = config.getSplit();
  const self = require('path').basename(process.execPath); // dev: electron.exe；打包: 代理客戶端.exe
  return { rules: split.rules, defaultTarget: split.defaultTarget, udp: split.udp, routes: config.getRoutes(), selfNames: [self] };
}

function sendEngineStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('engine-status', engine ? engine.status() : { state: 'off', elevated: false, tun: null, health: [] });
}

// 列舉執行中的程式（含完整路徑），供規則挑選器用
function listProcesses() {
  try {
    const out = execSync('powershell -NoProfile -Command "Get-Process | Where-Object {$_.Path} | Select-Object Name,Id,Path | ConvertTo-Json -Compress"', { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }).toString();
    let arr = JSON.parse(out); if (!Array.isArray(arr)) arr = [arr];
    const seen = new Set(); const res = [];
    for (const p of arr) {
      if (!p.Path || seen.has(p.Path.toLowerCase())) continue;
      seen.add(p.Path.toLowerCase());
      res.push({ pid: p.Id, name: p.Name, path: p.Path, exe: require('path').basename(p.Path) });
    }
    return res.sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) { return []; }
}

ipcMain.handle('get-split', () => config.getSplit());
ipcMain.handle('save-split', async (_e, patch) => {
  const s = config.saveSplit(patch);
  if (engine && engine.state === 'running') { await engine.stop(); await engine.start(engineParams()); sendEngineStatus(); } // 立即套用
  return s;
});
ipcMain.handle('list-processes', () => listProcesses());
ipcMain.handle('browse-exe', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { title: '選擇程式', filters: [{ name: '程式', extensions: ['exe'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0]; const base = require('path').basename(p);
  return { name: base.replace(/\.exe$/i, ''), exe: base, path: p };
});
ipcMain.handle('engine-start', async () => {
  setupEngine();
  const r = await engine.start(engineParams());
  sendEngineStatus();
  return r;
});
ipcMain.handle('engine-stop', async () => {
  if (engine) await engine.stop();
  sendEngineStatus();
  return { ok: true };
});
ipcMain.handle('get-engine-status', () => { setupEngine(); return engine.status(); });

// 用到才提權：以系統管理員重啟自己（帶旗標讓新實例自動啟動引擎與其上游路由）。
// app 本身用 asInvoker 正常啟動，只有分流引擎（建 TUN）需要提權。
function relaunchElevated() {
  // 用 powershell 的 Start-Process -Verb RunAs 觸發 UAC，並「等它結束」判斷結果：
  //   exit 0 = 使用者同意、提權實例已啟動 → 才收掉目前這個（避免埠衝突、避免像 crash）
  //   非 0 / error = 被拒或被公司政策封鎖 → 不關閉，回報錯誤，其餘功能照常
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      // Portable 會解壓到 temp 再跑；舊實例結束會刪那個 temp → 必須重啟「原始 portable exe」
      // （PORTABLE_EXECUTABLE_FILE，會重新解壓到新 temp），否則新提權實例的檔案被刪會 crash。
      const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
      const psCmd = `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList '--engine-autostart' -Verb RunAs`;
      const cp = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', psCmd], { windowsHide: true });
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

// 提權重啟後自動啟動引擎（先把規則會用到的路由帶起來）
async function autoStartEngineElevated() {
  setupEngine();
  const split = config.getSplit();
  const wanted = new Set([split.defaultTarget, ...split.rules.filter(r => r.on).map(r => r.target)].filter(t => t && t !== 'direct'));
  for (const rid of wanted) {
    const def = config.getRoutes().find(r => r.id === rid);
    if (def && !routeManager.isRunning(rid)) {
      const rr = resolveRoute(def);
      if (rr.hops.length) { try { await routeManager.start(rr); } catch (e) {} }
    }
  }
  sendRouteStatus();
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

app.whenReady().then(() => {
  createWindow();
  createTray();

  const settings = config.getSettings();
  if (settings.autoConnect) {
    const activeId = config.getActiveServerId();
    if (activeId) startProxyServers(activeId).catch(() => {});
  }

  // 啟動 config 中定義的多端口路由（各自綁定 proxy/串鏈，獨立於主連線）
  applyRoutes().catch(err => addLog('error', 'route', err.message));

  // 若是「用到才提權」重啟進來的（帶 --engine-autostart），提權後自動把分流引擎帶起來
  if (process.argv.includes('--engine-autostart')) {
    setTimeout(() => autoStartEngineElevated().catch(err => addLog('error', 'engine', err.message)), 1800);
  }

  checkUpdatesOnStartup(); // 啟動後靜默檢查更新（僅安裝版）
});

app.on('window-all-closed', () => {
  // Keep running in tray
});

app.on('before-quit', async () => {
  if (proxyRunning) await stopProxyServers();
  if (routeManager) await routeManager.stopAll();
  if (engine) await engine.stop();
  if (systemProxyEnabled) winProxy.disableProxy();
});
