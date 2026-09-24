// 引擎啟動的端到端測試 —— 這一段需要系統管理員權限，所以獨立成一支，
// 不放進 scripts/e2e-cdp.js（那支在一般權限下就能跑完）。
//
// 跑法（app 必須「已經是管理員」啟動，否則 app 會走 relaunch-app 重開自己，
// 而那條路徑不會帶 --user-data-dir，會讀到使用者的真實設定）：
//
//   以管理員開 PowerShell，然後：
//   dist\win-unpacked\RelayClient.exe --remote-debugging-port=9300 --user-data-dir=%TEMP%\engud
//
//   再用一般權限跑：
//   CDP_PORT=9300 node scripts/e2e-engine.js
//
// profile 要先放夾具（r-oracle 路由 + 兩條規則）與裁判 socks-oracle.js，
// 空的 {} 會在第二步就失敗。建法見 docs/QA.md「跑引擎／斷線保護測試的前置」。
//
// 測試設定刻意用 mode=direct（只有 direct outbound、final=direct）：
// TUN 起得來、路由裝得上，但流量原樣出去、不經任何代理 —— 驗證的是
// 「引擎起不起得來、收不收得乾淨」，不是分流本身。
//
// 無論成功失敗都會在最後把引擎停掉並確認 TUN 消失。

const http = require('http');
const { execFileSync } = require('child_process');

const PORT = Number(process.env.CDP_PORT || 9300);

const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

const ps = (cmd) => {
  try { return execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 15000 }); }
  catch (e) { return ''; }
};

const tunAdapters = () => ps("Get-NetAdapter | Where-Object { $_.Name -like '*proxyclient*' -or $_.InterfaceDescription -like '*sing-box*' } | Measure-Object | % Count").trim();
const defaultRoutes = () => ps("(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -EA 0 | Sort-Object ifIndex | % { \"$($_.ifIndex):$($_.NextHop)\" }) -join ','").trim();
// sing-box 在 Windows 是在 TUN 介面上裝一條 0.0.0.0/0 走 172.19.0.2（不是 Linux 常見的 0.0.0.0/1 + 128.0.0.0/1）
const tunDefaultRoutes = () => ps("(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -EA 0 | Where-Object { $_.NextHop -like '172.19.0.*' } | Measure-Object).Count").trim();

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

// 連通性必須從主機測：renderer 跑在 file:// origin，它的 fetch 到 https 一律失敗，
// 跟引擎有沒有把網路弄壞完全無關——第一版就是這樣誤報的。
// 抓一個有點大的 TLS 回應，MTU 不對時這種才會斷（204 太小可能混過）。
function probe() {
  const one = (url) => new Promise((res) => {
    try {
      const out = execFileSync('curl', ['-s', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null',
        '-w', '%{http_code} %{size_download} %{time_total}', '--max-time', '10', url], { encoding: 'utf8', timeout: 15000 });
      res(String(out).trim());
    } catch (e) { res('000 0 timeout'); }
  });
  return Promise.all([one('https://www.gstatic.com/generate_204'), one('https://github.com')])
    .then(([a, b]) => {
      const code = (x) => x.split(' ')[0];
      const ok = (code(a) === '204' || code(a) === '200') && code(b) === '200';
      return { ok, detail: `generate_204=[${a}] github=[${b}]` };
    });
}

const ORACLE_LOG = process.env.SOCKS_LOG || (process.env.TEMP + '/socks-oracle.log');
const readOracle = () => { try { return require('fs').readFileSync(ORACLE_LOG, 'utf8').split(/\r?\n/).filter(Boolean); } catch (e) { return []; } };
const probeOne = (url) => {
  try {
    return execFileSync('curl', ['-s', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null',
      '-w', '%{http_code} %{time_total}', '--max-time', '15', url], { encoding: 'utf8', timeout: 20000 }).trim();
  } catch (e) { return '000 timeout'; }
};

