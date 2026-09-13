const SingBoxEngine = require('../src/engine/singbox');
const { forPlatform } = require('../src/platform');

// schema 2 的單一規則表：一條規則的 when 內各條件互為 AND。
// 固定注入 Windows adapter，讓斷言不受執行 CI 的 OS 影響。
const WIN = forPlatform('win32');
const mk = () => new SingBoxEngine({ platform: WIN });
const ROUTES = [
  { id: 'r1', kind: 'socks5', localPort: 10810 },
  { id: 'r2', kind: 'http', localPort: 10820 },
];
const SETS = [
  { tag: 'geoip-tw', path: 'C:/rs/geoip-tw.srs', format: 'binary' },
  { tag: 'geosite-ads', path: 'C:/rs/ads.json', format: 'source' },
];
const gen = (rules, extra = {}) => mk().generateConfig({ rules, ruleSets: SETS, routes: ROUTES, ...extra });
// 濾掉每份設定都有的 sniff、「自我 bypass」與內建的「本機與內網 → 直連」，只留下真正被測的規則
const LAN_FIRST = '127.0.0.0/8';
const isBuiltin = r => r.action === 'sniff'
  || (r.process_name || []).includes('sing-box.exe')
  || (r.ip_cidr || []).includes(LAN_FIRST);
const nonSelf = cfg => cfg.route.rules.filter(r => !isBuiltin(r));
// 好寫的規則工廠
const dest = (match, value, target = 'r1', extra = {}) => ({ id: 'x', on: true, target, when: { dest: { match, value } }, ...extra });

describe('目的地條件', () => {
  test('domain / suffix / keyword / regex 對應到 sing-box 欄位', () => {
    const cfg = gen([
      { id: 'a', on: true, target: 'r1', when: { dest: { match: 'domain', value: 'example.com' } } },
      { id: 'b', on: true, target: 'r1', when: { dest: { match: 'suffix', value: 'google.com' } } },
      { id: 'c', on: true, target: 'direct', when: { dest: { match: 'keyword', value: 'tracker' } } },
      { id: 'd', on: true, target: 'direct', when: { dest: { match: 'regex', value: '^ad\\d+\\.test$' } } },
    ]);
    expect(nonSelf(cfg)).toEqual([
      { domain: ['example.com'], outbound: 'route-r1' },
      { domain_suffix: ['google.com'], outbound: 'route-r1' },
      { domain_keyword: ['tracker'], outbound: 'direct' },
      { domain_regex: ['^ad\\d+\\.test$'], outbound: 'direct' },
    ]);
  });

  test('多值可用換行 / 逗號 / 分號分隔，前後空白與重複值會被清掉', () => {
    expect(nonSelf(gen([dest('suffix', ' a.com,\n b.com ; a.com ')]))[0].domain_suffix).toEqual(['a.com', 'b.com']);
  });

  test('suffix 允許寫成 *.example.com（開頭的萬用字元會被去掉）', () => {
    expect(nonSelf(gen([dest('suffix', '*.example.com')]))[0].domain_suffix).toEqual(['example.com']);
  });

  test('沒寫遮罩的 IP 自動補 /32（IPv6 補 /128）', () => {
    expect(nonSelf(gen([dest('ip', '8.8.8.8\n10.0.0.0/8\n2001:db8::1', 'direct')]))[0].ip_cidr)
      .toEqual(['8.8.8.8/32', '10.0.0.0/8', '2001:db8::1/128']);
  });

  test('存在網域條件才加 sniff（TUN 只看得到 IP，要嗅探才有網域可比對）', () => {
    expect(gen([dest('suffix', 'a.com')]).route.rules[0]).toEqual({ action: 'sniff' });
    expect(gen([dest('ip', '10.0.0.0/8', 'direct')]).route.rules[0]).not.toEqual({ action: 'sniff' });
  });
});

