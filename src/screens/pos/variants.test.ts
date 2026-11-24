// Unit tests for sales-screen variant helpers. Run: npm run test:unit
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  collapseFamilies,
  familyPriceSummary,
  firstEnabledVariantIndex,
  stepVariantHighlight,
  variantOptionLabel,
  type VariantLikeProduct,
} from './variants.ts';

const standalone = (id: string, name: string, price: number): VariantLikeProduct => ({
  id,
  name,
  salePriceMinor: price,
  parentId: null,
});

const variant = (
  id: string,
  order: number,
  v1: string,
  v2: string,
  price: number,
): VariantLikeProduct => ({
  id,
  name: `جراب سيليكون ملون ${v1} ${v2}`,
  salePriceMinor: price,
  parentId: 'fam-1',
  parentName: 'جراب سيليكون ملون',
  dimension1: 'الموبايل',
  dimension2: 'اللون',
  variant1: v1,
  variant2: v2,
  variantOrder: order,
});

test('collapseFamilies collapses variants of a parent into one family tile in variantOrder', () => {
  const items: VariantLikeProduct[] = [
    standalone('p1', 'شاحن سامسونج', 35000),
    variant('v2', 1, 'Galaxy A16', 'بينك', 7000),
    standalone('p2', 'كابل تايب سي', 8000),
    variant('v1', 0, 'Galaxy A16', 'أسود', 7000),
    variant('v3', 2, 'iPhone 16', 'أسود', 9000),
  ];

  const entries = collapseFamilies(items);
  assert.equal(entries.length, 3);
  assert.equal(entries[0]?.kind, 'product');
  assert.equal(entries[1]?.kind, 'family');
  assert.equal(entries[2]?.kind, 'product');

  const fam = entries[1];
  assert.ok(fam && fam.kind === 'family');
  assert.equal(fam.parentId, 'fam-1');
  assert.equal(fam.parentName, 'جراب سيليكون ملون');
  assert.deepEqual(fam.dimensions, ['الموبايل', 'اللون']);
  assert.deepEqual(
    fam.variants.map((v) => v.id),
    ['v1', 'v2', 'v3'],
  );
});

test('familyPriceSummary reports min/max and whether prices differ across variants', () => {
  assert.deepEqual(
    familyPriceSummary([
      { salePriceMinor: 7000 },
      { salePriceMinor: 7000 },
    ]),
    { minMinor: 7000, maxMinor: 7000, varies: false },
  );
  assert.deepEqual(
    familyPriceSummary([
      { salePriceMinor: 7000 },
      { salePriceMinor: 9000 },
    ]),
    { minMinor: 7000, maxMinor: 9000, varies: true },
  );
  assert.deepEqual(familyPriceSummary([{ salePriceMinor: null }]), {
    minMinor: null,
    maxMinor: null,
    varies: false,
  });
});

test('variantOptionLabel joins variant values with an Arabic comma', () => {
  assert.equal(
    variantOptionLabel({ variant1: 'Galaxy A16', variant2: 'أسود', name: 'x' }),
    'Galaxy A16، أسود',
  );
  assert.equal(
    variantOptionLabel({ variant1: '20W', variant2: null, name: 'x' }),
    '20W',
  );
  assert.equal(
    variantOptionLabel({ variant1: null, variant2: null, name: 'شاحن' }),
    'شاحن',
  );
});

test('firstEnabledVariantIndex and stepVariantHighlight skip disabled options and wrap', () => {
  const flags = [false, true, false, true];
  assert.equal(firstEnabledVariantIndex(flags), 1);
  assert.equal(stepVariantHighlight(flags, 1, 1), 3);
  assert.equal(stepVariantHighlight(flags, 3, 1), 1);
  assert.equal(stepVariantHighlight(flags, 1, -1), 3);
  assert.equal(firstEnabledVariantIndex([false, false]), 0);
  assert.equal(stepVariantHighlight([false, false], 0, 1), 0);
});
