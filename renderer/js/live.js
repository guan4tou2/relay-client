'use strict';
// 傳輸統計取樣與路由狀態對帳。
// renderer 的各檔都是一般 <script>（不是 module），最外層的宣告在各檔之間共用；載入順序見 index.html。

// =====================================================================================
// 傳輸統計 tick（300ms 取樣；速率由真實累計位元組差分推得）
// =====================================================================================
// 視窗沒有焦點或被遮住時，Chromium 會把這個 300ms 計時器拉長到約 1 秒（實測 30 秒只跑 31 次）。
// 所以速率要除以「實際經過的時間」，不是固定的 0.3 秒——否則背景時速率會被放大 3 倍多；
// 漏掉的格數也要補上，不然「5 分鐘」那 1000 格實際上涵蓋了十幾分鐘。
setInterval(() => {
  let selDirty = false;
  const now = performance.now();
  Object.keys(state.sessions).forEach(id => {
    const s = state.sessions[id];
    if (s.status !== 'running') { s._pt = 0; return; }
    const pu = s._pu || 0, pd = s._pd || 0;
    const elapsed = s._pt ? Math.max(TICK_MS, now - s._pt) : TICK_MS;
    s._pt = now;
    const up = Math.max(0, (s.upT || 0) - pu) / (elapsed / 1000), down = Math.max(0, (s.downT || 0) - pd) / (elapsed / 1000);
    s._pu = s.upT || 0; s._pd = s.downT || 0;
    s.up = up; s.down = down;
    const ser = s.series || (s.series = []);
    const n = Math.min(SERIES_MAX, Math.max(1, Math.round(elapsed / TICK_MS)));
    for (let i = 0; i < n; i++) ser.push({ down, up });
    if (ser.length > SERIES_MAX) ser.splice(0, ser.length - SERIES_MAX);
    if (s.startTs) s.uptime = Math.floor((Date.now() - s.startTs) / 1000);
    if (id === state.sel) selDirty = true;
  });
  if (selDirty && state.tab === 'dashboard') updateTraffic();
}, TICK_MS);

// =====================================================================================
// 狀態同步（onRouteStatus 對帳）
// =====================================================================================
function reconcileStatus(list) {
  const arr = Array.isArray(list) ? list : [];
  const runningIds = new Set(arr.filter(s => s.running).map(s => s.id));
  arr.forEach(s => {
    if (!s.running) return;
    const cur = state.sessions[s.id];
    if (!cur || (cur.status !== 'running' && cur.status !== 'connecting' && cur.status !== 'closing')) {
      setSes(s.id, { status: 'running', prog: 1, settle: false, startTs: (cur && cur.startTs) || Date.now(),
        series: (cur && cur.series) || [], upT: (cur && cur.upT) || 0, downT: (cur && cur.downT) || 0, conns: (cur && cur.conns) || 0, uptime: (cur && cur.uptime) || 0,
        _pu: (cur && cur.upT) || 0, _pd: (cur && cur.downT) || 0 });   // 基準接著現有累計，不然第一格會把全部累計算成瞬間流量
    }
  });
  Object.keys(state.sessions).forEach(id => {
    const s = state.sessions[id];
    if (!runningIds.has(id) && s.status === 'running') dropSes(id);
  });
  afterStatusChange();
}
