// config.json 壞掉時 electron-store 8 在建構時就丟 SyntaxError；
// 那發生在 main.js 最頂端，錯誤攔截都還沒掛上，app 會直接起不來。
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('config.json 損毀時的復原', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-rec-')); });
  afterEach(() => { jest.resetModules(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

  test('壞檔改名保留、用預設值重建，並回報備份位置', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), '{ broken');
    let calls = 0;
    jest.isolateModules(() => {
      jest.doMock('electron', () => ({ app: { getPath: () => dir } }), { virtual: true });
      jest.doMock('electron-store', () => jest.fn().mockImplementation(({ defaults }) => {
        calls++;
        if (fs.existsSync(path.join(dir, 'config.json'))) { const e = new SyntaxError('Unexpected token b'); throw e; }
        const data = new Map(Object.entries(JSON.parse(JSON.stringify(defaults))));
        return { get: k => data.get(k), set: (k, v) => data.set(k, v) };
      }));
      const config = require('../src/store/config');
      expect(calls).toBe(2);
      expect(config.getServers()).toEqual([]);
      const backup = config.recoveredFrom();
      expect(backup).toMatch(/config\.corrupt-\d+\.json$/);
      expect(fs.readFileSync(backup, 'utf8')).toBe('{ broken');
    });
  });

  test('不是 SyntaxError 的錯誤照樣往外丟（不要把權限問題之類的吞掉）', () => {
    jest.isolateModules(() => {
      jest.doMock('electron', () => ({ app: { getPath: () => dir } }), { virtual: true });
      jest.doMock('electron-store', () => jest.fn().mockImplementation(() => { throw new Error('EACCES'); }));
      expect(() => require('../src/store/config')).toThrow('EACCES');
    });
  });
});