describe('規則庫（地區 / 分類）', () => {
  test('引用已安裝的規則庫 → 產生 rule_set 規則與 route.rule_set 本地宣告', () => {
    const cfg = gen([dest('ruleset', 'geoip-tw', 'direct')]);
    expect(nonSelf(cfg)).toEqual([{ rule_set: ['geoip-tw'], outbound: 'direct' }]);
    expect(cfg.route.rule_set).toEqual([{ type: 'local', tag: 'geoip-tw', format: 'binary', path: 'C:/rs/geoip-tw.srs' }]);
  });

  test('未安裝的規則庫 → 整條規則略過（引用不存在的 tag 會讓 sing-box FATAL）', () => {
    const cfg = gen([dest('ruleset', 'geoip-xx')]);
    expect(nonSelf(cfg)).toEqual([]);
    expect(cfg.route.rule_set).toBeUndefined();
  });

  test('未安裝的規則庫不會讓規則退化成「命中所有流量」', () => {
    // 這條規則同時有程式條件；規則庫沒下載時，整條都要消失，
    // 絕不能只留下 process_name 就把 chrome 全部送進代理。
    const cfg = gen([{ id: 'x', on: true, target: 'r1', when: { app: { match: 'name', value: 'chrome.exe' }, dest: { match: 'ruleset', value: 'geoip-xx' } } }]);
    expect(nonSelf(cfg)).toEqual([]);
  });

  test('只宣告真的被用到的規則庫', () => {
    expect(gen([dest('ruleset', 'geosite-ads', 'block')]).route.rule_set.map(s => s.tag)).toEqual(['geosite-ads']);
  });

  test('geosite 類要 sniff，geoip 類不用', () => {
    expect(gen([dest('ruleset', 'geosite-ads', 'block')]).route.rules[0]).toEqual({ action: 'sniff' });
    expect(gen([dest('ruleset', 'geoip-tw', 'direct')]).route.rules[0]).not.toEqual({ action: 'sniff' });
  });
});

describe('複合條件（一條規則 = 程式 × 目的地 × 埠 × 協定）', () => {
  test('多個條件 → logical/and；子條件順序為 app → dest → port → network', () => {
    const cfg = gen([{
      id: 'c', on: true, target: 'r1',
      when: { app: { match: 'name', value: 'chrome.exe' }, dest: { match: 'suffix', value: 'netflix.com' }, port: '443', network: 'tcp' },
    }]);
    expect(nonSelf(cfg)[0]).toEqual({
      type: 'logical', mode: 'and',
      rules: [
        { process_name: ['chrome.exe'] },
        { domain_suffix: ['netflix.com'] },
        { port: [443] },
        { network: ['tcp'] },
      ],
      outbound: 'route-r1',
    });
  });

  test('單一條件則攤平，不包成 logical（設定比較好讀）', () => {
    expect(nonSelf(gen([dest('suffix', 'a.com')]))[0]).toEqual({ domain_suffix: ['a.com'], outbound: 'route-r1' });
  });

  test('埠：單值、多值與範圍；破折號會轉成 sing-box 要的冒號式', () => {
    const cfg = gen([{ id: 'p', on: true, target: 'r1', when: { port: '443, 8443, 8000-9000, 100:200' } }]);
    expect(nonSelf(cfg)[0]).toEqual({ port: [443, 8443], port_range: ['8000:9000', '100:200'], outbound: 'route-r1' });
  });

  test('埠只有範圍時不產生空的 port 陣列', () => {
    expect(nonSelf(gen([{ id: 'p', on: true, target: 'r1', when: { port: '8000-9000' } }]))[0])
      .toEqual({ port_range: ['8000:9000'], outbound: 'route-r1' });
  });

  test('協定條件只接受 tcp / udp，亂寫會被忽略', () => {
    expect(nonSelf(gen([{ id: 'n', on: true, target: 'r1', when: { network: 'udp' } }]))[0])
      .toEqual({ network: ['udp'], outbound: 'route-r1' });
    expect(nonSelf(gen([{ id: 'n', on: true, target: 'r1', when: { network: 'sctp' } }]))).toEqual([]);
  });

  test('when 完全空的規則會被略過（要「全部」請用 defaultTarget）', () => {
    expect(nonSelf(gen([{ id: 'e', on: true, target: 'r1', when: {} }]))).toEqual([]);
    expect(nonSelf(gen([{ id: 'e', on: true, target: 'r1' }]))).toEqual([]);
  });

  test('值全空的條件不算條件', () => {
    expect(nonSelf(gen([{ id: 'e', on: true, target: 'r1', when: { app: { match: 'name', value: '   ' } } }]))).toEqual([]);
  });
});

