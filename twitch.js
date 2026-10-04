/* 忠誠點轉盤：Twitch 忠誠點兌換 → 自動轉盤 → 寫進 Google 試算表 */
(async () => {
  const { Store, Sync, ui } = LW;
  const { $, $$, wait, esc, toast, dialog, applyTheme } = ui;
  const { Wheel, Sfx } = LuckyWheel;
  const { drawOne, normalizeConfig, normalizePrize, tierOf, probabilities, randId } = LuckyCore;
  const T = TwitchCore;

  // 網站管理者到 dev.twitch.tv 註冊應用程式後填入（公開資訊，不是密碼）。使用者也可在步驟 1「進階」自填
  const BUILTIN_CLIENT_ID = 'owgfsq6jkw61bh7l7cvtbmkfjvbfhf';
  const REDEEM_TYPE = 'channel.channel_points_custom_reward_redemption.add';
  const K = { config: 'tw.config', records: 'tw.records', queue: 'tw.queue', auth: 'tw.auth' };
  const MAX_RECORDS = 1000;

  Store.onError = (e) => toast(`儲存失敗：${e.message}`, 6000);
  await Store.init(Object.values(K));
  let cfg = T.normalizeTwConfig(Store.get(K.config, null));
  const records = Store.get(K.records, []);
  const queue = Store.get(K.queue, []);
  let auth = Store.get(K.auth, null); // { token, clientId, userId, login, name }
  const saveCfg = () => Store.set(K.config, cfg);
  const saveRecords = () => { if (records.length > MAX_RECORDS) records.length = MAX_RECORDS; Store.set(K.records, records); };
  const saveQueue = () => Store.set(K.queue, queue);
  const saveAuth = () => Store.set(K.auth, auth);
  saveCfg(); // 第一次開啟時把產生的暗號、頻道代碼存下來

  const redirectUri = () => `${location.origin}${location.pathname}`;
  const clientId = () => cfg.clientId || BUILTIN_CLIENT_ID;
  const fmtTime = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const corePrizes = () => cfg.prizes.map((p, i) => normalizePrize({ id: p.id, name: p.name, weight: p.weight, color: p.color, quantity: -1 }, i));

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
    Sfx.enabled = cfg.sound; Sfx.volume = cfg.volume / 100;
  }

  // ---------- OBS 覆蓋層（沿用主轉盤的 index.html?overlay=1） ----------
  let obsSeen = 0;
  function overlayConfig() {
    return normalizeConfig({
      title: '忠誠點轉盤', prizes: corePrizes(), spinDuration: cfg.spinDuration, turns: cfg.turns, sound: cfg.sound, volume: cfg.volume,
      overlayResultSeconds: cfg.resultSeconds, countdown: 0, theme: cfg.theme, themeChosen: true, bg3d: false,
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
      if (!adds.length && !undos.length) { if (this.state !== 'fail') this.state = 'idle'; renderStatus(); return; }
      this.busy = true; this.again = false;
      try {
        for (const [action, list] of [['add', adds], ['undo', undos]]) {
          if (!list.length) continue;
          const res = await sheetPost({ action, records: list.map(T.forSheet) });
          if (!res.ok) {
            if (!res.fatal) throw new Error(res.error || '試算表忙碌中');
            list.forEach((r) => { r.status = action === 'add' ? 'error' : 'ok'; r.error = res.error; });
            continue;
          }
          for (const x of res.results || []) {
            const r = records.find((y) => y.id === x.id); if (!r) continue;
            r.attempts = (r.attempts || 0) + 1;
            if (action === 'add') {
              if (x.ok) Object.assign(r, { status: 'ok', cell: x.cell || '', sheetName: x.name || '', isNew: !!x.isNew, error: '' });
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
        if (this.again || (this.state === 'ok' && records.some((r) => r.status === 'pending' || r.status === 'undoing'))) this.kick(300);
      }
    },
  };

  // ---------- Twitch：登入（implicit grant）+ EventSub WebSocket ----------
  const Twitch = {
    ws: null, session: '', state: 'off', error: '', kaSec: 10, kaTimer: null, retry: 0, retryTimer: null, rewards: null,
    login(force = false) {
      if (!clientId()) { this.setState('off', '這個網頁還沒設定 Twitch Client ID：請網站管理者依 README 設定，或在下方「進階」自行填入'); return; }
      const st = randId(16);
      try { sessionStorage.setItem('tw.oauth', st); } catch { /* ignore */ }
      const q = new URLSearchParams({ response_type: 'token', client_id: clientId(), redirect_uri: redirectUri(), scope: 'channel:read:redemptions', state: st, force_verify: force ? 'true' : 'false' });
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
        Object.assign(auth, { userId: j.user_id, login: j.login, clientId: j.client_id || auth.clientId, expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : 0 });
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
      const r = await this.helix(`/channel_points/custom_rewards?broadcaster_id=${auth.userId}`);
      if (r.status === 200) this.rewards = (r.json.data || []).map((x) => ({ id: x.id, title: x.title, cost: x.cost, enabled: x.is_enabled, color: x.background_color }));
      else if (r.status === 403) { this.rewards = []; this.rewardError = '這個頻道還沒有忠誠點功能（需要是 Twitch 聯盟或合作夥伴）'; }
      else { this.rewards = []; this.rewardError = `讀取品項失敗（${r.status}）`; }
      renderRewards();
    },
    async start() {
      clearTimeout(this.retryTimer);
      if (!auth || !auth.token) { this.setState('off'); return; }
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
          else this.subscribe();
        } else if (type === 'session_reconnect') {
          this.connect(m.payload.session.reconnect_url, true);
        } else if (type === 'notification' && m.payload.subscription.type === REDEEM_TYPE) {
          onRedemption(m.payload.event);
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
      if (r.status === 202 || r.status === 409) this.setState('online');
      else if (r.status === 403) this.setState('error', '沒有權限讀取忠誠點兌換：頻道需要是 Twitch 聯盟或合作夥伴');
      else if (r.status !== 401) { this.setState('offline', `訂閱兌換通知失敗（${r.status}），稍後重試`); if (this.ws) this.ws.close(); }
    },
    setState(s, err = '') { this.state = s; this.error = err; renderStatus(); renderSetup(); },
  };

  // ---------- 兌換 → 排隊 → 轉盤 ----------
  function onRedemption(ev) {
    if (!cfg.rewardIds.includes(ev.reward && ev.reward.id)) return;
    if (queue.some((q) => q.id === ev.id) || records.some((r) => r.id === ev.id)) return; // Twitch 偶爾會重送
    queue.push({ id: ev.id, login: ev.user_login, display: ev.user_name, reward: ev.reward.title, at: ev.redeemed_at || new Date().toISOString() });
    saveQueue(); renderQueue(); pump();
  }

  let spinning = false;
  let leader = false; // 拿到分頁鎖之後才開始轉盤
  async function pump() {
    if (spinning || !leader) return;
    spinning = true;
    try {
      while (queue.length) {
        const q = queue[0];
        const core = drawOne(corePrizes());
        const prize = core && cfg.prizes.find((p) => p.id === core.id);
        if (!prize) { toast('轉盤沒有可抽的獎項：請到設定的步驟 4 檢查權重', 8000); break; }
        const at = new Date(q.at); const when = Number.isNaN(at.getTime()) ? new Date() : at; // 用兌換當下的時間決定日期（排隊跨過午夜也不會記錯天）
        const rec = T.makeRecord({ id: q.id, login: q.login, display: q.display, reward: q.reward, prize, now: when, cutoffHour: cfg.cutoffHour, test: !!q.test });
        records.unshift(rec); queue.shift();
        saveRecords(); saveQueue(); renderQueue(); renderRecords();
        Writer.kick(); // 先寫入再播動畫：就算中途關掉網頁也不會漏記
        await animate(rec);
      }
    } finally { spinning = false; }
  }

  async function animate(rec) {
    const probs = probabilities(corePrizes());
    const p = corePrizes().find((x) => x.id === rec.prizeId);
    const tier = p ? tierOf(p, probs[p.id]) : 'normal';
    const who = T.viewerLabel(rec);
    $('#nowBanner').innerHTML = `<span class="tw-now-who">${esc(rec.display || rec.login)}</span><span class="tw-now-label">${rec.status === 'test' ? '試轉中…' : `兌換了「${esc(rec.reward)}」`}</span>`;
    $('#nowBanner').classList.add('active');
    $('#lastResult').classList.add('hidden');
    Sync.send({ type: 'spin', batchId: rec.id, batchType: '', count: 1, player: who, results: [{ rid: rec.id, index: 1, prizeId: rec.prizeId, name: rec.prize, image: '', color: rec.color, tier }], prizes: overlayConfig().prizes, reveal: 'flip', pity: '', countdown: 0 });
    await wheel.spinTo(rec.prizeId, { duration: cfg.spinDuration, turns: cfg.turns });
    if (tier === 'big') Sfx.fanfare(); else Sfx.win();
    wheel.focus(1400);
    const last = $('#lastResult');
    last.style.setProperty('--c', rec.color || '#888');
    last.innerHTML = `<span class="tw-last-who">${esc(rec.display || rec.login)}</span> 轉到 <b>${esc(rec.prize)}</b>`;
    last.classList.remove('hidden');
    await wait(cfg.resultSeconds * 1000 + 400);
    $('#nowBanner').classList.remove('active');
    $('#nowBanner').innerHTML = '<span class="tw-now-label">等待兌換中…</span>';
  }

  // ---------- 畫面：狀態 ----------
  function sheetSummary() {
    const pending = records.filter((r) => r.status === 'pending' || r.status === 'undoing').length;
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
    else if (Writer.state === 'fail' && cfg.scriptUrl) alert = { text: `試算表寫入失敗：${Writer.lastError}（每隔一段時間會自動重試，紀錄都還在）`, btn: '立刻重試', act: () => Writer.kick() };
    else if (failed) alert = { text: `有 ${failed} 筆沒寫進試算表：${records.find((r) => r.status === 'error').error}`, btn: '全部重新寫入', act: retryAll };
    $('#alert').classList.toggle('hidden', !alert);
    if (alert) { $('#alertText').textContent = alert.text; $('#alertBtn').textContent = alert.btn; $('#alertBtn').onclick = alert.act; }
    $('#retryAll').classList.toggle('hidden', !failed);
  }

  // ---------- 畫面：排隊與紀錄 ----------
  function renderQueue() {
    $('#queueCount').textContent = queue.length;
    $('#queueList').innerHTML = queue.length
      ? queue.map((q) => `<li><span class="tw-li-main">${esc(q.display || q.login)}</span><span class="tw-li-sub">${esc(q.test ? '試轉' : q.reward)} · ${fmtTime(q.at)}</span></li>`).join('')
      : '<li class="tw-empty">目前沒有人排隊</li>';
  }
  const STATUS_TEXT = { pending: '寫入中…', ok: '已寫入', error: '寫入失敗', undoing: '撤銷中…', undone: '已撤銷', test: '試轉（不記錄）' };
  function renderRecords() {
    const list = records.slice(0, 60);
    $('#recordList').innerHTML = list.length ? list.map((r) => {
      const actions = r.status === 'error' ? `<button class="btn icon" data-retry="${esc(r.id)}">重試</button>` : r.status === 'ok' ? `<button class="btn icon ghost" data-undo="${esc(r.id)}" title="從試算表減回去">撤銷</button>` : '';
      const detail = r.status === 'ok' ? `${r.cell}${r.isNew ? ' · 新觀眾已加入名單' : ''}` : r.status === 'error' ? r.error : '';
      return `<li class="st-${r.status}">
        <span class="tw-dot" style="--c:${esc(r.color || '#888')}"></span>
        <span class="tw-li-main">${esc(r.display || r.login)} → <b>${esc(r.prize)}</b></span>
        <span class="tw-li-sub">${fmtTime(r.time)} · <span class="tw-st">${STATUS_TEXT[r.status] || r.status}</span>${detail ? ` · ${esc(detail)}` : ''}</span>
        <span class="tw-li-act">${actions}</span></li>`;
    }).join('') : '<li class="tw-empty">還沒有紀錄。觀眾兌換後會出現在這裡。</li>';
  }
  function retryAll() { records.forEach((r) => { if (r.status === 'error') { r.status = 'pending'; r.error = ''; } }); saveRecords(); renderRecords(); Writer.kick(); }
  $('#retryAll').onclick = retryAll;
  $('#recordList').addEventListener('click', async (e) => {
    const retry = e.target.closest('[data-retry]'); const undo = e.target.closest('[data-undo]');
    if (retry) { const r = records.find((x) => x.id === retry.dataset.retry); if (r) { r.status = 'pending'; r.error = ''; saveRecords(); renderRecords(); Writer.kick(); } }
    if (undo) {
      const r = records.find((x) => x.id === undo.dataset.undo); if (!r) return;
      if (!(await dialog({ title: '撤銷這一筆？', message: `把 ${T.viewerLabel(r)} 的「${r.prize}」從試算表（${r.cell}）減回去。Twitch 那邊的忠誠點不會退還。`, okLabel: '撤銷', danger: true }))) return;
      r.status = 'undoing'; saveRecords(); renderRecords(); Writer.kick();
    }
  });

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
    };
  }
  function renderSetup() {
    const done = stepDone();
    [1, 2, 3].forEach((n) => $(`#step${n}`).classList.toggle('done', done[n]));
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
    box.innerHTML = Twitch.rewards.map((r) => `<label class="tw-reward${cfg.rewardIds.includes(r.id) ? ' on' : ''}"><input type="checkbox" value="${esc(r.id)}"${cfg.rewardIds.includes(r.id) ? ' checked' : ''}><span class="tw-reward-dot" style="--c:${esc(r.color || '#9146ff')}"></span><span class="tw-reward-title">${esc(r.title)}</span><span class="tw-reward-cost">${r.cost.toLocaleString()} 點${r.enabled ? '' : '（已停用）'}</span></label>`).join('');
  }
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
      await navigator.clipboard.writeText(T.scriptWithKey(scriptSrc, cfg.sheetKey));
      toast('已複製！到 Apps Script 編輯區按 Ctrl+V 貼上');
      $('#copyScript').textContent = '✓ 已複製（再按一次可重新複製）';
    } catch (e) { toast(`複製失敗：${e.message}`, 6000); }
  };
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
      const cols = [...new Set(cfg.prizes.map((p) => p.column))];
      const res = await sheetPost({ action: 'ping', date, columns: cols }, url);
      if (!res.ok) throw new Error(res.error || '測試失敗');
      const [, m, d] = date.split('-').map(Number);
      const found = Object.entries(res.columns || {}).map(([c, l]) => `${c}（${l} 欄）`).join('、');
      const problems = res.problems || [];
      box.classList.add(problems.length ? 'bad' : 'ok');
      box.innerHTML = `<b>${problems.length ? '⚠ 連上了，但有問題' : '✓ 連線成功'}</b>：「${esc(res.title)}」，名單目前 ${res.viewers ?? '?'} 人。` +
        (found ? `<br>今天（${m}/${d}）的結果會寫在「${esc(res.sheet)}」分頁的 ${esc(found)}。` : '') +
        (problems.length ? `<ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : '');
      cfg.scriptUrl = url; cfg.sheetOk = problems.length ? '' : url; saveCfg();
      Writer.state = 'idle'; Writer.kick();
    } catch (e) {
      box.classList.add('bad'); box.textContent = `✗ ${e.message}`;
    } finally { $('#testSheet').disabled = false; renderSetup(); renderStatus(); }
  };

  // 步驟 4：轉盤內容
  function renderPrizes() {
    const total = cfg.prizes.reduce((s, p) => s + p.weight, 0);
    const colOpts = (cur) => [...new Set([...T.SHEET_COLUMNS, cur])].map((c) => `<option${c === cur ? ' selected' : ''}>${esc(c)}</option>`).join('');
    $('#prizeRows').innerHTML = cfg.prizes.map((p, i) => `<tr data-i="${i}">
      <td><input type="color" data-k="color" value="${esc(p.color)}"></td>
      <td><input data-k="name" value="${esc(p.name)}" maxlength="30"></td>
      <td><input type="number" data-k="weight" value="${p.weight}" min="0" step="1"></td>
      <td class="tw-prob">${total ? ((p.weight / total) * 100).toFixed(1) : '0'}%</td>
      <td><select data-k="column">${colOpts(p.column)}</select></td>
      <td><button class="btn icon ghost" data-del="${i}" title="刪除"${cfg.prizes.length <= 1 ? ' disabled' : ''}>✕</button></td></tr>`).join('');
  }
  function prizesChanged() { cfg = T.normalizeTwConfig(cfg); saveCfg(); updateWheel(); sendConfig(); }
  $('#prizeRows').addEventListener('change', (e) => {
    const tr = e.target.closest('tr'); const k = e.target.dataset.k; if (!tr || !k) return;
    const p = cfg.prizes[Number(tr.dataset.i)];
    p[k] = k === 'weight' ? Math.max(0, Number(e.target.value) || 0) : e.target.value;
    prizesChanged(); renderPrizes();
    if (k === 'column' && cfg.sheetOk) { cfg.sheetOk = ''; saveCfg(); renderSetup(); toast('改了寫入欄位，建議回步驟 3 再按一次「測試連線」確認找得到'); }
  });
  $('#prizeRows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    cfg.prizes.splice(Number(b.dataset.del), 1); prizesChanged(); renderPrizes();
  });
  $('#addPrize').onclick = () => { cfg.prizes.push({ name: `獎項 ${cfg.prizes.length + 1}`, weight: 10, column: T.SHEET_COLUMNS[0] }); prizesChanged(); renderPrizes(); };
  $('#resetPrizes').onclick = async () => {
    if (!(await dialog({ message: '把轉盤恢復成 1點 50%、3點 30%、5點 20%？' }))) return;
    cfg.prizes = T.DEFAULT_PRIZES.map((p) => ({ ...p })); prizesChanged(); renderPrizes();
  };
  $('#cutoffHour').innerHTML = Array.from({ length: 9 }, (_, h) => `<option value="${h}">${h === 0 ? '0 點（不跨夜，照日曆）' : `${h} 點`}</option>`).join('');
  $('#cutoffHour').value = cfg.cutoffHour;
  $('#cutoffHour').onchange = () => { cfg.cutoffHour = Number($('#cutoffHour').value); saveCfg(); };

  // 步驟 5：OBS
  $('#copyObs').onclick = async () => { try { await navigator.clipboard.writeText(obsUrl()); toast('已複製 OBS 網址'); } catch { await dialog({ title: 'OBS 網址', message: '請手動複製：', input: obsUrl() }); } };
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

  // ---------- 切換畫面 ----------
  function showSetup(step) {
    $('#setupView').classList.remove('hidden'); $('#liveView').classList.add('hidden');
    $('#toSetup').classList.add('hidden'); $('#toLive').classList.remove('hidden');
    renderSetup(); renderRewards(); renderPrizes();
    if (step) setTimeout(() => $(`#step${step}`).scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
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
  Twitch.takeRedirect();
  setTheme(cfg.theme);
  updateWheel();
  $('#scriptUrl').value = cfg.scriptUrl;
  renderQueue(); renderRecords(); renderStatus();
  if (cfg.setupDone && !Twitch.error) showLive(); else showSetup();

  if (!(await becomeLeader())) {
    $('#lockScreen').classList.remove('hidden');
    await takeover();
    $('#lockScreen').classList.add('hidden');
  }
  leader = true;

  Sync.onStatus = () => renderStatus();
  Sync.on((msg) => {
    if (msg.type === 'hello') { obsSeen = Date.now(); sendConfig(); renderStatus(); }
    else if (msg.type === 'pong') { obsSeen = Date.now(); renderStatus(); toast('OBS 畫面有回應 ✓'); }
  });
  Sync.start(cfg.room, { sync: cfg.sync, broker: cfg.broker, secret: cfg.secret });
  setTimeout(sendConfig, 800);

  // 舊的待寫入、上次沒轉完的排隊都接著做
  records.forEach((r) => { if (r.status === 'error' && /忙碌|連不到/.test(r.error)) r.status = 'pending'; });
  Writer.kick(500);
  Twitch.start().then(() => { renderSetup(); renderStatus(); });
  pump();
  // Twitch 規定要定期檢查 token；順便發現過期
  setInterval(() => { if (auth && Twitch.state === 'online') Twitch.validate().then(() => renderStatus()); }, 60 * 60 * 1000);
  setInterval(renderStatus, 60 * 1000);
})();
