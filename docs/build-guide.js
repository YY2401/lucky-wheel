'use strict';
/* 把 docs/guide.html 轉成 PDF。先跑 node docs/shots.js 產生截圖，再跑 node docs/build-guide.js */
const path = require('node:path');
const H = require('../test/e2e/helpers');

(async () => {
  const srv = await H.serve();
  const browser = await H.launch();
  const page = await browser.newPage();
  await page.goto(`${srv.url}/docs/guide.html`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  const out = path.join(__dirname, '忠誠點轉盤使用說明.pdf');
  await page.pdf({
    path: out, format: 'A4', printBackground: true, preferCSSPageSize: true,
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: '<div style="width:100%;font-size:8px;color:#888;text-align:center;font-family:sans-serif">忠誠點轉盤 使用說明書　·　<span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  });
  console.log(out);
  await browser.close(); srv.server.close();
})();
