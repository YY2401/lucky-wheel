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
    Utilities: { formatDate: (d, tz, f) => (f === 'yyyy' ? String(d.getFullYear()) : f === 'd' ? String(d.getDate()) : `${d.getMonth() + 1}/${d.getDate()}`) },
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

test('Twitch 兌換狀態：可退點期滿才標已完成、撤銷要退點的立刻送；依品項分組、每批最多 50 筆', () => {
  const p = tw.DEFAULT_PRIZES[0];
  const mk = (id, rewardId, at) => tw.makeRecord({ id, rewardId, prize: p, processedAt: at });
  const recs = [mk('a', 'r1', 0), mk('b', 'r1', 0), mk('c', 'r2', 0), mk('d', 'r1', 1e12), tw.makeRecord({ id: 'm', prize: p }), tw.makeRecord({ id: 't', rewardId: 'r1', prize: p, test: true })];
  recs[3].tw = 'to-cancel';
  assert.equal(recs[4].tw, ''); assert.equal(recs[5].tw, ''); // 手動補登、試轉不碰 Twitch
  const due = tw.dueTwitchUpdates(recs, tw.HOLD_MS + 1);
  assert.deepEqual(due, [
    { rewardId: 'r1', status: 'FULFILLED', ids: ['a', 'b'] },
    { rewardId: 'r2', status: 'FULFILLED', ids: ['c'] },
    { rewardId: 'r1', status: 'CANCELED', ids: ['d'] },
  ]);
  assert.deepEqual(tw.dueTwitchUpdates(recs, tw.HOLD_MS - 1).map((x) => x.status), ['CANCELED']); // 還在可退點期
  const many = Array.from({ length: 120 }, (_, i) => mk(`x${i}`, 'r1', 0));
  assert.deepEqual(tw.dueTwitchUpdates(many, tw.HOLD_MS).map((x) => x.ids.length), [50, 50, 20]);
  assert.equal(tw.nextHoldExpiry(recs), tw.HOLD_MS);
  assert.equal(tw.nextHoldExpiry([]), 0);
});

test('補抓：只列這個網頁沒處理過的兌換，照兌換時間排、不重複', () => {
  const x = (id, at) => ({ id, user_login: id, user_name: id.toUpperCase(), redeemed_at: at, reward: { id: 'r1', title: '轉盤' } });
  const out = tw.missedRedemptions([x('b', '2026-10-02T00:00:00Z'), x('known', '2026-10-01T00:00:00Z'), x('a', '2026-10-01T00:00:00Z'), x('b', '2026-10-02T00:00:00Z')], ['known']);
  assert.deepEqual(out.map((m) => m.id), ['a', 'b']);
  assert.deepEqual(out[0], { id: 'a', login: 'a', display: 'A', userId: '', input: '', reward: '轉盤', rewardId: 'r1', at: '2026-10-01T00:00:00Z' });
});

test('搬到 OBS 面板：設定與可退點紀錄打包進網址，同一份只套用一次，壞資料不會出錯', () => {
  const cfg = tw.normalizeTwConfig({ scriptUrl: 'https://script.google.com/macros/s/x/exec', rewardIds: ['r1'], prizes: [{ name: '中文獎項', weight: 1 }], cutoffHour: 3 });
  const recs = [tw.makeRecord({ id: 'h', rewardId: 'r1', prize: cfg.prizes[0] }), tw.makeRecord({ id: 'm', prize: cfg.prizes[0] })];
  const code = tw.encodeMove(tw.buildMove(cfg, recs));
  assert.match(code, /^[A-Za-z0-9_-]+$/); // 放在網址裡不用再編碼
  const fresh = tw.normalizeTwConfig({ cutoffHour: 0 });
  const r = tw.applyMove(fresh, [], tw.decodeMove(code));
  for (const k of ['scriptUrl', 'sheetKey', 'room', 'secret', 'cutoffHour']) assert.deepEqual(r.cfg[k], cfg[k], k);
  assert.equal(r.cfg.prizes[0].name, '中文獎項');
  assert.deepEqual(r.add.map((x) => x.id), ['h']);
  assert.equal(r.cfg.movedToObs, false);
  assert.equal(tw.applyMove(r.cfg, r.add, tw.decodeMove(code)), null); // OBS 重開帶同一個網址
  assert.equal(tw.decodeMove('壞掉'), null);
  assert.equal(tw.decodeMove(Buffer.from('{"v":2}').toString('base64')), null);
});

