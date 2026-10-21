/**
 * 忠誠點轉盤 → Google 試算表 接收器
 *
 * 用法：在試算表上方選單「擴充功能 → Apps Script」，把原本的內容全部刪掉、貼上這整段，
 *       儲存後「部署 → 新增部署作業 → 網頁應用程式」（執行身分：我／存取權：所有人）。
 * 不需要改任何東西。KEY 是轉盤網頁替你產生的暗號，沒有暗號的請求一律拒絕。
 *
 * 寫入方式（照試算表原本的結構）：
 *   - 觀眾名單在「兌換紀錄」B 欄，格式「顯示名稱(帳號)」；用括號裡的帳號找人，找不到就填進第一個空白列。
 *   - 每月分頁（1月…12月）第 1 列是日期、第 2 列是欄名（1點 / 3點 / 5點…），
 *     把「當天 × 轉到的獎項」那一格 +1。總表是公式，會自己跟著更新。
 */
const KEY = '__KEY__';
const NAME_SHEET = '兌換紀錄';
const SUMMARY_SHEET = '總表';
const FIRST_ROW = 3; // 第 3 列開始是觀眾
const DATE_ROW = 1;
const HEAD_ROW = 2;

function doGet() {
  return json_({ ok: true, hello: '連線成功：這是忠誠點轉盤的試算表接收器。請回到轉盤網頁按「測試連線」。' });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: '資料格式錯誤' }); }
  if (!req || req.key !== KEY) return json_({ ok: false, fatal: true, error: '暗號不符：請回轉盤網頁重新複製程式碼、貼上後重新部署' });
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return json_({ ok: false, error: '試算表忙碌中，稍後自動重試' });
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (req.action === 'ping') return json_(ping_(ss, req));
    if (req.action === 'newYear') {
      try { const res = newYear_(ss, req.year); SpreadsheetApp.flush(); return json_(res); }
      catch (err) { return json_({ ok: false, fatal: true, error: String((err && err.message) || err) }); }
    }
    if (req.action === 'move') {
      const moved = (req.records || []).map(function (r) {
        try { return move_(ss, r); } catch (err) { return { id: r && r.id, ok: false, error: String((err && err.message) || err) }; }
      });
      SpreadsheetApp.flush();
      return json_({ ok: true, results: moved });
    }
    if (req.action === 'add' || req.action === 'undo') {
      const delta = req.action === 'undo' ? -1 : 1;
      const results = (req.records || []).map(function (r) {
        try { return apply_(ss, r, delta); } catch (err) { return { id: r && r.id, ok: false, error: String((err && err.message) || err) }; }
      });
      SpreadsheetApp.flush();
      return json_({ ok: true, results: results });
    }
    return json_({ ok: false, error: '未知的動作：' + req.action });
  } finally {
    lock.releaseLock();
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- 觀眾名稱 ----------
// 「嘎唄(gabai)」「小于甜心 (xiaoyuthesweetheart_)」「安棉コットン (anmianatwork):」「shengwei_0509」都要認得
function parseViewer_(s) {
  s = String(s == null ? '' : s).trim().replace(/[:：\s]+$/, '');
  const m = s.match(/^(.*?)\s*[(（]\s*([^()（）]*?)\s*[)）]$/);
  if (m && m[2]) return { display: m[1].trim(), login: m[2].toLowerCase() };
  return { display: s, login: '' };
}

// names：B 欄由上而下的文字。回傳索引，找不到回 -1
function matchViewer_(names, login, display) {
  login = String(login || '').trim().toLowerCase();
  display = String(display || '').trim().toLowerCase();
  const parsed = names.map(parseViewer_);
  if (login) {
    for (let i = 0; i < parsed.length; i++) if (parsed[i].login === login) return i;
  }
  // 名單裡只寫了一個名字（沒有括號）：跟帳號或顯示名稱一樣就算同一人
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (p.login || !p.display) continue;
    const d = p.display.toLowerCase();
    if ((login && d === login) || (display && d === display)) return i;
  }
  // 手動輸入沒有帳號時，用顯示名稱比對有括號的列
  if (!login && display) {
    for (let i = 0; i < parsed.length; i++) if (parsed[i].display.toLowerCase() === display) return i;
  }
  return -1;
}

function viewerLabel_(r) {
  const display = String(r.display || '').trim();
  const login = String(r.login || '').trim().toLowerCase();
  if (display && login) return display + '(' + login + ')';
  return display || login;
}

