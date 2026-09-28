'use strict';
const js = require('@eslint/js');
const globals = require('globals');

// 只開「會是 bug」的規則（recommended），不管排版。
// 空的 catch 在這個專案是刻意的（清理步驟失敗不影響運作），所以放行。
const shared = {
  ...js.configs.recommended.rules,
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  'no-use-before-define': ['error', { functions: false, classes: true, variables: false }],
  'no-constant-condition': ['error', { checkLoops: false }],
};

const config = [
  { ignores: ['node_modules/**', 'dist/**', 'engine/**', 'build/**'] },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: shared,
  },
  {
    // 畫面端：沒有 Node，只有瀏覽器 API 與 preload 橋接出來的 window.api。
    // renderer/js/ 的各檔是依序載入的一般 script，最外層宣告跨檔共用 —— 單檔看的話
    // 「未定義」「沒用到」都會誤報，所以這兩條在這裡關掉，改由 test/renderer-scripts.test.js
    // 把各檔照 index.html 的順序接起來、用完整規則檢查一次。
    files: ['renderer/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': ['error', { vars: 'local', args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: { globals: { ...globals.jest } },
  },
];

module.exports = config;
module.exports.shared = shared;
