// The delivery form's rules (`0035`), tested without a browser.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  deliveryFormProblem,
  imeiCountProblem,
  noteProblem,
  parsePieces,
  piecesProblem,
  purchaseDateProblem,
  referenceProblem,
} from './receiving.ts';

const base = {
  existingProduct: true,
  hasProduct: true,
  creating: false,
  quantity: '2',
  unitCost: '7000',
  purchaseDate: '',
  reference: '',
  note: '',
  imeiCount: 0,
  imeiRequired: false,
  serial: true,
};

test('a quantity is a whole number of pieces, never a rounded one', () => {
  assert.equal(parsePieces('3'), 3);
  assert.equal(parsePieces('٣'), null);
  assert.equal(parsePieces('2.5'), null);
  assert.equal(parsePieces('-1'), null);
  assert.equal(parsePieces(''), null);
  assert.equal(piecesProblem('0'), 'الكمية لازم تكون قطعة واحدة على الأقل.');
  assert.equal(piecesProblem('3'), '');
});

test('a purchase day has to exist, not just look like a date', () => {
  assert.equal(purchaseDateProblem(''), '', 'no paper means no day, and that is allowed');
  assert.equal(purchaseDateProblem('2026-11-05'), '');
  assert.equal(purchaseDateProblem('2026-02-31'), 'اليوم ده مش موجود في الشهر ده.');
  assert.equal(purchaseDateProblem('2026-13-01'), 'الشهر لازم يكون من 1 لـ 12.');
  assert.equal(purchaseDateProblem('11/05/2026'), 'التاريخ بالشكل ده: 2026-11-05.');
  assert.equal(purchaseDateProblem('2024-02-29'), '', 'a leap day is a real day');
  assert.equal(purchaseDateProblem('2025-02-29'), 'اليوم ده مش موجود في الشهر ده.');
});

test('the supplier reference has the ledger column’s limit', () => {
  assert.equal(referenceProblem(''), '');
  assert.equal(referenceProblem('  442/2026  '), '');
  assert.equal(referenceProblem('x'.repeat(60)), '');
  assert.equal(referenceProblem('x'.repeat(61)), 'رقم الفاتورة أطول من 60 حرف.');
});

test('the note has the ledger column’s limit', () => {
  assert.equal(noteProblem(''), '');
  assert.equal(noteProblem('x'.repeat(300)), '');
  assert.equal(noteProblem('x'.repeat(301)), 'الملاحظة أطول من 300 حرف.');
});

test('IMEIs are optional, but a count that cannot be true is refused', () => {
  // The shop's rule: a phone may arrive without its serial and get it later.
  assert.equal(imeiCountProblem(0, 5, false), '');
  assert.equal(imeiCountProblem(2, 5, false), '');
  assert.equal(imeiCountProblem(5, 5, false), '');
  assert.equal(imeiCountProblem(6, 5, false), 'عدد أرقام الـ IMEI أكبر من الكمية.');
  // ...unless the shop asked for every piece to carry one.
  assert.equal(imeiCountProblem(4, 5, true), 'وضع الـ IMEI إلزامي: سجّل 5 رقم IMEI قبل الحفظ.');
  assert.equal(imeiCountProblem(5, 5, true), '');
});

test('a delivery with no cost typed is refused before anything is written', () => {
  assert.equal(deliveryFormProblem({ ...base, unitCost: '' }), 'اكتب سعر الوحدة.');
  assert.equal(
    deliveryFormProblem({ ...base, unitCost: 'ألف' }),
    'سعر الوحدة لازم يكون رقم، مثال: 40 أو 40.50.'
  );
  // A cost of zero is a real cost — a gift, a sample, a write-off.
  assert.equal(deliveryFormProblem({ ...base, unitCost: '0' }), '');
});

test('an existing product must be chosen, and a new one must be describable', () => {
  assert.equal(deliveryFormProblem({ ...base, hasProduct: false }), 'اختار الصنف الأول.');
  assert.equal(
    deliveryFormProblem({
      ...base,
      existingProduct: false,
      hasProduct: false,
      creating: true,
      newNameProblem: 'اكتب اسم الصنف.',
    }),
    'اكتب اسم الصنف.'
  );
  assert.equal(deliveryFormProblem({ ...base, existingProduct: false, hasProduct: false }), 'اختار الصنف الأول.');
});

test('the form is read in the order it is filled, one message at a time', () => {
  const why = deliveryFormProblem({
    ...base,
    quantity: '0',
    purchaseDate: '2026-02-31',
    reference: 'x'.repeat(61),
    note: 'x'.repeat(301),
  });
  assert.equal(why, 'الكمية لازم تكون قطعة واحدة على الأقل.');
});

test('the whole form passes for an ordinary delivery with no paper', () => {
  assert.equal(deliveryFormProblem(base), '');
  assert.equal(
    deliveryFormProblem({
      ...base,
      purchaseDate: '2026-11-01',
      reference: 'INV-9001',
      note: 'شحنة أول الشهر',
      imeiCount: 2,
    }),
    ''
  );
});