// ---------- 觀眾的 Twitch 永久編號 → 名單第幾列 ----------
// 英文帳號每 60 天可以改一次，但編號永遠不變。第一次寫入時記下來，之後改了帳號也找得回同一列
function rememberViewer_(props, uid, row, name) {
  if (!props || !uid) return;
  props.setProperty('id:' + uid, JSON.stringify({ row: row, name: name, login: parseViewer_(name).login }));
}
function viewerById_(props, uid, names) {
  if (!props || !uid) return null;
  let saved = null;
  try { saved = JSON.parse(props.getProperty('id:' + uid) || 'null'); } catch (err) { return null; }
  if (!saved || !(saved.row >= FIRST_ROW) || saved.row >= FIRST_ROW + names.length) return null;
  const now = names[saved.row - FIRST_ROW];
  const cur = parseViewer_(now);
  // 那一列還是同一個人才算數（名單被重新排序過就不採用，改用帳號比對）
  if (now === saved.name || (cur.login && cur.login === saved.login)) return { row: saved.row, cur: cur };
  return null;
}

// 回傳 { row, name, isNew, renamedFrom }
function findViewerRow_(ss, r, allowAdd, props) {
  const sh = ss.getSheetByName(NAME_SHEET);
  if (!sh) throw new Error('找不到「' + NAME_SHEET + '」分頁');
  const last = Math.max(sh.getLastRow(), FIRST_ROW);
  const names = sh.getRange(FIRST_ROW, 2, last - FIRST_ROW + 1, 1).getDisplayValues().map(function (x) { return x[0]; });
  const uid = String(r.uid || '').replace(/[^0-9]/g, '');
  const login = String(r.login || '').trim().toLowerCase();

  const byId = viewerById_(props, uid, names);
  if (byId) {
    let name = names[byId.row - FIRST_ROW];
    let renamedFrom = '';
    if (login && byId.cur.login && byId.cur.login !== login) { // 改過英文帳號：括號裡換成新帳號，前面的名字照舊
      renamedFrom = byId.cur.login;
      name = (byId.cur.display || r.display || login) + '(' + login + ')';
      sh.getRange(byId.row, 2).setValue(name);
    }
    rememberViewer_(props, uid, byId.row, name);
    return { row: byId.row, name: name, isNew: false, renamedFrom: renamedFrom };
  }

  const i = matchViewer_(names, r.login, r.display);
  if (i >= 0) { rememberViewer_(props, uid, FIRST_ROW + i, names[i]); return { row: FIRST_ROW + i, name: names[i], isNew: false }; }
  if (!allowAdd) throw new Error('名單裡找不到「' + viewerLabel_(r) + '」');
  const label = viewerLabel_(r);
  if (!label) throw new Error('沒有觀眾名稱');
  // 第一個空白列（A 欄已經編好號、B 欄空著）；整份都滿了就接在最後
  let j = names.findIndex(function (n) { return !String(n).trim(); });
  if (j < 0) j = names.length;
  const row = FIRST_ROW + j;
  sh.getRange(row, 2).setValue(label);
  if (sh.getRange(row, 1).getValue() === '') sh.getRange(row, 1).setValue(row - FIRST_ROW + 1);
  rememberViewer_(props, uid, row, label);
  return { row: row, name: label, isNew: true };
}

// 名單裡沒寫 Twitch 帳號、只寫名字的人（只能靠顯示名稱比對，觀眾一改名就認不出來）
function namesWithoutLogin_(names) {
  return names.filter(function (n) {
    const v = parseViewer_(n);
    return v.display && !v.login && !/^[A-Za-z0-9_]{3,25}$/.test(v.display);
  });
}

