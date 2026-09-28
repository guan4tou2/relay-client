const {
  esc, fmtBytes, validPortStr, validPortSpec, validIpOrCidr, testFailReason,
  fmtAge, thinSeries, splitVals, parseImportFile, normalizeImportedRoute,
} = require('../renderer/js/lib');

// renderer/js/lib.js：畫面端不碰 DOM 的純邏輯。以前埋在 4000 行的 renderer.js 裡，完全沒有測試。

describe('esc', () => {
  test('HTML 特殊字元全部跳脫（伺服器名稱、路由名稱都會進 innerHTML）', () => {
    expect(esc(`<img src=x onerror="a('b')">&`)).toBe('&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  });
  test('null / undefined 變空字串，數字轉字串', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc(1080)).toBe('1080');
  });
});

describe('fmtBytes', () => {
  test('單位換算', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(1023)).toBe('1023 B');
    expect(fmtBytes(1024)).toBe('1.0 KB');
    expect(fmtBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(fmtBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });
  test('超過 GB 仍用 GB，不會跑出 undefined 單位', () => {
    expect(fmtBytes(5 * 1024 ** 4)).toBe('5120.0 GB');
  });
});

describe('validPortStr（本地端口）', () => {
  test.each([['1', true], ['1080', true], ['65535', true], ['0', false], ['65536', false], ['99999', false], ['', false], ['10 80', false], ['1e3', false], ['-1', false]])('%s → %s', (v, ok) => {
    expect(validPortStr(v)).toBe(ok);
  });
});

describe('validPortSpec（規則的埠條件）', () => {
  test.each([
    ['443', true], ['443, 80', true], ['3000-3999', true], ['80, 3000 - 3999', true],
    ['0', false], ['99999', false], ['4000-3000', false], ['80,', false], ['a', false], ['1-2-3', false],
  ])('%s → %s', (v, ok) => expect(validPortSpec(v)).toBe(ok));
});

describe('validIpOrCidr', () => {
  test.each([
    ['8.8.8.8', true], ['10.0.0.0/8', true], ['0.0.0.0/0', true], ['192.168.1.1/32', true],
    ['999.1.1.1', false], ['10.0.0.0/33', false], ['10.0.0', false], ['10.0.0.0/8/1', false],
    ['::1', true], ['fe80::/10', true], ['2001:db8::1/128', true], ['2001:db8::/129', false], ['gggg::1', false],
    ['example.com', false],
  ])('%s → %s', (v, ok) => expect(validIpOrCidr(v)).toBe(ok));
});

describe('testFailReason（把錯誤原文翻成一句人話）', () => {
  test.each([
    ['connect ECONNREFUSED 1.2.3.4:1080', '連線被拒'],
    ['Connection timeout', '逾時'],
    ['getaddrinfo ENOTFOUND proxy.example', '找不到主機'],
    ['self-signed certificate in certificate chain', '憑證無法驗證'],
    ['socket hang up', '連線被中斷'],
    ['HTTP/1.1 407 Proxy Authentication Required', '驗證失敗'],
    ['connect EHOSTUNREACH', '網路無法到達'],
    ['something else', ''],
    ['', ''],
  ])('%s → %s', (m, r) => expect(testFailReason(m)).toBe(r));
});

describe('fmtAge', () => {
  const now = Date.UTC(2026, 8, 28, 12);
  const day = 86400000;
  test.each([
    [0, '未知'], [now - 1000, '今天更新'], [now - day, '昨天更新'], [now - 5 * day, '5 天前更新'], [now - 65 * day, '2 個月前更新'],
  ])('%s → %s', (ts, s) => expect(fmtAge(ts, now)).toBe(s));
  test('時間在未來（時鐘不準）也當成今天，不會出現負數天', () => {
    expect(fmtAge(now + 3 * day, now)).toBe('今天更新');
  });
});

describe('thinSeries（速率圖降採樣）', () => {
  test('點數不超過上限就原樣回傳', () => {
    const pts = [{ down: 1, up: 2 }];
    expect(thinSeries(pts, 10)).toBe(pts);
  });
  test('壓縮成 n 點，每桶取最大值 —— 突波不會被平均掉', () => {
    const pts = Array.from({ length: 1000 }, () => ({ down: 0, up: 0 }));
    pts[517] = { down: 999, up: 5 };
    const out = thinSeries(pts, 280);
    expect(out).toHaveLength(280);
    expect(Math.max(...out.map(p => p.down))).toBe(999);
  });
});

describe('splitVals（規則條件的多值欄位）', () => {
  test('換行、逗號、分號都能分隔，前後空白與空項去掉', () => {
    expect(splitVals(' a.com,\nb.com ;; c.com\n')).toEqual(['a.com', 'b.com', 'c.com']);
  });
  test('陣列也吃；null 變空陣列', () => {
    expect(splitVals([' x ', '', 'y'])).toEqual(['x', 'y']);
    expect(splitVals(null)).toEqual([]);
  });
});

describe('parseImportFile', () => {
  test('新格式：{ servers, routes }；缺 host / port 的伺服器丟掉', () => {
    const r = parseImportFile({ servers: [{ host: 'a', port: 1 }, { host: 'b' }, null], routes: [{ id: 'r1' }] });
    expect(r).toEqual({ servers: [{ host: 'a', port: 1 }], routes: [{ id: 'r1' }] });
  });
  test('舊格式：整個是伺服器陣列、沒有路由', () => {
    expect(parseImportFile([{ host: 'a', port: 1 }])).toEqual({ servers: [{ host: 'a', port: 1 }], routes: [] });
  });
  test('檔案內容是 null、字串、或欄位型別不對 → 空的，不丟例外', () => {
    for (const bad of [null, 'x', 42, { servers: 'nope', routes: { a: 1 } }]) {
      expect(parseImportFile(bad)).toEqual({ servers: [], routes: [] });
    }
  });
});

describe('normalizeImportedRoute（匯入的路由存檔前整理）', () => {
  const ctx = (over = {}) => ({ idMap: new Map([['old-s1', 's1']]), known: new Set(['s1', 's2']), fallbackId: 'r-fallback', ...over });

  test('合格的路由：跳點對回本機伺服器', () => {
    expect(normalizeImportedRoute({ id: 'r1', label: 'JP', localPort: '10808', kind: 'http', hops: ['old-s1', 's2'] }, ctx())).toEqual({
      route: { id: 'r1', label: 'JP', localPort: 10808, kind: 'http', hops: ['s1', 's2'], enabled: true }, lostHops: 0,
    });
  });

  test('對不回去的跳點拿掉並計數（舊版匯出檔沒有伺服器 id）', () => {
    const n = normalizeImportedRoute({ id: 'r1', localPort: 1080, hops: ['ghost', 's2', 'ghost2'] }, ctx());
    expect(n.route.hops).toEqual(['s2']);
    expect(n.lostHops).toBe(2);
  });

  test('id 會變成 profile 目錄名：含 .. 或路徑字元的換成新 id', () => {
    for (const id of ['../../x', 'a/b', 'C:\\Windows', 'x'.repeat(65)]) {
      expect(normalizeImportedRoute({ id, localPort: 1080 }, ctx()).route.id).toBe('r-fallback');
    }
    expect(normalizeImportedRoute({ id: 'r-ok_1', localPort: 1080 }, ctx()).route.id).toBe('r-ok_1');
  });

  test('埠或類型不合格 → bad', () => {
    for (const r of [{ id: 'r', localPort: 0 }, { id: 'r', localPort: 70000 }, { id: 'r', localPort: 'abc' }, { id: 'r', localPort: 1080, kind: 'socks4' }]) {
      expect(normalizeImportedRoute(r, ctx())).toEqual({ bad: true });
    }
  });

  test('沒有 id → 整筆忽略；enabled 預設 true、明確 false 保留；缺 kind 補 socks5', () => {
    expect(normalizeImportedRoute({ localPort: 1080 }, ctx())).toBe(null);
    expect(normalizeImportedRoute(null, ctx())).toBe(null);
    const n = normalizeImportedRoute({ id: 'r', localPort: 1080, enabled: false }, ctx());
    expect(n.route.enabled).toBe(false);
    expect(n.route.kind).toBe('socks5');
    expect(n.route.label).toBe('');
  });
});
