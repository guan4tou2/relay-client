// 用 path.win32 而不是 path——path 的分隔符依「執行主機」決定，
// 在 macOS/Linux 上跑時 path.basename('C:\x\a.exe') 會回傳整串。
// adapter 的邏輯必須與執行主機無關，否則在別的 OS 上測 Windows adapter 就是假的。
const path = require('path').win32;
const { execSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

// Windows adapter —— 由 main.js / singbox.js / win-proxy.js 原樣搬過來，行為刻意不變。

const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const PROXY_BYPASS = 'localhost;127.*;10.*;192.168.*;<local>';

// ---- 引擎 ----
const engineBinName = 'sing-box.exe';
const tunInterfaceName = 'proxyclient-tun'; // Windows 可自訂 TUN 介面名
const selfProcessNames = ['sing-box.exe'];  // 一律 bypass，避免 relay→上游 被 TUN 抓回造成迴圈

function isElevated() {
  try { execSync('net session', { stdio: 'ignore', windowsHide: true }); return true; }
  catch (e) { return false; }
}

// Windows 的做法是「整個 app 以系統管理員重啟」（UAC），因為 TUN 與路由表都需要提權。
const engineElevation = {
  strategy: 'relaunch-app',
  // 純函式：組出觸發 UAC 的 powershell 指令，方便測試跳脫處理
  relaunchCommand(exePath, args = ['--engine-autostart']) {
    const quoted = String(exePath).replace(/'/g, "''");
    const argList = args.map(a => String(a).replace(/'/g, "''")).join(' ');
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
        `Start-Process -FilePath '${quoted}'${argList ? ` -ArgumentList '${argList}'` : ''} -Verb RunAs`],
    };
  },
  instructions: () => '建立 TUN 虛擬網卡與寫入路由表需要系統管理員權限，Windows 會顯示一次 UAC。',
};

// 清掉「上次崩潰殘留、還占著同名 TUN」的自家 sing-box。
// 不用 taskkill /IM（那會殃及其他 sing-box 系 app），只殺 ExecutablePath 相符的。
function staleEngineCleanupCommand(binPath) {
  const self = String(binPath).replace(/'/g, "''");
  const ps = `Get-CimInstance Win32_Process -Filter "Name='sing-box.exe'" | Where-Object { $_.ExecutablePath -eq '${self}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  return { cmd: 'powershell', args: ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps] };
}

// 先禮貌後強制：讓 sing-box 有機會自己移除 TUN 與路由，逾時再 /F，避免殘留把網路卡住。
async function killTree(pid, proc) {
  try { await execFileP('taskkill', ['/PID', String(pid), '/T'], { windowsHide: true, timeout: 3000 }); } catch (e) {}
  await new Promise(r => setTimeout(r, 1200));
  try { if (proc) proc.kill(); } catch (e) {}
  try { await execFileP('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }); } catch (e) {}
}

// ---- 行程列舉 ----
const exeFilters = [{ name: '程式', extensions: ['exe'] }];

function listProcessesCommand() {
  return {
    cmd: 'powershell',
    args: ['-NoProfile', '-Command', 'Get-Process | Where-Object {$_.Path} | Select-Object Name,Id,Path | ConvertTo-Json -Compress'],
  };
}

function parseProcessList(stdout) {
  let arr;
  try { arr = JSON.parse(String(stdout || '')); } catch (e) { return []; }
  if (!Array.isArray(arr)) arr = [arr];
  const seen = new Set(); const res = [];
  for (const p of arr) {
    if (!p || !p.Path || seen.has(p.Path.toLowerCase())) continue;
    seen.add(p.Path.toLowerCase());
    res.push({ pid: p.Id, name: p.Name, path: p.Path, exe: path.basename(p.Path) });
  }
  return res.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function listProcesses() {
  try {
    const c = listProcessesCommand();
    // maxBuffer 拉大：機器上幾百個行程的 JSON 很容易超過預設 1MB
    const out = execSync(`${c.cmd} ${c.args.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`,
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }).toString();
    return parseProcessList(out);
  } catch (e) { return []; }
}

// 由一個執行檔路徑生出規則要用的識別資料。Windows 的行程名不分大小寫、帶 .exe。
function normalizeApp(fullPath) {
  const base = path.basename(String(fullPath || ''));
  return { type: 'executable', name: base.toLowerCase(), label: base.replace(/\.exe$/i, ''), path: String(fullPath || '') };
}
// 規則比對時的正規化（Windows：忽略大小寫）
const appNameEquals = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

// ---- 系統代理（HKCU 登錄檔 + WinInet 立即生效）----
const systemProxy = {
  get() {
    try {
      const enableOut = execSync(`reg query "${REG_PATH}" /v ProxyEnable`, { encoding: 'utf8', windowsHide: true });
      const enabled = enableOut.includes('0x1');
      let server = '';
      try {
        const serverOut = execSync(`reg query "${REG_PATH}" /v ProxyServer`, { encoding: 'utf8', windowsHide: true });
        const match = serverOut.match(/ProxyServer\s+REG_SZ\s+(.+)/);
        if (match) server = match[1].trim();
      } catch (e) {}
      return { enabled, server };
    } catch (e) { return { enabled: false, server: '' }; }
  },

  enable(httpPort) {
    const server = `127.0.0.1:${httpPort}`;
    // 先寫 server / override，最後才 ProxyEnable=1；任一步失敗都不會停在「已啟用但指向壞位址」的狀態。
    execSync(`reg add "${REG_PATH}" /v ProxyServer /t REG_SZ /d "${server}" /f`, { windowsHide: true });
    execSync(`reg add "${REG_PATH}" /v ProxyOverride /t REG_SZ /d "${PROXY_BYPASS}" /f`, { windowsHide: true });
    execSync(`reg add "${REG_PATH}" /v ProxyEnable /t REG_DWORD /d 1 /f`, { windowsHide: true });
    refresh();
    return { enabled: true, server };
  },

  disable() {
    execSync(`reg add "${REG_PATH}" /v ProxyEnable /t REG_DWORD /d 0 /f`, { windowsHide: true });
    refresh();
    return { enabled: false, server: '' };
  },
};

function refresh() {
  try {
    execSync(
      'powershell -NoProfile -Command "[System.Runtime.InteropServices.RuntimeEnvironment]::FromGlobalAccessCache($null); $signature = @\\"\\npublic static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);\\n\\"@; $type = Add-Type -MemberDefinition $signature -Name WinInet -Namespace Pinvoke -PassThru; $type::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0); $type::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)"',
      { windowsHide: true, timeout: 5000 }
    );
  } catch (e) { /* Fallback: settings will take effect on next app start */ }
}

// ---- 開機自動啟動（Electron 登入項目）----
// 可攜版須指回外層 exe（PORTABLE_EXECUTABLE_FILE），否則會登記到 %TEMP% 的解壓路徑，重開機後失效。
const autostart = {
  usesElectronLoginItem: true,
  launchPath: () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
};

// ---- 瀏覽器（「用路由開瀏覽器」用）----
function browserCandidates() {
  const PF = process.env['ProgramFiles'] || 'C:\\Program Files';
  const PFx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const LAD = process.env['LOCALAPPDATA'] || '';
  return [
    { name: 'Chrome', path: path.join(PF, 'Google\\Chrome\\Application\\chrome.exe') },
    { name: 'Chrome', path: path.join(PFx86, 'Google\\Chrome\\Application\\chrome.exe') },
    LAD && { name: 'Chrome', path: path.join(LAD, 'Google\\Chrome\\Application\\chrome.exe') },
    { name: 'Edge', path: path.join(PFx86, 'Microsoft\\Edge\\Application\\msedge.exe') },
    { name: 'Edge', path: path.join(PF, 'Microsoft\\Edge\\Application\\msedge.exe') },
  ].filter(Boolean);
}

module.exports = {
  id: 'win32', label: 'Windows',
  engineBinName, tunInterfaceName, selfProcessNames, isElevated, engineElevation,
  staleEngineCleanupCommand, killTree,
  path,   // 讓共用模組跟這個 adapter 用同一種路徑語意（不看執行主機）
  exeFilters, listProcesses, listProcessesCommand, parseProcessList, normalizeApp, appNameEquals,
  systemProxy, autostart, browserCandidates,
};
