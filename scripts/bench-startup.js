// 啟動時間基準：從行程被建立到「使用者真的能操作」之間各段花多久。
//
//   node scripts/bench-startup.js [次數]
//
// 每一輪都用全新的隔離設定檔，避免前一輪的狀態影響。
// 量四個里程碑：
//   spawn      → CDP 的 /json/list 有回應        （Electron 起來了）
//   → page     → 有 page target                 （視窗建立了）
//   → api      → window.api 可用                 （preload 跑完）
//   → 可互動   → 主畫面（引導或儀表板）畫出來了   （renderer boot 完）
// 另外單獨量幾個「主行程會被卡住」的 IPC 來回。

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const EXE = process.env.APP_EXE || path.resolve('dist/win-unpacked/RelayClient.exe');
const ROUNDS = Number(process.argv[2] || 3);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const getJSON = (port, p) => new Promise((res, rej) => {
  const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 1500 }, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  });
  req.on('error', rej); req.on('timeout', () => { req.destroy(); rej(new Error('timeout')); });
});

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) { const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    };
    return c;
  }
  send(method, params = {}, ms = 30000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, ms);
    });
  }
  async eval(e, ms) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, ms);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result.value;
  }
}

const killAll = () => { try { execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Process RelayClient -EA 0 | Stop-Process -Force -EA 0'], { timeout: 20000 }); } catch (e) {} };

async function until(fn, budgetMs = 45000, every = 25) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return Date.now() - t0; } catch (e) {}
    if (Date.now() - t0 > budgetMs) return -1;
    await sleep(every);
  }
}

async function oneRound(port) {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
  fs.writeFileSync(path.join(ud, 'config.json'), '{}');

  const t0 = Date.now();
  spawn(EXE, [`--remote-debugging-port=${port}`, `--user-data-dir=${ud}`], { detached: true, stdio: 'ignore' }).unref();

  const tHttp = await until(() => getJSON(port, '/json/version').then(() => true).catch(() => false));
  const tPage = await until(() => getJSON(port, '/json/list').then(l => l.some(x => x.type === 'page' && x.webSocketDebuggerUrl)).catch(() => false));

  const target = (await getJSON(port, '/json/list')).find(x => x.type === 'page');
  const c = await CDP.connect(target.webSocketDebuggerUrl);
  await c.send('Runtime.enable');

  // 頁面內用 performance.now() 等條件成立，避免 CDP 輪詢的來回延遲混進數字裡。
  // 回傳的是「相對於 navigationStart」的毫秒，跟 DOMContentLoaded 可以直接比。
  const inPage = (cond, ms = 30000) => c.eval(`new Promise(res => {
    const t0 = performance.now();
    const tick = () => {
      try { if (${cond}) return res(performance.now()); } catch (e) {}
      if (performance.now() - t0 > ${ms}) return res(-1);
      setTimeout(tick, 8);   // 不能用 requestAnimationFrame：視窗在背景時它不會觸發
    };
    tick();
  })`, ms + 5000).catch(() => -1);

  const tApi = await inPage('!!window.api');
  // 版面的 id 是 view-guide / view-dash（不是 view-dashboard，寫錯就永遠等不到）
  const tMount = await inPage("!!document.getElementById('view-dash')");
  const tReady = await inPage(`(() => { const g = document.getElementById('view-guide'), d = document.getElementById('view-dash');
    const vis = el => el && getComputedStyle(el).display !== 'none' && el.textContent.trim().length > 0;
    return vis(g) || vis(d); })()`);
  const marks = await c.eval(`JSON.stringify(window.__boot || {})`).then(v => JSON.parse(v || '{}')).catch(() => ({}));
  const mmarks = await c.eval(`window.api.perfMarks ? window.api.perfMarks().then(m => JSON.stringify(m)) : '{}'`).then(v => JSON.parse(v || '{}')).catch(() => ({}));
  const nav = await c.eval(`(() => { const n = performance.getEntriesByType('navigation')[0] || {};
    return { dcl: Math.round(n.domContentLoadedEventEnd || 0), load: Math.round(n.loadEventEnd || 0) }; })()`).catch(() => ({ dcl: 0, load: 0 }));

  // 幾個「會把主行程卡住」的 IPC 來回
  const timeIpc = async (label, expr) => {
    const t = Date.now();
    try { await c.eval(expr, 30000); } catch (e) {}
    return [label, Date.now() - t];
  };
  const ipc = [];
  ipc.push(await timeIpc('getLoginItem', 'window.api.getLoginItem()'));
  ipc.push(await timeIpc('getSettings', 'window.api.getSettings()'));
  ipc.push(await timeIpc('getRoutes', 'window.api.getRoutes()'));
  ipc.push(await timeIpc('getEngineStatus', 'window.api.getEngineStatus()'));
  ipc.push(await timeIpc('listProcesses', 'window.api.listProcesses()'));

  killAll();
  await sleep(1500);
  try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) {}
  return { tHttp, tPage: tHttp + tPage, tApi, tMount, tReady, nav, marks, mmarks, ipc };
}

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

