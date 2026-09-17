'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

if (!H.chromePath()) {
  test('e2e（找不到 Chrome，略過；可用 CHROME_PATH 指定）', { skip: true }, () => {});
} else {
  let srv, browser;
  before(async () => { srv = await H.serve(); browser = await H.launch(); });
  after(async () => { await browser.close(); srv.server.close(); });

  const FAST = { prizes: [
    { id: 'a', name: '特獎', weight: 1, quantity: 1, remaining: 1, pity: true },
    { id: 'b', name: '頭獎', weight: 5, quantity: 3, remaining: 3, pity: true },
    { id: 'c', name: '銘謝惠顧', weight: 94, quantity: -1, remaining: -1 },
  ] };
  async function fresh(t, extra = {}, query = '') {
    const page = await H.newPage(browser);
    t.after(() => page.close());
    await page.goto(`${srv.url}/?t=${Date.now()}${query}`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => new Promise((res) => { const r = indexedDB.deleteDatabase('lucky-wheel'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
    await H.seed(page, { 'lw.config': { ...FAST, ...extra }, 'lw.records': [], 'lw.skipAnim': true });
    await page.reload({ waitUntil: 'networkidle0' });
    await H.sleep(400);
    return page;
  }

  test('載入無錯誤、預設白底、轉盤有畫出獎項', async (t) => {
    const page = await fresh(t);
    assert.deepEqual(page.errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    assert.equal(await page.$$eval('#prizeRows tr', (r) => r.length), 3);
  });

  test('五連抽：扣庫存、寫紀錄、結果視窗五張卡、重整後資料還在', async (t) => {
    const page = await fresh(t);
    await H.spinOnce(page, 5);
    assert.equal(await page.$$eval('#resultGrid .r-card', (c) => c.length), 5);
    const recs = await H.readKey(page, 'lw.records');
    assert.equal(recs.length, 5);
    await page.reload({ waitUntil: 'networkidle0' }); await H.sleep(400);
    assert.equal((await H.readKey(page, 'lw.records')).length, 5);
    assert.equal(await page.$eval('#skipAnim', (e) => e.checked), true);
    assert.deepEqual(page.errors, []);
  });

  test('撤銷：跳出頁內確認視窗（不是原生 confirm），取消不動、確定後庫存加回、紀錄移除', async (t) => {
    const page = await fresh(t);
    const before = (await H.readKey(page, 'lw.config')).prizes.map((p) => p.remaining);
    await H.spinOnce(page, 3); await H.sleep(300);
    await page.click('#undoThis'); await H.sleep(300);
    assert.equal(await page.$eval('#confirmModal', (e) => !e.classList.contains('hidden')), true);
    await page.click('#confirmCancel'); await H.sleep(200);
    assert.equal((await H.readKey(page, 'lw.records')).length, 3);
    await page.click('#undoThis'); await H.sleep(300); await page.click('#confirmOk'); await H.sleep(400);
    assert.equal((await H.readKey(page, 'lw.records')).length, 0);
    assert.deepEqual((await H.readKey(page, 'lw.config')).prizes.map((p) => p.remaining), before);
    assert.equal(await page.$eval('#resultModal', (e) => e.classList.contains('hidden')), true);
    assert.deepEqual(page.errors, [], '不應出現原生對話框或錯誤');
  });

  test('紀錄搜尋與統計：依抽獎者過濾、統計跟著搜尋結果', async (t) => {
    const page = await fresh(t);
    await page.type('#player', '小明'); await H.spinOnce(page, 3); await H.closeResult(page);
    await page.evaluate(() => { document.querySelector('#player').value = '阿花'; });
    await H.spinOnce(page, 1); await H.closeResult(page);
    await page.click('.open-panel[data-tab="records"]'); await H.sleep(300);
    assert.match(await page.$eval('#statsTitle', (e) => e.textContent), /共 4 抽/);
    await page.type('#recordSearch', '小明'); await H.sleep(200);
    assert.match(await page.$eval('#recordCount', (e) => e.textContent), /符合 3 \/ 4 筆/);
    assert.equal(await page.$$eval('#recordRows tr', (r) => r.length), 3);
    assert.match(await page.$eval('#statsTitle', (e) => e.textContent), /搜尋結果.*共 3 抽/);
  });

  test('獎項表格：打字不失焦、換順序 / 刪除 / 新增 / 無限切換都正確對帳', async (t) => {
    const page = await fresh(t);
    await page.click('.open-panel[data-tab="prizes"]'); await H.sleep(300);
    // 打字途中表格會因機率重算而更新，焦點與輸入內容都要保留
    const name = await page.$('#prizeRows tr:nth-child(2) .f-name');
    await name.click({ clickCount: 3 }); await name.type('頭獎改名');
    assert.equal(await page.evaluate(() => document.activeElement.className), 'f-name');
    assert.equal(await page.$eval('#prizeRows tr:nth-child(2) .f-name', (e) => e.value), '頭獎改名');
    assert.equal(await page.$eval('#prizeRows tr:nth-child(2) .prob', (e) => e.textContent), '5.00%');
    // 第二列下移 → 順序變成 特獎、銘謝惠顧、頭獎改名；同一個 DOM 節點被搬動而不是重建
    const nodeBefore = await page.evaluateHandle(() => document.querySelector('#prizeRows tr:nth-child(2)'));
    await page.click('#prizeRows tr:nth-child(2) .f-down'); await H.sleep(150);
    assert.deepEqual(await page.$$eval('#prizeRows .f-name', (els) => els.map((e) => e.value)), ['特獎', '銘謝惠顧', '頭獎改名']);
    assert.equal(await page.evaluate((n) => n === document.querySelector('#prizeRows tr:nth-child(3)'), nodeBefore), true);
    assert.equal(await page.$eval('#prizeRows tr:nth-child(3) .f-down', (e) => e.disabled), true, '最後一列不能再下移');
    // 無限切換：欄位啟用並填回數字
    await page.click('#prizeRows tr:nth-child(2) .f-unlimited'); await H.sleep(150);
    assert.equal(await page.$eval('#prizeRows tr:nth-child(2) .f-quantity', (e) => e.disabled), false);
    assert.equal(await page.$eval('#prizeRows tr:nth-child(2) .f-quantity', (e) => e.value), '10');
    // 刪除第一列、新增一列
    await page.click('#prizeRows tr:nth-child(1) .f-del'); await H.sleep(200); await page.click('#confirmOk'); await H.sleep(200);
    await page.click('#addPrize'); await H.sleep(150);
    assert.deepEqual(await page.$$eval('#prizeRows .f-name', (els) => els.map((e) => e.value)), ['銘謝惠顧', '頭獎改名', '獎項 3']);
    // 儲存後重整，順序與內容一致
    await page.click('#savePrizes'); await H.sleep(300);
    await page.reload({ waitUntil: 'networkidle0' }); await H.sleep(300);
    await page.click('.open-panel[data-tab="prizes"]'); await H.sleep(200);
    assert.deepEqual(await page.$$eval('#prizeRows .f-name', (els) => els.map((e) => e.value)), ['銘謝惠顧', '頭獎改名', '獎項 3']);
    assert.deepEqual(page.errors, []);
  });

  test('獎項一覽：左上角按鈕收合、機率 / 剩餘可切換、抽獎後即時更新、偏好會記住', async (t) => {
    const page = await fresh(t);
    assert.equal(await page.$eval('#prizeList', (e) => e.classList.contains('hidden')), true, '預設收合');
    await page.click('#togglePrizeList'); await H.sleep(150);
    assert.equal(await page.$eval('#prizeList', (e) => e.classList.contains('hidden')), false);
    assert.deepEqual(await page.$$eval('#prizeListRows .pl-name', (els) => els.map((e) => e.textContent)), ['特獎', '頭獎', '銘謝惠顧']);
    assert.deepEqual(await page.$$eval('#prizeListRows .pl-prob', (els) => els.map((e) => e.textContent)), ['1.00%', '5.00%', '94.0%']);
    assert.deepEqual(await page.$$eval('#prizeListRows .pl-stock', (els) => els.map((e) => e.textContent)), ['剩 1', '剩 3', '不限']);
    await page.click('#plShowProb'); await H.sleep(100);
    assert.equal(await page.$$eval('#prizeListRows .pl-prob', (els) => els.length), 0, '關掉機率後不顯示');
    // 抽獎後清單要跟著更新：與儲存的庫存一致（把銘謝惠顧權重設 0，確保一定扣到限量獎）
    await page.click('.open-panel[data-tab="prizes"]'); await H.sleep(200);
    const w = await page.$('#prizeRows tr:nth-child(3) .f-weight'); await w.click({ clickCount: 3 }); await w.type('0');
    await page.click('#savePrizes'); await H.sleep(200); await page.click('#closePanel');
    await H.spinOnce(page, 3); await H.closeResult(page); await H.sleep(200);
    const cfg = await H.readKey(page, 'lw.config');
    const expect = cfg.prizes.map((p) => (p.quantity === -1 ? '不限' : p.remaining === 0 ? '抽完' : `剩 ${p.remaining}`));
    assert.deepEqual(await page.$$eval('#prizeListRows .pl-stock', (els) => els.map((e) => e.textContent)), expect);
    assert.notDeepEqual(expect, ['剩 1', '剩 3', '不限'], '三連抽全部落在限量獎，庫存一定變');
    await page.reload({ waitUntil: 'networkidle0' }); await H.sleep(400);
    assert.equal(await page.$eval('#prizeList', (e) => e.classList.contains('hidden')), false, '展開狀態記住');
    assert.equal(await page.$eval('#plShowProb', (e) => e.checked), false, '機率開關記住');
    await page.click('#togglePrizeList'); await H.sleep(100);
    assert.equal(await page.$eval('#prizeList', (e) => e.classList.contains('hidden')), true);
    assert.deepEqual(page.errors, []);
  });

  test('保底：連抽保底每 5 抽至少一個，40 批全部符合', async (t) => {
    const page = await fresh(t, { pityBatch: true, pityBatchK: 5, prizes: FAST.prizes.map((p) => ({ ...p, quantity: -1, remaining: -1 })) });
    for (let i = 0; i < 40; i++) { await H.spinOnce(page, 5); await H.closeResult(page); }
    const recs = await H.readKey(page, 'lw.records');
    const batches = {}; recs.forEach((r) => { (batches[r.batchId] ||= []).push(r); });
    assert.equal(Object.keys(batches).length, 40);
    assert.ok(Object.values(batches).every((b) => b.some((r) => r.hit)));
    assert.deepEqual(page.errors, []);
  });

  test('設定：秒 ↔ 毫秒換算、OBS 網址依選項組合、重整後保留', async (t) => {
    const page = await fresh(t);
    await page.click('.open-panel[data-tab="settings"]'); await H.sleep(300);
    assert.equal(await page.$eval('#s-spinDuration', (e) => e.value), '5');
    await page.evaluate(() => { document.querySelector('#s-spinDuration').value = '3.5'; document.querySelector('#s-overlaySize').value = '700'; document.querySelector('#s-overlaySpinOnly').checked = true; });
    await page.click('#saveSettings'); await H.sleep(300);
    const url = await page.$eval('#overlayUrl', (e) => e.textContent);
    assert.match(url, /overlay=1&room=[A-Z0-9]+&size=700&mode=spin$/);
    await page.evaluate(() => { document.querySelector('#s-overlayList').checked = true; document.querySelector('#s-overlayListStock').checked = false; });
    await page.click('#saveSettings'); await H.sleep(300);
    assert.match(await page.$eval('#overlayUrl', (e) => e.textContent), /&list=1&ls=0$/);
    assert.equal((await H.readKey(page, 'lw.config')).spinDuration, 3500);
    await page.reload({ waitUntil: 'networkidle0' }); await H.sleep(300);
    await page.click('.open-panel[data-tab="settings"]'); await H.sleep(200);
    assert.equal(await page.$eval('#s-spinDuration', (e) => e.value), '3.5');
  });

  test('主題切換：頂欄按鈕立即套用並記住', async (t) => {
    const page = await fresh(t);
    await page.click('.theme-toggle button[data-theme="dark"]'); await H.sleep(200);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await page.reload({ waitUntil: 'networkidle0' }); await H.sleep(300);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  });

  test('舊版 localStorage 資料會自動搬進 IndexedDB', async (t) => {
    const page = await H.newPage(browser); t.after(() => page.close());
    await page.goto(`${srv.url}/?t=${Date.now()}`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => new Promise((res) => { const r = indexedDB.deleteDatabase('lucky-wheel'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
    await page.evaluate(() => { localStorage.setItem('lw.config', JSON.stringify({ room: 'OLDROOM', prizes: [{ id: 'x', name: '舊資料獎', weight: 1 }] })); localStorage.setItem('lw.records', JSON.stringify([{ time: 't', batchId: 'b', type: '單抽', index: 1, player: '舊', prize: '舊資料獎', prizeId: 'x' }])); });
    await page.reload({ waitUntil: 'networkidle0' }); await H.sleep(400);
    assert.equal(await page.evaluate(() => localStorage.getItem('lw.config')), null, '搬完要清掉舊資料');
    assert.equal((await H.readKey(page, 'lw.config')).room, 'OLDROOM');
    assert.equal((await H.readKey(page, 'lw.records')).length, 1);
    assert.equal(await page.$eval('.f-name', (e) => e.value), '舊資料獎');
  });

  test('OBS 覆蓋層：同瀏覽器同步、測試連線有回應、會播放抽獎結果', async (t) => {
    const page = await fresh(t, { spinDuration: 600, multiSpinDuration: 300 });
    const room = (await H.readKey(page, 'lw.config')).room;
    const ov = await H.newPage(browser, { width: 1280, height: 720 }); t.after(() => ov.close());
    await ov.goto(`${srv.url}/?overlay=1&room=${room}&sync=0&list=1&lp=0&t=${Date.now()}`, { waitUntil: 'networkidle0' }); await H.sleep(500);
    assert.deepEqual(await ov.$$eval('#ovPrizeListRows .pl-name', (els) => els.map((e) => e.textContent)), ['特獎', '頭獎', '銘謝惠顧'], '覆蓋層獎項一覽');
    assert.equal(await ov.$$eval('#ovPrizeListRows .pl-prob', (els) => els.length), 0, 'lp=0 不顯示機率');
    await page.bringToFront(); await page.click('.open-panel[data-tab="settings"]'); await H.sleep(200);
    await page.click('#testSync'); await H.sleep(3500);
    assert.match(await page.$eval('#toast', (e) => e.textContent), /已回應（1 個）/);
    await page.click('#closePanel');
    await page.evaluate(() => { document.querySelector('#skipAnim').checked = false; });
    await H.spinOnce(page, 3);
    await ov.bringToFront();
    await ov.waitForSelector('#ovResultLayer:not(.out)', { timeout: 20000 });
    assert.equal(await ov.$$eval('#ovGrid .r-card', (c) => c.length), 3);
    const ovStocks = await ov.$$eval('#ovPrizeListRows .pl-stock', (els) => els.map((e) => e.textContent));
    const ctrlCfg = await H.readKey(page, 'lw.config');
    assert.deepEqual(ovStocks, ctrlCfg.prizes.map((p) => (p.quantity === -1 ? '不限' : p.remaining === 0 ? '抽完' : `剩 ${p.remaining}`)), '抽獎後覆蓋層一覽的剩餘與控制台一致');
    assert.deepEqual(ov.errors, []);
  });
}