test('測試連線回傳當天底下的欄名（給「寫到哪一欄」選單）', () => {
  const { book } = makeBook({ names: NAMES });
  const gas = loadScript(book);
  const res = gas.post({ action: 'ping', date: '2026-10-04', columns: ['1點'] });
  assert.deepEqual([...res.heads], COLS);
  const none = gas.post({ action: 'ping', date: '2026-11-04', columns: [] }); // 沒有 11 月分頁
  assert.equal(none.heads, undefined);
});

test('「不寫進試算表」的格子：紀錄狀態是 nowrite，不送去試算表', () => {
  const r = tw.makeRecord({ id: 'x', rewardId: 'rw', prize: { id: 'm', name: '下次一定', column: '' } });
  assert.equal(r.status, 'nowrite');
  assert.equal(r.tw, 'hold'); // 一樣可以退點
  assert.equal(tw.makeRecord({ id: 'y', prize: { id: 'a', name: '1點', column: '1點' } }).status, 'pending');
  assert.deepEqual(tw.normalizeTwConfig({ sheetColumns: [' 1點 ', '1點', '', 'Q版塗鴉'] }).sheetColumns, ['1點', 'Q版塗鴉']);
  assert.equal(tw.normalizeTwConfig({ prizes: [{ name: '下次一定', column: '' }] }).prizes[0].column, '');
});

test('觀眾改了英文帳號：用 Twitch 永久編號找回同一列，括號裡換成新帳號', () => {
  const { book, sheets } = makeBook({ names: NAMES });
  const gas = loadScript(book);
  const base = { date: '2026-10-04', column: '1點' };
  const first = gas.post({ action: 'add', records: [{ ...base, id: 'a1', login: 'gabai', display: '嘎唄', uid: '1001' }] }).results[0];
  assert.equal(first.row, 3);
  // 改了帳號 gabai → gabai_tw：還是第 3 列、名單更新、不新增一列
  const second = gas.post({ action: 'add', records: [{ ...base, id: 'a2', login: 'gabai_tw', display: '嘎唄唄', uid: '1001' }] }).results[0];
  assert.equal(second.row, 3); assert.equal(second.isNew, false); assert.equal(second.renamedFrom, 'gabai');
  assert.equal(sheets['兌換紀錄'].cell(3, 2).v, '嘎唄(gabai_tw)'); // 前面的名字維持實況主原本寫的
  assert.equal(sheets['10月'].cell(3, 3 + 3 * 8).v, 2);
  // 沒有編號（手動補登）用新帳號也找得到
  assert.equal(gas.post({ action: 'add', records: [{ ...base, id: 'a3', login: 'gabai_tw', display: 'x' }] }).results[0].row, 3);
});

test('名單被重新排序過：記住的列已經不是同一人，就不採用，改用帳號比對', () => {
  const { book, sheets } = makeBook({ names: NAMES });
  const gas = loadScript(book);
  const base = { date: '2026-10-04', column: '1點' };
  gas.post({ action: 'add', records: [{ ...base, id: 'b1', login: 'haruneuka', display: 'HaruneUka', uid: '2002' }] }); // 記住第 4 列
  sheets['兌換紀錄'].put(4, 2, '嘎唄(gabai)'); sheets['兌換紀錄'].put(3, 2, 'HaruneUka(haruneuka)'); // 兩列對調
  const r = gas.post({ action: 'add', records: [{ ...base, id: 'b2', login: 'haruneuka', display: 'HaruneUka', uid: '2002' }] }).results[0];
  assert.equal(r.row, 3); assert.equal(r.renamedFrom, '');
  assert.equal(sheets['兌換紀錄'].cell(4, 2).v, '嘎唄(gabai)'); // 沒有被改掉
});

test('測試連線列出名單裡只寫名字、沒寫帳號的人（只寫英文帳號的不算）', () => {
  const { book } = makeBook({ names: NAMES });
  const gas = loadScript(book);
  const res = gas.post({ action: 'ping', date: '2026-10-04', columns: [] });
  assert.deepEqual([...res.noLogin], ['幽璃ゆうり']);
});

