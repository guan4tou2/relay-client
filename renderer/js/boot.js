'use strict';
// 開機：載入資料、接上主行程推來的事件，最後呼叫 boot()。一定要最後載入。
// renderer 的各檔都是一般 <script>（不是 module），最外層的宣告在各檔之間共用；載入順序見 index.html。

// =====================================================================================
// 開機
// =====================================================================================
// 開機各段的時間點。留著不是為了好玩：啟動慢起來的時候，沒有這個就只能猜
// 「是 renderer 慢還是主行程慢」。只寫幾個數字，成本可以忽略。
/** @type {Record<string, number>} */
const bootMarks = (window.__boot = {});
const mark = (k) => { bootMarks[k] = Math.round(performance.now()); };

async function boot() {
  mark('start');
  setTheme(localStorage.getItem('proxy_theme') || '系統');
  mount();
  mark('mounted');

  // 這些 IPC 彼此不相干，一個一個 await 的話延遲是相加的 —— 原本九個排隊，
  // 而且要全部回來才畫第一個畫面。分兩批：畫面需要的先併發拿，其餘的後補。
  const settle = (p, fallback) => p.then(v => v, () => fallback);
  const timed = (name, p, fallback) => {
    const t = performance.now();
    return p.then(v => v, () => fallback).then(v => { bootMarks['ipc_' + name] = Math.round(performance.now() - t); return v; });
  };

  mark('coreStart');
  // 判斷「等 IPC 的那段時間」是誰被卡住：這個 50ms 的計時器若準時觸發，
  // renderer 的執行緒是空的（問題在主行程那邊）；若延到跟 IPC 一樣晚，就是 renderer 自己忙。
  const tickT0 = performance.now();
  setTimeout(() => { bootMarks.tick50 = Math.round(performance.now() - tickT0); }, 50);
  const [s, servers, routes, routeStatus] = await Promise.all([
    timed('settings', window.api.getSettings(), null),
    timed('servers', window.api.getServers(), []),
    timed('routes', window.api.getRoutes(), []),
    timed('routeStatus', window.api.getRouteStatus(), []),
  ]);
  if (s) state.settings = { ...state.settings, ...s };
  state.servers = servers || [];
  state.routes = routes || [];
  (routeStatus || []).forEach(r => { if (r.running) setSes(r.id, { status: 'running', prog: 1, startTs: Date.now(), series: [], upT: 0, downT: 0, conns: 0, uptime: 0, _pu: 0, _pd: 0 }); });
  if (!state.sel && state.routes[0]) state.sel = state.routes[0].id;
  mark('coreLoaded');

  // 畫面先出來。下面那批（紀錄、分流規則、引擎狀態、瀏覽器、實例）都不是
  // 首屏需要的東西，讓它們在背景補，不要讓使用者多盯著空白視窗。
  renderSidebar();
  showTab('dashboard');
  refreshSettings();
  syncTitlebar();
  mark('firstPaint');

  Promise.all([
    settle(window.api.getLogs(), []),
    settle(window.api.getSplit(), null),
    settle(window.api.getEngineStatus(), null),
    settle(window.api.browserInfo(), null),
    settle(window.api.listInstances(), []),
    settle(loadCreds(), null),
  ]).then(([logs, sp, est, browser, instances]) => {
    state.logs = (logs || []).map(l => ({ ...l, id: ++logSeq }));
    if (sp) {
      if (Array.isArray(sp.rules)) state.splitRules = sp.rules;
      if (sp.defaultTarget != null) state.splitDefaultTarget = sp.defaultTarget;
      if (typeof sp.udp === 'boolean') state.splitUdp = sp.udp;
    }
    if (est) applyEngineStatus(est);
    state.browser = browser || null;
    state.instances = instances || [];
    // 這個要跑 PowerShell，排在最後面，只有設定頁用得到
    window.api.getLoginItem().then(v => { state.bootLaunch = !!v; refreshSettings(); }).catch(() => {});
    // 補到的資料要反映到「已經畫出來的」那一頁上
    renderSidebar();
    showTab(state.tab);
    refreshSettings();
    mark('restLoaded');
  });

  window.api.onLogEntry(entry => {
    state.logs.push({ ...entry, id: ++logSeq });
    if (state.logs.length > 300) state.logs.splice(0, state.logs.length - 300);
    // 每條連線都重畫一次會把渲染執行緒灌爆：實測開著紀錄分頁時，200 條連線 =
    // 200 次重畫、合計 5826ms，而牆鐘只有 1494ms。改成一個影格最多重畫一次。
    if (state.tab === 'logs' && !logRenderQueued) {
      logRenderQueued = true;
      requestAnimationFrame(() => { logRenderQueued = false; if (state.tab === 'logs') appendLogRows(); });
    }
  });
  window.api.onRouteStats(stats => {
    if (!stats || !stats.routeId) return;
    const s = state.sessions[stats.routeId];
    if (!s) return;
    if (typeof stats.connections === 'number') s.conns = Math.max(0, stats.connections);
    // 主行程送的是「路由啟動以來的累計位元組」。畫面重建（重新載入、視窗重開）後的第一筆
    // 只拿來當差分基準——原本會被當成一個 300ms 格子裡的流量，畫出幾百 MB/s 的假尖峰。
    if (!s._seen) {
      s._seen = true;
      if (typeof stats.bytesUp === 'number') s._pu = stats.bytesUp;
      if (typeof stats.bytesDown === 'number') s._pd = stats.bytesDown;
    }
    if (typeof stats.bytesUp === 'number') s.upT = stats.bytesUp;
    if (typeof stats.bytesDown === 'number') s.downT = stats.bytesDown;
  });
  window.api.onRouteStatus(list => reconcileStatus(list));

  // 系統代理也可能從系統匣被切換。少了這個訂閱，從系統匣切換之後
  // 主視窗的開關還停在舊狀態，使用者看到的跟實際的不一樣。
  if (window.api.onSystemProxy) window.api.onSystemProxy(s => {
    if (!s) return;
    if (s.notice) flash(s.notice, 'var(--amber)');   // 主行程自己關掉系統代理時要讓使用者知道
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

boot();
