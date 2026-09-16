/* 共用轉盤模組：繪製、轉動動畫、音效、彩帶（控制台與 OBS 覆蓋層共用） */
(function (global) {
  const TAU = Math.PI * 2;
  const PALETTE = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#ff8fab', '#c77dff', '#48cae4', '#ffb703', '#8ac926', '#f15bb5', '#00b4d8', '#f4a261'];
  const imgCache = new Map();

  function norm(a) { a %= TAU; return a < 0 ? a + TAU : a; }

  function loadImage(src) {
    if (!src) return Promise.resolve(null);
    if (!imgCache.has(src)) {
      imgCache.set(src, new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
      }));
    }
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
    }

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
      this.draw();
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
      ctx.fillStyle = '#1b1b2f'; ctx.fill();
      ctx.lineWidth = 3 * k; ctx.strokeStyle = '#ffd166'; ctx.stroke();
      const leds = 28;
      for (let i = 0; i < leds; i++) {
        const a = (i / leds) * TAU;
        const on = (i + this.ledPhase) % 2 === 0;
        ctx.beginPath(); ctx.arc(Math.cos(a) * (R + 7 * k), Math.sin(a) * (R + 7 * k), 3.2 * k, 0, TAU);
        ctx.fillStyle = on ? '#fff3b0' : '#5a4a1e';
        ctx.shadowBlur = on ? 10 : 0; ctx.shadowColor = '#ffd166';
        ctx.fill();
      }
      ctx.shadowBlur = 0;

      if (!this.segments.length) {
        ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fillStyle = '#2a2a3d'; ctx.fill();
        ctx.fillStyle = '#aaa'; ctx.font = `${Math.max(14, S * 0.04)}px sans-serif`;
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
        if (this.highlight === seg) { ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fill(); }
        ctx.lineWidth = 2 * k; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke();

        // 扇區內容：圖片在外側、文字沿半徑排
        ctx.save();
        ctx.rotate(seg.start + seg.span / 2);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R - 2, -seg.span / 2, seg.span / 2); ctx.closePath(); ctx.clip();
        if (seg.soldOut) ctx.globalAlpha = 0.55;
        const img = this.images.get(seg.prize.id);
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
        const textStart = R * 0.17;
        const textMax = Math.max(10, textEnd - textStart);
        const fs = Math.max(9, Math.min(S * 0.036, chord * 0.45));
        if (chord * 0.45 < 7) { ctx.restore(); return; } // 扇區太細，文字畫了也看不清
        ctx.font = `bold ${fs}px "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round'; ctx.lineWidth = 3 * k; ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        const label = seg.soldOut ? `${seg.prize.name}（已抽完）` : seg.prize.name;
        // 左半邊的扇區把文字翻 180°，改成由外往內讀，這樣任何角度都不會上下顛倒
        const flip = screenAngle > Math.PI / 2 && screenAngle < Math.PI * 1.5;
        let tx = textStart;
        if (flip) { ctx.rotate(Math.PI); ctx.textAlign = 'right'; tx = -textStart; }
        else ctx.textAlign = 'left';
        ctx.strokeText(label, tx, 0, textMax);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, tx, 0, textMax);
        ctx.restore();
      });
      ctx.restore();

      // 中心軸
      ctx.beginPath(); ctx.arc(0, 0, R * 0.13, 0, TAU);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.lineWidth = 4 * k; ctx.strokeStyle = '#ffd166'; ctx.stroke();
      ctx.fillStyle = '#1b1b2f'; ctx.font = `bold ${R * 0.085}px sans-serif`;
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
      ctx.fillStyle = '#ff3b5c'; ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 8; ctx.fill();
      ctx.shadowBlur = 0; ctx.lineWidth = 3 * k; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.beginPath(); ctx.arc(0, -8 * k, 6 * k, 0, TAU); ctx.fillStyle = '#fff'; ctx.fill();
      ctx.restore();
    }

    // 轉到指定獎項；回傳 Promise<prize>
    spinTo(prizeId, { duration = 5000, turns = 6 } = {}) {
      return new Promise((resolve) => {
        const seg = this.segments.find((s) => s.prize.id === prizeId);
        if (!seg) { resolve(null); return; }
        if (this._raf) cancelAnimationFrame(this._raf);
        const offset = (Math.random() - 0.5) * seg.span * 0.7;
        const target = seg.start + seg.span / 2 + offset;     // 轉盤座標上要停在指針下的角度
        const want = norm(this.opts.pointerAngle - target);   // 最終 rotation（mod 2π）
        const delta = norm(want - norm(this.rotation));
        const total = turns * TAU + delta;
        const start = this.rotation;
        const t0 = performance.now();
        this.spinning = true; this.highlight = null; this.skipRequested = false;
        let lastSeg = this.currentSegment();
        const step = (now) => {
          let t = duration <= 0 ? 1 : Math.min(1, (now - t0) / duration);
          if (this.skipRequested) t = 1;
          const e = 1 - Math.pow(1 - t, 4);
          this.rotation = start + total * e;
          const segNow = this.currentSegment();
          if (segNow !== lastSeg) {
            lastSeg = segNow; this.pointerKick = 1;
            if (this.opts.onTick) this.opts.onTick();
          }
          this.pointerKick *= 0.82;
          this.ledPhase = Math.floor(now / (60 + 300 * e));
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
  }

  // ---------- 音效（WebAudio 合成，無需音檔） ----------
  const Sfx = {
    enabled: true,
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
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(c.destination);
      o.start(t); o.stop(t + dur);
    },
    tick() { if (!this.enabled) return; try { this._tone(900, 0.05); } catch (e) { /* ignore */ } },
    pop() { if (!this.enabled) return; try { this._tone(600, 0.12, 'triangle', 0.15); this._tone(900, 0.1, 'triangle', 0.12, 0.06); } catch (e) { /* ignore */ } },
    win() {
      if (!this.enabled) return;
      try { [523, 659, 784, 1046, 1318].forEach((f, i) => this._tone(f, 0.35, 'triangle', 0.18, i * 0.11)); } catch (e) { /* ignore */ }
    },
  };

  // ---------- 彩帶 ----------
  class Confetti {
    constructor(canvas) { this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.parts = []; this._raf = null; }
    burst(n = 160) {
      const W = (this.canvas.width = this.canvas.clientWidth || window.innerWidth);
      const H = (this.canvas.height = this.canvas.clientHeight || window.innerHeight);
      if (this.parts.length > 400) this.parts = this.parts.slice(-200); // 連續抽獎時避免彩帶堆積
      for (let i = 0; i < n; i++) {
        this.parts.push({
          x: W / 2 + (Math.random() - 0.5) * W * 0.4, y: H * 0.45,
          vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 16 - 5,
          w: 6 + Math.random() * 7, h: 4 + Math.random() * 5,
          rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 0.35,
          color: PALETTE[Math.floor(Math.random() * PALETTE.length)], life: 90 + Math.random() * 70,
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
