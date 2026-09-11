// Windows adapter 的系統代理（HKCU 登錄檔）。execFile 一併 mock：
// adapter 在載入時就會 promisify(execFile)，只 mock execSync 會在 require 階段就炸。
jest.mock('child_process', () => ({
  execSync: jest.fn(),
  execFile: jest.fn(),
}));

const { execSync } = require('child_process');
const winProxy = require('../src/platform/windows').systemProxy;

beforeEach(() => {
  execSync.mockReset();
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

    // 先寫 server/override，最後才 Enable=1（避免停在「已啟用但指向壞位址」）：ProxyServer, ProxyOverride, ProxyEnable=1, refresh
    expect(execSync).toHaveBeenCalledTimes(4);

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
    expect(execSync).toHaveBeenCalledTimes(2);
    expect(execSync.mock.calls[0][0]).toMatch(/ProxyEnable.*\/d 0/);
  });
});

describe('platform/windows systemProxy — refresh fallback', () => {
  test('enableProxy succeeds even if refresh throws', () => {
    let callCount = 0;
    execSync.mockImplementation(() => {
      callCount++;
      // 4th call is the PowerShell refresh
      if (callCount === 4) throw new Error('powershell failed');
      return '';
    });

    const result = winProxy.enable(10808);
    expect(result.enabled).toBe(true);
  });

  test('disableProxy succeeds even if refresh throws', () => {
    let callCount = 0;
    execSync.mockImplementation(() => {
      callCount++;
      if (callCount === 2) throw new Error('powershell failed');
      return '';
    });

    const result = winProxy.disable();
    expect(result.enabled).toBe(false);
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
