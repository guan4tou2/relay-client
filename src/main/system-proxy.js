// 系統代理：開關、跟 OS 的實際狀態對帳、結束時還原。
const config = require('../store/config');
const platform = require('../platform').current;
const systemProxy = platform.systemProxy;            // Windows 登錄檔 / macOS networksetup / Linux gsettings
const { state, send, sleepSync } = require('./state');
const { addLog } = require('./log');
const routes = require('./routes');
const win = require('./window');

let systemProxyEnabled = false;
let systemProxyTargetPort = null;   // 系統代理目前指向哪個本地埠（停掉那條路由時要跟著處理）

// 系統代理該指向哪個埠：跑著的路由裡挑一個，優先 http（Windows 的系統代理欄位
// 是 HTTP 代理，指到 socks5 埠的話瀏覽器連不上）。沒有路由在跑就回 null。
//
// 以前系統匣是寫死 settings.httpPort（10808，舊的單一主連線用的埠）。
// 主視窗早就改成用「當下路由的埠」了，兩邊對「系統代理」的定義不一樣 ——
// 從系統匣按下去會把整台機器指到一個沒人在聽的埠，然後就全部上不了網。
function systemProxyPort() {
  const running = routes.runningRoutes();
  if (!running.length) return null;
  return (running.find(r => r.kind === 'http') || running[0]).localPort;
}

// 啟動時 systemProxyEnabled 一律是 false，但上一輪可能是當機、或提權重啟（app.exit 跳過清理）結束的，
// 系統代理其實還開著、指向我們的埠。沒讀回來的話介面顯示「關」，結束時也不會去還原。
// 只認得出「127.0.0.1 + 我們某條路由的埠」這種；別人設的代理不碰。
function syncSystemProxyFromOS() {
  try {
    const s = systemProxy.get();
    const m = s && s.enabled && /^(?:https?:\/\/)?127\.0\.0\.1:(\d+)$/.exec(String(s.server || '').trim());
    if (!m) return;
    const port = Number(m[1]);
    if (!config.getRoutes().some(r => Number(r.localPort) === port)) return;
    systemProxyEnabled = true;
    systemProxyTargetPort = port;
  } catch (e) { /* 讀不到就維持預設 */ }
}

// 系統代理指向的那條路由不在跑了就關掉，並告訴使用者 —— 否則整台機器指著一個沒人在聽的埠，上不了網。
function reconcileSystemProxy() {
  if (!systemProxyEnabled || state.quitting) return;
  const running = routes.runningRoutes();
  if (systemProxyTargetPort && running.some(r => r.localPort === systemProxyTargetPort)) return;
  // 不自動改指到別條路由：那可能是別的上游、別的國家，使用者不會想要流量被默默換出口
  let notice = '系統代理指向的路由已停止，已關閉系統代理（避免整台機器上不了網）';
  try {
    systemProxy.disable();
    systemProxyEnabled = false;
    systemProxyTargetPort = null;
    addLog('warn', 'win-proxy', notice);
  } catch (e) { notice = `調整系統代理失敗：${e.message}`; addLog('error', 'win-proxy', notice); }
  sendSystemProxyState(notice);
  win.updateTrayMenu();
}

function resolveSystemProxyPort(requested) {
  const n = Number(requested);
  const running = routes.runningRoutes();
  if (Number.isInteger(n) && running.some(r => r.localPort === n)) return n;
  return systemProxyPort();
}

// 系統代理狀態變了就告訴視窗一聲。少了這個，從系統匣切換之後主視窗的開關
// 還停在舊狀態，使用者看到的跟實際的不一樣。
function sendSystemProxyState(notice) {
  send('system-proxy', { enabled: systemProxyEnabled, ...(notice ? { notice } : {}) });
}

const isEnabled = () => systemProxyEnabled;

// 系統匣的「啟用／關閉系統代理」。沒有路由在跑就不給開——跟主視窗那句「請先啟動路由」是同一個規則
function toggleFromTray() {
  const port = systemProxyPort();
  try {
    if (systemProxyEnabled) { systemProxy.disable(); systemProxyEnabled = false; systemProxyTargetPort = null; }
    else if (port) { systemProxy.enable(port); systemProxyEnabled = true; systemProxyTargetPort = port; }
  } catch (e) { addLog('error', 'system', `系統匣切換系統代理失敗：${e.message}`); }
  win.updateTrayMenu();
  sendSystemProxyState();
}

// 結束時把系統代理關回去。這一步失敗的後果是「關掉 app 之後整台機器上不了網」，
// 所以不能像其他清理那樣 try/catch 吞掉就算了 —— 失敗是要讓使用者知道的。
//
// 三件事：寫完讀回來確認（不信回傳值）、失敗就重試、最後真的不行就留下
// 一則寫得出手動步驟的紀錄。同一類的安靜失敗已經在 refresh() 上咬過一次。
function restoreSystemProxy() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { systemProxy.disable(); } catch (e) { addLog('warn', 'system', `還原系統代理第 ${attempt} 次失敗：${e.message}`); }
    try {
      if (!systemProxy.get().enabled) { systemProxyEnabled = false; return true; }
    } catch (e) { /* 讀不回來就當沒成功，繼續重試 */ }
    sleepSync(250);
  }
  addLog('error', 'system',
    '結束時無法關閉系統代理 —— 這台機器可能會上不了網',
    '請手動關閉：Windows 設定 → 網路和網際網路 → Proxy → 手動設定 Proxy → 關閉；'
    + '或執行 reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f');
  return false;
}

function registerIpc(ipcMain) {
  ipcMain.handle('toggle-system-proxy', (_e, enable, port) => {
    try {
      if (enable) {
        // 只接受「正在跑的路由」的埠：這個值會寫進系統設定（Windows 還是拼進 reg 指令），
        // 而且指到沒人在聽的埠整台機器就上不了網。不合的一律改用自己挑的那條。
        const target = resolveSystemProxyPort(port);
        if (!target) return { systemProxyEnabled, error: '沒有路由在跑' };
        systemProxy.enable(target);
        systemProxyEnabled = true;
        systemProxyTargetPort = target;
      } else {
        systemProxy.disable();
        systemProxyEnabled = false;
        systemProxyTargetPort = null;
      }
    } catch (e) {
      addLog('error', 'win-proxy', `切換系統代理失敗：${e.message}`);
      return { systemProxyEnabled, error: e.message };
    } finally {
      sendSystemProxyState();
      win.updateTrayMenu();
    }
    return { systemProxyEnabled };
  });
}

// 逐一掛在 module.exports 上、不重設它：模組之間互相 require（例如 engine ↔ killswitch），
// 重設的話先載入的那一方會拿到空物件。這種寫法 TypeScript（npm run typecheck）也推得出型別。
module.exports.systemProxyPort = systemProxyPort;
module.exports.syncSystemProxyFromOS = syncSystemProxyFromOS;
module.exports.reconcileSystemProxy = reconcileSystemProxy;
module.exports.sendSystemProxyState = sendSystemProxyState;
module.exports.restoreSystemProxy = restoreSystemProxy;
module.exports.isEnabled = isEnabled;
module.exports.toggleFromTray = toggleFromTray;
module.exports.registerIpc = registerIpc;
