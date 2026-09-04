'use strict';
/* 代理客戶端 renderer v2 — 照 Claude Design「SOCKS5 Client Redesign v2（路由模型）」一比一還原，
   以真實 IPC 後端取代設計稿模擬。路由（route）為主概念：每條路由 = 一個本地端口 → 一串上游跳點，
   各自擁有獨立 runtime session；多條可同時執行。設計稿為 React，此處以原生 JS 重建：
   骨架 mount() 建一次，電源 SVG 常駐、以 targeted update 套用（保留元素才能觸發 CSS 過場）。 */

const app = document.getElementById('app');
const $ = id => document.getElementById(id);
const setDisp = (id, on) => { const e = $(id); if (e) e.style.display = on ? 'block' : 'none'; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 真實伺服器物件用 type/username/password；設計稿用 proto/user/pass。統一以下列存取。
const sProto = s => (s && s.type) || 'socks5';
const sUser = s => (s && s.username) || '';
const sPass = s => (s && s.password) || '';

const PROTO = {
  socks5: { label: 'SOCKS5', name: '帳密認證 (RFC 1929)', port: 1080, auth: 'userpass', hint: '透過 socks 套件握手，支援 RFC 1929 帳密認證。', authTitle: '帳密認證', authDesc: 'RFC 1929 Username / Password' },
  socks4: { label: 'SOCKS4', name: '無認證機制', port: 1080, auth: 'none', hint: 'SOCKS4 協定沒有認證機制，僅能附帶 User ID 供伺服器辨識。', authTitle: 'User ID', authDesc: '協定無認證，僅辨識用字串' },
  http: { label: 'HTTP', name: 'Basic 認證', port: 8080, auth: 'basic', hint: '以 CONNECT 建立通道，帶入 Proxy-Authorization: Basic。', authTitle: 'Basic 認證', authDesc: 'Proxy-Authorization: Basic' },
  https: { label: 'HTTPS', name: 'Basic 認證（TLS）', port: 8443, auth: 'basic', hint: '先完成 TLS 握手再送出 CONNECT，認證方式同 HTTP Basic。', authTitle: 'Basic 認證', authDesc: 'Proxy-Authorization: Basic（TLS）' },
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
  settings: { httpPort: 10808, socksPort: 10809, minimizeToTray: true, autoConnect: false, testTarget: null },
  // ---- 分流（split routing）狀態 ----
  splitRules: [], splitDefaultTarget: 'direct', splitUdp: false,
  splitEngine: 'off', splitElevated: false, splitTun: null, splitApps: 0, splitHealth: [], splitLive: [],
  splitFilter: '全部', splitSheet: false, splitEditing: null,
  splitPickMode: '執行中的程式', splitMatchMode: '程式名稱', splitProcSearch: '', splitProcs: [],
  splitDraft: { name: '', exe: '', path: '', pattern: '', target: 'direct', match: 'name' },
  splitPendingDel: null, splitDrag: null, splitUac: false, splitUacSeen: false,
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
          <span style="font-size:13.5px;font-weight:600;letter-spacing:-.2px;white-space:nowrap">代理客戶端</span>
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

    <div style="flex:1;display:flex;overflow:hidden;position:relative">
      <div id="sidebar" style="width:264px;flex-shrink:0;display:flex;flex-direction:column;background:var(--panel);border-right:1px solid var(--sep)">
        <div style="padding:12px 14px 8px;display:flex;align-items:center;gap:8px">
          <span id="sideCount" style="font-size:12px;font-weight:600;color:var(--text2);letter-spacing:.2px">路由 · 0</span>
          <span id="sideRunning" style="margin-left:auto;font-size:11px;color:var(--text3);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace"></span>
        </div>
        <div id="routeList" style="flex:1;overflow-y:auto;padding:0 10px 12px;display:flex;flex-direction:column;gap:8px"></div>
      </div>

      <div id="content" style="flex:1;overflow-y:auto;padding:20px 22px 24px;min-width:0">
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

  $('btnTheme').onclick = () => setTheme(state.theme === 'dark' ? '淺色' : '深色');
  $('btnAdd').onclick = () => state.tab === 'split' ? openSplitSheet() : openRoute();
  $('btnMin').onclick = () => window.api.windowMinimize();
  $('btnMax').onclick = () => window.api.windowMaximize();
  $('btnClose').onclick = () => window.api.windowClose();
  $('bannerDismiss').onclick = () => { state.banner = ''; state.sysHintSeen = true; showBanner(); };

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); if (state.tab === 'split') openSplitSheet(); else openRoute(); }
    if (e.code === 'Space' && state.tab !== 'split' && !state.routeSheet && !state.srvSheet && !state.alert && e.target === document.body) { e.preventDefault(); togglePower(); }
    if (e.key === 'Escape') { closeMenu(); if (state.splitUac) closeSplitUac(); else if (state.splitSheet) closeSplitSheet(); else if (state.alert) closeAlert(); else if (state.srvSheet) closeSrvSheet(); else if (state.routeSheet) closeRouteSheet(); }
  });
  document.addEventListener('click', () => closeMenu(), true);
}

