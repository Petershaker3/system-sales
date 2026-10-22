// The bridge layer: what the screen promises about the old → new mapping.
//
// A mapping is only worth showing if it stays true. These tests pin the three
// things that would otherwise drift silently: every old key has a destination,
// every collection can be described on both sides, and every finding the
// validator can produce has a written reason and a written fix.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { readLegacyBackup } from '../src/legacy.mjs';
import { buildDefaultPlan, validatePlan } from '../src/plan.mjs';
import {
  LEGACY_MAP,
  describeRow,
  explainFinding,
  fieldsOf,
  stateOf,
} from '../src/mapping.mjs';

const text = readFileSync(new URL('./fixtures/legacy-sample.json', import.meta.url), 'utf8');
const plan = buildDefaultPlan(readLegacyBackup(text));

test('every old key the tool reads is on the map, with a destination', () => {
  const keys = LEGACY_MAP.map((entry) => entry.key);
  for (const needle of ['mshop_cfg', 'mshop_cats', 'mshop_ca', 'mshop_cu', 'mshop_inventory', 'mshop_wallets_list + cfg']) {
    assert.ok(keys.includes(needle), `${needle} is on the map`);
  }
  for (const entry of LEGACY_MAP) {
    assert.ok(entry.title && entry.legacy && entry.plan, `${entry.key} explains itself`);
    assert.ok(entry.dest && entry.inNew, `${entry.key} says where it lands`);
    assert.equal(typeof entry.count(legacy(), plan), 'number', `${entry.key} counts without throwing`);
  }
});

function legacy() {
  return readLegacyBackup(text);
}

test('every map row either has a tab to open or says nothing moves', () => {
  const tabs = ['overview', 'map', 'categories', 'brands', 'items', 'months', 'sales', 'repairs', 'expenses', 'wallets', 'settings', 'build'];
  for (const entry of LEGACY_MAP) {
    if (entry.tab === '') continue;
    assert.ok(tabs.includes(entry.tab), `${entry.key} points at a real tab (${entry.tab})`);
  }
});

test('an item shows its old shape and the department it will live under', () => {
  const item = plan.items.find((row) => row.name === 'جراب 50');
  const described = describeRow(plan, 'items', item);
  assert.equal(described.old.fields.length > 0, true, 'the old row has fields to show');
  assert.match(described.next.where, /المخزن ← الأصناف/);
  assert.match(described.next.where, new RegExp(plan.categories.find((category) => category.id === item.categoryId).name));
  const labels = described.next.fields.map((field) => field.label);
  assert.ok(labels.includes('القسم'));
  assert.ok(labels.includes('سعر البيع'));
});

test('a sale says which invoice it becomes and what the money was', () => {
  const sale = plan.sales.find((row) => row.name === 'جراب 50');
  const described = describeRow(plan, 'sales', sale);
  assert.match(described.next.where, /المبيعات ← فاتورة 2026-10-01/);
  assert.match(described.next.table, /sale_lines/);
  const labels = described.next.fields.map((field) => field.label);
  assert.ok(labels.includes('الإجمالي'));
  assert.ok(labels.includes('الربح'));
  assert.equal(described.old.fields.some((field) => field.label === 'التصنيف'), true);
});

test('a repair, an expense, a wallet and a month all describe themselves', () => {
  for (const [coll, row] of [
    ['repairs', plan.repairs[0]],
    ['expenses', plan.expenses[0]],
    ['wallets', plan.wallets[0]],
    ['months', plan.months[0]],
    ['summary', plan.summary[0]],
    ['categories', plan.categories[0]],
    ['brands', plan.brands[0]],
  ]) {
    const described = describeRow(plan, coll, row);
    assert.equal(described.old.title, 'في القديم', coll);
    assert.equal(described.next.title, 'في السيستم الجديد', coll);
    assert.ok(described.next.where.length > 0, `${coll} says where it lands`);
    assert.ok(described.next.fields.length > 0, `${coll} lists the new shape`);
  }
});

test('the details panel can edit the fields that matter, and never invents one', () => {
  const item = plan.items.find((row) => row.kind === 'accessory');
  const fields = fieldsOf(plan, 'items', item).map((field) => field.field);
  for (const needed of ['name', 'categoryId', 'buy', 'sell', 'qty']) assert.ok(fields.includes(needed), needed);
  assert.equal(fields.includes('brandId'), false, 'an accessory has no brand field');

  const phone = plan.items.find((row) => row.kind === 'phone');
  const phoneFields = fieldsOf(plan, 'items', phone).map((field) => field.field);
  for (const needed of ['brandId', 'model', 'ramGb', 'storageGb']) assert.ok(phoneFields.includes(needed), needed);
});

test('the row status reads in the owner\'s words', () => {
  assert.equal(stateOf({ include: true }).label, 'هيتنقل');
  assert.equal(stateOf({ include: false }).label, 'مش هيتنقل');
});

test('every finding the validator emits has a reason and a fix', () => {
  // Build a plan that trips every check at once, so the guide list is measured
  // against what `validatePlan` actually produces, not against a wish list.
  const broken = JSON.parse(JSON.stringify(plan));
  broken.categories.push({ ...broken.categories[0], id: 'cat-dup', name: broken.categories[0].name, include: true });
  broken.categories.push({ id: 'cat-empty', name: '  ', kind: 'item', icon: 'nope', sortOrder: 1, include: true });
  broken.categories.push({ id: 'cat-orphan', name: 'يتيم', kind: 'item', icon: 'tag', sortOrder: 2, include: true, parentId: 'gone' });
  broken.items.push({ ...broken.items[0], id: 'item-empty', name: '', include: true });
  broken.items.push({ ...broken.items[0], id: 'item-negative', name: 'سالب', buy: -5, include: true });
  broken.items.push({ ...broken.items[0], id: 'item-orphan', name: 'بلا قسم', categoryId: 'gone', include: true });
  broken.items.push({ ...broken.items[0], id: 'item-dup', name: broken.items[0].name, include: true });
  broken.items.push({ ...broken.items[0], id: 'item-nosell', name: 'بلا سعر', sell: null, include: true });
  broken.items.push({ id: 'item-phone', kind: 'phone', name: 'موبايل ناقص', brandId: null, model: '', buy: 1, sell: 2, qty: 0, include: true, priceSource: 'added' });
  broken.sales.push({ id: 'sale-orphan', date: '2026-10-01', clock: '', section: 'acc', itemId: 'gone', name: 'x', qty: 1, buy: 1, sell: 2, include: true });
  broken.months[0].mode = 'skip';
  broken.months[0].include = true;
  broken.wallets[0].currentBalance = -1;
  broken.wallets[0].number = 'x'.repeat(90);
  broken.expenses.push({ id: 'exp-zero', date: '2026-10-01', clock: '', category: 'مصاريف', amount: 0, include: true });
  broken.repairs.push({ ...broken.repairs[0], id: 'rep-negative', ticketNo: 'T-1', price: -1, include: true });

  const { findings } = validatePlan(broken);
  const codes = [...new Set(findings.map((finding) => finding.code))];
  assert.ok(codes.length >= 12, `the probe trips many checks (${codes.length})`);
  for (const code of codes) {
    const explained = explainFinding({ code, level: 'error', message: '', ref: null });
    assert.notEqual(explained.title, 'ملاحظة', `${code} has a written title`);
    assert.ok(explained.why.length > 20, `${code} explains why`);
    assert.match(explained.fix, /\S/, `${code} says what to do`);
    assert.ok(explained.tab, `${code} can be reached`);
  }
});
