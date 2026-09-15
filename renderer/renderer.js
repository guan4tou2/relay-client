'use strict';
/* RelayClient renderer v2 — 照 Claude Design「SOCKS5 Client Redesign v2（路由模型）」一比一還原，
   以真實 IPC 後端取代設計稿模擬。路由（route）為主概念：每條路由 = 一個本地端口 → 一串上游跳點，
   各自擁有獨立 runtime session；多條可同時執行。設計稿為 React，此處以原生 JS 重建：
   骨架 mount() 建一次，電源 SVG 常駐、以 targeted update 套用（保留元素才能觸發 CSS 過場）。 */

const app = document.getElementById('app');
const $ = id => document.getElementById(id);
const setDisp = (id, on) => { const e = $(id); if (e) e.style.display = on ? 'block' : 'none'; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 真實伺服器物件用 type/username/password；設計稿用 proto/user/pass。統一以下列存取。
const sProto = s => { const t = (s && s.type) || 'socks5'; return PROTO[t] ? t : 'socks5'; }; // 未知型別退回 socks5，避免 PROTO[..] undefined 整頁崩
const sUser = s => (s && s.username) || '';
const sPass = s => (s && s.password) || '';

const PROTO = {
  socks5: { label: 'SOCKS5', name: '帳號密碼認證', port: 1080, auth: 'userpass', hint: '支援帳號密碼認證。', authTitle: '帳號密碼', authDesc: '帳號與密碼' },
  socks4: { label: 'SOCKS4', name: '無認證機制', port: 1080, auth: 'none', hint: '沒有密碼機制，只能附帶一個識別字串。', authTitle: 'User ID', authDesc: '沒有密碼，只有識別字串' },
  http: { label: 'HTTP', name: '帳號密碼認證', port: 8080, auth: 'basic', hint: '支援帳號密碼認證。', authTitle: '帳號密碼', authDesc: '帳號與密碼' },
  https: { label: 'HTTPS', name: '帳號密碼認證（加密）', port: 8443, auth: 'basic', hint: '先建立加密連線再送出帳密。', authTitle: '帳號密碼', authDesc: '帳號密碼（加密傳輸）' },
};
const LEVELS = { info: '#4470c4', warn: '#d98b1f', error: '#d9534a', debug: '#9a9aa2' };
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
  creds: JSON.parse(localStorage.getItem('proxy_creds') || '[]'),
  credEdit: null, cdraft: { name: '', user: '', pass: '', note: '' },
  pendingRouteDel: null, pendingSrvDel: null, bootLaunch: false, alert: null,
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
const fmtBytes = b => { if (b < 1024) return b.toFixed(0) + ' B'; const u = ['KB', 'MB', 'GB']; let i = -1, n = b; while (n >= 1024 && i < 2) { n /= 1024; i++; } return n.toFixed(1) + ' ' + u[i]; };
const testColor = l => l == null ? 'var(--text3)' : l < 0 ? 'var(--red)' : l < 200 ? 'var(--good)' : 'var(--amber)';
const segCss = on => `font-weight:${on ? 600 : 500};background:${on ? 'var(--panel)' : 'transparent'};color:${on ? 'var(--text)' : 'var(--text2)'};box-shadow:${on ? '0 1px 3px rgba(0,0,0,.12)' : 'none'}`;

// 任一 session 狀態轉變後的統一刷新（不在 300ms tick 呼叫，避免 sidebar dotBeat 每 tick 重置）
function afterStatusChange() {
  renderSidebar();
  syncTitlebar();
  if (state.tab === 'dashboard' && state.routes.length && state.sel) updateDashboard();
  else if (state.tab === 'dashboard') showTab('dashboard');
}

// =====================================================================================
// 骨架（建一次）
// =====================================================================================
function mount() {
  app.innerHTML = `
  <div style="width:100vw;height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text);overflow:hidden;font-size:14px;-webkit-font-smoothing:antialiased">

    <div class="titlebar" style="height:56px;flex-shrink:0;display:flex;align-items:center;gap:14px;padding:0 14px;background:var(--panelq);backdrop-filter:saturate(180%) blur(20px);border-bottom:1px solid var(--sep)">
      <div style="display:flex;align-items:center;gap:9px;min-width:186px;flex-shrink:0">
        <svg width="26" height="26" viewBox="0 0 256 256" style="border-radius:7px;flex-shrink:0">
          <rect x="0" y="0" width="256" height="256" rx="56" fill="var(--accent)"></rect>
          <circle cx="128" cy="128" r="76" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="18"></circle>
          <path d="M128 52 A76 76 0 0 1 204 128" fill="none" stroke="#fff" stroke-width="18" stroke-linecap="round"></path>
          <path id="markArc" d="M52 128 A76 76 0 0 0 128 204" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="18" stroke-linecap="round"></path>
          <circle cx="128" cy="128" r="20" fill="#fff"></circle>
        </svg>
        <div style="display:flex;flex-direction:column;line-height:1.2;min-width:0">
          <span style="font-size:13.5px;font-weight:600;letter-spacing:-.2px;white-space:nowrap">RelayClient</span>
          <span id="status" style="font-size:11px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">未執行</span>
        </div>
      </div>
      <div id="tabseg" style="display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:9px;margin:0 auto;flex-shrink:0"></div>
      <div style="display:flex;align-items:center;gap:6px;min-width:186px;justify-content:flex-end;flex-shrink:0">
        <button id="btnTheme" class="hvFill2" title="切換深淺色" aria-label="切換深淺色" style="width:28px;height:28px;border:none;border-radius:7px;background:transparent;color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"></circle><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"></path></svg>
        </button>
        <button id="btnAdd" class="hvBright" title="新增路由 (Ctrl+N)" style="display:flex;align-items:center;gap:5px;border:none;cursor:pointer;height:30px;padding:0 11px;border-radius:8px;background:var(--accent);color:#fff;font-size:12.5px;font-weight:600;white-space:nowrap">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>新增路由
        </button>
        <div style="display:flex;gap:1px;margin-left:2px">
          <button id="btnMin" class="hvFill2" title="最小化" aria-label="最小化" style="width:26px;height:26px;border:none;border-radius:7px;background:transparent;color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.4"><line x1="2" y1="6" x2="10" y2="6"></line></svg></button>
          <button id="btnMax" class="hvFill2" title="最大化" aria-label="最大化" style="width:26px;height:26px;border:none;border-radius:7px;background:transparent;color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2" width="8" height="8" rx="1.5"></rect></svg></button>
          <button id="btnClose" class="hvRed" title="關閉" aria-label="關閉" style="width:26px;height:26px;border:none;border-radius:7px;background:transparent;color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="11" height="11" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5"></line><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"></line></svg></button>
        </div>
      </div>
    </div>

    <div id="banner" style="display:none;flex-shrink:0;align-items:center;gap:10px;padding:9px 16px;background:var(--accent-dim);border-bottom:1px solid var(--sep);font-size:12.5px;animation:toastIn .22s ease-out">
      <span style="width:7px;height:7px;border-radius:50%;background:var(--accent);flex-shrink:0"></span>
      <span id="bannerText" style="flex:1"></span>
      <button id="bannerDismiss" class="hvFill2" style="border:none;background:transparent;color:var(--text2);cursor:pointer;font-size:12px;padding:2px 6px;border-radius:6px">關閉</button>
    </div>

    <div id="ksBar"></div>

    <div style="flex:1;display:flex;overflow:hidden;position:relative">
      <div id="sidebar" style="width:264px;flex-shrink:0;display:flex;flex-direction:column;background:var(--panel);border-right:1px solid var(--sep)">
        <div style="padding:12px 14px 8px;display:flex;align-items:center;gap:8px">
          <span id="sideCount" style="font-size:12px;font-weight:600;color:var(--text2);letter-spacing:.2px">路由 · 0</span>
          <span id="sideRunning" style="margin-left:auto;font-size:11px;color:var(--text3);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace"></span>
        </div>
        <div id="routeList" style="flex:1;overflow-y:auto;padding:0 10px 12px;display:flex;flex-direction:column;gap:8px"></div>
      </div>

      <div id="content" style="flex:1;overflow-y:auto;padding:18px 22px 24px;min-width:0">
        <div id="view-guide" style="height:100%;display:none"></div>
        <div id="view-dash" style="display:none"></div>
        <div id="view-servers" style="display:none"></div>
        <div id="view-logs" style="height:100%;display:none"></div>
        <div id="view-creds" style="display:none"></div>
        <div id="view-settings" style="display:none"></div>
        <div id="view-split" style="display:none"></div>
      </div>

      <div id="sheetMount"></div>
      <div id="srvSheetMount"></div>
      <div id="splitSheetMount"></div>
      <div id="launchSheetMount"></div>
      <div id="splitUacMount"></div>
      <div id="alertMount"></div>
      <div id="ksMount"></div>
      <div id="menuMount"></div>
      <div id="toast" style="display:none;position:absolute;top:12px;right:16px;z-index:80;padding:10px 15px;background:var(--panelq);backdrop-filter:blur(20px);border:1px solid var(--sep);border-radius:11px;box-shadow:var(--shadow);font-size:12.5px;animation:toastIn .2s ease-out;align-items:center;gap:8px">
        <span id="toastDot" style="width:7px;height:7px;border-radius:50%;background:var(--accent)"></span><span id="toastText"></span>
      </div>
    </div>
  </div>`;

  buildDashboard();
  buildLogs();
  buildSettings();
  buildSplit();

  // 讀取實際 OS 開機自啟狀態，反映到設定頁開關
  window.api.getLoginItem().then(v => { state.bootLaunch = !!v; refreshSettings(); }).catch(() => {});
  window.api.getAppInfo().then(i => { const el = document.getElementById('aboutVer'); if (el && i && i.version) el.textContent = i.version; }).catch(() => {});

  $('btnTheme').onclick = () => setTheme(state.theme === 'dark' ? '淺色' : '深色');
  $('btnAdd').onclick = () => state.tab === 'split' ? openSplitSheet() : openRoute();
  $('btnMin').onclick = () => window.api.windowMinimize();
  $('btnMax').onclick = () => window.api.windowMaximize();
  $('btnClose').onclick = () => window.api.windowClose();
  $('bannerDismiss').onclick = () => { state.banner = ''; state.sysHintSeen = true; showBanner(); };

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      if (state.tab === 'logs' || state.tab === 'settings') return;   // 這兩頁沒有新增動作
      if (state.tab === 'split') openSplitSheet(); else openRoute();
    }
    // Ctrl+1–6 切分頁；Ctrl+L 用選取的路由開瀏覽器
    if ((e.metaKey || e.ctrlKey) && /^[1-6]$/.test(e.key)) {
      e.preventDefault();
      const order = ['dashboard', 'split', 'servers', 'logs', 'creds', 'settings'];
      showTab(order[Number(e.key) - 1]);
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      const rid = state.sel || (state.routes[0] || {}).id;
      if (rid) openLaunchSheet(rid); else flash('請先建立一條路由', 'var(--amber)');
    }
    if (e.code === 'Space' && state.tab !== 'split' && !state.routeSheet && !state.srvSheet && !state.alert && e.target === document.body) { e.preventDefault(); togglePower(); }
    if (e.key === 'Escape') { closeMenu(); if (state.launchSheet) closeLaunchSheet(); else if (state.splitUac) closeSplitUac(); else if (state.splitSheet) closeSplitSheet(); else if (state.alert) closeAlert(); else if (state.srvSheet) closeSrvSheet(); else if (state.routeSheet) closeRouteSheet(); }
  });
  document.addEventListener('click', () => closeMenu(), true);
}

