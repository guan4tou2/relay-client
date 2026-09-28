// Per-app 分流引擎（sing-box TUN）。
const path = require('path');
const { spawn } = require('child_process');
const { app, dialog } = require('electron');
const config = require('../store/config');
const SingBoxEngine = require('../engine/singbox');
const { HitParser } = require('../engine/hit-parser');
const platform = require('../platform').current;
const { state, send } = require('./state');
const { addLog } = require('./log');
const routes = require('./routes');
const ks = require('./killswitch');
const rulesets = require('./rulesets');

let engine = null;
const getEngine = () => engine;

// sing-box 的良性噪音：http/socks 上游本就不帶 UDP，QUIC/UDP 會被拒並記 ERROR，但不影響功能 → 不進紀錄。
const ENGINE_LOG_NOISE = /UDP is not supported by outbound/i;
// ===== 命中追蹤 =====
// 解析器在 src/engine/hit-parser.js（抽出去才測得到——main.js 需要 electron 才能載入）。
// 它吃引擎的 debug log，把「這條連線命中第幾條規則」還原出來；這些行只統計不落地，
// 否則 debug 每條連線三四行會把 app.log 灌爆。
const hitParser = new HitParser({
  getRuleIndex: () => (engine && engine.ruleIndex) || [],
  onHit: (conn) => recordHit(conn),
});
const consumeEngineLine = line => hitParser.consume(line);
function resetHits() { hitParser.reset(); }

function recordHit(conn) {
  const info = conn.info;
  // app 自己的流量不記；DNS 拦截也不記（每查一次就一行，會把紀錄灌爆）
  if (info && (info.kind === 'self' || info.kind === 'dns')) return;
  const split = config.getSplit();
  const rule = info && info.kind === 'rule' ? split.rules.find(r => r.id === info.id) : null;
  addLog('info', 'split', `連線 ${conn.host}`, null, {
    matched: !!info,
    ruleId: rule ? rule.id : null,
    ruleName: !info ? '預設' : info.kind === 'lan' ? '本機與內網' : (rule && rule.name) || '未命名規則',
    ruleIndex: rule ? split.rules.indexOf(rule) + 1 : 0,
    target: info ? (info.kind === 'lan' ? 'direct' : info.target) : split.defaultTarget,
  });
}

function setupEngine() {
  if (engine) return;
  engine = new SingBoxEngine();
  engine.on('status', (s) => send('engine-status', s));
  engine.on('log', (chunk) => {
    // sing-box 一個 data 事件常含多行；逐行處理並濾掉已知的良性噪音（見 ENGINE_LOG_NOISE）。
    for (const raw of String(chunk).split(/\r?\n/)) {
      // eslint-disable-next-line no-control-regex -- 去掉 sing-box 輸出的 ANSI 色碼（ESC[..m）
      const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (!line || ENGINE_LOG_NOISE.test(line)) continue;
      if (consumeEngineLine(line)) continue;   // 命中 / 連線相關 → 只統計，不進紀錄
      addLog('debug', 'engine', line.slice(0, 400));
    }
  });
  engine.on('exit', (code) => {
    if (state.quitting) return;
    // block（斷線保護）模式自己中止 → 不遞迴再觸發，只記錄並回報
    if (engine._blocking) { addLog('error', 'killswitch', `斷線保護的封鎖模式也中止了（code ${code}）——受保護程式已失去保護`); ks.markBlockingLost(); sendEngineStatus(); return; }
    addLog('warn', 'engine', `分流引擎異常結束（code ${code}）`);
    if (config.getSettings().killSwitch) ks.triggerKillSwitch(code);
    else sendEngineStatus();
  });
}

function engineParams() {
  const split = config.getSplit();
  const self = path.basename(process.execPath); // dev: electron.exe；打包: RelayClient.exe
  return {
    rules: split.rules,
    ruleSets: rulesets.setupRuleSets().resolveForEngine(rulesets.referencedSetTags(split.rules)),
    defaultTarget: split.defaultTarget, udp: split.udp,
    mode: split.mode, globalTarget: split.globalTarget, lanDirect: split.lanDirect,
    routes: config.getRoutes(), selfNames: [self],
    // TUN 拉起來前先抓系統 DNS，當成 sing-box 的上游（不能讓它自己讀系統清單，那裡面有 TUN 自己）
    dnsServers: platform.systemDnsServers ? platform.systemDnsServers() : [],
    // 只在「只有以下程式」模式下才傳，空陣列 = 所有走代理的程式（依規則表）
    scopeApps: (() => { const st = config.getSettings();
      return st.killSwitchScope === 'apps' ? (st.killSwitchApps || []) : []; })(),
  };
}

