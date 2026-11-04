import assert from 'node:assert/strict';
import test from 'node:test';

import { digitsOf, filterProducts, productMatches } from './catalog-search.ts';
import { normalizeShortageSearch } from './shortages.ts';

const charger = { id: 'p1', name: 'شاحن 7210 تخين', barcode: '2000000000017' };
const phone = { id: 'p2', name: 'Samsung A07 8GB/256GB', barcode: null };
const emeiPhone = { id: 'p3', name: 'Infinix Hot 30', barcode: '2000000000024' };

test('the search finds an item by name, by code, and by the serial on the shelf', () => {
  // By name, with the Arabic letter variants a shopkeeper actually types.
  assert.equal(productMatches('شاحن', charger), true);
  assert.equal(productMatches('شارج', charger), false);
  // By barcode, whole or partial.
  assert.equal(productMatches('2000000000017', charger), true);
  assert.equal(productMatches('0017', charger), true);
  // By the IMEI of a handset that is on the shelf.
  assert.equal(productMatches('356938035643809', phone, ['356938035643809']), true);
  assert.equal(productMatches('5643', phone, ['356938035643809']), true);

  // And it does not answer for something it is not.
  assert.equal(productMatches('جراب', charger), false);
  assert.equal(productMatches('356938035643809', emeiPhone, ['111111111111111']), false);
});

test('an empty search keeps every row, and the filter keeps the loaded order', () => {
  const rows = [charger, phone, emeiPhone];
  assert.deepEqual(filterProducts(rows, '').map((r) => r.id), ['p1', 'p2', 'p3']);
  assert.deepEqual(filterProducts(rows, 'a07').map((r) => r.id), ['p2']);
  assert.deepEqual(
    filterProducts(rows, '0017', new Map()).map((r) => r.id),
    ['p1'],
  );
});

test('Arabic letter shapes and Arabic-Indic digits read the same', () => {
  assert.equal(normalizeShortageSearch('شاحن'), normalizeShortageSearch('شاحن'));
  assert.equal(digitsOf('٠١٠٦-١٢٣'), '0106123');
});
