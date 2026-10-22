// What the tool understands from an old backup, and what it decides.
//
// The fixture is synthetic on purpose: the owner's real shop data must never
// enter this repository. It still exercises the shapes that matter — a rolled
// record, both cash shapes, a keypad phone, a repair without a ticket number and
// a category that only appears in a sale.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { readLegacyBackup } from '../src/legacy.mjs';
import { buildDefaultPlan, planTotals, validatePlan } from '../src/plan.mjs';

const text = readFileSync(new URL('./fixtures/legacy-sample.json', import.meta.url), 'utf8');
const legacy = readLegacyBackup(text);
const plan = buildDefaultPlan(legacy);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;

test('the export reads as four days across two months', () => {
  assert.equal(legacy.ok, true);
  assert.deepEqual(legacy.months, ['2026-09', '2026-10']);
  assert.equal(legacy.days.length, 4);
  assert.equal(legacy.shopName, 'محل تجربة');
});

test('a rolled record is kept in the source but never included', () => {
  const rolled = legacy.days.flatMap((day) => Object.values(day.sections)).flat().filter((row) => row.rolled);
  assert.equal(rolled.length, 1);
  assert.equal(plan.sales.some((sale) => sale.sourceId === rolled[0].id), false);
  assert.equal(plan.summary.some((row) => row.label.includes('سكرين')), false);
});

test('the latest month is detailed and the earlier one is summarised', () => {
  const september = plan.months.find((month) => month.month === '2026-09');
  const october = plan.months.find((month) => month.month === '2026-10');
  assert.equal(september.mode, 'summary');
  assert.equal(october.mode, 'detail');
  assert.equal(plan.settings.currentMonth, '2026-10');
  assert.equal(plan.sales.length, 5, 'October keeps its five individual sales');
});

test('summaries group accessories by category, used as one line, phones by model', () => {
  const september = plan.summary.filter((row) => row.month === '2026-09');
  const labels = september.map((row) => row.label).sort();
  assert.deepEqual(labels, ['جراب', 'سماعات', 'مستعمل'].sort());
  assert.equal(plan.summary.filter((row) => row.month === '2026-10').length, 0);
});

test('the summarised numbers equal the source to the piastre', () => {
  const september = plan.summary.filter((row) => row.month === '2026-09');
  const total = september.reduce((sum, row) => sum + row.total, 0);
  const cost = september.reduce((sum, row) => sum + row.cost, 0);
  // 50 (accessory) + 50 (accessory) + 4300 (used) from the fixture.
  assert.equal(total, 4400);
  assert.equal(cost, 25 + 23 + 3300);
});

test('the detailed month keeps the price each sale actually had', () => {
  const jarab = plan.sales.find((sale) => sale.name === 'جراب 50');
  assert.equal(jarab.buy, 25);
  assert.equal(jarab.sell, 60, 'the October price, not the catalogue price');
  const phone = plan.sales.find((sale) => sale.section === 'phones');
  assert.equal(phone.qty, 1);
  assert.equal(phone.sell, 900);
});

test('an accessory sold in the month but absent from the old catalogue is created', () => {
  const shield = plan.items.find((item) => item.name === 'شاشة حماية');
  assert.ok(shield, 'the item exists');
  assert.equal(shield.kind, 'accessory');
  assert.equal(shield.priceSource, 'daily-sales');
  assert.equal(shield.categoryId, plan.categories.find((category) => category.name === 'سكرين').id);
});

test('the catalogue, the store and the sold items make one product list', () => {
  assert.equal(plan.items.length, 7);
  const phones = plan.items.filter((item) => item.kind === 'phone');
  assert.equal(phones.length, 2);
  const samsung = phones.find((item) => item.model === 'A07');
  assert.equal(samsung.storageGb, 64);
  assert.equal(samsung.ramGb, 4);
  assert.equal(samsung.qty, 2);
  const keypad = phones.find((item) => item.model === '102');
  assert.equal(keypad.deviceType, 'keypad');
  assert.equal(keypad.storageGb, null, 'a keypad phone has no storage');
});

