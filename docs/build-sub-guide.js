'use strict';
/* 單張圖文「續訂也能抽獎」：真的 twitch.html（Twitch 換成模擬資料）截圖，排成一張 PNG。執行：node docs/build-sub-guide.js */
const path = require('node:path');
const H = require('../test/e2e/helpers');
const { installMocks } = require('../test/e2e/twitch-mocks');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL_OK = 'https://script.google.com/macros/s/AKfycb-example/exec';
const OUT = path.join(__dirname, '忠誠點轉盤_續訂抽獎.png');

(async () => {
  const srv = await H.serve();
  const browser = await H.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument(installMocks);
  await page.goto(`${srv.url}/twitch.html`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => new Promise((res) => { const r = indexedDB.deleteDatabase('lucky-wheel'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
  await H.seed(page, {
    'tw.records': [], 'tw.queue': [], 'tw.auth': { token: 'tok', clientId: 'cid' },
    'tw.config': { clientId: 'cid', sync: false, spinDuration: 1800, resultSeconds: 4, sound: false, theme: 'light', rewardIds: ['rw1'], scriptUrl: URL_OK, sheetOk: URL_OK, setupDone: true, triggers: { sub: { on: true, newSpins: 1, resubSpins: 3, t2: 2, t3: 5 } } },
  });
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(1500);
  await page.addStyleTag({ content: '.tw .topbar,.tw-alert{position:relative!important;top:0!important} .mark{outline:4px solid #e8a33d!important;outline-offset:3px;border-radius:6px}' });

  // 1. 設定步驟 7 的訂閱區塊，框出要填的地方
  await page.click('#toSetup'); await sleep(400);
  await page.evaluate(() => { ['#subOn', '#subResub', '#subT2', '#subT3'].forEach((s) => document.querySelector(s).closest('label').classList.add('mark')); });
  const sub = await page.$('#subBox'); await sub.evaluate((e) => e.scrollIntoView({ block: 'center' })); await sleep(300);
  const shot1 = await sub.screenshot({ encoding: 'base64' });

  // 2. 有人續訂（Tier 1，第 2 個月）→ 轉 3 次
  await page.click('#toLive'); await sleep(400);
  await page.evaluate(() => window.__tw.notify('channel.subscription.message', { user_login: 'haruneuka', user_name: 'HaruneUka', user_id: '77', tier: '1000', cumulative_months: 2, message: '' }, 'r1'));
  await page.waitForFunction(() => /續訂 2 個月/.test(document.querySelector('#nowBanner').textContent)); await sleep(2600);
  const stage = await page.$('.tw-stage');
  const shot2 = await stage.screenshot({ encoding: 'base64' });
  await page.waitForFunction(() => !document.querySelector('#nowBanner').classList.contains('active'), { timeout: 20000 });
  const side = await page.$('.tw-side .tw-box:last-child');
  const shot3 = await side.screenshot({ encoding: 'base64' });

  // 排成一張（跟功能總覽同一套樣式）
  const card = await browser.newPage();
  await card.setViewport({ width: 900, height: 800, deviceScaleFactor: 2 });
  await card.setContent(`<html><head><style>
    body{margin:0;background:#f4efe4;font-family:"Noto Sans TC","Microsoft JhengHei",sans-serif;color:#141414;padding:30px 36px 34px;width:900px;box-sizing:border-box}
    .badge{display:inline-block;background:#ffcf33;border:3px solid #141414;border-radius:12px;padding:4px 16px;font-size:30px;font-weight:900;box-shadow:4px 4px 0 #141414}
    .sub{color:#5c5850;font-size:17px;margin:12px 0 22px}
    .step{display:flex;gap:12px;align-items:flex-start;font-size:19px;font-weight:700;line-height:1.55;margin:20px 0 10px}
    .no{flex:none;width:34px;height:34px;border-radius:50%;background:#ffcf33;border:3px solid #141414;display:flex;align-items:center;justify-content:center;font-weight:900}
    img{display:block;margin:0 auto;border:3px solid #141414;border-radius:10px;max-width:100%;background:#fff}
    .two{display:flex;gap:16px;align-items:flex-start}.two img{max-width:none;width:100%}.two>div{flex:1}
    .note{margin-top:22px;background:#141414;color:#fffdf7;border-radius:12px;padding:14px 18px;font-size:16px;line-height:1.7}
    .note b{background:#ffcf33;color:#141414;border-radius:6px;padding:1px 8px;margin-right:6px}
  </style></head><body>
    <span class="badge">續訂也能抽獎</span>
    <p class="sub">觀眾在聊天室分享續訂（「已訂閱層級 1。這位使用者已經訂閱了 2 個月！」）時自動轉盤</p>
    <div class="step"><span class="no">1</span><span>右上角「設定」→ 往下到「7 加碼：小奇點、訂閱也轉盤」，勾「訂閱」，在「續訂轉 __ 次」填要抽幾次。Tier 2、Tier 3 可以另外乘倍數（例：Tier 3 乘 5，續訂 3 次就變 15 次）。改了馬上生效。</span></div>
    <img src="data:image/png;base64,${shot1}" style="width:88%">
    <div class="step"><span class="no">2</span><span>有人分享續訂，就照設定的次數轉盤，結果一樣寫進試算表；紀錄上會標「續訂 2 個月（Tier 1）」。</span></div>
    <div class="two"><div><img src="data:image/png;base64,${shot2}"></div><div style="flex:.8"><img src="data:image/png;base64,${shot3}"></div></div>
    <div class="note"><b>注意</b>只有觀眾自己按「分享續訂」、聊天室出現那行字時，Twitch 才會通知；沒分享、自動續訂的收不到。網頁（或 OBS 面板）要開著；第一次打開訂閱要重新連接 Twitch 一次。</div>
  </body></html>`, { waitUntil: 'load' });
  await sleep(500);
  const h = await card.evaluate(() => document.body.scrollHeight);
  await card.setViewport({ width: 900, height: h, deviceScaleFactor: 2 });
  await card.screenshot({ path: OUT, fullPage: true });
  console.log(OUT);
  await browser.close(); srv.server.close();
})().catch((e) => { console.error(e); process.exit(1); });
