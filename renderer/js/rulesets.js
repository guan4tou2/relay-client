'use strict';
// 規則庫（rule-set）管理：分流分頁的第二個子分頁。
// renderer 的各檔都是一般 <script>（不是 module），最外層的宣告在各檔之間共用；載入順序見 index.html。

// =====================================================================================
// 規則庫（rule-set）管理 — 分流分頁的第二個子分頁。
// 上：已安裝（更新 / 移除 / 檔案遺失重新下載）；下：內建目錄（下載）。另有匯入 .srs / .json。
// =====================================================================================
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
  const chips = apps.map(a => `<span style="display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 6px 0 9px;border-radius:13px;background:var(--purple-dim);color:var(--purple);font-size:11.5px;font-weight:500;white-space:nowrap">${esc(a)}<button data-kschip="${esc(a)}" title="移除" aria-label="移除" style="width:16px;height:16px;border:none;border-radius:50%;background:rgba(0,0,0,.12);color:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0"><svg width="8" height="8" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.8"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5"></line><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"></line></svg></button></span>`).join('');

  el.innerHTML = `
    <div style="padding:13px 16px;display:flex;align-items:center;gap:14px;border-top:1px solid var(--sep)">
      <div style="flex:1;min-width:0">
        ${rowTitle('受保護程式', '全部：依規則表，凡是走代理的連線都會被暫停\n指定程式：只暫停選定的程式，其餘照常上網')}
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
        ? `<button data-setdl="${esc(e.tag)}" class="hvBright" style="flex-shrink:0;height:28px;padding:0 12px;border:none;border-radius:8px;background:var(--amber);color:var(--on-amber);font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap">重新下載</button>`
        : `<button data-setup="${esc(e.tag)}" ${canUpdate ? '' : 'disabled'} class="${canUpdate ? 'hvFill2' : ''}" title="${e.source === 'import' ? '手動匯入的規則庫沒有更新來源' : '從目錄重新下載最新版'}" style="flex-shrink:0;height:28px;padding:0 12px;border:1px solid var(--sep);border-radius:8px;background:var(--bg);color:${canUpdate ? 'var(--text)' : 'var(--text3)'};font-size:11.5px;cursor:${canUpdate ? 'pointer' : 'not-allowed'};white-space:nowrap">更新</button>`}
      <button data-setdel="${esc(e.tag)}" class="hvRed" title="${pend ? '再按一次確認移除' : used ? used + ' 條規則將失效' : '移除規則庫'}" style="flex-shrink:0;width:28px;height:28px;border:none;border-radius:8px;background:${pend ? 'var(--red)' : 'var(--fill2)'};color:${pend ? 'var(--on-red)' : 'var(--red)'};cursor:pointer;display:flex;align-items:center;justify-content:center">${pend
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
      <div style="flex:1;min-width:0">${rowTitle('自動更新', `每 ${days} 天檢查一次`)}</div>
      <div style="display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:8px;opacity:${autoOn ? '1' : '.45'}">
        ${[7, 14, 30].map(d => `<button data-rsd="${d}" ${autoOn ? '' : 'disabled'} style="border:none;cursor:${autoOn ? 'pointer' : 'not-allowed'};height:26px;padding:0 10px;border-radius:6px;font-size:12px;white-space:nowrap;${segCss(days === d)}">${d}</button>`).join('')}
      </div>
      <button data-rsauto="1" role="switch" aria-checked="${autoOn}" aria-label="自動更新規則庫" style="width:44px;height:26px;border-radius:13px;border:none;padding:0;cursor:pointer;position:relative;background:${autoOn ? 'var(--accent)' : 'var(--fill)'};transition:background .22s;flex-shrink:0"><span style="position:absolute;top:3px;left:${autoOn ? '21px' : '3px'};width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .22s cubic-bezier(.32,.72,0,1)"></span></button>
    </div>
    <div style="padding:13px 16px;display:flex;align-items:center;gap:14px">
      <div style="flex:1;min-width:0">${rowTitle('下載經由', '規則庫從 GitHub 下載；連不上時可改走某條路由')}</div>
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
  window.api.rulesetRemove(tag).then(() => { flash(`已移除 ${catLabel(tag)}`); refreshRuleSets(); })
    .catch(e => { flash(`移除 ${catLabel(tag)} 失敗：` + (e && e.message || e), 'var(--red)'); refreshRuleSets(); });
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
      tone: 'info', title: '需要下載規則庫',
      body: `此範本需要下載 ${need.length} 個規則庫（${need.map(catLabel).join('、')}），要現在下載嗎？`,
      primary: '下載並套用', secondary: '取消',
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
        <div style="display:flex;gap:9px">
          <button id="spUacCancel" class="hvFill2" style="flex:1;height:36px;border:1px solid var(--sep);border-radius:10px;background:var(--bg);color:var(--text);font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap">稍後再說</button>
          <button id="spUacGrant" class="hvBright" style="flex:1;height:36px;border:none;border-radius:10px;background:var(--accent);color:var(--on-accent);font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap">繼續並提權</button>
        </div>
      </div>
    </div>`;
  $('spUacOverlay').onclick = e => { if (e.target === $('spUacOverlay')) closeSplitUac(); };
  $('spUacCancel').onclick = () => closeSplitUac();
  $('spUacGrant').onclick = () => grantSplitUac();
}
function closeSplitUac() { state.splitUac = false; $('splitUacMount').innerHTML = ''; }
