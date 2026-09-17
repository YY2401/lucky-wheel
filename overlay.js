/* OBS 覆蓋層：透明背景，只聽同步頻道，不能操作 */
(function () {
  const LW = (window.LW = window.LW || {});
  const { Wheel, Sfx, Confetti } = LuckyWheel;
  const { DEFAULT_CONFIG, normalizeConfig, normalizePrize } = LuckyCore;
  const { $, $$, wait, isFlip, flipTotal, resultCards, scheduleFlipSounds, liveChip, renderPrizeListRows, applyTheme } = LW.ui;

  function startOverlay(params) {
    const { Store, Sync, KEYS } = LW;
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
    const showList = params.get('list') === '1';
    const listOpts = { prob: params.get('lp') !== '0', stock: params.get('ls') !== '0' };
    if (showList) $('#ovPrizeList').classList.remove('hidden');
    const renderList = () => { if (showList) renderPrizeListRows($('#ovPrizeListRows'), config.prizes, listOpts); };

    // 先用本機快取的設定畫轉盤（同一瀏覽器直接共用，跨瀏覽器則等控制台回覆）
    let config = normalizeConfig(Store.get(KEYS.config, null) || Store.get(KEYS.overlayConfig, null) || DEFAULT_CONFIG);
    const room = params.get('room') || config.room;
    function applyConfig(c) {
      config = normalizeConfig(c);
      Store.set(KEYS.overlayConfig, config);
      Sfx.enabled = soundParam === '0' ? false : !!config.sound;
      try { localStorage.setItem('lw.bg3d', config.bg3d ? '1' : '0'); } catch { /* ignore */ }
      applyTheme(params.get('theme') || config.theme, wheel);
      wheel.setPrizes(config.prizes, config.segmentMode, config.minSlice / 100);
      renderList();
      if (window.WheelBG && params.get('bg') !== '0') WheelBG.setEnabled(config.bg3d);
    }
    if (params.get('status') !== '0') $('#ovStatus').classList.remove('hidden');
    applyConfig(config);

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
          if (d.results.length > 1) { liveChip($('#ovLive'), r); Sfx.pop(); await wait(350); }
        }
      }
      if (d.prizes) { config.prizes = d.prizes.map(normalizePrize); Store.set(KEYS.overlayConfig, config); wheel.setPrizes(config.prizes, config.segmentMode, config.minSlice / 100); renderList(); }
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

    Sync.onStatus = (state) => {
      const dot = $('#ovStatus');
      dot.className = `ov-status ${state === 'online' || state === 'local' ? 'ok' : state === 'connecting' ? 'wait' : 'bad'}`;
      dot.title = { local: '同瀏覽器同步', online: '跨瀏覽器同步中', connecting: '連線中', offline: '中繼離線', off: '關閉' }[state];
    };
    Sync.on((msg) => {
      if (msg.type === 'config') applyConfig(msg.config);
      else if (msg.type === 'spin') { queue.push(msg); pump(); }
      else if (msg.type === 'ping') { Sync.send({ type: 'pong' }); const d = $('#ovStatus'); d.classList.add('flash'); setTimeout(() => d.classList.remove('flash'), 1200); }
    });
    Sync.start(room, { sync: params.get('sync') !== '0', broker: params.get('broker') || config.broker });
    // 向控制台要最新設定（跨瀏覽器時需要）
    const hello = () => Sync.send({ type: 'hello' });
    setTimeout(hello, 500); setTimeout(hello, 3000);
  }

  LW.startOverlay = startOverlay;
})();
