const fs = require('fs');
const path = require('path');
const { Linter } = require('eslint');
const globals = require('globals');
const { shared } = require('../eslint.config');

// renderer/js/ 的各檔是依序載入的一般 <script>，最外層的宣告跨檔共用。
// 單檔 lint 看不出「A 檔用到的函式根本沒人定義」或「兩個檔宣告了同一個名字」——
// 後者在瀏覽器裡是 SyntaxError，整個畫面直接空白。
// 這裡照 index.html 的順序把各檔接起來，當成一支 script 用完整規則檢查。

const DIR = path.join(__dirname, '..', 'renderer');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);

describe('renderer scripts', () => {
  test('index.html 載入的每個檔都存在，renderer/js/ 裡也沒有沒被載入的檔', () => {
    for (const s of scripts) expect(fs.existsSync(path.join(DIR, s))).toBe(true);
    const onDisk = fs.readdirSync(path.join(DIR, 'js')).filter(f => f.endsWith('.js')).map(f => 'js/' + f).sort();
    expect([...scripts].sort()).toEqual(onDisk);
  });

  test('lib、core 最先，boot 最後（其他檔依賴 lib / core；boot() 要等全部載入完才能跑）', () => {
    expect(scripts.slice(0, 2)).toEqual(['js/lib.js', 'js/core.js']);
    expect(scripts[scripts.length - 1]).toBe('js/boot.js');
  });

  test('接起來之後：沒有未定義的名字、沒有重複宣告、沒有沒用到的函式', () => {
    const src = scripts.map(s => fs.readFileSync(path.join(DIR, s), 'utf8').replace(/^'use strict';\n/, '')).join('\n');
    const linter = new Linter();
    const messages = linter.verify("'use strict';\n" + src, [{
      languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.browser } },
      rules: { ...shared, 'no-unused-vars': ['error', { vars: 'all', args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^_' }] },
    }]);
    expect(messages.map(m => `${m.line}: ${m.ruleId || 'parse'} ${m.message}`)).toEqual([]);
  });
});
