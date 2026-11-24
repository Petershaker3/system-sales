import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampWarrantyMonths,
  defaultWarrantyMonthsForKind,
  toIsoCalendarDate,
  warrantyDatesForMonths,
} from './warranty.ts';

test('defaultWarrantyMonthsForKind resolves new phone, used phone, and item defaults from Settings', () => {
  const settings = {
    warrantyNew: '12',
    warrantyUsed: '3',
    warrantyItem: '0',
  };
  assert.equal(defaultWarrantyMonthsForKind('phone', settings), 12);
  assert.equal(defaultWarrantyMonthsForKind('used', settings), 3);
  assert.equal(defaultWarrantyMonthsForKind('item', settings), 0);

  // Arabic digits and boundary checks
  assert.equal(clampWarrantyMonths('٦', 0), 6);
  assert.equal(clampWarrantyMonths('99', 1), 1);
  assert.equal(clampWarrantyMonths('-2', 12), 12);
});

test('warrantyDatesForMonths computes YYYY-MM-DD start and end dates or omits when 0', () => {
  const saleDay = new Date(2026, 9, 18, 15, 0); // 2026-10-18
  assert.equal(toIsoCalendarDate(saleDay), '2026-10-18');

  assert.deepEqual(warrantyDatesForMonths(0, saleDay), {});
  assert.deepEqual(warrantyDatesForMonths(12, saleDay), {
    warrantyStart: '2026-10-18',
    warrantyEnd: '2027-10-18',
  });
  assert.deepEqual(warrantyDatesForMonths(1, saleDay), {
    warrantyStart: '2026-10-18',
    warrantyEnd: '2026-11-18',
  });
  assert.deepEqual(warrantyDatesForMonths(3, saleDay), {
    warrantyStart: '2026-10-18',
    warrantyEnd: '2027-01-18',
  });
});
