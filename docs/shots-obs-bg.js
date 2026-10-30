'use strict';
/* OBS 背景透明度的說明截圖：調整前（0%）、調整後（60%）的覆蓋層，加上設定頁的拉桿。執行：node docs/shots-obs-bg.js */
const path = require('node:path');
const fs = require('node:fs');
const H = require('../test/e2e/helpers');

const OUT = path.join(__dirname, 'img');
const { installMocks } = require('../test/e2e/twitch-mocks');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 只有模擬資料：clientId、試算表網址都是假的，頻道代碼和暗號每次隨機產生
const READY = { clientId: 'cid', sync: false, spinDuration: 2600, resultSeconds: 3, sound: false, theme: 'light', rewardIds: ['rw1'], scriptUrl: 'https://script.google.com/macros/s/AKfycb-example/exec', sheetOk: 'https://script.google.com/macros/s/AKfycb-example/exec', setupDone: true };
// OBS 底下的直播畫面：用深色棋盤格代替，透明的地方看得出來
const CHECKER = 'repeating-conic-gradient(#2b2b2b 0 25%, #3d3d3d 0 50%) 0 0 / 32px 32px';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await H.serve();
  const browser = await H.launch();
  const page = H.autoTab(await browser.newPage());
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument(installMocks);
  await page.goto(`${srv.url}/twitch.html`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => new Promise((res) => { const r = indexedDB.deleteDatabase('lucky-wheel'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
  await H.seed(page, { 'tw.records': [], 'tw.queue': [], 'tw.config': READY, 'tw.auth': { token: 'tok', clientId: 'cid' } });
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(600);
  await page.click('#toSetup').catch(() => {}); await sleep(300);
  await H.showTab(page, '#obsBgOpacity');
  const slide = (v) => page.$eval('#obsBgOpacity', (e, v) => { e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); }, v);

  const cfg = await H.readKey(page, 'tw.config');
  const ov = await browser.newPage();
  await ov.setViewport({ width: 1280, height: 720 });
  await ov.goto(`${srv.url}/index.html?overlay=1&room=${cfg.room}&key=${cfg.secret}&sync=0&status=0`, { waitUntil: 'networkidle0' });
  await sleep(800);
  const view = await browser.newPage();
  await view.setViewport({ width: 1280, height: 720 });
  // 覆蓋層照 OBS 的方式疊在棋盤格上：先截透明背景的圖，再放到棋盤格上截一次
  const overlayShot = async (name, v) => {
    await page.bringToFront(); await slide(v); await sleep(400);
    await ov.bringToFront(); await sleep(400);
    const png = await ov.screenshot({ omitBackground: true, encoding: 'base64' });
    await view.bringToFront();
    await view.setContent(`<body style="margin:0;background:${CHECKER}"><img style="display:block" src="data:image/png;base64,${png}"></body>`, { waitUntil: 'load' });
    await view.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log('shot', name);
  };
  await overlayShot('obs-bg-before', 0);
  await overlayShot('obs-bg-after', 60);

  await page.bringToFront(); await sleep(300);
  const el = await page.$('#obsBgOpacity');
  const label = await el.evaluateHandle((e) => e.closest('label'));
  await label.evaluate((e) => { e.style.outline = '10px solid transparent'; e.scrollIntoView({ block: 'center' }); });
  await label.screenshot({ path: path.join(OUT, 'obs-bg-slider.png') });
  console.log('shot obs-bg-slider');

  await browser.close(); srv.server.close();
})();
