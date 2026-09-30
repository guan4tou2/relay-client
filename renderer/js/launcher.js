'use strict';
// 實例分流：用路由啟動瀏覽器或其他程式。
// renderer 的各檔都是一般 <script>（不是 module），最外層的宣告在各檔之間共用；載入順序見 index.html。

// =====================================================================================
// 實例分流：以路由啟動程式（設計稿 v5；MERGE §1 路由列第三顆鈕開這張 sheet）
// =====================================================================================
function openLaunchSheet(routeId) {
  const rid = routeId || state.sel || (state.routes[0] || {}).id;
  if (!rid) { flash('請先建立一條路由', 'var(--amber)'); return; }
  closeAllSheets();
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
// 每打一個字送一次；慢的那個晚回來時不能蓋掉新的
let launchPreviewSeq = 0;
async function refreshLaunchPreview() {
  const d = state.launchDraft; if (!d) return;
  const seq = ++launchPreviewSeq;
  let text;
  try { text = (await window.api.launchPreview(d)) || ''; } catch { text = ''; }
  if (seq !== launchPreviewSeq) return;
  state.launchPreview = text;
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
      <span style="font-size:10px;color:var(--text3);white-space:nowrap">${b.found ? '&nbsp;' : '未安裝'}</span>
    </button>`;
  }).join('');

  const engineOff = !isBrowser && !!d.exePath && !splitRunning();
  const programBody = `
        <div style="display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;gap:8px">
            <input id="lsPath" aria-label="程式路徑" value="${esc(d.exePath)}" placeholder="程式的完整路徑" style="flex:1;min-width:0;height:34px;padding:0 11px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12px;outline:none">
            <button id="lsBrowse" class="hvFill2" style="flex-shrink:0;height:34px;padding:0 13px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap">瀏覽…</button>
          </div>
          <input id="lsArgs" aria-label="啟動參數" value="${esc(d.exeArgs)}" placeholder="啟動參數（選填）" style="height:34px;padding:0 11px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12px;outline:none">
          ${engineOff ? '<span style="display:flex;align-items:center;gap:8px;padding:9px 11px;border-radius:9px;background:var(--amber-dim);font-size:11px;color:var(--amber);line-height:1.5"><span style="flex:1;text-wrap:pretty">分流引擎未執行。這支程式要走代理，得先到分流頁啟動引擎。</span></span>' : ''}
          <div style="background:var(--bg);border:1px solid var(--sep);border-radius:12px;overflow:hidden">
            <div style="display:flex;align-items:center;gap:12px;padding:10px 13px">
              <div style="flex:1;min-width:0">
                <div style="font-size:12.5px;font-weight:500;white-space:nowrap">登記成程式規則</div>
                <div style="font-size:11px;color:var(--text2);margin-top:2px;line-height:1.45;text-wrap:pretty">引擎只認程式名稱，沒有「只有這次」。關掉的話就只是啟動程式，不會走代理。</div>
              </div>
              <button data-lsremember="1" role="switch" aria-checked="${d.remember}" aria-label="登記成程式規則" style="width:40px;height:24px;border-radius:12px;border:none;padding:0;cursor:pointer;position:relative;background:${d.remember ? 'var(--accent)' : 'var(--fill)'};transition:background .22s;flex-shrink:0"><span style="position:absolute;top:3px;left:${d.remember ? '19px' : '3px'};width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .22s cubic-bezier(.32,.72,0,1)"></span></button>
            </div>
          </div>
        </div>`;

  m.innerHTML = `
  <div id="lsOverlay" style="position:absolute;inset:0;background:rgba(0,0,0,.28);display:flex;justify-content:flex-end;z-index:60">
    <div id="lsPanel" style="width:470px;height:100%;background:var(--panel);border-left:1px solid var(--sep);box-shadow:-12px 0 40px rgba(0,0,0,.18);display:flex;flex-direction:column;animation:sheetIn .26s cubic-bezier(.32,.72,0,1)">
      <div style="padding:16px 20px;border-bottom:1px solid var(--sep);display:flex;align-items:center;gap:10px">
        <span style="font-size:15px;font-weight:700;letter-spacing:-.2px;white-space:nowrap">以路由啟動程式</span>
        <button id="lsClose" class="hvFill2" title="關閉面板（Esc）" aria-label="關閉面板（Esc）" style="margin-left:auto;width:26px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="11" height="11" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.6"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5"></line><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"></line></svg></button>
      </div>

      <div style="flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:16px">
        <div style="display:flex;flex-direction:column;gap:7px">
          <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">路由</span>
          <button id="lsRoute" class="hvFill2" style="display:flex;align-items:center;gap:9px;height:36px;padding:0 11px;border:1px solid var(--sep);border-radius:10px;background:var(--bg);color:var(--text);font-size:12.5px;cursor:pointer;text-align:left">
            <span style="width:7px;height:7px;border-radius:50%;background:${running ? 'var(--good)' : 'var(--text3)'};flex-shrink:0"></span>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(route.label || '未命名路由')}</span>
            <span style="font-size:11px;color:var(--text3);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;white-space:nowrap">${route.kind === 'http' ? 'HTTP' : 'SOCKS5'} · ${esc(route.localPort || '')}</span>
            <span style="color:var(--text3);font-size:9px">▾</span>
          </button>
          ${running ? '' : '<span style="font-size:11px;color:var(--text3);line-height:1.5">此路由尚未啟動，啟動程式時會先自動啟動路由。</span>'}
        </div>

        <div style="display:flex;flex-direction:column;gap:8px">
          <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap;display:flex;align-items:center">要啟動什麼${tipIcon('瀏覽器：只有這個視窗走代理，關掉即結束；不需引擎或權限，不影響平常的瀏覽器\n其他程式：登記成程式規則後由分流引擎比對，需引擎執行中')}</span>
          <div style="display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:9px">${modeSeg}</div>
        </div>

        ${isBrowser ? `<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px">${browserCards || '<span style="font-size:11.5px;color:var(--text3)">找不到可用的瀏覽器</span>'}</div>` : programBody}

        <details id="lsPreviewBox" ${state.showJson ? 'open' : ''} style="background:var(--fill2);border-radius:12px;padding:11px 15px">
          <summary style="font-size:11px;font-weight:600;color:var(--text3);letter-spacing:.3px;cursor:pointer;white-space:nowrap">將執行的指令</summary>
          <div id="lsPreview" style="margin-top:7px;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:11px;color:var(--text2);line-height:1.7;word-break:break-all;user-select:text;white-space:pre-wrap">${esc(state.launchPreview)}</div>
        </details>
      </div>

      <div style="padding:14px 20px;border-top:1px solid var(--sep);display:flex;align-items:center;gap:10px">
        <span style="font-size:11.5px;color:var(--text3);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${isBrowser ? '' : (d.exePath ? '規則對這支程式一律生效，不只這次' : '')}</span>
        <button id="lsCancel" class="hvFill2" style="height:32px;padding:0 16px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap">取消</button>
        <button id="lsGo" ${canLaunch ? '' : 'disabled'} class="${canLaunch ? 'hvBright' : ''}" style="height:32px;padding:0 18px;border:none;border-radius:9px;background:var(--accent);color:var(--on-accent);font-size:12.5px;font-weight:600;cursor:${canLaunch ? 'pointer' : 'not-allowed'};white-space:nowrap;opacity:${canLaunch ? '1' : '.5'}">${state.launchBusy ? '啟動中…' : target ? '啟動 ' + esc(target) : '啟動'}</button>
      </div>
    </div>
  </div>`;

  $('lsOverlay').onclick = () => closeLaunchSheet();
  $('lsPanel').onclick = e => e.stopPropagation();
  $('lsClose').onclick = () => closeLaunchSheet();
  $('lsPreviewBox').ontoggle = e => { state.showJson = e.target.open; };
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
      <span style="width:78px;flex-shrink:0"><span title="${isB ? '啟動參數綁定代理，免提權' : '分流引擎依程式名稱比對'}" style="font-size:9.5px;font-weight:700;letter-spacing:.3px;padding:2px 6px;border-radius:5px;background:${isB ? 'var(--accent-dim)' : 'var(--purple-dim)'};color:${isB ? 'var(--accent)' : 'var(--purple)'};white-space:nowrap">${isB ? '獨立實例' : '引擎接管'}</span></span>
      <span style="flex:1;min-width:0;display:flex;align-items:center;gap:7px">
        <span style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${on ? 'var(--good)' : 'var(--amber)'};animation:${on ? 'dotBeat 2.2s ease-in-out infinite' : 'none'}"></span>
        <span style="display:flex;flex-direction:column;min-width:0;gap:1px">
          <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${on ? 'var(--text)' : 'var(--amber)'}">${esc(route ? (route.label || i.routeId) : '（路由已刪除）')}</span>
          <span style="font-size:10.5px;color:var(--text3);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;white-space:nowrap">${route ? '127.0.0.1:' + esc(route.localPort) : ''}</span>
        </span>
      </span>
      <span style="width:64px;flex-shrink:0;display:flex;justify-content:flex-end">
        <button data-killinst="${esc(i.id)}" class="hvRed" title="${pend ? '再按一次確認結束' : '結束此實例'}" aria-label="${pend ? '再按一次確認結束實例' : '結束此實例'}" style="width:26px;height:26px;border:none;border-radius:7px;background:${pend ? 'var(--red)' : 'var(--fill2)'};color:${pend ? 'var(--on-red)' : 'var(--red)'};cursor:pointer;display:flex;align-items:center;justify-content:center">${pend
          ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M5 13l4 4L19 7"></path></svg>'
          : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>'}</button>
      </span>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div style="display:flex;align-items:flex-end;gap:12px;margin-bottom:14px">
      <div style="display:flex;flex-direction:column;gap:3px;min-width:0">
        <span style="font-size:15px;font-weight:700;letter-spacing:-.2px;white-space:nowrap;display:flex;align-items:center">實例分流${tipIcon('只有從這裡啟動的實例走代理，平常開的同名程式照常')}</span>
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

// 跟 src/main/killswitch.js 的 KS_MAX_RETRY 保持一致（那邊是真正控制重試次數的地方）
const KS_MAX_RETRY = 3;

function renderKillswitch() {
  const k = state.killswitch, m = $('ksMount'), bar = $('ksBar');
  if (!k || !k.tripped) { m.innerHTML = ''; if (bar) bar.innerHTML = ''; state.ksAlertOpen = false; return; }

  // 設計稿是兩層：觸發時彈對話框讓使用者做決定，
  // 決定完（或重連失敗）之後仍留一條紅帶，按「查看」可以把對話框叫回來。
  if (bar) {
    bar.innerHTML = `<div style="flex-shrink:0;display:flex;align-items:center;gap:10px;padding:9px 16px;background:var(--red);color:var(--on-red);font-size:12.5px;font-weight:500;animation:fadeUp .2s ease-out">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M12 3l7 3.5v5c0 4.2-2.9 7-7 8.5-4.1-1.5-7-4.3-7-8.5v-5L12 3z"></path><path d="M12 9v4M12 16.5h.01"></path></svg>
      <span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">斷線保護已啟動 · ${k.blocking ? '依規則分流的連線已暫停' : '封鎖模式未生效，目前沒有保護'}</span>
      <button id="ksBarOpen" style="height:26px;padding:0 11px;border:1px solid color-mix(in srgb, var(--on-red) 55%, transparent);border-radius:8px;background:transparent;color:var(--on-red);font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap">查看</button>
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
      <div id="ksBox" style="width:440px;background:var(--panel);border:1px solid var(--sep);border-radius:20px;box-shadow:0 28px 70px rgba(0,0,0,.36);padding:26px 26px 22px;display:flex;flex-direction:column;gap:16px;animation:fadeUp .22s ease-out">
        <div style="display:flex;align-items:center;gap:14px">
          <div style="width:52px;height:52px;flex-shrink:0;border-radius:15px;background:var(--red-dim);display:flex;align-items:center;justify-content:center;color:var(--red);animation:shieldIn .35s cubic-bezier(.32,.72,0,1)">
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
          <button id="ksReconnect" class="hvBright" style="flex:1;height:38px;border:none;border-radius:11px;background:var(--accent);color:var(--on-accent);font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;display:flex;align-items:center;justify-content:center;gap:7px">${k.reconnecting ? '重新啟動引擎…' : '重新連線'}</button>
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
    try { await window.api.killswitchClear(); flash('已停用分流，網路恢復直連', 'var(--amber)'); }
    catch (e) { flash('停用分流失敗：' + (e && e.message || e) + '（受保護的程式仍被封鎖）', 'var(--red)'); }
  };
}
