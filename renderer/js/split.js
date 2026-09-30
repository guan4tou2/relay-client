'use strict';
// 分流分頁：引擎、模式、單一規則表、模擬器、規則編輯面板。
// renderer 的各檔都是一般 <script>（不是 module），最外層的宣告在各檔之間共用；載入順序見 index.html。

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
const condChipStyle = k => k === '程式' ? { bg: 'var(--purple-dim)', color: 'var(--purple)' }
  : (k === '埠' || k === '協定') ? { bg: 'var(--fill2)', color: 'var(--text2)' }
  : { bg: 'var(--accent-dim)', color: 'var(--accent)' };
// 規則引用到、但還沒下載的規則庫
const missingTags = r => {
  const d = rWhen(r).dest;
  return (d && d.match === 'ruleset') ? splitVals(d.value).filter(t => !isInstalled(t)) : [];
};


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
// 標題列那顆「新增」是分頁的新增，不是永遠的「新增路由」——伺服器頁與憑證頁
// 各有自己的新增對象，掛著「新增路由」按下去會跑去開路由面板。
// 沒列在這裡的分頁（紀錄、設定）沒有新增動作，整顆隱藏。
// 標籤字數不一（新增伺服器 5 字、新增路由 4 字），btnAdd 因此給了固定 min-width：
// 不然按鈕一變寬，置中的分頁列就會跟著位移，切到伺服器頁時整排會跳一下。
const TAB_ADD = {
  dashboard: { label: '新增路由', go: () => openRoute() },
  split: { label: '新增規則', go: () => openSplitSheet() },
  servers: { label: '新增伺服器', go: () => openSrv() },
  creds: { label: '新增憑證', go: () => addCred() },
};
const tabAdd = () => TAB_ADD[state.tab] || null;

