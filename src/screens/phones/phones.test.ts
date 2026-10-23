// The phones section's arithmetic (`screens/phones/phones.ts`).
//
// The two questions the owner asked for — how many handsets, and what they are
// worth — are both computed here from one list, so a bug in the screen cannot make
// «بالعدد» and «بالفلوس» disagree.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPhoneModels,
  buildShelfCards,
  cardsTotals,
  companyCounts,
  daysInStock,
  isPhoneProduct,
  isUsedUnit,
  matchesPhone,
  modelKind,
  type PhoneHandset,
  type PhoneProductLike,
  type PhoneUnitLike,
} from './phones.ts';

const product = (
  id: string,
  name: string,
  price: number | null,
  disposition = 'serialized',
): PhoneProductLike => ({ id, name, salePriceMinor: price, disposition, status: 'active' });

const unit = (
  id: string,
  productId: string,
  cost: number,
  extra: Partial<PhoneUnitLike> = {},
): PhoneUnitLike => ({
  id,
  productId,
  imei: `35${id.padStart(13, '0')}`,
  unitCostMinor: cost,
  createdAt: 1_700_000_000_000,
  ...extra,
});

test('only serialized and one-off products are phones, and an archived one is not', () => {
  assert.equal(isPhoneProduct(product('a', 'Galaxy A16', 100)), true);
  assert.equal(isPhoneProduct(product('b', 'كفر', 100, 'quantity')), false);
  assert.equal(isPhoneProduct(product('c', 'Nokia 105', 100, 'one_off')), true);
  // A phone registered as a tracked quantity product is still a phone: the
  // disposition split came later than the phones did.
  assert.equal(
    isPhoneProduct({ ...product('e', 'Galaxy A16', 100, 'quantity'), tracking: 'serial_optional' }),
    true,
  );
  assert.equal(
    isPhoneProduct({ ...product('f', 'كابل', 100, 'quantity'), tracking: 'none' }),
    false,
  );
  assert.equal(
    isPhoneProduct({ ...product('d', 'قديم', 100), status: 'archived' }),
    false,
    'a phone nobody sells any more is not one to count',
  );
});

test('a used handset is the one with a condition, not the one in a used category', () => {
  assert.equal(isUsedUnit(unit('1', 'a', 500)), false);
  assert.equal(isUsedUnit(unit('2', 'a', 500, { conditionGrade: 'B' })), true);
  assert.equal(isUsedUnit(unit('3', 'a', 500, { batteryHealthPct: 88 })), true);
  assert.equal(isUsedUnit(unit('4', 'a', 500, { conditionGrade: null })), false);
});

test('models carry their own count and money, and the totals agree with them', () => {
  const products = [
    product('a', 'Samsung Galaxy A16', 750_000),
    product('b', 'iPhone 13', 2_000_000),
    product('c', 'كابل', 8000, 'quantity'),
  ];
  const units = [
    unit('1', 'a', 600_000),
    unit('2', 'a', 640_000),
    unit('3', 'a', 500_000, { conditionGrade: 'B' }),
    unit('4', 'b', 1_800_000, { batteryHealthPct: 90 }),
  ];
  const models = buildPhoneModels(products, units);
  assert.equal(models.length, 2, 'the cable is not a phone');

  const a = models.find((m) => m.productId === 'a');
  assert.equal(a?.available, 3);
  assert.equal(a?.newCount, 2);
  assert.equal(a?.usedCount, 1);
  assert.equal(a?.costMinor, 1_740_000);
  assert.equal(a?.avgCostMinor, 580_000, 'the average is the shelf’s, not the price list’s');
  assert.equal(a?.saleMinor, 2_250_000, 'three handsets at 7,500');

  // There is deliberately no «total» that adds the two kinds together: the owner
  // reads new and used as two shelves, and a mixed number would be a third thing
  // nobody asked for.
  const shelf = cardsTotals(models.map((m) => ({
    productId: m.productId,
    name: m.name,
    brand: '',
    salePriceMinor: m.salePriceMinor,
    handsets: [],
    unregistered: m.unregistered,
    count: m.available,
    costMinor: m.costMinor,
    saleMinor: m.saleMinor,
    avgCostMinor: m.avgCostMinor,
  })));
  assert.equal(shelf.units, 4);
  assert.equal(shelf.costMinor, 3_540_000);
  assert.equal(shelf.saleMinor, 4_250_000);
  // The biggest shelf value comes first: that is the money to look at.
  assert.equal(models[0]?.productId, 'b');
});

