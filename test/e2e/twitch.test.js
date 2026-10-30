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
    const page = H.autoTab(await H.newPage(browser));
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
    assert.equal(authUrl.searchParams.get('scope'), 'channel:read:redemptions channel:manage:redemptions bits:read channel:read:subscriptions');
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
    assert.match(await page.$eval('#sheetResult', (e) => e.textContent), /建議補上 Twitch 帳號（1 人）.*夜貓子/s);
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
      window.__tw.redeem({ id: 'e1', user_login: 'xiaomei', user_name: '小美', user_id: '1001', reward: { id: 'rw1', title: '忠誠點轉盤' } });
      window.__tw.redeem({ id: 'e1', user_login: 'xiaomei', user_name: '小美', reward: { id: 'rw1', title: '忠誠點轉盤' } }); // 重送
      window.__tw.redeem({ id: 'e2', user_login: 'x', user_name: 'x', reward: { id: 'rw2', title: '喝水' } });
      window.__tw.redeem({ id: 'e3', user_login: 'newbie', user_name: '新朋友', reward: { id: 'rw1', title: '忠誠點轉盤' } });
    });
    assert.match(await page.$eval('#nowBanner', (e) => e.textContent), /小美/);
    const recs = await waitFor(async () => { const r = await records(page); return r.length === 2 && r.every((x) => x.status === 'ok') && r; });
    assert.deepEqual(recs.map((r) => r.id).sort(), ['e1', 'e3']);
    assert.ok(recs.every((r) => ['1點', '3點', '5點'].includes(r.column)));
    const sent = await page.evaluate(() => window.__tw.sheetCalls.flatMap((c) => c.records || []));
    assert.deepEqual([...new Set(sent.map((r) => r.id))].sort(), ['e1', 'e3']);
    assert.deepEqual(Object.keys(sent[0]).sort(), ['column', 'date', 'display', 'id', 'login', 'uid']);
    assert.equal(sent.find((r) => r.id === 'e1').uid, '1001'); // Twitch 永久編號：觀眾改帳號也認得
    await waitFor(() => page.$eval('#queueCount', (e) => e.textContent === '0'));
    assert.match(await page.$eval('#recordList', (e) => e.textContent), /新觀眾已加入名單/);
    assert.deepEqual(page.errors, []);
  });

  test('小奇點：每滿 100 轉一次、零頭累積，一筆轉好幾次各寫一格；重送不重算；訂閱用第二個轉盤', async (t) => {
    const triggers = { bits: { on: true, per: 100, carry: true }, sub: { on: true, newSpins: 1, t3: 3, wheel: 'bonus' } };
    const page = await open(t, { config: { ...READY, triggers, wheel2: { name: '斗內轉盤', prizes: [{ id: 'bx', name: '大獎', weight: 1, column: '5點' }] } } });
    await waitFor(() => page.evaluate(() => window.__tw.subs.includes('channel.cheer') && window.__tw.subs.includes('channel.subscription.gift')));
    const viewer = { user_login: 'xiaomei', user_name: '小美', user_id: '1001' };
    await page.evaluate((v) => {
      window.__tw.notify('channel.cheer', { ...v, bits: 250 }, 'c1');
      window.__tw.notify('channel.cheer', { ...v, bits: 250 }, 'c1'); // Twitch 重送同一則
    }, viewer);
    await waitFor(() => page.$eval('#nowBanner', (e) => /小奇點 250.*轉 2 次/.test(e.textContent)));
    let recs = await waitFor(async () => { const r = await records(page); return r.length === 2 && r.every((x) => x.status === 'ok') && r; });
    assert.deepEqual(recs.map((r) => r.id).sort(), ['ev-c1.1', 'ev-c1.2']);
    assert.ok(recs.every((r) => r.source === 'bits' && r.src === 'ev-c1' && r.login === 'xiaomei'));
    assert.equal((await H.readKey(page, 'tw.config')).bitsCarry['1001'], 50);
    // 再送 60：加上零頭 50 湊滿一次，剩 10
    await page.evaluate((v) => window.__tw.notify('channel.cheer', { ...v, bits: 60 }, 'c2'), viewer);
    await waitFor(async () => (await records(page)).some((r) => r.id === 'ev-c2'));
    assert.equal((await H.readKey(page, 'tw.config')).bitsCarry['1001'], 10);
    // 層級三新訂閱：乘 3 倍，轉第二個轉盤
    await page.evaluate(() => window.__tw.notify('channel.subscribe', { user_login: 'subber', user_name: '訂閱者', user_id: '77', tier: '3000', is_gift: false }, 's1'));
    recs = await waitFor(async () => { const r = (await records(page)).filter((x) => x.src === 'ev-s1'); return r.length === 3 && r.every((x) => x.status === 'ok') && r; }, 15000);
    assert.ok(recs.every((r) => r.prize === '大獎' && r.column === '5點' && r.source === 'sub'));
    const sent = await page.evaluate(() => window.__tw.sheetCalls.flatMap((c) => c.records || []));
    assert.equal(sent.filter((r) => r.id.startsWith('ev-c1')).length, 2);
    assert.match(await page.$eval('#recordList', (e) => e.textContent), /新訂閱（層級三）/);
    // 撤銷：沒有忠誠點可退
    await page.click(`[data-undo="${recs[0].id}"]`);
    assert.match(await page.$eval('#undoRefundHint', (e) => e.textContent), /沒有忠誠點可退/);
    await page.click('#undoCancel');
    assert.deepEqual(page.errors, []);
  });

  test('小奇點、訂閱：舊授權缺權限時提醒重新連接；設定頁可模擬一次（不寫進試算表）', async (t) => {
    const page = await open(t, { before: (p) => p.evaluate(() => localStorage.setItem('mock.scopes', 'nobits')) });
    await waitFor(() => page.evaluate(() => window.__tw.subscribed));
    assert.equal(await page.$eval('#alert', (e) => e.classList.contains('hidden')), true); // 沒打開就不打擾
    await page.click('#toSetup');
    await page.click('#bitsOn');
    await waitFor(() => page.$eval('#alertText', (e) => /小奇點、訂閱通知.*重新連接/.test(e.textContent)));
    assert.match(await page.$eval('#trigState', (e) => e.textContent), /重新連接 Twitch/);
    assert.equal((await H.readKey(page, 'tw.config')).triggers.bits.on, true);
    // 依門檻模式 + 模擬 600 小奇點：門檻 500 轉 6 次
    await page.click('input[name="bitsMode"][value="tiers"]');
    assert.equal((await H.readKey(page, 'tw.config')).triggers.bits.mode, 'tiers');
    await page.click('#simBits');
    await page.waitForSelector('#confirmModal:not(.hidden)');
    await page.$eval('#confirmInput', (i) => { i.value = '600'; });
    await page.click('#confirmOk');
    await waitFor(() => page.$eval('#nowBanner', (e) => /轉 6 次/.test(e.textContent)));
    const recs = await waitFor(async () => { const r = await records(page); return r.length === 6 && r; });
    assert.ok(recs.every((r) => r.status === 'test'));
    assert.equal(await page.evaluate(() => window.__tw.sheetCalls.filter((c) => c.action === 'add').length), 0);
    assert.deepEqual(page.errors, []);
  });

  test('排隊陪玩：兌換加入、重複排退點、下一輪叫號並標成完成、移出可退點、OBS 排隊名單同步、暫停', async (t) => {
    const page = await open(t, { config: { ...READY, party: { rewardId: 'rwq', batch: 1, show: 5 } }, before: (p) => p.evaluate(() => localStorage.setItem('mock.party', '1')) });
    await waitFor(() => page.evaluate(() => window.__tw.subscribed));
    assert.equal(await page.$eval('#partyBox', (e) => e.classList.contains('hidden')), false);
    const q = (id, login, input = '') => ({ id, user_login: login, user_name: login.toUpperCase(), user_id: `u${login}`, user_input: input, reward: { id: 'rwq', title: '排隊陪玩' } });
    await page.evaluate((a, b, c) => { window.__tw.redeem(a); window.__tw.redeem(b); window.__tw.redeem(c); }, q('q1', 'amy', 'Amy#1'), q('q2', 'bob'), q('q3', 'amy'));
    await waitFor(() => page.$eval('#partyCount', (e) => e.textContent === '2'));
    await waitFor(() => page.evaluate(() => window.__tw.patches.some((x) => x.status === 'CANCELED' && x.ids.includes('q3')))); // 同一人重複排：退點
    assert.match(await page.$eval('#partyWaiting', (e) => e.textContent), /1AMY.*Amy#1.*2BOB/s);
    assert.equal((await records(page)).length, 0); // 不會轉盤
    // OBS 排隊名單（同一個瀏覽器）
    const cfg = await H.readKey(page, 'tw.config');
    const ov = await H.newPage(browser); t.after(() => ov.close());
    await ov.goto(`${srv.url}/queue.html?room=${cfg.room}&key=${cfg.secret}&sync=0`, { waitUntil: 'networkidle0' });
    await waitFor(() => ov.$eval('#waiting', (e) => /AMY.*BOB/s.test(e.textContent)));
    assert.ok(!(await ov.$eval('#card', (e) => e.textContent)).includes('Amy#1'), '預設不公開遊戲 ID');
    // 下一輪：amy 上場；再下一輪：amy 標成完成、bob 上場（背景分頁點不到按鈕，先切回控制面板）
    await page.bringToFront();
    await page.click('#partyNext');
    await waitFor(() => page.$eval('#partyPlaying', (e) => /AMY/.test(e.textContent)));
    await waitFor(() => ov.$eval('#playing', (e) => /AMY/.test(e.textContent)));
    await page.click('#partyNext');
    await waitFor(() => page.evaluate(() => window.__tw.patches.some((x) => x.status === 'FULFILLED' && x.ids.includes('q1'))));
    assert.match(await page.$eval('#partyPlaying', (e) => e.textContent), /BOB/);
    // 移出並退點
    await page.evaluate((c) => window.__tw.redeem(c), q('q4', 'cat'));
    await waitFor(() => page.$('[data-party-remove="q4"]'));
    await page.click('[data-party-remove="q4"]'); await page.click('#confirmOk'); await H.sleep(200); await page.click('#confirmOk');
    await waitFor(() => page.evaluate(() => window.__tw.patches.some((x) => x.status === 'CANCELED' && x.ids.includes('q4'))));
    assert.equal(await page.$eval('#partyCount', (e) => e.textContent), '0');
    // 暫停排隊
    await page.click('#partyPause');
    await waitFor(() => page.$eval('#partyPaused', (e) => !e.classList.contains('hidden')));
    assert.equal(await page.evaluate(() => window.__tw.rewards.find((r) => r.id === 'rwq').is_paused), true);
    assert.deepEqual(page.errors, []); assert.deepEqual(ov.errors || [], []);
  });

  test('排隊陪玩：網頁關著時兌換的人，打開後自動排進隊伍', async (t) => {
    const page = await open(t, { config: { ...READY, party: { rewardId: 'rwq' } }, before: (p) => p.evaluate(() => {
      localStorage.setItem('mock.party', '1');
      localStorage.setItem('mock.unfulfilled', JSON.stringify([{ id: 'off1', user_login: 'zed', user_name: 'Zed', user_id: 'uz', user_input: 'Z#9', redeemed_at: '2026-10-24T10:00:00Z', reward: { id: 'rwq', title: '排隊陪玩' } }]));
    }) });
    await waitFor(() => page.$eval('#partyWaiting', (e) => /Zed.*Z#9/s.test(e.textContent)));
    assert.deepEqual(await page.evaluate(() => window.__tw.patches), []);
    assert.deepEqual(page.errors, []);
  });

  test('小奇點點歌：貼 YouTube 連結就排隊（不轉盤）、沒貼的照樣轉盤；播放器回報歌名、播完換下一首、播不了列進沒播的；封鎖', async (t) => {
    const page = await open(t, { config: { ...READY, triggers: { bits: { on: true, per: 100 } }, songs: { on: true, minBits: 100 } } });
    await waitFor(() => page.evaluate(() => window.__tw.subs.includes('channel.cheer')));
    const v = { user_login: 'xiaomei', user_name: '小美', user_id: '1001' };
    await page.evaluate((u) => {
      window.__tw.notify('channel.cheer', { ...u, bits: 200, message: 'Cheer200 https://youtu.be/AAAAAAAAAA1?si=x' }, 's1');
      window.__tw.notify('channel.cheer', { user_login: 'bob', user_name: 'Bob', user_id: '2', bits: 100, message: 'Cheer100 https://www.youtube.com/watch?v=BBBBBBBBBB2' }, 's2');
      window.__tw.notify('channel.cheer', { user_login: 'cat', user_name: 'Cat', user_id: '3', bits: 50, message: 'Cheer50 https://youtu.be/CCCCCCCCCC3' }, 's3');
      window.__tw.notify('channel.cheer', { user_login: 'dan', user_name: 'Dan', user_id: '4', bits: 300, message: 'Cheer300 https://youtu.be/DDDDDDDDDD4' }, 's4');
      window.__tw.notify('channel.cheer', { ...u, bits: 100, message: 'Cheer100 加油' }, 'c1'); // 沒貼連結：照步驟 7 轉盤
    }, v);
    await waitFor(() => page.$eval('#songCount', (e) => e.textContent === '2'));
    assert.match(await page.$eval('#songNow', (e) => e.textContent), /youtu\.be\/AAAAAAAAAA1.*小美.*200 小奇點/s);
    assert.match(await page.$eval('#songMissed', (e) => e.textContent), /Cat.*小奇點不到 100/s);
    await waitFor(async () => (await records(page)).some((r) => r.src === '' && r.id === 'ev-c1' && r.source === 'bits'));
    assert.equal((await records(page)).length, 1); // 點歌的小奇點不轉盤
    // 假裝 OBS 點歌播放器（同一個瀏覽器，用同一組頻道代碼和暗號）
    const cfg = await H.readKey(page, 'tw.config');
    const ov = await H.newPage(browser); t.after(() => ov.close());
    await ov.goto(`${srv.url}/queue.html?room=${cfg.room}&key=${cfg.secret}&sync=0`, { waitUntil: 'networkidle0' });
    const ev = (id, event, extra = {}) => ov.evaluate((m) => window.LW.Sync.send(m), { type: 'songEvent', id, event, ...extra });
    await ev('song-s1', 'title', { title: '夜に駆ける（免版權翻唱）' });
    await page.bringToFront();
    await waitFor(() => page.$eval('#songNow', (e) => /夜に駆ける/.test(e.textContent)));
    await ev('song-s2', 'ended'); await H.sleep(300); // 不是正在播的那首：不理
    assert.match(await page.$eval('#songNow', (e) => e.textContent), /夜に駆ける/);
    await ev('song-s1', 'ended');
    await waitFor(() => page.$eval('#songNow', (e) => /BBBBBBBBBB2/.test(e.textContent)));
    await ev('song-s2', 'error', { code: 150 });
    await waitFor(() => page.$eval('#songMissed', (e) => /不允許在其他網站播放/.test(e.textContent)));
    assert.match(await page.$eval('#songNow', (e) => e.textContent), /DDDDDDDDDD4/);
    // 封鎖：跳過，之後再點同一首不播
    await page.click('#songBlock'); await page.click('#confirmOk');
    await waitFor(async () => (await H.readKey(page, 'tw.config')).songs.blocked.includes('DDDDDDDDDD4'));
    await page.evaluate(() => window.__tw.notify('channel.cheer', { user_login: 'eve', user_name: 'Eve', user_id: '5', bits: 100, message: 'Cheer100 DDDDDDDDDD4' }, 's5'));
    await waitFor(() => page.$eval('#songMissed', (e) => /Eve.*封鎖/s.test(e.textContent)));
    // 沒播的點歌按「播」照樣排進去
    await page.click('#songMissedBox summary');
    await page.click('[data-song-play="song-s3"]');
    await waitFor(() => page.$eval('#songNow', (e) => /CCCCCCCCCC3/.test(e.textContent)));
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

  const doneRec = (id, extra = {}) => ({ id, time: new Date().toISOString(), date: '2026-10-04', login: 'xiaomei', display: '小美', reward: '轉', prizeId: 'pt3', prize: '3點', column: '3點', color: '#6bcb77', status: 'ok', cell: '10月!AB3', error: '', attempts: 1, rewardId: '', tw: '', holdUntil: 0, ...extra });
  const unfulfilled = (id, rewardId = 'rw1', at = new Date().toISOString(), login = 'xiaomei', name = '小美') => ({ id, user_login: login, user_name: name, redeemed_at: at, status: 'UNFULFILLED', reward: { id: rewardId, title: '忠誠點轉盤' } });

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
        unfulfilled('m1', 'rw1', '2026-10-01T12:00:00.000Z', 'ading_tw', '阿丁'),
        unfulfilled('m2', 'rw1', '2026-10-02T12:00:00.000Z', 'xiaoju_tw', '小橘'),
      ]);
    } });
    await waitFor(() => page.$eval('#catchupModal', (e) => !e.classList.contains('hidden')));
    assert.equal(await page.$eval('#catchupCount', (e) => e.textContent), '2');
    assert.match(await page.$eval('#catchupList', (e) => e.textContent), /阿丁.*小橘/s);
    await page.click('#catchupList input[value="m2"]'); // 取消勾選 → 退點
    await page.click('#catchupGo'); await H.sleep(300);
    assert.match(await page.$eval('#confirmMsg', (e) => e.textContent), /小橘/);
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
    await page.type('#confirmInput', '小美 (xiaomei)');
    await page.click('#confirmOk');
    await page.click('#testSpin');
    const recs = await waitFor(async () => { const r = await records(page); return r.length === 2 && r.find((x) => x.status === 'ok') && r; }, 10000);
    const manual = recs.find((x) => x.reward === '手動補登');
    assert.equal(manual.login, 'xiaomei'); assert.equal(manual.display, '小美');
    assert.equal(recs.find((x) => x.reward === '試轉').status, 'test');
    const sent = await page.evaluate(() => window.__tw.sheetCalls.flatMap((c) => c.records || []));
    assert.deepEqual(sent.map((r) => r.login), ['xiaomei']);
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
      document.querySelector('#confirmInput').value = '小美(xiaomei)'; document.querySelector('#confirmOk').click();
    });
    await waitFor(() => ov.$eval('#ovResultLayer', (e) => !e.classList.contains('out')), 10000);
    assert.match(await ov.$eval('#ovPlayer', (e) => e.textContent), /小美\(xiaomei\)/);
    assert.match(await ov.$eval('#ovGrid', (e) => e.textContent), /[135]點/);
    assert.equal(await ov.$eval('#ovWrongPlace', (e) => e.classList.contains('hidden')), true, '直播畫面上不能出現「貼錯地方」提示');
    await ov.mouse.move(300, 300); await H.sleep(100);
    assert.equal(await ov.$eval('#ovWrongPlace', (e) => e.classList.contains('hidden')), true, '滑鼠移過不提示');
    await ov.mouse.click(320, 320); await H.sleep(100);
    assert.match(await ov.$eval('#ovWrongPlace:not(.hidden)', (e) => e.textContent), /觀眾看的轉盤.*控制面板/s); // 被貼進停駐視窗、點到：提示貼錯地方
    const top = await ov.evaluate(() => { const b = document.querySelector('#ovBanner').getBoundingClientRect(); const ring = document.querySelector('.wheel-wrap').getBoundingClientRect().top - document.querySelector('.wheel-wrap').offsetWidth * 0.07; return { bannerBottom: b.bottom, ringTop: ring, bannerTop: b.top }; });
    assert.ok(top.bannerBottom <= top.ringTop + 1 && top.bannerTop >= 0, `名字不能被轉盤外圈蓋到 ${JSON.stringify(top)}`);
    assert.deepEqual(ov.errors, []);
  });

  test('OBS 背景透明度：拉桿設 40 重新整理後還在；拉動時覆蓋層背景即時跟著變（不重新整理）、轉盤本身不變淡', async (t) => {
    const page = await open(t);
    const slide = (v) => page.$eval('#obsBgOpacity', (e, v) => { e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); }, v);
    const shown = () => page.$eval('#obsBgOpacity', (e) => [e.value, document.querySelector('#obsBgOpacityVal').textContent]);
    await H.showTab(page, '#obsBgOpacity');
    await slide(40);
    assert.deepEqual(await shown(), ['40', '40%']);
    await waitFor(async () => (await H.readKey(page, 'tw.config')).obsBgOpacity === 40);
    await page.reload({ waitUntil: 'networkidle0' }); await H.sleep(300);
    assert.deepEqual(await shown(), ['40', '40%']);

    // 覆蓋層：同一個瀏覽器、同一組頻道代碼和暗號（sync=0 只走 BroadcastChannel，不連外部伺服器）
    const cfg = await H.readKey(page, 'tw.config');
    const ov = await H.newPage(browser, { width: 1280, height: 720 }); t.after(() => ov.close());
    await ov.goto(`${srv.url}/index.html?overlay=1&room=${cfg.room}&key=${cfg.secret}&sync=0`, { waitUntil: 'networkidle0' });
    await H.sleep(500);
    await ov.evaluate(() => { window.__noReload = true; });
    const alpha = () => ov.$eval('body', (b) => {
      const c = getComputedStyle(b).backgroundColor;
      if (c === 'transparent') return 0;
      const m = c.match(/\/\s*([\d.]+)\s*\)$/) || c.match(/^rgba\(.*,\s*([\d.]+)\)$/);
      return m ? Number(m[1]) : 1;
    });
    const wheelOpacity = () => ov.$eval('#ovWheel', (e) => { let o = 1; for (let n = e; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; });
    const before = await wheelOpacity();
    for (const [v, want] of [[40, 0.4], [0, 0], [100, 1], [40, 0.4]]) {
      await slide(v);
      await waitFor(async () => Math.abs((await alpha()) - want) < 0.02, 5000).catch(async () => assert.fail(`拉到 ${v}：覆蓋層背景 alpha 應約 ${want}，實際 ${await alpha()}`));
      assert.equal(await wheelOpacity(), before, `拉到 ${v}：轉盤的 opacity 不能被改`);
    }
    assert.equal(await ov.evaluate(() => window.__noReload), true, '覆蓋層不能重新整理');
    assert.deepEqual(page.errors, []);
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
    assert.equal(links.length, 10);
    for (const [k, href] of links) assert.ok(href.endsWith(`#page=${pages[k]}`), `${k} ${href}`);
    for (const href of [links[0][1].split('#')[0], await page.$eval('#openGuide', (a) => a.getAttribute('href'))]) {
      const r = await page.evaluate((u) => fetch(u).then((x) => x.status + ' ' + x.headers.get('content-type')), href);
      assert.match(r, /^200 application\/pdf/, href);
    }
  });

  test('寫到哪一欄：測試連線後選單列出試算表實際的欄；可選不寫進試算表、可自己輸入', async (t) => {
    const prizes = [{ id: 'a', name: '1點', weight: 0, column: '1點' }, { id: 'miss', name: '下次一定', weight: 1, column: '1點' }]; // 一定轉到「下次一定」
    const page = await open(t, { config: { ...READY, setupDone: false, prizes } });
    const opts = () => page.$$eval('#prizeRows tr[data-i="1"] select option', (os) => os.map((o) => o.textContent));
    assert.ok(!(await opts()).includes('新欄位'));
    await page.click('#testSheet');
    await waitFor(() => page.$eval('#sheetResult', (e) => e.classList.contains('ok')));
    assert.deepEqual(await opts(), ['1點', '3點', '5點', 'Q版塗鴉', '新欄位', '（不寫進試算表）', '自己輸入…']);
    assert.deepEqual((await H.readKey(page, 'tw.config')).sheetColumns, ['1點', '3點', '5點', 'Q版塗鴉', '新欄位']);
    // 自己輸入一個試算表沒有的欄名：選單標示沒找到，並提醒重測
    await page.select('#prizeRows tr[data-i="0"] select', '__custom__'); await H.sleep(200);
    await page.$eval('#confirmInput', (e) => { e.value = ''; }); await page.type('#confirmInput', '特別獎'); await page.click('#confirmOk'); await H.sleep(200);
    assert.equal((await H.readKey(page, 'tw.config')).prizes[0].column, '特別獎');
    assert.match(await page.$eval('#prizeRows tr[data-i="0"] select', (s) => s.selectedOptions[0].textContent), /特別獎（試算表裡沒找到）/);
    // 落空的格子不寫進試算表
    await page.select('#prizeRows tr[data-i="1"] select', ''); await H.sleep(200);
    assert.equal((await H.readKey(page, 'tw.config')).prizes[1].column, '');
    await page.click('#finishSetup'); await H.sleep(200);
    if (await page.$('#confirmModal:not(.hidden)')) await page.click('#confirmOk');
    await waitFor(() => page.evaluate(() => window.__tw.subscribed));
    await page.evaluate(() => { window.__tw.sheetCalls = []; window.__tw.redeem({ id: 'nw1', user_login: 'xiaomei', user_name: '小美', reward: { id: 'rw1', title: '轉' } }); });
    const rec = await waitFor(async () => (await records(page)).find((r) => r.id === 'nw1'));
    assert.equal(rec.prize, '下次一定');
    assert.equal(rec.status, 'nowrite');
    await H.sleep(800);
    assert.equal(await page.evaluate(() => window.__tw.sheetCalls.filter((c) => c.action === 'add').length), 0);
    assert.match(await page.$eval('#recordList', (e) => e.textContent), /不寫進試算表/);
    await page.click('[data-undo="nw1"]'); await H.sleep(200);
    assert.match(await page.$eval('#undoMsg', (e) => e.textContent), /沒有寫進試算表/);
    await page.click('#undoRefundNo'); await page.click('#undoOk');
    await waitFor(async () => (await records(page)).find((r) => r.id === 'nw1').status === 'undone');
    assert.equal(await page.evaluate(() => window.__tw.sheetCalls.filter((c) => c.action === 'undo').length), 0);
    assert.deepEqual(page.errors, []);
  });

  test('代抽：兌換時輸入 @帳號就記給對方；查不到就記給兌換的人並註明；事後可改記給別人', async (t) => {
    const page = await open(t);
    await waitFor(() => page.evaluate(() => window.__tw.subscribed));
    await page.evaluate(() => {
      window.__tw.redeem({ id: 'px1', user_login: 'xiaomei', user_name: '小美', user_id: '1', user_input: '幫 @Xiaoju_tw 抽', reward: { id: 'rw1', title: '代抽轉盤' } });
      window.__tw.redeem({ id: 'px2', user_login: 'xiaomei', user_name: '小美', user_id: '1', user_input: '@nobody', reward: { id: 'rw1', title: '代抽轉盤' } });
      window.__tw.redeem({ id: 'px3', user_login: 'xiaomei', user_name: '小美', user_id: '1', user_input: '加油', reward: { id: 'rw1', title: '代抽轉盤' } });
      window.__tw.redeem({ id: 'px4', user_login: 'uncle_fu', user_name: '阿福', user_id: '2', user_input: '@路人甲', reward: { id: 'rw1', title: '代抽用' } });
      window.__tw.redeem({ id: 'px5', user_login: 'uncle_fu', user_name: '阿福', user_id: '2', user_input: '@雙胞胎', reward: { id: 'rw1', title: '代抽用' } });
    });
    await waitFor(() => page.$eval('#nowBanner', (e) => /小美 幫忙抽/.test(e.textContent)));
    const recs = await waitFor(async () => { const r = await records(page); return r.length === 5 && r.every((x) => x.status === 'ok') && r; }, 25000);
    const by = (id) => recs.find((r) => r.id === id);
    assert.equal(by('px1').login, 'xiaoju_tw'); assert.equal(by('px1').display, 'XIAOJU_TW'); assert.deepEqual(by('px1').by, { login: 'xiaomei', display: '小美' });
    assert.equal(by('px2').login, 'xiaomei'); assert.match(by('px2').note, /找不到 @nobody/);
    assert.equal(by('px3').login, 'xiaomei'); assert.equal(by('px3').by, null); // 留言不算代抽
    assert.equal(by('px4').login, 'lurenjia'); assert.equal(by('px4').display, '路人甲'); assert.deepEqual(by('px4').by, { login: 'uncle_fu', display: '阿福' }); // @中文名字
    assert.equal(by('px5').login, 'uncle_fu'); assert.match(by('px5').note, /找不到 @雙胞胎.*改記給/); // 同名不只一位：不猜，註明
    const sent = await page.evaluate(() => window.__tw.sheetCalls.flatMap((c) => c.records || []));
    assert.equal(sent.find((r) => r.id === 'px1').login, 'xiaoju_tw');
    assert.match(await page.$eval('#recordList', (e) => e.textContent), /小美 代抽/);
    // 事後改記：px2 改記給 azhe_tw
    await page.click('[data-move="px2"]'); await H.sleep(200);
    await page.type('#confirmInput', 'azhe_tw'); await page.click('#confirmOk');
    await waitFor(async () => { const r = (await records(page)).find((x) => x.id === 'px2'); return r.status === 'ok' && r.login === 'azhe_tw'; });
    const mv = await page.evaluate(() => window.__tw.sheetCalls.find((c) => c.action === 'move').records[0]);
    assert.equal(mv.from.login, 'xiaomei'); assert.equal(mv.to.login, 'azhe_tw');
    assert.match(await page.$eval('#recordList', (e) => e.textContent), /由 小美\(xiaomei\) 改記/);
    assert.deepEqual(page.errors, []);
  });

  test('建立代抽用品項：觀眾兌換時必須輸入文字', async (t) => {
    const page = await open(t, { config: { ...READY, rewardIds: [], setupDone: false } });
    await waitFor(() => page.$$eval('#rewards input', (e) => e.length === 2));
    await page.$eval('#newRewardTitle', (e) => { e.value = '代抽轉盤'; });
    await page.click('#newRewardProxy'); await page.click('#createReward');
    await waitFor(() => page.evaluate(() => window.__tw.created.length === 1));
    const b = await page.evaluate(() => window.__tw.created[0]);
    assert.equal(b.is_user_input_required, true); assert.match(b.prompt, /@對方/);
  });

  test('跨年：寫入因為沒有新年度分頁失敗時，提醒條變成「開新年度」，開完自動補寫', async (t) => {
    const page = await open(t);
    await waitFor(() => page.evaluate(() => window.__tw.subscribed));
    await page.evaluate(() => { window.__tw.rowErrors.xiaomei = '還沒有 2027 年 1 月的分頁（「1月」分頁是 2026 年的），請在轉盤網頁按「開新年度」'; });
    await page.evaluate(() => window.__tw.redeem({ id: 'ny1', user_login: 'xiaomei', user_name: '小美', reward: { id: 'rw1', title: '轉' }, redeemed_at: '2027-01-05T12:00:00Z' }));
    await waitFor(() => page.$eval('#alertBtn', (e) => e.textContent === '開新年度'), 15000);
    await page.click('#alertBtn'); await H.sleep(200);
    assert.equal(await page.$eval('#confirmInput', (e) => e.value), '2027'); // 用失敗那筆的年份
    await page.click('#confirmOk');
    await waitFor(() => page.$eval('#confirmTitle', (e) => /2027 年的分頁建好了/.test(e.textContent)));
    assert.match(await page.$eval('#confirmMsg', (e) => e.textContent), /12 個月份分頁.*98 格/s);
    await page.click('#confirmOk');
    await waitFor(async () => (await records(page)).find((r) => r.id === 'ny1').status === 'ok');
    assert.equal(await page.evaluate(() => window.__tw.newYear), 2027);
    assert.deepEqual(page.errors, []);
  });

  test('說明選單：功能總覽、快速上手可以直接用網頁看', async (t) => {
    const page = await open(t);
    await page.click('#openHelp'); await H.sleep(200);
    const items = await page.$$eval('#twHelpModal .tw-help-item', (as) => as.map((a) => [a.querySelector('b').textContent, a.getAttribute('href')]));
    assert.deepEqual(items.map((x) => x[0]), ['一頁快速上手', '功能總覽', '完整說明書（PDF）']);
    const doc = await H.newPage(browser, { width: 390, height: 800 }); t.after(() => doc.close());
    for (const [name, href] of items.slice(0, 2)) {
      await doc.goto(`${srv.url}/${href}`, { waitUntil: 'networkidle0' });
      assert.match(await doc.$eval('h1', (e) => e.textContent), new RegExp(name.replace('一頁', '')), name);
      assert.ok(await doc.evaluate(() => document.querySelectorAll('.card').length >= 4));
      assert.ok(await doc.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} 手機上不能出現橫向捲軸`);
    }
    assert.deepEqual(doc.errors, []);
  });
}