test('brands are deduplicated case-insensitively, the way the new unique index sees them', () => {
  assert.deepEqual(plan.brands.map((brand) => brand.name).sort(), ['HMD', 'Samsung']);
});

test('categories carry kinds the new system accepts, and their ids are UUIDs', () => {
  assert.equal(plan.categories.length, 6);
  assert.ok(plan.categories.every((category) => UUID.test(category.id)));
  assert.equal(plan.categories.find((category) => category.name === 'موبايلات جديدة').kind, 'phone');
  assert.equal(plan.categories.find((category) => category.name === 'مستعمل').kind, 'used');
  assert.ok(plan.categories.every((category) => ['item', 'phone', 'used'].includes(category.kind)));
});

test('repairs and software become tickets, and every one gets a unique number', () => {
  assert.equal(plan.repairs.length, 3);
  assert.equal(plan.repairs.filter((repair) => repair.kind === 'software').length, 2);
  const numbers = plan.repairs.map((repair) => repair.ticketNo);
  assert.equal(new Set(numbers).size, numbers.length);
});

test('cash keeps the commission and the moved amount apart', () => {
  const withBoth = plan.cashOps.find((row) => row.hasMovedAmount);
  assert.equal(withBoth.fee, 5);
  assert.equal(withBoth.moved, 500);
  const oldShape = plan.cashOps.find((row) => !row.hasMovedAmount);
  assert.equal(oldShape.kind, 'deposit', 'the oldest rows had no cash type and were deposits');
  assert.equal(oldShape.moved, 0);
});

test('wallets open on the balance the old file recorded, flagged as a guess', () => {
  const vf = plan.wallets.find((wallet) => wallet.id === 'vf');
  assert.equal(vf.currentBalance, 1000);
  assert.equal(vf.balanceIsGuess, true);
  assert.equal(vf.number, '01000000000');
  assert.equal(plan.wallets.find((wallet) => wallet.id === 'ip').payMethod, 'instapay');
});

test('notes, notifications and the trash are reported, not imported', () => {
  const keys = plan.source.excludedKeys.map((entry) => entry.key);
  for (const key of ['mshop_notes', 'mshop_notifs', 'mshop_trash', 'mshop_calc_hist']) {
    assert.ok(keys.includes(key), `${key} is listed as excluded`);
  }
  assert.deepEqual(legacy.legacySecretsSeen.sort(), ['googleClientId', 'passAdmin', 'passMain']);
});

test('a clean plan has no blocking findings', () => {
  const validation = validatePlan(plan);
  assert.deepEqual(validation.findings.filter((finding) => finding.level === 'error'), []);
  assert.equal(validation.includes.items, 7);
  assert.equal(validation.includes.sales, 5);
  assert.equal(validation.includes.summary, 3);
});

test('validation refuses what the database would refuse', () => {
  const broken = structuredClone(plan);
  broken.categories.push({ ...broken.categories[0], id: 'dup', name: broken.categories[0].name });
  broken.sales.push({ id: 'x', date: '2026-10-01', clock: '', section: 'acc', itemId: 'missing', name: 'x', qty: 1, buy: 1, sell: 2, include: true });
  broken.wallets[0].currentBalance = -5;
  const errors = validatePlan(broken).findings.filter((finding) => finding.level === 'error').map((finding) => finding.code);
  assert.ok(errors.includes('duplicate-category'));
  assert.ok(errors.includes('sale-item-missing'));
  assert.ok(errors.includes('wallet-negative'));
});

test('plan totals match the rows that are included', () => {
  const totals = planTotals(plan);
  assert.equal(totals.saleCount, 5);
  assert.equal(totals.summaryCount, 3);
  assert.equal(totals.summaryTotal, 4400);
  assert.equal(totals.expenseTotal, 115);
  assert.equal(totals.repairTotal, 500);
});
