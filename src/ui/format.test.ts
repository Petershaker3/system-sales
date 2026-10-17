// Unit tests for numbers and money on screen. Run: npm run test:unit
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { countWord, dg, money, monthsTxt, num, parseCount, parseMoney, pcsWord, setDigits } from './format.ts';

test('money shows pounds from piastres, with at most two decimals', () => {
  setDigits('latin');
  assert.equal(money(15000), '150 ج.م');
  assert.equal(money(15050), '150.5 ج.م');
  assert.equal(money(1999), '19.99 ج.م');
  assert.equal(money(125000), '1,250 ج.م');
  assert.equal(money(0), '0 ج.م');
});

test('Arabic-Indic digits when the owner chooses them', () => {
  setDigits('arabic');
  assert.equal(num(1250), '١٬٢٥٠');
  assert.equal(dg('INV-2026'), 'INV-٢٠٢٦');
  setDigits('latin');
  assert.equal(dg('INV-2026'), 'INV-2026');
});

test('typed amounts parse to piastres, either digit style', () => {
  assert.equal(parseMoney('150'), 15000);
  assert.equal(parseMoney('١٥٠'), 15000);
  assert.equal(parseMoney('1,250.5'), 125050);
  assert.equal(parseMoney('19.99'), 1999);
  assert.equal(parseMoney('19.999'), null);
  assert.equal(parseMoney('-5'), null);
  assert.equal(parseMoney(''), null);
});

test('typed counts parse to whole numbers', () => {
  assert.equal(parseCount('3'), 3);
  assert.equal(parseCount('٣'), 3);
  assert.equal(parseCount('2.5'), null);
});

test('counted words follow Egyptian usage', () => {
  setDigits('latin');
  assert.equal(pcsWord(1), 'قطعة');
  assert.equal(pcsWord(2), 'قطعتين');
  assert.equal(pcsWord(5), '5 قطع');
  assert.equal(pcsWord(12), '12 قطعة');
  assert.equal(monthsTxt(12), '12 شهر');
  assert.equal(countWord(3, 'نوع', 'نوعين', 'أنواع'), '3 أنواع');
});
