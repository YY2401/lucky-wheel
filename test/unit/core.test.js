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

test('suggestWeights：數量 q / 總抽數 N ＝ 建議機率，無限量獎項分掉剩餘', () => {
  const ps = core.normalizeConfig({ prizes: [
    { id: 'a', name: '特獎', weight: 1, quantity: 1 }, { id: 'b', name: '頭獎', weight: 1, quantity: 3 },
    { id: 'c', name: '二獎', weight: 1, quantity: 10 }, { id: 'd', name: '銘謝惠顧', weight: 1, quantity: -1 },
  ] }).prizes;
  const r = core.suggestWeights(ps, 100);
  assert.equal(r.stock, 14);
  assert.equal(r.draws, 100);
  assert.equal(r.capped, false);
  const by = Object.fromEntries(r.rows.map((x) => [x.id, x]));
  assert.equal(by.a.weight, 1); assert.equal(by.b.weight, 3); assert.equal(by.c.weight, 10); assert.equal(by.d.weight, 86);
  assert.equal(by.a.every, 100, '特獎平均每 100 抽出現一次');
  assert.ok(Math.abs(r.rows.reduce((s, x) => s + x.suggested, 0) - 100) < 1e-9, '建議機率加總 100%');
});

test('suggestWeights：沒有無限量獎項時，權重＝數量（大家同時抽完）；抽數少於庫存會被拉高', () => {
  const ps = core.normalizeConfig({ prizes: [{ id: 'a', weight: 50, quantity: 1 }, { id: 'b', weight: 50, quantity: 3 }] }).prizes;
  const r = core.suggestWeights(ps, 0);
  assert.equal(r.draws, 4);
  assert.deepEqual(r.rows.map((x) => x.weight), [25, 75]);
  const c = core.suggestWeights(ps, 2);
  assert.equal(c.capped, true); assert.equal(c.draws, 4);
});

test('suggestWeights：多個無限量獎項照目前權重比例分；數量 0 的獎項不分機率', () => {
  const ps = core.normalizeConfig({ prizes: [
    { id: 'a', weight: 1, quantity: 5 }, { id: 'x', weight: 30, quantity: -1 }, { id: 'y', weight: 10, quantity: -1 }, { id: 'z', weight: 5, quantity: 0 },
  ] }).prizes;
  const by = Object.fromEntries(core.suggestWeights(ps, 50).rows.map((r) => [r.id, r]));
  assert.equal(by.a.suggested, 10);
  assert.ok(Math.abs(by.x.suggested - 67.5) < 1e-9);
  assert.ok(Math.abs(by.y.suggested - 22.5) < 1e-9);
  assert.equal(by.z.weight, 0);
});

test('suggestWeights：極小機率不會被四捨五入成 0', () => {
  const ps = core.normalizeConfig({ prizes: [{ id: 'a', weight: 1, quantity: 1 }, { id: 'b', weight: 1, quantity: -1 }] }).prizes;
  const by = Object.fromEntries(core.suggestWeights(ps, 100000).rows.map((r) => [r.id, r]));
  assert.equal(by.a.weight, 0.01);
  assert.ok(by.a.suggested > 0 && by.a.suggested < 0.01);
});

test('簽章：正確金鑰通過；錯誤金鑰、竄改內容、過期時間戳都拒絕', async () => {
  const m = await core.signMessage('s3cret', { type: 'spin', results: [{ name: 'A', nested: { b: 1, a: 2 } }] });
  assert.ok(m.sig && m.ts);
  assert.equal(await core.verifyMessage('s3cret', m), true);
  assert.equal(await core.verifyMessage('other', m), false);
  assert.equal(await core.verifyMessage('s3cret', { ...m, type: 'config' }), false);
  assert.equal(await core.verifyMessage('s3cret', { ...m, results: [{ name: 'B' }] }), false);
  assert.equal(await core.verifyMessage('s3cret', m, Date.now() + core.SIG_WINDOW_MS + 1000), false);
  assert.equal(await core.verifyMessage('s3cret', { ...m, sig: undefined }), false);
  // 鍵順序不同但內容相同 → 同一個簽章（JSON 正規化）
  const reordered = { results: m.results, type: m.type, ts: m.ts, mid: m.mid, sig: m.sig };
  assert.equal(await core.verifyMessage('s3cret', reordered), true);
});

test('normalizeConfig：會自動產生金鑰，且只留英數', () => {
  const c = core.normalizeConfig({});
  assert.match(c.secret, /^[A-Z0-9]{20}$/);
  assert.equal(core.normalizeConfig({ secret: 'ab-c!d' }).secret, 'abcd');
});

