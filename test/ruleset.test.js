const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { RuleSetStore, CATALOG } = require('../src/engine/ruleset');

// 規則庫管理：目錄、下載（httpsGet 注入假實作，測試不連網）、匯入、更新、移除、交給引擎的形狀。
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-test-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

// 假的 https.get：回傳指定 status/body，並記錄請求過的 host/path
function fakeHttps(reply) {
  const calls = [];
  const get = (opts, cb) => {
    calls.push(opts);
    const r = typeof reply === 'function' ? reply(opts, calls.length) : reply;
    const res = Readable.from([Buffer.from(r.body || '')]);
    res.statusCode = r.status || 200;
    res.headers = r.headers || {};
    setImmediate(() => cb(res));
    return { on: () => {}, destroy: () => {} };
  };
  get.calls = calls;
  return get;
}

const mk = (get) => new RuleSetStore({ dir, httpsGet: get });

describe('內建目錄（catalog）', () => {
  test('包含地區(GeoIP)與網站分類(GeoSite)，且來源都是 https 的 .srs', () => {
    const c = mk().catalog();
    expect(c.length).toBe(CATALOG.length);
    expect(c.some(x => x.kind === 'geoip')).toBe(true);
    expect(c.some(x => x.kind === 'geosite')).toBe(true);
    for (const x of c) expect(x.url).toMatch(/^https:\/\/raw\.githubusercontent\.com\/.+\.srs$/);
  });

  test('目錄是複本，改它不會污染共用常數', () => {
    mk().catalog()[0].label = 'HACKED';
    expect(mk().catalog()[0].label).not.toBe('HACKED');
  });
});

describe('下載安裝', () => {
  test('install 寫檔＋寫 index，list 回報大小與 sha256', async () => {
    const s = mk(fakeHttps({ body: 'SRS-DATA' }));
    const r = await s.install('geoip-tw');
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'geoip-tw.srs'), 'utf8')).toBe('SRS-DATA');
    const [e] = s.list();
    expect(e).toMatchObject({ tag: 'geoip-tw', kind: 'geoip', bytes: 8, source: 'catalog', missing: false, format: 'binary' });
    expect(e.sha256).toHaveLength(64);
  });

  test('目錄裡沒有的 tag → 明確錯誤，不會發出請求', async () => {
    const get = fakeHttps({ body: 'x' });
    const r = await mk(get).install('geoip-mars');
    expect(r.ok).toBe(false);
    expect(get.calls).toHaveLength(0);
  });

  test('HTTP 非 200 → 失敗且不留下檔案', async () => {
    const s = mk(fakeHttps({ status: 404 }));
    const r = await s.install('geoip-tw');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/404/);
    expect(s.list()).toEqual([]);
  });

  test('跟隨轉址', async () => {
    const get = fakeHttps((o, n) => n === 1
      ? { status: 302, headers: { location: 'https://objects.githubusercontent.com/blob' } }
      : { body: 'AFTER-REDIRECT' });
    const s = mk(get);
    expect((await s.install('geoip-tw')).ok).toBe(true);
    expect(get.calls[1].hostname).toBe('objects.githubusercontent.com');
    expect(fs.readFileSync(path.join(dir, 'geoip-tw.srs'), 'utf8')).toBe('AFTER-REDIRECT');
  });

  test('轉址到白名單外的網域 → 拒絕下載', async () => {
    const s = mk(fakeHttps({ status: 302, headers: { location: 'https://evil.example.com/x.srs' } }));
    const r = await s.install('geoip-tw');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/不允許的下載來源/);
  });

  test('重覆安裝同一個 tag 只留一筆（覆蓋不重複）', async () => {
    const s = mk(fakeHttps({ body: 'v1' }));
    await s.install('geoip-tw');
    await s.install('geoip-tw');
    expect(s.list()).toHaveLength(1);
  });
});

