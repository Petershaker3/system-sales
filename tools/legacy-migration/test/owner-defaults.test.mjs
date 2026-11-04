// قرارين المالك (2026-11-02) مكتوبين كاختبارات:
//
//   1. «خلي الـIMEI أصفار مؤقتًا» — جهاز مستعمل من غير رقم بيتاخد رقم مؤقت من
//      الأصفار، بس لازم يبقى رقم البرنامج نفسه بيقبله (١٥ رقم + رقم تحقق) وفريد،
//      وإلا قاعدة البيانات بترفض الملف كله.
//   2. «سعر البيع أصفار لحد ما نعدل السيستم» — الصنف اللي مش معروف سعره بيتسجل
//      صفر صريح، مش رقم مخترع ومش NULL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { preparePlan } from '../src/pipeline.mjs';
import { buildDefaultPlan, validatePlan, placeholderImei, applyOwnerDefaults, placeholderDeviceCount } from '../src/plan.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/legacy-sample.json', import.meta.url), 'utf8'));
const read = (raw) => preparePlan(JSON.stringify(raw), {}).legacy;

const usedPlan = () => ({
  format: 'system-sales-migration',
  items: [
    { id: 'u1', kind: 'used', name: 'VIVO Y04', buy: 4000, sell: 5000, include: true, qty: 2, devices: [{ imei: '', condition: 'B', cost: 4000 }, { condition: 'A' }] },
    { id: 'p1', kind: 'phone', name: 'Samsung A07', buy: 6000, sell: null, include: true, qty: 1, devices: [] },
    { id: 'a1', kind: 'accessory', name: 'جراب', buy: 25, sell: 50, include: true, qty: 3 },
    { id: 'x1', kind: 'used', name: 'مستبعد', buy: 1, sell: 1, include: false, devices: [{ imei: '' }] },
  ],
  categories: [], brands: [], months: [], sales: [], summary: [], repairs: [], expenses: [], cashOps: [], wallets: [], expenseCategories: [],
});

test('the placeholder IMEI is a number the app itself accepts', () => {
  const seen = new Set();
  for (let serial = 1; serial <= 200; serial += 1) {
    const imei = placeholderImei(serial);
    assert.match(imei, /^\d{15}$/, `${imei} مش ١٥ رقم`);
    assert.match(imei, /^0{9}/, `${imei} مش أصفار`);
    // نفس قاعدة رقم التحقق اللي في الكاشير.
    let sum = 0;
    for (let index = 0; index < 14; index += 1) {
      let digit = Number(imei[index]);
      if (index % 2 === 1) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
    }
    assert.equal((10 - (sum % 10)) % 10, Number(imei[14]), `${imei} رقم تحققه غلط`);
    assert.ok(!seen.has(imei), `${imei} متكرر — والبرنامج بيرفض التكرار`);
    seen.add(imei);
  }
});

test('a used device without a number gets a placeholder, and only that device', () => {
  const plan = usedPlan();
  const summary = applyOwnerDefaults(plan);
  assert.equal(summary.placeholderImeis, 2);
  assert.equal(plan.items[0].devices[0].imei, '000000000000018');
  assert.equal(plan.items[0].devices[1].imei, '000000000000026');
  assert.ok(plan.items[0].devices.every((device) => device.imeiIsPlaceholder));
  // المستبعد مش داخل النسخة، فمش بياخد رقم ولا بيتعدل.
  assert.equal(plan.items[3].devices[0].imei, '');
});

test('running the defaults twice changes nothing', () => {
  const plan = usedPlan();
  applyOwnerDefaults(plan);
  const snapshot = JSON.stringify(plan);
  const again = applyOwnerDefaults(plan);
  assert.equal(JSON.stringify(plan), snapshot);
  // The second run still *counts* what has no price — it just changes nothing.
  assert.equal(again.placeholderImeis, 0);
  assert.equal(again.zeroPricedItems, 1);
});

test('a phone with no known price goes in with no price, not with a zero', () => {
  const plan = usedPlan();
  const summary = applyOwnerDefaults(plan);
  assert.equal(summary.zeroPricedItems, 1);
  // NULL = «مالوش سعر بيع» في البرنامج (وبيرفض يبيعه)، وصفر كان هيبقى سعر مجاني.
  assert.equal(plan.items[1].sell, null);
  // الصنف اللي ليه سعر ما بيتلمسش.
  assert.equal(plan.items[2].sell, 50);
});

test('a stored zero turns into no price, because zero is a price', () => {
  const plan = usedPlan();
  plan.items[2].sell = 0;
  applyOwnerDefaults(plan);
  assert.equal(plan.items[2].sell, null);
});

test('a zero price is a warning, not a reason to refuse the build', () => {
  const plan = usedPlan();
  applyOwnerDefaults(plan);
  const findings = validatePlan(plan).findings;
  const zero = findings.filter((finding) => finding.code === 'no-sale-price');
  assert.equal(zero.length, 1);
  assert.equal(zero[0].level, 'warn');
  assert.equal(findings.filter((finding) => finding.level === 'error').length, 0);
});

test('the real fixture keeps its prices when they exist', () => {
  const plan = buildDefaultPlan(read(fixture), { currentMonth: '2026-10', pastMode: 'summary' });
  const priced = plan.items.filter((item) => item.sell > 0).length;
  const summary = applyOwnerDefaults(plan);
  assert.equal(plan.items.filter((item) => item.sell > 0).length, priced);
  assert.equal(summary.placeholderImeis, placeholderDeviceCount(plan));
});
