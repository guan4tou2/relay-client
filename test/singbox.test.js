const SingBoxEngine = require('../src/engine/singbox');
const { forPlatform } = require('../src/platform');

// generateConfig 是純函式（不啟動 TUN、不需 binary），可完整單元測試分流設定生成邏輯。
// 固定注入 Windows adapter，讓 sing-box.exe / proxyclient-tun 這些斷言在任何 OS 的 CI 上都成立
// （各平台的差異本身由 test/platform.test.js 負責）。
const WIN = forPlatform('win32');
const mk = () => new SingBoxEngine({ platform: WIN });
// 每份設定都會有的內建規則：sniff、自我 bypass、「本機與內網 → 直連」
const isBuiltinLan = r => (r.ip_cidr || []).includes('127.0.0.0/8');
const isHijackDns = r => r.action === 'hijack-dns';
const userRules = cfg => cfg.route.rules.filter(r => !isBuiltinLan(r) && !isHijackDns(r));
const ROUTES = [
  { id: 'r1', kind: 'socks5', localPort: 10810 },
  { id: 'r2', kind: 'http', localPort: 10820 },
];

describe('DNS 設定', () => {
  const SB = require('../src/engine/singbox');
  const gen = (dnsServers) => new SB().generateConfig({ rules: [], ruleSets: [], defaultTarget: 'direct', routes: [], mode: 'direct', dnsServers });

  test('用傳進來的系統 DNS 當上游，不自己讀系統清單', () => {
    const cfg = gen(['10.0.0.53', '10.0.0.54']);
    expect(cfg.dns.servers.map(x => x.server)).toEqual(['10.0.0.53', '10.0.0.54']);
    // 不能加 detour：sing-box 啟動時會 FATAL（detour to an empty direct outbound）
    expect(cfg.dns.servers.every(x => x.detour === undefined)).toBe(true);
    expect(cfg.dns.final).toBe(cfg.dns.servers[0].tag);
  });

  test('沒拉到系統 DNS 時用公開解析器當退路，不能留空', () => {
    for (const v of [undefined, [], [null, '']]) {
      const cfg = gen(v);
      expect(cfg.dns.servers.length).toBeGreaterThan(0);
      expect(cfg.dns.servers.every(x => x.detour === undefined)).toBe(true);
    }
  });

  test('route 要指定 default_domain_resolver（1.14 起沒寫會報錯）', () => {
    const cfg = gen(['10.0.0.53']);
    expect(cfg.route.default_domain_resolver).toBe(cfg.dns.final);
    const blk = new SB().generateBlockConfig({ rules: [], dnsServers: ['10.0.0.53'] });
    expect(blk.route.default_domain_resolver).toBe(blk.dns.final);
  });

  test('一定要有 dns 區塊 —— 沒有的話 auto_route 把 DNS 導到 TUN 上，查詢會進黑洞', () => {
    for (const cfg of [
      new SB().generateConfig({ rules: [], ruleSets: [], defaultTarget: 'direct', routes: [], mode: 'direct' }),
      new SB().generateBlockConfig({ rules: [] }),
    ]) {
      expect(cfg.dns).toBeTruthy();
      expect(cfg.dns.servers.length).toBeGreaterThan(0);
      expect(cfg.dns.final).toBe(cfg.dns.servers[0].tag);
    }
  });

  test('用 1.12 的新 server 格式（舊格式 1.14 會被移除）', () => {
    const cfg = new SB().generateConfig({ rules: [], ruleSets: [], defaultTarget: 'direct', routes: [], mode: 'direct' });
    expect(cfg.dns.servers[0].type).toBe('udp');
    expect(cfg.dns.servers[0].address).toBeUndefined();   // 舊格式的 address 欄位不該再出現
  });
});

