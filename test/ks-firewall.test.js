const { KillSwitchFirewall, protectedPrograms, complementRanges, TUN_CIDR, LOCAL_NOT_TUN, REMOTE_PUBLIC } = require('../src/engine/ks-firewall');
const SingBoxEngine = require('../src/engine/singbox');
const { forPlatform } = require('../src/platform');

// issue #3：sing-box 一死，流量退回實體網卡，封鎖模式要數秒才重建。
// 防火牆層預先布防，靠「來源位址不是 TUN」在崩潰當下就擋。

describe('complementRanges（位址補集）', () => {
  test('IPv4：排除 TUN 的 /30，剩下前後兩段', () => {
    expect(complementRanges(['172.19.0.0/30'], 4)).toEqual(['0.0.0.0-172.18.255.255', '172.19.0.4-255.255.255.255']);
  });
  test('重疊與相鄰的排除範圍會合併處理', () => {
    expect(complementRanges(['10.0.0.0/8', '10.1.0.0/16', '11.0.0.0/8'], 4)).toEqual(['0.0.0.0-9.255.255.255', '12.0.0.0-255.255.255.255']);
  });
  test('沒有排除 → 整個位址空間', () => {
    expect(complementRanges([], 4)).toEqual(['0.0.0.0-255.255.255.255']);
    expect(complementRanges([], 6)).toEqual(['0:0:0:0:0:0:0:0-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff']);
  });
  test('IPv6：排除 ::1 與 fe80::/10', () => {
    expect(complementRanges(['::1/128', 'fe80::/10'], 6)).toEqual([
      '0:0:0:0:0:0:0:0-0:0:0:0:0:0:0:0',
      '0:0:0:0:0:0:0:2-fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
      'fec0:0:0:0:0:0:0:0-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    ]);
  });
});

describe('規則用的位址範圍', () => {
  test('本機位址排除的就是 sing-box 設定裡的 TUN 位址（兩邊改一邊會失效）', () => {
    const tun = new SingBoxEngine({ platform: forPlatform('win32') })._tunInbound().address[0];   // 172.19.0.1/30
    expect(tun.split('/')[1]).toBe(TUN_CIDR.split('/')[1]);
    expect(LOCAL_NOT_TUN).not.toMatch(/172\.19\.0\.[0-3]-/);
    expect(LOCAL_NOT_TUN).toContain('172.19.0.4-');
  });
  test('對方位址不含內網：擋外連，不擋印表機、NAS、本機', () => {
    for (const lan of ['10.', '192.168.', '127.', '169.254.']) expect(REMOTE_PUBLIC.split(',').some(r => r.startsWith(lan))).toBe(false);
    expect(REMOTE_PUBLIC).toContain('11.0.0.0-100.63.255.255');
  });
});

describe('protectedPrograms（要保護哪些程式）', () => {
  const split = {
    mode: 'rule',
    rules: [
      { id: 'a', on: true, target: 'r1', when: { app: { match: 'name', value: 'chrome.exe, firefox.exe' } } },
      { id: 'b', on: true, target: 'r1', when: { app: { match: 'path', value: 'C:\\Tools\\tg.exe' } } },
      { id: 'c', on: true, target: 'direct', when: { app: { match: 'name', value: 'steam.exe' } } },   // 原本就直連：不保護
      { id: 'd', on: false, target: 'r1', when: { app: { match: 'name', value: 'off.exe' } } },       // 停用的規則
      { id: 'e', on: true, target: 'r1', when: { dest: { match: 'suffix', value: 'google.com' } } },  // 純網域：沒有程式可比對
      { id: 'f', on: true, target: 'block', when: { app: { match: 'name', value: 'spy.exe' } } },     // 封鎖也算
    ],
  };

  test('規則模式：只取「依程式」且原本要走代理或封鎖的規則', () => {
    expect(protectedPrograms({ settings: {}, split })).toEqual({ paths: ['C:\\Tools\\tg.exe'], names: ['chrome.exe', 'firefox.exe', 'spy.exe'] });
  });
  test('「只保護以下程式」模式：用那份清單，不看規則表', () => {
    expect(protectedPrograms({ settings: { killSwitchScope: 'apps', killSwitchApps: ['discord.exe'] }, split })).toEqual({ paths: [], names: ['discord.exe'] });
  });
  test('全域模式沒有程式可比對 → 空（誠實回報，不假裝有保護）', () => {
    expect(protectedPrograms({ settings: {}, split: { ...split, mode: 'global' } })).toEqual({ paths: [], names: [] });
  });
});

describe('KillSwitchFirewall（布防狀態機）', () => {
  const mkAdapter = () => {
    const rules = [];
    return {
      rules,
      sameName: (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),
      addRule: jest.fn(async p => { rules.push(p); }),
      removeAll: jest.fn(async () => { rules.length = 0; }),
    };
  };
  const procs = [
    { path: 'C:\\Program Files\\Google\\Chrome\\chrome.exe' },
    { path: 'C:\\Other\\notepad.exe' },
    { path: 'C:\\Program Files (x86)\\Chrome Beta\\CHROME.EXE' },
  ];

  test('指定路徑直接加；指定名稱從執行中的程式找完整路徑（不分大小寫）', async () => {
    const ad = mkAdapter();
    const fw = new KillSwitchFirewall({ adapter: ad, listProcesses: async () => procs, rescanMs: 0 });
    const r = await fw.arm({ paths: ['C:\\Tools\\tg.exe'], names: ['chrome.exe'] });
    expect(r).toEqual({ ok: true, count: 3 });
    expect(ad.rules.sort()).toEqual(['C:\\Program Files (x86)\\Chrome Beta\\CHROME.EXE', 'C:\\Program Files\\Google\\Chrome\\chrome.exe', 'C:\\Tools\\tg.exe'].sort());
    expect(fw.active).toBe(true);
  });

  test('重新同步只補新出現的程式，不重複加', async () => {
    const ad = mkAdapter();
    let list = [procs[0]];
    const fw = new KillSwitchFirewall({ adapter: ad, listProcesses: async () => list, rescanMs: 0 });
    await fw.arm({ paths: [], names: ['chrome.exe'] });
    expect(ad.addRule).toHaveBeenCalledTimes(1);
    list = procs;
    expect(await fw.sync()).toBe(1);
    expect(await fw.sync()).toBe(0);
    expect(ad.addRule).toHaveBeenCalledTimes(2);
  });

  test('再次布防會先清掉舊規則（規則表可能改了）', async () => {
    const ad = mkAdapter();
    const fw = new KillSwitchFirewall({ adapter: ad, listProcesses: async () => [], rescanMs: 0 });
    await fw.arm({ paths: ['C:\\a.exe'], names: [] });
    await fw.arm({ paths: ['C:\\b.exe'], names: [] });
    expect(ad.rules).toEqual(['C:\\b.exe']);
  });

  test('沒有可比對的程式 → 不布防，也不留定期掃描', async () => {
    const ad = mkAdapter();
    const fw = new KillSwitchFirewall({ adapter: ad, listProcesses: async () => procs });
    const r = await fw.arm({ paths: [], names: [] });
    expect(r).toEqual({ ok: true, count: 0 });
    expect(fw.active).toBe(false);
    expect(fw.timer).toBe(null);
  });

  test('解除：刪掉全部規則、停掉定期掃描', async () => {
    jest.useFakeTimers();
    try {
      const ad = mkAdapter();
      const list = jest.fn(async () => procs);
      const fw = new KillSwitchFirewall({ adapter: ad, listProcesses: list, rescanMs: 1000 });
      await fw.arm({ paths: [], names: ['chrome.exe'] });
      await fw.disarm();
      expect(ad.rules).toEqual([]);
      expect(fw.active).toBe(false);
      list.mockClear();
      await jest.advanceTimersByTimeAsync(5000);
      expect(list).not.toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });

  test('一條規則加失敗只記錄，其他照加', async () => {
    const ad = mkAdapter();
    ad.addRule.mockImplementationOnce(async () => { throw new Error('access denied'); });
    const log = jest.fn();
    const fw = new KillSwitchFirewall({ adapter: ad, listProcesses: async () => [], log, rescanMs: 0 });
    const r = await fw.arm({ paths: ['C:\\a.exe', 'C:\\b.exe'], names: [] });
    expect(r.count).toBe(1);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('access denied'));
  });

  test('沒有 adapter 的平台（macOS / Linux）：不支援，什麼都不做', async () => {
    const fw = new KillSwitchFirewall({ adapter: null });
    expect(fw.supported).toBe(false);
    expect(await fw.arm({ paths: ['/usr/bin/x'], names: [] })).toEqual({ ok: false, unsupported: true });
  });
});

describe('Windows adapter 的 netsh 參數', () => {
  const ks = forPlatform('win32').killSwitchFirewall;

  test('封鎖對外、指定程式、本機位址不是 TUN、對方是公網', () => {
    const args = ks.addRuleArgs('C:\\Program Files\\Google\\Chrome\\chrome.exe');
    expect(args.slice(0, 4)).toEqual(['advfirewall', 'firewall', 'add', 'rule']);
    expect(args).toEqual(expect.arrayContaining([
      `name=${ks.ruleName}`, 'dir=out', 'action=block', 'enable=yes', 'profile=any',
      'program=C:\\Program Files\\Google\\Chrome\\chrome.exe',
      `localip=${LOCAL_NOT_TUN}`, `remoteip=${REMOTE_PUBLIC}`,
    ]));
  });

  test('刪除用同一個名稱，崩潰後殘留的也一次收乾淨', () => {
    expect(ks.deleteArgs()).toEqual(['advfirewall', 'firewall', 'delete', 'rule', `name=${ks.ruleName}`]);
  });

  test('只接受完整路徑（相對路徑或單純檔名一律拒絕）', async () => {
    await expect(ks.addRule('chrome.exe')).rejects.toThrow();
  });

  test('其他平台沒有這一層', () => {
    expect(forPlatform('linux').killSwitchFirewall).toBeUndefined();
    expect(forPlatform('darwin').killSwitchFirewall).toBeUndefined();
  });
});
