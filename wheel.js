/* 共用轉盤模組：繪製、轉動動畫、音效、彩帶（控制台與 OBS 覆蓋層共用） */
(function (global) {
  const TAU = Math.PI * 2;
  const PALETTE = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#ff8fab', '#c77dff', '#48cae4', '#ffb703', '#8ac926', '#f15bb5', '#00b4d8', '#f4a261'];
  const imgCache = new Map();

  function norm(a) { a %= TAU; return a < 0 ? a + TAU : a; }

  function loadStill(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }
  // GIF 動圖：canvas 的 drawImage 只會畫 <img> 的第一格，所以用 ImageDecoder（Chrome / Edge / OBS）把每一格解出來，
  // draw 時依時間挑格。不支援或解不開（跨網域等）就退回靜態第一格
  const GIF_MAX_FRAMES = 200;
  const isGif = (src) => /^data:image\/gif[;,]/i.test(src) || /\.gif($|[?#])/i.test(src);
  async function loadGif(src) {
    if (typeof ImageDecoder === 'undefined') return loadStill(src);
    try {
      const data = await (await fetch(src)).arrayBuffer();
      const dec = new ImageDecoder({ data, type: 'image/gif' });
      await dec.tracks.ready;
      const track = dec.tracks.selectedTrack;
      const n = Math.min(GIF_MAX_FRAMES, track ? track.frameCount : 1);
      if (n <= 1) { dec.close(); return loadStill(src); }
      const frames = []; let total = 0;
      for (let i = 0; i < n; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        const dur = Math.max(20, (image.duration || 100000) / 1000); // µs → ms，太短的延遲瀏覽器也是當 ~20ms
        frames.push({ image, at: total }); total += dur;
      }
      dec.close();
      return { animated: true, frames, total, width: frames[0].image.displayWidth, height: frames[0].image.displayHeight,
        indexAt(t) { const m = t % total; let lo = 0, hi = frames.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (frames[mid].at <= m) lo = mid; else hi = mid - 1; } return lo; },
        frameAt(t) { return frames[this.indexAt(t)].image; },
        nextChangeIn(t) { const m = t % total; const i = this.indexAt(t); return (i + 1 < frames.length ? frames[i + 1].at : total) - m; } };
    } catch { return loadStill(src); }
  }
  function loadImage(src) {
    if (!src) return Promise.resolve(null);
    if (!imgCache.has(src)) imgCache.set(src, isGif(src) ? loadGif(src) : loadStill(src));
    return imgCache.get(src);
  }

  // 依模式把獎項換算成扇區（角度從 0 開始順時針排列）
  function buildSegments(prizes, mode, minSlice = 0) {
    const list = prizes.filter((p) => (mode === 'equal' ? true : p.weight > 0 && p.remaining !== 0));
    const weights = list.map((p) => (mode === 'equal' ? 1 : Number(p.weight) || 0));
    const total = weights.reduce((s, w) => s + w, 0);
    if (!list.length || total <= 0) return [];
    let shares = weights.map((w) => w / total);
    if (mode === 'weight' && minSlice > 0) {
      // 只影響「畫面上」的扇區寬度，抽獎機率不變；避免 1% 的大獎細到看不見
      for (let k = 0; k < 3; k++) { shares = shares.map((v) => Math.max(v, minSlice)); const t = shares.reduce((x, y) => x + y, 0); shares = shares.map((v) => v / t); }
    }
    let a = 0;
    return list.map((p, i) => {
      const span = shares[i] * TAU;
      const seg = { prize: p, start: a, end: a + span, span, index: i, soldOut: p.remaining === 0 || !(p.weight > 0) };
      a += span;
      return seg;
    });
  }

  class Wheel {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = Object.assign({ pointerAngle: -Math.PI / 2, hubText: 'GO', onTick: null }, opts);
      this.theme = { ring: '#1c1c1c', ringStroke: '#ffcf33', ledOn: '#ffcf33', ledOff: '#4a4a4a', hubBg: '#f4efe4', hubText: '#141414', hubStroke: '#ffcf33', pointer: '#e63b3b', pointerStroke: '#f4efe4', sliceStroke: '#141414', textFill: '#ffffff', textStroke: 'rgba(0,0,0,0.55)' };
      this.rotation = -Math.PI / 2; // 第一個扇區從 12 點鐘方向開始
      this.segments = [];
      this.images = new Map();
      this.spinning = false;
      this.highlight = null;
      this.pointerKick = 0;
      this.ledPhase = 0;
      this.skipRequested = false;
      this._raf = null;
      this.resize();
      this._ro = new ResizeObserver(() => { this.resize(); this.draw(); });
      this._ro.observe(canvas);
      this._idle = setInterval(() => { if (!this.spinning) { this.ledPhase++; this.draw(); } }, 500);
      // 中心「GO」可當按鈕：有給 onHubClick 才啟用（覆蓋層不給，純顯示）
      this.hubHover = false; this.hubPressed = false;
      if (this.opts.onHubClick) {
        const inHub = (e) => { const r = canvas.getBoundingClientRect(); const s = this.size / r.width; const x = (e.clientX - r.left) * s - this.size / 2; const y = (e.clientY - r.top) * s - this.size / 2; return Math.hypot(x, y) <= this.hubRadius(); };
        canvas.addEventListener('pointermove', (e) => { const h = inHub(e); if (h !== this.hubHover) { this.hubHover = h; canvas.style.cursor = h && !this.spinning ? 'pointer' : ''; this.draw(); } });
        canvas.addEventListener('pointerleave', () => { this.hubHover = false; this.hubPressed = false; canvas.style.cursor = ''; this.draw(); });
        canvas.addEventListener('pointerdown', (e) => { if (inHub(e) && !this.spinning) { this.hubPressed = true; this.draw(); } });
        canvas.addEventListener('pointerup', (e) => { const was = this.hubPressed; this.hubPressed = false; this.draw(); if (was && inHub(e) && !this.spinning) this.opts.onHubClick(); });
      }
      this._animTimer = null;
    }

    // 有 GIF 動圖時，閒置狀態要在「下一格該換」的時間點重畫（轉動中本來就每幀重畫，不用管）
    _animate() {
      clearTimeout(this._animTimer); this._animTimer = null;
      const anim = [...this.images.values()].filter((i) => i && i.animated);
      if (!anim.length) return;
      const now = performance.now();
      const wait = Math.max(16, Math.min(1000, ...anim.map((a) => a.nextChangeIn(now))));
      this._animTimer = setTimeout(() => { if (!this.spinning) this.draw(); this._animate(); }, wait + 1);
    }

    setTheme(t) { this.theme = Object.assign({}, this.theme, t || {}); this.draw(); }

    hubRadius() { const R = this.size / 2 - Math.max(16, this.size * 0.045); return R * 0.13 * 1.1; }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const size = Math.max(100, Math.floor(this.canvas.clientWidth || 500));
      this.size = size;
      this.canvas.width = Math.round(size * dpr);
      this.canvas.height = Math.round(size * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    async setPrizes(prizes, mode = 'weight', minSlice = 0) {
      this.prizes = prizes;
      this.mode = mode;
      this.minSlice = minSlice;
      this.segments = buildSegments(prizes, mode, minSlice);
      if (this.highlight) this.highlight = this.segments.find((s) => s.prize.id === this.highlight.prize.id) || null;
      this.draw();
      await Promise.all(prizes.map(async (p) => {
        const img = await loadImage(p.image);
        if (img) this.images.set(p.id, img); else this.images.delete(p.id);
      }));
      this.images.forEach((img, id) => { if (!prizes.some((p) => p.id === id)) this.images.delete(id); });
      this.draw();
      this._animate();
    }

    currentSegment() {
      const a = norm(this.opts.pointerAngle - this.rotation);
      return this.segments.find((s) => a >= s.start && a < s.end) || this.segments[this.segments.length - 1] || null;
    }

    draw() {
      const ctx = this.ctx;
      const S = this.size;
      const c = S / 2;
      const R = c - Math.max(16, S * 0.045);
      const k = R / 240; // 尺寸縮放係數
      ctx.clearRect(0, 0, S, S);
      ctx.save();
      ctx.translate(c, c);

      // 外框與 LED 燈
      ctx.beginPath(); ctx.arc(0, 0, R + 14 * k, 0, TAU);
      const T = this.theme;
      ctx.fillStyle = T.ring; ctx.fill();
      ctx.lineWidth = 3 * k; ctx.strokeStyle = T.ringStroke; ctx.stroke();
      const leds = 28;
      for (let i = 0; i < leds; i++) {
        const a = (i / leds) * TAU;
        const strobing = this.strobeUntil && performance.now() < this.strobeUntil;
        const on = strobing ? Math.floor(performance.now() / 70) % 2 === 0 : (i + this.ledPhase) % 2 === 0; // 大獎時整圈跑馬燈快閃
        ctx.beginPath(); ctx.arc(Math.cos(a) * (R + 7 * k), Math.sin(a) * (R + 7 * k), 3.2 * k, 0, TAU);
        ctx.fillStyle = on ? T.ledOn : T.ledOff;
        ctx.shadowBlur = on ? 8 : 0; ctx.shadowColor = T.ledOn;
        ctx.fill();
      }
      ctx.shadowBlur = 0;

      if (!this.segments.length) {
        ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fillStyle = '#2a2a3d'; ctx.fill();
        ctx.fillStyle = '#888'; ctx.font = `${Math.max(14, S * 0.04)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('尚無可抽獎項', 0, 0);
        ctx.restore();
        this._drawPointer(c, R, k);
        return;
      }

      ctx.save();
      ctx.rotate(this.rotation);
      this.segments.forEach((seg, i) => {
        const color = seg.soldOut ? '#4a4a55' : (seg.prize.color || PALETTE[i % PALETTE.length]);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R, seg.start, seg.end); ctx.closePath();
        ctx.fillStyle = color; ctx.fill();
        const focusing = this.focusUntil && performance.now() < this.focusUntil;
        if (this.highlight === seg) {
          const pulse = focusing ? 0.25 + 0.35 * Math.abs(Math.sin((performance.now() - (this.focusUntil - 1400)) / 1400 * Math.PI * 3)) : 0.45;
          ctx.fillStyle = `rgba(255,255,255,${pulse})`; ctx.fill(); if (seg.span < 0.16 || focusing) { ctx.lineWidth = 3 * k; ctx.strokeStyle = '#ffffff'; ctx.stroke(); }
        } else if (focusing) { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fill(); }
        ctx.lineWidth = (seg.span < 0.12 ? 1 : 2.5) * k; ctx.strokeStyle = T.sliceStroke; ctx.stroke(); // 格子很細時邊線變細，不然全是黑線

        // 扇區內容：圖片在外側、文字沿半徑排
        ctx.save();
        ctx.rotate(seg.start + seg.span / 2);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R - 2, -seg.span / 2, seg.span / 2); ctx.closePath(); ctx.clip();
        if (seg.soldOut) ctx.globalAlpha = 0.55;
        const src = this.images.get(seg.prize.id);
        const img = src && src.animated ? src.frameAt(performance.now()) : src;
        const chord = 2 * R * 0.7 * Math.sin(Math.min(seg.span, Math.PI) / 2);
        const mid = seg.start + seg.span / 2;
        const screenAngle = norm(mid + this.rotation); // 扇區目前在畫面上的方向
        let textEnd = R * 0.92;
        if (img) {
          const imgSize = Math.max(8, Math.min(R * 0.3, chord * 0.85));
          ctx.save();
          ctx.translate(R * 0.72, 0);
          ctx.rotate(-(mid + this.rotation)); // 反向旋轉，圖片永遠正立
          ctx.drawImage(img, -imgSize / 2, -imgSize / 2, imgSize, imgSize);
          ctx.restore();
          textEnd = R * 0.72 - imgSize / 2 - 6 * k;
        }
        // 文字沿半徑排，能用的長度很夠；限制在於格子的「厚度」（弦長）。人數多時字縮小、起點往內移，最小 8px；
        // 再細（約 90 格以上）就不畫字，靠獎項一覽和停下時的打亮 / 結果卡
        const dense = seg.span < 0.16;
        const fs = Math.max(8, Math.min(S * 0.036, chord * (dense ? 0.72 : 0.45)));
        if (chord * 0.72 < 7) { ctx.restore(); return; }
        // 靠近圓心格子太窄會跟鄰居疊在一起：起點推到「格子厚度 ≥ 字高」的半徑
        const rMin = (fs * 1.25) / (2 * Math.sin(Math.min(seg.span, Math.PI) / 2));
        const textStart = Math.max(R * 0.17, Math.min(R * 0.6, rMin));
        const textMax = Math.max(10, textEnd - textStart);
        ctx.font = `${dense ? '600' : 'bold'} ${fs}px "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round'; ctx.lineWidth = (dense ? 2 : 3) * k; ctx.strokeStyle = T.textStroke;
        const label = seg.soldOut ? (dense ? seg.prize.name : `${seg.prize.name}（已抽完）`) : seg.prize.name;
        // 左半邊的扇區把文字翻 180°，改成由外往內讀，這樣任何角度都不會上下顛倒
        const flip = screenAngle > Math.PI / 2 && screenAngle < Math.PI * 1.5;
        let tx = textStart;
        if (flip) { ctx.rotate(Math.PI); ctx.textAlign = 'right'; tx = -textStart; }
        else ctx.textAlign = 'left';
        ctx.strokeText(label, tx, 0, textMax);
        ctx.fillStyle = T.textFill;
        ctx.fillText(label, tx, 0, textMax);
        ctx.restore();
      });
      ctx.restore();

      if (this.opts.hubDom) { ctx.restore(); this._drawPointer(c, R, k); return; } // 中心由 DOM 按鈕負責
      // 中心軸（有 onHubClick 時是按鈕：滑過放大、按下縮小）
      const clickable = !!this.opts.onHubClick && !this.spinning;
      const hubScale = clickable ? (this.hubPressed ? 0.94 : this.hubHover ? 1.1 : 1) : 1;
      const hr = R * 0.13 * hubScale;
      ctx.beginPath(); ctx.arc(0, 0, hr, 0, TAU);
      ctx.fillStyle = clickable && this.hubHover ? T.ledOn : T.hubBg; ctx.fill();
      ctx.lineWidth = 4 * k; ctx.strokeStyle = T.hubStroke; ctx.stroke();
      ctx.fillStyle = T.hubText; ctx.font = `${R * 0.085 * hubScale}px "Bungee", sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(this.opts.hubText, 0, 1);
      ctx.restore();

      this._drawPointer(c, R, k);
    }

    _drawPointer(c, R, k) {
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(c, c - R - 6 * k);
      ctx.rotate(this.pointerKick * 0.35);
      ctx.beginPath();
      ctx.moveTo(0, 28 * k); ctx.lineTo(-16 * k, -14 * k); ctx.lineTo(16 * k, -14 * k); ctx.closePath();
      const T = this.theme;
      ctx.fillStyle = T.pointer; ctx.fill();
      ctx.lineWidth = 3 * k; ctx.strokeStyle = T.pointerStroke; ctx.stroke();
      ctx.beginPath(); ctx.arc(0, -8 * k, 6 * k, 0, TAU); ctx.fillStyle = T.pointerStroke; ctx.fill();
      ctx.restore();
    }

    // 轉到指定獎項；回傳 Promise<prize>
    spinTo(prizeId, { duration = 5000, turns = 6 } = {}) {
      return new Promise((resolve) => {
        const seg = this.segments.find((s) => s.prize.id === prizeId);
        if (!seg) { resolve(null); return; }
        if (this._raf) cancelAnimationFrame(this._raf);
        // 落點在格子中段 ±25%，尾段會多衝過去一點再彈回（真轉盤的橡膠擋片感），衝過的量最多 20% 格寬，
        // 加起來不會越過格子邊界（落點測試驗證離邊界至少 15%）
        const offset = (Math.random() - 0.5) * seg.span * 0.5;
        const target = seg.start + seg.span / 2 + offset;     // 轉盤座標上要停在指針下的角度
        const want = norm(this.opts.pointerAngle - target);   // 最終 rotation（mod 2π）
        const delta = norm(want - norm(this.rotation));
        const total = turns * TAU + delta;
        const over = duration > 0 ? Math.min(seg.span * 0.2, 0.06) : 0;
        const SPLIT = 0.86; // 前 86% 時間衝到（終點＋衝過量），剩下時間彈回終點
        const start = this.rotation;
        const t0 = performance.now();
        this.spinning = true; this.highlight = null; this.skipRequested = false; this.focusUntil = 0;
        let lastSeg = this.currentSegment(); let lastRot = start; let lastNow = t0;
        const step = (now) => {
          let t = duration <= 0 ? 1 : Math.min(1, (now - t0) / duration);
          if (this.skipRequested) t = 1;
          let e;
          if (t < SPLIT) { const u = t / SPLIT; e = (1 - Math.pow(1 - u, 3)) * (total + over) / total; }
          else { const u = (t - SPLIT) / (1 - SPLIT); e = (total + over * Math.cos(u * Math.PI / 2) * (1 - u * 0.15)) / total; }
          if (t >= 1) e = 1;
          this.rotation = start + total * e;
          const dt = Math.max(1, now - lastNow); const speed = Math.abs(this.rotation - lastRot) / dt * 1000; // rad/s
          lastRot = this.rotation; lastNow = now;
          const segNow = this.currentSegment();
          if (segNow !== lastSeg) {
            lastSeg = segNow; this.pointerKick = Math.min(1.6, 0.7 + 0.9 / Math.max(0.3, speed)); // 越慢踢越大
            if (this.opts.onTick) this.opts.onTick(speed);
          }
          this.pointerKick *= 0.82;
          this.ledPhase = Math.floor(now / (60 + 300 * Math.min(1, e)));
          this.draw();
          if (t < 1) { this._raf = requestAnimationFrame(step); return; }
          this._raf = null; this.spinning = false; this.pointerKick = 0;
          this.rotation = norm(this.rotation);
          this.highlight = seg;
          this.draw();
          resolve(seg.prize);
        };
        this._raf = requestAnimationFrame(step);
      });
    }

    skip() { this.skipRequested = true; }

    strobe(ms = 1200) { this.strobeUntil = performance.now() + ms; const loop = (now) => { if (now >= this.strobeUntil) { this.strobeUntil = 0; this.draw(); return; } this.draw(); requestAnimationFrame(loop); }; requestAnimationFrame(loop); }

    // 停下後聚焦 1.4 秒：其他格子暗下去、中獎格脈動打亮三次（OBS 小畫面也找得到停在哪）
    focus(ms = 1400) {
      if (!this.highlight) return;
      const t0 = performance.now(); this.focusUntil = t0 + ms;
      const loop = (now) => { if (this.spinning || now >= this.focusUntil) { this.focusUntil = 0; this.draw(); return; } this.draw(); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }
  }

  // ---------- 音效（WebAudio 合成，無需音檔） ----------
  const Sfx = {
    enabled: true,
    volume: 0.7, // 0～1，設定頁的音量滑桿
    ctx: null,
    _ctx() {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    _tone(freq, dur, type = 'square', vol = 0.08, at = 0) {
      const c = this._ctx();
      const o = c.createOscillator(); const g = c.createGain();
      o.type = type; o.frequency.value = freq;
      const t = c.currentTime + at;
      const v = Math.max(0.0005, vol * this.volume);
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
      o.connect(g).connect(c.destination);
      o.start(t); o.stop(t + dur);
    },
    // speed：rad/s。快的時候高而短、慢下來低而長，光聽就知道快停了
    tick(speed) { if (!this.enabled) return; try { const s = Math.min(1, (speed || 6) / 12); this._tone(550 + 550 * s, 0.045 + 0.06 * (1 - s), 'square', 0.08); } catch (e) { /* ignore */ } },
    fanfare() { if (!this.enabled) return; try { [[523, 0], [523, 0.12], [523, 0.24], [659, 0.36], [784, 0.6], [659, 0.84], [784, 0.96], [1046, 1.2]].forEach(([f, at]) => this._tone(f, 0.28, 'square', 0.14, at)); [[262, 0.6], [330, 0.96], [392, 1.2]].forEach(([f, at]) => this._tone(f, 0.5, 'triangle', 0.12, at)); } catch (e) { /* ignore */ } },
    sad() { if (!this.enabled) return; try { this._tone(330, 0.35, 'sawtooth', 0.09); this._tone(262, 0.5, 'sawtooth', 0.09, 0.3); } catch (e) { /* ignore */ } },
    pop() { if (!this.enabled) return; try { this._tone(600, 0.12, 'triangle', 0.15); this._tone(900, 0.1, 'triangle', 0.12, 0.06); } catch (e) { /* ignore */ } },
    win() {
      if (!this.enabled) return;
      try { [523, 659, 784, 1046, 1318].forEach((f, i) => this._tone(f, 0.35, 'triangle', 0.18, i * 0.11)); } catch (e) { /* ignore */ }
    },
  };

  // ---------- 彩帶 ----------
  class Confetti {
    constructor(canvas) { this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.parts = []; this._raf = null; }
    burst(n = 160, colors = PALETTE) {
      const W = (this.canvas.width = this.canvas.clientWidth || window.innerWidth);
      const H = (this.canvas.height = this.canvas.clientHeight || window.innerHeight);
      if (this.parts.length > 400) this.parts = this.parts.slice(-200); // 連續抽獎時避免彩帶堆積
      for (let i = 0; i < n; i++) {
        this.parts.push({
          x: W / 2 + (Math.random() - 0.5) * W * 0.4, y: H * 0.45,
          vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 16 - 5,
          w: 6 + Math.random() * 7, h: 4 + Math.random() * 5,
          rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 0.35,
          color: colors[Math.floor(Math.random() * colors.length)], life: 90 + Math.random() * 70,
        });
      }
      if (!this._raf) this._loop();
    }
    _loop() {
      const ctx = this.ctx; const W = this.canvas.width; const H = this.canvas.height;
      ctx.clearRect(0, 0, W, H);
      this.parts = this.parts.filter((p) => p.life > 0 && p.y < H + 20);
      for (const p of this.parts) {
        p.vy += 0.38; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life--;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.globalAlpha = Math.min(1, p.life / 30);
        ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (this.parts.length) this._raf = requestAnimationFrame(() => this._loop());
      else { this._raf = null; ctx.clearRect(0, 0, W, H); }
    }
  }

  global.LuckyWheel = { Wheel, Sfx, Confetti, PALETTE, loadImage, buildSegments, norm };
})(window);
