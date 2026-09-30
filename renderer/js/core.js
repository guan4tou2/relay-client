'use strict';
// 共用：小工具、全域 state、session 計時器、面板開關、對話框焦點管理。其他檔都依賴這裡，要最先載入。
// renderer 的各檔都是一般 <script>（不是 module），最外層的宣告在各檔之間共用；載入順序見 index.html。

/* RelayClient renderer v2 — 照 Claude Design「SOCKS5 Client Redesign v2（路由模型）」一比一還原，
   以真實 IPC 後端取代設計稿模擬。路由（route）為主概念：每條路由 = 一個本地端口 → 一串上游跳點，
   各自擁有獨立 runtime session；多條可同時執行。設計稿為 React，此處以原生 JS 重建：
   骨架 mount() 建一次，電源 SVG 常駐、以 targeted update 套用（保留元素才能觸發 CSS 過場）。 */

const app = document.getElementById('app');
// 回傳 any：畫面都是 innerHTML 組出來的，元素實際是 input / button / select 只有呼叫端知道
/** @type {(id: string) => any} */
const $ = id => document.getElementById(id);
const setDisp = (id, on) => { const e = $(id); if (e) e.style.display = on ? 'block' : 'none'; };

// 真實伺服器物件用 type/username/password；設計稿用 proto/user/pass。統一以下列存取。
const sProto = s => { const t = (s && s.type) || 'socks5'; return PROTO[t] ? t : 'socks5'; }; // 未知型別退回 socks5，避免 PROTO[..] undefined 整頁崩
const sUser = s => (s && s.username) || '';
const sPass = s => (s && s.password) || '';

