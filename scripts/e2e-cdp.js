// 端到端測試：用 CDP 驅動「打包好的真 app」——真滑鼠事件、真 preload、真 ipcMain。
//
// 跑法（不要對著自己在用的那顆跑）：
//   npm run pack
//   mkdir %TEMP%\e2e && echo {} > %TEMP%\e2e\config.json
//   dist\win-unpacked\RelayClient.exe --remote-debugging-port=9222 --user-data-dir=%TEMP%\e2e
//   SHOT_DIR=%TEMP%\shots node scripts/e2e-cdp.js
//
// 那個預先放的空 config.json 是必要的：main.js 的 migrateLegacyUserData() 讀
// app.getPath('appData')/socks5-client，而 --user-data-dir 只改 userData、不改 appData，
// 新 profile 沒有 config.json 就會把舊設定搬進來，等於沒隔離到。
//
// 用 CDP 驅動「真的打包好的 app」：真滑鼠事件、真後端、真截圖。
// 跟瀏覽器 harness 的差別是這裡沒有假的 window.api，走的是 preload + ipcMain。
const http = require('http');
const fs = require('fs');

const PORT = Number(process.env.CDP_PORT || 9222);
const OUT = process.env.SHOT_DIR;

const getJSON = (path) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path }, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

async function waitForTarget(timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const list = await getJSON('/json/list');
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error('CDP target not found');
    await new Promise(r => setTimeout(r, 500));
  }
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = e => rej(new Error('ws error')); });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 15000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result.value;
  }
  // 真的滑鼠事件（不是 el.click()）
  async click(x, y) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
    await new Promise(r => setTimeout(r, 260));
  }
  async clickSel(sel) {
    const box = await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
      if (!e) return null; const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!box) throw new Error('找不到元素 ' + sel);
    await this.click(box.x, box.y);
  }
  async type(text) {
    for (const ch of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp' });
    }
    await new Promise(r => setTimeout(r, 150));
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  }
}

