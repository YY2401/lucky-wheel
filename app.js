/* 幸運轉盤（純前端版）：設定與紀錄存在瀏覽器、Excel 由瀏覽器直接寫入、OBS 透過頻道同步 */
(async () => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const { Wheel, Sfx, Confetti, PALETTE } = LuckyWheel;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const formatTime = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const randId = (n = 6) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join(''); };
  const rand = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] / 4294967296; };

  const params = new URLSearchParams(location.search);
  const OVERLAY = params.get('overlay') === '1';
  const LS = { config: 'lw.config', records: 'lw.records', overlayConfig: 'lw.overlayConfig' };
  const SHEET = '抽獎紀錄';
  const HEADERS = ['時間', '批次ID', '抽獎類型', '第幾抽', '抽獎者/備註', '獎項', '獎項ID', '剩餘數量', '當時機率(%)', '保底'];
  const COL_WIDTHS = [20, 22, 10, 8, 20, 24, 14, 10, 12, 8];

  const DEFAULT_CONFIG = {
    title: '幸運轉盤', segmentMode: 'weight', spinDuration: 5000, multiSpinDuration: 1500, turns: 6, sound: true,
    overlayResultSeconds: 8, multiMode: 'flip', minSlice: 4, bg3d: true, theme: 'light', themeChosen: false,
    overlaySize: 520, overlaySpinOnly: false, overlayMute: false, overlayHideStatus: false,
    pityAccum: false, pityAccumN: 30, pityBatch: false, pityBatchK: 10, pityScope: 'player', room: '', sync: false, broker: 'wss://broker.emqx.io:8084/mqtt',
    prizes: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `p${n}`, name: `獎項 ${n}`, weight: 10, quantity: -1, remaining: -1, image: '', color: PALETTE[(n - 1) % PALETTE.length] })),
  };

  // ---------- 儲存 ----------
  // 資料存在 IndexedDB（容量大、非同步不卡頁面），啟動時一次讀進記憶體，之後寫入在背景進行
  const idb = {
    open() { return new Promise((res, rej) => { const r = indexedDB.open('lucky-wheel', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    async get(k) { const db = await this.open(); return new Promise((res, rej) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); },
    async del(k) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = res; t.onerror = () => rej(t.error); }); },
  };
  const Store = {
    cache: new Map(),
    async init(keys) {
      for (const k of keys) {
        let v;
        try { v = await idb.get(k); } catch { v = undefined; }
        if (v === undefined) { // 從舊版 localStorage 搬移
          try { const raw = localStorage.getItem(k); if (raw) { v = JSON.parse(raw); await idb.set(k, v); localStorage.removeItem(k); } } catch { /* ignore */ }
        }
        if (v !== undefined) this.cache.set(k, v);
      }
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* ignore */ }
    },
    get(k, fb) { return this.cache.has(k) ? this.cache.get(k) : fb; },
    set(k, v) {
      this.cache.set(k, v);
      idb.set(k, JSON.parse(JSON.stringify(v))).catch((e) => toast(`儲存失敗：${e.message}`, 6000));
      return true;
    },
  };
  const loadLS = (k, fb) => Store.get(k, fb);
  const saveLS = (k, v) => Store.set(k, v);
  await Store.init([LS.config, LS.records, LS.overlayConfig, 'lw.skipAnim']);
  function normalizePrize(p, i) {
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

  function toast(msg, ms = 3000) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ---------- 主題 ----------
  const WHEEL_THEMES = {
    dark: { ring: '#1c1c1c', ringStroke: '#ffcf33', ledOn: '#ffcf33', ledOff: '#4a4a4a', hubBg: '#f4efe4', hubText: '#141414', hubStroke: '#ffcf33', pointer: '#e63b3b', pointerStroke: '#f4efe4', sliceStroke: '#141414', textFill: '#ffffff', textStroke: 'rgba(0,0,0,0.55)' },
    light: { ring: '#141414', ringStroke: '#ffcf33', ledOn: '#ffcf33', ledOff: '#4a4a4a', hubBg: '#fffdf7', hubText: '#141414', hubStroke: '#141414', pointer: '#e63b3b', pointerStroke: '#141414', sliceStroke: '#141414', textFill: '#ffffff', textStroke: 'rgba(0,0,0,0.55)' },
  };
  function applyTheme(theme, wheelInst) {
    theme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('lw.theme', theme); } catch { /* ignore */ }
    if (wheelInst) wheelInst.setTheme(WHEEL_THEMES[theme]);
    if (window.WheelBG) WheelBG.setTheme(theme);
    $$('.theme-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.theme === theme));
    return theme;
  }

  // ---------- 頁內確認 / 輸入視窗（OBS 內建瀏覽器不會顯示原生 confirm，所以自己畫） ----------
  function dialog({ title = '確認', message = '', input = null, okLabel = '確定', danger = false }) {
    return new Promise((resolve) => {
      const m = $('#confirmModal'); if (!m) { resolve(input !== null ? window.prompt(message, input) : window.confirm(message)); return; }
      $('#confirmTitle').textContent = title; $('#confirmMsg').textContent = message;
      const inp = $('#confirmInput'); inp.classList.toggle('hidden', input === null); if (input !== null) inp.value = input;
      const ok = $('#confirmOk'); ok.textContent = okLabel; ok.className = `btn ${danger ? 'danger' : 'primary'}`;
      m.classList.remove('hidden');
      const done = (v) => { m.classList.add('hidden'); ok.onclick = null; $('#confirmCancel').onclick = null; m.onclick = null; document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(input !== null ? null : false); if (e.key === 'Enter' && input !== null) done(inp.value); };
      ok.onclick = () => done(input !== null ? inp.value : true);
      $('#confirmCancel').onclick = () => done(input !== null ? null : false);
      m.onclick = (e) => { if (e.target === m) done(input !== null ? null : false); };
      document.addEventListener('keydown', onKey);
      setTimeout(() => (input !== null ? inp : ok).focus(), 50);
    });
  }
  const ask = (message, opts = {}) => dialog({ message, ...opts });

  // ---------- 抽獎邏輯 ----------
  const pool = (prizes) => prizes.filter((p) => p.weight > 0 && (p.remaining === -1 || p.remaining > 0));
  function probabilities(prizes) {
    const pl = pool(prizes); const total = pl.reduce((s, p) => s + p.weight, 0); const m = {};
    pl.forEach((p) => { m[p.id] = total ? (p.weight / total) * 100 : 0; });
    return m;
  }
  function drawOne(prizes) {
    const pl = pool(prizes); if (!pl.length) return null;
    let r = rand() * pl.reduce((s, p) => s + p.weight, 0);
    for (const p of pl) { r -= p.weight; if (r < 0) return p; }
    return pl[pl.length - 1];
  }
  const colorOf = (p, i) => p.color || PALETTE[i % PALETTE.length];

  // ---------- 同步頻道（BroadcastChannel 同瀏覽器 + MQTT 跨瀏覽器） ----------
  const Sync = {
    id: randId(10), bc: null, client: null, room: null, handlers: [], seen: new Set(), state: 'off',
    start(room, cfg) {
      this.stop();
      this.room = room;
      this.bc = new BroadcastChannel(`lucky-wheel:${room}`);
      this.bc.onmessage = (e) => this._recv(e.data);
      this.state = 'local';
      if (cfg.sync && window.mqtt) {
        try {
          this.client = mqtt.connect(cfg.broker, { clientId: `lw_${this.id}`, reconnectPeriod: 3000, connectTimeout: 8000, clean: true });
          this.client.on('connect', () => { this.state = 'online'; this.client.subscribe(this.topic()); this._status(); });
          this.client.on('message', (t, buf) => { try { this._recv(JSON.parse(buf.toString())); } catch { /* ignore */ } });
          this.client.on('offline', () => { this.state = 'offline'; this._status(); });
          this.client.on('error', () => { this.state = 'offline'; this._status(); });
          this.state = 'connecting';
        } catch (e) { this.state = 'offline'; }
      }
      this._status();
    },
    stop() { if (this.bc) this.bc.close(); if (this.client) this.client.end(true); this.bc = this.client = null; this.state = 'off'; },
    topic() { return `luckywheel/${this.room}`; },
    send(msg) {
      msg = { ...msg, from: this.id, mid: randId(10) };
      this.seen.add(msg.mid);
      if (this.bc) this.bc.postMessage(msg);
      if (this.client && this.client.connected) this.client.publish(this.topic(), JSON.stringify(msg));
    },
    on(fn) { this.handlers.push(fn); },
    _recv(msg) {
      if (!msg || msg.from === this.id || this.seen.has(msg.mid)) return;
      this.seen.add(msg.mid); if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-200));
      this.handlers.forEach((h) => h(msg));
    },
    _status() {
      const dot = $('#ovStatus');
      if (dot) { dot.className = `ov-status ${this.state === 'online' || this.state === 'local' ? 'ok' : this.state === 'connecting' ? 'wait' : 'bad'}`; dot.title = { local: '同瀏覽器同步', online: '跨瀏覽器同步中', connecting: '連線中', offline: '中繼離線', off: '關閉' }[this.state]; }
      const el = $('#syncStatus'); if (!el) return;
      const map = { off: ['', '同步：關閉'], local: ['ok', `頻道 ${this.room}（同瀏覽器）`], connecting: ['', `頻道 ${this.room}：連線中…`], online: ['ok', `頻道 ${this.room}：跨瀏覽器同步中`], offline: ['bad', `頻道 ${this.room}：中繼離線，重連中…`] };
      el.className = `status ${map[this.state][0]}`; el.lastChild.textContent = map[this.state][1];
    },
  };

  // ---------- Excel（File System Access API + SheetJS） ----------
  const Excel = {
    handle: null,
    supported: typeof window.showSaveFilePicker === 'function',
    types: [{ description: 'Excel 活頁簿', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }],
    async init() { try { this.handle = (await idb.get('excelHandle')) || null; } catch { this.handle = null; } this.render(); },
    async create() {
      this.handle = await window.showSaveFilePicker({ suggestedName: '抽獎紀錄.xlsx', types: this.types });
      await idb.set('excelHandle', this.handle); this.render();
      return this.writeAll();
    },
    async open() {
      [this.handle] = await window.showOpenFilePicker({ types: this.types, multiple: false });
      await idb.set('excelHandle', this.handle); this.render();
      return this.writeAll();
    },
    async forget() { this.handle = null; await idb.del('excelHandle'); this.render(); },
    async ensurePermission() {
      if (!this.handle) return false;
      let p = await this.handle.queryPermission({ mode: 'readwrite' });
      if (p !== 'granted') p = await this.handle.requestPermission({ mode: 'readwrite' });
      return p === 'granted';
    },
    rows() { return state.records.map((r) => [r.time, r.batchId, r.type, r.index, r.player, r.prize, r.prizeId, r.remaining === -1 ? '無限' : r.remaining, r.probability, r.pity ? '是' : '']); },
    buildWorkbook(existing) {
      let wb = null;
      if (existing) { try { wb = XLSX.read(existing, { type: 'array' }); } catch { wb = null; } }
      if (!wb) wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...this.rows()]);
      ws['!cols'] = COL_WIDTHS.map((wch) => ({ wch }));
      if (wb.SheetNames.includes(SHEET)) wb.Sheets[SHEET] = ws; else XLSX.utils.book_append_sheet(wb, ws, SHEET);
      return wb;
    },
    async writeAll() {
      if (!this.handle) return { ok: false, skipped: true };
      if (!(await this.ensurePermission())) return { ok: false, error: '未取得寫入權限' };
      let existing = null;
      try { const f = await this.handle.getFile(); if (f.size > 0) existing = await f.arrayBuffer(); } catch { existing = null; }
      const out = XLSX.write(this.buildWorkbook(existing), { type: 'array', bookType: 'xlsx' });
      const w = await this.handle.createWritable();
      await w.write(out); await w.close();
      this.lastWrite = new Date(); this.render();
      return { ok: true, name: this.handle.name };
    },
    download() { XLSX.writeFile(this.buildWorkbook(), `抽獎紀錄_${formatTime(new Date()).replace(/[-: ]/g, '')}.xlsx`); },
    render() {
      const info = $('#excelInfo'); if (!info) return;
      if (!this.supported) {
        info.textContent = '此瀏覽器不支援直接寫入檔案（請用 Chrome / Edge）；仍可用「下載 Excel」取得紀錄。';
        ['#excelCreate', '#excelOpen', '#excelWrite', '#excelForget'].forEach((s) => { $(s).disabled = true; });
        return;
      }
      info.textContent = this.handle
        ? `已綁定：${this.handle.name}${this.lastWrite ? `（最後寫入 ${formatTime(this.lastWrite)}）` : ''}`
        : '尚未綁定 Excel 檔案。按「建立新的 Excel」選擇存放位置，之後每次抽獎會自動寫入。';
      $('#excelWrite').disabled = $('#excelForget').disabled = !this.handle;
    },
  };

  // ---------- 狀態 ----------
  const state = { config: null, records: [], dirty: false, spinning: false, skipAll: false };

  // 翻牌結果卡：先蓋牌，再依序翻開
  const FLIP_START = 500, FLIP_GAP = 160, FLIP_DUR = 900;
  function resultCards(results, showIndex, flip = true) {
    return results.map((r, i) => `
      <div class="r-card${flip ? '' : ' revealed'}" style="--c:${esc(r.color || '#888')}">
        <div class="flip-inner" style="--d:${FLIP_START + i * FLIP_GAP}ms">
          <div class="flip-face flip-back"><span class="q">?</span></div>
          <div class="flip-face flip-front">
            ${r.pity ? '<span class="badge-pity">保底</span>' : ''}
            <div class="r-img">${r.image ? `<img src="${esc(r.image)}" alt="">` : '<span class="r-dot"></span>'}</div>
            <div class="r-name">${esc(r.name)}</div>
            ${showIndex ? `<div class="r-idx">第 ${r.index} 抽</div>` : ''}
          </div>
        </div>
      </div>`).join('');
  }
  function scheduleFlipSounds(n) {
    for (let i = 0; i < n; i++) setTimeout(() => Sfx.pop(), FLIP_START + i * FLIP_GAP + FLIP_DUR * 0.45);
  }
  const flipTotal = (n, flip = true) => (flip ? FLIP_START + (n - 1) * FLIP_GAP + FLIP_DUR : 0);
  // 連抽且採翻牌模式時，轉盤只轉一次、結果用翻牌揭曉
  const isFlip = (d) => d.results.length > 1 && d.reveal !== 'each';

  // ======================================================================
  //  OBS 覆蓋層模式
  // ======================================================================
  if (OVERLAY) {
    document.body.classList.add('overlay');
    $$('.control-only').forEach((el) => el.remove());
    $$('.overlay-only').forEach((el) => el.classList.remove('hidden'));
    const size = Number(params.get('size')) || 520;
    const mode = params.get('mode') === 'spin' ? 'spin' : 'always';
    const hideParam = Number(params.get('hide'));
    const soundParam = params.get('sound');
    document.documentElement.style.setProperty('--size', `${size}px`);
    const stage = $('#ovStage');
    const wheel = new Wheel($('#ovWheel'), { onTick: () => Sfx.tick() });
    const confetti = new Confetti($('#confetti'));
    const queue = []; let busy = false;
    if (mode === 'spin') stage.classList.add('out');

    // 先用本機快取的設定畫轉盤（同一瀏覽器直接共用，跨瀏覽器則等控制台回覆）
    let config = normalizeConfig(loadLS(LS.config, null) || loadLS(LS.overlayConfig, null) || DEFAULT_CONFIG);
    const room = params.get('room') || config.room;
    function applyConfig(c) {
      config = normalizeConfig(c);
      saveLS(LS.overlayConfig, config);
      Sfx.enabled = soundParam === '0' ? false : !!config.sound;
      try { localStorage.setItem('lw.bg3d', config.bg3d ? '1' : '0'); } catch { /* ignore */ }
      applyTheme(params.get('theme') || config.theme, wheel);
      wheel.setPrizes(config.prizes, config.segmentMode, config.minSlice / 100);
      if (window.WheelBG && params.get('bg') !== '0') WheelBG.setEnabled(config.bg3d);
    }
    if (params.get('status') !== '0') $('#ovStatus').classList.remove('hidden');
    applyConfig(config);
    function addLive(r) {
      const chip = document.createElement('span');
      chip.className = 'chip'; chip.style.setProperty('--c', r.color || '#888');
      chip.innerHTML = `${r.image ? `<img src="${esc(r.image)}" alt="">` : '<span class="dot"></span>'}${esc(r.name)}`;
      $('#ovLive').appendChild(chip);
    }
    async function play(d) {
      if (!d.results.length) return;
      $('#ovLive').innerHTML = '';
      stage.classList.remove('out');
      if (window.WheelBG) WheelBG.setSpinning(true);
      await wait(mode === 'spin' ? 600 : 50);
      const flip = isFlip(d);
      if (flip) {
        await wheel.spinTo(d.results[0].prizeId, { duration: config.spinDuration, turns: config.turns });
      } else {
        for (let i = 0; i < d.results.length; i++) {
          const r = d.results[i]; const first = i === 0;
          await wheel.spinTo(r.prizeId, { duration: first ? config.spinDuration : config.multiSpinDuration, turns: first ? config.turns : Math.max(2, Math.round(config.turns / 2)) });
          if (d.results.length > 1) { addLive(r); Sfx.pop(); await wait(350); }
        }
      }
      if (d.prizes) { config.prizes = d.prizes.map(normalizePrize); saveLS(LS.overlayConfig, config); wheel.setPrizes(config.prizes, config.segmentMode, config.minSlice / 100); }
      Sfx.win(); confetti.burst(d.results.length > 1 ? 260 : 160);
      if (window.WheelBG) { WheelBG.setSpinning(false); WheelBG.burst(); }
      $('#ovResultCard').classList.toggle('single', d.results.length === 1);
      $('#ovTitle').textContent = d.results.length > 1 ? `${d.batchType}結果` : '恭喜獲得';
      $('#ovPlayer').textContent = d.player ? d.player : '';
      $('#ovGrid').innerHTML = resultCards(d.results, d.results.length > 1, flip);
      $('#ovResultLayer').classList.remove('out');
      $('#ovLive').innerHTML = '';
      if (flip) scheduleFlipSounds(d.results.length);
      await wait(flipTotal(d.results.length, flip) + (hideParam || config.overlayResultSeconds || 8) * 1000);
      $('#ovResultLayer').classList.add('out');
      $('#ovLive').innerHTML = '';
      if (mode === 'spin') stage.classList.add('out');
    }
    async function pump() { if (busy) return; busy = true; while (queue.length) { try { await play(queue.shift()); } catch (e) { console.error(e); } } busy = false; }
    Sync.on((msg) => {
      if (msg.type === 'config') applyConfig(msg.config);
      else if (msg.type === 'spin') { queue.push(msg); pump(); }
      else if (msg.type === 'ping') { Sync.send({ type: 'pong' }); const d = $('#ovStatus'); d.classList.add('flash'); setTimeout(() => d.classList.remove('flash'), 1200); }
    });
    Sync.start(room, { sync: params.get('sync') !== '0', broker: params.get('broker') || config.broker });
    // 向控制台要最新設定（跨瀏覽器時需要）
    const hello = () => Sync.send({ type: 'hello' });
    setTimeout(hello, 500); setTimeout(hello, 3000);
    return;
  }

  // ======================================================================
  //  控制台模式
  // ======================================================================
  const wheel = new Wheel($('#wheel'), { onTick: () => Sfx.tick() });
  const confetti = new Confetti($('#confetti'));

  function overlayUrl() {
    const c = state.config;
    const q = new URLSearchParams({ overlay: '1', room: c.room });
    if (c.overlaySize !== 520) q.set('size', c.overlaySize);
    if (c.overlaySpinOnly) q.set('mode', 'spin');
    if (c.overlayMute) q.set('sound', '0');
    if (c.overlayHideStatus) q.set('status', '0');
    return `${location.origin}${location.pathname}?${q.toString()}`;
  }
  function markDirty(v = true) {
    state.dirty = v;
    $('#dirtyHint').textContent = v ? '● 有未儲存的變更' : '';
    $('#savePrizes').classList.toggle('pulse', v);
  }
  function saveConfig(silent) {
    state.config = normalizeConfig(state.config);
    if (!saveLS(LS.config, state.config)) return false;
    try { localStorage.setItem('lw.bg3d', state.config.bg3d ? '1' : '0'); } catch { /* ignore */ }
    markDirty(false); renderAll();
    Sync.send({ type: 'config', config: state.config });
    if (!silent) toast('已儲存設定');
    return true;
  }
  function renderAll() {
    const c = state.config;
    renderPrizeRows(); renderSettings(); updateWheel(); renderPityInfo();
  }
  function updateWheel() {
    applyTheme(state.config.theme, wheel);
    wheel.setPrizes(state.config.prizes, state.config.segmentMode, state.config.minSlice / 100);
    renderProbBar(); refreshComputed();
    if (window.WheelBG) WheelBG.setEnabled(state.config.bg3d);
    Sfx.enabled = !!state.config.sound;
  }

  // ---------- 獎項表格 ----------
  function renderPrizeRows() {
    const tb = $('#prizeRows'); tb.innerHTML = '';
    state.config.prizes.forEach((p, i) => {
      const unlimited = p.quantity === -1;
      const tr = document.createElement('tr'); tr.dataset.id = p.id;
      tr.innerHTML = `
        <td><div style="display:flex;gap:6px;align-items:center">
          <div class="thumb" title="點擊上傳圖片">${p.image ? `<img src="${esc(p.image)}" alt="">` : '<span class="thumb-empty">上傳</span>'}</div>
          <div class="thumb-actions"><button class="f-url">網址</button><button class="f-clearimg">清除</button></div>
          <input type="file" accept="image/*" class="f-file" hidden>
        </div></td>
        <td><input class="f-name" value="${esc(p.name)}" maxlength="60"></td>
        <td><input type="number" class="f-weight" min="0" step="0.1" value="${p.weight}"></td>
        <td class="prob">–</td>
        <td><div class="qty">
          <input type="number" class="f-quantity" min="0" value="${unlimited ? '' : p.quantity}" ${unlimited ? 'disabled' : ''}>
          <label><input type="checkbox" class="f-unlimited" ${unlimited ? 'checked' : ''}>無限</label>
        </div></td>
        <td><input type="number" class="f-remaining" min="0" value="${unlimited ? '' : p.remaining}" ${unlimited ? 'disabled' : ''}></td>
        <td><input type="color" class="f-color" value="${colorOf(p, i)}"></td>
        <td style="text-align:center"><input type="checkbox" class="f-pity" ${p.pity ? 'checked' : ''} title="勾選＝算保底獎"></td>
        <td style="white-space:nowrap">
          <button class="btn icon f-up" title="上移">↑</button>
          <button class="btn icon f-down" title="下移">↓</button>
          <button class="btn icon f-del" title="刪除">✕</button>
        </td>`;
      tb.appendChild(tr);
      const on = (sel, ev, fn) => $(sel, tr).addEventListener(ev, fn);
      const rerender = () => { markDirty(); renderPrizeRows(); updateWheel(); };
      on('.f-name', 'input', (e) => { p.name = e.target.value; markDirty(); updateWheel(); });
      on('.f-weight', 'input', (e) => { p.weight = Math.max(0, Number(e.target.value) || 0); markDirty(); updateWheel(); });
      on('.f-quantity', 'input', (e) => {
        const q = Math.max(0, Math.trunc(Number(e.target.value)) || 0);
        p.remaining = Math.min(q, Math.max(0, p.remaining + (q - p.quantity)));
        p.quantity = q; $('.f-remaining', tr).value = p.remaining; markDirty(); updateWheel();
      });
      on('.f-remaining', 'input', (e) => { p.remaining = Math.min(p.quantity, Math.max(0, Math.trunc(Number(e.target.value)) || 0)); markDirty(); updateWheel(); });
      on('.f-unlimited', 'change', (e) => { if (e.target.checked) { p.quantity = -1; p.remaining = -1; } else { p.quantity = 10; p.remaining = 10; } rerender(); });
      on('.f-color', 'input', (e) => { p.color = e.target.value; markDirty(); updateWheel(); });
      on('.f-pity', 'change', (e) => { p.pity = e.target.checked; markDirty(); renderPityInfo(); });
      on('.f-del', 'click', async () => { if (await ask(`刪除獎項「${p.name}」？`, { title: '刪除獎項', okLabel: '刪除', danger: true })) { state.config.prizes.splice(i, 1); rerender(); } });
      on('.f-up', 'click', () => { if (i === 0) return; const a = state.config.prizes; [a[i - 1], a[i]] = [a[i], a[i - 1]]; rerender(); });
      on('.f-down', 'click', () => { const a = state.config.prizes; if (i >= a.length - 1) return; [a[i + 1], a[i]] = [a[i], a[i + 1]]; rerender(); });
      on('.thumb', 'click', () => $('.f-file', tr).click());
      on('.f-file', 'change', async (e) => {
        const file = e.target.files[0]; if (!file) return;
        try { p.image = await downscale(file, 200); rerender(); }
        catch (err) { toast(`讀取圖片失敗：${err.message}`); }
      });
      on('.f-url', 'click', async () => { const u = await dialog({ title: '圖片網址', message: '輸入圖片網址（https://…）', input: p.image.startsWith('data:') ? '' : p.image }); if (u !== null) { p.image = u.trim(); rerender(); } });
      on('.f-clearimg', 'click', () => { p.image = ''; rerender(); });
    });
    refreshComputed();
  }
  function refreshComputed() {
    const probs = probabilities(state.config.prizes);
    $$('#prizeRows tr').forEach((tr) => {
      const p = state.config.prizes.find((x) => x.id === tr.dataset.id); if (!p) return;
      const pr = probs[p.id];
      $('.prob', tr).textContent = pr == null ? (p.remaining === 0 ? '已抽完' : '0%') : `${pr.toFixed(2)}%`;
      tr.classList.toggle('tr-soldout', pr == null);
      const rem = $('.f-remaining', tr);
      if (document.activeElement !== rem && p.quantity !== -1) rem.value = p.remaining;
    });
  }
  function renderProbBar() {
    const probs = probabilities(state.config.prizes);
    const bar = $('#probBar'); bar.innerHTML = '';
    state.config.prizes.forEach((p, i) => {
      if (probs[p.id] == null) return;
      const s = document.createElement('span');
      s.style.width = `${probs[p.id]}%`; s.style.background = colorOf(p, i);
      s.title = `${p.name} ${probs[p.id].toFixed(2)}%`;
      s.textContent = probs[p.id] >= 8 ? `${p.name} ${probs[p.id].toFixed(1)}%` : '';
      bar.appendChild(s);
    });
  }
  // 圖片縮小後以 data URL 存在瀏覽器（webp 支援透明且檔案小）
  function downscale(file, max) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('讀取檔案失敗'));
      reader.onload = () => {
        if (file.type === 'image/svg+xml' && file.size < 60000) return resolve(reader.result);
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const cv = document.createElement('canvas');
          cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          let out = cv.toDataURL('image/webp', 0.85);
          if (!out.startsWith('data:image/webp')) out = cv.toDataURL('image/png');
          resolve(out);
        };
        img.onerror = () => reject(new Error('不是有效的圖片'));
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ---------- 設定頁 ----------
  const SETTING_KEYS = ['segmentMode', 'turns', 'overlayResultSeconds', 'multiMode', 'minSlice', 'pityAccumN', 'pityBatchK', 'pityScope', 'theme', 'room', 'broker', 'overlaySize'];
  const SEC_KEYS = ['spinDuration', 'multiSpinDuration']; // 畫面用秒，內部存毫秒
  const BOOL_KEYS = ['sound', 'sync', 'bg3d', 'pityAccum', 'pityBatch', 'overlaySpinOnly', 'overlayMute', 'overlayHideStatus'];
  function renderSettings() {
    const c = state.config;
    SETTING_KEYS.forEach((k) => { $(`#s-${k}`).value = c[k]; });
    SEC_KEYS.forEach((k) => { $(`#s-${k}`).value = Math.round(c[k] / 100) / 10; });
    BOOL_KEYS.forEach((k) => { $(`#s-${k}`).checked = !!c[k]; });
    $('#overlayUrl').textContent = overlayUrl();
    $('#openOverlay').href = overlayUrl();
  }
  $('#saveSettings').addEventListener('click', () => {
    const c = state.config;
    const before = `${c.room}|${c.sync}|${c.broker}`;
    SETTING_KEYS.forEach((k) => { c[k] = $(`#s-${k}`).value; });
    SEC_KEYS.forEach((k) => { c[k] = Math.round(Number($(`#s-${k}`).value) * 1000); });
    BOOL_KEYS.forEach((k) => { c[k] = $(`#s-${k}`).checked; });
    c.themeChosen = true;
    if (!saveConfig()) return;
    const c2 = state.config; // saveConfig 會重新 normalize
    if (before !== `${c2.room}|${c2.sync}|${c2.broker}`) Sync.start(c2.room, c2);
  });
  $('#newRoom').addEventListener('click', () => { $('#s-room').value = randId(); });
  $$('.theme-toggle button').forEach((b) => b.addEventListener('click', () => {
    state.config.theme = b.dataset.theme; state.config.themeChosen = true; $('#s-theme').value = b.dataset.theme;
    saveLS(LS.config, state.config); applyTheme(b.dataset.theme, wheel);
    Sync.send({ type: 'config', config: state.config });
  }));
  $('#testSync').addEventListener('click', () => {
    state.pongs = 0; Sync.send({ type: 'ping' }); toast('已送出測試訊號，等待覆蓋層回應…', 3000);
    setTimeout(() => toast(state.pongs ? `OBS 畫面已回應（${state.pongs} 個）` : '3 秒內沒有回應：請確認「讓 OBS 畫面跟著控制台動」已打開並儲存，且 OBS 裡貼的是最新複製的網址', 6000), 3000);
  });
  $('#testSound').addEventListener('click', () => { const on = $('#s-sound').checked; if (!on) { toast('音效目前是關閉的，先打開再試聽'); return; } const was = Sfx.enabled; Sfx.enabled = true; Sfx.tick(); setTimeout(() => Sfx.pop(), 200); setTimeout(() => { Sfx.win(); Sfx.enabled = was || on; }, 500); });
  $('#savePrizes').addEventListener('click', () => saveConfig());
  $('#addPrize').addEventListener('click', () => {
    const n = state.config.prizes.length;
    state.config.prizes.push({ id: `p_${randId(8)}`, name: `獎項 ${n + 1}`, weight: 10, quantity: -1, remaining: -1, image: '', color: PALETTE[n % PALETTE.length] });
    markDirty(); renderPrizeRows(); updateWheel();
  });
  $('#resetStock').addEventListener('click', async () => {
    if (!(await ask('把所有獎項的剩餘數量重置為原始數量？', { title: '重置庫存', okLabel: '重置' }))) return;
    state.config.prizes.forEach((p) => { p.remaining = p.quantity; });
    saveConfig(true); toast('庫存已重置');
  });
  $('#copyOverlay').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(overlayUrl()); toast('已複製 OBS 畫面網址'); }
    catch { prompt('請手動複製', overlayUrl()); }
  });
  $('#exportConfig').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state.config, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'lucky-wheel-config.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#importConfig').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { state.config = normalizeConfig(JSON.parse(await f.text())); saveConfig(); Sync.start(state.config.room, state.config); }
    catch { toast('匯入失敗：不是有效的設定檔'); }
    e.target.value = '';
  });
  function showTab(name) {
    $$('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
    if (name === 'records') renderRecords();
  }
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $$('.open-panel').forEach((b) => b.addEventListener('click', () => { showTab(b.dataset.tab); $('#panelModal').classList.remove('hidden'); }));
  $('#closePanel').addEventListener('click', () => $('#panelModal').classList.add('hidden'));
  $('#panelModal').addEventListener('click', (e) => { if (e.target.id === 'panelModal') e.target.classList.add('hidden'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#panelModal').classList.add('hidden'); $('#resultModal').classList.add('hidden'); } });

  // ---------- 紀錄 / Excel ----------
  function renderRecords() {
    const q = ($('#recordSearch').value || '').trim().toLowerCase();
    const terms = q ? q.split(/\s+/) : [];
    const list = terms.length
      ? state.records.filter((r) => { const hay = `${r.time} ${r.player} ${r.type} ${r.prize} ${r.batchId} ${r.pity ? '保底' : ''}`.toLowerCase(); return terms.every((t) => hay.includes(t)); })
      : state.records;
    $('#recordCount').textContent = terms.length ? `符合 ${list.length} / ${state.records.length} 筆` : `共 ${state.records.length} 筆`;
    $('#recordRows').innerHTML = list.slice(-500).reverse().map((r) => `<tr>
      <td>${esc(r.time)}</td><td>${esc(r.player)}</td><td>${esc(r.type)}</td><td>${r.index}</td>
      <td>${esc(r.prize)}</td><td>${r.remaining === -1 ? '∞' : r.remaining}</td><td>${r.probability}%</td><td>${r.pity ? '<span class="badge-pity inline">保底</span>' : ''}</td></tr>`).join('');
  }
  const excelAction = (fn) => async () => { try { const r = await fn(); if (r && r.ok) toast(`已寫入 ${r.name}`); } catch (e) { if (e.name !== 'AbortError') toast(`Excel 失敗：${e.message}`, 5000); } };
  $('#excelCreate').addEventListener('click', excelAction(() => Excel.create()));
  $('#excelOpen').addEventListener('click', excelAction(() => Excel.open()));
  $('#excelWrite').addEventListener('click', excelAction(() => Excel.writeAll()));
  $('#excelForget').addEventListener('click', () => Excel.forget());
  $('#excelDownload').addEventListener('click', () => Excel.download());
  $('#recordSearch').addEventListener('input', renderRecords);
  async function undoLastBatch() {
    if (!state.records.length) { toast('沒有可撤銷的紀錄'); return false; }
    const bid = state.records[state.records.length - 1].batchId;
    const batch = state.records.filter((r) => r.batchId === bid);
    const names = batch.map((r) => r.prize).join('、');
    const okd = await ask(`${batch[0].time}　${batch[0].type}　${batch.length} 筆${batch[0].player ? `　抽獎者：${batch[0].player}` : ''}\n獎項：${names}\n\n庫存會加回，紀錄與 Excel 內的這幾筆會一併移除。確定撤銷？`, { title: '撤銷上一批抽獎', okLabel: '確定撤銷', danger: true });
    if (!okd) return false;
    batch.forEach((r) => { const p = state.config.prizes.find((x) => x.id === r.prizeId); if (p && p.quantity !== -1) p.remaining = Math.min(p.quantity, p.remaining + 1); });
    state.records = state.records.filter((r) => r.batchId !== bid);
    saveLS(LS.records, state.records);
    saveConfig(true); renderRecords(); renderPityInfo();
    Excel.writeAll().then((r) => { if (r.ok) toast(`已撤銷並更新 Excel（${r.name}）`); else toast('已撤銷'); }).catch((e) => toast(`已撤銷，但 Excel 更新失敗：${e.message}`, 6000));
    return true;
  }
  $('#undoLast').addEventListener('click', undoLastBatch);
  $('#undoThis').addEventListener('click', async () => { if (await undoLastBatch()) $('#resultModal').classList.add('hidden'); });
  $('#clearRecords').addEventListener('click', async () => {
    if (!(await ask('清除瀏覽器裡的所有抽獎紀錄？（已綁定的 Excel 檔不會被改動，直到下次寫入）', { title: '清除紀錄', okLabel: '清除', danger: true }))) return;
    state.records = []; saveLS(LS.records, state.records); renderRecords();
  });

  // ---------- 抽獎 ----------
  function setSpinning(v) {
    state.spinning = v;
    if (window.WheelBG) WheelBG.setSpinning(v);
    $$('.spin-btn').forEach((b) => { b.disabled = v; });
    $('#skipBtn').classList.toggle('hidden', !v);
  }
  $('#skipBtn').addEventListener('click', () => { state.skipAll = true; wheel.skip(); });
  $('#skipAnim').checked = loadLS('lw.skipAnim', false) === true;
  $('#skipAnim').addEventListener('change', (e) => saveLS('lw.skipAnim', e.target.checked));
  $$('.spin-btn[data-count]').forEach((b) => b.addEventListener('click', () => spin(Number(b.dataset.count))));
  $('#customSpin').addEventListener('click', () => spin(Number($('#customCount').value) || 1));
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) { e.preventDefault(); spin(1); }
  });

  // 保底：從紀錄反推「這個計數範圍距離上次抽中保底獎已經幾抽」，撤銷後自動正確
  const pityPool = (prizes) => pool(prizes).filter((p) => p.pity);
  function drawsSinceHit(player) {
    const cfg = state.config;
    const key = cfg.pityScope === 'global' ? null : (player || '');
    let n = 0;
    for (let i = state.records.length - 1; i >= 0; i--) {
      const r = state.records[i];
      if (key !== null && (r.player || '') !== key) continue;
      if (r.hit) break;
      n++;
    }
    return n;
  }
  function renderPityInfo() {
    const cfg = state.config; const el = $('#pityInfo');
    const hasPool = cfg.prizes.some((p) => p.pity);
    if (!(cfg.pityAccum || cfg.pityBatch) || !hasPool) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const parts = [];
    if (cfg.pityAccum) {
      const player = $('#player').value.trim();
      const left = Math.max(0, cfg.pityAccumN - drawsSinceHit(player));
      const who = cfg.pityScope === 'global' ? '全體' : (player || '匿名');
      parts.push(left === 0 ? `${who}：下一抽必中保底獎` : `${who}：再 ${left} 抽觸發累積保底`);
    }
    if (cfg.pityBatch) parts.push(`每 ${cfg.pityBatchK} 抽至少 1 個保底獎`);
    el.textContent = parts.join('　｜　');
  }
  $('#player').addEventListener('input', renderPityInfo);

  function doSpin(countRaw, player) {
    const count = Math.min(100, Math.max(1, Math.trunc(Number(countRaw)) || 1));
    const now = new Date();
    const batchId = `${formatTime(now).replace(/[-: ]/g, '')}-${randId(4)}`;
    const type = count === 1 ? '單抽' : `${count}連抽`;
    const results = [];
    const cfg = state.config;
    let since = drawsSinceHit(player);
    let hitsInBatch = 0;
    const guaranteed = cfg.pityBatch && count >= cfg.pityBatchK ? Math.floor(count / cfg.pityBatchK) : 0;
    for (let i = 0; i < count; i++) {
      const probs = probabilities(cfg.prizes);
      let forced = false;
      if (cfg.pityAccum && since >= cfg.pityAccumN) forced = true;
      if (guaranteed) { const needed = guaranteed - hitsInBatch; if (needed > 0 && needed >= count - i) forced = true; }
      let p = forced ? drawOne(pityPool(cfg.prizes)) : null;
      if (!p) { forced = false; p = drawOne(cfg.prizes); }
      if (!p) break;
      if (p.remaining > 0) p.remaining -= 1;
      const hit = !!p.pity;
      if (hit) { since = 0; hitsInBatch++; } else since++;
      results.push({ index: i + 1, prizeId: p.id, name: p.name, image: p.image, color: p.color, remaining: p.remaining, probability: Math.round(probs[p.id] * 100) / 100, pity: forced, hit });
    }
    const time = formatTime(now);
    const recs = results.map((r) => ({ time, batchId, type, index: r.index, player, prize: r.name, prizeId: r.prizeId, remaining: r.remaining, probability: r.probability, pity: r.pity, hit: r.hit }));
    if (recs.length) { state.records.push(...recs); saveLS(LS.records, state.records); saveLS(LS.config, state.config); }
    return { type: 'spin', batchId, batchType: type, count, player, results, prizes: state.config.prizes, exhausted: results.length < count, time, reveal: state.config.multiMode };
  }

  async function spin(count) {
    if (state.spinning) return;
    setSpinning(true);
    try {
      if (state.dirty && !saveConfig(true)) return;
      if (Excel.handle) await Excel.ensurePermission(); // 需在使用者點擊後立即詢問
      const res = doSpin(count, $('#player').value.trim());
      Sync.send(res);
      const excelP = res.results.length ? Excel.writeAll().catch((e) => ({ ok: false, error: e.message })) : Promise.resolve({ ok: false, skipped: true });
      await playBatch(res);
      res.excel = await excelP;
      if (res.results.length) showResult(res);
    } catch (e) { toast(`抽獎失敗：${e.message}`); console.error(e); }
    finally { setSpinning(false); }
  }
  function addLive(r) {
    const chip = document.createElement('span');
    chip.className = 'chip'; chip.style.setProperty('--c', r.color || '#888');
    chip.innerHTML = `${r.image ? `<img src="${esc(r.image)}" alt="">` : '<span class="dot"></span>'}${esc(r.name)}`;
    $('#liveResults').appendChild(chip);
  }
  async function playBatch(res) {
    $('#liveResults').innerHTML = ''; state.skipAll = $('#skipAnim').checked;
    if (!res.results.length) { toast('沒有可抽的獎項（獎項都抽完或權重為 0）'); return; }
    const cfg = state.config;
    if (isFlip(res)) {
      await wheel.spinTo(res.results[0].prizeId, { duration: state.skipAll ? 0 : cfg.spinDuration, turns: cfg.turns });
    } else {
      for (let i = 0; i < res.results.length; i++) {
        const r = res.results[i]; const first = i === 0;
        await wheel.spinTo(r.prizeId, { duration: state.skipAll ? 0 : (first ? cfg.spinDuration : cfg.multiSpinDuration), turns: first ? cfg.turns : Math.max(2, Math.round(cfg.turns / 2)) });
        addLive(r);
        if (res.results.length > 1) Sfx.pop();
        if (!state.skipAll) await wait(350);
      }
    }
    updateWheel(); renderPrizeRows(); renderPityInfo();
    Sfx.win(); confetti.burst(res.results.length > 1 ? 260 : 160);
    if (window.WheelBG) WheelBG.burst();
  }
  function showResult(res) {
    $('#resultTitle').textContent = res.results.length > 1 ? `${res.batchType}結果` : '恭喜獲得';
    $('#resultSub').textContent = [res.player && `抽獎者：${res.player}`, res.exhausted && '（部分獎項已抽完，實際抽數少於設定）'].filter(Boolean).join('　');
    const flip = isFlip(res);
    $('#resultGrid').innerHTML = resultCards(res.results, true, flip);
    $('.modal-box', $('#resultModal')).classList.toggle('single', res.results.length === 1);
    if (flip) scheduleFlipSounds(res.results.length);
    const ex = $('#excelStatus'); const e = res.excel || {};
    ex.textContent = e.ok ? `已寫入 Excel：${e.name}` : e.skipped ? '（未綁定 Excel 檔案；可在「紀錄 / Excel」綁定或下載）' : `Excel 寫入失敗：${e.error}（紀錄仍保存在瀏覽器，可稍後「立即寫入」或下載）`;
    ex.classList.toggle('bad', !e.ok && !e.skipped);
    $('#resultModal').classList.remove('hidden');
    if (window.anime) {
      anime({ targets: '#resultGrid .r-card', translateY: [40, 0], opacity: [0, 1], scale: [0.7, 1], delay: anime.stagger(60, { start: 80 }), duration: 600, easing: 'easeOutBack' });
      anime({ targets: '#resultTitle', scale: [0.6, 1], opacity: [0, 1], duration: 600, easing: 'easeOutBack' });
    }
  }
  $('#closeResult').addEventListener('click', () => $('#resultModal').classList.add('hidden'));
  $('#resultModal').addEventListener('click', (e) => { if (e.target.id === 'resultModal') e.target.classList.add('hidden'); });

  // ---------- 啟動 ----------
  state.config = normalizeConfig(loadLS(LS.config, DEFAULT_CONFIG));
  state.records = loadLS(LS.records, []);
  saveLS(LS.config, state.config);
  renderAll(); markDirty(false);
  Excel.init();
  if (window.anime) {
    anime({ targets: '.wheel-wrap', scale: [0.6, 1], opacity: [0, 1], rotate: [-40, 0], duration: 1100, easing: 'easeOutElastic(1, .6)' });
    anime({ targets: '.controls, .topbar', translateY: [24, 0], opacity: [0, 1], delay: anime.stagger(120, { start: 200 }), duration: 700, easing: 'easeOutCubic' });
  }
  Sync.on((msg) => {
    if (msg.type === 'hello') Sync.send({ type: 'config', config: state.config });
    else if (msg.type === 'pong') state.pongs = (state.pongs || 0) + 1;
  });
  Sync.start(state.config.room, state.config);
  window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
})();