(async () => {
  killAll(); await sleep(2000);
  const rounds = [];
  for (let i = 0; i < ROUNDS; i++) {
    const r = await oneRound(9500 + i);
    rounds.push(r);
    console.log(`第 ${i + 1} 輪  行程→CDP ${r.tHttp}ms │ 頁內：DCL ${r.nav.dcl}ms  api ${Math.round(r.tApi)}ms  DOM ${Math.round(r.tMount)}ms  首屏 ${Math.round(r.tReady)}ms`);
  }
  console.log('');
  console.log('中位數：');
  console.log(`  行程建立 → Electron 起來           ${med(rounds.map(r => r.tHttp))} ms`);
  console.log(`  行程建立 → 視窗建立                ${med(rounds.map(r => r.tPage))} ms`);
  console.log('  ── 以下為頁面內計時（相對 navigationStart）──');
  console.log(`  DOMContentLoaded                   ${med(rounds.map(r => r.nav.dcl))} ms`);
  console.log(`  load 事件結束                      ${med(rounds.map(r => r.nav.load))} ms`);
  console.log(`  window.api 可用                    ${Math.round(med(rounds.map(r => r.tApi)))} ms`);
  console.log(`  版面建好（mount）                  ${Math.round(med(rounds.map(r => r.tMount)))} ms`);
  console.log(`  首屏畫出來                         ${Math.round(med(rounds.map(r => r.tReady)))} ms`);
  console.log('');
  console.log('renderer 自己記的 boot 時間點（中位數）：');
  for (const k of ['start', 'mounted', 'coreStart', 'coreLoaded', 'firstPaint', 'restLoaded',
                   'tick50', 'ipc_settings', 'ipc_servers', 'ipc_routes', 'ipc_routeStatus']) {
    const vals = rounds.map(r => r.marks[k]).filter(v => typeof v === 'number');
    if (vals.length) console.log(`  ${k.padEnd(12)} ${med(vals)} ms`);
  }
  console.log('');
  console.log('主行程自己記的時間點（中位數，相對主行程載入）：');
  for (const k of ['ready', 'fileLog', 'window', 'tray', 'settings', 'readyDone', 'routesApplied']) {
    const vals = rounds.map(r => r.mmarks[k]).filter(v => typeof v === 'number');
    if (vals.length) console.log(`  ${k.padEnd(14)} ${med(vals)} ms`);
  }
  console.log('');
  console.log('各 IPC 來回（中位數；這些會卡住主行程）：');
  for (const [label] of rounds[0].ipc) {
    const vals = rounds.map(r => (r.ipc.find(x => x[0] === label) || [])[1]).filter(v => typeof v === 'number');
    console.log(`  ${label.padEnd(18)} ${med(vals)} ms`);
  }
  process.exit(0);
})().catch(e => { console.error('BENCH ERROR', e.message); process.exit(1); });