test('送給試算表的資料帶著 Twitch 永久編號', () => {
  const r = tw.makeRecord({ id: 'x', login: 'Gabai', display: '嘎唄', userId: '1001', prize: tw.DEFAULT_PRIZES[0] });
  assert.deepEqual(tw.forSheet(r), { id: 'x', date: r.date, login: 'gabai', display: '嘎唄', uid: '1001', column: '1點' });
  assert.equal(tw.missedRedemptions([{ id: 'm', user_login: 'a', user_name: 'A', user_id: '77', redeemed_at: '2026-10-01T00:00:00Z', reward: { id: 'r', title: 't' } }], [])[0].userId, '77');
});

test('代抽：@帳號、@中文名字都算；沒有 @ 的中文和留言不算', () => {
  assert.deepEqual(tw.proxyTarget('@ToastIwa'), { login: 'toastiwa' });
  assert.deepEqual(tw.proxyTarget('幫 @gabai 抽！'), { login: 'gabai' });
  assert.deepEqual(tw.proxyTarget('  haruneuka '), { login: 'haruneuka' });
  assert.deepEqual(tw.proxyTarget('@秋野貼鐵'), { name: '秋野貼鐵' });
  assert.deepEqual(tw.proxyTarget('幫＠秋野貼鐵 抽一次'), { name: '秋野貼鐵' });
  assert.deepEqual(tw.proxyTarget('@ 小于甜心！'), { name: '小于甜心' });
  assert.equal(tw.proxyTarget('嘎唄'), null);
  assert.equal(tw.proxyTarget('加油'), null);
  assert.equal(tw.proxyTarget('good luck everyone'), null);
  assert.equal(tw.proxyTarget(''), null);
  const r = tw.makeRecord({ id: 'p', login: 'toastiwa', display: '吐司', by: { login: 'Gabai', display: '嘎唄' }, prize: tw.DEFAULT_PRIZES[0] });
  assert.deepEqual(r.by, { login: 'gabai', display: '嘎唄' });
  r.moveTo = { login: 'newbie', display: '新人', userId: '5' };
  assert.deepEqual(tw.forMove(r), { id: 'p', seq: 1, date: r.date, column: '1點', from: { login: 'toastiwa', display: '吐司', uid: '' }, to: { login: 'newbie', display: '新人', uid: '5' } });
});

test('改記給別人：原本的人 -1、新的人 +1，重送不會重複，之後撤銷減的是新的人', () => {
  const { book, sheets } = makeBook({ names: NAMES });
  const gas = loadScript(book);
  const col = 3 + 3 * 8; // 10/4 的 1點
  gas.post({ action: 'add', records: [{ id: 'm1', date: '2026-10-04', login: 'gabai', display: '嘎唄', column: '1點' }] });
  const mv = { id: 'm1', seq: 1, date: '2026-10-04', column: '1點', from: { login: 'gabai', display: '嘎唄' }, to: { login: 'haruneuka', display: 'HaruneUka' } };
  const res = gas.post({ action: 'move', records: [mv] }).results[0];
  assert.equal(res.ok, true); assert.equal(res.row, 4);
  assert.equal(sheets['10月'].cell(3, col).v, ''); assert.equal(sheets['10月'].cell(4, col).v, 1);
  assert.equal(gas.post({ action: 'move', records: [mv] }).results[0].dup, true); // 重送
  assert.equal(sheets['10月'].cell(4, col).v, 1);
  gas.post({ action: 'undo', records: [{ id: 'm1', date: '2026-10-04', login: 'haruneuka', display: 'HaruneUka', column: '1點' }] });
  assert.equal(sheets['10月'].cell(4, col).v, '');
  // 還沒寫進去的、移到新觀眾
  assert.match(gas.post({ action: 'move', records: [{ ...mv, id: 'never' }] }).results[0].error, /還沒寫進試算表/);
  gas.post({ action: 'add', records: [{ id: 'm2', date: '2026-10-04', login: 'gabai', display: '嘎唄', column: '1點' }] });
  const n = gas.post({ action: 'move', records: [{ ...mv, id: 'm2', to: { login: 'brandnew', display: '新來的' } }] }).results[0];
  assert.equal(n.isNew, true); assert.equal(sheets['兌換紀錄'].cell(n.row, 2).v, '新來的(brandnew)');
});

