'use strict';
// 伺服器分頁與伺服器編輯面板。
// renderer 的各檔都是一般 <script>（不是 module），最外層的宣告在各檔之間共用；載入順序見 index.html。

// =====================================================================================
// 伺服器分頁
// =====================================================================================
// 各欄 min-width 加左右 padding 的總和。預設視窗 900px 只給內容區 583px，所以這個值
// 必須低於它，否則常態就會出現橫向捲軸；低於此寬度才讓表格橫向捲動，不讓欄位被擠沒。
const SRV_MINW = 84 + 150 + 58 + 66 + 104 + 90 + 32;

function renderServers() {
  const rows = state.servers.map(s => {
    const pend = state.pendingSrvDel === s.id;
    const lat = s.latency;
    const why = lat < 0 ? testFailReason(s.lastError) : '';
    const tText = lat == null ? '未測試' : lat < 0 ? (why ? '失敗 · ' + why : '測試失敗') : '成功 · ' + lat + 'ms';
    const authIcon = sUser(s) ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>' : '';
    const delIcon = pend
      ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"></path></svg>'
      : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"></path></svg>';
    const addr = `${s.host}:${s.port}`;
    const nm = esc(s.name || '未命名');
    return `<div class="hvFill2" style="display:flex;align-items:center;padding:11px 16px;border-bottom:1px solid var(--sep);font-size:12.5px;min-width:${SRV_MINW}px">
      <span title="${nm}" style="flex:1 1 0;min-width:84px;max-width:220px;font-weight:600;padding-right:10px;box-sizing:border-box;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${nm}</span>
      <button class="hvFill" data-scopy="${esc(addr)}" title="點擊複製位址 ${esc(addr)}" style="flex:1.9 1 0;min-width:150px;max-width:260px;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12.5px;color:var(--text2);padding:4px 10px 4px 0;border:none;border-radius:6px;background:transparent;text-align:left;cursor:pointer;box-sizing:border-box;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(addr)}</button>
      <span style="width:58px;flex-shrink:0"><span${s.tlsInsecure && sProto(s) === 'https' ? ' data-tip="不驗證代理的憑證：帳號密碼可能被攔截。可在編輯伺服器時關閉「略過憑證驗證」" aria-label="HTTPS，不驗證憑證"' : ''} style="font-size:9.5px;font-weight:700;letter-spacing:.4px;padding:2px 6px;border-radius:5px;background:var(--fill2);color:${s.tlsInsecure && sProto(s) === 'https' ? 'var(--amber)' : 'var(--text2)'};${s.tlsInsecure && sProto(s) === 'https' ? 'box-shadow:inset 0 0 0 1px var(--amber);' : ''}white-space:nowrap">${PROTO[sProto(s)].label}</span></span>
      <span style="width:66px;flex-shrink:0;padding-right:8px;box-sizing:border-box;color:var(--text2);display:flex;align-items:center;gap:5px;white-space:nowrap">${authIcon}${sUser(s) ? '已設定' : '無'}</span>
      <span style="flex:1 1 0;min-width:104px;padding-right:12px;box-sizing:border-box;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;color:${testColor(lat)};white-space:nowrap;overflow:hidden;text-overflow:ellipsis"${lat < 0 && s.lastError ? ` data-tip="${esc(s.lastError)}"` : ''}>${esc(tText)}</span>
      <span style="width:90px;flex-shrink:0;display:flex;justify-content:flex-end;gap:6px">
        <button class="hvAcc" data-stest="${esc(s.id)}" title="${testingServers.has(s.id) ? '測試中…' : '測試連線'}" aria-label="${testingServers.has(s.id) ? '測試中' : '測試連線'}" ${testingServers.has(s.id) ? 'disabled aria-busy="true"' : ''} style="width:26px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:${testingServers.has(s.id) ? 'progress' : 'pointer'};opacity:${testingServers.has(s.id) ? '.5' : '1'};display:flex;align-items:center;justify-content:center"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5z"></path></svg></button>
        <button class="hvAcc" data-sedit="${esc(s.id)}" title="編輯" aria-label="編輯" style="width:26px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h4L20 8l-4-4L4 16v4z"></path></svg></button>
        <button class="hvRed" data-sdel="${esc(s.id)}" title="${pend ? '再按一次確認刪除' : '刪除'}" aria-label="${pend ? '再按一次確認刪除伺服器' : '刪除伺服器'}" style="width:26px;height:26px;border:none;border-radius:7px;background:${pend ? 'var(--red)' : 'var(--fill2)'};color:${pend ? 'var(--on-red)' : 'var(--red)'};cursor:pointer;display:flex;align-items:center;justify-content:center">${delIcon}</button>
      </span>
    </div>`;
  }).join('');

  $('view-servers').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px">
      <!-- 新增鈕就是標題列那顆（TAB_ADD），頁內不再放第二顆 -->
      <span style="font-size:16px;font-weight:700;letter-spacing:-.2px;white-space:nowrap;display:flex;align-items:center">伺服器${tipIcon('你的上游代理。路由會從這裡挑跳點組成鏈路')}</span>
      <div style="background:var(--card);border:1px solid var(--sep);border-radius:16px;overflow-x:auto">
        <div style="display:flex;align-items:center;padding:9px 16px;border-bottom:1px solid var(--sep);font-size:11px;color:var(--text3);font-weight:600;letter-spacing:.3px;min-width:${SRV_MINW}px">
          <span style="flex:1 1 0;min-width:84px;max-width:220px;padding-right:10px;box-sizing:border-box;white-space:nowrap">名稱</span><span style="flex:1.9 1 0;min-width:150px;max-width:260px;padding-right:10px;box-sizing:border-box;white-space:nowrap">位址</span><span style="width:58px;flex-shrink:0;white-space:nowrap">協定</span><span style="width:66px;flex-shrink:0;white-space:nowrap">認證</span><span style="flex:1 1 0;min-width:104px;padding-right:12px;box-sizing:border-box;white-space:nowrap">測試結果</span><span style="width:90px;flex-shrink:0"></span>
        </div>
        ${rows}
        ${state.servers.length === 0 ? `<div style="padding:44px 20px;text-align:center;color:var(--text3);font-size:12.5px;line-height:1.7">還沒有伺服器<br>新增後即可組成路由</div>` : ''}
      </div>
    </div>`;

  $('view-servers').querySelectorAll('[data-scopy]').forEach(b => b.onclick = () => copyText(b.dataset.scopy, '已複製位址：' + b.dataset.scopy));
  $('view-servers').querySelectorAll('[data-stest]').forEach(b => b.onclick = () => testServerRow(b.dataset.stest));
  $('view-servers').querySelectorAll('[data-sedit]').forEach(b => b.onclick = () => openSrv(b.dataset.sedit));
  $('view-servers').querySelectorAll('[data-sdel]').forEach(b => b.onclick = () => deleteServerRow(b.dataset.sdel));
}

const testingServers = new Set();   // 同一台連按不會並行跑好幾個測試
async function testServerRow(id) {
  const s = state.servers.find(x => x.id === id); if (!s) return;
  if (testingServers.has(id)) return;
  testingServers.add(id);
  if (state.tab === 'servers') renderServers();
  flash((s.name || s.host) + ' 測試中…');
  let r;
  try { r = await window.api.testServer(id, state.settings.testTarget || undefined); }
  catch (e) { r = { success: false, error: e && e.message }; }
  testingServers.delete(id);
  try { state.servers = await window.api.getServers(); } catch (e) {}
  if (state.tab === 'servers') renderServers();
  if (state.tab === 'dashboard') updateChain();
  if (r && r.success) flash((s.name || s.host) + ' 測試成功 · ' + r.latency + 'ms');
  else flash((s.name || s.host) + ' 測試失敗' + (testFailReason(r && r.error) ? '：' + testFailReason(r.error) : ''), 'var(--red)');
}

function deleteServerRow(id) {
  // 刪伺服器會默默把它從所有路由的跳點拿掉。有路由在用時要講清楚影響範圍，
  // 只剩它一個跳點的路由之後就啟動不了。
  const used = state.routes.filter(r => (r.hops || []).includes(id));
  if (used.length) {
    const srv = state.servers.find(x => x.id === id) || {};
    const orphan = used.filter(r => r.hops.length === 1);
    state.alert = {
      tone: 'warn', title: `刪除伺服器「${srv.name || srv.host || ''}」？`,
      body: `以下路由會失去這個跳點：${used.map(r => r.label || '未命名路由').join('、')}。`
        + (orphan.length ? `其中 ${orphan.map(r => r.label || '未命名路由').join('、')} 沒有其他跳點，刪除後將無法啟動。` : ''),
      primary: '刪除', secondary: '取消', danger: true,
      go: () => { closeAlert(); doDeleteServer(id); },
    };
    renderAlert();
    return;
  }
  if (state.pendingSrvDel !== id) {
    state.pendingSrvDel = id; renderServers();
    setTimeout(() => { if (state.pendingSrvDel === id) { state.pendingSrvDel = null; if (state.tab === 'servers') renderServers(); } }, 2500);
    return;
  }
  doDeleteServer(id);
}

function doDeleteServer(id) {
  state.pendingSrvDel = null;
  window.api.deleteServer(id).then(async () => {
    state.servers = await window.api.getServers();
    // 從各路由 hops 移除此伺服器並 persist
    // 一條存不進去不能讓其他路由停在指向已刪除伺服器的狀態：逐條處理、失敗的列出來
    const failed = [];
    for (const r of state.routes) {
      if (!r.hops.includes(id)) continue;
      try { await window.api.saveRoute({ ...r, hops: r.hops.filter(h => h !== id) }); }
      catch (e) { failed.push(r.label || r.id); }
    }
    if (failed.length) flash(`以下路由沒能移除這個跳點：${failed.join('、')}`, 'var(--red)');
    state.routes = await window.api.getRoutes();
    renderSidebar(); showTab(state.tab); flash('已刪除伺服器');
  }).catch(e => flash('刪除伺服器失敗：' + (e && e.message || e), 'var(--red)'));
}

// =====================================================================================
// 伺服器編輯面板（同 v1）
// =====================================================================================
function openSrv(id) {
  const S = state;
  const s = id ? S.servers.find(x => x.id === id) : null;
  closeAllSheets();
  S.srvSheet = true; S.srvEditing = id || null; S.showPass = false; S.credPick = ''; S.srvBusy = false; closeMenu();
  S.proto = s ? sProto(s) : 'socks5';
  S.authOpen = s ? !!sUser(s) : false;
  S.tlsInsecure = s ? !!s.tlsInsecure : false;   // 新伺服器預設驗證憑證
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
          <button id="ssClose" class="hvFill" title="關閉面板" aria-label="關閉面板" style="margin-left:auto;width:26px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="11" height="11" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.6"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5"></line><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"></line></svg></button>
        </div>
        <div id="ssBody" style="flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:16px">
          <div style="display:flex;flex-direction:column;gap:7px">
            <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap;display:flex;align-items:center">通訊協定${p.hint ? tipIcon(p.hint) : ''}</span>
            <button id="protoBtn" class="hvFill2" style="display:flex;align-items:center;gap:9px;padding:9px 11px;border:1px solid var(--sep);border-radius:10px;background:var(--bg);color:var(--text);font-size:13px;cursor:pointer;text-align:left">
              <span style="font-size:9.5px;font-weight:700;letter-spacing:.4px;padding:3px 6px;border-radius:5px;background:var(--accent-dim);color:var(--accent);flex-shrink:0">${p.label}</span>
              <span style="flex:1">${p.name}</span><span style="color:var(--text3);font-size:9px">▾</span>
            </button>
          </div>

          <div style="display:flex;flex-direction:column;gap:7px">
            <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">名稱</span>
            <input id="fName" aria-label="伺服器名稱" value="${esc(F.name)}" placeholder="例如：主要節點" style="padding:9px 11px;border:1px solid var(--sep);border-radius:10px;background:var(--bg);color:var(--text);font-size:13px;outline:none">
          </div>

          <div style="display:flex;gap:10px">
            <div style="flex:3;display:flex;flex-direction:column;gap:7px">
              <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">主機</span>
              <input id="fHost" aria-label="主機" value="${esc(F.host)}" placeholder="192.168.1.100" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--sep);border-radius:10px;background:var(--bg);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:13px;outline:none">
            </div>
            <div style="flex:1;display:flex;flex-direction:column;gap:7px">
              <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">端口</span>
              <input id="fPort" aria-label="端口" value="${esc(F.port)}" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--sep);border-radius:10px;background:var(--bg);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:13px;text-align:center;outline:none">
            </div>
          </div>

          <div style="background:var(--bg);border:1px solid var(--sep);border-radius:12px">
            <div style="padding:11px 13px;display:flex;align-items:center;gap:12px">
              <div style="flex:1;font-size:12.5px;font-weight:600">${p.authTitle}</div>
              <button id="authToggle" role="switch" aria-checked="${S.authOpen}" aria-label="${p.authTitle}" style="width:44px;height:26px;border-radius:13px;border:none;padding:0;cursor:pointer;position:relative;background:${S.authOpen ? 'var(--accent)' : 'var(--fill)'};transition:background .22s;flex-shrink:0">
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
                <input id="fUser" aria-label="User ID" value="${esc(F.user)}" style="padding:8px 10px;border:1px solid var(--sep);border-radius:9px;background:var(--card);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12.5px;outline:none">
              </div>` : `<div style="display:flex;gap:10px">
                <div style="flex:1;display:flex;flex-direction:column;gap:6px">
                  <span style="font-size:11px;font-weight:600;color:var(--text2);white-space:nowrap">帳號</span>
                  <input id="fUser" aria-label="帳號" value="${esc(F.user)}" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--sep);border-radius:9px;background:var(--card);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12.5px;outline:none">
                </div>
                <div style="flex:1;display:flex;flex-direction:column;gap:6px">
                  <span style="font-size:11px;font-weight:600;color:var(--text2);white-space:nowrap">密碼</span>
                  <div style="position:relative;display:flex">
                    <input id="fPass" aria-label="密碼" type="${S.showPass ? 'text' : 'password'}" value="${esc(F.pass)}" style="width:100%;box-sizing:border-box;padding:8px 32px 8px 10px;border:1px solid var(--sep);border-radius:9px;background:var(--card);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12.5px;outline:none">
                    <button id="passEye" title="顯示 / 隱藏密碼" aria-label="顯示 / 隱藏密碼" style="position:absolute;right:4px;top:50%;transform:translateY(-50%);width:24px;height:24px;border:none;background:transparent;color:var(--text3);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"></path><circle cx="12" cy="12" r="3"></circle></svg></button>
                  </div>
                </div>
              </div>`}
              <label style="display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--text2);cursor:pointer"><input id="fSaveCred" type="checkbox"> 同時存入憑證庫</label>
            </div>` : ''}
          </div>

          ${S.proto === 'https' ? `<div style="background:var(--bg);border:1px solid ${S.tlsInsecure ? 'var(--amber)' : 'var(--sep)'};border-radius:12px">
            <div style="padding:11px 13px;display:flex;align-items:center;gap:12px">
              <div style="flex:1;min-width:0">
                <div style="font-size:12.5px;font-weight:600;display:flex;align-items:center">略過憑證驗證${tipIcon('只在代理使用自簽憑證時開啟。\n開啟後無法確認連到的是真的代理，帳號密碼可能被攔截。')}</div>
                ${S.tlsInsecure ? '<div style="font-size:11.5px;color:var(--amber);margin-top:3px">不驗證代理的憑證：帳號密碼可能被攔截</div>' : ''}
              </div>
              <button id="tlsToggle" role="switch" aria-checked="${!!S.tlsInsecure}" aria-label="略過憑證驗證" style="width:44px;height:26px;border-radius:13px;border:none;padding:0;cursor:pointer;position:relative;background:${S.tlsInsecure ? 'var(--amber)' : 'var(--fill)'};transition:background .22s;flex-shrink:0">
                <span style="position:absolute;top:3px;left:${S.tlsInsecure ? '21px' : '3px'};width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .22s cubic-bezier(.32,.72,0,1)"></span>
              </button>
            </div>
          </div>` : ''}

          <div style="display:flex;flex-direction:column;gap:7px">
            <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">備註</span>
            <input id="fNote" aria-label="備註" value="${esc(F.note)}" placeholder="例如：VPS 上的 SSH 通道" style="padding:9px 11px;border:1px solid var(--sep);border-radius:10px;background:var(--bg);color:var(--text);font-size:13px;outline:none">
          </div>
        </div>
        <div style="padding:14px 20px;border-top:1px solid var(--sep);display:flex;align-items:center;gap:10px">
          <span style="flex:1"></span>
          <button id="ssCancel" class="hvFill2" style="height:32px;padding:0 16px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap">取消</button>
          <button id="ssSave" class="hvBright" style="height:32px;padding:0 18px;border:none;border-radius:9px;background:var(--accent);color:var(--on-accent);font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap">儲存並測試</button>
        </div>
      </div>
    </div>`;

  $('ssOverlay').onclick = e => { if (e.target === $('ssOverlay')) closeSrvSheet(); };
  $('ssClose').onclick = () => closeSrvSheet();
  $('ssCancel').onclick = () => closeSrvSheet();
  $('ssSave').onclick = () => saveSrvSheet();
  $('protoBtn').onclick = e => { e.stopPropagation(); syncForm(); openMenu('proto', $('protoBtn')); };
  $('authToggle').onclick = () => { syncForm(); state.authOpen = !state.authOpen; renderSrvSheet(); };
  if ($('tlsToggle')) $('tlsToggle').onclick = () => { syncForm(); state.tlsInsecure = !state.tlsInsecure; renderSrvSheet(); };
  if ($('credBtn')) $('credBtn').onclick = e => { e.stopPropagation(); syncForm(); openMenu('cred', $('credBtn')); };
  if ($('passEye')) $('passEye').onclick = () => { syncForm(); state.showPass = !state.showPass; renderSrvSheet(); };
  if ($('ssBody')) $('ssBody').scrollTop = scrollTop;
}

