const { forPlatform, isSupported, PLATFORMS } = require('../src/platform');
const SingBoxEngine = require('../src/engine/singbox');

// 平台適配層。重點：組指令 / 解析輸出都是純函式，所以 macOS 與 Linux 的邏輯
// 可以在 Windows 的 CI 上完整測到，不需要那些機器。
const win = forPlatform('win32');
const mac = forPlatform('darwin');
const lin = forPlatform('linux');

describe('adapter 契約（三個平台必須長一樣）', () => {
  const REQUIRED = [
    'id', 'label', 'engineBinName', 'selfProcessNames', 'isElevated', 'engineElevation',
    'staleEngineCleanupCommand', 'killTree', 'exeFilters', 'listProcesses',
    'normalizeApp', 'appNameEquals', 'systemProxy', 'autostart', 'browserCandidates',
  ];

  test.each(PLATFORMS)('%s 實作了完整介面', (name) => {
    const p = forPlatform(name);
    for (const k of REQUIRED) expect(p[k]).toBeDefined();
    for (const fn of ['isElevated', 'staleEngineCleanupCommand', 'killTree', 'listProcesses', 'normalizeApp', 'appNameEquals', 'browserCandidates']) {
      expect(typeof p[fn]).toBe('function');
    }
    for (const fn of ['get', 'enable', 'disable']) expect(typeof p.systemProxy[fn]).toBe('function');
    expect(Array.isArray(p.selfProcessNames)).toBe(true);
    expect(p.selfProcessNames.length).toBeGreaterThan(0);
    // tunInterfaceName 允許是 null（macOS 的 utun 由核心命名）
    expect(['string', 'object']).toContain(typeof p.tunInterfaceName);
  });

  test('未知平台會明確拋錯，不是回一個半殘的物件', () => {
    expect(() => forPlatform('plan9')).toThrow(/不支援的平台/);
    expect(isSupported('plan9')).toBe(false);
    expect(isSupported('win32')).toBe(true);
  });

  test('三個平台的 id 不重複且對得上', () => {
    expect([win.id, mac.id, lin.id]).toEqual(['win32', 'darwin', 'linux']);
  });
});

describe('Windows adapter', () => {
  test('引擎執行檔帶 .exe，TUN 介面名可自訂', () => {
    expect(win.engineBinName).toBe('sing-box.exe');
    expect(win.tunInterfaceName).toBe('proxyclient-tun');
    expect(win.selfProcessNames).toEqual(['sing-box.exe']);
  });

  test('提權是「整個 app 用 UAC 重啟」，路徑裡的單引號有被跳脫', () => {
    expect(win.engineElevation.strategy).toBe('relaunch-app');
    const { cmd, args } = win.engineElevation.relaunchCommand("C:\\Bob's App\\R.exe", ['--engine-autostart']);
    expect(cmd).toBe('powershell.exe');
    expect(args[args.length - 1]).toContain("Bob''s App");   // ' → '' 才不會提早結束字串
    expect(args[args.length - 1]).toContain('-Verb RunAs');
  });

  test('清殘留只針對自己那支 sing-box 的完整路徑（不會誤殺別家的）', () => {
    const c = win.staleEngineCleanupCommand('C:\\app\\engine\\sing-box.exe');
    expect(c.args[c.args.length - 1]).toContain("ExecutablePath -eq 'C:\\app\\engine\\sing-box.exe'");
    expect(c.args[c.args.length - 1]).not.toContain('/IM');
  });

  test('行程清單解析：去重（不分大小寫）、補 exe 欄位、依名稱排序', () => {
    const out = win.parseProcessList(JSON.stringify([
      { Name: 'zeta', Id: 3, Path: 'C:\\x\\zeta.exe' },
      { Name: 'chrome', Id: 1, Path: 'C:\\x\\chrome.exe' },
      { Name: 'chrome', Id: 2, Path: 'C:\\X\\CHROME.EXE' },
    ]));
    expect(out.map(p => p.name)).toEqual(['chrome', 'zeta']);
    expect(out[0].exe).toBe('chrome.exe');
  });

  test('單一物件（PowerShell 只有一個行程時不會給陣列）也吃得下', () => {
    expect(win.parseProcessList(JSON.stringify({ Name: 'a', Id: 1, Path: 'C:\\a.exe' }))).toHaveLength(1);
  });

  test('壞掉的 JSON 回空陣列，不丟例外', () => {
    expect(win.parseProcessList('not json')).toEqual([]);
  });

  test('程式名比對不分大小寫；normalizeApp 產生小寫名與去副檔名的顯示名', () => {
    expect(win.appNameEquals('Chrome.EXE', 'chrome.exe')).toBe(true);
    expect(win.normalizeApp('C:\\x\\Chrome.exe')).toEqual({
      type: 'executable', name: 'chrome.exe', label: 'Chrome', path: 'C:\\x\\Chrome.exe',
    });
  });
});

