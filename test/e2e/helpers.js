'use strict';
/* e2e 共用：起一個靜態伺服器 + 用本機 Chrome 開頁面 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.gif': 'image/gif' };
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
      let file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
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
const closeResult = (page) => page.click('#closeResult');

module.exports = { ROOT, chromePath, serve, launch, newPage, seed, readKey, sleep, spinOnce, closeResult };
