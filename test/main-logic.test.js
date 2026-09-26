// Test main.js logic that can be tested without full Electron runtime:
// - addLog buffer management
// - stopProxyServers guard logic
// - tray icon SVG generation
//
// We extract testable functions by partially loading main.js with mocked Electron.

const { EventEmitter } = require('events');

// 系統代理換成假的。理由有兩個，都不只是「讓測試好寫」：
//   - 真的打下去會有副作用：Windows 上寫使用者的 HKCU、Linux 上呼叫 gsettings。
//     單元測試不該改執行它的那台機器的設定。
//   - 會變成看主機臉色：CI 的 ubuntu runner 沒有 GNOME schema，
//     真的 gsettings 直接拋 "No such schema"，測試就紅了（實際發生過）。
// adapter 其餘部分保持真的，這裡只換掉會碰到系統狀態的那一塊。
jest.mock('../src/platform', () => {
  const actual = jest.requireActual('../src/platform');
  return {
    ...actual,
    current: {
      ...actual.current,
      systemProxy: {
        get: () => ({ enabled: false, server: '' }),
        enable: jest.fn((port) => ({ enabled: true, server: `127.0.0.1:${port}` })),
        disable: jest.fn(() => ({ enabled: false, server: '' })),
      },
    },
  };
});

// Mock Electron modules
const mockWebContents = { send: jest.fn() };
const mockWindow = {
  isDestroyed: () => false,
  webContents: mockWebContents,
  loadFile: jest.fn(),
  on: jest.fn(),
  hide: jest.fn(),
  show: jest.fn(),
  focus: jest.fn(),
  minimize: jest.fn(),
  maximize: jest.fn(),
  unmaximize: jest.fn(),
  isMaximized: jest.fn(() => false),
  close: jest.fn()
};

jest.mock('electron', () => ({
  app: {
    whenReady: () => new Promise(() => {}), // never resolves to prevent startup
    on: jest.fn(),
    exit: jest.fn(),
    quit: jest.fn(),
    // 單一實例鎖：測試環境一律視為「拿到鎖」，main.js 才會走正常的初始化路徑
    requestSingleInstanceLock: jest.fn(() => true),
    getPath: jest.fn(() => require('os').tmpdir()),
    getVersion: jest.fn(() => '0.0.0-test'),
  },
  BrowserWindow: jest.fn(() => mockWindow),
  ipcMain: { handle: jest.fn() },
  Tray: jest.fn(() => ({
    setImage: jest.fn(),
    setToolTip: jest.fn(),
    setContextMenu: jest.fn(),
    on: jest.fn()
  })),
  Menu: { buildFromTemplate: jest.fn(() => ({})) },
  nativeImage: { createFromDataURL: jest.fn(() => 'mock-image') }
}));

jest.mock('electron-store', () => {
  const data = new Map();
  data.set('servers', []);
  data.set('activeServerId', null);
  data.set('settings', { httpPort: 10808, socksPort: 10809, autoStart: false, autoConnect: false, minimizeToTray: true });
  return jest.fn(() => ({
    get: (k) => JSON.parse(JSON.stringify(data.get(k))),
    set: (k, v) => data.set(k, JSON.parse(JSON.stringify(v)))
  }));
});

jest.mock('../src/proxy/connect', () => ({
  connectViaProxy: jest.fn(),
  openSocketToProxy: jest.fn()
}));

// Collect IPC handlers registered by main.js
const ipcHandlers = {};
const { ipcMain } = require('electron');
ipcMain.handle.mockImplementation((channel, handler) => {
  ipcHandlers[channel] = handler;
});

// Now load main.js — it registers IPC handlers synchronously
require('../main');

describe('main.js — IPC handler registration', () => {
  test('registers all expected IPC channels', () => {
    const expected = [
      'get-servers', 'add-server', 'update-server', 'delete-server',
      'toggle-system-proxy',
      'test-server', 'get-logs', 'clear-logs', 'open-logs-folder',
      'get-settings', 'update-settings',
      'get-routes', 'save-route', 'route-start', 'route-stop', 'get-route-status',
      'window-minimize', 'window-maximize', 'window-close'
    ];
    for (const ch of expected) {
      expect(ipcHandlers[ch]).toBeDefined();
    }
  });

  // 拿掉的那些：舊的「單一主連線」（start-proxy / stop-proxy / get-proxy-status）
  // 與幾個 renderer 從來沒叫過的。留著只會讓人以為還有一條主連線。
  test('舊的單一主連線相關 channel 已經不存在', () => {
    for (const ch of ['start-proxy', 'stop-proxy', 'get-proxy-status',
                      'get-system-proxy-state', 'save-routes', 'reorder-servers', 'launch-browser']) {
      expect(ipcHandlers[ch]).toBeUndefined();
    }
  });
});

describe('main.js — get-logs / clear-logs', () => {
  test('get-logs returns array', async () => {
    const logs = await ipcHandlers['get-logs']();
    expect(Array.isArray(logs)).toBe(true);
  });

  test('clear-logs empties and returns true', async () => {
    const result = await ipcHandlers['clear-logs']();
    expect(result).toBe(true);
    const logs = await ipcHandlers['get-logs']();
    expect(logs).toHaveLength(0);
  });
});