// ---------- 月份分頁的格子 ----------
// 月份分頁的命名：開過新年度之後是「2027-1月」；還沒開過時是「1月」（從分頁上的日期看出是哪一年）
const isDate_ = function (v) { return Object.prototype.toString.call(v) === '[object Date]'; };
function sheetYear_(sh, tz) {
  const n = Math.min(sh.getLastColumn(), 60);
  if (n < 1) return null;
  const row = sh.getRange(DATE_ROW, 1, 1, n).getValues()[0];
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    if (isDate_(v)) return Number(Utilities.formatDate(v, tz, 'yyyy'));
    const x = String(v).match(/^\s*(\d{4})[/\-.年]\d{1,2}/);
    if (x) return Number(x[1]);
  }
  return null; // 日期沒寫年份：不檢查
}
function monthSheet_(ss, date) {
  const parts = String(date).split('-').map(Number);
  const y = parts[0]; const m = parts[1];
  const tz = ss.getSpreadsheetTimeZone();
  const named = ss.getSheetByName(y + '-' + m + '月');
  if (named) return named;
  const plain = ss.getSheetByName(m + '月');
  if (plain) {
    const sy = sheetYear_(plain, tz);
    if (sy === null || sy === y) return plain;
    throw new Error('還沒有 ' + y + ' 年 ' + m + ' 月的分頁（「' + m + '月」分頁是 ' + sy + ' 年的），請在轉盤網頁按「開新年度」');
  }
  if (ss.getSheetByName((y - 1) + '-' + m + '月')) throw new Error('還沒有 ' + y + ' 年 ' + m + ' 月的分頁，請在轉盤網頁按「開新年度」');
  throw new Error('找不到「' + m + '月」分頁');
}

function sameDay_(v, m, d, tz) {
  if (v === '' || v == null) return false;
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, tz, 'M/d') === m + '/' + d;
  const s = String(v);
  const x = s.match(/(\d{1,4})[/\-.年](\d{1,2})(?:[/\-.月](\d{1,2}))?/);
  if (!x) return false;
  if (x[3]) return Number(x[2]) === m && Number(x[3]) === d; // 2026/10/4
  return Number(x[1]) === m && Number(x[2]) === d; // 10/4、10月4日
}

// 某一天在月份分頁占的欄：{ start, end, heads }（start 從 0 起算、不含 end）
function dayBlock_(sh, date, tz) {
  const parts = String(date).split('-').map(Number);
  const m = parts[1]; const d = parts[2];
  const lastCol = sh.getLastColumn();
  const dates = sh.getRange(DATE_ROW, 1, 1, lastCol).getValues()[0];
  const heads = sh.getRange(HEAD_ROW, 1, 1, lastCol).getDisplayValues()[0];
  let start = -1;
  for (let i = 0; i < lastCol; i++) if (sameDay_(dates[i], m, d, tz)) { start = i; break; }
  if (start < 0) throw new Error('「' + sh.getName() + '」分頁第 1 列找不到 ' + m + '/' + d + ' 這一天');
  let end = lastCol;
  for (let i = start + 1; i < lastCol; i++) if (dates[i] !== '' && dates[i] != null) { end = i; break; }
  return { start: start, end: end, heads: heads, label: m + '/' + d };
}

// 回傳欄號（從 1 起算）
function findColumn_(sh, date, column, tz) {
  const b = dayBlock_(sh, date, tz);
  const want = String(column).trim();
  for (let i = b.start; i < b.end; i++) if (String(b.heads[i]).trim() === want) return i + 1;
  throw new Error('「' + sh.getName() + '」分頁 ' + b.label + ' 底下找不到「' + want + '」欄');
}

// 某一天底下有哪些欄名（給轉盤網頁的「寫到哪一欄」選單用）
function dayHeads_(sh, date, tz) {
  const b = dayBlock_(sh, date, tz);
  const out = [];
  for (let i = b.start; i < b.end; i++) { const h = String(b.heads[i]).trim(); if (h && out.indexOf(h) < 0) out.push(h); }
  return out;
}