describe('DNS 拦截', () => {
  const SB = require('../src/engine/singbox');
  const gen = (o = {}) => new SB().generateConfig({ rules: [], ruleSets: [], defaultTarget: 'direct', routes: [], mode: 'direct', dnsServers: ['1.1.1.1'], ...o });

  test('一定要有 hijack-dns，否則查詢只是普通封包，會被內網規則抓走進黑洞', () => {
    const rules = gen().route.rules;
    expect(rules.some(r => r.action === 'hijack-dns')).toBe(true);
  });

  test('hijack 要排在內網規則之前 —— TUN 位址 172.19.0.2 落在 172.16.0.0/12 裡', () => {
    const rules = gen().route.rules;
    const hj = rules.findIndex(r => r.action === 'hijack-dns');
    const lan = rules.findIndex(r => Array.isArray(r.ip_cidr));
    expect(hj).toBeGreaterThanOrEqual(0);
    expect(lan).toBeGreaterThanOrEqual(0);
    expect(hj).toBeLessThan(lan);
  });

  test('hijack 要排在自我 bypass 之後 —— 否則 sing-box 問上游 DNS 也會被拦，就迴圈了', () => {
    const rules = gen({ selfNames: ['RelayClient.exe'] }).route.rules;
    const self = rules.findIndex(r => Array.isArray(r.process_name));
    const hj = rules.findIndex(r => r.action === 'hijack-dns');
    expect(self).toBeGreaterThanOrEqual(0);
    expect(self).toBeLessThan(hj);
  });

  test('封鎖模式也要有 —— 未被保護的程式還要能上網', () => {
    const cfg = new SB().generateBlockConfig({ rules: [], dnsServers: ['1.1.1.1'] });
    expect(cfg.route.rules.some(r => r.action === 'hijack-dns')).toBe(true);
  });

  test('ruleIndex 要跟 route.rules 逐項對齊（命中標記靠它）', () => {
    const e = new SB();
    const cfg = e.generateConfig({ rules: [{ id: 'r1', on: true, target: 'direct', when: { dest: { match: 'suffix', value: 'a.com' } } }],
      ruleSets: [], defaultTarget: 'direct', routes: [], selfNames: ['x'], mode: 'rule', lanDirect: true, dnsServers: ['1.1.1.1'] });
    expect(e.ruleIndex.length).toBe(cfg.route.rules.length);
    const hj = cfg.route.rules.findIndex(r => r.action === 'hijack-dns');
    expect(e.ruleIndex[hj].kind).toBe('dns');
  });
});

describe('TUN MTU', () => {
  test('不能用 sing-box 預設的 9000 —— 一般出口是 1500 或更低，9000 會讓 TLS 半路被重置', () => {
    const SB = require('../src/engine/singbox');
    const cfg = new SB().generateConfig({ rules: [], ruleSets: [], defaultTarget: 'direct', routes: [], mode: 'direct' });
    const mtu = cfg.inbounds[0].mtu;
    expect(mtu).toBeLessThanOrEqual(1500);
    expect(mtu).toBeGreaterThanOrEqual(1280);   // 低於 IPv6 最小 MTU 就太小了
  });
});

