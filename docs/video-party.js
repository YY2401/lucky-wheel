'use strict';
/* 「排隊陪玩」設定教學影片。網頁畫面用真的 twitch.html（Twitch 換成模擬資料），OBS 畫面用實際 OBS 截圖。
   node docs/video-party.js host            → 開一個示範控制面板（跨電腦同步開著），印出給 OBS 用的排隊名單網址，保持 20 分鐘
   node docs/video-party.js build docs/video-obs/obs.json → 錄網頁畫面、接上 OBS 截圖（obs.json：截圖檔、螢幕座標的裁切範圍與標示框），輸出 docs/忠誠點轉盤_排隊陪玩教學.mp4 與 .srt */
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const H = require('../test/e2e/helpers');
const { installMocks } = require('../test/e2e/twitch-mocks');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 1280; const HGT = 760; const DPR = 1.5;
const OUT = path.join(__dirname, '忠誠點轉盤_排隊陪玩教學');
const FRAMES = `${OUT}_frames`;
const LIVE = 'https://yy2401.github.io/lucky-wheel/';
const URL_OK = 'https://script.google.com/macros/s/AKfycb-example/exec';
const READY = { clientId: 'cid', spinDuration: 2600, resultSeconds: 3, sound: false, theme: 'light', rewardIds: ['rw1'], scriptUrl: URL_OK, sheetOk: URL_OK, setupDone: true };
const FONT = '"Noto Sans TC","Microsoft JhengHei",sans-serif';

