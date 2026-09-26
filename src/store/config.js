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
  rulesetLastCheck: 0,
  // 逐連線的 CONNECT 預設只留在畫面上、不寫進紀錄檔：它佔了紀錄檔 99.98% 的行數，
  // 開著等於每三天就把所有診斷訊息輪替掉。要抓連線層的問題再臨時打開。
  logConnections: false
};

const STORE_OPTS = {
  defaults: {
    servers: [],
    activeServerId: null,
    creds: [],
    settings: { ...DEFAULT_SETTINGS }
  }
};

// config.json 壞掉（斷電寫到一半、手動改壞）時 electron-store 8 預設直接丟 SyntaxError，
// 而這裡是在 main.js 最頂端被 require 的 —— 連錯誤攔截都還沒掛上，app 就起不來了。
// 壞檔改名留著（使用者或我們還救得回伺服器清單），用預設值重建。
let recoveredFrom = null;
function openStore() {
  try { return new Store(STORE_OPTS); }
  catch (e) {
    if (!e || e.name !== 'SyntaxError') throw e;
    const fs = require('fs');
    const path = require('path');
    const { app } = require('electron');
    const file = path.join(app.getPath('userData'), 'config.json');
    const backup = path.join(app.getPath('userData'), `config.corrupt-${Date.now()}.json`);
    try { fs.renameSync(file, backup); recoveredFrom = backup; } catch (err) { throw e; }
    return new Store(STORE_OPTS);
  }
}
const store = openStore();

// ===== 密碼加密（safeStorage）=====
// config.js 不直接 require electron（單元測試不跑 electron）；main.js 在 app ready 後
// 用 setCipher 注入 safeStorage。沒注入、或這台機器不支援加密時照舊存明文。
// 存檔格式：'enc:v1:<base64>'。讀取時兩種都認，舊檔的明文會在 migrateSecrets() 補加密。
const ENC_PREFIX = 'enc:v1:';
let cipher = null;   // { encrypt: (string) => Buffer, decrypt: (Buffer) => string }
let decryptFailures = 0;

function setCipher(c) {
  cipher = c && typeof c.encrypt === 'function' && typeof c.decrypt === 'function' ? c : null;
  decryptFailures = 0;
}

function seal(v) {
  if (typeof v !== 'string' || !v || v.startsWith(ENC_PREFIX) || !cipher) return v;
  try { return ENC_PREFIX + cipher.encrypt(v).toString('base64'); } catch (e) { return v; }
}

// 解不開（例如設定檔被搬到另一台電腦、或 OS 金鑰被重設）就回空字串，讓使用者重新輸入。
function unseal(v) {
  if (typeof v !== 'string' || !v.startsWith(ENC_PREFIX)) return v;
  if (!cipher) { decryptFailures++; return ''; }
  try { return cipher.decrypt(Buffer.from(v.slice(ENC_PREFIX.length), 'base64')); }
  catch (e) { decryptFailures++; return ''; }
}

// 解不開的密文：畫面上看到的是空字串。使用者沒動密碼欄就存檔時，送回來的也是空字串 ——
// 直接存下去就把原本的密文永久蓋掉了（金鑰圈換了、之後又換回來的話本來還救得回來）。
function isUndecryptable(v) {
  if (typeof v !== 'string' || !v.startsWith(ENC_PREFIX)) return false;
  if (!cipher) return true;
  try { cipher.decrypt(Buffer.from(v.slice(ENC_PREFIX.length), 'base64')); return false; } catch (e) { return true; }
}
const keepOrSeal = (incoming, stored) => (incoming === '' && isUndecryptable(stored) ? stored : seal(incoming));

const rawServers = () => store.get('servers') || [];
const openServer = s => (s && s.password ? { ...s, password: unseal(s.password) } : s);
const sealServer = s => (s && s.password ? { ...s, password: seal(s.password) } : s);

function getServers() {
  return rawServers().map(openServer);
}

function getServer(id) {
  return getServers().find(s => s.id === id);
}

