// 開機自動啟動（OS 登入項目）的端到端測試。
//
// 之前完全沒測過。它不像分流引擎那樣「壞了馬上看得出來」——
// 使用者按下開關、看到「已設定開機自動啟動」，然後要等到下次開機才知道沒生效。
// 所以這裡不信 IPC 的回傳值，一律從登錄檔外部讀回來比對。
//
// Windows 的登入項目就是 HKCU\...\CurrentVersion\Run 底下一個值。
// 開頭先整份快照，finally 一定還原（多的刪掉、原本有的寫回去）。
//
// 跑法（對著打包版，不要對你自己在用的那顆）：
//   dist\win-unpacked\RelayClient.exe --remote-debugging-port=9301 --user-data-dir=%TEMP%\asud
//   CDP_PORT=9301 node scripts/e2e-autostart.js

const http = require('http');
const { execFileSync } = require('child_process');

const PORT = Number(process.env.CDP_PORT || 9301);
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

const reg = (args) => {
  try { return execFileSync('reg', args, { encoding: 'utf8', timeout: 8000 }); } catch (e) { return ''; }
};

// 種/刪帶中文名字的值時不能用 reg.exe：它讀參數走行程的 ANSI 代碼頁，
// 在 Git Bash 底下「代理客戶端」會被吃掉，reg add 安靜地失敗，
// 然後測試就會以為是 app 沒讀到 —— 測試殼層的毛病被誤判成產品的 bug。
// 走 -EncodedCommand（base64 的 UTF-16），命令列上全是 ASCII。
function ps(script) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', timeout: 10000 });
  } catch (e) { return ''; }
}
const RUN_PS = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const setRunValue = (name, data) => ps(`Set-ItemProperty -Path '${RUN_PS}' -Name '${name}' -Value '${data}' -Force`);
const delRunValue = (name) => ps(`Remove-ItemProperty -Path '${RUN_PS}' -Name '${name}' -Force -ErrorAction SilentlyContinue`);

// 把整個 Run 讀成 { 名稱: { type, data } }
function readRun() {
  const out = reg(['query', RUN_KEY]);
  const map = {};
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s{4}(.+?)\s{4}(REG_\w+)\s{4}(.*)$/);
    if (m) map[m[1].trim()] = { type: m[2], data: m[3].trim() };
  }
  return map;
}

// 我們自己的那一筆：資料裡指到打包版 exe 的就算
const oursIn = (map, exeHint) => Object.entries(map)
  .filter(([, v]) => /RelayClient\.exe/i.test(v.data) || (exeHint && v.data.toLowerCase().includes(exeHint.toLowerCase())));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result.value;
  }
  async clickSel(sel) {
    const box = await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
      if (!e) return null; e.scrollIntoView({ block: 'center' });
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!box) throw new Error('找不到元素 ' + sel);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await new Promise(r => setTimeout(r, 400));
  }
}

