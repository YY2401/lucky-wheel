'use strict';
/* 忠誠點轉盤（twitch.html）端對端：Twitch API / EventSub / Apps Script 都換成頁內模擬，其餘是真的 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

// 在頁面任何程式執行前裝上模擬：fetch（Twitch、Apps Script）與 WebSocket（EventSub）
function installMocks() {
  const M = (window.__tw = {
    sockets: [], sheetCalls: [], validateStatus: Number(localStorage.getItem('mock.validate')) || 200, subscribeStatus: 202, failSheet: 0, rowErrors: {},
    rewards: [{ id: 'rw1', title: '忠誠點轉盤', cost: 500, is_enabled: true, background_color: '#00C7AC' }, { id: 'rw2', title: '喝水', cost: 100, is_enabled: true }],
    redeem(ev) {
      const ws = M.sockets[M.sockets.length - 1];
      ws.onmessage({ data: JSON.stringify({ metadata: { message_type: 'notification' }, payload: { subscription: { type: 'channel.channel_points_custom_reward_redemption.add' }, event: { redeemed_at: new Date().toISOString(), ...ev } } }) });
    },
  });
  class FakeWS {
    constructor(url) {
      this.url = url; M.sockets.push(this);
      setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: `S${M.sockets.length}`, keepalive_timeout_seconds: 600 } } }) }), 30);
    }
    close() { this.closed = true; if (this.onclose) setTimeout(() => this.onclose(), 0); }
  }
  window.WebSocket = FakeWS;
  const real = window.fetch.bind(window);
  const json = (o, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } }));
  window.fetch = (url, opts = {}) => {
    url = String(url);
    if (url.startsWith('https://id.twitch.tv/oauth2/validate')) return M.validateStatus === 200 ? json({ login: 'streamer', user_id: '123', client_id: 'cid', expires_in: 9999 }) : json({ status: 401 }, 401);
    if (url.startsWith('https://api.twitch.tv/helix/users')) return json({ data: [{ display_name: '實況主' }] });
    if (url.startsWith('https://api.twitch.tv/helix/channel_points/custom_rewards')) return json({ data: M.rewards });
    if (url.startsWith('https://api.twitch.tv/helix/eventsub/subscriptions')) { M.subscribed = JSON.parse(opts.body); return json({}, M.subscribeStatus); }
    if (url.startsWith('https://script.google.com/')) {
      const req = JSON.parse(opts.body);
      M.sheetCalls.push(req);
      if (M.failSheet > 0) { M.failSheet--; return Promise.reject(new TypeError('Failed to fetch')); }
      if (req.action === 'ping') return json({ ok: true, title: '轉盤紀錄', viewers: 216, sheet: '10月', columns: { '1點': 'AA', '3點': 'AB', '5點': 'AC' }, problems: [] });
      return json({ ok: true, results: req.records.map((r, i) => (M.rowErrors[r.login] ? { id: r.id, ok: false, error: M.rowErrors[r.login] } : { id: r.id, ok: true, cell: `${Number(r.date.slice(5, 7))}月!AB${3 + i}`, name: `${r.display}(${r.login})`, isNew: r.login === 'newbie' })) });
    }
    return real(url, opts);
  };
}

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
    assert.equal(authUrl.searchParams.get('scope'), 'channel:read:redemptions');
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

  test('撤銷：送出 undo，狀態變「已撤銷」', async (t) => {
    const done = { id: 'u1', time: new Date().toISOString(), date: '2026-10-04', login: 'gabai', display: '嘎唄', reward: '轉', prizeId: 'pt3', prize: '3點', column: '3點', color: '#6bcb77', status: 'ok', cell: '10月!AB3', error: '', attempts: 1 };
    const page = await open(t, { before: (p) => H.seed(p, { 'tw.records': [done] }) });
    await page.click('[data-undo="u1"]'); await H.sleep(200);
    await page.click('#confirmOk');
    await waitFor(async () => (await records(page))[0].status === 'undone');
    const call = await page.evaluate(() => window.__tw.sheetCalls.find((c) => c.action === 'undo'));
    assert.equal(call.records[0].id, 'u1');
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
}
