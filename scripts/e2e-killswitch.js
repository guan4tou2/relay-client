// 斷線保護的端到端測試 —— 需要提權，且需要一支能砍 sing-box 的小幫手。
//
// 為什麼要小幫手：sing-box 由提權的 app 啟動，一般權限的測試行程砍不動它。
// 而「引擎意外中止」正是這個功能唯一的觸發條件，不模擬就測不到。
//
// 跑法：
//   1) 管理員視窗 A：dist\win-unpacked\RelayClient.exe --remote-debugging-port=9300 --user-data-dir=%TEMP%\engud
//   2) 管理員視窗 B（小幫手，一直開著）：
//      while ($true) { if (Test-Path "$env:TEMP\kill-singbox") { Remove-Item "$env:TEMP\kill-singbox" -Force -EA 0;
//        Get-Process sing-box -EA 0 | Stop-Process -Force }; Start-Sleep -Milliseconds 300 }
//   3) 一般權限：CDP_PORT=9300 node scripts/e2e-killswitch.js
//
// 風險範圍：測試設定是 mode=rule、規則外流量 direct，所以封鎖模式只會擋
// 「原本要走代理」的那一條（gstatic）。其餘流量照常，而且結束時一定會清乾淨。

const http = require('http');
const fs = require('fs');
const { execFileSync } = require('child_process');

const PORT = Number(process.env.CDP_PORT || 9300);
const KILL_FLAG = (process.env.TEMP || '/tmp') + '/kill-singbox';
const ORACLE_LOG = process.env.SOCKS_LOG || ((process.env.TEMP || '/tmp') + '/socks-oracle.log');

const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

const ps = (cmd) => { try { return execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 15000 }); } catch (e) { return ''; } };
const singboxCount = () => Number(ps('(Get-Process sing-box -EA 0 | Measure-Object).Count').trim() || 0);
const tunCount = () => Number(ps("(Get-NetAdapter | ? { $_.Name -like '*proxyclient*' } | Measure-Object).Count").trim() || 0);
const readOracle = () => { try { return fs.readFileSync(ORACLE_LOG, 'utf8').split(/\r?\n/).filter(Boolean); } catch (e) { return []; } };
const curl = (url, ms = 10) => {
  try {
    return execFileSync('curl', ['-s', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null',
      '-w', '%{http_code}', '--max-time', String(ms), url], { encoding: 'utf8', timeout: (ms + 5) * 1000 }).trim();
  } catch (e) { return '000'; }
};

// 請小幫手砍掉 sing-box，模擬引擎崩潰
async function crashEngine() {
  const before = singboxCount();
  if (!before) throw new Error('sing-box 沒在跑，沒東西可以砍');
  fs.writeFileSync(KILL_FLAG, '');
  for (let i = 0; i < 40; i++) {
    if (singboxCount() < before) return;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('小幫手沒有砍掉 sing-box —— 它有在跑嗎？（見檔頭說明）');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) { const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 90000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result.value;
  }
}

