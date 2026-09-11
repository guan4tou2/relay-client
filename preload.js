const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Servers
  getServers: () => ipcRenderer.invoke('get-servers'),
  addServer: (server) => ipcRenderer.invoke('add-server', server),
  updateServer: (id, updates) => ipcRenderer.invoke('update-server', id, updates),
  deleteServer: (id) => ipcRenderer.invoke('delete-server', id),
  reorderServers: (ids) => ipcRenderer.invoke('reorder-servers', ids),

  // Proxy control
  startProxy: (serverId) => ipcRenderer.invoke('start-proxy', serverId),
  stopProxy: () => ipcRenderer.invoke('stop-proxy'),
  getProxyStatus: () => ipcRenderer.invoke('get-proxy-status'),

  // System proxy
  toggleSystemProxy: (enable, port) => ipcRenderer.invoke('toggle-system-proxy', enable, port),
  getSystemProxyState: () => ipcRenderer.invoke('get-system-proxy-state'),

  // Connection test
  testServer: (serverId, testTarget) => ipcRenderer.invoke('test-server', serverId, testTarget),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (updates) => ipcRenderer.invoke('update-settings', updates),

  // App 資訊 + 開機自動啟動（OS 登入項目）
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  getLoginItem: () => ipcRenderer.invoke('get-login-item'),
  setLoginItem: (enable) => ipcRenderer.invoke('set-login-item', enable),

  // 自動更新（electron-updater → GitHub Releases）
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  quitAndInstall: () => ipcRenderer.invoke('quit-and-install'),
  onUpdateStatus: (callback) => {
    const listener = (_e, s) => callback(s);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.removeListener('update-status', listener);
  },

  // Logs
  getLogs: () => ipcRenderer.invoke('get-logs'),
  clearLogs: () => ipcRenderer.invoke('clear-logs'),
  openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
  onLogEntry: (callback) => {
    const listener = (_event, entry) => callback(entry);
    ipcRenderer.on('log-entry', listener);
    return () => ipcRenderer.removeListener('log-entry', listener);
  },

  // Multi-port routes（每個 localPort → 各自的 proxy 或多跳串鏈）
  getRoutes: () => ipcRenderer.invoke('get-routes'),
  saveRoutes: (routes) => ipcRenderer.invoke('save-routes', routes),
  saveRoute: (route) => ipcRenderer.invoke('save-route', route),
  deleteRoute: (id) => ipcRenderer.invoke('delete-route', id),
  routeStart: (id) => ipcRenderer.invoke('route-start', id),
  routeStop: (id) => ipcRenderer.invoke('route-stop', id),
  getRouteStatus: () => ipcRenderer.invoke('get-route-status'),
  launchBrowser: (routeId) => ipcRenderer.invoke('launch-browser', routeId),

  // Per-app 分流（sing-box TUN 引擎）
  getSplit: () => ipcRenderer.invoke('get-split'),
  saveSplit: (patch) => ipcRenderer.invoke('save-split', patch),
  listProcesses: () => ipcRenderer.invoke('list-processes'),
  browseExe: () => ipcRenderer.invoke('browse-exe'),
  engineStart: () => ipcRenderer.invoke('engine-start'),
  engineStop: () => ipcRenderer.invoke('engine-stop'),
  engineElevate: () => ipcRenderer.invoke('engine-elevate'),
  isElevated: () => ipcRenderer.invoke('is-elevated'),
  getEngineStatus: () => ipcRenderer.invoke('get-engine-status'),

  // 依網域 / 地區(GeoIP) 分流的規則庫（rule-set）
  rulesetCatalog: () => ipcRenderer.invoke('ruleset-catalog'),
  rulesetList: () => ipcRenderer.invoke('ruleset-list'),
  rulesetInstall: (tag) => ipcRenderer.invoke('ruleset-install', tag),
  rulesetUpdate: (tag) => ipcRenderer.invoke('ruleset-update', tag),
  rulesetUpdateAll: () => ipcRenderer.invoke('ruleset-update-all'),
  rulesetImport: () => ipcRenderer.invoke('ruleset-import'),
  rulesetRemove: (tag) => ipcRenderer.invoke('ruleset-remove', tag),

  // 規則模擬器：輸入網址／IP（可加程式）→ 回傳會命中哪條規則、走哪條路由
  ruleMatch: (query) => ipcRenderer.invoke('rule-match', query),

  // 命中次數（解析引擎 debug log 得到，每秒推一次）
  getEngineHits: () => ipcRenderer.invoke('get-engine-hits'),
  onEngineHits: (callback) => {
    const listener = (_e, hits) => callback(hits);
    ipcRenderer.on('engine-hits', listener);
    return () => ipcRenderer.removeListener('engine-hits', listener);
  },

  // 斷線保護（Kill-switch）
  getKillswitch: () => ipcRenderer.invoke('get-killswitch'),
  killswitchReconnect: () => ipcRenderer.invoke('killswitch-reconnect'),
  killswitchClear: () => ipcRenderer.invoke('killswitch-clear'),
  onKillswitch: (callback) => {
    const listener = (_e, s) => callback(s);
    ipcRenderer.on('killswitch', listener);
    return () => ipcRenderer.removeListener('killswitch', listener);
  },
  onEngineStatus: (callback) => {
    const listener = (_e, s) => callback(s);
    ipcRenderer.on('engine-status', listener);
    return () => ipcRenderer.removeListener('engine-status', listener);
  },
  onEngineStats: (callback) => {
    const listener = (_e, s) => callback(s);
    ipcRenderer.on('engine-stats', listener);
    return () => ipcRenderer.removeListener('engine-stats', listener);
  },
  onRouteStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('route-status', listener);
    return () => ipcRenderer.removeListener('route-status', listener);
  },
  onRouteStats: (callback) => {
    const listener = (_event, stats) => callback(stats);
    ipcRenderer.on('route-stats', listener);
    return () => ipcRenderer.removeListener('route-stats', listener);
  },

  // Window controls
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),

  // Events
  onStats: (callback) => {
    const listener = (_event, stats) => callback(stats);
    ipcRenderer.on('proxy-stats', listener);
    return () => ipcRenderer.removeListener('proxy-stats', listener);
  },
  onStatusChange: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('proxy-status-change', listener);
    return () => ipcRenderer.removeListener('proxy-status-change', listener);
  }
});
