'use strict';
// 骨架（mount）、標題列分頁、側邊欄路由清單、無路由時的導引。
// renderer 的各檔都是一般 <script>（不是 module），最外層的宣告在各檔之間共用；載入順序見 index.html。

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
        <button id="btnAdd" class="hvBright" title="新增路由 (Ctrl+N)" style="display:flex;align-items:center;justify-content:center;gap:5px;border:none;cursor:pointer;height:30px;min-width:104px;padding:0 11px;border-radius:8px;background:var(--accent);color:var(--on-accent);font-size:12.5px;font-weight:600;white-space:nowrap">
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
      <div id="toast" role="status" aria-live="polite" aria-atomic="true" style="display:none;position:absolute;bottom:18px;left:0;right:0;margin:0 auto;width:max-content;max-width:calc(100% - 32px);z-index:80;padding:10px 15px;background:var(--panelq);backdrop-filter:blur(20px);border:1px solid var(--sep);border-radius:11px;box-shadow:var(--shadow);font-size:12.5px;animation:toastIn .2s ease-out;align-items:center;gap:8px">
        <span id="toastDot" style="width:7px;height:7px;border-radius:50%;background:var(--accent)"></span><span id="toastText"></span>
      </div>
    </div>
  </div>`;

  buildDashboard();
  buildLogs();
  buildSettings();
  buildSplit();

  // 「開機自動啟動」現在的狀態要問 OS，而那在 Windows 上得跑一次 PowerShell。
  // 在 mount() 裡直接問會讓它跟首屏需要的那幾個 IPC 擠在一起 —— 實測首屏因此
  // 被推遲一秒多。這個值只有設定頁看得到，等首屏畫完再問就好。
  window.api.getAppInfo().then(i => { const el = document.getElementById('aboutVer'); if (el && i && i.version) el.textContent = i.version; }).catch(() => {});

  $('btnTheme').onclick = () => setTheme(state.theme === 'dark' ? '淺色' : '深色');
  $('btnAdd').onclick = () => { const a = tabAdd(); if (a) a.go(); };
  $('btnMin').onclick = () => window.api.windowMinimize();
  $('btnMax').onclick = () => window.api.windowMaximize();
  $('btnClose').onclick = () => window.api.windowClose();
  $('bannerDismiss').onclick = () => { state.banner = ''; state.sysHintSeen = true; showBanner(); };

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      const a = tabAdd(); if (a) a.go();   // 沒有新增動作的分頁（紀錄、設定）就不做事
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
    if (e.code === 'Space' && state.tab !== 'split' && !anyOverlayOpen() && e.target === document.body) { e.preventDefault(); togglePower(); }
    // 一次只關最上面那一層：以前選單跟底下的面板會一起被關掉，填到一半的表單就沒了
    if (e.key === 'Escape' && state.menu) { e.preventDefault(); closeMenu(); return; }
    if (e.key === 'Escape' && $('ksBox')) return;   // 斷線保護對話框必須做出選擇
    if (e.key === 'Escape' && $('tipBox')) { hideTip(); return; }
    // 順序照疊放：告警 > 權限說明 > 各面板（斷線保護對話框刻意不能用 Esc 關）
    if (e.key === 'Escape') { if (state.alert) closeAlert(); else if (state.splitUac) closeSplitUac(); else if (state.launchSheet) closeLaunchSheet(); else if (state.splitSheet) closeSplitSheet(); else if (state.srvSheet) closeSrvSheet(); else if (state.routeSheet) closeRouteSheet(); }
  });
  document.addEventListener('click', () => closeMenu(), true);
  initDialogFocus();
}

// =====================================================================================
// 標題列分頁 + 狀態
// =====================================================================================
function renderTabs() {
  // v7 定案的順序：先選出口（路由）→ 再定規則（分流）→ 再看結果（紀錄）
  const tabs = [['dashboard', '路由'], ['split', '分流'], ['servers', '伺服器'], ['logs', '紀錄'], ['creds', '憑證'], ['settings', '設定']];
  $('tabseg').setAttribute('role', 'tablist');
  // 每次狀態變化都會整排重畫；焦點在分頁鈕上的話要接回同一顆，不然鍵盤使用者會被丟回 body
  const focusedTab = $('tabseg').contains(document.activeElement) ? document.activeElement.dataset.tab : null;
  // 快捷鍵提示原本常駐在狀態列右端，改成各分頁鈕的 title
  $('tabseg').innerHTML = tabs.map(([k, label], i) =>
    `<button data-tab="${k}" role="tab" aria-selected="${state.tab === k}" aria-label="${label}" title="${label}（Ctrl+${i + 1}）" style="border:none;cursor:pointer;padding:6px 13px;border-radius:7px;font-size:12.5px;${segCss(state.tab === k)};transition:background .18s,color .18s;white-space:nowrap;flex-shrink:0">${label}</button>`
  ).join('');
  $('tabseg').querySelectorAll('button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  if (focusedTab) { const b = $('tabseg').querySelector(`[data-tab="${focusedTab}"]`); if (b) b.focus(); }
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
    { label: state.sys && runIds.length ? '系統代理已開啟' : '系統代理已關閉',
      color: state.sys && runIds.length ? 'var(--good)' : 'var(--text2)', tab: 'dashboard' },
    state.killswitch && state.killswitch.tripped
      ? { label: '斷線保護已觸發', color: 'var(--red)', tab: 'split' }
      // 斷線保護只在分流引擎執行時才有作用；引擎沒開時寫「就緒」會讓人以為有保護
      : { label: !state.settings.killSwitch ? '斷線保護停用' : splitRunning() ? '斷線保護就緒' : '斷線保護待命',
          tip: state.settings.killSwitch && !splitRunning() ? '分流引擎沒有執行，斷線保護目前不起作用；啟動引擎後才會保護' : '',
          color: state.settings.killSwitch && splitRunning() ? 'var(--good)' : 'var(--text2)', tab: state.settings.killSwitch && !splitRunning() ? 'split' : 'settings' },
  ];
  // 末端的分流引擎開關：設計稿是「迷你開關 + 文字」包在一顆有框的鈕裡，
  // 不是徽章。開關本身 32×18、鈕 26 高，狀態靠顏色與撥桿位置表達。
  const engOn = splitRunning(), engBusy = state.splitEngine === 'starting';
  const engTip = engOn ? '停止引擎：程式與網域規則將失效' : '啟動引擎：依程式與網域規則自動分流（需管理員權限）';
  const pill = `<button id="stEnginePill" class="hvFill2" role="switch" aria-checked="${engOn}" aria-label="分流引擎" title="${engTip}" style="display:flex;align-items:center;gap:7px;border:1px solid var(--sep);background:var(--card);padding:0 9px 0 6px;height:26px;border-radius:13px;cursor:pointer;color:${engOn ? 'var(--good)' : engBusy ? 'var(--amber)' : 'var(--text2)'};font-weight:500;font-size:12px;white-space:nowrap">
    <span style="width:32px;height:18px;border-radius:9px;position:relative;background:${engOn ? 'var(--good)' : 'var(--fill)'};transition:background .22s;flex-shrink:0"><span style="position:absolute;top:2px;left:${engOn ? '16px' : '2px'};width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:left .22s cubic-bezier(.32,.72,0,1)"></span></span>${engBusy ? '分流引擎啟動中' : engOn ? '分流引擎執行中' : '分流引擎未執行'}
  </button>`;
  st.innerHTML = segs.map((g, i) =>
    `${i ? '<span style="color:var(--text3);margin:0 6px">·</span>' : ''}<button data-stseg="${g.tab}"${g.tip ? ` data-tip="${esc(g.tip)}"` : ''} style="border:none;background:transparent;padding:0;cursor:pointer;font-weight:500;font-size:12.5px;white-space:nowrap;color:${g.color}">${esc(g.label)}</button>`).join('') + pill;
  st.querySelectorAll('[data-stseg]').forEach(b => b.onclick = () => showTab(b.dataset.stseg));
  $('stEnginePill').onclick = () => toggleSplitEngine();
}

function showTab(tab) {
  if (tab !== state.tab) closeAllSheets();   // 面板屬於原本那一頁的情境，換頁就收掉
  state.tab = tab;
  const noRoutes = state.routes.length === 0;
  const showGuide = tab === 'dashboard' && noRoutes;
  const showDash = tab === 'dashboard' && !noRoutes;
  setDisp('view-guide', showGuide); setDisp('view-dash', showDash);
  setDisp('view-servers', tab === 'servers'); setDisp('view-logs', tab === 'logs');
  setDisp('view-creds', tab === 'creds'); setDisp('view-settings', tab === 'settings');
  setDisp('view-split', tab === 'split');
  // 路由側欄只跟「路由」與「紀錄」（依選取的路由篩紀錄）有關；其他頁全寬，
  // 否則 800px 最小視窗下伺服器表格會被擠到要橫向捲動、看不到操作鈕
  const sb = $('sidebar'); if (sb) sb.style.display = (tab === 'dashboard' || tab === 'logs') ? 'flex' : 'none';
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
  // 同上：路由狀態一變就整個側欄重畫，焦點要接回原本那一列（或那一列上的同一顆按鈕）
  const fa = list.contains(document.activeElement) ? document.activeElement : null;
  const focusRid = fa && fa.closest('[data-rid]') ? fa.closest('[data-rid]').dataset.rid : null;
  const focusAct = fa && fa.dataset ? fa.dataset.act : null;
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
    // 側欄只有 264px，這欄常被截：讓它吃掉剩餘寬度，出口與引用完整內容放懸浮提示
    const powerBg = conn ? 'var(--good)' : busy ? 'var(--amber)' : 'var(--fill2)';
    const powerColor = conn ? 'var(--on-good)' : busy ? 'var(--on-amber)' : 'var(--text2)';
    const powerTip = conn ? '停止這條路由' : busy ? '正在啟動…' : '啟動這條路由';
    const delIcon = pend
      ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"></path></svg>'
      : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"></path></svg>';
    return `<div class="hvFill2" data-rid="${esc(r.id)}" role="button" tabindex="0" aria-pressed="${active}" aria-label="${esc(r.label || '未命名路由')}" style="padding:11px 12px;border-radius:12px;cursor:pointer;background:${active ? 'var(--fill2)' : 'transparent'};border:1px solid ${active ? 'var(--accent)' : conn ? 'var(--good)' : 'var(--sep)'};display:flex;flex-direction:column;gap:7px;transition:background .16s,border-color .16s">
      <div style="display:flex;align-items:center;gap:7px">
        <span style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${dot};box-shadow:${conn ? '0 0 0 3px rgba(47,158,120,.22)' : 'none'};animation:${conn ? 'dotBeat 2.2s ease-in-out infinite' : 'none'}"></span>
        <span style="font-size:13.5px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.label || '未命名路由')}</span>
        ${chained ? `<span style="font-size:9.5px;font-weight:700;letter-spacing:.3px;padding:2px 5px;border-radius:5px;background:var(--accent-dim);color:var(--accent);flex-shrink:0">${r.hops.length} 跳</span>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-size:9.5px;font-weight:700;letter-spacing:.4px;padding:2px 5px;border-radius:5px;background:var(--fill2);color:var(--text2);flex-shrink:0">${r.kind === 'http' ? 'HTTP' : 'SOCKS5'}</span>
        <span style="font-size:11.5px;color:var(--text2);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace">127.0.0.1:${esc(String(r.localPort))}</span>
        <span data-tip="${esc('出口：' + exitName + (refs ? '\n使用中：' + refs : ''))}" style="margin-left:auto;flex:1;min-width:0;text-align:right;font-size:11px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(refs || exitName)}</span>
      </div>
      ${active ? `<div style="display:flex;gap:6px;padding-top:2px">
        <button class="hvBright" data-act="power" title="${powerTip}（空白鍵）" aria-label="${powerTip}" style="flex:1;height:26px;border:none;border-radius:7px;background:${powerBg};color:${powerColor};cursor:pointer;display:flex;align-items:center;justify-content:center">${POWER_ICON}</button>
        <button class="hvAcc" data-act="edit" title="編輯路由" aria-label="編輯路由" style="flex:1;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h4L20 8l-4-4L4 16v4z"></path></svg></button>
        <button class="hvAcc" data-act="browser" title="以此路由啟動程式（Ctrl+L）" aria-label="以此路由啟動程式（Ctrl+L）" style="flex:1;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path></svg></button>
        <button class="hvRed" data-act="del" title="${pend ? '再按一次確認刪除' + (refs ? '（' + refs + '將失效）' : '') : '刪除路由'}" aria-label="${pend ? '再按一次確認刪除路由' : '刪除路由'}" style="flex:1;height:26px;border:none;border-radius:7px;background:${pend ? 'var(--red)' : 'var(--fill2)'};color:${pend ? 'var(--on-red)' : 'var(--red)'};cursor:pointer;display:flex;align-items:center;justify-content:center">${delIcon}</button>
      </div>` : ''}
    </div>`;
  }).join('');

  list.querySelectorAll('[data-rid]').forEach(row => {
    const id = row.dataset.rid;
    row.addEventListener('click', e => { if (e.target.closest('[data-act]')) return; selectRoute(id); });
    row.addEventListener('keydown', e => {
      if (e.target !== row || (e.key !== 'Enter' && e.code !== 'Space')) return;
      e.preventDefault(); selectRoute(id);
      const next = list.querySelector(`[data-rid="${CSS.escape(id)}"]`); if (next) next.focus();   // 選取會重畫整列，焦點要接回去
    });
    row.querySelector('[data-act="power"]')?.addEventListener('click', e => { e.stopPropagation(); togglePower(id); });
    row.querySelector('[data-act="browser"]')?.addEventListener('click', e => { e.stopPropagation(); openLaunchSheet(id); });
    row.querySelector('[data-act="edit"]')?.addEventListener('click', e => { e.stopPropagation(); openRoute(id); });
    row.querySelector('[data-act="del"]')?.addEventListener('click', e => { e.stopPropagation(); deleteRoute(id); });
  });
  if (focusRid) {
    const row = list.querySelector(`[data-rid="${CSS.escape(focusRid)}"]`);
    const t = row && (focusAct ? row.querySelector(`[data-act="${focusAct}"]`) : row);
    if (t) t.focus({ preventScroll: true }); else if (row) row.focus({ preventScroll: true });
  }
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
  state.pendingRouteDel = null;
  renderSidebar();

  // 真的刪之前什麼都不動：以前是先停掉路由、丟掉 session 才問 profile 要不要留，
  // 結果對話框按 Esc 或點遮罩「取消」時，路由已經被停掉卻沒有刪掉。
  const del = keepProfile => {
    clearSTimers(id); dropSes(id);
    return window.api.deleteRoute(id, { keepProfile }).then(routes => {
      state.routes = routes || [];
      if (state.sel === id) state.sel = state.routes[0] ? state.routes[0].id : null;
      renderSidebar(); showTab(state.tab); flash('已刪除路由');
    }).catch(e => { flash('刪除路由失敗：' + (e && e.message || e), 'var(--red)'); refreshRouteStatus(); });
  };

  // 這條路由開過瀏覽器的話會留下 profile（cookie / 登入狀態）。
  // 默默刪掉等於連帶登出，所以先問一句；沒有 profile 就不多這道問題。
  // 查不到就當作有，保留資料（刪錯救不回來，留著頂多占空間）。
  window.api.routeProfileInfo(id).then(info => {
    if (!(info && info.exists)) return del(false);
    state.alert = {
      tone: 'info', title: '這條路由的瀏覽器資料要一併刪除嗎？',
      body: '用這條路由開過的瀏覽器視窗有自己的 cookie 與登入狀態。保留的話下次建相同 id 的路由還能用。',
      primary: '一併刪除', secondary: '保留資料', cancel: true, danger: true,
      go: () => { closeAlert(); del(false); },
      onSecondary: () => { closeAlert(); del(true); },
    };
    renderAlert();
  }).catch(() => del(true));
}

// 刪除失敗時 session 已經丟了，跟主行程對一次帳把真實狀態拿回來
function refreshRouteStatus() {
  window.api.getRouteStatus().then(list => reconcileStatus(list)).catch(() => {});
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
        <button id="guideAdd" class="hvBright" style="height:38px;padding:0 20px;border:none;border-radius:10px;background:var(--accent);color:var(--on-accent);font-size:13.5px;font-weight:600;cursor:pointer;white-space:nowrap">${esc(G.primary)}</button>
        <button id="guideAlt" class="hvFill2" style="height:38px;padding:0 20px;border:1px solid var(--sep);border-radius:10px;background:var(--card);color:var(--text);font-size:13.5px;font-weight:600;cursor:pointer;white-space:nowrap">${esc(G.secondary)}</button>
      </div>
      <span style="font-size:11.5px;color:var(--text3)">Ctrl + N 新增 · 空白鍵啟動選取的路由</span>
    </div>`;
  $('guideAdd').onclick = G.onPrimary;
  $('guideAlt').onclick = G.onSecondary;
}
