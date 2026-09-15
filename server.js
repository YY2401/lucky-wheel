'use strict';
/**
 * 幸運轉盤後端
 *  - 獎項 / 機率 / 庫存設定（data/config.json）
 *  - 抽獎邏輯（伺服器端決定結果，前端只負責動畫）
 *  - 抽獎紀錄：data/records.json（備份）＋ 指定的 Excel 檔（可自訂路徑）
 *  - SSE 廣播：控制台與 OBS 覆蓋層即時同步
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ExcelJS = require('exceljs');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const RECORDS_PATH = path.join(DATA_DIR, 'records.json');
const UPLOAD_DIR = path.join(ROOT, 'public', 'uploads');
const PORT = Number(process.env.PORT) || 3000;
const SHEET_NAME = '抽獎紀錄';
const HEADERS = ['時間', '批次ID', '抽獎類型', '第幾抽', '抽獎者/備註', '獎項', '獎項ID', '剩餘數量', '當時機率(%)'];
const COL_WIDTHS = [20, 22, 10, 8, 20, 24, 14, 10, 12];

for (const d of [DATA_DIR, UPLOAD_DIR]) fs.mkdirSync(d, { recursive: true });

const DEFAULT_CONFIG = {
  title: '幸運轉盤',
  excelPath: './data/records.xlsx',
  segmentMode: 'weight', // weight = 扇區依機率比例 / equal = 平均等分
  spinDuration: 5000,
  multiSpinDuration: 1500,
  turns: 6,
  sound: true,
  overlayResultSeconds: 8,
  prizes: [
    { id: 'p1', name: '特獎 iPad', weight: 1, quantity: 1, remaining: 1, image: '', color: '#ff6b6b' },
    { id: 'p2', name: '頭獎 藍牙耳機', weight: 5, quantity: 3, remaining: 3, image: '', color: '#ffd93d' },
    { id: 'p3', name: '二獎 500 元禮券', weight: 15, quantity: 10, remaining: 10, image: '', color: '#6bcb77' },
    { id: 'p4', name: '三獎 貼圖組', weight: 30, quantity: -1, remaining: -1, image: '', color: '#4d96ff' },
    { id: 'p5', name: '銘謝惠顧', weight: 49, quantity: -1, remaining: -1, image: '', color: '#c77dff' },
  ],
};

// ---------- 檔案工具 ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
function pad(n) { return String(n).padStart(2, '0'); }
function formatTime(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---------- 設定正規化 ----------
function normalizePrize(p, i) {
  const rawQty = p.quantity === '' || p.quantity == null ? -1 : Number(p.quantity);
  const quantity = Number.isFinite(rawQty) ? Math.max(-1, Math.trunc(rawQty)) : -1;
  let remaining = p.remaining == null || p.remaining === '' ? quantity : Math.trunc(Number(p.remaining));
  if (quantity === -1) remaining = -1;
  else remaining = Math.min(Math.max(0, Number.isFinite(remaining) ? remaining : quantity), quantity);
  return {
    id: String(p.id || `p_${crypto.randomBytes(4).toString('hex')}`),
    name: String(p.name || `獎項 ${i + 1}`).slice(0, 60),
    weight: Math.max(0, Number(p.weight) || 0),
    quantity,
    remaining,
    image: String(p.image || ''),
    color: /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : '',
    note: String(p.note || ''),
  };
}
function normalizeConfig(c) {
  const cfg = { ...DEFAULT_CONFIG, ...(c || {}) };
  cfg.title = String(cfg.title || DEFAULT_CONFIG.title).slice(0, 40);
  cfg.excelPath = String(cfg.excelPath || DEFAULT_CONFIG.excelPath);
  cfg.segmentMode = cfg.segmentMode === 'equal' ? 'equal' : 'weight';
  cfg.spinDuration = Math.min(30000, Math.max(500, Number(cfg.spinDuration) || 5000));
  cfg.multiSpinDuration = Math.min(30000, Math.max(300, Number(cfg.multiSpinDuration) || 1500));
  cfg.turns = Math.min(20, Math.max(1, Math.trunc(Number(cfg.turns)) || 6));
  cfg.sound = cfg.sound !== false;
  cfg.overlayResultSeconds = Math.min(120, Math.max(1, Number(cfg.overlayResultSeconds) || 8));
  cfg.prizes = Array.isArray(cfg.prizes) ? cfg.prizes.map(normalizePrize) : [];
  return cfg;
}

let config = normalizeConfig(readJson(CONFIG_PATH, DEFAULT_CONFIG));
let records = readJson(RECORDS_PATH, []);
if (!fs.existsSync(CONFIG_PATH)) writeJson(CONFIG_PATH, config);

// ---------- 抽獎邏輯 ----------
function pool(prizes) {
  return prizes.filter((p) => p.weight > 0 && (p.remaining === -1 || p.remaining > 0));
}
function probabilities(prizes) {
  const pl = pool(prizes);
  const total = pl.reduce((s, p) => s + p.weight, 0);
  const m = {};
  pl.forEach((p) => { m[p.id] = total ? (p.weight / total) * 100 : 0; });
  return m;
}
function rand() { return crypto.randomInt(0, 2 ** 47) / 2 ** 47; }
function drawOne(prizes) {
  const pl = pool(prizes);
  if (!pl.length) return null;
  const total = pl.reduce((s, p) => s + p.weight, 0);
  let r = rand() * total;
  for (const p of pl) { r -= p.weight; if (r < 0) return p; }
  return pl[pl.length - 1];
}

async function doSpin(countRaw, playerRaw) {
  const count = Math.min(100, Math.max(1, Math.trunc(Number(countRaw)) || 1));
  const player = String(playerRaw || '').slice(0, 60);
  const now = new Date();
  const batchId = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
  const type = count === 1 ? '單抽' : `${count}連抽`;
  const results = [];
  for (let i = 0; i < count; i++) {
    const probs = probabilities(config.prizes);
    const p = drawOne(config.prizes);
    if (!p) break; // 全部抽完
    if (p.remaining > 0) p.remaining -= 1;
    results.push({
      index: i + 1, prizeId: p.id, name: p.name, image: p.image, color: p.color,
      remaining: p.remaining, probability: Math.round(probs[p.id] * 100) / 100,
    });
  }
  const time = formatTime(now);
  const recs = results.map((r) => ({
    time, batchId, type, index: r.index, player, prize: r.name, prizeId: r.prizeId,
    remaining: r.remaining, probability: r.probability,
  }));
  if (recs.length) {
    records.push(...recs);
    writeJson(RECORDS_PATH, records);
    writeJson(CONFIG_PATH, config);
  }
  let excel = { ok: true, path: excelFile() };
  if (recs.length) {
    try { await excelQueue(() => appendToExcel(recs)); }
    catch (e) { excel = { ok: false, path: excelFile(), error: e.message }; console.error('[excel] 寫入失敗：', e.message); }
  }
  const payload = {
    type: 'spin', batchId, batchType: type, count, player, results, excel,
    prizes: config.prizes, exhausted: results.length < count, time,
  };
  broadcast(payload);
  return payload;
}

// ---------- Excel ----------
let excelChain = Promise.resolve();
function excelQueue(fn) {
  const p = excelChain.then(fn, fn);
  excelChain = p.catch(() => {});
  return p;
}
function excelFile() {
  const p = config.excelPath || './data/records.xlsx';
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}
function recordToRow(r) {
  return [r.time, r.batchId, r.type, r.index, r.player, r.prize, r.prizeId, r.remaining === -1 ? '無限' : r.remaining, r.probability];
}
function writeHeader(ws) {
  const h = ws.addRow(HEADERS);
  h.font = { bold: true };
  h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE699' } };
  COL_WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}
async function appendToExcel(recs) {
  const file = excelFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const wb = new ExcelJS.Workbook();
  if (fs.existsSync(file)) await wb.xlsx.readFile(file);
  let ws = wb.getWorksheet(SHEET_NAME);
  if (!ws) ws = wb.addWorksheet(SHEET_NAME);
  if (ws.rowCount === 0 || !ws.getRow(1).getCell(1).value) writeHeader(ws);
  recs.forEach((r) => ws.addRow(recordToRow(r)));
  await wb.xlsx.writeFile(file);
}
async function rebuildExcel() {
  const file = excelFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const wb = new ExcelJS.Workbook();
  if (fs.existsSync(file)) await wb.xlsx.readFile(file);
  const old = wb.getWorksheet(SHEET_NAME);
  if (old) wb.removeWorksheet(old.id);
  const ws = wb.addWorksheet(SHEET_NAME);
  writeHeader(ws);
  records.forEach((r) => ws.addRow(recordToRow(r)));
  await wb.xlsx.writeFile(file);
}

// ---------- SSE ----------
const clients = new Set();
function broadcast(payload) {
  const msg = `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) c.write(msg);
}

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ type: 'hello', config })}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

app.get('/api/config', (req, res) => res.json(config));
app.put('/api/config', (req, res) => {
  config = normalizeConfig({ ...config, ...req.body });
  writeJson(CONFIG_PATH, config);
  broadcast({ type: 'config', config });
  res.json(config);
});
app.post('/api/reset-stock', (req, res) => {
  config.prizes.forEach((p) => { p.remaining = p.quantity; });
  writeJson(CONFIG_PATH, config);
  broadcast({ type: 'config', config });
  res.json(config);
});

const spinHandler = async (req, res) => {
  const src = req.method === 'GET' ? req.query : req.body || {};
  try { res.json(await doSpin(src.count, src.player)); }
  catch (e) { res.status(500).json({ error: e.message }); }
};
app.post('/api/spin', spinHandler);
app.get('/api/spin', spinHandler); // 方便 Stream Deck / 聊天機器人以網址觸發

app.get('/api/records', (req, res) => {
  const limit = Math.min(1000, Number(req.query.limit) || 200);
  res.json({ total: records.length, records: records.slice(-limit).reverse(), excelPath: excelFile() });
});
app.delete('/api/records', (req, res) => {
  records = [];
  writeJson(RECORDS_PATH, records);
  res.json({ ok: true });
});
app.post('/api/export', async (req, res) => {
  try { await excelQueue(rebuildExcel); res.json({ ok: true, path: excelFile(), count: records.length }); }
  catch (e) { res.status(500).json({ ok: false, path: excelFile(), error: e.message }); }
});
app.post('/api/upload', (req, res) => {
  const m = /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,(.+)$/.exec(req.body?.data || '');
  if (!m) return res.status(400).json({ error: '請上傳圖片（png/jpg/gif/webp/svg）' });
  const ext = { png: 'png', jpeg: 'jpg', jpg: 'jpg', gif: 'gif', webp: 'webp', 'svg+xml': 'svg' }[m[1]];
  const file = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), Buffer.from(m[2], 'base64'));
  res.json({ url: `/uploads/${file}` });
});
app.get('/api/status', (req, res) => {
  res.json({
    excelPath: excelFile(), excelExists: fs.existsSync(excelFile()),
    records: records.length, clients: clients.size,
    pool: pool(config.prizes).map((p) => p.name), probabilities: probabilities(config.prizes),
  });
});

app.listen(PORT, () => {
  console.log(`\n🎡 幸運轉盤已啟動`);
  console.log(`   控制台：      http://localhost:${PORT}/`);
  console.log(`   OBS 覆蓋層：  http://localhost:${PORT}/overlay.html`);
  console.log(`   Excel 檔案：  ${excelFile()}\n`);
});
