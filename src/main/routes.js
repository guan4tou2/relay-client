// 多端口路由：每個本地埠 → 各自的上游代理或多跳串鏈。
const fs = require('fs');
const net = require('net');
const { dialog } = require('electron');
const config = require('../store/config');
const RouteManager = require('../proxy/route-manager');   // SocksRelay / HttpBridge 由它持有，這裡不直接碰
const { state, send } = require('./state');
const { addLog } = require('./log');
const systemProxy = require('./system-proxy');
const win = require('./window');
const launcher = require('./launcher');

let routeManager = null;
const getRouteManager = () => routeManager;
// 正在跑的路由（系統代理、系統匣都依它判斷）
const runningRoutes = () => (routeManager ? routeManager.status().filter(r => r.running) : []);

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
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    dialog.showMessageBox(state.mainWindow, {
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
  routeManager.on('stats', (routeId, stats) => send('route-stats', { routeId, ...stats }));
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
  send('route-status', routeManager ? routeManager.status() : []);
  // 系統匣的「路由執行中」與「啟用系統代理」是依路由狀態算的；只在切換代理時重建的話，
  // 開機後路由非同步起來，選單會一直停在「沒有路由在跑」、代理選項也一直是灰的。
  win.updateTrayMenu();
}

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

function registerIpc(ipcMain) {
  ipcMain.handle('get-routes', () => config.getRoutes());
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
    systemProxy.reconcileSystemProxy();
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

  ipcMain.handle('delete-route', async (_e, id, opts) => {
    if (routeManager) await routeManager.stop(id);
    systemProxy.reconcileSystemProxy();
    config.setRoutes(config.getRoutes().filter(r => r.id !== id));
    // 這條路由的瀏覽器 profile（cookie / 登入狀態）。MERGE §4：要問過才能刪，
    // 不問就刪等於連帶把使用者在那個視窗裡的登入狀態一起清掉。
    if (opts && opts.keepProfile) { sendRouteStatus(); return config.getRoutes(); }
    try {
      if (!RouteManager.isValidRouteId(id)) throw new Error(`路由 id 不合法，不清除 profile：${String(id).slice(0, 80)}`);
      const dir = launcher.setupLauncher().profileDir(id);
      if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); addLog('info', 'launch', `已清除路由 ${id} 的瀏覽器 profile`); }
    } catch (e) { addLog('warn', 'launch', `清除瀏覽器 profile 失敗：${e.message}`); }
    sendRouteStatus();
    return config.getRoutes();
  });
}

// 用 Object.assign 而不是重設 module.exports：模組之間互相 require（例如 engine ↔ killswitch），
// 重設的話先載入的那一方會拿到空物件。
Object.assign(module.exports, { serverToProxy, resolveRoute, setupRouteManager, getRouteManager, runningRoutes, applyRoutes, sendRouteStatus, checkPortFree, ensureSplitRoutesStarted, registerIpc });