test('a model with no price is said so, not counted as free', () => {
  const models = buildPhoneModels(
    [product('a', 'Nokia 105', null), product('b', 'iPhone 13', 2_000_000)],
    [unit('1', 'a', 300_000), unit('2', 'b', 1_800_000)],
  );
  const nokia = models.find((m) => m.productId === 'a');
  assert.equal(nokia?.costMinor, 300_000, 'the cost is known even when the price is not');
  assert.equal(nokia?.saleMinor, null, '«من غير سعر» is not zero, and never 0×count');
});

test('a handset whose product vanished still counts on the shelf', () => {
  const models = buildPhoneModels([], [unit('1', 'gone', 400_000)]);
  assert.equal(models.length, 1);
  assert.equal(models[0]?.available, 1);
  assert.equal(models[0]?.costMinor, 400_000, 'the money is on the shelf whether or not the row is');
  assert.equal(models[0]?.costMinor, 400_000);
});

test('search matches a model, a colour, or the tail of an IMEI', () => {
  const handset = { name: 'Samsung Galaxy A16', imei: '350123456789012', color: 'أزرق' };
  assert.equal(matchesPhone('', handset), true);
  assert.equal(matchesPhone('galaxy', handset), true);
  assert.equal(matchesPhone('ازرق', handset), true, 'أ/ا are one letter, as everywhere else');
  assert.equal(matchesPhone('9012', handset), true, 'the last digits are what people read out');
  assert.equal(matchesPhone('9988', handset), false, 'digits count only when they are in the IMEI');
  assert.equal(matchesPhone('ايفون', handset), false);
});

test('days in stock never goes backwards', () => {
  const now = 1_700_000_000_000;
  assert.equal(daysInStock(now - 2 * 86_400_000, now), 2);
  assert.equal(daysInStock(now, now), 0);
  assert.equal(daysInStock(now + 86_400_000, now), 0, 'a clock that went back is not negative age');
  assert.equal(daysInStock(0, now), 0);
});

test('stock received by quantity is counted, and said to be unregistered', () => {
  // A shop can receive a box and type «4» instead of four IMEIs. Those handsets
  // are on the shelf and must be in the count — but they have no IMEI, and the
  // screen has to say so rather than pretend the row is complete.
  const models = buildPhoneModels(
    [{ ...product('a', 'Samsung Galaxy A16', 925_000), onHand: 4 }],
    [unit('1', 'a', 640_000), unit('2', 'a', 660_000)],
  );
  assert.equal(models.length, 1);
  assert.equal(models[0]?.available, 4);
  assert.equal(models[0]?.unregistered, 2);
  assert.equal(models[0]?.avgCostMinor, 650_000, 'the average covers the two handsets whose cost is known');

  assert.equal(models[0]?.costMinor, 1_300_000, 'only the two handsets whose cost is known');
  assert.equal(models[0]?.saleMinor, 3_700_000, 'four handsets at 9,250, not just the two registered');
});

test('a phone model with an empty shelf is still listed', () => {
  const models = buildPhoneModels([{ ...product('a', 'iPhone 16', 5_750_000), onHand: 0 }], []);
  assert.equal(models.length, 1);
  assert.equal(models[0]?.available, 0);
  assert.equal(models[0]?.saleMinor, 0);
  assert.deepEqual(buildShelfCards(models, [], 'new'), [], 'nothing on the shelf is not a row of zeros');
});

// --- two shelves: the used phones never mix into the new ones ----------------

const handset = (extra: Partial<PhoneHandset> & { id: string; productId: string }): PhoneHandset => ({
  name: 'Galaxy A16',
  brand: 'Samsung',
  imei: `35${extra.id.padStart(13, '0')}`,
  color: '',
  used: false,
  costMinor: 100_000,
  salePriceMinor: 130_000,
  createdAt: 1_700_000_000_000,
  conditionGrade: null,
  batteryHealthPct: null,
  ...extra,
});