const PROTO = {
  socks5: { label: 'SOCKS5', name: '帳號密碼認證', port: 1080, auth: 'userpass', authTitle: '帳號密碼' },
  socks4: { label: 'SOCKS4', name: '無認證機制', port: 1080, auth: 'none', hint: '沒有密碼機制，只能附帶一個識別字串。', authTitle: 'User ID' },
  http: { label: 'HTTP', name: '帳號密碼認證', port: 8080, auth: 'basic', authTitle: '帳號密碼' },
  https: { label: 'HTTPS', name: '帳號密碼認證（加密）', port: 8443, auth: 'basic', hint: '先建立加密連線再送出帳密。', authTitle: '帳號密碼' },
};
// 用 CSS 變數而不是色碼：深色主題的 accent／amber／red 是另一組值，寫死會在深色下對比不足
const LEVELS = { info: 'var(--accent)', warn: 'var(--amber)', error: 'var(--red)', debug: 'var(--text3)' };
const SRC_TITLE = { system: '系統', test: '連線測試', route: '路由', 'socks-relay': 'SOCKS 中繼', 'http-bridge': 'HTTP 橋接', 'win-proxy': '系統代理' };
const ICONS = {
  local: ['M4 5h16v10H4zM8 19h8M12 15v4'],
  hop: ['M12 3l7 4v6c0 4-3 6.5-7 8-4-1.5-7-4-7-8V7l7-4z'],
  target: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3.5 9h17M3.5 15h17M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18'],
};
const iconSvg = (paths, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${paths.map(d => `<path d="${d}"></path>`).join('')}</svg>`;
const POWER_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>';

let logSeq = 0;
const state = {
  theme: 'light', themeMode: '系統', tab: 'dashboard', sel: null,
  servers: [], routes: [], sessions: {},
  sys: false, sysHintSeen: false, range: '60 秒', copied: false, toast: '', banner: '',
  routeSheet: false, routeEditing: null, draft: { label: '', localPort: '10808', kind: 'socks5', hops: [], enabled: true },
  srvSheet: false, srvEditing: null, proto: 'socks5', authOpen: false, showPass: false, credPick: '', _form: { name: '', host: '', port: '', note: '', user: '', pass: '' },
  menu: null, level: 'all', search: '', expanded: {}, logs: [],
  creds: [],   // 開機後由 loadCreds() 從主行程載入（密碼在主行程加密存放）
  credEdit: null, cdraft: { name: '', user: '', pass: '', note: '' },
  pendingRouteDel: null, pendingSrvDel: null, pendingCredDel: null, pendingLogClear: false,
  srvBusy: false, routeBusy: false, bootLaunch: false, alert: null,
  killswitch: { tripped: false, reason: '', blocking: false },
  update: { status: 'idle', version: '', percent: 0 },
  settings: { httpPort: 10808, socksPort: 10809, minimizeToTray: true, autoConnect: false, autoStartRoutes: true, testTarget: null },
  // ---- 分流（split routing）狀態 ----
  splitRules: [], splitDefaultTarget: 'direct', splitUdp: false,
  splitMode: 'rule', splitGlobalTarget: null, splitLanDirect: true,
  splitEngine: 'off', splitElevated: false, splitTun: null, splitHealth: [],
  splitFilter: '全部', splitSearch: '', splitSheet: false, splitEditing: null,
  splitProcs: [], splitCatalog: [], splitInstalled: [],
  splitSimHost: '', splitSimExe: '', splitSim: null, splitHitId: null, splitSimOpen: false,
  ksAlertOpen: false,
  splitDraft: { name: '', when: {}, target: 'direct', error: '' }, splitOpenConds: {},
  splitPendingDel: null, splitDrag: null, splitUac: false, splitUacSeen: false,
  setsBusy: null, setsPendingDel: null,
  browser: null,   // { name, path }；找不到 Chrome/Edge 時為 null
  browsers: [],        // [{ name, found }]
  instances: [],       // 由本程式啟動的實例（設計稿 v5）
  launchSheet: false, launchDraft: null, launchBusy: false, launchPreview: '', pendingKill: null,
};

// ------- session 小工具 -------
const sTimers = {};
function setSes(id, patch) { state.sessions[id] = { ...(state.sessions[id] || {}), ...patch }; }
function dropSes(id) { delete state.sessions[id]; }
function sTimeout(id, fn, ms) { (sTimers[id] = sTimers[id] || []).push(setTimeout(fn, ms)); }
function clearSTimers(id) { (sTimers[id] || []).forEach(clearTimeout); sTimers[id] = []; }
const ses = id => state.sessions[id] || {};
const curRoute = () => state.routes.find(r => r.id === state.sel);
const runningRouteIds = () => state.routes.filter(r => ses(r.id).status === 'running').map(r => r.id);
const activeRouteIds = () => state.routes.filter(r => ['running', 'connecting'].includes(ses(r.id).status)).map(r => r.id);
const srvName = id => (state.servers.find(x => x.id === id) || {}).name || '（已刪除）';
const testColor = l => l == null ? 'var(--text3)' : l < 0 ? 'var(--red)' : l < 200 ? 'var(--good)' : 'var(--amber)';
const segCss = on => `font-weight:${on ? 600 : 500};background:${on ? 'var(--panel)' : 'transparent'};color:${on ? 'var(--text)' : 'var(--text2)'};box-shadow:${on ? '0 1px 3px rgba(0,0,0,.12)' : 'none'}`;

// 面板的遮罩只蓋住內容區，標題列仍可點 —— 不先收掉舊面板的話，換分頁再開另一種面板
// 會兩層遮罩疊在一起。開任何面板前、切分頁時都先收乾淨。
const anyOverlayOpen = () => !!(state.routeSheet || state.srvSheet || state.splitSheet || state.launchSheet
  || state.splitUac || state.alert || (state.killswitch && state.killswitch.tripped));
function closeAllSheets() {
  if (state.routeSheet) closeRouteSheet();
  if (state.srvSheet) closeSrvSheet();
  if (state.splitSheet) closeSplitSheet();
  if (state.launchSheet) closeLaunchSheet();
}

// =====================================================================================
// 對話框的焦點管理（鍵盤與螢幕閱讀器）
// =====================================================================================
// 各個面板、對話框都是 innerHTML 整塊重畫的，一個一個去補焦點處理會漏。
// 這裡改成監看它們的掛載點：最上層的對話框一出現就把焦點移進去、記住原本在哪，
// Tab 只在對話框裡循環，對話框消失時把焦點還回去。
// 陣列順序 = 疊放順序（前面的蓋在後面的上面）。
const DIALOGS = [
  { root: 'menuBox', role: 'menu' },
  { root: 'ksBox', initial: () => $('ksReconnect') },            // z-index 150
  { root: 'spUacBox', initial: () => $('spUacGrant') },          // 150
  { root: 'alertBox', initial: () => (state.alert && state.alert.danger ? ($('alertDismiss') || $('alertCancel')) : $('alertPrimary')) },   // 140
  { root: 'lsPanel' }, { root: 'spSheetPanel' }, { root: 'ssPanel' }, { root: 'rdPanel' },
];
const FOCUSABLE = 'button:not([disabled]),input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),select:not([disabled]),summary,a[href],[tabindex]:not([tabindex="-1"])';
const focusStack = [];      // [{ root, el, ret }]；ret = 關掉之後焦點要回去的元素 { el, key }
const lastFocusIn = {};     // root → 對話框裡最後一個有焦點的元素選擇器（重畫後接回去）

const topDialog = () => { for (const d of DIALOGS) { const el = $(d.root); if (el) return { d, el }; } return null; };
const focusablesIn = el => [...el.querySelectorAll(FOCUSABLE)].filter(x => x.getClientRects().length);

// 重畫之後元素是新的，要靠選擇器找回「同一顆」：有 id 用 id，沒有就用第一個 data-* 屬性
// （路由列、上移／下移、跳點這些按鈕都只有 data-*）
function focusKey(el) {
  if (!el || el === document.body || !el.getAttribute) return null;
  if (el.id) return '#' + CSS.escape(el.id);
  for (const a of el.attributes) if (a.name.startsWith('data-')) return `[${a.name}="${CSS.escape(a.value)}"]`;
  return null;
}
const findByKey = (key, scope = document) => { try { return key ? scope.querySelector(key) : null; } catch (e) { return null; } };

function dialogInitial(d, el) {
  const pick = d.initial && d.initial();
  if (pick && el.contains(pick)) return pick;
  if (d.role === 'menu') return el.querySelector('[data-mi][aria-checked="true"]') || el.querySelector('[data-mi]');
  return el.querySelector('input:not([disabled]):not([type="checkbox"]),textarea:not([disabled])') || focusablesIn(el)[0] || el;
}

function decorateDialog(d, el) {
  if (d.role === 'menu') {
    el.setAttribute('role', 'menu');
    el.querySelectorAll('[data-mi]').forEach(b => b.setAttribute('role', 'menuitemradio'));
  } else {
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    const title = el.querySelector('span[style*="font-weight:700"]');
    if (title && !el.getAttribute('aria-label')) el.setAttribute('aria-label', title.textContent.trim());
  }
  if (!el.hasAttribute('tabindex')) el.tabIndex = -1;   // 沒有可聚焦元素時至少能把焦點放在框上
}

function restoreFocus(ret, scope) {
  if (!ret) return false;
  const t = (ret.el && ret.el.isConnected && (!scope || scope.contains(ret.el))) ? ret.el : findByKey(ret.key, scope || document);
  if (t && t.focus) { t.focus(); return true; }
  return false;
}

function syncDialogFocus() {
  // 1. 已經不在畫面上的對話框出棧。一次關掉好幾層時，焦點回到最底下那層的開啟者
  let popped = null;
  while (focusStack.length && !$(focusStack[focusStack.length - 1].root)) popped = focusStack.pop();
  const top = topDialog();
  const cur = focusStack[focusStack.length - 1];
  if (popped && (!top || (cur && cur.root === top.d.root))) {
    // 回到底下那層（或回到主畫面）：還給開啟者；開啟者不在底下那層裡就聚焦那層的預設元素
    if (!restoreFocus(popped.ret, top ? top.el : null) && top) { const t = dialogInitial(top.d, top.el); if (t) t.focus(); }
  }
  if (!top) return;
  decorateDialog(top.d, top.el);
  if (!cur || cur.root !== top.d.root) {
    // 新的一層。若是同一批裡取代了剛關掉的那層（例如關掉 A 面板、打開 B 面板），沿用 A 的返回目標，
    // 不然這時的 activeElement 可能在 B 裡面，關掉 B 之後焦點就掉到 body
    const a = document.activeElement;
    const ret = popped && (!a || a === document.body || top.el.contains(a)) ? popped.ret : { el: a, key: focusKey(a) };
    focusStack.push({ root: top.d.root, el: top.el, ret });
    delete lastFocusIn[top.d.root];
  }
  focusStack[focusStack.length - 1].el = top.el;
  // 2. 焦點不在最上層對話框裡（剛打開，或整塊重畫把原本的元素換掉了）→ 接回去
  if (!top.el.contains(document.activeElement)) {
    const back = findByKey(lastFocusIn[top.d.root], top.el);
    const t = back || dialogInitial(top.d, top.el);
    if (t) t.focus({ preventScroll: true });
  }
}

function initDialogFocus() {
  const mo = new MutationObserver(() => syncDialogFocus());
  ['menuMount', 'alertMount', 'ksMount', 'splitUacMount', 'launchSheetMount', 'splitSheetMount', 'srvSheetMount', 'sheetMount']
    .forEach(id => { const m = $(id); if (m) mo.observe(m, { childList: true }); });
  document.addEventListener('focusin', e => {
    const top = topDialog();
    const key = top && top.el.contains(e.target) ? focusKey(e.target) : null;
    if (key) lastFocusIn[top.d.root] = key;
  });
  document.addEventListener('keydown', e => {
    const top = topDialog();
    if (!top) return;
    if (e.key === 'Tab') {
      const list = focusablesIn(top.el);
      if (!list.length) { e.preventDefault(); return; }
      const i = list.indexOf(document.activeElement);
      const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i === -1 || i === list.length - 1 ? 0 : i + 1);
      e.preventDefault();
      list[next].focus();
    } else if (top.d.role === 'menu' && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      const items = [...top.el.querySelectorAll('[data-mi]')];
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
        : e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
      e.preventDefault();
      items[next].focus();
    }
  }, true);
}

// 任一 session 狀態轉變後的統一刷新（不在 300ms tick 呼叫，避免 sidebar dotBeat 每 tick 重置）
function afterStatusChange() {
  renderSidebar();
  syncTitlebar();
  if (state.tab === 'dashboard' && state.routes.length && state.sel) updateDashboard();
  else if (state.tab === 'dashboard') showTab('dashboard');
}
