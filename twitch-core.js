/* 忠誠點轉盤的純邏輯：設定正規化、觀眾名稱、直播日、紀錄。不碰 DOM，瀏覽器與 Node 共用 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.TwitchCore = factory(root.LuckyCore);
})(typeof self !== 'undefined' ? self : this, function (LuckyCore) {
  const { PALETTE, randId } = LuckyCore;

  // 試算表每天底下的欄名（照原本的試算表）；還沒測試連線讀到實際欄名之前，選單先用這份
  const SHEET_COLUMNS = ['1點', '3點', '5點', 'Q版塗鴉', '正比塗鴉', '模板貼圖', '舔舔貼圖', '自選品項'];

  const DEFAULT_PRIZES = [
    { id: 'pt1', name: '1點', weight: 50, column: '1點', color: PALETTE[3] },
    { id: 'pt3', name: '3點', weight: 30, column: '3點', color: PALETTE[2] },
    { id: 'pt5', name: '5點', weight: 20, column: '5點', color: PALETTE[1] },
  ];

  // 第二個轉盤（給小奇點、訂閱用）：id 跟主轉盤不同，OBS 畫面才分得出是哪個轉盤
  const DEFAULT_PRIZES2 = [
    { id: 'b1', name: '1點', weight: 50, column: '1點', color: PALETTE[4] },
    { id: 'b3', name: '3點', weight: 30, column: '3點', color: PALETTE[5] },
    { id: 'b5', name: '5點', weight: 20, column: '5點', color: PALETTE[6] },
  ];

  // 小奇點、訂閱觸發轉盤的規則（每位實況主自己設定）
  const DEFAULT_TRIGGERS = {
    bits: { on: false, mode: 'per', per: 100, carry: true, tiers: [{ min: 100, spins: 1 }, { min: 500, spins: 6 }], wheel: 'main' },
    sub: { on: false, newSpins: 1, resubSpins: 1, t2: 1, t3: 1, gift: 'giver', wheel: 'main' },
    anon: 'name', // name：記在 anonName 底下 / skip：不轉
    anonName: '匿名',
    multi: 'flip', // 一次要轉好幾次時：flip 轉一次、翻牌揭曉全部 / each 每一次都轉
    maxSpins: 50, // 一筆最多轉幾次（避免一次贈送幾百份訂閱把轉盤卡住好幾個小時）
  };

  const DEFAULT_TW = {
    clientId: '', // 留空用網頁內建的 Twitch Client ID
    rewardIds: [], // 觸發轉盤的忠誠點品項
    scriptUrl: '', // Apps Script 網頁應用程式網址
    sheetOk: '', // 最後一次「測試連線」成功的網址
    sheetColumns: [], // 測試連線時從試算表讀到的欄名（每天底下那幾欄），給「寫到哪一欄」選單用
    sheetKey: '', // 寫進 Apps Script 的暗號
    cutoffHour: 0, // 凌晨幾點以前算前一天（跨夜直播用）
    prizes: DEFAULT_PRIZES,
    spinDuration: 5000, turns: 6, resultSeconds: 6, sound: true, volume: 70, theme: 'light',
    obsBgOpacity: 0, // OBS 畫面背景透明度（%）：0＝完全透明，100＝不透明
    room: '', secret: '', sync: true, broker: 'wss://broker.emqx.io:8084/mqtt',
    setupDone: false,
    movedToObs: false, // 設定已搬到 OBS 面板：這裡不再接收兌換（避免兩邊同時轉）
    importedIds: [], // 已經匯入過的搬家碼（OBS 每次重開都會帶同一個網址，不能重複匯入）
    triggers: DEFAULT_TRIGGERS,
    wheel2: { name: '斗內轉盤', prizes: DEFAULT_PRIZES2 },
    bitsCarry: {}, // 每位觀眾還沒湊滿一次的小奇點：{ 觀眾編號: 點數 }
    party: null, // 排隊陪玩（見 DEFAULT_PARTY）
    songs: null, // 小奇點點歌（見 DEFAULT_SONGS）
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
    cfg.obsBgOpacity = clampInt(cfg.obsBgOpacity, 0, 100, 0);
    cfg.room = String(cfg.room || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || `tw${randId(6)}`;
    cfg.secret = String(cfg.secret || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40) || randId(20);
    cfg.sync = cfg.sync !== false;
    cfg.broker = /^wss?:\/\//.test(cfg.broker || '') ? cfg.broker : DEFAULT_TW.broker;
    cfg.setupDone = cfg.setupDone === true;
    cfg.sheetColumns = Array.isArray(cfg.sheetColumns) ? [...new Set(cfg.sheetColumns.map((c) => String(c).trim()).filter(Boolean))].slice(0, 50) : [];
    cfg.movedToObs = cfg.movedToObs === true;
    cfg.importedIds = Array.isArray(cfg.importedIds) ? cfg.importedIds.map(String).slice(-20) : [];
    cfg.triggers = normalizeTriggers(cfg.triggers);
    cfg.party = normalizeParty(cfg.party);
    cfg.songs = normalizeSongs(cfg.songs);
    const w2 = cfg.wheel2 && typeof cfg.wheel2 === 'object' ? cfg.wheel2 : {};
    cfg.wheel2 = {
      name: String(w2.name || '').trim().slice(0, 20) || '斗內轉盤',
      prizes: (Array.isArray(w2.prizes) && w2.prizes.length ? w2.prizes : DEFAULT_PRIZES2).map((p, i) => normalizeTwPrize(p, i)),
    };
    // 兩個轉盤的格子 id 不能撞（OBS 畫面靠 id 分辨是哪個轉盤）
    const mainIds = new Set(cfg.prizes.map((p) => p.id));
    cfg.wheel2.prizes.forEach((p) => { if (mainIds.has(p.id)) p.id = `tp_${randId(8)}`; });
    const carry = cfg.bitsCarry && typeof cfg.bitsCarry === 'object' ? cfg.bitsCarry : {};
    cfg.bitsCarry = Object.fromEntries(Object.entries(carry).filter(([k, v]) => k && Number(v) > 0).slice(-500).map(([k, v]) => [k, Math.trunc(Number(v))]));
    return cfg;
  }

  function normalizeTriggers(t) {
    t = t && typeof t === 'object' ? t : {};
    const d = DEFAULT_TRIGGERS;
    const b = { ...d.bits, ...(t.bits || {}) };
    const s = { ...d.sub, ...(t.sub || {}) };
    const wheel = (w) => (w === 'bonus' ? 'bonus' : 'main');
    const tiers = (Array.isArray(b.tiers) ? b.tiers : d.bits.tiers)
      .map((x) => ({ min: clampInt(x && x.min, 1, 1000000, 0), spins: clampInt(x && x.spins, 0, 1000, 0) }))
      .filter((x) => x.min > 0).sort((x, y) => x.min - y.min).slice(0, 10);
    return {
      bits: { on: b.on === true, mode: b.mode === 'tiers' ? 'tiers' : 'per', per: clampInt(b.per, 1, 1000000, 100), carry: b.carry !== false, tiers, wheel: wheel(b.wheel) },
      sub: {
        on: s.on === true,
        newSpins: clampInt(s.newSpins, 0, 100, 1), resubSpins: clampInt(s.resubSpins, 0, 100, 1),
        t2: clampInt(s.t2, 1, 20, 1), t3: clampInt(s.t3, 1, 20, 1),
        gift: ['giver', 'receiver', 'none'].includes(s.gift) ? s.gift : 'giver',
        wheel: wheel(s.wheel),
      },
      anon: t.anon === 'skip' ? 'skip' : 'name',
      anonName: String(t.anonName || '').trim().slice(0, 25) || d.anonName,
      multi: t.multi === 'each' ? 'each' : 'flip',
      maxSpins: clampInt(t.maxSpins, 1, 200, d.maxSpins),
    };
  }

  // ---------- 小奇點、訂閱 → 轉幾次 ----------
  // 小奇點：per 模式每滿 per 點轉 1 次（carry＝零頭幫觀眾記著，下次加上去）；tiers 模式依達到的最高門檻轉固定次數
  function bitsSpins(bits, prevCarry, rule) {
    bits = Math.max(0, Math.trunc(Number(bits) || 0));
    if (rule.mode === 'tiers') {
      const hit = rule.tiers.filter((x) => bits >= x.min).pop();
      return { spins: hit ? hit.spins : 0, carry: 0 };
    }
    const total = bits + (rule.carry ? Math.max(0, Math.trunc(Number(prevCarry) || 0)) : 0);
    return { spins: Math.floor(total / rule.per), carry: rule.carry ? total % rule.per : 0 };
  }
  const TIER_NAME = { 1000: '層級一', 2000: '層級二', 3000: '層級三' }; // 跟 Twitch 中文介面同一套說法
  const tierMult = (tier, rule) => (String(tier) === '3000' ? rule.t3 : String(tier) === '2000' ? rule.t2 : 1);

  // Twitch EventSub 通知 → 要轉幾次、記給誰。不觸發回 null
  // 回傳 { source, spins, wheel, label, who: { login, display, userId }, carryKey?, carry? }
  function triggerSpins(type, ev, trig, carryMap = {}) {
    ev = ev || {};
    const named = !!ev.user_login && ev.is_anonymous !== true;
    let who = named ? { login: String(ev.user_login).toLowerCase(), display: ev.user_name || ev.user_login, userId: String(ev.user_id || '') } : null;
    if (!who) {
      if (trig.anon === 'skip') return null;
      who = { login: '', display: trig.anonName, userId: '' };
    }
    const tierName = TIER_NAME[ev.tier] || '層級一';
    let out;
    if (type === 'channel.cheer') {
      if (!trig.bits.on) return null;
      const key = named ? who.userId || who.login : ''; // 匿名的不幫忙累積（不知道是誰）
      const r = bitsSpins(ev.bits, key ? carryMap[key] : 0, key ? trig.bits : { ...trig.bits, carry: false });
      out = { source: 'bits', spins: r.spins, wheel: trig.bits.wheel, label: `小奇點 ${Number(ev.bits) || 0}` };
      if (key && trig.bits.mode === 'per' && trig.bits.carry) Object.assign(out, { carryKey: key, carry: r.carry });
    } else {
      const s = trig.sub;
      if (!s.on) return null;
      const m = tierMult(ev.tier, s);
      if (type === 'channel.subscribe') {
        if (ev.is_gift && s.gift !== 'receiver') return null; // 贈訂預設記給送的人（由 channel.subscription.gift 處理）
        out = { spins: s.newSpins * m, label: ev.is_gift ? `收到贈訂（${tierName}）` : `新訂閱（${tierName}）` };
      } else if (type === 'channel.subscription.message') {
        out = { spins: s.resubSpins * m, label: `續訂${ev.cumulative_months ? ` ${ev.cumulative_months} 個月` : ''}（${tierName}）` };
      } else if (type === 'channel.subscription.gift') {
        if (s.gift !== 'giver') return null;
        const n = Math.max(1, Math.trunc(Number(ev.total) || 1));
        out = { spins: s.newSpins * m * n, label: `贈送 ${n} 份訂閱（${tierName}）` };
      } else return null;
      Object.assign(out, { source: 'sub', wheel: s.wheel });
    }
    out.spins = Math.min(trig.maxSpins, Math.max(0, out.spins));
    out.who = who;
    return out;
  }
  // ---------- 排隊陪玩 ----------
  // 觀眾兌換「排隊陪玩」品項就加入隊伍；兌換在 Twitch 上保持「未完成」，玩完標成已完成、被移出可退點
  const DEFAULT_PARTY = { rewardId: '', title: '排隊陪玩', max: 20, batch: 1, show: 5, showInput: false };
  function normalizeParty(p) {
    p = { ...DEFAULT_PARTY, ...(p && typeof p === 'object' ? p : {}) };
    return {
      rewardId: String(p.rewardId || ''),
      title: String(p.title || '').trim().slice(0, 20) || DEFAULT_PARTY.title,
      max: clampInt(p.max, 1, 200, DEFAULT_PARTY.max),
      batch: clampInt(p.batch, 1, 20, DEFAULT_PARTY.batch),
      show: clampInt(p.show, 1, 20, DEFAULT_PARTY.show),
      showInput: p.showInput === true, // OBS 畫面上要不要顯示觀眾填的遊戲 ID
    };
  }
  const partyEntry = (ev) => ({ id: String(ev.id), login: String(ev.user_login || '').toLowerCase(), display: ev.user_name || ev.user_login || '', userId: String(ev.user_id || ''), input: String(ev.user_input || '').trim().slice(0, 60), rewardId: (ev.reward && ev.reward.id) || '', at: ev.redeemed_at || new Date().toISOString() });
  // 加入隊伍。回傳 { state, added } 或 { state, reason }（要退點的原因）；同一筆兌換重送回 { state, dup: true }
  function admitParty(state, entry, rule) {
    const all = [...state.playing, ...state.waiting];
    if (all.some((e) => e.id === entry.id)) return { state, dup: true };
    const same = (e) => (entry.userId && e.userId === entry.userId) || (entry.login && e.login === entry.login);
    if (all.some(same)) return { state, reason: '已經在隊伍裡了' };
    if (state.waiting.length >= rule.max) return { state, reason: `隊伍滿了（上限 ${rule.max} 人）` };
    return { state: { ...state, waiting: [...state.waiting, entry] }, added: entry };
  }
  // 下一輪：正在玩的都算玩完（done），再從隊伍叫 batch 位上來
  function nextRound(state, batch) {
    const called = state.waiting.slice(0, batch);
    return { state: { playing: called, waiting: state.waiting.slice(batch) }, done: state.playing, called };
  }
  // 從隊伍或正在玩的名單拿掉一位
  const removeParty = (state, id) => ({ playing: state.playing.filter((e) => e.id !== id), waiting: state.waiting.filter((e) => e.id !== id) });
  // 送給 OBS 排隊畫面的內容
  function partyView(state, rule) {
    const show = (e) => ({ name: e.display || e.login, input: rule.showInput ? e.input : '' });
    return { type: 'party', title: rule.title, playing: state.playing.map(show), waiting: state.waiting.slice(0, rule.show).map(show), more: Math.max(0, state.waiting.length - rule.show), total: state.waiting.length };
  }

  // ---------- 小奇點點歌 ----------
  // 觀眾送小奇點時在訊息貼 YouTube 連結（或 11 碼影片編號），送到門檻就照時間排隊播放
  const DEFAULT_SONGS = { on: false, minBits: 100, perUser: 3, maxMinutes: 6, show: 5, volume: 60, blocked: [] };
  function normalizeSongs(p) {
    p = { ...DEFAULT_SONGS, ...(p && typeof p === 'object' ? p : {}) };
    return {
      on: p.on === true,
      minBits: clampInt(p.minBits, 1, 1000000, DEFAULT_SONGS.minBits),
      perUser: clampInt(p.perUser, 1, 50, DEFAULT_SONGS.perUser), // 每人同時在隊伍裡最多幾首
      maxMinutes: clampInt(p.maxMinutes, 0, 60, DEFAULT_SONGS.maxMinutes), // 0＝不限制；超過的播到時間就切下一首
      show: clampInt(p.show, 1, 20, DEFAULT_SONGS.show),
      volume: clampInt(p.volume, 0, 100, DEFAULT_SONGS.volume),
      blocked: Array.isArray(p.blocked) ? [...new Set(p.blocked.map(String).filter((x) => /^[A-Za-z0-9_-]{11}$/.test(x)))].slice(-500) : [],
    };
  }
  // 從文字裡找 YouTube 影片編號：youtube.com/watch?v=、youtu.be/、/shorts/、/live/、music.youtube.com，或單獨的 11 碼編號
  function youtubeId(text) {
    const t = String(text || '');
    const m = t.match(/(?:youtube\.com\/(?:watch\?(?:[^\s#]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
    if (m) return m[1];
    const bare = t.split(/\s+/).find((w) => /^[A-Za-z0-9_-]{11}$/.test(w) && /[0-9_-]/.test(w) && /[A-Za-z]/.test(w) && !/^cheer\d/i.test(w)); // 11 碼裡要同時有英文和數字／符號，免得把一般英文字當成編號
    return bare || '';
  }
  // 點歌加入隊伍。回傳 { state, added } 或 { state, reason }（沒排進去的原因：小奇點不能退，列給實況主處理）
  function admitSong(state, req, rule) {
    const all = [...(state.now ? [state.now] : []), ...state.queue];
    if (all.some((s) => s.id === req.id) || state.missed.some((s) => s.id === req.id)) return { state, dup: true };
    const miss = (reason) => ({ state: { ...state, missed: [{ ...req, reason }, ...state.missed].slice(0, 50) }, reason });
    if (!req.videoId) return miss('訊息裡沒有 YouTube 連結');
    if (req.bits < rule.minBits) return miss(`小奇點不到 ${rule.minBits}`);
    if (rule.blocked.includes(req.videoId)) return miss('這首被封鎖了');
    if (all.some((s) => s.videoId === req.videoId)) return miss('同一首已經在隊伍裡');
    const mine = (s) => (req.userId && s.userId === req.userId) || (req.login && s.login === req.login);
    if (req.login && all.filter(mine).length >= rule.perUser) return miss(`每人同時最多點 ${rule.perUser} 首`);
    return { state: { ...state, queue: [...state.queue, req] }, added: req };
  }
  // 播下一首：目前這首結束（或跳過），隊伍最前面的上來
  const nextSong = (state) => ({ ...state, now: state.queue[0] || null, queue: state.queue.slice(1) });
  // 送給 OBS 點歌播放器畫面的名單
  function songView(state, rule) {
    const show = (s) => ({ title: s.title || '（讀取歌名中…）', who: s.display || s.login || '匿名' });
    return { type: 'songs', now: state.now ? { ...show(state.now), id: state.now.id, videoId: state.now.videoId } : null, next: state.queue.slice(0, rule.show).map(show), more: Math.max(0, state.queue.length - rule.show), volume: rule.volume, maxSec: rule.maxMinutes * 60 };
  }

  // 更新某位觀眾的小奇點零頭（0 就刪掉）
  function setCarry(map, key, n) {
    const next = { ...map };
    delete next[key];
    if (n > 0) next[key] = n;
    return next;
  }

  // 「小美(xiaomei)」→ { display: '小美', login: 'xiaomei' }；「xiaomei」→ { display: 'xiaomei', login: '' }
  // 與 sheet-script.gs 的 parseViewer_ 同一套規則
  function parseViewer(s) {
    s = String(s == null ? '' : s).trim().replace(/[:：\s]+$/, '');
    const m = s.match(/^(.*?)\s*[(（]\s*([^()（）]*?)\s*[)）]$/);
    if (m && m[2]) return { display: m[1].trim(), login: m[2].toLowerCase() };
    return { display: s, login: '' };
  }

  // 代抽：兌換時輸入的文字裡要幫誰抽
  //   「@帳號」或整段就是一個英文帳號 → { login }
  //   「@中文名字」→ { name }（之後向 Twitch 搜尋名字完全一樣的帳號）
  //   其他（「加油」、沒有 @ 的中文）→ null，當作幫自己抽
  function proxyTarget(input) {
    const t = String(input || '').trim();
    const m = t.match(/[@＠]\s*([^\s@＠,，.。!！?？:：;；、()（）「」]+)/);
    if (m) {
      const tok = m[1];
      return /^[A-Za-z0-9_]{3,25}$/.test(tok) ? { login: tok.toLowerCase() } : { name: tok.slice(0, 25) };
    }
    return /^[A-Za-z0-9_]{3,25}$/.test(t) ? { login: t.toLowerCase() } : null;
  }

  // 直播日：凌晨 cutoffHour 點以前算前一天。回傳 'YYYY-MM-DD'（本機時間）
  function dayKey(date, cutoffHour = 0) {
    const d = new Date(date.getTime() - cutoffHour * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // 一筆轉盤紀錄。id 用 Twitch 兌換編號（同一筆兌換不會轉兩次、不會寫兩次）
  // rewardId 有值＝來自 Twitch 兌換：先在 Twitch 保持「未完成」HOLD_MS（這段時間撤銷可退點），之後自動標成已完成
  function makeRecord({ id, src = '', source = '', login = '', display = '', userId = '', by = null, note = '', reward = '', rewardId = '', prize, now = new Date(), cutoffHour = 0, test = false, processedAt = Date.now() }) {
    return {
      id: String(id || `m-${randId(10)}`),
      src: String(src || ''), // 一次轉好幾次（小奇點、訂閱）時，同一筆通知的編號
      source: String(source || ''), // bits 小奇點 / sub 訂閱 / 空白＝忠誠點或手動
      time: now.toISOString(),
      date: dayKey(now, cutoffHour),
      login: String(login).toLowerCase(), display: String(display || login),
      userId: String(userId || ''), // Twitch 永久編號：觀眾改了英文帳號也認得
      by: by && by.login ? { login: String(by.login).toLowerCase(), display: String(by.display || by.login) } : null, // 代抽：實際兌換（花點數）的人
      note: String(note || ''),
      reward: String(reward || ''),
      prizeId: prize.id, prize: prize.name, column: prize.column, color: prize.color,
      // pending 待寫入 / ok 已寫入 / error 失敗 / undoing 撤銷中 / undone 已撤銷 / test 測試不寫入 / nowrite 這格設定成不寫進試算表
      status: test ? 'test' : prize.column ? 'pending' : 'nowrite',
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
      .map((x) => ({ id: x.id, login: x.user_login || '', display: x.user_name || x.user_login || '', userId: x.user_id || '', input: x.user_input || '', reward: (x.reward && x.reward.title) || '', rewardId: (x.reward && x.reward.id) || '', at: x.redeemed_at || new Date().toISOString() }))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }

  // 改記給別人：送給 Apps Script 的「從誰移到誰」
  const forMove = (r) => ({ id: r.id, seq: r.moveSeq || 1, date: r.date, column: r.column, from: { login: r.login, display: r.display, uid: r.userId || '' }, to: { login: r.moveTo.login, display: r.moveTo.display, uid: r.moveTo.userId || '' } });

  // 要送給 Apps Script 的欄位（不送顏色等用不到的）
  const forSheet = (r) => ({ id: r.id, date: r.date, login: r.login, display: r.display, uid: r.userId || '', column: r.column });

  // 名單中顯示用
  const viewerLabel = (r) => (r.display && r.login && r.display.toLowerCase() !== r.login ? `${r.display}(${r.login})` : r.display || r.login || '匿名');

  // 只有原始碼裡的 '__KEY__' 會被換掉
  const scriptWithKey = (src, key) => String(src).replace("const KEY = '__KEY__';", `const KEY = '${key}';`);

  // ---------- 搬到 OBS 面板：把設定和還在可退點期的紀錄包進網址（# 後面，不會送到伺服器） ----------
  // 不搬 Twitch 登入（在 OBS 面板裡重新連接一次）、不搬一般紀錄（留在原本的瀏覽器）
  const MOVE_KEYS = ['clientId', 'rewardIds', 'scriptUrl', 'sheetKey', 'sheetOk', 'cutoffHour', 'prizes', 'spinDuration', 'turns', 'resultSeconds', 'sound', 'volume', 'theme', 'obsBgOpacity', 'room', 'secret', 'sync', 'broker', 'setupDone', 'triggers', 'wheel2', 'bitsCarry', 'party', 'songs'];
  function buildMove(cfg, records, now = Date.now()) {
    const c = {};
    MOVE_KEYS.forEach((k) => { c[k] = cfg[k]; });
    // 還在可退點期的：OBS 面板要接手「期滿標完成」與「退點」，也要知道它們轉過了，補抓時才不會再列出來
    const hold = records.filter((r) => r.tw === 'hold' || r.tw === 'to-cancel');
    return { v: 1, mid: `${now.toString(36)}${randId(6)}`, cfg: c, hold };
  }
  const b64urlEncode = (str) => {
    const bytes = new TextEncoder().encode(str);
    let bin = ''; bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const b64urlDecode = (s) => {
    const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
  };
  const encodeMove = (payload) => b64urlEncode(JSON.stringify(payload));
  // 壞掉或不是我們的資料回 null
  function decodeMove(str) {
    try {
      const p = JSON.parse(b64urlDecode(str));
      if (!p || p.v !== 1 || !p.mid || !p.cfg || typeof p.cfg !== 'object') return null;
      return { v: 1, mid: String(p.mid), cfg: p.cfg, hold: Array.isArray(p.hold) ? p.hold.filter((r) => r && r.id) : [] };
    } catch { return null; }
  }
  // 套用搬家碼：回傳新的設定與要補進紀錄的項目；同一個搬家碼只套用一次
  function applyMove(cfg, records, payload) {
    if (!payload || cfg.importedIds.includes(payload.mid)) return null;
    const picked = {};
    MOVE_KEYS.forEach((k) => { if (k in payload.cfg) picked[k] = payload.cfg[k]; });
    const next = normalizeTwConfig({ ...cfg, ...picked, movedToObs: false, importedIds: [...cfg.importedIds, payload.mid] });
    const have = new Set(records.map((r) => r.id));
    return { cfg: next, add: payload.hold.filter((r) => !have.has(r.id)) };
  }

  return { DEFAULT_SONGS, normalizeSongs, youtubeId, admitSong, nextSong, songView, DEFAULT_PARTY, normalizeParty, partyEntry, admitParty, nextRound, removeParty, partyView, DEFAULT_TRIGGERS, DEFAULT_PRIZES2, normalizeTriggers, bitsSpins, triggerSpins, setCarry, proxyTarget, forMove, SHEET_COLUMNS, buildMove, encodeMove, decodeMove, applyMove, DEFAULT_PRIZES, DEFAULT_TW, HOLD_MS, normalizeTwPrize, normalizeTwConfig, parseViewer, dayKey, makeRecord, forSheet, viewerLabel, scriptWithKey, dueTwitchUpdates, nextHoldExpiry, missedRedemptions };
});