test('the used shelf holds only used handsets, the new shelf only new ones', () => {
  const products = [product('p1', 'Galaxy A16', 1_300_000)];
  const models = buildPhoneModels(products, [
    unit('1', 'p1', 900_000),
    unit('2', 'p1', 950_000),
    unit('3', 'p1', 500_000, { conditionGrade: 'B', batteryHealthPct: 88 }),
  ]);
  const handsets = [
    handset({ id: '1', productId: 'p1', costMinor: 900_000 }),
    handset({ id: '2', productId: 'p1', costMinor: 950_000 }),
    handset({
      id: '3',
      productId: 'p1',
      costMinor: 500_000,
      used: true,
      conditionGrade: 'B',
      batteryHealthPct: 88,
    }),
  ];

  const fresh = buildShelfCards(models, handsets, 'new');
  const used = buildShelfCards(models, handsets, 'used');

  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]!.count, 2, 'only the two new handsets');
  assert.equal(fresh[0]!.costMinor, 1_850_000);
  assert.deepEqual(fresh[0]!.handsets.map((h) => h.id).sort(), ['1', '2']);

  assert.equal(used.length, 1);
  assert.equal(used[0]!.count, 1);
  assert.equal(used[0]!.costMinor, 500_000);
  assert.deepEqual(used[0]!.handsets.map((h) => h.id), ['3']);

  // the two totals are each other's complement, never a mix of the two
  assert.equal(cardsTotals(fresh).units + cardsTotals(used).units, 3);
  assert.equal(cardsTotals(fresh).costMinor + cardsTotals(used).costMinor, 2_350_000);
});

test('a used-only model does not appear on the new shelf at all', () => {
  const models = buildPhoneModels([product('p1', 'iPhone 16', 4_000_000)], [
    unit('1', 'p1', 3_000_000, { conditionGrade: 'A' }),
  ]);
  const usedHandset = handset({
    id: '1',
    productId: 'p1',
    used: true,
    costMinor: 3_000_000,
    conditionGrade: 'A',
  });

  assert.equal(modelKind(models[0]!), 'used');
  assert.deepEqual(buildShelfCards(models, [usedHandset], 'new'), []);
  assert.equal(buildShelfCards(models, [usedHandset], 'used')[0]!.count, 1);
});

test('stock received by quantity is counted on its own shelf and named as a gap', () => {
  // four A16s on the counter, two of them registered with an IMEI
  const models = buildPhoneModels([{ ...product('p1', 'Galaxy A16', 1_300_000), onHand: 4 }], [
    unit('1', 'p1', 900_000),
    unit('2', 'p1', 900_000),
  ]);
  const handsets = [
    handset({ id: '1', productId: 'p1', costMinor: 900_000 }),
    handset({ id: '2', productId: 'p1', costMinor: 900_000 }),
  ];

  const fresh = buildShelfCards(models, handsets, 'new');
  assert.equal(fresh[0]!.count, 4);
  assert.equal(fresh[0]!.unregistered, 2);
  assert.equal(fresh[0]!.costMinor, 1_800_000, 'only the registered handsets have a cost');
  assert.equal(fresh[0]!.saleMinor, 1_300_000 * 4, 'the price is per handset on the shelf');
  assert.equal(cardsTotals(fresh).unregistered, 2);
});

test('a shelf with nothing on it says nothing rather than zero', () => {
  const models = buildPhoneModels([product('p1', 'Galaxy A16', 1_300_000)], []);
  assert.deepEqual(buildShelfCards(models, [], 'new'), []);
  assert.deepEqual(cardsTotals([]), {
    models: 0,
    units: 0,
    unregistered: 0,
    costMinor: 0,
    saleMinor: 0,
  });
});

test('the company strip counts one shelf only, and shares add up to a hundred', () => {
  const models = buildPhoneModels(
    [
      product('p1', 'Galaxy A16', 100),
      product('p2', 'iPhone 16', 100),
    ],
    [unit('1', 'p1', 10), unit('2', 'p1', 10), unit('3', 'p2', 10, { conditionGrade: 'A' })],
  );
  const handsets = [
    handset({ id: '1', productId: 'p1', brand: 'Samsung', costMinor: 10_000 }),
    handset({ id: '2', productId: 'p1', brand: 'Samsung', costMinor: 10_000 }),
    handset({ id: '3', productId: 'p2', brand: 'Apple', used: true, costMinor: 10_000 }),
  ];

  const fresh = companyCounts(buildShelfCards(models, handsets, 'new'));
  assert.deepEqual(fresh.map((c) => [c.name, c.units, c.sharePct]), [['Samsung', 2, 100]]);

  const used = companyCounts(buildShelfCards(models, handsets, 'used'));
  assert.deepEqual(used.map((c) => [c.name, c.units, c.sharePct]), [['Apple', 1, 100]]);
});
