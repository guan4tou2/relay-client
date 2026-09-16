// 更新裝完之後，pending 底下那支一百多 MB 的安裝檔會一直留著。
// 實測過它不會害使用者「關掉 app 又裝一次」（安裝程式沒跑、exe 時間沒變），
// 所以不是功能問題，是磁碟浪費。
//
// 這個模組刪的是別的模組（electron-updater）管的檔案，所以每一條
// 判斷不出來的路都要選擇「不動手」。下面大半的測試守的就是這件事。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { cacheDirFrom, versionFromFileName, notNewerThan, clearStaleUpdateCache } = require('../src/update-cache');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upcache-')); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });

function makeCache(fileName, extra = ['current.blockmap']) {
  const pending = path.join(tmp, 'cache', 'pending');
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, 'update-info.json'), JSON.stringify({ fileName, sha512: 'x' }));
  if (fileName) fs.writeFileSync(path.join(pending, fileName), 'installer bytes');
  for (const f of extra) fs.writeFileSync(path.join(pending, f), 'x');
  return path.join(tmp, 'cache');
}
const pendingFiles = (dir) => fs.readdirSync(path.join(dir, 'pending')).sort();

describe('cacheDirFrom：快取目錄只從 app-update.yml 讀', () => {
  const yml = (body) => { const p = path.join(tmp, 'app-update.yml'); fs.writeFileSync(p, body); return p; };

  test('讀得到 updaterCacheDirName', () => {
    const p = yml('owner: guan4tou2\nrepo: relay-client\nprovider: github\nupdaterCacheDirName: socks5-client-updater\n');
    expect(cacheDirFrom(p, 'C:\\LOCAL')).toBe(path.join('C:\\LOCAL', 'socks5-client-updater'));
  });

  test('檔案不存在 → null（寧可不清，也不要亂猜一個目錄去刪東西）', () => {
    expect(cacheDirFrom(path.join(tmp, 'nope.yml'), 'C:\\LOCAL')).toBeNull();
  });

  test('沒有那個欄位 → null', () => {
    expect(cacheDirFrom(yml('owner: x\nrepo: y\n'), 'C:\\LOCAL')).toBeNull();
  });

  test('值帶路徑分隔符就拒絕（不讓它指到別的地方去）', () => {
    expect(cacheDirFrom(yml('updaterCacheDirName: ../../Windows\n'), 'C:\\LOCAL')).toBeNull();
    expect(cacheDirFrom(yml('updaterCacheDirName: a/b\n'), 'C:\\LOCAL')).toBeNull();
  });

  test('沒有 LOCALAPPDATA → null', () => {
    expect(cacheDirFrom(yml('updaterCacheDirName: x\n'), undefined)).toBeNull();
  });
});

describe('versionFromFileName', () => {
  test('取得出安裝檔名裡的版本', () => {
    expect(versionFromFileName('RelayClient-Setup-1.3.4.exe')).toBe('1.3.4');
    expect(versionFromFileName('RelayClient-Portable-10.20.30.exe')).toBe('10.20.30');
  });
  test('看不懂就回 null', () => {
    expect(versionFromFileName('installer.exe')).toBeNull();
    expect(versionFromFileName('')).toBeNull();
    expect(versionFromFileName(null)).toBeNull();
  });
});

describe('notNewerThan', () => {
  test('舊的與一樣的都算「不比現在新」', () => {
    expect(notNewerThan('1.3.4', '1.3.4')).toBe(true);
    expect(notNewerThan('1.3.1', '1.3.4')).toBe(true);
    expect(notNewerThan('1.2.9', '1.3.0')).toBe(true);
    expect(notNewerThan('0.9.9', '1.0.0')).toBe(true);
  });
  test('比較新的不算', () => {
    expect(notNewerThan('1.3.5', '1.3.4')).toBe(false);
    expect(notNewerThan('2.0.0', '1.9.9')).toBe(false);
  });
  test('比不出來一律回 false（＝不清）', () => {
    expect(notNewerThan('1.3', '1.3.4')).toBe(false);
    expect(notNewerThan('abc', '1.3.4')).toBe(false);
    expect(notNewerThan('1.3.4', '')).toBe(false);
  });
});

