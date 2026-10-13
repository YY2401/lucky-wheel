/* 忠誠點轉盤的純邏輯：設定正規化、觀眾名稱、直播日、紀錄。不碰 DOM，瀏覽器與 Node 共用 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.TwitchCore = factory(root.LuckyCore);
})(typeof self !== 'undefined' ? self : this, function (LuckyCore) {
  const { PALETTE, randId } = LuckyCore;

  // 試算表每天底下的欄名（照原本的試算表）
  const SHEET_COLUMNS = ['1點', '3點', '5點', 'Q版塗鴉', '正比塗鴉', '模板貼圖', '舔舔貼圖', '自選品項'];

  const DEFAULT_PRIZES = [
    { id: 'pt1', name: '1點', weight: 50, column: '1點', color: PALETTE[3] },
    { id: 'pt3', name: '3點', weight: 30, column: '3點', color: PALETTE[2] },
    { id: 'pt5', name: '5點', weight: 20, column: '5點', color: PALETTE[1] },
  ];

  const DEFAULT_TW = {
    clientId: '', // 留空用網頁內建的 Twitch Client ID
    rewardIds: [], // 觸發轉盤的忠誠點品項
    scriptUrl: '', // Apps Script 網頁應用程式網址
    sheetOk: '', // 最後一次「測試連線」成功的網址
    sheetKey: '', // 寫進 Apps Script 的暗號
    cutoffHour: 0, // 凌晨幾點以前算前一天（跨夜直播用）
    prizes: DEFAULT_PRIZES,
    spinDuration: 5000, turns: 6, resultSeconds: 6, sound: true, volume: 70, theme: 'light',
    room: '', secret: '', sync: true, broker: 'wss://broker.emqx.io:8084/mqtt',
    setupDone: false,
  };

  const clampInt = (v, lo, hi, fb) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb; };

  function normalizeTwPrize(p, i) {
    p = p || {};
    const name = String(p.name || '').trim().slice(0, 30) || `獎項 ${i + 1}`;
    return {
      id: String(p.id || `tp_${randId(8)}`),
      name,
      weight: Math.max(0, Number(p.weight) || 0),
      column: String(p.column == null ? name : p.column).trim().slice(0, 30),
      color: /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : PALETTE[i % PALETTE.length],
    };
  }

  function normalizeTwConfig(c) {
    const cfg = { ...DEFAULT_TW, ...(c || {}) };
    cfg.clientId = String(cfg.clientId || '').replace(/[^a-z0-9]/gi, '').slice(0, 64);
    cfg.rewardIds = Array.isArray(cfg.rewardIds) ? [...new Set(cfg.rewardIds.map(String).filter(Boolean))].slice(0, 20) : [];
    cfg.scriptUrl = /^https:\/\/script\.google(usercontent)?\.com\//.test(String(cfg.scriptUrl || '').trim()) ? String(cfg.scriptUrl).trim() : '';
    cfg.sheetKey = String(cfg.sheetKey || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40) || randId(16);
    cfg.cutoffHour = clampInt(cfg.cutoffHour, 0, 12, 0);
    cfg.prizes = (Array.isArray(cfg.prizes) && cfg.prizes.length ? cfg.prizes : DEFAULT_PRIZES).map(normalizeTwPrize);
    cfg.spinDuration = clampInt(cfg.spinDuration, 1000, 20000, 5000);
    cfg.turns = clampInt(cfg.turns, 1, 20, 6);
    cfg.resultSeconds = clampInt(cfg.resultSeconds, 1, 60, 6);
    cfg.sound = cfg.sound !== false;
    cfg.volume = clampInt(cfg.volume, 0, 100, 70);
    cfg.theme = cfg.theme === 'dark' ? 'dark' : 'light';
    cfg.room = String(cfg.room || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || `tw${randId(6)}`;
    cfg.secret = String(cfg.secret || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40) || randId(20);
    cfg.sync = cfg.sync !== false;
    cfg.broker = /^wss?:\/\//.test(cfg.broker || '') ? cfg.broker : DEFAULT_TW.broker;
    cfg.setupDone = cfg.setupDone === true;
    return cfg;
  }

  // 「嘎唄(gabai)」→ { display: '嘎唄', login: 'gabai' }；「gabai」→ { display: 'gabai', login: '' }
  // 與 sheet-script.gs 的 parseViewer_ 同一套規則
  function parseViewer(s) {
    s = String(s == null ? '' : s).trim().replace(/[:：\s]+$/, '');
    const m = s.match(/^(.*?)\s*[(（]\s*([^()（）]*?)\s*[)）]$/);
    if (m && m[2]) return { display: m[1].trim(), login: m[2].toLowerCase() };
    return { display: s, login: '' };
  }

  // 直播日：凌晨 cutoffHour 點以前算前一天。回傳 'YYYY-MM-DD'（本機時間）
  function dayKey(date, cutoffHour = 0) {
    const d = new Date(date.getTime() - cutoffHour * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // 一筆轉盤紀錄。id 用 Twitch 兌換編號（同一筆兌換不會轉兩次、不會寫兩次）
  // rewardId 有值＝來自 Twitch 兌換：先在 Twitch 保持「未完成」HOLD_MS（這段時間撤銷可退點），之後自動標成已完成
  function makeRecord({ id, login = '', display = '', reward = '', rewardId = '', prize, now = new Date(), cutoffHour = 0, test = false, processedAt = Date.now() }) {
    return {
      id: String(id || `m-${randId(10)}`),
      time: now.toISOString(),
      date: dayKey(now, cutoffHour),
      login: String(login).toLowerCase(), display: String(display || login),
      reward: String(reward || ''),
      prizeId: prize.id, prize: prize.name, column: prize.column, color: prize.color,
      status: test ? 'test' : 'pending', // pending 待寫入 / ok 已寫入 / error 失敗 / undoing 撤銷中 / undone 已撤銷 / test 測試不寫入
      cell: '', error: '', attempts: 0,
      rewardId: String(rewardId || ''),
      tw: rewardId && !test ? 'hold' : '', // hold 可退點期 / fulfilled 已完成 / to-cancel 退點中 / canceled 已退點 / cancel-failed 退點失敗
      holdUntil: rewardId && !test ? processedAt + HOLD_MS : 0,
    };
  }

  // ---------- Twitch 兌換狀態 ----------
  // Twitch 規定：兌換標成「已完成」後就不能退點，所以先保留一段可退點期
  const HOLD_MS = 24 * 3600 * 1000;
  const TW_CHUNK = 50; // Twitch 一次最多改 50 筆

  // 該送給 Twitch 的狀態更新：[{ rewardId, status: 'FULFILLED' | 'CANCELED', ids }]
  function dueTwitchUpdates(records, now = Date.now()) {
    const groups = new Map();
    for (const r of records) {
      let status = null;
      if (r.tw === 'hold' && r.holdUntil && now >= r.holdUntil) status = 'FULFILLED';
      else if (r.tw === 'to-cancel') status = 'CANCELED';
      if (!status || !r.rewardId) continue;
      const k = `${r.rewardId}|${status}`;
      if (!groups.has(k)) groups.set(k, { rewardId: r.rewardId, status, ids: [] });
      groups.get(k).ids.push(r.id);
    }
    const out = [];
    for (const g of groups.values()) for (let i = 0; i < g.ids.length; i += TW_CHUNK) out.push({ ...g, ids: g.ids.slice(i, i + TW_CHUNK) });
    return out;
  }
  // 下一次要醒來處理「可退點期滿」的時間（沒有就回 0）
  const nextHoldExpiry = (records) => records.reduce((m, r) => (r.tw === 'hold' && r.holdUntil && (!m || r.holdUntil < m) ? r.holdUntil : m), 0);

  // Twitch 上還是「未完成」、但這個網頁沒有處理過的兌換＝網頁關著時漏掉的
  function missedRedemptions(redemptions, knownIds) {
    const known = new Set(knownIds);
    const seen = new Set();
    return redemptions.filter((x) => x && x.id && !known.has(x.id) && !seen.has(x.id) && seen.add(x.id))
      .map((x) => ({ id: x.id, login: x.user_login || '', display: x.user_name || x.user_login || '', reward: (x.reward && x.reward.title) || '', rewardId: (x.reward && x.reward.id) || '', at: x.redeemed_at || new Date().toISOString() }))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }

  // 要送給 Apps Script 的欄位（不送顏色等用不到的）
  const forSheet = (r) => ({ id: r.id, date: r.date, login: r.login, display: r.display, column: r.column });

  // 名單中顯示用
  const viewerLabel = (r) => (r.display && r.login && r.display.toLowerCase() !== r.login ? `${r.display}(${r.login})` : r.display || r.login || '匿名');

  // 只有原始碼裡的 '__KEY__' 會被換掉
  const scriptWithKey = (src, key) => String(src).replace("const KEY = '__KEY__';", `const KEY = '${key}';`);

  return { SHEET_COLUMNS, DEFAULT_PRIZES, DEFAULT_TW, HOLD_MS, normalizeTwPrize, normalizeTwConfig, parseViewer, dayKey, makeRecord, forSheet, viewerLabel, scriptWithKey, dueTwitchUpdates, nextHoldExpiry, missedRedemptions };
});
