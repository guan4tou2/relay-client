'use strict';
// 紀錄分頁。
// renderer 的各檔都是一般 <script>（不是 module），最外層的宣告在各檔之間共用；載入順序見 index.html。

// =====================================================================================
// 紀錄
// =====================================================================================
function buildLogs() {
  $('view-logs').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px;height:100%">
      <!-- 這排在最小視窗（可用寬 483px）塞不下，所以讓右半組整組換行。
           flex 是先換行才縮，而且換行與否看的是「最大內容寬」：input 沒給寬度時
           那是瀏覽器預設的 ~192px，預設視窗就會被推到第二行。所以搜尋框要寫死
           width:92px（再靠 flex-grow 長回去），預設視窗才排得下同一行。 -->
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;row-gap:9px">
        <div id="levelSeg" style="display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:8px;flex-shrink:0"></div>
        <div style="flex:1 1 auto;display:flex;align-items:center;justify-content:flex-end;gap:7px;min-width:0">
          <input id="logSearch" aria-label="搜尋紀錄" placeholder="搜尋…" style="width:92px;min-width:88px;flex:1 1 auto;height:30px;padding:0 11px;border:1px solid var(--sep);border-radius:9px;background:var(--card);color:var(--text);font-size:12.5px;outline:none">
          <button id="logOpen" class="hvFill2" title="開啟紀錄檔資料夾" style="height:30px;padding:0 13px;border:1px solid var(--sep);border-radius:9px;background:var(--card);color:var(--text);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap">紀錄檔</button>
          <button id="logCopy" class="hvFill2" style="height:30px;padding:0 13px;border:1px solid var(--sep);border-radius:9px;background:var(--card);color:var(--text);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap">複製</button>
          <button id="logClear" class="hvFill2" style="height:30px;padding:0 13px;border:1px solid var(--sep);border-radius:9px;background:var(--card);color:var(--red);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap;flex-shrink:0">清除</button>
        </div>
      </div>
      <div id="logList" style="flex:1;background:var(--card);border:1px solid var(--sep);border-radius:16px;overflow-y:auto;user-select:text"></div>
    </div>`;
  $('logSearch').addEventListener('input', e => { state.search = e.target.value; renderLogList(); });
  $('logOpen').onclick = async () => { const r = await window.api.openLogsFolder(); if (!(r && r.ok)) flash('開啟紀錄檔失敗：' + ((r && r.error) || '未知'), 'var(--red)'); };
  $('logCopy').onclick = () => copyLogs();
  $('logClear').onclick = () => clearLogsRow();
  renderLevelSeg();
}

// 清除的是磁碟上的紀錄檔，救不回來 —— 照 app 其他刪除的做法：再按一次才真的清
function clearLogsRow() {
  const b = $('logClear'); if (!b) return;
  // 待確認時要換成 hvRed：hvFill2 的 hover 是灰底，會把紅色的確認狀態蓋掉
  const paint = (el, pending) => {
    el.textContent = pending ? '再按一次清除' : '清除';
    el.className = pending ? 'hvRed' : 'hvFill2';
    el.style.background = pending ? 'var(--red)' : 'var(--card)';
    el.style.color = pending ? 'var(--on-red)' : 'var(--red)';
  };
  if (!state.pendingLogClear) {
    state.pendingLogClear = true;
    paint(b, true);
    clearTimeout(state._logClearT);
    state._logClearT = setTimeout(() => {
      state.pendingLogClear = false;
      const el = $('logClear'); if (el) paint(el, false);
    }, 2500);
    return;
  }
  clearTimeout(state._logClearT);
  state.pendingLogClear = false;
  paint(b, false);
  window.api.clearLogs().then(() => { state.logs = []; renderLogList(); flash('已清除紀錄'); })
    .catch(e => flash('清除紀錄失敗：' + (e && e.message || e), 'var(--red)'));
}

function renderLevelSeg() {
  const levels = [['all', '全部', 'var(--text3)'], ['info', '訊息', LEVELS.info], ['warn', '警告', LEVELS.warn], ['error', '錯誤', LEVELS.error], ['debug', '除錯', LEVELS.debug]];
  $('levelSeg').innerHTML = levels.map(([k, label, dot]) =>
    `<button data-lv="${k}" style="display:flex;align-items:center;gap:5px;border:none;cursor:pointer;height:28px;padding:0 9px;border-radius:6px;font-size:12px;white-space:nowrap;flex-shrink:0;${segCss(state.level === k)}"><span style="width:6px;height:6px;border-radius:50%;background:${dot}"></span>${label}</button>`
  ).join('');
  $('levelSeg').querySelectorAll('button').forEach(b => b.onclick = () => { state.level = b.dataset.lv; renderLevelSeg(); renderLogList(); });
}

function logGroupTitle(source) {
  if (source && source.indexOf('route:') === 0) {
    const rid = source.slice(6);
    const r = state.routes.find(x => x.id === rid);
    return { title: r ? (r.label || '未命名路由') : '路由 ' + rid, meta: r ? '127.0.0.1:' + r.localPort + ' · ' + r.hops.length + ' 跳' : '' };
  }
  return { title: SRC_TITLE[source] || source, meta: '' };
}

// 命中徽章：命中規則＝藍底「命中：第 N 條 名稱」、未命中＝灰底「預設」、封鎖＝紅底
function logHitBadge(l) {
  const m = l.meta; if (!m) return '';
  const block = m.target === 'block';
  const bg = block ? 'var(--red-dim)' : m.matched ? 'var(--accent-dim)' : 'var(--fill2)';
  const color = block ? 'var(--red)' : m.matched ? 'var(--accent)' : 'var(--text3)';
  const label = !m.matched ? '預設' : m.ruleIndex ? `命中：第 ${m.ruleIndex} 條 ${m.ruleName}` : m.ruleName;
  return `<button data-loghit="${esc(m.ruleId || '')}" title="跳到分流規則" style="flex-shrink:0;max-width:220px;border:none;border-radius:5px;padding:2px 7px;background:${bg};color:${color};font-size:10.5px;font-weight:600;cursor:${m.ruleId ? 'pointer' : 'default'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px">${esc(label)}</button>`;
}

// toLocaleTimeString 在 Chromium 裡實測每次 69µs，一次重畫 300 列就是 21ms。
// 每筆只算一次，之後重畫直接讀快取。
function logTime(l) {
  if (l._time === undefined) l._time = new Date(l.time || l.t).toLocaleTimeString('en-GB', { hour12: false });
  return l._time;
}

// 篩選條件以前在 renderLogList 跟 copyLogs 各寫了一次同樣的長字串 —— 改一邊就會漏掉另一邊。
function logPasses(l) {
  const S = state;
  return (S.level === 'all' || l.level === S.level)
    && !(hideDebug() && l.level === 'debug' && S.level !== 'debug')
    && (!S.search || `${l.message} ${l.detail || ''} ${l.source}`.toLowerCase().includes(S.search.toLowerCase()));
}
const logShown = () => state.logs.filter(logPasses);

// 每列不再印來源：紀錄已依來源分組，組標題就寫著路由名稱，每列再印一次 route:r-… 只是佔位
function logRowHtml(l) {
  const exp = state.expanded[l.id];
  return `<div data-log="${l.id}" ${l.detail ? `role="button" tabindex="0" aria-expanded="${!!exp}" aria-label="展開詳細訊息"` : ''} style="padding:5px 14px;display:flex;gap:10px;align-items:flex-start;cursor:${l.detail ? 'pointer' : 'default'};border-bottom:1px solid var(--sep);font-size:12px;line-height:1.6" class="${l.detail ? 'hvFill2' : ''}">
      <span style="width:58px;flex-shrink:0;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;color:var(--text3);font-size:11px;padding-top:1px">${logTime(l)}</span>
      <span title="${l.level}" style="width:7px;height:7px;border-radius:50%;flex-shrink:0;margin-top:6px;background:${LEVELS[l.level] || LEVELS.info}"></span>
      <span style="flex:1;min-width:0;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:11.5px;word-break:break-word">${esc(l.message)}<span style="color:var(--text2)">${l.detail && exp ? '  ' + esc(l.detail) : ''}</span></span>
      ${logHitBadge(l)}
      <span style="flex-shrink:0;color:var(--text3);font-size:10px;padding-top:2px">${l.detail ? (exp ? '▾' : '▸') : ''}</span>
    </div>`;
}

function logGroupHtml(k, rows) {
  const g = logGroupTitle(k);
  return `<div data-loggroup>
      <div style="position:sticky;top:0;z-index:1;padding:7px 14px;background:var(--card);border-bottom:1px solid var(--sep);display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--text2)">
        <span style="font-weight:600;color:var(--text)">${esc(g.title)}</span>
        <span style="font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace">${esc(g.meta)}</span>
        <span data-logcount style="margin-left:auto;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;color:var(--text3)">${rows.length} 筆</span>
      </div>
      <div data-logbody>${rows.map(logRowHtml).join('')}</div>
    </div>`;
}

// 增量追加用的視圖索引。只有「尾端進來新訊息、前端被汰除」這種變化走得了增量，
// 改篩選、展開、清除一律退回 renderLogList() 整塊重建。
let logView = null;   // { sig, list, lastId, groups: Map<source, { section, body, countEl, ids }> }
let logRenderQueued = false;
const logSig = () => [state.level, state.search, hideDebug() ? 1 : 0].join('\u0000');

// 事件委派：以前每次重建都要 querySelectorAll 兩輪、逐列掛 onclick，
// 增量追加的新列根本不會經過那段。改成掛在容器上一次解決。
function bindLogList(list) {
  if (list._logBound) return;
  list._logBound = true;
  list.addEventListener('click', (e) => {
    const hit = e.target.closest('[data-loghit]');
    if (hit) {
      e.stopPropagation();
      const id = hit.dataset.loghit;
      showTab('split');
      if (!id) return;
      state.splitHitId = id; renderSplitRules();
      clearTimeout(state._splitHitT);
      state._splitHitT = setTimeout(() => { state.splitHitId = null; renderSplitRules(); }, 2000);
      return;
    }
    const row = e.target.closest('[data-log]');
    if (row) toggleLogRow(row.dataset.log);
  });
  list.addEventListener('keydown', (e) => {
    const row = e.target.closest && e.target.closest('[data-log]');
    if (!row || e.target !== row || (e.key !== 'Enter' && e.code !== 'Space')) return;
    e.preventDefault(); toggleLogRow(row.dataset.log);
  });
}

// 展開／收合只影響那一列，換掉那一列就好，不用整塊重建。
function toggleLogRow(id) {
  const l = state.logs.find(x => String(x.id) === id);
  if (!(l && l.detail)) return;
  state.expanded[id] = !state.expanded[id];
  const list = $('logList');
  const row = list && list.querySelector(`[data-log="${id}"]`);
  if (!row) { renderLogList(); return; }
  row.outerHTML = logRowHtml(l);
  const next = list.querySelector(`[data-log="${id}"]`);
  if (next && document.activeElement === document.body) next.focus();
}

// 貼著底部時才自動跟到底（對應「紀錄自動捲動」設定）。以前整塊 innerHTML 重建
// 每次都把捲動位置歸零，所以有流量的時候根本捲不動，那個設定也從來沒有人讀。
const logAtBottom = (list) => list.scrollHeight - list.scrollTop - list.clientHeight < 40;
function logStickBottom(list, wasBottom) {
  if (localStorage.getItem('sw_scroll') !== '0' && wasBottom) list.scrollTop = list.scrollHeight;
}

function renderLogList() {
  const list = $('logList');
  if (!list) return;
  bindLogList(list);
  const wasBottom = logAtBottom(list);
  const shown = logShown();
  logView = null;
  if (shown.length === 0) {
    list.innerHTML = `<div style="padding:60px 20px;text-align:center;color:var(--text3);font-size:12.5px">沒有符合的紀錄</div>`;
    return;
  }
  // 以前是每個群組再 filter 一次整份清單（O(群組 × 筆數)），改成掃一趟分桶
  const byKey = new Map();
  for (const l of shown) {
    let arr = byKey.get(l.source);
    if (!arr) { arr = []; byKey.set(l.source, arr); }
    arr.push(l);
  }
  const keys = [...byKey.keys()];
  list.innerHTML = keys.map(k => logGroupHtml(k, byKey.get(k))).join('');
  const groups = new Map();
  keys.forEach((k, i) => {
    const section = list.children[i];
    groups.set(k, { section, body: section.querySelector('[data-logbody]'),
      countEl: section.querySelector('[data-logcount]'), ids: byKey.get(k).map(l => l.id) });
  });
  logView = { sig: logSig(), list, groups,
    lastId: state.logs.length ? state.logs[state.logs.length - 1].id : 0 };
  logStickBottom(list, wasBottom);
}

// 只在「有新訊息進來」時呼叫。視圖對不上就退回整塊重建。
function appendLogRows() {
  const list = $('logList');
  if (!list) return;
  if (!logView || logView.list !== list || logView.sig !== logSig()) { renderLogList(); return; }
  const S = state;
  const wasBottom = logAtBottom(list);

  // 1) 汰除：state.logs 是滑動視窗，被 splice 掉的 id 一定小於現在的第一筆
  const minId = S.logs.length ? S.logs[0].id : Infinity;
  for (const [src, g] of [...logView.groups]) {
    let n = 0;
    while (g.ids.length && g.ids[0] < minId) { g.ids.shift(); n++; }
    if (!n) continue;
    for (let i = 0; i < n; i++) { const el = g.body.firstElementChild; if (el) el.remove(); }
    if (!g.ids.length) { g.section.remove(); logView.groups.delete(src); }
    else g.countEl.textContent = g.ids.length + ' 筆';
  }

  // 2) 追加：lastId 之後的才是新的
  let start = S.logs.length;
  while (start > 0 && S.logs[start - 1].id > logView.lastId) start--;
  for (let i = start; i < S.logs.length; i++) {
    const l = S.logs[i];
    logView.lastId = l.id;
    if (!logPasses(l)) continue;
    let g = logView.groups.get(l.source);
    if (!g) {
      list.insertAdjacentHTML('beforeend', logGroupHtml(l.source, []));
      const section = list.lastElementChild;
      g = { section, body: section.querySelector('[data-logbody]'),
        countEl: section.querySelector('[data-logcount]'), ids: [] };
      logView.groups.set(l.source, g);
    }
    g.body.insertAdjacentHTML('beforeend', logRowHtml(l));
    g.ids.push(l.id);
    g.countEl.textContent = g.ids.length + ' 筆';
  }

  if (!logView.groups.size) { renderLogList(); return; }   // 全空了 → 讓空狀態回來
  logStickBottom(list, wasBottom);
}

function copyLogs() {
  const shown = logShown();
  const text = shown.map(l => `[${logTime(l)}] [${(l.level || '').toUpperCase()}] [${l.source}] ${l.message}${l.detail ? ' ' + l.detail : ''}`).join('\n');
  copyText(text, '已複製紀錄');
}