function colLetter_(n) {
  let s = '';
  while (n > 0) { const k = (n - 1) % 26; s = String.fromCharCode(65 + k) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ---------- 防重複：同一筆兌換重送不會加兩次 ----------
function seen_(props, key) { return props.getProperty(key) !== null; }
function mark_(props, key, info) {
  props.setProperty(key, JSON.stringify({ t: Date.now(), c: info }));
  const all = props.getProperties();
  const keys = Object.keys(all);
  if (keys.length < 3000) return;
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000; // 兩週前的紀錄不會再重送了
  keys.forEach(function (k) {
    try { if (JSON.parse(all[k]).t < cutoff) props.deleteProperty(k); } catch (err) { /* 不是我們的資料 */ }
  });
}

function apply_(ss, r, delta) {
  if (!r || !r.id) throw new Error('缺少紀錄編號');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.date || ''))) throw new Error('日期格式錯誤');
  if (!r.column) throw new Error('缺少要寫入的欄位');
  const props = PropertiesService.getScriptProperties();
  const doneKey = (delta > 0 ? 'w:' : 'u:') + r.id;
  if (seen_(props, doneKey)) {
    const prev = JSON.parse(props.getProperty(doneKey)).c || {};
    return { id: r.id, ok: true, dup: true, cell: prev.cell, row: prev.row, name: prev.name };
  }
  if (delta < 0 && !seen_(props, 'w:' + r.id)) throw new Error('這筆沒有寫進試算表過，不用撤銷');

  const tz = ss.getSpreadsheetTimeZone();
  const sh = monthSheet_(ss, r.date);
  const col = findColumn_(sh, r.date, r.column, tz);
  const viewer = findViewerRow_(ss, r, delta > 0, props);
  const row = viewer.row;

  // 月份分頁超過原本公式範圍的列：補上「編號」和「名稱」公式，跟上面的列一樣
  if (ss.getSheetByName(SUMMARY_SHEET)) {
    const b = sh.getRange(row, 2);
    if (b.getFormula() === '' && b.getValue() === '') b.setFormula("='" + SUMMARY_SHEET + "'!B" + row);
    const a = sh.getRange(row, 1);
    if (a.getValue() === '') a.setValue(row - FIRST_ROW + 1);
  }

  const cell = sh.getRange(row, col);
  if (cell.getFormula() !== '') throw new Error(sh.getName() + '!' + colLetter_(col) + row + ' 是公式，不敢覆蓋');
  const before = Number(cell.getValue()) || 0;
  const after = Math.max(0, before + delta);
  cell.setValue(after > 0 ? after : '');
  const info = { cell: sh.getName() + '!' + colLetter_(col) + row, row: row, name: viewer.name };
  mark_(props, doneKey, info);
  return { id: r.id, ok: true, cell: info.cell, row: row, name: viewer.name, isNew: viewer.isNew, renamedFrom: viewer.renamedFrom || '', before: before, after: after };
}

// ---------- 開新年度：舊分頁改名「去年-N月」、複製出「今年-N月」並清空，總表改看今年、累積點數加上去年 ----------
function newYear_(ss, y) {
  y = Number(y);
  if (!(y >= 2000 && y < 2100)) throw new Error('年份不對');
  const tz = ss.getSpreadsheetTimeZone();
  if (ss.getSheetByName(y + '-1月')) throw new Error(y + ' 年的分頁已經建立過了');
  const out = { ok: true, year: y, created: [], renamed: [], warnings: [] };
  // 1. 還沒加年份的「N月」分頁，改名成「那一年-N月」（試算表會自動更新引用它的公式）
  for (let m = 1; m <= 12; m++) {
    const sh = ss.getSheetByName(m + '月');
    if (!sh) continue;
    const sy = sheetYear_(sh, tz) || (y - 1);
    if (sy === y) throw new Error('「' + m + '月」分頁已經是 ' + y + ' 年的，不用開新年度');
    const name = sy + '-' + m + '月';
    if (ss.getSheetByName(name)) { out.warnings.push('已經有「' + name + '」，「' + m + '月」分頁沒有改名'); continue; }
    sh.setName(name); out.renamed.push(name);
  }
  // 2. 每個月從最近一年的分頁複製一份當範本
  const prev = {};
  for (let m = 1; m <= 12; m++) {
    let src = null;
    for (let yy = y - 1; yy >= y - 10 && !src; yy--) src = ss.getSheetByName(yy + '-' + m + '月');
    if (!src) { out.warnings.push('找不到 ' + m + ' 月的舊分頁可以當範本，' + y + '-' + m + '月沒有建立'); continue; }
    prev[m] = src.getName();
    const sh = src.copyTo(ss);
    sh.setName(y + '-' + m + '月');
    resetMonth_(sh, y, m, tz, out.warnings);
    out.created.push(sh.getName());
  }
  // 3. 總表
  rollSummary_(ss, y, prev, out);
  return out;
}