describe('走向與順序', () => {
  test('target=block → action:reject（不是 outbound）', () => {
    expect(nonSelf(gen([dest('ruleset', 'geosite-ads', 'block')]))[0]).toEqual({ rule_set: ['geosite-ads'], action: 'reject' });
  });

  test('複合規則的 block 也是 action:reject', () => {
    const cfg = gen([{ id: 'b', on: true, target: 'block', when: { app: { match: 'name', value: 'x.exe' }, dest: { match: 'suffix', value: 'ads.com' } } }]);
    expect(nonSelf(cfg)[0]).toMatchObject({ type: 'logical', mode: 'and', action: 'reject' });
    expect(nonSelf(cfg)[0].outbound).toBeUndefined();
  });

  test('規則指到的路由才會產生 outbound；block 與 direct 不會', () => {
    const cfg = gen([dest('suffix', 'a.com', 'r2'), dest('suffix', 'b.com', 'block'), dest('suffix', 'c.com', 'direct')]);
    expect(cfg.outbounds.map(o => o.tag)).toEqual(['direct', 'route-r2']);
    expect(cfg.outbounds.find(o => o.tag === 'route-r2')).toMatchObject({ type: 'http', server_port: 10820 });
  });

  test('順序就是表的順序（不再有 app-first / net-first 開關）', () => {
    const rules = [
      { id: 'n', on: true, target: 'r2', when: { dest: { match: 'suffix', value: 'a.com' } } },
      { id: 'a', on: true, target: 'r1', when: { app: { match: 'name', value: 'chrome.exe' } } },
    ];
    expect(nonSelf(gen(rules)).map(r => Object.keys(r)[0])).toEqual(['domain_suffix', 'process_name']);
    expect(nonSelf(gen([...rules].reverse())).map(r => Object.keys(r)[0])).toEqual(['process_name', 'domain_suffix']);
  });

  test('on 未指定視為啟用（只有明確 false 才停用）', () => {
    expect(nonSelf(gen([{ id: 'a', target: 'r1', when: { app: { match: 'name', value: 'x.exe' } } }]))).toHaveLength(1);
    expect(nonSelf(gen([{ id: 'a', on: false, target: 'r1', when: { app: { match: 'name', value: 'x.exe' } } }]))).toHaveLength(0);
  });
});