// =====================================================================================
// 標題列分頁 + 狀態
// =====================================================================================
function renderTabs() {
  // v7 定案的順序：先選出口（路由）→ 再定規則（分流）→ 再看結果（紀錄）
  const tabs = [['dashboard', '路由'], ['split', '分流'], ['servers', '伺服器'], ['logs', '紀錄'], ['creds', '憑證'], ['settings', '設定']];
  $('tabseg').setAttribute('role', 'tablist');
  $('tabseg').innerHTML = tabs.map(([k, label]) =>
    `<button data-tab="${k}" role="tab" aria-selected="${state.tab === k}" aria-label="${label}" style="border:none;cursor:pointer;padding:6px 13px;border-radius:7px;font-size:12.5px;${segCss(state.tab === k)};transition:background .18s,color .18s;white-space:nowrap;flex-shrink:0">${label}</button>`
  ).join('');
  $('tabseg').querySelectorAll('button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
}

function syncTitlebar() {
  if (state.tab === 'split') { syncSplitTitlebar(); renderTabs(); return; }
  const runIds = runningRouteIds(), actIds = activeRouteIds();
  const st = $('status'); if (!st) return;

  // 標題列副標：設計稿只放一句短狀態（有色），
  // 三段式的狀態列在儀表板頁首列，別把兩者搞混。
  const first = runIds.length === 1 ? (state.routes.find(r => r.id === runIds[0]) || {}) : null;
  st.textContent = runIds.length > 1 ? `${runIds.length} 條路由執行中`
    : first ? `執行中 · ${first.label || '未命名路由'}`
    : actIds.length ? '正在啟動…' : '未執行';
  st.style.color = runIds.length ? 'var(--good)' : actIds.length ? 'var(--amber)' : 'var(--text3)';

  renderDashStatus(runIds, actIds);
  $('markArc').setAttribute('stroke', runIds.length ? '#7fe3bd' : 'rgba(255,255,255,.55)');
  syncAddButton();
  renderTabs();
}

// 儀表板首列：三段狀態句 · 分流引擎開關 · 快捷鍵提示。
// 各段自己著色、可點跳分頁。
function renderDashStatus(runIds, actIds) {
  const st = $('dashStatus'); if (!st) return;
  const segs = [
    { label: runIds.length ? `${runIds.length} 條路由執行中` : actIds.length ? '路由連線中' : '沒有路由執行',
      color: runIds.length ? 'var(--good)' : actIds.length ? 'var(--amber)' : 'var(--text2)', tab: 'dashboard' },
    // 欄位是 state.sys（sysToggle 也讀它）。這裡原本寫成 state.sysProxy ——
    // 那個名字全檔案沒有任何地方賦值過，所以這一段永遠顯示「關閉」。
    { label: runIds.length ? '系統代理' + (state.sys ? '已開' : '關閉') : '系統代理關閉',
      color: state.sys && runIds.length ? 'var(--good)' : 'var(--text2)', tab: 'dashboard' },
    state.killswitch && state.killswitch.tripped
      ? { label: '斷線保護已觸發', color: 'var(--red)', tab: 'split' }
      : { label: state.settings.killSwitch ? '斷線保護就緒' : '斷線保護停用',
          color: state.settings.killSwitch && splitRunning() ? 'var(--good)' : 'var(--text2)', tab: 'settings' },
  ];
  // 末端的分流引擎開關：設計稿是「迷你開關 + 文字」包在一顆有框的鈕裡，
  // 不是徽章。開關本身 32×18、鈕 26 高，狀態靠顏色與撥桿位置表達。
  const engOn = splitRunning(), engBusy = state.splitEngine === 'starting';
  const engTip = engOn ? '停止引擎：程式與網域規則將失效' : '啟動引擎：依程式與網域規則自動分流（需管理員權限）';
  const pill = `<button id="stEnginePill" class="hvFill2" title="${engTip}" style="display:flex;align-items:center;gap:7px;border:1px solid var(--sep);background:var(--card);padding:0 9px 0 6px;height:26px;border-radius:13px;cursor:pointer;color:${engOn ? 'var(--good)' : engBusy ? 'var(--amber)' : 'var(--text2)'};font-weight:500;font-size:12px;white-space:nowrap">
    <span style="width:32px;height:18px;border-radius:9px;position:relative;background:${engOn ? 'var(--good)' : 'var(--fill)'};transition:background .22s;flex-shrink:0"><span style="position:absolute;top:2px;left:${engOn ? '16px' : '2px'};width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:left .22s cubic-bezier(.32,.72,0,1)"></span></span>${engBusy ? '分流引擎啟動中' : engOn ? '分流引擎執行中' : '分流引擎未執行'}
  </button>`;
  // 設計稿在狀態列最右端放快捷鍵提示，用 margin-left:auto 推到底
  const hint = '<span style="margin-left:auto;font-size:11px;color:var(--text3);white-space:nowrap">Ctrl+1–6 切換分頁</span>';
  st.innerHTML = segs.map((g, i) =>
    `${i ? '<span style="color:var(--text3);margin:0 6px">·</span>' : ''}<button data-stseg="${g.tab}" style="border:none;background:transparent;padding:0;cursor:pointer;font-weight:500;font-size:12.5px;white-space:nowrap;color:${g.color}">${esc(g.label)}</button>`).join('') + pill + hint;
  st.querySelectorAll('[data-stseg]').forEach(b => b.onclick = () => showTab(b.dataset.stseg));
  $('stEnginePill').onclick = () => toggleSplitEngine();
}

function showTab(tab) {
  state.tab = tab;
  const noRoutes = state.routes.length === 0;
  const showGuide = tab === 'dashboard' && noRoutes;
  const showDash = tab === 'dashboard' && !noRoutes;
  setDisp('view-guide', showGuide); setDisp('view-dash', showDash);
  setDisp('view-servers', tab === 'servers'); setDisp('view-logs', tab === 'logs');
  setDisp('view-creds', tab === 'creds'); setDisp('view-settings', tab === 'settings');
  setDisp('view-split', tab === 'split');
  const sb = $('sidebar'); if (sb) sb.style.display = tab === 'split' ? 'none' : 'flex'; // 分流為全寬版面，隱藏路由側欄
  if (showGuide) renderGuide();
  if (showDash) updateDashboard();
  if (showDash) renderInstances();
  if (tab === 'servers') renderServers();
  if (tab === 'logs') renderLogList();
  if (tab === 'creds') renderCreds();
  if (tab === 'settings') refreshSettings();
  if (tab === 'split') enterSplit();
  syncAddButton();
  syncTitlebar();
}

// =====================================================================================
// 側邊欄：路由清單
// =====================================================================================
// 這條路由被幾條分流規則指到（MERGE §3-3）。刪除時要提醒影響範圍。
// MERGE §3-3：路由列尾端的引用數「2 條規則 · 1 個實例」（沒引用就不顯示）
function routeRefLabel(routeId) {
  const n = state.splitRules.filter(r => r.on !== false && r.target === routeId).length;
  const inst = state.instances.filter(i => i.routeId === routeId).length;
  return [n ? `${n} 條規則` : '', inst ? `${inst} 個實例` : ''].filter(Boolean).join(' · ');
}

function renderSidebar() {
  const runIds = runningRouteIds();
  $('sideCount').textContent = `路由 · ${state.routes.length}`;
  $('sideRunning').textContent = runIds.length ? runIds.length + ' 執行中' : '';
  const list = $('routeList');
  if (state.routes.length === 0) {
    list.innerHTML = `<div style="padding:20px 10px;text-align:center;color:var(--text3);font-size:12.5px;line-height:1.7">還沒有路由<br>從右側開始新增</div>`;
    return;
  }
  list.innerHTML = state.routes.map(r => {
    const st = ses(r.id).status, conn = st === 'running', busy = st === 'connecting', fail = st === 'failing';
    const active = state.sel === r.id, pend = state.pendingRouteDel === r.id;
    const dot = conn ? 'var(--good)' : busy ? 'var(--amber)' : fail ? 'var(--red)' : 'var(--text3)';
    const chained = r.hops.length > 1;
    const exitName = r.hops.length ? srvName(r.hops[r.hops.length - 1]) : '未設跳點';
    const refs = routeRefLabel(r.id);   // 「2 條規則」——被分流規則引用時取代出口名顯示
    const powerBg = conn ? 'var(--good)' : busy ? 'var(--amber)' : 'var(--fill2)';
    const powerColor = (conn || busy) ? '#fff' : 'var(--text2)';
    const powerTip = conn ? '停止這條路由' : busy ? '正在啟動…' : '啟動這條路由';
    const delIcon = pend
      ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"></path></svg>'
      : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"></path></svg>';
    return `<div class="hvFill2" data-rid="${r.id}" style="padding:11px 12px;border-radius:12px;cursor:pointer;background:${active ? 'var(--fill2)' : 'transparent'};border:1px solid ${active ? 'var(--accent)' : conn ? 'var(--good)' : 'var(--sep)'};display:flex;flex-direction:column;gap:7px;transition:background .16s,border-color .16s">
      <div style="display:flex;align-items:center;gap:7px">
        <span style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${dot};box-shadow:${conn ? '0 0 0 3px rgba(47,158,120,.22)' : 'none'};animation:${conn ? 'dotBeat 2.2s ease-in-out infinite' : 'none'}"></span>
        <span style="font-size:13.5px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.label || '未命名路由')}</span>
        ${chained ? `<span style="font-size:9.5px;font-weight:700;letter-spacing:.3px;padding:2px 5px;border-radius:5px;background:var(--accent-dim);color:var(--accent);flex-shrink:0">${r.hops.length} 跳</span>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-size:9.5px;font-weight:700;letter-spacing:.4px;padding:2px 5px;border-radius:5px;background:var(--fill2);color:var(--text2);flex-shrink:0">${r.kind === 'http' ? 'HTTP' : 'SOCKS5'}</span>
        <span style="font-size:11.5px;color:var(--text2);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace">127.0.0.1:${esc(String(r.localPort))}</span>
        <span style="margin-left:auto;font-size:11px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:96px">${esc(refs || exitName)}</span>
      </div>
      ${active ? `<div style="display:flex;gap:6px;padding-top:2px">
        <button class="hvBright" data-act="power" title="${powerTip}（空白鍵）" style="flex:1;height:26px;border:none;border-radius:7px;background:${powerBg};color:${powerColor};cursor:pointer;display:flex;align-items:center;justify-content:center">${POWER_ICON}</button>
        <button class="hvAcc" data-act="edit" title="編輯路由" style="flex:1;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h4L20 8l-4-4L4 16v4z"></path></svg></button>
        <button class="hvAcc" data-act="browser" title="以此路由啟動程式（Ctrl+L）" style="flex:1;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path></svg></button>
        <button class="hvRed" data-act="del" title="${pend ? '再按一次確認刪除' + (refs ? '（' + refs + '將失效）' : '') : '刪除路由'}" style="flex:1;height:26px;border:none;border-radius:7px;background:${pend ? 'var(--red)' : 'var(--fill2)'};color:${pend ? '#fff' : 'var(--red)'};cursor:pointer;display:flex;align-items:center;justify-content:center">${delIcon}</button>
      </div>` : ''}
    </div>`;
  }).join('');

  list.querySelectorAll('[data-rid]').forEach(row => {
    const id = row.dataset.rid;
    row.addEventListener('click', e => { if (e.target.closest('[data-act]')) return; selectRoute(id); });
    row.querySelector('[data-act="power"]')?.addEventListener('click', e => { e.stopPropagation(); togglePower(id); });
    row.querySelector('[data-act="browser"]')?.addEventListener('click', e => { e.stopPropagation(); openLaunchSheet(id); });
    row.querySelector('[data-act="edit"]')?.addEventListener('click', e => { e.stopPropagation(); openRoute(id); });
    row.querySelector('[data-act="del"]')?.addEventListener('click', e => { e.stopPropagation(); deleteRoute(id); });
  });
}

function selectRoute(id) {
  state.sel = id; state.pendingRouteDel = null;
  renderSidebar();
  if (state.tab === 'dashboard') showTab('dashboard');
}


function deleteRoute(id) {
  if (state.pendingRouteDel !== id) {
    state.pendingRouteDel = id; renderSidebar();
    setTimeout(() => { if (state.pendingRouteDel === id) { state.pendingRouteDel = null; renderSidebar(); } }, 2500);
    return;
  }
  clearSTimers(id); dropSes(id);
  state.pendingRouteDel = null;
  window.api.routeStop(id).catch(() => {});

  const finish = routes => {
    state.routes = routes || [];
    if (state.sel === id) state.sel = state.routes[0] ? state.routes[0].id : null;
    renderSidebar(); showTab(state.tab); flash('已刪除路由');
  };
  const del = keepProfile => window.api.deleteRoute(id, { keepProfile }).then(finish)
    .catch(e => flash('刪除路由失敗：' + (e && e.message || e), 'var(--red)'));

  // 這條路由開過瀏覽器的話會留下 profile（cookie / 登入狀態）。
  // 默默刪掉等於連帶登出，所以先問一句；沒有 profile 就不多這道問題。
  window.api.routeProfileInfo(id).then(info => {
    if (!(info && info.exists)) return del(false);
    state.alert = {
      tone: 'info', title: '這條路由的瀏覽器資料要一併刪除嗎？',
      body: '用這條路由開過的瀏覽器視窗有自己的 cookie 與登入狀態。保留的話下次建相同 id 的路由還能用。',
      primary: '一併刪除', secondary: '保留資料',
      go: () => { closeAlert(); del(false); },
      onSecondary: () => { closeAlert(); del(true); },
    };
    renderAlert();
  }).catch(() => del(false));
}

// =====================================================================================
// 導引（無路由）
// =====================================================================================
// 空狀態接力：無伺服器 → 無路由 → 有路由無規則。每段只給「下一步」，不列全部。
// 儀表板的空狀態只有兩階；第三階「還沒有規則」在分流頁的 spEmpty，
// 因為路由建好之後儀表板要顯示路由列表，不再是空的。
function guideStage() {
  return state.servers.length ? 'route' : 'server';
}

function renderGuide() {
  const stage = guideStage();
  const firstServer = state.servers[0];
  const G = {
    server: {
      icon: '<path d="M4 6h16v5H4zM4 13h16v5H4zM7.5 8.5h.01M7.5 15.5h.01"></path>',
      title: '先新增一台伺服器',
      body: '伺服器就是你手上的 SOCKS / HTTP 代理。路由再從這裡挑跳點組成鏈路。',
      primary: '新增伺服器', onPrimary: () => openSrv(),
      secondary: '匯入', onSecondary: () => importData(),
    },
    route: {
      icon: '<circle cx="5" cy="12" r="2.5"></circle><circle cx="19" cy="12" r="2.5"></circle><circle cx="12" cy="5" r="2.5"></circle><path d="M7.5 12h2M14.5 12h2M12 7.5v2"></path>',
      title: firstServer ? `用「${firstServer.name || firstServer.host}」建一條路由` : '建立第一條路由',
      body: '一條路由 = 一個本地端口 + 一串上游跳點。多條路由可同時執行，各自綁不同端口與線路。',
      primary: '新增路由', onPrimary: () => openRoute(),
      secondary: '匯入', onSecondary: () => importData(),
    },
  }[stage];

  $('view-guide').innerHTML = `
    <div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;text-align:center;animation:fadeUp .3s ease-out">
      <div style="width:62px;height:62px;border-radius:18px;background:var(--accent-dim);display:flex;align-items:center;justify-content:center;color:var(--accent)">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${G.icon}</svg>
      </div>
      <div style="display:flex;flex-direction:column;gap:7px;max-width:360px">
        <span style="font-size:19px;font-weight:700;letter-spacing:-.3px">${esc(G.title)}</span>
        <span style="font-size:13px;color:var(--text2);line-height:1.65;text-wrap:pretty">${esc(G.body)}</span>
      </div>
      <div style="display:flex;gap:10px">
        <button id="guideAdd" class="hvBright" style="height:38px;padding:0 20px;border:none;border-radius:10px;background:var(--accent);color:#fff;font-size:13.5px;font-weight:600;cursor:pointer;white-space:nowrap">${esc(G.primary)}</button>
        <button id="guideAlt" class="hvFill2" style="height:38px;padding:0 20px;border:1px solid var(--sep);border-radius:10px;background:var(--card);color:var(--text);font-size:13.5px;font-weight:600;cursor:pointer;white-space:nowrap">${esc(G.secondary)}</button>
      </div>
      <span style="font-size:11.5px;color:var(--text3)">⌘/Ctrl + N 新增 · 空白鍵啟動選取的路由</span>
    </div>`;
  $('guideAdd').onclick = G.onPrimary;
  $('guideAlt').onclick = G.onSecondary;
}

// =====================================================================================
// 儀表板（建一次；動態值以 updateDashboard 套用，電源 SVG 常駐）
// =====================================================================================
function buildDashboard() {
  $('view-dash').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:14px">
      <div id="dashStatus" style="display:flex;align-items:center;gap:8px;font-size:12.5px;padding:0 2px;flex-wrap:wrap"></div>
      <div style="background:var(--card);border:1px solid var(--sep);border-radius:16px;padding:18px 20px;display:flex;flex-direction:column;gap:15px">
        <div style="display:flex;align-items:center;gap:20px">
          <button id="powerBtn" title="啟動路由（空白鍵）" style="width:100px;height:100px;flex-shrink:0;position:relative;border:none;background:transparent;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center">
            <span id="pwRipple" style="position:absolute;inset:-6px;border-radius:50%;border:1px solid var(--good);opacity:0"></span>
            <span id="pwHalo" style="position:absolute;inset:0;border-radius:50%;background:transparent"></span>
            <svg width="100" height="100" viewBox="0 0 256 256" style="position:absolute;inset:0;overflow:visible">
              <defs>
                <linearGradient id="v2tail" x1="0" y1="0" x2="1" y2="1"><stop id="tailStop0" offset="0" stop-color="var(--accent)" stop-opacity="0"></stop><stop id="tailStop1" offset="1" stop-color="var(--accent)" stop-opacity="1"></stop></linearGradient>
                <linearGradient id="v2sweep" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity="0"></stop><stop offset=".55" stop-color="var(--accent)" stop-opacity=".55"></stop><stop offset="1" stop-color="var(--accent)" stop-opacity="1"></stop></linearGradient>
              </defs>
              <circle cx="128" cy="128" r="90" fill="none" stroke="var(--fill2)" stroke-width="13"></circle>
              <g id="pwArcGroup" style="transform-origin:128px 128px">
                <g style="transform-origin:128px 128px;transform:rotate(-90deg)"><circle id="pwTop" cx="128" cy="128" r="90" fill="none" stroke="var(--accent)" stroke-width="13" stroke-linecap="round" stroke-dasharray="283 283" stroke-dashoffset="283" style="opacity:0"></circle></g>
                <g style="transform-origin:128px 128px;transform:rotate(90deg)"><circle id="pwBot" cx="128" cy="128" r="90" fill="none" stroke="var(--good)" stroke-width="13" stroke-linecap="round" stroke-dasharray="283 283" stroke-dashoffset="283" style="opacity:0"></circle></g>
              </g>
              <g id="pwSweep" style="transform-origin:128px 128px;opacity:0"><path d="M60 173 A90 90 0 0 1 218 128" fill="none" stroke="url(#v2sweep)" stroke-width="13" stroke-linecap="round"></path></g>
              <g id="pwSpin" style="transform-origin:128px 128px;opacity:0"><path d="M128 38 A90 90 0 0 1 218 128" fill="none" stroke="url(#v2tail)" stroke-width="13" stroke-linecap="round"></path><circle id="pwSpinDot" cx="218" cy="128" r="8.5" fill="var(--accent)"></circle></g>
              <circle id="pwNode" cx="128" cy="128" r="26" fill="var(--text3)" style="transition:fill .35s,r 1.2s cubic-bezier(.32,.72,0,1);transform-origin:128px 128px"></circle>
              <circle id="pwHole" cx="128" cy="128" r="9" fill="var(--card)" style="transition:r 1.2s cubic-bezier(.32,.72,0,1)"></circle>
            </svg>
          </button>
          <div style="flex:1;display:flex;flex-direction:column;gap:8px;min-width:0">
            <span id="pwTitle" style="font-size:20px;font-weight:700;letter-spacing:-.4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">未執行</span>
            <span id="pwSub" style="font-size:12.5px;color:var(--text2);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">尚未選擇路由</span>
            <span id="pwMeta" style="font-size:11.5px;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></span>
          </div>
          <div style="width:1px;align-self:stretch;background:var(--sep)"></div>
          <div style="width:144px;flex-shrink:0;display:flex;flex-direction:column;gap:9px">
            <span style="font-size:12.5px;font-weight:600">系統代理</span>
            <span id="sysDesc" style="font-size:11px;color:var(--text2);line-height:1.45">所有系統流量改走此端口</span>
            <button id="sysToggle" title="切換系統代理" style="width:50px;height:30px;border-radius:15px;border:none;padding:0;cursor:pointer;position:relative;background:var(--fill);transition:background .22s">
              <span id="sysKnob" style="position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .22s cubic-bezier(.32,.72,0,1)"></span>
            </button>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;padding-top:13px;border-top:1px solid var(--sep);flex-wrap:wrap;row-gap:9px">
          <button id="copyAddr" class="hvFill2" title="複製本地代理位址" style="display:flex;align-items:center;gap:7px;height:28px;padding:0 10px;border:1px solid var(--sep);border-radius:9px;background:transparent;color:var(--text);cursor:pointer;font-size:11.5px;white-space:nowrap;flex-shrink:0">
            <span id="curKind" style="color:var(--text3);font-weight:600"></span>
            <span id="curAddr" style="font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace"></span>
            <span id="copyIcon" style="width:16px;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--text3)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"></path></svg></span>
            <span id="copyChk" style="width:16px;margin-left:-16px;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--accent);opacity:0;background:var(--card)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12.5 9.5 18 20 6.5"></polyline></svg></span>
          </button>
          <span id="curRouteId" style="font-size:11.5px;color:var(--text3);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace"></span>
          <button id="editCurrent" class="hvAccDim" style="margin-left:auto;height:28px;padding:0 12px;border:1px solid var(--sep);border-radius:9px;background:transparent;color:var(--accent);font-size:12px;font-weight:500;cursor:pointer;flex-shrink:0;white-space:nowrap">編輯路由</button>
        </div>
      </div>

      <div style="background:var(--card);border:1px solid var(--sep);border-radius:16px;padding:16px 18px;display:flex;flex-direction:column;gap:13px">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:13.5px;font-weight:600;white-space:nowrap">連線鏈路</span>
          <span id="chainSummary" style="font-size:11.5px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
        </div>
        <div id="chainRow" style="display:flex;align-items:flex-start;gap:0;overflow-x:auto;padding-bottom:2px"></div>
      </div>

      <div style="background:var(--card);border:1px solid var(--sep);border-radius:16px;padding:15px 18px;display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;align-items:center;gap:14px">
          <span style="font-size:13.5px;font-weight:600;white-space:nowrap">即時速率</span>
          <div style="display:flex;align-items:center;gap:14px;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12px">
            <span style="display:flex;align-items:center;gap:5px"><span style="width:7px;height:7px;border-radius:2px;background:var(--good)"></span>↓ <span id="downRate">0 B/s</span></span>
            <span style="display:flex;align-items:center;gap:5px"><span style="width:7px;height:7px;border-radius:2px;background:var(--purple)"></span>↑ <span id="upRate">0 B/s</span></span>
          </div>
          <div id="rangeSeg" style="margin-left:auto;display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:8px"></div>
        </div>
        <svg viewBox="0 0 560 88" preserveAspectRatio="none" style="width:100%;height:88px;display:block">
          <line x1="0" y1="22" x2="560" y2="22" stroke="var(--sep)" stroke-width="1"></line>
          <line x1="0" y1="55" x2="560" y2="55" stroke="var(--sep)" stroke-width="1"></line>
          <polygon id="areaDown" points="" fill="rgba(47,158,120,.14)"></polygon>
          <polyline id="lineDown" points="" fill="none" stroke="var(--good)" stroke-width="2" stroke-linejoin="round"></polyline>
          <polyline id="lineUp" points="" fill="none" stroke="var(--purple)" stroke-width="1.6" stroke-linejoin="round" stroke-dasharray="3 3"></polyline>
        </svg>
        <div style="display:flex;gap:22px;padding-top:11px;border-top:1px solid var(--sep)">
          <div style="display:flex;flex-direction:column;gap:3px"><span style="font-size:10.5px;color:var(--text3);font-weight:600;letter-spacing:.3px;white-space:nowrap">連線數</span><span id="statConns" style="font-size:16px;font-weight:600;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace">0</span></div>
          <div style="display:flex;flex-direction:column;gap:3px"><span style="font-size:10.5px;color:var(--text3);font-weight:600;letter-spacing:.3px;white-space:nowrap">上傳總量</span><span id="statUp" style="font-size:16px;font-weight:600;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace">0 B</span></div>
          <div style="display:flex;flex-direction:column;gap:3px"><span style="font-size:10.5px;color:var(--text3);font-weight:600;letter-spacing:.3px;white-space:nowrap">下載總量</span><span id="statDown" style="font-size:16px;font-weight:600;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace">0 B</span></div>
          <div style="display:flex;flex-direction:column;gap:3px"><span style="font-size:10.5px;color:var(--text3);font-weight:600;letter-spacing:.3px;white-space:nowrap">已執行</span><span id="statUptime" style="font-size:16px;font-weight:600;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace">00:00</span></div>
        </div>
      </div>
      <div id="dashInstances" style="display:none"></div>
    </div>`;

  $('powerBtn').onclick = () => togglePower();
  $('sysToggle').onclick = () => toggleSys();
  $('copyAddr').onclick = () => copyAddr();
  $('editCurrent').onclick = () => openRoute(state.sel);
  renderRange();
}

function renderRange() {
  $('rangeSeg').innerHTML = ['60 秒', '5 分鐘'].map(r =>
    `<button data-r="${r}" style="border:none;cursor:pointer;height:27px;padding:0 11px;border-radius:6px;font-size:12px;white-space:nowrap;flex-shrink:0;${segCss(state.range === r)}">${r}</button>`
  ).join('');
  $('rangeSeg').querySelectorAll('button').forEach(b => b.onclick = () => { state.range = b.dataset.r; renderRange(); updateTraffic(); });
}

// 電源按鈕：讀 selected route 的 session，套用到常駐 SVG（保留元素才能觸發 stroke-dashoffset / r 過場）
function updatePower() {
  if (!$('pwTop')) return;
  const S = ses(state.sel);
  const running = S.status === 'running', connecting = S.status === 'connecting', closing = S.status === 'closing', failing = S.status === 'failing';
  const prog = S.prog || 0, settle = !!S.settle, shaking = !!S.shaking;
  const topOff = 283 - 141.4 * Math.min(1, prog / 0.55) - 0.1;
  const botOff = 283 - 141.4 * Math.max(0, (prog - 0.55) / 0.45) - 0.1;
  const arcOpacity = prog > 0.001 ? '1' : '0';
  const tailColor = failing ? 'var(--red)' : 'var(--accent)';
  const transTop = closing ? 'stroke-dashoffset .55s cubic-bezier(.4,0,.6,1) .3s,opacity .3s' : failing ? 'stroke-dashoffset .3s ease-out,opacity .2s' : 'stroke-dashoffset 1.9s cubic-bezier(.25,.5,.3,1),opacity .3s';
  const transBot = closing ? 'stroke-dashoffset .5s cubic-bezier(.4,0,.6,1),opacity .3s' : 'stroke-dashoffset 1.5s cubic-bezier(.3,.4,.2,1) 1.9s,opacity .3s';

  const top = $('pwTop'), bot = $('pwBot'), spin = $('pwSpin'), node = $('pwNode'), hole = $('pwHole');
  $('pwArcGroup').style.animation = settle ? 'arcSettle 1.5s 1 both' : 'none';
  top.style.transition = transTop; top.style.opacity = arcOpacity; top.style.stroke = failing ? 'var(--red)' : 'var(--accent)'; top.setAttribute('stroke-dashoffset', String(topOff));
  bot.style.transition = transBot; bot.style.opacity = arcOpacity; bot.style.stroke = failing ? 'var(--red)' : 'var(--good)'; bot.setAttribute('stroke-dashoffset', String(botOff));
  spin.style.animation = connecting ? 'spinArc 1.15s cubic-bezier(.6,.05,.4,.95) infinite' : closing ? 'spinArc .8s linear infinite reverse' : 'none';
  spin.style.opacity = failing ? '0' : connecting ? '1' : closing ? '.6' : '0';
  $('tailStop0').setAttribute('stop-color', tailColor); $('tailStop1').setAttribute('stop-color', tailColor); $('pwSpinDot').setAttribute('fill', tailColor);
  $('powerBtn').style.animation = shaking ? 'shake .5s cubic-bezier(.36,.07,.19,.97) 1' : 'none';
  node.style.fill = failing ? 'var(--red)' : running ? 'var(--good)' : (connecting || closing) ? 'var(--accent)' : 'var(--text3)';
  node.setAttribute('r', (connecting || closing) ? String(15 + 11 * prog) : '26');
  node.style.animation = running ? 'nodeBeat .55s cubic-bezier(.32,.72,0,1) 1' : 'none';
  hole.setAttribute('r', running ? '11' : (connecting || closing) ? String(9 * prog) : '9');
  $('pwRipple').style.opacity = running ? '1' : '0'; $('pwRipple').style.animation = running ? 'ripple 2.6s ease-out infinite' : 'none';
  $('pwHalo').style.background = running ? 'rgba(47,158,120,.14)' : 'transparent';

  const cur = curRoute();
  $('powerBtn').title = failing ? '重新啟動這條路由（空白鍵）' : running ? '停止路由（空白鍵）' : '啟動路由（空白鍵）';
  $('pwTitle').textContent = failing ? '啟動失敗' : running ? '執行中' : connecting ? (S.stage || '正在啟動…') : closing ? '正在停止…' : '未執行';
  $('pwSub').textContent = cur ? (cur.kind === 'http' ? 'HTTP' : 'SOCKS5') + ' 127.0.0.1:' + cur.localPort : '尚未選擇路由';
  $('pwMeta').textContent = failing ? (S.failReason || '') : cur ? (cur.hops.length ? cur.hops.length + ' 跳 · 出口 ' + srvName(cur.hops[cur.hops.length - 1]) : '尚未設定跳點') : '';
}

function updateChain() {
  const cur = curRoute();
  if (!cur) { $('chainSummary').textContent = ''; $('chainRow').innerHTML = ''; return; }
  const S = ses(state.sel);
  const running = S.status === 'running', connecting = S.status === 'connecting';
  $('chainSummary').textContent = cur.hops.length > 1 ? cur.hops.length + ' 跳串鏈 · 每跳握手都跑在前一跳的通道內，流量自最後一跳出網'
    : cur.hops.length === 1 ? '單跳 · 流量自此節點出網' : '尚未設定跳點';
  const hops = cur.hops.map(id => state.servers.find(x => x.id === id)).filter(Boolean);
  const doneHops = running ? hops.length + 1 : (S.hopDone || 0);
  const nodes = [{ name: '本地監聽', sub: '127.0.0.1:' + cur.localPort, badge: cur.kind === 'http' ? 'HTTP' : 'SOCKS5', icon: iconSvg(ICONS.local), stage: 0 }]
    .concat(hops.map((hp, i) => ({ name: hp.name, sub: hp.host + ':' + hp.port, badge: PROTO[sProto(hp)].label + (i === hops.length - 1 ? ' · 出口' : ''), icon: iconSvg(i === hops.length - 1 ? ICONS.target : ICONS.hop), stage: i + 1 })));
  $('chainRow').innerHTML = nodes.map((c, i, arr) => {
    const lit = running || c.stage <= doneHops;
    const hasNext = i < arr.length - 1;
    const linkColor = running ? 'var(--good)' : c.stage < doneHops ? 'var(--accent)' : 'var(--sep)';
    const dash = (running || connecting) ? '4 4' : '0';
    const flowAnim = (running || connecting) ? 'hopFlow .6s linear infinite' : 'none';
    return `<div style="display:flex;align-items:flex-start;flex-shrink:0">
      <div style="width:118px;display:flex;flex-direction:column;align-items:center;gap:7px">
        <div style="width:38px;height:38px;border-radius:11px;background:${lit ? 'var(--accent-dim)' : 'var(--fill2)'};border:1px solid ${lit ? 'var(--accent)' : 'var(--sep)'};display:flex;align-items:center;justify-content:center;color:${lit ? 'var(--accent)' : 'var(--text3)'}">${c.icon}</div>
        <span style="font-size:12px;font-weight:600;text-align:center;max-width:112px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</span>
        <span style="font-size:10.5px;color:var(--text2);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;text-align:center;white-space:nowrap;max-width:112px;overflow:hidden;text-overflow:ellipsis">${esc(c.sub)}</span>
        <span style="font-size:9.5px;font-weight:700;letter-spacing:.4px;padding:2px 6px;border-radius:5px;background:var(--fill2);color:var(--text2);white-space:nowrap">${esc(c.badge)}</span>
      </div>
      ${hasNext ? `<svg width="46" height="38" viewBox="0 0 46 38" style="flex-shrink:0">
        <line x1="2" y1="19" x2="40" y2="19" stroke="${linkColor}" stroke-width="2" stroke-linecap="round" stroke-dasharray="${dash}" style="animation:${flowAnim}"></line>
        <polyline points="34 13 40 19 34 25" fill="none" stroke="${linkColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></polyline>
      </svg>` : ''}
    </div>`;
  }).join('');
}

function updateTraffic() {
  if (!$('lineDown')) return;
  const S = ses(state.sel);
  const pts = S.series || [];
  const max = Math.max(3000000, ...pts.map(p => Math.max(p.down, p.up)));
  const div = Math.max(1, pts.length - 1); // 折線永遠鋪滿寬度（否則 5 分鐘檔只擠在左邊約 20%）
  const xy = key => pts.map((p, i) => `${(i / div) * 560},${88 - (p[key] / max) * 78}`).join(' ');
  const ld = xy('down'), lu = xy('up');
  $('lineDown').setAttribute('points', ld);
  $('lineUp').setAttribute('points', lu);
  $('areaDown').setAttribute('points', ld ? `0,88 ${ld} 560,88` : '');
  $('downRate').textContent = fmtBytes(S.down || 0) + '/s';
  $('upRate').textContent = fmtBytes(S.up || 0) + '/s';
  $('statConns').textContent = String(Math.max(0, S.conns || 0)); // 夾住下界，永不顯示負值
  $('statUp').textContent = fmtBytes(S.upT || 0);
  $('statDown').textContent = fmtBytes(S.downT || 0);
  const upt = S.uptime || 0;
  $('statUptime').textContent = `${String(Math.floor(upt / 60)).padStart(2, '0')}:${String(upt % 60).padStart(2, '0')}`;
}

function updateDashboard() {
  updatePower();
  updateChain();
  updateTraffic();
  const cur = curRoute();
  const runIds = runningRouteIds();
  $('sysToggle').style.background = state.sys ? 'var(--accent)' : 'var(--fill)';
  $('sysKnob').style.left = state.sys ? '23px' : '3px';
  $('sysDesc').textContent = runIds.length > 1 ? '指向選取的路由端口' : '所有系統流量改走此端口';
  $('copyIcon').style.color = state.copied ? 'transparent' : 'var(--text3)';
  $('copyChk').style.opacity = state.copied ? '1' : '0';
  $('curKind').textContent = cur ? (cur.kind === 'http' ? 'HTTP' : 'SOCKS5') : '';
  $('curAddr').textContent = cur ? '127.0.0.1:' + cur.localPort : '';
  $('curRouteId').textContent = cur ? 'id: ' + cur.id : '';
}
// =====================================================================================
// 電源狀態機（連線 / 中斷）—— 綁到真實 route IPC
// =====================================================================================
async function togglePower(id) {
  const rid = id || state.sel;
  if (!rid) { flash('請先選擇一條路由'); return; }
  const route = state.routes.find(r => r.id === rid);
  if (!route) return;
  const S = ses(rid);
  if (S.status === 'connecting' || S.status === 'closing') return;

  // 停止
  if (S.status === 'running') {
    clearSTimers(rid);
    setSes(rid, { status: 'closing', prog: 0, settle: false });
    afterStatusChange();
    window.api.routeStop(rid).catch(() => {});
    sTimeout(rid, () => { dropSes(rid); afterStatusChange(); }, 900);
    flash('已停止 ' + (route.label || '路由'));
    if (!state.routes.some(r => r.id !== rid && ses(r.id).status === 'running') && state.sys) {
      state.sys = false;
      window.api.toggleSystemProxy(false, route.localPort).catch(() => {});
    }
    return;
  }

  // 啟動：跑連線動畫時間軸；用真實 routeStart 結果決定 settle
  const hops = route.hops.map(hid => state.servers.find(x => x.id === hid)).filter(Boolean);
  clearSTimers(rid);
  setSes(rid, { status: 'connecting', prog: 0, stage: '綁定 127.0.0.1:' + route.localPort + '…', failReason: '', settle: false, shaking: false,
    series: [], up: 0, down: 0, upT: 0, downT: 0, uptime: 0, conns: 0, hopDone: 0, startTs: 0, _pu: 0, _pd: 0 });
  afterStatusChange();
  requestAnimationFrame(() => { setSes(rid, { prog: 1 }); if (state.sel === rid && state.tab === 'dashboard') updatePower(); });
  const t0 = performance.now();
  const per = 2600 / Math.max(1, hops.length);
  hops.forEach((hp, i) => sTimeout(rid, () => { setSes(rid, { stage: '第 ' + (i + 1) + ' 跳握手 · ' + hp.name + '…', hopDone: i }); if (state.sel === rid && state.tab === 'dashboard') { updatePower(); updateChain(); } }, 700 + per * i));
  sTimeout(rid, () => { if (ses(rid).status === 'connecting') { setSes(rid, { stage: '開啟本地監聽…', hopDone: hops.length }); if (state.sel === rid && state.tab === 'dashboard') { updatePower(); updateChain(); } } }, 3000);

  let result;
  try { result = await window.api.routeStart(rid); }
  catch (e) { result = { ok: false, error: e.message }; }

  const settle = () => {
    if (ses(rid).status !== 'connecting') return;
    if (result && result.ok) {
      const hint = !state.sysHintSeen && !state.sys;
      setSes(rid, { status: 'running', prog: 1, stage: '', settle: true, startTs: Date.now() });
      state.sysHintSeen = true; state.banner = hint ? '路由已啟動。開啟「系統代理」即可讓所有系統流量改走此端口。' : '';
      showBanner();
      sTimeout(rid, () => { setSes(rid, { settle: false }); if (state.sel === rid && state.tab === 'dashboard') updatePower(); }, 1560);
      afterStatusChange();
      flash('已連線 · ' + (route.label || '路由'));
    } else if (result && result.conflict) {
      clearSTimers(rid); dropSes(rid);
      state.alert = result.conflict; renderAlert(); afterStatusChange();
    } else {
      const reason = (result && result.error) || '連線失敗';
      setSes(rid, { status: 'failing', shaking: true, failReason: reason, stage: '', prog: 0.5 });
      afterStatusChange();
      sTimeout(rid, () => { setSes(rid, { shaking: false }); if (state.sel === rid && state.tab === 'dashboard') updatePower(); }, 520);
      flash((route.label || '路由') + ' 連線失敗');
    }
  };
  const target = (result && result.ok) ? 3450 : (result && result.conflict) ? 0 : 1750;
  const wait = Math.max(0, target - (performance.now() - t0));
  setTimeout(settle, wait);
  flash('正在啟動 ' + (route.label || '路由'));
}

async function toggleSys() {
  const runIds = runningRouteIds();
  if (!runIds.length) { flash('請先啟動路由', 'var(--amber)'); return; }
  const cur = curRoute();
  const next = !state.sys;
  try { const r = await window.api.toggleSystemProxy(next, cur ? cur.localPort : state.settings.httpPort); state.sys = r ? !!r.systemProxyEnabled : next; }
  catch { state.sys = next; }
  if (state.tab === 'dashboard') updateDashboard();
}

function copyAddr() {
  const cur = curRoute();
  if (!cur) return;
  navigator.clipboard.writeText('127.0.0.1:' + cur.localPort);
  state.copied = true; if (state.tab === 'dashboard') updateDashboard();
  setTimeout(() => { state.copied = false; if (state.tab === 'dashboard') updateDashboard(); }, 1200);
}

// =====================================================================================
// 伺服器分頁
// =====================================================================================
function renderServers() {
  const rows = state.servers.map(s => {
    const pend = state.pendingSrvDel === s.id;
    const lat = s.latency;
    const tText = lat == null ? '未測試' : lat < 0 ? '測試失敗' : '成功 · ' + lat + 'ms';
    const authIcon = sUser(s) ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>' : '';
    const delIcon = pend
      ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"></path></svg>'
      : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"></path></svg>';
    return `<div class="hvFill2" style="display:flex;align-items:center;padding:11px 16px;border-bottom:1px solid var(--sep);font-size:12.5px">
      <span style="width:150px;flex-shrink:0;font-weight:600;padding-right:10px;box-sizing:border-box;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.name || '未命名')}</span>
      <span style="width:158px;flex-shrink:0;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;color:var(--text2);padding-right:10px;box-sizing:border-box;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.host)}:${esc(String(s.port))}</span>
      <span style="width:78px;flex-shrink:0"><span style="font-size:9.5px;font-weight:700;letter-spacing:.4px;padding:2px 6px;border-radius:5px;background:var(--fill2);color:var(--text2);white-space:nowrap">${PROTO[sProto(s)].label}</span></span>
      <span style="width:74px;flex-shrink:0;color:var(--text2);display:flex;align-items:center;gap:5px;white-space:nowrap">${authIcon}${sUser(s) ? '已設定' : '無'}</span>
      <span style="flex:1;min-width:0;padding-right:12px;box-sizing:border-box;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;color:${testColor(lat)};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(tText)}</span>
      <span style="width:96px;flex-shrink:0;display:flex;justify-content:flex-end;gap:6px">
        <button class="hvAcc" data-stest="${s.id}" title="測試連線" style="width:26px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5z"></path></svg></button>
        <button class="hvAcc" data-sedit="${s.id}" title="編輯" style="width:26px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h4L20 8l-4-4L4 16v4z"></path></svg></button>
        <button class="hvRed" data-sdel="${s.id}" title="${pend ? '再按一次確認刪除' : '刪除'}" style="width:26px;height:26px;border:none;border-radius:7px;background:${pend ? 'var(--red)' : 'var(--fill2)'};color:${pend ? '#fff' : 'var(--red)'};cursor:pointer;display:flex;align-items:center;justify-content:center">${delIcon}</button>
      </span>
    </div>`;
  }).join('');

  $('view-servers').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;align-items:flex-end;gap:12px">
        <div style="display:flex;flex-direction:column;gap:3px">
          <span style="font-size:16px;font-weight:700;letter-spacing:-.2px;white-space:nowrap">伺服器</span>
          <span style="font-size:12px;color:var(--text2)">你的上游代理。路由會從這裡挑跳點組成鏈路。</span>
        </div>
        <button id="srvAdd" class="hvBright" style="margin-left:auto;height:32px;padding:0 15px;border:none;border-radius:9px;background:var(--accent);color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap">新增伺服器</button>
      </div>
      <div style="background:var(--card);border:1px solid var(--sep);border-radius:16px;overflow:hidden">
        <div style="display:flex;align-items:center;padding:9px 16px;border-bottom:1px solid var(--sep);font-size:11px;color:var(--text3);font-weight:600;letter-spacing:.3px">
          <span style="width:150px;flex-shrink:0;white-space:nowrap">名稱</span><span style="width:158px;flex-shrink:0;white-space:nowrap">位址</span><span style="width:78px;flex-shrink:0;white-space:nowrap">協定</span><span style="width:74px;flex-shrink:0;white-space:nowrap">認證</span><span style="flex:1;min-width:0;padding-right:12px;box-sizing:border-box;white-space:nowrap">測試結果</span><span style="width:96px;flex-shrink:0"></span>
        </div>
        ${rows}
        ${state.servers.length === 0 ? `<div style="padding:44px 20px;text-align:center;color:var(--text3);font-size:12.5px;line-height:1.7">還沒有伺服器<br>新增後即可組成路由</div>` : ''}
      </div>
    </div>`;

  $('srvAdd').onclick = () => openSrv();
  $('view-servers').querySelectorAll('[data-stest]').forEach(b => b.onclick = () => testServerRow(b.dataset.stest));
  $('view-servers').querySelectorAll('[data-sedit]').forEach(b => b.onclick = () => openSrv(b.dataset.sedit));
  $('view-servers').querySelectorAll('[data-sdel]').forEach(b => b.onclick = () => deleteServerRow(b.dataset.sdel));
}

async function testServerRow(id) {
  const s = state.servers.find(x => x.id === id); if (!s) return;
  flash((s.name || s.host) + ' 測試中…');
  const r = await window.api.testServer(id, state.settings.testTarget || undefined);
  state.servers = await window.api.getServers();
  if (state.tab === 'servers') renderServers();
  if (state.tab === 'dashboard') updateChain();
  if (r && r.success) flash((s.name || s.host) + ' 測試成功 · ' + r.latency + 'ms');
  else flash('測試失敗', 'var(--red)');
}

function deleteServerRow(id) {
  if (state.pendingSrvDel !== id) {
    state.pendingSrvDel = id; renderServers();
    setTimeout(() => { if (state.pendingSrvDel === id) { state.pendingSrvDel = null; if (state.tab === 'servers') renderServers(); } }, 2500);
    return;
  }
  state.pendingSrvDel = null;
  window.api.deleteServer(id).then(async () => {
    state.servers = await window.api.getServers();
    // 從各路由 hops 移除此伺服器並 persist
    for (const r of state.routes) {
      if (r.hops.includes(id)) { r.hops = r.hops.filter(h => h !== id); await window.api.saveRoute(r); }
    }
    state.routes = await window.api.getRoutes();
    renderSidebar(); showTab(state.tab); flash('已刪除伺服器');
  }).catch(e => flash('刪除伺服器失敗：' + (e && e.message || e), 'var(--red)'));
}

// =====================================================================================
// 紀錄
// =====================================================================================
function buildLogs() {
  $('view-logs').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px;height:100%">
      <div style="display:flex;align-items:center;gap:10px">
        <div id="levelSeg" style="display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:8px;flex-shrink:0"></div>
        <div style="margin-left:auto;display:flex;align-items:center;gap:7px;min-width:0">
          <input id="logSearch" placeholder="搜尋…" style="width:132px;min-width:80px;height:30px;padding:0 11px;border:1px solid var(--sep);border-radius:9px;background:var(--card);color:var(--text);font-size:12.5px;outline:none">
          <button id="logOpen" class="hvFill2" title="開啟紀錄檔資料夾" style="height:30px;padding:0 13px;border:1px solid var(--sep);border-radius:9px;background:var(--card);color:var(--text);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap">紀錄檔</button>
          <button id="logCopy" class="hvFill2" style="height:30px;padding:0 13px;border:1px solid var(--sep);border-radius:9px;background:var(--card);color:var(--text);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap">複製</button>
          <button id="logClear" class="hvFill2" style="height:30px;padding:0 13px;border:1px solid var(--sep);border-radius:9px;background:var(--card);color:var(--red);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap">清除</button>
        </div>
      </div>
      <div id="logList" style="flex:1;background:var(--card);border:1px solid var(--sep);border-radius:16px;overflow-y:auto;user-select:text"></div>
    </div>`;
  $('logSearch').addEventListener('input', e => { state.search = e.target.value; renderLogList(); });
  $('logOpen').onclick = async () => { const r = await window.api.openLogsFolder(); if (!(r && r.ok)) flash('開啟紀錄檔失敗：' + ((r && r.error) || '未知'), 'var(--red)'); };
  $('logCopy').onclick = () => copyLogs();
  $('logClear').onclick = async () => { await window.api.clearLogs(); state.logs = []; renderLogList(); flash('已清除紀錄'); };
  renderLevelSeg();
}

function renderLevelSeg() {
  const levels = [['all', '全部', 'var(--text3)'], ['info', '訊息', LEVELS.info], ['warn', '警告', LEVELS.warn], ['error', '錯誤', LEVELS.error], ['debug', '除錯', LEVELS.debug]];
  $('levelSeg').innerHTML = levels.map(([k, label, dot]) =>
    `<button data-lv="${k}" style="display:flex;align-items:center;gap:5px;border:none;cursor:pointer;height:28px;padding:0 9px;border-radius:6px;font-size:12px;white-space:nowrap;flex-shrink:0;${segCss(state.level === k)}"><span style="width:6px;height:6px;border-radius:50%;background:${dot}"></span>${label}</button>`
  ).join('');
  $('levelSeg').querySelectorAll('button').forEach(b => b.onclick = () => { state.level = b.dataset.lv; renderLevelSeg(); renderLogList(); });
}

function logGroupTitle(source) {
  if (source && source.indexOf('route:') === 0) {
    const rid = source.slice(6);
    const r = state.routes.find(x => x.id === rid);
    return { title: r ? (r.label || '未命名路由') : '路由 ' + rid, meta: r ? '127.0.0.1:' + r.localPort + ' · ' + r.hops.length + ' 跳' : '' };
  }
  return { title: SRC_TITLE[source] || source, meta: '' };
}

// 命中徽章：命中規則＝藍底「命中：第 N 條 名稱」、未命中＝灰底「預設」、封鎖＝紅底
function logHitBadge(l) {
  const m = l.meta; if (!m) return '';
  const block = m.target === 'block';
  const bg = block ? 'rgba(217,83,74,.14)' : m.matched ? 'var(--accent-dim)' : 'var(--fill2)';
  const color = block ? 'var(--red)' : m.matched ? 'var(--accent)' : 'var(--text3)';
  const label = !m.matched ? '預設' : m.ruleIndex ? `命中：第 ${m.ruleIndex} 條 ${m.ruleName}` : m.ruleName;
  return `<button data-loghit="${esc(m.ruleId || '')}" title="跳到分流規則" style="flex-shrink:0;max-width:220px;border:none;border-radius:5px;padding:2px 7px;background:${bg};color:${color};font-size:10.5px;font-weight:600;cursor:${m.ruleId ? 'pointer' : 'default'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px">${esc(label)}</button>`;
}

function renderLogList() {
  const S = state;
  const shown = S.logs.filter(l => (S.level === 'all' || l.level === S.level) && (!S.search || `${l.message} ${l.detail || ''} ${l.source}`.toLowerCase().includes(S.search.toLowerCase())));
  const list = $('logList');
  if (shown.length === 0) { list.innerHTML = `<div style="padding:60px 20px;text-align:center;color:var(--text3);font-size:12.5px">沒有符合的紀錄</div>`; return; }
  const keys = [...new Set(shown.map(l => l.source))];
  list.innerHTML = keys.map(k => {
    const rows = shown.filter(l => l.source === k);
    const g = logGroupTitle(k);
    return `<div>
      <div style="position:sticky;top:0;padding:7px 14px;background:var(--panelq);backdrop-filter:blur(12px);border-bottom:1px solid var(--sep);display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--text2)">
        <span style="font-weight:600;color:var(--text)">${esc(g.title)}</span>
        <span style="font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace">${esc(g.meta)}</span>
        <span style="margin-left:auto;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;color:var(--text3)">${rows.length} 筆</span>
      </div>
      ${rows.map(l => {
        const time = new Date(l.time || l.t).toLocaleTimeString('en-GB', { hour12: false });
        const exp = S.expanded[l.id];
        return `<div data-log="${l.id}" style="padding:5px 14px;display:flex;gap:10px;align-items:flex-start;cursor:${l.detail ? 'pointer' : 'default'};border-bottom:1px solid var(--sep);font-size:12px;line-height:1.6" class="${l.detail ? 'hvFill2' : ''}">
          <span style="width:58px;flex-shrink:0;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;color:var(--text3);font-size:11px;padding-top:1px">${time}</span>
          <span title="${l.level}" style="width:7px;height:7px;border-radius:50%;flex-shrink:0;margin-top:6px;background:${LEVELS[l.level] || LEVELS.info}"></span>
          <span style="width:88px;flex-shrink:0;color:var(--purple);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:11px;padding-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.source)}</span>
          <span style="flex:1;min-width:0;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:11.5px;word-break:break-word">${esc(l.message)}<span style="color:var(--text2)">${l.detail && exp ? '  ' + esc(l.detail) : ''}</span></span>
          ${logHitBadge(l)}
          <span style="flex-shrink:0;color:var(--text3);font-size:10px;padding-top:2px">${l.detail ? (exp ? '▾' : '▸') : ''}</span>
        </div>`;
      }).join('')}
    </div>`;
  }).join('');
  list.querySelectorAll('[data-loghit]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const id = b.dataset.loghit;
    showTab('split');
    if (!id) return;
    state.splitHitId = id; renderSplitRules();
    clearTimeout(state._splitHitT);
    state._splitHitT = setTimeout(() => { state.splitHitId = null; renderSplitRules(); }, 2000);
  });
  list.querySelectorAll('[data-log]').forEach(row => {
    const id = row.dataset.log;
    const l = S.logs.find(x => String(x.id) === id);
    if (l && l.detail) row.onclick = () => { S.expanded[id] = !S.expanded[id]; renderLogList(); };
  });
}

function copyLogs() {
  const S = state;
  const shown = S.logs.filter(l => (S.level === 'all' || l.level === S.level) && (!S.search || `${l.message} ${l.detail || ''} ${l.source}`.toLowerCase().includes(S.search.toLowerCase())));
  const text = shown.map(l => `[${new Date(l.time || l.t).toLocaleTimeString('en-GB', { hour12: false })}] [${(l.level || '').toUpperCase()}] [${l.source}] ${l.message}${l.detail ? ' ' + l.detail : ''}`).join('\n');
  navigator.clipboard.writeText(text);
  flash('已複製紀錄');
}
// =====================================================================================
// 憑證庫（localStorage 'proxy_creds'）
// =====================================================================================
function saveCreds() { localStorage.setItem('proxy_creds', JSON.stringify(state.creds.map(({ id, name, user, pass, note }) => ({ id, name, user, pass, note, shown: false })))); }

function renderCreds() {
  const S = state;
  const rows = S.creds.map(c => {
    if (S.credEdit === c.id) {
      return `<div style="border-bottom:1px solid var(--sep);background:var(--accent-dim)">
        <div style="padding:13px 16px;display:flex;align-items:center;flex-wrap:wrap;row-gap:9px;box-sizing:border-box;animation:fadeUp .18s ease-out">
          <span style="width:150px;padding-right:10px;box-sizing:border-box"><input id="cdName" value="${esc(S.cdraft.name)}" placeholder="名稱" style="width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid var(--accent);border-radius:8px;background:var(--bg);color:var(--text);font-size:12.5px;font-weight:600;outline:none"></span>
          <span style="width:130px;padding-right:10px;box-sizing:border-box"><input id="cdUser" value="${esc(S.cdraft.user)}" placeholder="帳號" style="width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid var(--sep);border-radius:8px;background:var(--bg);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12.5px;outline:none"></span>
          <span style="width:120px;padding-right:10px;box-sizing:border-box"><input id="cdPass" value="${esc(S.cdraft.pass)}" placeholder="密碼" style="width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid var(--sep);border-radius:8px;background:var(--bg);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12.5px;outline:none"></span>
          <div style="order:2;margin-left:auto;display:flex;justify-content:flex-end;gap:6px">
            <button id="cdCancel" class="hvFill" title="取消" style="width:26px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"></line><line x1="19" y1="5" x2="5" y2="19"></line></svg></button>
            <button id="cdSave" class="hvBright" title="完成" style="width:26px;height:26px;border:none;border-radius:7px;background:var(--accent);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12.5 9.5 18 20 6.5"></polyline></svg></button>
          </div>
          <span style="order:3;width:100%;box-sizing:border-box"><input id="cdNote" value="${esc(S.cdraft.note)}" placeholder="備註" style="width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid var(--sep);border-radius:8px;background:var(--bg);color:var(--text);font-size:12.5px;outline:none"></span>
        </div>
      </div>`;
    }
    return `<div style="border-bottom:1px solid var(--sep)">
      <div class="hvFill2" style="display:flex;align-items:center;padding:11px 16px;font-size:12.5px">
        <span style="width:150px;flex-shrink:0;font-weight:600;display:flex;align-items:center;gap:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="color:var(--text3)"><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>${esc(c.name || '未命名')}</span>
        <span style="width:130px;flex-shrink:0;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.user)}</span>
        <button data-ctoggle="${c.id}" title="點擊顯示 / 隱藏" style="width:120px;text-align:left;border:none;background:transparent;color:var(--text2);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12.5px;cursor:pointer;padding:0">${c.shown ? esc(c.pass) : '••••••••'}</button>
        <span style="flex:1;min-width:0;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.note || '—')}</span>
        <span style="width:60px;flex-shrink:0;display:flex;justify-content:flex-end;gap:6px">
          <button data-cedit="${c.id}" class="hvAcc" title="編輯" style="width:26px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h4L20 8l-4-4L4 16v4z"></path></svg></button>
          <button data-cdel="${c.id}" class="hvRed" title="刪除" style="width:26px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--red);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"></path></svg></button>
        </span>
      </div>
    </div>`;
  }).join('');

  $('view-creds').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;align-items:flex-end;gap:12px">
        <div style="display:flex;flex-direction:column;gap:3px"><span style="font-size:16px;font-weight:700;letter-spacing:-.2px;white-space:nowrap">憑證庫</span><span style="font-size:12px;color:var(--text2)">存好帳密，新增伺服器時可直接選用</span></div>
        <button id="credAdd" class="hvBright" style="margin-left:auto;height:32px;padding:0 15px;border:none;border-radius:9px;background:var(--accent);color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap">新增憑證</button>
      </div>
      <div style="background:var(--card);border:1px solid var(--sep);border-radius:16px;overflow:hidden">
        <div style="display:flex;padding:9px 16px;border-bottom:1px solid var(--sep);font-size:11px;color:var(--text3);font-weight:600;letter-spacing:.3px">
          <span style="width:150px;flex-shrink:0;white-space:nowrap">名稱</span><span style="width:130px;flex-shrink:0;white-space:nowrap">帳號</span><span style="width:120px;flex-shrink:0;white-space:nowrap">密碼</span><span style="flex:1;min-width:0;white-space:nowrap">備註</span><span style="width:60px;flex-shrink:0"></span>
        </div>
        ${rows}
        ${S.creds.length === 0 ? `<div style="padding:44px 20px;text-align:center;color:var(--text3);font-size:12.5px;line-height:1.7">還沒有儲存的憑證<br>新增後即可在伺服器表單選用</div>` : ''}
      </div>
      <div style="display:flex;gap:9px;padding:12px 15px;background:var(--accent-dim);border-radius:12px;font-size:11.5px;color:var(--text2);line-height:1.65">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent);flex-shrink:0;margin-top:1px"><circle cx="12" cy="12" r="9"></circle><path d="M12 8h.01M11 12h1v5h1"></path></svg>
        <span style="text-wrap:pretty">SOCKS5、HTTP 與 HTTPS 都支援帳號密碼認證。SOCKS4 沒有密碼機制，只能附帶一個識別字串給伺服器辨識。</span>
      </div>
    </div>`;

  $('credAdd').onclick = () => { const id = 'c' + Date.now(); S.creds.push({ id, name: '', user: '', pass: '', note: '', shown: false }); S.credEdit = id; S.cdraft = { name: '', user: '', pass: '', note: '' }; renderCreds(); };
  $('view-creds').querySelectorAll('[data-ctoggle]').forEach(b => b.onclick = () => { const c = S.creds.find(x => x.id === b.dataset.ctoggle); c.shown = !c.shown; renderCreds(); });
  $('view-creds').querySelectorAll('[data-cedit]').forEach(b => b.onclick = () => { const c = S.creds.find(x => x.id === b.dataset.cedit); S.credEdit = c.id; S.cdraft = { name: c.name, user: c.user, pass: c.pass, note: c.note }; renderCreds(); });
  $('view-creds').querySelectorAll('[data-cdel]').forEach(b => b.onclick = () => { S.creds = S.creds.filter(x => x.id !== b.dataset.cdel); S.credEdit = null; saveCreds(); renderCreds(); });
  if ($('cdCancel')) $('cdCancel').onclick = () => { const c = S.creds.find(x => x.id === S.credEdit); if (c && !c.name && !c.user && !c.pass && !c.note) S.creds = S.creds.filter(x => x.id !== S.credEdit); S.credEdit = null; renderCreds(); };
  if ($('cdSave')) $('cdSave').onclick = () => {
    S.cdraft = { name: $('cdName').value.trim() || '未命名', user: $('cdUser').value.trim(), pass: $('cdPass').value, note: $('cdNote').value.trim() };
    S.creds = S.creds.map(x => x.id === S.credEdit ? { ...x, ...S.cdraft } : x); S.credEdit = null; saveCreds(); renderCreds(); flash('憑證已更新');
  };
}

// =====================================================================================
// 設定（無「本地端口」段；端口改為每路由設定）
// =====================================================================================
// ---- 自動更新按鈕（關於卡片；electron-updater → GitHub Releases）----
function updateBtnLabel() {
  const u = state.update;
  switch (u.status) {
    case 'checking': return '檢查中…';
    case 'available': return `下載更新 v${u.version}`;
    case 'downloading': return `下載中 ${u.percent}%`;
    case 'downloaded': return '重新啟動安裝';
    case 'none': return '已是最新版本';
    default: return '檢查更新';
  }
}
function refreshUpdateBtn() { const b = $('setUpdate'); if (b) b.textContent = updateBtnLabel(); }
async function onUpdateClick() {
  const u = state.update;
  try {
    if (u.status === 'available') { await window.api.downloadUpdate(); return; }
    if (u.status === 'downloaded') { await window.api.quitAndInstall(); return; }
    const r = await window.api.checkForUpdates();
    if (r && r.ok === false && r.error) flash('檢查更新：' + r.error, 'var(--amber)');
  } catch (e) { flash('更新操作失敗：' + e.message, 'var(--red)'); }
}

// 設定頁。分組照 MERGE.md：外觀 / 行為 / 連線 / 斷線保護 / 規則庫 / 資料 / 關於。
// 文案原則：desc 一句 ≤22 字、不放括號補充、技術名詞不進 desc。
const SW_GROUPS = {
  behavior: [
    { key: 'tray', label: '關閉時最小化到系統匣', desc: '保留背景執行與系統匣圖示' },
    { key: 'bootLaunch', label: '開機時自動啟動', desc: '登入後自動啟動 RelayClient' },
    { key: 'autostart', label: '啟動時自動套用路由', desc: '自動啟動已啟用的路由' },
    { key: 'scroll', label: '紀錄自動捲動', desc: '新紀錄進來時跟到底部' },
    { key: 'nodebug', label: '隱藏除錯訊息', desc: '只顯示一般訊息與錯誤' },
  ],
};

const swRow = (w, last) => `
  <div style="padding:13px 16px;display:flex;align-items:center;gap:14px;${last ? '' : 'border-bottom:1px solid var(--sep)'}">
    <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500;white-space:nowrap">${w.label}</div><div style="font-size:11.5px;color:var(--text2);margin-top:2px">${w.desc}</div></div>
    <button data-sw="${w.key}" role="switch" aria-checked="false" aria-label="${w.label}" style="width:44px;height:26px;border-radius:13px;border:none;padding:0;cursor:pointer;position:relative;background:var(--fill);transition:background .22s;flex-shrink:0">
      <span style="position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .22s cubic-bezier(.32,.72,0,1)"></span>
    </button>
  </div>`;

const group = (title, inner, desc) => `
  <div style="display:flex;flex-direction:column;gap:8px">
    <span style="font-size:11.5px;font-weight:600;color:var(--text3);letter-spacing:.4px;padding-left:4px;white-space:nowrap">${title}</span>
    ${desc ? `<span style="font-size:11px;color:var(--text3);padding-left:4px;margin-top:-4px;line-height:1.5">${desc}</span>` : ''}
    <div style="background:var(--card);border:1px solid var(--sep);border-radius:16px;overflow:hidden">${inner}</div>
  </div>`;

function buildSettings() {
  $('view-settings').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:18px">

      ${group('外觀', `
        <div style="padding:13px 16px;display:flex;align-items:center;gap:14px">
          <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500;white-space:nowrap">主題</div><div style="font-size:11.5px;color:var(--text2);margin-top:2px">預設跟隨系統設定</div></div>
          <div id="themeSeg" style="display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:8px"></div>
        </div>`)}

      ${group('行為', SW_GROUPS.behavior.map((w, i) => swRow(w, i === SW_GROUPS.behavior.length - 1)).join(''))}

      ${group('連線', `
        ${swRow({ key: 'udp', label: 'UDP 轉發', desc: '能否真的走代理要看上游支援' }, false)}
        <div style="padding:13px 16px;display:flex;align-items:center;gap:14px">
          <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500;white-space:nowrap">連線測試目標</div><div style="font-size:11.5px;color:var(--text2);margin-top:2px">留空則只測協定握手</div></div>
          <div style="display:flex;align-items:center;gap:5px">
            <input id="setTestHost" placeholder="example.com" style="width:158px;height:30px;padding:0 10px;border:1px solid var(--sep);border-radius:8px;background:var(--bg);color:var(--text);font-size:12.5px;outline:none">
            <span style="color:var(--text3)">:</span>
            <input id="setTestPort" placeholder="443" style="width:56px;height:30px;padding:0 8px;border:1px solid var(--sep);border-radius:8px;background:var(--bg);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12.5px;outline:none;text-align:center">
          </div>
        </div>`)}

      ${group('斷線保護', `
        ${swRow({ key: 'killswitch', label: '斷線保護', desc: '引擎意外停止時先暫停受保護程式的連線' }, false)}
        <div id="ksScopeRow"></div>
        <div id="ksAutoRow">${swRow({ key: 'ksauto', label: '自動重連', desc: '觸發後自動重試 3 次，每次間隔 4 秒' }, true)}</div>`)}

      ${group('規則庫', '<div id="setRuleSets"></div>', '存在 %APPDATA%\\RelayClient\\rulesets\\，只有按下載時才連網')}

      ${group('資料', `
        <div style="padding:13px 16px;display:flex;align-items:center;gap:14px">
          <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500;white-space:nowrap">匯入 / 匯出設定</div><div style="font-size:11.5px;color:var(--text2);margin-top:2px">備份伺服器與路由，密碼可選擇是否包含</div></div>
          <div style="display:flex;gap:8px">
            <button id="setExport" class="hvFill2" style="height:30px;padding:0 13px;border:1px solid var(--sep);border-radius:8px;background:var(--bg);color:var(--text);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap">匯出</button>
            <button id="setImport" class="hvFill2" style="height:30px;padding:0 13px;border:1px solid var(--sep);border-radius:8px;background:var(--bg);color:var(--text);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap">匯入</button>
          </div>
        </div>`)}

      ${group('關於', `
        <div style="padding:13px 16px;display:flex;align-items:center;gap:14px">
          <svg width="42" height="42" viewBox="0 0 256 256" style="border-radius:11px;flex-shrink:0">
            <rect x="0" y="0" width="256" height="256" rx="56" fill="var(--accent)"></rect>
            <circle cx="128" cy="128" r="76" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="15"></circle>
            <path d="M128 52 A76 76 0 0 1 204 128" fill="none" stroke="#fff" stroke-width="15" stroke-linecap="round"></path>
            <path d="M52 128 A76 76 0 0 0 128 204" fill="none" stroke="#7fe3bd" stroke-width="15" stroke-linecap="round"></path>
            <circle cx="128" cy="128" r="18" fill="#fff"></circle>
          </svg>
          <div style="flex:1;min-width:0"><div style="font-size:13.5px;font-weight:600;white-space:nowrap">RelayClient</div><div id="setVersion" style="font-size:11.5px;color:var(--text2);margin-top:2px;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace">—</div></div>
          <div style="display:flex;gap:8px">
            <button id="setLogs" class="hvFill2" style="height:30px;padding:0 13px;border:1px solid var(--sep);border-radius:8px;background:var(--bg);color:var(--text);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap">開啟紀錄檔資料夾</button>
            <button id="setUpdate" class="hvFill2" style="height:30px;padding:0 13px;border:1px solid var(--sep);border-radius:8px;background:var(--bg);color:var(--text);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap">檢查更新</button>
          </div>
        </div>`)}
    </div>`;

  $('view-settings').querySelectorAll('[data-sw]').forEach(b => b.onclick = () => toggleSwitch(b.dataset.sw));
  $('setTestHost').addEventListener('input', updateTestTarget);
  $('setTestPort').addEventListener('input', updateTestTarget);
  $('setExport').onclick = exportData;
  $('setImport').onclick = importData;
  $('setLogs').onclick = async () => { try { await window.api.openLogsFolder(); } catch (e) { flash('開啟紀錄檔失敗：' + e.message, 'var(--red)'); } };
  $('setUpdate').onclick = onUpdateClick;
  window.api.getAppInfo().then(i => { if ($('setVersion')) $('setVersion').textContent = `v${i.version}`; }).catch(() => {});
}

function updateTestTarget() {
  const host = $('setTestHost').value.trim();
  const port = parseInt($('setTestPort').value) || 443;
  state.settings.testTarget = host ? { host, port } : null;
  saveSettings();
}

function renderThemeSeg() {
  if (!$('themeSeg')) return;
  $('themeSeg').innerHTML = ['系統', '淺色', '深色'].map(m =>
    `<button data-th="${m}" style="border:none;cursor:pointer;height:27px;padding:0 12px;border-radius:6px;font-size:12px;white-space:nowrap;flex-shrink:0;${segCss(state.themeMode === m)}">${m}</button>`
  ).join('');
  $('themeSeg').querySelectorAll('button').forEach(b => b.onclick = () => setTheme(b.dataset.th));
}

function toggleSwitch(key) {
  if (key === 'bootLaunch') {
    // OS 登入項目：非同步呼叫主行程，成功才更新視覺狀態
    const next = !state.bootLaunch;
    window.api.setLoginItem(next).then(r => {
      if (r && r.ok) { state.bootLaunch = next; flash(next ? '已設定開機自動啟動' : '已取消開機自動啟動'); }
      else flash('設定開機啟動失敗：' + ((r && r.error) || '未知錯誤'), 'var(--red)');
      refreshSettings();
    }).catch(e => { flash('設定開機啟動失敗：' + e.message, 'var(--red)'); });
    return;
  }
  if (key === 'udp') { state.splitUdp = !state.splitUdp; persistSplit({ udp: state.splitUdp }); refreshSettings(); flash(state.splitUdp ? 'UDP 轉發已啟用' : 'UDP 轉發已停用'); return; }
  if (key === 'ksauto') { state.settings.killSwitchAutoReconnect = !(state.settings.killSwitchAutoReconnect !== false); }
  else if (key === 'rsauto') { state.settings.rulesetAutoUpdate = !state.settings.rulesetAutoUpdate; }
  else if (key === 'tray') state.settings.minimizeToTray = !(state.settings.minimizeToTray !== false);
  else if (key === 'autostart') state.settings.autoStartRoutes = !(state.settings.autoStartRoutes !== false);
  else if (key === 'killswitch') state.settings.killSwitch = !state.settings.killSwitch;
  else localStorage.setItem('sw_' + key, localStorage.getItem('sw_' + key) === '1' ? '0' : '1');
  saveSettings(); refreshSettings();
}
function swOn(key) {
  if (key === 'tray') return state.settings.minimizeToTray !== false;
  if (key === 'bootLaunch') return !!state.bootLaunch;
  if (key === 'autostart') return state.settings.autoStartRoutes !== false;
  if (key === 'killswitch') return !!state.settings.killSwitch;
  if (key === 'ksauto') return state.settings.killSwitchAutoReconnect !== false;
  if (key === 'udp') return !!state.splitUdp;
  if (key === 'rsauto') return !!state.settings.rulesetAutoUpdate;
  if (key === 'scroll') return localStorage.getItem('sw_scroll') !== '0';
  return localStorage.getItem('sw_nodebug') === '1';
}
function refreshSettings() {
  if (!$('setTestHost')) return;
  $('setTestHost').value = state.settings.testTarget?.host || '';
  $('setTestPort').value = state.settings.testTarget?.port || '';
  $('view-settings').querySelectorAll('[data-sw]').forEach(b => {
    const on = swOn(b.dataset.sw);
    b.style.background = on ? 'var(--accent)' : 'var(--fill)';
    b.firstElementChild.style.left = on ? '21px' : '3px';
    b.setAttribute('aria-checked', on ? 'true' : 'false'); // 無障礙：反映開關狀態
  });
  renderThemeSeg();
  const ksRow = $('ksAutoRow'); if (ksRow) ksRow.style.display = state.settings.killSwitch ? 'block' : 'none';
  renderKsScope();
  renderRuleSets();
}

function saveSettings() {
  window.api.updateSettings({
    minimizeToTray: state.settings.minimizeToTray, autoStartRoutes: state.settings.autoStartRoutes,
    killSwitch: state.settings.killSwitch, testTarget: state.settings.testTarget,
    rulesetAutoUpdate: state.settings.rulesetAutoUpdate, rulesetUpdateDays: state.settings.rulesetUpdateDays,
    rulesetDetourRouteId: state.settings.rulesetDetourRouteId,
    killSwitchAutoReconnect: state.settings.killSwitchAutoReconnect,
    killSwitchScope: state.settings.killSwitchScope, killSwitchApps: state.settings.killSwitchApps,
  });
}

// =====================================================================================
// 路由編輯面板（右側滑入 470px）
// =====================================================================================
function openRoute(id) {
  const S = state;
  const r = id ? S.routes.find(x => x.id === id) : null;
  const used = S.routes.map(x => +x.localPort);
  let n = 10808; while (used.includes(n)) n++;
  S.routeSheet = true; S.routeEditing = id || null; closeMenu();
  S.draft = r ? { label: r.label, localPort: String(r.localPort), kind: r.kind, hops: [...r.hops], enabled: r.enabled !== false }
              : { label: '', localPort: String(n), kind: 'socks5', hops: [], enabled: true };
  renderRouteSheet();
}
function closeRouteSheet() { state.routeSheet = false; closeMenu(); $('sheetMount').innerHTML = ''; }
function syncDraft() { const d = state.draft; if ($('rdLabel')) d.label = $('rdLabel').value; if ($('rdPort')) d.localPort = $('rdPort').value.replace(/[^0-9]/g, '').slice(0, 5); }

function draftJson() {
  const d = state.draft;
  return '{ "id": "' + (state.routeEditing || 'r-new') + '", "label": "' + esc(d.label || '未命名') + '", "localPort": ' + (d.localPort || 0) + ', "kind": "' + d.kind + '", "hops": [' + d.hops.map(x => '"' + x + '"').join(', ') + '], "enabled": ' + d.enabled + ' }';
}
function fillPortWarn() {
  const d = state.draft, c = $('rdPortWarn'); if (!c) return;
  const dup = state.routes.some(r => r.id !== state.routeEditing && String(r.localPort) === String(d.localPort));
  c.innerHTML = dup ? `<span style="font-size:11.5px;color:var(--red);display:flex;align-items:center;gap:6px;margin-top:-8px"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v6M12 17h.01"></path></svg>端口 ${esc(d.localPort)} 已被其他路由使用，啟動時會被阻擋。</span>` : '';
}

function renderRouteSheet() {
  const S = state, d = S.draft;
  const dupPort = S.routes.some(r => r.id !== S.routeEditing && String(r.localPort) === String(d.localPort));
  const scrollTop = $('rdBody') ? $('rdBody').scrollTop : 0;
  const hopsHtml = d.hops.map((id, i) => {
    const s = S.servers.find(x => x.id === id) || {};
    return `<div style="display:flex;align-items:center;gap:9px;padding:9px 11px;background:var(--bg);border:1px solid var(--sep);border-radius:11px">
      <span style="width:20px;height:20px;flex-shrink:0;border-radius:50%;background:var(--accent-dim);color:var(--accent);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center">${i + 1}</span>
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
        <span style="font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.name || '（已刪除）')}</span>
        <span style="font-size:11px;color:var(--text2);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc((s.host || '?') + ':' + (s.port || '?'))}</span>
      </div>
      <span style="font-size:9.5px;font-weight:700;letter-spacing:.4px;padding:2px 6px;border-radius:5px;background:var(--fill2);color:var(--text2);flex-shrink:0">${s.type ? PROTO[sProto(s)].label : '—'}</span>
      <button data-hup="${i}" title="上移" style="width:24px;height:24px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:${i === 0 ? '.3' : '1'}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 14 12 8 18 14"></polyline></svg></button>
      <button data-hdown="${i}" title="下移" style="width:24px;height:24px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:${i === d.hops.length - 1 ? '.3' : '1'}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 10 12 16 18 10"></polyline></svg></button>
      <button data-hrem="${i}" title="移除跳點" style="width:24px;height:24px;border:none;border-radius:7px;background:var(--fill2);color:var(--red);cursor:pointer;display:flex;align-items:center;justify-content:center" class="hvRed"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>
    </div>`;
  }).join('');

  $('sheetMount').innerHTML = `
    <div id="rdOverlay" style="position:absolute;inset:0;background:rgba(0,0,0,.28);display:flex;justify-content:flex-end;z-index:50">
      <div id="rdPanel" style="width:470px;height:100%;background:var(--panel);border-left:1px solid var(--sep);box-shadow:-12px 0 40px rgba(0,0,0,.18);display:flex;flex-direction:column;animation:sheetIn .26s cubic-bezier(.32,.72,0,1)">
        <div style="padding:16px 20px;border-bottom:1px solid var(--sep);display:flex;align-items:center">
          <span style="font-size:15px;font-weight:700;letter-spacing:-.2px">${S.routeEditing ? '編輯路由' : '新增路由'}</span>
          <button id="rdClose" class="hvFill" title="關閉面板" style="margin-left:auto;width:26px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="11" height="11" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.6"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5"></line><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"></line></svg></button>
        </div>
        <div id="rdBody" style="flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:16px">
          <div style="display:flex;flex-direction:column;gap:7px">
            <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">名稱</span>
            <input id="rdLabel" value="${esc(d.label)}" placeholder="例如：主要節點 SOCKS5" style="padding:9px 11px;border:1px solid var(--sep);border-radius:10px;background:var(--bg);color:var(--text);font-size:13px;outline:none">
          </div>

          <div style="display:flex;gap:10px">
            <div style="flex:1;display:flex;flex-direction:column;gap:7px">
              <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">本地端口類型</span>
              <div style="display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:9px">
                ${[['socks5', 'SOCKS5'], ['http', 'HTTP']].map(([k, label]) =>
                  `<button data-kind="${k}" style="flex:1;border:none;cursor:pointer;height:30px;border-radius:7px;font-size:12.5px;white-space:nowrap;${segCss(d.kind === k)}">${label}</button>`).join('')}
              </div>
            </div>
            <div style="width:118px;flex-shrink:0;display:flex;flex-direction:column;gap:7px">
              <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">本地端口</span>
              <input id="rdPort" value="${esc(d.localPort)}" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid ${dupPort ? 'var(--red)' : 'var(--sep)'};border-radius:10px;background:var(--bg);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:13px;text-align:center;outline:none">
            </div>
          </div>
          <div id="rdPortWarn"></div>

          <div style="display:flex;flex-direction:column;gap:9px">
            <div style="display:flex;align-items:center;gap:9px">
              <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">跳點鏈路</span>
              <span style="font-size:11px;color:var(--text3)">${d.hops.length > 1 ? '依序串鏈，最後一跳為出口' : '可加入多個跳點組成串鏈'}</span>
            </div>
            <div style="display:flex;flex-direction:column;gap:7px">
              ${hopsHtml}
              ${d.hops.length === 0 ? `<div style="padding:18px;text-align:center;color:var(--text3);font-size:12px;border:1px dashed var(--sep);border-radius:11px">尚未加入跳點 · 至少需要一個</div>` : ''}
              <button id="rdHopMenu" class="hvAccDim" style="display:flex;align-items:center;justify-content:center;gap:6px;height:34px;border:1px dashed var(--sep);border-radius:11px;background:transparent;color:var(--accent);font-size:12.5px;font-weight:600;cursor:pointer">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>加入跳點
              </button>
            </div>
          </div>

          <div style="background:var(--bg);border:1px solid var(--sep);border-radius:12px;padding:11px 13px;display:flex;align-items:center;gap:12px">
            <div style="flex:1"><div style="font-size:12.5px;font-weight:600">啟用此路由</div><div style="font-size:11px;color:var(--text2);margin-top:2px">停用時不佔用端口，也不會隨程式啟動</div></div>
            <button id="rdEnabled" style="width:44px;height:26px;border-radius:13px;border:none;padding:0;cursor:pointer;position:relative;background:${d.enabled ? 'var(--accent)' : 'var(--fill)'};transition:background .22s;flex-shrink:0">
              <span style="position:absolute;top:3px;left:${d.enabled ? '21px' : '3px'};width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .22s cubic-bezier(.32,.72,0,1)"></span>
            </button>
          </div>

          <div style="background:var(--fill2);border-radius:12px;padding:13px 15px;display:flex;flex-direction:column;gap:7px">
            <span style="font-size:11px;font-weight:600;color:var(--text3);letter-spacing:.3px">對應 config.json</span>
            <span style="font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:11px;color:var(--text2);line-height:1.7;word-break:break-all;user-select:text">${draftJson()}</span>
          </div>
        </div>
        <div style="padding:14px 20px;border-top:1px solid var(--sep);display:flex;align-items:center;gap:10px">
          <span style="font-size:11.5px;color:var(--text3);flex:1">儲存後立即套用（不需重啟）</span>
          <button id="rdCancel" class="hvFill2" style="height:32px;padding:0 16px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap">取消</button>
          <button id="rdSave" class="hvBright" style="height:32px;padding:0 18px;border:none;border-radius:9px;background:var(--accent);color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap">儲存路由</button>
        </div>
      </div>
    </div>`;

  $('rdOverlay').onclick = e => { if (e.target === $('rdOverlay')) closeRouteSheet(); };
  $('rdClose').onclick = () => closeRouteSheet();
  $('rdCancel').onclick = () => closeRouteSheet();
  $('rdSave').onclick = () => saveRouteSheet();
  $('rdLabel').addEventListener('input', () => { state.draft.label = $('rdLabel').value; updateDraftJson(); });
  $('rdPort').addEventListener('input', () => {
    const v = $('rdPort').value.replace(/[^0-9]/g, '').slice(0, 5);
    if ($('rdPort').value !== v) $('rdPort').value = v;
    state.draft.localPort = v;
    $('rdPort').style.borderColor = state.routes.some(r => r.id !== state.routeEditing && String(r.localPort) === String(v)) ? 'var(--red)' : 'var(--sep)';
    fillPortWarn(); updateDraftJson();
  });
  $('sheetMount').querySelectorAll('[data-kind]').forEach(b => b.onclick = () => { syncDraft(); state.draft.kind = b.dataset.kind; renderRouteSheet(); });
  $('rdEnabled').onclick = () => { syncDraft(); state.draft.enabled = !state.draft.enabled; renderRouteSheet(); };
  $('rdHopMenu').onclick = e => { e.stopPropagation(); syncDraft(); openMenu('hop', $('rdHopMenu')); };
  $('sheetMount').querySelectorAll('[data-hup]').forEach(b => b.onclick = () => { syncDraft(); const i = +b.dataset.hup; if (!i) return; const h = state.draft.hops; [h[i - 1], h[i]] = [h[i], h[i - 1]]; renderRouteSheet(); });
  $('sheetMount').querySelectorAll('[data-hdown]').forEach(b => b.onclick = () => { syncDraft(); const i = +b.dataset.hdown; const h = state.draft.hops; if (i === h.length - 1) return; [h[i + 1], h[i]] = [h[i], h[i + 1]]; renderRouteSheet(); });
  $('sheetMount').querySelectorAll('[data-hrem]').forEach(b => b.onclick = () => { syncDraft(); const i = +b.dataset.hrem; state.draft.hops = state.draft.hops.filter((_, j) => j !== i); renderRouteSheet(); });
  fillPortWarn();
  if ($('rdBody')) $('rdBody').scrollTop = scrollTop;
}

function updateDraftJson() {
  const jsonSpan = $('sheetMount') && $('sheetMount').querySelector('[style*="word-break:break-all"]');
  if (jsonSpan) jsonSpan.textContent = draftJson();
}

async function saveRouteSheet() {
  syncDraft();
  const d = state.draft;
  const dupPort = state.routes.some(r => r.id !== state.routeEditing && String(r.localPort) === String(d.localPort));
  if (dupPort) { state.alert = { kind: 'conflict', title: '本地端口衝突', body: '端口 ' + d.localPort + ' 已被其他路由使用。同一個端口無法同時服務兩條路由，請改用其他端口。' }; renderAlert(); return; }
  const id = state.routeEditing || 'r-' + Date.now();
  const rec = { id, label: d.label.trim() || '未命名路由', localPort: +d.localPort || 0, kind: d.kind, hops: [...d.hops], enabled: d.enabled };
  let routes;
  try { routes = await window.api.saveRoute(rec); }
  catch (e) { flash('儲存路由失敗：' + (e && e.message || e), 'var(--red)'); return; }
  state.routes = routes || (await window.api.getRoutes());
  state.sel = id;
  closeRouteSheet();
  renderSidebar(); showTab(state.tab);
  flash('已套用路由設定');
  // 儲存後立即套用（不需重啟）
  const wasRunning = ses(id).status === 'running';
  if (rec.enabled && !wasRunning) {
    togglePower(id); // 啟動（衝突會彈 alert）
  } else if (!rec.enabled && wasRunning) {
    togglePower(id); // 停用 → 停止
  } else if (rec.enabled && wasRunning) {
    // 已在執行且仍啟用：重新套用新設定（main 會 stop→start relay）
    const r = await window.api.routeStart(id).catch(() => null);
    if (r && r.ok === false && r.conflict) { state.alert = r.conflict; renderAlert(); }
    afterStatusChange();
  }
}
// =====================================================================================
// 伺服器編輯面板（同 v1）
// =====================================================================================
function openSrv(id) {
  const S = state;
  const s = id ? S.servers.find(x => x.id === id) : null;
  S.srvSheet = true; S.srvEditing = id || null; S.showPass = false; S.credPick = ''; closeMenu();
  S.proto = s ? sProto(s) : 'socks5';
  S.authOpen = s ? !!sUser(s) : false;
  S._form = {
    name: s ? (s.name || '') : '',
    host: s ? (s.host || '') : '',
    port: s ? String(s.port) : String(PROTO[S.proto].port),
    note: s ? (s.note || '') : '',
    user: s ? sUser(s) : '',
    pass: s ? sPass(s) : '',
  };
  renderSrvSheet();
}
function closeSrvSheet() { state.srvSheet = false; closeMenu(); $('srvSheetMount').innerHTML = ''; }
function credLabel() { const opts = credOpts(); return (opts.find(o => o.value === state.credPick) || opts[0]).label; }
function credOpts() { return [{ value: '', label: '不使用（手動輸入）' }, ...state.creds.map(c => ({ value: c.id, label: `${c.name || '未命名'} · ${c.user}` }))]; }
function syncForm() {
  const F = state._form;
  if ($('fName')) F.name = $('fName').value;
  if ($('fHost')) F.host = $('fHost').value;
  if ($('fPort')) F.port = $('fPort').value;
  if ($('fNote')) F.note = $('fNote').value;
  if ($('fUser')) F.user = $('fUser').value;
  if ($('fPass')) F.pass = $('fPass').value;
}

function renderSrvSheet() {
  const S = state, p = PROTO[S.proto], F = S._form;
  const isSocks4 = S.proto === 'socks4';
  const scrollTop = $('ssBody') ? $('ssBody').scrollTop : 0;
  $('srvSheetMount').innerHTML = `
    <div id="ssOverlay" style="position:absolute;inset:0;background:rgba(0,0,0,.28);display:flex;justify-content:flex-end;z-index:50">
      <div id="ssPanel" style="width:470px;height:100%;background:var(--panel);border-left:1px solid var(--sep);box-shadow:-12px 0 40px rgba(0,0,0,.18);display:flex;flex-direction:column;animation:sheetIn .26s cubic-bezier(.32,.72,0,1)">
        <div style="padding:16px 20px;border-bottom:1px solid var(--sep);display:flex;align-items:center">
          <span style="font-size:15px;font-weight:700;letter-spacing:-.2px">${S.srvEditing ? '編輯伺服器' : '新增伺服器'}</span>
          <button id="ssClose" class="hvFill" title="關閉面板" style="margin-left:auto;width:26px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="11" height="11" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.6"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5"></line><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"></line></svg></button>
        </div>
        <div id="ssBody" style="flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:16px">
          <div style="display:flex;flex-direction:column;gap:7px">
            <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">通訊協定</span>
            <button id="protoBtn" class="hvFill2" style="display:flex;align-items:center;gap:9px;padding:9px 11px;border:1px solid var(--sep);border-radius:10px;background:var(--bg);color:var(--text);font-size:13px;cursor:pointer;text-align:left">
              <span style="font-size:9.5px;font-weight:700;letter-spacing:.4px;padding:3px 6px;border-radius:5px;background:var(--accent-dim);color:var(--accent);flex-shrink:0">${p.label}</span>
              <span style="flex:1">${p.name}</span><span style="color:var(--text3);font-size:9px">▾</span>
            </button>
            <span style="font-size:11px;color:var(--text3);line-height:1.55">${p.hint}</span>
          </div>

          <div style="display:flex;flex-direction:column;gap:7px">
            <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">名稱</span>
            <input id="fName" value="${esc(F.name)}" placeholder="例如：主要節點" style="padding:9px 11px;border:1px solid var(--sep);border-radius:10px;background:var(--bg);color:var(--text);font-size:13px;outline:none">
          </div>

          <div style="display:flex;gap:10px">
            <div style="flex:3;display:flex;flex-direction:column;gap:7px">
              <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">主機</span>
              <input id="fHost" value="${esc(F.host)}" placeholder="192.168.1.100" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--sep);border-radius:10px;background:var(--bg);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:13px;outline:none">
            </div>
            <div style="flex:1;display:flex;flex-direction:column;gap:7px">
              <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">端口</span>
              <input id="fPort" value="${esc(F.port)}" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--sep);border-radius:10px;background:var(--bg);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:13px;text-align:center;outline:none">
            </div>
          </div>

          <div style="background:var(--bg);border:1px solid var(--sep);border-radius:12px">
            <div style="padding:11px 13px;display:flex;align-items:center;gap:12px">
              <div style="flex:1"><div style="font-size:12.5px;font-weight:600">${p.authTitle}</div><div style="font-size:11px;color:var(--text2);margin-top:2px">${p.authDesc}</div></div>
              <button id="authToggle" style="width:44px;height:26px;border-radius:13px;border:none;padding:0;cursor:pointer;position:relative;background:${S.authOpen ? 'var(--accent)' : 'var(--fill)'};transition:background .22s;flex-shrink:0">
                <span style="position:absolute;top:3px;left:${S.authOpen ? '21px' : '3px'};width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .22s cubic-bezier(.32,.72,0,1)"></span>
              </button>
            </div>
            ${S.authOpen ? `<div style="padding:0 13px 13px;display:flex;flex-direction:column;gap:11px;border-top:1px solid var(--sep);padding-top:12px;animation:fadeUp .2s ease-out">
              <div style="display:flex;flex-direction:column;gap:6px">
                <span style="font-size:11px;font-weight:600;color:var(--text2);white-space:nowrap">從憑證庫帶入</span>
                <button id="credBtn" class="hvFill2" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--sep);border-radius:9px;background:var(--card);color:var(--text);font-size:12.5px;cursor:pointer;text-align:left">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="color:var(--text3);flex-shrink:0"><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>
                  <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(credLabel())}</span><span style="color:var(--text3);font-size:9px">▾</span>
                </button>
              </div>
              ${isSocks4 ? `<div style="display:flex;flex-direction:column;gap:6px">
                <span style="font-size:11px;font-weight:600;color:var(--text2);white-space:nowrap">User ID</span>
                <input id="fUser" value="${esc(F.user)}" style="padding:8px 10px;border:1px solid var(--sep);border-radius:9px;background:var(--card);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12.5px;outline:none">
              </div>` : `<div style="display:flex;gap:10px">
                <div style="flex:1;display:flex;flex-direction:column;gap:6px">
                  <span style="font-size:11px;font-weight:600;color:var(--text2);white-space:nowrap">帳號</span>
                  <input id="fUser" value="${esc(F.user)}" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--sep);border-radius:9px;background:var(--card);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12.5px;outline:none">
                </div>
                <div style="flex:1;display:flex;flex-direction:column;gap:6px">
                  <span style="font-size:11px;font-weight:600;color:var(--text2);white-space:nowrap">密碼</span>
                  <div style="position:relative;display:flex">
                    <input id="fPass" type="${S.showPass ? 'text' : 'password'}" value="${esc(F.pass)}" style="width:100%;box-sizing:border-box;padding:8px 32px 8px 10px;border:1px solid var(--sep);border-radius:9px;background:var(--card);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12.5px;outline:none">
                    <button id="passEye" title="顯示 / 隱藏密碼" style="position:absolute;right:4px;top:50%;transform:translateY(-50%);width:24px;height:24px;border:none;background:transparent;color:var(--text3);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"></path><circle cx="12" cy="12" r="3"></circle></svg></button>
                  </div>
                </div>
              </div>`}
              <label style="display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--text2);cursor:pointer"><input id="fSaveCred" type="checkbox"> 同時存入憑證庫</label>
            </div>` : ''}
          </div>

          <div style="display:flex;flex-direction:column;gap:7px">
            <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">備註</span>
            <input id="fNote" value="${esc(F.note)}" placeholder="例如：VPS 上的 SSH 通道" style="padding:9px 11px;border:1px solid var(--sep);border-radius:10px;background:var(--bg);color:var(--text);font-size:13px;outline:none">
          </div>
        </div>
        <div style="padding:14px 20px;border-top:1px solid var(--sep);display:flex;align-items:center;gap:10px">
          <span style="font-size:11.5px;color:var(--text3);flex:1">儲存前會自動測試連線</span>
          <button id="ssCancel" class="hvFill2" style="height:32px;padding:0 16px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap">取消</button>
          <button id="ssSave" class="hvBright" style="height:32px;padding:0 18px;border:none;border-radius:9px;background:var(--accent);color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap">測試並儲存</button>
        </div>
      </div>
    </div>`;

  $('ssOverlay').onclick = e => { if (e.target === $('ssOverlay')) closeSrvSheet(); };
  $('ssClose').onclick = () => closeSrvSheet();
  $('ssCancel').onclick = () => closeSrvSheet();
  $('ssSave').onclick = () => saveSrvSheet();
  $('protoBtn').onclick = e => { e.stopPropagation(); syncForm(); openMenu('proto', $('protoBtn')); };
  $('authToggle').onclick = () => { syncForm(); state.authOpen = !state.authOpen; renderSrvSheet(); };
  if ($('credBtn')) $('credBtn').onclick = e => { e.stopPropagation(); syncForm(); openMenu('cred', $('credBtn')); };
  if ($('passEye')) $('passEye').onclick = () => { syncForm(); state.showPass = !state.showPass; renderSrvSheet(); };
  if ($('ssBody')) $('ssBody').scrollTop = scrollTop;
}