// ---------- 開新年度：模擬一整年 12 個月份分頁＋總表公式（照實際試算表的寫法） ----------
const L = (n) => { let s = ''; while (n > 0) { const k = (n - 1) % 26; s = String.fromCharCode(65 + k) + s; n = Math.floor((n - 1) / 26); } return s; };
function makeYearBook(year = 2026, viewers = ['嘎唄(gabai)', 'HaruneUka(haruneuka)']) {
  const sheets = {};
  const book = {
    getSheetByName: (n) => sheets[n] || null,
    _sheets: sheets, getName: () => '轉盤紀錄', getSpreadsheetTimeZone: () => 'Asia/Taipei',
    rename(sh, to) { // 跟 Google 試算表一樣：分頁改名時，所有引用它的公式跟著改
      const from = sh.name; delete sheets[from]; sh.name = to; sheets[to] = sh;
      for (const s of Object.values(sheets)) for (const c of s.cells.values()) if (c.f) c.f = c.f.split(`'${from}'!`).join(`'${to}'!`);
    },
  };
  const add = (n) => { const s = new Sheet(n); s.book = book; return (sheets[n] = s); };
  const ex = add('兌換紀錄');
  viewers.forEach((v, i) => { ex.put(3 + i, 1, i + 1); ex.put(3 + i, 2, v); });
  const sum = add('總表');
  for (let m = 1; m <= 12; m++) {
    const days = new Date(year, m, 0).getDate();
    const ms = add(`${m}月`);
    for (let d = 1; d <= days; d++) { const c = 3 + (d - 1) * 8; ms.put(1, c, new Date(year, m - 1, d)); COLS.forEach((h, k) => ms.put(2, c + k, h)); }
    const sc = 3 + days * 8; // 當月總結
    ms.put(1, sc, '當月總結'); COLS.forEach((h, k) => ms.put(2, sc + k, h));
    viewers.forEach((_, i) => { const r = 3 + i; ms.put(r, 1, i + 1); ms.put(r, 2, '(公式)', `='總表'!B${r}`); ms.put(r, sc, '(公式)', `=C${r}+K${r}`); });
    // 總表：每個月 8 欄，從 P 欄開始；1點 / 3點×3 / 5點×5 / Q版塗鴉
    viewers.forEach((_, i) => {
      const r = 3 + i; const b = 16 + (m - 1) * 8;
      sum.put(r, b, '(公式)', `='${m}月'!${L(sc)}${r}`); sum.put(r, b + 1, '(公式)', `='${m}月'!${L(sc + 1)}${r}*3`);
      sum.put(r, b + 2, '(公式)', `='${m}月'!${L(sc + 2)}${r}*5`); sum.put(r, b + 3, '(公式)', `='${m}月'!${L(sc + 3)}${r}`);
    });
  }
  viewers.forEach((_, i) => {
    const r = 3 + i; const cols = (k) => Array.from({ length: 12 }, (_, m) => `${L(16 + m * 8 + k)}${r}`);
    sum.put(r, 1, i + 1); sum.put(r, 2, '(公式)', `='兌換紀錄'!B${r}`);
    sum.put(r, 3, '(公式)', `=${[...cols(0), ...cols(1), ...cols(2)].join('+')}`); // 累積點數
    sum.put(r, 5, '(公式)', `=C${r}-D${r}`);
    sum.put(r, 6, '(公式)', `=${cols(3).join('+')}-G${r}`); // Q版塗鴉剩餘
    sum.put(r, 7, 0);
  });
  return { book, sheets };
}
// 模擬補上「開新年度」會用到的試算表功能
Sheet.prototype.setName = function (n) { this.book.rename(this, n); return this; };
Sheet.prototype.copyTo = function (book) { const c = new Sheet(`${this.name} 的副本`); c.book = book; for (const [k, v] of this.cells) c.cells.set(k, { ...v }); c.maxRow = this.maxRow; c.maxCol = this.maxCol; book._sheets[c.name] = c; return c; };
{
  const orig = Sheet.prototype.getRange;
  Sheet.prototype.getRange = function (r, c, nr = 1, nc = 1) {
    const sh = this; const rg = orig.call(this, r, c, nr, nc);
    rg.getFormulas = () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => sh.cell(r + i, c + j).f));
    rg.setFormulas = (fs) => fs.forEach((row, i) => row.forEach((f, j) => sh.put(r + i, c + j, `(公式)${f}`, f)));
    rg.clearContent = () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sh.put(r + i, c + j, ''); };
    rg.setFormula = (f) => { const d = /^=DATE\((\d+),(\d+),(\d+)\)$/.exec(f); sh.put(r, c, d ? new Date(+d[1], d[2] - 1, +d[3]) : `(公式)${f}`, f); };
    return rg;
  };
}

