const Store = require('electron-store');

const DEFAULT_SETTINGS = {
  httpPort: 10808,
  socksPort: 10809,
  autoStart: false,
  autoConnect: false,
  autoStartRoutes: true,
  minimizeToTray: true,
  killSwitch: false,
  testTarget: null
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

// Per-app 分流：儲存在 settings.split。
// rule = { id, name, exe, path, match:'name'|'path', target:'direct'|routeId, on }
function getSplit() {
  const s = getSettings().split || {};
  return { rules: s.rules || [], defaultTarget: s.defaultTarget || 'direct', udp: !!s.udp };
}

function saveSplit(patch) {
  const cur = getSplit();
  const next = { ...cur, ...patch };
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