// 埠要是 1..65535 的整數。介面那層也會擋，但存檔是最後一道 ——
// 一個壞掉的埠存進設定檔之後，之後每次連線都會失敗，而錯誤訊息是
// net.connect 丟出來的原文，看不出是設定有問題。
function validPort(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function addServer(server) {
  if (!validPort(server && server.port)) throw new Error(`連接埠不合法：${server && server.port}（要介於 1 到 65535）`);
  const servers = rawServers();
  server.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  server.createdAt = Date.now();
  if (!server.type) server.type = 'socks5';
  servers.push(sealServer(server));
  store.set('servers', servers);
  return server;
}

function updateServer(id, updates) {
  if (updates && 'port' in updates && !validPort(updates.port)) {
    throw new Error(`連接埠不合法：${updates.port}（要介於 1 到 65535）`);
  }
  const servers = rawServers();
  const idx = servers.findIndex(s => s.id === id);
  if (idx === -1) return null;
  const patch = { ...updates };
  if ('password' in patch) patch.password = keepOrSeal(patch.password, servers[idx].password);
  servers[idx] = { ...servers[idx], ...patch, id };
  store.set('servers', servers);
  return openServer(servers[idx]);
}

function deleteServer(id) {
  const servers = rawServers().filter(s => s.id !== id);
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

// ===== 憑證庫 =====
// 以前放在 renderer 的 localStorage（Chromium 的 leveldb，明文）。搬進 electron-store，密碼跟伺服器一樣加密。
const str = (v, max = 500) => String(v == null ? '' : v).slice(0, max);

function getCreds() {
  const list = store.get('creds');
  return (Array.isArray(list) ? list : []).map(c => ({ ...c, pass: unseal(c.pass) }));
}

function saveCreds(list) {
  if (!Array.isArray(list)) throw new Error('憑證資料不合法');
  const stored = new Map((Array.isArray(store.get('creds')) ? store.get('creds') : []).map(c => [c && c.id, c && c.pass]));
  const clean = list.filter(c => c && typeof c === 'object').map(c => {
    const id = str(c.id, 64) || 'c' + Date.now() + Math.random().toString(36).slice(2, 6);
    return { id, name: str(c.name, 200), user: str(c.user), pass: keepOrSeal(str(c.pass), stored.get(id)), note: str(c.note) };
  });
  store.set('creds', clean);
  return getCreds();
}

// 舊資料補加密：伺服器密碼與憑證庫裡還是明文的，在 cipher 注入之後重寫一次。回傳重寫了幾筆。
function migrateSecrets() {
  if (!cipher) return 0;
  const plain = v => typeof v === 'string' && v && !v.startsWith(ENC_PREFIX);
  const servers = rawServers();
  const s = servers.filter(x => x && plain(x.password)).length;
  if (s) store.set('servers', servers.map(x => (x && plain(x.password) ? sealServer(x) : x)));
  const creds = Array.isArray(store.get('creds')) ? store.get('creds') : [];
  const c = creds.filter(x => x && plain(x.pass)).length;
  if (c) store.set('creds', creds.map(x => (x && plain(x.pass) ? { ...x, pass: seal(x.pass) } : x)));
  return s + c;
}

// 舊版對 HTTPS 代理一律不驗證憑證。改成預設驗證之後，既有的 HTTPS 伺服器先沿用舊行為
// （很多是自簽憑證，一更新就全部連不上比較糟），介面上會標出「未驗證憑證」讓使用者自己關掉。
// 只做一次；之後新增的伺服器預設驗證。回傳這次標記了幾台。
function migrateTlsDefaults() {
  if (getSettings().tlsDefaultsMigrated) return 0;
  const servers = rawServers();
  let n = 0;
  const next = servers.map(x => {
    if (x && x.type === 'https' && x.tlsInsecure === undefined) { n++; return { ...x, tlsInsecure: true }; }
    return x;
  });
  if (n) store.set('servers', next);
  updateSettings({ tlsDefaultsMigrated: true });
  return n;
}

// 舊版匯入會把檔案裡的路由 id 原樣存進來；現在 save-route 只收 ^[\w-]{1,64}$
// （id 會拿去組 profile 目錄，刪路由時整個 rmSync）。不合格式的 id 換成新的，
// 並把分流規則、預設走向、全域目標、規則庫下載路由裡的引用一起改掉。缺 kind 的補 socks5。
const ROUTE_ID_OK = /^[\w-]{1,64}$/;
function migrateRouteIds() {
  const settings = getSettings();
  const routes = Array.isArray(settings.routes) ? settings.routes : [];
  const map = new Map();
  let fixedKind = 0;
  const used = new Set(routes.map(r => r && r.id).filter(id => ROUTE_ID_OK.test(String(id))));
  const next = routes.map((r, i) => {
    if (!r || typeof r !== 'object') return r;
    let out = r;
    if (!ROUTE_ID_OK.test(String(r.id))) {
      let id = 'r-' + (String(r.id).replace(/[^\w-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'migrated') ;
      while (used.has(id)) id = `${id}-${i}`;
      used.add(id);
      map.set(r.id, id);
      out = { ...out, id };
    }
    if (out.kind !== 'socks5' && out.kind !== 'http') { out = { ...out, kind: 'socks5' }; fixedKind++; }
    return out;
  });
  if (!map.size && !fixedKind) return 0;
  const re = t => (map.has(t) ? map.get(t) : t);
  const patch = { routes: next };
  if (settings.split) {
    const sp = settings.split;
    patch.split = { ...sp, rules: (sp.rules || []).map(r => (r && map.has(r.target) ? { ...r, target: re(r.target) } : r)),
      defaultTarget: re(sp.defaultTarget), globalTarget: re(sp.globalTarget) };
  }
  if (map.has(settings.rulesetDetourRouteId)) patch.rulesetDetourRouteId = re(settings.rulesetDetourRouteId);
  updateSettings(patch);
  return map.size + fixedKind;
}

function reorderServers(orderedIds) {
  const servers = rawServers();
  const map = new Map(servers.map(s => [s.id, s]));
  const reordered = orderedIds.map(id => map.get(id)).filter(Boolean);
  for (const s of servers) if (!orderedIds.includes(s.id)) reordered.push(s); // 不在排序清單的補回，避免遺失
  store.set('servers', reordered);
  return reordered;
}

module.exports = {
  getServers, getServer, addServer, updateServer, deleteServer, validPort,
  getActiveServerId, setActiveServerId,
  getSettings, updateSettings, reorderServers,
  getRoutes, setRoutes,
  getSplit, saveSplit,
  getCreds, saveCreds,
  setCipher, migrateSecrets, migrateTlsDefaults, migrateRouteIds,
  decryptFailures: () => decryptFailures,
  recoveredFrom: () => recoveredFrom,
};
