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

  const FAST = { countdown: 0, prizes: [
    { id: 'a', name: '特獎', weight: 1, quantity: 1, remaining: 1, pity: true },
    { id: 'b', name: '頭獎', weight: 5, quantity: 3, remaining: 3, pity: true },
    { id: 'c', name: '銘謝惠顧', weight: 94, quantity: -1, remaining: -1 },
  ] };
  async function fresh(t, extra = {}, query = '') {
    const page = await H.newPage(browser);
    t.after(() => page.close());
    await page.goto(`${srv.url}/?t=${Date.now()}${query}`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => new Promise((res) => { const r = indexedDB.deleteDatabase('lucky-wheel'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
    await H.seed(page, { 'lw.config': { ...FAST, ...extra }, 'lw.records': [], 'lw.skipAnim': true, 'lw.meta': { helpSeen: true } });
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
    // 拖曳：標題列按住拖到 (300,200)，位置記住；雙擊回原位；置中放大
    const head = await page.$('#prizeListHead'); const hb = await head.boundingBox();
    const start = await page.$eval('#prizeList', (e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top }; });
    await page.mouse.move(hb.x + 10, hb.y + 10); await page.mouse.down(); await page.mouse.move(hb.x + 10 + 250, hb.y + 10 + 120, { steps: 5 }); await page.mouse.up(); await H.sleep(150);
    const box = await page.$eval('#prizeList', (e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top }; });
    assert.ok(Math.abs(box.left - (start.left + 250)) < 3 && Math.abs(box.top - (start.top + 120)) < 3, `拖曳後位置 ${box.left},${box.top}，預期 ${start.left + 250},${start.top + 120}`);
    await page.reload({ waitUntil: 'networkidle0' }); await H.sleep(400);
    const box2 = await page.$eval('#prizeList', (e) => ({ left: e.getBoundingClientRect().left }));
    assert.ok(Math.abs(box2.left - (start.left + 250)) < 3, '拖曳位置重整後保留');
    await page.click('#plCenter'); await H.sleep(150);
    assert.equal(await page.$eval('#prizeList', (e) => e.classList.contains('centered')), true);
    const cb = await page.$eval('#prizeList', (e) => { const r = e.getBoundingClientRect(); return Math.abs(r.left + r.width / 2 - innerWidth / 2) + Math.abs(r.top + r.height / 2 - innerHeight / 2); });
    assert.ok(cb < 4, '置中模式在畫面正中間');
    await page.click('#plCenter'); await page.click('#prizeListHead', { clickCount: 2 }); await H.sleep(150);
    assert.ok(Math.abs((await page.$eval('#prizeList', (e) => e.getBoundingClientRect().left)) - 22) < 3, '雙擊回到原位');
    await page.click('#plClose'); await H.sleep(100);
    assert.equal(await page.$eval('#prizeList', (e) => e.classList.contains('hidden')), true);
    assert.deepEqual(page.errors, []);
  });

  test('撤銷指定批次：中間那批撤掉，前後兩批保留、庫存正確加回', async (t) => {
    const page = await fresh(t, { prizes: [{ id: 'a', name: '限量', weight: 1, quantity: 10, remaining: 10 }] });
    for (const n of ['一', '二', '三']) { await page.evaluate((n) => { document.querySelector('#player').value = n; }, n); await H.spinOnce(page, 3); await H.closeResult(page); }
    assert.equal((await H.readKey(page, 'lw.config')).prizes[0].remaining, 1);
    await page.click('.open-panel[data-tab="records"]'); await H.sleep(300);
    const btns = await page.$$('#recordRows .f-undo');
    assert.equal(btns.length, 3, '每批一顆撤銷鈕');
    await btns[1].click(); await H.sleep(300); await page.click('#confirmOk'); await H.sleep(400);
    const recs = await H.readKey(page, 'lw.records');
    assert.deepEqual([...new Set(recs.map((r) => r.player))], ['一', '三']);
    assert.equal((await H.readKey(page, 'lw.config')).prizes[0].remaining, 4);
    assert.equal((await page.$$('#recordRows .f-undo')).length, 2);
  });

  test('抽獎者名字選單：用過的名字出現在下拉清單，最新在前', async (t) => {
    const page = await fresh(t);
    for (const n of ['小明', '阿花', '小明']) { await page.evaluate((n) => { document.querySelector('#player').value = n; }, n); await H.spinOnce(page, 1); await H.closeResult(page); }
    assert.deepEqual(await page.$$eval('#playerNames option', (els) => els.map((e) => e.value)), ['小明', '阿花']);
    assert.equal(await page.$eval('#player', (e) => e.getAttribute('list')), 'playerNames');
  });

  test('保底獎全部抽完時，主畫面提示改為「已抽完」而不是倒數', async (t) => {
    const page = await fresh(t, { pityAccum: true, pityAccumN: 5, prizes: [{ id: 'a', name: '保底獎', weight: 1, quantity: 1, remaining: 0, pity: true }, { id: 'c', name: '銘謝惠顧', weight: 9, quantity: -1, remaining: -1 }] });
    assert.match(await page.$eval('#pityInfo', (e) => e.textContent), /保底獎已全部抽完/);
  });

  test('多分頁：第二個控制台分頁會被鎖住，接手後原分頁被鎖', async (t) => {
    const page = await fresh(t);
    const second = await H.newPage(browser); t.after(() => second.close());
    await second.goto(`${srv.url}/?t=${Date.now()}`, { waitUntil: 'networkidle0' }); await H.sleep(800);
    assert.equal(await second.$eval('#lockScreen', (e) => e.classList.contains('hidden')), false, '第二個分頁鎖住');
    assert.equal(await page.$eval('#lockScreen', (e) => e.classList.contains('hidden')), true, '原分頁不受影響');
    await second.click('#takeover'); await H.sleep(1200);
    assert.equal(await second.$eval('#lockScreen', (e) => e.classList.contains('hidden')), true, '接手的分頁可用');
    assert.equal(await page.$eval('#lockScreen', (e) => e.classList.contains('hidden')), false, '原分頁被鎖');
  });

  test('備份與還原：備份檔含設定＋紀錄，清空後還原可完整回來；匯入設定拒收備份檔', async (t) => {
    const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
    const page = await fresh(t);
    await page.evaluate(() => { document.querySelector('#player').value = '備份君'; });
    await H.spinOnce(page, 3); await H.closeResult(page);
    await page.click('#togglePrizeList'); await H.sleep(100); // 偏好也要一起備份
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-backup-'));
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
    await page.click('.open-panel[data-tab="records"]'); await H.sleep(200);
    assert.equal(await page.$eval('#backupInfo', (e) => e.textContent), '還沒備份過');
    await page.click('#backupAll');
    let file; for (let i = 0; i < 40 && !file; i++) { await H.sleep(100); file = fs.readdirSync(dir).find((f) => f.endsWith('.lwbackup')); }
    assert.ok(file, '有下載備份檔');
    const backup = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.equal(backup.kind, 'lucky-wheel-backup');
    assert.equal(backup.records.length, 3);
    assert.equal(backup.config.prizes.length, 3);
    assert.equal(backup.prizeList.open, true);
    assert.match(await page.$eval('#backupInfo', (e) => e.textContent), /上次備份：/);
    // 清空（模擬換電腦）再還原
    await page.evaluate(() => new Promise((res) => { const r = indexedDB.deleteDatabase('lucky-wheel'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
    await H.seed(page, { 'lw.meta': { helpSeen: true } }); // 清空後第一次開會跳說明，測試裡先標成看過
    await page.reload({ waitUntil: 'networkidle0' }); await H.sleep(400);
    assert.equal((await H.readKey(page, 'lw.records') || []).length, 0);
    await page.click('.open-panel[data-tab="records"]'); await H.sleep(200);
    const input = await page.$('#restoreFile'); await input.uploadFile(path.join(dir, file)); await H.sleep(400);
    assert.equal(await page.$eval('#confirmModal', (e) => !e.classList.contains('hidden')), true, '還原前有確認');
    await page.click('#confirmOk'); await H.sleep(500);
    assert.equal((await H.readKey(page, 'lw.records')).length, 3);
    assert.deepEqual((await H.readKey(page, 'lw.config')).prizes.map((p) => p.name), ['特獎', '頭獎', '銘謝惠顧']);
    assert.equal(await page.$eval('#prizeList', (e) => e.classList.contains('hidden')), false, '偏好一起還原');
    assert.deepEqual([...new Set((await H.readKey(page, 'lw.records')).map((r) => r.player))], ['備份君']);
    // 「匯入設定」拿到備份檔要指路，不要亂套
    await page.click('.tabs button[data-tab="prizes"]'); await H.sleep(100);
    const imp = await page.$('#importFile'); await imp.uploadFile(path.join(dir, file)); await H.sleep(300);
    assert.match(await page.$eval('#toast', (e) => e.textContent), /完整備份檔/);
    assert.deepEqual(page.errors, []);
  });

  test('轉盤中心 GO：點一下＝單抽、不倒數；轉動中不會重複觸發', async (t) => {
    const page = await fresh(t, { spinDuration: 800, countdown: 3 });
    await page.evaluate(() => { document.querySelector('#skipAnim').checked = false; });
    const box = await page.$eval('#hubBtn', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.move(box.x, box.y); await H.sleep(200);
    assert.equal(await page.$eval('#hubBtn', (e) => getComputedStyle(e).cursor), 'pointer', '滑到中心游標變手指');
    await page.mouse.click(box.x, box.y);
    await H.sleep(150);
    assert.equal(await page.$eval('#hubBtn', (e) => e.classList.contains('spinning')), true, '轉動中 GO 變成轉動狀態');
    assert.equal(await page.$eval('#countdown', (e) => e.classList.contains('hidden')), true, 'GO 單抽不倒數');
    await page.waitForSelector('#resultModal:not(.hidden)', { timeout: 15000 });
    assert.equal((await H.readKey(page, 'lw.records')).length, 1);
    assert.equal(await page.$$eval('#resultGrid .r-card', (c) => c.length), 1);
    await H.closeResult(page);
    // 點在中心以外（扇區上）不會抽
    await page.mouse.click(box.x + 150, box.y + 150); await H.sleep(400);
    assert.equal((await H.readKey(page, 'lw.records')).length, 1);
  });

  test('抽獎前倒數 + 覆蓋層轉動中橫幅（抽獎者 / 連抽 / 保底）', async (t) => {
    const page = await fresh(t, { countdown: 2, spinDuration: 600, pityAccum: true, pityAccumN: 5 });
    await page.evaluate(() => { document.querySelector('#skipAnim').checked = false; document.querySelector('#player').value = '倒數哥'; });
    const { room, secret } = await H.readKey(page, 'lw.config');
    const ov = await H.newPage(browser, { width: 1280, height: 720 }); t.after(() => ov.close());
    await ov.goto(`${srv.url}/?overlay=1&room=${room}&key=${secret}&sync=0&t=${Date.now()}`, { waitUntil: 'networkidle0' }); await H.sleep(400);
    assert.equal(await ov.$eval('#ovPrizeList', (e) => e.classList.contains('hidden')), true, '沒帶 list=1 就不該出現獎項一覽');
    await page.bringToFront(); await page.click('.spin-btn[data-count="3"]'); await H.sleep(300);
    assert.equal(await page.$eval('#countdown', (e) => !e.classList.contains('hidden')), true, '控制台有倒數');
    assert.equal(await page.$eval('#countdown span', (e) => e.textContent), '2');
    await ov.bringToFront(); await H.sleep(200);
    assert.equal(await ov.$eval('#ovBanner', (e) => !e.classList.contains('hidden')), true, '覆蓋層有橫幅');
    assert.equal(await ov.$eval('#ovWho', (e) => e.textContent), '倒數哥　3連抽');
    assert.match(await ov.$eval('#ovPity', (e) => e.textContent), /倒數哥：再 5 抽觸發累積保底/);
    await page.bringToFront(); await page.waitForSelector('#resultModal:not(.hidden)', { timeout: 15000 });
    assert.equal(await page.$eval('#countdown', (e) => e.classList.contains('hidden')), true, '倒數結束後隱藏');
    // 勾「跳過動畫」就不倒數
    await H.closeResult(page); await page.evaluate(() => { document.querySelector('#skipAnim').checked = true; });
    await page.click('.spin-btn[data-count="1"]'); await H.sleep(150);
    assert.equal(await page.$eval('#countdown', (e) => e.classList.contains('hidden')), true, '跳過動畫時不倒數');
    await page.waitForSelector('#resultModal:not(.hidden)', { timeout: 15000 });
    assert.deepEqual(page.errors, []); assert.deepEqual(ov.errors, []);
  });

  test('手機版：版面不橫向溢出、預設跳過動畫、設定表格改卡片、能抽獎', async (t) => {
    const page = await browser.newPage(); t.after(() => page.close());
    page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
    await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile Safari' });
    await page.goto(`${srv.url}/?t=${Date.now()}`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => new Promise((res) => { const r = indexedDB.deleteDatabase('lucky-wheel'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
    await H.seed(page, { 'lw.config': FAST, 'lw.records': [], 'lw.meta': { helpSeen: true } });
    await page.reload({ waitUntil: 'networkidle0' }); await H.sleep(500);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, '首頁不橫向溢出');
    assert.equal(await page.$eval('#skipAnim', (e) => e.checked), true, '手機預設跳過動畫');
    await page.click('.open-panel[data-tab="prizes"]'); await H.sleep(300);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, '設定頁不橫向溢出');
    assert.equal(await page.$eval('#prizeRows tr', (e) => getComputedStyle(e).display), 'block', '表格列改成卡片');
    assert.equal(await page.$eval('#prizeRows td[data-label="名稱"]', (e) => getComputedStyle(e, '::before').content), '"名稱"', '卡片欄位有標籤');
    await page.click('#closePanel');
    await page.tap('.spin-btn[data-count="3"]');
    await page.waitForSelector('#resultModal:not(.hidden)', { timeout: 15000 });
    assert.equal(await page.$$eval('#resultGrid .r-card', (c) => c.length), 3);
    assert.deepEqual(page.errors, []);
  });

  test('補抽：結果卡上補抽某一抽 → 原筆作廢、新筆同批次；紀錄表也能補抽；統計排除作廢', async (t) => {
    const page = await fresh(t, { prizes: [{ id: 'a', name: '限量', weight: 1, quantity: 5, remaining: 5 }, { id: 'b', name: '不限', weight: 1, quantity: -1, remaining: -1 }] });
    await page.evaluate(() => { document.querySelector('#player').value = '補抽哥'; });
    await H.spinOnce(page, 3); await H.sleep(2200); // 等翻牌翻完，補抽鈕在正面
    const before = await H.readKey(page, 'lw.records');
    const target = before[1];
    const stockBefore = (await H.readKey(page, 'lw.config')).prizes[0].remaining;
    // 結果視窗第 2 張卡的補抽鈕
    await page.hover(`#resultGrid .r-card[data-rid="${target.rid}"]`);
    await page.click(`#resultGrid .r-card[data-rid="${target.rid}"] .r-redraw`); await H.sleep(300);
    assert.equal(await page.$eval('#confirmModal', (e) => !e.classList.contains('hidden')), true, '補抽前有確認');
    assert.match(await page.$eval('#confirmMsg', (e) => e.textContent), /第 2 抽/);
    await page.click('#confirmOk'); await H.sleep(1500);
    const after = await H.readKey(page, 'lw.records');
    assert.equal(after.length, 4);
    const voided = after.find((r) => r.rid === target.rid);
    assert.equal(voided.void, true);
    const redrawn = after.find((r) => r.redrawOf === target.rid);
    assert.ok(redrawn, '有補抽紀錄');
    assert.equal(redrawn.batchId, target.batchId); assert.equal(redrawn.index, 2); assert.equal(redrawn.type, '補抽'); assert.equal(redrawn.player, '補抽哥');
    // 庫存：作廢加回、補抽扣掉 → 只看落點差異
    const stockAfter = (await H.readKey(page, 'lw.config')).prizes[0].remaining;
    const expected = stockBefore + (target.prizeId === 'a' ? 1 : 0) - (redrawn.prizeId === 'a' ? 1 : 0);
    assert.equal(stockAfter, expected, '庫存正確');
    // 結果視窗還開著，第 2 張卡換成新結果、仍是 3 張
    assert.equal(await page.$eval('#resultModal', (e) => e.classList.contains('hidden')), false);
    assert.equal(await page.$$eval('#resultGrid .r-card', (c) => c.length), 3);
    assert.equal(await page.$eval(`#resultGrid .r-card[data-rid="${redrawn.rid}"] .r-name`, (e) => e.textContent), redrawn.prize);
    assert.equal(await page.$eval(`#resultGrid .r-card[data-rid="${redrawn.rid}"] .badge-redraw`, (e) => e.textContent), '補抽');
    // 紀錄表：作廢列劃線、補抽列有標籤、作廢列沒有補抽鈕；統計只算 3 抽
    await H.closeResult(page); await page.click('.open-panel[data-tab="records"]'); await H.sleep(300);
    assert.equal(await page.$$eval('#recordRows tr.void', (r) => r.length), 1);
    assert.equal(await page.$$eval('#recordRows .tag-redraw', (r) => r.length), 1);
    assert.equal(await page.$$eval('#recordRows .f-redraw', (r) => r.length), 3, '作廢列沒有補抽鈕');
    assert.match(await page.$eval('#statsTitle', (e) => e.textContent), /共 3 抽/);
    // 從紀錄表補抽補抽後的那筆（可以連續補）
    await page.click(`#recordRows .f-redraw[data-key="${redrawn.rid}"]`); await H.sleep(300); await page.click('#confirmOk'); await H.sleep(800);
    const again = await H.readKey(page, 'lw.records');
    assert.equal(again.length, 5);
    assert.equal(again.filter((r) => r.void).length, 2);
    assert.deepEqual(page.errors, []);
  });

  test('貼上名單：名字變成獎項（數量 1）、取代或加在後面', async (t) => {
    const page = await fresh(t);
    await page.click('.open-panel[data-tab="prizes"]'); await H.sleep(200);
    await page.click('#pasteNames'); await H.sleep(300);
    assert.equal(await page.$eval('#confirmTextarea', (e) => !e.classList.contains('hidden')), true, '多行輸入框');
    await page.type('#confirmTextarea', '小明\n阿花\n小明\n大雄');
    await page.click('#confirmOk'); await H.sleep(300);
    await page.click('#confirmOk'); await H.sleep(300); // 取代
    assert.deepEqual(await page.$$eval('#prizeRows .f-name', (els) => els.map((e) => e.value)), ['小明', '阿花', '大雄']);
    assert.deepEqual(await page.$$eval('#prizeRows .f-quantity', (els) => els.map((e) => e.value)), ['1', '1', '1']);
    await page.click('#savePrizes'); await H.sleep(200); await page.click('#closePanel');
    await H.spinOnce(page, 3); await H.closeResult(page); await H.sleep(200);
    const cfg = await H.readKey(page, 'lw.config');
    assert.deepEqual(cfg.prizes.map((p) => p.remaining), [0, 0, 0], '三個人都抽到一次後全部退出');
  });

  test('每人限抽：超過縮成剩餘次數、抽滿擋下；結果視窗「再抽一次」', async (t) => {
    const page = await fresh(t, { limitPerPlayer: 3, limitPeriod: 'all', prizes: [{ id: 'x', name: '不限', weight: 1, quantity: -1, remaining: -1 }] });
    await page.type('#player', '小明'); await H.sleep(100);
    assert.match(await page.$eval('#pityInfo', (e) => e.textContent), /小明：還可抽 3 次/);
    await H.spinOnce(page, 1);
    assert.equal(await page.$eval('#spinAgain', (e) => e.textContent), '再抽一次');
    await page.click('#spinAgain'); await page.waitForSelector('#resultModal:not(.hidden)'); await H.closeResult(page); await H.sleep(150);
    assert.equal((await H.readKey(page, 'lw.records')).length, 2);
    assert.match(await page.$eval('#pityInfo', (e) => e.textContent), /還可抽 1 次/);
    await page.click('.spin-btn[data-count="5"]'); await H.sleep(300);
    assert.match(await page.$eval('#confirmMsg', (e) => e.textContent), /只剩 1 次可抽/);
    await page.click('#confirmOk'); await page.waitForSelector('#resultModal:not(.hidden)'); await H.closeResult(page); await H.sleep(150);
    assert.equal((await H.readKey(page, 'lw.records')).length, 3);
    await page.click('.spin-btn[data-count="1"]'); await H.sleep(300);
    assert.match(await page.$eval('#toast', (e) => e.textContent), /已抽滿 3 次/);
    assert.equal((await H.readKey(page, 'lw.records')).length, 3, '抽滿後不再新增');
    // 沒填名字不受限
    await page.evaluate(() => { document.querySelector('#player').value = ''; });
    await H.spinOnce(page, 1); await H.closeResult(page);
    assert.equal((await H.readKey(page, 'lw.records')).length, 4);
    assert.deepEqual(page.errors, []);
  });

  test('音量：設定頁滑桿存到設定，Sfx.volume 跟著變', async (t) => {
    const page = await fresh(t);
    await page.click('.open-panel[data-tab="settings"]'); await H.sleep(200);
    assert.equal(await page.$eval('#s-volume', (e) => e.value), '70');
    await page.evaluate(() => { const s = document.querySelector('#s-volume'); s.value = '30'; s.dispatchEvent(new Event('input')); });
    assert.equal(await page.$eval('#volumeVal', (e) => e.textContent), '30%');
    assert.equal(await page.evaluate(() => window.LuckyWheel.Sfx.volume), 0.3);
    await page.click('#saveSettings'); await H.sleep(200);
    assert.equal((await H.readKey(page, 'lw.config')).volume, 30);
  });

  test('多人名單：40 人轉盤可畫、一覽自動分欄；獎項可拖曳換順序；名單可從 Excel 匯入', async (t) => {
    const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
    const page = await fresh(t);
    await page.click('.open-panel[data-tab="prizes"]'); await H.sleep(200);
    // 用 SheetJS（頁面已載入）在瀏覽器端產生一個 40 人的 xlsx，寫到暫存檔再用檔案匯入
    const b64 = await page.evaluate(() => { const rows = [['名字'], ...Array.from({ length: 40 }, (_, i) => [`觀眾${i + 1}`])]; const wb = window.XLSX.utils.book_new(); window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(rows), 'S'); return window.XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }); });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-names-')); const xlsx = path.join(dir, 'names.xlsx'); fs.writeFileSync(xlsx, Buffer.from(b64, 'base64'));
    await page.click('#pasteNames'); await H.sleep(300);
    const fi = await page.$('#confirmFile'); await fi.uploadFile(xlsx); await H.sleep(400);
    const txt = await page.$eval('#confirmTextarea', (e) => e.value);
    assert.equal(txt.split('\n').length, 41, '第一欄全部讀進來（含標題列，可自行刪）');
    await page.click('#confirmOk'); await H.sleep(300); await page.click('#confirmOk'); await H.sleep(400); // 取代
    assert.equal(await page.$$eval('#prizeRows tr', (r) => r.length), 41);
    // 拖曳：把第 3 列拖到第 1 列前面
    const ids = await page.$$eval('#prizeRows tr', (rs) => rs.map((r) => r.dataset.id));
    // 無頭 Chrome 不會真的發原生拖曳事件，直接對把手 / 目標列派送 DragEvent 來測我們的處理邏輯
    await page.evaluate((from, to) => {
      const dt = new DataTransfer();
      const handle = document.querySelector(`#prizeRows tr[data-id="${from}"] .drag-handle`);
      const target = document.querySelector(`#prizeRows tr[data-id="${to}"]`);
      handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const r = target.getBoundingClientRect();
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 2 }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 2 }));
      handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    }, ids[2], ids[0]); await H.sleep(300);
    const after = await page.$$eval('#prizeRows tr', (rs) => rs.map((r) => r.dataset.id));
    assert.equal(after[0], ids[2], '第 3 列拖到最前面');
    assert.equal(after.length, 41);
    await page.click('#savePrizes'); await H.sleep(200); await page.click('#closePanel');
    // 一覽：超過 14 個自動分欄
    await page.click('#togglePrizeList'); await H.sleep(200);
    assert.equal(await page.$eval('#prizeList', (e) => e.classList.contains('many')), true);
    assert.equal(await page.$$eval('#prizeListRows li', (l) => l.length), 41);
    // 轉盤畫得出來、抽得出來
    await H.spinOnce(page, 3);
    assert.equal(await page.$$eval('#resultGrid .r-card', (c) => c.length), 3);
    assert.deepEqual(page.errors, []);
  });

  test('說明：第一次開啟自動顯示、關掉後不再跳；版本號顯示；快捷鍵 1/3/5/0', async (t) => {
    const page = await H.newPage(browser); t.after(() => page.close());
    await page.goto(`${srv.url}/?t=${Date.now()}`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => new Promise((res) => { const r = indexedDB.deleteDatabase('lucky-wheel'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
    await H.seed(page, { 'lw.config': FAST, 'lw.records': [], 'lw.skipAnim': true });
    await page.reload({ waitUntil: 'networkidle0' }); await H.sleep(1000);
    assert.equal(await page.$eval('#helpModal', (e) => e.classList.contains('hidden')), false, '第一次自動顯示說明');
    assert.match(await page.$eval('#helpVersion', (e) => e.textContent), /版本 #\d+/);
    await page.click('#closeHelp2'); await H.sleep(200);
    await page.reload({ waitUntil: 'networkidle0' }); await H.sleep(1000);
    assert.equal(await page.$eval('#helpModal', (e) => e.classList.contains('hidden')), true, '關掉後不再自動跳');
    await page.click('#openHelp'); await H.sleep(150);
    assert.equal(await page.$eval('#helpModal', (e) => e.classList.contains('hidden')), false, '按說明可再打開');
    await page.keyboard.press('Escape'); await H.sleep(150);
    assert.equal(await page.$eval('#helpModal', (e) => e.classList.contains('hidden')), true);
    await page.click('.open-panel[data-tab="settings"]'); await H.sleep(200);
    assert.match(await page.$eval('#versionLine', (e) => e.textContent), /版本 #\d+/);
    // 設定視窗開著時快捷鍵不動作
    await page.keyboard.press('Digit3'); await H.sleep(300);
    assert.equal((await H.readKey(page, 'lw.records') || []).length, 0);
    await page.click('#closePanel'); await H.sleep(150);
    await page.keyboard.press('Digit3'); await page.waitForSelector('#resultModal:not(.hidden)', { timeout: 15000 });
    assert.equal((await H.readKey(page, 'lw.records')).length, 3, '按 3 = 三連抽');
    await H.closeResult(page);
    await page.keyboard.press('Digit0'); await page.waitForSelector('#resultModal:not(.hidden)', { timeout: 15000 });
    assert.equal((await H.readKey(page, 'lw.records')).length, 13, '按 0 = 十連抽');
    await H.closeResult(page);
    await page.focus('#player'); await page.keyboard.press('Digit5'); await H.sleep(300);
    assert.equal((await H.readKey(page, 'lw.records')).length, 13, '打字中不觸發');
    assert.deepEqual(page.errors, []);
  });

  test('保底：連抽保底每 5 抽至少一個，40 批全部符合', async (t) => {
    // 40 批連續大獎慶祝（彩帶 + 3D 粒子）在無頭軟體 GPU 下很吃資源，這個統計測試關掉背景、批與批之間喘一下
    const page = await fresh(t, { pityBatch: true, pityBatchK: 5, bg3d: false, prizes: FAST.prizes.map((p) => ({ ...p, quantity: -1, remaining: -1 })) });
    for (let i = 0; i < 40; i++) { await H.spinOnce(page, 5); await H.closeResult(page); await H.sleep(120); }
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
    assert.match(url, /overlay=1&room=[A-Z0-9]+&key=[A-Z0-9]{20}&size=700&mode=spin$/);
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
    const { room, secret } = await H.readKey(page, 'lw.config');
    const ov = await H.newPage(browser, { width: 1280, height: 720 }); t.after(() => ov.close());
    await ov.goto(`${srv.url}/?overlay=1&room=${room}&key=${secret}&sync=0&list=1&lp=0&lpos=c&t=${Date.now()}`, { waitUntil: 'networkidle0' }); await H.sleep(500);
    assert.equal(await ov.$eval('#ovPrizeList', (e) => e.classList.contains('centered')), true, 'lpos=c 置中');
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
    // 金鑰錯誤的覆蓋層：同一個瀏覽器、同頻道，但收不到任何東西
    const bad = await H.newPage(browser, { width: 1280, height: 720 }); t.after(() => bad.close());
    await bad.goto(`${srv.url}/?overlay=1&room=${room}&key=WRONGKEY&sync=0&t=${Date.now()}`, { waitUntil: 'networkidle0' }); await H.sleep(300);
    await page.bringToFront(); await H.closeResult(page); await page.evaluate(() => { document.querySelector('#skipAnim').checked = true; });
    await H.spinOnce(page, 1); await H.closeResult(page); await H.sleep(800);
    assert.equal(await bad.$eval('#ovResultLayer', (e) => e.classList.contains('out')), true, '簽章不符的訊息不會被播放');
    const ovStocks = await ov.$$eval('#ovPrizeListRows .pl-stock', (els) => els.map((e) => e.textContent));
    const ctrlCfg = await H.readKey(page, 'lw.config');
    assert.deepEqual(ovStocks, ctrlCfg.prizes.map((p) => (p.quantity === -1 ? '不限' : p.remaining === 0 ? '抽完' : `剩 ${p.remaining}`)), '抽獎後覆蓋層一覽的剩餘與控制台一致');
    assert.deepEqual(ov.errors, []);
  });

  test('建議機率：預覽依數量算出、改總抽數即時重算、套用後權重更新且標記未儲存', async (t) => {
    const page = await fresh(t);
    await page.click('.open-panel[data-tab="prizes"]'); await H.sleep(300);
    await page.click('#suggestWeights'); await H.sleep(200);
    assert.equal(await page.$eval('#suggestModal', (e) => !e.classList.contains('hidden')), true);
    assert.equal(await page.$eval('#suggestDraws', (e) => e.value), '8', '預設：有無限量獎項 → 庫存 4 的兩倍');
    assert.deepEqual(await page.$$eval('#suggestRows tr td:nth-child(4)', (els) => els.map((e) => e.textContent.replace(/[↑↓ ]/g, ''))), ['12.50%', '37.50%', '50.00%']);
    await page.click('#suggestDraws', { clickCount: 3 }); await page.type('#suggestDraws', '100'); await H.sleep(150);
    assert.deepEqual(await page.$$eval('#suggestRows tr td:nth-child(4)', (els) => els.map((e) => e.textContent.replace(/[↑↓ ]/g, ''))), ['1.00%', '3.00%', '96.00%']);
    await page.click('#suggestApply'); await H.sleep(200);
    assert.equal(await page.$eval('#suggestModal', (e) => e.classList.contains('hidden')), true);
    assert.deepEqual(await page.$$eval('#prizeRows .f-weight', (els) => els.map((e) => Number(e.value))), [1, 3, 96]);
    assert.equal(await page.$eval('#prizeRows tr:nth-child(1) .prob', (e) => e.textContent), '1.00%');
    assert.match(await page.$eval('#dirtyHint', (e) => e.textContent), /未儲存/);
    assert.deepEqual(page.errors, []);
  });

  test('GIF 動圖：轉盤會逐格換圖（不是只畫第一格）', async (t) => {
    const page = await fresh(t, { prizes: [{ id: 'g', name: 'GIF', weight: 1, quantity: -1, remaining: -1, image: '/test/e2e/anim.gif' }, { id: 'c', name: '銘謝惠顧', weight: 1, quantity: -1, remaining: -1 }] });
    await H.sleep(500);
    const seen = await page.evaluate(async () => {
      const c = document.querySelector('#wheel'); const ctx = c.getContext('2d'); const colors = new Set();
      const isTest = (r, g, b) => (r > 240 && g < 20 && b < 20) || (g > 180 && r < 20 && b < 20) || (b > 240 && r < 20 && g < 20) || (r > 240 && g > 200 && g < 240 && b < 20);
      for (let k = 0; k < 16; k++) {
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        for (let j = 0; j < d.length; j += 4) if (isTest(d[j], d[j + 1], d[j + 2])) colors.add(`${d[j]},${d[j + 1]},${d[j + 2]}`);
        await new Promise((r) => setTimeout(r, 110));
      }
      return [...colors];
    });
    assert.ok(seen.length >= 3, `1.7 秒內至少應看到 3 種格子顏色，實際：${seen.join(' / ')}`);
    assert.deepEqual(page.errors, []);
  });

  // 2026-09-20 的實際活動中，某個獎項的剩餘被「還原」了四次（送出 41 份 vs 庫存 30）。
  // 查下來最可能的可觸發路徑是 Chrome 的「滾輪會改有焦點的數字欄位」：點過剩餘欄後捲動面板就會加減庫存。
  test('滑鼠滾輪不會改到數字欄位（捲面板時誤改權重 / 庫存）', async (t) => {
    const page = await fresh(t, { prizes: [{ id: 's', name: '甜點券', weight: 10, quantity: 14, remaining: 14 }] });
    await page.click('.open-panel[data-tab="prizes"]'); await H.sleep(300);
    for (const sel of ['.f-remaining', '.f-quantity', '.f-weight']) {
      const el = await page.$(`#prizeRows tr ${sel}`);
      await el.focus();
      const before = await page.$eval(`#prizeRows tr ${sel}`, (e) => e.value);
      const box = await el.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel({ deltaY: -200 }); await H.sleep(150);
      assert.equal(await page.$eval(`#prizeRows tr ${sel}`, (e) => e.value), before, `${sel} 不該被滾輪改到`);
    }
    const p0 = (await H.readKey(page, 'lw.config')).prizes[0];
    assert.equal(p0.remaining, 14); assert.equal(p0.quantity, 14); assert.equal(p0.weight, 10);
    assert.deepEqual(page.errors, []);
  });

  // 欄位停在被夾掉的數字時，之後的任何一次輸入都會從那個假數字算起，所以離開欄位一定要對帳回真實值
  test('剩餘欄位輸入被夾住時，離開欄位會回到真實數字', async (t) => {
    const page = await fresh(t, { prizes: [{ id: 's', name: '甜點券', weight: 100, quantity: 14, remaining: 14 }] });
    await page.click('.open-panel[data-tab="prizes"]'); await H.sleep(300);
    await page.click('#prizeRows tr .f-remaining', { clickCount: 3 });
    await page.type('#prizeRows tr .f-remaining', '999'); await H.sleep(150);
    assert.equal((await H.readKey(page, 'lw.config')).prizes[0].remaining, 14, '剩餘不能超過數量');
    await page.click('#prizeRows tr .f-name'); await H.sleep(200);
    assert.equal(await page.$eval('#prizeRows tr .f-remaining', (e) => e.value), '14', '離開欄位後畫面要回到真實值');
    await page.keyboard.press('Tab'); await H.sleep(100);
    assert.deepEqual(page.errors, []);
  });

  // 打字中的欄位不能被背景重畫蓋掉，否則邊打邊被改會輸入不了
  test('正在打字的欄位不會被背景重畫蓋掉', async (t) => {
    const page = await fresh(t, { prizes: [{ id: 's', name: '甜點券', weight: 10, quantity: 14, remaining: 14 }, { id: 'c', name: '銘謝惠顧', weight: 30, quantity: -1, remaining: -1 }] });
    await page.click('.open-panel[data-tab="prizes"]'); await H.sleep(300);
    await page.click('#prizeRows tr:nth-child(1) .f-weight', { clickCount: 3 });
    await page.type('#prizeRows tr:nth-child(1) .f-weight', '2.5', { delay: 60 });
    assert.equal(await page.$eval('#prizeRows tr:nth-child(1) .f-weight', (e) => e.value), '2.5', '打到一半不能被重畫蓋掉');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('f-weight')), true, '打字途中不能失焦');
    assert.equal(await page.$eval('#prizeRows tr:nth-child(1) .prob', (e) => e.textContent), '7.69%', '每個按鍵都要即時重算機率');
    await page.click('#savePrizes'); await H.sleep(300);
    assert.equal((await H.readKey(page, 'lw.config')).prizes[0].weight, 2.5);
    assert.deepEqual(page.errors, []);
  });
}
