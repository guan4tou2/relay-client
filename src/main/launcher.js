// 用路由開瀏覽器／其他程式（實例分流）。
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const config = require('../store/config');
const RouteManager = require('../proxy/route-manager');
const { Launcher } = require('../launcher');
const platform = require('../platform').current;
const { send } = require('./state');
const { addLog } = require('./log');
const routes = require('./routes');
const engineMod = require('./engine');

// 找已安裝的 Chromium 系瀏覽器（Chrome 優先、再 Edge），供「用路由開瀏覽器」用
function findBrowser() {
  for (const c of platform.browserCandidates()) { try { if (fs.existsSync(c.path)) return c; } catch (e) {} }
  return null;
}

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
    onChange: (list) => send('instances', list),
  });
  return launcher;
}

function registerIpc(ipcMain) {
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
      const r = routes.resolveRoute(def);
      if (!r.hops || r.hops.length === 0) return { ok: false, error: '此路由沒有有效跳點（先在路由裡加伺服器）' };
      if (d.mode !== 'browser') {
        // exePath 來自 renderer，交給 spawn 之前至少確認它是一個實際存在的絕對路徑
        const exePath = typeof d.exePath === 'string' ? d.exePath.trim() : '';
        if (!exePath || !platform.path.isAbsolute(exePath) || !fs.existsSync(exePath)) {
          return { ok: false, error: '找不到這支程式，請重新選擇' };
        }
        d.exePath = exePath;
      }
      routes.setupRouteManager();
      const routeManager = routes.getRouteManager();
      if (!routeManager.isRunning(def.id)) {
        if (!(await routes.checkPortFree(r.localPort))) return { ok: false, error: `本地埠 ${r.localPort} 已被占用，無法啟動路由` };
        try { await routeManager.start(r); routes.sendRouteStatus(); }
        catch (e) { return { ok: false, error: '路由啟動失敗：' + e.message }; }
      }
      const L = setupLauncher();
      if (d.mode === 'browser') return L.launchBrowser({ route: def, localPort: r.localPort, browserName: d.browserName });

      // 其他程式：sing-box 比的是 process_name / process_path，沒有 PID 規則，
      // 所以「只有這次」做不到。要讓它走代理，就得登記成程式規則。
      const res = L.launchProgram({ route: def, exePath: d.exePath, exeArgs: d.exeArgs });
      if (res.ok && d.remember !== false) {
        const split = config.getSplit();
        const exe = path.basename(d.exePath);
        const dup = (split.rules || []).some(x => x.when && x.when.app && x.when.app.value === exe);
        if (!dup) {
          const rules = [{ id: 'r' + Date.now(), on: true, name: exe, target: def.id,
                           when: { app: { match: 'name', value: exe } } }, ...(split.rules || [])];
          config.saveSplit({ rules });
          await engineMod.reloadEngineIfRunning();
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
}

// 用 Object.assign 而不是重設 module.exports：模組之間互相 require（例如 engine ↔ killswitch），
// 重設的話先載入的那一方會拿到空物件。
Object.assign(module.exports, { setupLauncher, findBrowser, registerIpc });