// =====================================================================================
// 標題列分頁 + 狀態
// =====================================================================================
function renderTabs() {
  const tabs = [['dashboard', '總覽'], ['servers', '伺服器'], ['logs', '紀錄'], ['creds', '憑證'], ['settings', '設定'], ['split', '分流']];
  $('tabseg').setAttribute('role', 'tablist');
  $('tabseg').innerHTML = tabs.map(([k, label]) =>
    `<button data-tab="${k}" role="tab" aria-selected="${state.tab === k}" aria-label="${label}" style="border:none;cursor:pointer;padding:6px 13px;border-radius:7px;font-size:12.5px;${segCss(state.tab === k)};transition:background .18s,color .18s;white-space:nowrap;flex-shrink:0">${label}</button>`
  ).join('');
  $('tabseg').querySelectorAll('button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
}

function syncTitlebar() {
  if (state.tab === 'split') { syncSplitTitlebar(); renderTabs(); return; }
  const runIds = runningRouteIds(), actIds = activeRouteIds();
  const st = $('status');
  if (runIds.length > 1) { st.textContent = `${runIds.length} 條路由執行中`; st.style.color = 'var(--good)'; }
  else if (runIds.length === 1) { st.textContent = `執行中 · ${(state.routes.find(r => r.id === runIds[0]) || {}).label || ''}`; st.style.color = 'var(--good)'; }
  else if (actIds.length) { st.textContent = '正在啟動…'; st.style.color = 'var(--amber)'; }
  else { st.textContent = '未執行'; st.style.color = 'var(--text3)'; }
  $('markArc').setAttribute('stroke', runIds.length ? '#7fe3bd' : 'rgba(255,255,255,.55)');
  renderTabs();
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
function renderSidebar() {
  const runIds = runningRouteIds();
  $('sideCount').textContent = `路由 · ${state.routes.length}`;
  $('sideRunning').textContent = runIds.length ? runIds.length + ' 執行中' : '';
  const list = $('routeList');
  if (state.routes.length === 0) {
    list.innerHTML = `<div style="padding:20px 10px;text-align:center;color:var(--text3);font-size:12.5px;line-height:1.7">尚無路由<br>從右側開始新增</div>`;
    return;
  }
  list.innerHTML = state.routes.map(r => {
    const st = ses(r.id).status, conn = st === 'running', busy = st === 'connecting', fail = st === 'failing';
    const active = state.sel === r.id, pend = state.pendingRouteDel === r.id;
    const dot = conn ? 'var(--good)' : busy ? 'var(--amber)' : fail ? 'var(--red)' : 'var(--text3)';
    const chained = r.hops.length > 1;
    const exitName = r.hops.length ? srvName(r.hops[r.hops.length - 1]) : '未設跳點';
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
        <span style="font-size:11.5px;color:var(--text2);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace">127.0.0.1:${r.localPort}</span>
        <span style="margin-left:auto;font-size:11px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:96px">${esc(exitName)}</span>
      </div>
      ${active ? `<div style="display:flex;gap:6px;padding-top:2px">
        <button class="hvBright" data-act="power" title="${powerTip}" style="flex:1;height:26px;border:none;border-radius:7px;background:${powerBg};color:${powerColor};cursor:pointer;display:flex;align-items:center;justify-content:center">${POWER_ICON}</button>
        <button class="hvAcc" data-act="edit" title="編輯路由" style="flex:1;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h4L20 8l-4-4L4 16v4z"></path></svg></button>
        <button class="hvRed" data-act="del" title="${pend ? '再按一次確認刪除' : '刪除路由'}" style="flex:1;height:26px;border:none;border-radius:7px;background:${pend ? 'var(--red)' : 'var(--fill2)'};color:${pend ? '#fff' : 'var(--red)'};cursor:pointer;display:flex;align-items:center;justify-content:center">${delIcon}</button>
      </div>` : ''}
    </div>`;
  }).join('');

  list.querySelectorAll('[data-rid]').forEach(row => {
    const id = row.dataset.rid;
    row.addEventListener('click', e => { if (e.target.closest('[data-act]')) return; selectRoute(id); });
    row.querySelector('[data-act="power"]')?.addEventListener('click', e => { e.stopPropagation(); togglePower(id); });
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
  window.api.deleteRoute(id).then(routes => {
    state.routes = routes || [];
    if (state.sel === id) state.sel = state.routes[0] ? state.routes[0].id : null;
    renderSidebar(); showTab(state.tab); flash('已刪除路由');
  });
}

// =====================================================================================
// 導引（無路由）
// =====================================================================================
function renderGuide() {
  $('view-guide').innerHTML = `
    <div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;text-align:center;animation:fadeUp .3s ease-out">
      <div style="width:62px;height:62px;border-radius:18px;background:var(--accent-dim);display:flex;align-items:center;justify-content:center;color:var(--accent)">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="2.5"></circle><circle cx="19" cy="12" r="2.5"></circle><circle cx="12" cy="5" r="2.5"></circle><path d="M7.5 12h2M14.5 12h2M12 7.5v2"></path></svg>
      </div>
      <div style="display:flex;flex-direction:column;gap:7px;max-width:360px">
        <span style="font-size:19px;font-weight:700;letter-spacing:-.3px">建立第一條路由</span>
        <span style="font-size:13px;color:var(--text2);line-height:1.65;text-wrap:pretty">一條路由 = 一個本地端口 + 一串上游跳點。多條路由可同時執行，各自綁不同端口與線路。</span>
      </div>
      <div style="display:flex;gap:10px">
        <button id="guideAdd" class="hvBright" style="height:38px;padding:0 20px;border:none;border-radius:10px;background:var(--accent);color:#fff;font-size:13.5px;font-weight:600;cursor:pointer">新增路由</button>
        <button id="guideImport" class="hvFill2" style="height:38px;padding:0 20px;border:1px solid var(--sep);border-radius:10px;background:var(--card);color:var(--text);font-size:13.5px;font-weight:600;cursor:pointer">匯入設定</button>
      </div>
      <span style="font-size:11.5px;color:var(--text3)">⌘/Ctrl + N 新增 · 空白鍵啟動選取的路由</span>
    </div>`;
  $('guideAdd').onclick = () => openRoute();
  $('guideImport').onclick = () => importData();
}

// =====================================================================================
// 儀表板（建一次；動態值以 updateDashboard 套用，電源 SVG 常駐）
// =====================================================================================
function buildDashboard() {
  $('view-dash').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:14px">
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
  const div = state.range === '60 秒' ? 59 : 299;
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
      <span style="width:158px;flex-shrink:0;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;color:var(--text2);padding-right:10px;box-sizing:border-box;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.host)}:${s.port}</span>
      <span style="width:78px;flex-shrink:0"><span style="font-size:9.5px;font-weight:700;letter-spacing:.4px;padding:2px 6px;border-radius:5px;background:var(--fill2);color:var(--text2);white-space:nowrap">${PROTO[sProto(s)].label}</span></span>
      <span style="width:74px;flex-shrink:0;color:var(--text2);display:flex;align-items:center;gap:5px;white-space:nowrap">${authIcon}${sUser(s) ? '已設定' : '無'}</span>
      <span style="flex:1;min-width:0;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;color:${testColor(lat)};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(tText)}</span>
      <span style="width:88px;flex-shrink:0;display:flex;justify-content:flex-end;gap:6px">
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
          <span style="font-size:12px;color:var(--text2)">上游節點清單；路由再從這裡挑跳點組成鏈路</span>
        </div>
        <button id="srvAdd" class="hvBright" style="margin-left:auto;height:32px;padding:0 15px;border:none;border-radius:9px;background:var(--accent);color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap">新增伺服器</button>
      </div>
      <div style="background:var(--card);border:1px solid var(--sep);border-radius:16px;overflow:hidden">
        <div style="display:flex;align-items:center;padding:9px 16px;border-bottom:1px solid var(--sep);font-size:11px;color:var(--text3);font-weight:600;letter-spacing:.3px">
          <span style="width:150px;flex-shrink:0;white-space:nowrap">名稱</span><span style="width:158px;flex-shrink:0;white-space:nowrap">位址</span><span style="width:78px;flex-shrink:0;white-space:nowrap">協定</span><span style="width:74px;flex-shrink:0;white-space:nowrap">認證</span><span style="flex:1;min-width:0;white-space:nowrap">測試結果</span><span style="width:88px;flex-shrink:0"></span>
        </div>
        ${rows}
        ${state.servers.length === 0 ? `<div style="padding:44px 20px;text-align:center;color:var(--text3);font-size:12.5px;line-height:1.7">尚無伺服器<br>新增後即可組成路由</div>` : ''}
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
    renderServers(); renderSidebar(); flash('已刪除伺服器');
  });
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
          <button id="logCopy" class="hvFill2" style="height:30px;padding:0 13px;border:1px solid var(--sep);border-radius:9px;background:var(--card);color:var(--text);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap">複製</button>
          <button id="logClear" class="hvFill2" style="height:30px;padding:0 13px;border:1px solid var(--sep);border-radius:9px;background:var(--card);color:var(--red);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap">清除</button>
        </div>
      </div>
      <div id="logList" style="flex:1;background:var(--card);border:1px solid var(--sep);border-radius:16px;overflow-y:auto;user-select:text"></div>
    </div>`;
  $('logSearch').addEventListener('input', e => { state.search = e.target.value; renderLogList(); });
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
          <span style="flex-shrink:0;color:var(--text3);font-size:10px;padding-top:2px">${l.detail ? (exp ? '▾' : '▸') : ''}</span>
        </div>`;
      }).join('')}
    </div>`;
  }).join('');
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
        <div style="display:flex;flex-direction:column;gap:3px"><span style="font-size:16px;font-weight:700;letter-spacing:-.2px;white-space:nowrap">憑證庫</span><span style="font-size:12px;color:var(--text2)">儲存帳密後可在伺服器表單直接選用</span></div>
        <button id="credAdd" class="hvBright" style="margin-left:auto;height:32px;padding:0 15px;border:none;border-radius:9px;background:var(--accent);color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap">新增憑證</button>
      </div>
      <div style="background:var(--card);border:1px solid var(--sep);border-radius:16px;overflow:hidden">
        <div style="display:flex;padding:9px 16px;border-bottom:1px solid var(--sep);font-size:11px;color:var(--text3);font-weight:600;letter-spacing:.3px">
          <span style="width:150px;flex-shrink:0;white-space:nowrap">名稱</span><span style="width:130px;flex-shrink:0;white-space:nowrap">帳號</span><span style="width:120px;flex-shrink:0;white-space:nowrap">密碼</span><span style="flex:1;min-width:0;white-space:nowrap">備註</span><span style="width:60px;flex-shrink:0"></span>
        </div>
        ${rows}
        ${S.creds.length === 0 ? `<div style="padding:44px 20px;text-align:center;color:var(--text3);font-size:12.5px;line-height:1.7">尚無儲存的憑證<br>新增後可在表單一鍵帶入</div>` : ''}
      </div>
      <div style="display:flex;gap:9px;padding:12px 15px;background:var(--accent-dim);border-radius:12px;font-size:11.5px;color:var(--text2);line-height:1.65">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent);flex-shrink:0;margin-top:1px"><circle cx="12" cy="12" r="9"></circle><path d="M12 8h.01M11 12h1v5h1"></path></svg>
        <span style="text-wrap:pretty">SOCKS5 使用 RFC 1929 帳密認證；HTTP / HTTPS 使用 Basic（<span style="font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace">Proxy-Authorization</span>）。SOCKS4 協定本身不支援認證，僅有 userId 欄位。</span>
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

function buildSettings() {
  const swDefs = [
    { key: 'tray', label: '關閉時最小化到系統匣', desc: '保留背景執行與托盤圖示' },
    { key: 'bootLaunch', label: '開機時自動啟動', desc: '登入 Windows 後自動啟動代理客戶端' },
    { key: 'autostart', label: '啟動時自動套用路由', desc: 'App 啟動後自動起所有已啟用的路由' },
    { key: 'killswitch', label: '斷線保護 (Kill-switch)', desc: '分流引擎異常中止時封鎖受保護程式，防止流量以真實 IP 外洩（用 TUN，不動防火牆）' },
    { key: 'scroll', label: '紀錄自動捲動', desc: '新紀錄進來時跟隨到底部' },
    { key: 'nodebug', label: '隱藏除錯層級', desc: '紀錄預設隔絕 debug 訊息' },
  ];
  const swHtml = swDefs.map(w => `
    <div style="padding:13px 16px;display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--sep)">
      <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500;white-space:nowrap">${w.label}</div><div style="font-size:11.5px;color:var(--text2);margin-top:2px">${w.desc}</div></div>
      <button data-sw="${w.key}" role="switch" aria-checked="false" aria-label="${w.label}" style="width:46px;height:28px;border-radius:14px;border:none;padding:0;cursor:pointer;position:relative;background:var(--fill);transition:background .22s;flex-shrink:0">
        <span style="position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .22s cubic-bezier(.32,.72,0,1)"></span>
      </button>
    </div>`).join('');

  $('view-settings').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:18px">
      <div style="display:flex;flex-direction:column;gap:8px">
        <span style="font-size:11.5px;font-weight:600;color:var(--text3);letter-spacing:.4px;padding-left:4px;white-space:nowrap">外觀與行為</span>
        <div style="background:var(--card);border:1px solid var(--sep);border-radius:16px;overflow:hidden">
          <div style="padding:13px 16px;display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--sep)">
            <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500;white-space:nowrap">外觀</div><div style="font-size:11.5px;color:var(--text2);margin-top:2px">預設跟隨系統設定</div></div>
            <div id="themeSeg" style="display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:8px"></div>
          </div>
          ${swHtml}
          <div style="padding:13px 16px;display:flex;align-items:center;gap:14px">
            <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500;white-space:nowrap">連線測試目標</div><div style="font-size:11.5px;color:var(--text2);margin-top:2px">留空 = 僅測試協定握手，不需外網</div></div>
            <div style="display:flex;align-items:center;gap:5px">
              <input id="setTestHost" placeholder="example.com" style="width:158px;height:30px;padding:0 10px;border:1px solid var(--sep);border-radius:8px;background:var(--bg);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12px;outline:none">
              <span style="color:var(--text3)">:</span>
              <input id="setTestPort" placeholder="443" style="width:56px;height:30px;padding:0 8px;border:1px solid var(--sep);border-radius:8px;background:var(--bg);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12px;text-align:center;outline:none">
            </div>
          </div>
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:8px">
        <span style="font-size:11.5px;font-weight:600;color:var(--text3);letter-spacing:.4px;padding-left:4px;white-space:nowrap">資料</span>
        <div style="background:var(--card);border:1px solid var(--sep);border-radius:16px;padding:13px 16px;display:flex;align-items:center;gap:14px">
          <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500;white-space:nowrap">匯入 / 匯出設定</div><div style="font-size:11.5px;color:var(--text2);margin-top:2px">以 JSON 備份伺服器與路由（不含密碼）</div></div>
          <div style="display:flex;gap:7px;flex-shrink:0">
            <button id="setExport" class="hvFill2" style="height:30px;padding:0 15px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap">匯出</button>
            <button id="setImport" class="hvFill2" style="height:30px;padding:0 15px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap">匯入</button>
          </div>
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:8px">
        <span style="font-size:11.5px;font-weight:600;color:var(--text3);letter-spacing:.4px;padding-left:4px;white-space:nowrap">關於</span>
        <div style="background:var(--card);border:1px solid var(--sep);border-radius:16px;padding:16px;display:flex;align-items:center;gap:14px">
          <svg width="42" height="42" viewBox="0 0 256 256" style="border-radius:11px;flex-shrink:0"><rect x="0" y="0" width="256" height="256" rx="56" fill="var(--accent)"></rect><circle cx="128" cy="128" r="76" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="15"></circle><path d="M128 52 A76 76 0 0 1 204 128" fill="none" stroke="#fff" stroke-width="15" stroke-linecap="round"></path><path d="M52 128 A76 76 0 0 0 128 204" fill="none" stroke="#7fe3bd" stroke-width="15" stroke-linecap="round"></path><circle cx="128" cy="128" r="18" fill="#fff"></circle></svg>
          <div style="flex:1"><div style="font-size:13.5px;font-weight:600">代理客戶端</div><div style="font-size:11.5px;color:var(--text2);margin-top:2px;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace">版本 1.1.0 · 多端口路由 · 多跳串鏈</div></div>
          <button id="setUpdate" class="hvAccDim" style="height:30px;padding:0 15px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--accent);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap">${updateBtnLabel()}</button>
        </div>
      </div>
    </div>`;

  $('setTestHost').addEventListener('change', updateTestTarget);
  $('setTestPort').addEventListener('change', updateTestTarget);
  $('setExport').onclick = () => exportData();
  $('setImport').onclick = () => importData();
  $('setUpdate').onclick = onUpdateClick;
  $('view-settings').querySelectorAll('[data-sw]').forEach(b => b.onclick = () => toggleSwitch(b.dataset.sw));
  renderThemeSeg();
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
  if (key === 'tray') state.settings.minimizeToTray = !(state.settings.minimizeToTray !== false);
  else if (key === 'autostart') state.settings.autoConnect = !state.settings.autoConnect;
  else if (key === 'killswitch') state.settings.killSwitch = !state.settings.killSwitch;
  else localStorage.setItem('sw_' + key, localStorage.getItem('sw_' + key) === '1' ? '0' : '1');
  saveSettings(); refreshSettings();
}
function swOn(key) {
  if (key === 'tray') return state.settings.minimizeToTray !== false;
  if (key === 'bootLaunch') return !!state.bootLaunch;
  if (key === 'autostart') return !!state.settings.autoConnect;
  if (key === 'killswitch') return !!state.settings.killSwitch;
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
}
function saveSettings() { window.api.updateSettings({ minimizeToTray: state.settings.minimizeToTray, autoConnect: state.settings.autoConnect, killSwitch: state.settings.killSwitch, testTarget: state.settings.testTarget }); }

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
  const routes = await window.api.saveRoute(rec);
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
  if (state.tab === 'servers') renderServers();
  if (state.tab === 'dashboard') updateChain();
  flash('已儲存');
  window.api.testServer(id, state.settings.testTarget || undefined).then(async () => {
    state.servers = await window.api.getServers();
    if (state.tab === 'servers') renderServers();
    if (state.tab === 'dashboard') updateChain();
  });
}

// =====================================================================================
// 下拉選單（hop / proto / cred）
// =====================================================================================
function openMenu(kind, anchor) {
  if (state.menu && state.menu.kind === kind) { closeMenu(); return; }
  let items;
  if (kind === 'split-default' || kind === 'split-target') {
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
      ${m.items.map((o, i) => `<button data-mi="${i}" class="hvFill2" style="display:flex;align-items:center;gap:9px;padding:8px 9px;border:none;border-radius:9px;background:${o.check ? 'var(--accent-dim)' : 'transparent'};color:var(--text);font-size:12.5px;cursor:pointer;text-align:left;width:100%">
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
}
function closeMenu() { if (state.menu) { state.menu = null; $('menuMount').innerHTML = ''; } }

// =====================================================================================
// App 內告警視窗
// =====================================================================================
function renderAlert() {
  const a = state.alert;
  if (!a) { $('alertMount').innerHTML = ''; return; }
  const primary = a.kind === 'nohop' ? '編輯路由' : '知道了';
  $('alertMount').innerHTML = `
    <div id="alertOverlay" style="position:absolute;inset:0;background:rgba(0,0,0,.34);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:140">
      <div id="alertBox" style="width:356px;background:var(--panel);border:1px solid var(--sep);border-radius:16px;box-shadow:0 20px 50px rgba(0,0,0,.3);padding:22px;display:flex;flex-direction:column;align-items:center;gap:13px;text-align:center;animation:fadeUp .2s ease-out">
        <div style="width:44px;height:44px;border-radius:50%;background:rgba(217,83,74,.14);display:flex;align-items:center;justify-content:center;color:var(--red)">
          <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3.5 2.8 19.5h18.4L12 3.5z"></path><path d="M12 9.5v4.5M12 17h.01"></path></svg>
        </div>
        <span style="font-size:15.5px;font-weight:700;letter-spacing:-.2px">${esc(a.title)}</span>
        <span style="font-size:12.5px;color:var(--text2);line-height:1.7;text-wrap:pretty">${esc(a.body)}</span>
        <div style="display:flex;gap:9px;width:100%;padding-top:4px">
          <button id="alertCancel" class="hvFill2" style="flex:1;height:34px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap">取消</button>
          <button id="alertPrimary" class="hvBright" style="flex:1;height:34px;border:none;border-radius:9px;background:var(--accent);color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap">${primary}</button>
        </div>
      </div>
    </div>`;
  $('alertOverlay').onclick = e => { if (e.target === $('alertOverlay')) closeAlert(); };
  $('alertCancel').onclick = () => closeAlert();
  $('alertPrimary').onclick = () => alertAction();
}
function closeAlert() { state.alert = null; $('alertMount').innerHTML = ''; }
function alertAction() {
  const k = state.alert && state.alert.kind;
  closeAlert();
  if (k === 'nohop' || k === 'conflict') openRoute(state.sel);
}

// 斷線保護告警（分流引擎異常中止時彈出；不可用 Esc 關閉，必須選擇重連或停用）
function renderKillswitch() {
  const k = state.killswitch, m = $('ksMount'); if (!m) return;
  if (!k || !k.tripped) { m.innerHTML = ''; return; }
  const blockLine = k.blocking
    ? '受保護程式的網路已<strong>封鎖（fail-closed）</strong>，不會以真實 IP 外洩。'
    : '<strong style="color:var(--red)">block 模式未能啟動</strong>，受保護程式目前無 TUN 保護，請儘速重新連線或停用。';
  m.innerHTML = `
    <div style="position:absolute;inset:0;background:rgba(0,0,0,.42);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:150">
      <div style="width:384px;background:var(--panel);border:1px solid var(--red);border-radius:16px;box-shadow:0 20px 50px rgba(0,0,0,.34);padding:22px;display:flex;flex-direction:column;align-items:center;gap:13px;text-align:center;animation:fadeUp .2s ease-out">
        <div style="width:46px;height:46px;border-radius:50%;background:rgba(217,83,74,.16);display:flex;align-items:center;justify-content:center;color:var(--red)">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3.5 2.8 19.5h18.4L12 3.5z"></path><path d="M12 9.5v4.5M12 17h.01"></path></svg>
        </div>
        <span style="font-size:15.5px;font-weight:700;letter-spacing:-.2px">🛑 斷線保護已啟動</span>
        <span style="font-size:12.5px;color:var(--text2);line-height:1.7;text-wrap:pretty">${esc(k.reason || '分流引擎中止')}。<br>${blockLine}</span>
        <div style="display:flex;gap:9px;width:100%;padding-top:4px">
          <button id="ksClear" class="hvFill2" style="flex:1;height:34px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap">停用保護（恢復直連）</button>
          <button id="ksReconnect" class="hvBright" style="flex:1;height:34px;border:none;border-radius:9px;background:var(--accent);color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap">重新連線</button>
        </div>
      </div>
    </div>`;
  $('ksReconnect').onclick = async () => {
    const b = $('ksReconnect'); b.textContent = '重新連線中…'; b.disabled = true;
    try { const r = await window.api.killswitchReconnect(); if (!(r && r.ok)) { flash('重新連線失敗：' + ((r && r.error) || '未知'), 'var(--red)'); b.textContent = '重新連線'; b.disabled = false; } }
    catch (e) { flash('重新連線失敗：' + e.message, 'var(--red)'); b.textContent = '重新連線'; b.disabled = false; }
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
  const slim = { servers: servers.map(({ name, host, port, type, note }) => ({ name, host, port, type, note })), routes };
  const blob = new Blob([JSON.stringify(slim, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'proxy-config.json'; a.click();
  URL.revokeObjectURL(url);
  flash(`已匯出 ${servers.length} 台伺服器 · ${routes.length} 條路由`);
}
function importData() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const servers = Array.isArray(data) ? data : (data.servers || []);
      const routes = Array.isArray(data) ? [] : (data.routes || []);
      let ns = 0;
      for (const s of servers) { if (!s.host || !s.port) continue; await window.api.addServer({ name: s.name || s.host, host: s.host, port: s.port, type: s.type || 'socks5', username: s.username || '', password: s.password || '', note: s.note || '' }); ns++; }
      for (const r of routes) { if (r && r.id) await window.api.saveRoute(r); }
      state.servers = await window.api.getServers();
      state.routes = await window.api.getRoutes();
      if (!state.sel && state.routes[0]) state.sel = state.routes[0].id;
      renderSidebar(); showTab(state.tab);
      flash(`已匯入 ${ns} 台伺服器 · ${routes.length} 條路由`);
    } catch (err) { flash('匯入失敗：' + err.message, 'var(--red)'); }
  };
  input.click();
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

  if (window.api.onEngineStatus) window.api.onEngineStatus(st => { if (st) applyEngineStatus(st); });
  if (window.api.onKillswitch) window.api.onKillswitch(k => { if (k) { state.killswitch = k; renderKillswitch(); if (k.tripped) flash('🛑 斷線保護啟動：受保護程式已封鎖', 'var(--red)'); } });
  if (window.api.onUpdateStatus) window.api.onUpdateStatus(s => {
    if (!s) return;
    state.update = { status: s.status, version: s.version || state.update.version, percent: s.percent || 0 };
    refreshUpdateBtn();
    if (s.status === 'available') flash(`發現新版本 v${s.version}`);
    else if (s.status === 'downloaded') flash('更新已下載——點「重新啟動安裝」即可套用');
    else if (s.status === 'error') flash('更新檢查失敗：' + (s.error || ''), 'var(--amber)');
  });
  window.api.getKillswitch && window.api.getKillswitch().then(k => { if (k && k.tripped) { state.killswitch = k; renderKillswitch(); } }).catch(() => {});
  if (window.api.onEngineStats) window.api.onEngineStats(payload => {
    state.splitLive = (payload && Array.isArray(payload.live)) ? payload.live : [];
    if (state.tab === 'split') { updateSplitLive(); syncTitlebar(); }
  });
}

// =====================================================================================
// 分流（Split routing）分頁 — 照 Claude Design v3「Per-app 分流」一比一還原，接真實 IPC。
// 引擎（TUN）狀態機 off→starting→running；規則 = 應用程式 → 路由/直連。
// 骨架 buildSplit() 建一次（電源 SVG 常駐才能觸發 ring 過場）；updateSplit() 套動態值。
// =====================================================================================
const SPLIT_PALETTE = ['#4470c4', '#2f9e78', '#d98b1f', '#7a72cf', '#d9534a'];
const splitInitials = n => String(n == null ? '' : n).replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, '').slice(0, 2).toUpperCase();
const splitTint = n => SPLIT_PALETTE[String(n == null ? '' : n).length % SPLIT_PALETTE.length];
const splitRunning = () => state.splitEngine === 'running';
const splitRouteOf = id => state.routes.find(r => r.id === id);
const splitTargetLabel = id => id === 'direct' ? '直接連線（不經代理）' : (splitRouteOf(id) || {}).label || '（路由已刪除）';
const splitTargetBadge = id => id === 'direct' ? 'DIRECT' : (splitRouteOf(id) ? (splitRouteOf(id).kind === 'http' ? 'HTTP' : 'SOCKS5') : '—');
const splitTargetDot = id => id === 'direct' ? 'var(--text3)' : splitRunning() ? 'var(--good)' : 'var(--text3)';
// 真實 route 無 udp 能力欄位；依任務近似：只要 UDP 開啟且目標非直連即示警（上游 SOCKS5 可能不支援 UDP）。
const splitRouteUdpCapable = () => false;
const splitUdpIssue = target => state.splitUdp && target !== 'direct' && !!splitRouteOf(target) && !splitRouteUdpCapable(splitRouteOf(target));
const splitTrashIcon = pend => pend
  ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"></path></svg>'
  : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"></path></svg>';
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
  if (typeof st.apps === 'number') state.splitApps = st.apps;
  if (Array.isArray(st.health)) state.splitHealth = st.health;
  if (state.splitEngine !== 'running') state.splitLive = [];
  if (state.tab === 'split') updateSplit();
  if (state.tab === 'split') syncTitlebar();
}
async function refreshEngineStatus() {
  try { const st = await window.api.getEngineStatus(); if (st) applyEngineStatus(st); } catch {}
}

// ---- 標題列 / 新增按鈕（分頁感知）----
function syncSplitTitlebar() {
  const st = $('status'); if (!st) return;
  const running = splitRunning(), starting = state.splitEngine === 'starting';
  if (running) { st.textContent = `分流引擎執行中 · ${state.splitLive.length} 個程式`; st.style.color = 'var(--good)'; }
  else if (starting) { st.textContent = '正在啟動引擎…'; st.style.color = 'var(--amber)'; }
  else { st.textContent = '分流引擎未執行'; st.style.color = 'var(--text3)'; }
  $('markArc').setAttribute('stroke', running ? '#7fe3bd' : 'rgba(255,255,255,.55)');
}
function syncAddButton() {
  const b = $('btnAdd'); if (!b) return;
  const isSplit = state.tab === 'split';
  b.title = isSplit ? '新增規則 (Ctrl+N)' : '新增路由 (Ctrl+N)';
  b.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>${isSplit ? '新增規則' : '新增路由'}`;
}

// ---- 進入分頁 ----
function enterSplit() { updateSplit(); refreshSplit(); }
async function refreshSplit() {
  try { const sp = await window.api.getSplit(); if (sp) { if (Array.isArray(sp.rules)) state.splitRules = sp.rules; if (sp.defaultTarget != null) state.splitDefaultTarget = sp.defaultTarget; if (typeof sp.udp === 'boolean') state.splitUdp = sp.udp; } } catch {}
  try { const est = await window.api.getEngineStatus(); if (est) applyEngineStatus(est); } catch {}
  if (state.tab === 'split') { updateSplit(); syncTitlebar(); }
}

// ---- 骨架（建一次；電源 SVG + 標題/徽章/描述/統計 + 規則外流量/UDP 常駐）----
function buildSplit() {
  $('view-split').innerHTML = `
  <div style="display:flex;flex-direction:column;gap:14px;align-items:stretch">

    <div style="background:var(--card);border:1px solid var(--sep);border-radius:16px;padding:18px 20px;display:flex;flex-direction:column;gap:15px;flex-shrink:0">
      <div style="display:flex;align-items:center;gap:18px">
        <button id="spEngineBtn" title="啟動分流引擎" style="width:78px;height:78px;flex-shrink:0;position:relative;border:none;background:transparent;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center">
          <svg width="78" height="78" viewBox="0 0 256 256" style="position:absolute;inset:0">
            <circle cx="128" cy="128" r="92" fill="none" stroke="var(--fill2)" stroke-width="14"></circle>
            <g id="spEngineSpin" style="transform-origin:128px 128px;animation:none;opacity:0">
              <path d="M128 36 A92 92 0 0 1 220 128" fill="none" stroke="var(--accent)" stroke-width="14" stroke-linecap="round"></path>
            </g>
            <circle id="spEngineRing" cx="128" cy="128" r="92" fill="none" stroke="var(--accent)" stroke-width="14" stroke-linecap="round" stroke-dasharray="578" stroke-dashoffset="578" style="transform-origin:128px 128px;transform:rotate(-90deg);transition:stroke-dashoffset 1.1s cubic-bezier(.25,.5,.3,1),stroke .3s;opacity:0"></circle>
            <path id="spEngineIconLine" d="M100 118 h56 M128 96 v44 M108 150 h40" stroke="var(--text3)" stroke-width="0" fill="none"></path>
            <g id="spEngineIcon" style="color:var(--text3)">
              <path d="M92 100 h72 a8 8 0 0 1 8 8 v40 a8 8 0 0 1 -8 8 h-72 a8 8 0 0 1 -8 -8 v-40 a8 8 0 0 1 8 -8 z" fill="none" stroke="currentColor" stroke-width="11" stroke-linejoin="round"></path>
              <path d="M110 156 v14 M146 156 v14 M96 170 h64" fill="none" stroke="currentColor" stroke-width="11" stroke-linecap="round"></path>
            </g>
          </svg>
        </button>
        <div style="flex:1;display:flex;flex-direction:column;gap:7px;min-width:0">
          <div style="display:flex;align-items:center;gap:9px">
            <span id="spEngineTitle" style="font-size:19px;font-weight:700;letter-spacing:-.3px;white-space:nowrap">分流引擎未執行</span>
            <span id="spEngineBadge" style="font-size:9.5px;font-weight:700;letter-spacing:.4px;padding:3px 7px;border-radius:6px;background:rgba(217,139,31,.14);color:var(--amber);white-space:nowrap">需要提權</span>
          </div>
          <span id="spEngineDesc" style="font-size:12.5px;color:var(--text2);line-height:1.6;text-wrap:pretty">啟動後可強制指定程式走代理，無需程式本身支援 proxy 設定。</span>
          <div style="display:flex;align-items:center;gap:16px;font-size:11.5px;color:var(--text3);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;flex-wrap:wrap;row-gap:4px">
            <span id="spEngineDev" style="white-space:nowrap">dev: —</span>
            <span id="spEngineApps" style="white-space:nowrap">apps: 0</span>
            <span id="spEngineFlow" style="white-space:nowrap">rules: 0</span>
          </div>
        </div>
        <div style="width:1px;align-self:stretch;background:var(--sep)"></div>
        <div style="width:196px;flex-shrink:0;display:flex;flex-direction:column;gap:11px">
          <div style="display:flex;flex-direction:column;gap:5px">
            <span style="font-size:11px;font-weight:600;color:var(--text3);letter-spacing:.3px;white-space:nowrap">規則外流量</span>
            <button id="spDefaultBtn" class="hvFill2" style="display:flex;align-items:center;gap:7px;height:30px;padding:0 10px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12px;cursor:pointer;text-align:left">
              <span id="spDefaultDot" style="width:7px;height:7px;border-radius:50%;background:var(--text3);flex-shrink:0"></span>
              <span id="spDefaultLabel" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">直接連線（不經代理）</span>
              <span style="color:var(--text3);font-size:9px">▾</span>
            </button>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="flex:1;min-width:0"><div style="font-size:12px;font-weight:600;white-space:nowrap">UDP 轉發</div><div id="spUdpDesc" style="font-size:10.5px;color:var(--text2);margin-top:2px;line-height:1.4">僅轉發 TCP 流量</div></div>
            <button id="spUdpBtn" title="切換 UDP 轉發" style="width:44px;height:26px;border-radius:13px;border:none;padding:0;cursor:pointer;position:relative;background:var(--fill);transition:background .22s;flex-shrink:0;opacity:.55">
              <span id="spUdpKnob" style="position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .22s cubic-bezier(.32,.72,0,1)"></span>
            </button>
          </div>
        </div>
      </div>
      <div id="spNotice"></div>
    </div>

    <div style="display:flex;align-items:flex-end;gap:12px;flex-shrink:0">
      <div style="display:flex;flex-direction:column;gap:3px;min-width:0">
        <span style="font-size:15px;font-weight:700;letter-spacing:-.2px;white-space:nowrap">應用程式規則</span>
        <span style="font-size:11.5px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">由上往下比對，第一條命中的規則生效；拖曳可調整優先序</span>
      </div>
      <div id="spFilterSeg" style="margin-left:auto;display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:8px;flex-shrink:0"></div>
    </div>

    <div id="spRulesTable" style="background:var(--card);border:1px solid var(--sep);border-radius:16px;overflow:hidden;flex-shrink:0"></div>

    <div style="display:flex;gap:12px;flex-shrink:0">
      <div style="flex:1;background:var(--card);border:1px solid var(--sep);border-radius:16px;padding:15px 17px;display:flex;flex-direction:column;gap:11px;min-width:0">
        <div style="display:flex;align-items:center;gap:9px">
          <span style="font-size:13.5px;font-weight:600;white-space:nowrap">攔截中的程式</span>
          <span id="spLiveCount" style="font-size:11.5px;color:var(--text3);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;white-space:nowrap"></span>
        </div>
        <div id="spLiveList" style="display:flex;flex-direction:column;gap:11px"></div>
      </div>
      <div style="width:262px;flex-shrink:0;background:var(--card);border:1px solid var(--sep);border-radius:16px;padding:15px 17px;display:flex;flex-direction:column;gap:11px">
        <span style="font-size:13.5px;font-weight:600;white-space:nowrap">引擎健康</span>
        <div id="spHealthList" style="display:flex;flex-direction:column;gap:11px"></div>
      </div>
    </div>
  </div>`;

  $('spEngineBtn').onclick = () => toggleSplitEngine();
  $('spDefaultBtn').onclick = e => { e.stopPropagation(); openMenu('split-default', $('spDefaultBtn')); };
  $('spUdpBtn').onclick = () => toggleSplitUdp();
}

// ---- 動態值套用 ----
function updateSplit() {
  if (!$('spEngineBtn')) return;
  const running = state.splitEngine === 'running', starting = state.splitEngine === 'starting', elevated = state.splitElevated;
  const spin = $('spEngineSpin'); if (spin) { spin.style.animation = starting ? 'spinArc 1.1s cubic-bezier(.6,.05,.4,.95) infinite' : 'none'; spin.style.opacity = starting ? '1' : '0'; }
  const ring = $('spEngineRing'); if (ring) { ring.setAttribute('stroke', running ? 'var(--good)' : 'var(--accent)'); ring.setAttribute('stroke-dashoffset', String(running ? 0 : 578)); ring.style.opacity = running ? '1' : '0'; }
  const iconColor = running ? 'var(--good)' : starting ? 'var(--accent)' : 'var(--text3)';
  const ig = $('spEngineIcon'); if (ig) ig.style.color = iconColor;
  const il = $('spEngineIconLine'); if (il) il.setAttribute('stroke', iconColor);
  $('spEngineBtn').title = running ? '停止分流引擎' : '啟動分流引擎';
  $('spEngineTitle').textContent = running ? '分流引擎執行中' : starting ? '正在啟動…' : '分流引擎未執行';
  const badge = $('spEngineBadge');
  badge.textContent = running ? 'TUN 已建立' : starting ? '建立虛擬網卡' : elevated ? '已授權' : '需要提權';
  badge.style.background = running ? 'rgba(47,158,120,.14)' : starting ? 'rgba(217,139,31,.14)' : elevated ? 'var(--fill2)' : 'rgba(217,139,31,.14)';
  badge.style.color = running ? 'var(--good)' : starting ? 'var(--amber)' : elevated ? 'var(--text2)' : 'var(--amber)';
  $('spEngineDesc').textContent = running ? '已接管指定程式的連線；其餘流量不受影響。' : '啟動後可強制指定程式走代理，無需程式本身支援 proxy 設定。';
  const onRules = state.splitRules.filter(r => r.on).length;
  const liveN = running ? state.splitLive.length : 0;
  $('spEngineDev').textContent = running ? 'dev: ' + (state.splitTun || 'utun-cht0') : 'dev: —';
  $('spEngineApps').textContent = running ? 'apps: ' + liveN + '/' + onRules : 'apps: 0';
  $('spEngineFlow').textContent = running ? 'rules: ' + state.splitRules.length + ' · default: ' + (state.splitDefaultTarget === 'direct' ? 'direct' : 'proxy') : 'rules: ' + state.splitRules.length;
  $('spDefaultDot').style.background = splitTargetDot(state.splitDefaultTarget);
  $('spDefaultLabel').textContent = splitTargetLabel(state.splitDefaultTarget);
  const udp = state.splitUdp, udpBtn = $('spUdpBtn');
  udpBtn.style.background = udp ? 'var(--accent)' : 'var(--fill)';
  udpBtn.style.opacity = (running || elevated) ? '1' : '.55';
  $('spUdpKnob').style.left = udp ? '21px' : '3px';
  $('spUdpDesc').textContent = udp ? '含 QUIC / 遊戲流量' : '僅轉發 TCP 流量';
  renderSplitNotice();
  renderSplitFilter();
  renderSplitRules();
  updateSplitLive();
  renderSplitHealth();
}

function renderSplitNotice() {
  const el = $('spNotice'); if (!el) return;
  const running = splitRunning();
  const noUdpRoutes = state.splitRules.some(r => r.on && r.target !== 'direct' && splitRouteOf(r.target) && !splitRouteUdpCapable(splitRouteOf(r.target)));
  const shield = 'M12 3l7 3.5v5c0 4.2-2.9 7-7 8.5-4.1-1.5-7-4.3-7-8.5v-5L12 3z';
  const warn = 'M12 3.5 2.8 19.5h18.4L12 3.5zM12 9.5v4.5M12 17h.01';
  const info = 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8h.01M11 12h1v5h1';
  let notice = null;
  if (state.routes.length === 0) notice = { text: '尚未建立任何路由，規則的目標只能選「直接連線」，因此不會有流量被導向代理。請先到「總覽」新增一條路由（指定上游 proxy 或多跳串鏈），再回此頁把程式指向它。', bg: 'rgba(217,139,31,.12)', color: 'var(--amber)', icon: warn, action: '前往新增路由', go: () => { showTab('dashboard'); } };
  else if (!state.splitElevated && !running) notice = { text: '首次啟動需要系統管理員權限，用於建立虛擬網卡並注入路由表。整個過程只需同意一次。', bg: 'var(--accent-dim)', color: 'var(--accent)', icon: shield, action: '了解權限用途', go: () => { state.splitUac = true; renderSplitUac(); } };
  else if (running && state.splitUdp && noUdpRoutes) notice = { text: 'UDP 轉發已開啟，但部分規則指向的上游不支援 UDP（HTTP CONNECT 與 SOCKS4 僅支援 TCP），這些程式的 UDP 流量會自動回落為直連。', bg: 'rgba(217,139,31,.12)', color: 'var(--amber)', icon: warn, action: '', go: () => {} };
  else if (running) notice = { text: '引擎執行中：未列於規則的程式依「規則外流量」設定處理。停止引擎會立即還原系統路由表。', bg: 'var(--fill2)', color: 'var(--text3)', icon: info, action: '', go: () => {} };
  if (!notice) { el.innerHTML = ''; return; }
  el.innerHTML = `<div style="display:flex;align-items:flex-start;gap:9px;padding:11px 13px;background:${notice.bg};border-radius:11px;font-size:11.5px;color:var(--text2);line-height:1.65">
    <span style="flex-shrink:0;margin-top:1px;color:${notice.color}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${notice.icon}"></path></svg></span>
    <span style="flex:1;text-wrap:pretty">${esc(notice.text)}</span>
    ${notice.action ? `<button id="spNoticeGo" class="hvAccDim" style="flex-shrink:0;height:26px;padding:0 11px;border:1px solid var(--sep);border-radius:8px;background:var(--card);color:var(--accent);font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap">${esc(notice.action)}</button>` : ''}
  </div>`;
  if ($('spNoticeGo')) $('spNoticeGo').onclick = notice.go;
}

function renderSplitFilter() {
  const el = $('spFilterSeg'); if (!el) return;
  el.innerHTML = ['全部', '走代理', '直連'].map(f => `<button data-sfilter="${esc(f)}" style="border:none;cursor:pointer;height:27px;padding:0 11px;border-radius:6px;font-size:12px;white-space:nowrap;flex-shrink:0;${segCss(state.splitFilter === f)}">${f}</button>`).join('');
  el.querySelectorAll('[data-sfilter]').forEach(b => b.onclick = () => { state.splitFilter = b.dataset.sfilter; renderSplitFilter(); renderSplitRules(); });
}

function splitVisibleRules() {
  return state.splitRules.filter(r => state.splitFilter === '全部' || (state.splitFilter === '走代理' ? r.target !== 'direct' : r.target === 'direct'));
}

function renderSplitRules() {
  const el = $('spRulesTable'); if (!el) return;
  const running = splitRunning();
  const visible = splitVisibleRules();
  const header = `<div style="display:flex;align-items:center;padding:9px 16px;border-bottom:1px solid var(--sep);font-size:11px;color:var(--text3);font-weight:600;letter-spacing:.3px">
    <span style="width:26px;flex-shrink:0"></span>
    <span style="width:224px;flex-shrink:0;white-space:nowrap">應用程式</span>
    <span style="width:92px;flex-shrink:0;white-space:nowrap">比對方式</span>
    <span style="flex:1;min-width:0;white-space:nowrap">流量走向</span>
    <span style="width:96px;flex-shrink:0;white-space:nowrap;text-align:right">即時流量</span>
    <span style="width:96px;flex-shrink:0"></span>
  </div>`;
  const rowsHtml = visible.map(r => {
    const pend = state.splitPendingDel === r.id, on = !!r.on;
    const exe = r.match === 'path' ? (String(r.path || '').split('\\').slice(-2).join('\\') || r.exe) : r.exe;
    const fullPath = r.path || r.exe;
    const iconBg = splitTint(r.name) + '22', iconColor = splitTint(r.name);
    const matchLabel = r.match === 'path' ? '完整路徑' : '程式名稱';
    const targetLabel = splitTargetLabel(r.target), targetColor = on ? 'var(--text)' : 'var(--text3)';
    const dot = !on ? 'var(--text3)' : r.target === 'direct' ? 'var(--text2)' : running ? 'var(--good)' : 'var(--text3)';
    const dotAnim = on && running && r.target !== 'direct' ? 'dotBeat 2.2s ease-in-out infinite' : 'none';
    const udpWarn = (on && splitUdpIssue(r.target)) ? '此路由的上游不支援 UDP，該程式的 UDP 流量會回落為直連' : '';
    const liveMatch = running ? state.splitLive.find(l => l.name === r.name) : null;
    const flow = (liveMatch && liveMatch.rate) ? liveMatch.rate : '—';
    const flowColor = (liveMatch && liveMatch.rate) ? 'var(--text2)' : 'var(--text3)';
    const rowBg = on ? 'transparent' : 'var(--fill2)';
    const onBg = on ? 'var(--accent)' : 'var(--fill)', knob = on ? '19px' : '3px';
    const enableTip = on ? '停用此規則' : '啟用此規則';
    const delTip = pend ? '再按一次確認刪除' : '刪除規則', delBg = pend ? 'var(--red)' : 'var(--fill2)', delColor = pend ? '#fff' : 'var(--red)';
    return `<div data-srid="${esc(r.id)}" draggable="true" class="hvFill2" style="display:flex;align-items:center;padding:10px 16px;border-bottom:1px solid var(--sep);font-size:12.5px;background:${rowBg};cursor:grab">
      <span style="width:26px;flex-shrink:0;display:flex;align-items:center;color:var(--text3)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 7h.01M8 12h.01M8 17h.01M16 7h.01M16 12h.01M16 17h.01"></path></svg></span>
      <span style="width:224px;flex-shrink:0;padding-right:10px;box-sizing:border-box;display:flex;align-items:center;gap:9px;min-width:0">
        <span style="width:26px;height:26px;flex-shrink:0;border-radius:7px;background:${iconBg};color:${iconColor};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700">${esc(splitInitials(r.name))}</span>
        <span style="display:flex;flex-direction:column;min-width:0;gap:1px">
          <span style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.name)}</span>
          <span title="${esc(fullPath)}" style="font-size:10.5px;color:var(--text3);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(exe)}</span>
        </span>
      </span>
      <span style="width:92px;flex-shrink:0;padding-right:10px;box-sizing:border-box"><span style="font-size:9.5px;font-weight:700;letter-spacing:.3px;padding:2px 6px;border-radius:5px;background:var(--fill2);color:var(--text2);white-space:nowrap">${matchLabel}</span></span>
      <span style="flex:1;min-width:0;padding-right:10px;box-sizing:border-box;display:flex;align-items:center;gap:7px">
        <span style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${dot};animation:${dotAnim}"></span>
        <span title="${esc(targetLabel)}" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${targetColor}">${esc(targetLabel)}</span>
        ${udpWarn ? `<span title="${esc(udpWarn)}" style="flex-shrink:0;display:flex;color:var(--amber)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3.5 2.8 19.5h18.4L12 3.5z"></path><path d="M12 9.5v4.5M12 17h.01"></path></svg></span>` : ''}
      </span>
      <span style="width:96px;flex-shrink:0;text-align:right;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:11.5px;color:${flowColor};white-space:nowrap">${esc(flow)}</span>
      <span style="width:96px;flex-shrink:0;display:flex;justify-content:flex-end;gap:6px">
        <button data-sact="toggle" title="${enableTip}" style="width:40px;height:24px;border-radius:12px;border:none;padding:0;cursor:pointer;position:relative;background:${onBg};transition:background .22s;flex-shrink:0"><span style="position:absolute;top:3px;left:${knob};width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .22s cubic-bezier(.32,.72,0,1)"></span></button>
        <button data-sact="edit" class="hvAcc" title="編輯規則" style="width:26px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h4L20 8l-4-4L4 16v4z"></path></svg></button>
        <button data-sact="del" class="hvRed" title="${delTip}" style="width:26px;height:26px;border:none;border-radius:7px;background:${delBg};color:${delColor};cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0">${splitTrashIcon(pend)}</button>
      </span>
    </div>`;
  }).join('');
  const defaultRow = `<div style="display:flex;align-items:center;padding:10px 16px;font-size:12.5px;background:var(--fill2)">
    <span style="width:26px;flex-shrink:0"></span>
    <span style="width:224px;flex-shrink:0;display:flex;align-items:center;gap:9px;color:var(--text2)">
      <span style="width:26px;height:26px;flex-shrink:0;border-radius:7px;background:var(--fill2);color:var(--text3);display:flex;align-items:center;justify-content:center"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 12h16M12 4v16"></path></svg></span>
      <span style="font-weight:600;white-space:nowrap">其他所有程式</span>
    </span>
    <span style="width:92px;flex-shrink:0"><span style="font-size:9.5px;font-weight:700;letter-spacing:.3px;padding:2px 6px;border-radius:5px;background:var(--fill);color:var(--text2);white-space:nowrap">預設</span></span>
    <span style="flex:1;min-width:0;display:flex;align-items:center;gap:7px;color:var(--text2)">
      <span style="width:7px;height:7px;border-radius:50%;background:${splitTargetDot(state.splitDefaultTarget)};flex-shrink:0"></span>
      <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(splitTargetLabel(state.splitDefaultTarget))}</span>
    </span>
    <span style="width:96px;flex-shrink:0;text-align:right;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:11.5px;color:var(--text3);white-space:nowrap">—</span>
    <span style="width:96px;flex-shrink:0;display:flex;justify-content:flex-end"><button id="spDefaultChange" class="hvAccDim" style="height:26px;padding:0 11px;border:1px solid var(--sep);border-radius:8px;background:var(--card);color:var(--accent);font-size:11.5px;font-weight:500;cursor:pointer;white-space:nowrap">變更</button></span>
  </div>`;
  const empty = visible.length === 0 ? `<div style="padding:40px 20px;text-align:center;color:var(--text3);font-size:12.5px;line-height:1.8">尚無應用程式規則<br>所有流量都依「其他所有程式」的預設走向處理</div>` : '';
  el.innerHTML = header + rowsHtml + defaultRow + empty;
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
    row.querySelector('[data-sact="toggle"]').onclick = e => { e.stopPropagation(); state.splitRules = state.splitRules.map(x => x.id === rid ? { ...x, on: !x.on } : x); updateSplit(); persistSplit({ rules: state.splitRules }); };
    row.querySelector('[data-sact="edit"]').onclick = e => { e.stopPropagation(); openSplitSheet(rid); };
    row.querySelector('[data-sact="del"]').onclick = e => { e.stopPropagation(); splitDeleteRule(rid); };
  });
  if ($('spDefaultChange')) $('spDefaultChange').onclick = e => { e.stopPropagation(); openMenu('split-default', $('spDefaultChange')); };
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

function updateSplitLive() {
  const running = splitRunning();
  const live = running ? state.splitLive : [];
  if ($('spLiveCount')) $('spLiveCount').textContent = running ? live.length + ' 個程式' : '';
  const listEl = $('spLiveList'); if (!listEl) return;
  if (!running || live.length === 0) {
    listEl.innerHTML = `<div style="padding:16px 0;text-align:center;color:var(--text3);font-size:11.5px">引擎未執行 · 尚無攔截中的程式</div>`;
    return;
  }
  const maxBytes = Math.max(1, ...live.map(l => Number(l.bytes) || 0));
  listEl.innerHTML = live.map((l, i) => {
    const name = l.name || '';
    const initials = l.initials || splitInitials(name);
    const iconBg = splitTint(name) + '22', iconColor = splitTint(name);
    const pct = Math.max(6, Math.min(100, Math.round(((Number(l.bytes) || 0) / maxBytes) * 100)));
    const barColor = i % 2 ? 'var(--purple)' : 'var(--good)';
    return `<div style="display:flex;align-items:center;gap:10px;font-size:12px">
      <span style="width:22px;height:22px;flex-shrink:0;border-radius:6px;background:${iconBg};color:${iconColor};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700">${esc(initials)}</span>
      <span style="width:104px;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500">${esc(name)}</span>
      <span style="flex:1;min-width:0;height:6px;border-radius:3px;background:var(--fill2);position:relative;overflow:hidden">
        <span style="position:absolute;inset:0 auto 0 0;width:${pct}%;background:${barColor};border-radius:3px;transition:width .3s linear"></span>
      </span>
      <span style="width:74px;flex-shrink:0;text-align:right;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:11px;color:var(--text2);white-space:nowrap">${esc(l.rate || '')}</span>
    </div>`;
  }).join('');
}

function splitHealthData() {
  if (Array.isArray(state.splitHealth) && state.splitHealth.length) return state.splitHealth;
  const running = splitRunning(), udp = state.splitUdp, elevated = state.splitElevated;
  return running ? [
    { label: '虛擬網卡 (TUN)', value: state.splitTun || 'utun-cht0', dot: 'var(--good)', color: 'var(--text2)' },
    { label: '路由表注入', value: '正常', dot: 'var(--good)', color: 'var(--good)' },
    { label: '規則命中率', value: '—', dot: 'var(--good)', color: 'var(--text2)' },
    { label: 'UDP 轉發', value: udp ? '啟用' : '停用', dot: udp ? 'var(--good)' : 'var(--text3)', color: 'var(--text2)' },
    { label: 'DNS 攔截', value: '127.0.0.1:53', dot: 'var(--good)', color: 'var(--text2)' },
  ] : [
    { label: '虛擬網卡 (TUN)', value: '未建立', dot: 'var(--text3)', color: 'var(--text3)' },
    { label: '路由表注入', value: '—', dot: 'var(--text3)', color: 'var(--text3)' },
    { label: '提權狀態', value: elevated ? '已授權' : '未授權', dot: elevated ? 'var(--good)' : 'var(--amber)', color: elevated ? 'var(--good)' : 'var(--amber)' },
    { label: 'UDP 轉發', value: udp ? '啟用' : '停用', dot: 'var(--text3)', color: 'var(--text3)' },
  ];
}

function renderSplitHealth() {
  const el = $('spHealthList'); if (!el) return;
  el.innerHTML = splitHealthData().map(h => `<div style="display:flex;align-items:center;gap:9px;font-size:12px">
    <span style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${splitDotColor(h.dot)}"></span>
    <span style="flex:1;min-width:0;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(h.label)}</span>
    <span style="flex-shrink:0;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:11px;color:${h.color || 'var(--text2)'};white-space:nowrap">${esc(h.value)}</span>
  </div>`).join('');
}

// ---- 引擎電源狀態機（engineStart / engineStop / needElevation → UAC）----
async function toggleSplitEngine() {
  if (state.splitEngine === 'running' || state.splitEngine === 'starting') {
    try { await window.api.engineStop(); } catch {}
    state.splitEngine = 'off'; state.splitLive = [];
    updateSplit(); syncTitlebar();
    flash('引擎已停止，系統路由表已還原');
    refreshEngineStatus();
    return;
  }
  attemptSplitEngineStart();
}
async function attemptSplitEngineStart() {
  state.splitEngine = 'starting';
  updateSplit(); syncTitlebar();
  let res;
  try { res = await window.api.engineStart(); }
  catch (e) { res = { ok: false, error: (e && e.message) || String(e) }; }
  if (res && res.ok) {
    state.splitEngine = 'running';
    await refreshEngineStatus();
    if (state.splitEngine !== 'running') state.splitEngine = 'running';
    updateSplit(); syncTitlebar();
    flash('分流引擎已啟動');
  } else if (res && res.needElevation) {
    state.splitEngine = 'off';
    state.splitUac = true;
    updateSplit(); syncTitlebar();
    renderSplitUac();
  } else {
    state.splitEngine = 'off';
    updateSplit(); syncTitlebar();
    flash((res && (res.error || res.message)) || '引擎啟動失敗', 'var(--red)');
  }
}
async function grantSplitUac() {
  state.splitUac = false; state.splitUacSeen = true;
  closeSplitUac();
  // app 用 asInvoker 正常啟動；建 TUN 需提權 → 請求以系統管理員身分重啟。
  // 只有提權被接受時 app 才會關閉並以系管員重啟；被拒/被擋則留在原地顯示錯誤（不 crash）。
  state.splitEngine = 'starting';
  updateSplit(); syncTitlebar();
  flash('正在請求系統管理員權限…');
  let r;
  try { r = window.api.engineElevate ? await window.api.engineElevate() : { ok: false, error: '此版本不支援提權' }; }
  catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
  if (!r || !r.ok) {
    state.splitEngine = 'off';
    updateSplit(); syncTitlebar();
    flash((r && r.error) || '提權失敗，分流引擎未啟動', 'var(--red)');
  }
  // r.ok → app 會以系管員重啟並自動開引擎，這裡不需再處理
}
function toggleSplitUdp() {
  state.splitUdp = !state.splitUdp;
  updateSplit();
  persistSplit({ udp: state.splitUdp });
  flash(state.splitUdp ? 'UDP 轉發已啟用' : 'UDP 轉發已停用');
}

// ---- 持久化（saveSplit）----
async function persistSplit(patch) {
  try {
    const merged = await window.api.saveSplit(patch);
    if (merged) {
      if (Array.isArray(merged.rules)) state.splitRules = merged.rules;
      if (merged.defaultTarget != null) state.splitDefaultTarget = merged.defaultTarget;
      if (typeof merged.udp === 'boolean') state.splitUdp = merged.udp;
      if (state.tab === 'split') updateSplit();
    }
  } catch {}
}

// ---- 規則外流量 / 目標路由 下拉（接 openMenu）----
function splitMenuItems(kind) {
  const isDefault = kind === 'split-default';
  const cur = isDefault ? state.splitDefaultTarget : state.splitDraft.target;
  const opts = [{ id: 'direct', label: '直接連線（不經代理）' }, ...state.routes.map(r => ({ id: r.id, label: r.label }))];
  return opts.map(o => ({
    label: o.label, badge: splitTargetBadge(o.id), dot: splitTargetDot(o.id), check: cur === o.id,
    pick: () => {
      if (isDefault) { state.splitDefaultTarget = o.id; closeMenu(); updateSplit(); persistSplit({ defaultTarget: o.id }); flash('已更新規則外流量走向'); }
      else { state.splitDraft = { ...state.splitDraft, target: o.id }; closeMenu(); renderSplitSheet(); }
    },
  }));
}

// ---- 規則編輯面板（右側滑入 470px）----
function openSplitSheet(id) {
  const r = id ? state.splitRules.find(x => x.id === id) : null;
  state.splitSheet = true; state.splitEditing = id || null; closeMenu();
  state.splitPickMode = r ? '手動輸入' : '執行中的程式';
  state.splitMatchMode = r ? (r.match === 'path' ? '完整路徑' : '程式名稱') : '程式名稱';
  state.splitProcSearch = '';
  const defTarget = state.routes[0] ? state.routes[0].id : 'direct';
  state.splitDraft = r ? { name: r.name, exe: r.exe, path: r.path, pattern: r.exe, target: r.target, match: r.match }
                       : { name: '', exe: '', path: '', pattern: '', target: defTarget, match: 'name' };
  renderSplitSheet();
  loadSplitProcs();
}
function closeSplitSheet() { state.splitSheet = false; closeMenu(); $('splitSheetMount').innerHTML = ''; }
async function loadSplitProcs() {
  try { const list = await window.api.listProcesses(); if (Array.isArray(list)) state.splitProcs = list; } catch {}
  if (state.splitSheet && state.splitPickMode === '執行中的程式') renderSplitProcList();
}
function syncSplitDraft() {
  const d = state.splitDraft;
  if ($('spDraftName')) d.name = $('spDraftName').value;
  if ($('spDraftPath')) d.path = $('spDraftPath').value;
  if ($('spDraftPattern')) d.pattern = $('spDraftPattern').value;
  if ($('spProcSearch')) state.splitProcSearch = $('spProcSearch').value;
}
function splitDraftJson() {
  const d = state.splitDraft;
  const value = d.match === 'path' ? (d.path || '') : (d.pattern || d.exe || '');
  return '{ "id": "' + (state.splitEditing || 'ru-new') + '", "name": "' + (d.name || '未命名') + '", "match": "' + d.match + '", "value": "' + value + '", "target": "' + d.target + '", "enabled": true }';
}
function updateSplitJson() { const el = $('spDraftJson'); if (el) el.textContent = splitDraftJson(); }

function renderSplitSheet() {
  if (!state.splitSheet) { $('splitSheetMount').innerHTML = ''; return; }
  const d = state.splitDraft;
  const scrollTop = $('spSheetBody') ? $('spSheetBody').scrollTop : 0;
  const isRunningPick = state.splitPickMode === '執行中的程式';
  const isBrowsePick = state.splitPickMode === '瀏覽檔案';
  const isManualPick = state.splitPickMode === '手動輸入';
  const draftTargetLabel = splitTargetLabel(d.target), draftTargetBadge = splitTargetBadge(d.target), draftTargetDot = splitTargetDot(d.target);
  const draftRt = splitRouteOf(d.target);
  const draftUdpWarn = (state.splitUdp && draftRt && !splitRouteUdpCapable(draftRt)) ? '「' + draftRt.label + '」的上游為 ' + (draftRt.kind === 'http' ? 'HTTP CONNECT' : 'SOCKS') + '，不支援 UDP；此程式的 UDP 流量將回落為直連。' : '';
  const pickSeg = ['執行中的程式', '瀏覽檔案', '手動輸入'].map(m => `<button data-spick="${esc(m)}" style="flex:1;border:none;cursor:pointer;height:30px;border-radius:7px;font-size:12px;white-space:nowrap;${segCss(state.splitPickMode === m)}">${m}</button>`).join('');
  const matchSeg = ['程式名稱', '完整路徑'].map(m => `<button data-smatch="${esc(m)}" style="flex:1;border:none;cursor:pointer;height:30px;border-radius:7px;font-size:12px;white-space:nowrap;${segCss(state.splitMatchMode === m)}">${m}</button>`).join('');

  $('splitSheetMount').innerHTML = `
    <div id="spSheetOverlay" style="position:absolute;inset:0;background:rgba(0,0,0,.28);display:flex;justify-content:flex-end;z-index:60">
      <div id="spSheetPanel" style="width:470px;height:100%;background:var(--panel);border-left:1px solid var(--sep);box-shadow:-12px 0 40px rgba(0,0,0,.18);display:flex;flex-direction:column;animation:sheetIn .26s cubic-bezier(.32,.72,0,1)">
        <div style="padding:16px 20px;border-bottom:1px solid var(--sep);display:flex;align-items:center">
          <span style="font-size:15px;font-weight:700;letter-spacing:-.2px;white-space:nowrap">${state.splitEditing ? '編輯規則' : '新增應用程式規則'}</span>
          <button id="spSheetClose" class="hvFill" title="關閉面板" style="margin-left:auto;width:26px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="11" height="11" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.6"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5"></line><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"></line></svg></button>
        </div>
        <div id="spSheetBody" style="flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:16px">
          <div style="display:flex;flex-direction:column;gap:8px">
            <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">選擇程式</span>
            <div style="display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:9px">${pickSeg}</div>
          </div>
          ${isRunningPick ? `<div style="display:flex;flex-direction:column;gap:8px">
            <div style="display:flex;gap:8px;align-items:center">
              <input id="spProcSearch" value="${esc(state.splitProcSearch)}" placeholder="搜尋執行中的程式…" style="flex:1;min-width:0;height:32px;padding:0 11px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12.5px;outline:none">
              <button id="spProcRefresh" class="hvFill2" title="重新整理清單" style="width:32px;height:32px;flex-shrink:0;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4"></path></svg></button>
            </div>
            <div id="spProcList" style="border:1px solid var(--sep);border-radius:11px;max-height:196px;overflow-y:auto;background:var(--bg)"></div>
          </div>` : ''}
          ${isBrowsePick ? `<div style="display:flex;flex-direction:column;gap:8px">
            <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">執行檔路徑</span>
            <div style="display:flex;gap:8px">
              <input id="spDraftPath" value="${esc(d.path)}" placeholder="C:\\Program Files\\App\\app.exe" style="flex:1;min-width:0;height:34px;padding:0 11px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12px;outline:none">
              <button id="spBrowseExe" class="hvFill2" style="flex-shrink:0;height:34px;padding:0 13px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap">瀏覽…</button>
            </div>
            <span style="font-size:11px;color:var(--text3);line-height:1.55">選擇 .exe 後會自動填入程式名稱；勾選「完整路徑比對」可避免同名程式誤命中。</span>
          </div>` : ''}
          ${isManualPick ? `<div style="display:flex;flex-direction:column;gap:8px">
            <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">程式名稱或樣式</span>
            <input id="spDraftPattern" value="${esc(d.pattern)}" placeholder="例如 chrome.exe 或 *\\Steam\\*" style="height:34px;padding:0 11px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12px;outline:none">
            <span style="font-size:11px;color:var(--text3);line-height:1.55">支援 * 通用字元，適合整個資料夾或多個執行檔共用一條規則。</span>
          </div>` : ''}
          <div style="display:flex;flex-direction:column;gap:7px">
            <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">顯示名稱</span>
            <input id="spDraftName" value="${esc(d.name)}" placeholder="例如 Chrome" style="height:34px;padding:0 11px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:13px;outline:none">
          </div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">比對方式</span>
            <div style="display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:9px">${matchSeg}</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">流量走向</span>
            <button id="spTargetBtn" class="hvFill2" style="display:flex;align-items:center;gap:9px;height:36px;padding:0 11px;border:1px solid var(--sep);border-radius:10px;background:var(--bg);color:var(--text);font-size:12.5px;cursor:pointer;text-align:left">
              <span style="width:7px;height:7px;border-radius:50%;background:${draftTargetDot};flex-shrink:0"></span>
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(draftTargetLabel)}</span>
              <span style="font-size:9.5px;font-weight:700;letter-spacing:.3px;padding:2px 6px;border-radius:5px;background:var(--fill2);color:var(--text2);flex-shrink:0;white-space:nowrap">${draftTargetBadge}</span>
              <span style="color:var(--text3);font-size:9px">▾</span>
            </button>
            ${draftUdpWarn ? `<span style="display:flex;align-items:flex-start;gap:7px;font-size:11px;color:var(--amber);line-height:1.55"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="flex-shrink:0;margin-top:1px"><path d="M12 3.5 2.8 19.5h18.4L12 3.5z"></path><path d="M12 9.5v4.5M12 17h.01"></path></svg><span style="flex:1;text-wrap:pretty">${esc(draftUdpWarn)}</span></span>` : ''}
          </div>
          <div style="background:var(--fill2);border-radius:12px;padding:13px 15px;display:flex;flex-direction:column;gap:7px">
            <span style="font-size:11px;font-weight:600;color:var(--text3);letter-spacing:.3px;white-space:nowrap">對應 config.json</span>
            <span id="spDraftJson" style="font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:11px;color:var(--text2);line-height:1.7;word-break:break-all;user-select:text">${esc(splitDraftJson())}</span>
          </div>
        </div>
        <div style="padding:14px 20px;border-top:1px solid var(--sep);display:flex;align-items:center;gap:10px">
          <span style="font-size:11.5px;color:var(--text3);flex:1;min-width:0">儲存後立即生效，無需重啟引擎</span>
          <button id="spSheetCancel" class="hvFill2" style="height:32px;padding:0 16px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap">取消</button>
          <button id="spSheetSave" class="hvBright" style="height:32px;padding:0 18px;border:none;border-radius:9px;background:var(--accent);color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap">儲存規則</button>
        </div>
      </div>
    </div>`;

  $('spSheetOverlay').onclick = e => { if (e.target === $('spSheetOverlay')) closeSplitSheet(); };
  $('spSheetClose').onclick = () => closeSplitSheet();
  $('spSheetCancel').onclick = () => closeSplitSheet();
  $('spSheetSave').onclick = () => saveSplitRule();
  $('splitSheetMount').querySelectorAll('[data-spick]').forEach(b => b.onclick = () => { syncSplitDraft(); state.splitPickMode = b.dataset.spick; renderSplitSheet(); if (b.dataset.spick === '執行中的程式') loadSplitProcs(); });
  $('splitSheetMount').querySelectorAll('[data-smatch]').forEach(b => b.onclick = () => { syncSplitDraft(); state.splitMatchMode = b.dataset.smatch; state.splitDraft.match = b.dataset.smatch === '完整路徑' ? 'path' : 'name'; renderSplitSheet(); });
  $('spTargetBtn').onclick = e => { e.stopPropagation(); syncSplitDraft(); openMenu('split-target', $('spTargetBtn')); };
  if ($('spDraftName')) $('spDraftName').addEventListener('input', e => { state.splitDraft.name = e.target.value; updateSplitJson(); });
  if ($('spDraftPath')) $('spDraftPath').addEventListener('input', e => { state.splitDraft.path = e.target.value; updateSplitJson(); });
  if ($('spDraftPattern')) $('spDraftPattern').addEventListener('input', e => { state.splitDraft.pattern = e.target.value; updateSplitJson(); });
  if ($('spProcSearch')) $('spProcSearch').addEventListener('input', e => { state.splitProcSearch = e.target.value; renderSplitProcList(); });
  if ($('spProcRefresh')) $('spProcRefresh').onclick = async () => { await loadSplitProcs(); flash('已重新讀取程式清單'); };
  if ($('spBrowseExe')) $('spBrowseExe').onclick = () => splitBrowseExe();
  if (isRunningPick) renderSplitProcList();
  if ($('spSheetBody')) $('spSheetBody').scrollTop = scrollTop;
}

function renderSplitProcList() {
  const el = $('spProcList'); if (!el) return;
  const d = state.splitDraft;
  const q = (state.splitProcSearch || '').toLowerCase();
  const procs = state.splitProcs.filter(p => !q || ((p.name || '') + (p.path || '')).toLowerCase().includes(q));
  if (procs.length === 0) {
    el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text3);font-size:11.5px">${state.splitProcs.length ? '沒有符合的程式' : '讀取中…'}</div>`;
    return;
  }
  el.innerHTML = procs.map(p => {
    const iconBg = splitTint(p.name) + '22', iconColor = splitTint(p.name);
    const checked = d.path === p.path;
    return `<button data-sproc="${esc(p.path)}" class="hvFill2" style="width:100%;display:flex;align-items:center;gap:9px;padding:9px 11px;border:none;border-bottom:1px solid var(--sep);background:${checked ? 'var(--accent-dim)' : 'transparent'};color:var(--text);cursor:pointer;text-align:left">
      <span style="width:24px;height:24px;flex-shrink:0;border-radius:6px;background:${iconBg};color:${iconColor};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700">${esc(splitInitials(p.name))}</span>
      <span style="display:flex;flex-direction:column;min-width:0;flex:1;gap:1px">
        <span style="font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</span>
        <span style="font-size:10.5px;color:var(--text3);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.path)}</span>
      </span>
      <span style="flex-shrink:0;font-size:10.5px;color:var(--text3);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;white-space:nowrap">PID ${esc(String(p.pid))}</span>
      <span style="width:12px;flex-shrink:0;color:var(--accent);font-size:11px">${checked ? '✓' : ''}</span>
    </button>`;
  }).join('');
  el.querySelectorAll('[data-sproc]').forEach(b => b.onclick = () => {
    const p = state.splitProcs.find(x => x.path === b.dataset.sproc); if (!p) return;
    state.splitDraft = { ...state.splitDraft, name: p.name, path: p.path, exe: String(p.path).split('\\').pop().toLowerCase() };
    const nameEl = $('spDraftName'); if (nameEl) nameEl.value = state.splitDraft.name;
    renderSplitProcList(); updateSplitJson();
  });
}

async function splitBrowseExe() {
  syncSplitDraft();
  try {
    const res = await window.api.browseExe();
    if (res && res.path) {
      const base = String(res.path).split('\\').pop();
      state.splitDraft = { ...state.splitDraft, name: res.name || state.splitDraft.name || base, path: res.path, exe: base.toLowerCase() };
      renderSplitSheet();
      flash('已選擇 ' + base);
    }
  } catch {}
}

async function saveSplitRule() {
  syncSplitDraft();
  const d = state.splitDraft, editing = state.splitEditing;
  const id = editing || 'ru' + Date.now();
  const rec = { id, name: d.name || '未命名程式', exe: (d.pattern || d.exe || 'app.exe'), path: d.path || '', match: d.match, target: d.target, on: true };
  state.splitRules = editing ? state.splitRules.map(r => r.id === id ? rec : r) : [...state.splitRules, rec];
  closeSplitSheet();
  updateSplit();
  persistSplit({ rules: state.splitRules });
  flash(editing ? '規則已更新' : '已新增規則');
}

// ---- UAC 提權說明視窗 ----
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



