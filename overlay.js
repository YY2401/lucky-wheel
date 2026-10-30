/* OBS 覆蓋層：透明背景，只聽同步頻道，不能操作 */
(function () {
  const LW = (window.LW = window.LW || {});
  const { Wheel, Sfx, Confetti } = LuckyWheel;
  const { DEFAULT_CONFIG, normalizeConfig, normalizePrize, batchTier } = LuckyCore;
  const { $, $$, wait, isFlip, flipTotal, resultCards, scheduleFlipSounds, liveChip, renderPrizeListRows, runCountdown, celebrate, shakeResultBox, applyTheme } = LW.ui;

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
    { const pl = $('#ovPrizeList'); pl.classList.toggle('hidden', !showList); const pos = params.get('lpos'); if (pos === 'c') pl.classList.add('centered'); else if (pos === 'tr') pl.classList.add('pos-tr'); }
    const renderList = () => { if (showList) renderPrizeListRows($('#ovPrizeListRows'), config.prizes, listOpts); };

    // 先用本機快取的設定畫轉盤（同一瀏覽器直接共用，跨瀏覽器則等控制台回覆）
    let config = normalizeConfig(Store.get(KEYS.config, null) || Store.get(KEYS.overlayConfig, null) || DEFAULT_CONFIG);
    const room = params.get('room') || config.room;
    // 簽章金鑰：網址帶的 key 優先；同一個瀏覽器可直接讀控制台設定。兩者都沒有就拒收所有訊息
    const localCfg = Store.get(KEYS.config, null);
    const secret = params.get('key') || (localCfg && localCfg.room === room ? localCfg.secret : '') || '';
    function applyConfig(c) {
      config = normalizeConfig(c);
      Store.set(KEYS.overlayConfig, config);
      Sfx.enabled = soundParam === '0' ? false : !!config.sound; Sfx.volume = config.volume / 100;
      try { localStorage.setItem('lw.bg3d', config.bg3d ? '1' : '0'); } catch { /* ignore */ }
      applyTheme(params.get('theme') || config.theme, wheel);
      document.body.style.setProperty('--ov-bg-alpha', String(config.obsBgOpacity / 100)); // 背景透明度：只影響 body 底色
      wheel.setPrizes(config.prizes, config.segmentMode, config.minSlice / 100);
      renderList();
      if (window.WheelBG && params.get('bg') !== '0') WheelBG.setEnabled(config.bg3d);
    }
    if (params.get('status') !== '0') $('#ovStatus').classList.remove('hidden');
    // OBS「來源」裡的瀏覽器收不到滑鼠點擊；被點到代表貼錯地方（停駐視窗或一般瀏覽器）：提示一下，8 秒後收起
    const wrongPlace = () => {
      const w = $('#ovWrongPlace'); w.classList.remove('hidden');
      clearTimeout(w._t); w._t = setTimeout(() => w.classList.add('hidden'), 8000);
    };
    document.addEventListener('pointerdown', (e) => { if (e.isTrusted) wrongPlace(); }); // 只在真的被點時提示：滑鼠移動在某些環境沒人操作也會觸發，不能冒險出現在直播畫面上
    applyConfig(config);

    // 控制台連續快抽時覆蓋層會積壓：後面還有等待的批次就用快轉播（轉盤不轉、結果只停 2 秒）
    async function play(d, fast) {
      if (!d.results.length) return;
      $('#ovLive').innerHTML = '';
      stage.classList.remove('out');
      // 轉動中橫幅：誰在抽、抽幾連、保底狀態（觀眾看得到）
      $('#ovWho').textContent = `${d.player || '匿名'}　${d.batchType || ''}`;
      $('#ovPity').textContent = d.pity || '';
      $('#ovBanner').classList.remove('hidden');
      if (window.WheelBG) WheelBG.setSpinning(true);
      await wait(fast ? 0 : mode === 'spin' ? 600 : 50);
      if (!fast && d.countdown) await runCountdown(d.countdown, { onTick: () => Sfx.tick() });
      // 還沒收到控制台設定（OBS 比控制台晚開）：先用訊息附帶的獎項畫轉盤，不然找不到格子會空轉
      if (d.prizes && d.results.some((r) => !config.prizes.some((p) => p.id === r.prizeId))) {
        config.prizes = d.prizes.map(normalizePrize); await wheel.setPrizes(config.prizes, config.segmentMode, config.minSlice / 100); renderList();
      }
      const flip = isFlip(d);
      const dur = (ms) => (fast ? 0 : ms);
      if (flip) {
        await wheel.spinTo(d.results[0].prizeId, { duration: dur(config.spinDuration), turns: config.turns });
      } else {
        for (let i = 0; i < d.results.length; i++) {
          const r = d.results[i]; const first = i === 0;
          await wheel.spinTo(r.prizeId, { duration: dur(first ? config.spinDuration : config.multiSpinDuration), turns: first ? config.turns : Math.max(2, Math.round(config.turns / 2)) });
          if (d.results.length > 1) { liveChip($('#ovLive'), r); Sfx.pop(); if (!fast) await wait(350); }
        }
      }
      if (d.prizes) { config.prizes = d.prizes.map(normalizePrize); Store.set(KEYS.overlayConfig, config); wheel.setPrizes(config.prizes, config.segmentMode, config.minSlice / 100); renderList(); }
      const tier = batchTier(d.results);
      if (window.WheelBG) WheelBG.setSpinning(false);
      if (flip && !fast) { wheel.focus(1200); setTimeout(() => { celebrate(tier, { wheel: null, confetti, count: d.results.length }); if (tier === 'miss') shakeResultBox($('#ovResultCard')); }, flipTotal(d.results.length, true) - 300); }
      else { celebrate(tier, { wheel, confetti, count: d.results.length }); if (tier === 'miss') shakeResultBox($('#ovResultCard')); }
      $('#ovResultCard').classList.toggle('single', d.results.length === 1);
      $('#ovTitle').textContent = d.results.length > 1 ? `${d.batchType}結果` : '恭喜獲得';
      $('#ovPlayer').textContent = d.player ? d.player : '';
      $('#ovGrid').innerHTML = resultCards(d.results, d.results.length > 1, flip);
      $('#ovResultLayer').classList.remove('out');
      $('#ovLive').innerHTML = '';
      if (flip && !fast) scheduleFlipSounds(d.results.length);
      await wait(fast ? 2000 : flipTotal(d.results.length, flip) + (hideParam || config.overlayResultSeconds || 8) * 1000);
      $('#ovResultLayer').classList.add('out');
      $('#ovLive').innerHTML = '';
      $('#ovBanner').classList.add('hidden');
      if (mode === 'spin') stage.classList.add('out');
    }
    async function pump() { if (busy) return; busy = true; while (queue.length) { const d = queue.shift(); try { await play(d, queue.length > 0); } catch (e) { console.error(e); } } busy = false; }

    Sync.onStatus = (state) => {
      const dot = $('#ovStatus');
      if (!secret) { dot.className = 'ov-status bad nokey'; dot.title = '網址缺少金鑰，收不到控制台訊息：請到控制台重新複製 OBS 畫面網址'; return; }
      dot.className = `ov-status ${state === 'online' || state === 'local' ? 'ok' : state === 'connecting' ? 'wait' : 'bad'}`;
      dot.title = { local: '同瀏覽器同步', online: '跨瀏覽器同步中', connecting: '連線中', offline: '中繼離線', off: '關閉' }[state];
    };
    Sync.onReject = () => { const dot = $('#ovStatus'); dot.classList.add('reject'); setTimeout(() => dot.classList.remove('reject'), 1500); };
    // 除錯模式（網址加 &debug=1）：直接在畫面上顯示每台中繼伺服器的連線狀態和收到的訊息，OBS 裡看不到主控台時用
    if (params.get('debug') === '1') {
      const box = document.createElement('pre');
      box.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99;margin:0;padding:8px 10px;background:rgba(0,0,0,.8);color:#7f7;font:14px/1.5 monospace;border-radius:8px;white-space:pre';
      document.body.appendChild(box);
      const log = []; let n = 0; let bad = 0;
      Sync.on((m) => { n += 1; log.unshift(`${new Date().toLocaleTimeString()} ${m.type}`); log.length = Math.min(log.length, 5); });
      const prevReject = Sync.onReject; Sync.onReject = (m) => { bad += 1; if (prevReject) prevReject(m); };
      setInterval(() => {
        const cs = (Sync.clients || []).map((c, i) => `中繼${i + 1}：${c.connected ? '已連上' : c.reconnecting ? '重連中' : '未連上'}`).join('　');
        box.textContent = [`狀態：${Sync.state}　頻道：${room}　暗號：${secret ? '有' : '沒有'}`, cs, `收到 ${n} 則、驗證不過 ${bad} 則`, ...log].join('\n');
      }, 500);
    }
    Sync.on((msg) => {
      if (msg.type === 'config') applyConfig(msg.config);
      else if (msg.type === 'spin') { queue.push(msg); pump(); }
      else if (msg.type === 'ping') { Sync.send({ type: 'pong' }); const d = $('#ovStatus'); d.classList.add('ping'); setTimeout(() => d.classList.remove('ping'), 1500); /* 不能叫 flash：跟全螢幕閃光效果的 .flash 撞名 */ }
    });
    // 沒金鑰時用一個不可能簽出的假金鑰，讓所有訊息都驗不過（拒收），狀態點會顯示原因
    Sync.start(room, { sync: params.get('sync') !== '0', broker: params.get('broker') || config.broker, secret: secret || '\u0000no-key' });
    // 向控制台要最新設定（跨瀏覽器時需要）
    const hello = () => Sync.send({ type: 'hello' });
    setTimeout(hello, 500); setTimeout(hello, 3000);
  }

  LW.startOverlay = startOverlay;
})();
