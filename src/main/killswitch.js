// 斷線保護：引擎非預期中止時以封鎖模式擋住受保護程式、自動重連，外加防火牆層（issue #3）。
const config = require('../store/config');
const { KillSwitchFirewall, protectedPrograms } = require('../engine/ks-firewall');
const platform = require('../platform').current;
const { state, send } = require('./state');
const { addLog } = require('./log');
const routes = require('./routes');
const engineMod = require('./engine');

const engine = () => engineMod.getEngine();

// 分流引擎「非使用者主動」中止時，若已啟用，立即以封鎖模式重建 TUN，
// 先擋住受保護程式的連線，避免它們繞過代理外洩；並通知 UI 顯示告警。
const KS_MAX_RETRY = 3, KS_RETRY_DELAY = 4000;
const ksIdle = () => ({ tripped: false, reason: '', blocking: false, retries: 0, reconnecting: false, at: 0 });
let killSwitchState = ksIdle();
let ksRetryTimer = null;
// 使用者主動停止引擎或結束程式時一定要呼叫：不清掉的話，4 秒內重試計時器
// 看到 tripped 還是 true，就會違背使用者的意思把引擎重新拉起來（結束時則會殘留 TUN）。
function resetKillSwitch() {
  clearTimeout(ksRetryTimer);
  ksRetryTimer = null;
  killSwitchState = ksIdle();
}
// ---- 防火牆層（issue #3）----
// 引擎在跑、斷線保護開著的期間，對受保護程式預先加上防火牆規則（見 src/engine/ks-firewall.js）。
// sing-box 一死、流量退回實體網卡的當下就會被擋，不必等封鎖模式重建 TUN。
let ksFirewall = null;
function setupKsFirewall() {
  if (ksFirewall) return ksFirewall;
  ksFirewall = new KillSwitchFirewall({
    adapter: platform.killSwitchFirewall || null,
    listProcesses: () => (platform.listProcessesAsync ? platform.listProcessesAsync() : platform.listProcesses()),
    basename: p => platform.path.basename(p),
    log: (lvl, msg) => addLog(lvl, 'killswitch', msg),
  });
  return ksFirewall;
}
// 同一時間只跑一個：布防與解除都是一串 netsh，交錯執行會把剛加的規則刪掉
let ksFwChain = Promise.resolve();
const serialFw = fn => (ksFwChain = ksFwChain.then(fn, fn));
async function doSyncKsFirewall() {
  const fw = setupKsFirewall();
  if (!fw.supported || state.quitting) return;
  if (killSwitchState.tripped) return;   // 觸發中：規則正在擋，不能先拆再裝
  const st = config.getSettings();
  const e = engine();
  const engineUp = !!(e && e.state === 'running' && !e._blocking);
  if (!st.killSwitch || !engineUp) {
    if (fw.active) { await fw.disarm(); addLog('info', 'killswitch', '已解除防火牆層'); }
    return;
  }
  const r = await fw.arm(protectedPrograms({ settings: st, split: config.getSplit() }));
  if (r.ok) {
    addLog('info', 'killswitch', r.count
      ? `防火牆層已布防：${r.count} 支受保護程式在引擎中止的當下就會被擋`
      : '防火牆層沒有可比對的程式（純網域／IP 規則或全域模式），這部分仍只靠封鎖模式');
  }
}
const syncKsFirewall = () => serialFw(doSyncKsFirewall).catch(e => addLog('warn', 'killswitch', `防火牆層同步失敗：${e.message}`));

// 開機時清掉上一輪殘留的規則：app 崩潰時規則會留著（那正是它的用意），
// 但重開之後引擎還沒跑，留著就是受保護的程式永遠連不出去。
async function cleanupStaleKsFirewall() {
  const fw = setupKsFirewall();
  const ad = platform.killSwitchFirewall;
  if (!fw.supported || !ad.hasRules) return;
  if (!(await ad.hasRules())) return;
  await fw.disarm();
  if (await ad.hasRules()) {
    addLog('error', 'killswitch', '上次留下的斷線保護防火牆規則移除不了（需要系統管理員權限），受保護的程式可能連不出去',
      `以系統管理員身分啟動 RelayClient 一次即可自動清除；或手動執行：netsh advfirewall firewall delete rule name=${ad.ruleName}`);
  } else addLog('info', 'killswitch', '已清除上次留下的斷線保護防火牆規則');
}

// 重連失敗後要回到封鎖模式。重連的第一步是 stop（收掉封鎖用的 TUN），
// 以前失敗就這樣關著等下一次重試 —— 那 4 秒以上受保護的程式完全沒有保護，而介面還寫著「已暫停」。
async function reenterBlockMode() {
  if (state.quitting || !killSwitchState.tripped) return;
  let ok = false;
  try { const b = await engine().startBlock(engineMod.engineParams()); ok = !!(b && b.ok); } catch (e) {}
  killSwitchState.blocking = ok;
  if (!ok) addLog('error', 'killswitch', '無法回到封鎖模式 —— 受保護程式目前沒有保護');
}