describe('SingBoxEngine.generateConfig — 基本結構', () => {
  test('空規則 → 只有 direct outbound、final=direct、僅剩 sing-box 自我 bypass', () => {
    const cfg = mk().generateConfig({ rules: [], defaultTarget: 'direct', routes: ROUTES });
    expect(cfg.outbounds).toEqual([{ type: 'direct', tag: 'direct' }]);
    expect(cfg.route.final).toBe('direct');
    // sing-box.exe 自我 bypass 一律存在（防迴圈）；不應有任何 app 規則
    expect(userRules(cfg)).toEqual([{ process_name: ['sing-box.exe'], outbound: 'direct' }]);
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
    const cfg = mk().generateConfig({ rules: [{ on: true, when: { app: { match: 'name', value: 'chrome.exe' } }, target: 'r1' }], routes: ROUTES });
    expect(cfg.outbounds.find(o => o.tag === 'route-r1')).toMatchObject({
      type: 'socks', server: '127.0.0.1', server_port: 10810, version: '5',
    });
  });

  test('http route → type http、無 version', () => {
    const cfg = mk().generateConfig({ rules: [{ on: true, when: { app: { match: 'name', value: 'x.exe' } }, target: 'r2' }], routes: ROUTES });
    const ob = cfg.outbounds.find(o => o.tag === 'route-r2');
    expect(ob).toMatchObject({ type: 'http', server_port: 10820 });
    expect(ob.version).toBeUndefined();
  });

  test('只建立被引用的 route（未引用者不出現）', () => {
    const cfg = mk().generateConfig({ rules: [{ on: true, when: { app: { match: 'name', value: 'chrome.exe' } }, target: 'r1' }], routes: ROUTES });
    expect(cfg.outbounds.find(o => o.tag === 'route-r1')).toBeTruthy();
    expect(cfg.outbounds.find(o => o.tag === 'route-r2')).toBeUndefined();
  });

  test('同一 route 被多條規則引用 → outbound 去重僅一份', () => {
    const cfg = mk().generateConfig({
      rules: [
        { on: true, when: { app: { match: 'name', value: 'a.exe' } }, target: 'r1' },
        { on: true, when: { app: { match: 'name', value: 'b.exe' } }, target: 'r1' },
      ], routes: ROUTES,
    });
    expect(cfg.outbounds.filter(o => o.tag === 'route-r1')).toHaveLength(1);
  });
});

describe('SingBoxEngine.generateConfig — 規則導向', () => {
  test('exe 規則 → process_name 導向對應 route', () => {
    const cfg = mk().generateConfig({ rules: [{ on: true, when: { app: { match: 'name', value: 'chrome.exe' } }, target: 'r1' }], routes: ROUTES });
    const rule = cfg.route.rules.find(r => r.process_name && r.process_name.includes('chrome.exe'));
    expect(rule.outbound).toBe('route-r1');
  });

  test('match=path 規則 → 用 process_path', () => {
    const cfg = mk().generateConfig({ rules: [{ on: true, when: { app: { match: 'path', value: 'C:\\a\\b.exe' } }, target: 'r1' }], routes: ROUTES });
    expect(cfg.route.rules.find(r => r.process_path)).toEqual({ process_path: ['C:\\a\\b.exe'], outbound: 'route-r1' });
  });

  test('關閉的規則(on:false) → 不產生 app rule 也不建 outbound（僅剩 self bypass）', () => {
    const cfg = mk().generateConfig({ rules: [{ on: false, when: { app: { match: 'name', value: 'chrome.exe' } }, target: 'r1' }], routes: ROUTES });
    expect(userRules(cfg)).toEqual([{ process_name: ['sing-box.exe'], outbound: 'direct' }]);
    expect(cfg.outbounds.find(o => o.tag === 'route-r1')).toBeUndefined();
  });

  test('target=direct 的規則 → 導 direct、不建 outbound', () => {
    const cfg = mk().generateConfig({ rules: [{ on: true, when: { app: { match: 'name', value: 'chrome.exe' } }, target: 'direct' }], routes: ROUTES });
    expect(cfg.route.rules.find(r => r.process_name && r.process_name.includes('chrome.exe')).outbound).toBe('direct');
    expect(cfg.outbounds).toEqual([{ type: 'direct', tag: 'direct' }]);
  });

  test('target 指向不存在的 route → 當成 direct（防無效 outbound）', () => {
    const cfg = mk().generateConfig({ rules: [{ on: true, when: { app: { match: 'name', value: 'chrome.exe' } }, target: 'ghost' }], routes: ROUTES });
    expect(cfg.route.rules.find(r => r.process_name && r.process_name.includes('chrome.exe')).outbound).toBe('direct');
    expect(cfg.outbounds.find(o => o.tag === 'route-ghost')).toBeUndefined();
  });
});