// 新分頁：第 1 列日期換成新年份、清掉每天的數字（公式保留）
function resetMonth_(sh, y, m, tz, warnings) {
  const lastCol = sh.getLastColumn();
  const dates = sh.getRange(DATE_ROW, 1, 1, lastCol).getValues()[0];
  const days = new Date(y, m, 0).getDate();
  let first = -1; let sumStart = lastCol + 1; let maxDay = 0;
  for (let i = 0; i < lastCol; i++) {
    const v = dates[i];
    let d = 0;
    if (isDate_(v)) d = Number(Utilities.formatDate(v, tz, 'd'));
    else { const x = String(v).match(/(?:\d{4}[/\-.年])?\d{1,2}[/\-.月](\d{1,2})/); if (x) d = Number(x[1]); }
    if (d) {
      if (first < 0) first = i + 1;
      if (d <= days) { sh.getRange(DATE_ROW, i + 1).setFormula('=DATE(' + y + ',' + m + ',' + d + ')'); maxDay = Math.max(maxDay, d); }
      else { sh.getRange(DATE_ROW, i + 1).setValue(''); warnings.push(y + '-' + m + '月 多出 ' + m + '/' + d + ' 的欄位（今年沒有這一天），可以刪掉'); }
    } else if (first > 0 && v !== '' && v != null && sumStart > lastCol) sumStart = i + 1; // 「當月總結」
  }
  if (maxDay < days) warnings.push(y + '-' + m + '月 少了 ' + m + '/' + (maxDay + 1) + (days > maxDay + 1 ? '～' + m + '/' + days : '') + ' 的欄位：那幾天有人兌換時會寫入失敗，請照前一天的格式手動補上');
  const rows = sh.getLastRow() - FIRST_ROW + 1;
  if (first < 0 || rows < 1 || sumStart <= first) return;
  const rng = sh.getRange(FIRST_ROW, first, rows, sumStart - first);
  const f = rng.getFormulas();
  if (f.every(function (r) { return r.every(function (x) { return !x; }); })) { rng.clearContent(); return; }
  for (let i = 0; i < f.length; i++) for (let j = 0; j < f[i].length; j++) if (!f[i][j]) sh.getRange(FIRST_ROW + i, first + j).setValue('');
}