async function saveSrvSheet() {
  syncForm();
  const F = state._form;
  const host = F.host.trim();
  const port = parseInt(F.port) || PROTO[state.proto].port;
  if (!host) { flash('請輸入主機位址', 'var(--amber)'); return; }
  const name = F.name.trim();
  const user = state.authOpen ? F.user.trim() : '';
  const pass = state.authOpen ? F.pass : '';
  const note = F.note.trim();
  const saveCred = $('fSaveCred') && $('fSaveCred').checked;
  const data = { name: name || host, host, port, type: state.proto, username: user, password: pass, note };
  let id;
  if (state.srvEditing) { await window.api.updateServer(state.srvEditing, data); id = state.srvEditing; }
  else { const srv = await window.api.addServer(data); id = srv.id; }
  if (saveCred && user) { state.creds.push({ id: 'c' + Date.now(), name: name || host, user, pass, note, shown: false }); saveCreds(); }
  state.servers = await window.api.getServers();
  closeSrvSheet();
  renderSidebar();
  // 走 showTab 而不是只 updateChain()：儀表板可能正在顯示空狀態引導，
  // 而引導的階段是由 servers/routes 數量算出來的，不重畫就會停在上一階。
  if (state.tab === 'dashboard' || state.tab === 'servers') showTab(state.tab);
  flash('已儲存');
  window.api.testServer(id, state.settings.testTarget || undefined).then(async () => {
    state.servers = await window.api.getServers();
    if (state.tab === 'servers') renderServers();
    if (state.tab === 'dashboard') updateChain();
  }).catch(() => {});
}