function syncAddButton() {
  const b = $('btnAdd'); if (!b) return;
  const act = tabAdd();
  // 用 visibility 而非 display：按鈕消失會讓置中的分頁列往右跳（紀錄、設定頁）
  b.style.visibility = act ? 'visible' : 'hidden';
  if (!act) return;
  const label = act.label;
  b.title = label + ' (Ctrl+N)';
  b.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>${label}`;
}

// ---- 進入分頁 ----
function enterSplit() { updateSplit(); refreshSplit(); }
async function refreshSplit() {
  // 四個互不相干的 IPC，一起送
  const settle = p => p.then(v => v, () => null);
  const [sp, cat, list, est] = await Promise.all([
    settle(window.api.getSplit()), settle(window.api.rulesetCatalog()),
    settle(window.api.rulesetList()), settle(window.api.getEngineStatus()),
  ]);
  applySplit(sp);
  if (Array.isArray(cat)) state.splitCatalog = cat;
  if (Array.isArray(list)) state.splitInstalled = list;
  if (est) applyEngineStatus(est);
  if (state.tab === 'split') { updateSplit(); syncTitlebar(); }
}

// ---- 骨架（建一次；電源 SVG 常駐才能觸發 ring 過場）----
function buildSplit() {
  $('view-split').innerHTML = `
  <div style="display:flex;flex-direction:column;gap:14px;align-items:stretch">

    <div style="background:var(--card);border:1px solid var(--sep);border-radius:16px;padding:18px 20px;display:flex;flex-direction:column;gap:14px;flex-shrink:0">
      <div style="display:flex;align-items:center;gap:18px">
        <button id="spEngineBtn" title="啟動分流引擎" aria-label="啟動分流引擎" style="width:78px;height:78px;flex-shrink:0;position:relative;border:none;background:transparent;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center">
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
          <span id="spEngineDesc" style="font-size:12.5px;color:var(--text2);line-height:1.6;text-wrap:pretty"></span>
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
          <span id="spDirectNote" style="display:none;font-size:11.5px;color:var(--text2);line-height:1.5;text-wrap:pretty">虛擬網卡與斷線保護維持運作，切回規則不需重新提權。</span>
        </div>
      </div>

    </div>

    <div id="spNotice"></div>

    <div id="spRulesHead" style="display:flex;align-items:center;gap:10px;flex-shrink:0">
      <span style="font-size:15px;font-weight:700;letter-spacing:-.2px;white-space:nowrap;display:flex;align-items:center">規則${tipIcon('由上往下比對，第一條命中即生效；一條規則可同時限定程式、目的地、埠與協定')}</span>
      <button id="spSimToggle" class="hvFill2" title="測試某個網址會走哪一條規則" aria-label="測試某個網址會走哪一條規則" style="margin-left:auto;display:flex;align-items:center;gap:5px;height:28px;padding:0 11px;border:1px solid var(--sep);border-radius:8px;background:var(--card);color:var(--text2);font-size:12px;cursor:pointer;white-space:nowrap;flex-shrink:0"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"></circle><path d="M20 20l-4.2-4.2"></path></svg>模擬</button>
      <div id="spTools" style="display:none;align-items:center;gap:8px;flex-shrink:0">
        <input id="spSearch" aria-label="搜尋規則" placeholder="搜尋…" style="width:150px;height:28px;padding:0 10px;border:1px solid var(--sep);border-radius:8px;background:var(--card);color:var(--text);font-size:12px;outline:none">
        <div id="spFilterSeg" style="display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:8px"></div>
      </div>
    </div>

    <div id="spSimPanel" style="display:none;flex-direction:column;gap:9px;background:var(--card);border:1px solid var(--sep);border-radius:16px;padding:13px 16px;flex-shrink:0">
      <div style="display:flex;align-items:center;gap:8px">
        <input id="spSimHost" aria-label="要模擬的網域或 IP" placeholder="輸入網域、IP 或 IP:埠，例如 www.netflix.com" style="flex:1;min-width:0;height:32px;padding:0 11px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12.5px;outline:none">
        <button id="spSimExeBtn" class="hvFill2" title="只測某支程式" style="display:flex;align-items:center;gap:6px;height:32px;padding:0 10px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text2);font-size:12px;cursor:pointer;white-space:nowrap;flex-shrink:0"><span id="spSimExeLabel">不限程式</span><span style="color:var(--text3);font-size:9px">▾</span></button>
        <button id="spSimRun" class="hvBright" style="height:32px;padding:0 15px;border:none;border-radius:9px;background:var(--accent);color:var(--on-accent);font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0">模擬</button>
      </div>
      <div id="spSimResult"></div>
    </div>

    <div id="spTableWrap" style="background:var(--card);border:1px solid var(--sep);border-radius:16px;overflow-x:auto;flex-shrink:0;transition:opacity .3s">
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
  $('spEngineBtn').setAttribute('aria-label', $('spEngineBtn').title);
  $('spEngineTitle').textContent = running ? '分流引擎執行中' : starting ? '正在啟動…' : '分流引擎未執行';

  const badge = $('spEngineBadge');
  badge.textContent = running ? '執行中' : starting ? '正在啟動' : state.splitElevated ? '已授權' : '需要授權';
  badge.style.background = running ? 'var(--good-dim)' : starting ? 'var(--amber-dim)' : state.splitElevated ? 'var(--fill2)' : 'var(--amber-dim)';
  badge.style.color = running ? 'var(--good)' : starting ? 'var(--amber)' : state.splitElevated ? 'var(--text2)' : 'var(--amber)';
  // 權限說明原本是一條常駐通知列；改掛在「需要授權」徽章上，點下去開完整說明
  const needUac = !running && !starting && !state.splitElevated;
  if (needUac) badge.dataset.tip = '首次啟動需要系統管理員權限，用於建立虛擬網卡並注入路由表，只需同意一次。點擊了解權限用途';
  else delete badge.dataset.tip;
  badge.style.cursor = needUac ? 'pointer' : '';
  const openUac = () => { state.splitUac = true; renderSplitUac(); };
  badge.onclick = needUac ? openUac : null;
  // 可點時要讓鍵盤也按得到
  if (needUac) { badge.setAttribute('role', 'button'); badge.tabIndex = 0; badge.setAttribute('aria-label', '需要授權：了解權限用途'); }
  else { badge.removeAttribute('role'); badge.removeAttribute('tabindex'); badge.removeAttribute('aria-label'); }
  badge.onkeydown = needUac ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openUac(); } } : null;

  $('spEngineDesc').textContent = running
    ? (ruleMode ? '依規則表分流；規則變更約 1–2 秒生效。切換模式不需重新提權。'
      : mode === 'global' ? `所有流量走「${splitTargetLabel(state.splitGlobalTarget)}」。`
      : '所有流量直連，斷線保護維持。')
    : '';
  $('spEngineDesc').style.display = $('spEngineDesc').textContent ? '' : 'none';

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
  // 不再另外跳 toast：模式切換後上方的通知列已經寫明現況，兩個一起出現是重複
  await persistSplit({ mode, globalTarget: state.splitGlobalTarget });
}

