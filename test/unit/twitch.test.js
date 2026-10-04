'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tw = require('../../twitch-core.js');

// ---------- 模擬 Google 試算表（照實際檔案的結構：兌換紀錄 B 欄名單、月份分頁每天 8 欄） ----------
const COLS = tw.SHEET_COLUMNS;
class Sheet {
  constructor(name) { this.name = name; this.cells = new Map(); this.maxRow = 0; this.maxCol = 0; }
  key(r, c) { return `${r},${c}`; }
  cell(r, c) { return this.cells.get(this.key(r, c)) || { v: '', f: '' }; }
  put(r, c, v, f = '') { this.cells.set(this.key(r, c), { v, f }); this.maxRow = Math.max(this.maxRow, r); this.maxCol = Math.max(this.maxCol, c); }
  getName() { return this.name; }
  getLastRow() { return this.maxRow; }
  getLastColumn() { return this.maxCol; }
  getRange(r, c, nr = 1, nc = 1) {
    const sh = this;
    const grid = (fn) => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => fn(sh.cell(r + i, c + j))));
    const disp = (x) => (x.v instanceof Date ? `${x.v.getFullYear()}/${x.v.getMonth() + 1}/${x.v.getDate()}` : String(x.v));
    return {
      getValues: () => grid((x) => x.v),
      getDisplayValues: () => grid(disp),
      getValue: () => sh.cell(r, c).v,
      getFormula: () => sh.cell(r, c).f,
      setValue: (v) => sh.put(r, c, v),
      setFormula: (f) => sh.put(r, c, `(公式)${f}`, f),
    };
  }
}

function makeBook({ month = 10, year = 2026, names, monthFormulaRows = 300, totalRows = 999 } = {}) {
  const sheets = {};
  const add = (n) => (sheets[n] = new Sheet(n));
  const ex = add('兌換紀錄');
  ex.put(1, 1, '編號'); ex.put(1, 2, '名稱');
  for (let i = 0; i < totalRows; i++) { ex.put(3 + i, 1, i + 1); if (names[i] != null) ex.put(3 + i, 2, names[i]); }
  add('總表').put(1, 1, '編號');
  const days = new Date(year, month, 0).getDate();
  const ms = add(`${month}月`);
  ms.put(1, 1, '日期');
  for (let d = 1; d <= days; d++) {
    const start = 3 + (d - 1) * 8;
    ms.put(1, start, new Date(year, month - 1, d));
    COLS.forEach((h, k) => ms.put(2, start + k, h));
  }
  const sumStart = 3 + days * 8;
  ms.put(1, sumStart, '當月總結');
  COLS.forEach((h, k) => ms.put(2, sumStart + k, h));
  for (let i = 0; i < monthFormulaRows; i++) { ms.put(3 + i, 1, i + 1); ms.put(3 + i, 2, `(公式)`, `='總表'!B${3 + i}`); }
  const book = {
    getSheetByName: (n) => sheets[n] || null,
    getName: () => '常駐_揪團_抖內_忠誠點轉盤紀錄',
    getSpreadsheetTimeZone: () => 'Asia/Taipei',
  };
  return { book, sheets };
}

function loadScript(book, key = 'SECRET123') {
  const src = tw.scriptWithKey(fs.readFileSync(path.join(__dirname, '../../sheet-script.gs'), 'utf8'), key);
  const props = new Map();
  const ctx = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => book, flush() {} },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, v),
        getProperties: () => Object.fromEntries(props),
        deleteProperty: (k) => props.delete(k),
      }),
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ setMimeType: () => JSON.parse(t) }) },
    Utilities: { formatDate: (d) => `${d.getMonth() + 1}/${d.getDate()}` },
  });
  vm.runInContext(`${src}\n;this.__api = { doPost, doGet, parseViewer_, matchViewer_ };`, ctx);
  const api = ctx.__api;
  const post = (body) => api.doPost({ postData: { contents: JSON.stringify({ key, ...body }) } });
  return { ...api, post, props };
}

const NAMES = ['嘎唄(gabai)', 'HaruneUka(haruneuka)', '小于甜心 (xiaoyuthesweetheart_)', '安棉コットン (anmianatwork):', 'shengwei_0509', '幽璃ゆうり', 'FCerror'];