// =====================================================================================
// 下拉選單（hop / proto / cred）
// =====================================================================================
function openMenu(kind, anchor) {
  if (state.menu && state.menu.kind === kind) { closeMenu(); return; }
  let items;
  if (kind === 'ls-route') {
    const d = state.launchDraft || {};
    items = state.routes.map(r => ({
      label: r.label || r.id, port: (r.kind === 'http' ? 'HTTP' : 'SOCKS5') + ' · ' + r.localPort,
      dot: runningRouteIds().includes(r.id) ? 'var(--good)' : 'var(--text3)', check: d.routeId === r.id,
      pick: () => { d.routeId = r.id; closeMenu(); renderLaunchSheet(); refreshLaunchPreview(); },
    }));
  } else if (kind === 'ks-app') {
    const cur = state.settings.killSwitchApps || [];
    items = state.splitProcs.filter(p => !cur.includes(p)).map(p => ({
      label: p, dot: 'var(--purple)',
      pick: () => { state.settings.killSwitchApps = [...cur, p]; closeMenu(); saveSettings(); refreshSettings(); },
    }));
    if (!items.length) items = [{ label: '沒有其他執行中的程式', dot: 'var(--text3)', pick: () => closeMenu() }];
  } else if (kind === 'rs-detour') {
    items = [{ id: null, label: '直連（不繞路由）' }, ...state.routes.map(r => ({ id: r.id, label: r.label || r.id }))]
      .map(o => ({ label: o.label, dot: o.id ? 'var(--accent)' : 'var(--text3)', check: (state.settings.rulesetDetourRouteId || null) === o.id,
        pick: () => { state.settings.rulesetDetourRouteId = o.id; closeMenu(); saveSettings(); refreshSettings(); flash(o.id ? `規則庫將經由「${o.label}」下載` : '規則庫改為直連下載'); } }));
  } else if (kind.startsWith('split-')) {
    items = splitMenuItems(kind);
  } else if (kind === 'hop') {
    items = state.servers.map(s => ({ badge: PROTO[sProto(s)].label, label: s.name || '未命名', check: false,
      pick: () => { syncDraft(); state.draft.hops = [...state.draft.hops, s.id]; closeMenu(); renderRouteSheet(); } }));
  } else if (kind === 'proto') {
    items = Object.keys(PROTO).map(k => ({ badge: PROTO[k].label, label: PROTO[k].name, check: state.proto === k,
      pick: () => { syncForm(); const wasDefault = state._form.port === String(PROTO[state.proto].port) || !state._form.port; state.proto = k; if (wasDefault) state._form.port = String(PROTO[k].port); if (k === 'socks4') state.authOpen = false; closeMenu(); renderSrvSheet(); } }));
  } else {
    items = credOpts().map(o => ({ badge: '', label: o.label, check: state.credPick === o.value,
      pick: () => { syncForm(); const c = state.creds.find(x => x.id === o.value); state.credPick = o.value; state._form.user = c ? c.user : ''; state._form.pass = c ? c.pass : ''; closeMenu(); renderSrvSheet(); } }));
  }
  const r = anchor.getBoundingClientRect();
  const h = Math.min(260, items.length * 37 + 8), gap = 6;
  const below = window.innerHeight - r.bottom > h + 16;
  const width = (kind === 'split-default' || kind === 'split-target') ? Math.max(r.width, 214) : r.width;
  state.menu = { kind, items, left: r.left, width, top: below ? r.bottom + gap : Math.max(8, r.top - h - gap) };
  renderMenu();
}
function renderMenu() {
  const m = state.menu;
  if (!m) { $('menuMount').innerHTML = ''; return; }
  $('menuMount').innerHTML = `
    <div id="menuOverlay" style="position:fixed;inset:0;z-index:110"></div>
    <div id="menuBox" style="position:fixed;top:${m.top}px;left:${m.left}px;width:${m.width}px;z-index:120;background:var(--panel);border:1px solid var(--sep);border-radius:12px;box-shadow:0 14px 36px rgba(0,0,0,.26);padding:4px;display:flex;flex-direction:column;gap:1px;animation:fadeUp .16s ease-out;max-height:260px;overflow-y:auto">
      ${m.items.map((o, i) => o.header
        ? `<span style="padding:7px 9px 3px;font-size:10.5px;font-weight:600;color:var(--text3);letter-spacing:.3px">${esc(o.header)}</span>`
        : `<button data-mi="${i}" class="hvFill2" style="display:flex;align-items:center;gap:9px;padding:8px 9px;border:none;border-radius:9px;background:${o.check ? 'var(--accent-dim)' : 'transparent'};color:var(--text);font-size:12.5px;cursor:pointer;text-align:left;width:100%">
        <span style="width:12px;flex-shrink:0;color:var(--accent);font-size:11px">${o.check ? '✓' : ''}</span>
        ${o.dot ? `<span style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${o.dot}"></span>` : ''}
        ${o.badge && !o.dot ? `<span style="font-size:9.5px;font-weight:700;letter-spacing:.4px;padding:2px 6px;border-radius:5px;background:var(--fill2);color:var(--text2);flex-shrink:0;width:52px;text-align:center">${o.badge}</span>` : ''}
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(o.label)}</span>
        ${o.badge && o.dot ? `<span style="font-size:9.5px;font-weight:700;letter-spacing:.3px;padding:2px 6px;border-radius:5px;background:var(--fill2);color:var(--text2);flex-shrink:0;white-space:nowrap">${o.badge}</span>` : ''}
      </button>`).join('')}
    </div>`;
  $('menuOverlay').onclick = () => closeMenu();
  $('menuBox').onclick = e => e.stopPropagation();
  $('menuBox').querySelectorAll('[data-mi]').forEach(b => b.onclick = () => m.items[+b.dataset.mi].pick());
  $('menuBox').style.alignItems = 'stretch';
}
function closeMenu() { if (state.menu) { state.menu = null; $('menuMount').innerHTML = ''; } }

// =====================================================================================
// App 內告警視窗
// =====================================================================================
function renderAlert() {
  const a = state.alert;
  if (!a) { $('alertMount').innerHTML = ''; return; }
  const primary = a.primary || (a.kind === 'nohop' ? '編輯路由' : '知道了');
  const secondary = a.secondary || '取消';
  const warn = a.tone !== 'info';
  $('alertMount').innerHTML = `
    <div id="alertOverlay" style="position:absolute;inset:0;background:rgba(0,0,0,.34);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:140">
      <div id="alertBox" style="width:356px;background:var(--panel);border:1px solid var(--sep);border-radius:16px;box-shadow:0 20px 50px rgba(0,0,0,.3);padding:22px;display:flex;flex-direction:column;align-items:center;gap:13px;text-align:center;animation:fadeUp .2s ease-out">
        <div style="width:44px;height:44px;border-radius:50%;background:${warn ? 'rgba(217,83,74,.14)' : 'var(--accent-dim)'};display:flex;align-items:center;justify-content:center;color:${warn ? 'var(--red)' : 'var(--accent)'}">
          <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3.5 2.8 19.5h18.4L12 3.5z"></path><path d="M12 9.5v4.5M12 17h.01"></path></svg>
        </div>
        <span style="font-size:15.5px;font-weight:700;letter-spacing:-.2px">${esc(a.title)}</span>
        <span style="font-size:12.5px;color:var(--text2);line-height:1.7;text-wrap:pretty">${esc(a.body)}</span>
        <div style="display:flex;gap:9px;width:100%;padding-top:4px">
          <button id="alertCancel" class="hvFill2" style="flex:1;height:34px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap">${esc(secondary)}</button>
          <button id="alertPrimary" class="hvBright" style="flex:1;height:34px;border:none;border-radius:9px;background:var(--accent);color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap">${primary}</button>
        </div>
      </div>
    </div>`;
  $('alertOverlay').onclick = e => { if (e.target === $('alertOverlay')) closeAlert(); };
  $('alertCancel').onclick = () => (a.onSecondary ? a.onSecondary() : closeAlert());
  $('alertPrimary').onclick = () => alertAction();
}
function closeAlert() { state.alert = null; $('alertMount').innerHTML = ''; }
function alertAction() {
  const a = state.alert, k = a && a.kind, go = a && a.go;
  if (go) { go(); return; }   // 自訂動作自己負責關閉
  closeAlert();
  if (k === 'nohop' || k === 'conflict') openRoute(state.sel);
}

// 斷線保護告警（分流引擎異常中止時彈出；不可用 Esc 關閉，必須選擇重連或停用）
// =====================================================================================
// 實例分流：以路由啟動程式（設計稿 v5；MERGE §1 路由列第三顆鈕開這張 sheet）
// =====================================================================================
function openLaunchSheet(routeId) {
  const rid = routeId || state.sel || (state.routes[0] || {}).id;
  if (!rid) { flash('請先建立一條路由', 'var(--amber)'); return; }
  state.launchSheet = true;
  state.launchDraft = { routeId: rid, mode: 'browser', browserName: null, exePath: '', exeArgs: '', remember: true };
  state.launchBusy = false; state.launchPreview = '';
  closeMenu();
  renderLaunchSheet();
  loadBrowsersThen();
  refreshLaunchPreview();
}
function closeLaunchSheet() { state.launchSheet = false; closeMenu(); $('launchSheetMount').innerHTML = ''; }

async function loadBrowsersThen() {
  if (!state.browsers.length) {
    try { state.browsers = (await window.api.listBrowsers()) || []; } catch { state.browsers = []; }
  }
  const d = state.launchDraft; if (!d) return;
  if (!d.browserName) { const b = state.browsers.find(x => x.found); if (b) d.browserName = b.name; }
  renderLaunchSheet(); refreshLaunchPreview();
}

// 「將執行」那段由主行程產生，和實際啟動用同一份參數，不會對不上
async function refreshLaunchPreview() {
  const d = state.launchDraft; if (!d) return;
  try { state.launchPreview = (await window.api.launchPreview(d)) || ''; } catch { state.launchPreview = ''; }
  const el = $('lsPreview'); if (el) el.textContent = state.launchPreview;
}

