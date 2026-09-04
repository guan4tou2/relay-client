// Test main.js logic that can be tested without full Electron runtime:
// - addLog buffer management
// - stopProxyServers guard logic
// - tray icon SVG generation
//
// We extract testable functions by partially loading main.js with mocked Electron.

const { EventEmitter } = require('events');

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
    exit: jest.fn()
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
      'get-servers', 'add-server', 'update-server', 'delete-server', 'reorder-servers',
      'start-proxy', 'stop-proxy', 'get-proxy-status',
      'toggle-system-proxy', 'get-system-proxy-state',
      'test-server', 'get-logs', 'clear-logs',
      'get-settings', 'update-settings',
      'window-minimize', 'window-maximize', 'window-close'
    ];
    for (const ch of expected) {
      expect(ipcHandlers[ch]).toBeDefined();
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

describe('main.js — get-proxy-status', () => {
  test('returns status object with expected fields', async () => {
    const status = await ipcHandlers['get-proxy-status']();
    expect(status).toHaveProperty('proxyRunning');
    expect(status).toHaveProperty('systemProxyEnabled');
    expect(status).toHaveProperty('activeServerId');
    expect(typeof status.proxyRunning).toBe('boolean');
    expect(typeof status.systemProxyEnabled).toBe('boolean');
  });
});

describe('main.js — stop-proxy when not running', () => {
  test('stop-proxy returns success even when not running', async () => {
    const result = await ipcHandlers['stop-proxy'](null);
    expect(result.success).toBe(true);
  });
});

describe('main.js — start-proxy with invalid server', () => {
  test('start-proxy with nonexistent server returns error', async () => {
    const result = await ipcHandlers['start-proxy'](null, 'nonexistent-id');
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
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