describe('generateBlockConfig — 斷線保護', () => {
  test('原本走代理的規則（含複合、含網域）→ reject；直連的不動', () => {
    const cfg = mk().generateBlockConfig({
      rules: [
        { id: 'a', on: true, target: 'r1', when: { app: { match: 'name', value: 'chrome.exe' } } },
        { id: 'b', on: true, target: 'direct', when: { dest: { match: 'suffix', value: 'b.com' } } },
        { id: 'c', on: true, target: 'r1', when: { dest: { match: 'ruleset', value: 'geoip-tw' } } },
        { id: 'd', on: true, target: 'block', when: { app: { match: 'name', value: 'x.exe' }, dest: { match: 'suffix', value: 'a.com' } } },
      ],
      ruleSets: SETS,
    });
    expect(nonSelf(cfg)).toEqual([
      { process_name: ['chrome.exe'], action: 'reject' },
      { rule_set: ['geoip-tw'], action: 'reject' },
      { type: 'logical', mode: 'and', rules: [{ process_name: ['x.exe'] }, { domain_suffix: ['a.com'] }], action: 'reject' },
    ]);
    expect(cfg.route.rule_set.map(s => s.tag)).toEqual(['geoip-tw']);
    expect(cfg.route.final).toBe('direct');
  });

  test('MERGE §6 受保護程式：指定程式時只擋這幾支，規則表不再參與', () => {
    const cfg = mk().generateBlockConfig({
      rules: [
        { id: 'a', on: true, target: 'r1', when: { app: { match: 'name', value: 'chrome.exe' } } },
        { id: 'c', on: true, target: 'r1', when: { dest: { match: 'ruleset', value: 'geoip-tw' } } },
      ],
      ruleSets: SETS,
      scopeApps: ['firefox.exe', 'Code.exe'],
    });
    // 只一條：擋選定的程式。chrome.exe 雖然在規則表裡，但不在名單上 → 照常上網
    expect(nonSelf(cfg)).toEqual([{ process_name: ['firefox.exe', 'Code.exe'], action: 'reject' }]);
    // 沒用到規則條件，就不該還拉 rule-set 進來
    expect(cfg.route.rule_set || []).toEqual([]);
    expect(cfg.route.final).toBe('direct');
  });

  test('MERGE §6：全域模式下指定程式，不再用 catch-all 擋全部', () => {
    const cfg = mk().generateBlockConfig({ rules: [], mode: 'global', scopeApps: ['firefox.exe'] });
    expect(nonSelf(cfg)).toEqual([{ process_name: ['firefox.exe'], action: 'reject' }]);
  });

  test('MERGE §6：名單空的時候與原本行為一致', () => {
    const args = { rules: [{ id: 'a', on: true, target: 'r1', when: { app: { match: 'name', value: 'chrome.exe' } } }] };
    const a = mk().generateBlockConfig(args);
    const b = mk().generateBlockConfig({ ...args, scopeApps: [] });
    const c = mk().generateBlockConfig({ ...args, scopeApps: ['  ', ''] });   // 只有空白也算沒選
    expect(nonSelf(b)).toEqual(nonSelf(a));
    expect(nonSelf(c)).toEqual(nonSelf(a));
  });

  test('內網保護在指定程式模式下也要排在前面', () => {
    const cfg = mk().generateBlockConfig({ rules: [], scopeApps: ['firefox.exe'], lanDirect: true });
    const idx = cfg.route.rules.findIndex(r => r.ip_cidr);
    const rej = cfg.route.rules.findIndex(r => r.action === 'reject');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(rej);
  });

  test('沒有任何要保護的規則 → 只剩自我 bypass', () => {
    const cfg = mk().generateBlockConfig({ rules: [{ id: 'b', on: true, target: 'direct', when: { app: { match: 'name', value: 'a.exe' } } }], selfNames: ['RelayClient.exe'] });
    expect(nonSelf(cfg)).toEqual([]);
  });
});