test('跨年：還沒開新年度時，2027 的兌換不會寫進 2026 年的分頁', () => {
  const { book, sheets } = makeYearBook(2026);
  const gas = loadScript(book);
  const r = gas.post({ action: 'add', records: [{ id: 'y1', date: '2027-01-05', login: 'gabai', display: '嘎唄', column: '1點' }] }).results[0];
  assert.equal(r.ok, false); assert.match(r.error, /還沒有 2027 年 1 月的分頁.*開新年度/);
  assert.equal(sheets['1月'].cell(3, 3 + 4 * 8).v, ''); // 2026/1/5 沒被動到
  assert.equal(gas.post({ action: 'add', records: [{ id: 'y0', date: '2026-10-04', login: 'gabai', display: '嘎唄', column: '1點' }] }).results[0].ok, true);
});

test('開新年度：舊分頁改名、建新分頁（日期換新、數字清空）、總表改看今年且累積點數加上去年', () => {
  const { book, sheets } = makeYearBook(2026);
  const gas = loadScript(book);
  gas.post({ action: 'add', records: [{ id: 'old', date: '2026-01-05', login: 'gabai', display: '嘎唄', column: '1點' }] });
  const res = gas.post({ action: 'newYear', year: 2027 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.renamed.length, 12); assert.equal(res.created.length, 12);
  assert.ok(sheets['2026-1月'] && sheets['2027-1月'] && !sheets['1月']);
  const n = sheets['2027-1月']; const o = sheets['2026-1月'];
  assert.equal(n.cell(1, 3).v.getFullYear(), 2027); assert.equal(n.cell(1, 3 + 30 * 8).v.getDate(), 31);
  assert.equal(o.cell(3, 3 + 4 * 8).v, 1); assert.equal(n.cell(3, 3 + 4 * 8).v, ''); // 舊的留著、新的清空
  assert.equal(n.cell(3, 2).f, "='總表'!B3"); // 名稱公式保留
  const sum = sheets['總表'];
  assert.match(sum.cell(3, 16).f, /^='2027-1月'!/); // 每月欄改看今年
  assert.match(sum.cell(3, 3).f, /^=P3\+.*\+\(\('2026-1月'!.*\)\+.*'2026-12月'!/); // 累積點數 = 今年 + 去年
  assert.match(sum.cell(3, 6).f, /-G3\+\(\('2026-1月'!/); // Q版塗鴉剩餘也加上去年
  assert.equal(sum.cell(3, 5).f, '=C3-D3'); // 不相干的公式不動
  assert.deepEqual(res.warnings, []);
  // 開完之後：2027 寫進新分頁；補抓到的 2026 年底兌換寫進舊分頁
  assert.match(gas.post({ action: 'add', records: [{ id: 'n1', date: '2027-01-05', login: 'gabai', display: '嘎唄', column: '1點' }] }).results[0].cell, /^2027-1月!/);
  assert.match(gas.post({ action: 'add', records: [{ id: 'n2', date: '2026-12-31', login: 'gabai', display: '嘎唄', column: '1點' }] }).results[0].cell, /^2026-12月!/);
  // 同一年不能開兩次
  const again = gas.post({ action: 'newYear', year: 2027 });
  assert.equal(again.ok, false); assert.match(again.error, /已經建立過/);
});

test('連續兩年開新年度：累積點數疊加兩個舊年度；閏年 2 月少一天會提醒', () => {
  const { book, sheets } = makeYearBook(2026);
  const gas = loadScript(book);
  assert.equal(gas.post({ action: 'newYear', year: 2027 }).ok, true);
  const res = gas.post({ action: 'newYear', year: 2028 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.renamed.length, 0); // 已經是「年份-N月」，不用改名
  const c = sheets['總表'].cell(3, 3).f;
  assert.match(c, /2026-1月.*2027-1月/s);
  assert.match(sheets['總表'].cell(3, 16).f, /^='2028-1月'!/);
  assert.ok(res.warnings.some((w) => /2028-2月 少了 2\/29/.test(w)), res.warnings.join('\n'));
});

// ---------- 小奇點、訂閱觸發轉盤 ----------
const trig = (over = {}) => tw.normalizeTriggers({ ...over, bits: { on: true, ...(over.bits || {}) }, sub: { on: true, ...(over.sub || {}) } });
const viewer = { user_login: 'Gabai', user_name: '嘎唄', user_id: '42' };

test('小奇點：每滿 N 點轉一次，零頭幫觀眾累積', () => {
  const t = trig();
  let r = tw.triggerSpins('channel.cheer', { ...viewer, bits: 250 }, t, {});
  assert.deepEqual([r.spins, r.carry, r.carryKey, r.source, r.who.login], [2, 50, '42', 'bits', 'gabai']);
  const carry = tw.setCarry({}, r.carryKey, r.carry);
  r = tw.triggerSpins('channel.cheer', { ...viewer, bits: 60 }, t, carry);
  assert.deepEqual([r.spins, r.carry], [1, 10]);
  assert.deepEqual(tw.setCarry(carry, '42', 0), {});
});

test('小奇點：不累積零頭、匿名不累積', () => {
  let r = tw.triggerSpins('channel.cheer', { ...viewer, bits: 250 }, trig({ bits: { carry: false } }), { 42: 90 });
  assert.equal(r.spins, 2); assert.equal(r.carryKey, undefined);
  r = tw.triggerSpins('channel.cheer', { is_anonymous: true, bits: 150 }, trig(), { '': 90 });
  assert.deepEqual([r.spins, r.who.display, r.carryKey], [1, '匿名', undefined]);
  assert.equal(tw.triggerSpins('channel.cheer', { is_anonymous: true, bits: 150 }, trig({ anon: 'skip' })), null);
});

test('小奇點：分級門檻取達到的最高一級', () => {
  const t = trig({ bits: { mode: 'tiers', tiers: [{ min: 500, spins: 6 }, { min: 100, spins: 1 }] } });
  assert.equal(tw.triggerSpins('channel.cheer', { ...viewer, bits: 99 }, t).spins, 0);
  assert.equal(tw.triggerSpins('channel.cheer', { ...viewer, bits: 499 }, t).spins, 1);
  assert.equal(tw.triggerSpins('channel.cheer', { ...viewer, bits: 5000 }, t).spins, 6);
});

test('訂閱：新訂閱、續訂、Tier 倍數、一筆上限', () => {
  const t = trig({ sub: { newSpins: 2, resubSpins: 1, t2: 2, t3: 5 }, maxSpins: 8 });
  assert.equal(tw.triggerSpins('channel.subscribe', { ...viewer, tier: '1000' }, t).spins, 2);
  assert.equal(tw.triggerSpins('channel.subscribe', { ...viewer, tier: '2000' }, t).spins, 4);
  assert.equal(tw.triggerSpins('channel.subscribe', { ...viewer, tier: '3000' }, t).spins, 8); // 10 被上限 8 擋住
  const re = tw.triggerSpins('channel.subscription.message', { ...viewer, tier: '1000', cumulative_months: 7 }, t);
  assert.deepEqual([re.spins, re.label, re.source], [1, '續訂 7 個月（Tier 1）', 'sub']);
});

test('贈訂：記給送的人（送幾份轉幾次）或收到的人，不會重複算', () => {
  const giver = trig();
  const gift = { ...viewer, tier: '1000', total: 5 };
  assert.equal(tw.triggerSpins('channel.subscription.gift', gift, giver).spins, 5);
  assert.equal(tw.triggerSpins('channel.subscribe', { user_login: 'kid', user_name: 'kid', tier: '1000', is_gift: true }, giver), null);
  const recv = trig({ sub: { gift: 'receiver' } });
  assert.equal(tw.triggerSpins('channel.subscription.gift', gift, recv), null);
  assert.equal(tw.triggerSpins('channel.subscribe', { user_login: 'kid', user_name: 'kid', tier: '1000', is_gift: true }, recv).who.login, 'kid');
  const none = trig({ sub: { gift: 'none' } });
  assert.equal(tw.triggerSpins('channel.subscription.gift', gift, none), null);
  assert.equal(tw.triggerSpins('channel.subscription.gift', { is_anonymous: true, tier: '1000', total: 2 }, giver).who.display, '匿名');
});

test('沒打開的觸發方式不轉；設定正規化給預設值', () => {
  const off = tw.normalizeTriggers({});
  assert.equal(tw.triggerSpins('channel.cheer', { ...viewer, bits: 1000 }, off), null);
  assert.equal(tw.triggerSpins('channel.subscribe', { ...viewer, tier: '1000' }, off), null);
  const cfg = tw.normalizeTwConfig({ prizes: [{ id: 'b1', name: 'x', weight: 1 }] });
  assert.equal(cfg.wheel2.name, '斗內轉盤');
  assert.ok(!cfg.wheel2.prizes.some((p) => p.id === 'b1'), '第二個轉盤的格子 id 不能跟主轉盤撞');
  assert.deepEqual(cfg.triggers.bits.tiers.map((x) => x.min), [100, 500]);
});

test('搬到 OBS 面板會帶上小奇點、訂閱設定與零頭', () => {
  const cfg = tw.normalizeTwConfig({ triggers: { bits: { on: true, per: 300 } }, bitsCarry: { 42: 120 }, wheel2: { name: '加碼' } });
  const res = tw.applyMove(tw.normalizeTwConfig({}), [], tw.decodeMove(tw.encodeMove(tw.buildMove(cfg, []))));
  assert.deepEqual([res.cfg.triggers.bits.on, res.cfg.triggers.bits.per, res.cfg.bitsCarry[42], res.cfg.wheel2.name], [true, 300, 120, '加碼']);
});

// ---------- 排隊陪玩 ----------
const pe = (id, login, extra = {}) => tw.partyEntry({ id, user_login: login, user_name: login.toUpperCase(), user_id: `u${login}`, reward: { id: 'rq' }, ...extra });

test('排隊：加入、同一人不能重複排、滿了不收、重送不重複', () => {
  const rule = tw.normalizeParty({ max: 2 });
  let s = { playing: [], waiting: [] };
  let r = tw.admitParty(s, pe('a1', 'amy', { user_input: ' Amy#123 ' }), rule); s = r.state;
  assert.equal(r.added.input, 'Amy#123');
  assert.equal(tw.admitParty(s, pe('a1', 'amy'), rule).dup, true);
  assert.match(tw.admitParty(s, pe('a2', 'amy'), rule).reason, /已經在隊伍裡/);
  s = tw.admitParty(s, pe('b1', 'bob'), rule).state;
  assert.match(tw.admitParty(s, pe('c1', 'cat'), rule).reason, /隊伍滿了/);
  assert.deepEqual(s.waiting.map((e) => e.login), ['amy', 'bob']);
});

test('排隊：下一輪把正在玩的算玩完、依序叫下一批；移出', () => {
  let s = { playing: [], waiting: ['a', 'b', 'c'].map((x) => pe(x, x)) };
  let r = tw.nextRound(s, 2); s = r.state;
  assert.deepEqual([r.done.length, r.called.map((e) => e.login), s.waiting.map((e) => e.login)], [0, ['a', 'b'], ['c']]);
  r = tw.nextRound(s, 2); s = r.state;
  assert.deepEqual([r.done.map((e) => e.login), s.playing.map((e) => e.login), s.waiting.length], [['a', 'b'], ['c'], 0]);
  assert.deepEqual(tw.removeParty(s, 'c'), { playing: [], waiting: [] });
});

test('排隊：OBS 畫面只送前幾位，預設不公開遊戲 ID', () => {
  const s = { playing: [pe('p', 'pat', { user_input: 'Pat#1' })], waiting: ['a', 'b', 'c'].map((x) => pe(x, x)) };
  let v = tw.partyView(s, tw.normalizeParty({ show: 2 }));
  assert.deepEqual([v.playing[0], v.waiting.map((e) => e.name), v.more, v.total], [{ name: 'PAT', input: '' }, ['A', 'B'], 1, 3]);
  v = tw.partyView(s, tw.normalizeParty({ showInput: true }));
  assert.equal(v.playing[0].input, 'Pat#1');
});