// 自動重連（settings.killSwitchAutoReconnect，預設開）
function scheduleKillSwitchRetry() {
  clearTimeout(ksRetryTimer);
  if (!config.getSettings().killSwitchAutoReconnect) return;
  if (killSwitchState.retries >= KS_MAX_RETRY) {
    addLog('warn', 'killswitch', `已自動重試 ${KS_MAX_RETRY} 次仍失敗，請手動處理`);
    return;
  }
  ksRetryTimer = setTimeout(async () => {
    if (state.quitting || !killSwitchState.tripped) return;
    killSwitchState.retries += 1;
    killSwitchState.reconnecting = true;
    sendKillSwitch();
    addLog('info', 'killswitch', `自動重連第 ${killSwitchState.retries} 次…`);
    try {
      await engine().stop();
      killSwitchState.blocking = false;
      await routes.ensureSplitRoutesStarted();
      if (state.quitting || !killSwitchState.tripped) return;   // 停止期間使用者按了停止／結束
      const r = await engine().start(engineMod.engineParams());
      if (r && r.ok) {
        resetKillSwitch();
        addLog('info', 'killswitch', '自動重連成功，受保護程式已恢復連線');
        sendKillSwitch(); engineMod.sendEngineStatus();
        syncKsFirewall();
        return;
      }
      if (r && r.cancelled) return;                        // 使用者在中途按了停止
    } catch (e) { addLog('warn', 'killswitch', `自動重連失敗：${e.message}`); }
    await reenterBlockMode();
    killSwitchState.reconnecting = false;
    sendKillSwitch(); engineMod.sendEngineStatus();
    scheduleKillSwitchRetry();
  }, KS_RETRY_DELAY);
}

function sendKillSwitch() {
  send('killswitch', { ...killSwitchState, enabled: !!config.getSettings().killSwitch });
}
const getState = () => killSwitchState;
// 封鎖模式本身也中止了，或套用新設定後沒能回到封鎖模式：不能再顯示「已暫停」
function markBlockingLost() {
  killSwitchState.blocking = false;
  sendKillSwitch();
}
// 結束 app 時呼叫：引擎關了就要拆，否則結束之後受保護的程式永遠連不出去
function disarmFirewall() {
  if (!ksFirewall || !ksFirewall.supported) return Promise.resolve();
  return serialFw(() => ksFirewall.disarm());
}
async function triggerKillSwitch(code, reason) {
  if (state.quitting) return;
  const retries = killSwitchState.tripped ? killSwitchState.retries : 0;
  killSwitchState = { tripped: true, reason: reason || `分流引擎異常中止（code ${code}）`, blocking: false, retries, reconnecting: false, at: Date.now() };
  addLog('error', 'killswitch', '斷線保護啟動：已暫停受保護程式的連線，避免它們繞過代理');
  try {
    const r = await engine().startBlock(engineMod.engineParams());
    killSwitchState.blocking = !!(r && r.ok);
    if (!(r && r.ok)) addLog('error', 'killswitch', `block 模式啟動失敗：${(r && r.error) || '未知'}`);
  } catch (e) { addLog('error', 'killswitch', `封鎖模式例外：${e.message}`); }
  scheduleKillSwitchRetry();
  sendKillSwitch();
  engineMod.sendEngineStatus();
}

function registerIpc(ipcMain) {
  ipcMain.handle('get-killswitch', () => ({ ...killSwitchState, enabled: !!config.getSettings().killSwitch }));
  ipcMain.handle('killswitch-reconnect', async () => {
    clearTimeout(ksRetryTimer);
    engineMod.setupEngine();
    await engine().stop();               // 先收掉 block 模式
    killSwitchState.blocking = false;
    const gen = engine()._gen;
    await routes.ensureSplitRoutesStarted();  // 跟自動重連一樣：引擎要用的路由先帶起來，否則 TUN 往死掉的埠送
    if (state.quitting || gen !== engine()._gen) return { ok: false, cancelled: true, error: '啟動已取消' };
    const r = await engine().start(engineMod.engineParams());
    if (r && r.ok) { resetKillSwitch(); syncKsFirewall(); }
    else if (!(r && r.cancelled)) await reenterBlockMode();   // 失敗就回封鎖模式，不要關著不管
    sendKillSwitch(); engineMod.sendEngineStatus();
    return r;
  });
  ipcMain.handle('killswitch-clear', async () => {
    resetKillSwitch();
    engineMod.setupEngine();
    await engine().stop();               // 移除 TUN，恢復正常網路（使用者明確接受直連）
    await syncKsFirewall();            // 防火牆層也要拆，不然受保護的程式還是被擋
    sendKillSwitch(); engineMod.sendEngineStatus();
    return { ok: true };
  });
}

// 用 Object.assign 而不是重設 module.exports：模組之間互相 require（例如 engine ↔ killswitch），
// 重設的話先載入的那一方會拿到空物件。
Object.assign(module.exports, { resetKillSwitch, triggerKillSwitch, sendKillSwitch, getState, markBlockingLost, syncKsFirewall, serialFw, cleanupStaleKsFirewall, disarmFirewall, registerIpc });