// 總表：指向去年月份分頁的欄改指向今年；其他用到這些欄的合計（累積點數等）加上去年的數字，點數不歸零
function rollSummary_(ss, y, prev, out) {
  const sh = ss.getSheetByName(SUMMARY_SHEET);
  if (!sh) { out.warnings.push('找不到「' + SUMMARY_SHEET + '」分頁，總表沒有更新'); return; }
  const last = sh.getLastRow(); const lastCol = sh.getLastColumn();
  if (last < FIRST_ROW) return;
  const F = sh.getRange(FIRST_ROW, 1, last - FIRST_ROW + 1, lastCol).getFormulas();
  const names = Object.keys(prev).map(function (m) { return prev[m]; });
  const esc = function (t) { return t.replace(/[-]/g, '\\-'); };
  const refRe = new RegExp("'(" + names.map(esc).join('|') + ")'!", 'g');
  const isMonthCol = function (f) { refRe.lastIndex = 0; return !!f && refRe.test(f); };
  const toNew = function (f) { return f.replace(refRe, function (all, n) { return "'" + y + '-' + n.replace(/^\d{4}-/, '') + "'!"; }); };
  const changed = []; // [列, 欄, 新公式]
  for (let i = 0; i < F.length; i++) {
    const row = FIRST_ROW + i;
    const monthExpr = {};
    F[i].forEach(function (f, j) { if (isMonthCol(f)) monthExpr[colLetter_(j + 1)] = '(' + f.replace(/^=/, '') + ')'; });
    if (!Object.keys(monthExpr).length) continue;
    F[i].forEach(function (f, j) {
      if (!f) return;
      if (monthExpr[colLetter_(j + 1)]) { changed.push([row, j + 1, toNew(f)]); return; }
      // 這一列的合計公式：用到哪些月份欄，就把那些欄去年的算式加上去
      const used = [];
      const tokenRe = /(^|[^A-Za-z0-9_!'.$])\$?([A-Z]{1,3})\$?(\d+)(?![0-9(])/g;
      let t;
      while ((t = tokenRe.exec(f))) if (Number(t[3]) === row && monthExpr[t[2]] && used.indexOf(t[2]) < 0) used.push(t[2]);
      if (used.length) changed.push([row, j + 1, f + '+(' + used.map(function (c) { return monthExpr[c]; }).join('+') + ')']);
    });
  }
  // 依欄寫回（同一欄連續的列一次寫，比一格一格快很多）
  const byCol = {};
  changed.forEach(function (c) { (byCol[c[1]] = byCol[c[1]] || []).push(c); });
  Object.keys(byCol).forEach(function (col) {
    const list = byCol[col].sort(function (a, b) { return a[0] - b[0]; });
    let k = 0;
    while (k < list.length) {
      let e = k;
      while (e + 1 < list.length && list[e + 1][0] === list[e][0] + 1) e++;
      sh.getRange(list[k][0], Number(col), e - k + 1, 1).setFormulas(list.slice(k, e + 1).map(function (c) { return [c[2]]; }));
      k = e + 1;
    }
  });
  out.summaryCells = changed.length;
}

// ---------- 改記給別人（代抽記錯人、事後更正）：原本的人那格 -1、新的人那格 +1 ----------
function move_(ss, r) {
  if (!r || !r.id || !r.from || !r.to) throw new Error('資料不完整');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.date || ''))) throw new Error('日期格式錯誤');
  const props = PropertiesService.getScriptProperties();
  const key = 'mv:' + r.id + ':' + (r.seq || 1);
  if (seen_(props, key)) { const prev = JSON.parse(props.getProperty(key)).c || {}; return { id: r.id, ok: true, dup: true, cell: prev.cell, row: prev.row, name: prev.name }; }
  if (!seen_(props, 'w:' + r.id)) throw new Error('這筆還沒寫進試算表，不能移動');
  if (seen_(props, 'u:' + r.id)) throw new Error('這筆已經撤銷了');
  const tz = ss.getSpreadsheetTimeZone();
  const sh = monthSheet_(ss, r.date);
  const col = findColumn_(sh, r.date, r.column, tz);
  const from = findViewerRow_(ss, r.from, false, props);
  const to = findViewerRow_(ss, r.to, true, props);
  if (from.row === to.row) throw new Error('新的人和原本是同一列');
  const a = sh.getRange(from.row, col); const b = sh.getRange(to.row, col);
  if (a.getFormula() !== '' || b.getFormula() !== '') throw new Error('要改的格子是公式，不敢覆蓋');
  const av = Math.max(0, (Number(a.getValue()) || 0) - 1);
  a.setValue(av > 0 ? av : '');
  if (ss.getSheetByName(SUMMARY_SHEET)) { // 新的人在月份分頁還沒有名稱公式時補上
    const nb = sh.getRange(to.row, 2);
    if (nb.getFormula() === '' && nb.getValue() === '') nb.setFormula("='" + SUMMARY_SHEET + "'!B" + to.row);
    const na = sh.getRange(to.row, 1);
    if (na.getValue() === '') na.setValue(to.row - FIRST_ROW + 1);
  }
  b.setValue((Number(b.getValue()) || 0) + 1);
  const info = { cell: sh.getName() + '!' + colLetter_(col) + to.row, row: to.row, name: to.name };
  props.setProperty('w:' + r.id, JSON.stringify({ t: Date.now(), c: info })); // 之後撤銷要減的是新的人
  mark_(props, key, info);
  return { id: r.id, ok: true, cell: info.cell, row: to.row, name: to.name, isNew: to.isNew };
}

// ---------- 測試連線：檢查分頁、欄位都找得到，不寫任何東西 ----------
function ping_(ss, req) {
  const out = { ok: true, title: ss.getName(), problems: [], columns: {} };
  const names = ss.getSheetByName(NAME_SHEET);
  if (!names) out.problems.push('找不到「' + NAME_SHEET + '」分頁（觀眾名單放在它的 B 欄）');
  else {
    const last = Math.max(names.getLastRow(), FIRST_ROW);
    const list = names.getRange(FIRST_ROW, 2, last - FIRST_ROW + 1, 1).getDisplayValues().map(function (x) { return String(x[0]).trim(); }).filter(Boolean);
    out.viewers = list.length;
    out.noLogin = namesWithoutLogin_(list).slice(0, 100);
  }
  if (req.date) {
    try {
      const sh = monthSheet_(ss, req.date);
      out.sheet = sh.getName();
      const tz = ss.getSpreadsheetTimeZone();
      try { out.heads = dayHeads_(sh, req.date, tz); } catch (err) { /* 找不到這一天：下面檢查欄位時會回報 */ }
      (req.columns || []).forEach(function (c) {
        try { out.columns[c] = colLetter_(findColumn_(sh, req.date, c, tz)); } catch (err) { out.problems.push(err.message); }
      });
    } catch (err) { out.problems.push(err.message); }
  }
  return out;
}