describe('匯入本機檔案（離線路徑）', () => {
  const write = (name, body) => { const p = path.join(dir, '..', name); fs.writeFileSync(p, body); return p; };

  test('匯入 .json 規則庫 → format 為 source', () => {
    const p = write('my-set.json', '{"version":3,"rules":[]}');
    const s = mk();
    const r = s.importFile(p);
    expect(r.ok).toBe(true);
    expect(s.get('my-set')).toMatchObject({ format: 'source', source: 'import' });
    fs.unlinkSync(p);
  });

  test('.json 內容不是合法 JSON → 拒絕', () => {
    const p = write('bad.json', '{oops');
    expect(mk().importFile(p).ok).toBe(false);
    fs.unlinkSync(p);
  });

  test('副檔名不支援 → 拒絕', () => {
    const p = write('x.txt', 'hi');
    expect(mk().importFile(p).error).toMatch(/只支援/);
    fs.unlinkSync(p);
  });

  test('tag 含路徑字元 → 拒絕（避免路徑穿越）', () => {
    const p = write('ok.srs', 'bin');
    expect(mk().importFile(p, { tag: '../../evil' }).ok).toBe(false);
    fs.unlinkSync(p);
  });

  test('匯入的規則庫沒有更新來源，update 會明講', async () => {
    const p = write('mine.srs', 'bin');
    const s = mk(fakeHttps({ body: 'x' }));
    s.importFile(p);
    expect((await s.update('mine')).error).toMatch(/重新匯入/);
    fs.unlinkSync(p);
  });
});

describe('更新與移除', () => {
  test('update 覆蓋檔案並推進 updatedAt', async () => {
    const s = mk(fakeHttps((o, n) => ({ body: n === 1 ? 'v1' : 'v2-longer' })));
    await s.install('geoip-tw');
    const before = s.get('geoip-tw');
    await new Promise(r => setTimeout(r, 5));
    expect((await s.update('geoip-tw')).ok).toBe(true);
    const after = s.get('geoip-tw');
    expect(fs.readFileSync(after.path, 'utf8')).toBe('v2-longer');
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
    expect(after.sha256).not.toBe(before.sha256);
  });

  test('尚未安裝就 update → 錯誤', async () => {
    expect((await mk(fakeHttps({ body: 'x' })).update('geoip-tw')).ok).toBe(false);
  });

  test('updateAll 跳過手動匯入的項目', async () => {
    const p = path.join(dir, '..', 'imp.srs');
    fs.writeFileSync(p, 'bin');
    const s = mk(fakeHttps({ body: 'v' }));
    await s.install('geoip-tw');
    s.importFile(p);
    const res = await s.updateAll();
    expect(res.map(r => r.tag)).toEqual(['geoip-tw']);
    fs.unlinkSync(p);
  });

  test('remove 同時刪檔與索引', async () => {
    const s = mk(fakeHttps({ body: 'v' }));
    await s.install('geoip-tw');
    s.remove('geoip-tw');
    expect(s.list()).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'geoip-tw.srs'))).toBe(false);
  });
});

describe('交給引擎的形狀（resolveForEngine）', () => {
  test('只回傳被引用且檔案還在的規則庫', async () => {
    const s = mk(fakeHttps({ body: 'v' }));
    await s.install('geoip-tw');
    await s.install('geoip-jp');
    expect(s.resolveForEngine(['geoip-tw', 'geoip-xx']).map(x => x.tag)).toEqual(['geoip-tw']);
    // 檔案被手動刪掉 → 標記 missing 且不再交給引擎（否則 sing-box 會 FATAL）
    fs.unlinkSync(path.join(dir, 'geoip-tw.srs'));
    expect(s.get('geoip-tw').missing).toBe(true);
    expect(s.resolveForEngine(['geoip-tw'])).toEqual([]);
  });

  test('索引檔壞掉時退回空清單，不丟例外', () => {
    fs.writeFileSync(path.join(dir, 'index.json'), 'not json');
    expect(mk().list()).toEqual([]);
  });
});
