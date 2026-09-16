'use strict';
const js = require('@eslint/js');
const globals = require('globals');

// 頁面用 <script> 依序載入、共用全域；這些是各檔案之間的「介面」
const appGlobals = { LuckyCore: 'readonly', LuckyWheel: 'readonly', LW: 'writable', WheelBG: 'readonly', THREE: 'readonly', XLSX: 'readonly', mqtt: 'readonly', anime: 'readonly' };

module.exports = [
  js.configs.recommended,
  { ignores: ['node_modules/**', 'dist/**'] },
  {
    files: ['*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { ...globals.browser, ...appGlobals } },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none' }],
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true }], // 中文字串裡的全形空白是排版用
    },
  },
  {
    files: ['core.js'], // UMD：瀏覽器與 Node 都會載入
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ['eslint.config.js', 'test/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
];
