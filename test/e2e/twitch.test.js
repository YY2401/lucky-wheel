'use strict';
/* 忠誠點轉盤（twitch.html）端對端：Twitch API / EventSub / Apps Script 都換成頁內模擬，其餘是真的 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const { installMocks } = require('./twitch-mocks');

if (!H.chromePath()) {
  test('忠誠點轉盤 e2e（找不到 Chrome，略過）', { skip: true }, () => {});
} else {
  let srv, browser;
  before(async () => { srv = await H.serve(); browser = await H.launch(); });
  after(async () => { await browser.close(); srv.server.close(); });

  const READY = { clientId: 'cid', sync: false, spinDuration: 1000, resultSeconds: 1, sound: false, rewardIds: ['rw1'], scriptUrl: 'https://script.google.com/macros/s/X/exec', sheetOk: 'https://script.google.com/macros/s/X/exec', setupDone: true };
  async function open(t, { config = READY, auth = { token: 'tok', clientId: 'cid' }, before: setup } = {}) {
    const page = await H.newPage(browser);
    t.after(() => page.close());
    await page.evaluateOnNewDocument(installMocks);
    await page.goto(`${srv.url}/twitch.html`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => new Promise((res) => { const r = indexedDB.deleteDatabase('lucky-wheel'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
    await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('mock.')).forEach((k) => localStorage.removeItem(k)));
    const kv = { 'tw.records': [], 'tw.queue': [] };
    if (config) kv['tw.config'] = config;
    if (auth) kv['tw.auth'] = auth;
    await H.seed(page, kv);
    if (setup) await setup(page);
    await page.reload({ waitUntil: 'networkidle0' });
    await H.sleep(300);
    return page;
  }
  const records = (page) => H.readKey(page, 'tw.records');
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('等待逾時'); await H.sleep(100); } };

  test('第一次開啟：顯示設定步驟；按「連接 Twitch」帶著正確參數導向 Twitch 授權頁', async (t) => {
    const page = await open(t, { config: { clientId: 'cid', sync: false }, auth: null });
    assert.equal(await page.$eval('#setupView', (e) => e.classList.contains('hidden')), false);
    assert.equal(await page.$$eval('.tw-step.done', (e) => e.length), 0);
    await page.setRequestInterception(true);
    let authUrl = null;
    page.on('request', (r) => { if (r.url().startsWith('https://id.twitch.tv/')) { authUrl = new URL(r.url()); r.respond({ status: 200, contentType: 'text/html', body: 'ok' }); } else r.continue(); });
    await page.click('#twLogin');
    await waitFor(() => authUrl);
    assert.equal(authUrl.searchParams.get('client_id'), 'cid');
    assert.equal(authUrl.searchParams.get('response_type'), 'token');
    assert.equal(authUrl.searchParams.get('scope'), 'channel:read:redemptions channel:manage:redemptions');
    assert.equal(authUrl.searchParams.get('redirect_uri'), `${srv.url}/twitch.html`);
    assert.ok(authUrl.searchParams.get('state'));
    assert.deepEqual(page.errors, []);
  });

  test('授權回來：存下 token、列出品項；勾選品項、測試試算表後三步都完成，進直播畫面', async (t) => {
    const page = await open(t, { config: { clientId: 'cid', sync: false }, auth: null });
    await page.evaluate(() => sessionStorage.setItem('tw.oauth', 'ST4TE'));
    await page.goto(`${srv.url}/twitch.html?from=twitch#access_token=newtok&scope=channel%3Aread%3Aredemptions&state=ST4TE&token_type=bearer`, { waitUntil: 'networkidle0' });
    await waitFor(() => page.$eval('#step1', (e) => e.classList.contains('done')));
    assert.equal(page.url(), `${srv.url}/twitch.html`); // token 從網址列清掉
    assert.equal((await H.readKey(page, 'tw.auth')).token, 'newtok');
    assert.match(await page.$eval('#twUser', (e) => e.textContent), /實況主/);
    await waitFor(() => page.$$eval('#rewards input', (e) => e.length === 2));
    await page.click('#rewards input[value="rw1"]');
    assert.equal(await page.$eval('#step2', (e) => e.classList.contains('done')), true);
    assert.deepEqual((await H.readKey(page, 'tw.config')).rewardIds, ['rw1']);

    await page.type('#scriptUrl', 'https://script.google.com/macros/s/ABC/exec');
    await page.click('#testSheet');
    await waitFor(() => page.$eval('#sheetResult', (e) => e.classList.contains('ok')));
    assert.match(await page.$eval('#sheetResult', (e) => e.textContent), /連線成功.*216 人.*10月/s);
    const ping = await page.evaluate(() => window.__tw.sheetCalls[0]);
    assert.equal(ping.action, 'ping'); assert.deepEqual(ping.columns, ['1點', '3點', '5點']);
    assert.equal(ping.key, (await H.readKey(page, 'tw.config')).sheetKey); // 送出的暗號＝程式碼裡的暗號
    assert.equal(await page.$eval('#step3', (e) => e.classList.contains('done')), true);
    await page.click('#finishSetup'); await H.sleep(200);
    assert.equal(await page.$eval('#liveView', (e) => e.classList.contains('hidden')), false);
    assert.deepEqual(page.errors, []);
  });

  test('網址貼錯會直接說明；複製程式碼內含專屬暗號', async (t) => {
    const page = await open(t, { config: { ...READY, setupDone: false, scriptUrl: '', sheetOk: '' } });
    await page.type('#scriptUrl', 'https://script.google.com/home/projects/abc/edit');
    await page.click('#testSheet');
    assert.match(await page.$eval('#sheetResult', (e) => e.textContent), /結尾是 \/exec/);
    const ctx = browser.defaultBrowserContext();
    await ctx.overridePermissions(srv.url, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    await page.click('#copyScript');
    await waitFor(() => page.$eval('#copyScript', (e) => e.textContent.includes('已複製')));
    const code = await page.evaluate(() => navigator.clipboard.readText());
    const key = (await H.readKey(page, 'tw.config')).sheetKey;
    assert.ok(code.includes(`const KEY = '${key}';`));
    assert.ok(code.includes('function doPost'));
  });

  test('兌換指定品項 → 自動轉盤 → 寫進試算表；其他品項與重送的同一筆都不理', async (t) => {
    const page = await open(t);
    await waitFor(() => page.evaluate(() => window.__tw.subscribed));
    assert.equal(await page.evaluate(() => window.__tw.subscribed.condition.broadcaster_user_id), '123');
    assert.match(await page.$eval('#pillTwitch', (e) => e.textContent), /已連線/);
    await page.evaluate(() => {
      window.__tw.redeem({ id: 'e1', user_login: 'gabai', user_name: '嘎唄', reward: { id: 'rw1', title: '忠誠點轉盤' } });
      window.__tw.redeem({ id: 'e1', user_login: 'gabai', user_name: '嘎唄', reward: { id: 'rw1', title: '忠誠點轉盤' } }); // 重送
      window.__tw.redeem({ id: 'e2', user_login: 'x', user_name: 'x', reward: { id: 'rw2', title: '喝水' } });
      window.__tw.redeem({ id: 'e3', user_login: 'newbie', user_name: '新朋友', reward: { id: 'rw1', title: '忠誠點轉盤' } });
    });
    assert.match(await page.$eval('#nowBanner', (e) => e.textContent), /嘎唄/);
    const recs = await waitFor(async () => { const r = await records(page); return r.length === 2 && r.every((x) => x.status === 'ok') && r; });
    assert.deepEqual(recs.map((r) => r.id).sort(), ['e1', 'e3']);
    assert.ok(recs.every((r) => ['1點', '3點', '5點'].includes(r.column)));
    const sent = await page.evaluate(() => window.__tw.sheetCalls.flatMap((c) => c.records || []));
    assert.deepEqual([...new Set(sent.map((r) => r.id))].sort(), ['e1', 'e3']);
    assert.deepEqual(Object.keys(sent[0]).sort(), ['column', 'date', 'display', 'id', 'login']);
    await waitFor(() => page.$eval('#queueCount', (e) => e.textContent === '0'));
    assert.match(await page.$eval('#recordList', (e) => e.textContent), /新觀眾已加入名單/);
    assert.deepEqual(page.errors, []);
  });

  test('試算表連不上：紀錄留著、自動重試，恢復後補寫；單筆錯誤可按重試', async (t) => {
    const page = await open(t);
    await waitFor(() => page.evaluate(() => window.__tw.subscribed));
    await page.evaluate(() => { window.__tw.failSheet = 1; window.__tw.rowErrors.bad = '找不到「10月」分頁'; });
    await page.evaluate(() => {
      window.__tw.redeem({ id: 'f1', user_login: 'aaa', user_name: 'aaa', reward: { id: 'rw1', title: '轉' } });
      window.__tw.redeem({ id: 'f2', user_login: 'bad', user_name: 'bad', reward: { id: 'rw1', title: '轉' } });
    });
    await waitFor(() => page.$eval('#pillSheet', (e) => e.classList.contains('bad')));
    assert.equal(await page.$eval('#alert', (e) => e.classList.contains('hidden')), false);
    const recs = await waitFor(async () => { const r = await records(page); const a = r.find((x) => x.id === 'f1'); const b = r.find((x) => x.id === 'f2'); return a && b && a.status === 'ok' && b.status === 'error' && r; }, 12000);
    assert.match(recs.find((x) => x.id === 'f2').error, /10月/);
    assert.match(await page.$eval('#alertText', (e) => e.textContent), /沒寫進試算表/);
    await page.evaluate(() => { delete window.__tw.rowErrors.bad; });
    await page.click('[data-retry="f2"]');
    await waitFor(async () => (await records(page)).find((x) => x.id === 'f2').status === 'ok');
    await waitFor(() => page.$eval('#alert', (e) => e.classList.contains('hidden')));
    assert.deepEqual(page.errors, []);
  });

  const doneRec = (id, extra = {}) => ({ id, time: new Date().toISOString(), date: '2026-10-04', login: 'gabai', display: '嘎唄', reward: '轉', prizeId: 'pt3', prize: '3點', column: '3點', color: '#6bcb77', status: 'ok', cell: '10月!AB3', error: '', attempts: 1, rewardId: '', tw: '', holdUntil: 0, ...extra });
  const unfulfilled = (id, rewardId = 'rw1', at = new Date().toISOString(), login = 'gabai', name = '嘎唄') => ({ id, user_login: login, user_name: name, redeemed_at: at, status: 'UNFULFILLED', reward: { id: rewardId, title: '忠誠點轉盤' } });

  test('撤銷（手動補登的紀錄）：沒有點數可退，只撤銷試算表', async (t) => {
    const page = await open(t, { before: (p) => H.seed(p, { 'tw.records': [doneRec('u1')] }) });
    await page.click('[data-undo="u1"]'); await H.sleep(200);
    assert.equal(await page.$eval('#undoRefundYes', (e) => e.disabled), true);
    assert.match(await page.$eval('#undoRefundHint', (e) => e.textContent), /手動補登/);
    await page.click('#undoOk');
    await waitFor(async () => (await records(page))[0].status === 'undone');
    const call = await page.evaluate(() => window.__tw.sheetCalls.find((c) => c.action === 'undo'));
    assert.equal(call.records[0].id, 'u1');
    assert.deepEqual(await page.evaluate(() => window.__tw.patches), []);
  });

  test('撤銷時選「退還忠誠點」：試算表減回去、Twitch 那筆退點；選「只撤銷」就不動 Twitch', async (t) => {
    const hold = { rewardId: 'rw1', tw: 'hold', holdUntil: Date.now() + 3600e3 };
    const page = await open(t, { before: async (p) => {
      await H.seed(p, { 'tw.records': [doneRec('r1', hold), doneRec('r2', hold)] });
      await p.evaluate((u) => localStorage.setItem('mock.unfulfilled', JSON.stringify(u)), [unfulfilled('r1'), unfulfilled('r2')]);
    } });
    await waitFor(() => page.evaluate(() => window.__tw.subscribed));
    assert.equal(await page.$('#catchupModal.hidden') !== null, true, '已處理過的兌換不會被當成漏掉');
    await page.click('[data-undo="r1"]'); await H.sleep(200);
    assert.equal(await page.$eval('#undoRefundYes', (e) => e.checked && !e.disabled), true); // 可退點時預設勾「退還」
    await page.click('#undoOk');
    await waitFor(async () => { const r = (await records(page)).find((x) => x.id === 'r1'); return r.status === 'undone' && r.tw === 'canceled'; });
    await page.click('[data-undo="r2"]'); await H.sleep(200);
    await page.click('#undoRefundNo'); await page.click('#undoOk');
    await waitFor(async () => (await records(page)).find((x) => x.id === 'r2').status === 'undone');
    await H.sleep(300);
    assert.deepEqual(await page.evaluate(() => window.__tw.patches), [{ rewardId: 'rw1', ids: ['r1'], status: 'CANCELED' }]);
    assert.equal((await records(page)).find((x) => x.id === 'r2').tw, 'hold');
    assert.match(await page.$eval('#recordList', (e) => e.textContent), /已退還忠誠點/);
    assert.deepEqual(page.errors, []);
  });

  test('可退點期（24 小時）過了：自動在 Twitch 標成已完成，之後撤銷不能退點', async (t) => {
    const page = await open(t, { before: async (p) => {
      await H.seed(p, { 'tw.records': [doneRec('old', { rewardId: 'rw1', tw: 'hold', holdUntil: Date.now() - 1000 })] });
      await p.evaluate((u) => localStorage.setItem('mock.unfulfilled', JSON.stringify(u)), [unfulfilled('old')]);
    } });
    await waitFor(async () => (await records(page))[0].tw === 'fulfilled', 10000);
    assert.deepEqual(await page.evaluate(() => window.__tw.patches), [{ rewardId: 'rw1', ids: ['old'], status: 'FULFILLED' }]);
    await page.click('[data-undo="old"]'); await H.sleep(200);
    assert.equal(await page.$eval('#undoRefundYes', (e) => e.disabled), true);
    assert.match(await page.$eval('#undoRefundHint', (e) => e.textContent), /24 小時/);
  });

  test('補抓：網頁關著時的兌換列出來確認；勾的照當天日期補轉，沒勾的退點', async (t) => {
    const page = await open(t, { before: async (p) => {
      await H.seed(p, { 'tw.records': [doneRec('seen', { rewardId: 'rw1', tw: 'hold', holdUntil: Date.now() + 3600e3 })] });
      await p.evaluate((u) => localStorage.setItem('mock.unfulfilled', JSON.stringify(u)), [
        unfulfilled('seen'), // 這個網頁處理過了
        unfulfilled('m1', 'rw1', '2026-10-01T12:00:00.000Z', 'smallseafood', '小海鮮'),
        unfulfilled('m2', 'rw1', '2026-10-02T12:00:00.000Z', 'toastiwa', '吐司瓦熊'),
      ]);
    } });
    await waitFor(() => page.$eval('#catchupModal', (e) => !e.classList.contains('hidden')));
    assert.equal(await page.$eval('#catchupCount', (e) => e.textContent), '2');
    assert.match(await page.$eval('#catchupList', (e) => e.textContent), /小海鮮.*吐司瓦熊/s);
    await page.click('#catchupList input[value="m2"]'); // 取消勾選 → 退點
    await page.click('#catchupGo'); await H.sleep(300);
    assert.match(await page.$eval('#confirmMsg', (e) => e.textContent), /吐司瓦熊/);
    await page.click('#confirmOk');
    const rec = await waitFor(async () => { const r = (await records(page)).find((x) => x.id === 'm1'); return r && r.status === 'ok' && r; }, 10000);
    assert.equal(rec.date, new Date('2026-10-01T12:00:00.000Z').toLocaleDateString('sv')); // 記在兌換那天，不是今天
    assert.equal(rec.tw, 'hold');
    await waitFor(() => page.evaluate(() => window.__tw.patches.some((x) => x.status === 'CANCELED')));
    assert.deepEqual(await page.evaluate(() => window.__tw.patches), [{ rewardId: 'rw1', ids: ['m2'], status: 'CANCELED' }]);
    assert.equal((await records(page)).some((x) => x.id === 'm2'), false);
    assert.deepEqual(page.errors, []);
  });

  test('補抓按「稍後再說」：上方提醒列留著，按了可以再打開', async (t) => {
    const page = await open(t, { before: (p) => p.evaluate((u) => localStorage.setItem('mock.unfulfilled', JSON.stringify(u)), [unfulfilled('m9', 'rw1', '2026-10-01T12:00:00.000Z')]) });
    await waitFor(() => page.$eval('#catchupModal', (e) => !e.classList.contains('hidden')));
    await page.click('#catchupLater');
    assert.match(await page.$eval('#alertText', (e) => e.textContent), /1 筆兌換還沒轉/);
    await page.click('#alertBtn');
    assert.equal(await page.$eval('#catchupModal', (e) => !e.classList.contains('hidden')), true);
  });

  test('在網頁建立品項：建立後自動勾選、標示可補抓；名稱重複會說明', async (t) => {
    const page = await open(t, { config: { ...READY, rewardIds: [], setupDone: false } });
    await waitFor(() => page.$$eval('#rewards input', (e) => e.length === 2));
    assert.match(await page.$eval('#rewards', (e) => e.textContent), /可補抓、可退點.*手動建立/s);
    await page.$eval('#newRewardTitle', (e) => { e.value = '喝水'; });
    await page.click('#createReward');
    await waitFor(() => page.$eval('#createErr', (e) => !e.classList.contains('hidden')));
    assert.match(await page.$eval('#createErr', (e) => e.textContent), /已經有叫「喝水」/);
    await page.$eval('#newRewardTitle', (e) => { e.value = '幸運轉盤'; });
    await page.$eval('#newRewardCost', (e) => { e.value = '300'; });
    await page.click('#createReward');
    await waitFor(() => page.$$eval('#rewards input', (e) => e.length === 3));
    assert.deepEqual(await page.evaluate(() => window.__tw.created.map((x) => [x.title, x.cost, x.should_redemptions_skip_request_queue])), [['幸運轉盤', 300, false]]);
    const cfg = await H.readKey(page, 'tw.config');
    assert.deepEqual(cfg.rewardIds, ['new2']);
    assert.equal(await page.$eval('#rewards input[value="new2"]', (e) => e.checked), true);
    assert.equal(await page.$eval('#step2', (e) => e.classList.contains('done')), true);
    assert.deepEqual(page.errors, []);
  });

  test('舊版授權（沒有管理權限）：提醒重新連接，建立品項按鈕停用並說明', async (t) => {
    const page = await open(t, { before: (p) => p.evaluate(() => localStorage.setItem('mock.scopes', 'read')) });
    await waitFor(() => page.$eval('#alertText', (e) => /重新連接 Twitch 一次/.test(e.textContent)));
    await page.click('#toSetup'); await H.sleep(200);
    assert.equal(await page.$eval('#createReward', (e) => e.disabled), true);
    assert.match(await page.$eval('#createErr', (e) => e.textContent), /重新連接/);
  });

  test('手動補一筆、試轉（試轉不寫入）', async (t) => {
    const page = await open(t);
    await page.click('#manualAdd'); await H.sleep(200);
    await page.type('#confirmInput', '小于甜心 (xiaoyuthesweetheart_)');
    await page.click('#confirmOk');
    await page.click('#testSpin');
    const recs = await waitFor(async () => { const r = await records(page); return r.length === 2 && r.find((x) => x.status === 'ok') && r; }, 10000);
    const manual = recs.find((x) => x.reward === '手動補登');
    assert.equal(manual.login, 'xiaoyuthesweetheart_'); assert.equal(manual.display, '小于甜心');
    assert.equal(recs.find((x) => x.reward === '試轉').status, 'test');
    const sent = await page.evaluate(() => window.__tw.sheetCalls.flatMap((c) => c.records || []));
    assert.deepEqual(sent.map((r) => r.login), ['xiaoyuthesweetheart_']);
  });

  test('Twitch 登入過期：提醒列出現「重新連接」', async (t) => {
    const page = await open(t, { before: (p) => p.evaluate(() => localStorage.setItem('mock.validate', '401')) });
    await waitFor(() => page.$eval('#alert', (e) => !e.classList.contains('hidden')));
    assert.match(await page.$eval('#alertBtn', (e) => e.textContent), /重新連接 Twitch/);
    assert.match(await page.$eval('#pillTwitch', (e) => e.textContent), /重新登入/);
    await page.evaluate(() => localStorage.removeItem('mock.validate'));
    assert.deepEqual(page.errors, []);
  });

  test('OBS 覆蓋層（主轉盤的 overlay）收得到轉盤，顯示觀眾名稱與結果', async (t) => {
    const page = await open(t);
    const cfg = await H.readKey(page, 'tw.config');
    const ov = await H.newPage(browser, { width: 1280, height: 720 }); t.after(() => ov.close());
    await ov.goto(`${srv.url}/index.html?overlay=1&room=${cfg.room}&key=${cfg.secret}&mode=spin&sync=0`, { waitUntil: 'networkidle0' });
    await H.sleep(800);
    await ov.bringToFront(); // 覆蓋層在背景分頁時瀏覽器會暫停動畫（OBS 裡不會），所以讓它保持在前面
    await page.evaluate(async () => {
      document.querySelector('#manualAdd').click(); await new Promise((r) => setTimeout(r, 200));
      document.querySelector('#confirmInput').value = '嘎唄(gabai)'; document.querySelector('#confirmOk').click();
    });
    await waitFor(() => ov.$eval('#ovResultLayer', (e) => !e.classList.contains('out')), 10000);
    assert.match(await ov.$eval('#ovPlayer', (e) => e.textContent), /嘎唄\(gabai\)/);
    assert.match(await ov.$eval('#ovGrid', (e) => e.textContent), /[135]點/);
    assert.deepEqual(ov.errors, []);
  });

  test('瀏覽器動畫被暫停（視窗縮小）時，排隊還是會一個一個轉完', async (t) => {
    const page = await open(t);
    await waitFor(() => page.evaluate(() => window.__tw.subscribed));
    await page.evaluate(() => {
      window.requestAnimationFrame = () => 0; // 模擬瀏覽器縮小時不畫面
      ['p1', 'p2', 'p3'].forEach((id) => window.__tw.redeem({ id, user_login: id, user_name: id, reward: { id: 'rw1', title: '轉' } }));
    });
    await waitFor(() => page.$eval('#queueCount', (e) => e.textContent === '0'), 20000);
    assert.equal((await records(page)).length, 3);
  });

  test('搬到 OBS 面板：設定與可退點紀錄一起搬過去、只匯入一次；原本的瀏覽器停止接收', async (t) => {
    const hold = doneRec('h1', { rewardId: 'rw1', tw: 'hold', holdUntil: Date.now() + 3600e3 });
    const page = await open(t, { config: { ...READY, prizes: [{ id: 'a', name: '大獎', weight: 1, column: '5點' }, { id: 'b', name: '小獎', weight: 9, column: '1點' }] }, before: (p) => H.seed(p, { 'tw.records': [hold, doneRec('old')] }) });
    await browser.defaultBrowserContext().overridePermissions(srv.url, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    await waitFor(() => page.evaluate(() => window.__tw.subscribed));
    await page.click('#toSetup'); await H.sleep(200);
    assert.equal(await page.$eval('#step6', (e) => e.classList.contains('done')), false);
    await page.click('#copyDock'); await H.sleep(300);
    const url = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(url, /\/twitch\.html\?dock=1#move=[A-Za-z0-9_-]+$/);
    await page.click('#confirmOk'); await H.sleep(300);
    assert.equal(await page.$eval('#movedBanner', (e) => e.classList.contains('hidden')), false);
    assert.equal(await page.$eval('#step6', (e) => e.classList.contains('done')), true);
    assert.equal((await H.readKey(page, 'tw.config')).movedToObs, true);
    assert.equal(await page.evaluate(() => window.__tw.sockets.at(-1).closed), true); // 不再收兌換

    // OBS 面板＝另一個瀏覽器（儲存空間分開）
    const ctx = await browser.createBrowserContext(); t.after(() => ctx.close());
    const dock = await ctx.newPage(); dock.errors = []; dock.on('pageerror', (e) => dock.errors.push(e.message));
    await dock.setViewport({ width: 380, height: 800 });
    await dock.evaluateOnNewDocument(installMocks);
    await dock.goto(url, { waitUntil: 'networkidle0' }); await H.sleep(400);
    assert.equal(await dock.evaluate(() => document.body.classList.contains('dock')), true);
    assert.equal(await dock.evaluate(() => location.hash), ''); // 網址列不留設定
    const dcfg = await H.readKey(dock, 'tw.config');
    const ccfg = await H.readKey(page, 'tw.config');
    for (const k of ['scriptUrl', 'sheetKey', 'room', 'secret', 'rewardIds']) assert.deepEqual(dcfg[k], ccfg[k], k);
    assert.deepEqual(dcfg.prizes.map((p) => p.name), ['大獎', '小獎']);
    assert.equal(dcfg.movedToObs, false);
    assert.deepEqual((await H.readKey(dock, 'tw.records')).map((r) => r.id), ['h1']); // 只搬可退點期的
    assert.equal(await dock.$eval('#step3', (e) => e.classList.contains('done')), true);
    assert.equal(await dock.$eval('#step6', (e) => e.classList.contains('done')), true);
    assert.equal(await dock.$eval('#dockHere', (e) => !e.classList.contains('hidden')), true);
    assert.equal(await dock.$eval('#step1', (e) => e.classList.contains('done')), false); // Twitch 要在面板裡登入一次
    // OBS 重開會用同一個網址：改過的設定不能被蓋回去
    await dock.evaluate(async () => { document.querySelector('#cutoffHour').value = '4'; document.querySelector('#cutoffHour').dispatchEvent(new Event('change')); });
    await H.sleep(300);
    await dock.goto(url, { waitUntil: 'networkidle0' }); await H.sleep(400);
    assert.equal((await H.readKey(dock, 'tw.config')).cutoffHour, 4);
    assert.equal(await dock.evaluate(() => document.body.scrollWidth <= innerWidth), true); // 窄面板不出現橫向捲軸
    assert.deepEqual(dock.errors, []);

    // 原本的瀏覽器可以改回來
    await page.click('#unmove'); await H.sleep(200); await page.click('#confirmOk');
    await waitFor(() => page.evaluate(() => window.__tw.sockets.length >= 2 && !window.__tw.sockets.at(-1).closed));
    assert.equal(await page.$eval('#movedBanner', (e) => e.classList.contains('hidden')), true);
    assert.deepEqual(page.errors, []);
  });

  test('「看圖解」連結帶著說明書頁碼，PDF 與快速上手都找得到', async (t) => {
    const page = await open(t, { config: { ...READY, setupDone: false } });
    const pages = JSON.parse(require('node:fs').readFileSync(require('node:path').join(H.ROOT, 'docs/guide-pages.json'), 'utf8'));
    await waitFor(() => page.$eval('[data-guide="step3"]', (a) => a.getAttribute('href').includes('#page=')));
    const links = await page.$$eval('[data-guide]', (as) => as.map((a) => [a.dataset.guide, a.getAttribute('href')]));
    assert.equal(links.length, 7);
    for (const [k, href] of links) assert.ok(href.endsWith(`#page=${pages[k]}`), `${k} ${href}`);
    for (const href of [links[0][1].split('#')[0], await page.$eval('.tw-guide-link a', (a) => a.getAttribute('href'))]) {
      const r = await page.evaluate((u) => fetch(u).then((x) => x.status + ' ' + x.headers.get('content-type')), href);
      assert.match(r, /^200 application\/pdf/, href);
    }
  });
}
