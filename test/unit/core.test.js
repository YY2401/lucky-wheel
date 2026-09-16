'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../../core.js');

const prizes = () => [
  { id: 'a', name: '特獎', weight: 1, quantity: 1, remaining: 1, pity: true },
  { id: 'b', name: '頭獎', weight: 5, quantity: -1, remaining: -1, pity: true },
  { id: 'c', name: '二獎', weight: 15, quantity: -1, remaining: -1 },
  { id: 'd', name: '三獎', weight: 30, quantity: -1, remaining: -1 },
  { id: 'e', name: '銘謝惠顧', weight: 49, quantity: -1, remaining: -1 },
];
const cfg = (extra = {}) => core.normalizeConfig({ prizes: prizes(), ...extra });

test('normalizeConfig：壞資料會被修正、缺的欄位補預設', () => {
  const c = core.normalizeConfig({ spinDuration: 'abc', turns: 999, theme: 'purple', prizes: [{ name: 'x', weight: -5, quantity: 3, remaining: 99 }, null] });
  assert.equal(c.spinDuration, 5000);
  assert.equal(c.turns, 20);
  assert.equal(c.theme, 'light');
  assert.equal(c.prizes.length, 2);
  assert.equal(c.prizes[0].weight, 0);
  assert.equal(c.prizes[0].remaining, 3, '剩餘不能超過數量');
  assert.match(c.prizes[1].id, /^p_/);
  assert.equal(c.prizes[1].name, '獎項 2');
  assert.ok(c.room.length >= 6);
});

test('normalizeConfig：沒明確選過主題時一律白底', () => {
  assert.equal(core.normalizeConfig({ theme: 'dark' }).theme, 'light');
  assert.equal(core.normalizeConfig({ theme: 'dark', themeChosen: true }).theme, 'dark');
});

test('probabilities：依權重算、抽完的退出獎池並重新分配', () => {
  const p = prizes();
  const m = core.probabilities(p);
  assert.equal(Math.round(m.a * 100) / 100, 1);
  assert.equal(Math.round(m.e * 100) / 100, 49);
  p[0].remaining = 0; // 特獎抽完
  const m2 = core.probabilities(p);
  assert.equal(m2.a, undefined);
  assert.ok(Math.abs(m2.e - 49 / 99 * 100) < 1e-9);
});

test('drawOne：100 萬次抽樣的比例與設定機率誤差 < 0.2%', () => {
  const p = prizes().map((x) => ({ ...x, remaining: -1 }));
  const N = 1e6; const cnt = {};
  for (let i = 0; i < N; i++) { const r = core.drawOne(p); cnt[r.id] = (cnt[r.id] || 0) + 1; }
  for (const x of p) assert.ok(Math.abs(cnt[x.id] / N * 100 - x.weight) < 0.2, `${x.name}: ${(cnt[x.id] / N * 100).toFixed(3)}% vs ${x.weight}%`);
});

test('drawOne：權重 0 或庫存 0 的獎項絕不會被抽到；全部抽完回傳 null', () => {
  const p = [{ id: 'x', weight: 0, remaining: -1 }, { id: 'y', weight: 10, remaining: 0 }, { id: 'z', weight: 1, remaining: 2 }];
  for (let i = 0; i < 1000; i++) assert.equal(core.drawOne(p).id, 'z');
  p[2].remaining = 0;
  assert.equal(core.drawOne(p), null);
});

test('drawBatch：扣庫存、抽完就停、紀錄與結果一致', () => {
  const c = cfg();
  const out = core.drawBatch({ cfg: c, records: [], count: 10, player: '小明', random: () => 0 }); // random=0 → 永遠抽到第一個可抽的獎項
  assert.equal(out.type, '10連抽');
  assert.equal(out.results[0].prizeId, 'a');
  assert.equal(c.prizes[0].remaining, 0, '特獎限量 1，抽完歸零');
  assert.equal(out.results[1].prizeId, 'b', '特獎抽完後退出獎池');
  assert.equal(out.recs.length, 10);
  assert.deepEqual(out.recs.map((r) => r.player), Array(10).fill('小明'));
  assert.ok(out.results.every((r, i) => r.index === i + 1));
});

test('drawBatch：count 超出範圍會被夾住', () => {
  assert.equal(core.drawBatch({ cfg: cfg(), records: [], count: 999 }).count, 100);
  assert.equal(core.drawBatch({ cfg: cfg(), records: [], count: 'abc' }).count, 1);
});

