// 自動更新的端到端測試（electron-updater → GitHub Releases）。
//
// 之前完全沒測過，而且是最不能只靠 mock 的一塊：它整條路徑都在外面 ——
// 真的 GitHub、真的 latest.yml、真的 108 MB 安裝檔。要驗的是「使用者按下
// 檢查更新，會不會真的看到新版、抓得下來」，那只有打真的才算數。
//
// 要對著「安裝版」跑（可攜/未封裝版沒有 app-update.yml，checkForUpdates 會直接報錯），
// 而且安裝版的版本要比 GitHub 上最新的 release 舊，否則只驗得到「已是最新版本」。
//
//   "%LOCALAPPDATA%\Programs\RelayClient\RelayClient.exe" --remote-debugging-port=9302 --user-data-dir=%TEMP%\upud
//   CDP_PORT=9302 node scripts/e2e-update.js
//
// 預設只到「下載完成」為止，不會真的安裝。要連安裝一起跑：E2E_INSTALL=1
// （會真的把這台機器上的 RelayClient 升級上去）。
//
// 收尾一定會把 pending 目錄清乾淨 —— autoInstallOnAppQuit=true，留著的話
// 使用者下次關掉 app 就會被裝上去，那不該是一次測試的副作用。

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CDP_PORT || 9302);
const DO_INSTALL = process.env.E2E_INSTALL === '1';
const CACHE = path.join(process.env.LOCALAPPDATA || '', 'socks5-client-updater');
const PENDING = path.join(CACHE, 'pending');

const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

const lsPending = () => { try { return fs.readdirSync(PENDING); } catch (e) { return []; } };

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
  send(method, params = {}, timeoutMs = 60000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, timeoutMs);
    });
  }
  async eval(expr, timeoutMs) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result.value;
  }
}

