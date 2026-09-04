const mockStore = new Map();

jest.mock('electron-store', () => {
  return jest.fn().mockImplementation(({ defaults = {} } = {}) => {
    for (const [k, v] of Object.entries(defaults)) {
      mockStore.set(k, JSON.parse(JSON.stringify(v)));
    }
    return {
      get: (key) => JSON.parse(JSON.stringify(mockStore.get(key))),
      set: (key, val) => mockStore.set(key, JSON.parse(JSON.stringify(val)))
    };
  });
});

const config = require('../src/store/config');

beforeEach(() => {
  mockStore.clear();
  mockStore.set('servers', []);
  mockStore.set('activeServerId', null);
  mockStore.set('settings', {
    httpPort: 10808,
    socksPort: 10809,
    autoStart: false,
    autoConnect: false,
    minimizeToTray: true
  });
});

describe('config — server CRUD', () => {
  test('getServers returns empty array initially', () => {
    expect(config.getServers()).toEqual([]);
  });

  test('addServer creates server with id and createdAt', () => {
    const s = config.addServer({ host: '1.2.3.4', port: 1080, name: 'test' });
    expect(s.id).toBeTruthy();
    expect(s.createdAt).toBeGreaterThan(0);
    expect(s.host).toBe('1.2.3.4');
    expect(s.port).toBe(1080);
  });

  test('addServer persists to store', () => {
    config.addServer({ host: '1.2.3.4', port: 1080 });
    const servers = config.getServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].host).toBe('1.2.3.4');
  });

  test('getServer returns server by id', () => {
    const s = config.addServer({ host: 'a.b.c', port: 9999 });
    const found = config.getServer(s.id);
    expect(found).toBeTruthy();
    expect(found.host).toBe('a.b.c');
  });

  test('getServer returns undefined for unknown id', () => {
    expect(config.getServer('nonexistent')).toBeUndefined();
  });

  test('updateServer merges fields and preserves id', () => {
    const s = config.addServer({ host: 'old', port: 1080, name: 'orig' });
    const updated = config.updateServer(s.id, { name: 'renamed', latency: 42 });
    expect(updated.name).toBe('renamed');
    expect(updated.latency).toBe(42);
    expect(updated.host).toBe('old');
    expect(updated.id).toBe(s.id);
  });

  test('updateServer returns null for unknown id', () => {
    expect(config.updateServer('ghost', { name: 'x' })).toBeNull();
  });

  test('updateServer cannot overwrite id', () => {
    const s = config.addServer({ host: 'h', port: 1 });
    config.updateServer(s.id, { id: 'hacked' });
    const found = config.getServer(s.id);
    expect(found.id).toBe(s.id);
  });

  test('deleteServer removes server from list', () => {
    const s1 = config.addServer({ host: 'a', port: 1 });
    const s2 = config.addServer({ host: 'b', port: 2 });
    config.deleteServer(s1.id);
    const servers = config.getServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].id).toBe(s2.id);
  });

  test('deleteServer clears activeServerId if it matches', () => {
    const s = config.addServer({ host: 'x', port: 1 });
    config.setActiveServerId(s.id);
    expect(config.getActiveServerId()).toBe(s.id);
    config.deleteServer(s.id);
    expect(config.getActiveServerId()).toBeNull();
  });

  test('deleteServer does not clear activeServerId for other servers', () => {
    const s1 = config.addServer({ host: 'a', port: 1 });
    const s2 = config.addServer({ host: 'b', port: 2 });
    config.setActiveServerId(s2.id);
    config.deleteServer(s1.id);
    expect(config.getActiveServerId()).toBe(s2.id);
  });

  test('multiple addServer calls create unique ids', () => {
    const ids = [];
    for (let i = 0; i < 20; i++) {
      ids.push(config.addServer({ host: 'h', port: i }).id);
    }
    expect(new Set(ids).size).toBe(20);
  });
});

describe('config — reorderServers', () => {
  test('reorders by given id array', () => {
    const s1 = config.addServer({ host: 'a', port: 1 });
    const s2 = config.addServer({ host: 'b', port: 2 });
    const s3 = config.addServer({ host: 'c', port: 3 });
    const reordered = config.reorderServers([s3.id, s1.id, s2.id]);
    expect(reordered.map(s => s.id)).toEqual([s3.id, s1.id, s2.id]);
    expect(config.getServers().map(s => s.id)).toEqual([s3.id, s1.id, s2.id]);
  });

  test('ignores unknown ids', () => {
    const s1 = config.addServer({ host: 'a', port: 1 });
    const reordered = config.reorderServers(['fake', s1.id]);
    expect(reordered).toHaveLength(1);
    expect(reordered[0].id).toBe(s1.id);
  });
});

describe('config — delete edge cases', () => {
  test('deleteServer on nonexistent id is a no-op', () => {
    config.addServer({ host: 'a', port: 1 });
    config.deleteServer('does-not-exist');
    expect(config.getServers()).toHaveLength(1);
  });

  test('deleteServer on empty list is a no-op', () => {
    config.deleteServer('anything');
    expect(config.getServers()).toEqual([]);
  });
});

describe('config — activeServerId', () => {
  test('getActiveServerId returns null initially', () => {
    expect(config.getActiveServerId()).toBeNull();
  });

  test('setActiveServerId persists value', () => {
    config.setActiveServerId('abc123');
    expect(config.getActiveServerId()).toBe('abc123');
  });
});

describe('config — settings', () => {
  test('getSettings returns defaults', () => {
    const s = config.getSettings();
    expect(s.httpPort).toBe(10808);
    expect(s.socksPort).toBe(10809);
    expect(s.minimizeToTray).toBe(true);
  });

  test('updateSettings merges partial updates', () => {
    const s = config.updateSettings({ httpPort: 9999 });
    expect(s.httpPort).toBe(9999);
    expect(s.socksPort).toBe(10809);
  });

  test('updateSettings persists across reads', () => {
    config.updateSettings({ autoConnect: true });
    expect(config.getSettings().autoConnect).toBe(true);
  });
});