const results = [];
async function T(name, fn) {
  try { await fn(); results.push(['ok', name]); console.log('ENG ok: ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('ENG FAIL: ' + name + ' :: ' + e.message); }
}

(async () => {
  const list = await getJSON('/json/list');
  const target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) throw new Error('找不到 CDP target');
  const c = await CDP.connect(target.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  await new Promise(r => setTimeout(r, 2500));

  // ---- 基準線：動手之前先記下來，收尾要比對 ----
  const base = { tun: tunAdapters(), def: defaultRoutes(), tunDef: tunDefaultRoutes() };
  console.log('基準：TUN=' + base.tun + ' 預設路由=[' + base.def + '] TUN 預設路由=' + base.tunDef);

  let started = false;
  try {
    await T('app 是以管理員啟動的（否則會走 relaunch 讀到真實設定）', async () => {
      const st = await c.eval(`window.api.getEngineStatus().then(s => JSON.stringify(s))`);
      const s = JSON.parse(st);
      if (!s.elevated) throw new Error('沒有提權：' + st);
    });

    await T('測試 profile 是隔離的（不是使用者的真實設定）', async () => {
      const v = await c.eval(`Promise.all([window.api.getRoutes(), window.api.getSplit(), window.api.getSettings()])
        .then(([r, sp, se]) => JSON.stringify({ routes: r.length, mode: sp.mode, def: sp.defaultTarget, rules: sp.rules.length, ks: !!se.killSwitch }))`);
      const o = JSON.parse(v);
      // 夹具：1 條路由指向本機 SOCKS 裁判；2 條規則——
      // 第 1 條把裁判自己（node.exe）放直連，不然它連出去的流量會被第 2 條抓回來→迴圈。
      // 這是「代理跑在本機」特有的問題，上游在遠端時不會發生。
      // 不是使用者的真實設定（那會有他自己的代理）。
      if (o.routes !== 1 || o.rules !== 2) throw new Error('profile 不是預期的夹具：' + v);
      if (o.mode !== 'rule') throw new Error('模式應為 rule，實際 ' + o.mode);
      if (o.def !== 'direct') throw new Error('規則外流量應直連，實際 ' + o.def);
      if (o.ks) throw new Error('斷線保護應關閉，否則引擎死掉會封鎖網路');
    });

    // 規則指向的路由必須先跑起來，不然 11081 沒人聽，
    // 命中的流量會送到一個沒人接的埠 → 默默斷掉。
    await T('先啟動規則指向的路由（本機中繼）', async () => {
      const r = await c.eval(`window.api.routeStart('r-oracle').then(x => JSON.stringify(x))`);
      const o = JSON.parse(r);
      if (!o.ok) throw new Error('路由啟動失敗：' + JSON.stringify(o));
      for (let i = 0; i < 15; i++) {
        const st = await c.eval(`window.api.getRouteStatus().then(s => JSON.stringify(s))`);
        if (/"r-oracle"/.test(st)) return;
        await new Promise(x => setTimeout(x, 500));
      }
      throw new Error('路由沒進入執行中狀態');
    });

    await T('啟動引擎 → 回報 running', async () => {
      const r = await c.eval(`window.api.engineStart().then(x => JSON.stringify(x))`);
      const o = JSON.parse(r);
      if (!o.ok) throw new Error('啟動失敗：' + (o.error || r));
      started = true;
      for (let i = 0; i < 20; i++) {
        const st = JSON.parse(await c.eval(`window.api.getEngineStatus().then(s => JSON.stringify(s))`));
        if (st.state === 'running') return;
        await new Promise(x => setTimeout(x, 700));
      }
      throw new Error('等了 14 秒仍不是 running');
    });

    await T('TUN 虛擬網卡真的出現了', async () => {
      for (let i = 0; i < 12; i++) {
        if (Number(tunAdapters()) > Number(base.tun)) return;
        await new Promise(x => setTimeout(x, 700));
      }
      throw new Error('沒看到新的 TUN 網卡（基準 ' + base.tun + '，現在 ' + tunAdapters() + '）');
    });

    await T('auto_route 真的寫進路由表', async () => {
      const now = Number(tunDefaultRoutes());
      if (!(now > Number(base.tunDef))) throw new Error('TUN 上沒有裝上 0.0.0.0/0（基準 ' + base.tunDef + '，現在 ' + now + '）');
    });

    await T('引擎在跑的時候 HTTPS 還通（direct 模式應該透明）', async () => {
      const r = await probe();
      if (!r.ok) throw new Error(`連不出去：${r.detail} —— 引擎把網路弄壞了`);
      console.log('    ' + r.detail);
    });

    // ---- 核心：規則真的把流量分到代理了嗎 ----
    // 裁判是一支獨立的 SOCKS5 伺服器（scripts 以外的 socks-oracle.js），
    // 每收到一個 CONNECT 就寫日誌。看日誌就知道有沒有經過代理，不用猜。
    await T('命中規則的網域真的走了代理', async () => {
      const before = readOracle().length;
      const r = probeOne('https://www.gstatic.com/generate_204');
      if (!/^(200|204)/.test(r)) throw new Error('請求失敗：' + r);
      await new Promise(x => setTimeout(x, 1500));
      // 只看 before 之後新增的行；不這樣做的話，測試開始前的連線會被算成「分流成功」。
      //
      // 不能用網域比對：hijack-dns 解析完之後，sing-box 交給上游的是 **IP**，
      // 所以裁判看到的是 CONNECT 108.177.97.94:443 而不是網域。
      // 要斷的本來就是「這條連線有沒有經過代理」，所以直接看有無新增。
      const fresh = readOracle().slice(before).filter(l => /CONNECT .*:443/.test(l));
      if (fresh.length === 0) throw new Error('代理沒收到這個連線 —— 規則沒生效');
      console.log('    裁判收到：' + fresh[fresh.length - 1].trim());
    });

    await T('沒命中的網域不走代理（規則是選擇性的，不是全拎）', async () => {
      const before2 = readOracle().length;
      const r = probeOne('https://github.com');
      if (!/^200/.test(r)) throw new Error('請求失敗：' + r);
      await new Promise(x => setTimeout(x, 800));
      // 同理：用「有沒有新增」而不是比網域名
      const leaked = readOracle().slice(before2).filter(l => /CONNECT /.test(l));
      if (leaked.length) throw new Error('不該走代理的也走了：' + leaked[0]);
      console.log('    裁判未新增（正確）');
    });

    await T('紀錄裡有引擎啟動的訊息', async () => {
      const n = await c.eval(`window.api.getLogs().then(l => l.filter(x => x.source === 'engine' || /引擎/.test(x.message || '')).length)`);
      if (!n) throw new Error('沒有引擎相關紀錄');
    });
  } finally {
    // ---- 收尾：無論如何都要停，並確認真的收乾淨 ----
    if (started) {
      await T('停止引擎 → 回報 stopped', async () => {
        await c.eval(`window.api.engineStop().then(x => JSON.stringify(x))`);
        for (let i = 0; i < 20; i++) {
          const st = JSON.parse(await c.eval(`window.api.getEngineStatus().then(s => JSON.stringify(s))`));
          if (st.state !== 'running' && st.state !== 'starting') return;
          await new Promise(x => setTimeout(x, 700));
        }
        throw new Error('停不下來');
      });

      await T('TUN 網卡消失、路由表還原', async () => {
        let ok = false;
        for (let i = 0; i < 15; i++) {
          if (tunAdapters() === base.tun && tunDefaultRoutes() === base.tunDef) { ok = true; break; }
          await new Promise(x => setTimeout(x, 800));
        }
        if (!ok) throw new Error(`沒還原：TUN ${base.tun}→${tunAdapters()}、TUN 預設路由 ${base.tunDef}→${tunDefaultRoutes()}`);
      });

      await T('預設路由回到原本那條', async () => {
        const now = defaultRoutes();
        if (now !== base.def) throw new Error(`預設路由變了：[${base.def}] → [${now}]`);
      });

      await T('收尾後 HTTPS 仍然通', async () => {
        const r = await probe();
        if (!r.ok) throw new Error('收尾後連不出去：' + r.detail);
        console.log('    ' + r.detail);
      });
    }
    const bad = results.filter(r => r[0] === 'FAIL');
    console.log('ENG SUMMARY ' + JSON.stringify({ total: results.length, fail: bad.length }));
    console.log('最終：TUN=' + tunAdapters() + ' 預設路由=[' + defaultRoutes() + '] TUN 預設路由=' + tunDefaultRoutes());
    process.exit(bad.length ? 1 : 0);
  }
})().catch(e => {
  console.log('ENG DRIVER ERROR: ' + e.message);
  console.log('救援：powershell -Command "Get-Process sing-box -EA 0 | Stop-Process -Force"');
  process.exit(2);
});
