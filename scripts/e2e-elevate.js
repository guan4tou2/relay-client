// 「用到才提權」的端到端測試（Windows 的 relaunch-app 策略）。
//
// 這是最後一條沒測過的路徑，而且看程式碼就有一個說不準的地方：
// relaunchElevated() 在「舊實例還握著單一實例鎖」的時候就把提權實例拉起來，
// 700ms 之後才 app.exit(0)。提權實例（高完整性）看得到一般實例的鎖，
// 拿不到就會 app.exit(0) —— 兩邊都退場的話，使用者按下「啟動分流引擎」
// 會看到整個 app 消失。這支就是要把這個時序講清楚。
//
// 跟真實流程的差別只有一處：這裡多帶 --user-data-dir 與 --remote-debugging-port。
//   - --user-data-dir：真實路徑不帶，提權實例會讀使用者的真實設定並照那份啟動引擎。
//     拿使用者的真實路由來跑測試不合適，所以隔離。
//   - --remote-debugging-port：提權實例才能被好好收掉。直接 Stop-Process -Force
//     會跳過 app.quit()，TUN 與路由表會留在機器上（程式碼裡也是這麼提醒的）。
//
// 跑法：
//   dist\win-unpacked\RelayClient.exe --remote-debugging-port=9303 --user-data-dir=%TEMP%\elud
//   node scripts/e2e-elevate.js        ← 會跳 UAC，要按「是」
//
// 無論成敗，最後都會停引擎、確認 TUN 消失、把提權實例關掉。

const http = require('http');
const { execFileSync, spawn } = require('child_process');
const path = require('path');

const OLD_PORT = Number(process.env.CDP_PORT || 9303);
const NEW_PORT = Number(process.env.CDP_PORT_ELEVATED || 9304);
const EXE = process.env.APP_EXE || path.resolve('dist/win-unpacked/RelayClient.exe');
const UD = process.env.APP_UD || path.join(process.env.TEMP || '.', 'elud');

const getJSON = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

const ps = (cmd) => {
  try { return execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 20000 }); }
  catch (e) { return ''; }
};
// 只算「真的還活著」的。這裡很容易騙到自己：
// 強制結束過的 Electron 會留下 threads=0 的殭屍行程，Get-Process 跟 Win32_Process
// 都照樣列得出來，而且它「還握著單一實例鎖」。拿那種清單去判斷「舊實例退場了沒」，
// 會把自己的收尾方式誤判成產品的 bug —— 我在這支測試上被騙過三次。
// 執行緒數是唯一可靠的活性指標。
const appPids = () => ps(
  "((Get-Process RelayClient -EA 0 | Where-Object { $_.Threads.Count -gt 0 }) | % Id) -join ','").trim();
// 主行程＝沒有 --type= 的那個。單一實例鎖握在它手上。
const appMainPid = () => ps(
  "(Get-CimInstance Win32_Process -Filter \"Name='RelayClient.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' -and (Get-Process -Id $_.ProcessId -EA 0).Threads.Count -gt 0 } | Select-Object -First 1 -ExpandProperty ProcessId)").trim();
const tunCount = () => ps("(Get-NetAdapter -EA 0 | Where-Object { $_.Name -like '*proxyclient*' -or $_.InterfaceDescription -like '*sing-box*' } | Measure-Object).Count").trim();
const singboxCount = () => ps("(Get-Process sing-box -EA 0 | Measure-Object).Count").trim();
const routeSnapshot = () => ps("(Get-NetRoute -EA 0 | Sort-Object DestinationPrefix,ifIndex | % { \"$($_.ifIndex) $($_.DestinationPrefix) $($_.NextHop)\" }) -join \"`n\"").trim();
const connectivity = () => ps("try { (Invoke-WebRequest -Uri 'http://www.gstatic.com/generate_204' -UseBasicParsing -TimeoutSec 8).StatusCode } catch { '000' }").trim();

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
  send(method, params = {}, ms = 90000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, ms);
    });
  }
  async eval(expr, ms) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result.value;
  }
}

async function attach(port, timeoutMs = 45000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const list = await getJSON(port, '/json/list');
      const t = list.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) { const c = await CDP.connect(t.webSocketDebuggerUrl); await c.send('Runtime.enable'); return c; }
    } catch (e) {}
    if (Date.now() - t0 > timeoutMs) return null;
    await new Promise(r => setTimeout(r, 700));
  }
}