const results = [];
async function T(name, fn) {
  try { await fn(); results.push(['ok', name]); console.log('KS ok: ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('KS FAIL: ' + name + ' :: ' + e.message); }
}

(async () => {
  const list = await getJSON('/json/list');
  const target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) throw new Error('找不到 CDP target');
  const c = await CDP.connect(target.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  await new Promise(r => setTimeout(r, 2000));

  const ks = () => c.eval(`window.api.getKillswitch().then(k => JSON.stringify(k))`).then(JSON.parse);
  const engState = () => c.eval(`window.api.getEngineStatus().then(s => s.state)`);
  const waitEngine = async (want, tries = 25) => {
    for (let i = 0; i < tries; i++) { if (await engState() === want) return true; await new Promise(r => setTimeout(r, 600)); }
    return false;
  };

  const baseTun = tunCount();
  console.log('基準：TUN=' + baseTun + ' sing-box=' + singboxCount());

  try {
    // ---------- 準備 ----------
    await T('開啟斷線保護、關掉自動重連（先驗手動流程）', async () => {
      await c.eval(`window.api.updateSettings({ killSwitch: true, killSwitchAutoReconnect: false })`);
      const s = JSON.parse(await c.eval(`window.api.getSettings().then(s => JSON.stringify({ ks: !!s.killSwitch, auto: !!s.killSwitchAutoReconnect }))`));
      if (!s.ks || s.auto) throw new Error('設定沒生效：' + JSON.stringify(s));
    });

    await T('啟動路由與引擎', async () => {
      await c.eval(`window.api.routeStart('r-oracle')`);
      await c.eval(`window.api.engineStart()`);
      if (!await waitEngine('running')) throw new Error('引擎沒起來');
      await new Promise(r => setTimeout(r, 2000));
    });

    await T('崩潰前：命中規則走代理、其餘直連', async () => {
      const before = readOracle().length;
      const a = curl('https://www.gstatic.com/generate_204');
      const b = curl('https://github.com');
      await new Promise(r => setTimeout(r, 1200));
      const fresh = readOracle().slice(before).filter(l => /CONNECT /.test(l));
      if (a !== '204') throw new Error('gstatic 失敗：' + a);
      if (b !== '200') throw new Error('github 失敗：' + b);
      if (!fresh.length) throw new Error('代理沒收到 gstatic —— 分流沒生效，後面的斷線測試沒意義');
    });

    // ---------- 觸發 ----------
    await T('砍掉 sing-box → 斷線保護觸發', async () => {
      await crashEngine();
      for (let i = 0; i < 30; i++) {
        const k = await ks();
        if (k.tripped) { console.log('    reason=' + (k.reason || '') + ' blocking=' + k.blocking); return; }
        await new Promise(r => setTimeout(r, 500));
      }
      throw new Error('等了 15 秒仍未觸發');
    });

    await T('封鎖模式真的起來了（blocking=true 且 TUN 重建）', async () => {
      const k = await ks();
      if (!k.blocking) throw new Error('blocking=false —— 受保護流量沒有被擋住，這是 fail-open');
      if (tunCount() <= baseTun) throw new Error('封鎖模式沒有重建 TUN');
    });

    await T('fail-closed：受保護的走不出去，其餘照常上網', async () => {
      const a = curl('https://www.gstatic.com/generate_204', 8);   // 受保護 → 應被擋
      const b = curl('https://github.com', 8);                     // 規則外 → 應照常
      if (a === '204') throw new Error('受保護的流量仍然出得去 —— 保護沒有生效');
      if (b !== '200') throw new Error('沒被保護的流量也斷了（' + b + '）—— 擋過頭了');
      console.log('    gstatic=' + a + '（擋住）github=' + b + '（照常）');
    });

    await T('關掉自動重連時不會自己復原', async () => {
      await new Promise(r => setTimeout(r, 6000));
      const k = await ks();
      if (!k.tripped) throw new Error('沒開自動重連卻自己復原了');
      if (k.retries) throw new Error('沒開自動重連卻重試了 ' + k.retries + ' 次');
    });

    // ---------- 手動復原 ----------
    await T('「停用分流並直連」→ 一切還原', async () => {
      await c.eval(`window.api.killswitchClear()`);
      for (let i = 0; i < 20; i++) {
        const k = await ks();
        if (!k.tripped) break;
        await new Promise(r => setTimeout(r, 500));
      }
      const k = await ks();
      if (k.tripped) throw new Error('仍是觸發狀態');
      for (let i = 0; i < 15; i++) { if (tunCount() === baseTun && !singboxCount()) break; await new Promise(r => setTimeout(r, 600)); }
      if (tunCount() !== baseTun) throw new Error('TUN 沒收乾淨');
      if (singboxCount()) throw new Error('sing-box 還在');
      if (curl('https://www.gstatic.com/generate_204') !== '204') throw new Error('網路沒恢復');
    });

    // ---------- 自動重連 ----------
    await T('開啟自動重連 → 崩潰後自己復原', async () => {
      await c.eval(`window.api.updateSettings({ killSwitchAutoReconnect: true })`);
      await c.eval(`window.api.engineStart()`);
      if (!await waitEngine('running')) throw new Error('引擎沒起來');
      await new Promise(r => setTimeout(r, 1500));
      await crashEngine();
      // 每次間隔 4 秒、最多 3 次 → 給它 25 秒
      for (let i = 0; i < 50; i++) {
        const k = await ks();
        if (!k.tripped && await engState() === 'running') { console.log('    自動復原，重試 ' + k.retries + ' 次'); return; }
        await new Promise(r => setTimeout(r, 500));
      }
      const k = await ks();
      throw new Error('25 秒內沒有自動復原（tripped=' + k.tripped + ' retries=' + k.retries + '）');
    });

    await T('自動復原後分流仍然正常', async () => {
      const before = readOracle().length;
      const a = curl('https://www.gstatic.com/generate_204');
      await new Promise(r => setTimeout(r, 1200));
      if (a !== '204') throw new Error('gstatic 失敗：' + a);
      if (!readOracle().slice(before).filter(l => /CONNECT /.test(l)).length) throw new Error('代理沒收到 —— 復原後規則沒生效');
    });
  } finally {
    // ---------- 收尾：務必還原 ----------
    await T('收尾：關掉保護、停引擎、確認乾淨', async () => {
      await c.eval(`window.api.updateSettings({ killSwitch: false, killSwitchAutoReconnect: false })`).catch(() => {});
      await c.eval(`window.api.killswitchClear()`).catch(() => {});
      await c.eval(`window.api.engineStop()`).catch(() => {});
      for (let i = 0; i < 20; i++) { if (tunCount() === baseTun && !singboxCount()) break; await new Promise(r => setTimeout(r, 600)); }
      if (tunCount() !== baseTun) throw new Error('TUN 殘留');
      if (singboxCount()) throw new Error('sing-box 殘留');
      if (curl('https://www.gstatic.com/generate_204') !== '204') throw new Error('網路沒恢復');
    });
    try { fs.unlinkSync(KILL_FLAG); } catch (e) {}
    const bad = results.filter(r => r[0] === 'FAIL');
    console.log('KS SUMMARY ' + JSON.stringify({ total: results.length, fail: bad.length }));
    console.log('最終：TUN=' + tunCount() + ' sing-box=' + singboxCount());
    process.exit(bad.length ? 1 : 0);
  }
})().catch(e => {
  console.log('KS DRIVER ERROR: ' + e.message);
  console.log('救援：powershell -Command "Get-Process sing-box -EA 0 | Stop-Process -Force"');
  process.exit(2);
});
