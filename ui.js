/* 共用介面工具：DOM 選取、提示、頁內對話框、結果卡、主題（控制台與覆蓋層共用） */
(function () {
  const LW = (window.LW = window.LW || {});
  const { PALETTE } = LuckyCore;
  const { Sfx } = LuckyWheel;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const colorOf = (p, i) => p.color || PALETTE[i % PALETTE.length];

  function toast(msg, ms = 3000) {
    const t = $('#toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
  }

  // 頁內確認 / 輸入視窗：OBS 內建瀏覽器不會顯示原生 confirm，所以自己畫
  // input：單行輸入；textarea：多行輸入（回傳字串，取消回傳 null）
  // file：{ accept, read(file) → Promise<string> }，多行模式下提供「從檔案匯入」把內容填進 textarea
  function dialog({ title = '確認', message = '', input = null, textarea = null, okLabel = '確定', danger = false, file = null }) {
    if (textarea !== null) input = textarea;
    return new Promise((resolve) => {
      const m = $('#confirmModal');
      if (!m) { resolve(input !== null ? window.prompt(message, input) : window.confirm(message)); return; }
      $('#confirmTitle').textContent = title; $('#confirmMsg').textContent = message;
      const single = $('#confirmInput'); const multi = $('#confirmTextarea');
      const inp = textarea !== null ? multi : single;
      single.classList.toggle('hidden', textarea !== null || input === null); multi.classList.toggle('hidden', textarea === null);
      if (input !== null) inp.value = input;
      const fileBtn = $('#confirmFileBtn'); const fileInp = $('#confirmFile');
      fileBtn.classList.toggle('hidden', !file);
      if (file) { fileInp.accept = file.accept || ''; fileBtn.onclick = () => fileInp.click(); fileInp.onchange = async () => { const f = fileInp.files[0]; fileInp.value = ''; if (!f) return; try { const txt = await file.read(f); multi.value = (multi.value.trim() ? `${multi.value.trim()}\n` : '') + txt; } catch (e) { toast(`讀取失敗：${e.message}`); } }; }
      const ok = $('#confirmOk'); ok.textContent = okLabel; ok.className = `btn ${danger ? 'danger' : 'primary'}`;
      m.classList.remove('hidden');
      const cancelValue = input !== null ? null : false;
      const done = (v) => { m.classList.add('hidden'); ok.onclick = null; $('#confirmCancel').onclick = null; m.onclick = null; fileBtn.onclick = null; fileInp.onchange = null; document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(cancelValue); if (e.key === 'Enter' && input !== null && textarea === null) done(inp.value); };
      ok.onclick = () => done(input !== null ? inp.value : true);
      $('#confirmCancel').onclick = () => done(cancelValue);
      m.onclick = (e) => { if (e.target === m) done(cancelValue); };
      document.addEventListener('keydown', onKey);
      setTimeout(() => (input !== null ? inp : ok).focus(), 50);
    });
  }
  const ask = (message, opts = {}) => dialog({ message, ...opts });

  // ---------- 結果卡（翻牌） ----------
  const FLIP = { start: 500, gap: 160, dur: 900 };
  // 連抽且採翻牌模式時，轉盤只轉一次、結果用翻牌揭曉
  const isFlip = (d) => d.results.length > 1 && d.reveal !== 'each';
  const flipTotal = (n, flip = true) => (flip ? FLIP.start + (n - 1) * FLIP.gap + FLIP.dur : 0);
  function resultCards(results, showIndex, flip = true, { redraw = false } = {}) {
    return results.map((r, i) => `
      <div class="r-card${flip ? '' : ' revealed'} tier-${esc(r.tier || 'normal')}" style="--c:${esc(r.color || '#888')}" data-rid="${esc(r.rid || '')}">
        <div class="flip-inner" style="--d:${FLIP.start + i * FLIP.gap}ms">
          <div class="flip-face flip-back${flip && r.tier === 'big' ? ' tease' : ''}"><span class="q">?</span></div>
          <div class="flip-face flip-front">
            ${r.tier === 'big' ? '<span class="ribbon">★ 大獎 ★</span><span class="stamp">中了！</span>' : r.tier === 'miss' ? '<span class="sticker">再接再厲</span>' : ''}
            ${r.pity ? '<span class="badge-pity">保底</span>' : ''}
            ${redraw && r.rid ? `<button type="button" class="r-redraw" data-rid="${esc(r.rid)}" title="只重抽這一抽">補抽</button>` : ''}
            ${r.redrawOf ? '<span class="badge-redraw">補抽</span>' : ''}
            <div class="r-img">${r.image ? `<img src="${esc(r.image)}" alt="">` : '<span class="r-dot"></span>'}</div>
            <div class="r-name">${esc(r.name)}</div>
            ${showIndex ? `<div class="r-idx">第 ${r.index} 抽</div>` : ''}
          </div>
        </div>
      </div>`).join('');
  }
  function scheduleFlipSounds(n) {
    for (let i = 0; i < n; i++) setTimeout(() => Sfx.pop(), FLIP.start + i * FLIP.gap + FLIP.dur * 0.45);
  }
  function liveChip(container, r) {
    const chip = document.createElement('span');
    chip.className = 'chip'; chip.style.setProperty('--c', r.color || '#888');
    chip.innerHTML = `${r.image ? `<img src="${esc(r.image)}" alt="">` : '<span class="dot"></span>'}${esc(r.name)}`;
    container.appendChild(chip);
  }

  // ---------- 抽獎前倒數 3、2、1（控制台與覆蓋層共用；anime.js 有載入就做縮放淡出） ----------
  async function runCountdown(n, { onTick, shouldStop } = {}) {
    const box = $('#countdown'); if (!box || !(n > 0)) return;
    const num = box.firstElementChild;
    box.classList.remove('hidden');
    for (let i = n; i >= 1; i--) {
      if (shouldStop && shouldStop()) break;
      num.textContent = i; if (onTick) onTick(i);
      if (window.anime) { anime.remove(num); anime({ targets: num, scale: [{ value: 1, duration: 500, easing: 'easeOutBack' }], opacity: [{ value: 1, duration: 120 }, { value: 1, duration: 580 }, { value: 0, duration: 250 }], rotate: [{ value: 0, duration: 500 }], easing: 'easeOutCubic' }); num.style.transform = 'scale(1.8) rotate(-8deg)'; num.style.opacity = 0; }
      await wait(1000);
    }
    box.classList.add('hidden');
  }

  // ---------- 獎項一覽（控制台面板與 OBS 覆蓋層共用） ----------
  function renderPrizeListRows(container, prizes, { prob = true, stock = true } = {}) {
    const panel = container.closest('.prize-list'); if (panel) panel.classList.toggle('many', prizes.length > 14);
    const probs = LuckyCore.probabilities(prizes);
    container.innerHTML = prizes.map((p, i) => {
      const pr = probs[p.id]; const soldOut = p.remaining === 0;
      return `<li class="${soldOut ? 'soldout' : ''}">
        <span class="pl-dot" style="--c:${esc(colorOf(p, i))}">${p.image ? `<img src="${esc(p.image)}" alt="">` : ''}</span>
        <span class="pl-name">${esc(p.name)}</span>
        ${p.pity ? '<span class="pl-pity">保底</span>' : ''}
        ${stock ? `<span class="pl-stock">${p.quantity === -1 ? '不限' : soldOut ? '抽完' : `剩 ${p.remaining}`}</span>` : ''}
        ${prob ? `<span class="pl-prob">${pr == null ? '—' : `${pr.toFixed(pr < 10 ? 2 : 1)}%`}</span>` : ''}
      </li>`;
    }).join('') || '<li class="hint">還沒有獎項</li>';
  }

  // ---------- 落地反應：依等級決定閃光、彩帶、音效、搖頭 ----------
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function celebrate(tier, { wheel, confetti, count = 1 } = {}) {
    if (wheel) wheel.focus(tier === 'big' ? 2000 : 1400);
    if (tier === 'miss') { Sfx.sad(); return; }
    if (tier === 'big') {
      Sfx.fanfare();
      if (!reduceMotion()) {
        const f = $('#flash'); if (f) { f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }
        if (wheel) wheel.strobe(1200);
        if (window.WheelBG) { WheelBG.burst(); const b = document.body.getBoundingClientRect(); WheelBG.burstAt(b.width / 2, b.height / 2, 160); }
      }
      if (confetti) { confetti.burst(420, ['#ffcf33', '#ffffff', '#e63b3b', '#141414']); setTimeout(() => confetti.burst(260, ['#ffcf33', '#ffffff']), 500); }
      return;
    }
    Sfx.win();
    if (confetti) confetti.burst(count > 1 ? 260 : 160);
    if (window.WheelBG) WheelBG.burst();
  }
  function shakeResultBox(el) { if (!el || reduceMotion()) return; el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }

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

  LW.ui = { $, $$, wait, esc, colorOf, toast, dialog, ask, isFlip, flipTotal, resultCards, scheduleFlipSounds, liveChip, renderPrizeListRows, runCountdown, celebrate, shakeResultBox, applyTheme };
})();