function sendEngineStatus() {
  send('engine-status', engine ? engine.status() : { state: 'off', elevated: false, tun: null, health: [] });
}

// 規則庫變動 → 引擎在跑就重載設定（等同 save-split 的即時套用）
// 重啟失敗不能安靜吞掉：這是使用者主動的 stop，斷線保護不會自己觸發，
// 引擎就這樣關著、介面不知道，受保護的程式全部直連出去。
async function reloadEngineIfRunning() {
  if (!(engine && engine.state === 'running')) return null;
  const wasBlocking = !!engine._blocking;
  await engine.stop();
  const gen = engine._gen;
  await routes.ensureSplitRoutesStarted();
  if (state.quitting || gen !== engine._gen) return { ok: false, cancelled: true, error: '啟動已取消' };
  const r = wasBlocking ? await engine.startBlock(engineParams()) : await engine.start(engineParams());
  if (!(r && r.ok) && !(r && r.cancelled)) {
    const why = (r && (r.error || r.message)) || '未知原因';
    addLog('error', 'engine', `套用新設定後分流引擎無法啟動：${why}`);
    if (wasBlocking) ks.markBlockingLost();   // 封鎖模式沒回來，不能再寫「已暫停」
    else if (config.getSettings().killSwitch) await ks.triggerKillSwitch(0, `套用新設定後分流引擎無法啟動：${why}`);
  } else if (r && r.ok && !wasBlocking) ks.syncKsFirewall();   // 規則可能改了 → 受保護的程式清單跟著換
  sendEngineStatus();
  return r;
}

// 用到才提權。提權方式因平台而異（adapter 的 engineElevation.strategy）：
//   relaunch-app（Windows）：以系統管理員重啟自己，帶旗標讓新實例自動啟動引擎與上游路由
//   setcap（Linux）：對 sing-box 授一次 CAP_NET_ADMIN 即可，不必用 root 跑 app
//   unsupported（macOS）：需要簽章的特權助手，本版未提供 → 回報說明而不是假裝成功
function relaunchElevated() {
  const el = platform.engineElevation;
  if (el.strategy === 'setcap') {
    const bin = engine ? engine.binPath : '';
    return Promise.resolve(el.isSatisfied(bin) ? { ok: true } : { ok: false, error: el.instructions(bin) });
  }
  if (el.strategy !== 'relaunch-app') return Promise.resolve({ ok: false, error: el.instructions() });
  // 用 powershell 的 Start-Process -Verb RunAs 觸發 UAC，並「等它結束」判斷結果：
  //   exit 0 = 使用者同意、提權實例已啟動 → 才收掉目前這個（避免埠衝突、避免像 crash）
  //   非 0 / error = 被拒或被公司政策封鎖 → 不關閉，回報錯誤，其餘功能照常
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      // Portable 會解壓到 temp 再跑；舊實例結束會刪那個 temp → 必須重啟「原始 portable exe」
      // （PORTABLE_EXECUTABLE_FILE，會重新解壓到新 temp），否則新提權實例的檔案被刪會 crash。
      const { cmd, args } = el.relaunchCommand(platform.autostart.launchPath(), ['--engine-autostart']);
      const cp = spawn(cmd, args, { windowsHide: true });
      cp.on('exit', (code) => {
        if (code === 0) {
          finish({ ok: true });
          // 先把鎖放掉，再等 700ms 退場。提權實例會在它自己啟動後一兩秒問鎖，
          // 我們還握著的話它就會自己退場 —— 使用者眼中是 app 整個消失。
          // 提權實例那邊也有重試（見 acquireSingleInstanceLock），兩邊各做一半。
          try { app.releaseSingleInstanceLock(); } catch (e) {}
          setTimeout(() => app.exit(0), 700);
        }
        else { finish({ ok: false, error: '提權被拒或被公司政策封鎖，分流引擎無法啟動（app 其餘功能不受影響）。' }); }
      });
      cp.on('error', (e) => finish({ ok: false, error: e.message }));
      setTimeout(() => finish({ ok: false, error: '提權逾時' }), 60000);
    } catch (e) { finish({ ok: false, error: e.message }); }
  });
}

