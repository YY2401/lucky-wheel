/* 控制台邏輯 */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const { Wheel, Sfx, Confetti, PALETTE } = LuckyWheel;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = { config: null, dirty: false, spinning: false, skipAll: false };
  const wheel = new Wheel($('#wheel'), { onTick: () => Sfx.tick() });
  const confetti = new Confetti($('#confetti'));

  async function api(method, url, body) {
    const r = await fetch(url, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }
  function toast(msg, ms = 3000) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ---------- 設定 ----------
  async function loadConfig() {
    state.config = await api('GET', '/api/config');
    markDirty(false);
    renderAll();
  }
  function markDirty(v = true) {
    state.dirty = v;
    $('#dirtyHint').textContent = v ? '● 有未儲存的變更' : '';
    $('#savePrizes').classList.toggle('pulse', v);
  }
  async function saveConfig(silent) {
    state.config = await api('PUT', '/api/config', state.config);
    markDirty(false);
    renderAll();
    if (!silent) toast('已儲存設定');
  }
  function renderAll() {
    const c = state.config;
    document.title = `${c.title}｜控制台`;
    $('#title').textContent = c.title;
    renderPrizeRows();
    renderSettings();
    updateWheel();
  }
  function updateWheel() {
    wheel.setPrizes(state.config.prizes, state.config.segmentMode);
    renderProbBar();
    refreshComputed();
    Sfx.enabled = !!state.config.sound;
  }
  function availableProbs(prizes) {
    const pool = prizes.filter((p) => p.weight > 0 && p.remaining !== 0);
    const total = pool.reduce((s, p) => s + Number(p.weight), 0);
    const m = {};
    pool.forEach((p) => { m[p.id] = total ? (p.weight / total) * 100 : 0; });
    return m;
  }
  function colorOf(p, i) { return p.color || PALETTE[i % PALETTE.length]; }

  // ---------- 獎項表格 ----------
  function renderPrizeRows() {
    const tb = $('#prizeRows');
    tb.innerHTML = '';
    state.config.prizes.forEach((p, i) => {
      const unlimited = p.quantity === -1;
      const tr = document.createElement('tr');
      tr.dataset.id = p.id;
      tr.innerHTML = `
        <td><div style="display:flex;gap:6px;align-items:center">
          <div class="thumb" title="點擊上傳圖片">${p.image ? `<img src="${esc(p.image)}" alt="">` : '📷'}</div>
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
        <td style="white-space:nowrap">
          <button class="btn icon f-up" title="上移">↑</button>
          <button class="btn icon f-down" title="下移">↓</button>
          <button class="btn icon f-del" title="刪除">✕</button>
        </td>`;
      tb.appendChild(tr);

      const on = (sel, ev, fn) => $(sel, tr).addEventListener(ev, fn);
      on('.f-name', 'input', (e) => { p.name = e.target.value; markDirty(); updateWheel(); });
      on('.f-weight', 'input', (e) => { p.weight = Math.max(0, Number(e.target.value) || 0); markDirty(); updateWheel(); });
      on('.f-quantity', 'input', (e) => {
        const q = Math.max(0, Math.trunc(Number(e.target.value)) || 0);
        const diff = q - p.quantity;
        p.quantity = q;
        p.remaining = Math.min(q, Math.max(0, p.remaining + diff)); // 增減總量時同步調整剩餘
        $('.f-remaining', tr).value = p.remaining;
        markDirty(); updateWheel();
      });
      on('.f-remaining', 'input', (e) => {
        p.remaining = Math.min(p.quantity, Math.max(0, Math.trunc(Number(e.target.value)) || 0));
        markDirty(); updateWheel();
      });
      on('.f-unlimited', 'change', (e) => {
        if (e.target.checked) { p.quantity = -1; p.remaining = -1; }
        else { p.quantity = 10; p.remaining = 10; }
        markDirty(); renderPrizeRows(); updateWheel();
      });
      on('.f-color', 'input', (e) => { p.color = e.target.value; markDirty(); updateWheel(); });
      on('.f-del', 'click', () => {
        if (!confirm(`刪除「${p.name}」？`)) return;
        state.config.prizes.splice(i, 1); markDirty(); renderPrizeRows(); updateWheel();
      });
      on('.f-up', 'click', () => { if (i === 0) return; const a = state.config.prizes; [a[i - 1], a[i]] = [a[i], a[i - 1]]; markDirty(); renderPrizeRows(); updateWheel(); });
      on('.f-down', 'click', () => { const a = state.config.prizes; if (i >= a.length - 1) return; [a[i + 1], a[i]] = [a[i], a[i + 1]]; markDirty(); renderPrizeRows(); updateWheel(); });
      on('.thumb', 'click', () => $('.f-file', tr).click());
      on('.f-file', 'change', async (e) => {
        const file = e.target.files[0]; if (!file) return;
        try {
          const dataUrl = await downscale(file, 320);
          const { url } = await api('POST', '/api/upload', { name: file.name, data: dataUrl });
          p.image = url; markDirty(); renderPrizeRows(); updateWheel();
        } catch (err) { toast(`上傳失敗：${err.message}`); }
      });
      on('.f-url', 'click', () => {
        const u = prompt('輸入圖片網址', p.image || '');
        if (u === null) return;
        p.image = u.trim(); markDirty(); renderPrizeRows(); updateWheel();
      });
      on('.f-clearimg', 'click', () => { p.image = ''; markDirty(); renderPrizeRows(); updateWheel(); });
    });
    refreshComputed();
  }
  function refreshComputed() {
    const probs = availableProbs(state.config.prizes);
    $$('#prizeRows tr').forEach((tr) => {
      const p = state.config.prizes.find((x) => x.id === tr.dataset.id);
      if (!p) return;
      const pr = probs[p.id];
      $('.prob', tr).textContent = pr == null ? (p.remaining === 0 ? '已抽完' : '0%') : `${pr.toFixed(2)}%`;
      tr.classList.toggle('tr-soldout', pr == null);
      const rem = $('.f-remaining', tr);
      if (document.activeElement !== rem && p.quantity !== -1) rem.value = p.remaining;
    });
  }
  function renderProbBar() {
    const probs = availableProbs(state.config.prizes);
    const bar = $('#probBar');
    bar.innerHTML = '';
    state.config.prizes.forEach((p, i) => {
      if (probs[p.id] == null) return;
      const s = document.createElement('span');
      s.style.width = `${probs[p.id]}%`;
      s.style.background = colorOf(p, i);
      s.title = `${p.name} ${probs[p.id].toFixed(2)}%`;
      s.textContent = probs[p.id] >= 8 ? `${p.name} ${probs[p.id].toFixed(1)}%` : '';
      bar.appendChild(s);
    });
  }
  function downscale(file, max) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('讀取檔案失敗'));
      reader.onload = () => {
        if (file.type === 'image/gif' || file.type === 'image/svg+xml') return resolve(reader.result);
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const cv = document.createElement('canvas');
          cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          resolve(cv.toDataURL('image/png'));
        };
        img.onerror = () => reject(new Error('不是有效的圖片'));
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ---------- 設定頁 ----------
  const SETTING_KEYS = ['title', 'segmentMode', 'spinDuration', 'multiSpinDuration', 'turns', 'overlayResultSeconds', 'excelPath'];
  function renderSettings() {
    const c = state.config;
    SETTING_KEYS.forEach((k) => { $(`#s-${k}`).value = c[k]; });
    $('#s-sound').checked = !!c.sound;
    $('#overlayUrl').textContent = `${location.origin}/overlay.html`;
    $('#apiUrl').textContent = `${location.origin}/api/spin?count=1&player=名字`;
  }
  $('#saveSettings').addEventListener('click', async () => {
    const c = state.config;
    SETTING_KEYS.forEach((k) => { c[k] = $(`#s-${k}`).value; });
    c.sound = $('#s-sound').checked;
    try { await saveConfig(); } catch (e) { toast(`儲存失敗：${e.message}`); }
  });
  $('#savePrizes').addEventListener('click', () => saveConfig().catch((e) => toast(`儲存失敗：${e.message}`)));
  $('#addPrize').addEventListener('click', () => {
    const n = state.config.prizes.length;
    state.config.prizes.push({ id: `p_${Date.now().toString(36)}`, name: `獎項 ${n + 1}`, weight: 10, quantity: -1, remaining: -1, image: '', color: PALETTE[n % PALETTE.length] });
    markDirty(); renderPrizeRows(); updateWheel();
  });
  $('#resetStock').addEventListener('click', async () => {
    if (!confirm('把所有獎項的剩餘數量重置為原始數量？')) return;
    if (state.dirty) await saveConfig(true);
    state.config = await api('POST', '/api/reset-stock');
    markDirty(false); renderAll(); toast('庫存已重置');
  });
  $('#copyOverlay').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(`${location.origin}/overlay.html`); toast('已複製覆蓋層網址'); }
    catch { prompt('請手動複製', `${location.origin}/overlay.html`); }
  });
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
    if (b.dataset.tab === 'records') loadRecords();
  }));

  // ---------- 紀錄頁 ----------
  async function loadRecords() {
    const { records, total, excelPath } = await api('GET', '/api/records?limit=300');
    $('#excelInfo').textContent = `共 ${total} 筆　Excel：${excelPath}`;
    $('#recordRows').innerHTML = records.map((r) => `<tr>
      <td>${esc(r.time)}</td><td>${esc(r.player)}</td><td>${esc(r.type)}</td><td>${r.index}</td>
      <td>${esc(r.prize)}</td><td>${r.remaining === -1 ? '∞' : r.remaining}</td><td>${r.probability}%</td></tr>`).join('');
  }
  $('#refreshRecords').addEventListener('click', loadRecords);
  $('#exportExcel').addEventListener('click', async () => {
    try { const r = await api('POST', '/api/export'); toast(`已重建 Excel（${r.count} 筆）：${r.path}`, 5000); }
    catch (e) { toast(`匯出失敗：${e.message}`, 6000); }
  });
  $('#clearRecords').addEventListener('click', async () => {
    if (!confirm('清除所有抽獎紀錄（records.json）？Excel 檔不會被刪除。')) return;
    await api('DELETE', '/api/records'); loadRecords();
  });

  // ---------- 抽獎 ----------
  function setSpinning(v) {
    state.spinning = v;
    $$('.spin-btn').forEach((b) => { b.disabled = v; });
    $('#skipBtn').classList.toggle('hidden', !v);
  }
  $('#skipBtn').addEventListener('click', () => { state.skipAll = true; wheel.skip(); });
  $$('.spin-btn[data-count]').forEach((b) => b.addEventListener('click', () => spin(Number(b.dataset.count))));
  $('#customSpin').addEventListener('click', () => spin(Number($('#customCount').value) || 1));
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) { e.preventDefault(); spin(1); }
  });

  async function spin(count) {
    if (state.spinning) return;
    setSpinning(true);
    try {
      if (state.dirty) await saveConfig(true);
      const res = await api('POST', '/api/spin', { count, player: $('#player').value.trim() });
      await playBatch(res);
    } catch (e) { toast(`抽獎失敗：${e.message}`); }
    finally { setSpinning(false); }
  }

  function addLive(r) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.setProperty('--c', r.color || '#888');
    chip.innerHTML = `${r.image ? `<img src="${esc(r.image)}" alt="">` : '<span class="dot"></span>'}${esc(r.name)}`;
    $('#liveResults').appendChild(chip);
  }

  async function playBatch(res) {
    $('#liveResults').innerHTML = '';
    state.skipAll = false;
    if (!res.results.length) { toast('沒有可抽的獎項（獎項都抽完或權重為 0）'); return; }
    const cfg = state.config;
    const fast = $('#fastMode').checked && res.results.length > 1;
    if (fast) {
      await wheel.spinTo(res.results[res.results.length - 1].prizeId, { duration: cfg.spinDuration, turns: cfg.turns });
      res.results.forEach(addLive);
    } else {
      for (let i = 0; i < res.results.length; i++) {
        const r = res.results[i];
        const first = i === 0;
        await wheel.spinTo(r.prizeId, {
          duration: state.skipAll ? 0 : (first ? cfg.spinDuration : cfg.multiSpinDuration),
          turns: first ? cfg.turns : Math.max(2, Math.round(cfg.turns / 2)),
        });
        addLive(r);
        if (res.results.length > 1) Sfx.pop();
        if (!state.skipAll) await wait(350);
      }
    }
    applyPrizes(res.prizes);
    Sfx.win();
    confetti.burst(res.results.length > 1 ? 260 : 160);
    showResult(res);
  }
  function applyPrizes(prizes) {
    if (!state.dirty) state.config.prizes = prizes;
    else prizes.forEach((p) => { const l = state.config.prizes.find((x) => x.id === p.id); if (l) l.remaining = p.remaining; });
    updateWheel();
  }
  function showResult(res) {
    const counts = new Map();
    res.results.forEach((r) => counts.set(r.name, (counts.get(r.name) || 0) + 1));
    $('#resultTitle').textContent = res.results.length > 1 ? `🎉 ${res.batchType}結果` : '🎉 恭喜獲得';
    $('#resultSub').textContent = [res.player && `抽獎者：${res.player}`, res.exhausted && '（部分獎項已抽完，實際抽數少於設定）'].filter(Boolean).join('　');
    $('#resultSummary').innerHTML = res.results.length > 1
      ? [...counts].map(([n, c]) => `<span class="chip">${esc(n)} × ${c}</span>`).join('') : '';
    $('#resultGrid').innerHTML = res.results.map((r, i) => `
      <div class="r-card" style="--c:${esc(r.color || '#888')};animation-delay:${i * 40}ms">
        <div class="r-img">${r.image ? `<img src="${esc(r.image)}" alt="">` : '🎁'}</div>
        <div class="r-name">${esc(r.name)}</div>
        <div class="r-idx">第 ${r.index} 抽</div>
      </div>`).join('');
    const ex = $('#excelStatus');
    ex.textContent = res.excel.ok ? `✔ 已寫入 Excel：${res.excel.path}` : `✖ Excel 寫入失敗：${res.excel.error}（紀錄仍保存在 records.json，可稍後在「抽獎紀錄」重建）`;
    ex.classList.toggle('bad', !res.excel.ok);
    $('#resultModal').classList.remove('hidden');
  }
  $('#closeResult').addEventListener('click', () => $('#resultModal').classList.add('hidden'));
  $('#resultModal').addEventListener('click', (e) => { if (e.target.id === 'resultModal') e.target.classList.add('hidden'); });

  // ---------- SSE：同步其他來源（覆蓋層 / Stream Deck）的動作 ----------
  function connectSSE() {
    const es = new EventSource('/api/events');
    const st = $('#sseStatus');
    es.onopen = () => { st.className = 'status ok'; st.lastChild.textContent = '已連線'; };
    es.onerror = () => { st.className = 'status bad'; st.lastChild.textContent = '連線中斷，重連中…'; };
    es.addEventListener('spin', (e) => {
      const d = JSON.parse(e.data);
      if (state.spinning) return; // 自己觸發的抽獎已在播放
      setSpinning(true);
      if ($('#player').value.trim() === '' && d.player) $('#player').placeholder = d.player;
      playBatch(d).finally(() => setSpinning(false));
    });
    es.addEventListener('config', (e) => {
      const { config } = JSON.parse(e.data);
      if (!state.dirty) { state.config = config; renderAll(); }
      else applyPrizes(config.prizes);
    });
  }

  loadConfig().then(connectSSE).catch((e) => toast(`載入設定失敗：${e.message}`));
})();
