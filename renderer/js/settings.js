'use strict';
// 憑證庫與設定分頁（含自動更新按鈕）。
// renderer 的各檔都是一般 <script>（不是 module），最外層的宣告在各檔之間共用；載入順序見 index.html。

// =====================================================================================
// 憑證庫（存在主行程，密碼以 safeStorage 加密）
// =====================================================================================
async function saveCreds() {
  try {
    const saved = await window.api.saveCreds(state.creds.map(({ id, name, user, pass, note }) => ({ id, name, user, pass, note })));
    const shown = new Set(state.creds.filter(c => c.shown).map(c => c.id));
    state.creds = (saved || []).map(c => ({ ...c, shown: shown.has(c.id) }));
    return true;
  } catch (e) { flash('儲存憑證失敗：' + e.message, 'var(--red)'); return false; }
}

// 舊版把憑證整包（含密碼）以明文放在 localStorage。第一次載入時搬進主行程，成功才刪掉舊的。
async function loadCreds() {
  let list = [];
  try { list = (await window.api.getCreds()) || []; } catch (e) {}
  let legacy = [];
  try { legacy = JSON.parse(localStorage.getItem('proxy_creds') || '[]'); } catch (e) {}
  if (Array.isArray(legacy) && legacy.length) {
    const have = new Set(list.map(c => c.id));
    const merged = [...list, ...legacy.filter(c => c && c.id && !have.has(c.id))];
    try { list = (await window.api.saveCreds(merged)) || merged; localStorage.removeItem('proxy_creds'); }
    catch (e) { list = merged; flash('搬移舊憑證失敗：' + e.message, 'var(--red)'); }
  }
  state.creds = list.map(c => ({ ...c, shown: false }));
}

// 各欄 min-width 加左右 padding 的總和，算法同 SRV_MINW
const CRED_MINW = 96 + 100 + 96 + 80 + 58 + 32;

// 新增一筆空白憑證並直接進入編輯列（標題列的「新增憑證」也走這裡）
function addCred() {
  const id = 'c' + Date.now();
  state.creds.push({ id, name: '', user: '', pass: '', note: '', shown: false });
  state.credEdit = id;
  state.cdraft = { name: '', user: '', pass: '', note: '' };
  renderCreds();
}

// 憑證是唯一沒有二次確認的刪除，而且按下去就直接覆寫 localStorage，救不回來
function deleteCredRow(id) {
  if (state.pendingCredDel !== id) {
    state.pendingCredDel = id; renderCreds();
    setTimeout(() => { if (state.pendingCredDel === id) { state.pendingCredDel = null; if (state.tab === 'creds') renderCreds(); } }, 2500);
    return;
  }
  state.pendingCredDel = null;
  state.creds = state.creds.filter(x => x.id !== id);
  state.credEdit = null;
  saveCreds(); renderCreds(); flash('已刪除憑證');
}

