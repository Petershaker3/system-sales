import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultMinQty,
  formatArrivedToast,
  parseWaitingCustomer,
  suggestedQty,
} from './shortages.ts';

test('defaultMinQty and suggestedQty match the mockup rules (2×min − stock, at least 1)', () => {
  assert.equal(defaultMinQty(false, 'item'), 5);
  assert.equal(defaultMinQty(true, 'phone'), 2);
  assert.equal(defaultMinQty(true, 'used'), 1);

  assert.equal(suggestedQty(0, 5), 10);
  assert.equal(suggestedQty(3, 5), 7);
  assert.equal(suggestedQty(5, 5), 5);
  assert.equal(suggestedQty(1, 2), 3);
  assert.equal(suggestedQty(10, 5), 1);
});

test('parseWaitingCustomer extracts name and phone when 8+ digits are typed', () => {
  assert.deepEqual(parseWaitingCustomer(''), {
    customerName: null,
    customerPhone: null,
  });
  assert.deepEqual(parseWaitingCustomer('كريم مصطفى 01011122233'), {
    customerName: 'كريم مصطفى',
    customerPhone: '01011122233',
  });
  assert.deepEqual(parseWaitingCustomer('٠١٠١١١٢٢٢٣٣'), {
    customerName: null,
    customerPhone: '01011122233',
  });
  assert.deepEqual(parseWaitingCustomer('أحمد محمود'), {
    customerName: 'أحمد محمود',
    customerPhone: null,
  });
});

test('formatArrivedToast mentions waiting customer and phone when present', () => {
  assert.equal(
    formatArrivedToast({
      name: 'شاحن 65 وات تايب سي',
      customerName: 'كريم مصطفى',
      customerPhone: '01011122233',
    }),
    '«شاحن 65 وات تايب سي» وصل، وكريم مصطفى مستنيه: 01011122233'
  );
  assert.equal(
    formatArrivedToast({
      name: 'كابل لايتنينج للآيفون',
      customerName: null,
      customerPhone: null,
    }),
    '«كابل لايتنينج للآيفون» وصل واتشال من النواقص'
  );
});