test('解析觀眾名稱：網頁與 Apps Script 規則一致', () => {
  const { book } = makeBook({ names: NAMES });
  const gas = loadScript(book);
  const cases = { '嘎唄(gabai)': ['嘎唄', 'gabai'], '小于甜心 (xiaoyuthesweetheart_)': ['小于甜心', 'xiaoyuthesweetheart_'], '安棉コットン (anmianatwork):': ['安棉コットン', 'anmianatwork'], 'shengwei_0509': ['shengwei_0509', ''], '全形（Abc）': ['全形', 'abc'], '': ['', ''] };
  for (const [s, [display, login]] of Object.entries(cases)) {
    assert.deepEqual(tw.parseViewer(s), { display, login }, s);
    assert.deepEqual({ ...gas.parseViewer_(s) }, { display, login }, `gas ${s}`);
  }
});

test('比對觀眾：帳號優先，沒括號的用帳號或顯示名稱比，大小寫不分', () => {
  const { book } = makeBook({ names: NAMES });
  const { matchViewer_: m } = loadScript(book);
  assert.equal(m(NAMES, 'gabai', '嘎唄'), 0);
  assert.equal(m(NAMES, 'GABAI', '改名了'), 0); // 改顯示名稱也認得
  assert.equal(m(NAMES, 'anmianatwork', 'x'), 3); // 結尾多了冒號
  assert.equal(m(NAMES, 'shengwei_0509', 'Shengwei_0509'), 4);
  assert.equal(m(NAMES, 'yuri123', '幽璃ゆうり'), 5); // 名單只有顯示名稱
  assert.equal(m(NAMES, 'fcerror', 'FCerror'), 6);
  assert.equal(m(NAMES, 'nobody', 'Nobody'), -1);
  assert.equal(m(NAMES, '', '嘎唄'), 0); // 手動輸入只有顯示名稱
});

test('寫入：當月分頁「當天 × 獎項」那格 +1，總表不碰', () => {
  const { book, sheets } = makeBook({ names: NAMES });
  const gas = loadScript(book);
  const rec = { id: 'r1', date: '2026-10-04', login: 'gabai', display: '嘎唄', column: '3點' };
  const res = gas.post({ action: 'add', records: [rec] });
  assert.equal(res.ok, true);
  const col = 3 + 3 * 8 + 1; // 10/4 那天的「3點」
  assert.equal(res.results[0].cell, '10月!AB3'); // 第 28 欄
  assert.equal(sheets['10月'].cell(3, col).v, 1);
  gas.post({ action: 'add', records: [{ ...rec, id: 'r2' }] });
  assert.equal(sheets['10月'].cell(3, col).v, 2);
  assert.equal(sheets['總表'].cells.size, 1);
});

test('同一筆兌換重送不會加兩次；撤銷減回去、重複撤銷也只減一次', () => {
  const { book, sheets } = makeBook({ names: NAMES });
  const gas = loadScript(book);
  const rec = { id: 'dup', date: '2026-10-31', login: 'haruneuka', display: 'HaruneUka', column: '5點' };
  const col = 3 + 30 * 8 + 2;
  gas.post({ action: 'add', records: [rec] });
  const again = gas.post({ action: 'add', records: [rec] });
  assert.equal(again.results[0].dup, true);
  assert.equal(sheets['10月'].cell(4, col).v, 1);
  gas.post({ action: 'undo', records: [rec] });
  gas.post({ action: 'undo', records: [rec] });
  assert.equal(sheets['10月'].cell(4, col).v, ''); // 減到 0 留空白，跟原本沒資料的格子一樣
  const never = gas.post({ action: 'undo', records: [{ ...rec, id: 'never' }] });
  assert.equal(never.results[0].ok, false);
});

