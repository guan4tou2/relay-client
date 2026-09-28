'use strict';
// 路由編輯面板（右側滑入）。
// renderer 的各檔都是一般 <script>（不是 module），最外層的宣告在各檔之間共用；載入順序見 index.html。

// =====================================================================================
// 路由編輯面板（右側滑入 470px）
// =====================================================================================
function openRoute(id) {
  const S = state;
  const r = id ? S.routes.find(x => x.id === id) : null;
  const used = S.routes.map(x => +x.localPort);
  let n = 10808; while (used.includes(n)) n++;
  closeAllSheets();
  S.routeSheet = true; S.routeEditing = id || null; S.routeBusy = false; closeMenu();
  S.draft = r ? { label: r.label, localPort: String(r.localPort), kind: r.kind, hops: [...r.hops], enabled: r.enabled !== false }
              : { label: '', localPort: String(n), kind: 'socks5', hops: [], enabled: true };
  renderRouteSheet();
}
function closeRouteSheet() { state.routeSheet = false; closeMenu(); $('sheetMount').innerHTML = ''; }
function syncDraft() { const d = state.draft; if ($('rdLabel')) d.label = $('rdLabel').value; if ($('rdPort')) d.localPort = $('rdPort').value.replace(/[^0-9]/g, '').slice(0, 5); }

