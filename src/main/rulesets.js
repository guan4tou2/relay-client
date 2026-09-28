// 規則庫（依網域 / 地區(GeoIP) 分流的資料來源）。
const path = require('path');
const { app, dialog } = require('electron');
const config = require('../store/config');
const { RuleSetStore } = require('../engine/ruleset');
const { connectViaChain } = require('../proxy/connect');
const { state } = require('./state');
const { addLog } = require('./log');
const routes = require('./routes');
const engineMod = require('./engine');

let ruleSets = null;

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
  return def ? routes.resolveRoute(def).hops : [];
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
  if (results.some(r => r.ok)) await engineMod.reloadEngineIfRunning();
}

function registerIpc(ipcMain) {
  // ---- 規則庫（rule-set）管理 ----
  ipcMain.handle('ruleset-catalog', () => setupRuleSets().catalog());
  ipcMain.handle('ruleset-list', () => setupRuleSets().list());

  ipcMain.handle('ruleset-install', async (_e, tag) => {
    const r = await setupRuleSets().install(tag, { hops: rulesetDetourHops() });
    addLog(r.ok ? 'info' : 'error', 'ruleset', r.ok ? `規則庫已下載：${tag}（${r.entry.bytes} bytes）` : `規則庫下載失敗：${tag} — ${r.error}`);
    if (r.ok) await engineMod.reloadEngineIfRunning();
    return r;
  });

  ipcMain.handle('ruleset-update', async (_e, tag) => {
    const r = await setupRuleSets().update(tag, { hops: rulesetDetourHops() });
    addLog(r.ok ? 'info' : 'warn', 'ruleset', r.ok ? `規則庫已更新：${tag}` : `規則庫更新失敗：${tag} — ${r.error}`);
    if (r.ok) await engineMod.reloadEngineIfRunning();
    return r;
  });

  ipcMain.handle('ruleset-update-all', async () => {
    const results = await setupRuleSets().updateAll({ hops: rulesetDetourHops() });
    config.updateSettings({ rulesetLastCheck: Date.now() });
    const bad = results.filter(r => !r.ok);
    addLog(bad.length ? 'warn' : 'info', 'ruleset', `規則庫更新完成：成功 ${results.length - bad.length} / ${results.length}`);
    if (results.some(r => r.ok)) await engineMod.reloadEngineIfRunning();
    return results;
  });

  ipcMain.handle('ruleset-import', async () => {
    const r = await dialog.showOpenDialog(state.mainWindow, {
      title: '匯入規則庫',
      filters: [{ name: '規則庫', extensions: ['srs', 'json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const res = setupRuleSets().importFile(r.filePaths[0]);
    addLog(res.ok ? 'info' : 'error', 'ruleset', res.ok ? `規則庫已匯入：${res.entry.tag}` : `規則庫匯入失敗：${res.error}`);
    if (res.ok) await engineMod.reloadEngineIfRunning();
    return res;
  });

  ipcMain.handle('ruleset-remove', async (_e, tag) => {
    const res = setupRuleSets().remove(tag);
    addLog('info', 'ruleset', `規則庫已移除：${tag}`);
    await engineMod.reloadEngineIfRunning();
    return res;
  });
}

// 用 Object.assign 而不是重設 module.exports：模組之間互相 require（例如 engine ↔ killswitch），
// 重設的話先載入的那一方會拿到空物件。
Object.assign(module.exports, { setupRuleSets, referencedSetTags, maybeAutoUpdateRuleSets, registerIpc });
