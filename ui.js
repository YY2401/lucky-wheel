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
  function dialog({ title = '確認', message = '', input = null, okLabel = '確定', danger = false }) {
    return new Promise((resolve) => {
      const m = $('#confirmModal');
      if (!m) { resolve(input !== null ? window.prompt(message, input) : window.confirm(message)); return; }
      $('#confirmTitle').textContent = title; $('#confirmMsg').textContent = message;
      const inp = $('#confirmInput'); inp.classList.toggle('hidden', input === null); if (input !== null) inp.value = input;
      const ok = $('#confirmOk'); ok.textContent = okLabel; ok.className = `btn ${danger ? 'danger' : 'primary'}`;
      m.classList.remove('hidden');
      const cancelValue = input !== null ? null : false;
      const done = (v) => { m.classList.add('hidden'); ok.onclick = null; $('#confirmCancel').onclick = null; m.onclick = null; document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(cancelValue); if (e.key === 'Enter' && input !== null) done(inp.value); };
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
  function resultCards(results, showIndex, flip = true) {
    return results.map((r, i) => `
      <div class="r-card${flip ? '' : ' revealed'}" style="--c:${esc(r.color || '#888')}">
        <div class="flip-inner" style="--d:${FLIP.start + i * FLIP.gap}ms">
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
    for (let i = 0; i < n; i++) setTimeout(() => Sfx.pop(), FLIP.start + i * FLIP.gap + FLIP.dur * 0.45);
  }
  function liveChip(container, r) {
    const chip = document.createElement('span');
    chip.className = 'chip'; chip.style.setProperty('--c', r.color || '#888');
    chip.innerHTML = `${r.image ? `<img src="${esc(r.image)}" alt="">` : '<span class="dot"></span>'}${esc(r.name)}`;
    container.appendChild(chip);
  }

  // ---------- 獎項一覽（控制台面板與 OBS 覆蓋層共用） ----------
  function renderPrizeListRows(container, prizes, { prob = true, stock = true } = {}) {
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

  LW.ui = { $, $$, wait, esc, colorOf, toast, dialog, ask, isFlip, flipTotal, resultCards, scheduleFlipSounds, liveChip, renderPrizeListRows, applyTheme };
})();