// 回傳純文字；放進 innerHTML 時由呼叫端 esc()，放進 textContent 時原樣
function draftJson() {
  const d = state.draft;
  return JSON.stringify({ id: state.routeEditing || 'r-new', label: d.label || '未命名', localPort: Number(d.localPort) || 0, kind: d.kind, hops: d.hops, enabled: d.enabled }, null, 1).replace(/\n\s*/g, ' ');
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
      <button data-hup="${i}" title="上移" aria-label="上移" style="width:24px;height:24px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:${i === 0 ? '.3' : '1'}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 14 12 8 18 14"></polyline></svg></button>
      <button data-hdown="${i}" title="下移" aria-label="下移" style="width:24px;height:24px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:${i === d.hops.length - 1 ? '.3' : '1'}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 10 12 16 18 10"></polyline></svg></button>
      <button data-hrem="${i}" title="移除跳點" aria-label="移除跳點" style="width:24px;height:24px;border:none;border-radius:7px;background:var(--fill2);color:var(--red);cursor:pointer;display:flex;align-items:center;justify-content:center" class="hvRed"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>
    </div>`;
  }).join('');

  $('sheetMount').innerHTML = `
    <div id="rdOverlay" style="position:absolute;inset:0;background:rgba(0,0,0,.28);display:flex;justify-content:flex-end;z-index:50">
      <div id="rdPanel" style="width:470px;height:100%;background:var(--panel);border-left:1px solid var(--sep);box-shadow:-12px 0 40px rgba(0,0,0,.18);display:flex;flex-direction:column;animation:sheetIn .26s cubic-bezier(.32,.72,0,1)">
        <div style="padding:16px 20px;border-bottom:1px solid var(--sep);display:flex;align-items:center">
          <span style="font-size:15px;font-weight:700;letter-spacing:-.2px">${S.routeEditing ? '編輯路由' : '新增路由'}</span>
          <button id="rdClose" class="hvFill" title="關閉面板" aria-label="關閉面板" style="margin-left:auto;width:26px;height:26px;border:none;border-radius:7px;background:var(--fill2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg width="11" height="11" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.6"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5"></line><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"></line></svg></button>
        </div>
        <div id="rdBody" style="flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:16px">
          <div style="display:flex;flex-direction:column;gap:7px">
            <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap">名稱</span>
            <input id="rdLabel" aria-label="路由名稱" value="${esc(d.label)}" placeholder="例如：主要節點 SOCKS5" style="padding:9px 11px;border:1px solid var(--sep);border-radius:10px;background:var(--bg);color:var(--text);font-size:13px;outline:none">
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
              <input id="rdPort" aria-label="本地端口" value="${esc(d.localPort)}" class="${dupPort ? 'inErr' : ''}" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid ${dupPort ? 'var(--red)' : 'var(--sep)'};border-radius:10px;background:var(--bg);color:var(--text);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:13px;text-align:center;outline:none">
            </div>
          </div>
          <div id="rdPortWarn"></div>

          <div style="display:flex;flex-direction:column;gap:9px">
            <div style="display:flex;align-items:center;gap:9px">
              <span style="font-size:11.5px;font-weight:600;color:var(--text2);white-space:nowrap;display:flex;align-items:center">跳點鏈路${tipIcon('可加入多個跳點依序串鏈，最後一跳為出口')}</span>
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
            <div style="flex:1;font-size:12.5px;font-weight:600;display:flex;align-items:center">啟用此路由${tipIcon('停用時不佔用端口，也不會隨程式啟動')}</div>
            <button id="rdEnabled" role="switch" aria-checked="${d.enabled}" aria-label="啟用此路由" style="width:44px;height:26px;border-radius:13px;border:none;padding:0;cursor:pointer;position:relative;background:${d.enabled ? 'var(--accent)' : 'var(--fill)'};transition:background .22s;flex-shrink:0">
              <span style="position:absolute;top:3px;left:${d.enabled ? '21px' : '3px'};width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .22s cubic-bezier(.32,.72,0,1)"></span>
            </button>
          </div>

          <!-- config.json 對照給進階使用者，預設收合 -->
          <details id="rdJson" ${S.showJson ? 'open' : ''} style="background:var(--fill2);border-radius:12px;padding:11px 15px">
            <summary style="font-size:11px;font-weight:600;color:var(--text3);letter-spacing:.3px;cursor:pointer;white-space:nowrap">對應 config.json</summary>
            <div style="margin-top:7px;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:11px;color:var(--text2);line-height:1.7;word-break:break-all;user-select:text">${esc(draftJson())}</div>
          </details>
        </div>
        <div style="padding:14px 20px;border-top:1px solid var(--sep);display:flex;align-items:center;gap:10px">
          <span style="flex:1"></span>
          <button id="rdCancel" class="hvFill2" style="height:32px;padding:0 16px;border:1px solid var(--sep);border-radius:9px;background:var(--bg);color:var(--text);font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap">取消</button>
          <button id="rdSave" class="hvBright" style="height:32px;padding:0 18px;border:none;border-radius:9px;background:var(--accent);color:var(--on-accent);font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap">儲存路由</button>
        </div>
      </div>
    </div>`;

  $('rdOverlay').onclick = e => { if (e.target === $('rdOverlay')) closeRouteSheet(); };
  $('rdClose').onclick = () => closeRouteSheet();
  $('rdJson').ontoggle = e => { state.showJson = e.target.open; };
  $('rdCancel').onclick = () => closeRouteSheet();
  $('rdSave').onclick = () => saveRouteSheet();
  $('rdLabel').addEventListener('input', () => { state.draft.label = $('rdLabel').value; updateDraftJson(); });
  $('rdPort').addEventListener('input', () => {
    const v = $('rdPort').value.replace(/[^0-9]/g, '').slice(0, 5);
    if ($('rdPort').value !== v) $('rdPort').value = v;
    state.draft.localPort = v;
    const dup = state.routes.some(r => r.id !== state.routeEditing && String(r.localPort) === String(v));
    const bad = dup || (v !== '' && !validPortStr(v));
    $('rdPort').style.borderColor = bad ? 'var(--red)' : 'var(--sep)';
    $('rdPort').classList.toggle('inErr', bad);   // 聚焦時保留紅框，不被 accent 蓋掉
    $('rdPort').setAttribute('aria-invalid', bad ? 'true' : 'false');
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
  // 連按兩下的話，第二下會在第一次 saveRoute 回來前送出：id 用 Date.now() 產生，
  // 而 dupPort 檢查讀的是還沒更新的 state.routes —— 會生出兩條同埠路由。
  if (state.routeBusy) return;
  syncDraft();
  const d = state.draft;
  if (!validPortStr(d.localPort)) { flash('本地端口要介於 1 到 65535', 'var(--amber)'); if ($('rdPort')) $('rdPort').focus(); return; }
  if (!d.hops.length) { flash('至少要加入一個跳點', 'var(--amber)'); if ($('rdHopMenu')) $('rdHopMenu').focus(); return; }
  const dupPort = state.routes.some(r => r.id !== state.routeEditing && String(r.localPort) === String(d.localPort));
  if (dupPort) { state.alert = { kind: 'conflict', title: '本地端口衝突', body: '端口 ' + d.localPort + ' 已被其他路由使用。同一個端口無法同時服務兩條路由，請改用其他端口。' }; renderAlert(); return; }
  const id = state.routeEditing || 'r-' + Date.now();
  const rec = { id, label: d.label.trim() || '未命名路由', localPort: Number(d.localPort), kind: d.kind, hops: [...d.hops], enabled: d.enabled };
  state.routeBusy = true; setSheetBusy('rdSave', '儲存中…');
  let routes;
  try { routes = await window.api.saveRoute(rec); }
  catch (e) { state.routeBusy = false; setSheetBusy('rdSave', '儲存路由', false); flash('儲存路由失敗：' + (e && e.message || e), 'var(--red)'); return; }
  state.routeBusy = false;
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
    const r = await window.api.routeStart(id).catch(e => ({ ok: false, error: e && e.message }));
    if (r && r.ok === false && r.conflict) { state.alert = r.conflict; renderAlert(); }
    else if (!r || r.ok === false) flash('重新套用路由失敗：' + ((r && r.error) || '未知錯誤'), 'var(--red)');
    refreshRouteStatus();
  }
}