// 提權重啟後自動啟動引擎（先把規則會用到的路由帶起來）
async function autoStartEngineElevated() {
  setupEngine();
  const gen = engine._gen;
  await routes.ensureSplitRoutesStarted();
  if (state.quitting || gen !== engine._gen) return;
  const r = await engine.start(engineParams());
  sendEngineStatus();
  addLog(r.ok ? 'info' : 'error', 'engine', r.ok ? '分流引擎已自動啟動（提權後）' : ('引擎自動啟動失敗：' + (r.error || r.message || '')));
  if (r.ok) ks.syncKsFirewall();
}

function registerIpc(ipcMain) {
  ipcMain.handle('get-split', () => config.getSplit());
  ipcMain.handle('save-split', async (_e, patch) => {
    const s = config.saveSplit(patch);
    const r = await reloadEngineIfRunning();   // 立即套用（先帶起規則要用的路由）
    return r && !r.ok && !r.cancelled ? { ...s, engineError: r.error || r.message || '分流引擎無法以新設定啟動' } : s;
  });
  // 列舉執行中的程式（含完整路徑），供規則挑選器用。
  // 列舉行程要跑 PowerShell（實測 448ms）。同步做的話整個 app 會凍住那麼久。
  ipcMain.handle('list-processes', () => (platform.listProcessesAsync ? platform.listProcessesAsync() : platform.listProcesses()));
  ipcMain.handle('browse-exe', async () => {
    const r = await dialog.showOpenDialog(state.mainWindow, { title: '選擇程式', filters: platform.exeFilters, properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    // 執行檔名的正規化（是否小寫、是否去 .exe、.app bundle 怎麼取名）由 adapter 決定
    const picked = platform.normalizeApp(r.filePaths[0]);
    return { name: picked.label, exe: picked.name, path: picked.path };
  });

  // 規則模擬器：「這個網址／IP（可選：這支程式）會走哪一條？」——不需啟動引擎
  ipcMain.handle('rule-match', async (_e, { host, exe, port, network } = {}) => {
    setupEngine();
    const split = config.getSplit();
    const res = await engine.matchTarget({
      host, exe, port, network,
      rules: split.rules,
      ruleSets: rulesets.setupRuleSets().resolveForEngine(rulesets.referencedSetTags(split.rules)),
      defaultTarget: split.defaultTarget,
      lanDirect: split.lanDirect !== false,
    });
    const rt = config.getRoutes().find(r => r.id === res.target);
    return { ...res, targetLabel: res.target === 'direct' ? '直接連線' : res.target === 'block' ? '封鎖' : (rt ? rt.label || rt.id : '（路由已刪除）') };
  });

  ipcMain.handle('engine-start', async () => {
    setupEngine();
    // 帶路由要時間；這段期間按了停止或結束程式的話，不能在那之後才把 sing-box 拉起來
    const gen = engine._gen;
    await routes.ensureSplitRoutesStarted(); // 引擎要用的路由先帶起來，避免 TUN 往死掉的本地埠送流量
    if (state.quitting || gen !== engine._gen) return { ok: false, cancelled: true, error: '啟動已取消' };
    resetHits();
    const r = await engine.start(engineParams());
    sendEngineStatus();
    if (r && r.ok) ks.syncKsFirewall();
    return r;
  });
  ipcMain.handle('engine-stop', async () => {
    resetHits();
    const wasTripped = ks.getState().tripped;
    ks.resetKillSwitch();
    if (engine) await engine.stop();
    await ks.syncKsFirewall();
    if (wasTripped) ks.sendKillSwitch();
    sendEngineStatus();
    return { ok: true };
  });
  ipcMain.handle('get-engine-status', () => { setupEngine(); return engine.status(); });
  ipcMain.handle('engine-elevate', () => relaunchElevated());
  ipcMain.handle('is-elevated', () => { setupEngine(); return engine.isElevated(); });
}

// 用 Object.assign 而不是重設 module.exports：模組之間互相 require（例如 engine ↔ killswitch），
// 重設的話先載入的那一方會拿到空物件。
Object.assign(module.exports, { setupEngine, getEngine, resetHits, engineParams, sendEngineStatus, reloadEngineIfRunning, autoStartEngineElevated, registerIpc });
