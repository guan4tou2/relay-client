const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Linux adapter。
//
// TUN 在 Linux 是三個平台裡最好處理的：不必整支 app 用 root 跑，
// 對 sing-box 執行檔下一次 `setcap cap_net_admin,cap_net_bind_service+ep` 就夠了。
// 因此 engineElevation.strategy = 'setcap'：檢查能力是否已授予，沒有就給使用者那一行指令。

const engineBinName = 'sing-box';
const tunInterfaceName = 'proxyclient-tun'; // Linux 可自訂介面名
const selfProcessNames = ['sing-box'];

const isElevated = () => typeof process.getuid === 'function' && process.getuid() === 0;

const CAPS = 'cap_net_admin,cap_net_bind_service+ep';

// 純函式：組出使用者要跑的那行指令（UI 直接顯示 / 可複製）
const setcapCommand = binPath => `sudo setcap ${CAPS} "${binPath}"`;

// `getcap <bin>` 輸出形如 "…/sing-box cap_net_admin,cap_net_bind_service=ep"
function parseGetcap(stdout) {
  const s = String(stdout || '');
  return /cap_net_admin/.test(s);
}

const engineElevation = {
  strategy: 'setcap',
  setcapCommand,
  parseGetcap,
  // 已經是 root，或 binary 已被授予 CAP_NET_ADMIN → 不需要再做任何事
  isSatisfied(binPath) {
    if (isElevated()) return true;
    try { return parseGetcap(execFileSync('getcap', [binPath]).toString()); }
    catch (e) { return false; }
  },
  instructions: binPath =>
    '建立 TUN 虛擬網卡需要 CAP_NET_ADMIN。執行下面這行授權一次即可（之後不需要 root）：\n'
    + setcapCommand(binPath || '<sing-box 路徑>'),
};

// Linux 同樣不需要清殘留（介面名被占用時 sing-box 會自己回報）
const staleEngineCleanupCommand = () => null;

async function killTree(pid, proc) {
  try { process.kill(pid, 'SIGTERM'); } catch (e) {}
  await new Promise(r => setTimeout(r, 1200));
  try { if (proc) proc.kill('SIGKILL'); } catch (e) {}
  try { process.kill(pid, 'SIGKILL'); } catch (e) {}
}

// ---- 行程列舉 ----
// 直接讀 /proc，不開子行程：比 ps 快，而且 ps 的 comm 欄位在 Linux 會被截成 15 字元。
const exeFilters = [{ name: '所有檔案', extensions: ['*'] }];

const listProcessesCommand = () => null; // 不用外部指令

