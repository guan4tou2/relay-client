const { execSync } = require('child_process');

const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function getProxyState() {
  try {
    const enableOut = execSync(
      `reg query "${REG_PATH}" /v ProxyEnable`,
      { encoding: 'utf8', windowsHide: true }
    );
    const enabled = enableOut.includes('0x1');

    let server = '';
    try {
      const serverOut = execSync(
        `reg query "${REG_PATH}" /v ProxyServer`,
        { encoding: 'utf8', windowsHide: true }
      );
      const match = serverOut.match(/ProxyServer\s+REG_SZ\s+(.+)/);
      if (match) server = match[1].trim();
    } catch {}

    return { enabled, server };
  } catch {
    return { enabled: false, server: '' };
  }
}

function enableProxy(httpPort) {
  const server = `127.0.0.1:${httpPort}`;
  execSync(
    `reg add "${REG_PATH}" /v ProxyEnable /t REG_DWORD /d 1 /f`,
    { windowsHide: true }
  );
  execSync(
    `reg add "${REG_PATH}" /v ProxyServer /t REG_SZ /d "${server}" /f`,
    { windowsHide: true }
  );
  execSync(
    `reg add "${REG_PATH}" /v ProxyOverride /t REG_SZ /d "localhost;127.*;10.*;192.168.*;<local>" /f`,
    { windowsHide: true }
  );
  _refreshProxy();
  return { enabled: true, server };
}

function disableProxy() {
  execSync(
    `reg add "${REG_PATH}" /v ProxyEnable /t REG_DWORD /d 0 /f`,
    { windowsHide: true }
  );
  _refreshProxy();
  return { enabled: false, server: '' };
}

function _refreshProxy() {
  try {
    execSync(
      'powershell -NoProfile -Command "[System.Runtime.InteropServices.RuntimeEnvironment]::FromGlobalAccessCache($null); $signature = @\\"\\npublic static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);\\n\\"@; $type = Add-Type -MemberDefinition $signature -Name WinInet -Namespace Pinvoke -PassThru; $type::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0); $type::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)"',
      { windowsHide: true, timeout: 5000 }
    );
  } catch {
    // Fallback: settings will take effect on next app start
  }
}

module.exports = { getProxyState, enableProxy, disableProxy };
