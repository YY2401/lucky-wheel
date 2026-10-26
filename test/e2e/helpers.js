'use strict';
/* e2e 共用：起一個靜態伺服器 + 用本機 Chrome 開頁面 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.gif': 'image/gif', '.pdf': 'application/pdf' };
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

function chromePath() { return CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } }); }

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      let file = path.join(ROOT, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function launch() {
  const puppeteer = require('puppeteer-core');
  return puppeteer.launch({ executablePath: chromePath(), headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--no-sandbox'] });
}

async function newPage(browser, { width = 1440, height = 900 } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', (d) => { page.errors.push(`native dialog: ${d.message()}`); d.dismiss(); });
  return page;
}

// 直接寫 IndexedDB，讓測試從已知狀態開始
async function seed(page, kv) {
  await page.evaluate((kv) => new Promise((res, rej) => {
    const r = indexedDB.open('lucky-wheel', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => { const t = r.result.transaction('kv', 'readwrite'); Object.entries(kv).forEach(([k, v]) => t.objectStore('kv').put(v, k)); t.oncomplete = res; t.onerror = () => rej(t.error); };
    r.onerror = () => rej(r.error);
  }), kv);
}
async function readKey(page, key) {
  return page.evaluate((key) => new Promise((res) => { const r = indexedDB.open('lucky-wheel', 1); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => res(q.result); }; }), key);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const spinOnce = async (page, count) => {
  await page.click(`.spin-btn[data-count="${count}"]`);
  await page.waitForSelector('#resultModal:not(.hidden)', { timeout: 15000 });
};
// 結果視窗彈出時有縮放動畫（落空還會搖一下），動畫中「關閉」的位置會移動：
// 太快點會點到視窗本體沒關成，下一次按抽獎就只會點到背景把視窗關掉、不會抽。等動畫停了再點，沒關掉就再點一次
const closeResult = async (page) => {
  for (let i = 0; i < 5; i++) {
    await page.waitForFunction(() => { const b = document.querySelector('#resultModal .modal-box'); return !b || b.getAnimations().every((a) => a.playState !== 'running'); }, { timeout: 5000 }).catch(() => {});
    await page.click('#closeResult');
    try { await page.waitForSelector('#resultModal.hidden', { timeout: 1000 }); return; } catch { /* 點到動畫中的位置，再點一次 */ }
  }
  throw new Error('結果視窗關不掉');
};

// 忠誠點轉盤的設定頁是頁籤：元素在沒打開的頁籤裡時，先點那個頁籤（跟使用者實際操作一樣）
async function showTab(page, sel) {
  await page.evaluate((s) => {
    const el = document.querySelector(s); const sec = el && el.closest('.tw-step.tab-hidden');
    if (sec) { const b = document.querySelector(`#setupTabs [data-tab="${sec.id.replace('step', '')}"]`); if (b) b.click(); }
  }, sel).catch(() => {});
}
// 讓 page.click／type／select 自動先切到元素所在的頁籤
function autoTab(page) {
  for (const m of ['click', 'type', 'select']) {
    const orig = page[m].bind(page);
    page[m] = async (sel, ...rest) => { await showTab(page, sel); return orig(sel, ...rest); };
  }
  return page;
}

module.exports = { showTab, autoTab, ROOT, chromePath, serve, launch, newPage, seed, readKey, sleep, spinOnce, closeResult };
