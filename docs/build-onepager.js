'use strict';
/* 用網頁同一套樣式產生單頁圖文（PNG＋PDF）。
   node docs/build-onepager.js            → 功能總覽與快速上手都重做
   node docs/build-onepager.js features   → 只做 features.json */
const path = require('node:path');
const fs = require('node:fs');
const H = require('../test/e2e/helpers');

const JOBS = { features: '忠誠點轉盤_功能總覽', quickstart: '忠誠點轉盤_快速上手' };

(async () => {
  const want = process.argv[2] ? [process.argv[2]] : Object.keys(JOBS);
  const srv = await H.serve();
  const browser = await H.launch();
  for (const key of want) {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, `${key}.json`), 'utf8'));
    const page = await browser.newPage();
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 2 });
    await page.evaluateOnNewDocument((d) => { window.DATA = d; }, data);
    await page.goto(`${srv.url}/docs/onepager.html`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    // 超過一頁就停下來：要精簡文字，不縮字
    const h = await page.evaluate(() => document.querySelector('.page').scrollHeight);
    if (h > 1123 + 2) throw new Error(`${key}：內容高度 ${h}px 超過一頁 1123px，請精簡文字`);
    const overflow = await page.evaluate(() => [...document.querySelectorAll('.card, .stat, .step')].filter((e) => e.scrollWidth > e.clientWidth + 2).length);
    if (overflow) throw new Error(`${key}：${overflow} 個區塊文字超出邊界`);
    const out = path.join(__dirname, JOBS[key]);
    await page.screenshot({ path: `${out}.png`, clip: { x: 0, y: 0, width: 794, height: 1123 } });
    await page.pdf({ path: `${out}.pdf`, width: '794px', height: '1123px', printBackground: true, pageRanges: '1' });
    console.log(`${out}.png / .pdf（高度 ${h}px）`);
    await page.close();
  }
  await browser.close(); srv.server.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