function renderLaunchSheet() {
  const m = $('launchSheetMount'); if (!m) return;
  if (!state.launchSheet) { m.innerHTML = ''; return; }
  const d = state.launchDraft;
  const route = state.routes.find(r => r.id === d.routeId) || {};
  const running = runningRouteIds().includes(d.routeId);
  const isBrowser = d.mode === 'browser';
  const target = isBrowser ? d.browserName : (d.exePath ? d.exePath.split(/[\\/]/).pop() : '');
  const canLaunch = !!target && !state.launchBusy;

  const modeSeg = [['browser', '瀏覽器'], ['program', '其他程式']].map(([k, label]) =>
    `<button data-lsmode="${k}" style="flex:1;border:none;cursor:pointer;height:30px;border-radius:7px;font-size:12px;white-space:nowrap;${segCss(d.mode === k)}">${label}</button>`).join('');

  const browserCards = state.browsers.map(b => {
    const on = d.browserName === b.name;
    const tip = b.found ? `以「${esc(route.label || d.routeId)}」開啟 ${esc(b.name)}` : `找不到 ${esc(b.name)}，請先安裝`;
    return `<button data-lsb="${esc(b.name)}" ${b.found ? '' : 'disabled'} title="${tip}" style="display:flex;flex-direction:column;align-items:center;gap:7px;padding:12px 8px 10px;border:1px solid ${on ? 'var(--accent)' : 'var(--sep)'};border-radius:12px;background:${on ? 'var(--accent-dim)' : 'var(--bg)'};color:var(--text);cursor:${b.found ? 'pointer' : 'not-allowed'};opacity:${b.found ? '1' : '.45'};min-width:0">
      <span style="width:34px;height:34px;border-radius:10px;background:var(--fill2);color:var(--text2);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700">${esc(b.name[0])}</span>
      <span style="font-size:12px;font-weight:600;white-space:nowrap">${esc(b.name)}</span>
      <span style="font-size:10px;color:var(--text3);white-space:nowrap">${b.found ? (on ? '已選擇' : '免提權') : '未安裝'}</span>
    </button>`;
  }).join('');

  const engineOff = !isBrowser && !!d.exePath && !splitRunning();
  const programBody = `
        <div style="display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;gap:8px">
            <input id="lsPath" value="${esc(d.exePath)}" placeholder="程式的完整路徑" style="flex:1;min-width:0;height:34px;padding:0 11px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12px;outline:none">
            <button id="lsBrowse" class="hvFill2" style="flex-shrink:0;height:34px;padding:0 13px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap">瀏覽…</button>
          </div>
          <input id="lsArgs" value="${esc(d.exeArgs)}" placeholder="啟動參數（選填）" style="height:34px;padding:0 11px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12px;outline:none">
          ${engineOff ? '<span style="display:flex;align-items:center;gap:8px;padding:9px 11px;border-radius:9px;background:rgba(217,139,31,.12);font-size:11px;color:var(--amber);line-height:1.5"><span style="flex:1;text-wrap:pretty">分流引擎未執行。這支程式要走代理，得先到分流頁啟動引擎。</span></span>' : ''}
          <div style="background:var(--bg);border:1px solid var(--sep);border-radius:12px;overflow:hidden">
            <div style="display:flex;align-items:center;gap:12px;padding:10px 13px">
              <div style="flex:1;min-width:0">
                <div style="font-size:12.5px;font-weight:500;white-space:nowrap">登記成程式規則</div>
                <div style="font-size:11px;color:var(--text2);margin-top:2px;line-height:1.45;text-wrap:pretty">引擎只認程式名稱，沒有「只有這次」。關掉的話就只是啟動程式，不會走代理。</div>
              </div>
              <button data-lsremember="1" role="switch" aria-label="登記成程式規則" style="width:40px;height:24px;border-radius:12px;border:none;padding:0;cursor:pointer;position:relative;background:${d.remember ? 'var(--accent)' : 'var(--fill)'};transition:background .22s;flex-shrink:0"><span style="position:absolute;top:3px;left:${d.remember ? '19px' : '3px'};width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .22s cubic-bezier(.32,.72,0,1)"></span></button>
            </div>
          </div>
        </div>`;

  m.innerHTML = `
  <div id="lsOverlay" style="position:absolute;inset:0;background:rgba(0,0,0,.28);display:flex;justify-content:flex-end;z-index:60">
    <div id="lsPanel" style="width:470px;height:100%;background:var(--panel);border-left:1px solid var(--sep);box-shadow:-12px 0 40px rgba(0,0,0,.18);display:flex;flex-direction:column;animation:sheetIn .26s cubic-bezier(.32,.72,0,1)">
      <div style="padding:16px 20px;border-bottom:1px solid var(--sep);display:flex;align-items:center;gap:10px">
        <span style="font-size:15px;font-weight:700;letter-spacing:-.2px;white-space:nowrap">以路由啟動程式</span>
        <button id="lsClose" class="hvFill2" title="關閉面板（Esc）" style="margin-left:auto;width:26px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="11" height="11" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.6"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5"></line><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"></line></svg></button>
      </div>

      <div style="flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:16px">
        <div style="display:flex;flex-direction:column;gap:7px">
          <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">路由</span>
          <button id="lsRoute" class="hvFill2" style="display:flex;align-items:center;gap:9px;height:36px;padding:0 11px;border:1px solid var(--sep);border-radius:10px;background:var(--bg);color:var(--text);font-size:12.5px;cursor:pointer;text-align:left">
            <span style="width:7px;height:7px;border-radius:50%;background:${running ? 'var(--good)' : 'var(--text3)'};flex-shrink:0"></span>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(route.label || '未命名路由')}</span>
            <span style="font-size:11px;color:var(--text3);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;white-space:nowrap">${route.kind === 'http' ? 'HTTP' : 'SOCKS5'} · ${route.localPort || ''}</span>
            <span style="color:var(--text3);font-size:9px">▾</span>
          </button>
          ${running ? '' : '<span style="font-size:11px;color:var(--text3);line-height:1.5">此路由尚未啟動，啟動程式時會先自動啟動路由。</span>'}
        </div>

        <div style="display:flex;flex-direction:column;gap:8px">
          <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">要啟動什麼</span>
          <div style="display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:9px">${modeSeg}</div>
          <span style="font-size:11px;color:var(--text3);line-height:1.5;text-wrap:pretty">${isBrowser ? '只有這個視窗走代理，關掉即結束；不需引擎或權限。' : '登記成程式規則後由分流引擎比對，需引擎執行中。'}</span>
        </div>

        ${isBrowser ? `<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px">${browserCards || '<span style="font-size:11.5px;color:var(--text3)">找不到可用的瀏覽器</span>'}</div>` : programBody}

        <div style="background:var(--fill2);border-radius:12px;padding:13px 15px;display:flex;flex-direction:column;gap:7px">
          <span style="font-size:11px;font-weight:600;color:var(--text3);letter-spacing:.3px;white-space:nowrap">將執行</span>
          <span id="lsPreview" style="font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:11px;color:var(--text2);line-height:1.7;word-break:break-all;user-select:text;white-space:pre-wrap">${esc(state.launchPreview)}</span>
        </div>
      </div>

      <div style="padding:14px 20px;border-top:1px solid var(--sep);display:flex;align-items:center;gap:10px">
        <span style="font-size:11.5px;color:var(--text3);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${isBrowser ? '關掉視窗即結束；不影響平常的瀏覽器' : (d.exePath ? '規則對這支程式一律生效，不只這次' : '選擇瀏覽器或程式')}</span>
        <button id="lsCancel" class="hvFill2" style="height:32px;padding:0 16px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap">取消</button>
        <button id="lsGo" ${canLaunch ? '' : 'disabled'} class="${canLaunch ? 'hvBright' : ''}" style="height:32px;padding:0 18px;border:none;border-radius:9px;background:var(--accent);color:#fff;font-size:12.5px;font-weight:600;cursor:${canLaunch ? 'pointer' : 'not-allowed'};white-space:nowrap;opacity:${canLaunch ? '1' : '.5'}">${state.launchBusy ? '啟動中…' : target ? '啟動 ' + esc(target) : '啟動'}</button>
      </div>
    </div>
  </div>`;

  $('lsOverlay').onclick = () => closeLaunchSheet();
  $('lsPanel').onclick = e => e.stopPropagation();
  $('lsClose').onclick = () => closeLaunchSheet();
  $('lsCancel').onclick = () => closeLaunchSheet();
  $('lsRoute').onclick = e => { e.stopPropagation(); openMenu('ls-route', $('lsRoute')); };
  m.querySelectorAll('[data-lsmode]').forEach(b => b.onclick = () => { d.mode = b.dataset.lsmode; renderLaunchSheet(); refreshLaunchPreview(); });
  m.querySelectorAll('[data-lsb]').forEach(b => { if (!b.disabled) b.onclick = () => { d.browserName = b.dataset.lsb; renderLaunchSheet(); refreshLaunchPreview(); }; });
  const rem = m.querySelector('[data-lsremember]');
  if (rem) rem.onclick = () => { d.remember = !d.remember; renderLaunchSheet(); };
  if ($('lsPath')) {
    $('lsPath').addEventListener('input', e => { d.exePath = e.target.value; refreshLaunchPreview(); });
    $('lsArgs').addEventListener('input', e => { d.exeArgs = e.target.value; refreshLaunchPreview(); });
    $('lsBrowse').onclick = async () => {
      try { const p = await window.api.browseExe(); if (p) { d.exePath = p; renderLaunchSheet(); refreshLaunchPreview(); } } catch {}
    };
  }
  $('lsGo').onclick = () => runLaunch();
}

async function runLaunch() {
  const d = state.launchDraft; if (!d || state.launchBusy) return;
  state.launchBusy = true; renderLaunchSheet();
  try {
    const r = await window.api.launchInstance(d);
    if (r && r.ok) {
      closeLaunchSheet();
      flash(r.ruleAdded ? `已啟動，並登記規則「${r.ruleAdded}」` : '已啟動');
      if (r.ruleAdded) { try { const sp = await window.api.getSplit(); if (sp && Array.isArray(sp.rules)) state.splitRules = sp.rules; } catch {} }
      renderSidebar();
    } else {
      state.launchBusy = false; renderLaunchSheet();
      flash((r && r.error) || '啟動失敗', 'var(--red)');
    }
  } catch (e) { state.launchBusy = false; renderLaunchSheet(); flash('啟動失敗：' + e.message, 'var(--red)'); }
}

// ---- 實例列（只有真的有實例時才出現，平常不佔版面）----
// MERGE §2 克制：副標只寫「獨立視窗／N 個子程序」，PID 與 profile 放 tooltip。
function renderInstances() {
  const el = $('dashInstances'); if (!el) return;
  const list = state.instances;
  if (!list.length) { el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = 'block';

  const rows = list.map(i => {
    const route = state.routes.find(r => r.id === i.routeId);
    const on = runningRouteIds().includes(i.routeId);
    const pend = state.pendingKill === i.id;
    const isB = i.mode === 'browser';
    const meta = `PID ${i.pid}` + (isB && i.profile ? ` · profile ${i.profile}` : '');
    return `<div style="display:flex;align-items:center;padding:10px 16px;border-bottom:1px solid var(--sep);font-size:12.5px;background:${pend ? 'rgba(217,83,74,.06)' : 'transparent'}">
      <span style="width:176px;flex-shrink:0;padding-right:10px;box-sizing:border-box;display:flex;align-items:center;gap:9px;min-width:0">
        <span style="width:26px;height:26px;flex-shrink:0;border-radius:7px;background:var(--fill2);color:var(--text2);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700">${esc((i.name || '?').slice(0, 2).toUpperCase())}</span>
        <span style="display:flex;flex-direction:column;min-width:0;gap:1px">
          <span style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(i.name)}</span>
          <span title="${esc(meta)}" style="font-size:10.5px;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${isB ? '獨立視窗' : '引擎接管'}</span>
        </span>
      </span>
      <span style="width:78px;flex-shrink:0"><span title="${isB ? '啟動參數綁定代理，免提權' : '分流引擎依程式名稱比對'}" style="font-size:9.5px;font-weight:700;letter-spacing:.3px;padding:2px 6px;border-radius:5px;background:${isB ? 'var(--accent-dim)' : 'rgba(122,114,207,.14)'};color:${isB ? 'var(--accent)' : 'var(--purple)'};white-space:nowrap">${isB ? '獨立實例' : '引擎接管'}</span></span>
      <span style="flex:1;min-width:0;display:flex;align-items:center;gap:7px">
        <span style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${on ? 'var(--good)' : 'var(--amber)'};animation:${on ? 'dotBeat 2.2s ease-in-out infinite' : 'none'}"></span>
        <span style="display:flex;flex-direction:column;min-width:0;gap:1px">
          <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${on ? 'var(--text)' : 'var(--amber)'}">${esc(route ? (route.label || i.routeId) : '（路由已刪除）')}</span>
          <span style="font-size:10.5px;color:var(--text3);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;white-space:nowrap">${route ? '127.0.0.1:' + route.localPort : ''}</span>
        </span>
      </span>
      <span style="width:64px;flex-shrink:0;display:flex;justify-content:flex-end">
        <button data-killinst="${esc(i.id)}" class="hvRed" title="${pend ? '再按一次確認結束' : '結束此實例'}" style="width:26px;height:26px;border:none;border-radius:7px;background:${pend ? 'var(--red)' : 'var(--fill2)'};color:${pend ? '#fff' : 'var(--red)'};cursor:pointer;display:flex;align-items:center;justify-content:center">${pend
          ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M5 13l4 4L19 7"></path></svg>'
          : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>'}</button>
      </span>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div style="display:flex;align-items:flex-end;gap:12px;margin-bottom:14px">
      <div style="display:flex;flex-direction:column;gap:3px;min-width:0">
        <span style="font-size:15px;font-weight:700;letter-spacing:-.2px;white-space:nowrap">實例分流</span>
        <span style="font-size:11.5px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">只有從這裡啟動的實例走代理，平常開的同名程式照常</span>
      </div>
      <span style="margin-left:auto;font-size:11.5px;color:var(--text3);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;white-space:nowrap">${list.filter(i => i.mode === 'browser').length} 獨立 · ${list.filter(i => i.mode !== 'browser').length} 引擎</span>
    </div>
    <div style="background:var(--card);border:1px solid var(--sep);border-radius:16px;overflow:hidden">
      <div style="display:flex;align-items:center;padding:9px 16px;border-bottom:1px solid var(--sep);font-size:11px;color:var(--text3);font-weight:600;letter-spacing:.3px">
        <span style="width:176px;flex-shrink:0">程式</span><span style="width:78px;flex-shrink:0">方式</span><span style="flex:1;min-width:0">路由</span><span style="width:64px;flex-shrink:0"></span>
      </div>
      ${rows}
    </div>`;

  el.querySelectorAll('[data-killinst]').forEach(b => b.onclick = () => killInstance(b.dataset.killinst));
}

function killInstance(id) {
  if (state.pendingKill !== id) {
    state.pendingKill = id; renderInstances();
    setTimeout(() => { if (state.pendingKill === id) { state.pendingKill = null; renderInstances(); } }, 2500);
    return;
  }
  state.pendingKill = null;
  window.api.killInstance(id).then(() => flash('已結束實例')).catch(e => flash('結束失敗：' + e.message, 'var(--red)'));
}

// 跟 main.js 的 KS_MAX_RETRY 保持一致（那邊是真正控制重試次數的地方）
const KS_MAX_RETRY = 3;

function renderKillswitch() {
  const k = state.killswitch, m = $('ksMount'), bar = $('ksBar');
  if (!k || !k.tripped) { m.innerHTML = ''; if (bar) bar.innerHTML = ''; state.ksAlertOpen = false; return; }

  // 設計稿是兩層：觸發時彈對話框讓使用者做決定，
  // 決定完（或重連失敗）之後仍留一條紅帶，按「查看」可以把對話框叫回來。
  if (bar) {
    bar.innerHTML = `<div style="flex-shrink:0;display:flex;align-items:center;gap:10px;padding:9px 16px;background:var(--red);color:#fff;font-size:12.5px;font-weight:500;animation:fadeUp .2s ease-out">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M12 3l7 3.5v5c0 4.2-2.9 7-7 8.5-4.1-1.5-7-4.3-7-8.5v-5L12 3z"></path><path d="M12 9v4M12 16.5h.01"></path></svg>
      <span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">斷線保護已啟動 · ${k.blocking ? '依規則分流的連線已暫停' : '封鎖模式未生效，目前沒有保護'}</span>
      <button id="ksBarOpen" style="height:26px;padding:0 11px;border:1px solid rgba(255,255,255,.5);border-radius:8px;background:transparent;color:#fff;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap">查看</button>
    </div>`;
    $('ksBarOpen').onclick = () => { state.ksAlertOpen = true; renderKillswitch(); };
  }
  if (!state.ksAlertOpen) { m.innerHTML = ''; return; }
  // 設計稿是「左對齊的橫向標題列 + 資訊方塊 + 兩顆等寬按鈕」，不是置中卡片
  const blockLine = k.blocking
    ? '受保護程式的連線已<strong style="color:var(--text);font-weight:600">暫停</strong>，不會繞過代理外洩；其他程式不受影響。'
    : '<strong style="color:var(--red);font-weight:600">封鎖模式未能啟動</strong>，受保護程式目前沒有保護，請盡快重新連線或停用。';
  const t = k.at ? new Date(k.at) : null;
  const hhmm = t ? `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : '剛剛';
  const retries = Number(k.retries) || 0;
  const retryText = k.reconnecting ? `第 ${retries + 1} 次重試中…`
    : retries >= KS_MAX_RETRY ? `已重試 ${retries} 次皆失敗，請手動處理`
    : retries ? `已重試 ${retries} 次，稍後再試` : '等待重試…';
  const retryColor = retries >= KS_MAX_RETRY ? 'var(--red)' : k.reconnecting ? 'var(--amber)' : 'var(--text)';
  const row = (label, value, color) => `<div style="display:flex;align-items:center;gap:8px;font-size:11.5px"><span style="color:var(--text3);width:56px;flex-shrink:0">${label}</span><span style="flex:1;color:${color || 'var(--text)'};word-break:break-all">${value}</span></div>`;
  m.innerHTML = `
    <div style="position:absolute;inset:0;background:rgba(0,0,0,.42);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:150">
      <div style="width:440px;background:var(--panel);border:1px solid var(--sep);border-radius:20px;box-shadow:0 28px 70px rgba(0,0,0,.36);padding:26px 26px 22px;display:flex;flex-direction:column;gap:16px;animation:fadeUp .22s ease-out">
        <div style="display:flex;align-items:center;gap:14px">
          <div style="width:52px;height:52px;flex-shrink:0;border-radius:15px;background:rgba(217,83,74,.14);display:flex;align-items:center;justify-content:center;color:var(--red);animation:shieldIn .35s cubic-bezier(.32,.72,0,1)">
            <svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3.5v5c0 4.2-2.9 7-7 8.5-4.1-1.5-7-4.3-7-8.5v-5L12 3z"></path><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"></path></svg>
          </div>
          <div style="display:flex;flex-direction:column;gap:3px;min-width:0">
            <span style="font-size:17px;font-weight:700;letter-spacing:-.3px;white-space:nowrap">斷線保護已啟動</span>
            <span style="font-size:12px;color:var(--text2);white-space:nowrap">${hhmm} · 分流引擎異常中止</span>
          </div>
        </div>
        <span style="font-size:12.5px;color:var(--text2);line-height:1.75;text-wrap:pretty">${blockLine}</span>
        <div style="background:var(--bg);border:1px solid var(--sep);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px">
          ${row('原因', `<span style="font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace">${esc(k.reason || '分流引擎中止')}</span>`)}
          ${row('已封鎖', k.blocking ? '所有連線（本機與內網除外）' : '未封鎖 — 保護沒有生效', k.blocking ? null : 'var(--red)')}
          ${row('自動重連', esc(retryText), retryColor)}
        </div>
        <div style="display:flex;gap:9px">
          <button id="ksClear" title="停用分流，受保護程式改為直連" style="flex:1;height:38px;border:1px solid var(--sep);border-radius:11px;background:var(--bg);color:var(--red);font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap">停用分流並直連</button>
          <button id="ksReconnect" class="hvBright" style="flex:1;height:38px;border:none;border-radius:11px;background:var(--accent);color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;display:flex;align-items:center;justify-content:center;gap:7px">${k.reconnecting ? '重新啟動引擎…' : '重新連線'}</button>
        </div>
        <span style="font-size:11px;color:var(--text3);text-align:center;line-height:1.5">此視窗無法以 Esc 關閉，必須選擇其一。</span>
      </div>
    </div>`;
  $('ksReconnect').onclick = async () => {
    // 設計稿：選完就收對話框，失敗也只留紅帶，不把使用者鎖在對話框裡
    const done = () => { state.ksAlertOpen = false; renderKillswitch(); };
    const b = $('ksReconnect'); b.textContent = '重新啟動引擎…'; b.disabled = true;
    try { const r = await window.api.killswitchReconnect(); if (!(r && r.ok)) { flash('重新連線失敗：' + ((r && r.error) || '未知'), 'var(--red)'); done(); } }
    catch (e) { flash('重新連線失敗：' + e.message, 'var(--red)'); done(); }
  };
  $('ksClear').onclick = async () => {
    try { await window.api.killswitchClear(); flash('已停用分流，網路恢復直連', 'var(--amber)'); } catch (e) {}
  };
}

// =====================================================================================
// 匯入 / 匯出（伺服器 + 路由，不含密碼）
// =====================================================================================
async function exportData() {
  const servers = await window.api.getServers();
  const routes = await window.api.getRoutes();
  if (!servers.length && !routes.length) { flash('沒有可匯出的設定', 'var(--amber)'); return; }
  // 密碼預設不匯出——匯出檔常常會被丟進聊天室或雲端硬碟。要帶的話必須明確選擇。
  state.alert = {
    tone: 'info', title: '匯出設定',
    body: `將匯出 ${servers.length} 台伺服器與 ${routes.length} 條路由。代理密碼預設不包含在檔案裡。`,
    primary: '包含密碼一起匯出', secondary: '不含密碼',
    go: () => { closeAlert(); doExport(servers, routes, true); },
    onSecondary: () => { closeAlert(); doExport(servers, routes, false); },
  };
  renderAlert();
}

function doExport(servers, routes, withPass) {
  const pick = s => withPass
    ? { name: s.name, host: s.host, port: s.port, type: s.type, note: s.note, username: s.username, password: s.password }
    : { name: s.name, host: s.host, port: s.port, type: s.type, note: s.note };
  const payload = { servers: servers.map(pick), routes, exportedAt: new Date().toISOString(), includesPasswords: !!withPass };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = withPass ? 'relayclient-config-with-passwords.json' : 'relayclient-config.json';
  a.click();
  URL.revokeObjectURL(url);
  flash(withPass
    ? `已匯出 ${servers.length} 台伺服器（含密碼，請妥善保管）`
    : `已匯出 ${servers.length} 台伺服器 · ${routes.length} 條路由`, withPass ? 'var(--amber)' : undefined);
}

function importData() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const servers = (Array.isArray(data) ? data : (data.servers || [])).filter(s => s && s.host && s.port);
      const routes = Array.isArray(data) ? [] : (data.routes || []);
      if (!servers.length && !routes.length) { flash('檔案裡沒有可匯入的設定', 'var(--amber)'); return; }

      // 衝突偵測：同名同位址的伺服器、或同 id／同本地埠的路由
      const curServers = await window.api.getServers();
      const curRoutes = await window.api.getRoutes();
      const dupServers = servers.filter(s => curServers.some(c => c.host === s.host && String(c.port) === String(s.port)));
      const dupRoutes = routes.filter(r => curRoutes.some(c => c.id === r.id || String(c.localPort) === String(r.localPort)));

      if (dupServers.length || dupRoutes.length) {
        const parts = [];
        if (dupServers.length) parts.push(`${dupServers.length} 台伺服器位址重複`);
        if (dupRoutes.length) parts.push(`${dupRoutes.length} 條路由的 id 或本地埠重複`);
        state.alert = {
          tone: 'info', title: '匯入設定有衝突',
          body: `${parts.join('、')}。「略過重複」會保留你現有的設定；「覆蓋」會用檔案裡的版本取代。`,
          primary: '覆蓋現有設定', secondary: '略過重複',
          go: () => { closeAlert(); doImport(servers, routes, true); },
          onSecondary: () => { closeAlert(); doImport(servers, routes, false); },
        };
        renderAlert();
        return;
      }
      doImport(servers, routes, false);
    } catch (err) { flash('匯入失敗：' + err.message, 'var(--red)'); }
  };
  input.click();
}

async function doImport(servers, routes, overwrite) {
  try {
    const curServers = await window.api.getServers();
    const curRoutes = await window.api.getRoutes();
    let ns = 0, skipped = 0;
    for (const s of servers) {
      const dup = curServers.find(c => c.host === s.host && String(c.port) === String(s.port));
      if (dup && !overwrite) { skipped++; continue; }
      const rec = { name: s.name || s.host, host: s.host, port: s.port, type: s.type || 'socks5', username: s.username || '', password: s.password || '', note: s.note || '' };
      if (dup) await window.api.updateServer(dup.id, rec); else await window.api.addServer(rec);
      ns++;
    }
    let nr = 0;
    for (const r of routes) {
      if (!r || !r.id) continue;
      const dup = curRoutes.find(c => c.id === r.id || String(c.localPort) === String(r.localPort));
      if (dup && !overwrite) { skipped++; continue; }
      await window.api.saveRoute(r); nr++;
    }
    state.servers = await window.api.getServers();
    state.routes = await window.api.getRoutes();
    if (!state.sel && state.routes[0]) state.sel = state.routes[0].id;
    renderSidebar(); showTab(state.tab);
    flash(`已匯入 ${ns} 台伺服器 · ${nr} 條路由` + (skipped ? `（略過 ${skipped} 筆重複）` : ''));
  } catch (err) { flash('匯入失敗：' + err.message, 'var(--red)'); }
}

// =====================================================================================
// Toast / Banner / 主題
// =====================================================================================
let toastTimer;
function flash(text, color) {
  state.toast = text;
  $('toastDot').style.background = color || 'var(--accent)';
  $('toastText').textContent = text;
  const t = $('toast'); t.style.display = 'flex';
  t.style.animation = 'none'; void t.offsetHeight; t.style.animation = 'toastIn .2s ease-out';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; state.toast = ''; }, 2200);
}
function showBanner() {
  const b = $('banner');
  if (state.banner) { $('bannerText').textContent = state.banner; b.style.display = 'flex'; }
  else b.style.display = 'none';
}
function setTheme(mode) {
  const theme = mode === '深色' ? 'dark' : mode === '淺色' ? 'light' : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.body.dataset.theme = theme;
  state.theme = theme; state.themeMode = mode;
  localStorage.setItem('proxy_theme', mode);
  renderThemeSeg();
}

// =====================================================================================
// 傳輸統計 tick（300ms 取樣；速率由真實累計位元組差分推得）
// =====================================================================================
setInterval(() => {
  let selDirty = false;
  Object.keys(state.sessions).forEach(id => {
    const s = state.sessions[id];
    if (s.status !== 'running') return;
    const pu = s._pu || 0, pd = s._pd || 0;
    const up = Math.max(0, (s.upT || 0) - pu) / 0.3, down = Math.max(0, (s.downT || 0) - pd) / 0.3;
    s._pu = s.upT || 0; s._pd = s.downT || 0;
    s.up = up; s.down = down;
    s.series = [...(s.series || []), { down, up }].slice(-60);
    if (s.startTs) s.uptime = Math.floor((Date.now() - s.startTs) / 1000);
    if (id === state.sel) selDirty = true;
  });
  if (selDirty && state.tab === 'dashboard') updateTraffic();
}, 300);

// =====================================================================================
// 狀態同步（onRouteStatus 對帳）
// =====================================================================================
function reconcileStatus(list) {
  const arr = Array.isArray(list) ? list : [];
  const runningIds = new Set(arr.filter(s => s.running).map(s => s.id));
  arr.forEach(s => {
    if (!s.running) return;
    const cur = state.sessions[s.id];
    if (!cur || (cur.status !== 'running' && cur.status !== 'connecting' && cur.status !== 'closing')) {
      setSes(s.id, { status: 'running', prog: 1, settle: false, startTs: (cur && cur.startTs) || Date.now(),
        series: (cur && cur.series) || [], upT: (cur && cur.upT) || 0, downT: (cur && cur.downT) || 0, conns: (cur && cur.conns) || 0, uptime: (cur && cur.uptime) || 0, _pu: 0, _pd: 0 });
    }
  });
  Object.keys(state.sessions).forEach(id => {
    const s = state.sessions[id];
    if (!runningIds.has(id) && s.status === 'running') dropSes(id);
  });
  afterStatusChange();
}

