const { Launcher } = require('../src/launcher');

// 假的 platform：只回目錄，存不存在由 _exists 的 stub 決定
const platform = {
  path: require('path').win32,   // 這個假 adapter 模擬 Windows，路徑語意就要固定成 win32
  browserCandidates: () => [
    { name: 'Chrome', path: 'C:\\PF\\Google\\Chrome\\Application\\chrome.exe' },
    { name: 'Chrome', path: 'C:\\PFx86\\Google\\Chrome\\Application\\chrome.exe' },
    { name: 'Edge', path: 'C:\\PF\\Microsoft\\Edge\\Application\\msedge.exe' },
    { name: 'Firefox', path: 'C:\\PF\\Mozilla Firefox\\firefox.exe' },
  ],
  killTree: jest.fn(),
};

function mk(present = ['C:\\PFx86\\Google\\Chrome\\Application\\chrome.exe', 'C:\\PF\\Microsoft\\Edge\\Application\\msedge.exe']) {
  const L = new Launcher({ platform, userDataDir: 'C:\\UD', log: () => {}, onChange: () => {} });
  L._exists = (p) => present.includes(p);
  return L;
}

const ROUTE = { id: 'r1', label: '中華網分', kind: 'socks' };

describe('Launcher — 瀏覽器清單', () => {
  test('同名只留第一個「真的存在」的路徑；沒裝的仍列出但 found=false', () => {
    const list = mk().browsers();
    expect(list.map(b => [b.name, b.found])).toEqual([
      ['Chrome', true], ['Edge', true], ['Firefox', false],
    ]);
    // Chrome 有兩個候選路徑，要挑存在的那個（PFx86），不是目錄裡的第一個
    expect(list.find(b => b.name === 'Chrome').path).toContain('PFx86');
  });

  test('一個都沒裝時全部 found=false', () => {
    expect(mk([]).browsers().every(b => !b.found)).toBe(true);
  });
});

describe('Launcher — 啟動參數', () => {
  test('SOCKS 路由用 socks5://，HTTP 路由用 http://', () => {
    const L = mk();
    expect(L.browserArgs({ route: ROUTE, localPort: 1081 })[0]).toBe('--proxy-server=socks5://127.0.0.1:1081');
    expect(L.browserArgs({ route: { ...ROUTE, kind: 'http' }, localPort: 8080 })[0]).toBe('--proxy-server=http://127.0.0.1:8080');
  });

  test('防漏參數預設都在（少了就會從真實 IP 洩漏 DNS / WebRTC）', () => {
    const args = mk().browserArgs({ route: ROUTE, localPort: 1081 }).join(' ');
    expect(args).toContain('--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1');
    expect(args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
  });

  test('profile 目錄依 routeId 隔離，且會把不安全的字元換掉', () => {
    const L = mk();
    // 寫死 win32 結果，不要用執行主機的 path.join——那會讓這條測試在 Linux 上假性失敗
    expect(L.profileDir('r1')).toBe('C:\\UD\\browser-profiles\\r1');
    expect(L.profileDir('a/b:c')).toBe('C:\\UD\\browser-profiles\\a_b_c');
  });

  test('關掉 profile / dnsGuard 時對應參數就不出現', () => {
    const args = mk().browserArgs({ route: ROUTE, localPort: 1081, profile: false, dnsGuard: false }).join(' ');
    expect(args).not.toContain('--user-data-dir');
    expect(args).not.toContain('host-resolver-rules');
  });
});

describe('Launcher — 將執行預覽', () => {
  test('預覽和實際啟動用同一份參數，不會對不上', () => {
    const L = mk();
    const preview = L.preview({ mode: 'browser', route: ROUTE, localPort: 1081, browserName: 'Chrome' });
    for (const a of L.browserArgs({ route: ROUTE, localPort: 1081 })) expect(preview).toContain(a);
    expect(preview.startsWith('chrome.exe ')).toBe(true);
  });

  test('其他程式模式會講明是登記成規則，不是「只有這次」', () => {
    const p = mk().preview({ mode: 'program', route: ROUTE, localPort: 1081, exePath: 'C:\\Tools\\app.exe', exeArgs: '-x' });
    expect(p).toContain('C:\\Tools\\app.exe -x');
    expect(p).toContain('登記程式規則');
  });

  test('沒選東西時不要吐半截指令', () => {
    const L = mk();
    expect(L.preview({ mode: 'program', route: ROUTE, localPort: 1081 })).toBe('（尚未選擇程式）');
  });
});

describe('Launcher — 路徑語意跟 adapter，不跟執行主機', () => {
  test('在任何 OS 上都能正確拆出 Windows 路徑的檔名', () => {
    const L = mk();
    expect(L.preview({ mode: 'browser', route: ROUTE, localPort: 1081, browserName: 'Chrome' }).startsWith('chrome.exe ')).toBe(true);
  });

  test('POSIX adapter 則用 POSIX 語意', () => {
    const posixPlatform = {
      path: require('path').posix,
      browserCandidates: () => [{ name: 'Chromium', path: '/usr/bin/chromium' }],
      killTree: () => {},
    };
    const L = new Launcher({ platform: posixPlatform, userDataDir: '/home/u/.config/RelayClient' });
    L._exists = () => true;
    expect(L.profileDir('r1')).toBe('/home/u/.config/RelayClient/browser-profiles/r1');
    expect(L.preview({ mode: 'browser', route: ROUTE, localPort: 1081, browserName: 'Chromium' }).startsWith('chromium ')).toBe(true);
  });
});

describe('Launcher — 實例登記與結束', () => {
  test('找不到指定的瀏覽器就不啟動，也不會留下實例', () => {
    const L = mk();
    const r = L.launchBrowser({ route: ROUTE, localPort: 1081, browserName: 'Firefox' });
    expect(r.ok).toBe(false);
    expect(L.list()).toEqual([]);
  });

  test('一個都沒裝時的錯誤訊息要講得出是哪個問題', () => {
    const r = mk([]).launchBrowser({ route: ROUTE, localPort: 1081 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('找不到');
  });

  test('kill 會呼叫 platform.killTree 並把列拿掉；重複 kill 不會炸', () => {
    const L = mk();
    const inst = L._add({ name: 'Chrome', exe: 'chrome.exe', mode: 'browser', routeId: 'r1', pid: 4242 });
    expect(L.list()).toHaveLength(1);
    platform.killTree.mockClear();
    expect(L.kill(inst.id).ok).toBe(true);
    expect(platform.killTree).toHaveBeenCalledWith(4242);
    expect(L.list()).toEqual([]);
    expect(L.kill(inst.id).ok).toBe(false);
  });

  test('onChange 在新增與結束時都會被通知（UI 靠它更新）', () => {
    const seen = [];
    const L = new Launcher({ platform, userDataDir: 'C:\\UD', onChange: l => seen.push(l.length) });
    L._exists = () => true;
    const a = L._add({ name: 'A', mode: 'browser', routeId: 'r1', pid: 1 });
    L._add({ name: 'B', mode: 'engine', routeId: 'r1', pid: 2 });
    L.kill(a.id);
    expect(seen).toEqual([1, 2, 1]);
  });

  test('實例 id 不重複（同一毫秒連開兩個也不會撞）', () => {
    const L = mk();
    const ids = [L._add({ name: 'A', pid: 1 }).id, L._add({ name: 'B', pid: 2 }).id];
    expect(new Set(ids).size).toBe(2);
  });
});