test('新觀眾：填進兌換紀錄第一個空白列，月份分頁補上名稱公式', () => {
  const { book, sheets } = makeBook({ names: NAMES, monthFormulaRows: 5 });
  const gas = loadScript(book);
  const res = gas.post({ action: 'add', records: [{ id: 'n1', date: '2026-10-04', login: 'newbie', display: '新來的', column: '1點' }] });
  const r = res.results[0];
  assert.equal(r.ok, true); assert.equal(r.isNew, true);
  assert.equal(r.row, 3 + NAMES.length);
  assert.equal(sheets['兌換紀錄'].cell(r.row, 2).v, '新來的(newbie)');
  assert.equal(sheets['10月'].cell(r.row, 2).f, `='總表'!B${r.row}`); // 原本只有 5 列有公式
  // 再來一次要找到同一列
  const again = gas.post({ action: 'add', records: [{ id: 'n2', date: '2026-10-04', login: 'newbie', display: '新來的', column: '1點' }] });
  assert.equal(again.results[0].row, r.row); assert.equal(again.results[0].isNew, false);
});

test('錯誤：暗號不符、沒有那個月份分頁、欄名找不到、格子是公式', () => {
  const { book, sheets } = makeBook({ names: NAMES });
  const gas = loadScript(book);
  const bad = gas.doPost({ postData: { contents: JSON.stringify({ key: 'wrong', action: 'ping' }) } });
  assert.equal(bad.ok, false); assert.equal(bad.fatal, true);
  const base = { date: '2026-10-04', login: 'gabai', display: '嘎唄', column: '1點' };
  const out = gas.post({ action: 'add', records: [
    { ...base, id: 'e1', date: '2026-11-01' },
    { ...base, id: 'e2', column: '7點' },
  ] }).results;
  assert.match(out[0].error, /找不到「11月」分頁/);
  assert.match(out[1].error, /找不到「7點」欄/);
  const col = 3 + 3 * 8;
  sheets['10月'].put(3, col, 9, '=1+8');
  assert.match(gas.post({ action: 'add', records: [{ ...base, id: 'e3' }] }).results[0].error, /是公式/);
  assert.equal(sheets['10月'].cell(3, col).v, 9);
});

test('測試連線：回報名單人數、分頁與每個欄位的位置', () => {
  const { book } = makeBook({ names: NAMES });
  const gas = loadScript(book);
  const res = gas.post({ action: 'ping', date: '2026-10-04', columns: ['1點', '3點', '5點', '不存在'] });
  assert.equal(res.ok, true);
  assert.equal(res.viewers, NAMES.length);
  assert.equal(res.sheet, '10月');
  assert.deepEqual(Object.keys(res.columns), ['1點', '3點', '5點']);
  assert.equal(res.problems.length, 1);
});

test('直播日：換日時間之前算前一天', () => {
  const at = (s) => new Date(s);
  assert.equal(tw.dayKey(at('2026-10-05T01:30:00'), 0), '2026-10-05');
  assert.equal(tw.dayKey(at('2026-10-05T01:30:00'), 4), '2026-10-04');
  assert.equal(tw.dayKey(at('2026-11-01T03:59:00'), 4), '2026-10-31'); // 跨月也正確
  assert.equal(tw.dayKey(at('2026-10-05T04:00:00'), 4), '2026-10-05');
});

test('設定正規化與暗號替換', () => {
  const c = tw.normalizeTwConfig({ scriptUrl: 'https://evil.example.com/x', cutoffHour: 99, prizes: [{ name: ' 5點 ', weight: -1 }], rewardIds: ['a', 'a', ''] });
  assert.equal(c.scriptUrl, '');
  assert.equal(c.cutoffHour, 12);
  assert.equal(c.prizes[0].name, '5點'); assert.equal(c.prizes[0].column, '5點'); assert.equal(c.prizes[0].weight, 0);
  assert.deepEqual(c.rewardIds, ['a']);
  assert.ok(c.sheetKey.length >= 16);
  assert.equal(tw.normalizeTwConfig({}).prizes.length, 3);
  assert.equal(tw.normalizeTwConfig({ scriptUrl: 'https://script.google.com/macros/s/AKfy/exec' }).scriptUrl, 'https://script.google.com/macros/s/AKfy/exec');
  const src = fs.readFileSync(path.join(__dirname, '../../sheet-script.gs'), 'utf8');
  assert.match(tw.scriptWithKey(src, 'ABC'), /const KEY = 'ABC';/);
});
