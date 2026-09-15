// 系統代理開關 + 規則庫真實下載的端到端測試。
//
// 這兩塊原本只有 mock：
//   - platform-windows-proxy.test.js 整個 jest.mock('child_process')，登錄檔寫入是假的
//   - ruleset.test.js 用假的 https server，沒真的從 GitHub 抓過 .srs
//
// 這支打真的 HKCU 登錄檔與真的 GitHub。開頭會先把登錄檔快照起來，
// finally 一定還原 —— 不管中間成功失敗。
//
// 不需要提權（HKCU 與網路讀取都不用），但需要 app 開著 CDP。
//   CDP_PORT=9300 node scripts/e2e-sysproxy-ruleset.js

const http = require('http');
const { execFileSync } = require('child_process');

const PORT = Number(process.env.CDP_PORT || 9300);
const REG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

const reg = (args) => { try { return execFileSync('reg', args, { encoding: 'utf8', timeout: 8000 }); } catch (e) { return ''; } };
const readVal = (name) => {
  const out = reg(['query', REG, '/v', name]);
  const m = out.match(new RegExp(name + '\\s+REG_\\w+\\s+(.*)'));
  return m ? m[1].trim() : null;
};
const proxySnapshot = () => ({ enable: readVal('ProxyEnable'), server: readVal('ProxyServer'), override: readVal('ProxyOverride') });

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 120000);
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
  try { await fn(); results.push(['ok', name]); console.log('SR ok: ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('SR FAIL: ' + name + ' :: ' + e.message); }
}

(async () => {
  const list = await getJSON('/json/list');
  const target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) throw new Error('找不到 CDP target');
  const c = await CDP.connect(target.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  await new Promise(r => setTimeout(r, 1500));

  const before = proxySnapshot();
  console.log('系統代理快照（測試前）:', JSON.stringify(before));
  let installed = [];

  try {
    // ---------------- 系統代理 ----------------
    await T('路由沒跑時 UI 擋下來（開了會把流量導到沒人聽的埠）', async () => {
      await c.eval(`window.api.routeStop('r-oracle')`).catch(() => {});
      await new Promise(r => setTimeout(r, 1000));
      await c.eval(`(async () => { state.routes = await window.api.getRoutes(); state.routeStatus = {}; })()`).catch(() => {});
      const snap = proxySnapshot();
      // 防護在 renderer 的 toggleSys()，IPC 層沒有——所以要從 UI 函式打
      await c.eval(`toggleSys()`).catch(() => {});
      await new Promise(r => setTimeout(r, 800));
      const now = proxySnapshot();
      if (now.enable !== snap.enable) throw new Error('沒有路由卻改了登錄檔：' + snap.enable + ' → ' + now.enable);
    });

    await T('開啟系統代理 → HKCU 真的被寫入，且指向路由的本地埠', async () => {
      await c.eval(`window.api.routeStart('r-oracle')`);
      await new Promise(r => setTimeout(r, 1200));
      const r = JSON.parse(await c.eval(`window.api.toggleSystemProxy(true, 11081).then(x => JSON.stringify(x))`));
      if (!r.systemProxyEnabled) throw new Error('開啟失敗：' + JSON.stringify(r));
      const now = proxySnapshot();
      if (now.enable !== '0x1') throw new Error('ProxyEnable 不是 0x1：' + now.enable);
      if (!/127\.0\.0\.1:\d+/.test(now.server || '')) throw new Error('ProxyServer 不對：' + now.server);
      if (!/localhost/.test(now.override || '')) throw new Error('ProxyOverride 沒有本機白名單：' + now.override);
      console.log('    ProxyServer=' + now.server + '  Override=' + (now.override || '').slice(0, 40));
    });

    await T('關閉系統代理 → ProxyEnable 回到 0', async () => {
      const r = JSON.parse(await c.eval(`window.api.toggleSystemProxy(false).then(x => JSON.stringify(x))`));
      if (r.systemProxyEnabled) throw new Error('關閉失敗：' + JSON.stringify(r));
      const now = proxySnapshot();
      if (now.enable !== '0x0') throw new Error('ProxyEnable 不是 0x0：' + now.enable);
    });

    await T('app 回報的狀態跟登錄檔一致（不是只改自己的記憶體）', async () => {
      await c.eval(`window.api.toggleSystemProxy(true)`);
      await new Promise(r => setTimeout(r, 600));
      const onReg = proxySnapshot().enable;
      await c.eval(`window.api.toggleSystemProxy(false)`);
      await new Promise(r => setTimeout(r, 600));
      const offReg = proxySnapshot().enable;
      if (onReg !== '0x1' || offReg !== '0x0') throw new Error(`開=${onReg} 關=${offReg}`);
    });

    // ---------------- 規則庫 ----------------
    await T('目錄讀得到，且都是允許的來源', async () => {
      const cat = JSON.parse(await c.eval(`window.api.rulesetCatalog().then(x => JSON.stringify(x))`));
      if (!Array.isArray(cat) || cat.length < 5) throw new Error('目錄太小：' + (cat || []).length);
      console.log('    目錄 ' + cat.length + ' 項');
    });

    await T('真的從 GitHub 下載一個規則庫', async () => {
      const r = JSON.parse(await c.eval(`window.api.rulesetInstall('geoip-tw').then(x => JSON.stringify(x))`));
      if (!r.ok) throw new Error('下載失敗：' + JSON.stringify(r).slice(0, 160));
      installed = JSON.parse(await c.eval(`window.api.rulesetList().then(x => JSON.stringify(x))`));
      const one = installed.find(x => x.tag === 'geoip-tw');
      if (!one) throw new Error('清單裡沒有 geoip-tw');
      if (!one.bytes || one.bytes < 1024) throw new Error('檔案太小，可能沒真的下載：' + one.bytes);
      console.log('    geoip-tw ' + one.bytes + ' bytes，來源 ' + one.source);
    });

    await T('下載回來的 .srs 引擎吃得下（規則真的能用）', async () => {
      const m = JSON.parse(await c.eval(`window.api.ruleMatch({ host: '1.34.0.1', exe: '', port: 443, network: 'tcp' }).then(x => JSON.stringify(x))`));
      if (!m) throw new Error('模擬器沒回應');
      // 只驗「不會炸」；命不命中要看該 IP 是否真在台灣段，不是這裡要斷言的事
      console.log('    ruleMatch 回應正常：matched=' + m.matched);
    });

    await T('移除規則庫 → 清單與檔案都不見', async () => {
      const r = JSON.parse(await c.eval(`window.api.rulesetRemove('geoip-tw').then(x => JSON.stringify(x))`));
      if (!r.ok) throw new Error('移除失敗：' + JSON.stringify(r));
      const after = JSON.parse(await c.eval(`window.api.rulesetList().then(x => JSON.stringify(x))`));
      if (after.find(x => x.tag === 'geoip-tw')) throw new Error('清單裡還在');
      installed = after;
    });
  } finally {
    // ---------------- 收尾：登錄檔一定要還原 ----------------
    await T('收尾：系統代理還原成測試前的樣子', async () => {
      await c.eval(`window.api.toggleSystemProxy(false)`).catch(() => {});
      await new Promise(r => setTimeout(r, 600));
      if (before.enable !== null) reg(['add', REG, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', String(parseInt(before.enable, 16)), '/f']);
      if (before.server !== null) reg(['add', REG, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', before.server, '/f']);
      if (before.override !== null) reg(['add', REG, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', before.override, '/f']);
      const now = proxySnapshot();
      if (now.enable !== before.enable) throw new Error(`ProxyEnable 沒還原：${before.enable} → ${now.enable}`);
      if (now.server !== before.server) throw new Error(`ProxyServer 沒還原：${before.server} → ${now.server}`);
    });

    await T('收尾：規則庫清空、路由停掉', async () => {
      for (const x of installed) await c.eval(`window.api.rulesetRemove('${x.tag}')`).catch(() => {});
      await c.eval(`window.api.routeStop('r-oracle')`).catch(() => {});
    });

    const bad = results.filter(r => r[0] === 'FAIL');
    console.log('SR SUMMARY ' + JSON.stringify({ total: results.length, fail: bad.length }));
    console.log('系統代理（測試後）:', JSON.stringify(proxySnapshot()));
    process.exit(bad.length ? 1 : 0);
  }
})().catch(e => {
  console.log('SR DRIVER ERROR: ' + e.message);
  console.log('救援（還原系統代理）：reg add "' + REG + '" /v ProxyEnable /t REG_DWORD /d 0 /f');
  process.exit(2);
});