describe('matchTarget — 規則模擬器', () => {
  const e = mk();
  const rules = [
    { id: 'c1', on: true, name: 'Chrome 看 Netflix', target: 'r-jp', when: { app: { match: 'name', value: 'chrome.exe' }, dest: { match: 'suffix', value: 'netflix.com' } } },
    { id: 'n1', on: true, name: 'Google', target: 'r2', when: { dest: { match: 'suffix', value: 'google.com' } } },
    { id: 'n2', on: true, name: '內網', target: 'direct', when: { dest: { match: 'ip', value: '10.0.0.0/8' } } },
    { id: 'n3', on: true, name: '廣告', target: 'block', when: { dest: { match: 'keyword', value: 'doubleclick' } } },
    { id: 'p1', on: true, name: 'QUIC', target: 'block', when: { port: '443', network: 'udp' } },
  ];
  const q = extra => ({ rules, defaultTarget: 'r1', ...extra });

  test('複合規則要所有條件都中才命中', async () => {
    await expect(e.matchTarget(q({ host: 'www.netflix.com', exe: 'C:\\p\\chrome.exe' }))).resolves.toMatchObject({ ruleId: 'c1', by: 'composite', target: 'r-jp' });
    // 網域對但程式不對 → 這條不算，往下找（netflix 沒有其他規則 → 回預設）
    await expect(e.matchTarget(q({ host: 'www.netflix.com', exe: 'C:\\p\\firefox.exe' }))).resolves.toMatchObject({ matched: false, target: 'r1' });
    // 程式對但網域不對
    await expect(e.matchTarget(q({ host: 'example.com', exe: 'C:\\p\\chrome.exe' }))).resolves.toMatchObject({ matched: false });
  });

  test('只有目的地條件的規則，不需要提供程式也能命中', async () => {
    await expect(e.matchTarget(q({ host: 'mail.google.com' }))).resolves.toMatchObject({ ruleId: 'n1', by: 'net', target: 'r2' });
    await expect(e.matchTarget(q({ host: 'notgoogle.com' }))).resolves.toMatchObject({ matched: false });
  });

  test('IP 落在 CIDR 內才命中', async () => {
    // 關掉內建保護才能單獨驗使用者規則的 CIDR 比對（開著的話 10/8 會先被內建規則吃掉）
    await expect(e.matchTarget(q({ host: '10.5.1.2', lanDirect: false }))).resolves.toMatchObject({ ruleId: 'n2', target: 'direct' });
    await expect(e.matchTarget(q({ host: '11.5.1.2' }))).resolves.toMatchObject({ matched: false });
  });

  test('內建「本機與內網」排在使用者規則之前（和引擎一致）', async () => {
    const lanRules = [{ id: 'x1', on: true, name: '全部走代理', target: 'r-jp', when: { dest: { match: 'ip', value: '0.0.0.0/0' } } }];
    // 引擎把 PRIVATE_CIDRS 推在 route.rules 最前面，模擬器必須给出同樣的答案
    await expect(e.matchTarget({ rules: lanRules, defaultTarget: 'r1', host: '192.168.1.10' }))
      .resolves.toMatchObject({ matched: true, builtin: true, target: 'direct' });
    await expect(e.matchTarget({ rules: lanRules, defaultTarget: 'r1', host: '127.0.0.1' }))
      .resolves.toMatchObject({ builtin: true, target: 'direct' });
    // 停用內建保護時就該落回使用者規則
    await expect(e.matchTarget({ rules: lanRules, defaultTarget: 'r1', host: '192.168.1.10', lanDirect: false }))
      .resolves.toMatchObject({ ruleId: 'x1', target: 'r-jp' });
    // 公網 IP 不受影響
    await expect(e.matchTarget({ rules: lanRules, defaultTarget: 'r1', host: '8.8.8.8' }))
      .resolves.toMatchObject({ ruleId: 'x1', target: 'r-jp' });
  });

  test('關鍵字 → 封鎖', async () => {
    await expect(e.matchTarget(q({ host: 'ads.doubleclick.net' }))).resolves.toMatchObject({ ruleId: 'n3', target: 'block' });
  });

  test('埠 + 協定條件（QUIC）', async () => {
    await expect(e.matchTarget(q({ host: 'x.tld', port: 443, network: 'udp' }))).resolves.toMatchObject({ ruleId: 'p1', target: 'block' });
    await expect(e.matchTarget(q({ host: 'x.tld', port: 443, network: 'tcp' }))).resolves.toMatchObject({ matched: false });
    await expect(e.matchTarget(q({ host: 'x.tld', port: 80, network: 'udp' }))).resolves.toMatchObject({ matched: false });
  });

  test('沒命中任何規則 → 回到預設走向', async () => {
    await expect(e.matchTarget(q({ host: 'nothing.tld' }))).resolves.toEqual(
      expect.objectContaining({ matched: false, by: 'default', target: 'r1', ruleName: '其他所有流量' })
    );
  });

  test('先命中先贏：把 Google 那條排到複合規則前面就換它贏', async () => {
    const reordered = [rules[1], rules[0], ...rules.slice(2)];
    await expect(e.matchTarget({ rules: reordered, defaultTarget: 'r1', host: 'www.google.com', exe: 'C:\\p\\chrome.exe' }))
      .resolves.toMatchObject({ ruleId: 'n1' });
  });

  test('停用的規則不參與比對', async () => {
    const off = rules.map(r => ({ ...r, on: false }));
    await expect(e.matchTarget({ rules: off, defaultTarget: 'r1', host: 'mail.google.com' })).resolves.toMatchObject({ matched: false });
  });

  test('detail 會說明命中的是哪些條件', async () => {
    const r = await e.matchTarget(q({ host: 'www.netflix.com', exe: 'C:\\p\\chrome.exe' }));
    expect(r.detail).toBe('process_name=chrome.exe AND domain_suffix=netflix.com');
  });
});