const results = [];
async function T(name, fn) {
  try { await fn(); results.push(['ok', name]); console.log('EL ok: ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('EL FAIL: ' + name + ' :: ' + e.message); }
}

(async () => {
  const old = await attach(OLD_PORT, 10000);
  if (!old) throw new Error('連不到一般權限的實例（先手動啟動，見檔頭）');

  const routesBefore = routeSnapshot();
  const tunBefore = tunCount();
  console.log('測試前：TUN=' + tunBefore + ' sing-box=' + singboxCount() + ' 連線=' + connectivity());

  let elevated = null;
  try {
    await T('一般權限下 isElevated() 是 false（測試前提）', async () => {
      const v = await old.eval(`window.api.isElevated ? window.api.isElevated() : null`);
      if (v !== false) throw new Error('回 ' + JSON.stringify(v));
    });

    await T('一般權限下啟動引擎會被擋下，並回報「需要提權」而不是假裝成功', async () => {
      const r = JSON.parse(await old.eval(`window.api.engineStart().then(x => JSON.stringify(x))`, 60000));
      if (r.ok) throw new Error('沒提權卻回成功：' + JSON.stringify(r));
      if (!r.needElevation) throw new Error('沒有 needElevation 旗標，UI 不知道要跳 UAC：' + JSON.stringify(r));
      if (tunCount() !== tunBefore) throw new Error('被擋下來了卻還是建了 TUN');
    });

    const oldMain = appMainPid();
    console.log('提權前的 app 主行程:', oldMain, '（全部：' + appPids() + '）');
    console.log('');
    console.log('  >>> 接下來會跳 UAC，請按「是」<<<');
    console.log('');

    // 真實流程是 ipcMain 的 engine-elevate；這裡直接用 adapter 組出來的同一條指令，
    // 差別只在多帶 --user-data-dir 與 --remote-debugging-port（理由見檔頭）。
    const winAdapter = require('../src/platform/windows');
    const { cmd, args } = winAdapter.engineElevation.relaunchCommand(
      EXE, ['--engine-autostart', `--user-data-dir=${UD}`, `--remote-debugging-port=${NEW_PORT}`]);

    const code = await new Promise((res) => {
      const cp = spawn(cmd, args, { windowsHide: true });
      cp.on('exit', res);
      cp.on('error', () => res(-1));
      setTimeout(() => res(-2), 120000);
    });

    await T('使用者同意後，觸發提權的指令回 0（回非 0 代表被拒或被政策擋）', async () => {
      if (code !== 0) throw new Error('離開碼 ' + code + (code === -2 ? '（等 UAC 逾時）' : ''));
    });

    // 真實流程在這個時間點會把舊實例收掉：app.exit(0)，是優雅退出。
    //
    // 這裡千萬不能用 Stop-Process -Force。強制結束 Electron 會留下一個
    // threads=0 的殭屍主行程，而它「還握著單一實例鎖」——於是提權實例拿不到鎖、
    // 自己退場，看起來就像產品壞了。我在這支測試上被自己這樣騙過兩次。
    // taskkill 不帶 /F 送的是 WM_CLOSE，跟 app.exit(0) 同一類，鎖會正常釋放。
    await new Promise(r => setTimeout(r, 700));
    // 用「CDP 埠還回不回應」判斷舊實例死透了沒。
    // 行程清單在這件事上不可信：強制結束過的 Electron 會留下 threads=0 的殭屍，
    // Get-Process / Win32_Process 都照樣列得出來，而且殭屍主行程「還握著單一實例鎖」。
    // 我被這個騙過三次，每次都差點把自己收尾的毛病寫成產品的 bug。
    const alive = (port) => new Promise(res => {
      const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 2000 }, r => { r.resume(); res(true); });
      req.on('error', () => res(false)); req.on('timeout', () => { req.destroy(); res(false); });
    });

    // 先走 app 自己準備的結束通道（NSIS 安裝程式用的同一條）：--quit 的意圖
    // 經由 second-instance 轉給在跑的實例，那邊做完整的 app.quit()。
    //
    // --user-data-dir 一定要跟著帶：單一實例鎖是「綁 userData 目錄」的，
    // 不帶的話 --quit 那個實例會在預設命名空間裡拿到鎖、自己退場，
    // 根本沒跟隔離設定檔裡的實例講到話。這就是我先前以為「--quit 壞掉」的原因。
    ps(`Start-Process '${EXE}' -ArgumentList '--quit','--user-data-dir=${UD}' -WindowStyle Hidden`);
    let quitWorked = false;
    for (let i = 0; i < 40; i++) {
      if (!await alive(OLD_PORT)) { quitWorked = true; break; }
      await new Promise(r => setTimeout(r, 250));
    }
    if (!quitWorked && oldMain) {
      console.log('  （--quit 沒收掉它，改用強制結束——這會留殭屍，下面若失敗要先懷疑這裡）');
      ps(`Stop-Process -Id ${oldMain} -Force -EA 0`);
      for (let i = 0; i < 40 && await alive(OLD_PORT); i++) await new Promise(r => setTimeout(r, 250));
    }
    console.log('舊實例退場方式:', quitWorked ? '--quit（優雅）' : '強制結束', ' 舊埠還活著:', await alive(OLD_PORT));
    if (await alive(OLD_PORT)) throw new Error('舊實例沒退場——鎖還握著，後面測什麼都不算數');

    await T('提權實例活得下來（沒有被單一實例鎖擋掉而自己退場）', async () => {
      elevated = await attach(NEW_PORT, 60000);
      if (!elevated) {
        throw new Error('提權實例沒有出現可用的視窗——很可能是撞到舊實例還握著的單一實例鎖，'
          + '兩邊都退場，使用者會看到整個 app 消失');
      }
    });

    await T('提權實例的 isElevated() 是 true', async () => {
      const v = await elevated.eval(`window.api.isElevated()`);
      if (v !== true) throw new Error('回 ' + JSON.stringify(v));
    });

    await T('--engine-autostart 有被吃到：提權後引擎自己起來了', async () => {
      let st = null;
      for (let i = 0; i < 40; i++) {
        st = JSON.parse(await elevated.eval(`window.api.getEngineStatus().then(x => JSON.stringify(x))`));
        if (st.state === 'running') break;
        await new Promise(r => setTimeout(r, 1000));
      }
      if (!st || st.state !== 'running') throw new Error('引擎狀態停在 ' + JSON.stringify(st));
    });

    await T('TUN 真的建起來了（不是只把狀態設成 running）', async () => {
      if (tunCount() === '0') throw new Error('沒有 TUN 介面');
      if (singboxCount() === '0') throw new Error('沒有 sing-box 行程');
    });

    await T('引擎接手後網路還通', async () => {
      const code2 = connectivity();
      if (code2 !== '204') throw new Error('HTTP ' + code2);
    });
  } finally {
    await T('收尾：停引擎 → TUN 消失、sing-box 收乾淨', async () => {
      if (elevated) { try { await elevated.eval(`window.api.engineStop()`, 60000); } catch (e) {} }
      await new Promise(r => setTimeout(r, 2500));
      if (tunCount() !== '0') throw new Error('TUN 還在：' + tunCount());
      if (singboxCount() !== '0') throw new Error('sing-box 還在：' + singboxCount());
    });

    await T('收尾：路由表跟測試前逐字相同', async () => {
      const after = routeSnapshot();
      if (after !== routesBefore) {
        const a = after.split('\n'), b = routesBefore.split('\n');
        throw new Error(`路由沒還原（前 ${b.length} 條、後 ${a.length} 條）\n  多: `
          + a.filter(x => !b.includes(x)).slice(0, 5).join(' | ') + '\n  少: '
          + b.filter(x => !a.includes(x)).slice(0, 5).join(' | '));
      }
    });

    await T('收尾：關掉提權實例、網路恢復', async () => {
      ps("Get-Process RelayClient -EA 0 | Stop-Process -Force -EA 0");
      await new Promise(r => setTimeout(r, 2000));
      const code3 = connectivity();
      if (code3 !== '204') throw new Error('HTTP ' + code3);
    });

    const bad = results.filter(r => r[0] === 'FAIL');
    console.log('EL SUMMARY ' + JSON.stringify({ total: results.length, fail: bad.length }));
    console.log('測試後：TUN=' + tunCount() + ' sing-box=' + singboxCount() + ' 連線=' + connectivity());
    process.exit(bad.length ? 1 : 0);
  }
})().catch(e => {
  console.log('EL DRIVER ERROR: ' + e.message);
  console.log('救援：Get-Process sing-box,RelayClient | Stop-Process -Force');
  process.exit(2);
});