test('補抽：原紀錄標作廢並加回庫存、新紀錄同批次同第幾抽、標補抽', () => {
  const c = cfg();
  const first = core.drawBatch({ cfg: c, records: [], count: 3, random: () => 0 }); // 三抽都落在第一個可抽獎項
  const records = [...first.recs];
  assert.equal(c.prizes[0].remaining, 0, '特獎限量 1 抽完');
  const target = records[0]; // 第 1 抽 = 特獎
  const out = core.redraw({ cfg: c, records, key: core.recordKey(target), random: () => 0.999 }); // 補抽落在最後一個（銘謝惠顧）
  records.push(...out.recs);
  assert.equal(target.void, true);
  assert.equal(target.note, '被補抽取代');
  assert.equal(c.prizes[0].remaining, 1, '作廢後特獎庫存加回');
  assert.equal(out.recs.length, 1);
  assert.equal(out.recs[0].batchId, target.batchId);
  assert.equal(out.recs[0].index, 1);
  assert.equal(out.recs[0].type, '補抽');
  assert.equal(out.recs[0].redrawOf, core.recordKey(target));
  assert.equal(out.recs[0].prizeId, 'e');
  assert.equal(out.results[0].index, 1);
  assert.equal(out.label, '補抽第 1 抽');
  assert.throws(() => core.redraw({ cfg: c, records, key: core.recordKey(target) }), /已經作廢/);
  assert.throws(() => core.redraw({ cfg: c, records, key: 'nope' }), /找不到/);
});

test('補抽：作廢的紀錄不算保底計數；撤銷整批時作廢的不會再加回庫存', () => {
  const c = cfg({ pityAccum: true, pityAccumN: 3 });
  const recs = [{ rid: 'a', player: 'x', hit: false, batchId: 'B', index: 1, prizeId: 'e' }, { rid: 'b', player: 'x', hit: false, batchId: 'B', index: 2, prizeId: 'a' }];
  assert.equal(core.drawsSinceHit(recs, c, 'x'), 2);
  recs[1].void = true;
  assert.equal(core.drawsSinceHit(recs, c, 'x'), 1, '作廢那筆不算');
  c.prizes[0].remaining = 0; // 假設特獎已被抽走
  const out = core.undoBatch(recs, c.prizes, 'B');
  assert.equal(out.records.length, 0);
  assert.equal(c.prizes[0].remaining, 0, '作廢的特獎紀錄不再加回（補抽時已加過）');
});

test('舊紀錄沒有 rid：recordKey 用批次＋第幾抽', () => {
  assert.equal(core.recordKey({ batchId: 'B1', index: 3 }), 'B1-3');
  assert.equal(core.recordKey({ rid: 'R', batchId: 'B1', index: 3 }), 'R');
});

test('每人限抽：作廢不算、空白名字不限、每天模式只算今天', () => {
  const today = core.formatTime(new Date()).slice(0, 10);
  const recs = [
    { player: '小明', time: `${today} 10:00:00` }, { player: '小明', time: `${today} 10:01:00`, void: true },
    { player: '小明 ', time: '2020-01-01 00:00:00' }, { player: '阿花', time: `${today} 11:00:00` }, { player: '', time: `${today} 12:00:00` },
  ];
  assert.equal(core.drawsUsed(recs, '小明', 'all'), 2, '含 trim 後同名的舊紀錄，不含作廢');
  assert.equal(core.drawsUsed(recs, '小明', 'day'), 1);
  assert.equal(core.drawsUsed(recs, '', 'all'), 0);
  assert.equal(core.drawsUsed(recs, '阿花', 'day'), 1);
});

test('名單 → 獎項：換行 / 逗號分隔、去重去空白、每人數量 1', () => {
  const list = core.prizesFromNames(' 小明 \n阿花,小明\n\n大雄、阿花 ，靜香');
  assert.deepEqual(list.map((p) => p.name), ['小明', '阿花', '大雄', '靜香']);
  assert.ok(list.every((p) => p.quantity === 1 && p.remaining === 1 && p.weight === 1 && /^n_/.test(p.id)));
  assert.deepEqual(core.prizesFromNames(''), []);
});

test('normalizeConfig：音量與限抽欄位範圍', () => {
  const c = core.normalizeConfig({ volume: 250, limitPerPlayer: -3, limitPeriod: 'week' });
  assert.equal(c.volume, 100); assert.equal(c.limitPerPlayer, 0); assert.equal(c.limitPeriod, 'all');
  assert.equal(core.normalizeConfig({}).volume, 70);
});