// =====================================================================================
// 開機
// =====================================================================================
async function boot() {
  setTheme(localStorage.getItem('proxy_theme') || '系統');
  mount();

  try { const s = await window.api.getSettings(); if (s) state.settings = { ...state.settings, ...s }; } catch {}
  try { state.servers = await window.api.getServers(); } catch {}
  try { state.routes = await window.api.getRoutes(); } catch {}
  try {
    const st = await window.api.getRouteStatus();
    (st || []).forEach(r => { if (r.running) setSes(r.id, { status: 'running', prog: 1, startTs: Date.now(), series: [], upT: 0, downT: 0, conns: 0, uptime: 0, _pu: 0, _pd: 0 }); });
  } catch {}
  if (!state.sel && state.routes[0]) state.sel = state.routes[0].id;
  try { const logs = await window.api.getLogs(); state.logs = (logs || []).map(l => ({ ...l, id: ++logSeq })); } catch {}
  try { const sp = await window.api.getSplit(); if (sp) { if (Array.isArray(sp.rules)) state.splitRules = sp.rules; if (sp.defaultTarget != null) state.splitDefaultTarget = sp.defaultTarget; if (typeof sp.udp === 'boolean') state.splitUdp = sp.udp; } } catch {}
  try { const est = await window.api.getEngineStatus(); if (est) applyEngineStatus(est); } catch {}
  try { state.browser = await window.api.browserInfo(); } catch {}
  try { state.instances = (await window.api.listInstances()) || []; } catch {}

  renderSidebar();
  showTab('dashboard');
  refreshSettings();
  syncTitlebar();

  window.api.onLogEntry(entry => {
    state.logs = [...state.logs, { ...entry, id: ++logSeq }].slice(-300);
    if (state.tab === 'logs') renderLogList();
  });
  window.api.onRouteStats(stats => {
    if (!stats || !stats.routeId) return;
    const s = state.sessions[stats.routeId];
    if (!s) return;
    if (typeof stats.connections === 'number') s.conns = Math.max(0, stats.connections);
    if (typeof stats.bytesUp === 'number') s.upT = stats.bytesUp;
    if (typeof stats.bytesDown === 'number') s.downT = stats.bytesDown;
  });
  window.api.onRouteStatus(list => reconcileStatus(list));

  // 系統代理也可能從系統匣被切換。少了這個訂閱，從系統匣切換之後
  // 主視窗的開關還停在舊狀態，使用者看到的跟實際的不一樣。
  if (window.api.onSystemProxy) window.api.onSystemProxy(s => {
    if (!s) return;
    state.sys = !!s.enabled;
    if (state.tab === 'dashboard') updateDashboard();
  });
  if (window.api.onEngineStatus) window.api.onEngineStatus(st => { if (st) applyEngineStatus(st); });
  if (window.api.onInstances) window.api.onInstances(list => { state.instances = list || []; renderInstances(); renderSidebar(); });
  if (window.api.onKillswitch) window.api.onKillswitch(k => { if (k) { if (k.tripped && !(state.killswitch && state.killswitch.tripped)) state.ksAlertOpen = true; state.killswitch = k; renderKillswitch(); if (k.tripped) flash('斷線保護啟動：已暫停受保護程式的連線', 'var(--red)'); } });
  if (window.api.onUpdateStatus) window.api.onUpdateStatus(s => {
    if (!s) return;
    state.update = { status: s.status, version: s.version || state.update.version, percent: s.percent || 0 };
    refreshUpdateBtn();
    if (s.status === 'available') flash(`發現新版本 v${s.version}`);
    else if (s.status === 'downloaded') flash('更新已下載——點「重新啟動安裝」即可套用');
    else if (s.status === 'error') flash('更新檢查失敗：' + (s.error || ''), 'var(--amber)');
  });
  window.api.getKillswitch && window.api.getKillswitch().then(k => { if (k && k.tripped) { state.killswitch = k; renderKillswitch(); } }).catch(() => {});
}

// =====================================================================================
// 分流（Split routing）分頁 — 照 Claude Design「v8 · 分流單一規則表」一比一還原，接真實 IPC。
// 引擎（TUN）狀態機 off→starting→running；模式 規則/全域/直連；
// 單一規則表：一條規則 = 程式 × 目的地 × 埠 × 協定（全部 AND），由上往下第一條命中即生效。
// 骨架 buildSplit() 建一次（電源 SVG 常駐才能觸發 ring 過場）；updateSplit() 套動態值。
// =====================================================================================
const splitRunning = () => state.splitEngine === 'running';
const splitRuleMode = () => state.splitMode === 'rule';
const splitActive = () => splitRunning() && splitRuleMode();
const splitRouteOf = id => state.routes.find(r => r.id === id);
const splitTargetLabel = id => id === 'direct' ? '直接連線（不經代理）' : id === 'block' ? '封鎖（丟棄連線）' : (splitRouteOf(id) || {}).label || '（路由已刪除）';
const splitTargetBadge = id => id === 'direct' ? 'DIRECT' : id === 'block' ? 'BLOCK' : (splitRouteOf(id) ? (splitRouteOf(id).kind === 'http' ? 'HTTP' : 'SOCKS5') : '—');
const splitTargetDot = (id, on = true) => !on ? 'var(--text3)' : id === 'block' ? 'var(--red)'
  : id === 'direct' ? 'var(--text2)' : splitActive() ? 'var(--good)' : 'var(--text3)';

// 內建「本機與內網」規則的顯示用清單（與 src/engine/singbox.js 的 PRIVATE_CIDRS 對應）
const LAN_CIDRS = '127.0.0.0/8 · 10.0.0.0/8 · 172.16.0.0/12 · 192.168.0.0/16 · 169.254.0.0/16 · 100.64.0.0/10 · 224.0.0.0/4 · ::1 · fc00::/7 · fe80::/10';

// ---- schema 2 規則存取：條件放在 rule.when（app / dest / port / network，全部可選且互為 AND）----
const rWhen = r => (r && r.when) || {};
const splitVals = s => (Array.isArray(s) ? s : String(s == null ? '' : s).split(/[\n,;]+/)).map(x => String(x).trim()).filter(Boolean);
const DEST_KINDS = [['suffix', '網域'], ['ip', 'IP / 網段'], ['ruleset', '地區 · 分類'], ['keyword', '關鍵字']];
const DEST_UI = {
  suffix: { ph: 'google.com\n=login.example.com', hint: '含所有子網域，一行一個。只想完全相符時在開頭加 =。' },
  ip: { ph: '10.0.0.0/8\n8.8.8.8', hint: '單一 IP 或 CIDR 網段，一行一個。' },
  keyword: { ph: 'doubleclick', hint: '網域中含這段文字就命中，最寬鬆，容易誤傷。' },
  regex: { ph: '^ad\\d+\\.example\\.com$', hint: 'RE2 語法。寫錯只會不命中，不會讓引擎壞掉。' },
  domain: { ph: 'example.com', hint: '完全相符才命中，一行一個。' },
};
const catLabel = tag => (state.splitCatalog.find(c => c.tag === tag) || {}).label || tag;
const isInstalled = tag => state.splitInstalled.some(e => e.tag === tag && !e.missing);

// 一條規則的條件摘要 → [{ k, v, full }]
function condSummary(w) {
  const out = [];
  if (w.app && w.app.value) {
    const v = w.app.match === 'path' ? String(w.app.value).split(/[\\/]/).pop() : w.app.value;
    out.push({ k: '程式', v, full: w.app.value });
  }
  if (w.dest && w.dest.value) {
    const v = splitVals(w.dest.value);
    const show = w.dest.match === 'ruleset' ? v.map(catLabel)
      : v.map(x => w.dest.match === 'suffix' && !x.startsWith('=') ? '*.' + x : x.replace(/^=/, ''));
    const k = w.dest.match === 'ruleset' ? '地區' : w.dest.match === 'ip' ? 'IP'
      : w.dest.match === 'keyword' ? '關鍵字' : w.dest.match === 'regex' ? '正則' : '網域';
    out.push({ k, v: show.slice(0, 2).join(', ') + (show.length > 2 ? ' +' + (show.length - 2) : ''), full: show.join(', ') });
  }
  if (w.port) out.push({ k: '埠', v: w.port, full: w.port });
  if (w.network) out.push({ k: '協定', v: String(w.network).toUpperCase(), full: String(w.network).toUpperCase() });
  return out;
}
const condChipStyle = k => k === '程式' ? { bg: 'rgba(122,114,207,.14)', color: 'var(--purple)' }
  : (k === '埠' || k === '協定') ? { bg: 'var(--fill2)', color: 'var(--text2)' }
  : { bg: 'var(--accent-dim)', color: 'var(--accent)' };
// 規則引用到、但還沒下載的規則庫
const missingTags = r => {
  const d = rWhen(r).dest;
  return (d && d.match === 'ruleset') ? splitVals(d.value).filter(t => !isInstalled(t)) : [];
};