function renderSplitNotice() {
  const el = $('spNotice'); if (!el) return;
  // 同時最多一條：斷線保護橫幅已經蓋在上方時，不再疊通知條
  if (state.killswitch && state.killswitch.tripped) { el.innerHTML = ''; return; }
  const running = splitRunning();
  const info = 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8h.01M11 12h1v5h1';
  const warn = 'M12 3.5 2.8 19.5h18.4L12 3.5zM12 9.5v4.5M12 17h.01';
  const missing = state.splitRules.filter(r => r.on !== false && missingTags(r).length);
  let n = null;
  if (state.splitMode === 'global') n = { text: `全域模式：所有流量走「${splitTargetLabel(state.splitGlobalTarget)}」，下方規則暫時停用（本機與內網仍直連）。`, bg: 'var(--accent-dim)', color: 'var(--accent)', icon: info, action: '切回規則', go: () => setSplitMode('rule') };
  else if (state.splitMode === 'direct') n = { text: '直連模式：所有流量不經代理，規則暫時停用。', bg: 'var(--fill2)', color: 'var(--text3)', icon: info, action: '切回規則', go: () => setSplitMode('rule') };
  else if (missing.length) n = { text: `有 ${missing.length} 條規則引用尚未下載的規則庫，這些規則目前不會生效。`, bg: 'var(--amber-dim)', color: 'var(--amber)', icon: warn, action: '全部下載', go: () => installRuleSets([...new Set(missing.flatMap(missingTags))]) };
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

// 動作欄：開關 40 + 上移 22 + 下移 22 + 編輯 26 + 刪除 26，加四個 6px 間距
const SPLIT_ACTW = 40 + 22 + 22 + 26 + 26 + 6 * 4;
const SPLIT_MINW = 26 + 26 + 150 + 110 + SPLIT_ACTW + 32;

function renderSplitRules() {
  const el = $('spRulesTable'); if (!el) return;
  if (!state.splitRules.length) { el.innerHTML = ''; return; }
  const active = splitActive();
  const visible = splitVisibleRules();

  const header = `<div style="display:flex;align-items:center;padding:9px 16px;border-bottom:1px solid var(--sep);font-size:11px;color:var(--text3);font-weight:600;letter-spacing:.3px;min-width:${SPLIT_MINW}px">
    <span style="width:26px;flex-shrink:0"></span><span style="width:26px;flex-shrink:0">#</span>
    <span style="flex:1.3 1 0;min-width:150px;padding-right:12px;box-sizing:border-box;white-space:nowrap">規則 · 條件</span>
    <span style="flex:1 1 0;min-width:110px;padding-right:10px;box-sizing:border-box;white-space:nowrap">流量走向</span>
    <span style="width:${SPLIT_ACTW}px;flex-shrink:0"></span>
  </div>`;

  const lanOn = state.splitLanDirect;
  const builtin = `<div style="display:flex;align-items:center;padding:10px 16px;border-bottom:1px solid var(--sep);font-size:12.5px;min-width:${SPLIT_MINW}px;background:${lanOn ? 'transparent' : 'var(--fill2)'};color:${lanOn ? 'var(--text)' : 'var(--text3)'}">
    <span title="內建規則：固定在最前面，可停用、不可刪除" style="width:26px;flex-shrink:0;display:flex;align-items:center;color:var(--text3)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="5" y="11" width="14" height="9" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg></span>
    <span style="width:26px;flex-shrink:0;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:11.5px;color:var(--text3)">0</span>
    <span style="flex:1.3 1 0;min-width:150px;padding-right:12px;box-sizing:border-box;display:flex;flex-direction:column;gap:3px">
      <span style="display:flex;align-items:center;gap:7px;min-width:0"><span style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">本機與內網</span><span style="font-size:9.5px;font-weight:700;letter-spacing:.3px;padding:2px 6px;border-radius:5px;background:var(--fill2);color:var(--text2);flex-shrink:0">內建</span></span>
      <span title="${esc(LAN_CIDRS)}" style="font-size:10.5px;color:var(--text3);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">目的地 loopback · 私有網段 · link-local · mDNS（離線清單，無需下載）</span>
    </span>
    <span style="flex:1 1 0;min-width:110px;padding-right:10px;box-sizing:border-box;display:flex;align-items:center;gap:7px"><span style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:var(--text2)"></span><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">直接連線（不經代理）</span></span>

    <span style="width:${SPLIT_ACTW}px;flex-shrink:0;display:flex;justify-content:flex-end;align-items:center;gap:6px">
      <button data-lan="1" role="switch" aria-checked="${lanOn}" aria-label="本機與內網直連" title="${lanOn ? '停用內建保護（不建議：印表機、NAS、路由器管理頁會被送進代理）' : '啟用內建保護'}" style="width:40px;height:24px;border-radius:12px;border:none;padding:0;cursor:pointer;position:relative;background:${lanOn ? 'var(--accent)' : 'var(--fill)'};transition:background .22s"><span style="position:absolute;top:3px;left:${lanOn ? '19px' : '3px'};width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .22s cubic-bezier(.32,.72,0,1)"></span></button>
      <span style="width:${SPLIT_ACTW - 46}px"></span>
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
    const pos = state.splitRules.indexOf(r);
    return `<div data-srid="${esc(r.id)}" draggable="true" class="hvFill2" style="display:flex;align-items:center;padding:10px 16px;border-bottom:1px solid var(--sep);font-size:12.5px;min-width:${SPLIT_MINW}px;background:${rowBg};box-shadow:${miss.length ? 'inset 3px 0 0 var(--amber)' : 'none'};cursor:grab;color:${on ? 'var(--text)' : 'var(--text3)'};transition:background .3s">
      <span style="width:26px;flex-shrink:0;display:flex;align-items:center;color:var(--text3)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 7h.01M8 12h.01M8 17h.01M16 7h.01M16 12h.01M16 17h.01"></path></svg></span>
      <span style="width:26px;flex-shrink:0;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:11.5px;color:var(--text3)">${idx}</span>
      <span style="flex:1.3 1 0;min-width:150px;padding-right:12px;box-sizing:border-box;display:flex;flex-direction:column;gap:4px">
        <span title="${esc(name)}" style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(name)}</span>
        <span style="display:flex;gap:5px;flex-wrap:wrap;min-width:0">${conds.map(c => {
          const st = condChipStyle(c.k);
          return `<span title="${esc(c.full)}" style="display:inline-flex;align-items:center;gap:4px;max-width:100%;height:18px;padding:0 6px;border-radius:5px;background:${st.bg};color:${st.color};font-size:10.5px;white-space:nowrap;overflow:hidden"><span style="font-weight:700;letter-spacing:.2px;flex-shrink:0">${esc(c.k)}</span><span style="overflow:hidden;text-overflow:ellipsis">${esc(c.v)}</span></span>`;
        }).join('')}</span>
      </span>
      <span style="flex:1 1 0;min-width:110px;padding-right:10px;box-sizing:border-box;display:flex;align-items:center;gap:7px">
        <span style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${dot};animation:${dotAnim}"></span>
        <span title="${esc(targetLabel)}" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${targetColor}">${esc(targetLabel)}</span>
        ${miss.length ? `<button data-sact="dl" class="hvBright" style="flex-shrink:0;height:22px;padding:0 9px;border:none;border-radius:6px;background:var(--amber);color:var(--on-amber);font-size:10.5px;font-weight:600;cursor:pointer;white-space:nowrap">下載規則庫</button>` : ''}
      </span>
      <span style="width:${SPLIT_ACTW}px;flex-shrink:0;display:flex;justify-content:flex-end;align-items:center;gap:6px">
        <button data-sact="toggle" role="switch" aria-checked="${on}" title="${on ? '停用規則：' : '啟用規則：'}${esc(name)}" style="width:40px;height:24px;border-radius:12px;border:none;padding:0;cursor:pointer;position:relative;background:${on ? 'var(--accent)' : 'var(--fill)'};transition:background .22s;flex-shrink:0"><span style="position:absolute;top:3px;left:${on ? '19px' : '3px'};width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .22s cubic-bezier(.32,.72,0,1)"></span></button>
        <button data-sact="up" title="上移一列" aria-label="上移一列" ${pos === 0 ? 'disabled' : ''} style="width:22px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:${pos === 0 ? 'not-allowed' : 'pointer'};opacity:${pos === 0 ? '.35' : '1'};display:flex;align-items:center;justify-content:center;flex-shrink:0" class="${pos === 0 ? '' : 'hvAcc'}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 14 12 8 18 14"></polyline></svg></button>
        <button data-sact="down" title="下移一列" aria-label="下移一列" ${pos === state.splitRules.length - 1 ? 'disabled' : ''} style="width:22px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:${pos === state.splitRules.length - 1 ? 'not-allowed' : 'pointer'};opacity:${pos === state.splitRules.length - 1 ? '.35' : '1'};display:flex;align-items:center;justify-content:center;flex-shrink:0" class="${pos === state.splitRules.length - 1 ? '' : 'hvAcc'}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 10 12 16 18 10"></polyline></svg></button>
        <button data-sact="edit" class="hvAcc" title="編輯規則" aria-label="編輯規則" style="width:26px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h4L20 8l-4-4L4 16v4z"></path></svg></button>
        <button data-sact="del" class="hvRed" title="${pend ? '再按一次確認刪除' : '刪除規則'}" style="width:26px;height:26px;border:none;border-radius:7px;background:${pend ? 'var(--red)' : 'var(--fill2)'};color:${pend ? 'var(--on-red)' : 'var(--red)'};cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0">${pend
          ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"></path></svg>'
          : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"></path></svg>'}</button>
      </span>
    </div>`;
  }).join('');

  const noVisible = visible.length === 0
    ? `<div style="padding:26px 20px;text-align:center;color:var(--text3);font-size:12.5px;border-bottom:1px solid var(--sep)">沒有符合篩選條件的規則</div>` : '';

  const defaultRow = `<div style="display:flex;align-items:center;padding:10px 16px;font-size:12.5px;background:var(--fill2);min-width:${SPLIT_MINW}px">
    <span style="width:26px;flex-shrink:0"></span><span style="width:26px;flex-shrink:0;color:var(--text3);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:11.5px">∞</span>
    <span style="flex:1.3 1 0;min-width:150px;padding-right:12px;box-sizing:border-box;display:flex;align-items:center;gap:7px;color:var(--text2)">
      <span style="font-weight:600;white-space:nowrap">其他所有流量</span>
      <span style="font-size:9.5px;font-weight:700;letter-spacing:.3px;padding:2px 6px;border-radius:5px;background:var(--fill);color:var(--text2);white-space:nowrap">預設</span>
    </span>
    <span style="flex:1 1 0;min-width:110px;padding-right:10px;box-sizing:border-box;display:flex;align-items:center;gap:7px;color:var(--text2)">
      <span style="width:7px;height:7px;border-radius:50%;background:${splitTargetDot(state.splitDefaultTarget)};flex-shrink:0"></span>
      <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(splitTargetLabel(state.splitDefaultTarget))}</span>
    </span>
    <span style="width:${SPLIT_ACTW}px;flex-shrink:0;display:flex;justify-content:flex-end"><button id="spDefaultChange" class="hvAccDim" style="height:26px;padding:0 11px;border:1px solid var(--sep);border-radius:8px;background:var(--card);color:var(--accent);font-size:11.5px;font-weight:500;cursor:pointer;white-space:nowrap">變更</button></span>
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
    ['up', 'down'].forEach(dir => {
      const b = row.querySelector(`[data-sact="${dir}"]`);
      if (b && !b.disabled) b.onclick = e => { e.stopPropagation(); moveSplitRule(rid, dir === 'up' ? -1 : 1); };
    });
    row.querySelector('[data-sact="edit"]').onclick = e => { e.stopPropagation(); openSplitSheet(rid); };
    row.querySelector('[data-sact="del"]').onclick = e => { e.stopPropagation(); splitDeleteRule(rid); };
    const dl = row.querySelector('[data-sact="dl"]');
    if (dl) dl.onclick = e => { e.stopPropagation(); installRuleSets(missingTags(state.splitRules.find(x => x.id === rid))); };
  });
  if ($('spDefaultChange')) $('spDefaultChange').onclick = e => { e.stopPropagation(); openMenu('split-default', $('spDefaultChange')); };
}

