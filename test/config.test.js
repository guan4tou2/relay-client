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
      ids.push(config.addServer({ host: 'h', port: i + 1 }).id);   // 從 1 開始：0 不是合法的連接埠
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

describe('config — 分流設定（schema 2：單一規則表 + 可組合條件）', () => {
  test('全新設定：空規則表、預設直連、規則模式、內網保護預設開', () => {
    expect(config.getSplit()).toEqual({
      schema: 2, rules: [], defaultTarget: 'direct', udp: false,
      mode: 'rule', globalTarget: null, lanDirect: true,
    });
  });

  test('mode 只接受 rule / global / direct，其他值退回 rule', () => {
    config.saveSplit({ mode: 'global', globalTarget: 'r-jp' });
    expect(config.getSplit()).toMatchObject({ mode: 'global', globalTarget: 'r-jp' });
    config.saveSplit({ mode: 'nonsense' });
    expect(config.getSplit().mode).toBe('rule');
  });

  test('lanDirect 可停用，但舊設定沒有這欄位時預設開啟', () => {
    config.saveSplit({ lanDirect: false });
    expect(config.getSplit().lanDirect).toBe(false);
    config.updateSettings({ split: { schema: 2, rules: [], defaultTarget: 'direct' } });
    expect(config.getSplit().lanDirect).toBe(true);
  });

  test('saveSplit 只覆寫傳入的欄位，其餘保留', () => {
    config.saveSplit({ rules: [{ id: 'a', name: 'Chrome', on: true, target: 'r1', when: { app: { match: 'name', value: 'chrome.exe' } } }] });
    const s = config.saveSplit({ udp: true });
    expect(s.rules).toHaveLength(1);
    expect(s.udp).toBe(true);
    expect(config.getSplit().rules[0].when.app.value).toBe('chrome.exe');
  });

  test('一條規則可同時帶多種條件（AND）', () => {
    const rule = { id: 'c', name: '複合', on: true, target: 'r-jp',
      when: { app: { match: 'name', value: 'chrome.exe' }, dest: { match: 'suffix', value: 'netflix.com' }, port: '443', network: 'tcp' } };
    config.saveSplit({ rules: [rule] });
    expect(config.getSplit().rules[0].when).toEqual(rule.when);
  });

  test('規則庫相關設定有預設值（預設不自動連網更新）', () => {
    const s = config.getSettings();
    expect(s.rulesetAutoUpdate).toBe(false);
    expect(s.rulesetUpdateDays).toBe(7);
    expect(s.rulesetDetourRouteId).toBeNull();
  });
});

describe('config — schema 1 → 2 遷移', () => {
  // 舊設定：兩張分開的表（程式規則 / 網域規則）+ ruleOrder 開關
  const legacy = (extra = {}) => ({
    rules: [
      { id: 'a1', name: 'Chrome', exe: 'chrome.exe', match: 'name', target: 'r1', on: true },
      { id: 'a2', name: 'Steam', path: 'C:\S\steam.exe', match: 'path', target: 'direct', on: false },
    ],
    netRules: [{ id: 'n1', name: '台灣', match: 'ruleset', value: 'geoip-tw', target: 'direct', on: true }],
    defaultTarget: 'r1', udp: true, ...extra,
  });

  test('舊的兩張表無損合併成一張，程式規則在前（對應舊的 app-first 預設）', () => {
    config.updateSettings({ split: legacy() });
    const s = config.getSplit();
    expect(s.schema).toBe(2);
    expect(s.rules.map(r => r.id)).toEqual(['a1', 'a2', 'n1']);
    expect(s.rules[0].when).toEqual({ app: { match: 'name', value: 'chrome.exe' } });
    expect(s.rules[1].when).toEqual({ app: { match: 'path', value: 'C:\S\steam.exe' } });
    expect(s.rules[2].when).toEqual({ dest: { match: 'ruleset', value: 'geoip-tw' } });
    // 其餘欄位照搬
    expect(s.defaultTarget).toBe('r1');
    expect(s.udp).toBe(true);
    expect(s.rules[1].on).toBe(false);   // 停用狀態要保住
    expect(s.rules[0].target).toBe('r1');
  });

  test('ruleOrder=net-first 的舊設定：網域規則排到前面', () => {
    config.updateSettings({ split: legacy({ ruleOrder: 'net-first' }) });
    expect(config.getSplit().rules.map(r => r.id)).toEqual(['n1', 'a1', 'a2']);
  });

  test('遷移會寫回設定檔，且不重複遷移（第二次讀是同一份）', () => {
    config.updateSettings({ split: legacy() });
    const first = config.getSplit();
    const second = config.getSplit();
    expect(second).toEqual(first);
    expect(config.getSettings().split.schema).toBe(2);
  });

  test('遷移後不再留下舊欄位', () => {
    config.updateSettings({ split: legacy() });
    config.getSplit();
    config.saveSplit({ udp: false });
    const stored = config.getSettings().split;
    expect(stored.netRules).toBeUndefined();
    expect(stored.ruleOrder).toBeUndefined();
  });

  test('只有程式規則的舊設定（沒碰過網域功能）也能遷移', () => {
    config.updateSettings({ split: { rules: [{ id: 'a1', exe: 'chrome.exe', match: 'name', target: 'r1', on: true }], defaultTarget: 'direct' } });
    const s = config.getSplit();
    expect(s.rules).toHaveLength(1);
    expect(s.rules[0].name).toBe('chrome.exe'); // 舊資料沒有 name → 用 exe 補
  });
});

// 埠沒驗的話，打錯的值會存進設定檔，之後每次連線都失敗，
// 而使用者看到的是 net.connect 丟出來的原文
// 「Port should be >= 0 and < 65536. Received type number (10108080)」，
// 看不出是設定有問題。真的在開發機的紀錄裡出現過。
describe('伺服器連接埠的驗證', () => {
  test('合法範圍', () => {
    expect(config.validPort(1)).toBe(true);
    expect(config.validPort(1080)).toBe(true);
    expect(config.validPort(65535)).toBe(true);
  });

  test('不合法的一律擋掉', () => {
    for (const bad of [0, -1, 65536, 10108080, 1.5, NaN, null, undefined, '', 'abc', {}]) {
      expect(config.validPort(bad)).toBe(false);
    }
  });

  test('addServer 擋下壞掉的埠，而且訊息說得出範圍', () => {
    expect(() => config.addServer({ host: 'x', port: 10108080 })).toThrow(/1 到 65535/);
    expect(() => config.addServer({ host: 'x' })).toThrow(/連接埠/);
  });

  test('updateServer 只在有帶 port 時檢查（改別的欄位不受影響）', () => {
    const s = config.addServer({ host: 'x', port: 1080 });
    expect(() => config.updateServer(s.id, { port: 70000 })).toThrow(/1 到 65535/);
    expect(() => config.updateServer(s.id, { label: '改名字' })).not.toThrow();
  });
});
