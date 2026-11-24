// أيام جديدة على مسودة موجودة، والبيعات اللي صنفها اتشال.
//
// Both features exist because of one afternoon's work (2026-11-02): the owner
// finished reorganising the draft, then found that the days after it were missing
// and that deleting rows had left 301 sales pointing at nothing. These tests hold
// the two promises he asked for:
//
//   * the new days arrive (sales, repairs, expenses, cash) and the counts drop by
//     what sold — and **nothing else in the draft changes**;
//   * an orphaned sale finds a home, and the month's money never moves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { preparePlan } from '../src/pipeline.mjs';
import { buildDefaultPlan } from '../src/plan.mjs';
import { describeNewDays, applyNewDays, newDaysOf } from '../src/merge-days.mjs';
import { describeOrphanSales, repairOrphanSales } from '../src/repair.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/legacy-sample.json', import.meta.url), 'utf8'));
const read = (raw) => preparePlan(JSON.stringify(raw), {}).legacy;

const withStock = (plan, qty = 10) => {
  // The fixture's accessories have no quantity (the old program never stored one),
  // so the tests set one: «العدد اللي عندك دلوقتي» is what the owner types.
  for (const item of plan.items) if (item.qty === 0 || item.qty === null) item.qty = qty;
  return plan;
};

const DAY = (sections) => JSON.stringify({
  acc: [], used: [], cash: [], sw: [], exp: [], phones: [], repairs: [],
  ...sections,
});

/** The fixture plus two days the draft was made before. */
function newerLegacy() {
  const raw = structuredClone(fixture);
  raw['mshop_d_2026-10-05'] = DAY({
    acc: [
      { name: 'جراب 50', mainCat: 'جراب', buy: 25, sell: 60, profit: 35, time: '٠١:٠٠ م' },
      { name: 'جراب 50', mainCat: 'جراب', buy: 25, sell: 60, profit: 35, time: '٠٢:٠٠ م' },
      { name: 'فيشة جديدة', mainCat: 'جراب', buy: 12, sell: 25, profit: 13, time: '٠٣:٠٠ م' },
    ],
    exp: [{ category: 'البيت', amount: 120, time: '٠٤:٠٠ م' }],
    repairs: [{
      clientName: 'أحمد', clientPhone: '0100', brand: 'Nokia', model: '105',
      fault: 'شاشة', partName: 'شاشة', partCost: 100, servicePrice: 250, time: '٠٥:٠٠ م',
    }],
    cash: [{ service: 'فودافون كاش', kind: 'deposit', transferAmount: 500, amount: 5, time: '٠٦:٠٠ م' }],
  });
  raw['mshop_d_2026-10-06'] = DAY({
    acc: [{ name: 'سكرين HD', mainCat: 'سكرين', buy: 12, sell: 35, profit: 23, time: '١١:٠٠ ص' }],
  });
  return read(raw);
}

test('the days after the draft are the only days taken', () => {
  const legacy = newerLegacy();
  const plan = buildDefaultPlan(read(fixture), { currentMonth: '2026-10', pastMode: 'summary' });
  const days = newDaysOf(plan, legacy).map((day) => day.day);
  assert.deepEqual(days, ['2026-10-05', '2026-10-06']);
});

test('the preview says what comes in and which counts move', () => {
  const legacy = newerLegacy();
  const plan = withStock(buildDefaultPlan(read(fixture), { currentMonth: '2026-10', pastMode: 'summary' }));
  const described = describeNewDays(plan, legacy);
  assert.equal(described.newDayCount, 2);
  assert.equal(described.sales, 4);
  assert.equal(described.saleTotal, 60 + 60 + 25 + 35);
  assert.equal(described.repairs, 1);
  assert.equal(described.expenses, 120);
  assert.equal(described.cash, 1);
  // جراب 50 sold twice, سكرين HD once — both are items the draft already has.
  const grip = described.counts.find((row) => row.name === 'جراب 50');
  assert.equal(grip.sold, 2);
  assert.equal(grip.after, grip.before - 2);
  // فيشة جديدة never existed in the draft; it arrives as a new item, not as a count.
  assert.deepEqual(described.newItems.map((item) => item.name), ['فيشة جديدة']);
});

test('adding the days changes nothing but the days', () => {
  const legacy = newerLegacy();
  const plan = withStock(buildDefaultPlan(read(fixture), { currentMonth: '2026-10', pastMode: 'summary' }));
  const before = JSON.parse(JSON.stringify(plan));
  const result = applyNewDays(plan, legacy);
  assert.equal(result.changed, true);
  const after = result.plan;

  // The draft's own decisions survive untouched.
  assert.deepEqual(after.categories, before.categories);
  assert.deepEqual(after.brands, before.brands);
  assert.deepEqual(after.wallets, before.wallets);
  assert.deepEqual(after.summary, before.summary);
  assert.equal(after.sales.length, before.sales.length + 4);
  assert.equal(after.expenses.length, before.expenses.length + 1);
  assert.equal(after.repairs.length, before.repairs.length + 1);
  assert.equal(after.cashOps.length, before.cashOps.length + 1);

  // Counts drop by what sold, and the item keeps every other field.
  const gripBefore = before.items.find((item) => item.name === 'جراب 50');
  const gripAfter = after.items.find((item) => item.name === 'جراب 50');
  assert.equal(gripAfter.qty, gripBefore.qty - 2);
  assert.equal(gripAfter.sell, gripBefore.sell);
  assert.equal(gripAfter.categoryId, gripBefore.categoryId);

  // The source range moves with the days.
  assert.equal(after.source.lastDay, '2026-10-06');
  assert.equal(after.source.days, before.source.days + 2);
});