const results = [];
async function T(name, fn) {
  try { await fn(); results.push(['ok', name]); console.log('CDP ok: ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('CDP FAIL: ' + name + ' :: ' + e.message); }
}

(async () => {
  const target = await waitForTarget();
  const c = await CDP.connect(target.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await new Promise(r => setTimeout(r, 2500));   // 等 renderer boot 完（會打真的 IPC）

  await T('真後端：window.api 是 preload 來的，不是 stub', async () => {
    const v = await c.eval(`(() => ({ hasApi: !!window.api, n: window.api ? Object.keys(window.api).length : 0,
      stub: !!window.__stub }))()`);
    if (!v.hasApi) throw new Error('沒有 window.api');
    if (v.stub) throw new Error('跑到 stub 了');
    if (v.n < 40) throw new Error('api 只有 ' + v.n + ' 個方法');
  });

  await T('真後端：getAppInfo 回傳真版本', async () => {
    const v = await c.eval(`window.api.getAppInfo().then(i => i && i.version)`);
    if (!v) throw new Error('沒拿到版本');
    if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error('版本格式 ' + v);
    console.log('    版本 = ' + v);
  });

  await T('真後端：全新 profile 下是空的，顯示第一階引導', async () => {
    const v = await c.eval(`(() => ({ guide: getComputedStyle(document.getElementById('view-guide')).display,
      text: document.getElementById('view-guide').textContent.trim().slice(0, 20) }))()`);
    if (v.guide === 'none') throw new Error('引導沒顯示');
    if (!v.text.includes('伺服器')) throw new Error('第一階應該是伺服器：' + v.text);
  });

  await c.shot('01-guide');

  // ---- 真的用滑鼠點出一台伺服器 ----
  await T('點「新增伺服器」開 sheet', async () => {
    await c.clickSel('#guideAdd');
    const open = await c.eval(`!!document.querySelector('#srvSheetMount').firstElementChild`);
    if (!open) throw new Error('sheet 沒開');
  });

  await T('填表並儲存 → 真的寫進後端', async () => {
    await c.clickSel('#fName'); await c.type('CDP 測試伺服器');
    await c.clickSel('#fHost'); await c.type('203.0.113.55');
    await c.clickSel('#fPort'); await c.type('1080');
    await c.shot('02-server-sheet');
    await c.clickSel('#ssSave');
    await new Promise(r => setTimeout(r, 900));
    const n = await c.eval(`window.api.getServers().then(s => s.length)`);
    if (n !== 1) throw new Error('後端伺服器數 = ' + n);
  });

  await T('存完 sheet 關閉，引導前進到第二階', async () => {
    const v = await c.eval(`(() => ({ sheet: !!document.querySelector('#srvSheetMount').firstElementChild,
      text: document.getElementById('view-guide').textContent.trim().slice(0, 30) }))()`);
    if (v.sheet) throw new Error('sheet 沒關');
    if (!v.text.includes('CDP 測試伺服器')) throw new Error('第二階沒預填伺服器名：' + v.text);
  });

  await c.shot('03-guide-stage2');

  // ---- 真的建一條路由 ----
  await T('點「新增路由」→ 填 → 存', async () => {
    await c.clickSel('#guideAdd');
    await new Promise(r => setTimeout(r, 400));
    await c.clickSel('#rdLabel'); await c.type('CDP 路由');
    // 路由至少要一個跳點，先點「加入跳點」選剛建的伺服器
    await c.clickSel('#rdHopMenu');
    await new Promise(r => setTimeout(r, 400));
    await c.clickSel('#menuBox [data-mi="0"]');
    await new Promise(r => setTimeout(r, 400));
    await c.shot('04-route-sheet');
    await c.clickSel('#rdSave');
    await new Promise(r => setTimeout(r, 900));
    const n = await c.eval(`window.api.getRoutes().then(r => r.length)`);
    if (n !== 1) throw new Error('後端路由數 = ' + n);
  });

  await T('有路由後顯示儀表板（不是引導）', async () => {
    const v = await c.eval(`(() => ({ guide: getComputedStyle(document.getElementById('view-guide')).display,
      dash: getComputedStyle(document.getElementById('view-dash')).display,
      status: (document.getElementById('dashStatus') || {}).textContent || '' }))()`);
    if (v.dash === 'none') throw new Error('儀表板沒顯示');
    if (v.guide !== 'none') throw new Error('引導還在');
    if (!v.status.includes('Ctrl+1')) throw new Error('狀態列缺快捷提示：' + v.status);
  });

  await c.shot('05-dashboard');

  // ---- 分流頁：真的存一條規則 ----
  await T('Ctrl+2 切到分流頁（真快捷鍵）', async () => {
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '2', code: 'Digit2', windowsVirtualKeyCode: 50, modifiers: 2 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '2', code: 'Digit2', windowsVirtualKeyCode: 50, modifiers: 2 });
    await new Promise(r => setTimeout(r, 500));
    const t = await c.eval(`state.tab`);
    if (t !== 'split') throw new Error('tab = ' + t);
  });

  await T('MERGE §2：模擬器預設收合、鈕叫「模擬」', async () => {
    const v = await c.eval(`(() => ({ has: !!document.getElementById('spSimToggle'),
      label: (document.getElementById('spSimToggle') || {}).textContent || '',
      panel: (document.getElementById('spSimPanel') || {}).style.display }))()`);
    if (!v.has) throw new Error('沒有模擬鈕');
    if (v.label.trim() !== '模擬') throw new Error('鈕文案 ' + v.label.trim());
    if (v.panel !== 'none') throw new Error('預設應收合');
  });

  await T('新增規則 → 真的存進後端', async () => {
    await c.clickSel('#btnAdd');
    await new Promise(r => setTimeout(r, 500));
    await c.clickSel('#spDestValue'); await c.type('example.com');
    await c.shot('06-rule-sheet');
    await c.clickSel('#spSheetSave');
    await new Promise(r => setTimeout(r, 900));
    const n = await c.eval(`window.api.getSplit().then(s => s.rules.length)`);
    if (n !== 1) throw new Error('後端規則數 = ' + n);
  });

  await T('MERGE §2：規則表無「命中」欄', async () => {
    const hs = await c.eval(`Array.from(document.getElementById('spRulesTable').firstElementChild.children).map(c => c.textContent.trim())`);
    if (hs.includes('命中')) throw new Error('表頭 ' + hs.join('|'));
  });

  await T('真模擬器：對真後端跑 ruleMatch', async () => {
    await c.clickSel('#spSimToggle');
    await c.clickSel('#spSimHost'); await c.type('www.example.com');
    await c.clickSel('#spSimRun');
    await new Promise(r => setTimeout(r, 1200));
    const t = await c.eval(`document.getElementById('spSimResult').textContent`);
    if (!t.includes('命中')) throw new Error('模擬結果：' + t.trim().slice(0, 60));
  });

  await c.shot('07-split');

  await T('設定頁：pill 44×26（MERGE §2）', async () => {
    await c.eval(`showTab('settings')`);
    await new Promise(r => setTimeout(r, 400));
    const v = await c.eval(`(() => { const b = document.querySelector('#view-settings [data-sw]'); const s = getComputedStyle(b);
      return { w: s.width, h: s.height, knob: getComputedStyle(b.firstElementChild).width }; })()`);
    if (v.w !== '44px' || v.h !== '26px') throw new Error(v.w + 'x' + v.h);
    if (v.knob !== '20px') throw new Error('knob ' + v.knob);
  });

  await T('設定開關 → 真的寫進後端設定檔', async () => {
    const before = await c.eval(`window.api.getSettings().then(s => !!s.minimizeToTray)`);
    await c.clickSel('#view-settings [data-sw="tray"]');
    await new Promise(r => setTimeout(r, 800));
    const after = await c.eval(`window.api.getSettings().then(s => !!s.minimizeToTray)`);
    if (before === after) throw new Error('設定沒變（' + before + ' → ' + after + '）');
  });

  await c.shot('08-settings');

  await T('紀錄頁：讀真的 log', async () => {
    await c.eval(`showTab('logs')`);
    await new Promise(r => setTimeout(r, 600));
    const n = await c.eval(`window.api.getLogs().then(l => l.length)`);
    if (!(n > 0)) throw new Error('沒有紀錄');
  });

  await c.shot('09-logs');

  await T('沒有 JS 例外', async () => {
    const errs = await c.eval(`(window.__errs || []).join(' | ')`);
    if (errs) throw new Error(errs);
  });

  const bad = results.filter(r => r[0] === 'FAIL');
  console.log('CDP SUMMARY ' + JSON.stringify({ total: results.length, fail: bad.length }));
  await c.eval(`window.api.windowClose && 0`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.log('CDP DRIVER ERROR: ' + e.message); process.exit(2); });