async function openPanel(browser, { config, party, mockParty = true }) {
  const page = H.autoTab(await browser.newPage());
  await page.setViewport({ width: W, height: HGT, deviceScaleFactor: DPR });
  await page.evaluateOnNewDocument(() => { window.__RealWS = window.WebSocket; });
  await page.evaluateOnNewDocument(installMocks);
  // 模擬程式把 WebSocket 整個換掉了；只模擬 Twitch 的連線，跨電腦同步（OBS）要用真的
  await page.evaluateOnNewDocument(() => { const Fake = window.WebSocket; window.WebSocket = function (url, p) { return /eventsub/.test(url) ? new Fake(url) : new window.__RealWS(url, p); }; Object.assign(window.WebSocket, { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 }); });
  await page.goto(`${H.srvUrl}/twitch.html`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => new Promise((res) => { const r = indexedDB.deleteDatabase('lucky-wheel'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
  await page.evaluate((on) => { Object.keys(localStorage).filter((k) => k.startsWith('mock.')).forEach((k) => localStorage.removeItem(k)); if (on) localStorage.setItem('mock.party', '1'); }, mockParty);
  await H.seed(page, { 'tw.records': [], 'tw.queue': [], 'tw.config': config, 'tw.auth': { token: 'tok', clientId: 'cid' }, ...(party ? { 'tw.party': party } : {}) });
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
  return page;
}
const pe = (id, n, input) => ({ id, login: n.toLowerCase(), display: n, userId: '', input, rewardId: 'rwq', at: new Date().toISOString() });
const DEMO = { playing: [pe('p1', '小明', 'Ming#1234')], waiting: [pe('w1', '小美', 'Mei#22'), pe('w2', '阿哲', 'Zhe#8'), pe('w3', '路人甲', 'Lu#7')] };

// 字幕列＋標示框（跟 deliverable-kit 影片同一套樣式）
async function caption(page, text, sel, no, total) {
  if (sel) { await H.showTab(page, sel); await page.$eval(sel, (e) => e.scrollIntoView({ block: 'center' })); await sleep(300); }
  const box = sel ? await page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }) : null;
  await page.evaluate(({ text, box, no, total, FONT }) => {
    const o = document.createElement('div'); o.id = '__cap'; o.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    if (box) { const b = document.createElement('div'); b.style.cssText = `position:absolute;left:${box.x - 6}px;top:${box.y - 6}px;width:${box.w + 12}px;height:${box.h + 12}px;border:4px solid #e8a33d;border-radius:10px;box-shadow:0 0 0 4000px rgba(0,0,0,.18)`; o.appendChild(b); }
    const bar = document.createElement('div'); bar.style.cssText = `position:absolute;left:0;right:0;bottom:0;padding:16px 28px;background:rgba(31,41,51,.94);color:#fff;font:600 24px/1.5 ${FONT};display:flex;gap:16px;align-items:center`;
    const n = document.createElement('span'); n.textContent = `${no} / ${total}`; n.style.cssText = 'background:#e8a33d;color:#1f2933;border-radius:8px;padding:2px 10px;font-size:18px;white-space:nowrap';
    const t = document.createElement('span'); t.textContent = text; bar.append(n, t); o.appendChild(bar); document.body.appendChild(o);
  }, { text, box, no, total, FONT });
}
const clearCap = (page) => page.evaluate(() => document.getElementById('__cap')?.remove());

async function card(page, file, title, sub) {
  await page.setContent(`<html><body style="margin:0;height:100vh;display:flex;flex-direction:column;justify-content:center;padding:0 10%;background:#1f2933;color:#fff;font-family:${FONT}"><div style="width:80px;height:6px;background:#e8a33d;margin-bottom:28px"></div><h1 style="font-size:52px;margin:0;line-height:1.3"></h1><p style="font-size:26px;color:#cbd2d9;margin-top:18px"></p></body></html>`);
  await page.evaluate((a, b) => { document.querySelector('h1').textContent = a; document.querySelector('p').textContent = b; }, title, sub);
  await page.screenshot({ path: file });
}

// OBS 截圖：放大截圖本身就是螢幕上 crop 那塊；view（可省略）只顯示其中一塊放大；boxes 都用螢幕座標
async function obsFrame(page, file, f, no, total) {
  const img = f.dataUrl || `data:image/jpeg;base64,${fs.readFileSync(f.file).toString('base64')}`;
  const crop = f.crop; const view = f.view || f.crop;
  await page.setContent(`<html><body style="margin:0;width:${W}px;height:${HGT}px;background:#2b2e38;display:flex;align-items:flex-start;justify-content:center;overflow:hidden"><div id="wrap" style="position:relative;margin-top:24px;overflow:hidden;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.5)"><img id="im" src="${img}" style="display:block;position:absolute"></div></body></html>`);
  await page.waitForFunction(() => document.getElementById('im').complete);
  await page.evaluate(({ boxes, crop, view, maxW, maxH }) => {
    const vw = view[2] - view[0]; const vh = view[3] - view[1];
    const k = Math.min(maxW / vw, maxH / vh); // 螢幕座標 → 畫面像素
    const wrap = document.getElementById('wrap'); const im = document.getElementById('im');
    wrap.style.width = `${vw * k}px`; wrap.style.height = `${vh * k}px`;
    im.style.width = `${(crop[2] - crop[0]) * k}px`; im.style.left = `${(crop[0] - view[0]) * k}px`; im.style.top = `${(crop[1] - view[1]) * k}px`;
    for (const [a, b, c, d] of boxes) { const e = document.createElement('div'); e.style.cssText = `position:absolute;left:${(a - view[0]) * k - 3}px;top:${(b - view[1]) * k - 3}px;width:${(c - a) * k + 6}px;height:${(d - b) * k + 6}px;border:3px solid #e8a33d;border-radius:6px`; wrap.appendChild(e); }
  }, { boxes: f.boxes || [], crop, view, maxW: W - 80, maxH: HGT - 140 });
  await caption(page, f.caption, null, no, total);
  await page.screenshot({ path: file });
}

(async () => {
  const mode = process.argv[2];
  const srv = await H.serve(); H.srvUrl = srv.url;
  const browser = await H.launch();
  await browser.defaultBrowserContext().overridePermissions(srv.url, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);

  if (mode === 'host') {
    const page = await openPanel(browser, { config: { ...READY, sync: true, party: { rewardId: 'rwq', batch: 1, show: 5 } }, party: DEMO });
    const cfg = await H.readKey(page, 'tw.config');
    console.log(`OBS_URL ${LIVE}queue.html?${new URLSearchParams({ room: cfg.room, key: cfg.secret })}`);
    await sleep(20 * 60 * 1000);
    await browser.close(); srv.server.close(); return;
  }

  // ---------- build ----------
  const obs = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  fs.rmSync(FRAMES, { recursive: true, force: true }); fs.mkdirSync(FRAMES, { recursive: true });
  const frames = [];
  const TOTAL = 4 + obs.length + 4;
  let no = 0;
  const shotTo = async (page, cap, sel, dur) => {
    await page.evaluate(() => document.querySelector('#toast')?.classList.remove('show')); await sleep(400); // 畫面上的提示收起來，免得被字幕列擋一半
    no += 1; await caption(page, cap, sel, no, TOTAL);
    const file = path.join(FRAMES, `${String(frames.length + 1).padStart(2, '0')}.png`);
    await page.screenshot({ path: file }); await clearCap(page);
    frames.push({ file, cap, dur: dur || Math.max(4.5, 3.5 + cap.length / 12) });
  };
  const cardPage = await browser.newPage(); await cardPage.setViewport({ width: W, height: HGT, deviceScaleFactor: DPR });
  const c0 = path.join(FRAMES, '00.png'); await card(cardPage, c0, '排隊陪玩 設定教學', '觀眾兌換忠誠點排隊，你按「下一輪」叫人。約 1 分半'); frames.push({ file: c0, cap: '排隊陪玩 設定教學', dur: 3.5 });

  // OBS 截圖裡的排隊名單換成示範資料（patchQueue：名單來源在螢幕上的位置），不放真的觀眾名字。要在主控制面板開之前做：同一個瀏覽器只允許一個控制面板運作
  for (const f of obs.filter((x) => x.patchQueue)) {
    const host = await openPanel(browser, { config: { ...READY, sync: false, party: { rewardId: 'rwq', batch: 1, show: 5 } }, party: DEMO });
    const cfgQ = await H.readKey(host, 'tw.config');
    const qv = await browser.newPage(); await qv.setViewport({ width: 400, height: 600, deviceScaleFactor: 1 });
    await qv.goto(`${H.srvUrl}/queue.html?room=${cfgQ.room}&key=${cfgQ.secret}&sync=0`, { waitUntil: 'networkidle0' });
    await qv.waitForSelector('#card:not(.hidden)'); await sleep(800);
    await qv.evaluate(() => { document.body.style.background = '#000'; });
    const q = (await qv.screenshot({ encoding: 'base64' }));
    await qv.close(); await host.close();
    const [x0, y0, x1] = f.crop; const [a, b2, c, d] = f.patchQueue;
    f.dataUrl = await cardPage.evaluate(async ({ src, q, x0, y0, x1, a, b2, c, d }) => {
      const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
      const base = await load(src); const top = await load(`data:image/png;base64,${q}`);
      const k = base.width / (x1 - x0);
      const cv = document.createElement('canvas'); cv.width = base.width; cv.height = base.height;
      const g = cv.getContext('2d'); g.drawImage(base, 0, 0); g.drawImage(top, (a - x0) * k, (b2 - y0) * k, (c - a) * k, (d - b2) * k);
      return cv.toDataURL('image/jpeg', 0.95);
    }, { src: `data:image/jpeg;base64,${fs.readFileSync(f.file).toString('base64')}`, q, x0, y0, x1, a, b2, c, d });
    fs.writeFileSync(f.file, Buffer.from(f.dataUrl.split(',')[1], 'base64')); // 存回原檔：專案裡只留示範名字
  }

  // 1～4：設定步驟 8
  const page = await openPanel(browser, { config: { ...READY, sync: false }, party: null, mockParty: false });
  await page.bringToFront(); await page.click('#toSetup'); await sleep(400);
  await shotTo(page, '打開忠誠點轉盤，按右上角「設定」，點上方的「8 排隊陪玩」頁籤', '#setupTabs [data-tab="8"]');
  await page.click('#setupTabs [data-tab="8"]'); await sleep(300);
  await page.$eval('#partyRewardTitle', (e) => { e.value = '排隊陪玩'; }); await page.$eval('#partyRewardCost', (e) => { e.value = '1000'; });
  await shotTo(page, '品項名稱、要花多少忠誠點照自己的需要填，按「建立品項」', '#createPartyReward');
  await page.click('#createPartyReward'); await page.waitForFunction(() => document.querySelector('#partyReward').value !== ''); await sleep(800);
  await page.evaluate(() => document.querySelector('#toast')?.classList.remove('show'));
  await shotTo(page, '建立好了：Twitch 上多了這個品項，「用哪個品項排隊」也自動選好', '#partyReward');
  await shotTo(page, '按「複製「排隊名單」網址」，接著到 OBS 貼上', '#copyPartyObs');

  // 5～：OBS 實際畫面
  for (const f of obs) {
    no += 1; const file = path.join(FRAMES, `${String(frames.length + 1).padStart(2, '0')}.png`);
    await cardPage.bringToFront(); await obsFrame(cardPage, file, f, no, TOTAL);
    frames.push({ file, cap: f.caption, dur: f.dur || Math.max(4.5, 3.5 + f.caption.length / 12) });
  }

  // 直播時：觀眾兌換、下一輪、暫停
  await page.bringToFront();
  await page.click('#toLive'); await sleep(400);
  const rid = (await H.readKey(page, 'tw.config')).party.rewardId;
  for (const [id, login, name, input] of [['v1', 'xiaoming', '小明', 'Ming#1234'], ['v2', 'xiaomei', '小美', 'Mei#22'], ['v3', 'azhe_tw', '阿哲', 'Zhe#8']]) {
    await page.evaluate((ev) => window.__tw.redeem(ev), { id, user_login: login, user_name: name, user_id: `u${login}`, user_input: input, reward: { id: rid, title: '排隊陪玩' } });
    await sleep(300);
  }
  await sleep(4500); // 等「加入排隊」提示消失
  await shotTo(page, '直播時：觀眾兌換「排隊陪玩」，就會照順序出現在右邊的排隊名單', '#partyBox');
  await shotTo(page, '要開始玩了，按「下一輪」，排最前面的人就會上場', '#partyNext');
  await page.click('#partyNext'); await sleep(4500);
  await shotTo(page, '「正在玩」換成小明。玩完再按一次「下一輪」換下一位；只讓一位下場按「完成」', '#partyPlaying');
  await shotTo(page, '人數夠了按「暫停排隊」，觀眾就暫時不能兌換。重複排、隊伍滿了會自動退點', '#partyPause');
  const c9 = path.join(FRAMES, '99.png'); await cardPage.bringToFront(); await card(cardPage, c9, '設定完成！', '更多說明請看說明書第 11 章「排隊陪玩」'); frames.push({ file: c9, cap: '設定完成！更多說明請看說明書第 11 章', dur: 3.5 });
  await browser.close(); srv.server.close();

  // 字幕＋影片
  let t = 0; const ts = (s) => { const ms = Math.round(s * 1000); const p = (n, w = 2) => String(n).padStart(w, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
  fs.writeFileSync(`${OUT}.srt`, frames.map((f, i) => { const s = `${i + 1}\n${ts(t)} --> ${ts(t + f.dur)}\n${f.cap}\n`; t += f.dur; return s; }).join('\n'));
  const list = path.join(FRAMES, 'list.txt');
  const esc = (p) => p.replace(/\\/g, '/').replace(/'/g, "'\\''");
  fs.writeFileSync(list, frames.map((f) => `file '${esc(f.file)}'\nduration ${f.dur.toFixed(2)}`).join('\n') + `\nfile '${esc(frames.at(-1).file)}'\n`);
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', `scale=${W * DPR}:${HGT * DPR},fps=30,format=yuv420p`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-movflags', '+faststart', `${OUT}.mp4`]);
  console.log(`${OUT}.mp4（${Math.round(t)} 秒，${frames.length} 個畫面）`);
})().catch((e) => { console.error(e); process.exit(1); });
