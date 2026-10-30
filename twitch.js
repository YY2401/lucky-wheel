/* 忠誠點轉盤：Twitch 忠誠點兌換 → 自動轉盤 → 寫進 Google 試算表 */
(async () => {
  const { Store, Sync, ui } = LW;
  const { $, $$, wait, esc, toast, dialog, applyTheme, flipTotal } = ui;
  const { Wheel, Sfx } = LuckyWheel;
  const { drawOne, normalizeConfig, normalizePrize, tierOf, probabilities, randId } = LuckyCore;
  const T = TwitchCore;

  // 網站管理者到 dev.twitch.tv 註冊應用程式後填入（公開資訊，不是密碼）。使用者也可在步驟 1「進階」自填
  const BUILTIN_CLIENT_ID = 'owgfsq6jkw61bh7l7cvtbmkfjvbfhf';
  const REDEEM_TYPE = 'channel.channel_points_custom_reward_redemption.add';
  // read：收到兌換通知；manage：建立品項、補抓漏掉的兌換、標成已完成 / 退點（只對這個網頁建立的品項有效）
  // bits:read、channel:read:subscriptions：小奇點、訂閱也轉盤（步驟 7）
  const SCOPES = 'channel:read:redemptions channel:manage:redemptions bits:read channel:read:subscriptions';
  const CHEER_TYPE = 'channel.cheer';
  const SUB_TYPES = ['channel.subscribe', 'channel.subscription.message', 'channel.subscription.gift'];
  const K = { config: 'tw.config', records: 'tw.records', queue: 'tw.queue', auth: 'tw.auth', party: 'tw.party', songs: 'tw.songs' };
  const MAX_RECORDS = 1000;

  Store.onError = (e) => toast(`儲存失敗：${e.message}`, 6000);
  await Store.init(Object.values(K));
  let cfg = T.normalizeTwConfig(Store.get(K.config, null));
  const records = Store.get(K.records, []);
  const queue = Store.get(K.queue, []);
  let auth = Store.get(K.auth, null); // { token, clientId, userId, login, name }
  let party = Store.get(K.party, null) || { playing: [], waiting: [] }; // 排隊陪玩：正在玩、排隊中
  const saveCfg = () => Store.set(K.config, cfg);
  const saveRecords = () => { if (records.length > MAX_RECORDS) records.length = MAX_RECORDS; Store.set(K.records, records); };
  const saveQueue = () => Store.set(K.queue, queue);
  const saveAuth = () => Store.set(K.auth, auth);
  const saveParty = () => Store.set(K.party, party);
  let songs = Store.get(K.songs, null) || { now: null, queue: [], missed: [], paused: false }; // 小奇點點歌：正在播、接下來、沒播的
  const saveSongs = () => Store.set(K.songs, songs);
  saveCfg(); // 第一次開啟時把產生的暗號、頻道代碼存下來

  // 放在 OBS 自訂瀏覽器停駐視窗裡：網址帶 ?dock=1（登入 Twitch 回來網址會變，所以記在 sessionStorage）
  const isDock = (() => {
    let v = new URLSearchParams(location.search).get('dock') === '1' || !!window.obsstudio;
    try { if (v) sessionStorage.setItem('tw.dock', '1'); else v = sessionStorage.getItem('tw.dock') === '1'; } catch { /* ignore */ }
    return v;
  })();
  document.body.classList.toggle('dock', isDock);
  const redirectUri = () => `${location.origin}${location.pathname}`;

  // 複製文字：OBS 面板或沒有權限時剪貼簿可能不能用，退回舊方法，再不行就顯示出來讓人手動複製
  async function copyText(text, label) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* 改用舊方法 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove();
      if (ok) return true;
    } catch { /* 顯示出來 */ }
    await dialog({ title: `請手動複製${label}`, message: '點下面的框，按 Ctrl+A 全選，再按 Ctrl+C 複製：', textarea: text, okLabel: '好了' });
    return false;
  }
  const clientId = () => cfg.clientId || BUILTIN_CLIENT_ID;
  const fmtTime = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  // 兩個轉盤：main＝步驟 4 的忠誠點轉盤，bonus＝步驟 7 的第二個轉盤
  const prizesOf = (w) => (w === 'bonus' ? cfg.wheel2.prizes : cfg.prizes);
  const corePrizes = (w = 'main') => prizesOf(w).map((p, i) => normalizePrize({ id: p.id, name: p.name, weight: p.weight, color: p.color, quantity: -1 }, i));

  // ---------- 只允許一個分頁運作（兩個分頁會把同一筆兌換轉兩次） ----------
  async function becomeLeader() {
    if (!navigator.locks) return true;
    return new Promise((resolve) => {
      navigator.locks.request('lw-twitch-leader', { ifAvailable: true }, (lock) => {
        resolve(!!lock);
        return lock ? new Promise(() => {}) : null; // 拿到就一直握著
      }).catch(() => location.reload()); // 被別的分頁接手：重新整理後會看到鎖定畫面
    });
  }
  // 鎖定畫面按「接手」：搶過鎖（原分頁會重新整理並改成鎖定畫面），這個分頁繼續啟動
  const takeover = () => new Promise((resolve) => {
    $('#takeover').onclick = () => navigator.locks.request('lw-twitch-leader', { steal: true }, () => { resolve(); return new Promise(() => {}); }).catch(() => location.reload());
  });

  // ---------- 主題 ----------
  function setTheme(theme) {
    let keep = null; try { keep = localStorage.getItem('lw.theme'); } catch { /* ignore */ }
    cfg.theme = applyTheme(theme, wheel);
    try { localStorage.setItem('tw.theme', cfg.theme); if (keep) localStorage.setItem('lw.theme', keep); } catch { /* ignore */ } // 不影響主轉盤頁的主題
  }

  // ---------- 轉盤 ----------
  const wheel = new Wheel($('#wheel'), { onTick: (s) => Sfx.tick(s) });
  function updateWheel() {
    wheel.setPrizes(corePrizes(), 'weight', 0.04);
    Sfx.enabled = cfg.sound && !isDock; Sfx.volume = cfg.volume / 100; // OBS 面板不出聲：OBS 畫面那邊已經有音效，避免被桌面音訊錄成兩次
  }

  // ---------- OBS 覆蓋層（沿用主轉盤的 index.html?overlay=1） ----------
  let obsSeen = 0;
  function overlayConfig() {
    return normalizeConfig({
      title: '忠誠點轉盤', prizes: corePrizes(), spinDuration: cfg.spinDuration, turns: cfg.turns, sound: cfg.sound, volume: cfg.volume,
      overlayResultSeconds: cfg.resultSeconds, countdown: 0, theme: cfg.theme, themeChosen: true, bg3d: false, obsBgOpacity: cfg.obsBgOpacity,
      room: cfg.room, secret: cfg.secret, sync: cfg.sync, broker: cfg.broker,
    });
  }
  const sendConfig = () => Sync.send({ type: 'config', config: overlayConfig() });
  function obsUrl() {
    const base = location.href.split(/[?#]/)[0].replace(/twitch\.html$/, '');
    const q = new URLSearchParams({ overlay: '1', room: cfg.room, key: cfg.secret, mode: 'spin' });
    return `${base}index.html?${q}`;
  }

  // ---------- Google 試算表（Apps Script 網頁應用程式） ----------
  async function sheetPost(body, url = cfg.scriptUrl) {
    let resp;
    try {
      resp = await fetch(url, { method: 'POST', body: JSON.stringify({ key: cfg.sheetKey, ...body }) }); // 純文字內容，不會觸發 CORS 預檢
    } catch {
      throw new Error('連不到試算表：請確認網址正確，而且部署時「誰可以存取」選的是「所有人」');
    }
    if (!resp.ok) throw new Error(`試算表回應錯誤（HTTP ${resp.status}）`);
    const text = await resp.text();
    try { return JSON.parse(text); } catch { throw new Error('試算表回應看不懂：請確認貼的是「網頁應用程式」網址（結尾 /exec），不是編輯器網址'); }
  }

  const Writer = {
    busy: false, timer: null, backoff: 0, state: 'idle', lastError: '',
    kick(ms = 0) { clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), ms); },
    async run() {
      if (this.busy) { this.again = true; return; }
      if (!cfg.scriptUrl) { this.state = 'off'; renderStatus(); return; }
      const oldestFirst = [...records].reverse();
      const adds = oldestFirst.filter((r) => r.status === 'pending').slice(0, 25);
      const undos = oldestFirst.filter((r) => r.status === 'undoing').slice(0, 25);
      const moves = oldestFirst.filter((r) => r.status === 'moving' && r.moveTo).slice(0, 25);
      if (!adds.length && !undos.length && !moves.length) { if (this.state !== 'fail') this.state = 'idle'; renderStatus(); return; }
      this.busy = true; this.again = false;
      try {
        for (const [action, list] of [['add', adds], ['undo', undos], ['move', moves]]) {
          if (!list.length) continue;
          const res = await sheetPost({ action, records: list.map(action === 'move' ? T.forMove : T.forSheet) });
          if (!res.ok) {
            if (!res.fatal) throw new Error(res.error || '試算表忙碌中');
            list.forEach((r) => { r.status = action === 'add' ? 'error' : 'ok'; r.error = res.error; r.moveTo = null; });
            continue;
          }
          for (const x of res.results || []) {
            const r = records.find((y) => y.id === x.id); if (!r) continue;
            r.attempts = (r.attempts || 0) + 1;
            if (action === 'move') {
              if (x.ok) Object.assign(r, { movedFrom: T.viewerLabel(r), login: r.moveTo.login, display: r.moveTo.display, userId: r.moveTo.userId || '', status: 'ok', cell: x.cell || r.cell, sheetName: x.name || '', isNew: !!x.isNew, moveTo: null, error: '' });
              else { Object.assign(r, { status: 'ok', moveTo: null }); toast(`改記失敗：${x.error}`, 6000); }
            } else if (action === 'add') {
              if (x.ok) Object.assign(r, { status: 'ok', cell: x.cell || '', sheetName: x.name || '', isNew: !!x.isNew, renamedFrom: x.renamedFrom || '', error: '' });
              else Object.assign(r, { status: 'error', error: x.error || '寫入失敗' });
            } else if (x.ok) Object.assign(r, { status: 'undone', error: '' });
            else { Object.assign(r, { status: 'ok', error: '' }); toast(`撤銷失敗：${x.error}`, 6000); }
          }
        }
        saveRecords();
        this.state = 'ok'; this.lastError = ''; this.backoff = 0;
      } catch (e) {
        this.state = 'fail'; this.lastError = e.message;
        this.backoff = Math.min(60000, Math.max(3000, this.backoff * 2));
        this.kick(this.backoff);
      } finally {
        this.busy = false;
        renderRecords(); renderStatus();
        if (this.again || (this.state === 'ok' && records.some((r) => r.status === 'pending' || r.status === 'undoing' || r.status === 'moving'))) this.kick(300);
      }
    },
  };

  // ---------- Twitch：登入（implicit grant）+ EventSub WebSocket ----------
  const Twitch = {
    ws: null, session: '', state: 'off', error: '', kaSec: 10, kaTimer: null, retry: 0, retryTimer: null, rewards: null,
    managed: new Set(), // 這個網頁建立的品項（才能補抓、退點）
    canManage: false, // 授權裡有沒有 manage 權限（舊的授權只有 read，要重新連接一次）
    login(force = false) {
      if (!clientId()) { this.setState('off', '這個網頁還沒設定 Twitch Client ID：請網站管理者依 README 設定，或在下方「進階」自行填入'); return; }
      const st = randId(16);
      try { sessionStorage.setItem('tw.oauth', st); } catch { /* ignore */ }
      const q = new URLSearchParams({ response_type: 'token', client_id: clientId(), redirect_uri: redirectUri(), scope: SCOPES, state: st, force_verify: force ? 'true' : 'false' });
      leaving = true; // 去 Twitch 登入再回來：紀錄都存著，不用跳「確定要離開？」
      location.href = `https://id.twitch.tv/oauth2/authorize?${q}`;
    },
    // 授權後 Twitch 把 token 放在網址 # 後面帶回來
    takeRedirect() {
      const h = new URLSearchParams(location.hash.slice(1));
      const q = new URLSearchParams(location.search);
      let expect = ''; try { expect = sessionStorage.getItem('tw.oauth') || ''; } catch { /* ignore */ }
      const state = h.get('state') || q.get('state');
      const err = h.get('error') || q.get('error');
      if (!h.get('access_token') && !err) return;
      history.replaceState(null, '', redirectUri());
      if (err) { this.error = err === 'access_denied' ? '你按了取消，沒有授權' : `Twitch 授權失敗：${h.get('error_description') || q.get('error_description') || err}`; return; }
      if (!expect || state !== expect) { this.error = '授權驗證碼不符，請再按一次「連接 Twitch」'; return; }
      auth = { token: h.get('access_token'), clientId: clientId() };
      saveAuth();
    },
    async validate() {
      if (!auth || !auth.token) return false;
      try {
        const r = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${auth.token}` } });
        if (r.status === 401) { this.expire(); return false; }
        const j = await r.json();
        Object.assign(auth, { userId: j.user_id, login: j.login, clientId: j.client_id || auth.clientId, scopes: j.scopes || [], expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : 0 });
        this.canManage = auth.scopes.includes('channel:manage:redemptions');
        this.canBits = auth.scopes.includes('bits:read');
        this.canSubs = auth.scopes.includes('channel:read:subscriptions');
        if (!auth.name) { const u = await this.helix('/users'); if (u.json && u.json.data && u.json.data[0]) auth.name = u.json.data[0].display_name; }
        saveAuth();
        return true;
      } catch { this.setState('offline', '連不到 Twitch，稍後自動重試'); return null; }
    },
    async helix(path, { method = 'GET', body } = {}) {
      const r = await fetch(`https://api.twitch.tv/helix${path}`, { method, headers: { Authorization: `Bearer ${auth.token}`, 'Client-Id': auth.clientId, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      if (r.status === 401) this.expire();
      let json = null; try { json = await r.json(); } catch { /* ignore */ }
      return { status: r.status, json };
    },
    expire() {
      this.stop();
      this.setState('expired', 'Twitch 登入過期了，收不到新的兌換。按「重新連接」登入一次就好（排隊中的不會掉）。');
    },
    async loadRewards() {
      if (!auth || !auth.userId) { this.rewards = null; renderRewards(); return; }
      const base = `/channel_points/custom_rewards?broadcaster_id=${auth.userId}`;
      const r = await this.helix(base);
      this.rewardError = '';
      if (r.status === 200) {
        const m = await this.helix(`${base}&only_manageable_rewards=true`);
        this.managed = new Set(m.status === 200 ? (m.json.data || []).map((x) => x.id) : []);
        this.rewards = (r.json.data || []).map((x) => ({ id: x.id, title: x.title, cost: x.cost, enabled: x.is_enabled, paused: !!x.is_paused, color: x.background_color, skipQueue: !!x.should_redemptions_skip_request_queue, managed: this.managed.has(x.id) }));
      } else if (r.status === 403) { this.rewards = []; this.rewardError = '這個頻道還沒有忠誠點功能（需要是 Twitch 聯盟或合作夥伴）'; }
      else { this.rewards = []; this.rewardError = `讀取品項失敗（${r.status}）`; }
      renderRewards(); renderStatus(); renderParty(); renderPartySetup();
    },
    // 用英文帳號查觀眾：回傳 { login, display, userId }；查不到回 null；連不到 Twitch 回 undefined
    async lookupUser(login) {
      if (!auth || !auth.token) return undefined;
      try {
        const r = await this.helix(`/users?login=${encodeURIComponent(login)}`);
        if (r.status !== 200) return undefined;
        const u = r.json && r.json.data && r.json.data[0];
        return u ? { login: u.login, display: u.display_name || u.login, userId: u.id } : null;
      } catch { return undefined; }
    },
    // 用顯示名稱（例如中文名字）找觀眾：Twitch 沒有直接用名字查的方式，用頻道搜尋找「名字完全一樣」的那一位
    async findByName(name) {
      if (!auth || !auth.token) return undefined;
      try {
        const r = await this.helix(`/search/channels?query=${encodeURIComponent(name)}&first=50`);
        if (r.status !== 200) return undefined;
        const want = String(name).trim().toLowerCase();
        const hit = (r.json.data || []).filter((c) => String(c.display_name || '').toLowerCase() === want || String(c.broadcaster_login || '') === want);
        return hit.length === 1 ? { login: hit[0].broadcaster_login, display: hit[0].display_name || hit[0].broadcaster_login, userId: hit[0].id } : null; // 找不到或同名不只一位都不猜
      } catch { return undefined; }
    },
    // 由這個網頁建立品項：之後才能補抓漏掉的兌換、退點。proxy＝代抽用（觀眾兌換時要輸入幫誰抽）
    async createReward(title, cost, proxy = false, prompt = '') {
      const body = { title, cost, is_enabled: true, should_redemptions_skip_request_queue: false };
      if (proxy) Object.assign(body, { is_user_input_required: true, prompt: '幫別人抽：輸入 @對方的名字或英文帳號（幫自己抽就隨便打一個字）' });
      if (prompt) Object.assign(body, { is_user_input_required: true, prompt });
      const r = await this.helix(`/channel_points/custom_rewards?broadcaster_id=${auth.userId}`, { method: 'POST', body });
      if (r.status === 200 && r.json && r.json.data && r.json.data[0]) return r.json.data[0];
      const msg = (r.json && r.json.message) || '';
      if (/DUPLICATE/i.test(msg)) throw new Error(`頻道裡已經有叫「${title}」的品項了，換個名稱，或直接在下面清單勾選它`);
      if (r.status === 403) throw new Error('這個頻道還沒有忠誠點功能（需要是 Twitch 聯盟或合作夥伴）');
      if (r.status === 401) throw new Error('Twitch 登入過期了，請重新連接');
      throw new Error(`建立失敗（${r.status}${msg ? `：${msg}` : ''}）`);
    },
    // 暫停／恢復品項（只對這個網頁建立的品項有效）
    async pauseReward(id, paused) {
      const r = await this.helix(`/channel_points/custom_rewards?broadcaster_id=${auth.userId}&id=${id}`, { method: 'PATCH', body: { is_paused: paused } });
      if (r.status !== 200) throw new Error(r.status === 403 ? '這個品項是在 Twitch 後台手動建立的，網頁不能暫停它' : `Twitch 回應 ${r.status}`);
    },
    async unfulfilled(rid) {
      const found = [];
      let after = '';
      for (let page = 0; page < 20; page++) {
        const r = await this.helix(`/channel_points/custom_rewards/redemptions?broadcaster_id=${auth.userId}&reward_id=${rid}&status=UNFULFILLED&sort=OLDEST&first=50${after ? `&after=${after}` : ''}`);
        if (r.status !== 200) break;
        found.push(...(r.json.data || []));
        after = r.json.pagination && r.json.pagination.cursor;
        if (!after) break;
      }
      return found;
    },
    // 補抓：Twitch 上還是「未完成」、但這個網頁沒處理過的兌換
    async catchUp() {
      if (!auth || !auth.userId || !this.canManage) return;
      const found = [];
      for (const rid of cfg.rewardIds.filter((id) => this.managed.has(id))) found.push(...(await this.unfulfilled(rid)));
      addMissed(found);
      // 排隊陪玩：網頁關著時兌換的人直接排進隊伍（照兌換順序）
      if (cfg.party.rewardId && this.managed.has(cfg.party.rewardId)) (await this.unfulfilled(cfg.party.rewardId)).forEach((x) => onPartyRedeem(x, true));
    },
    // 把兌換標成已完成 / 退點。回傳 Twitch 確認改好的 id
    async setRedemptions(rewardId, ids, status) {
      const q = ids.map((id) => `id=${encodeURIComponent(id)}`).join('&');
      const r = await this.helix(`/channel_points/custom_rewards/redemptions?${q}&broadcaster_id=${auth.userId}&reward_id=${rewardId}`, { method: 'PATCH', body: { status } });
      if (r.status === 200) return { ok: new Set((r.json.data || []).map((x) => x.id)) };
      if (r.status === 404) return { ok: new Set() }; // 都已經不是「未完成」（例如實況主自己在 Twitch 處理掉了）
      if (r.status === 403) return { notOurs: true }; // 手動建立的品項：Twitch 不讓這個網頁改
      throw new Error(`Twitch 回應 ${r.status}`);
    },
    async start() {
      clearTimeout(this.retryTimer);
      if (!auth || !auth.token) { this.setState('off'); return; }
      if (cfg.movedToObs && !isDock) { this.setState('off', '已搬到 OBS 面板，這個分頁不接收兌換'); return; }
      const ok = await this.validate();
      if (ok === null) { this.scheduleRetry(); return; }
      if (!ok) return;
      this.loadRewards();
      this.connect();
    },
    stop() {
      clearTimeout(this.kaTimer); clearTimeout(this.retryTimer);
      if (this.ws) { this.ws.onclose = null; this.ws.close(); }
      this.ws = null; this.session = '';
    },
    connect(url = 'wss://eventsub.wss.twitch.tv/ws', reconnecting = false) {
      if (!reconnecting) { this.stop(); this.setState('connecting'); }
      const ws = new WebSocket(url);
      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        const type = m.metadata && m.metadata.message_type;
        if (ws === this.ws || type === 'session_welcome') this.keepalive();
        if (type === 'session_welcome') {
          const old = this.ws;
          this.ws = ws; this.session = m.payload.session.id; this.kaSec = m.payload.session.keepalive_timeout_seconds || 10; this.retry = 0;
          this.keepalive();
          if (reconnecting && old && old !== ws) { old.onclose = null; old.close(); this.setState('online'); } // Twitch 要求換線：訂閱會自動帶過來
          else { this.subscribed = new Set(); this.subscribe(); }
        } else if (type === 'session_reconnect') {
          this.connect(m.payload.session.reconnect_url, true);
        } else if (type === 'notification') {
          const st = m.payload.subscription.type;
          if (st === REDEEM_TYPE) onRedemption(m.payload.event);
          else onTrigger(st, m.payload.event, m.metadata.message_id);
        } else if (type === 'revocation') {
          this.expire();
        }
      };
      ws.onclose = () => { if (this.ws && this.ws !== ws) return; this.ws = null; this.setState('offline', '與 Twitch 的連線中斷，正在重新連線…'); this.scheduleRetry(); };
      if (!reconnecting) this.ws = ws;
    },
    keepalive() {
      clearTimeout(this.kaTimer);
      this.kaTimer = setTimeout(() => { if (this.ws) this.ws.close(); }, (this.kaSec + 10) * 1000); // 太久沒消息就當作斷線
    },
    scheduleRetry() {
      clearTimeout(this.retryTimer);
      const ms = [1000, 2000, 5000, 10000, 30000][Math.min(this.retry++, 4)];
      this.retryTimer = setTimeout(() => this.start(), ms);
    },
    async subscribe() {
      const r = await this.helix('/eventsub/subscriptions', { method: 'POST', body: { type: REDEEM_TYPE, version: '1', condition: { broadcaster_user_id: auth.userId }, transport: { method: 'websocket', session_id: this.session } } });
      if (r.status === 202 || r.status === 409) { this.setState('online'); this.loadRewards().then(() => this.catchUp()); TwSync.kick(); this.subscribeExtras(); } // 連上（含斷線重連）就檢查有沒有漏掉的
      else if (r.status === 403) this.setState('error', '沒有權限讀取忠誠點兌換：頻道需要是 Twitch 聯盟或合作夥伴');
      else if (r.status !== 401) { this.setState('offline', `訂閱兌換通知失敗（${r.status}），稍後重試`); if (this.ws) this.ws.close(); }
    },
    // 步驟 7 打開的小奇點、訂閱通知。失敗不影響忠誠點兌換
    subscribed: new Set(), extraError: '', extraTimer: null,
    async subscribeExtras() {
      clearTimeout(this.extraTimer);
      if (!this.session || !auth || !auth.userId || this.state !== 'online') { renderTriggers(); return; }
      const want = [...(cfg.triggers.bits.on || cfg.songs.on ? [[CHEER_TYPE, this.canBits]] : []), ...(cfg.triggers.sub.on ? SUB_TYPES.map((t) => [t, this.canSubs]) : [])];
      let scope = false; let fail = 0;
      for (const [type, can] of want) {
        if (this.subscribed.has(type)) continue;
        if (!can) { scope = true; continue; }
        const r = await this.helix('/eventsub/subscriptions', { method: 'POST', body: { type, version: '1', condition: { broadcaster_user_id: auth.userId }, transport: { method: 'websocket', session_id: this.session } } });
        if (r.status === 202 || r.status === 409) this.subscribed.add(type);
        else if (r.status === 403) scope = true;
        else if (r.status !== 401) fail = fail || r.status;
      }
      this.extraError = scope ? 'scope' : fail ? `收不到小奇點／訂閱通知（Twitch 回應 ${fail}），稍後自動重試` : '';
      if (fail) this.extraTimer = setTimeout(() => this.subscribeExtras(), 60000);
      renderStatus(); renderTriggers(); renderSongSetup();
    },
    setState(s, err = '') { this.state = s; this.error = err; renderStatus(); renderSetup(); },
  };

  // ---------- 兌換 → 排隊 → 轉盤 ----------
  function onRedemption(ev) {
    if (cfg.party.rewardId && ev.reward && ev.reward.id === cfg.party.rewardId) { onPartyRedeem(ev); return; }
    if (!cfg.rewardIds.includes(ev.reward && ev.reward.id)) return;
    if (queue.some((q) => q.id === ev.id) || records.some((r) => r.id === ev.id)) return; // Twitch 偶爾會重送
    queue.push({ id: ev.id, login: ev.user_login, display: ev.user_name, userId: ev.user_id || '', input: ev.user_input || '', reward: ev.reward.title, rewardId: ev.reward.id, at: ev.redeemed_at || new Date().toISOString() });
    missed = missed.filter((m) => m.id !== ev.id);
    saveQueue(); renderQueue(); pump();
  }

  // ---------- 排隊陪玩 ----------
  function onPartyRedeem(ev, quiet = false) {
    const entry = T.partyEntry(ev);
    const res = T.admitParty(party, entry, cfg.party);
    if (res.dup) return;
    if (res.reason) {
      toast(`${entry.display} 的排隊沒有加入（${res.reason}），忠誠點已退還`, 6000);
      partySet([entry], 'CANCELED');
      return;
    }
    party = res.state; saveParty(); renderParty(); sendParty();
    if (!quiet) toast(`${entry.display} 加入排隊（第 ${party.waiting.length} 位）`, 4000);
  }
  // 在 Twitch 上把兌換標成已完成（玩完）或退點（被移出）
  async function partySet(entries, status) {
    if (!entries.length || !auth || !auth.userId) return;
    const byReward = new Map();
    entries.forEach((e) => { if (!byReward.has(e.rewardId)) byReward.set(e.rewardId, []); byReward.get(e.rewardId).push(e.id); });
    try {
      for (const [rid, ids] of byReward) {
        const res = await Twitch.setRedemptions(rid, ids, status);
        if (res.notOurs && status === 'CANCELED') toast('這個品項是在 Twitch 後台手動建立的，網頁不能退點，請到 Twitch 的獎勵請求佇列處理', 8000);
      }
    } catch (e) { toast(`Twitch 沒有更新成功（${e.message}），可以到 Twitch 的獎勵請求佇列手動處理`, 8000); }
  }
  const sendParty = () => { if (cfg.party.rewardId) Sync.send(T.partyView(party, cfg.party)); };
  function renderParty() {
    const on = !!cfg.party.rewardId;
    $('#partyBox').classList.toggle('hidden', !on);
    if (!on) return;
    const rw = Twitch.rewards && Twitch.rewards.find((r) => r.id === cfg.party.rewardId);
    $('#partyTitle').textContent = cfg.party.title;
    $('#partyCount').textContent = party.waiting.length;
    $('#partyPaused').classList.toggle('hidden', !(rw && rw.paused));
    $('#partyPause').textContent = rw && rw.paused ? '恢復排隊' : '暫停排隊';
    $('#partyPause').disabled = !rw;
    const row = (e, i, act) => `<li><span class="tw-li-main">${i != null ? `<span class="tw-no">${i + 1}</span>` : ''}${esc(e.display || e.login)}</span><span class="tw-li-sub">${e.input ? `遊戲 ID：${esc(e.input)} · ` : ''}${fmtTime(e.at)}</span><span class="tw-li-act">${act}</span></li>`;
    $('#partyPlaying').innerHTML = party.playing.length
      ? party.playing.map((e) => row(e, null, `<button class="btn icon" data-party-done="${esc(e.id)}" title="玩完了">完成</button>`)).join('')
      : '<li class="tw-empty">按「下一輪」從隊伍叫人</li>';
    $('#partyWaiting').innerHTML = party.waiting.length
      ? party.waiting.map((e, i) => row(e, i, `<button class="btn icon ghost" data-party-remove="${esc(e.id)}" title="移出隊伍，可選擇退點">移出</button>`)).join('')
      : '<li class="tw-empty">目前沒有人排隊</li>';
    $('#partyNext').disabled = !party.playing.length && !party.waiting.length;
  }
  $('#partyNext').onclick = () => {
    const res = T.nextRound(party, cfg.party.batch);
    party = res.state; saveParty(); renderParty(); sendParty();
    partySet(res.done, 'FULFILLED');
    if (res.called.length) toast(`輪到：${res.called.map((e) => e.display).join('、')}`, 5000);
  };
  $('#partyBox').addEventListener('click', async (e) => {
    const done = e.target.closest('[data-party-done]'); const rm = e.target.closest('[data-party-remove]');
    const id = (done && done.dataset.partyDone) || (rm && rm.dataset.partyRemove);
    const entry = id && [...party.playing, ...party.waiting].find((x) => x.id === id);
    if (!entry) return;
    let status = 'FULFILLED';
    if (rm) {
      if (!(await dialog({ title: `把 ${entry.display} 移出隊伍？`, message: '移出後會從排隊名單拿掉。', okLabel: '移出' }))) return;
      const refund = await dialog({ title: '要退還忠誠點嗎？', message: `退還 ${entry.display} 兌換排隊花的忠誠點。`, okLabel: '退點' });
      status = refund ? 'CANCELED' : 'FULFILLED';
    }
    party = T.removeParty(party, id); saveParty(); renderParty(); sendParty();
    partySet([entry], status);
  });
  $('#partyPause').onclick = async () => {
    const rw = Twitch.rewards && Twitch.rewards.find((r) => r.id === cfg.party.rewardId); if (!rw) return;
    try { await Twitch.pauseReward(rw.id, !rw.paused); rw.paused = !rw.paused; toast(rw.paused ? '已暫停：觀眾暫時不能兌換排隊' : '已恢復排隊'); } catch (err) { toast(err.message, 6000); }
    renderParty();
  };

  // ---------- 小奇點點歌 ----------
  function onSongCheer(ev, msgId) {
    const named = !!ev.user_login && ev.is_anonymous !== true;
    const req = { id: `song-${msgId}`, videoId: T.youtubeId(ev.message), bits: Number(ev.bits) || 0, login: named ? String(ev.user_login).toLowerCase() : '', display: named ? ev.user_name || ev.user_login : '匿名', userId: named ? String(ev.user_id || '') : '', title: '', at: new Date().toISOString() };
    const res = T.admitSong(songs, req, cfg.songs);
    if (res.dup) return;
    songs = res.state;
    if (res.reason) toast(`${req.display} 的點歌沒有排進去（${res.reason}），列在「沒播的點歌」`, 7000);
    else { if (!songs.now) songs = T.nextSong(songs); toast(`${req.display} 點了一首歌（${songs.now && songs.now.id === req.id ? '馬上播' : `排第 ${songs.queue.length} 首`}）`, 4000); }
    songsChanged();
  }
  const songsChanged = () => { saveSongs(); renderSongs(); sendSongs(); };
  const sendSongs = () => { if (cfg.songs.on || songs.now || songs.queue.length) Sync.send({ ...T.songView(songs, cfg.songs), paused: songs.paused }); };
  // OBS 點歌播放器回報：讀到歌名、播完、播不了
  const YT_ERR = { 2: '連結格式不對', 5: '這部影片播不了', 100: '影片不存在或已經刪除', 101: '影片作者不允許在其他網站播放', 150: '影片作者不允許在其他網站播放' };
  function onSongEvent(msg) {
    if (!songs.now || msg.id !== songs.now.id) return; // 好幾個 OBS 來源同時回報時只算一次
    if (msg.event === 'title') { if (songs.now.title !== msg.title) { songs.now.title = String(msg.title || '').slice(0, 120); songsChanged(); } return; }
    if (msg.event === 'error') songs.missed = [{ ...songs.now, reason: YT_ERR[msg.code] || `播放失敗（${msg.code}）` }, ...songs.missed].slice(0, 50);
    songs = { ...T.nextSong(songs), paused: false };
    songsChanged();
  }
  function renderSongs() {
    const on = cfg.songs.on || !!songs.now || songs.queue.length > 0 || songs.missed.length > 0;
    $('#songBox').classList.toggle('hidden', !on);
    if (!on) return;
    const ytLink = (x) => `https://youtu.be/${x.videoId}`;
    const row = (x, i, act, sub) => `<li><span class="tw-li-main">${i != null ? `<span class="tw-no">${i + 1}</span>` : ''}${esc(x.title || ytLink(x))}</span><span class="tw-li-sub">${esc(sub || `${x.display}${x.bits ? ` · ${x.bits} 小奇點` : ''} · ${fmtTime(x.at)}`)}</span><span class="tw-li-act">${act}</span></li>`;
    $('#songCount').textContent = songs.queue.length;
    $('#songPausedTag').classList.toggle('hidden', !songs.paused);
    $('#songPause').textContent = songs.paused ? '繼續' : '暫停';
    $('#songNow').innerHTML = songs.now ? row(songs.now, null, '') : '<li class="tw-empty">目前沒有歌</li>';
    $('#songQueue').innerHTML = songs.queue.length ? songs.queue.map((x, i) => row(x, i, `<button class="btn icon ghost" data-song-remove="${esc(x.id)}">刪除</button>`)).join('') : '<li class="tw-empty">沒有排隊的歌</li>';
    $('#songMissedBox').classList.toggle('hidden', !songs.missed.length);
    $('#songMissedCount').textContent = songs.missed.length;
    $('#songMissed').innerHTML = songs.missed.map((x) => row(x, null, `${x.videoId ? `<button class="btn icon" data-song-play="${esc(x.id)}">播</button>` : ''}<button class="btn icon ghost" data-song-drop="${esc(x.id)}">刪除</button>`, `${x.display}${x.bits ? ` · ${x.bits} 小奇點` : ''} · ${x.reason}`)).join('');
    ['#songSkip', '#songPause', '#songBlock'].forEach((sel) => { $(sel).disabled = !songs.now; });
  }
  $('#songSkip').onclick = () => { songs = { ...T.nextSong(songs), paused: false }; songsChanged(); };
  $('#songPause').onclick = () => { songs.paused = !songs.paused; songsChanged(); };
  $('#songBlock').onclick = async () => {
    if (!songs.now) return;
    if (!(await dialog({ title: '封鎖這首？', message: `「${songs.now.title || songs.now.videoId}」會馬上跳過，以後有人再點也不會播。`, okLabel: '封鎖' }))) return;
    cfg.songs.blocked = [...cfg.songs.blocked, songs.now.videoId]; cfg = T.normalizeTwConfig(cfg); saveCfg();
    songs = { ...T.nextSong(songs), paused: false }; songsChanged();
  };
  $('#songAdd').onclick = async () => {
    const v = await dialog({ title: '加一首歌', message: '貼上 YouTube 連結：', input: '', okLabel: '加入' });
    if (v === null) return;
    const videoId = T.youtubeId(v);
    if (!videoId) { toast('看不出是 YouTube 連結'); return; }
    const me = (auth && (auth.name || auth.login)) || '實況主';
    const res = T.admitSong(songs, { id: `song-m-${randId(8)}`, videoId, bits: 0, login: '', display: me, userId: '', title: '', at: new Date().toISOString() }, { ...cfg.songs, minBits: 0, blocked: [] });
    if (res.reason) { toast(res.reason); return; }
    songs = res.state; if (!songs.now) songs = T.nextSong(songs); songsChanged();
  };
  $('#songBox').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-song-remove]'); const play = e.target.closest('[data-song-play]'); const drop = e.target.closest('[data-song-drop]');
    if (rm) songs = { ...songs, queue: songs.queue.filter((x) => x.id !== rm.dataset.songRemove) };
    else if (drop) songs = { ...songs, missed: songs.missed.filter((x) => x.id !== drop.dataset.songDrop) };
    else if (play) { // 實況主決定照樣播：排到隊伍最後面
      const x = songs.missed.find((m) => m.id === play.dataset.songPlay); if (!x) return;
      const { reason, ...item } = x; void reason;
      songs = { ...songs, missed: songs.missed.filter((m) => m.id !== x.id), queue: [...songs.queue, item] };
      if (!songs.now) songs = T.nextSong(songs);
    } else return;
    songsChanged();
  });

  // ---------- 小奇點、訂閱 → 依步驟 7 的規則轉幾次 ----------
  const seenEvents = new Set(); // Twitch 偶爾會重送同一則通知（小奇點零頭不能算兩次）
  function onTrigger(type, ev, msgId) {
    const id = `ev-${msgId}`;
    if (!msgId || seenEvents.has(id) || queue.some((q) => q.id === id) || records.some((r) => r.id === id || r.src === id)) return;
    seenEvents.add(id);
    // 訊息裡有 YouTube 連結：算點歌，不轉盤
    if (type === CHEER_TYPE && cfg.songs.on && T.youtubeId(ev.message)) { onSongCheer(ev, msgId); return; }
    const res = T.triggerSpins(type, ev, cfg.triggers, cfg.bitsCarry);
    if (!res) return;
    if (res.carryKey) { cfg.bitsCarry = T.setCarry(cfg.bitsCarry, res.carryKey, res.carry); saveCfg(); }
    if (!res.spins) {
      if (res.source === 'bits') toast(`${res.who.display} 送了 ${ev.bits} 小奇點${res.carryKey ? `，累積 ${res.carry}／${cfg.triggers.bits.per}，還不到一次` : '，沒達到門檻'}`, 5000);
      return;
    }
    queue.push({ id, ...res.who, reward: res.label, rewardId: '', source: res.source, wheel: res.wheel, count: res.spins, at: new Date().toISOString() });
    saveQueue(); renderQueue(); pump();
  }

  // ---------- 補抓：網頁關著（或斷線）時漏掉的兌換，先列給實況主確認 ----------
  let missed = [];
  const knownIds = () => [...records.map((r) => r.id), ...queue.map((q) => q.id)];
  function addMissed(list) {
    const fresh = T.missedRedemptions(list, [...knownIds(), ...missed.map((m) => m.id)]);
    if (!fresh.length) return;
    missed = [...missed, ...fresh].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    renderStatus();
    if (leader) openCatchup();
  }
  function openCatchup() {
    const known = new Set(knownIds());
    missed = missed.filter((m) => !known.has(m.id));
    if (!missed.length) { $('#catchupModal').classList.add('hidden'); renderStatus(); return; }
    $('#catchupCount').textContent = missed.length;
    $('#catchupList').innerHTML = missed.map((m) => `<li><input type="checkbox" value="${esc(m.id)}" checked><span class="tw-li-main">${esc(m.display || m.login)}</span><span class="tw-li-sub">${esc(m.reward)} · 兌換時間 ${fmtTime(m.at)}</span></li>`).join('');
    $('#catchupModal').classList.remove('hidden');
  }
  $('#catchupList').addEventListener('click', (e) => { const li = e.target.closest('li'); if (li && e.target.tagName !== 'INPUT') { const c = $('input', li); c.checked = !c.checked; } });
  $('#catchupAll').onclick = () => $$('#catchupList input').forEach((c) => { c.checked = true; });
  $('#catchupNone').onclick = () => $$('#catchupList input').forEach((c) => { c.checked = false; });
  $('#catchupLater').onclick = () => { $('#catchupModal').classList.add('hidden'); renderStatus(); };
  $('#catchupGo').onclick = async () => {
    const pick = new Set($$('#catchupList input:checked').map((c) => c.value));
    const go = missed.filter((m) => pick.has(m.id));
    const refund = missed.filter((m) => !pick.has(m.id));
    if (refund.length) {
      $('#catchupModal').classList.add('hidden');
      const names = refund.slice(0, 5).map((m) => m.display).join('、') + (refund.length > 5 ? '…' : '');
      if (!(await dialog({ title: `退還 ${refund.length} 筆的忠誠點？`, message: `沒勾的 ${refund.length} 筆（${names}）不轉盤，忠誠點會退還給觀眾。`, okLabel: '確定' }))) { $('#catchupModal').classList.remove('hidden'); return; }
    }
    $('#catchupModal').classList.add('hidden');
    missed = [];
    go.forEach((m) => queue.push({ ...m }));
    saveQueue(); renderQueue(); renderStatus(); pump();
    if (!refund.length) return;
    const byReward = new Map();
    refund.forEach((m) => { if (!byReward.has(m.rewardId)) byReward.set(m.rewardId, []); byReward.get(m.rewardId).push(m.id); });
    let refunded = 0;
    try {
      for (const [rid, ids] of byReward) { const res = await Twitch.setRedemptions(rid, ids, 'CANCELED'); refunded += res.ok ? res.ok.size : 0; }
      toast(`已退還 ${refunded} 筆忠誠點${go.length ? `，開始補轉 ${go.length} 筆` : ''}`, 5000);
    } catch (e) { toast(`退點失敗：${e.message}。可以到 Twitch 的獎勵請求佇列手動退`, 8000); }
  };

  // ---------- Twitch 兌換狀態：可退點期滿標成已完成、撤銷時退點 ----------
  const TwSync = {
    timer: null, busy: false,
    kick(ms = 0) { clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), ms); },
    async run() {
      if (this.busy || !leader) return;
      if (!auth || !auth.userId || !Twitch.canManage || Twitch.state === 'expired' || (cfg.movedToObs && !isDock)) { this.kick(60000); return; }
      this.busy = true;
      let fail = false;
      try {
        for (const job of T.dueTwitchUpdates(records)) {
          let res;
          try { res = await Twitch.setRedemptions(job.rewardId, job.ids, job.status); } catch { fail = true; continue; }
          for (const id of job.ids) {
            const r = records.find((x) => x.id === id); if (!r) continue;
            if (res.notOurs) { r.tw = ''; continue; } // 手動建立的品項：不歸這個網頁管
            if (job.status === 'FULFILLED') r.tw = 'fulfilled'; // 沒在回應裡＝已經不是未完成，一樣當作處理完
            else if (res.ok.has(id)) r.tw = 'canceled';
            else { r.tw = 'cancel-failed'; toast(`${r.display} 的忠誠點沒退成：這筆在 Twitch 已經被處理過了`, 8000); }
          }
        }
        saveRecords(); renderRecords();
      } finally {
        this.busy = false;
        const next = T.nextHoldExpiry(records);
        this.kick(fail ? 60000 : next ? Math.min(Math.max(next - Date.now() + 1000, 1000), 3600000) : 3600000);
      }
    },
  };

  let spinning = false;
  let leader = false; // 拿到分頁鎖之後才開始轉盤
  async function pump() {
    if (spinning || !leader || (cfg.movedToObs && !isDock)) return;
    spinning = true;
    try {
      while (queue.length) {
        const q = queue[0];
        const w = q.wheel === 'bonus' ? 'bonus' : 'main';
        const n = Math.max(1, Math.trunc(q.count) || 1); // 小奇點、訂閱一次可能轉好幾次
        const picks = [];
        for (let k = 0; k < n; k++) {
          const core = drawOne(corePrizes(w));
          const prize = core && prizesOf(w).find((p) => p.id === core.id);
          if (!prize) break;
          picks.push(prize);
        }
        if (picks.length < n) { toast(`${w === 'bonus' ? '第二個轉盤' : '轉盤'}沒有可抽的獎項：請到設定的步驟 ${w === 'bonus' ? 7 : 4} 檢查權重`, 8000); break; }
        const at = new Date(q.at); const when = Number.isNaN(at.getTime()) ? new Date() : at; // 用兌換當下的時間決定日期（排隊跨過午夜也不會記錯天）
        const who = await proxyFor(q);
        const recs = picks.map((prize, k) => T.makeRecord({ id: n > 1 ? `${q.id}.${k + 1}` : q.id, src: n > 1 ? q.id : '', source: q.source, login: who.login, display: who.display, userId: who.userId, by: who.by, note: who.note, reward: q.reward, rewardId: q.rewardId, prize, now: when, cutoffHour: cfg.cutoffHour, test: !!q.test }));
        records.unshift(...recs); queue.shift();
        saveRecords(); saveQueue(); renderQueue(); renderRecords();
        Writer.kick(); // 先寫入再播動畫：就算中途關掉網頁也不會漏記
        await animate(recs, w);
      }
    } finally { spinning = false; }
  }

  // 代抽：兌換時輸入了「@帳號」就記給那個人（先向 Twitch 確認帳號存在）；查不到就記給兌換的人並註明
  async function proxyFor(q) {
    const self = { login: q.login, display: q.display, userId: q.userId, by: null, note: '' };
    const target = q.test ? null : T.proxyTarget(q.input);
    if (!target) return self;
    const me = String(q.login || '').toLowerCase();
    if (target.login === me || (target.name && target.name.toLowerCase() === String(q.display || '').toLowerCase())) return self;
    const label = target.login || target.name;
    const u = target.login ? await Twitch.lookupUser(target.login) : await Twitch.findByName(target.name);
    // 找不到（或同名不只一位）：先記給兌換的人，紀錄上一定註明，讓實況主用「改記給…」更正
    if (!u) return { ...self, note: `${u === null ? '找不到' : '查不到'} @${label}，先記給 ${q.display}，可以按「改記給…」更正` };
    if (u.login === me) return self;
    return { login: u.login, display: u.display, userId: u.userId, by: { login: q.login, display: q.display }, note: '' };
  }

  async function animate(recs, w = 'main') {
    const rec = recs[0]; const n = recs.length;
    const cp = corePrizes(w);
    const probs = probabilities(cp);
    const tierFor = (r) => { const p = cp.find((x) => x.id === r.prizeId); return p ? tierOf(p, probs[p.id]) : 'normal'; };
    const tiers = recs.map(tierFor);
    const who = T.viewerLabel(rec);
    const what = rec.status === 'test' ? `試轉中…${rec.source ? `（模擬${esc(rec.reward)}）` : ''}` : rec.by ? `${esc(rec.by.display)} 幫忙抽「${esc(rec.reward)}」` : rec.source ? esc(rec.reward) : `兌換了「${esc(rec.reward)}」`;
    $('#nowBanner').innerHTML = `<span class="tw-now-who">${esc(rec.display || rec.login)}</span><span class="tw-now-label">${what}${n > 1 ? ` · 轉 ${n} 次` : ''}</span>`;
    $('#nowBanner').classList.add('active');
    $('#lastResult').classList.add('hidden');
    if (w === 'bonus') await wheel.setPrizes(cp, 'weight', 0.04);
    const each = n > 1 && cfg.triggers.multi === 'each';
    const ovPrizes = normalizeConfig({ prizes: cp }).prizes;
    Sync.send({ type: 'spin', batchId: rec.src || rec.id, batchType: n > 1 ? `${n} 連抽` : '', count: n, player: rec.by ? `${who}（${rec.by.display} 代抽）` : rec.source ? `${who}（${rec.reward}）` : who, results: recs.map((r, i) => ({ rid: r.id, index: i + 1, prizeId: r.prizeId, name: r.prize, image: '', color: r.color, tier: tiers[i] })), prizes: ovPrizes, reveal: each ? 'each' : 'flip', pity: '', countdown: 0 });
    // 視窗縮小或分頁在背景時瀏覽器會暫停動畫，spinTo 不會結束；用時間保底，排隊才不會卡住
    await Promise.race([wheel.spinTo(rec.prizeId, { duration: cfg.spinDuration, turns: cfg.turns }), wait(cfg.spinDuration + 800)]);
    if (tiers.includes('big')) Sfx.fanfare(); else Sfx.win();
    wheel.focus(1400);
    const last = $('#lastResult');
    last.style.setProperty('--c', rec.color || '#888');
    const counts = new Map(); recs.forEach((r) => counts.set(r.prize, (counts.get(r.prize) || 0) + 1));
    last.innerHTML = `<span class="tw-last-who">${esc(rec.display || rec.login)}</span> 轉到 ${[...counts].map(([name, c]) => `<b>${esc(name)}</b>${n > 1 ? ` ×${c}` : ''}`).join('、')}`;
    last.classList.remove('hidden');
    // 一次轉好幾次時 OBS 畫面要播比較久：控制面板跟著等，下一位才不會把它快轉掉
    const extra = n > 1 ? (each ? (n - 1) * (overlayConfig().multiSpinDuration + 350) : flipTotal(n, true)) : 0;
    await wait(cfg.resultSeconds * 1000 + 400 + extra);
    if (w === 'bonus') updateWheel();
    $('#nowBanner').classList.remove('active');
    $('#nowBanner').innerHTML = '<span class="tw-now-label">等待兌換中…</span>';
  }

  // ---------- 畫面：狀態 ----------
  function sheetSummary() {
    const pending = records.filter((r) => r.status === 'pending' || r.status === 'undoing' || r.status === 'moving').length;
    const failed = records.filter((r) => r.status === 'error').length;
    return { pending, failed };
  }
  function pill(el, cls, text, title) { el.className = `tw-pill ${cls}`; $('span', el).textContent = text; el.title = title; }
  function renderStatus() {
    const twText = { online: 'Twitch 已連線', connecting: 'Twitch 連線中', offline: 'Twitch 重新連線中', expired: 'Twitch 需要重新登入', error: 'Twitch 無法接收', off: 'Twitch 未連接' }[Twitch.state] || 'Twitch';
    pill($('#pillTwitch'), { online: 'ok', connecting: 'wait', offline: 'wait', expired: 'bad', error: 'bad' }[Twitch.state] || '', twText, Twitch.error || twText);
    const { pending, failed } = sheetSummary();
    if (!cfg.scriptUrl) pill($('#pillSheet'), '', '試算表未連接', '到設定的步驟 3 連接');
    else if (Writer.state === 'fail') pill($('#pillSheet'), 'bad', `試算表寫入失敗${pending ? `（${pending} 筆等待）` : ''}`, Writer.lastError);
    else if (failed) pill($('#pillSheet'), 'bad', `試算表 ${failed} 筆失敗`, '在「最近紀錄」查看原因');
    else if (pending) pill($('#pillSheet'), 'wait', `試算表寫入中（${pending}）`, '');
    else pill($('#pillSheet'), 'ok', '試算表已連線', '');
    const obsOk = Date.now() - obsSeen < 10 * 60 * 1000;
    pill($('#pillObs'), obsOk ? 'ok' : '', obsOk ? 'OBS 已連線' : 'OBS', obsOk ? '' : '還沒收到 OBS 畫面回應：開著 OBS 時按設定步驟 5 的「測試 OBS」');

    // 最上方的提醒列：只顯示最要緊的一件事
    let alert = null;
    if (Twitch.state === 'expired') alert = { text: Twitch.error, btn: '重新連接 Twitch', act: () => Twitch.login() };
    else if (Twitch.state === 'error') alert = { text: Twitch.error, btn: '到設定', act: () => showSetup(1) };
    else if (missed.length) alert = { text: `網頁關著時有 ${missed.length} 筆兌換還沒轉`, btn: '查看並補轉', act: openCatchup };
    else if (Writer.state === 'fail' && cfg.scriptUrl) alert = { text: `試算表寫入失敗：${Writer.lastError}（每隔一段時間會自動重試，紀錄都還在）`, btn: '立刻重試', act: () => Writer.kick() };
    else if (failed) {
      const err = records.find((r) => r.status === 'error');
      // 跨年還沒開新年度：直接給「開新年度」
      const yearErr = records.find((r) => r.status === 'error' && /開新年度/.test(r.error));
      alert = yearErr ? { text: `有 ${failed} 筆沒寫進試算表：${yearErr.error}`, btn: '開新年度', act: () => openNewYear(Number(yearErr.date.slice(0, 4))) }
        : { text: `有 ${failed} 筆沒寫進試算表：${err.error}`, btn: '全部重新寫入', act: retryAll };
    }
    else if (Twitch.extraError === 'scope') alert = { text: '要收到小奇點、訂閱通知，請重新連接 Twitch 一次（多兩項讀取權限）', btn: '重新連接 Twitch', act: () => Twitch.login() };
    else if (Twitch.extraError) alert = { text: Twitch.extraError, btn: '到設定', act: () => showSetup(7) };
    else if (auth && auth.userId && auth.scopes && !Twitch.canManage) alert = { text: '新功能：重新連接 Twitch 一次，就能補抓網頁關著時的兌換、撤銷時退點', btn: '重新連接 Twitch', act: () => Twitch.login() };
    $('#alert').classList.toggle('hidden', !alert);
    if (alert) { $('#alertText').textContent = alert.text; $('#alertBtn').textContent = alert.btn; $('#alertBtn').onclick = alert.act; }
    $('#retryAll').classList.toggle('hidden', !failed);
  }

  // ---------- 畫面：排隊與紀錄 ----------
  function renderQueue() {
    $('#queueCount').textContent = queue.length;
    $('#queueList').innerHTML = queue.length
      ? queue.map((q) => `<li><span class="tw-li-main">${esc(q.display || q.login)}</span><span class="tw-li-sub">${esc(q.test ? '試轉' : q.reward)}${q.count > 1 ? ` · 轉 ${q.count} 次` : ''} · ${fmtTime(q.at)}</span></li>`).join('')
      : '<li class="tw-empty">目前沒有人排隊</li>';
  }
  const STATUS_TEXT = { moving: '改記中…', pending: '寫入中…', ok: '已寫入', error: '寫入失敗', undoing: '撤銷中…', undone: '已撤銷', test: '試轉（不記錄）', nowrite: '不寫進試算表' };
  function renderRecords() {
    const list = records.slice(0, 60);
    $('#recordList').innerHTML = list.length ? list.map((r) => {
      const actions = r.status === 'error' ? `<button class="btn icon" data-retry="${esc(r.id)}">重試</button>`
        : r.status === 'ok' ? `<button class="btn icon ghost" data-undo="${esc(r.id)}" title="從試算表減回去">撤銷</button>`
          : r.status === 'nowrite' && r.tw === 'hold' ? `<button class="btn icon ghost" data-undo="${esc(r.id)}" title="作廢這一筆，可選擇退點">撤銷</button>` : '';
      const canMove = ['ok', 'pending', 'error', 'nowrite'].includes(r.status);
      const move = canMove ? `<button class="btn icon ghost" data-move="${esc(r.id)}" title="代抽記錯人：改記到另一位觀眾">改記給…</button>` : '';
      const extra = (r.source ? ` · ${r.reward}` : '') + (r.by ? ` · ${r.by.display} 代抽` : '') + (r.note ? ` · ${r.note}` : '') + (r.movedFrom ? ` · 由 ${r.movedFrom} 改記` : '');
      const tw = { canceled: ' · 已退還忠誠點', 'to-cancel': ' · 退點中…', 'cancel-failed': ' · 退點失敗' }[r.tw] || '';
      const detail = extra + (r.status === 'ok' ? ` · ${r.cell}${r.isNew ? ' · 新觀眾已加入名單' : ''}${r.renamedFrom ? ` · 改過帳號，名單已從 ${r.renamedFrom} 更新` : ''}` : r.status === 'error' ? ` · ${r.error}` : '') + tw;
      return `<li class="st-${r.status}">
        <span class="tw-dot" style="--c:${esc(r.color || '#888')}"></span>
        <span class="tw-li-main">${esc(r.display || r.login)} → <b>${esc(r.prize)}</b></span>
        <span class="tw-li-sub">${fmtTime(r.time)} · <span class="tw-st">${STATUS_TEXT[r.status] || r.status}</span>${detail ? ` · ${esc(detail.replace(/^ · /, ''))}` : ''}</span>
        <span class="tw-li-act">${actions}${move}</span></li>`;
    }).join('') : '<li class="tw-empty">還沒有紀錄。觀眾兌換後會出現在這裡。</li>';
  }
  function retryAll() { records.forEach((r) => { if (r.status === 'error') { r.status = 'pending'; r.error = ''; } }); saveRecords(); renderRecords(); Writer.kick(); }
  $('#retryAll').onclick = retryAll;
  $('#recordList').addEventListener('click', async (e) => {
    const retry = e.target.closest('[data-retry]'); const undo = e.target.closest('[data-undo]'); const mv = e.target.closest('[data-move]');
    if (mv) { const r = records.find((x) => x.id === mv.dataset.move); if (r) reassign(r); return; }
    if (retry) { const r = records.find((x) => x.id === retry.dataset.retry); if (r) { r.status = 'pending'; r.error = ''; saveRecords(); renderRecords(); Writer.kick(); } }
    if (undo) {
      const r = records.find((x) => x.id === undo.dataset.undo); if (!r) return;
      const refund = await askUndo(r);
      if (refund === null) return;
      r.status = r.status === 'nowrite' ? 'undone' : 'undoing'; // 沒寫進試算表的就不用去試算表減
      if (refund) r.tw = 'to-cancel';
      saveRecords(); renderRecords(); Writer.kick(); if (refund) TwSync.kick();
    }
  });
  // 改記給別人：已寫進試算表的就從原本的人移到新的人；還沒寫的直接換人
  async function reassign(r) {
    const name = await dialog({ title: '改記給哪位觀眾？', message: `「${r.prize}」目前記在 ${T.viewerLabel(r)}。輸入要改記的觀眾：英文帳號最準（例如 xiaomei），也可以是試算表裡的名稱。${r.by ? `\n點數是 ${r.by.display} 花的，退點會退給 ${r.by.display}。` : ''}`, input: '', okLabel: '改記' });
    if (!name || !name.trim()) return;
    const v = T.parseViewer(name.replace(/^@/, ''));
    let login = v.login || (/^[a-z0-9_]{3,25}$/i.test(v.display) ? v.display.toLowerCase() : '');
    let display = v.display || login; let userId = '';
    if (!login && display) { // 中文名字：向 Twitch 找名字完全一樣的觀眾
      const u = await Twitch.findByName(display);
      if (u) ({ login, display, userId } = u);
    } else if (login) {
      const u = await Twitch.lookupUser(login);
      if (u === null && !(await dialog({ title: `Twitch 上找不到 ${login}`, message: '可能打錯帳號。還是要照這個名稱記嗎？（試算表會用這個名稱找人，找不到就新增一列）', okLabel: '照樣記' }))) return;
      if (u) ({ login, display, userId } = u);
    }
    if (login && login === r.login) { toast('跟目前記的是同一位觀眾'); return; }
    const to = { login, display, userId };
    if (r.status === 'ok') { r.moveTo = to; r.moveSeq = (r.moveSeq || 0) + 1; r.status = 'moving'; }
    else { r.movedFrom = T.viewerLabel(r); Object.assign(r, to); if (r.status === 'error') { r.status = 'pending'; r.error = ''; } }
    saveRecords(); renderRecords(); Writer.kick();
  }
  // 撤銷視窗：回傳 true（退點）/ false（不退）/ null（取消）
  function refundBlocker(r) {
    if (r.source) return '小奇點、訂閱觸發的轉盤沒有忠誠點可退（Twitch 也不提供退小奇點、訂閱）。';
    if (!r.rewardId) return '這筆不是觀眾兌換來的（手動補登），沒有忠誠點可退。';
    if (!Twitch.canManage) return '要先重新連接 Twitch 一次，才能從這裡退點。';
    if (!Twitch.managed.has(r.rewardId) || r.tw === '') return '這個品項是在 Twitch 後台手動建立的，網頁不能退點；請到 Twitch 的獎勵請求佇列處理。';
    if (r.tw === 'fulfilled') return '已經超過 24 小時可退點期限，在 Twitch 上已標成完成，不能退點了。';
    if (r.tw !== 'hold') return '這筆在 Twitch 上已經處理過了，不能退點。';
    return '';
  }
  function askUndo(r) {
    return new Promise((resolve) => {
      const block = refundBlocker(r);
      $('#undoMsg').textContent = r.status === 'nowrite' ? `作廢 ${T.viewerLabel(r)} 的「${r.prize}」（這格沒有寫進試算表）。` : `把 ${T.viewerLabel(r)} 的「${r.prize}」從試算表（${r.cell}）減回去。`;
      $('#undoRefundYes').disabled = !!block;
      $('#undoRefundYes').closest('label').classList.toggle('disabled', !!block);
      $('#undoRefundHint').textContent = block || `忠誠點會退回給 ${r.display}（可退到 ${fmtTime(new Date(r.holdUntil).toISOString())}）`;
      $(block ? '#undoRefundNo' : '#undoRefundYes').checked = true;
      $('#undoModal').classList.remove('hidden');
      const done = (v) => { $('#undoModal').classList.add('hidden'); $('#undoOk').onclick = $('#undoCancel').onclick = null; resolve(v); };
      $('#undoOk').onclick = () => done($('#undoRefundYes').checked);
      $('#undoCancel').onclick = () => done(null);
    });
  }

  // ---------- 直播畫面按鈕 ----------
  $('#manualAdd').onclick = async () => {
    const name = await dialog({ title: '手動補一筆', message: '輸入觀眾名稱：可以是「顯示名稱(帳號)」、帳號，或試算表裡的名稱。會轉一次並寫進試算表。', input: '', okLabel: '轉！' });
    if (!name || !name.trim()) return;
    const v = T.parseViewer(name);
    const login = v.login || (/^[a-z0-9_]{3,25}$/i.test(v.display) ? v.display.toLowerCase() : '');
    queue.push({ id: `m-${randId(10)}`, login, display: v.display || login, reward: '手動補登', at: new Date().toISOString() });
    saveQueue(); renderQueue(); pump();
  };
  $('#testSpin').onclick = () => {
    queue.push({ id: `t-${randId(10)}`, login: '', display: '測試', reward: '試轉', at: new Date().toISOString(), test: true });
    saveQueue(); renderQueue(); pump();
  };

  // ---------- 設定畫面 ----------
  function stepDone() {
    return {
      1: Twitch.state === 'online' || (!!auth && !!auth.userId && Twitch.state !== 'expired' && Twitch.state !== 'error'),
      2: cfg.rewardIds.length > 0,
      3: !!cfg.scriptUrl && cfg.sheetOk === cfg.scriptUrl,
      6: isDock || cfg.movedToObs,
    };
  }
  function renderSetup() {
    renderCreate();
    const done = stepDone();
    [1, 2, 3, 6].forEach((n) => $(`#step${n}`).classList.toggle('done', done[n]));
    const signedIn = !!(auth && auth.userId);
    $('#twOff').classList.toggle('hidden', signedIn);
    $('#twOn').classList.toggle('hidden', !signedIn);
    if (signedIn) $('#twUser').textContent = auth.name && auth.name.toLowerCase() !== auth.login ? `${auth.name}（${auth.login}）` : auth.login;
    const err = Twitch.state === 'expired' || Twitch.state === 'error' || (!signedIn && Twitch.error) ? Twitch.error : '';
    $('#twErr').textContent = err; $('#twErr').classList.toggle('hidden', !err);
    if (Twitch.state === 'expired') { $('#twOff').classList.remove('hidden'); $('#twLogin').textContent = '重新連接 Twitch'; }
    const missing = [!done[1] && '連接 Twitch', !done[2] && '選擇品項', !done[3] && '連接試算表'].filter(Boolean);
    $('#finishHint').textContent = missing.length ? `還沒完成：${missing.join('、')}` : '都設定好了！';
  }
  function renderRewards() {
    const box = $('#rewards');
    if (!auth || !auth.userId) { box.innerHTML = '<p class="hint">先完成步驟 1。</p>'; return; }
    if (Twitch.rewards === null) { box.innerHTML = '<p class="hint">讀取中…</p>'; return; }
    if (!Twitch.rewards.length) { box.innerHTML = `<p class="tw-err">${esc(Twitch.rewardError || '這個頻道還沒有任何忠誠點品項。')}</p>`; return; }
    const tag = (r) => (!r.managed ? '<span class="tw-tag meh" title="在 Twitch 後台手動建立：網頁開著才收得到、不能退點">手動建立</span>'
      : r.skipQueue ? '<span class="tw-tag warn" title="這個品項被設成「略過獎勵請求佇列」，兌換會直接變成已完成，補抓和退點都無效">略過佇列：無法補抓</span>'
        : '<span class="tw-tag good" title="網頁關著時的兌換可以補抓，撤銷時可以退點">可補抓、可退點</span>');
    box.innerHTML = Twitch.rewards.map((r) => `<label class="tw-reward${cfg.rewardIds.includes(r.id) ? ' on' : ''}"><input type="checkbox" value="${esc(r.id)}"${cfg.rewardIds.includes(r.id) ? ' checked' : ''}><span class="tw-reward-dot" style="--c:${esc(r.color || '#9146ff')}"></span><span class="tw-reward-title">${esc(r.title)}</span>${tag(r)}<span class="tw-reward-cost">${r.cost.toLocaleString()} 點${r.enabled ? '' : '（已停用）'}</span></label>`).join('');
  }
  function renderCreate() {
    const signedIn = !!(auth && auth.userId);
    $('#createReward').disabled = !signedIn || !Twitch.canManage;
    const err = $('#createErr');
    const msg = !signedIn ? '' : !Twitch.canManage ? '你的 Twitch 授權是舊版的，請按步驟 1 的「換一個帳號」用同一個帳號重新連接一次，就能建立品項。' : '';
    if (msg) { err.textContent = msg; err.classList.remove('hidden'); } else if (!err.dataset.keep) err.classList.add('hidden');
  }
  $('#createReward').onclick = async () => {
    const title = $('#newRewardTitle').value.trim();
    const cost = Math.trunc(Number($('#newRewardCost').value));
    const err = $('#createErr'); delete err.dataset.keep;
    const fail = (m) => { err.textContent = m; err.dataset.keep = '1'; err.classList.remove('hidden'); };
    if (!title) return fail('請填品項名稱');
    if (!(cost >= 1)) return fail('忠誠點至少要 1 點');
    $('#createReward').disabled = true;
    try {
      const r = await Twitch.createReward(title, cost, $('#newRewardProxy').checked);
      cfg.rewardIds = [...new Set([...cfg.rewardIds, r.id])]; saveCfg();
      err.classList.add('hidden');
      toast(`已在 Twitch 建立「${r.title}」並勾選好了`);
      await Twitch.loadRewards(); renderSetup();
    } catch (e) { fail(e.message); } finally { renderCreate(); }
  };
  $('#rewards').addEventListener('change', (e) => {
    if (e.target.type !== 'checkbox') return;
    cfg.rewardIds = $$('#rewards input:checked').map((i) => i.value);
    saveCfg(); renderRewards(); renderSetup();
  });
  $('#reloadRewards').onclick = () => { Twitch.rewards = null; renderRewards(); Twitch.loadRewards(); };
  $('#twLogin').onclick = () => Twitch.login();
  $('#twSwitch').onclick = () => Twitch.login(true);
  $('#redirectUri').textContent = redirectUri();
  $('#clientId').value = cfg.clientId;
  $('#clientId').onchange = () => { cfg = T.normalizeTwConfig({ ...cfg, clientId: $('#clientId').value }); saveCfg(); $('#clientId').value = cfg.clientId; };

  // 步驟 3：試算表
  let scriptSrc = null;
  $('#copyScript').onclick = async () => {
    try {
      if (!scriptSrc) { const r = await fetch('sheet-script.gs', { cache: 'no-cache' }); if (!r.ok) throw new Error(r.status); scriptSrc = await r.text(); }
      if (await copyText(T.scriptWithKey(scriptSrc, cfg.sheetKey), '程式碼')) toast('已複製！到 Apps Script 編輯區按 Ctrl+V 貼上');
      $('#copyScript').textContent = '✓ 已複製（再按一次可重新複製）';
    } catch (e) { toast(`複製失敗：${e.message}`, 6000); }
  };
  // 開新年度：在同一份試算表建好今年的月份分頁，總表接著累積
  async function openNewYear(year) {
    if (!cfg.scriptUrl) { toast('請先完成步驟 3 連接試算表'); return; }
    const now = new Date();
    const y = year || (now.getMonth() >= 10 ? now.getFullYear() + 1 : now.getFullYear()); // 11、12 月按的話準備明年
    const typed = await dialog({ title: '開新年度', message: `要建立哪一年的月份分頁？\n會做這些事：把「1月」～「12月」改名成「${y - 1}-1月」…；複製出「${y}-1月」～「${y}-12月」（日期換成 ${y} 年、數字清空）；總表改看 ${y} 年，累積點數加上去年（點數不歸零）。\n建議先到試算表「檔案 → 建立副本」備份一份。`, input: String(y), okLabel: '開始' });
    if (typed === null) return;
    const yy = Number(String(typed).trim());
    if (!(yy >= 2000 && yy < 2100)) { toast('年份不對'); return; }
    toast('建立中，大約需要半分鐘…', 30000);
    let res;
    try { res = await sheetPost({ action: 'newYear', year: yy }); } catch (e) { toast(`開新年度失敗：${e.message}`, 8000); return; }
    if (!res.ok) { await dialog({ title: '開新年度沒有完成', message: res.error || '失敗', okLabel: '知道了' }); return; }
    const warn = (res.warnings || []).length ? `\n\n要注意：\n・${res.warnings.join('\n・')}` : '';
    await dialog({ title: `${yy} 年的分頁建好了`, message: `建立了 ${res.created.length} 個月份分頁${res.renamed.length ? `，舊分頁改名為「${res.renamed[0]}」等 ${res.renamed.length} 個` : ''}，總表更新了 ${res.summaryCells || 0} 格公式。${warn}\n\n卡住的紀錄會自動補寫。`, okLabel: '好' });
    retryAll();
  }
  $('#newYearBtn').onclick = () => openNewYear();
  $('#newSheetKey').onclick = async () => {
    if (!(await dialog({ title: '換一組暗號？', message: '換了之後，舊的程式碼就不能寫入了。要重新複製程式碼、貼到 Apps Script，並重新部署（管理部署作業 → 編輯 → 新版本）。', okLabel: '換', danger: true }))) return;
    cfg = T.normalizeTwConfig({ ...cfg, sheetKey: '', sheetOk: '' }); saveCfg();
    $('#copyScript').textContent = '複製程式碼'; renderSetup(); toast('已換新暗號，請重新複製程式碼');
  };
  const todayKey = () => T.dayKey(new Date(), cfg.cutoffHour);
  $('#testSheet').onclick = async () => {
    const url = $('#scriptUrl').value.trim();
    const box = $('#sheetResult'); box.classList.remove('hidden', 'ok', 'bad');
    if (!/^https:\/\/script\.google(usercontent)?\.com\/.+/.test(url)) { box.classList.add('bad'); box.textContent = '網址看起來不對：要以 https://script.google.com/ 開頭、結尾是 /exec'; return; }
    if (/\/edit(\?|$)/.test(url)) { box.classList.add('bad'); box.textContent = '這是程式編輯器的網址。請貼「部署」完成後顯示的「網頁應用程式」網址（結尾是 /exec）'; return; }
    box.textContent = '測試中…';
    $('#testSheet').disabled = true;
    try {
      const date = todayKey();
      const cols = [...new Set(cfg.prizes.map((p) => p.column).filter(Boolean))];
      const res = await sheetPost({ action: 'ping', date, columns: cols }, url);
      if (!res.ok) throw new Error(res.error || '測試失敗');
      const [, m, d] = date.split('-').map(Number);
      const found = Object.entries(res.columns || {}).map(([c, l]) => `${c}（${l} 欄）`).join('、');
      const problems = res.problems || [];
      box.classList.add(problems.length ? 'bad' : 'ok');
      box.innerHTML = `<b>${problems.length ? '⚠ 連上了，但有問題' : '✓ 連線成功'}</b>：「${esc(res.title)}」，名單目前 ${res.viewers ?? '?'} 人。` +
        (found ? `<br>今天（${m}/${d}）的結果會寫在「${esc(res.sheet)}」分頁的 ${esc(found)}。` : '') +
        (problems.length ? `<ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : '') +
        (res.noLogin && res.noLogin.length ? `<div class="tw-nologin"><b>建議補上 Twitch 帳號（${res.noLogin.length} 人）</b>：名單裡這些人只寫了名字，觀眾一改顯示名稱就會對不上、被當成新觀眾。請到「兌換紀錄」B 欄改成「名字(英文帳號)」：<br>${res.noLogin.map(esc).join('、')}</div>` : '');
      cfg.scriptUrl = url; cfg.sheetOk = problems.length ? '' : url;
      if (Array.isArray(res.heads) && res.heads.length) cfg = T.normalizeTwConfig({ ...cfg, sheetColumns: res.heads }); // 「寫到哪一欄」改用試算表實際的欄名
      saveCfg(); renderPrizes();
      Writer.state = 'idle'; Writer.kick();
    } catch (e) {
      box.classList.add('bad'); box.textContent = `✗ ${e.message}`;
    } finally { $('#testSheet').disabled = false; renderSetup(); renderStatus(); }
  };

  // 步驟 4：轉盤內容（步驟 7 的第二個轉盤用同一套表格）
  const prizeTables = () => [$('#prizeRows'), $('#prizeRows2')];
  function renderPrizes() {
    // 選項：測試連線時從試算表讀到的欄名（還沒讀到就用預設那幾欄）＋目前的值＋不寫進試算表＋自己輸入
    const known = sheetColumnList();
    const colOpts = (cur) => [...new Set([...known, ...(cur ? [cur] : [])])].map((c) => `<option value="${esc(c)}"${c === cur ? ' selected' : ''}>${esc(c)}${known.includes(c) ? '' : '（試算表裡沒找到）'}</option>`).join('')
      + `<option value=""${cur ? '' : ' selected'}>（不寫進試算表）</option><option value="${CUSTOM}">自己輸入…</option>`;
    for (const tb of prizeTables()) {
      const list = prizesOf(tb.dataset.w);
      const total = list.reduce((sum, p) => sum + p.weight, 0);
      tb.innerHTML = list.map((p, i) => `<tr data-i="${i}">
      <td><input type="color" data-k="color" value="${esc(p.color)}"></td>
      <td><input data-k="name" value="${esc(p.name)}" maxlength="30"></td>
      <td><input type="number" data-k="weight" value="${p.weight}" min="0" step="1"></td>
      <td class="tw-prob">${total ? ((p.weight / total) * 100).toFixed(1) : '0'}%</td>
      <td><select data-k="column">${colOpts(p.column)}</select></td>
      <td><button class="btn icon ghost" data-del="${i}" title="刪除"${list.length <= 1 ? ' disabled' : ''}>✕</button></td></tr>`).join('');
    }
  }
  const CUSTOM = '__custom__'; // 選單裡「自己輸入…」的值
  const sheetColumnList = () => (cfg.sheetColumns.length ? cfg.sheetColumns : T.SHEET_COLUMNS);
  function prizesChanged() { cfg = T.normalizeTwConfig(cfg); saveCfg(); updateWheel(); sendConfig(); }
  prizeTables().forEach((tb) => {
    tb.addEventListener('change', async (e) => {
      const tr = e.target.closest('tr'); const k = e.target.dataset.k; if (!tr || !k) return;
      const p = prizesOf(tb.dataset.w)[Number(tr.dataset.i)];
      let v = e.target.value;
      if (k === 'column' && v === CUSTOM) {
        const typed = await dialog({ title: '寫到哪一欄', message: '輸入試算表每天底下的欄名（第 2 列），要一字不差，例如「Q版塗鴉」。', input: p.column || '', okLabel: '確定' });
        if (typed === null || !typed.trim()) { renderPrizes(); return; }
        v = typed.trim();
      }
      p[k] = k === 'weight' ? Math.max(0, Number(v) || 0) : v;
      prizesChanged(); renderPrizes();
      // 選了試算表裡沒讀到的欄名：提醒再測一次連線
      if (k === 'column' && v && !sheetColumnList().includes(v) && cfg.sheetOk) { cfg.sheetOk = ''; saveCfg(); renderSetup(); toast('試算表裡沒讀到這個欄名，請回步驟 3 再按一次「測試連線」確認找得到', 6000); }
    });
    tb.addEventListener('click', (e) => {
      const b = e.target.closest('[data-del]'); if (!b) return;
      prizesOf(tb.dataset.w).splice(Number(b.dataset.del), 1); prizesChanged(); renderPrizes();
    });
  });
  const addPrizeTo = (w) => { const list = prizesOf(w); list.push({ name: `獎項 ${list.length + 1}`, weight: 10, column: sheetColumnList()[0] }); prizesChanged(); renderPrizes(); };
  $('#addPrize').onclick = () => addPrizeTo('main');
  $('#addPrize2').onclick = () => addPrizeTo('bonus');
  $('#resetPrizes').onclick = async () => {
    if (!(await dialog({ message: '把轉盤恢復成 1點 50%、3點 30%、5點 20%？' }))) return;
    cfg.prizes = T.DEFAULT_PRIZES.map((p) => ({ ...p })); prizesChanged(); renderPrizes();
  };

  // 步驟 7：小奇點、訂閱也轉盤
  function renderTriggers() {
    const t = cfg.triggers;
    $('#bitsOn').checked = t.bits.on; $('#bitsBox').classList.toggle('on', t.bits.on);
    $$('input[name="bitsMode"]').forEach((r) => { r.checked = r.value === t.bits.mode; });
    $('#bitsPer').value = t.bits.per; $('#bitsCarry').checked = t.bits.carry;
    $('#bitsTiers').innerHTML = t.bits.tiers.map((x, i) => `<span class="tw-tier" data-i="${i}">一次送滿 <input type="number" class="tw-num" data-k="min" min="1" step="1" value="${x.min}"> 小奇點，轉 <input type="number" class="tw-num" data-k="spins" min="0" step="1" value="${x.spins}"> 次 <button type="button" class="btn icon ghost" data-del-tier="${i}" title="刪除這個門檻">✕</button></span>`).join('') || '<span class="hint">還沒有門檻</span>';
    $('#subOn').checked = t.sub.on; $('#subBox').classList.toggle('on', t.sub.on);
    $('#subNew').value = t.sub.newSpins; $('#subResub').value = t.sub.resubSpins; $('#subT2').value = t.sub.t2; $('#subT3').value = t.sub.t3; $('#subGift').value = t.sub.gift;
    $$('[data-wheel-select]').forEach((sel) => { sel.innerHTML = `<option value="main">忠誠點轉盤（步驟 4 的獎項）</option><option value="bonus">第二個轉盤：${esc(cfg.wheel2.name)}</option>`; });
    $('#bitsWheel').value = t.bits.wheel; $('#subWheel').value = t.sub.wheel;
    $('#anonMode').value = t.anon; $('#anonName').value = t.anonName; $('#anonName').classList.toggle('hidden', t.anon === 'skip');
    $('#multiMode').value = t.multi; $('#maxSpins').value = t.maxSpins;
    $('#wheel2Name').value = cfg.wheel2.name;
    $('#wheel2Box').classList.toggle('hidden', !((t.bits.on && t.bits.wheel === 'bonus') || (t.sub.on && t.sub.wheel === 'bonus')));
    // 目前收不收得到
    const box = $('#trigState');
    const on = t.bits.on || t.sub.on;
    let msg = ''; let cls = '';
    if (!on) msg = '';
    else if (!auth || !auth.userId) { msg = '先完成步驟 1 連接 Twitch。'; cls = 'bad'; }
    else if (Twitch.extraError === 'scope') { msg = '還差一步：按步驟 1 的「換一個帳號」用同一個帳號重新連接 Twitch 一次，才收得到小奇點、訂閱通知。'; cls = 'bad'; }
    else if (Twitch.extraError) { msg = Twitch.extraError; cls = 'bad'; }
    else if (Twitch.state === 'online') { msg = `✓ 正在接收${[t.bits.on && '小奇點', t.sub.on && '訂閱'].filter(Boolean).join('、')}通知。`; cls = 'ok'; }
    else msg = '連上 Twitch 後就會開始接收。';
    box.textContent = msg; box.className = `tw-check${cls ? ` ${cls}` : ''}${msg ? '' : ' hidden'}`;
  }
  function triggersChanged() {
    cfg = T.normalizeTwConfig(cfg); saveCfg(); renderTriggers();
    Twitch.subscribeExtras();
  }
  const num = (sel) => Number($(sel).value);
  $('#bitsOn').onchange = () => { cfg.triggers.bits.on = $('#bitsOn').checked; triggersChanged(); };
  $('#subOn').onchange = () => { cfg.triggers.sub.on = $('#subOn').checked; triggersChanged(); };
  $$('input[name="bitsMode"]').forEach((r) => { r.onchange = () => { cfg.triggers.bits.mode = r.value; triggersChanged(); }; });
  $('#bitsPer').onchange = () => { cfg.triggers.bits.per = num('#bitsPer'); triggersChanged(); };
  $('#bitsCarry').onchange = () => { cfg.triggers.bits.carry = $('#bitsCarry').checked; if (!cfg.triggers.bits.carry) cfg.bitsCarry = {}; triggersChanged(); };
  $('#bitsTiers').addEventListener('change', (e) => {
    const row = e.target.closest('[data-i]'); if (!row || !e.target.dataset.k) return;
    cfg.triggers.bits.tiers[Number(row.dataset.i)][e.target.dataset.k] = Number(e.target.value); triggersChanged();
  });
  $('#bitsTiers').addEventListener('click', (e) => {
    const b = e.target.closest('[data-del-tier]'); if (!b) return;
    e.preventDefault(); cfg.triggers.bits.tiers.splice(Number(b.dataset.delTier), 1); triggersChanged();
  });
  $('#addTier').onclick = (e) => {
    e.preventDefault();
    const last = cfg.triggers.bits.tiers[cfg.triggers.bits.tiers.length - 1];
    cfg.triggers.bits.tiers.push(last ? { min: last.min * 2, spins: last.spins * 2 || 1 } : { min: 100, spins: 1 }); triggersChanged();
  };
  [['#subNew', 'newSpins'], ['#subResub', 'resubSpins'], ['#subT2', 't2'], ['#subT3', 't3']].forEach(([sel, k]) => { $(sel).onchange = () => { cfg.triggers.sub[k] = num(sel); triggersChanged(); }; });
  $('#subGift').onchange = () => { cfg.triggers.sub.gift = $('#subGift').value; triggersChanged(); };
  $('#bitsWheel').onchange = () => { cfg.triggers.bits.wheel = $('#bitsWheel').value; triggersChanged(); renderPrizes(); };
  $('#subWheel').onchange = () => { cfg.triggers.sub.wheel = $('#subWheel').value; triggersChanged(); renderPrizes(); };
  $('#anonMode').onchange = () => { cfg.triggers.anon = $('#anonMode').value; triggersChanged(); };
  $('#anonName').onchange = () => { cfg.triggers.anonName = $('#anonName').value; triggersChanged(); };
  $('#multiMode').onchange = () => { cfg.triggers.multi = $('#multiMode').value; triggersChanged(); };
  $('#maxSpins').onchange = () => { cfg.triggers.maxSpins = num('#maxSpins'); triggersChanged(); };
  $('#wheel2Name').onchange = () => { cfg.wheel2.name = $('#wheel2Name').value; triggersChanged(); };
  // 模擬：照目前的規則算次數、轉給實況主看，不寫進試算表、不動小奇點零頭
  function simulate(type, ev, label) {
    const t = { ...cfg.triggers, bits: { ...cfg.triggers.bits, on: true }, sub: { ...cfg.triggers.sub, on: true } };
    const res = T.triggerSpins(type, { user_login: 'test', user_name: '測試', user_id: '', ...ev }, t, {});
    if (!res || !res.spins) { toast(`${label}：照目前的規則不會轉盤`, 5000); return; }
    queue.push({ id: `t-${randId(10)}`, login: '', display: '測試', reward: res.label, source: res.source, wheel: res.wheel, count: res.spins, at: new Date().toISOString(), test: true });
    saveQueue(); renderQueue(); showLive(); pump();
  }
  $('#simBits').onclick = async () => {
    const v = await dialog({ title: '模擬一次小奇點', message: '輸入觀眾送了多少小奇點：', input: String(cfg.triggers.bits.mode === 'tiers' && cfg.triggers.bits.tiers[0] ? cfg.triggers.bits.tiers[0].min : cfg.triggers.bits.per * 3), okLabel: '轉！' });
    if (v === null) return;
    const bits = Math.trunc(Number(v));
    if (!(bits > 0)) { toast('請輸入大於 0 的數字'); return; }
    simulate('channel.cheer', { bits }, `${bits} 小奇點`);
  };
  $('#simSub').onclick = () => simulate('channel.subscribe', { tier: '1000', is_gift: false }, '新訂閱');

  // 步驟 8：排隊陪玩
  function renderPartySetup() {
    const p = cfg.party;
    const list = (Twitch.rewards || []).filter((r) => r.managed && !cfg.rewardIds.includes(r.id));
    const cur = p.rewardId && !list.some((r) => r.id === p.rewardId) ? `<option value="${esc(p.rewardId)}" selected>（目前的品項，清單裡找不到）</option>` : '';
    $('#partyReward').innerHTML = `<option value="">（不使用排隊）</option>${cur}${list.map((r) => `<option value="${esc(r.id)}"${r.id === p.rewardId ? ' selected' : ''}>${esc(r.title)}（${r.cost.toLocaleString()} 點）</option>`).join('')}`;
    $('#partyMax').value = p.max; $('#partyBatch').value = p.batch; $('#partyShow').value = p.show; $('#partyTitleInput').value = p.title; $('#partyShowInput').checked = p.showInput;
    $('#createPartyReward').disabled = !(auth && auth.userId && Twitch.canManage);
    $('#step8').classList.toggle('done', !!p.rewardId);
  }
  const partyChanged = () => { cfg = T.normalizeTwConfig(cfg); saveCfg(); renderPartySetup(); renderParty(); sendParty(); };
  $('#partyReward').onchange = () => { cfg.party.rewardId = $('#partyReward').value; partyChanged(); };
  [['#partyMax', 'max'], ['#partyBatch', 'batch'], ['#partyShow', 'show']].forEach(([sel, k]) => { $(sel).onchange = () => { cfg.party[k] = Number($(sel).value); partyChanged(); }; });
  $('#partyTitleInput').onchange = () => { cfg.party.title = $('#partyTitleInput').value; partyChanged(); };
  $('#partyShowInput').onchange = () => { cfg.party.showInput = $('#partyShowInput').checked; partyChanged(); };
  $('#createPartyReward').onclick = async () => {
    const title = $('#partyRewardTitle').value.trim();
    const cost = Math.trunc(Number($('#partyRewardCost').value));
    const err = $('#partyErr');
    const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); };
    if (!title) return fail('請填品項名稱');
    if (!(cost >= 1)) return fail('忠誠點至少要 1 點');
    $('#createPartyReward').disabled = true;
    try {
      const r = await Twitch.createReward(title, cost, false, $('#partyRewardInput').checked ? '填你在遊戲裡的名字或 ID' : '');
      cfg.party.rewardId = r.id; err.classList.add('hidden');
      toast(`已在 Twitch 建立「${r.title}」，排隊功能開始了`);
      await Twitch.loadRewards(); partyChanged();
    } catch (e) { fail(e.message); } finally { renderPartySetup(); }
  };
  function partyObsUrl() {
    const base = location.href.split(/[?#]/)[0].replace(/twitch\.html$/, '');
    return `${base}queue.html?${new URLSearchParams({ room: cfg.room, key: cfg.secret })}`;
  }
  $('#copyPartyObs').onclick = async () => { if (await copyText(partyObsUrl(), '「排隊名單」網址')) toast('已複製「排隊名單」網址：貼到 OBS 的「來源 → 瀏覽器」', 5000); };

  // 步驟 9：小奇點點歌
  function renderSongSetup() {
    const p = cfg.songs;
    $('#songOn').checked = p.on; $('#songMin').value = p.minBits; $('#songPerUser').value = p.perUser; $('#songMaxMin').value = p.maxMinutes; $('#songShow').value = p.show; $('#songVolume').value = p.volume;
    $('#step9').classList.toggle('done', p.on);
    const box = $('#songState');
    let msg = ''; let cls = '';
    if (!p.on) msg = '';
    else if (!auth || !auth.userId) { msg = '先完成步驟 1 連接 Twitch。'; cls = 'bad'; }
    else if (Twitch.extraError === 'scope') { msg = '還差一步：重新連接 Twitch 一次，才收得到小奇點通知。'; cls = 'bad'; }
    else if (Twitch.extraError) { msg = Twitch.extraError; cls = 'bad'; }
    else if (Twitch.state === 'online') { msg = '✓ 正在接收小奇點點歌。'; cls = 'ok'; }
    else msg = '連上 Twitch 後就會開始接收。';
    box.textContent = msg; box.className = `tw-check${cls ? ` ${cls}` : ''}${msg ? '' : ' hidden'}`;
  }
  const songSetupChanged = () => { cfg = T.normalizeTwConfig(cfg); saveCfg(); renderSongSetup(); renderSongs(); sendSongs(); };
  $('#songOn').onchange = () => { cfg.songs.on = $('#songOn').checked; songSetupChanged(); Twitch.subscribeExtras(); };
  [['#songMin', 'minBits'], ['#songPerUser', 'perUser'], ['#songMaxMin', 'maxMinutes'], ['#songShow', 'show'], ['#songVolume', 'volume']].forEach(([sel, k]) => { $(sel).onchange = () => { cfg.songs[k] = Number($(sel).value); songSetupChanged(); }; });
  function songObsUrl() {
    const base = location.href.split(/[?#]/)[0].replace(/twitch\.html$/, '');
    return `${base}songs.html?${new URLSearchParams({ room: cfg.room, key: cfg.secret })}`;
  }
  $('#copySongObs').onclick = async () => { if (await copyText(songObsUrl(), '「點歌播放器」網址')) toast('已複製「點歌播放器」網址：貼到 OBS 的「來源 → 瀏覽器」', 5000); };
  $('#copySongRule').onclick = async () => {
    const text = `【小奇點點歌】送 ${cfg.songs.minBits} 小奇點以上，訊息裡貼 YouTube 連結就能點歌，照順序播放。只能點免版權的歌，不適合的歌會被跳過。每人同時最多 ${cfg.songs.perUser} 首${cfg.songs.maxMinutes ? `，每首最多播 ${cfg.songs.maxMinutes} 分鐘` : ''}。小奇點送出後無法退還，請確認連結正確。`;
    if (await copyText(text, '點歌說明')) toast('已複製點歌說明', 4000);
  };
  $('#cutoffHour').innerHTML = Array.from({ length: 9 }, (_, h) => `<option value="${h}">${h === 0 ? '0 點（不跨夜，照日曆）' : `${h} 點`}</option>`).join('');
  $('#cutoffHour').value = cfg.cutoffHour;
  $('#cutoffHour').onchange = () => { cfg.cutoffHour = Number($('#cutoffHour').value); saveCfg(); };

  // 步驟 5：OBS
  $('#copyObs').onclick = async () => { if (await copyText(obsUrl(), '「觀眾看的轉盤」網址')) toast('已複製「觀眾看的轉盤」網址：貼到 OBS 的「來源 → 瀏覽器」', 5000); };

  // 步驟 6：搬到 OBS 面板
  function dockUrl() {
    const base = location.href.split(/[?#]/)[0];
    return `${base}?dock=1#move=${T.encodeMove(T.buildMove(cfg, records))}`;
  }
  $('#copyDock').onclick = async () => {
    if (queue.length) { toast('還有人在排隊，等轉完再搬', 5000); return; }
    if (!(await copyText(dockUrl(), '「控制面板」網址'))) { /* 手動複製也算 */ }
    if (!(await dialog({ title: '貼到 OBS 了嗎？', message: '照下面第 2～4 步貼到 OBS 的「自訂瀏覽器停駐視窗」。貼好、在 OBS 面板裡看到設定都在之後按「搬好了」，這個分頁就會停止接收兌換。', okLabel: '搬好了' }))) return;
    cfg.movedToObs = true; saveCfg();
    Twitch.stop(); Twitch.setState('off');
    renderMoved(); renderSetup(); renderStatus();
  };
  $('#unmove').onclick = async () => {
    if (!(await dialog({ title: '改回在這個瀏覽器使用？', message: '請先把 OBS 裡的「忠誠點轉盤」面板關掉或刪掉，不然兩邊會同時轉盤。', okLabel: '改回這裡' }))) return;
    cfg.movedToObs = false; saveCfg(); renderMoved(); renderSetup();
    Twitch.start().then(() => { renderSetup(); renderStatus(); });
  };
  function renderMoved() {
    const moved = cfg.movedToObs && !isDock;
    $('#movedBanner').classList.toggle('hidden', !moved);
    $('#dockHere').classList.toggle('hidden', !isDock);
    $('#dockHow').classList.toggle('hidden', isDock);
  }
  $('#pingObs').onclick = () => { Sync.send({ type: 'ping' }); toast('已送出測試訊號：OBS 畫面右下的小圓點會閃一下'); };
  $('#spinSeconds').value = cfg.spinDuration / 1000;
  $('#resultSeconds').value = cfg.resultSeconds;
  $('#sound').checked = cfg.sound;
  $('#volume').value = cfg.volume;
  const obsSettings = () => {
    cfg = T.normalizeTwConfig({ ...cfg, spinDuration: Number($('#spinSeconds').value) * 1000, resultSeconds: $('#resultSeconds').value, sound: $('#sound').checked, volume: $('#volume').value });
    saveCfg(); updateWheel(); sendConfig();
  };
  ['#spinSeconds', '#resultSeconds', '#sound', '#volume'].forEach((s) => { $(s).onchange = obsSettings; });
  $('#volume').oninput = () => { Sfx.volume = Number($('#volume').value) / 100; };
  // OBS 背景透明度：拉動時就即時套到 OBS 畫面（只掛 oninput，放開時不會再多送一次）
  const showBgOpacity = () => { $('#obsBgOpacity').value = cfg.obsBgOpacity; $('#obsBgOpacityVal').textContent = `${cfg.obsBgOpacity}%`; };
  showBgOpacity();
  $('#obsBgOpacity').oninput = () => {
    cfg = T.normalizeTwConfig({ ...cfg, obsBgOpacity: $('#obsBgOpacity').value });
    $('#obsBgOpacityVal').textContent = `${cfg.obsBgOpacity}%`;
    saveCfg(); sendConfig();
  };

  // ---------- 切換畫面 ----------
  // ---------- 設定頁籤：一次只顯示一步 ----------
  const TAB_COUNT = $$('#setupTabs [data-tab]').length;
  let curTab = 0;
  function selectTab(n) {
    curTab = Math.min(TAB_COUNT, Math.max(1, Number(n) || 1));
    $$('.tw-step').forEach((sec) => sec.classList.toggle('tab-hidden', sec.id !== `step${curTab}`));
    $$('#setupTabs [data-tab]').forEach((b) => { const on = Number(b.dataset.tab) === curTab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); if (on) b.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
    $('#tabPrev').disabled = curTab <= 1; $('#tabNext').disabled = curTab >= TAB_COUNT;
    try { sessionStorage.setItem('tw.tab', String(curTab)); } catch { /* ignore */ }
  }
  // 頁籤上的 ✓ 跟著各步驟的「完成」狀態走（各步驟自己更新 .done，這裡跟著變）
  const syncTabs = () => $$('#setupTabs [data-tab]').forEach((b) => { const sec = $(`#step${b.dataset.tab}`); b.classList.toggle('done', sec.classList.contains('done')); b.classList.toggle('optional', sec.classList.contains('optional')); });
  new MutationObserver(syncTabs).observe($('#setupView'), { subtree: true, attributes: true, attributeFilter: ['class'] });
  $('#setupTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) selectTab(b.dataset.tab); });
  $('#tabPrev').onclick = () => { selectTab(curTab - 1); window.scrollTo({ top: 0 }); };
  $('#tabNext').onclick = () => { selectTab(curTab + 1); window.scrollTo({ top: 0 }); };
  // 沒指定哪一步：上次看的那一步；第一次打開就從第一個還沒完成的必要步驟開始
  function defaultTab() {
    let saved = 0; try { saved = Number(sessionStorage.getItem('tw.tab')) || 0; } catch { /* ignore */ }
    if (saved) return saved;
    const done = stepDone();
    return [1, 2, 3].find((n) => !done[n]) || 1;
  }
  function showSetup(step) {
    $('#setupView').classList.remove('hidden'); $('#liveView').classList.add('hidden');
    $('#toSetup').classList.add('hidden'); $('#toLive').classList.remove('hidden');
    renderSetup(); renderRewards(); renderPrizes(); renderTriggers(); renderPartySetup(); renderSongSetup();
    selectTab(step || curTab || defaultTab()); syncTabs();
  }
  function showLive() {
    $('#setupView').classList.add('hidden'); $('#liveView').classList.remove('hidden');
    $('#toSetup').classList.remove('hidden'); $('#toLive').classList.add('hidden');
    wheel.resize(); wheel.draw();
  }
  $('#toSetup').onclick = () => showSetup();
  $('#toLive').onclick = () => showLive();
  $$('.tw-pill').forEach((b) => { b.onclick = () => showSetup(Number(b.dataset.step)); });
  $('#finishSetup').onclick = async () => {
    const done = stepDone();
    if (!(done[1] && done[2] && done[3]) && !(await dialog({ title: '還沒全部設定好', message: `${$('#finishHint').textContent}。現在先到直播畫面嗎？（之後隨時可以按右上角「設定」回來）`, okLabel: '先去直播畫面' }))) return;
    cfg.setupDone = true; saveCfg(); showLive();
  };
  $$('.theme-toggle button').forEach((b) => { b.onclick = () => { setTheme(b.dataset.theme); saveCfg(); sendConfig(); }; });

  // 還有沒寫進試算表的紀錄時，關網頁前提醒
  let leaving = false;
  window.addEventListener('beforeunload', (e) => {
    if (leaving) return;
    if (queue.length || records.some((r) => r.status === 'pending' || r.status === 'undoing')) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- 啟動 ----------
  {
    const h = new URLSearchParams(location.hash.slice(1));
    const code = h.get('move');
    if (code) {
      const res = T.applyMove(cfg, records, T.decodeMove(code));
      if (res) {
        cfg = res.cfg; records.push(...res.add); saveCfg(); saveRecords();
        setTimeout(() => toast('已從瀏覽器搬入設定：試算表、品項、轉盤都設定好了，只要在這裡連接 Twitch 一次', 8000), 600);
      }
      history.replaceState(null, '', location.href.split('#')[0]); // 網址列不留設定（OBS 每次開都會用原本的網址，同一份只匯入一次）
    }
  }
  Twitch.takeRedirect();
  // 「看圖解」：直接打開說明書的那一頁（頁碼由 docs/guide_pages.py 在產生說明書時算好）
  const guidePdf = $('#openGuide').getAttribute('href');
  $('#openHelp').onclick = () => $('#twHelpModal').classList.remove('hidden');
  $('#closeHelp').onclick = () => $('#twHelpModal').classList.add('hidden');
  $('#twHelpModal').addEventListener('click', (e) => { if (e.target.id === 'twHelpModal' || e.target.closest('.tw-help-item')) $('#twHelpModal').classList.add('hidden'); });
  const guideLinks = (pages) => $$('[data-guide]').forEach((a) => { const n = pages && pages[a.dataset.guide]; a.href = n ? `${guidePdf}#page=${n}` : guidePdf; });
  guideLinks(null);
  fetch('docs/guide-pages.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).then(guideLinks).catch(() => {});
  setTheme(cfg.theme);
  updateWheel();
  $('#scriptUrl').value = cfg.scriptUrl;
  $('#clientId').value = cfg.clientId;
  renderMoved();
  renderQueue(); renderRecords(); renderStatus(); renderParty(); renderSongs();
  if (cfg.setupDone && !Twitch.error) showLive(); else showSetup();

  if (!(await becomeLeader())) {
    $('#lockScreen').classList.remove('hidden');
    await takeover();
    $('#lockScreen').classList.add('hidden');
  }
  leader = true;

  Sync.onStatus = () => renderStatus();
  Sync.on((msg) => {
    if (msg.type === 'hello') { obsSeen = Date.now(); sendConfig(); sendParty(); sendSongs(); renderStatus(); }
    else if (msg.type === 'songEvent') onSongEvent(msg);
    else if (msg.type === 'pong') { obsSeen = Date.now(); renderStatus(); toast('OBS 畫面有回應 ✓'); }
  });
  Sync.start(cfg.room, { sync: cfg.sync, broker: cfg.broker, secret: cfg.secret });
  setTimeout(sendConfig, 800);

  // 舊的待寫入、上次沒轉完的排隊都接著做
  records.forEach((r) => { if (r.status === 'error' && /忙碌|連不到/.test(r.error)) r.status = 'pending'; });
  Writer.kick(500);
  TwSync.kick(3000);
  if (missed.length) openCatchup();
  Twitch.start().then(() => { renderSetup(); renderStatus(); });
  pump();
  // Twitch 規定要定期檢查 token；順便發現過期
  setInterval(() => { if (auth && Twitch.state === 'online') Twitch.validate().then(() => renderStatus()); }, 60 * 60 * 1000);
  setInterval(renderStatus, 60 * 1000);
})();