describe('macOS adapter', () => {
  test('執行檔無副檔名；TUN 介面名交給核心（utun 不能自訂）', () => {
    expect(mac.engineBinName).toBe('sing-box');
    expect(mac.tunInterfaceName).toBeNull();
    expect(mac.selfProcessNames).toEqual(['sing-box']);
  });

  test('TUN 提權標為 unsupported，且說明講清楚原因與替代方案', () => {
    expect(mac.engineElevation.strategy).toBe('unsupported');
    const msg = mac.engineElevation.instructions();
    expect(msg).toMatch(/root/);
    expect(msg).toMatch(/本地端口路由與多層串接不受影響/);
  });

  test('osascript 提權指令的雙引號有跳脫', () => {
    const { cmd, args } = mac.engineElevation.adminShellCommand('/usr/bin/foo "bar"');
    expect(cmd).toBe('osascript');
    expect(args[1]).toContain('\\"bar\\"');
    expect(args[1]).toContain('with administrator privileges');
  });

  test('networksetup 服務清單：跳過第一行說明、排除前綴 * 的停用服務', () => {
    const out = mac._internal.parseNetworkServices(
      'An asterisk (*) denotes that a network service is disabled.\nWi-Fi\n*Bluetooth PAN\nThunderbolt Bridge\n'
    );
    expect(out).toEqual(['Wi-Fi', 'Thunderbolt Bridge']);
  });

  test('getwebproxy 輸出解析', () => {
    expect(mac._internal.parseWebProxy('Enabled: Yes\nServer: 127.0.0.1\nPort: 10808\n'))
      .toEqual({ enabled: true, server: '127.0.0.1:10808' });
    expect(mac._internal.parseWebProxy('Enabled: No\nServer:\nPort: 0\n'))
      .toEqual({ enabled: false, server: '' });
  });

  test('.app bundle 取 bundle 名當顯示名稱，而不是執行檔名', () => {
    expect(mac._internal.appLabel('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')).toBe('Google Chrome');
    expect(mac._internal.appLabel('/usr/bin/curl')).toBe('curl');
  });

  test('ps 輸出解析：略過沒有絕對路徑的核心行程', () => {
    const out = mac.parseProcessList('    1 /sbin/launchd\n  501 kernel_task\n  777 /Applications/Foo.app/Contents/MacOS/Foo\n');
    expect(out.map(p => p.name)).toEqual(['Foo', 'launchd']);
    expect(out.find(p => p.name === 'Foo').pid).toBe(777);
  });
});