const results = [];
async function T(name, fn) {
  try { await fn(); results.push(['ok', name]); console.log('UP ok: ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('UP FAIL: ' + name + ' :: ' + e.message); }
}

const cmp = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
};

(async () => {
  const list = await getJSON('/json/list');
  const target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) throw new Error('找不到 CDP target');
  const c = await CDP.connect(target.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  await new Promise(r => setTimeout(r, 2000));

  // 把 update-status 事件收起來——按鈕文案與進度全靠它，不能只看 IPC 回傳值
  await c.eval(`window.__ups = []; window.api.onUpdateStatus(s => window.__ups.push(s)); true`);

  const before = lsPending();
  console.log('pending 目錄（測試前）:', JSON.stringify(before));
  let newVersion = null;

  try {
    const cur = await c.eval(`window.api.getAppInfo ? window.api.getAppInfo().then(i => i.version) : null`).catch(() => null);
    console.log('安裝版版本:', cur);

    await T('這是安裝版（未封裝版沒有 app-update.yml，測了也沒意義）', async () => {
      const r = JSON.parse(await c.eval(`window.api.checkForUpdates().then(x => JSON.stringify(x))`, 90000));
      if (r.ok === false && /開發模式/.test(r.error || '')) throw new Error('跑在未封裝版上：' + r.error);
      if (r.ok === false && /app-update\.yml/.test(r.error || '')) throw new Error('缺 app-update.yml，這不是安裝版：' + r.error);
      if (!r.ok) throw new Error('檢查更新失敗：' + JSON.stringify(r));
      newVersion = r.version;
      console.log('    GitHub 上最新版:', newVersion);
    });

    await T('真的連到 GitHub 並讀到比目前新的版本', async () => {
      if (!newVersion) throw new Error('沒拿到版本');
      if (!/^\d+\.\d+\.\d+/.test(newVersion)) throw new Error('版本格式不對：' + newVersion);
      if (cur && cmp(newVersion, cur) <= 0) {
        throw new Error(`線上版本 ${newVersion} 沒有比安裝的 ${cur} 新——這樣只驗得到「已是最新版本」，測試沒有意義`);
      }
    });

    await T('事件序列是 checking → available，而且帶版本號', async () => {
      const ups = await c.eval(`JSON.stringify(window.__ups)`).then(JSON.parse);
      const seq = ups.map(u => u.status);
      if (!seq.includes('checking')) throw new Error('沒有 checking：' + JSON.stringify(seq));
      if (!seq.includes('available')) throw new Error('沒有 available：' + JSON.stringify(seq));
      if (seq.indexOf('checking') > seq.indexOf('available')) throw new Error('順序反了：' + JSON.stringify(seq));
      const av = ups.find(u => u.status === 'available');
      if (av.version !== newVersion) throw new Error(`事件版本 ${av.version} 與回傳 ${newVersion} 不一致`);
    });

    await T('關於卡片的按鈕變成「下載更新 v…」（使用者看得到）', async () => {
      await c.eval(`showTab('settings')`);
      await new Promise(r => setTimeout(r, 800));
      const label = await c.eval(`(document.getElementById('setUpdate') || {}).textContent || ''`);
      if (!/下載更新/.test(label)) throw new Error('按鈕文案是「' + label + '」');
      if (!label.includes(newVersion)) throw new Error('按鈕沒帶版本號：' + label);
    });

    await T('自動下載是關的（要讓使用者自己決定何時抓 100 MB）', async () => {
      const ups = await c.eval(`JSON.stringify(window.__ups)`).then(JSON.parse);
      if (ups.some(u => u.status === 'downloading' || u.status === 'downloaded')) {
        throw new Error('沒按下載就自己開始抓了：' + JSON.stringify(ups.map(u => u.status)));
      }
    });

    await T('按下下載 → 真的抓完整包，而且有進度回報', async () => {
      const r = JSON.parse(await c.eval(`window.api.downloadUpdate().then(x => JSON.stringify(x))`, 600000));
      if (!r.ok) throw new Error('下載失敗：' + JSON.stringify(r).slice(0, 200));
      const ups = await c.eval(`JSON.stringify(window.__ups)`).then(JSON.parse);
      const prog = ups.filter(u => u.status === 'downloading');
      if (!prog.length) throw new Error('完全沒有 download-progress 事件（進度條會是死的）');
      if (!ups.some(u => u.status === 'downloaded')) throw new Error('沒有 downloaded 事件');
      console.log('    進度事件 ' + prog.length + ' 次，最高 ' + Math.max(...prog.map(p => p.percent)) + '%');
    });

    await T('安裝檔真的落在 pending 目錄，大小合理', async () => {
      const now = lsPending().filter(f => !before.includes(f));
      const exe = lsPending().find(f => /\.exe$/i.test(f) && f.includes(newVersion));
      if (!exe) throw new Error('pending 裡沒有 ' + newVersion + ' 的安裝檔：' + JSON.stringify(lsPending()));
      const size = fs.statSync(path.join(PENDING, exe)).size;
      if (size < 50 * 1024 * 1024) throw new Error('檔案只有 ' + size + ' bytes，不像完整安裝檔');
      console.log('    ' + exe + ' ' + Math.round(size / 1048576) + ' MB（新增 ' + JSON.stringify(now) + '）');
    });

    await T('按鈕變成「重新啟動安裝」', async () => {
      const label = await c.eval(`(document.getElementById('setUpdate') || {}).textContent || ''`);
      if (!/重新啟動安裝/.test(label)) throw new Error('按鈕文案是「' + label + '」');
    });

    if (DO_INSTALL) {
      const exe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'RelayClient', 'RelayClient.exe');
      const exeVersion = () => {
        try {
          return require('child_process').execFileSync('powershell', ['-NoProfile', '-Command',
            `(Get-Item '${exe}').VersionInfo.ProductVersion`], { encoding: 'utf8', timeout: 10000 }).trim();
        } catch (e) { return ''; }
      };
      const vBefore = exeVersion();
      console.log('    安裝前 exe 版本:', vBefore);

      await T('quitAndInstall：app 先好好結束（不是被強殺）', async () => {
        await c.eval(`window.api.quitAndInstall()`).catch(() => {});
        console.log('    已觸發安裝。installer 是有 UI 的（oneClick:false），請點完精靈…');
        for (let i = 0; i < 40; i++) {                    // 最多等 200 秒
          const alive = await getJSON('/json/version').then(() => true).catch(() => false);
          if (!alive) return;
          await new Promise(r => setTimeout(r, 5000));
        }
        throw new Error('app 沒有結束 —— 安裝程式會在 app 還開著的情況下覆蓋檔案');
      });

      await T('安裝完成：exe 版本真的變成新版', async () => {
        for (let i = 0; i < 60; i++) {                    // 最多等 5 分鐘（含使用者點精靈的時間）
          const v = exeVersion();
          if (v && v.startsWith(newVersion)) { console.log('    ' + vBefore + ' → ' + v); return; }
          await new Promise(r => setTimeout(r, 5000));
        }
        throw new Error(`exe 版本還是 ${exeVersion()}，沒有升到 ${newVersion}`);
      });

      // 裝完之後 pending 裡那支安裝檔還在。重點不是「檔案在不在」，
      // 而是「關掉 app 會不會又裝一次」——autoInstallOnAppQuit 是 true。
      // 實測是不會（下次啟動檢查到已是最新版，就不會把它排進 will-quit 的安裝流程），
      // 所以它只是磁碟浪費，由 sweepStaleUpdateCache() 在啟動時收掉。
      await T('關掉新裝好的 app 不會又跑一次安裝', async () => {
        const exeTime = () => { try { return fs.statSync(exe).mtimeMs; } catch (e) { return 0; } };
        const before2 = exeTime();
        require('child_process').spawn(exe, ['--quit'], { detached: true, stdio: 'ignore' }).unref();
        await new Promise(r => setTimeout(r, 30000));
        const setup = require('child_process')
          .execFileSync('powershell', ['-NoProfile', '-Command',
            "(Get-Process -Name 'RelayClient-Setup-*' -EA 0 | Measure-Object).Count"], { encoding: 'utf8' }).trim();
        if (setup !== '0') throw new Error('安裝程式又跑起來了');
        if (exeTime() !== before2) throw new Error('exe 被重寫了 —— 真的重裝了一次');
      });

      await T('啟動時會把已安裝完成的更新快取收掉（不然一直佔著上百 MB）', async () => {
        const { clearStaleUpdateCache } = require('../src/update-cache');
        const removed = clearStaleUpdateCache(CACHE, newVersion);
        const left = lsPending().filter(f => /\.exe$/i.test(f));
        if (left.length) throw new Error('清不掉：' + JSON.stringify(left));
        console.log('    清掉 ' + removed.length + ' 個檔案');
      });
    } else {
      console.log('UP skip: 安裝那一步（要跑請帶 E2E_INSTALL=1；會真的升級這台機器）');
    }
  } finally {
    // autoInstallOnAppQuit=true：留著 pending 的話，使用者下次關掉 app 就會被裝上去。
    // 那不該是一次測試的副作用，所以只留測試前就有的東西。
    if (!DO_INSTALL) {
      await T('收尾：pending 目錄回到測試前的樣子', async () => {
        for (const f of lsPending()) {
          if (!before.includes(f)) { try { fs.rmSync(path.join(PENDING, f), { recursive: true, force: true }); } catch (e) {} }
        }
        const after = lsPending();
        const extra = after.filter(f => !before.includes(f));
        if (extra.length) throw new Error('清不掉：' + JSON.stringify(extra));
      });
    }

    const bad = results.filter(r => r[0] === 'FAIL');
    console.log('UP SUMMARY ' + JSON.stringify({ total: results.length, fail: bad.length }));
    process.exit(bad.length ? 1 : 0);
  }
})().catch(e => {
  console.log('UP DRIVER ERROR: ' + e.message);
  console.log('救援（清掉待安裝的更新）：rmdir /s /q "' + PENDING + '"');
  process.exit(2);
});