function listProcesses(procRoot = '/proc') {
  const seen = new Set(); const res = [];
  let entries = [];
  try { entries = fs.readdirSync(procRoot); } catch (e) { return []; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    let full;
    // 別人的行程讀 exe 會 EACCES（沒有 root 時很正常）→ 略過就好
    try { full = fs.readlinkSync(path.join(procRoot, e, 'exe')); } catch (err) { continue; }
    if (!full || seen.has(full)) continue;
    seen.add(full);
    res.push({ pid: Number(e), name: path.basename(full), path: full, exe: path.basename(full) });
  }
  return res.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function normalizeApp(fullPath) {
  const base = path.basename(String(fullPath || ''));
  return { type: 'executable', name: base, label: base, path: String(fullPath || '') };
}
// Linux 檔名大小寫敏感 → 規則比對也必須敏感，否則會誤命中
const appNameEquals = (a, b) => String(a || '') === String(b || '');

// ---- 系統代理 ----
// 只涵蓋 GNOME（gsettings）。KDE 與其他桌面環境各有各的設定位置，
// 而且大量 CLI 工具只吃 http_proxy 環境變數——所以這裡回報時會誠實說明涵蓋範圍。
const BYPASS = "['localhost', '127.0.0.0/8', '10.0.0.0/8', '192.168.0.0/16', '::1']";
const SCHEMA = 'org.gnome.system.proxy';

const gsettings = (...args) => execFileSync('gsettings', args, { timeout: 5000 }).toString().trim();

// gsettings get 的字串值帶單引號："'manual'" → "manual"
const unquote = s => String(s || '').trim().replace(/^'(.*)'$/, '$1');

function parseProxyState(mode, host, port) {
  const enabled = unquote(mode) === 'manual';
  const h = unquote(host);
  return { enabled, server: enabled && h ? `${h}:${String(port || '').trim()}` : '' };
}

const systemProxy = {
  available() { try { gsettings('get', SCHEMA, 'mode'); return true; } catch (e) { return false; } },

  get() {
    try { return parseProxyState(gsettings('get', SCHEMA, 'mode'), gsettings('get', SCHEMA + '.http', 'host'), gsettings('get', SCHEMA + '.http', 'port')); }
    catch (e) { return { enabled: false, server: '' }; }
  },

  enable(httpPort) {
    const port = String(httpPort);
    gsettings('set', SCHEMA + '.http', 'host', '127.0.0.1');
    gsettings('set', SCHEMA + '.http', 'port', port);
    gsettings('set', SCHEMA + '.https', 'host', '127.0.0.1');
    gsettings('set', SCHEMA + '.https', 'port', port);
    gsettings('set', SCHEMA, 'ignore-hosts', BYPASS);
    gsettings('set', SCHEMA, 'mode', 'manual'); // 最後才切換，避免中途指向壞位址
    return { enabled: true, server: `127.0.0.1:${port}`, note: '只影響遵循 GNOME 代理設定的程式；終端機工具請另外設定 http_proxy。' };
  },

  disable() {
    gsettings('set', SCHEMA, 'mode', 'none');
    return { enabled: false, server: '' };
  },
};

// ---- 開機自動啟動 ----
// Electron 的 setLoginItemSettings 在 Linux 不支援 → 自己寫 XDG autostart .desktop 檔。
const AUTOSTART_FILE = 'relayclient.desktop';
const autostartDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart');

function desktopEntry(execPath) {
  return [
    '[Desktop Entry]', 'Type=Application', 'Name=RelayClient',
    `Exec="${execPath}"`, 'Terminal=false', 'X-GNOME-Autostart-enabled=true', '',
  ].join('\n');
}

const autostart = {
  usesElectronLoginItem: false, // Electron 在 Linux 沒有實作，改用 XDG autostart
  launchPath: () => process.env.APPIMAGE || process.execPath,
  desktopEntry,
  get() { try { return fs.existsSync(path.join(autostartDir(), AUTOSTART_FILE)); } catch (e) { return false; } },
  set(enable) {
    const file = path.join(autostartDir(), AUTOSTART_FILE);
    try {
      if (enable) { fs.mkdirSync(autostartDir(), { recursive: true }); fs.writeFileSync(file, desktopEntry(autostart.launchPath())); }
      else if (fs.existsSync(file)) fs.unlinkSync(file);
      return { ok: true, enabled: !!enable };
    } catch (e) { return { ok: false, error: e.message }; }
  },
};

function browserCandidates() {
  return [
    { name: 'Chrome', path: '/usr/bin/google-chrome' },
    { name: 'Chrome', path: '/usr/bin/google-chrome-stable' },
    { name: 'Chromium', path: '/usr/bin/chromium' },
    { name: 'Chromium', path: '/usr/bin/chromium-browser' },
    { name: 'Edge', path: '/usr/bin/microsoft-edge' },
  ];
}

module.exports = {
  id: 'linux', label: 'Linux',
  engineBinName, tunInterfaceName, selfProcessNames, isElevated, engineElevation,
  staleEngineCleanupCommand, killTree,
  exeFilters, listProcesses, listProcessesCommand, normalizeApp, appNameEquals,
  systemProxy, autostart, browserCandidates,
  _internal: { parseProxyState, unquote, parseGetcap, setcapCommand, desktopEntry },
};
