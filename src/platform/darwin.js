const path = require('path').posix;   // 同理：與執行主機無關，固定用 POSIX 語意
const { execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

// macOS adapter。
//
// 已可用：本地端口路由 / 串接（與 OS 無關）、系統代理、行程列舉、開機自啟。
// 尚未可用：TUN 分流——macOS 的 utun 一定要 root，而且不能用 LaunchAgent（使用者權限）跑。
//   正解是安裝一支經 Developer ID 簽章的 LaunchDaemon 特權助手，那需要簽章與 notarization。
//   在那之前 engineElevation.strategy = 'unsupported'，UI 應顯示 instructions() 而不是假裝能用。

const engineBinName = 'sing-box';
// macOS 的 utun 裝置由核心命名（utun0、utun1…），不能自訂 → 交給 sing-box 自動指派。
const tunInterfaceName = null;
const selfProcessNames = ['sing-box'];

const isElevated = () => typeof process.getuid === 'function' && process.getuid() === 0;

const engineElevation = {
  strategy: 'unsupported',
  // 保留組指令的能力：真的要「每次啟動彈密碼」時可以用，但不做為預設（root 跑 GUI app 是壞習慣）
  adminShellCommand(shellLine) {
    const escaped = String(shellLine).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return { cmd: 'osascript', args: ['-e', `do shell script "${escaped}" with administrator privileges`] };
  },
  instructions: () =>
    'macOS 的 TUN 虛擬網卡必須以 root 執行，且不能透過使用者層的 LaunchAgent 啟動。'
    + '本版尚未內建特權助手（需要 Developer ID 簽章與 notarization），因此「指定程式走代理」在 macOS 暫不可用；'
    + '本地端口路由與多層串接不受影響，照常可用。',
};

// macOS 沒有殘留占用同名 TUN 的問題（介面由核心配置），不需要事前清理
const staleEngineCleanupCommand = () => null;

async function killTree(pid, proc) {
  try { process.kill(pid, 'SIGTERM'); } catch (e) {}
  await new Promise(r => setTimeout(r, 1200));
  try { if (proc) proc.kill('SIGKILL'); } catch (e) {}
  try { process.kill(pid, 'SIGKILL'); } catch (e) {}
}

// ---- 行程列舉 ----
// macOS 的 ps comm 欄位會給完整執行檔路徑（Linux 只給截斷的短名，所以兩邊做法不同）。
const exeFilters = [{ name: '應用程式', extensions: ['app'] }, { name: '所有檔案', extensions: ['*'] }];

const listProcessesCommand = () => ({ cmd: 'ps', args: ['-axo', 'pid=,comm='] });

function parseProcessList(stdout) {
  const seen = new Set(); const res = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!m) continue;
    const pid = Number(m[1]); const full = m[2];
    if (!full.startsWith('/') || seen.has(full)) continue; // 略過 kernel_task 等沒有路徑的
    seen.add(full);
    res.push({ pid, name: appLabel(full), path: full, exe: path.basename(full) });
  }
  return res.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function listProcesses() {
  try {
    const c = listProcessesCommand();
    return parseProcessList(execFileSync(c.cmd, c.args, { maxBuffer: 32 * 1024 * 1024 }).toString());
  } catch (e) { return []; }
}

// /Applications/Google Chrome.app/Contents/MacOS/Google Chrome → "Google Chrome"
// 有 .app bundle 時用 bundle 名，比執行檔名更接近使用者認知的「程式名稱」。
function appLabel(fullPath) {
  const m = String(fullPath).match(/\/([^/]+)\.app\/Contents\/MacOS\//);
  return m ? m[1] : path.basename(String(fullPath));
}

function normalizeApp(fullPath) {
  const p = String(fullPath || '');
  return { type: 'executable', name: path.basename(p), label: appLabel(p), path: p };
}
// macOS 檔名大小寫不敏感（預設 APFS 設定），比對時比照 Windows 忽略大小寫
const appNameEquals = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

// ---- 系統代理（networksetup，逐一設定每個網路服務）----
const BYPASS = ['localhost', '127.0.0.1', '10.*', '192.168.*', '*.local'];

// `networksetup -listallnetworkservices` 第一行是說明文字，前綴 * 代表該服務被停用
function parseNetworkServices(stdout) {
  return String(stdout || '').split('\n').slice(1)
    .map(s => s.trim()).filter(s => s && !s.startsWith('*'));
}

function networkServices() {
  try { return parseNetworkServices(execFileSync('networksetup', ['-listallnetworkservices']).toString()); }
  catch (e) { return []; }
}

// `networksetup -getwebproxy "Wi-Fi"` → "Enabled: Yes\nServer: 127.0.0.1\nPort: 10808\n..."
function parseWebProxy(stdout) {
  const s = String(stdout || '');
  const enabled = /Enabled:\s*Yes/i.test(s);
  const server = (s.match(/Server:\s*(.*)/) || [, ''])[1].trim();
  const port = (s.match(/Port:\s*(\d+)/) || [, ''])[1];
  return { enabled, server: enabled && server ? `${server}:${port}` : '' };
}

const systemProxy = {
  get() {
    const svc = networkServices()[0];
    if (!svc) return { enabled: false, server: '' };
    try { return parseWebProxy(execFileSync('networksetup', ['-getwebproxy', svc]).toString()); }
    catch (e) { return { enabled: false, server: '' }; }
  },

  enable(httpPort) {
    const port = String(httpPort);
    for (const svc of networkServices()) {
      try {
        execFileSync('networksetup', ['-setwebproxy', svc, '127.0.0.1', port]);
        execFileSync('networksetup', ['-setsecurewebproxy', svc, '127.0.0.1', port]);
        execFileSync('networksetup', ['-setproxybypassdomains', svc, ...BYPASS]);
      } catch (e) { /* 某個服務設不起來（例如被 MDM 鎖住）不該讓整批失敗 */ }
    }
    return { enabled: true, server: `127.0.0.1:${port}` };
  },

  disable() {
    for (const svc of networkServices()) {
      try {
        execFileSync('networksetup', ['-setwebproxystate', svc, 'off']);
        execFileSync('networksetup', ['-setsecurewebproxystate', svc, 'off']);
      } catch (e) {}
    }
    return { enabled: false, server: '' };
  },
};

// ---- 開機自動啟動 ----
// Electron 在 macOS 用 LaunchAgent 實作 setLoginItemSettings，可直接用。
const autostart = {
  usesElectronLoginItem: true,
  launchPath: () => process.execPath,
};

function browserCandidates() {
  return [
    { name: 'Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { name: 'Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    { name: 'Brave', path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
  ];
}

module.exports = {
  id: 'darwin', label: 'macOS',
  engineBinName, tunInterfaceName, selfProcessNames, isElevated, engineElevation,
  staleEngineCleanupCommand, killTree,
  exeFilters, listProcesses, listProcessesCommand, parseProcessList, normalizeApp, appNameEquals,
  systemProxy, autostart, browserCandidates,
  // 匯出給測試用的純函式
  _internal: { parseNetworkServices, parseWebProxy, appLabel },
};