describe('內建保護規則：本機與內網 → 直連', () => {
  const lanOf = cfg => cfg.route.rules.find(r => (r.ip_cidr || []).includes('127.0.0.0/8'));

  test('預設開啟，涵蓋 loopback / RFC1918 / link-local / CGNAT / multicast / IPv6', () => {
    const lan = lanOf(gen([]));
    expect(lan.outbound).toBe('direct');
    expect(lan.ip_cidr).toEqual([
      '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
      '169.254.0.0/16', '100.64.0.0/10', '224.0.0.0/4', '255.255.255.255/32',
      '::1/128', 'fc00::/7', 'fe80::/10',
    ]);
  });

  test('排在自我 bypass 之後、使用者規則之前（否則寬鬆規則會把內網搶走）', () => {
    const cfg = gen([{ id: 'a', on: true, target: 'r1', when: { app: { match: 'name', value: 'chrome.exe' } } }],
      { selfNames: ['RelayClient.exe'] });
    const idx = cfg.route.rules.findIndex(r => (r.ip_cidr || []).includes('127.0.0.0/8'));
    const selfIdx = cfg.route.rules.findIndex(r => (r.process_name || []).includes('sing-box.exe'));
    const userIdx = cfg.route.rules.findIndex(r => (r.process_name || []).includes('chrome.exe'));
    expect(selfIdx).toBeLessThan(idx);
    expect(idx).toBeLessThan(userIdx);
  });

  test('lanDirect:false 就完全不產生這條規則', () => {
    expect(lanOf(gen([], { lanDirect: false }))).toBeUndefined();
  });

  test('斷線保護模式同樣保留它（否則 catch-all 會把內網一起切斷）', () => {
    const cfg = mk().generateBlockConfig({ rules: [], mode: 'global', selfNames: ['RelayClient.exe'] });
    const idx = cfg.route.rules.findIndex(r => (r.ip_cidr || []).includes('127.0.0.0/8'));
    const rejectIdx = cfg.route.rules.findIndex(r => r.action === 'reject');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(rejectIdx);   // 保護要排在 catch-all 之前
  });
});

describe('三種模式：規則 / 全域 / 直連', () => {
  const RULES = [
    { id: 'a', on: true, target: 'r1', when: { app: { match: 'name', value: 'chrome.exe' } } },
    { id: 'b', on: true, target: 'block', when: { dest: { match: 'suffix', value: 'ads.com' } } },
  ];

  test('規則模式（預設）：照規則表，final = 預設走向', () => {
    const cfg = gen(RULES, { defaultTarget: 'r2' });
    expect(nonSelf(cfg)).toHaveLength(2);
    expect(cfg.route.final).toBe('route-r2');
    expect(cfg._mode).toBe('rule');
  });

  test('全域模式：規則表整個不參與，final = 指定路由', () => {
    const cfg = gen(RULES, { mode: 'global', globalTarget: 'r2', defaultTarget: 'r1' });
    expect(nonSelf(cfg)).toEqual([]);
    expect(cfg.route.final).toBe('route-r2');
    // 只建全域那條路由的 outbound，規則表用到的不建
    expect(cfg.outbounds.map(o => o.tag)).toEqual(['direct', 'route-r2']);
    expect(cfg.route.rule_set).toBeUndefined();
  });

  test('全域模式仍保留自我 bypass 與內網保護', () => {
    const cfg = gen(RULES, { mode: 'global', globalTarget: 'r2', selfNames: ['RelayClient.exe'] });
    expect(cfg.route.rules[0].process_name).toContain('RelayClient.exe');
    expect(cfg.route.rules[1].ip_cidr).toContain('127.0.0.0/8');
    expect(cfg.route.rules).toHaveLength(2);
  });

  test('全域模式沒指定路由 → 退回 direct，不產生無效 outbound', () => {
    const cfg = gen(RULES, { mode: 'global', globalTarget: null });
    expect(cfg.route.final).toBe('direct');
    expect(cfg.outbounds).toEqual([{ type: 'direct', tag: 'direct' }]);
  });

  test('直連模式：TUN 還在，但沒有任何規則、final = direct', () => {
    const cfg = gen(RULES, { mode: 'direct', defaultTarget: 'r1' });
    expect(nonSelf(cfg)).toEqual([]);
    expect(cfg.route.final).toBe('direct');
    expect(cfg.outbounds).toEqual([{ type: 'direct', tag: 'direct' }]);
    expect(cfg.inbounds[0].type).toBe('tun');   // 虛擬網卡仍在 → 提權不會白費、斷線保護仍可用
  });

  test('非規則模式不需要 sniff（沒有網域條件要比對）', () => {
    const withDomain = [{ id: 'd', on: true, target: 'r1', when: { dest: { match: 'suffix', value: 'a.com' } } }];
    expect(gen(withDomain).route.rules[0]).toEqual({ action: 'sniff' });
    expect(gen(withDomain, { mode: 'global', globalTarget: 'r1' }).route.rules[0]).not.toEqual({ action: 'sniff' });
    expect(gen(withDomain, { mode: 'direct' }).route.rules[0]).not.toEqual({ action: 'sniff' });
  });
});

