// «الجرد» بالعدد ومقسوم زراير/تانش، وأرقام المخزن اللي فوقه.

import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';

import {
  buildCountSheet,
  type CountProductInput,
  countScopePieces,
  countSheetPieces,
  filterCountRows,
  storeFigures,
} from './count-sheet.ts';

function phone(over: Partial<CountProductInput> = {}): CountProductInput {
  return {
    id: over.id ?? 'p-1',
    name: over.name ?? 'Samsung A16',
    disposition: over.disposition ?? 'serialized',
    deviceType: 'deviceType' in over ? over.deviceType : 'touch',
    brandId: over.brandId ?? 'b-samsung',
    onHand: over.onHand ?? 1,
    salePriceMinor: over.salePriceMinor ?? null,
  };
}

const company = (id: string | null): string => (id === 'b-samsung' ? 'سامسونج' : 'بدون شركة');

describe('the count sheet splits the shelves the way the owner counts them', () => {
  it('counts keypad and touch separately, and never mixes a phone with an item', () => {
    const sheet = buildCountSheet(
      [
        phone({ id: 'n1', deviceType: 'keypad', onHand: 4 }),
        phone({ id: 'n2', deviceType: 'keypad', onHand: 1 }),
        phone({ id: 't1', deviceType: 'touch', onHand: 3 }),
        phone({ id: 'i1', disposition: 'quantity', deviceType: null, onHand: 12 }),
        phone({ id: 'o1', disposition: 'one_off', deviceType: null, onHand: 1 }),
      ],
      company,
    );

    assert.deepEqual(sheet.keypad, { models: 2, pieces: 5 });
    assert.deepEqual(sheet.touch, { models: 1, pieces: 3 });
    assert.deepEqual(sheet.items, { models: 1, pieces: 12 });
    assert.equal(sheet.rows.length, 3, 'only phones are rows, not accessories');
    assert.equal(countSheetPieces(sheet), 20);
  });

  it('leaves a phone with no stated shelf out of both counts, not guessed into one', () => {
    const sheet = buildCountSheet([phone({ deviceType: null, onHand: 2 })], company);
    assert.deepEqual(sheet.unknown, { models: 1, pieces: 2 });
    assert.deepEqual(sheet.keypad, { models: 0, pieces: 0 });
    assert.deepEqual(sheet.touch, { models: 0, pieces: 0 });
    assert.equal(countSheetPieces(sheet), 2);
  });

  it('filters to one shelf without changing the pieces in it', () => {
    const sheet = buildCountSheet(
      [
        phone({ id: 'n1', deviceType: 'keypad', onHand: 4 }),
        phone({ id: 't1', deviceType: 'touch', onHand: 3 }),
      ],
      company,
    );
    assert.equal(filterCountRows(sheet.rows, 'keypad').length, 1);
    assert.equal(filterCountRows(sheet.rows, 'touch')[0]!.productId, 't1');
    assert.equal(filterCountRows(sheet.rows, 'all').length, 2);
    assert.equal(countScopePieces(sheet, 'keypad'), 4);
    assert.equal(countScopePieces(sheet, 'all'), 7);
  });
});

describe('the figures above «المخزن»', () => {
  it('measures the shelf at the wholesale price, and says so when no cost is in view', () => {
    const products = [
      phone({ id: 'a', onHand: 1, salePriceMinor: 900_000 }),
      phone({ id: 'b', onHand: 1 }),
      phone({ id: 'c', disposition: 'quantity', onHand: 5 }),
    ];

    const withCost = storeFigures({
      products,
      units: [{ unitCostMinor: 600_000 }, { unitCostMinor: 650_000 }],
    });
    // 6,000 + 6,500 — the device's sale price (9,000) has nothing to do with it.
    assert.equal(withCost.deviceValueMinor, 1_250_000);
    assert.equal(withCost.devicePieces, 2);
    assert.equal(withCost.itemPieces, 5);
    assert.equal(withCost.totalPieces, 7);
    assert.equal(withCost.itemsCount, 1);
    assert.equal(withCost.noPriceModels, 1, 'the phone with no price is the one counted');

    const withoutCost = storeFigures({ products, units: [{}, {}] });
    assert.equal(withoutCost.deviceValueMinor, null, 'no cost in view is not zero money');
  });
});

test('a phone the app itself registered is a device, not an accessory', () => {
  // The app writes phones as `quantity` + `serial_optional` (`catalog/phone.rs`);
  // the sale path accepts nothing else. Reading `disposition` alone filed them as
  // accessories, so «المخزن» said zero devices while the shelf was full.
  const appPhone: CountProductInput = {
    id: 'p-app',
    name: 'Samsung A16',
    disposition: 'quantity',
    tracking: 'serial_optional',
    deviceType: 'touch',
    brandId: 'b-samsung',
    onHand: 3,
    salePriceMinor: 700_000,
  };
  const sheet = buildCountSheet([appPhone], () => 'سامسونج');
  assert.deepEqual(sheet.touch, { models: 1, pieces: 3 });
  assert.deepEqual(sheet.items, { models: 0, pieces: 0 });
  assert.deepEqual(storeFigures({ products: [appPhone], units: [] }), {
    deviceValueMinor: null,
    devicePieces: 3,
    itemPieces: 0,
    totalPieces: 3,
    itemsCount: 0,
    noPriceModels: 0,
  });
});
