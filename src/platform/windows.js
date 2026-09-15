// 用 path.win32 而不是 path——path 的分隔符依「執行主機」決定，
// 在 macOS/Linux 上跑時 path.basename('C:\x\a.exe') 會回傳整串。
// adapter 的邏輯必須與執行主機無關，否則在別的 OS 上測 Windows adapter 就是假的。
const path = require('path').win32;
const { execSync, execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

// Windows adapter —— 由 main.js / singbox.js / win-proxy.js 原樣搬過來，行為刻意不變。

const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const PROXY_BYPASS = 'localhost;127.*;10.*;192.168.*;<local>';

// ---- 引擎 ----
const engineBinName = 'sing-box.exe';
const tunInterfaceName = 'proxyclient-tun'; // Windows 可自訂 TUN 介面名
const selfProcessNames = ['sing-box.exe'];  // 一律 bypass，避免 relay→上游 被 TUN 抓回造成迴圈

// 還「真的活著」的自家主行程數（含呼叫者自己）。
//
// 用來分辨「已經有一個 app 在跑」與「被強制結束的殭屍還握著單一實例鎖」。
// 強制結束掉的 Electron 會留下 threads=0 的行程物件，Get-Process 與
// Win32_Process 都照樣列得出來，而且它還握著鎖 —— 使用者點圖示不會有任何反應。
// 執行緒數是唯一可靠的活性指標；--type= 的是 renderer/gpu 等子行程，不算。
function liveMainInstances() {
  try {
    const exe = path.basename(process.execPath).replace(/'/g, "''");
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "@(Get-CimInstance Win32_Process -Filter \"Name='" + exe + "'\" | " +
      "Where-Object { $_.CommandLine -notmatch '--type=' -and (Get-Process -Id $_.ProcessId -EA 0).Threads.Count -gt 0 }).Count"],
      { encoding: 'ascii', windowsHide: true, timeout: 8000 });
    const n = parseInt(String(out).trim(), 10);
    return Number.isFinite(n) ? n : 1;   // 判不出來就回 1（＝別出聲），寧可少講也不要誤報
  } catch (e) { return 1; }
}

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
// TUN 拉起來「之前」的系統 DNS。拿來當 sing-box 的上游。
//
// 為什麼不能用 sing-box 的 type:'local'：auto_route 會把 TUN 自己設成系統 DNS，
// local 會去讀系統清單、讀到 TUN 自己 → 查詢繞回 sing-box → 沒人回答 → 逾時。
// 症狀是引擎一開，整台機器就解析不到任何沒快取過的網域。
//
// 也不能寫死 8.8.8.8：公司內部名稱要靠公司 DNS，而且把內部查詢送去公開解析器
// 本身就是洩漏。所以抓「現在實際在用的」，並排掉我們自己的 TUN。
function systemDnsServers() {
  try {
    // 一行一個位址，避免在命令列裡跟 -join 的引號纏鬥
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      'Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object { $_.ServerAddresses } | ' +
      'Select-Object -ExpandProperty ServerAddresses'],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    return dedupeDns(String(out).split(/\r?\n/));
  } catch (e) { return []; }
}

// 共用的清洗：去空白、去重、排掉 TUN 自己那段（172.19.0.x）與 loopback
function dedupeDns(list) {
  const seen = new Set();
  return (list || [])
    .map(x => String(x || '').trim())
    .filter(x => /^\d{1,3}(\.\d{1,3}){3}$/.test(x))
    .filter(x => !x.startsWith('172.19.0.') && !x.startsWith('127.'))
    .filter(x => (seen.has(x) ? false : (seen.add(x), true)));
}

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

// 通知 WinInet 立即套用新的代理設定。不做的話登錄檔雖然寫了，
// 已經開著的程式（瀏覽器等）要等重啟才會讀到。
//
// 舊版有兩個毛病，導致它一直失敗：
//   1. 把整段 PowerShell 拼成字串丟給 shell，@" here-string 後面變成字面的反斜線 n，
//      PowerShell 直接報 parser error。改用 execFileSync + 陣列參數，換行就是真換行。
//   2. MemberDefinition 沒帶 [DllImport]，Add-Type 也不會成功。
// 失敗不拋錯：登錄檔已經寫了，只是生效時機往後延。
function refresh() {
  const script = [
    '$sig = @"',
    '[DllImport("wininet.dll", SetLastError = true)]',
    'public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);',
    '"@',
    '$t = Add-Type -MemberDefinition $sig -Name WinInet -Namespace Pinvoke -PassThru',
    '$t::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null',
    '$t::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null',
  ].join('\n');
  try { execFileSync('powershell', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 10000 }); return true; }
  catch (e) { return false; }
}

// ---- 開機自動啟動（Electron 登入項目）----
// 可攜版須指回外層 exe（PORTABLE_EXECUTABLE_FILE），否則會登記到 %TEMP% 的解壓路徑，重開機後失效。