describe('斷線保護 × 模式', () => {
  const RULES = [
    { id: 'a', on: true, target: 'r1', when: { app: { match: 'name', value: 'chrome.exe' } } },
    { id: 'b', on: true, target: 'direct', when: { app: { match: 'name', value: 'safe.exe' } } },
  ];
  const blk = extra => mk().generateBlockConfig({ rules: RULES, selfNames: ['RelayClient.exe'], ...extra });

  test('規則模式：只擋原本走代理的，直連的不動', () => {
    const cfg = blk({ mode: 'rule' });
    expect(nonSelf(cfg)).toEqual([{ process_name: ['chrome.exe'], action: 'reject' }]);
  });

  test('全域模式：本來全部走代理 → catch-all 全擋', () => {
    const cfg = blk({ mode: 'global' });
    expect(nonSelf(cfg)).toEqual([{ inbound: ['tun-in'], action: 'reject' }]);
  });

  test('直連模式：本來就沒流量走代理 → 沒有東西要擋', () => {
    expect(nonSelf(blk({ mode: 'direct' }))).toEqual([]);
  });
});

describe('網域條件的 = 前綴（v8 設計：預設含子網域，= 表示完全相符）', () => {
  test('不加 = → domain_suffix；加 = → domain；混寫兩者同時出現', () => {
    expect(nonSelf(gen([dest('suffix', 'google.com')]))[0])
      .toEqual({ domain_suffix: ['google.com'], outbound: 'route-r1' });
    expect(nonSelf(gen([dest('suffix', '=login.example.com')]))[0])
      .toEqual({ domain: ['login.example.com'], outbound: 'route-r1' });
    expect(nonSelf(gen([dest('suffix', 'google.com\n=login.example.com')]))[0])
      .toEqual({ domain: ['login.example.com'], domain_suffix: ['google.com'], outbound: 'route-r1' });
  });

  test('= 後面仍可寫 *.（一併去掉）；只有 = 的空值不算條件', () => {
    expect(nonSelf(gen([dest('suffix', '=*.a.com')]))[0]).toEqual({ domain: ['a.com'], outbound: 'route-r1' });
    expect(nonSelf(gen([dest('suffix', '=')]))).toEqual([]);
  });

  test('模擬器：= 只命中完全相符，不含子網域', async () => {
    const rules = [{ id: 'x', on: true, target: 'r1', when: { dest: { match: 'suffix', value: '=login.example.com' } } }];
    await expect(mk().matchTarget({ rules, host: 'login.example.com', defaultTarget: 'direct' })).resolves.toMatchObject({ matched: true });
    await expect(mk().matchTarget({ rules, host: 'a.login.example.com', defaultTarget: 'direct' })).resolves.toMatchObject({ matched: false });
  });

  test('模擬器：混寫時兩種都能命中（OR）', async () => {
    const rules = [{ id: 'x', on: true, target: 'r1', when: { dest: { match: 'suffix', value: 'google.com\n=login.example.com' } } }];
    const m = h => mk().matchTarget({ rules, host: h, defaultTarget: 'direct' });
    await expect(m('mail.google.com')).resolves.toMatchObject({ matched: true });
    await expect(m('login.example.com')).resolves.toMatchObject({ matched: true });
    await expect(m('other.example.com')).resolves.toMatchObject({ matched: false });
  });
});
