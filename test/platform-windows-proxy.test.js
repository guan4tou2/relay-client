// Windows adapter 的系統代理（HKCU 登錄檔）。execFile 一併 mock：
// adapter 在載入時就會 promisify(execFile)，只 mock execSync 會在 require 階段就炸。
jest.mock('child_process', () => ({
  execSync: jest.fn(),
  execFile: jest.fn(),
  execFileSync: jest.fn(),
}));

const { execSync, execFileSync } = require('child_process');
const winProxy = require('../src/platform/windows').systemProxy;

beforeEach(() => {
  execSync.mockReset();
  execFileSync.mockReset();
});

describe('platform/windows systemProxy — getProxyState', () => {
  test('returns enabled=true when registry has 0x1', () => {
    execSync
      .mockReturnValueOnce('    ProxyEnable    REG_DWORD    0x1\r\n')
      .mockReturnValueOnce('    ProxyServer    REG_SZ    127.0.0.1:10808\r\n');

    const state = winProxy.get();
    expect(state.enabled).toBe(true);
    expect(state.server).toBe('127.0.0.1:10808');
  });

  test('returns enabled=false when registry has 0x0', () => {
    execSync
      .mockReturnValueOnce('    ProxyEnable    REG_DWORD    0x0\r\n')
      .mockReturnValueOnce('    ProxyServer    REG_SZ    \r\n');

    const state = winProxy.get();
    expect(state.enabled).toBe(false);
  });

  test('returns default when ProxyEnable query throws', () => {
    execSync.mockImplementation(() => { throw new Error('not found'); });
    const state = winProxy.get();
    expect(state.enabled).toBe(false);
    expect(state.server).toBe('');
  });

  test('handles missing ProxyServer gracefully', () => {
    execSync
      .mockReturnValueOnce('    ProxyEnable    REG_DWORD    0x1\r\n')
      .mockImplementationOnce(() => { throw new Error('not found'); });

    const state = winProxy.get();
    expect(state.enabled).toBe(true);
    expect(state.server).toBe('');
  });
});

describe('platform/windows systemProxy — enableProxy', () => {
  test('sets ProxyEnable, ProxyServer, ProxyOverride and refreshes', () => {
    execSync.mockReturnValue('');
    const result = winProxy.enable(10808);

    expect(result.enabled).toBe(true);
    expect(result.server).toBe('127.0.0.1:10808');

    // 先寫 server/override，最後才 Enable=1（避免停在「已啟用但指向壞位址」）。
    // refresh 已改走 execFileSync，所以 execSync 只剩三個 reg add。
    expect(execSync).toHaveBeenCalledTimes(3);
    expect(execFileSync).toHaveBeenCalledTimes(1);

    const calls = execSync.mock.calls.map(c => c[0]);
    expect(calls[0]).toMatch(/ProxyServer.*127\.0\.0\.1:10808/);
    expect(calls[1]).toMatch(/ProxyOverride/);
    expect(calls[2]).toMatch(/ProxyEnable.*\/d 1/);
  });

  test('uses the port number provided', () => {
    execSync.mockReturnValue('');
    winProxy.enable(9999);

    const serverCall = execSync.mock.calls[0][0];
    expect(serverCall).toContain('127.0.0.1:9999');
  });

  test('includes common bypass addresses', () => {
    execSync.mockReturnValue('');
    winProxy.enable(10808);

    const overrideCall = execSync.mock.calls[1][0];
    expect(overrideCall).toContain('localhost');
    expect(overrideCall).toContain('127.*');
    expect(overrideCall).toContain('<local>');
  });
});

describe('platform/windows systemProxy — disableProxy', () => {
  test('sets ProxyEnable=0 and refreshes', () => {
    execSync.mockReturnValue('');
    const result = winProxy.disable();

    expect(result.enabled).toBe(false);
    expect(result.server).toBe('');

    // ProxyEnable=0 + refresh
    expect(execSync).toHaveBeenCalledTimes(1);      // 只剩 ProxyEnable=0
    expect(execFileSync).toHaveBeenCalledTimes(1);  // refresh
    expect(execSync.mock.calls[0][0]).toMatch(/ProxyEnable.*\/d 0/);
  });
});

describe('platform/windows systemProxy — refresh fallback', () => {
  // refresh 現在走 execFileSync，所以要從那裡丟例外才測得到。
  // 舊版是 mock execSync 的第 4 次呼叫 —— 改完之後 execSync 只剩 3 次，
  // 那個例外永遠不會發生，測試變成空轉還照樣綠燈。
  test('enableProxy succeeds even if refresh throws', () => {
    execSync.mockReturnValue('');
    execFileSync.mockImplementation(() => { throw new Error('powershell failed'); });

    const result = winProxy.enable(10808);
    expect(result.enabled).toBe(true);
    expect(execFileSync).toHaveBeenCalled();
  });

  test('disableProxy succeeds even if refresh throws', () => {
    execSync.mockReturnValue('');
    execFileSync.mockImplementation(() => { throw new Error('powershell failed'); });

    const result = winProxy.disable();
    expect(result.enabled).toBe(false);
    expect(execFileSync).toHaveBeenCalled();
  });
});

describe('platform/windows systemProxy — registry calls use windowsHide', () => {
  test('all execSync calls use windowsHide: true', () => {
    execSync.mockReturnValue('');
    winProxy.enable(10808);

    for (const call of execSync.mock.calls) {
      const opts = call[1] || {};
      expect(opts.windowsHide).toBe(true);
    }
  });
});

// refresh()：通知 WinInet 立即套用。舊版把整段 PowerShell 拼成字串丟給 shell，
// @" here-string 的換行變成字面的反斜線 n，PowerShell 每次都 parser error ——
// 結果是登錄檔寫了但不生效，要等瀏覽器重啟。這幾條守住修正後的結構。
describe('refresh()：WinInet 通知', () => {
  const psCall = () => execFileSync.mock.calls.find(c => c[0] === 'powershell');

  test('走 execFileSync + 陣列參數，不是拼字串丟 shell', () => {
    winProxy.disable();
    const call = psCall();
    expect(call).toBeTruthy();
    expect(Array.isArray(call[1])).toBe(true);
    // 舊版是 execSync('powershell -NoProfile -Command "..."')，整段在一個字串裡
    expect(execSync.mock.calls.some(c => /powershell/.test(String(c[0])))).toBe(false);
  });

  test('here-string 裡是真換行，不是字面的反斜線 n', () => {
    winProxy.disable();
    const script = psCall()[1].join(' ');
    expect(script).toContain('@"');
    const body = psCall()[1][psCall()[1].length - 1];
    // 舊版的病根：here-string 後面是字面的反斜線 n，而不是真的換行
    expect(body).not.toContain(String.fromCharCode(92) + 'n');
    expect(body.split(String.fromCharCode(10)).length).toBeGreaterThan(3);
  });

  test('MemberDefinition 要帶 [DllImport]，否則 Add-Type 不會成功', () => {
    winProxy.disable();
    const body = psCall()[1][psCall()[1].length - 1];
    expect(body).toContain('[DllImport("wininet.dll"');
    expect(body).toContain('InternetSetOption');
  });

  test('refresh 失敗不能影響登錄檔已寫入的事實', () => {
    execFileSync.mockImplementation(() => { throw new Error('boom'); });
    expect(() => winProxy.enable(1080)).not.toThrow();
    // 三個 reg add 都要有送出去
    expect(execSync.mock.calls.filter(c => /reg add/.test(String(c[0])))).toHaveLength(3);
  });
});