test('特效等級：自動判定（機率 < 5% 或保底＝大獎、名字像銘謝惠顧＝落空）、手動指定優先；整批反應', () => {
  assert.equal(core.tierOf({ name: '特獎', pity: true }, 30), 'big');
  assert.equal(core.tierOf({ name: '頭獎' }, 4.9), 'big');
  assert.equal(core.tierOf({ name: '二獎' }, 15), 'normal');
  assert.equal(core.tierOf({ name: '銘謝惠顧' }, 60), 'miss');
  assert.equal(core.tierOf({ name: '謝謝參加' }, 60), 'miss');
  assert.equal(core.tierOf({ name: '銘謝惠顧', tier: 'normal' }, 60), 'normal', '手動指定優先');
  assert.equal(core.tierOf({ name: 'x', tier: 'big' }, 90), 'big');
  assert.equal(core.batchTier([{ tier: 'miss' }, { tier: 'big' }]), 'big');
  assert.equal(core.batchTier([{ tier: 'miss' }, { tier: 'miss' }]), 'miss');
  assert.equal(core.batchTier([{ tier: 'miss' }, { tier: 'normal' }]), 'normal');
  const c = cfg(); const out = core.drawBatch({ cfg: c, records: [], count: 2, random: () => 0 });
  assert.equal(out.results[0].tier, 'big', '抽獎結果帶等級');
  assert.equal(core.normalizeConfig({ prizes: [{ name: 'a', tier: 'weird' }] }).prizes[0].tier, 'auto');
});

test('diffStock：只有數量 / 剩餘變了才記，改名改權重不算', () => {
  const before = core.stockSnapshot([{ id: 'a', name: '甜點券', quantity: 30, remaining: 9 }, { id: 'b', name: '小卡', quantity: 5, remaining: 5 }]);
  const after = [{ id: 'a', name: '甜點券', quantity: 30, remaining: 14 }, { id: 'b', name: '小卡改名', weight: 99, quantity: 5, remaining: 5 }];
  const log = core.diffStock(before, after, { reason: '手動修改' });
  assert.equal(log.length, 1);
  assert.deepEqual({ ...log[0], time: 'x' }, { time: 'x', reason: '手動修改', kind: 'change', prizeId: 'a', prize: '甜點券', qtyFrom: 30, qtyTo: 30, remFrom: 9, remTo: 14 });
  assert.equal(core.stockDelta(log[0]), '+5');
});

test('diffStock：新增與刪除獎項各記一筆，方向正確', () => {
  const before = core.stockSnapshot([{ id: 'a', name: '舊獎', quantity: 3, remaining: 2 }]);
  const log = core.diffStock(before, [{ id: 'n', name: '新獎', quantity: 4, remaining: 4 }], { reason: '匯入設定' });
  const add = log.find((e) => e.kind === 'add'); const rm = log.find((e) => e.kind === 'remove');
  assert.equal(add.prize, '新獎'); assert.equal(add.remFrom, null); assert.equal(add.remTo, 4);
  assert.equal(rm.prize, '舊獎'); assert.equal(rm.remFrom, 2); assert.equal(rm.remTo, null);
  assert.equal(core.stockDelta(add), '新增獎項');
  assert.equal(core.stockDelta(rm), '刪除獎項');
  assert.ok(log.every((e) => e.reason === '匯入設定'));
});

test('diffStock：切換無限用「無限」表示，不會算出假的增減', () => {
  const before = core.stockSnapshot([{ id: 'a', name: '小卡', quantity: 10, remaining: 4 }]);
  const log = core.diffStock(before, [{ id: 'a', name: '小卡', quantity: -1, remaining: -1 }], { reason: '切換無限' });
  assert.equal(log.length, 1);
  assert.equal(core.stockNum(log[0].remTo), '無限');
  assert.equal(core.stockDelta(log[0]), '', '有一邊是無限時不顯示增減');
  assert.equal(core.stockNum(null), '—');
  assert.strictEqual(core.stockNum(0), 0, '一般數字要回數字，Excel 才排得了序');
  assert.strictEqual(core.stockNum(30), 30);
});

test('diffStock：沒有變化就不產生紀錄（抽獎前後拍快照不會被誤記）', () => {
  const ps = [{ id: 'a', name: 'x', quantity: 5, remaining: 5 }];
  assert.deepEqual(core.diffStock(core.stockSnapshot(ps), ps), []);
  assert.deepEqual(core.diffStock(core.stockSnapshot(ps), core.stockSnapshot(ps)), []);
});
