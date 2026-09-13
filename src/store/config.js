const Store = require('electron-store');

const DEFAULT_SETTINGS = {
  httpPort: 10808,
  socksPort: 10809,
  autoStart: false,
  autoConnect: false,
  autoStartRoutes: true,
  minimizeToTray: true,
  killSwitch: false,
  killSwitchAutoReconnect: true,   // 觸發後自動重試 3 次，每次間隔 4 秒
  // MERGE §6 受保護程式：'all' = 所有走代理的程式（依規則表），
  // 'apps' = 只有 killSwitchApps 列的這幾支。收窄範圍是為了讓其餘程式
  // 在引擎挂掉時繼續上網，代價是這些程式不受保護。
  killSwitchScope: 'all',
  killSwitchApps: [],
  testTarget: null,
  // 規則庫（依網域 / 地區分流用的 rule-set）：預設不自動連網，使用者按下載才會取用
  rulesetAutoUpdate: false,
  rulesetUpdateDays: 7,
  rulesetDetourRouteId: null,   // 下載規則庫時要不要繞某條路由（null = 直連）
  rulesetLastCheck: 0
};

const store = new Store({
  defaults: {
    servers: [],
    activeServerId: null,
    settings: { ...DEFAULT_SETTINGS }
  }
});

function getServers() {
  return store.get('servers');
}

function getServer(id) {
  return getServers().find(s => s.id === id);
}

function addServer(server) {
  const servers = getServers();
  server.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  server.createdAt = Date.now();
  if (!server.type) server.type = 'socks5';
  servers.push(server);
  store.set('servers', servers);
  return server;
}

function updateServer(id, updates) {
  const servers = getServers();
  const idx = servers.findIndex(s => s.id === id);
  if (idx === -1) return null;
  servers[idx] = { ...servers[idx], ...updates, id };
  store.set('servers', servers);
  return servers[idx];
}

function deleteServer(id) {
  const servers = getServers().filter(s => s.id !== id);
  store.set('servers', servers);
  if (store.get('activeServerId') === id) {
    store.set('activeServerId', null);
  }
}

function getActiveServerId() {
  return store.get('activeServerId');
}

function setActiveServerId(id) {
  store.set('activeServerId', id);
}

function getSettings() {
  // 合併預設：升級後新增的 settings 子鍵（舊 config 沒有）會被補上，避免讀到 undefined
  return { ...DEFAULT_SETTINGS, ...(store.get('settings') || {}) };
}

function updateSettings(updates) {
  const settings = { ...getSettings(), ...updates };
  store.set('settings', settings);
  return settings;
}

// 多端口路由：儲存在 settings.routes。route = { id, label, localPort, kind, hops:[serverId,...], enabled }
function getRoutes() {
  return getSettings().routes || [];
}

function setRoutes(routes) {
  updateSettings({ routes });
  return routes;
}

// ===== 分流設定（settings.split）=====
//
// schema 2 起改成「單一規則表 + 可組合條件」。一條規則的所有條件是 AND；
// 由上往下比，第一條命中的就贏（所以不再需要舊的 ruleOrder 開關——順序就是表的順序）。
//
// rule = {
//   id, name, on,
//   target: 'direct' | 'block' | <routeId>,
//   when: {                                   // 四個條件都可省略，有幾個就 AND 幾個
//     app:     { match: 'name'|'path', value },              誰在連
//     dest:    { match: 'domain'|'suffix'|'keyword'|'regex'|'ip'|'ruleset', value },   連去哪
//     port:    '443, 8000-9000',
//     network: 'tcp' | 'udp',
//   },
// }
// value 一律接受「換行 / 逗號 / 分號分隔的字串」或字串陣列。
// when 完全空的規則會被略過（想要「全部」請用 defaultTarget，不要用空規則）。
//
// 另有三個不屬於規則表的開關：
//   mode         'rule'（預設，照規則表走）| 'global'（全部走 globalTarget）| 'direct'（TUN 在但全部直連）
//   globalTarget mode==='global' 時全部流量走哪條路由
//   lanDirect    內建「本機與內網 → 直連」保護規則（預設開，可停用但刪不掉）
const SPLIT_SCHEMA = 2;
const MODES = ['rule', 'global', 'direct'];

function getSplit() {
  const s = getSettings().split || {};
  if ((s.schema || 1) < SPLIT_SCHEMA) return migrateSplit(s);
  return {
    schema: SPLIT_SCHEMA,
    rules: s.rules || [],
    defaultTarget: s.defaultTarget || 'direct',
    udp: !!s.udp,
    mode: MODES.includes(s.mode) ? s.mode : 'rule',
    globalTarget: s.globalTarget || null,
    // 舊設定沒有這個欄位 → 預設開啟。這會修掉「預設走向指向代理時，
    // 印表機／NAS／路由器管理頁等內網流量被送進代理」的問題。
    lanDirect: s.lanDirect !== false,
  };
}

// schema 1 → 2：把「程式規則表」與「網域規則表」合併成一張，順序照舊的 ruleOrder 決定。
// 無損：舊的每一條都會變成只有單一條件的新規則。遷移後立刻寫回，不會重複遷移。
function migrateSplit(old) {
  const app = (old.rules || []).map(r => ({
    id: r.id, name: r.name || r.exe || '未命名規則', on: r.on !== false, target: r.target || 'direct',
    when: { app: { match: r.match === 'path' ? 'path' : 'name', value: r.match === 'path' ? (r.path || '') : (r.exe || '') } },
  }));
  const net = (old.netRules || []).map(r => ({
    id: r.id, name: r.name || '未命名規則', on: r.on !== false, target: r.target || 'direct',
    when: { dest: { match: r.match, value: r.value } },
  }));
  const next = {
    schema: SPLIT_SCHEMA,
    rules: old.ruleOrder === 'net-first' ? [...net, ...app] : [...app, ...net],
    defaultTarget: old.defaultTarget || 'direct',
    udp: !!old.udp,
    mode: 'rule', globalTarget: null, lanDirect: true,
  };
  updateSettings({ split: next });
  return next;
}

function saveSplit(patch) {
  const cur = getSplit();
  const next = { ...cur, ...patch, schema: SPLIT_SCHEMA };
  delete next.netRules; delete next.ruleOrder; // 舊欄位不再寫回，避免半新半舊的設定檔
  updateSettings({ split: next });
  return next;
}

function reorderServers(orderedIds) {
  const servers = getServers();
  const map = new Map(servers.map(s => [s.id, s]));
  const reordered = orderedIds.map(id => map.get(id)).filter(Boolean);
  for (const s of servers) if (!orderedIds.includes(s.id)) reordered.push(s); // 不在排序清單的補回，避免遺失
  store.set('servers', reordered);
  return reordered;
}

module.exports = {
  getServers, getServer, addServer, updateServer, deleteServer,
  getActiveServerId, setActiveServerId,
  getSettings, updateSettings, reorderServers,
  getRoutes, setRoutes,
  getSplit, saveSplit
};