describe('main.js — test-server', () => {
  test('returns error for unknown server id', async () => {
    const result = await ipcHandlers['test-server'](null, 'bad-id');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('uses connectViaProxy when testTarget is provided', async () => {
    const { connectViaProxy } = require('../src/proxy/connect');
    const server = await ipcHandlers['add-server'](null, { host: '1.2.3.4', port: 1080 });
    connectViaProxy.mockResolvedValue({ destroy: jest.fn() });
    const result = await ipcHandlers['test-server'](null, server.id, { host: '10.0.0.1', port: 80 });
    expect(result.success).toBe(true);
    expect(result.latency).toBeGreaterThanOrEqual(0);
    expect(connectViaProxy).toHaveBeenCalled();
  });
});

describe('main.js — settings IPC', () => {
  test('get-settings returns settings object', async () => {
    const settings = await ipcHandlers['get-settings']();
    expect(settings).toHaveProperty('httpPort');
    expect(settings).toHaveProperty('socksPort');
  });

  test('update-settings persists changes', async () => {
    await ipcHandlers['update-settings'](null, { httpPort: 12345 });
    const settings = await ipcHandlers['get-settings']();
    expect(settings.httpPort).toBe(12345);
  });
});

describe('main.js — server CRUD IPC', () => {
  test('add-server and get-servers round-trip', async () => {
    const server = await ipcHandlers['add-server'](null, { host: 'test.host', port: 2222, name: 'TestSrv' });
    expect(server.id).toBeTruthy();
    expect(server.host).toBe('test.host');

    const servers = await ipcHandlers['get-servers']();
    expect(servers.some(s => s.id === server.id)).toBe(true);
  });

  test('update-server via IPC', async () => {
    const server = await ipcHandlers['add-server'](null, { host: 'old', port: 1 });
    await ipcHandlers['update-server'](null, server.id, { name: 'Updated' });
    const servers = await ipcHandlers['get-servers']();
    const found = servers.find(s => s.id === server.id);
    expect(found.name).toBe('Updated');
  });

  test('delete-server via IPC', async () => {
    const server = await ipcHandlers['add-server'](null, { host: 'del', port: 1 });
    const before = (await ipcHandlers['get-servers']()).length;
    await ipcHandlers['delete-server'](null, server.id);
    const after = (await ipcHandlers['get-servers']()).length;
    expect(after).toBe(before - 1);
  });
});

// 系統代理指向哪個埠，是「會不會整台機器上不了網」等級的事。
// 以前系統匣寫死 settings.httpPort（舊主連線的 10808），主視窗卻用當下路由的埠，
// 兩邊定義不一樣 —— 從系統匣按下去就把機器指到一個沒人在聽的埠。
describe('main.js — toggle-system-proxy 的埠來源', () => {
  test('沒有路由在跑時不動手，而且明講原因', async () => {
    const r = await ipcHandlers['toggle-system-proxy'](null, true);
    expect(r.systemProxyEnabled).toBe(false);
    expect(r.error).toBeTruthy();
  });

  test('關閉不需要路由在跑（殘留的設定一定要關得掉）', async () => {
    const r = await ipcHandlers['toggle-system-proxy'](null, false);
    expect(r.systemProxyEnabled).toBe(false);
  });
});

describe('main.js — save-route / delete-route 的路由 id 防護', () => {
  const fs = require('fs');

  test('save-route 擋掉 id 是 `..` 的路由', async () => {
    expect(() => ipcHandlers['save-route'](null, { id: '..', localPort: 10808, kind: 'socks5', hops: [] })).toThrow(/id/);
  });

  test('save-route 擋掉不合法的埠', async () => {
    expect(() => ipcHandlers['save-route'](null, { id: 'r-x', localPort: 99999, kind: 'socks5', hops: [] })).toThrow();
  });

  test('delete-route 對不合法的 id 絕不呼叫 rmSync', async () => {
    const rm = jest.spyOn(fs, 'rmSync').mockImplementation(() => {});
    const ex = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    try {
      await ipcHandlers['delete-route'](null, '..', {});
      expect(rm).not.toHaveBeenCalled();
    } finally { rm.mockRestore(); ex.mockRestore(); }
  });

  test('delete-route 對合法的 id 只刪 browser-profiles 底下那一層', async () => {
    const path = require('path');
    const rm = jest.spyOn(fs, 'rmSync').mockImplementation(() => {});
    const ex = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    try {
      await ipcHandlers['delete-route'](null, 'r-123', {});
      expect(rm).toHaveBeenCalledTimes(1);
      const target = rm.mock.calls[0][0];
      expect(path.basename(path.dirname(target))).toBe('browser-profiles');
      expect(path.basename(target)).toBe('r-123');
    } finally { rm.mockRestore(); ex.mockRestore(); }
  });
});

describe('main.js — toggle-system-proxy 不信任 renderer 傳來的埠', () => {
  test('帶一個不是路由的埠（或注入字串）也不會寫進系統設定', async () => {
    const { systemProxy } = require('../src/platform').current;
    systemProxy.enable.mockClear();
    const r = await ipcHandlers['toggle-system-proxy'](null, true, '1" & calc & "');
    expect(systemProxy.enable).not.toHaveBeenCalled();
    expect(r.error).toBeTruthy();
  });
});