test('保底（連抽）：每 K 抽至少一個保底獎，統計 2000 批', () => {
  const c = cfg({ pityBatch: true, pityBatchK: 5 });
  c.prizes.forEach((p) => { p.remaining = -1; });
  for (let i = 0; i < 2000; i++) {
    const out = core.drawBatch({ cfg: c, records: [], count: 5 });
    assert.ok(out.results.some((r) => r.hit), `第 ${i} 批沒有保底獎：${out.results.map((r) => r.name)}`);
  }
});

test('保底（累積）：連續 N 抽沒中，第 N+1 抽必中；依抽獎者分開計數', () => {
  const c = cfg({ pityAccum: true, pityAccumN: 3 });
  c.prizes.forEach((p) => { p.remaining = -1; });
  const miss = () => 0.999; // 永遠落在最後一個（銘謝惠顧）
  let records = [];
  for (let i = 0; i < 3; i++) { const o = core.drawBatch({ cfg: c, records, count: 1, player: '小明', random: miss }); records.push(...o.recs); assert.equal(o.results[0].hit, false); }
  // 換人：阿花的計數是獨立的，不會被小明的 3 次未中觸發
  const other = core.drawBatch({ cfg: c, records, count: 1, player: '阿花', random: miss });
  assert.equal(other.results[0].hit, false);
  records.push(...other.recs);
  // 小明第 4 抽：強制從保底獎池抽（random=miss 會落在保底池最後一個＝頭獎）
  const forced = core.drawBatch({ cfg: c, records, count: 1, player: '小明', random: miss });
  assert.equal(forced.results[0].pity, true);
  assert.equal(forced.results[0].hit, true);
  assert.equal(forced.results[0].prizeId, 'b');
});

test('保底：全體共用計數時不分人', () => {
  const c = cfg({ pityAccum: true, pityAccumN: 2, pityScope: 'global' });
  c.prizes.forEach((p) => { p.remaining = -1; });
  const miss = () => 0.999;
  let records = [];
  for (const who of ['A', 'B']) { const o = core.drawBatch({ cfg: c, records, count: 1, player: who, random: miss }); records.push(...o.recs); }
  const o = core.drawBatch({ cfg: c, records, count: 1, player: 'C', random: miss });
  assert.equal(o.results[0].pity, true);
});

test('保底：保底獎全部抽完時不觸發、也不會卡住', () => {
  const c = cfg({ pityAccum: true, pityAccumN: 1 });
  c.prizes[0].remaining = 0; c.prizes[1].quantity = 0; c.prizes[1].remaining = 0; // 兩個保底獎都沒了
  const o = core.drawBatch({ cfg: c, records: [{ hit: false, player: '' }, { hit: false, player: '' }], count: 3, random: () => 0.999 });
  assert.equal(o.results.length, 3);
  assert.ok(o.results.every((r) => !r.pity));
});

test('undoBatch：庫存加回、只移除該批、不超過原始數量', () => {
  const c = cfg();
  const r1 = core.drawBatch({ cfg: c, records: [], count: 3, random: () => 0 });
  let records = [...r1.recs];
  const r2 = core.drawBatch({ cfg: c, records, count: 2, random: () => 0.5 });
  records.push(...r2.recs);
  assert.equal(c.prizes[0].remaining, 0);
  const out = core.undoBatch(records, c.prizes, r1.batchId);
  assert.equal(out.batch.length, 3);
  assert.equal(out.records.length, 2);
  assert.equal(c.prizes[0].remaining, 1);
  core.undoBatch(out.records, c.prizes, r1.batchId); // 重複撤銷同一批不會再加
  assert.equal(c.prizes[0].remaining, 1);
});

test('drawsSinceHit：撤銷後計數自動回到正確值', () => {
  const c = cfg({ pityAccum: true, pityAccumN: 5 });
  const recs = [{ player: 'x', hit: false }, { player: 'x', hit: true, batchId: 'B' }, { player: 'x', hit: false }, { player: 'x', hit: false }];
  assert.equal(core.drawsSinceHit(recs, c, 'x'), 2);
  const after = core.undoBatch(recs, c.prizes, 'B').records;
  assert.equal(core.drawsSinceHit(after, c, 'x'), 3);
});
