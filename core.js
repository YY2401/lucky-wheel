/* 純邏輯：設定正規化、機率、抽獎、保底。不碰 DOM，瀏覽器與 Node 都能用（Node 端用來跑測試） */
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
    title: '幸運轉盤', segmentMode: 'weight', spinDuration: 5000, multiSpinDuration: 1500, turns: 6, sound: true,
    overlayResultSeconds: 8, multiMode: 'flip', minSlice: 4, bg3d: true, theme: 'light', themeChosen: false,
    overlaySize: 520, overlaySpinOnly: false, overlayMute: false, overlayHideStatus: false,
    overlayList: false, overlayListProb: true, overlayListStock: true,
    pityAccum: false, pityAccumN: 30, pityBatch: false, pityBatchK: 10, pityScope: 'player', room: '', sync: false, broker: 'wss://broker.emqx.io:8084/mqtt',
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
    };
  }
  function normalizeConfig(c) {
    const cfg = { ...DEFAULT_CONFIG, ...(c || {}) };
    cfg.title = String(cfg.title || DEFAULT_CONFIG.title).slice(0, 40);
    cfg.segmentMode = cfg.segmentMode === 'equal' ? 'equal' : 'weight';
    cfg.spinDuration = Math.min(30000, Math.max(500, Number(cfg.spinDuration) || 5000));
    cfg.multiSpinDuration = Math.min(30000, Math.max(300, Number(cfg.multiSpinDuration) || 1500));
    cfg.turns = Math.min(20, Math.max(1, Math.trunc(Number(cfg.turns)) || 6));
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
    cfg.theme = cfg.themeChosen ? (cfg.theme === 'dark' ? 'dark' : 'light') : 'light';
    cfg.pityAccum = cfg.pityAccum === true;
    cfg.pityAccumN = Math.min(1000, Math.max(1, Math.trunc(Number(cfg.pityAccumN)) || 30));
    cfg.pityBatch = cfg.pityBatch === true;
    cfg.pityBatchK = Math.min(100, Math.max(2, Math.trunc(Number(cfg.pityBatchK)) || 10));
    cfg.pityScope = cfg.pityScope === 'global' ? 'global' : 'player';
    cfg.room = String(cfg.room || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || randId();
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

  // ---------- 保底：從紀錄反推「距上次抽中保底獎已經幾抽」，撤銷後自動正確 ----------
  function drawsSinceHit(records, cfg, player) {
    const key = cfg.pityScope === 'global' ? null : (player || '');
    let n = 0;
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
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
      results.push({ index: i + 1, prizeId: p.id, name: p.name, image: p.image, color: p.color, remaining: p.remaining, probability: Math.round(probs[p.id] * 100) / 100, pity: forced, hit });
    }
    const time = formatTime(now);
    const recs = results.map((r) => ({ time, batchId, type, index: r.index, player, prize: r.name, prizeId: r.prizeId, remaining: r.remaining, probability: r.probability, pity: r.pity, hit: r.hit }));
    return { batchId, type, count, results, recs, time };
  }

  // ---------- 撤銷一批：把庫存加回去，回傳移除後的紀錄 ----------
  function undoBatch(records, prizes, batchId) {
    const batch = records.filter((r) => r.batchId === batchId);
    batch.forEach((r) => { const p = prizes.find((x) => x.id === r.prizeId); if (p && p.quantity !== -1) p.remaining = Math.min(p.quantity, p.remaining + 1); });
    return { batch, records: records.filter((r) => r.batchId !== batchId) };
  }

  return { PALETTE, DEFAULT_CONFIG, formatTime, randId, rand, normalizePrize, normalizeConfig, pool, pityPool, probabilities, drawOne, drawsSinceHit, drawBatch, undoBatch };
});