describe('SingBoxEngine.generateConfig — 防迴圈 self bypass', () => {
  test('selfNames + sing-box.exe 一律 bypass，且排在 app 規則之前', () => {
    const cfg = mk().generateConfig({
      rules: [{ on: true, when: { app: { match: 'name', value: 'chrome.exe' } }, target: 'r1' }],
      routes: ROUTES, selfNames: ['RelayClient.exe'],
    });
    expect(cfg.route.rules[0]).toMatchObject({ outbound: 'direct' });
    expect(cfg.route.rules[0].process_name).toEqual(expect.arrayContaining(['RelayClient.exe', 'sing-box.exe']));
    // 用相對順序而不是寫死索引：中間可能再插內建規則（例如 hijack-dns）
    const iSelf = cfg.route.rules.findIndex(r => (r.process_name || []).includes('sing-box.exe'));
    const iLan = cfg.route.rules.findIndex(r => (r.ip_cidr || []).includes('127.0.0.0/8'));
    const iUser = cfg.route.rules.findIndex(r => (r.process_name || []).includes('chrome.exe'));
    expect(cfg.route.rules[iLan]).toMatchObject({ outbound: 'direct' });
    expect(iSelf).toBeLessThan(iLan);
    expect(iLan).toBeLessThan(iUser);
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
        { on: true, when: { app: { match: 'name', value: 'chrome.exe' } }, target: 'r1' },
        { on: true, when: { app: { match: 'path', value: 'C:\\x\\y.exe' } }, target: 'r2' },
        { on: true, when: { app: { match: 'name', value: 'safe.exe' } }, target: 'direct' }, // 原本直連 → 不擋
        { on: false, when: { app: { match: 'name', value: 'off.exe' } }, target: 'r1' },      // 關閉 → 不擋
      ],
      selfNames: ['RelayClient.exe'],
    });
    expect(cfg.route.rules[0].outbound).toBe('direct'); // self bypass 第一條
    expect(cfg.route.rules[0].process_name).toEqual(expect.arrayContaining(['RelayClient.exe', 'sing-box.exe']));
    // 封鎖模式也保留內網保護，且要在 self bypass 之後
    const iLanB = cfg.route.rules.findIndex(r => (r.ip_cidr || []).includes('127.0.0.0/8'));
    expect(iLanB).toBeGreaterThan(0);
    expect(cfg.route.rules).toContainEqual({ process_name: ['chrome.exe'], action: 'reject' });
    expect(cfg.route.rules).toContainEqual({ process_path: ['C:\\x\\y.exe'], action: 'reject' });
    expect(cfg.route.rules.find(r => r.process_name && r.process_name.includes('safe.exe'))).toBeUndefined();
    expect(cfg.route.rules.find(r => r.process_name && r.process_name.includes('off.exe'))).toBeUndefined();
    expect(cfg.route.final).toBe('direct');
    expect(cfg.outbounds).toEqual([{ type: 'direct', tag: 'direct' }]);
    expect(cfg._blocking).toBe(true);
  });

  test('_forEngine 去掉底線內部欄位（否則 sing-box check unknown field → kill-switch 失效）', () => {
    const e = mk();
    const clean = e._forEngine(e.generateBlockConfig({ rules: [{ on: true, when: { app: { match: 'name', value: 'chrome.exe' } }, target: 'r1' }], selfNames: ['RelayClient.exe'] }));
    expect(clean._blocking).toBeUndefined();
    expect(clean._udp).toBeUndefined();
    expect(clean.route).toBeDefined();        // 正常欄位保留
    expect(clean.inbounds[0].type).toBe('tun');
  });

  test('無規則 → 只有 self bypass（不誤擋整機）', () => {
    const cfg = mk().generateBlockConfig({ rules: [], selfNames: [] });
    expect(userRules(cfg)).toEqual([{ process_name: ['sing-box.exe'], outbound: 'direct' }]);
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