// 改名之前（productName 還叫「代理客戶端」）建立的登入項目。
//
// Electron 的 setLoginItemSettings 是拿「當下的 productName」當登錄檔值的名字，
// 所以一改名，舊名字那一筆就變成沒人管得到的孤兒：設定頁讀不到它（顯示「關」），
// 關閉開關也刪不掉它，但 OS 每次登入照樣去啟動那個路徑。
// 實際在這台機器上就有一筆，指著一個已經被刪掉的 Portable-1.1.1.exe。
//
// 這是我們自己留下來的東西，所以由我們自己收 —— 只收這幾個確定是本 app 的名字。
const LEGACY_LOGIN_ITEM_NAMES = ['electron.app.代理客戶端', '代理客戶端'];

// 中文名字兩個方向都不走命令列的明碼，也不走 stdout 的明碼。
//
// 這裡踩過兩次，兩次症狀相反，值得寫清楚：
//   1. reg.exe 讀「參數」是照行程的 ANSI 代碼頁。從 Git Bash 呼叫時
//      reg query /v 代理客戶端 會回「找不到」—— 明明那一筆就在。
//   2. 改成 reg query 整把撈、在 JS 裡比名字之後，換成打包的 app 找不到：
//      reg.exe 的「輸出」編碼跟主控台代碼頁綁在一起，Git Bash 是 UTF-8，
//      但 Electron 底下沒有主控台，出來的是系統 ANSI，用 utf8 解就成亂碼。
//
// 所以：整件事交給 PowerShell，指令用 -EncodedCommand（base64 的 UTF-16）送進去，
// 結果用 base64 的 UTF-8 JSON 送出來。命令列與 stdout 上都只有 ASCII，
// 跟代碼頁完全無關。
const PS_RUN = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const psLit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const encodeCmd = (script) => Buffer.from(script, 'utf16le').toString('base64');

function runPs(script) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCmd(script)],
    { encoding: 'ascii', windowsHide: true, timeout: 10000 });
}

// 回 base64(UTF-8 JSON)，不是明碼
function psEmitJson(expr) {
  return `$ProgressPreference = 'SilentlyContinue'
$j = ConvertTo-Json -InputObject ${expr} -Compress
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$j))`;
}

function legacyLoginItems() {
  const names = LEGACY_LOGIN_ITEM_NAMES.map(psLit).join(',');
  const script = `$ErrorActionPreference = 'SilentlyContinue'
$p = Get-ItemProperty -Path ${psLit(PS_RUN)}
$out = @()
foreach ($n in @(${names})) {
  if ($p -and ($p.PSObject.Properties.Name -contains $n)) {
    $out += [pscustomobject]@{ name = $n; data = [string]$p.$n }
  }
}
${psEmitJson('@($out)')}`;
  try {
    const b64 = String(runPs(script)).trim();
    if (!b64) return [];
    const arr = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return Array.isArray(arr) ? arr : [arr];
  } catch (e) { return []; }
}

// names 省略時清掉全部；給了就只清那幾筆（啟動時只收「指向已刪除檔案」的那種）。
function clearLegacyLoginItems(names) {
  const want = Array.isArray(names) ? new Set(names) : null;
  const targets = legacyLoginItems().filter(it => !want || want.has(it.name)).map(it => it.name);
  if (!targets.length) return 0;
  const script = targets
    .map(n => `Remove-ItemProperty -Path ${psLit(PS_RUN)} -Name ${psLit(n)} -Force -ErrorAction SilentlyContinue`)
    .join('\n');
  try { runPs(script); } catch (e) { return 0; } // 刪不掉就算了，不值得為它中斷啟動
  // 不信回傳值：-ErrorAction SilentlyContinue 會把失敗吞掉，離開碼照樣是 0。重讀確認。
  const left = new Set(legacyLoginItems().map(it => it.name));
  return targets.filter(n => !left.has(n)).length;
}

// Run 的值可能是 "C:\有空白的路徑\app.exe" --arg，也可能沒引號：C:\path\app.exe --arg。
// 取到 .exe 為止。解析不出來就回空字串 —— 呼叫端據此當「判斷不出，別動它」。
function runEntryTarget(data) {
  const m = String(data || '').trim().replace(/^"/, '').match(/^(.*?\.exe)/i);
  return m ? m[1] : '';
}

const autostart = {
  usesElectronLoginItem: true,
  launchPath: () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
  legacyNames: LEGACY_LOGIN_ITEM_NAMES,
  listLegacy: legacyLoginItems,
  clearLegacy: clearLegacyLoginItems,
  entryTarget: runEntryTarget,
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
  systemProxy, autostart, browserCandidates, systemDnsServers, liveMainInstances,
};
