'use strict';
// 下拉選單、App 內告警視窗、Toast／Banner、主題、懸浮說明。
// renderer 的各檔都是一般 <script>（不是 module），最外層的宣告在各檔之間共用；載入順序見 index.html。

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
  // 分組標題只有 24px 高，全部當 37 算的話（規則庫選單有兩組）會高估，
  // 貼近視窗底部時就會把選單翻到不該翻的方向。
  const h = Math.min(260, items.reduce((a, o) => a + (o.header ? 24 : 37), 0) + 8), gap = 6;
  const below = window.innerHeight - r.bottom > h + 16;
  // 錨點是小按鈕的選單（例如規則庫的「直連 ▾」）若沿用按鈕寬度，標籤會被截成只剩圓點
  const width = (kind === 'split-default' || kind === 'split-target' || kind === 'rs-detour') ? Math.max(r.width, 214) : r.width;
  // 規則庫按鈕靠右，選單改對齊按鈕右緣往左展開
  const want = kind === 'rs-detour' ? r.right - width : r.left;
  const left = Math.max(8, Math.min(want, window.innerWidth - width - 8));   // 不要開到視窗外
  state.menu = { kind, items, left, width, top: below ? r.bottom + gap : Math.max(8, r.top - h - gap) };
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
        : `<button data-mi="${i}" aria-checked="${!!o.check}" class="hvFill2" style="display:flex;align-items:center;gap:9px;padding:8px 9px;border:none;border-radius:9px;background:${o.check ? 'var(--accent-dim)' : 'transparent'};color:var(--text);font-size:12.5px;cursor:pointer;text-align:left;width:100%">
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
        <div style="width:44px;height:44px;border-radius:50%;background:${warn ? 'var(--red-dim)' : 'var(--accent-dim)'};display:flex;align-items:center;justify-content:center;color:${warn ? 'var(--red)' : 'var(--accent)'}">
          <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${warn
            ? '<path d="M12 3.5 2.8 19.5h18.4L12 3.5z"></path><path d="M12 9.5v4.5M12 17h.01"></path>'
            : '<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 7.6h.01"></path>'}</svg>
        </div>
        <span style="font-size:15.5px;font-weight:700;letter-spacing:-.2px">${esc(a.title)}</span>
        <span style="font-size:12.5px;color:var(--text2);line-height:1.7;text-wrap:pretty">${esc(a.body)}</span>
        <div style="display:flex;gap:9px;width:100%;padding-top:4px">
          ${a.cancel ? '<button id="alertDismiss" class="hvFill2" style="flex:1;height:34px;border:1px solid var(--sep);border-radius:9px;background:transparent;color:var(--text2);font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap">取消</button>' : ''}
          <button id="alertCancel" class="hvFill2" style="flex:1;height:34px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap">${esc(secondary)}</button>
          <button id="alertPrimary" class="hvBright" style="flex:1;height:34px;border:none;border-radius:9px;background:${a.danger ? 'var(--red)' : 'var(--accent)'};color:${a.danger ? 'var(--on-red)' : 'var(--on-accent)'};font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap">${esc(primary)}</button>
        </div>
      </div>
    </div>`;
  $('alertOverlay').onclick = e => { if (e.target === $('alertOverlay')) closeAlert(); };
  $('alertCancel').onclick = () => (a.onSecondary ? a.onSecondary() : closeAlert());
  if ($('alertDismiss')) $('alertDismiss').onclick = () => closeAlert();
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
// Toast / Banner / 主題
// =====================================================================================
let toastTimer;
const toastQueue = [];
// 連續的訊息原本會互相覆蓋（例如一次下載多個規則庫、每個都失敗，只看得到最後一則），
// 所以排隊依序顯示；長訊息也給多一點時間讀完。
const isErrToast = c => c === 'var(--red)';
function flash(text, color) {
  if (state.toast) {
    const last = toastQueue.length ? toastQueue[toastQueue.length - 1] : null;
    if (state.toast === text || (last && last.text === text)) return;   // 同一則不重複排隊
    if (toastQueue.length < 5) toastQueue.push({ text, color });
    else if (isErrToast(color)) {
      // 佇列滿了：錯誤不能被丟掉，擠掉最舊的一則非錯誤訊息
      const i = toastQueue.findIndex(t => !isErrToast(t.color));
      if (i >= 0) { toastQueue.splice(i, 1); toastQueue.push({ text, color }); }
    }
    return;
  }
  showToast(text, color);
}
function showToast(text, color) {
  state.toast = text;
  $('toastDot').style.background = color || 'var(--accent)';
  $('toastText').textContent = text;
  const t = $('toast'); t.style.display = 'flex';
  t.style.animation = 'none'; void t.offsetHeight; t.style.animation = 'toastIn .2s ease-out';
  clearTimeout(toastTimer);
  // 錯誤要讀得完：至少 5 秒；一般訊息照長度 2.2–5 秒
  const base = Math.min(5000, 2200 + Math.max(0, text.length - 10) * 60);
  toastTimer = setTimeout(() => {
    state.toast = '';
    const next = toastQueue.shift();
    if (next) { showToast(next.text, next.color); return; }
    t.style.display = 'none';
  }, isErrToast(color) ? Math.max(5000, base + 2000) : base);
}
// ---- 懸浮說明 ----
// 次要說明不再常駐在畫面上：標題旁放一顆 ⓘ（tipIcon），或直接在元素上掛 data-tip，
// 滑鼠停 250ms 才出現。原生 title 要等一秒多、樣式也跟不上主題，所以自己畫。
const tipIcon = text => `<span class="tipI" data-tip="${esc(text)}" role="img" tabindex="0" aria-label="${esc(text)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 7.6h.01"></path></svg></span>`;
let tipTimer = null, tipFor = null;
function hideTip() { clearTimeout(tipTimer); tipFor = null; const b = $('tipBox'); if (b) b.remove(); }
function showTipFor(el) {
  hideTip(); tipFor = el;
  const b = document.createElement('div'); b.id = 'tipBox'; b.textContent = el.dataset.tip;
  document.body.appendChild(b);
  const r = el.getBoundingClientRect(), w = b.offsetWidth, h = b.offsetHeight;
  const below = r.bottom + 6 + h < window.innerHeight - 8;
  b.style.top = (below ? r.bottom + 6 : r.top - h - 6) + 'px';
  b.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8)) + 'px';
}
document.addEventListener('mouseover', e => {
  const t = /** @type {any} */ (e.target);
  const el = t.closest && t.closest('[data-tip]');
  if (el === tipFor) return;
  hideTip();
  if (el && el.dataset.tip) { tipFor = el; tipTimer = setTimeout(() => { if (tipFor === el && el.isConnected) showTipFor(el); }, 250); }
});
// 鍵盤也要看得到說明：Tab 到 ⓘ（或任何帶 data-tip 的元素）時直接顯示，離開就收
document.addEventListener('focusin', e => {
  const t = /** @type {any} */ (e.target);
  const el = t.closest && t.closest('[data-tip]');
  if (el && el.dataset.tip && t.matches(':focus-visible')) showTipFor(el);
});
document.addEventListener('focusout', e => { if (tipFor && tipFor.contains(e.target)) hideTip(); });
document.addEventListener('mousedown', hideTip, true);
document.addEventListener('scroll', hideTip, true);
window.addEventListener('blur', hideTip);

function showBanner() {
  const b = $('banner');
  if (state.banner) { $('bannerText').textContent = state.banner; b.style.display = 'flex'; }
  else b.style.display = 'none';
}
// 「系統」模式要跟著 OS 即時切換，不是只在開機讀一次
const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
const onOsTheme = () => { if (state.themeMode === '系統') setTheme('系統'); };
if (darkMq.addEventListener) darkMq.addEventListener('change', onOsTheme); else if (darkMq.addListener) darkMq.addListener(onOsTheme);
function setTheme(mode) {
  const theme = mode === '深色' ? 'dark' : mode === '淺色' ? 'light' : (darkMq.matches ? 'dark' : 'light');
  document.body.dataset.theme = theme;
  state.theme = theme; state.themeMode = mode;
  localStorage.setItem('proxy_theme', mode);
  renderThemeSeg();
}
