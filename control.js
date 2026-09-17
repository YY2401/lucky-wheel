/* 控制台：獎項設定、抽獎、紀錄 / Excel、設定頁 */
(function () {
  const LW = (window.LW = window.LW || {});
  const { Wheel, Sfx, Confetti } = LuckyWheel;
  const { PALETTE, DEFAULT_CONFIG, randId, normalizeConfig, probabilities, drawsSinceHit, drawBatch, undoBatch } = LuckyCore;
  const { $, $$, wait, esc, colorOf, toast, dialog, ask, isFlip, resultCards, scheduleFlipSounds, liveChip, renderPrizeListRows, applyTheme } = LW.ui;

  function startControl() {
    const { Store, Sync, Excel, KEYS } = LW;
    const state = { config: null, records: [], dirty: false, spinning: false, skipAll: false, pongs: 0 };
    const wheel = new Wheel($('#wheel'), { onTick: () => Sfx.tick() });
    const confetti = new Confetti($('#confetti'));

    // ======================================================================
    //  設定：儲存 / 重畫
    // ======================================================================
    function overlayUrl() {
      const c = state.config;
      const q = new URLSearchParams({ overlay: '1', room: c.room });
      if (c.overlaySize !== 520) q.set('size', c.overlaySize);
      if (c.overlaySpinOnly) q.set('mode', 'spin');
      if (c.overlayMute) q.set('sound', '0');
      if (c.overlayHideStatus) q.set('status', '0');
      if (c.overlayList) { q.set('list', '1'); if (!c.overlayListProb) q.set('lp', '0'); if (!c.overlayListStock) q.set('ls', '0'); if (c.overlayListPos !== 'tl') q.set('lpos', c.overlayListPos); }
      return `${location.origin}${location.pathname}?${q.toString()}`;
    }
    function markDirty(v = true) {
      state.dirty = v;
      $('#dirtyHint').textContent = v ? '● 有未儲存的變更' : '';
      $('#savePrizes').classList.toggle('pulse', v);
    }
    function saveConfig(silent) {
      state.config = normalizeConfig(state.config);
      if (!Store.set(KEYS.config, state.config)) return false;
      try { localStorage.setItem('lw.bg3d', state.config.bg3d ? '1' : '0'); } catch { /* ignore */ }
      markDirty(false); renderAll();
      Sync.send({ type: 'config', config: state.config });
      if (!silent) toast('已儲存設定');
      return true;
    }
    function renderAll() { renderPrizeRows(); renderSettings(); updateWheel(); renderPityInfo(); }
    function updateWheel() {
      applyTheme(state.config.theme, wheel);
      wheel.setPrizes(state.config.prizes, state.config.segmentMode, state.config.minSlice / 100);
      renderProbBar(); refreshComputed(); renderPrizeList();
      if (window.WheelBG) WheelBG.setEnabled(state.config.bg3d);
      Sfx.enabled = !!state.config.sound;
    }

    // ======================================================================
    //  獎項一覽（首頁左上角可收合的清單）
    // ======================================================================
    const plPrefs = Object.assign({ open: false, prob: true, stock: true, center: false, x: null, y: null }, Store.get(KEYS.prizeList, {}));
    function savePlPrefs() { Store.set(KEYS.prizeList, plPrefs); }
    function renderPrizeList() {
      const panel = $('#prizeList');
      panel.classList.toggle('hidden', !plPrefs.open);
      panel.classList.toggle('centered', plPrefs.center);
      $('#plCenter').classList.toggle('primary', plPrefs.center);
      $('#plCenter').textContent = plPrefs.center ? '回到角落' : '置中放大';
      // 置中模式不吃自訂位置；角落模式若拖曳過就用記住的座標
      if (!plPrefs.center && plPrefs.x != null) { panel.style.left = `${plPrefs.x}px`; panel.style.top = `${plPrefs.y}px`; }
      else { panel.style.left = ''; panel.style.top = ''; }
      $('#togglePrizeList').setAttribute('aria-expanded', String(plPrefs.open));
      $('#togglePrizeList').classList.toggle('primary', plPrefs.open);
      $('#plShowProb').checked = plPrefs.prob; $('#plShowStock').checked = plPrefs.stock;
      if (!plPrefs.open) return;
      renderPrizeListRows($('#prizeListRows'), state.config.prizes, plPrefs);
    }
    $('#togglePrizeList').addEventListener('click', () => { plPrefs.open = !plPrefs.open; savePlPrefs(); renderPrizeList(); });
    $('#plClose').addEventListener('click', () => { plPrefs.open = false; savePlPrefs(); renderPrizeList(); });
    $('#plCenter').addEventListener('click', () => { plPrefs.center = !plPrefs.center; savePlPrefs(); renderPrizeList(); });
    // 拖曳標題列移動面板；雙擊標題列回到預設位置
    (() => {
      const head = $('#prizeListHead'); const panel = $('#prizeList');
      let drag = null;
      head.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button, input, label') || plPrefs.center) return;
        const r = panel.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        head.setPointerCapture(e.pointerId); panel.classList.add('dragging');
      });
      head.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const w = panel.offsetWidth, h = panel.offsetHeight;
        plPrefs.x = Math.min(Math.max(0, e.clientX - drag.dx), window.innerWidth - w);
        plPrefs.y = Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - Math.min(h, 80));
        panel.style.left = `${plPrefs.x}px`; panel.style.top = `${plPrefs.y}px`;
      });
      const end = () => { if (!drag) return; drag = null; panel.classList.remove('dragging'); savePlPrefs(); };
      head.addEventListener('pointerup', end); head.addEventListener('pointercancel', end);
      head.addEventListener('dblclick', (e) => { if (e.target.closest('button, input, label')) return; plPrefs.x = plPrefs.y = null; savePlPrefs(); renderPrizeList(); });
    })();
    $('#plShowProb').addEventListener('change', (e) => { plPrefs.prob = e.target.checked; savePlPrefs(); renderPrizeList(); });
    $('#plShowStock').addEventListener('change', (e) => { plPrefs.stock = e.target.checked; savePlPrefs(); renderPrizeList(); });

    // ======================================================================
    //  獎項表格
    // ======================================================================
    // 表格用「對帳」方式更新：列以獎項 id 為鍵重複使用，只有新增 / 刪除 / 換順序才動 DOM 結構，
    // 打字、抽獎、儲存都只改欄位值，不會失去焦點或捲動位置
    function renderPrizeRows() {
      const tb = $('#prizeRows');
      const rows = new Map($$('tr', tb).map((tr) => [tr.dataset.id, tr]));
      state.config.prizes.forEach((p) => {
        let tr = rows.get(p.id);
        if (!tr) tr = createPrizeRow(p.id);
        else rows.delete(p.id);
        tb.appendChild(tr); // 已存在的列 appendChild 等於搬到正確順序
      });
      rows.forEach((tr) => tr.remove()); // 已刪除的獎項
      syncPrizeRows();
    }
    function createPrizeRow(id) {
      const tr = document.createElement('tr'); tr.dataset.id = id;
      tr.innerHTML = `
        <td><div style="display:flex;gap:6px;align-items:center">
          <div class="thumb" title="點擊上傳圖片"></div>
          <div class="thumb-actions"><button class="f-url">網址</button><button class="f-clearimg">清除</button></div>
          <input type="file" accept="image/*" class="f-file" hidden>
        </div></td>
        <td><input class="f-name" maxlength="60"></td>
        <td><input type="number" class="f-weight" min="0" step="0.1"></td>
        <td class="prob">–</td>
        <td><div class="qty">
          <input type="number" class="f-quantity" min="0">
          <label><input type="checkbox" class="f-unlimited">無限</label>
        </div></td>
        <td><input type="number" class="f-remaining" min="0"></td>
        <td><input type="color" class="f-color"></td>
        <td style="text-align:center"><input type="checkbox" class="f-pity" title="勾選＝算保底獎"></td>
        <td style="white-space:nowrap">
          <button class="btn icon f-up" title="上移">↑</button>
          <button class="btn icon f-down" title="下移">↓</button>
          <button class="btn icon f-del" title="刪除">✕</button>
        </td>`;
      // 事件用 id 回頭找獎項，順序變了也不會綁到錯的列
      const prize = () => state.config.prizes.find((x) => x.id === id);
      const index = () => state.config.prizes.findIndex((x) => x.id === id);
      const on = (sel, ev, fn) => $(sel, tr).addEventListener(ev, (e) => { const p = prize(); if (p) fn(e, p); });
      const touched = () => { markDirty(); updateWheel(); };
      const restructure = () => { markDirty(); renderPrizeRows(); updateWheel(); };
      on('.f-name', 'input', (e, p) => { p.name = e.target.value; touched(); });
      on('.f-weight', 'input', (e, p) => { p.weight = Math.max(0, Number(e.target.value) || 0); touched(); });
      on('.f-quantity', 'input', (e, p) => {
        const q = Math.max(0, Math.trunc(Number(e.target.value)) || 0);
        p.remaining = Math.min(q, Math.max(0, p.remaining + (q - p.quantity)));
        p.quantity = q; touched();
      });
      on('.f-remaining', 'input', (e, p) => { p.remaining = Math.min(p.quantity, Math.max(0, Math.trunc(Number(e.target.value)) || 0)); touched(); });
      on('.f-unlimited', 'change', (e, p) => { if (e.target.checked) { p.quantity = -1; p.remaining = -1; } else { p.quantity = 10; p.remaining = 10; } touched(); });
      on('.f-color', 'input', (e, p) => { p.color = e.target.value; touched(); });
      on('.f-pity', 'change', (e, p) => { p.pity = e.target.checked; markDirty(); renderPityInfo(); });
      on('.f-del', 'click', async (e, p) => { if (await ask(`刪除獎項「${p.name}」？`, { title: '刪除獎項', okLabel: '刪除', danger: true })) { state.config.prizes.splice(index(), 1); restructure(); } });
      on('.f-up', 'click', () => { const i = index(); if (i <= 0) return; const a = state.config.prizes; [a[i - 1], a[i]] = [a[i], a[i - 1]]; restructure(); });
      on('.f-down', 'click', () => { const i = index(); const a = state.config.prizes; if (i < 0 || i >= a.length - 1) return; [a[i + 1], a[i]] = [a[i], a[i + 1]]; restructure(); });
      on('.thumb', 'click', () => $('.f-file', tr).click());
      on('.f-file', 'change', async (e, p) => {
        const file = e.target.files[0]; if (!file) return;
        try { p.image = await downscale(file, 200); touched(); }
        catch (err) { toast(`讀取圖片失敗：${err.message}`); }
        e.target.value = '';
      });
      on('.f-url', 'click', async (e, p) => { const u = await dialog({ title: '圖片網址', message: '輸入圖片網址（https://…）', input: p.image.startsWith('data:') ? '' : p.image }); if (u !== null) { p.image = u.trim(); touched(); } });
      on('.f-clearimg', 'click', (e, p) => { p.image = ''; touched(); });
      return tr;
    }
    // 把資料同步到每一列的欄位；正在打字的欄位不動
    function syncPrizeRows() {
      const probs = probabilities(state.config.prizes);
      const active = document.activeElement;
      const setVal = (el, v) => { if (el !== active && String(el.value) !== String(v)) el.value = v; };
      $$('#prizeRows tr').forEach((tr) => {
        const i = state.config.prizes.findIndex((x) => x.id === tr.dataset.id); if (i < 0) return;
        const p = state.config.prizes[i]; const unlimited = p.quantity === -1;
        const thumb = $('.thumb', tr); const img = thumb.querySelector('img');
        if (p.image) { if (!img) thumb.innerHTML = '<img alt="">'; if (thumb.querySelector('img').getAttribute('src') !== p.image) thumb.querySelector('img').src = p.image; }
        else if (img || !thumb.firstChild) thumb.innerHTML = '<span class="thumb-empty">上傳</span>';
        setVal($('.f-name', tr), p.name);
        setVal($('.f-weight', tr), p.weight);
        const qty = $('.f-quantity', tr); const rem = $('.f-remaining', tr);
        qty.disabled = rem.disabled = unlimited;
        setVal(qty, unlimited ? '' : p.quantity);
        setVal(rem, unlimited ? '' : p.remaining);
        $('.f-unlimited', tr).checked = unlimited;
        setVal($('.f-color', tr), colorOf(p, i));
        $('.f-pity', tr).checked = !!p.pity;
        const pr = probs[p.id];
        $('.prob', tr).textContent = pr == null ? (p.remaining === 0 ? '已抽完' : '0%') : `${pr.toFixed(2)}%`;
        tr.classList.toggle('tr-soldout', pr == null);
        $('.f-up', tr).disabled = i === 0;
        $('.f-down', tr).disabled = i === state.config.prizes.length - 1;
      });
    }
    const refreshComputed = syncPrizeRows;
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

    // ======================================================================
    //  設定頁
    // ======================================================================
    const SETTING_KEYS = ['segmentMode', 'turns', 'overlayResultSeconds', 'multiMode', 'minSlice', 'pityAccumN', 'pityBatchK', 'pityScope', 'theme', 'room', 'broker', 'overlaySize', 'overlayListPos'];
    const SEC_KEYS = ['spinDuration', 'multiSpinDuration']; // 畫面用秒，內部存毫秒
    const BOOL_KEYS = ['sound', 'sync', 'bg3d', 'pityAccum', 'pityBatch', 'overlaySpinOnly', 'overlayMute', 'overlayHideStatus', 'overlayList', 'overlayListProb', 'overlayListStock'];
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
      Store.set(KEYS.config, state.config); applyTheme(b.dataset.theme, wheel);
      Sync.send({ type: 'config', config: state.config });
    }));
    $('#testSync').addEventListener('click', () => {
      state.pongs = 0; Sync.send({ type: 'ping' }); toast('已送出測試訊號，等待覆蓋層回應…', 3000);
      setTimeout(() => toast(state.pongs ? `OBS 畫面已回應（${state.pongs} 個）` : '3 秒內沒有回應：請確認「讓 OBS 畫面跟著控制台動」已打開並儲存，且 OBS 裡貼的是最新複製的網址', 6000), 3000);
    });
    $('#testSound').addEventListener('click', () => {
      if (!$('#s-sound').checked) { toast('音效目前是關閉的，先打開再試聽'); return; }
      const was = Sfx.enabled; Sfx.enabled = true;
      Sfx.tick(); setTimeout(() => Sfx.pop(), 200); setTimeout(() => { Sfx.win(); Sfx.enabled = was || true; }, 500);
    });
    $('#copyOverlay').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(overlayUrl()); toast('已複製 OBS 畫面網址'); }
      catch { dialog({ title: '請手動複製', message: overlayUrl(), input: overlayUrl() }); }
    });
    Sync.onStatus = (s, room) => {
      const el = $('#syncStatus');
      const map = { off: ['', '同步：關閉'], local: ['ok', `頻道 ${room}（同瀏覽器）`], connecting: ['', `頻道 ${room}：連線中…`], online: ['ok', `頻道 ${room}：跨瀏覽器同步中`], offline: ['bad', `頻道 ${room}：中繼離線，重連中…`] };
      el.className = `status ${map[s][0]}`; el.lastChild.textContent = map[s][1];
    };

    // 頁籤 / 彈出視窗
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

    // ======================================================================
    //  紀錄 / 統計 / Excel
    // ======================================================================
    function renderRecords() {
      const q = ($('#recordSearch').value || '').trim().toLowerCase();
      const terms = q ? q.split(/\s+/) : [];
      const list = terms.length
        ? state.records.filter((r) => { const hay = `${r.time} ${r.player} ${r.type} ${r.prize} ${r.batchId} ${r.pity ? '保底' : ''}`.toLowerCase(); return terms.every((t) => hay.includes(t)); })
        : state.records;
      $('#recordCount').textContent = terms.length ? `符合 ${list.length} / ${state.records.length} 筆` : `共 ${state.records.length} 筆`;
      renderStats(list, terms.length > 0);
      $('#recordRows').innerHTML = list.slice(-500).reverse().map((r) => `<tr>
        <td>${esc(r.time)}</td><td>${esc(r.player)}</td><td>${esc(r.type)}</td><td>${r.index}</td>
        <td>${esc(r.prize)}</td><td>${r.remaining === -1 ? '∞' : r.remaining}</td><td>${r.probability}%</td><td>${r.pity ? '<span class="badge-pity inline">保底</span>' : ''}</td></tr>`).join('');
    }
    // 統計：每個獎項實際抽出幾次，對照目前設定的機率
    function renderStats(list, filtered) {
      const total = list.length;
      const probs = probabilities(state.config.prizes);
      const byId = new Map();
      list.forEach((r) => {
        const e = byId.get(r.prizeId) || { name: r.prize, count: 0, pity: 0 };
        e.count++; if (r.pity) e.pity++; e.name = r.prize; byId.set(r.prizeId, e);
      });
      // 依目前獎項順序排，紀錄裡有但已刪除的獎項排最後
      const order = state.config.prizes.map((p) => p.id).filter((id) => byId.has(id));
      byId.forEach((_, id) => { if (!order.includes(id)) order.push(id); });
      const hits = list.filter((r) => r.hit).length;
      $('#statsTitle').textContent = `統計${filtered ? '（搜尋結果）' : ''}：共 ${total} 抽，抽到保底獎 ${hits} 次（${total ? (hits / total * 100).toFixed(1) : 0}%）`;
      $('#statsRows').innerHTML = total ? order.map((id) => {
        const e = byId.get(id); const share = e.count / total * 100; const cfg = probs[id];
        const diff = cfg == null ? null : share - cfg;
        const diffTxt = diff == null ? '—' : `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%`;
        const cls = diff == null ? '' : Math.abs(diff) >= 5 ? ' class="stat-off"' : '';
        return `<tr><td>${esc(e.name)}</td><td>${e.count}</td><td>${share.toFixed(1)}%</td><td>${cfg == null ? '（已抽完 / 已刪除）' : `${cfg.toFixed(1)}%`}</td><td${cls}>${diffTxt}</td><td>${e.pity || ''}</td></tr>`;
      }).join('') : '<tr><td colspan="6" class="hint">還沒有紀錄</td></tr>';
    }
    $('#recordSearch').addEventListener('input', renderRecords);
    async function undoLastBatch() {
      if (!state.records.length) { toast('沒有可撤銷的紀錄'); return false; }
      const bid = state.records[state.records.length - 1].batchId;
      const batch = state.records.filter((r) => r.batchId === bid);
      const names = batch.map((r) => r.prize).join('、');
      const okd = await ask(`${batch[0].time}　${batch[0].type}　${batch.length} 筆${batch[0].player ? `　抽獎者：${batch[0].player}` : ''}\n獎項：${names}\n\n庫存會加回，紀錄與 Excel 內的這幾筆會一併移除。確定撤銷？`, { title: '撤銷上一批抽獎', okLabel: '確定撤銷', danger: true });
      if (!okd) return false;
      state.records = undoBatch(state.records, state.config.prizes, bid).records;
      Store.set(KEYS.records, state.records);
      saveConfig(true); renderRecords(); renderPityInfo();
      Excel.writeAll().then((r) => toast(r.ok ? `已撤銷並更新 Excel（${r.name}）` : '已撤銷')).catch((e) => toast(`已撤銷，但 Excel 更新失敗：${e.message}`, 6000));
      return true;
    }
    $('#undoLast').addEventListener('click', undoLastBatch);
    $('#undoThis').addEventListener('click', async () => { if (await undoLastBatch()) $('#resultModal').classList.add('hidden'); });
    $('#clearRecords').addEventListener('click', async () => {
      if (!(await ask('清除瀏覽器裡的所有抽獎紀錄？（已綁定的 Excel 檔不會被改動，直到下次寫入）', { title: '清除紀錄', okLabel: '清除', danger: true }))) return;
      state.records = []; Store.set(KEYS.records, state.records); renderRecords();
    });
    const excelAction = (fn) => async () => { try { const r = await fn(); if (r && r.ok) toast(`已寫入 ${r.name}`); } catch (e) { if (e.name !== 'AbortError') toast(`Excel 失敗：${e.message}`, 5000); } };
    $('#excelCreate').addEventListener('click', excelAction(() => Excel.create()));
    $('#excelOpen').addEventListener('click', excelAction(() => Excel.open()));
    $('#excelWrite').addEventListener('click', excelAction(() => Excel.writeAll()));
    $('#excelForget').addEventListener('click', () => Excel.forget());
    $('#excelDownload').addEventListener('click', () => Excel.download());
    function renderExcel(ex) {
      $('#excelInfo').textContent = ex.statusText();
      if (!ex.supported) { ['#excelCreate', '#excelOpen', '#excelWrite', '#excelForget'].forEach((s) => { $(s).disabled = true; }); return; }
      $('#excelWrite').disabled = $('#excelForget').disabled = !ex.handle;
    }

    // ======================================================================
    //  抽獎
    // ======================================================================
    function renderPityInfo() {
      const cfg = state.config; const el = $('#pityInfo');
      const hasPool = cfg.prizes.some((p) => p.pity);
      if (!(cfg.pityAccum || cfg.pityBatch) || !hasPool) { el.classList.add('hidden'); return; }
      el.classList.remove('hidden');
      const parts = [];
      if (cfg.pityAccum) {
        const player = $('#player').value.trim();
        const left = Math.max(0, cfg.pityAccumN - drawsSinceHit(state.records, cfg, player));
        const who = cfg.pityScope === 'global' ? '全體' : (player || '匿名');
        parts.push(left === 0 ? `${who}：下一抽必中保底獎` : `${who}：再 ${left} 抽觸發累積保底`);
      }
      if (cfg.pityBatch) parts.push(`每 ${cfg.pityBatchK} 抽至少 1 個保底獎`);
      el.textContent = parts.join('　｜　');
    }
    $('#player').addEventListener('input', renderPityInfo);

    function setSpinning(v) {
      state.spinning = v;
      if (window.WheelBG) WheelBG.setSpinning(v);
      $$('.spin-btn').forEach((b) => { b.disabled = v; });
      $('#skipBtn').classList.toggle('hidden', !v);
    }
    function doSpin(countRaw, player) {
      const { batchId, type, count, results, recs, time } = drawBatch({ cfg: state.config, records: state.records, count: countRaw, player });
      if (recs.length) { state.records.push(...recs); Store.set(KEYS.records, state.records); Store.set(KEYS.config, state.config); }
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
          liveChip($('#liveResults'), r);
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
    $('#skipBtn').addEventListener('click', () => { state.skipAll = true; wheel.skip(); });
    $('#skipAnim').checked = Store.get(KEYS.skipAnim, false) === true;
    $('#skipAnim').addEventListener('change', (e) => Store.set(KEYS.skipAnim, e.target.checked));
    $$('.spin-btn[data-count]').forEach((b) => b.addEventListener('click', () => spin(Number(b.dataset.count))));
    $('#customSpin').addEventListener('click', () => spin(Number($('#customCount').value) || 1));
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) { e.preventDefault(); spin(1); }
    });
    $('#closeResult').addEventListener('click', () => $('#resultModal').classList.add('hidden'));
    $('#resultModal').addEventListener('click', (e) => { if (e.target.id === 'resultModal') e.target.classList.add('hidden'); });

    // ======================================================================
    //  啟動
    // ======================================================================
    state.config = normalizeConfig(Store.get(KEYS.config, DEFAULT_CONFIG));
    state.records = Store.get(KEYS.records, []);
    Store.set(KEYS.config, state.config);
    renderAll(); markDirty(false);
    Excel.init({ getRecords: () => state.records, onChange: renderExcel });
    if (window.anime) {
      anime({ targets: '.wheel-wrap', scale: [0.6, 1], opacity: [0, 1], rotate: [-40, 0], duration: 1100, easing: 'easeOutElastic(1, .6)' });
      anime({ targets: '.controls, .topbar', translateY: [24, 0], opacity: [0, 1], delay: anime.stagger(120, { start: 200 }), duration: 700, easing: 'easeOutCubic' });
    }
    Sync.on((msg) => {
      if (msg.type === 'hello') Sync.send({ type: 'config', config: state.config });
      else if (msg.type === 'pong') state.pongs += 1;
    });
    Sync.start(state.config.room, state.config);
    window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
  }

  LW.startControl = startControl;
})();