describe('Linux adapter', () => {
  test('TUN 提權走 setcap，不需要用 root 跑整個 app', () => {
    expect(lin.engineElevation.strategy).toBe('setcap');
    expect(lin.engineElevation.setcapCommand('/opt/r/sing-box'))
      .toBe('sudo setcap cap_net_admin,cap_net_bind_service+ep "/opt/r/sing-box"');
    expect(lin.engineElevation.instructions('/opt/r/sing-box')).toContain('setcap');
  });

  test('getcap 輸出判斷是否已授權', () => {
    expect(lin._internal.parseGetcap('/opt/r/sing-box cap_net_admin,cap_net_bind_service=ep')).toBe(true);
    expect(lin._internal.parseGetcap('')).toBe(false);
  });

  test('gsettings 的值會去掉外層單引號', () => {
    expect(lin._internal.parseProxyState("'manual'", "'127.0.0.1'", '10808'))
      .toEqual({ enabled: true, server: '127.0.0.1:10808' });
    expect(lin._internal.parseProxyState("'none'", "'127.0.0.1'", '10808'))
      .toEqual({ enabled: false, server: '' });
  });

  test('程式名比對大小寫敏感（Linux 檔名本來就分大小寫）', () => {
    expect(lin.appNameEquals('Chrome', 'chrome')).toBe(false);
    expect(lin.appNameEquals('chrome', 'chrome')).toBe(true);
  });

  test('開機自啟用 XDG .desktop，不走 Electron 登入項目', () => {
    expect(lin.autostart.usesElectronLoginItem).toBe(false);
    const entry = lin._internal.desktopEntry('/opt/RelayClient.AppImage');
    expect(entry).toContain('[Desktop Entry]');
    expect(entry).toContain('Exec="/opt/RelayClient.AppImage"');
  });

  test('讀不到 /proc 時回空陣列', () => {
    expect(lin.listProcesses('/definitely-not-a-proc-dir')).toEqual([]);
  });
});

describe('引擎吃 adapter：同一份程式碼產出各平台正確的設定', () => {
  const ROUTES = [{ id: 'r1', kind: 'socks5', localPort: 10810 }];
  const cfgFor = p => new SingBoxEngine({ platform: p, binPath: 'x' })
    .generateConfig({ rules: [{ on: true, target: 'r1', when: { app: { match: 'name', value: 'chrome.exe' } } }], routes: ROUTES });

  test('Windows：有 interface_name，自我 bypass 帶 .exe', () => {
    const cfg = cfgFor(win);
    expect(cfg.inbounds[0].interface_name).toBe('proxyclient-tun');
    expect(cfg.route.rules[0].process_name).toEqual(['sing-box.exe']);
  });

  test('macOS：不寫 interface_name（交給 sing-box 配 utun），自我 bypass 無副檔名', () => {
    const cfg = cfgFor(mac);
    expect(cfg.inbounds[0].interface_name).toBeUndefined();
    expect(cfg.route.rules[0].process_name).toEqual(['sing-box']);
  });

  test('Linux：介面名可自訂，自我 bypass 無副檔名', () => {
    const cfg = cfgFor(lin);
    expect(cfg.inbounds[0].interface_name).toBe('proxyclient-tun');
    expect(cfg.route.rules[0].process_name).toEqual(['sing-box']);
  });

  test('引擎執行檔名依平台解析', () => {
    expect(new SingBoxEngine({ platform: mac })._resolveBin()).toMatch(/sing-box$/);
    expect(new SingBoxEngine({ platform: win })._resolveBin()).toMatch(/sing-box\.exe$/);
  });

  test('規則模擬器的程式比對沿用平台的大小寫規則', async () => {
    const rules = [{ id: 'a', on: true, name: 'Chrome', target: 'r1', when: { app: { match: 'name', value: 'chrome' } } }];
    const q = { rules, host: 'x.com', exe: '/usr/bin/Chrome', defaultTarget: 'direct' };
    await expect(new SingBoxEngine({ platform: lin, binPath: 'x' }).matchTarget(q)).resolves.toMatchObject({ matched: false });
    await expect(new SingBoxEngine({ platform: win, binPath: 'x' }).matchTarget(q)).resolves.toMatchObject({ matched: true, target: 'r1' });
  });
});
