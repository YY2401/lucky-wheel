'use strict';
/* 產生使用說明書的截圖：用真的 twitch.html，Twitch / Apps Script 換成模擬資料。執行：node docs/shots.js */
const path = require('node:path');
const fs = require('node:fs');
const H = require('../test/e2e/helpers');

const OUT = path.join(__dirname, 'img');
const { installMocks } = require('../test/e2e/twitch-mocks');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const URL_OK = 'https://script.google.com/macros/s/AKfycb-example/exec';
const BASE = { clientId: 'cid', sync: false, spinDuration: 2600, resultSeconds: 3, sound: false, theme: 'light' };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await H.serve();
  const browser = await H.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument(installMocks);
  await page.goto(`${srv.url}/twitch.html`, { waitUntil: 'networkidle0' });
  const reset = async (kv) => {
    await page.evaluate(() => new Promise((res) => { const r = indexedDB.deleteDatabase('lucky-wheel'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
    await H.seed(page, { 'tw.records': [], 'tw.queue': [], ...kv });
    await page.reload({ waitUntil: 'networkidle0' }); await sleep(600);
  };
  // 截圖時頂欄改成不黏在上方，免得蓋住捲動後的元素
  const unstick = () => page.addStyleTag({ content: '.tw .topbar,.tw-alert{position:relative!important;top:0!important}' });
  const shot = async (name, sel, pad = 12) => {
    await unstick();
    const el = await page.$(sel);
    await el.evaluate((e, pad) => { e.style.outline = `${pad}px solid transparent`; e.style.outlineOffset = '0'; }, pad);
    await el.screenshot({ path: path.join(OUT, `${name}.png`) });
    await el.evaluate((e) => { e.style.outline = ''; });
    console.log('shot', name);
  };

  // 1. 第一次打開：還沒設定
  await reset({ 'tw.config': BASE });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(OUT, 'first-open.png'), clip: { x: 0, y: 0, width: 1100, height: 560 } });
  await shot('step1-before', '#step1');

  // 2. 登入後：步驟 1 完成、步驟 2 列出品項
  await reset({ 'tw.config': BASE, 'tw.auth': { token: 'tok', clientId: 'cid' } });
  await sleep(500);
  await shot('step1-done', '#step1');
  await shot('step2-list', '#step2');
  await page.click('#rewards input[value="rw1"]'); await sleep(200);
  await shot('step2-done', '#step2');

  // 3. 試算表：貼錯網址、成功
  await page.type('#scriptUrl', 'https://script.google.com/home/projects/1AbC/edit');
  await page.click('#testSheet'); await sleep(200);
  await shot('step3-wrong', '#step3 .tw-howto li:last-child', 8);
  await page.$eval('#scriptUrl', (e) => { e.value = ''; });
  await page.type('#scriptUrl', URL_OK);
  await page.click('#testSheet'); await sleep(500);
  await shot('step3', '#step3');
  await shot('step3-ok', '#sheetResult', 8);
  await shot('step4', '#step4');
  await shot('step5', '#step5');
  await shot('finish', '.tw-setup-foot', 20);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(OUT, 'pills-ok.png'), clip: { x: 470, y: 0, width: 630, height: 62 } });

  // 4. 直播畫面：有人兌換、轉盤中、紀錄
  const now = Date.now();
  const rec = (i, login, display, prize, status, extra = {}) => ({ id: `r${i}`, time: new Date(now - i * 240000).toISOString(), date: '2026-10-04', login, display, reward: '忠誠點轉盤', prizeId: { '1點': 'pt1', '3點': 'pt3', '5點': 'pt5' }[prize], prize, column: prize, color: { '1點': '#4d96ff', '3點': '#6bcb77', '5點': '#ffd93d' }[prize], status, cell: status === 'ok' ? `10月!${{ '1點': 'AA', '3點': 'AB', '5點': 'AC' }[prize]}${3 + i}` : '', error: '', attempts: 1, ...extra });
  const READY = { ...BASE, rewardIds: ['rw1'], scriptUrl: URL_OK, sheetOk: URL_OK, setupDone: true };
  await reset({ 'tw.config': READY, 'tw.auth': { token: 'tok', clientId: 'cid' }, 'tw.records': [
    rec(1, 'gabai', '嘎唄', '3點', 'ok'), rec(2, 'newbie', '新朋友', '1點', 'ok', { isNew: true }), rec(3, 'haruneuka', 'HaruneUka', '5點', 'ok'),
  ] });
  await sleep(500);
  await page.evaluate(() => {
    window.__tw.redeem({ id: 'live1', user_login: 'smallseafood', user_name: '小海鮮', reward: { id: 'rw1', title: '忠誠點轉盤' } });
    window.__tw.redeem({ id: 'live2', user_login: 'toastiwa', user_name: '吐司瓦熊', reward: { id: 'rw1', title: '忠誠點轉盤' } });
  });
  await sleep(1300);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(OUT, 'live-spinning.png'), clip: { x: 0, y: 0, width: 1100, height: 900 } });
  await sleep(1700);
  await shot('live-result', '.tw-stage', 10);
  await sleep(4500);
  await shot('records', '.tw-side', 10);

  // 5. 狀況：寫入失敗、單筆錯誤、Twitch 過期
  await reset({ 'tw.config': READY, 'tw.auth': { token: 'tok', clientId: 'cid' }, 'tw.records': [
    rec(1, 'gabai', '嘎唄', '3點', 'error', { error: '找不到「11月」分頁' }), rec(2, 'haruneuka', 'HaruneUka', '5點', 'ok'),
  ] });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(OUT, 'alert-row-error.png'), clip: { x: 0, y: 0, width: 1100, height: 120 } });
  await shot('record-error', '.tw-side .tw-box:last-child', 10);
  await page.evaluate(() => localStorage.setItem('mock.validate', '401'));
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(800);
  await page.screenshot({ path: path.join(OUT, 'alert-twitch.png'), clip: { x: 0, y: 0, width: 1100, height: 120 } });
  await page.evaluate(() => localStorage.removeItem('mock.validate'));

  // 6. 手動補一筆、撤銷確認
  const hold = { rewardId: 'rw1', tw: 'hold', holdUntil: Date.now() + 20 * 3600e3 };
  await reset({ 'tw.config': READY, 'tw.auth': { token: 'tok', clientId: 'cid' }, 'tw.records': [rec(1, 'gabai', '嘎唄', '3點', 'ok', hold)] });
  await page.click('#manualAdd'); await sleep(300);
  await page.type('#confirmInput', '小于甜心 (xiaoyuthesweetheart_)');
  await shot('manual-add', '#confirmModal .modal-box', 6);
  await page.click('#confirmCancel'); await sleep(300);
  await page.click('[data-undo="r1"]'); await sleep(300);
  await shot('undo', '#undoModal .modal-box', 6);
  await page.click('#undoCancel');

  // 6-2. 補轉清單：網頁關著時的兌換
  const day = (d, h) => new Date(2026, 9, d, h, 12).toISOString();
  const un = (id, login, name, at) => ({ id, user_login: login, user_name: name, redeemed_at: at, status: 'UNFULFILLED', reward: { id: 'rw1', title: '忠誠點轉盤' } });
  await page.evaluate((u) => localStorage.setItem('mock.unfulfilled', JSON.stringify(u)), [un('c1', 'smallseafood', '小海鮮', day(3, 22)), un('c2', 'toastiwa', '吐司瓦熊', day(3, 23)), un('c3', 'haruneuka', 'HaruneUka', day(4, 1))]);
  await reset({ 'tw.config': READY, 'tw.auth': { token: 'tok', clientId: 'cid' } });
  await page.waitForSelector('#catchupModal:not(.hidden)');
  await shot('catchup', '#catchupModal .modal-box', 6);
  await page.click('#catchupLater');
  await page.evaluate(() => localStorage.removeItem('mock.unfulfilled'));

  // 6-3. 放進 OBS 面板：步驟 6、搬好後的瀏覽器、面板裡的樣子
  await reset({ 'tw.config': READY, 'tw.auth': { token: 'tok', clientId: 'cid' }, 'tw.records': [rec(1, 'gabai', '嘎唄', '3點', 'ok', hold), rec(2, 'haruneuka', 'HaruneUka', '5點', 'ok', hold)] });
  await browser.defaultBrowserContext().overridePermissions(srv.url, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  await page.click('#toSetup'); await sleep(300);
  await shot('step6', '#step6');
  // 步驟 7：小奇點、訂閱也轉盤（打開兩種，訂閱用第二個轉盤）
  await page.click('#bitsOn'); await page.click('#subOn'); await sleep(200);
  await page.select('#subWheel', 'bonus'); await sleep(600);
  await shot('step7', '#step7');
  await page.click('#bitsOn'); await page.click('#subOn'); await sleep(200);
  await page.click('#copyDock'); await sleep(400);
  const dockLink = await page.evaluate(() => navigator.clipboard.readText());
  await page.click('#confirmOk'); await sleep(400);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.addStyleTag({ content: '.tw .topbar,.tw-alert{position:relative!important;top:0!important}' });
  const mb = await page.$('#movedBanner');
  const top = await page.$('header.topbar');
  const a = await top.boundingBox(); const b = await mb.boundingBox();
  await page.screenshot({ path: path.join(OUT, 'moved.png'), clip: { x: 0, y: a.y, width: 1100, height: b.y + b.height - a.y } });
  const ctx = await browser.createBrowserContext();
  const dock = await ctx.newPage();
  await dock.setViewport({ width: 380, height: 760, deviceScaleFactor: 2 });
  await dock.evaluateOnNewDocument(installMocks);
  await dock.goto(dockLink, { waitUntil: 'networkidle0' }); await sleep(900);
  await dock.evaluate(() => { document.querySelector('#toast').classList.remove('show'); });
  await sleep(400);
  await dock.screenshot({ path: path.join(OUT, 'dock-live.png') });
  console.log('shot dock-live');
  await ctx.close();

  // 7. OBS 畫面（上一段按了「搬好了」會停止接收兌換，先重設回一般狀態）
  await reset({ 'tw.config': READY, 'tw.auth': { token: 'tok', clientId: 'cid' } });
  const cfg = await H.readKey(page, 'tw.config');
  const ov = await browser.newPage();
  await ov.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await ov.goto(`${srv.url}/index.html?overlay=1&room=${cfg.room}&key=${cfg.secret}&sync=0&bg=0`, { waitUntil: 'networkidle0' });
  await ov.evaluate(() => { document.body.style.background = 'repeating-conic-gradient(#d8d8d8 0 25%, #f3f3f3 0 50%) 0 0 / 32px 32px'; });
  await sleep(1200);
  await page.evaluate(() => window.__tw.redeem({ id: 'obs1', user_login: 'gabai', user_name: '嘎唄', reward: { id: 'rw1', title: '忠誠點轉盤' } }));
  await ov.waitForSelector('#ovBanner:not(.hidden)', { timeout: 10000 }); await sleep(900); // 等名字出現、轉盤轉起來再拍
  await ov.screenshot({ path: path.join(OUT, 'obs-spin.png') });
  await sleep(3200);
  await ov.screenshot({ path: path.join(OUT, 'obs-result.png') });
  await ov.close();

  // 8. 排隊陪玩：設定步驟 8、直播畫面的排隊名單、OBS 排隊名單
  await page.evaluate(() => localStorage.setItem('mock.party', '1'));
  const pe = (id, n, input) => ({ id, login: n.toLowerCase(), display: n, userId: '', input, rewardId: 'rwq', at: '2026-10-25T13:05:00Z' });
  await reset({ 'tw.config': { ...READY, party: { rewardId: 'rwq', batch: 1, show: 5 } }, 'tw.auth': { token: 'tok', clientId: 'cid' },
    'tw.party': { playing: [pe('p1', '小明', 'Ming#1234')], waiting: [pe('w1', '嘎唄', 'Gabai#22'), pe('w2', 'HaruneUka', 'Uka#8'), pe('w3', '秋野貼鐵', 'AKN#7')] } });
  await sleep(600);
  await shot('party-live', '#partyBox', 10);
  await page.click('#toSetup'); await sleep(400);
  await shot('step8', '#step8');
  const cfg2 = await H.readKey(page, 'tw.config');
  const qv = await browser.newPage();
  await qv.setViewport({ width: 400, height: 380, deviceScaleFactor: 2 });
  await qv.goto(`${srv.url}/queue.html?room=${cfg2.room}&key=${cfg2.secret}&sync=0`, { waitUntil: 'networkidle0' });
  await qv.evaluate(() => { document.body.style.background = 'repeating-conic-gradient(#d8d8d8 0 25%, #f3f3f3 0 50%) 0 0 / 32px 32px'; });
  await qv.waitForSelector('#card:not(.hidden)', { timeout: 10000 }); await sleep(800);
  await qv.screenshot({ path: path.join(OUT, 'obs-party.png') });
  console.log('shot obs-party');
  await page.evaluate(() => localStorage.removeItem('mock.party'));

  await browser.close(); srv.server.close();
})();