test('a count that would go below zero stops at zero and says so', () => {
  const legacy = newerLegacy();
  const plan = withStock(buildDefaultPlan(read(fixture), { currentMonth: '2026-10', pastMode: 'summary' }));
  const grip = plan.items.find((item) => item.name === 'جراب 50');
  grip.qty = 1;
  const described = describeNewDays(plan, legacy);
  const row = described.counts.find((entry) => entry.name === 'جراب 50');
  assert.equal(row.after, 0);
  assert.equal(row.clamped, true);
  assert.ok(described.warnings.some((line) => line.includes('جراب 50')));
  const result = applyNewDays(plan, legacy);
  assert.equal(result.plan.items.find((item) => item.name === 'جراب 50').qty, 0);
});

test('a month the draft keeps as one line does not get detailed rows', () => {
  const legacy = newerLegacy();
  const plan = withStock(buildDefaultPlan(read(fixture), { currentMonth: '2026-10', pastMode: 'summary' }));
  for (const month of plan.months) month.mode = 'summary';
  const beforeSummary = plan.summary.length;
  const result = applyNewDays(plan, legacy);
  assert.equal(result.plan.sales.length, plan.sales.length, 'مفيش صفوف تفصيلية اتضافت لشهر مجمّع');
  assert.ok(result.plan.summary.length > beforeSummary, 'الشهر المجمّع زاد بنود');
  const month = result.plan.summary.filter((row) => row.month === '2026-10');
  assert.ok(month.some((row) => row.label === 'جراب 50' && row.count === 2));
});

test('an orphaned sale goes back to the item with the same name', () => {
  const plan = withStock(buildDefaultPlan(read(fixture), { currentMonth: '2026-10', pastMode: 'summary' }));
  // The owner's case: two rows with one name, he kept one and the sales still
  // point at the id of the other.
  const grip = plan.items.find((item) => item.name === 'جراب 50');
  grip.id = 'kept-row';
  const before = plan.sales.length;
  const described = describeOrphanSales(plan);
  assert.ok(described.totalSales > 0);
  assert.ok(described.matched.some((group) => group.name === 'جراب 50'), 'البيعة لقيت الصنف اللي بنفس الاسم');
  const result = repairOrphanSales(plan);
  assert.equal(result.plan.sales.length, before, 'مفيش بيعة اتشالت');
  assert.ok(result.plan.sales.every((sale) => result.plan.items.some((item) => item.id === sale.itemId)));
  assert.equal(result.plan.items.length, plan.items.length, 'مفيش صنف زاد');
});

test('a merged name keeps the sales, and a vanished one comes back excluded', () => {
  const plan = buildDefaultPlan(read(fixture), { currentMonth: '2026-10', pastMode: 'summary' });
  const grip = plan.items.find((item) => item.name === 'جراب 50');
  const other = plan.items.find((item) => item.name === 'سكرين HD');
  // What the owner's merge leaves behind: one row carrying the old name.
  other.name = 'سكرين HD/جراب 50';
  plan.items = plan.items.filter((item) => item.id !== grip.id);
  const described = describeOrphanSales(plan);
  assert.ok(described.guessed.some((group) => group.toName === 'سكرين HD/جراب 50'));

  // And a name nobody kept: the item returns, excluded and at zero.
  plan.sales.push({ id: 'sale-lonely', date: '2026-10-02', clock: '', section: 'acc', itemId: 'gone', name: 'حافظة مفقودة', qty: 1, buy: 10, sell: 20, include: true });
  const described2 = describeOrphanSales(plan);
  assert.ok(described2.recreated.some((group) => group.name === 'حافظة مفقودة'));
  const result = repairOrphanSales(plan);
  const revived = result.plan.items.find((item) => item.name === 'حافظة مفقودة' && item.id === 'gone');
  assert.ok(revived, 'الصنف رجع');
  assert.equal(revived.include, false, 'ومش بيتنقل للكتالوج');
  assert.equal(revived.qty, 0, 'ومن غير مخزون مخترع');
  const total = (rows) => rows.reduce((sum, sale) => sum + sale.sell * sale.qty, 0);
  assert.equal(total(result.plan.sales), total(plan.sales), 'فلوس الشهر ما اتغيرتش');
});
