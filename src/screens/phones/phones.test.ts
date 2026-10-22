// The phones section's arithmetic (`screens/phones/phones.ts`).
//
// The two questions the owner asked for — how many handsets, and what they are
// worth — are both computed here from one list, so a bug in the screen cannot make
// «بالعدد» and «بالفلوس» disagree.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPhoneModels,
  daysInStock,
  isPhoneProduct,
  isUsedUnit,
  matchesPhone,
  phoneTotals,
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

  const totals = phoneTotals(models);
  assert.equal(totals.units, 4);
  assert.equal(totals.usedUnits, 2);
  assert.equal(totals.costMinor, 3_540_000);
  assert.equal(totals.saleMinor, 4_250_000);
  assert.equal(totals.expectedProfitMinor, 710_000, 'every handset here has a cost');
  // The biggest shelf value comes first: that is the money to look at.
  assert.equal(models[0]?.productId, 'b');
});

test('a model with no price is said so, not counted as free', () => {
  const models = buildPhoneModels(
    [product('a', 'Nokia 105', null), product('b', 'iPhone 13', 2_000_000)],
    [unit('1', 'a', 300_000), unit('2', 'b', 1_800_000)],
  );
  const totals = phoneTotals(models);
  assert.equal(totals.costMinor, 2_100_000, 'the cost is known even when the price is not');
  assert.equal(totals.saleMinor, null, '«من غير سعر» is not zero');
  assert.equal(totals.expectedProfitMinor, null);
});

test('a handset whose product vanished still counts on the shelf', () => {
  const models = buildPhoneModels([], [unit('1', 'gone', 400_000)]);
  assert.equal(models.length, 1);
  assert.equal(models[0]?.available, 1);
  assert.equal(models[0]?.costMinor, 400_000, 'the money is on the shelf whether or not the row is');
  assert.equal(phoneTotals(models).costMinor, 400_000);
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

  const totals = phoneTotals(models);
  assert.equal(totals.units, 4);
  assert.equal(totals.unregistered, 2);
  assert.equal(totals.costMinor, 1_300_000);
  assert.equal(models[0]?.saleMinor, 3_700_000, 'four handsets at 9,250, not just the two registered');
  assert.equal(
    totals.expectedProfitMinor,
    null,
    'a shelf with an unpriced cost cannot claim a profit, even a negative one',
  );
});

test('a phone model with an empty shelf is still listed', () => {
  const models = buildPhoneModels([{ ...product('a', 'iPhone 16', 5_750_000), onHand: 0 }], []);
  assert.equal(models.length, 1);
  assert.equal(models[0]?.available, 0);
  assert.equal(models[0]?.saleMinor, 0);
  assert.equal(phoneTotals(models).units, 0);
});
