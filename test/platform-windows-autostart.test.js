// 開機自動啟動：改名前留下的孤兒登入項目。
//
// Electron 的 setLoginItemSettings 是拿「當下的 productName」當登錄檔值的名字。
// 這個 app 從「代理客戶端」改名成 RelayClient 之後，舊名字那一筆就沒人管得到了：
// 設定頁讀不到（顯示「關」）、關閉開關也刪不掉，但 OS 每次登入照樣去啟動它。
// 開發機上實際就留著一筆 electron.app.代理客戶端 → RelayClient-Portable-1.1.1.exe。

jest.mock('child_process', () => ({
  execSync: jest.fn(),
  execFile: jest.fn(),
  execFileSync: jest.fn(),
}));

const { execFileSync } = require('child_process');
const { autostart } = require('../src/platform/windows');

const decode = (b64) => Buffer.from(b64, 'base64').toString('utf16le');
const emit = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64') + '\r\n';

// 假登錄檔。形狀本身就是那個約定：進去的指令是 base64 的 UTF-16，
// 出來的結果是 base64 的 UTF-8 JSON —— 命令列與 stdout 上都不能有非 ASCII。
// 用明碼在任一方向都會被主控台代碼頁吃掉（reg.exe 兩個方向各踩過一次）。
function fakeRegistry(entries) {
  execFileSync.mockImplementation((cmd, args) => {
    if (cmd !== 'powershell') throw new Error('不該直接呼叫 ' + cmd + '（reg.exe 的編碼靠不住）');
    const i = args.indexOf('-EncodedCommand');
    if (i < 0) throw new Error('沒有用 -EncodedCommand');
    if (!/^[A-Za-z0-9+/=]+$/.test(args[i + 1])) throw new Error('命令列上不是純 ASCII');
    const script = decode(args[i + 1]);

    if (/Remove-ItemProperty/.test(script)) {
      for (const m of script.matchAll(/-Name '((?:[^']|'')*)'/g)) delete entries[m[1].replace(/''/g, "'")];
      return '';
    }
    // 查詢：腳本裡列出要找的名字，回傳命中的那幾筆
    const asked = [...script.matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1].replace(/''/g, "'"));
    const hits = asked.filter(n => n in entries).map(n => ({ name: n, data: entries[n] }));
    return emit(hits);
  });
}

beforeEach(() => execFileSync.mockReset());

describe('舊名字留下的登入項目', () => {
  test('listLegacy 找得到改名前那一筆', () => {
    fakeRegistry({ 'electron.app.代理客戶端': 'C:\\Users\\u\\Downloads\\RelayClient-Portable-1.1.1.exe' });
    const found = autostart.listLegacy();
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('electron.app.代理客戶端');
    expect(found[0].data).toBe('C:\\Users\\u\\Downloads\\RelayClient-Portable-1.1.1.exe');
  });

  test('沒有舊項目時回空陣列，不是拋錯', () => {
    fakeRegistry({});
    expect(autostart.listLegacy()).toEqual([]);
  });

  test('clearLegacy() 不帶參數＝全部清掉', () => {
    const reg = { 'electron.app.代理客戶端': 'C:\\a.exe', '代理客戶端': 'C:\\b.exe' };
    fakeRegistry(reg);
    expect(autostart.clearLegacy()).toBe(2);
    expect(Object.keys(reg)).toEqual([]);
  });

  test('clearLegacy([name]) 只清指定那一筆，不波及其他', () => {
    const reg = { 'electron.app.代理客戶端': 'C:\\a.exe', '代理客戶端': 'C:\\b.exe' };
    fakeRegistry(reg);
    expect(autostart.clearLegacy(['代理客戶端'])).toBe(1);
    expect(Object.keys(reg)).toEqual(['electron.app.代理客戶端']);
  });

  test('只認自己的舊名字，不會去碰別人的登入項目', () => {
    // 這是最重要的一條：清理程式跑在使用者的 Run 底下，
    // 名單寫錯就會刪掉 Docker / Teams / OneDrive 那些。
    for (const name of autostart.legacyNames) {
      expect(/代理客戶端/.test(name)).toBe(true);
    }
    const reg = { 'Docker Desktop': 'C:\\docker.exe', OneDrive: 'C:\\od.exe' };
    fakeRegistry(reg);
    autostart.clearLegacy();
    expect(Object.keys(reg).sort()).toEqual(['Docker Desktop', 'OneDrive']);
  });

  test('刪除失敗不拋錯，而且回 0（不能謊報清掉了）', () => {
    execFileSync.mockImplementation((cmd, args) => {
      const script = decode(args[args.indexOf('-EncodedCommand') + 1]);
      if (/Remove-ItemProperty/.test(script)) throw new Error('Access is denied');
      return emit([{ name: '代理客戶端', data: 'C:\\a.exe' }]);
    });
    expect(() => autostart.clearLegacy()).not.toThrow();
    expect(autostart.clearLegacy()).toBe(0);
  });

  test('刪除指令回 0 但東西還在 → 也回 0（重讀確認，不信離開碼）', () => {
    // -ErrorAction SilentlyContinue 會把失敗吞掉，離開碼照樣是 0
    execFileSync.mockImplementation((cmd, args) => {
      const script = decode(args[args.indexOf('-EncodedCommand') + 1]);
      if (/Remove-ItemProperty/.test(script)) return '';
      return emit([{ name: '代理客戶端', data: 'C:\\a.exe' }]);
    });
    expect(autostart.clearLegacy()).toBe(0);
  });

  test('stdout 是亂碼時回空陣列，不是拋錯或回垃圾', () => {
    execFileSync.mockImplementation(() => '?????\r\n');
    expect(autostart.listLegacy()).toEqual([]);
  });

  test('中文名字不會出現在命令列參數上', () => {
    fakeRegistry({ 'electron.app.代理客戶端': 'C:\\a.exe' });
    autostart.clearLegacy();
    for (const [, args] of execFileSync.mock.calls) {
      for (const a of args) expect(/[^\x00-\x7F]/.test(String(a))).toBe(false);
    }
  });

  test('查詢失敗（沒有 reg 指令等）也只是回空，不拋錯', () => {
    execFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(autostart.listLegacy()).toEqual([]);
  });
});

describe('Run 值裡的執行檔路徑', () => {
  const t = require('../src/platform/windows').autostart.entryTarget;

  test('有引號、路徑含空白、後面還帶參數', () => {
    expect(t('"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe" /background'))
      .toBe('C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe');
  });

  test('沒引號但帶參數（LM Studio 在真機上就是這樣寫的）', () => {
    expect(t('C:\\Users\\u\\AppData\\Local\\Programs\\LM Studio\\LM Studio.exe --run-as-service'))
      .toBe('C:\\Users\\u\\AppData\\Local\\Programs\\LM Studio\\LM Studio.exe');
  });

  test('乾淨的路徑，沒引號沒參數', () => {
    expect(t('C:\\Users\\u\\Downloads\\RelayClient-Portable-1.1.1.exe'))
      .toBe('C:\\Users\\u\\Downloads\\RelayClient-Portable-1.1.1.exe');
  });

  test('解析不出 .exe 就回空字串（呼叫端據此「不動它」，寧可留著也不要誤刪）', () => {
    expect(t('')).toBe('');
    expect(t('rundll32 shell32.dll,Control_RunDLL')).toBe('');
    expect(t(null)).toBe('');
  });
});