function splitDotColor(d) {
  if (!d) return 'var(--text3)';
  if (/^(var\(|#|rgb)/.test(d)) return d;
  const map = { good: 'var(--good)', ok: 'var(--good)', green: 'var(--good)', up: 'var(--good)', amber: 'var(--amber)', warn: 'var(--amber)', yellow: 'var(--amber)', red: 'var(--red)', error: 'var(--red)', bad: 'var(--red)', down: 'var(--red)', off: 'var(--text3)', idle: 'var(--text3)', neutral: 'var(--text3)', gray: 'var(--text3)', grey: 'var(--text3)' };
  return map[String(d).toLowerCase()] || 'var(--text3)';
}

// ---- 引擎狀態同步（getEngineStatus / onEngineStatus）----
function applyEngineStatus(st) {
  if (st.state) state.splitEngine = st.state;
  if (typeof st.elevated === 'boolean') state.splitElevated = st.elevated;
  if ('tun' in st) state.splitTun = st.tun;
  if (Array.isArray(st.health)) state.splitHealth = st.health;
  if (state.tab === 'split') { updateSplit(); syncTitlebar(); }
}
async function refreshEngineStatus() {
  try { const st = await window.api.getEngineStatus(); if (st) applyEngineStatus(st); } catch {}
}

// ---- 標題列 / 新增按鈕（分頁感知）----
function syncSplitTitlebar() {
  const st = $('status'); if (!st) return;
  const running = splitRunning(), starting = state.splitEngine === 'starting';
  const modeTail = state.splitMode === 'rule' ? `${state.splitRules.filter(r => r.on !== false).length} 條規則`
    : state.splitMode === 'global' ? '全域' : '直連';
  if (running) { st.textContent = `分流引擎執行中 · ${modeTail}`; st.style.color = 'var(--good)'; }
  else if (starting) { st.textContent = '正在啟動引擎…'; st.style.color = 'var(--amber)'; }
  else { st.textContent = '分流引擎未執行'; st.style.color = 'var(--text3)'; }
  $('markArc').setAttribute('stroke', running ? '#7fe3bd' : 'rgba(255,255,255,.55)');
}
function syncAddButton() {
  const b = $('btnAdd'); if (!b) return;
  // 紀錄與設定頁沒有「新增」這個動作 → 整顆隱藏，免得按了跑去新增路由
  const hidden = state.tab === 'logs' || state.tab === 'settings';
  b.style.display = hidden ? 'none' : 'flex';
  if (hidden) return;
  const isSplit = state.tab === 'split';
  const label = isSplit ? '新增規則' : '新增路由';
  b.title = label + ' (Ctrl+N)';
  b.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>${label}`;
}

// ---- 進入分頁 ----
function enterSplit() { updateSplit(); refreshSplit(); }
async function refreshSplit() {
  try {
    const sp = await window.api.getSplit();
    if (sp) {
      if (Array.isArray(sp.rules)) state.splitRules = sp.rules;
      if (sp.defaultTarget != null) state.splitDefaultTarget = sp.defaultTarget;
      if (typeof sp.udp === 'boolean') state.splitUdp = sp.udp;
      if (sp.mode) state.splitMode = sp.mode;
      if ('globalTarget' in sp) state.splitGlobalTarget = sp.globalTarget;
      if (typeof sp.lanDirect === 'boolean') state.splitLanDirect = sp.lanDirect;
    }
  } catch {}
  try { const cat = await window.api.rulesetCatalog(); if (Array.isArray(cat)) state.splitCatalog = cat; } catch {}
  try { const list = await window.api.rulesetList(); if (Array.isArray(list)) state.splitInstalled = list; } catch {}
  try { const est = await window.api.getEngineStatus(); if (est) applyEngineStatus(est); } catch {}
  if (state.tab === 'split') { updateSplit(); syncTitlebar(); }
}

// ---- 骨架（建一次；電源 SVG 常駐才能觸發 ring 過場）----
function buildSplit() {
  $('view-split').innerHTML = `
  <div style="display:flex;flex-direction:column;gap:14px;align-items:stretch">

    <div style="background:var(--card);border:1px solid var(--sep);border-radius:16px;padding:18px 20px;display:flex;flex-direction:column;gap:14px;flex-shrink:0">
      <div style="display:flex;align-items:center;gap:18px">
        <button id="spEngineBtn" title="啟動分流引擎" style="width:78px;height:78px;flex-shrink:0;position:relative;border:none;background:transparent;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center">
          <svg width="78" height="78" viewBox="0 0 256 256" style="position:absolute;inset:0">
            <circle cx="128" cy="128" r="92" fill="none" stroke="var(--fill2)" stroke-width="14"></circle>
            <g id="spEngineSpin" style="transform-origin:128px 128px;animation:none;opacity:0">
              <path d="M128 36 A92 92 0 0 1 220 128" fill="none" stroke="var(--accent)" stroke-width="14" stroke-linecap="round"></path>
            </g>
            <circle id="spEngineRing" cx="128" cy="128" r="92" fill="none" stroke="var(--good)" stroke-width="14" stroke-linecap="round" stroke-dasharray="578" stroke-dashoffset="578" style="transform-origin:128px 128px;transform:rotate(-90deg);transition:stroke-dashoffset 1.1s cubic-bezier(.25,.5,.3,1),stroke .3s;opacity:0"></circle>
            <g id="spEngineIcon" style="color:var(--text3)">
              <path d="M92 100 h72 a8 8 0 0 1 8 8 v40 a8 8 0 0 1 -8 8 h-72 a8 8 0 0 1 -8 -8 v-40 a8 8 0 0 1 8 -8 z" fill="none" stroke="currentColor" stroke-width="11" stroke-linejoin="round"></path>
              <path d="M110 156 v14 M146 156 v14 M96 170 h64" fill="none" stroke="currentColor" stroke-width="11" stroke-linecap="round"></path>
            </g>
          </svg>
        </button>
        <div style="flex:1;display:flex;flex-direction:column;gap:7px;min-width:0">
          <div style="display:flex;align-items:center;gap:9px">
            <span id="spEngineTitle" style="font-size:19px;font-weight:700;letter-spacing:-.3px;white-space:nowrap">分流引擎未執行</span>
            <span id="spEngineBadge" style="font-size:9.5px;font-weight:700;letter-spacing:.4px;padding:3px 7px;border-radius:6px;background:var(--fill2);color:var(--text2);white-space:nowrap">未授權</span>
          </div>
          <span id="spEngineDesc" style="font-size:12.5px;color:var(--text2);line-height:1.6;text-wrap:pretty">啟動後依規則決定每個連線走哪條路。</span>
        </div>
        <div style="width:1px;align-self:stretch;background:var(--sep)"></div>
        <div style="width:236px;flex-shrink:0;display:flex;flex-direction:column;gap:11px">
          <div style="display:flex;flex-direction:column;gap:5px">
            <span style="font-size:11px;font-weight:600;color:var(--text3);letter-spacing:.3px;white-space:nowrap">模式</span>
            <div id="spModeSeg" style="display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:9px"></div>
          </div>
          <div id="spDefaultWrap" style="display:flex;flex-direction:column;gap:5px">
            <span style="font-size:11px;font-weight:600;color:var(--text3);letter-spacing:.3px;white-space:nowrap">規則外流量</span>
            <button id="spDefaultBtn" class="hvFill2" style="display:flex;align-items:center;gap:7px;height:30px;padding:0 10px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12px;cursor:pointer;text-align:left">
              <span id="spDefaultDot" style="width:7px;height:7px;border-radius:50%;background:var(--text2);flex-shrink:0"></span>
              <span id="spDefaultLabel" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">直接連線</span>
              <span style="color:var(--text3);font-size:9px">▾</span>
            </button>
          </div>
          <div id="spGlobalWrap" style="display:none;flex-direction:column;gap:5px">
            <span style="font-size:11px;font-weight:600;color:var(--text3);letter-spacing:.3px;white-space:nowrap">全部流量走</span>
            <button id="spGlobalBtn" class="hvFill2" style="display:flex;align-items:center;gap:7px;height:30px;padding:0 10px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12px;cursor:pointer;text-align:left">
              <span id="spGlobalDot" style="width:7px;height:7px;border-radius:50%;background:var(--text2);flex-shrink:0"></span>
              <span id="spGlobalLabel" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">—</span>
              <span style="color:var(--text3);font-size:9px">▾</span>
            </button>
          </div>
          <span id="spDirectNote" style="display:none;font-size:11.5px;color:var(--text2);line-height:1.5;text-wrap:pretty">所有流量直連，不走任何路由。TUN 與斷線保護維持運作，切回規則不需重新提權。</span>
        </div>
      </div>

    </div>

    <div id="spNotice"></div>

    <div id="spRulesHead" style="display:flex;align-items:center;gap:10px;flex-shrink:0">
      <span style="font-size:15px;font-weight:700;letter-spacing:-.2px;white-space:nowrap">規則</span>
      <span style="font-size:11.5px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0">由上往下比對，第一條命中即生效；一條規則可同時限定程式、目的地、埠與協定</span>
      <button id="spSimToggle" class="hvFill2" title="測試某個網址會走哪一條規則" style="margin-left:auto;display:flex;align-items:center;gap:5px;height:28px;padding:0 11px;border:1px solid var(--sep);border-radius:8px;background:var(--card);color:var(--text2);font-size:12px;cursor:pointer;white-space:nowrap;flex-shrink:0"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"></circle><path d="M20 20l-4.2-4.2"></path></svg>模擬</button>
      <div id="spTools" style="display:none;align-items:center;gap:8px;flex-shrink:0">
        <input id="spSearch" placeholder="搜尋…" style="width:150px;height:28px;padding:0 10px;border:1px solid var(--sep);border-radius:8px;background:var(--card);color:var(--text);font-size:12px;outline:none">
        <div id="spFilterSeg" style="display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:8px"></div>
      </div>
    </div>

    <div id="spSimPanel" style="display:none;flex-direction:column;gap:9px;background:var(--card);border:1px solid var(--sep);border-radius:16px;padding:13px 16px;flex-shrink:0">
      <div style="display:flex;align-items:center;gap:8px">
        <input id="spSimHost" placeholder="輸入網域、IP 或 IP:埠，例如 www.netflix.com" style="flex:1;min-width:0;height:32px;padding:0 11px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12.5px;outline:none">
        <button id="spSimExeBtn" class="hvFill2" title="只測某支程式" style="display:flex;align-items:center;gap:6px;height:32px;padding:0 10px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text2);font-size:12px;cursor:pointer;white-space:nowrap;flex-shrink:0"><span id="spSimExeLabel">不限程式</span><span style="color:var(--text3);font-size:9px">▾</span></button>
        <button id="spSimRun" class="hvBright" style="height:32px;padding:0 15px;border:none;border-radius:9px;background:var(--accent);color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0">模擬</button>
      </div>
      <div id="spSimResult"></div>
    </div>

    <div id="spTableWrap" style="background:var(--card);border:1px solid var(--sep);border-radius:16px;overflow:hidden;flex-shrink:0;transition:opacity .3s">
      <div id="spRulesTable"></div>
    </div>

    <div id="spEmpty"></div>
  </div>`;

  $('spEngineBtn').onclick = () => toggleSplitEngine();
  $('spDefaultBtn').onclick = e => { e.stopPropagation(); openMenu('split-default', $('spDefaultBtn')); };
  $('spGlobalBtn').onclick = e => { e.stopPropagation(); openMenu('split-global', $('spGlobalBtn')); };
  $('spSimExeBtn').onclick = e => { e.stopPropagation(); openMenu('split-simexe', $('spSimExeBtn')); };
  $('spSimRun').onclick = () => runSplitSim();
  $('spSimToggle').onclick = () => {
    state.splitSimOpen = !state.splitSimOpen;
    updateSplit();
    if (state.splitSimOpen && $('spSimHost')) $('spSimHost').focus();
  };
  $('spSimHost').addEventListener('input', e => { state.splitSimHost = e.target.value; });
  $('spSimHost').addEventListener('keydown', e => { if (e.key === 'Enter') runSplitSim(); });
  $('spSearch').addEventListener('input', e => { state.splitSearch = e.target.value; renderSplitRules(); });
}

// ---- 動態值套用 ----
function updateSplit() {
  if (!$('spEngineBtn')) return;
  const running = splitRunning(), starting = state.splitEngine === 'starting';
  const mode = state.splitMode, ruleMode = mode === 'rule';

  const spin = $('spEngineSpin'); if (spin) { spin.style.animation = starting ? 'spinArc 1.1s cubic-bezier(.6,.05,.4,.95) infinite' : 'none'; spin.style.opacity = starting ? '1' : '0'; }
  const ring = $('spEngineRing'); if (ring) { ring.setAttribute('stroke-dashoffset', String(running ? 0 : 578)); ring.style.opacity = running ? '1' : '0'; }
  const ig = $('spEngineIcon'); if (ig) ig.style.color = running ? 'var(--good)' : starting ? 'var(--accent)' : 'var(--text3)';
  $('spEngineBtn').title = running ? '停止分流引擎' : '啟動分流引擎（需管理員權限）';
  $('spEngineTitle').textContent = running ? '分流引擎執行中' : starting ? '正在啟動…' : '分流引擎未執行';

  const badge = $('spEngineBadge');
  badge.textContent = running ? '執行中' : starting ? '正在啟動' : state.splitElevated ? '已授權' : '需要授權';
  badge.style.background = running ? 'rgba(47,158,120,.14)' : starting ? 'rgba(217,139,31,.14)' : state.splitElevated ? 'var(--fill2)' : 'rgba(217,139,31,.14)';
  badge.style.color = running ? 'var(--good)' : starting ? 'var(--amber)' : state.splitElevated ? 'var(--text2)' : 'var(--amber)';

  $('spEngineDesc').textContent = running
    ? (ruleMode ? '依規則表分流；規則變更約 1–2 秒生效。切換模式不需重新提權。'
      : mode === 'global' ? `所有流量走「${splitTargetLabel(state.splitGlobalTarget)}」。`
      : '所有流量直連，斷線保護維持。')
    : '啟動後依規則決定每個連線走哪條路。';

  renderSplitModes();
  setDisp('spDefaultWrap', false); setDisp('spGlobalWrap', false); setDisp('spDirectNote', false);
  if (ruleMode) { $('spDefaultWrap').style.display = 'flex'; }
  else if (mode === 'global') { $('spGlobalWrap').style.display = 'flex'; }
  else { $('spDirectNote').style.display = 'block'; }

  $('spDefaultDot').style.background = splitTargetDot(state.splitDefaultTarget);
  $('spDefaultLabel').textContent = splitTargetLabel(state.splitDefaultTarget);
  $('spGlobalDot').style.background = splitTargetDot(state.splitGlobalTarget);
  $('spGlobalLabel').textContent = state.splitGlobalTarget ? splitTargetLabel(state.splitGlobalTarget) : '請選擇路由';
  $('spSimExeLabel').textContent = state.splitSimExe || '不限程式';

  const has = state.splitRules.length > 0;
  setDisp('spRulesHead', has); $('spRulesHead').style.display = has ? 'flex' : 'none';
  $('spTableWrap').style.display = has ? 'block' : 'none';
  $('spTableWrap').style.opacity = ruleMode ? '1' : '.45';
  $('spTools').style.display = state.splitRules.length >= 10 ? 'flex' : 'none';
  $('spSimToggle').style.display = has ? 'flex' : 'none';
  $('spSimPanel').style.display = (has && state.splitSimOpen) ? 'flex' : 'none';

  renderSplitNotice();
  renderSplitFilter();
  renderSplitRules();
  renderSplitEmpty();
  renderSplitSim();
}

function renderSplitModes() {
  const el = $('spModeSeg'); if (!el) return;
  const modes = [['rule', '規則', '依下方規則表分流'], ['global', '全域', '所有流量走同一條路由'], ['direct', '直連', '所有流量不經代理']];
  el.innerHTML = modes.map(([k, label, tip]) =>
    `<button data-mode="${k}" title="${esc(tip)}" style="flex:1;border:none;cursor:pointer;height:28px;border-radius:7px;font-size:12px;white-space:nowrap;${segCss(state.splitMode === k)}">${label}</button>`).join('');
  el.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setSplitMode(b.dataset.mode));
}

async function setSplitMode(mode) {
  if (state.splitMode === mode) return;
  if (mode === 'global' && !state.splitGlobalTarget) {
    const first = state.routes[0];
    if (!first) { flash('請先建立一條路由', 'var(--amber)'); return; }
    state.splitGlobalTarget = first.id;
  }
  state.splitMode = mode;
  updateSplit();
  await persistSplit({ mode, globalTarget: state.splitGlobalTarget });
  flash(mode === 'rule' ? '已切回規則模式'
    : mode === 'global' ? `全域模式：所有流量走「${splitTargetLabel(state.splitGlobalTarget)}」`
    : '直連模式：所有流量不經代理');
}

function renderSplitNotice() {
  const el = $('spNotice'); if (!el) return;
  // 同時最多一條：斷線保護橫幅已經蓋在上方時，不再疊通知條
  if (state.killswitch && state.killswitch.tripped) { el.innerHTML = ''; return; }
  const running = splitRunning();
  const info = 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8h.01M11 12h1v5h1';
  const warn = 'M12 3.5 2.8 19.5h18.4L12 3.5zM12 9.5v4.5M12 17h.01';
  const shield = 'M12 3l7 3.5v5c0 4.2-2.9 7-7 8.5-4.1-1.5-7-4.3-7-8.5v-5L12 3z';
  const missing = state.splitRules.filter(r => r.on !== false && missingTags(r).length);
  let n = null;
  if (state.splitMode === 'global') n = { text: `全域模式：所有流量走「${splitTargetLabel(state.splitGlobalTarget)}」，下方規則暫時停用（本機與內網仍直連）。`, bg: 'var(--accent-dim)', color: 'var(--accent)', icon: info, action: '切回規則', go: () => setSplitMode('rule') };
  else if (state.splitMode === 'direct') n = { text: '直連模式：所有流量不經代理，規則暫時停用。', bg: 'var(--fill2)', color: 'var(--text3)', icon: info, action: '切回規則', go: () => setSplitMode('rule') };
  else if (!state.splitElevated && !running) n = { text: '首次啟動需要系統管理員權限，用於建立虛擬網卡並注入路由表。整個過程只需同意一次。', bg: 'var(--accent-dim)', color: 'var(--accent)', icon: shield, action: '了解權限用途', go: () => { state.splitUac = true; renderSplitUac(); } };
  else if (missing.length) n = { text: `有 ${missing.length} 條規則引用尚未下載的規則庫，這些規則目前不會生效。`, bg: 'rgba(217,139,31,.12)', color: 'var(--amber)', icon: warn, action: '全部下載', go: () => installRuleSets([...new Set(missing.flatMap(missingTags))]) };
  else if (!running && state.splitRules.length) n = { text: '規則要在分流引擎執行時才會生效。', bg: 'var(--fill2)', color: 'var(--text3)', icon: info, action: '啟動引擎', go: () => toggleSplitEngine() };

  if (!n) { el.innerHTML = ''; return; }
  el.innerHTML = `<div style="display:flex;align-items:center;gap:9px;padding:10px 13px;background:${n.bg};border-radius:11px;font-size:11.5px;color:var(--text2);line-height:1.6;flex-shrink:0;animation:fadeUp .2s ease-out">
    <span style="flex-shrink:0;color:${n.color};display:flex"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${n.icon}"></path></svg></span>
    <span style="flex:1;text-wrap:pretty">${esc(n.text)}</span>
    ${n.action ? `<button id="spNoticeGo" class="hvAccDim" style="flex-shrink:0;height:26px;padding:0 11px;border:1px solid var(--sep);border-radius:8px;background:var(--card);color:var(--accent);font-size:11.5px;font-weight:500;cursor:pointer;white-space:nowrap">${esc(n.action)}</button>` : ''}
  </div>`;
  if ($('spNoticeGo')) $('spNoticeGo').onclick = n.go;
}

function renderSplitFilter() {
  const el = $('spFilterSeg'); if (!el) return;
  el.innerHTML = ['全部', '程式', '目的地', '走代理', '直連', '封鎖'].map(f =>
    `<button data-sfilter="${esc(f)}" style="border:none;cursor:pointer;height:26px;padding:0 10px;border-radius:6px;font-size:12px;white-space:nowrap;${segCss(state.splitFilter === f)}">${f}</button>`).join('');
  el.querySelectorAll('[data-sfilter]').forEach(b => b.onclick = () => { state.splitFilter = b.dataset.sfilter; renderSplitFilter(); renderSplitRules(); });
}

function splitVisibleRules() {
  const q = (state.splitSearch || '').toLowerCase();
  return state.splitRules.filter(r => {
    if (q && !((r.name || '') + JSON.stringify(rWhen(r))).toLowerCase().includes(q)) return false;
    const f = state.splitFilter, w = rWhen(r);
    return f === '全部' || (f === '程式' ? !!w.app : f === '目的地' ? !!w.dest
      : f === '走代理' ? r.target !== 'direct' && r.target !== 'block'
      : f === '直連' ? r.target === 'direct' : r.target === 'block');
  });
}

function renderSplitRules() {
  const el = $('spRulesTable'); if (!el) return;
  if (!state.splitRules.length) { el.innerHTML = ''; return; }
  const active = splitActive();
  const visible = splitVisibleRules();

  const header = `<div style="display:flex;align-items:center;padding:9px 16px;border-bottom:1px solid var(--sep);font-size:11px;color:var(--text3);font-weight:600;letter-spacing:.3px">
    <span style="width:26px;flex-shrink:0"></span><span style="width:26px;flex-shrink:0">#</span>
    <span style="flex:1.3;min-width:0;white-space:nowrap">規則 · 條件</span>
    <span style="flex:1;min-width:0;white-space:nowrap">流量走向</span>
    <span style="width:104px;flex-shrink:0"></span>
  </div>`;

  const lanOn = state.splitLanDirect;
  const builtin = `<div style="display:flex;align-items:center;padding:10px 16px;border-bottom:1px solid var(--sep);font-size:12.5px;background:${lanOn ? 'transparent' : 'var(--fill2)'};color:${lanOn ? 'var(--text)' : 'var(--text3)'}">
    <span title="內建規則：固定在最前面，可停用、不可刪除" style="width:26px;flex-shrink:0;display:flex;align-items:center;color:var(--text3)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="5" y="11" width="14" height="9" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg></span>
    <span style="width:26px;flex-shrink:0;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:11.5px;color:var(--text3)">0</span>
    <span style="flex:1.3;min-width:0;padding-right:12px;box-sizing:border-box;display:flex;flex-direction:column;gap:3px">
      <span style="display:flex;align-items:center;gap:7px;min-width:0"><span style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">本機與內網</span><span style="font-size:9.5px;font-weight:700;letter-spacing:.3px;padding:2px 6px;border-radius:5px;background:var(--fill2);color:var(--text2);flex-shrink:0">內建</span></span>
      <span title="${esc(LAN_CIDRS)}" style="font-size:10.5px;color:var(--text3);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">目的地 loopback · 私有網段 · link-local · mDNS（離線清單，無需下載）</span>
    </span>
    <span style="flex:1;min-width:0;padding-right:10px;box-sizing:border-box;display:flex;align-items:center;gap:7px"><span style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:var(--text2)"></span><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">直接連線（不經代理）</span></span>
    
    <span style="width:104px;flex-shrink:0;display:flex;justify-content:flex-end;align-items:center;gap:6px">
      <button data-lan="1" title="${lanOn ? '停用內建保護（不建議：印表機、NAS、路由器管理頁會被送進代理）' : '啟用內建保護'}" style="width:40px;height:24px;border-radius:12px;border:none;padding:0;cursor:pointer;position:relative;background:${lanOn ? 'var(--accent)' : 'var(--fill)'};transition:background .22s"><span style="position:absolute;top:3px;left:${lanOn ? '19px' : '3px'};width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .22s cubic-bezier(.32,.72,0,1)"></span></button>
      <span style="width:58px"></span>
    </span>
  </div>`;

  const rowsHtml = visible.map(r => {
    const idx = state.splitRules.indexOf(r) + 1;
    const pend = state.splitPendingDel === r.id, on = r.on !== false, isBlock = r.target === 'block';
    const miss = missingTags(r);
    const conds = condSummary(rWhen(r));
    const name = r.name || conds.map(c => c.v).join(' · ') || '未命名規則';
    const targetLabel = isBlock ? '封鎖' : splitTargetLabel(r.target);
    const targetColor = !on ? 'var(--text3)' : isBlock ? 'var(--red)' : 'var(--text)';
    const dot = splitTargetDot(r.target, on);
    const dotAnim = on && active && !isBlock && r.target !== 'direct' ? 'dotBeat 2.2s ease-in-out infinite' : 'none';
    const rowBg = state.splitHitId === r.id ? 'var(--accent-dim)' : on ? 'transparent' : 'var(--fill2)';
    return `<div data-srid="${esc(r.id)}" draggable="true" class="hvFill2" style="display:flex;align-items:center;padding:10px 16px;border-bottom:1px solid var(--sep);font-size:12.5px;background:${rowBg};box-shadow:${miss.length ? 'inset 3px 0 0 var(--amber)' : 'none'};cursor:grab;color:${on ? 'var(--text)' : 'var(--text3)'};transition:background .3s">
      <span style="width:26px;flex-shrink:0;display:flex;align-items:center;color:var(--text3)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 7h.01M8 12h.01M8 17h.01M16 7h.01M16 12h.01M16 17h.01"></path></svg></span>
      <span style="width:26px;flex-shrink:0;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:11.5px;color:var(--text3)">${idx}</span>
      <span style="flex:1.3;min-width:0;padding-right:12px;box-sizing:border-box;display:flex;flex-direction:column;gap:4px">
        <span style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(name)}</span>
        <span style="display:flex;gap:5px;flex-wrap:wrap;min-width:0">${conds.map(c => {
          const st = condChipStyle(c.k);
          return `<span title="${esc(c.full)}" style="display:inline-flex;align-items:center;gap:4px;max-width:100%;height:18px;padding:0 6px;border-radius:5px;background:${st.bg};color:${st.color};font-size:10.5px;white-space:nowrap;overflow:hidden"><span style="font-weight:700;letter-spacing:.2px;flex-shrink:0">${esc(c.k)}</span><span style="overflow:hidden;text-overflow:ellipsis">${esc(c.v)}</span></span>`;
        }).join('')}</span>
      </span>
      <span style="flex:1;min-width:0;padding-right:10px;box-sizing:border-box;display:flex;align-items:center;gap:7px">
        <span style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${dot};animation:${dotAnim}"></span>
        <span title="${esc(targetLabel)}" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${targetColor}">${esc(targetLabel)}</span>
        ${miss.length ? `<button data-sact="dl" class="hvBright" style="flex-shrink:0;height:22px;padding:0 9px;border:none;border-radius:6px;background:var(--amber);color:#fff;font-size:10.5px;font-weight:600;cursor:pointer;white-space:nowrap">下載規則庫</button>` : ''}
      </span>
      <span style="width:104px;flex-shrink:0;display:flex;justify-content:flex-end;align-items:center;gap:6px">
        <button data-sact="toggle" title="${on ? '停用規則：' : '啟用規則：'}${esc(name)}" style="width:40px;height:24px;border-radius:12px;border:none;padding:0;cursor:pointer;position:relative;background:${on ? 'var(--accent)' : 'var(--fill)'};transition:background .22s;flex-shrink:0"><span style="position:absolute;top:3px;left:${on ? '19px' : '3px'};width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .22s cubic-bezier(.32,.72,0,1)"></span></button>
        <button data-sact="edit" class="hvAcc" title="編輯規則" style="width:26px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h4L20 8l-4-4L4 16v4z"></path></svg></button>
        <button data-sact="del" class="hvRed" title="${pend ? '再按一次確認刪除' : '刪除規則'}" style="width:26px;height:26px;border:none;border-radius:7px;background:${pend ? 'var(--red)' : 'var(--fill2)'};color:${pend ? '#fff' : 'var(--red)'};cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0">${pend
          ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"></path></svg>'
          : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"></path></svg>'}</button>
      </span>
    </div>`;
  }).join('');

  const noVisible = visible.length === 0
    ? `<div style="padding:26px 20px;text-align:center;color:var(--text3);font-size:12.5px;border-bottom:1px solid var(--sep)">沒有符合篩選條件的規則</div>` : '';

  const defaultRow = `<div style="display:flex;align-items:center;padding:10px 16px;font-size:12.5px;background:var(--fill2)">
    <span style="width:26px;flex-shrink:0"></span><span style="width:26px;flex-shrink:0;color:var(--text3);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:11.5px">∞</span>
    <span style="flex:1.3;min-width:0;padding-right:12px;box-sizing:border-box;display:flex;align-items:center;gap:7px;color:var(--text2)">
      <span style="font-weight:600;white-space:nowrap">其他所有流量</span>
      <span style="font-size:9.5px;font-weight:700;letter-spacing:.3px;padding:2px 6px;border-radius:5px;background:var(--fill);color:var(--text2);white-space:nowrap">預設</span>
    </span>
    <span style="flex:1;min-width:0;padding-right:10px;box-sizing:border-box;display:flex;align-items:center;gap:7px;color:var(--text2)">
      <span style="width:7px;height:7px;border-radius:50%;background:${splitTargetDot(state.splitDefaultTarget)};flex-shrink:0"></span>
      <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(splitTargetLabel(state.splitDefaultTarget))}</span>
    </span>
    <span style="width:104px;flex-shrink:0;display:flex;justify-content:flex-end"><button id="spDefaultChange" class="hvAccDim" style="height:26px;padding:0 11px;border:1px solid var(--sep);border-radius:8px;background:var(--card);color:var(--accent);font-size:11.5px;font-weight:500;cursor:pointer;white-space:nowrap">變更</button></span>
  </div>`;

  el.innerHTML = header + builtin + rowsHtml + noVisible + defaultRow;

  const lanBtn = el.querySelector('[data-lan]');
  if (lanBtn) lanBtn.onclick = () => toggleLanDirect();
  el.querySelectorAll('[data-srid]').forEach(row => {
    const rid = row.dataset.srid;
    row.addEventListener('dragstart', () => { state.splitDrag = rid; });
    row.addEventListener('dragover', e => e.preventDefault());
    row.addEventListener('drop', e => {
      e.preventDefault();
      const from = state.splitRules.findIndex(x => x.id === state.splitDrag);
      const to = state.splitRules.findIndex(x => x.id === rid);
      state.splitDrag = null;
      if (from < 0 || from === to) return;
      const arr = [...state.splitRules];
      arr.splice(to, 0, arr.splice(from, 1)[0]);
      state.splitRules = arr;
      renderSplitRules(); persistSplit({ rules: state.splitRules });
    });
    row.querySelector('[data-sact="toggle"]').onclick = e => { e.stopPropagation(); state.splitRules = state.splitRules.map(x => x.id === rid ? { ...x, on: x.on === false } : x); updateSplit(); persistSplit({ rules: state.splitRules }); };
    row.querySelector('[data-sact="edit"]').onclick = e => { e.stopPropagation(); openSplitSheet(rid); };
    row.querySelector('[data-sact="del"]').onclick = e => { e.stopPropagation(); splitDeleteRule(rid); };
    const dl = row.querySelector('[data-sact="dl"]');
    if (dl) dl.onclick = e => { e.stopPropagation(); installRuleSets(missingTags(state.splitRules.find(x => x.id === rid))); };
  });
  if ($('spDefaultChange')) $('spDefaultChange').onclick = e => { e.stopPropagation(); openMenu('split-default', $('spDefaultChange')); };
}

async function toggleLanDirect() {
  state.splitLanDirect = !state.splitLanDirect;
  updateSplit();
  await persistSplit({ lanDirect: state.splitLanDirect });
  flash(state.splitLanDirect ? '已啟用本機與內網保護' : '已停用本機與內網保護——內網流量將依下方規則處理',
    state.splitLanDirect ? undefined : 'var(--amber)');
}

function renderSplitEmpty() {
  const el = $('spEmpty'); if (!el) return;
  if (state.splitRules.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div style="background:var(--card);border:1px solid var(--sep);border-radius:16px;padding:34px 24px 24px;display:flex;flex-direction:column;align-items:center;gap:18px;flex-shrink:0">
    <div style="width:56px;height:56px;border-radius:16px;background:var(--accent-dim);color:var(--accent);display:flex;align-items:center;justify-content:center"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 6h16M4 12h10M4 18h6"></path></svg></div>
    <div style="display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center">
      <span style="font-size:16px;font-weight:700;letter-spacing:-.2px">還沒有規則</span>
      <span style="font-size:12.5px;color:var(--text2);line-height:1.6;text-wrap:pretty;max-width:440px">一條規則＝「誰／連去哪／哪個埠」的組合 → 走哪條路。內建的「本機與內網直連」已在保護你。</span>
    </div>
    <div style="display:flex;gap:9px">
      <button id="spEmptyAdd" class="hvBright" style="height:34px;padding:0 16px;border:none;border-radius:9px;background:var(--accent);color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap">新增規則</button>
      <button id="spEmptyBrowser" class="${state.browser ? 'hvFill2' : ''}" ${state.browser ? '' : 'disabled'} title="${state.browser ? '不用規則、不用引擎：用路由開一個只有它走代理的瀏覽器' : '找不到 Chrome 或 Edge，裝了其中一個才能用'}" style="display:flex;align-items:center;gap:6px;height:34px;padding:0 16px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path></svg>用這條路由開瀏覽器</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;width:100%;padding-top:4px">
      ${splitTemplates().map((t, i) => `<button data-stpl="${i}" class="hvFill2" style="display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:14px 15px;border:1px solid var(--sep);border-radius:13px;background:var(--bg);color:var(--text);cursor:pointer;text-align:left;min-width:0">
        <span style="display:flex;color:${t.color}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${t.icon}"></path></svg></span>
        <span style="font-size:13px;font-weight:600;line-height:1.4;text-wrap:pretty">${esc(t.title)}</span>
        <span style="font-size:11px;color:var(--text2);line-height:1.6;text-wrap:pretty">${esc(t.desc)}</span>
      </button>`).join('')}
    </div>
  </div>`;
  el.querySelectorAll('[data-stpl]').forEach(b => b.onclick = () => applyTemplate(+b.dataset.stpl));
  $('spEmptyAdd').onclick = () => openSplitSheet();
  $('spEmptyBrowser').onclick = () => openLaunchSheet();

}

// ---- 規則模擬器 ----
async function runSplitSim() {
  const raw = (state.splitSimHost || '').trim();
  if (!raw) return;
  const clean = raw.toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  const [host, portStr] = clean.split(':');
  const port = portStr && /^\d+$/.test(portStr) ? Number(portStr) : 0;
  try {
    const res = await window.api.ruleMatch({ host, exe: state.splitSimExe || '', port, network: 'tcp' });
    state.splitSim = { host: raw, res };
    state.splitHitId = res && res.ruleId ? res.ruleId : null;
    renderSplitSim(); renderSplitRules();
    clearTimeout(state._splitHitT);
    state._splitHitT = setTimeout(() => { state.splitHitId = null; renderSplitRules(); }, 2000);
  } catch { flash('測試失敗', 'var(--red)'); }
}

function renderSplitSim() {
  const el = $('spSimResult'); if (!el) return;
  const sim = state.splitSim;
  if (!sim) { el.innerHTML = ''; return; }
  const r = sim.res || {};

  // 內建「本機與內網」沒有對應的使用者規則列，單獨一段
  if (r.builtin) {
    el.innerHTML = simResultHtml({
      host: sim.host, bg: 'var(--fill2)', color: 'var(--text2)', icon: 'M5 13l4 4L19 7',
      title: '命中內建規則「本機與內網」', sub: '走向：直接連線', note: '',
    });
    return;
  }

  // 全域／直連模式下規則表整個不比對，結果只會誤導人
  if (state.splitMode !== 'rule') {
    const glob = state.splitMode === 'global';
    el.innerHTML = simResultHtml({
      host: sim.host, bg: glob ? 'var(--accent-dim)' : 'var(--fill2)', color: glob ? 'var(--accent)' : 'var(--text3)',
      icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8h.01M11 12h1v5h1',
      title: glob ? '全域模式，不比對規則' : '直連模式，不比對規則',
      sub: '走向：' + (glob ? (state.splitGlobalTarget ? splitTargetLabel(state.splitGlobalTarget) : '尚未選擇路由') : '直接連線'),
      note: '',
    });
    return;
  }

  const hit = r.matched;
  const rule = hit ? state.splitRules.find(x => x.id === r.ruleId) : null;
  const idx = rule ? state.splitRules.indexOf(rule) + 1 : 0;
  const isBlock = r.target === 'block';
  const miss = rule ? missingTags(rule) : [];
  const bg = isBlock ? 'rgba(217,83,74,.10)' : hit ? 'var(--accent-dim)' : 'var(--fill2)';
  const color = isBlock ? 'var(--red)' : hit ? 'var(--accent)' : 'var(--text3)';
  const icon = isBlock ? 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.5 5.5l13 13'
    : hit ? 'M5 13l4 4L19 7' : 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8h.01M11 12h1v5h1';
  const title = hit ? `命中第 ${idx} 條「${rule ? (rule.name || condSummary(rWhen(rule)).map(c => c.v).join(' · ')) : r.ruleName}」` : '未命中任何規則 → 依預設走向';
  const sub = `走向：${r.targetLabel || splitTargetLabel(r.target)}` + (isBlock ? '，這個連線會被丟棄' : '');
  el.innerHTML = simResultHtml({
    host: sim.host, bg, color, icon, title, sub,
    note: miss.length ? '此規則目前不會生效（規則庫未下載）' : '',
  });
}

function simResultHtml({ host, bg, color, icon, title, sub, note }) {
  return `<div style="display:flex;align-items:flex-start;gap:10px;padding:11px 13px;background:${bg};border-radius:11px;font-size:12px;line-height:1.65;animation:fadeUp .2s ease-out">
    <span style="flex-shrink:0;margin-top:1px;color:${color};display:flex"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${icon}"></path></svg></span>
    <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
      <span style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap">
        <span style="font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-weight:600;white-space:nowrap">${esc(host)}</span>
        <span style="color:var(--text3)">→</span>
        <span style="text-wrap:pretty">${esc(title)}</span>
      </span>
      <span style="color:var(--text2);text-wrap:pretty">${esc(sub)}</span>
      ${note ? `<span style="color:var(--amber);text-wrap:pretty">${esc(note)}</span>` : ''}
    </div>
  </div>`;
}

function splitDeleteRule(rid) {
  if (state.splitPendingDel !== rid) {
    state.splitPendingDel = rid; renderSplitRules();
    setTimeout(() => { if (state.splitPendingDel === rid) { state.splitPendingDel = null; renderSplitRules(); } }, 2500);
    return;
  }
  state.splitPendingDel = null;
  state.splitRules = state.splitRules.filter(x => x.id !== rid);
  updateSplit(); persistSplit({ rules: state.splitRules });
}

// ---- 規則庫下載 ----
async function installRuleSets(tags) {
  const list = (tags || []).filter(Boolean);
  if (!list.length) return;
  flash(`下載中… ${list.map(catLabel).join('、')}`);
  let ok = 0;
  for (const t of list) {
    try { const r = await window.api.rulesetInstall(t); if (r && r.ok) ok++; else flash(`下載失敗：${catLabel(t)}${r && r.error ? ' — ' + r.error : ''}`, 'var(--red)'); }
    catch { flash(`下載失敗：${catLabel(t)}`, 'var(--red)'); }
  }
  try { const l = await window.api.rulesetList(); if (Array.isArray(l)) state.splitInstalled = l; } catch {}
  updateSplit();
  if (ok) flash(`已下載 ${ok} 個規則庫`);
}

// ---- 引擎啟停 ----
async function toggleSplitEngine() {
  if (splitRunning() || state.splitEngine === 'starting') {
    await window.api.engineStop();
    state.splitEngine = 'off'; state.splitTun = null;
    updateSplit(); syncTitlebar();
    flash('引擎已停止，系統路由表已還原');
    return;
  }
  await attemptSplitEngineStart();
}

async function attemptSplitEngineStart() {
  state.splitEngine = 'starting'; updateSplit(); syncTitlebar();
  let r;
  try { r = await window.api.engineStart(); } catch (e) { r = { ok: false, error: e.message }; }
  if (r && r.ok) { state.splitEngine = 'running'; await refreshEngineStatus(); updateSplit(); syncTitlebar(); flash('分流引擎已啟動'); return; }
  state.splitEngine = 'off'; updateSplit(); syncTitlebar();
  if (r && r.needElevation) { state.splitUac = true; renderSplitUac(); return; }
  flash('引擎啟動失敗：' + ((r && (r.error || r.message)) || '未知錯誤'), 'var(--red)');
}

async function grantSplitUac() {
  closeSplitUac();
  state.splitEngine = 'starting'; updateSplit(); syncTitlebar();
  let r;
  try { r = await window.api.engineElevate(); } catch (e) { r = { ok: false, error: e.message }; }
  if (!(r && r.ok)) {
    state.splitEngine = 'off'; updateSplit(); syncTitlebar();
    flash((r && r.error) || '提權失敗', 'var(--red)');
  }
}

// ---- 持久化（saveSplit）----
async function persistSplit(patch) {
  try {
    const merged = await window.api.saveSplit(patch);
    if (merged) {
      if (Array.isArray(merged.rules)) state.splitRules = merged.rules;
      if (merged.defaultTarget != null) state.splitDefaultTarget = merged.defaultTarget;
      if (typeof merged.udp === 'boolean') state.splitUdp = merged.udp;
      if (merged.mode) state.splitMode = merged.mode;
      if ('globalTarget' in merged) state.splitGlobalTarget = merged.globalTarget;
      if (typeof merged.lanDirect === 'boolean') state.splitLanDirect = merged.lanDirect;
      if (state.tab === 'split') updateSplit();
    }
  } catch {}
}

// ---- 下拉選單（接 openMenu）----
function splitTargetOptions(cur, pick, includeBlock = true, includeDirect = true) {
  const opts = [
    ...(includeDirect ? [{ id: 'direct' }] : []),
    ...state.routes.map(r => ({ id: r.id })),
    ...(includeBlock ? [{ id: 'block' }] : []),
  ];
  return opts.map(o => ({
    label: splitTargetLabel(o.id), badge: splitTargetBadge(o.id),
    dot: o.id === 'block' ? 'var(--red)' : splitTargetDot(o.id),
    check: cur === o.id, pick: () => pick(o.id),
  }));
}

function splitMenuItems(kind) {
  if (kind === 'split-default') {
    return splitTargetOptions(state.splitDefaultTarget, id => {
      state.splitDefaultTarget = id; closeMenu(); updateSplit();
      persistSplit({ defaultTarget: id }); flash('已更新規則外流量走向');
    }, false);
  }
  if (kind === 'split-global') {
    return splitTargetOptions(state.splitGlobalTarget, id => {
      state.splitGlobalTarget = id; closeMenu(); updateSplit();
      persistSplit({ globalTarget: id }); flash(`全域模式：所有流量走「${splitTargetLabel(id)}」`);
    }, false, false);
  }
  if (kind === 'split-target') {
    return splitTargetOptions(state.splitDraft.target, id => {
      state.splitDraft = { ...state.splitDraft, target: id }; closeMenu(); renderSplitSheet();
    });
  }
  if (kind === 'split-simexe') {
    return [{ id: '', label: '不限程式' }, ...state.splitProcs.slice(0, 40).map(p => ({ id: p.exe, label: p.exe }))]
      .map(o => ({ label: o.label, dot: 'var(--text3)', check: state.splitSimExe === o.id,
        pick: () => { state.splitSimExe = o.id; closeMenu(); updateSplit(); } }));
  }
  if (kind === 'split-proc') {
    return state.splitProcs.slice(0, 60).map(p => ({ label: p.exe, badge: '', dot: 'var(--purple)', check: false,
      pick: () => { setDraftWhen({ app: { match: 'name', value: p.exe } }); closeMenu(); renderSplitSheet(); } }));
  }
  if (kind === 'split-rs') {
    const d = state.splitDraft.when.dest || { match: 'ruleset', value: '' };
    const tags = splitVals(d.value);
    const inst = state.splitCatalog.filter(c => isInstalled(c.tag));
    const rest = state.splitCatalog.filter(c => !isInstalled(c.tag));
    const mk = (c, installed) => ({
      label: c.label, badge: installed ? '' : '未下載', dot: 'var(--accent)', check: tags.includes(c.tag),
      pick: () => {
        const next = tags.includes(c.tag) ? tags.filter(t => t !== c.tag) : [...tags, c.tag];
        setDraftWhen({ dest: { match: 'ruleset', value: next.join('\n') } });
        renderSplitSheet();
      },
    });
    // 設計稿把目錄分成「已下載」與「目錄中」兩組，21 項一長串根本找不到東西
    return [
      ...(inst.length ? [{ header: '已下載' }, ...inst.map(c => mk(c, true))] : []),
      ...(rest.length ? [{ header: '目錄中' }, ...rest.map(c => mk(c, false))] : []),
    ];
  }
  return [];
}

// ---- 規則編輯面板（右側滑入 480px）----
function setDraftWhen(patch) {
  const d = state.splitDraft;
  state.splitDraft = { ...d, when: { ...d.when, ...patch }, error: '' };
}
function openSplitSheet(id) {
  const r = id ? state.splitRules.find(x => x.id === id) : null;
  state.splitSheet = true; state.splitEditing = id || null; closeMenu();
  const w = r ? JSON.parse(JSON.stringify(rWhen(r))) : {};
  state.splitDraft = { name: r ? (r.name || '') : '', when: w, target: r ? r.target : (state.routes[0] ? state.routes[0].id : 'direct'), error: '' };
  state.splitOpenConds = { app: !!w.app, dest: !!w.dest || !r, port: !!w.port, net: !!w.network };
  renderSplitSheet();
  loadSplitProcs();
}
function closeSplitSheet() { state.splitSheet = false; closeMenu(); $('splitSheetMount').innerHTML = ''; }
async function loadSplitProcs() {
  try { const list = await window.api.listProcesses(); if (Array.isArray(list)) state.splitProcs = list; } catch {}
}

function splitDraftJson() {
  const d = state.splitDraft, w = d.when;
  const nameAuto = condSummary(w).map(c => c.v).join(' · ');
  const when = Object.fromEntries(Object.entries(w).filter(([, v]) => v && (typeof v !== 'object' || v.value)));
  return JSON.stringify({ id: state.splitEditing || 'r-new', name: d.name || nameAuto || '未命名', when, target: d.target, enabled: true });
}

function renderSplitSheet() {
  if (!state.splitSheet) { $('splitSheetMount').innerHTML = ''; return; }
  const d = state.splitDraft, w = d.when;
  const scrollTop = $('spSheetBody') ? $('spSheetBody').scrollTop : 0;
  const dest = w.dest || { match: 'suffix', value: '' };
  const dTags = dest.match === 'ruleset' ? splitVals(dest.value) : [];
  const nameAuto = condSummary(w).map(c => c.v).join(' · ');
  const appMatch = (w.app || { match: 'name' }).match;

  const condDefs = [
    { k: 'app', label: '程式', color: 'var(--purple)', has: !!(w.app && w.app.value),
      icon: 'M4 5h16v11H4zM8 20h8M12 16v4', summary: w.app && w.app.value ? (appMatch === 'path' ? '路徑 ' : '') + w.app.value : '不限' },
    { k: 'dest', label: '目的地', color: 'var(--accent)', has: !!(w.dest && w.dest.value),
      icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18',
      summary: w.dest && w.dest.value ? (condSummary({ dest: w.dest })[0] || {}).full || '不限' : '不限' },
    { k: 'port', label: '埠', color: 'var(--text2)', has: !!w.port, icon: 'M4 12h16M4 6h16M4 18h16', summary: w.port || '不限' },
    { k: 'net', label: '協定', color: 'var(--text2)', has: !!w.network, icon: 'M5 12l4-8 6 16 4-8', summary: w.network ? String(w.network).toUpperCase() : 'TCP + UDP' },
  ];

  const seg = (items, cur, attr) => items.map(([k, label]) =>
    `<button data-${attr}="${k}" style="flex:1;border:none;cursor:pointer;height:26px;border-radius:6px;font-size:12px;white-space:nowrap;${segCss(cur === k)}">${label}</button>`).join('');

  const condHtml = condDefs.map(c => {
    const open = !!state.splitOpenConds[c.k];
    let body = '';
    if (c.k === 'app') {
      body = `<div style="display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:8px">${seg([['name', '程式名稱'], ['path', '完整路徑']], appMatch, 'sappmode')}</div>
        <div style="display:flex;gap:8px">
          <input id="spAppValue" value="${esc((w.app || {}).value || '')}" placeholder="${appMatch === 'path' ? 'C:\\Program Files\\...\\app.exe' : 'chrome.exe'}" style="flex:1;min-width:0;height:32px;padding:0 10px;border:1px solid var(--sep);border-radius:8px;background:var(--panel);color:var(--text);font-size:12px;outline:none;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace">
          <button id="spPickProc" class="hvFill2" style="flex-shrink:0;height:32px;padding:0 11px;border:1px solid var(--sep);border-radius:8px;background:var(--panel);color:var(--text);font-size:12px;cursor:pointer;white-space:nowrap">從執行中挑選</button>
          <button id="spBrowseExe" class="hvFill2" style="flex-shrink:0;height:32px;padding:0 11px;border:1px solid var(--sep);border-radius:8px;background:var(--panel);color:var(--text);font-size:12px;cursor:pointer;white-space:nowrap">瀏覽…</button>
        </div>`;
    } else if (c.k === 'dest') {
      const isRs = dest.match === 'ruleset';
      const ui = DEST_UI[dest.match] || DEST_UI.suffix;
      body = `<div style="display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:8px">${seg(DEST_KINDS, dest.match, 'sdestkind')}</div>`;
      if (!isRs) {
        body += `<textarea id="spDestValue" rows="3" placeholder="${esc(ui.ph)}" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--sep);border-radius:8px;background:var(--panel);color:var(--text);font-size:12px;outline:none;resize:vertical;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;line-height:1.6">${esc(dest.value || '')}</textarea>
          <span style="font-size:11px;color:var(--text3);line-height:1.5">${esc(ui.hint)}</span>`;
      } else {
        body += `<button id="spRsPick" class="hvFill2" style="display:flex;align-items:center;gap:9px;height:34px;padding:0 11px;border:1px solid var(--sep);border-radius:9px;background:var(--panel);color:${dTags.length ? 'var(--text)' : 'var(--text3)'};font-size:12.5px;cursor:pointer;text-align:left"><span style="flex:1">${dTags.length ? `已選 ${dTags.length} 個` : '選擇地區或分類…'}</span><span style="color:var(--text3);font-size:9px">▾</span></button>
          ${dTags.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${dTags.map(t => {
            const ok = isInstalled(t);
            return `<span style="display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 6px 0 9px;border-radius:13px;background:${ok ? 'var(--accent-dim)' : 'rgba(217,139,31,.14)'};color:${ok ? 'var(--accent)' : 'var(--amber)'};font-size:11.5px;font-weight:500;white-space:nowrap">${esc(catLabel(t))}<span style="font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:10px;opacity:.7">${esc(t)}</span><button data-schip="${esc(t)}" title="移除" style="width:16px;height:16px;border:none;border-radius:50%;background:rgba(0,0,0,.12);color:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0"><svg width="8" height="8" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.8"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5"></line><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"></line></svg></button></span>`;
          }).join('')}</div>` : ''}
          <span style="font-size:11px;color:var(--text3);line-height:1.5;text-wrap:pretty">依「目的地在哪個國家」或「屬於哪類網站」（如 Netflix、廣告）比對，選了才下載對應清單，可複選。</span>`;
      }
    } else if (c.k === 'port') {
      body = `<input id="spPortValue" value="${esc(w.port || '')}" placeholder="443, 80, 3000-3999" style="height:32px;padding:0 10px;border:1px solid var(--sep);border-radius:8px;background:var(--panel);color:var(--text);font-size:12px;outline:none;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace">
        <span style="font-size:11px;color:var(--text3);line-height:1.5">目的地埠，逗號分隔，可寫範圍。</span>`;
    } else {
      body = `<div style="display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:8px">${seg([['', 'TCP + UDP'], ['tcp', '僅 TCP'], ['udp', '僅 UDP']], w.network || '', 'snetmode')}</div>`;
    }
    return `<div style="border:1px solid ${c.has ? 'var(--accent)' : 'var(--sep)'};border-radius:12px;background:${c.has ? 'var(--accent-dim)' : 'var(--bg)'};overflow:hidden;flex-shrink:0">
      <button data-scond="${c.k}" class="hvFill2" style="width:100%;display:flex;align-items:center;gap:10px;height:42px;padding:0 14px;border:none;background:transparent;color:var(--text);cursor:pointer;text-align:left">
        <span style="display:flex;color:${c.has ? c.color : 'var(--text3)'}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${c.icon}"></path></svg></span>
        <span style="font-size:13px;font-weight:600;white-space:nowrap">${c.label}</span>
        <span style="flex:1;min-width:0;font-size:11.5px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace">${esc(c.summary)}</span>
        <span style="color:var(--text3);font-size:10px;transform:rotate(${open ? '90deg' : '0deg'});transition:transform .2s;display:flex"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 6l6 6-6 6"></path></svg></span>
      </button>
      ${open ? `<div style="padding:2px 14px 14px;display:flex;flex-direction:column;gap:9px;animation:fadeUp .18s ease-out">${body}</div>` : ''}
    </div>`;
  }).join('');

  $('splitSheetMount').innerHTML = `
    <div id="spSheetOverlay" style="position:absolute;inset:0;background:rgba(0,0,0,.28);display:flex;justify-content:flex-end;z-index:60">
      <div id="spSheetPanel" style="width:480px;height:100%;background:var(--panel);border-left:1px solid var(--sep);box-shadow:-12px 0 40px rgba(0,0,0,.18);display:flex;flex-direction:column;animation:sheetIn .26s cubic-bezier(.32,.72,0,1)">
        <div style="padding:16px 20px;border-bottom:1px solid var(--sep);display:flex;align-items:center">
          <span style="font-size:15px;font-weight:700;letter-spacing:-.2px;white-space:nowrap">${state.splitEditing ? '編輯規則' : '新增規則'}</span>
          <button id="spSheetClose" class="hvFill" title="關閉面板" style="margin-left:auto;width:26px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="11" height="11" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.6"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5"></line><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"></line></svg></button>
        </div>
        <div id="spSheetBody" style="flex:1;min-height:0;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:14px">
          <span style="font-size:11.5px;color:var(--text2);line-height:1.55;text-wrap:pretty;flex-shrink:0">條件全部要同時成立才算命中；沒展開的條件＝不限。至少填一項。</span>
          ${condHtml}
          ${d.error ? `<span style="font-size:11px;color:var(--red);line-height:1.5;flex-shrink:0">${esc(d.error)}</span>` : ''}
          <div style="display:flex;flex-direction:column;gap:8px;flex-shrink:0">
            <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">流量走向</span>
            <button id="spTargetBtn" class="hvFill2" style="display:flex;align-items:center;gap:9px;height:36px;padding:0 11px;border:1px solid var(--sep);border-radius:10px;background:var(--bg);color:${d.target === 'block' ? 'var(--red)' : 'var(--text)'};font-size:12.5px;cursor:pointer;text-align:left">
              <span style="width:7px;height:7px;border-radius:50%;background:${d.target === 'block' ? 'var(--red)' : splitTargetDot(d.target)};flex-shrink:0"></span>
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(splitTargetLabel(d.target))}</span>
              <span style="font-size:9.5px;font-weight:700;letter-spacing:.3px;padding:2px 6px;border-radius:5px;background:${d.target === 'block' ? 'rgba(217,83,74,.14)' : 'var(--fill2)'};color:${d.target === 'block' ? 'var(--red)' : 'var(--text2)'};flex-shrink:0;white-space:nowrap">${splitTargetBadge(d.target)}</span>
              <span style="color:var(--text3);font-size:9px">▾</span>
            </button>
          </div>
          <div style="display:flex;flex-direction:column;gap:7px;flex-shrink:0">
            <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">顯示名稱</span>
            <input id="spDraftName" value="${esc(d.name)}" placeholder="${nameAuto ? esc('留空自動使用「' + nameAuto + '」') : '例如 Chrome 連公司系統'}" style="height:34px;padding:0 11px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:13px;outline:none">
          </div>
          <div style="background:var(--fill2);border-radius:12px;padding:13px 15px;display:flex;flex-direction:column;gap:7px;flex-shrink:0">
            <span style="font-size:11px;font-weight:600;color:var(--text3);letter-spacing:.3px;white-space:nowrap">對應 config.json</span>
            <span style="font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:11px;color:var(--text2);line-height:1.7;word-break:break-all;user-select:text">${esc(splitDraftJson())}</span>
          </div>
        </div>
        <div style="padding:14px 20px;border-top:1px solid var(--sep);display:flex;align-items:center;gap:10px">
          <span style="font-size:11.5px;color:var(--text3);flex:1;min-width:0">儲存後立即生效，無需重啟引擎</span>
          <button id="spSheetCancel" class="hvFill2" style="height:32px;padding:0 16px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap">取消</button>
          <button id="spSheetSave" class="hvBright" style="height:32px;padding:0 18px;border:none;border-radius:9px;background:var(--accent);color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap">儲存規則</button>
        </div>
      </div>
    </div>`;

  const M = $('splitSheetMount');
  $('spSheetOverlay').onclick = e => { if (e.target === $('spSheetOverlay')) closeSplitSheet(); };
  $('spSheetClose').onclick = () => closeSplitSheet();
  $('spSheetCancel').onclick = () => closeSplitSheet();
  $('spSheetSave').onclick = () => saveSplitRule();
  $('spTargetBtn').onclick = e => { e.stopPropagation(); openMenu('split-target', $('spTargetBtn')); };
  M.querySelectorAll('[data-scond]').forEach(b => b.onclick = () => {
    const k = b.dataset.scond;
    state.splitOpenConds = { ...state.splitOpenConds, [k]: !state.splitOpenConds[k] };
    renderSplitSheet();
  });
  M.querySelectorAll('[data-sappmode]').forEach(b => b.onclick = () => { setDraftWhen({ app: { match: b.dataset.sappmode, value: (w.app || {}).value || '' } }); renderSplitSheet(); });
  M.querySelectorAll('[data-sdestkind]').forEach(b => b.onclick = () => { setDraftWhen({ dest: { match: b.dataset.sdestkind, value: '' } }); renderSplitSheet(); });
  M.querySelectorAll('[data-snetmode]').forEach(b => b.onclick = () => { setDraftWhen({ network: b.dataset.snetmode || undefined }); renderSplitSheet(); });
  M.querySelectorAll('[data-schip]').forEach(b => b.onclick = () => {
    const t = b.dataset.schip;
    setDraftWhen({ dest: { match: 'ruleset', value: dTags.filter(x => x !== t).join('\n') } });
    renderSplitSheet();
  });
  if ($('spAppValue')) $('spAppValue').addEventListener('input', e => { state.splitDraft.when.app = { match: appMatch, value: e.target.value }; });
  if ($('spDestValue')) $('spDestValue').addEventListener('input', e => { state.splitDraft.when.dest = { match: dest.match, value: e.target.value }; });
  if ($('spPortValue')) $('spPortValue').addEventListener('input', e => { state.splitDraft.when.port = e.target.value; });
  if ($('spDraftName')) $('spDraftName').addEventListener('input', e => { state.splitDraft.name = e.target.value; });
  if ($('spPickProc')) $('spPickProc').onclick = e => { e.stopPropagation(); openMenu('split-proc', $('spPickProc')); };
  if ($('spBrowseExe')) $('spBrowseExe').onclick = () => splitBrowseExe();
  if ($('spRsPick')) $('spRsPick').onclick = e => { e.stopPropagation(); openMenu('split-rs', $('spRsPick')); };
  if ($('spSheetBody')) $('spSheetBody').scrollTop = scrollTop;
}

