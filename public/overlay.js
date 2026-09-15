/* OBS 覆蓋層：只聽 SSE，不能操作；背景透明 */
(() => {
  const $ = (s) => document.querySelector(s);
  const { Wheel, Sfx, Confetti } = LuckyWheel;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const params = new URLSearchParams(location.search);
  const size = Number(params.get('size')) || 520;
  const mode = params.get('mode') === 'spin' ? 'spin' : 'always'; // spin = 只在抽獎時顯示轉盤
  const hideParam = Number(params.get('hide'));
  if (params.get('sound') === '0') Sfx.enabled = false;
  document.documentElement.style.setProperty('--size', `${size}px`);

  const stage = $('#stage');
  const wheel = new Wheel($('#wheel'), { onTick: () => Sfx.tick() });
  const confetti = new Confetti($('#confetti'));
  let config = null;
  const queue = [];
  let busy = false;
  if (mode === 'spin') stage.classList.add('out');

  function applyConfig(c) {
    config = c;
    document.title = `${c.title}｜OBS`;
    if (params.get('sound') !== '0') Sfx.enabled = !!c.sound;
    wheel.setPrizes(c.prizes, c.segmentMode);
  }

  function addLive(r) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.setProperty('--c', r.color || '#888');
    chip.innerHTML = `${r.image ? `<img src="${esc(r.image)}" alt="">` : '<span class="dot"></span>'}${esc(r.name)}`;
    $('#liveResults').appendChild(chip);
  }

  async function play(d) {
    if (!d.results.length) return;
    const cfg = config || { spinDuration: 5000, multiSpinDuration: 1500, turns: 6, overlayResultSeconds: 8 };
    $('#liveResults').innerHTML = '';
    stage.classList.remove('out');
    await wait(mode === 'spin' ? 600 : 50);
    for (let i = 0; i < d.results.length; i++) {
      const r = d.results[i];
      const first = i === 0;
      await wheel.spinTo(r.prizeId, {
        duration: first ? cfg.spinDuration : cfg.multiSpinDuration,
        turns: first ? cfg.turns : Math.max(2, Math.round(cfg.turns / 2)),
      });
      if (d.results.length > 1) { addLive(r); Sfx.pop(); await wait(350); }
    }
    wheel.setPrizes(d.prizes, cfg.segmentMode);
    Sfx.win();
    confetti.burst(d.results.length > 1 ? 260 : 160);

    // 結果卡
    const counts = new Map();
    d.results.forEach((r) => counts.set(r.name, (counts.get(r.name) || 0) + 1));
    $('#resultCard').classList.toggle('single', d.results.length === 1);
    $('#rTitle').textContent = d.results.length > 1 ? `🎉 ${d.batchType}結果` : '🎉 恭喜獲得';
    $('#rPlayer').textContent = d.player ? `🎯 ${d.player}` : '';
    $('#rSummary').innerHTML = d.results.length > 1 ? [...counts].map(([n, c]) => `<span class="chip">${esc(n)} × ${c}</span>`).join('') : '';
    $('#rGrid').innerHTML = d.results.map((r, i) => `
      <div class="r-card" style="--c:${esc(r.color || '#888')};animation-delay:${i * 40}ms">
        <div class="r-img">${r.image ? `<img src="${esc(r.image)}" alt="">` : '🎁'}</div>
        <div class="r-name">${esc(r.name)}</div>
        ${d.results.length > 1 ? `<div class="r-idx">第 ${r.index} 抽</div>` : ''}
      </div>`).join('');
    $('#resultLayer').classList.remove('out');
    await wait((hideParam || cfg.overlayResultSeconds || 8) * 1000);
    $('#resultLayer').classList.add('out');
    $('#liveResults').innerHTML = '';
    if (mode === 'spin') stage.classList.add('out');
  }

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) { try { await play(queue.shift()); } catch (e) { console.error(e); } }
    busy = false;
  }

  function connect() {
    const es = new EventSource('/api/events');
    es.addEventListener('hello', (e) => applyConfig(JSON.parse(e.data).config));
    es.addEventListener('config', (e) => applyConfig(JSON.parse(e.data).config));
    es.addEventListener('spin', (e) => { queue.push(JSON.parse(e.data)); pump(); });
  }
  connect();
})();