// 順序決定命中優先，拖曳不是每個人都用得順手（也不能用鍵盤）
function moveSplitRule(rid, delta) {
  const from = state.splitRules.findIndex(x => x.id === rid);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= state.splitRules.length) return;
  const arr = [...state.splitRules];
  [arr[from], arr[to]] = [arr[to], arr[from]];
  state.splitRules = arr;
  renderSplitRules(); persistSplit({ rules: arr });
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
      <button id="spEmptyAdd" class="hvBright" style="height:34px;padding:0 16px;border:none;border-radius:9px;background:var(--accent);color:var(--on-accent);font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap">新增規則</button>
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
// 每次按啟動／停止都遞增。啟動中按了停止，晚回來的啟動結果就不該再把狀態改成「執行中」。
let engineOp = 0, engineStopping = false;
async function toggleSplitEngine() {
  if (engineStopping) return;
  if (splitRunning() || state.splitEngine === 'starting') {
    engineOp++;
    engineStopping = true;
    try {
      await window.api.engineStop();
      state.splitEngine = 'off'; state.splitTun = null;
      flash('引擎已停止，系統路由表已還原');
    } catch (e) {
      flash('停止引擎失敗：' + (e && e.message || e), 'var(--red)');
      await refreshEngineStatus();
    } finally { engineStopping = false; }
    updateSplit(); syncTitlebar();
    return;
  }
  await attemptSplitEngineStart();
}

