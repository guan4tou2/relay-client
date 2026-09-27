const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Servers
  getServers: () => ipcRenderer.invoke('get-servers'),
  addServer: (server) => ipcRenderer.invoke('add-server', server),
  updateServer: (id, updates) => ipcRenderer.invoke('update-server', id, updates),
  deleteServer: (id) => ipcRenderer.invoke('delete-server', id),

  // 憑證庫（存在主行程，密碼加密）
  getCreds: () => ipcRenderer.invoke('get-creds'),
  saveCreds: (list) => ipcRenderer.invoke('save-creds', list),

  // System proxy
  toggleSystemProxy: (enable, port) => ipcRenderer.invoke('toggle-system-proxy', enable, port),
  // 系統代理也可能從系統匣被切換，視窗要跟著更新，否則畫面上的開關會跟實際不一致
  onSystemProxy: (callback) => {
    const listener = (_e, s) => callback(s);
    ipcRenderer.on('system-proxy', listener);
    return () => ipcRenderer.removeListener('system-proxy', listener);
  },

  // Connection test
  testServer: (serverId, testTarget) => ipcRenderer.invoke('test-server', serverId, testTarget),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (updates) => ipcRenderer.invoke('update-settings', updates),

  // App 資訊 + 開機自動啟動（OS 登入項目）
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  perfMarks: () => ipcRenderer.invoke('perf-marks'),
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
  saveRoute: (route) => ipcRenderer.invoke('save-route', route),
  deleteRoute: (id, opts) => ipcRenderer.invoke('delete-route', id, opts),
  routeStart: (id) => ipcRenderer.invoke('route-start', id),
  routeStop: (id) => ipcRenderer.invoke('route-stop', id),
  getRouteStatus: () => ipcRenderer.invoke('get-route-status'),
  browserInfo: () => ipcRenderer.invoke('browser-info'),
  listBrowsers: () => ipcRenderer.invoke('list-browsers'),
  listInstances: () => ipcRenderer.invoke('list-instances'),
  killInstance: (id) => ipcRenderer.invoke('kill-instance', id),
  launchPreview: (d) => ipcRenderer.invoke('launch-preview', d),
  launchInstance: (d) => ipcRenderer.invoke('launch-instance', d),
  onInstances: (callback) => {
    const listener = (_e, list) => callback(list);
    ipcRenderer.on('instances', listener);
    return () => ipcRenderer.removeListener('instances', listener);
  },
  routeProfileInfo: (id) => ipcRenderer.invoke('route-profile-info', id),

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
});