function renderCreds() {
  const S = state;
  const rows = S.creds.map(c => {
    if (S.credEdit === c.id) {
      return `<div style="border-bottom:1px solid var(--sep);background:var(--accent-dim)">
        <div style="padding:13px 16px;display:flex;align-items:center;flex-wrap:wrap;row-gap:9px;box-sizing:border-box;animation:fadeUp .18s ease-out">
          <span style="width:150px;padding-right:10px;box-sizing:border-box"><input id="cdName" aria-label="憑證名稱" value="${esc(S.cdraft.name)}" placeholder="名稱" style="width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid var(--accent);border-radius:8px;background:var(--bg);color:var(--text);font-size:12.5px;font-weight:600;outline:none"></span>
          <span style="width:130px;padding-right:10px;box-sizing:border-box"><input id="cdUser" aria-label="帳號" value="${esc(S.cdraft.user)}" placeholder="帳號" style="width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid var(--sep);border-radius:8px;background:var(--bg);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12.5px;outline:none"></span>
          <span style="width:120px;padding-right:10px;box-sizing:border-box"><input id="cdPass" type="password" autocomplete="new-password" aria-label="密碼" value="${esc(S.cdraft.pass)}" placeholder="密碼" style="width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid var(--sep);border-radius:8px;background:var(--bg);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12.5px;outline:none"></span>
          <div style="order:2;margin-left:auto;display:flex;justify-content:flex-end;gap:6px">
            <button id="cdCancel" class="hvFill" title="取消" aria-label="取消" style="width:26px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"></line><line x1="19" y1="5" x2="5" y2="19"></line></svg></button>
            <button id="cdSave" class="hvBright" title="完成" aria-label="完成" style="width:26px;height:26px;border:none;border-radius:7px;background:var(--accent);color:var(--on-accent);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12.5 9.5 18 20 6.5"></polyline></svg></button>
          </div>
          <span style="order:3;width:100%;box-sizing:border-box"><input id="cdNote" aria-label="備註" value="${esc(S.cdraft.note)}" placeholder="備註" style="width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid var(--sep);border-radius:8px;background:var(--bg);color:var(--text);font-size:12.5px;outline:none"></span>
        </div>
      </div>`;
    }
    const cpend = S.pendingCredDel === c.id;
    return `<div style="border-bottom:1px solid var(--sep)">
      <div class="hvFill2" style="display:flex;align-items:center;padding:11px 16px;font-size:12.5px;min-width:${CRED_MINW}px">
        <span title="${esc(c.name || '未命名')}" style="flex:1 1 0;min-width:96px;max-width:200px;padding-right:10px;box-sizing:border-box;font-weight:600;display:flex;align-items:center;gap:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="color:var(--text3);flex-shrink:0"><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg><span style="overflow:hidden;text-overflow:ellipsis">${esc(c.name || '未命名')}</span></span>
        <span title="${esc(c.user)}" style="flex:1 1 0;min-width:100px;max-width:190px;padding-right:10px;box-sizing:border-box;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.user)}</span>
        <button data-ctoggle="${esc(c.id)}" title="點擊顯示 / 隱藏" aria-label="顯示或隱藏密碼" style="flex:1 1 0;min-width:96px;max-width:190px;padding:0 10px 0 0;box-sizing:border-box;text-align:left;border:none;background:transparent;color:var(--text2);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12.5px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.shown ? esc(c.pass) : '••••••••'}</button>
        <span title="${esc(c.note || '')}" style="flex:1 1 0;min-width:80px;padding-right:10px;box-sizing:border-box;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.note || '—')}</span>
        <span style="width:58px;flex-shrink:0;display:flex;justify-content:flex-end;gap:6px">
          <button data-cedit="${esc(c.id)}" class="hvAcc" title="編輯" aria-label="編輯" style="width:26px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h4L20 8l-4-4L4 16v4z"></path></svg></button>
          <button data-cdel="${esc(c.id)}" class="hvRed" title="${cpend ? '再按一次確認刪除' : '刪除'}" aria-label="${cpend ? '再按一次確認刪除憑證' : '刪除憑證'}" style="width:26px;height:26px;border:none;border-radius:7px;background:${cpend ? 'var(--red)' : 'var(--fill2)'};color:${cpend ? 'var(--on-red)' : 'var(--red)'};cursor:pointer;display:flex;align-items:center;justify-content:center">${cpend
            ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"></path></svg>'
            : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"></path></svg>'}</button>
        </span>
      </div>
    </div>`;
  }).join('');

  $('view-creds').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px">
      <span style="font-size:16px;font-weight:700;letter-spacing:-.2px;white-space:nowrap;display:flex;align-items:center">憑證庫${tipIcon('存好帳密，新增伺服器時可直接選用。\nSOCKS5、HTTP、HTTPS 支援帳號密碼；SOCKS4 沒有密碼機制，只能附帶一個識別字串')}</span>
      <div style="background:var(--card);border:1px solid var(--sep);border-radius:16px;overflow-x:auto">
        <div style="display:flex;padding:9px 16px;border-bottom:1px solid var(--sep);font-size:11px;color:var(--text3);font-weight:600;letter-spacing:.3px;min-width:${CRED_MINW}px">
          <span style="flex:1 1 0;min-width:96px;max-width:200px;padding-right:10px;box-sizing:border-box;white-space:nowrap">名稱</span><span style="flex:1 1 0;min-width:100px;max-width:190px;padding-right:10px;box-sizing:border-box;white-space:nowrap">帳號</span><span style="flex:1 1 0;min-width:96px;max-width:190px;padding-right:10px;box-sizing:border-box;white-space:nowrap">密碼</span><span style="flex:1 1 0;min-width:80px;padding-right:10px;box-sizing:border-box;white-space:nowrap">備註</span><span style="width:58px;flex-shrink:0"></span>
        </div>
        ${rows}
        ${S.creds.length === 0 ? `<div style="padding:44px 20px;text-align:center;color:var(--text3);font-size:12.5px;line-height:1.7">還沒有儲存的憑證<br>新增後即可在伺服器表單選用</div>` : ''}
      </div>
    </div>`;

  $('view-creds').querySelectorAll('[data-ctoggle]').forEach(b => b.onclick = () => { const c = S.creds.find(x => x.id === b.dataset.ctoggle); c.shown = !c.shown; renderCreds(); });
  $('view-creds').querySelectorAll('[data-cedit]').forEach(b => b.onclick = () => { const c = S.creds.find(x => x.id === b.dataset.cedit); S.credEdit = c.id; S.cdraft = { name: c.name, user: c.user, pass: c.pass, note: c.note }; renderCreds(); });
  $('view-creds').querySelectorAll('[data-cdel]').forEach(b => b.onclick = () => deleteCredRow(b.dataset.cdel));
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
    // desc 是懸浮說明（ⓘ）；標題已經講清楚的就不寫
    { key: 'tray', label: '關閉時最小化到系統匣', desc: '關閉視窗後繼續在背景執行' },
    { key: 'bootLaunch', label: '開機時自動啟動' },
    { key: 'autostart', label: '啟動時自動套用路由', desc: '開啟 RelayClient 時自動啟動已啟用的路由' },
    { key: 'scroll', label: '紀錄自動捲動' },
    { key: 'nodebug', label: '隱藏除錯訊息' },
    { key: 'logConns', label: '把每條連線寫入紀錄檔', desc: '診斷用。連線量大時紀錄檔很快就會輪替掉' },
  ],
};

// 設定列的標題；說明收進 ⓘ 懸浮顯示
const rowTitle = (label, tip) => `<div style="font-size:13px;font-weight:500;white-space:nowrap;display:flex;align-items:center">${label}${tip ? tipIcon(tip) : ''}</div>`;
const swRow = (w, last) => `
  <div style="padding:13px 16px;display:flex;align-items:center;gap:14px;${last ? '' : 'border-bottom:1px solid var(--sep)'}">
    <div style="flex:1;min-width:0">${rowTitle(w.label, w.desc)}</div>
    <button data-sw="${w.key}" role="switch" aria-checked="false" aria-label="${w.label}" style="width:44px;height:26px;border-radius:13px;border:none;padding:0;cursor:pointer;position:relative;background:var(--fill);transition:background .22s;flex-shrink:0">
      <span style="position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .22s cubic-bezier(.32,.72,0,1)"></span>
    </button>
  </div>`;

const group = (title, inner, desc) => `
  <div style="display:flex;flex-direction:column;gap:8px">
    <span style="font-size:11.5px;font-weight:600;color:var(--text3);letter-spacing:.4px;padding-left:4px;white-space:nowrap;display:flex;align-items:center">${title}${desc ? tipIcon(desc) : ''}</span>
    <div style="background:var(--card);border:1px solid var(--sep);border-radius:16px;overflow:hidden">${inner}</div>
  </div>`;

function buildSettings() {
  $('view-settings').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:18px">

      ${group('外觀', `
        <div style="padding:13px 16px;display:flex;align-items:center;gap:14px">
          <div style="flex:1;min-width:0">${rowTitle('主題')}</div>
          <div id="themeSeg" style="display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:8px"></div>
        </div>`)}

      ${group('行為', SW_GROUPS.behavior.map((w, i) => swRow(w, i === SW_GROUPS.behavior.length - 1)).join(''))}

      ${group('連線', `
        ${swRow({ key: 'udp', label: 'UDP 轉發', desc: '能否真的走代理要看上游伺服器支援' }, false)}
        <div style="padding:13px 16px;display:flex;align-items:center;gap:14px">
          <div style="flex:1;min-width:0">${rowTitle('連線測試目標', '測試伺服器時要連去的網站；留空則只測協定握手')}</div>
          <div style="display:flex;align-items:center;gap:5px">
            <input id="setTestHost" aria-label="連線測試目標主機" placeholder="example.com" style="width:158px;height:30px;padding:0 10px;border:1px solid var(--sep);border-radius:8px;background:var(--bg);color:var(--text);font-size:12.5px;outline:none">
            <span style="color:var(--text3)">:</span>
            <input id="setTestPort" aria-label="連線測試目標連接埠" placeholder="443" style="width:56px;height:30px;padding:0 8px;border:1px solid var(--sep);border-radius:8px;background:var(--bg);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12.5px;outline:none;text-align:center">
          </div>
        </div>`)}

      ${group('斷線保護', `
        ${swRow({ key: 'killswitch', label: '斷線保護', desc: '引擎意外停止時先暫停受保護程式的連線' }, false)}
        <div id="ksScopeRow"></div>
        <div id="ksAutoRow">${swRow({ key: 'ksauto', label: '自動重連', desc: '觸發後自動重試 3 次，每次間隔 4 秒' }, true)}</div>`)}

      ${group('規則庫', '<div id="setRuleSets"></div>', '存在 %APPDATA%\\RelayClient\\rulesets\\，只有按下載時才連網')}

      ${group('資料', `
        <div style="padding:13px 16px;display:flex;align-items:center;gap:14px">
          <div style="flex:1;min-width:0">${rowTitle('匯入 / 匯出設定', '備份伺服器與路由；匯出時可選擇是否包含密碼')}</div>
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

let testTargetTimer = null;
function updateTestTarget() {
  const host = $('setTestHost').value.trim();
  const raw = $('setTestPort').value.trim();
  const ok = raw === '' || validPortStr(raw);
  $('setTestPort').style.borderColor = ok ? 'var(--sep)' : 'var(--red)';
  $('setTestPort').setAttribute('aria-invalid', ok ? 'false' : 'true');
  if (!ok) return;   // 不合法的埠不存；框線標紅就好，不要每打一個字跳一次提示
  state.settings.testTarget = host ? { host, port: raw ? Number(raw) : 443 } : null;
  clearTimeout(testTargetTimer);
  testTargetTimer = setTimeout(saveSettings, 400);   // 以前每按一個鍵就寫一次設定檔
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
  else if (key === 'logConns') state.settings.logConnections = !state.settings.logConnections;
  else localStorage.setItem('sw_' + key, localStorage.getItem('sw_' + key) === '1' ? '0' : '1');
  saveSettings(); refreshSettings();
  if (key === 'nodebug' && state.tab === 'logs') renderLogList();
}
// 「隱藏除錯訊息」以前只有 swOn 讀得到，沒有任何地方真的拿它過濾 —— 等於裝飾用的開關。
// 逐連線的 CONNECT 現在是 debug，這個開關才真的有東西可以關。
function hideDebug() { return localStorage.getItem('sw_nodebug') === '1'; }
function swOn(key) {
  if (key === 'tray') return state.settings.minimizeToTray !== false;
  if (key === 'bootLaunch') return !!state.bootLaunch;
  if (key === 'autostart') return state.settings.autoStartRoutes !== false;
  if (key === 'killswitch') return !!state.settings.killSwitch;
  if (key === 'ksauto') return state.settings.killSwitchAutoReconnect !== false;
  if (key === 'udp') return !!state.splitUdp;
  if (key === 'rsauto') return !!state.settings.rulesetAutoUpdate;
  if (key === 'logConns') return !!state.settings.logConnections;
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

// 存失敗要講，並把畫面拉回主行程那邊的真實值：斷線保護這類開關，
// 畫面顯示「開」但其實沒存進去，比沒有開關還危險。
async function saveSettings() {
  try {
    await window.api.updateSettings(settingsPayload());
  } catch (e) {
    flash('儲存設定失敗：' + (e && e.message || e), 'var(--red)');
    try { const s = await window.api.getSettings(); if (s) state.settings = { ...state.settings, ...s }; } catch (err) {}
    refreshSettings();
  }
}
function settingsPayload() {
  return {
    minimizeToTray: state.settings.minimizeToTray, autoStartRoutes: state.settings.autoStartRoutes,
    killSwitch: state.settings.killSwitch, testTarget: state.settings.testTarget,
    rulesetAutoUpdate: state.settings.rulesetAutoUpdate, rulesetUpdateDays: state.settings.rulesetUpdateDays,
    rulesetDetourRouteId: state.settings.rulesetDetourRouteId,
    killSwitchAutoReconnect: state.settings.killSwitchAutoReconnect,
    killSwitchScope: state.settings.killSwitchScope, killSwitchApps: state.settings.killSwitchApps,
    logConnections: state.settings.logConnections,
  };
}
