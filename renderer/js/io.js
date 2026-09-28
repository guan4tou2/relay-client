'use strict';
// 匯入／匯出（伺服器＋路由，不含密碼）。
// renderer 的各檔都是一般 <script>（不是 module），最外層的宣告在各檔之間共用；載入順序見 index.html。

// =====================================================================================
// 匯入 / 匯出（伺服器 + 路由，不含密碼）
// =====================================================================================
async function exportData() {
  let servers, routes;
  try { [servers, routes] = await Promise.all([window.api.getServers(), window.api.getRoutes()]); }
  catch (e) { flash('讀取設定失敗：' + (e && e.message || e), 'var(--red)'); return; }
  if (!servers.length && !routes.length) { flash('沒有可匯出的設定', 'var(--amber)'); return; }
  // 密碼預設不匯出——匯出檔常常會被丟進聊天室或雲端硬碟。要帶的話必須明確選擇。
  state.alert = {
    tone: 'info', title: '匯出設定',
    body: `將匯出 ${servers.length} 台伺服器與 ${routes.length} 條路由。代理密碼預設不包含在檔案裡。`,
    primary: '包含密碼一起匯出', secondary: '不含密碼',
    go: () => { closeAlert(); doExport(servers, routes, true); },
    onSecondary: () => { closeAlert(); doExport(servers, routes, false); },
  };
  renderAlert();
}

function doExport(servers, routes, withPass) {
  // id 一定要帶：路由的 hops 存的是伺服器 id，匯入端要靠它把跳點對回新建的伺服器
  const pick = s => withPass
    ? { id: s.id, name: s.name, host: s.host, port: s.port, type: s.type, note: s.note, username: s.username, password: s.password }
    : { id: s.id, name: s.name, host: s.host, port: s.port, type: s.type, note: s.note };
  const payload = { servers: servers.map(pick), routes, exportedAt: new Date().toISOString(), includesPasswords: !!withPass };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = withPass ? 'relayclient-config-with-passwords.json' : 'relayclient-config.json';
  a.click();
  // 立刻 revoke 在部分 Chromium 版本會把還沒開始的下載取消掉
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  flash(withPass
    ? `已匯出 ${servers.length} 台伺服器（含密碼，請妥善保管）`
    : `已匯出 ${servers.length} 台伺服器 · ${routes.length} 條路由`, withPass ? 'var(--amber)' : undefined);
}

function importData() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const { servers, routes } = parseImportFile(JSON.parse(await file.text()));
      if (!servers.length && !routes.length) { flash('檔案裡沒有可匯入的設定', 'var(--amber)'); return; }

      // 衝突偵測：同名同位址的伺服器、或同 id／同本地埠的路由
      const curServers = await window.api.getServers();
      const curRoutes = await window.api.getRoutes();
      const dupServers = servers.filter(s => curServers.some(c => c.host === s.host && String(c.port) === String(s.port)));
      const dupRoutes = routes.filter(r => curRoutes.some(c => c.id === r.id || String(c.localPort) === String(r.localPort)));

      if (dupServers.length || dupRoutes.length) {
        const parts = [];
        if (dupServers.length) parts.push(`${dupServers.length} 台伺服器位址重複`);
        if (dupRoutes.length) parts.push(`${dupRoutes.length} 條路由的 id 或本地埠重複`);
        state.alert = {
          tone: 'info', title: '匯入設定有衝突',
          body: `${parts.join('、')}。「略過重複」會保留你現有的設定；「覆蓋」會用檔案裡的版本取代。`,
          primary: '覆蓋現有設定', secondary: '略過重複',
          go: () => { closeAlert(); doImport(servers, routes, true); },
          onSecondary: () => { closeAlert(); doImport(servers, routes, false); },
        };
        renderAlert();
        return;
      }
      doImport(servers, routes, false);
    } catch (err) { flash('匯入失敗：' + err.message, 'var(--red)'); }
  };
  input.click();
}

async function doImport(servers, routes, overwrite) {
  try {
    const curServers = await window.api.getServers();
    const curRoutes = await window.api.getRoutes();
    let ns = 0, skipped = 0;
    // 匯出端的伺服器 id → 這台機器上的 id。伺服器匯入時會拿到新 id，
    // 路由的 hops 不改寫的話會指向不存在的伺服器，路由整條不能用。
    const idMap = new Map();
    for (const s of servers) {
      const dup = curServers.find(c => c.host === s.host && String(c.port) === String(s.port));
      if (dup) idMap.set(s.id, dup.id);   // 略過或覆蓋都沿用現有那台
      if (dup && !overwrite) { skipped++; continue; }
      const rec = { name: s.name || s.host, host: s.host, port: s.port, type: s.type || 'socks5', username: s.username || '', password: s.password || '', note: s.note || '' };
      if (dup) await window.api.updateServer(dup.id, rec);
      else { const added = await window.api.addServer(rec); if (s.id && added) idMap.set(s.id, added.id); }
      ns++;
    }
    const known = new Set([...curServers.map(c => c.id), ...idMap.values()]);
    let nr = 0, lostHops = 0;
    let badRoutes = 0;
    for (const r of routes) {
      // 整理規則見 lib.js 的 normalizeImportedRoute（埠／類型檢查、id 換新、跳點對回本機伺服器）
      const n = normalizeImportedRoute(r, { idMap, known, fallbackId: 'r-' + Date.now() + '-' + nr });
      if (!n) continue;
      if (n.bad) { badRoutes++; continue; }
      const dup = curRoutes.find(c => c.id === n.route.id || String(c.localPort) === String(n.route.localPort));
      if (dup && !overwrite) { skipped++; continue; }
      // 舊版匯出檔沒有伺服器 id，對不回去的跳點只能拿掉，並在結果裡講明
      lostHops += n.lostHops;
      await window.api.saveRoute(n.route); nr++;
    }
    state.servers = await window.api.getServers();
    state.routes = await window.api.getRoutes();
    if (!state.sel && state.routes[0]) state.sel = state.routes[0].id;
    renderSidebar(); showTab(state.tab);
    flash(`已匯入 ${ns} 台伺服器 · ${nr} 條路由` + (skipped ? `（略過 ${skipped} 筆重複）` : '')
      + (lostHops ? `；${lostHops} 個跳點對不到伺服器，已移除，請重新設定` : '')
      + (badRoutes ? `；${badRoutes} 條路由格式不正確，已略過` : ''), (lostHops || badRoutes) ? 'var(--amber)' : undefined);
  } catch (err) { flash('匯入失敗：' + err.message, 'var(--red)'); }
}
