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

// reg 一律走 execFileSync('reg', [...])；refresh 走 execFileSync('powershell', [...])。
const regCalls = () => execFileSync.mock.calls.filter(c => c[0] === 'reg').map(c => c[1]);
const psCalls = () => execFileSync.mock.calls.filter(c => c[0] === 'powershell');

describe('platform/windows systemProxy — getProxyState', () => {
  test('returns enabled=true when registry has 0x1', () => {
    execFileSync
      .mockReturnValueOnce('    ProxyEnable    REG_DWORD    0x1\r\n')
      .mockReturnValueOnce('    ProxyServer    REG_SZ    127.0.0.1:10808\r\n');

    const state = winProxy.get();
    expect(state.enabled).toBe(true);
    expect(state.server).toBe('127.0.0.1:10808');
  });

  test('returns enabled=false when registry has 0x0', () => {
    execFileSync
      .mockReturnValueOnce('    ProxyEnable    REG_DWORD    0x0\r\n')
      .mockReturnValueOnce('    ProxyServer    REG_SZ    \r\n');

    const state = winProxy.get();
    expect(state.enabled).toBe(false);
  });

  test('returns default when ProxyEnable query throws', () => {
    execFileSync.mockImplementation(() => { throw new Error('not found'); });
    const state = winProxy.get();
    expect(state.enabled).toBe(false);
    expect(state.server).toBe('');
  });

  test('handles missing ProxyServer gracefully', () => {
    execFileSync
      .mockReturnValueOnce('    ProxyEnable    REG_DWORD    0x1\r\n')
      .mockImplementationOnce(() => { throw new Error('not found'); });

    const state = winProxy.get();
    expect(state.enabled).toBe(true);
    expect(state.server).toBe('');
  });
});

describe('platform/windows systemProxy — enableProxy', () => {
  test('sets ProxyServer, ProxyOverride, then ProxyEnable and refreshes', () => {
    execFileSync.mockReturnValue('');
    const result = winProxy.enable(10808);

    expect(result.enabled).toBe(true);
    expect(result.server).toBe('127.0.0.1:10808');

    // 先寫 server/override，最後才 Enable=1（避免停在「已啟用但指向壞位址」）
    const calls = regCalls();
    expect(calls).toHaveLength(3);
    expect(psCalls()).toHaveLength(1);
    expect(calls[0]).toEqual(expect.arrayContaining(['add', 'ProxyServer', '127.0.0.1:10808']));
    expect(calls[1]).toEqual(expect.arrayContaining(['add', 'ProxyOverride']));
    expect(calls[2]).toEqual(expect.arrayContaining(['add', 'ProxyEnable', 'REG_DWORD', '1']));
  });

  test('uses the port number provided', () => {
    execFileSync.mockReturnValue('');
    winProxy.enable(9999);
    expect(regCalls()[0]).toContain('127.0.0.1:9999');
  });

  test('includes common bypass addresses', () => {
    execFileSync.mockReturnValue('');
    winProxy.enable(10808);
    const override = regCalls()[1].join(' ');
    expect(override).toContain('localhost');
    expect(override).toContain('127.*');
    expect(override).toContain('<local>');
  });

  // 埠號最終來自 renderer；以前是拼進 execSync 的字串，`1" & calc & "` 就能執行任意指令
  test('不合法的埠直接丟例外，而且一個 reg 都不送', () => {
    execFileSync.mockReturnValue('');
    for (const bad of ['1" & calc & "', 0, 70000, 1.5, null]) {
      expect(() => winProxy.enable(bad)).toThrow();
    }
    expect(regCalls()).toHaveLength(0);
  });

  test('不經 shell：execSync 完全沒被用到', () => {
    execFileSync.mockReturnValue('');
    winProxy.enable(10808);
    winProxy.disable();
    winProxy.get();
    expect(execSync).not.toHaveBeenCalled();
  });
});

describe('platform/windows systemProxy — disableProxy', () => {
  test('sets ProxyEnable=0 and refreshes', () => {
    execFileSync.mockReturnValue('');
    const result = winProxy.disable();

    expect(result.enabled).toBe(false);
    expect(result.server).toBe('');
    expect(regCalls()).toHaveLength(1);
    expect(regCalls()[0]).toEqual(expect.arrayContaining(['ProxyEnable', '0']));
    expect(psCalls()).toHaveLength(1);
  });
});

describe('platform/windows systemProxy — refresh fallback', () => {
  const failPowershell = () => execFileSync.mockImplementation((cmd) => {
    if (cmd === 'powershell') throw new Error('powershell failed');
    return '';
  });

  test('enableProxy succeeds even if refresh throws', () => {
    failPowershell();
    const result = winProxy.enable(10808);
    expect(result.enabled).toBe(true);
    expect(psCalls().length).toBeGreaterThan(0);
  });

  test('disableProxy succeeds even if refresh throws', () => {
    failPowershell();
    const result = winProxy.disable();
    expect(result.enabled).toBe(false);
    expect(psCalls().length).toBeGreaterThan(0);
  });
});

describe('platform/windows systemProxy — registry calls use windowsHide', () => {
  test('all reg calls use windowsHide: true', () => {
    execFileSync.mockReturnValue('');
    winProxy.enable(10808);
    for (const call of execFileSync.mock.calls.filter(c => c[0] === 'reg')) {
      expect((call[2] || {}).windowsHide).toBe(true);
    }
  });
});

// refresh()：通知 WinInet 立即套用。舊版把整段 PowerShell 拼成字串丟給 shell，
// @" here-string 的換行變成字面的反斜線 n，PowerShell 每次都 parser error ——
// 結果是登錄檔寫了但不生效，要等瀏覽器重啟。這幾條守住修正後的結構。
describe('refresh()：WinInet 通知', () => {
  const psCall = () => psCalls()[0];

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
    execFileSync.mockImplementation((cmd) => { if (cmd === 'powershell') throw new Error('boom'); return ''; });
    expect(() => winProxy.enable(1080)).not.toThrow();
    // 三個 reg add 都要有送出去
    expect(regCalls().filter(a => a[0] === 'add')).toHaveLength(3);
  });
});