// 面板送出中：把按鈕停用並換字，避免同一筆資料被送出兩次
function setSheetBusy(btnId, label, busy = true) {
  const b = $(btnId); if (!b) return;
  b.disabled = busy;
  b.textContent = label;
  b.style.opacity = busy ? '.6' : '1';
  b.style.cursor = busy ? 'not-allowed' : 'pointer';
}

async function saveSrvSheet() {
  if (state.srvBusy) return;   // 連按兩下會新增兩台一模一樣的伺服器
  syncForm();
  const F = state._form;
  const host = F.host.trim();
  const port = parseInt(F.port) || PROTO[state.proto].port;
  if (!host) { flash('請輸入主機位址', 'var(--amber)'); return; }
  // 沒有這道檢查的話，打錯的埠會一路走到 net.connect，使用者看到的是 Node
  // 丟出來的原文「Port should be >= 0 and < 65536. Received type number (…)」，
  // 而且伺服器已經存進去了 —— 之後每次連線都失敗，卻看不出是哪裡不對。
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    flash('連接埠要介於 1 到 65535', 'var(--amber)');
    return;
  }
  const name = F.name.trim();
  const user = state.authOpen ? F.user.trim() : '';
  const pass = state.authOpen ? F.pass : '';
  const note = F.note.trim();
  const saveCred = $('fSaveCred') && $('fSaveCred').checked;
  const data = { name: name || host, host, port, type: state.proto, username: user, password: pass, note, tlsInsecure: state.proto === 'https' && !!state.tlsInsecure };
  let id;
  state.srvBusy = true; setSheetBusy('ssSave', '儲存中…');
  try {
    if (state.srvEditing) { await window.api.updateServer(state.srvEditing, data); id = state.srvEditing; }
    else { const srv = await window.api.addServer(data); id = srv.id; }
    state.servers = await window.api.getServers();
  } catch (e) {
    state.srvBusy = false; setSheetBusy('ssSave', '儲存並測試', false);
    flash('儲存伺服器失敗：' + (e && e.message || e), 'var(--red)');
    return;
  }
  state.srvBusy = false;
  if (saveCred && user) { state.creds.push({ id: 'c' + Date.now(), name: name || host, user, pass, note, shown: false }); saveCreds(); }
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
