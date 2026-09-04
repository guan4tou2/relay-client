const SingBoxEngine = require('../src/engine/singbox');

// generateConfig 是純函式（不啟動 TUN、不需 binary），可完整單元測試分流設定生成邏輯。
const mk = () => new SingBoxEngine();
const ROUTES = [
  { id: 'r1', kind: 'socks5', localPort: 10810 },
  { id: 'r2', kind: 'http', localPort: 10820 },
];

describe('SingBoxEngine.generateConfig — 基本結構', () => {
  test('空規則 → 只有 direct outbound、final=direct、僅剩 sing-box 自我 bypass', () => {
    const cfg = mk().generateConfig({ rules: [], defaultTarget: 'direct', routes: ROUTES });
    expect(cfg.outbounds).toEqual([{ type: 'direct', tag: 'direct' }]);
    expect(cfg.route.final).toBe('direct');
    // sing-box.exe 自我 bypass 一律存在（防迴圈）；不應有任何 app 規則
    expect(cfg.route.rules).toEqual([{ process_name: ['sing-box.exe'], outbound: 'direct' }]);
    expect(cfg.route.auto_detect_interface).toBe(true);
  });

  test('tun inbound 欄位正確（gvisor / auto_route / 位址 / 介面名）', () => {
    const tun = mk().generateConfig({ rules: [], routes: ROUTES }).inbounds[0];
    expect(tun.type).toBe('tun');
    expect(tun.interface_name).toBe('proxyclient-tun');
    expect(tun.address).toEqual(['172.19.0.1/30']);
    expect(tun.auto_route).toBe(true);
    expect(tun.stack).toBe('gvisor');
    // sniff 已移除（新版 schema 不接受）
    expect(tun.sniff).toBeUndefined();
  });
});

describe('SingBoxEngine.generateConfig — outbound 生成', () => {
  test('socks route → type socks + version 5 + 指向本地端口', () => {
    const cfg = mk().generateConfig({ rules: [{ on: true, exe: 'chrome.exe', target: 'r1' }], routes: ROUTES });
    expect(cfg.outbounds.find(o => o.tag === 'route-r1')).toMatchObject({
      type: 'socks', server: '127.0.0.1', server_port: 10810, version: '5',
    });
  });

  test('http route → type http、無 version', () => {
    const cfg = mk().generateConfig({ rules: [{ on: true, exe: 'x.exe', target: 'r2' }], routes: ROUTES });
    const ob = cfg.outbounds.find(o => o.tag === 'route-r2');
    expect(ob).toMatchObject({ type: 'http', server_port: 10820 });
    expect(ob.version).toBeUndefined();
  });

  test('只建立被引用的 route（未引用者不出現）', () => {
    const cfg = mk().generateConfig({ rules: [{ on: true, exe: 'chrome.exe', target: 'r1' }], routes: ROUTES });
    expect(cfg.outbounds.find(o => o.tag === 'route-r1')).toBeTruthy();
    expect(cfg.outbounds.find(o => o.tag === 'route-r2')).toBeUndefined();
  });

  test('同一 route 被多條規則引用 → outbound 去重僅一份', () => {
    const cfg = mk().generateConfig({
      rules: [
        { on: true, exe: 'a.exe', target: 'r1' },
        { on: true, exe: 'b.exe', target: 'r1' },
      ], routes: ROUTES,
    });
    expect(cfg.outbounds.filter(o => o.tag === 'route-r1')).toHaveLength(1);
  });
});

describe('SingBoxEngine.generateConfig — 規則導向', () => {
  test('exe 規則 → process_name 導向對應 route', () => {
    const cfg = mk().generateConfig({ rules: [{ on: true, exe: 'chrome.exe', target: 'r1' }], routes: ROUTES });
    const rule = cfg.route.rules.find(r => r.process_name && r.process_name.includes('chrome.exe'));
    expect(rule.outbound).toBe('route-r1');
  });

  test('match=path 規則 → 用 process_path', () => {
    const cfg = mk().generateConfig({ rules: [{ on: true, match: 'path', path: 'C:\\a\\b.exe', target: 'r1' }], routes: ROUTES });
    expect(cfg.route.rules.find(r => r.process_path)).toEqual({ process_path: ['C:\\a\\b.exe'], outbound: 'route-r1' });
  });

  test('關閉的規則(on:false) → 不產生 app rule 也不建 outbound（僅剩 self bypass）', () => {
    const cfg = mk().generateConfig({ rules: [{ on: false, exe: 'chrome.exe', target: 'r1' }], routes: ROUTES });
    expect(cfg.route.rules).toEqual([{ process_name: ['sing-box.exe'], outbound: 'direct' }]);
    expect(cfg.outbounds.find(o => o.tag === 'route-r1')).toBeUndefined();
  });

  test('target=direct 的規則 → 導 direct、不建 outbound', () => {
    const cfg = mk().generateConfig({ rules: [{ on: true, exe: 'chrome.exe', target: 'direct' }], routes: ROUTES });
    expect(cfg.route.rules.find(r => r.process_name.includes('chrome.exe')).outbound).toBe('direct');
    expect(cfg.outbounds).toEqual([{ type: 'direct', tag: 'direct' }]);
  });

  test('target 指向不存在的 route → 當成 direct（防無效 outbound）', () => {
    const cfg = mk().generateConfig({ rules: [{ on: true, exe: 'chrome.exe', target: 'ghost' }], routes: ROUTES });
    expect(cfg.route.rules.find(r => r.process_name.includes('chrome.exe')).outbound).toBe('direct');
    expect(cfg.outbounds.find(o => o.tag === 'route-ghost')).toBeUndefined();
  });
});

