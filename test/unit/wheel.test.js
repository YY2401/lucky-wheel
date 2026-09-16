'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// wheel.js 是瀏覽器模組：用最小的 canvas / RAF 假環境載入，測的是真正的轉動與落點邏輯
function loadWheel() {
  const noop = new Proxy(function () {}, { get: () => noop, apply: () => noop, set: () => true });
  global.window = global;
  global.ResizeObserver = class { observe() {} };
  global.Image = class { set src(v) { if (this.onerror) this.onerror(); } };
  global.performance = { now: () => Date.now() };
  global.requestAnimationFrame = (fn) => setImmediate(() => fn(performance.now()));
  global.cancelAnimationFrame = () => {};
  global.setInterval = () => 0; // 轉盤的閒置 LED 計時器在測試裡不需要，也會讓 Node 無法結束
  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(path.join(__dirname, '../../wheel.js'), 'utf8'));
  return { ...window.LuckyWheel, canvas: { clientWidth: 400, getContext: () => noop } };
}

const prizes = [
  { id: 'a', name: 'A', weight: 1, remaining: 1 }, { id: 'b', name: 'B', weight: 5, remaining: -1 },
  { id: 'c', name: 'C', weight: 15, remaining: -1 }, { id: 'd', name: 'D', weight: 30, remaining: -1 },
  { id: 'e', name: 'E', weight: 49, remaining: -1 }, { id: 'tiny', name: 'tiny', weight: 0.05, remaining: -1 },
  { id: 'big', name: 'big', weight: 80, remaining: -1 },
];

test('buildSegments：依權重 / 等分 / 最小扇區', () => {
  const { buildSegments } = loadWheel();
  const w = buildSegments(prizes, 'weight');
  const total = w.reduce((s, x) => s + x.span, 0);
  assert.ok(Math.abs(total - Math.PI * 2) < 1e-9);
  assert.ok(w.find((s) => s.prize.id === 'tiny').span < 0.01);
  const e = buildSegments(prizes, 'equal');
  assert.ok(e.every((s) => Math.abs(s.span - e[0].span) < 1e-9));
  const m = buildSegments(prizes, 'weight', 0.04);
  assert.ok(m.find((s) => s.prize.id === 'tiny').span >= Math.PI * 2 * 0.039, '最小扇區至少 4%');
  assert.ok(Math.abs(m.reduce((s, x) => s + x.span, 0) - Math.PI * 2) < 1e-9);
});

test('buildSegments：依權重模式下抽完 / 權重 0 的獎項不出現在轉盤', () => {
  const { buildSegments } = loadWheel();
  const p = [{ id: 'x', weight: 0, remaining: -1 }, { id: 'y', weight: 1, remaining: 0 }, { id: 'z', weight: 1, remaining: -1 }];
  assert.deepEqual(buildSegments(p, 'weight').map((s) => s.prize.id), ['z']);
  assert.deepEqual(buildSegments(p, 'equal').map((s) => s.prize.id), ['x', 'y', 'z']);
});

for (const mode of ['weight', 'equal']) {
  for (const minSlice of [0, 0.04]) {
    test(`spinTo：${mode} 模式、最小扇區 ${minSlice}，3000 次落點全部在指定獎項且不壓線`, async () => {
      const { Wheel, norm, canvas } = loadWheel();
      const w = new Wheel(canvas, {});
      await w.setPrizes(prizes, mode, minSlice);
      let worst = Infinity;
      for (let i = 0; i < 3000; i++) {
        const target = prizes[Math.floor(Math.random() * prizes.length)];
        const landed = await w.spinTo(target.id, { duration: 0, turns: 1 + Math.floor(Math.random() * 8) });
        const under = w.currentSegment();
        assert.equal(landed && landed.id, target.id);
        assert.equal(under.prize.id, target.id, `第 ${i} 次：指針在 ${under.prize.id}，應為 ${target.id}`);
        const a = norm(w.opts.pointerAngle - w.rotation);
        const seg = w.segments.find((s) => s.prize.id === target.id);
        worst = Math.min(worst, Math.min(a - seg.start, seg.end - a) / seg.span);
      }
      assert.ok(worst >= 0.15 - 1e-9, `最靠近邊界的落點只有扇區寬度的 ${(worst * 100).toFixed(1)}%`);
    });
  }
}

test('spinTo：指定不存在的獎項回傳 null，不會轉動', async () => {
  const { Wheel, canvas } = loadWheel();
  const w = new Wheel(canvas, {});
  await w.setPrizes(prizes, 'weight');
  const before = w.rotation;
  assert.equal(await w.spinTo('nope', { duration: 0 }), null);
  assert.equal(w.rotation, before);
});