describe('clearStaleUpdateCache', () => {
  test('待安裝的版本＝已安裝的版本 → 整個 pending 清掉', () => {
    const dir = makeCache('RelayClient-Setup-1.3.4.exe');
    const removed = clearStaleUpdateCache(dir, '1.3.4');
    expect(removed.sort()).toEqual(['RelayClient-Setup-1.3.4.exe', 'update-info.json'].sort());
    // .blockmap 留著：那是下次差分更新的依據，只有 0.1 MB，刪掉要多抓一百多 MB
    expect(pendingFiles(dir)).toEqual(['current.blockmap']);
  });

  test('待安裝的比已安裝的舊 → 也清（那是更早以前留下的）', () => {
    const dir = makeCache('RelayClient-Setup-1.3.1.exe');
    expect(clearStaleUpdateCache(dir, '1.3.4').length).toBeGreaterThan(0);
  });

  test('待安裝的比較新 → 一個都不能動（那是還沒裝的更新）', () => {
    const dir = makeCache('RelayClient-Setup-1.4.0.exe');
    expect(clearStaleUpdateCache(dir, '1.3.4')).toEqual([]);
    expect(pendingFiles(dir)).toHaveLength(3);
  });

  test('檔名看不出版本 → 不動', () => {
    const dir = makeCache('installer.exe');
    expect(clearStaleUpdateCache(dir, '1.3.4')).toEqual([]);
    expect(pendingFiles(dir)).toHaveLength(3);
  });

  test('update-info.json 壞掉 → 不動、不拋錯', () => {
    const dir = makeCache('RelayClient-Setup-1.3.4.exe');
    fs.writeFileSync(path.join(dir, 'pending', 'update-info.json'), '{ 這不是 json');
    expect(() => clearStaleUpdateCache(dir, '1.3.4')).not.toThrow();
    expect(pendingFiles(dir).length).toBeGreaterThan(0);
  });

  test('沒有 pending 目錄 / 沒有參數 → 回空陣列，不拋錯', () => {
    expect(clearStaleUpdateCache(path.join(tmp, 'nope'), '1.3.4')).toEqual([]);
    expect(clearStaleUpdateCache(null, '1.3.4')).toEqual([]);
    expect(clearStaleUpdateCache(path.join(tmp, 'cache'), '')).toEqual([]);
  });

  // 快取根目錄的 installer.exe 是 electron-updater 執行安裝前搬過去的複本，
  // 跟 pending 裡那支一樣大（各一百多 MB），裝完也是死的。
  test('快取根目錄那兩個已知的殘留也收掉', () => {
    const dir = makeCache('RelayClient-Setup-1.3.4.exe');
    fs.writeFileSync(path.join(dir, 'installer.exe'), 'x');
    fs.writeFileSync(path.join(dir, 'current.blockmap'), 'x');
    const removed = clearStaleUpdateCache(dir, '1.3.4');
    expect(removed).toContain('installer.exe');
    expect(removed).not.toContain('current.blockmap');
    expect(fs.readdirSync(dir).sort()).toEqual(['current.blockmap', 'pending']);
  });

  test('只刪自己認得的檔名，其他一律不碰', () => {
    const dir = makeCache('RelayClient-Setup-1.3.4.exe');
    fs.writeFileSync(path.join(dir, 'installer.exe'), 'x');
    fs.writeFileSync(path.join(dir, '別人的東西.dat'), 'x');
    fs.mkdirSync(path.join(dir, 'somedir'));
    clearStaleUpdateCache(dir, '1.3.4');
    expect(fs.readdirSync(dir).sort()).toEqual(['pending', 'somedir', '別人的東西.dat'].sort());
  });

  test('待安裝的比較新時，根目錄那兩個也不能動（安裝可能正要跑）', () => {
    const dir = makeCache('RelayClient-Setup-1.4.0.exe');
    fs.writeFileSync(path.join(dir, 'installer.exe'), 'x');
    expect(clearStaleUpdateCache(dir, '1.3.4')).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'installer.exe'))).toBe(true);
  });
});

// 一輪走完之後 pending 會是空的，下次再呼叫就會在第一關退出 ——
// 根目錄那支一百多 MB 的 installer.exe 就永遠收不到了。
describe('沒有待安裝資訊時的根目錄殘留', () => {
  test('沒有 update-info.json → 根目錄那兩個是孤兒，收掉', () => {
    const dir = path.join(tmp, 'cache');
    fs.mkdirSync(path.join(dir, 'pending'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'installer.exe'), 'x');
    fs.writeFileSync(path.join(dir, 'current.blockmap'), 'x');
    const removed = clearStaleUpdateCache(dir, '1.3.4');
    expect(removed).toEqual(['installer.exe']);
    expect(fs.readdirSync(dir).sort()).toEqual(['current.blockmap', 'pending']);
  });

  test('快取目錄根本不存在 → 什麼都不做，也不建目錄', () => {
    const dir = path.join(tmp, 'nope');
    expect(clearStaleUpdateCache(dir, '1.3.4')).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  test('這條路一樣只刪自己認得的檔名', () => {
    const dir = path.join(tmp, 'cache');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'installer.exe'), 'x');
    fs.writeFileSync(path.join(dir, '別人的東西.dat'), 'x');
    clearStaleUpdateCache(dir, '1.3.4');
    expect(fs.readdirSync(dir)).toEqual(['別人的東西.dat']);
  });
});
