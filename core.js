/* 純邏輯：設定正規化、機率、建議機率、抽獎、保底、庫存異動。不碰 DOM，瀏覽器與 Node 都能用（Node 端用來跑測試） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LuckyCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const PALETTE = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#ff8fab', '#c77dff', '#48cae4', '#ffb703', '#8ac926', '#f15bb5', '#00b4d8', '#f4a261'];
  const cryptoObj = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;

  const pad = (n) => String(n).padStart(2, '0');
  const formatTime = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const randId = (n = 6) => { const a = new Uint8Array(n); cryptoObj.getRandomValues(a); return Array.from(a, (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join(''); };
  const rand = () => { const a = new Uint32Array(1); cryptoObj.getRandomValues(a); return a[0] / 4294967296; };

  const DEFAULT_CONFIG = {
    title: '幸運轉盤', segmentMode: 'weight', spinDuration: 5000, multiSpinDuration: 1500, turns: 6, sound: true, volume: 70, countdown: 3,
    limitPerPlayer: 0, limitPeriod: 'all',
    overlayResultSeconds: 8, multiMode: 'flip', minSlice: 4, bg3d: true, theme: 'light', themeChosen: false,
    overlaySize: 520, overlaySpinOnly: false, overlayMute: false, overlayHideStatus: false,
    overlayList: false, overlayListProb: true, overlayListStock: true, overlayListPos: 'tl',
    pityAccum: false, pityAccumN: 30, pityBatch: false, pityBatchK: 10, pityScope: 'player', room: '', secret: '', sync: false, broker: 'wss://broker.emqx.io:8084/mqtt',
    prizes: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `p${n}`, name: `獎項 ${n}`, weight: 10, quantity: -1, remaining: -1, image: '', color: PALETTE[(n - 1) % PALETTE.length] })),
  };

  // ---------- 設定正規化：任何來源（舊版、匯入、手改）的資料都經過這裡 ----------
  function normalizePrize(p, i) {
    p = p || {};
    const rawQty = p.quantity === '' || p.quantity == null ? -1 : Number(p.quantity);
    const quantity = Number.isFinite(rawQty) ? Math.max(-1, Math.trunc(rawQty)) : -1;
    let remaining = p.remaining == null || p.remaining === '' ? quantity : Math.trunc(Number(p.remaining));
    if (quantity === -1) remaining = -1;
    else remaining = Math.min(Math.max(0, Number.isFinite(remaining) ? remaining : quantity), quantity);
    return {
      id: String(p.id || `p_${randId(8)}`), name: String(p.name || `獎項 ${i + 1}`).slice(0, 60),
      weight: Math.max(0, Number(p.weight) || 0), quantity, remaining,
      image: String(p.image || ''), color: /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : '',
      pity: p.pity === true,
      tier: ['auto', 'big', 'normal', 'miss'].includes(p.tier) ? p.tier : 'auto', // 特效等級
    };
  }
  function normalizeConfig(c) {
    const cfg = { ...DEFAULT_CONFIG, ...(c || {}) };
    cfg.title = String(cfg.title || DEFAULT_CONFIG.title).slice(0, 40);
    cfg.segmentMode = cfg.segmentMode === 'equal' ? 'equal' : 'weight';
    cfg.spinDuration = Math.min(30000, Math.max(500, Number(cfg.spinDuration) || 5000));
    cfg.multiSpinDuration = Math.min(30000, Math.max(300, Number(cfg.multiSpinDuration) || 1500));
    cfg.turns = Math.min(20, Math.max(1, Math.trunc(Number(cfg.turns)) || 6));
    cfg.countdown = Math.min(10, Math.max(0, Number.isFinite(Number(cfg.countdown)) ? Math.trunc(Number(cfg.countdown)) : 3));
    cfg.volume = Math.min(100, Math.max(0, Number.isFinite(Number(cfg.volume)) ? Math.round(Number(cfg.volume)) : 70));
    cfg.limitPerPlayer = Math.min(1000, Math.max(0, Math.trunc(Number(cfg.limitPerPlayer)) || 0));
    cfg.limitPeriod = cfg.limitPeriod === 'day' ? 'day' : 'all';
    cfg.sound = cfg.sound !== false;
    cfg.sync = cfg.sync === true;
    cfg.overlayResultSeconds = Math.min(120, Math.max(1, Number(cfg.overlayResultSeconds) || 8));
    cfg.multiMode = cfg.multiMode === 'each' ? 'each' : 'flip';
    cfg.minSlice = Math.min(20, Math.max(0, Number(cfg.minSlice) || 0));
    cfg.bg3d = cfg.bg3d !== false;
    cfg.themeChosen = cfg.themeChosen === true;
    cfg.overlaySize = Math.min(2000, Math.max(200, Math.trunc(Number(cfg.overlaySize)) || 520));
    cfg.overlaySpinOnly = cfg.overlaySpinOnly === true; cfg.overlayMute = cfg.overlayMute === true; cfg.overlayHideStatus = cfg.overlayHideStatus === true;
    cfg.overlayList = cfg.overlayList === true; cfg.overlayListProb = cfg.overlayListProb !== false; cfg.overlayListStock = cfg.overlayListStock !== false;
    cfg.overlayListPos = ['tl', 'tr', 'c'].includes(cfg.overlayListPos) ? cfg.overlayListPos : 'tl';
    cfg.theme = cfg.themeChosen ? (cfg.theme === 'dark' ? 'dark' : 'light') : 'light';
    cfg.pityAccum = cfg.pityAccum === true;
    cfg.pityAccumN = Math.min(1000, Math.max(1, Math.trunc(Number(cfg.pityAccumN)) || 30));
    cfg.pityBatch = cfg.pityBatch === true;
    cfg.pityBatchK = Math.min(100, Math.max(2, Math.trunc(Number(cfg.pityBatchK)) || 10));
    cfg.pityScope = cfg.pityScope === 'global' ? 'global' : 'player';
    cfg.room = String(cfg.room || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || randId();
    cfg.secret = String(cfg.secret || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40) || randId(20); // 同步訊息簽章用，只出現在 OBS 網址裡
    cfg.broker = /^wss?:\/\//.test(cfg.broker || '') ? cfg.broker : DEFAULT_CONFIG.broker;
    cfg.prizes = Array.isArray(cfg.prizes) ? cfg.prizes.map(normalizePrize) : [];
    return cfg;
  }

  // ---------- 機率 ----------
  const pool = (prizes) => prizes.filter((p) => p.weight > 0 && (p.remaining === -1 || p.remaining > 0));
  const pityPool = (prizes) => pool(prizes).filter((p) => p.pity);
  function probabilities(prizes) {
    const pl = pool(prizes); const total = pl.reduce((s, p) => s + p.weight, 0); const m = {};
    pl.forEach((p) => { m[p.id] = total ? (p.weight / total) * 100 : 0; });
    return m;
  }
  function drawOne(prizes, random = rand) {
    const pl = pool(prizes); if (!pl.length) return null;
    let r = random() * pl.reduce((s, p) => s + p.weight, 0);
    for (const p of pl) { r -= p.weight; if (r < 0) return p; }
    return pl[pl.length - 1];
  }

  // ---------- 建議機率：依「數量」反推每個獎項該給多少機率 ----------
  // 想法：預計總共抽 N 次，數量 q 的獎項機率設 q / N，平均剛好在第 N 抽左右送完（大獎數量少 → 機率自然低）。
  // 無限量的獎項（銘謝惠顧、小獎）分掉剩下的機率，比例照它們目前的權重。
  // 回傳 { draws, rows: [{ id, name, quantity, current, suggested, weight, every }], capped }
  function suggestWeights(prizes, expectedDraws) {
    const limited = prizes.filter((p) => p.quantity > 0);
    const unlimited = prizes.filter((p) => p.quantity === -1 && p.weight > 0);
    const stock = limited.reduce((s, p) => s + p.quantity, 0);
    let draws = Math.trunc(Number(expectedDraws)) || 0;
    if (draws < 1) draws = unlimited.length ? stock * 2 : stock; // 預設：有無限量獎就抓庫存的兩倍（一半機率槓龜），沒有就剛好抽完
    let capped = false;
    if (draws < stock) { draws = stock; capped = true; } // 抽數比庫存少，機率會超過 100%，退回剛好抽完
    const current = probabilities(prizes);
    const limitedShare = draws ? Math.min(1, stock / draws) : 0;
    const rest = 1 - limitedShare;
    const uw = unlimited.reduce((s, p) => s + p.weight, 0);
    const rows = prizes.map((p) => {
      let share = 0;
      if (p.quantity > 0) share = draws ? p.quantity / draws : 0;
      else if (p.quantity === -1 && p.weight > 0 && uw > 0) share = rest * (p.weight / uw);
      const suggested = share * 100;
      const weight = suggested > 0 ? Math.max(0.01, Math.round(suggested * 100) / 100) : 0;
      return { id: p.id, name: p.name, quantity: p.quantity, current: current[p.id] == null ? 0 : current[p.id], suggested, weight, every: share > 0 ? 1 / share : 0 };
    });
    return { draws: draws || 0, stock, rows, capped };
  }

  // ---------- 保底：從紀錄反推「距上次抽中保底獎已經幾抽」，撤銷後自動正確 ----------
  function drawsSinceHit(records, cfg, player) {
    const key = cfg.pityScope === 'global' ? null : (player || '');
    let n = 0;
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (r.void) continue; // 被補抽作廢的不算
      if (key !== null && (r.player || '') !== key) continue;
      if (r.hit) break;
      n++;
    }
    return n;
  }

  // ---------- 抽一批：會直接扣 cfg.prizes 的庫存；回傳結果與要寫進紀錄的列 ----------
  function drawBatch({ cfg, records, count: countRaw, player = '', now = new Date(), random = rand }) {
    const count = Math.min(100, Math.max(1, Math.trunc(Number(countRaw)) || 1));
    const batchId = `${formatTime(now).replace(/[-: ]/g, '')}-${randId(4)}`;
    const type = count === 1 ? '單抽' : `${count}連抽`;
    const results = [];
    let since = drawsSinceHit(records, cfg, player);
    let hitsInBatch = 0;
    const guaranteed = cfg.pityBatch && count >= cfg.pityBatchK ? Math.floor(count / cfg.pityBatchK) : 0;
    for (let i = 0; i < count; i++) {
      const probs = probabilities(cfg.prizes);
      let forced = false;
      if (cfg.pityAccum && since >= cfg.pityAccumN) forced = true;
      if (guaranteed) { const needed = guaranteed - hitsInBatch; if (needed > 0 && needed >= count - i) forced = true; }
      let p = forced ? drawOne(pityPool(cfg.prizes), random) : null;
      if (!p) { forced = false; p = drawOne(cfg.prizes, random); }
      if (!p) break;
      if (p.remaining > 0) p.remaining -= 1;
      const hit = !!p.pity;
      if (hit) { since = 0; hitsInBatch++; } else since++;
      const probability = Math.round(probs[p.id] * 100) / 100;
      results.push({ rid: randId(8), index: i + 1, prizeId: p.id, name: p.name, image: p.image, color: p.color, remaining: p.remaining, probability, pity: forced, hit, tier: tierOf(p, probs[p.id]) });
    }
    const time = formatTime(now);
    const recs = results.map((r) => ({ rid: r.rid, time, batchId, type, index: r.index, player, prize: r.name, prizeId: r.prizeId, remaining: r.remaining, probability: r.probability, pity: r.pity, hit: r.hit }));
    return { batchId, type, count, results, recs, time };
  }

  // ---------- 同步訊息簽章（HMAC-SHA256）：公開 MQTT 誰都能監聽 / 發送，靠簽章擋掉假訊息 ----------
  const SIG_WINDOW_MS = 5 * 60 * 1000;
  const enc = (s) => new TextEncoder().encode(s);
  async function hmacKey(secret) { return cryptoObj.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  function sortKeys(v) { if (Array.isArray(v)) return v.map(sortKeys); if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => { o[k] = sortKeys(v[k]); return o; }, {}); return v; }
  function canonical(msg) { const { sig, ...rest } = msg; void sig; return JSON.stringify(sortKeys(rest)); }
  async function signMessage(secret, msg) {
    const body = { ...msg, ts: msg.ts || Date.now() };
    const sig = hex(await cryptoObj.subtle.sign('HMAC', await hmacKey(secret), enc(canonical(body))));
    return { ...body, sig };
  }
  async function verifyMessage(secret, msg, now = Date.now()) {
    if (!msg || typeof msg.sig !== 'string' || typeof msg.ts !== 'number') return false;
    if (Math.abs(now - msg.ts) > SIG_WINDOW_MS) return false;
    const expected = hex(await cryptoObj.subtle.sign('HMAC', await hmacKey(secret), enc(canonical(msg))));
    if (expected.length !== msg.sig.length) return false;
    let diff = 0; for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ msg.sig.charCodeAt(i);
    return diff === 0;
  }

  // ---------- 特效等級：大獎 / 一般 / 銘謝惠顧。auto = 機率 < 5% 或勾保底算大獎，名字像「銘謝惠顧」算落空 ----------
  const MISS_RE = /銘謝|謝謝|再接再厲|沒中|槓龜|落空|安慰|下次|thanks|miss/i;
  function tierOf(prize, probability) {
    if (prize.tier && prize.tier !== 'auto') return prize.tier;
    if (MISS_RE.test(prize.name || '')) return 'miss';
    if (prize.pity || (probability != null && probability < 5)) return 'big';
    return 'normal';
  }
  // 一批的整體反應：有任何大獎就大獎；全部落空就落空；其他一般
  function batchTier(results) {
    if (!results.length) return 'normal';
    if (results.some((r) => r.tier === 'big')) return 'big';
    if (results.every((r) => r.tier === 'miss')) return 'miss';
    return 'normal';
  }

  // ---------- 每人限抽：某人已經抽了幾次（作廢不算；每天重置時只算今天） ----------
  function drawsUsed(records, player, period = 'all', now = new Date()) {
    const name = (player || '').trim();
    if (!name) return 0; // 沒填名字無法辨識，不限制
    const today = formatTime(now).slice(0, 10);
    return records.filter((r) => !r.void && (r.player || '').trim() === name && (period !== 'day' || String(r.time || '').slice(0, 10) === today)).length;
  }

  // ---------- 名單 → 獎項：一行一個名字，去重去空白，每人數量 1、權重相同 ----------
  function prizesFromNames(text, { weight = 1 } = {}) {
    const seen = new Set(); const out = [];
    String(text || '').split(/\r?\n|,|，|、/).map((s) => s.trim()).filter(Boolean).forEach((name, i) => {
      if (seen.has(name)) return; seen.add(name);
      out.push({ id: `n_${randId(8)}`, name: name.slice(0, 60), weight, quantity: 1, remaining: 1, image: '', color: PALETTE[i % PALETTE.length], pity: false });
    });
    return out;
  }

  // ---------- 庫存異動紀錄：抽獎以外的庫存變化（手改、重置、匯入、新增 / 刪除獎項）都留下痕跡 ----------
  // 用法：動之前先 stockSnapshot(prizes)，動完 diffStock(before, prizes, {...}) 取得要寫進紀錄的列。
  // 只比對數量與剩餘，改名 / 改權重不算庫存異動。
  const stockSnapshot = (prizes) => (prizes || []).map((p) => ({ id: p.id, name: p.name, quantity: p.quantity, remaining: p.remaining }));
  function diffStock(before, prizes, { reason = '手動修改', now = new Date() } = {}) {
    const time = formatTime(now);
    const was = new Map((before || []).map((p) => [p.id, p]));
    const out = [];
    (prizes || []).forEach((p) => {
      const b = was.get(p.id);
      was.delete(p.id);
      if (!b) { out.push({ time, reason, kind: 'add', prizeId: p.id, prize: p.name, qtyFrom: null, qtyTo: p.quantity, remFrom: null, remTo: p.remaining }); return; }
      if (b.quantity === p.quantity && b.remaining === p.remaining) return;
      out.push({ time, reason, kind: 'change', prizeId: p.id, prize: p.name, qtyFrom: b.quantity, qtyTo: p.quantity, remFrom: b.remaining, remTo: p.remaining });
    });
    was.forEach((b) => out.push({ time, reason, kind: 'remove', prizeId: b.id, prize: b.name, qtyFrom: b.quantity, qtyTo: null, remFrom: b.remaining, remTo: null }));
    return out;
  }
  // 供畫面與 Excel 共用：一般數字就回數字（Excel 裡才排得了序、加得了總），-1 是「無限」、null 是「不存在」
  const stockNum = (v) => (v === null || v === undefined ? '—' : v === -1 ? '無限' : Number(v));
  function stockDelta(e) {
    if (e.kind === 'add') return '新增獎項';
    if (e.kind === 'remove') return '刪除獎項';
    if (typeof e.remFrom !== 'number' || typeof e.remTo !== 'number' || e.remFrom === -1 || e.remTo === -1) return '';
    const d = e.remTo - e.remFrom;
    return d === 0 ? '' : `${d > 0 ? '+' : ''}${d}`;
  }

  // ---------- 撤銷一批：把庫存加回去，回傳移除後的紀錄 ----------
  function undoBatch(records, prizes, batchId) {
    const batch = records.filter((r) => r.batchId === batchId);
    // 已作廢（被補抽）的那筆庫存早就加回去了，不能再加一次
    batch.filter((r) => !r.void).forEach((r) => { const p = prizes.find((x) => x.id === r.prizeId); if (p && p.quantity !== -1) p.remaining = Math.min(p.quantity, p.remaining + 1); });
    return { batch, records: records.filter((r) => r.batchId !== batchId) };
  }

  // ---------- 補抽：把某一抽作廢（留紀錄、庫存加回），再用同樣的人 / 批次 / 第幾抽重抽一次 ----------
  const recordKey = (r) => r.rid || `${r.batchId}-${r.index}`; // 舊紀錄沒有 rid
  function redraw({ cfg, records, key, now = new Date(), random = rand }) {
    const target = records.find((r) => recordKey(r) === key);
    if (!target) throw new Error('找不到這筆紀錄');
    if (target.void) throw new Error('這筆已經作廢，請對補抽後的那筆操作');
    target.void = true;
    target.note = `被補抽取代`;
    const p = cfg.prizes.find((x) => x.id === target.prizeId);
    if (p && p.quantity !== -1) p.remaining = Math.min(p.quantity, p.remaining + 1);
    const out = drawBatch({ cfg, records, count: 1, player: target.player || '', now, random });
    const label = `補抽第 ${target.index} 抽`;
    out.results.forEach((r) => { r.index = target.index; r.redrawOf = key; });
    out.recs.forEach((r) => { r.batchId = target.batchId; r.type = '補抽'; r.index = target.index; r.redrawOf = key; r.note = label; });
    return { ...out, batchId: target.batchId, type: '補抽', label, voided: target };
  }

  return { PALETTE, DEFAULT_CONFIG, formatTime, randId, rand, normalizePrize, normalizeConfig, pool, pityPool, probabilities, drawOne, suggestWeights, drawsSinceHit, drawsUsed, prizesFromNames, tierOf, batchTier, drawBatch, undoBatch, stockSnapshot, diffStock, stockNum, stockDelta, recordKey, redraw, signMessage, verifyMessage, SIG_WINDOW_MS };
});