describe('SingBoxEngine.generateConfig — 防迴圈 self bypass', () => {
  test('selfNames + sing-box.exe 一律 bypass，且排在 app 規則之前', () => {
    const cfg = mk().generateConfig({
      rules: [{ on: true, exe: 'chrome.exe', target: 'r1' }],
      routes: ROUTES, selfNames: ['代理客戶端.exe'],
    });
    expect(cfg.route.rules[0]).toMatchObject({ outbound: 'direct' });
    expect(cfg.route.rules[0].process_name).toEqual(expect.arrayContaining(['代理客戶端.exe', 'sing-box.exe']));
    expect(cfg.route.rules[1].process_name).toContain('chrome.exe'); // app 規則在後
  });

  test('沒有 selfNames 時仍不會漏掉 sing-box.exe 的 bypass', () => {
    const cfg = mk().generateConfig({ rules: [], routes: ROUTES });
    // 無 selfNames 且無 app 規則 → self 陣列僅 sing-box.exe，仍應有一條 bypass
    const selfRule = cfg.route.rules.find(r => r.process_name && r.process_name.includes('sing-box.exe'));
    expect(selfRule).toBeTruthy();
    expect(selfRule.outbound).toBe('direct');
  });
});

describe('SingBoxEngine.generateConfig — 預設走向與 UDP flag', () => {
  test('defaultTarget=route → final 指向該 route 並建立 outbound', () => {
    const cfg = mk().generateConfig({ rules: [], defaultTarget: 'r2', routes: ROUTES });
    expect(cfg.route.final).toBe('route-r2');
    expect(cfg.outbounds.find(o => o.tag === 'route-r2')).toBeTruthy();
  });

  test('_udp 反映 udp 參數（供 UI 顯示提示用）', () => {
    expect(mk().generateConfig({ rules: [], routes: ROUTES, udp: true })._udp).toBe(true);
    expect(mk().generateConfig({ rules: [], routes: ROUTES, udp: false })._udp).toBe(false);
  });
});

describe('SingBoxEngine.generateBlockConfig — 斷線保護 fail-closed', () => {
  test('受保護程式 → action reject；原本 direct / 關閉的規則不擋；其餘走 final direct', () => {
    const cfg = mk().generateBlockConfig({
      rules: [
        { on: true, exe: 'chrome.exe', target: 'r1' },
        { on: true, match: 'path', path: 'C:\\x\\y.exe', target: 'r2' },
        { on: true, exe: 'safe.exe', target: 'direct' }, // 原本直連 → 不擋
        { on: false, exe: 'off.exe', target: 'r1' },      // 關閉 → 不擋
      ],
      selfNames: ['代理客戶端.exe'],
    });
    expect(cfg.route.rules[0].outbound).toBe('direct'); // self bypass 第一條
    expect(cfg.route.rules[0].process_name).toEqual(expect.arrayContaining(['代理客戶端.exe', 'sing-box.exe']));
    expect(cfg.route.rules).toContainEqual({ process_name: ['chrome.exe'], action: 'reject' });
    expect(cfg.route.rules).toContainEqual({ process_path: ['C:\\x\\y.exe'], action: 'reject' });
    expect(cfg.route.rules.find(r => r.process_name && r.process_name.includes('safe.exe'))).toBeUndefined();
    expect(cfg.route.rules.find(r => r.process_name && r.process_name.includes('off.exe'))).toBeUndefined();
    expect(cfg.route.final).toBe('direct');
    expect(cfg.outbounds).toEqual([{ type: 'direct', tag: 'direct' }]);
    expect(cfg._blocking).toBe(true);
  });

  test('無規則 → 只有 self bypass（不誤擋整機）', () => {
    const cfg = mk().generateBlockConfig({ rules: [], selfNames: [] });
    expect(cfg.route.rules).toEqual([{ process_name: ['sing-box.exe'], outbound: 'direct' }]);
    expect(cfg.route.final).toBe('direct');
  });

  test('block 設定沿用同一 TUN inbound（gvisor / auto_route）', () => {
    const tun = mk().generateBlockConfig({ rules: [] }).inbounds[0];
    expect(tun.type).toBe('tun');
    expect(tun.stack).toBe('gvisor');
    expect(tun.auto_route).toBe(true);
    expect(tun.interface_name).toBe('proxyclient-tun');
  });
});

describe('SingBoxEngine start/startBlock 分派（不實際 spawn）', () => {
  test('start() 走一般設定、_blocking=false', async () => {
    const e = mk(); e.binPath = '/nonexistent-bin';
    let usedNormal = false; const o = e.generateConfig.bind(e); e.generateConfig = p => { usedNormal = true; return o(p); };
    await e.start({ rules: [], routes: [] });
    expect(usedNormal).toBe(true);
    expect(e._blocking).toBe(false);
  });
  test('startBlock() 走 block 設定、_blocking=true', async () => {
    const e = mk(); e.binPath = '/nonexistent-bin';
    let usedBlock = false; const o = e.generateBlockConfig.bind(e); e.generateBlockConfig = p => { usedBlock = true; return o(p); };
    await e.startBlock({ rules: [], selfNames: [] });
    expect(usedBlock).toBe(true);
    expect(e._blocking).toBe(true);
  });
  test('stop() 標記使用者主動停止（_userStopping=true）', async () => {
    const e = mk();
    await e.stop();
    expect(e._userStopping).toBe(true);
  });
});