async function attemptSplitEngineStart() {
  const op = ++engineOp;
  state.splitEngine = 'starting'; updateSplit(); syncTitlebar();
  let r;
  try { r = await window.api.engineStart(); } catch (e) { r = { ok: false, error: e.message }; }
  if (op !== engineOp) return;   // 途中被停止了
  if (r && r.ok) { state.splitEngine = 'running'; await refreshEngineStatus(); updateSplit(); syncTitlebar(); flash('分流引擎已啟動'); return; }
  state.splitEngine = 'off'; updateSplit(); syncTitlebar();
  if (r && r.cancelled) return;
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
function applySplit(sp) {
  if (!sp) return;
  if (Array.isArray(sp.rules)) state.splitRules = sp.rules;
  if (sp.defaultTarget != null) state.splitDefaultTarget = sp.defaultTarget;
  if (typeof sp.udp === 'boolean') state.splitUdp = sp.udp;
  if (sp.mode) state.splitMode = sp.mode;
  if ('globalTarget' in sp) state.splitGlobalTarget = sp.globalTarget;
  if (typeof sp.lanDirect === 'boolean') state.splitLanDirect = sp.lanDirect;
}

// 畫面是先改、後存的。存失敗時要講，並把畫面拉回實際存著的規則 ——
// 否則畫面上的規則跟引擎實際執行的不一樣，使用者完全不會知道。
async function persistSplit(patch) {
  try {
    const merged = await window.api.saveSplit(patch);
    applySplit(merged);
    if (merged && merged.engineError) flash('規則已儲存，但分流引擎無法套用：' + merged.engineError, 'var(--red)');
    if (state.tab === 'split') updateSplit();
    return true;
  } catch (e) {
    flash('儲存分流設定失敗：' + (e && e.message || e), 'var(--red)');
    try { applySplit(await window.api.getSplit()); } catch (err) {}
    if (state.tab === 'split') updateSplit();
    if (state.tab === 'settings') refreshSettings();
    return false;
  }
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
      persistSplit({ globalTarget: id });
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
  closeAllSheets();
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
    let body;   // 每個分支都會指定
    if (c.k === 'app') {
      body = `<div style="display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:8px">${seg([['name', '程式名稱'], ['path', '完整路徑']], appMatch, 'sappmode')}</div>
        <div style="display:flex;gap:8px">
          <input id="spAppValue" aria-label="程式" value="${esc((w.app || {}).value || '')}" placeholder="${appMatch === 'path' ? 'C:\\Program Files\\...\\app.exe' : 'chrome.exe'}" style="flex:1;min-width:0;height:32px;padding:0 10px;border:1px solid var(--sep);border-radius:8px;background:var(--panel);color:var(--text);font-size:12px;outline:none;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace">
          <button id="spPickProc" class="hvFill2" style="flex-shrink:0;height:32px;padding:0 11px;border:1px solid var(--sep);border-radius:8px;background:var(--panel);color:var(--text);font-size:12px;cursor:pointer;white-space:nowrap">從執行中挑選</button>
          <button id="spBrowseExe" class="hvFill2" style="flex-shrink:0;height:32px;padding:0 11px;border:1px solid var(--sep);border-radius:8px;background:var(--panel);color:var(--text);font-size:12px;cursor:pointer;white-space:nowrap">瀏覽…</button>
        </div>`;
    } else if (c.k === 'dest') {
      const isRs = dest.match === 'ruleset';
      const ui = DEST_UI[dest.match] || DEST_UI.suffix;
      body = `<div style="display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:8px">${seg(DEST_KINDS, dest.match, 'sdestkind')}</div>`;
      if (!isRs) {
        body += `<textarea id="spDestValue" aria-label="目的地" rows="3" placeholder="${esc(ui.ph)}" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--sep);border-radius:8px;background:var(--panel);color:var(--text);font-size:12px;outline:none;resize:vertical;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;line-height:1.6">${esc(dest.value || '')}</textarea>
          <span style="font-size:11px;color:var(--text3);line-height:1.5">${esc(ui.hint)}</span>`;
      } else {
        body += `<button id="spRsPick" class="hvFill2" style="display:flex;align-items:center;gap:9px;height:34px;padding:0 11px;border:1px solid var(--sep);border-radius:9px;background:var(--panel);color:${dTags.length ? 'var(--text)' : 'var(--text3)'};font-size:12.5px;cursor:pointer;text-align:left"><span style="flex:1">${dTags.length ? `已選 ${dTags.length} 個` : '選擇地區或分類…'}</span><span style="color:var(--text3);font-size:9px">▾</span></button>
          ${dTags.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${dTags.map(t => {
            const ok = isInstalled(t);
            return `<span style="display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 6px 0 9px;border-radius:13px;background:${ok ? 'var(--accent-dim)' : 'var(--amber-dim)'};color:${ok ? 'var(--accent)' : 'var(--amber)'};font-size:11.5px;font-weight:500;white-space:nowrap">${esc(catLabel(t))}<span style="font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:10px;opacity:.7">${esc(t)}</span><button data-schip="${esc(t)}" title="移除" aria-label="移除" style="width:16px;height:16px;border:none;border-radius:50%;background:rgba(0,0,0,.12);color:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0"><svg width="8" height="8" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.8"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5"></line><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"></line></svg></button></span>`;
          }).join('')}</div>` : ''}
          <span style="font-size:11px;color:var(--text3);line-height:1.5;text-wrap:pretty">依「目的地在哪個國家」或「屬於哪類網站」（如 Netflix、廣告）比對，選了才下載對應清單，可複選。</span>`;
      }
    } else if (c.k === 'port') {
      body = `<input id="spPortValue" aria-label="埠" value="${esc(w.port || '')}" placeholder="443, 80, 3000-3999" style="height:32px;padding:0 10px;border:1px solid var(--sep);border-radius:8px;background:var(--panel);color:var(--text);font-size:12px;outline:none;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace">
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
          <button id="spSheetClose" class="hvFill" title="關閉面板" aria-label="關閉面板" style="margin-left:auto;width:26px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="11" height="11" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.6"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5"></line><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"></line></svg></button>
        </div>
        <div id="spSheetBody" style="flex:1;min-height:0;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:14px">
          <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap;display:flex;align-items:center;flex-shrink:0">條件${tipIcon('全部條件同時成立才算命中；沒展開的條件＝不限。至少填一項')}</span>
          ${condHtml}
          ${d.error ? `<span style="font-size:11px;color:var(--red);line-height:1.5;flex-shrink:0">${esc(d.error)}</span>` : ''}
          <div style="display:flex;flex-direction:column;gap:8px;flex-shrink:0">
            <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">流量走向</span>
            <button id="spTargetBtn" class="hvFill2" style="display:flex;align-items:center;gap:9px;height:36px;padding:0 11px;border:1px solid var(--sep);border-radius:10px;background:var(--bg);color:${d.target === 'block' ? 'var(--red)' : 'var(--text)'};font-size:12.5px;cursor:pointer;text-align:left">
              <span style="width:7px;height:7px;border-radius:50%;background:${d.target === 'block' ? 'var(--red)' : splitTargetDot(d.target)};flex-shrink:0"></span>
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(splitTargetLabel(d.target))}</span>
              <span style="font-size:9.5px;font-weight:700;letter-spacing:.3px;padding:2px 6px;border-radius:5px;background:${d.target === 'block' ? 'var(--red-dim)' : 'var(--fill2)'};color:${d.target === 'block' ? 'var(--red)' : 'var(--text2)'};flex-shrink:0;white-space:nowrap">${splitTargetBadge(d.target)}</span>
              <span style="color:var(--text3);font-size:9px">▾</span>
            </button>
          </div>
          <div style="display:flex;flex-direction:column;gap:7px;flex-shrink:0">
            <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">顯示名稱</span>
            <input id="spDraftName" aria-label="規則名稱" value="${esc(d.name)}" placeholder="${nameAuto ? esc('留空自動使用「' + nameAuto + '」') : '例如 Chrome 連公司系統'}" style="height:34px;padding:0 11px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:13px;outline:none">
          </div>
          <details id="spJson" ${state.showJson ? 'open' : ''} style="background:var(--fill2);border-radius:12px;padding:11px 15px;flex-shrink:0">
            <summary style="font-size:11px;font-weight:600;color:var(--text3);letter-spacing:.3px;cursor:pointer;white-space:nowrap">對應 config.json</summary>
            <div style="margin-top:7px;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:11px;color:var(--text2);line-height:1.7;word-break:break-all;user-select:text" id="spDraftJson">${esc(splitDraftJson())}</div>
          </details>
        </div>
        <div style="padding:14px 20px;border-top:1px solid var(--sep);display:flex;align-items:center;gap:10px">
          <span style="flex:1"></span>
          <button id="spSheetCancel" class="hvFill2" style="height:32px;padding:0 16px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap">取消</button>
          <button id="spSheetSave" class="hvBright" style="height:32px;padding:0 18px;border:none;border-radius:9px;background:var(--accent);color:var(--on-accent);font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap">儲存規則</button>
        </div>
      </div>
    </div>`;

  const M = $('splitSheetMount');
  $('spSheetOverlay').onclick = e => { if (e.target === $('spSheetOverlay')) closeSplitSheet(); };
  $('spSheetClose').onclick = () => closeSplitSheet();
  $('spJson').ontoggle = e => { state.showJson = e.target.open; };
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
  // 打字時不重畫整張面板（會丟掉游標），只更新 JSON 預覽
  const syncJson = () => { const el = $('spDraftJson'); if (el) el.textContent = splitDraftJson(); };
  if ($('spAppValue')) $('spAppValue').addEventListener('input', e => { state.splitDraft.when.app = { match: appMatch, value: e.target.value }; syncJson(); });
  if ($('spDestValue')) $('spDestValue').addEventListener('input', e => { state.splitDraft.when.dest = { match: dest.match, value: e.target.value }; syncJson(); });
  if ($('spPortValue')) $('spPortValue').addEventListener('input', e => { state.splitDraft.when.port = e.target.value; syncJson(); });
  if ($('spDraftName')) $('spDraftName').addEventListener('input', e => { state.splitDraft.name = e.target.value; syncJson(); });
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
  else if (clean.port && !validPortSpec(clean.port)) error = '埠格式不正確（1–65535），例如 443, 80, 3000-3999';
  else if (clean.dest && clean.dest.match === 'ip') {
    const bad = splitVals(clean.dest.value).findIndex(v => !validIpOrCidr(v));
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