async function splitBrowseExe() {
  try {
    const res = await window.api.browseExe();
    if (res && res.path) {
      setDraftWhen({ app: { match: 'path', value: res.path } });
      if (!state.splitDraft.name) state.splitDraft.name = res.name || '';
      renderSplitSheet();
      flash('已選擇 ' + res.exe);
    }
  } catch {}
}

async function saveSplitRule() {
  const d = state.splitDraft, w = d.when;
  const clean = {};
  if (w.app && String(w.app.value || '').trim()) clean.app = { match: w.app.match === 'path' ? 'path' : 'name', value: String(w.app.value).trim() };
  if (w.dest && splitVals(w.dest.value).length) clean.dest = { match: w.dest.match, value: splitVals(w.dest.value).join('\n') };
  if (w.port && String(w.port).trim()) clean.port = String(w.port).trim();
  if (w.network) clean.network = w.network;

  let error = '';
  if (!Object.keys(clean).length) error = '至少要填一項條件';
  else if (clean.port && !/^\d{1,5}(-\d{1,5})?(\s*,\s*\d{1,5}(-\d{1,5})?)*$/.test(clean.port)) error = '埠格式不正確，例如 443, 80, 3000-3999';
  else if (clean.dest && clean.dest.match === 'ip') {
    const bad = splitVals(clean.dest.value).findIndex(v => !/^(\d{1,3}(\.\d{1,3}){3}|[0-9a-fA-F:]+)(\/\d{1,3})?$/.test(v));
    if (bad >= 0) error = `目的地第 ${bad + 1} 行不是合法的 IP 或網段`;
  }
  if (error) { state.splitDraft = { ...d, error }; renderSplitSheet(); return; }

  const id = state.splitEditing || 'r' + Date.now();
  const prev = state.splitEditing ? state.splitRules.find(r => r.id === id) : null;
  const rec = { id, name: d.name || '', on: prev ? prev.on !== false : true, target: d.target, when: clean };
  state.splitRules = state.splitEditing ? state.splitRules.map(r => r.id === id ? rec : r) : [...state.splitRules, rec];
  closeSplitSheet();
  updateSplit();
  persistSplit({ rules: state.splitRules });
  flash(state.splitEditing ? '規則已更新' : '已新增規則');

  // 規則引用了還沒下載的規則庫 → 立刻問要不要下載
  const miss = missingTags(rec);
  if (miss.length) installRuleSets(miss);
}

// =====================================================================================
// 規則庫（rule-set）管理 — 分流分頁的第二個子分頁。
// 上：已安裝（更新 / 移除 / 檔案遺失重新下載）；下：內建目錄（下載）。另有匯入 .srs / .json。
// =====================================================================================
function fmtAge(ts) {
  if (!ts) return '未知';
  const d = Math.floor((Date.now() - ts) / 86400000);
  return d <= 0 ? '今天更新' : d === 1 ? '昨天更新' : d < 30 ? `${d} 天前更新` : `${Math.floor(d / 30)} 個月前更新`;
}
// 這個規則庫被幾條規則引用（移除時要警告）
const setUsage = tag => state.splitRules.filter(r => {
  const d = rWhen(r).dest;
  return d && d.match === 'ruleset' && splitVals(d.value).includes(tag);
}).length;
const kindIcon = kind => kind === 'geoip'
  ? 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18'
  : 'M4 7h16M4 12h10M4 17h6';

// MERGE §6：受保護程式範圍。主開關開才顯示。
// 'all' = 依規則表（所有走代理的）；'apps' = 只擋選定的幾支程式。
function renderKsScope() {
  const el = $('ksScopeRow'); if (!el) return;
  if (!state.settings.killSwitch) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = 'block';
  const scope = state.settings.killSwitchScope === 'apps' ? 'apps' : 'all';
  const apps = state.settings.killSwitchApps || [];
  const seg = [['all', '所有走代理的程式'], ['apps', '只有以下程式']].map(([k, label]) =>
    `<button data-ksscope="${k}" style="border:none;cursor:pointer;height:26px;padding:0 10px;border-radius:6px;font-size:12px;white-space:nowrap;${segCss(scope === k)}">${label}</button>`).join('');
  const chips = apps.map(a => `<span style="display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 6px 0 9px;border-radius:13px;background:rgba(122,114,207,.14);color:var(--purple);font-size:11.5px;font-weight:500;white-space:nowrap">${esc(a)}<button data-kschip="${esc(a)}" title="移除" style="width:16px;height:16px;border:none;border-radius:50%;background:rgba(0,0,0,.12);color:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0"><svg width="8" height="8" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.8"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5"></line><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"></line></svg></button></span>`).join('');

  el.innerHTML = `
    <div style="padding:13px 16px;display:flex;align-items:center;gap:14px;border-top:1px solid var(--sep)">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:500;white-space:nowrap">受保護程式</div>
        <div style="font-size:11.5px;color:var(--text2);margin-top:2px">${scope === 'all' ? '依規則表，凡是走代理的都會被暫停' : '只暫停選定的程式，其餘照常上網'}</div>
      </div>
      <div style="display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:8px;flex-shrink:0">${seg}</div>
    </div>
    ${scope === 'apps' ? `<div style="padding:0 16px 13px;display:flex;flex-wrap:wrap;gap:6px;align-items:center">
      ${chips || '<span style="font-size:11.5px;color:var(--text3)">還沒選程式，目前不會暫停任何連線</span>'}
      <button id="ksAddApp" class="hvFill2" style="height:26px;padding:0 11px;border:1px dashed var(--sep);border-radius:13px;background:transparent;color:var(--text2);font-size:11.5px;cursor:pointer;white-space:nowrap">＋ 加入程式</button>
    </div>` : ''}`;

  el.querySelectorAll('[data-ksscope]').forEach(b => b.onclick = () => {
    state.settings.killSwitchScope = b.dataset.ksscope;
    saveSettings(); refreshSettings();
  });
  el.querySelectorAll('[data-kschip]').forEach(b => b.onclick = () => {
    state.settings.killSwitchApps = (state.settings.killSwitchApps || []).filter(a => a !== b.dataset.kschip);
    saveSettings(); refreshSettings();
  });
  if ($('ksAddApp')) $('ksAddApp').onclick = async e => {
    e.stopPropagation();
    if (!state.splitProcs.length) await loadSplitProcs();
    openMenu('ks-app', $('ksAddApp'));
  };
}

function renderRuleSets() {
  const el = $('setRuleSets'); if (!el) return;
  const installed = state.splitInstalled;

  const rows = installed.map(e => {
    const used = setUsage(e.tag), pend = state.setsPendingDel === e.tag;
    const canUpdate = e.source === 'catalog' && !state.setsBusy;
    const stale = e.updatedAt && (Date.now() - e.updatedAt) > 30 * 86400000;
    const busy = state.setsBusy === e.tag;
    const mid = e.missing ? '<span style="color:var(--amber)">檔案遺失</span>'
      : `${e.bytes ? fmtBytes(e.bytes) : '—'} · <span style="color:${stale ? 'var(--amber)' : 'inherit'}">${fmtAge(e.updatedAt)}</span>`;
    return `<div style="display:flex;align-items:center;gap:11px;padding:0 16px;height:48px;border-bottom:1px solid var(--sep);font-size:12.5px;box-shadow:${e.missing ? 'inset 3px 0 0 var(--amber)' : 'none'}">
      <span style="width:30px;height:30px;flex-shrink:0;border-radius:8px;background:var(--accent-dim);color:var(--accent);display:flex;align-items:center;justify-content:center"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${kindIcon(e.kind)}"></path></svg></span>
      <span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:1px">
        <span style="display:flex;align-items:center;gap:7px;min-width:0">
          <span style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(e.label)}</span>
          <span style="font-size:10.5px;color:var(--text3);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;flex-shrink:0">${esc(e.tag)}</span>
          ${used ? `<span style="font-size:11px;color:var(--text3);white-space:nowrap;flex-shrink:0">${used} 條規則使用中</span>` : ''}
        </span>
        <span style="font-size:11px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${mid} · ${e.source === 'import' ? '匯入' : '目錄'}</span>
      </span>
      ${busy ? `<span style="flex-shrink:0;display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--text2)"><span style="width:76px;height:4px;border-radius:2px;background:var(--fill);overflow:hidden"><span style="display:block;width:45%;height:100%;background:var(--accent)"></span></span>下載中…</span>`
        : e.missing
        ? `<button data-setdl="${esc(e.tag)}" class="hvBright" style="flex-shrink:0;height:28px;padding:0 12px;border:none;border-radius:8px;background:var(--amber);color:#fff;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap">重新下載</button>`
        : `<button data-setup="${esc(e.tag)}" ${canUpdate ? '' : 'disabled'} class="${canUpdate ? 'hvFill2' : ''}" title="${e.source === 'import' ? '手動匯入的規則庫沒有更新來源' : '從目錄重新下載最新版'}" style="flex-shrink:0;height:28px;padding:0 12px;border:1px solid var(--sep);border-radius:8px;background:var(--bg);color:${canUpdate ? 'var(--text)' : 'var(--text3)'};font-size:11.5px;cursor:${canUpdate ? 'pointer' : 'not-allowed'};white-space:nowrap">更新</button>`}
      <button data-setdel="${esc(e.tag)}" class="hvRed" title="${pend ? '再按一次確認移除' : used ? used + ' 條規則將失效' : '移除規則庫'}" style="flex-shrink:0;width:28px;height:28px;border:none;border-radius:8px;background:${pend ? 'var(--red)' : 'var(--fill2)'};color:${pend ? '#fff' : 'var(--red)'};cursor:pointer;display:flex;align-items:center;justify-content:center">${pend
        ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"></path></svg>'
        : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"></path></svg>'}</button>
    </div>`;
  }).join('');

  const empty = '<div style="padding:20px 16px;text-align:center;color:var(--text3);font-size:12px;border-bottom:1px solid var(--sep);line-height:1.7">還沒有規則庫<br>新增規則時選擇地區或分類即會下載</div>';
  const canUpdateAll = installed.some(e => e.source === 'catalog') && !state.setsBusy;
  const days = Number(state.settings.rulesetUpdateDays) || 7;
  const autoOn = !!state.settings.rulesetAutoUpdate;
  const det = state.settings.rulesetDetourRouteId;
  const detRoute = det ? state.routes.find(r => r.id === det) : null;

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:11px 16px;border-bottom:1px solid var(--sep)">
      <span style="flex:1;font-size:12.5px;color:var(--text2)">已安裝 ${installed.length} 個</span>
      <button id="setRsImport" class="hvFill2" style="height:28px;padding:0 12px;border:1px solid var(--sep);border-radius:8px;background:var(--bg);color:var(--text);font-size:11.5px;cursor:pointer;white-space:nowrap">匯入</button>
      <button id="setRsUpdateAll" ${canUpdateAll ? '' : 'disabled'} class="${canUpdateAll ? 'hvFill2' : ''}" style="height:28px;padding:0 12px;border:1px solid var(--sep);border-radius:8px;background:var(--bg);color:${canUpdateAll ? 'var(--text)' : 'var(--text3)'};font-size:11.5px;cursor:${canUpdateAll ? 'pointer' : 'not-allowed'};white-space:nowrap">全部更新</button>
    </div>
    ${installed.length ? rows : empty}
    <div style="padding:13px 16px;display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--sep)">
      <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500;white-space:nowrap">自動更新</div><div style="font-size:11.5px;color:var(--text2);margin-top:2px">每 ${days} 天檢查一次</div></div>
      <div style="display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:8px;opacity:${autoOn ? '1' : '.45'}">
        ${[7, 14, 30].map(d => `<button data-rsd="${d}" ${autoOn ? '' : 'disabled'} style="border:none;cursor:${autoOn ? 'pointer' : 'not-allowed'};height:26px;padding:0 10px;border-radius:6px;font-size:12px;white-space:nowrap;${segCss(days === d)}">${d}</button>`).join('')}
      </div>
      <button data-rsauto="1" role="switch" aria-label="自動更新規則庫" style="width:44px;height:26px;border-radius:13px;border:none;padding:0;cursor:pointer;position:relative;background:${autoOn ? 'var(--accent)' : 'var(--fill)'};transition:background .22s;flex-shrink:0"><span style="position:absolute;top:3px;left:${autoOn ? '21px' : '3px'};width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .22s cubic-bezier(.32,.72,0,1)"></span></button>
    </div>
    <div style="padding:13px 16px;display:flex;align-items:center;gap:14px">
      <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500;white-space:nowrap">下載經由</div><div style="font-size:11.5px;color:var(--text2);margin-top:2px">規則庫來源在 GitHub</div></div>
      <button id="setRsDetour" class="hvFill2" style="display:flex;align-items:center;gap:7px;height:30px;padding:0 10px;border:1px solid var(--sep);border-radius:8px;background:var(--bg);color:var(--text);font-size:12px;cursor:pointer;white-space:nowrap;flex-shrink:0"><span>${esc(detRoute ? (detRoute.label || det) : '直連')}</span><span style="color:var(--text3);font-size:9px">▾</span></button>
    </div>`;

  $('setRsImport').onclick = () => importRuleSet();
  if (canUpdateAll) $('setRsUpdateAll').onclick = () => updateAllRuleSets();
  $('setRsDetour').onclick = e => { e.stopPropagation(); openMenu('rs-detour', $('setRsDetour')); };
  el.querySelector('[data-rsauto]').onclick = () => toggleSwitch('rsauto');
  el.querySelectorAll('[data-rsd]').forEach(b => { if (!b.disabled) b.onclick = () => { state.settings.rulesetUpdateDays = +b.dataset.rsd; saveSettings(); refreshSettings(); }; });
  el.querySelectorAll('[data-setdl]').forEach(b => b.onclick = () => installRuleSets([b.dataset.setdl]));
  el.querySelectorAll('[data-setup]').forEach(b => { if (!b.disabled) b.onclick = () => updateRuleSet(b.dataset.setup); });
  el.querySelectorAll('[data-setdel]').forEach(b => b.onclick = () => removeRuleSet(b.dataset.setdel));
}

async function refreshRuleSets() {
  try { const l = await window.api.rulesetList(); if (Array.isArray(l)) state.splitInstalled = l; } catch {}
  if (state.tab === 'settings') renderRuleSets();
  if (state.tab === 'split') { renderSplitRules(); renderSplitNotice(); }
}

async function updateRuleSet(tag) {
  state.setsBusy = tag; renderRuleSets();
  try {
    const r = await window.api.rulesetUpdate(tag);
    flash(r && r.ok ? `已更新 ${catLabel(tag)}` : `更新失敗：${(r && r.error) || '未知'}`, r && r.ok ? undefined : 'var(--red)');
  } catch (e) { flash('更新失敗：' + e.message, 'var(--red)'); }
  state.setsBusy = null;
  await refreshRuleSets();
}

async function updateAllRuleSets() {
  const updatable = state.splitInstalled.filter(e => e.source === 'catalog');
  if (!updatable.length) { flash('沒有可更新的規則庫（手動匯入的需重新匯入）'); return; }
  state.setsBusy = 'all'; renderRuleSets();
  try {
    const res = await window.api.rulesetUpdateAll();
    const ok = (res || []).filter(r => r.ok).length;
    flash(`規則庫更新完成：${ok} / ${(res || []).length} 成功`, ok === (res || []).length ? undefined : 'var(--amber)');
  } catch (e) { flash('更新失敗：' + e.message, 'var(--red)'); }
  state.setsBusy = null;
  await refreshRuleSets();
}

async function importRuleSet() {
  try {
    const r = await window.api.rulesetImport();
    if (!r) return; // 使用者取消
    flash(r.ok ? `已匯入 ${r.entry.label}` : `匯入失敗：${r.error}`, r.ok ? undefined : 'var(--red)');
  } catch (e) { flash('匯入失敗：' + e.message, 'var(--red)'); }
  await refreshRuleSets();
}

function removeRuleSet(tag) {
  if (state.setsPendingDel !== tag) {
    state.setsPendingDel = tag; renderRuleSets();
    setTimeout(() => { if (state.setsPendingDel === tag) { state.setsPendingDel = null; renderRuleSets(); } }, 2500);
    return;
  }
  state.setsPendingDel = null;
  window.api.rulesetRemove(tag).then(() => { flash(`已移除 ${catLabel(tag)}`); refreshRuleSets(); }).catch(() => {});
}

// ---- 空狀態的常用範本（v8）----
function splitTemplates() {
  const firstRoute = (state.routes[0] || {}).id || null;
  return [
    {
      title: '台灣直連、其餘走代理', color: 'var(--accent)',
      desc: '台灣 IP 直連，其他流量走選定路由。內建內網保護已涵蓋 LAN。',
      icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18',
      tags: ['geoip-tw'],
      rules: [{ id: 't' + Date.now(), name: '台灣網站直連', on: true, target: 'direct', when: { dest: { match: 'ruleset', value: 'geoip-tw' } } }],
      def: firstRoute,
    },
    {
      title: '擋掉廣告與追蹤', color: 'var(--red)',
      desc: '廣告與追蹤器網域直接丟棄。',
      icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.5 5.5l13 13',
      tags: ['geosite-category-ads-all'],
      rules: [{ id: 't' + (Date.now() + 1), name: '擋掉廣告與追蹤', on: true, target: 'block', when: { dest: { match: 'ruleset', value: 'geosite-category-ads-all' } } }],
    },
  ];
}

async function applyTemplate(i) {
  const t = splitTemplates()[i];
  if (!t) return;
  if (t.openSheet) { openSplitSheet(); state.splitOpenConds = { app: true, dest: false, port: false, net: false }; renderSplitSheet(); return; }
  const need = (t.tags || []).filter(x => !isInstalled(x));
  if (need.length) {
    state.alert = {
      title: '需要下載規則庫',
      body: `此範本需要下載 ${need.length} 個規則庫（${need.map(catLabel).join('、')}），要現在下載嗎？`,
      action: '下載並套用',
      go: async () => { closeAlert(); await doApplyTemplate(t); },
    };
    renderAlert();
    return;
  }
  await doApplyTemplate(t);
}

async function doApplyTemplate(t) {
  state.splitRules = [...state.splitRules, ...t.rules];
  if (t.def) state.splitDefaultTarget = t.def;
  updateSplit();
  await persistSplit({ rules: state.splitRules, ...(t.def ? { defaultTarget: t.def } : {}) });
  const need = (t.tags || []).filter(x => !isInstalled(x));
  if (need.length) await installRuleSets(need);
  flash(`已套用範本「${t.title}」`);
}

function renderSplitUac() {
  if (!state.splitUac) { $('splitUacMount').innerHTML = ''; return; }
  const items = [
    { n: '1', text: '安裝並啟用虛擬網卡驅動（首次執行時進行，之後可重複使用）。' },
    { n: '2', text: '在系統路由表加入指向虛擬網卡的路由，讓被指定的程式流量改道。' },
    { n: '3', text: '停止引擎或關閉程式時，自動移除路由並還原原本設定。' },
  ];
  $('splitUacMount').innerHTML = `
    <div id="spUacOverlay" style="position:absolute;inset:0;background:rgba(0,0,0,.36);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:150">
      <div id="spUacBox" style="width:412px;background:var(--panel);border:1px solid var(--sep);border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.32);padding:24px;display:flex;flex-direction:column;gap:16px;animation:fadeUp .22s ease-out">
        <div style="display:flex;align-items:center;gap:13px">
          <div style="width:46px;height:46px;flex-shrink:0;border-radius:13px;background:var(--accent-dim);display:flex;align-items:center;justify-content:center;color:var(--accent)"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3.5v5c0 4.2-2.9 7-7 8.5-4.1-1.5-7-4.3-7-8.5v-5L12 3z"></path><path d="M9.5 12.2l1.8 1.8 3.4-3.6"></path></svg></div>
          <div style="display:flex;flex-direction:column;gap:3px;min-width:0">
            <span style="font-size:16px;font-weight:700;letter-spacing:-.2px;white-space:nowrap">需要系統管理員權限</span>
            <span style="font-size:12px;color:var(--text2);white-space:nowrap">僅在首次啟動分流引擎時需要同意一次</span>
          </div>
        </div>
        <span style="font-size:12.5px;color:var(--text2);line-height:1.75;text-wrap:pretty">分流引擎會建立一個虛擬網卡（TUN），把指定程式的流量導入代理。安裝虛擬網卡與設定路由表屬於系統層級操作，因此 Windows 會顯示使用者帳戶控制（UAC）視窗。</span>
        <div style="background:var(--bg);border:1px solid var(--sep);border-radius:12px;padding:13px 15px;display:flex;flex-direction:column;gap:9px">
          ${items.map(u => `<div style="display:flex;align-items:flex-start;gap:9px;font-size:12px;line-height:1.6"><span style="width:17px;height:17px;flex-shrink:0;border-radius:50%;background:var(--accent-dim);color:var(--accent);font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px">${u.n}</span><span style="flex:1;color:var(--text2);text-wrap:pretty">${esc(u.text)}</span></div>`).join('')}
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--text2);cursor:pointer"><input type="checkbox"> 記住這個選擇，之後自動以管理員身分啟動</label>
        <div style="display:flex;gap:9px">
          <button id="spUacCancel" class="hvFill2" style="flex:1;height:36px;border:1px solid var(--sep);border-radius:10px;background:var(--bg);color:var(--text);font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap">稍後再說</button>
          <button id="spUacGrant" class="hvBright" style="flex:1;height:36px;border:none;border-radius:10px;background:var(--accent);color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap">繼續並提權</button>
        </div>
      </div>
    </div>`;
  $('spUacOverlay').onclick = e => { if (e.target === $('spUacOverlay')) closeSplitUac(); };
  $('spUacCancel').onclick = () => closeSplitUac();
  $('spUacGrant').onclick = () => grantSplitUac();
}
function closeSplitUac() { state.splitUac = false; $('splitUacMount').innerHTML = ''; }

boot();