const results = [];
async function T(name, fn) {
  try { await fn(); results.push(['ok', name]); console.log('AS ok: ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('AS FAIL: ' + name + ' :: ' + e.message); }
}

(async () => {
  const list = await getJSON('/json/list');
  const target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) throw new Error('找不到 CDP target');
  const c = await CDP.connect(target.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  await new Promise(r => setTimeout(r, 1500));

  const before = readRun();
  console.log('Run 快照（測試前）:', JSON.stringify(before, null, 0));

  try {
    await T('一開始沒有登入項目（測試前提；有的話下面的斷言會失真）', async () => {
      const ours = oursIn(before);
      if (ours.length) throw new Error('測試前就有：' + JSON.stringify(ours));
    });

    await T('setLoginItem(true) → HKCU Run 真的多一筆，指向 app 的 exe', async () => {
      const r = JSON.parse(await c.eval(`window.api.setLoginItem(true).then(x => JSON.stringify(x))`));
      if (!r.ok) throw new Error('IPC 回失敗：' + JSON.stringify(r));
      await new Promise(x => setTimeout(x, 600));
      const now = readRun();
      const ours = oursIn(now);
      if (!ours.length) throw new Error('登錄檔沒有多出任何指向 RelayClient.exe 的值');
      console.log('    Run 值：' + ours.map(([k, v]) => k + ' = ' + v.data).join(' | '));
    });

    await T('登記的是 app 自己的 exe，不是 electron.exe（開發時最容易寫錯的地方）', async () => {
      const ours = oursIn(readRun());
      const data = ours.map(([, v]) => v.data).join(' ');
      if (/electron\.exe/i.test(data)) throw new Error('指到 electron.exe：' + data);
      if (!/RelayClient\.exe/i.test(data)) throw new Error('沒指到 RelayClient.exe：' + data);
    });

    await T('登記路徑不在 %TEMP%（可攜版解壓路徑，重開機就失效）', async () => {
      const ours = oursIn(readRun());
      const data = ours.map(([, v]) => v.data).join(' ');
      if (/\\Temp\\/i.test(data)) throw new Error('指到 TEMP，重開機後會失效：' + data);
    });

    await T('getLoginItem() 讀回 true（不是只寫進去沒讀回來）', async () => {
      const v = await c.eval(`window.api.getLoginItem()`);
      if (v !== true) throw new Error('讀回 ' + JSON.stringify(v));
    });

    await T('setLoginItem(false) → 登錄檔那一筆消失', async () => {
      const r = JSON.parse(await c.eval(`window.api.setLoginItem(false).then(x => JSON.stringify(x))`));
      if (!r.ok) throw new Error('IPC 回失敗：' + JSON.stringify(r));
      await new Promise(x => setTimeout(x, 600));
      const ours = oursIn(readRun());
      if (ours.length) throw new Error('還在：' + JSON.stringify(ours));
      const v = await c.eval(`window.api.getLoginItem()`);
      if (v !== false) throw new Error('getLoginItem 仍回 ' + JSON.stringify(v));
    });

    // ---- 真的用滑鼠點設定頁的開關 ----
    await T('設定頁點開關 → 登錄檔真的變（UI 到 OS 整條打通）', async () => {
      await c.eval(`showTab('settings')`);
      await new Promise(x => setTimeout(x, 700));
      const sel = 'button[data-sw="bootLaunch"]';
      const exists = await c.eval(`!!document.querySelector('${sel}')`);
      if (!exists) throw new Error('設定頁找不到「開機時自動啟動」開關');

      await c.clickSel(sel);
      await new Promise(x => setTimeout(x, 900));
      if (!oursIn(readRun()).length) throw new Error('點了開關但登錄檔沒變');

      const checked = await c.eval(`document.querySelector('${sel}').getAttribute('aria-checked')`);
      if (checked !== 'true') throw new Error('登錄檔變了但開關視覺沒跟上：aria-checked=' + checked);
    });

    await T('再點一次關掉 → 登錄檔那一筆消失、開關回到關', async () => {
      const sel = 'button[data-sw="bootLaunch"]';
      await c.clickSel(sel);
      await new Promise(x => setTimeout(x, 900));
      if (oursIn(readRun()).length) throw new Error('點了關閉但登錄檔那一筆還在');
      const checked = await c.eval(`document.querySelector('${sel}').getAttribute('aria-checked')`);
      if (checked !== 'false') throw new Error('aria-checked=' + checked);
    });

    // ---- 改名前留下的孤兒登入項目 ----
    // 開發機上實際就有一筆：electron.app.代理客戶端 → RelayClient-Portable-1.1.1.exe。
    // 這裡不靠那一筆，自己種一個假的來測（收尾會刪掉）。
    const LEGACY = 'electron.app.代理客戶端';
    const DEAD = 'C:\\Users\\user\\Downloads\\NoSuchRelayClient-9.9.9.exe';

    await T('舊名字那一筆也算數 → getLoginItem 讀得到（不然設定頁顯示關、OS 照開）', async () => {
      setRunValue(LEGACY, DEAD);
      await c.eval(`window.api.setLoginItem(false)`);   // 新名字那一筆確定是關的
      await new Promise(x => setTimeout(x, 600));
      setRunValue(LEGACY, DEAD);
      const v = await c.eval(`window.api.getLoginItem()`);
      if (v !== true) throw new Error('舊名字那一筆存在，getLoginItem 卻回 ' + JSON.stringify(v));
    });

    await T('關閉開關 → 舊名字那一筆也一起清掉（不然使用者永遠關不掉）', async () => {
      const r = JSON.parse(await c.eval(`window.api.setLoginItem(false).then(x => JSON.stringify(x))`));
      if (!r.ok) throw new Error('IPC 回失敗：' + JSON.stringify(r));
      await new Promise(x => setTimeout(x, 800));
      if (LEGACY in readRun()) throw new Error('舊名字那一筆還在');
      const v = await c.eval(`window.api.getLoginItem()`);
      if (v !== false) throw new Error('getLoginItem 仍回 ' + JSON.stringify(v));
    });

    await T('開啟開關 → 只留新名字一筆，不會新舊並存（並存會開兩個實例）', async () => {
      setRunValue(LEGACY, DEAD);
      await c.eval(`window.api.setLoginItem(true)`);
      await new Promise(x => setTimeout(x, 800));
      const now = readRun();
      if (LEGACY in now) throw new Error('開啟後新舊並存');
      if (!oursIn(now).length) throw new Error('新名字那一筆沒寫進去');
      await c.eval(`window.api.setLoginItem(false)`);
      await new Promise(x => setTimeout(x, 600));
    });

    await T('不會誤刪別人的登入項目（清理程式跑在使用者的 Run 底下）', async () => {
      // 排掉自家的名字：快照裡若剛好有一筆舊登入項目，那筆本來就該被清掉，
      // 拿它來當「別人的項目」會把功能正常運作誤判成誤刪。
      const others = Object.keys(before).filter(n => n !== LEGACY && !/RelayClient/i.test(n));
      setRunValue(LEGACY, DEAD);
      await c.eval(`window.api.setLoginItem(false)`);
      await new Promise(x => setTimeout(x, 800));
      const now = readRun();
      const lost = others.filter(n => !(n in now));
      if (lost.length) throw new Error('把別人的項目刪掉了：' + lost.join(', '));
    });

    await T('重開設定頁時狀態從 OS 讀回來，不是記在前端', async () => {
      await c.eval(`window.api.setLoginItem(true)`);
      await new Promise(x => setTimeout(x, 600));
      // 模擬重新載入後的初始化路徑（renderer 啟動時就是這樣讀的）
      await c.eval(`window.api.getLoginItem().then(v => { state.bootLaunch = !!v; refreshSettings(); })`);
      await new Promise(x => setTimeout(x, 500));
      const checked = await c.eval(`document.querySelector('button[data-sw="bootLaunch"]').getAttribute('aria-checked')`);
      if (checked !== 'true') throw new Error('從 OS 讀回來後開關沒亮：aria-checked=' + checked);
      await c.eval(`window.api.setLoginItem(false)`);
      await new Promise(x => setTimeout(x, 500));
    });
  } finally {
    await T('收尾：Run 登錄檔還原成測試前的樣子', async () => {
      await c.eval(`window.api.setLoginItem(false)`).catch(() => {});
      await new Promise(x => setTimeout(x, 600));
      const now = readRun();
      // 測試中多出來的刪掉（走 PowerShell，名字可能有中文）
      for (const name of Object.keys(now)) {
        if (!(name in before)) delRunValue(name);
      }
      // 原本有的寫回去（值被改到的話）
      for (const [name, v] of Object.entries(before)) {
        if (!now[name] || now[name].data !== v.data) setRunValue(name, v.data);
      }
      const after = readRun();
      const a = JSON.stringify(after), b = JSON.stringify(before);
      if (a !== b) throw new Error('沒還原乾淨\n  前：' + b + '\n  後：' + a);
    });

    const bad = results.filter(r => r[0] === 'FAIL');
    console.log('AS SUMMARY ' + JSON.stringify({ total: results.length, fail: bad.length }));
    process.exit(bad.length ? 1 : 0);
  }
})().catch(e => {
  console.log('AS DRIVER ERROR: ' + e.message);
  console.log('救援（手動清掉登入項目）：reg delete "' + RUN_KEY + '" /v RelayClient /f');
  process.exit(2);
});
