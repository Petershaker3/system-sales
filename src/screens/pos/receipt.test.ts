import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildWhatsAppUrl,
  defaultInvoiceReceiptMode,
  effectiveReceiptSetting,
  formatWhatsAppMessage,
  isValidEgyptianPhone,
  normalizeEgyptianPhone,
  receiptModeDoneLabel,
  receiptModeOptions,
} from './receipt.ts';

test('normalizeEgyptianPhone accepts valid 11-digit Egyptian numbers and Arabic digits', () => {
  assert.equal(normalizeEgyptianPhone('01012345678'), '01012345678');
  assert.equal(normalizeEgyptianPhone('٠١١٢٢٣٣٤٤٥٥'), '01122334455');
  assert.equal(normalizeEgyptianPhone('+20 122 334 4556'), '01223344556');
  assert.equal(normalizeEgyptianPhone('00201551234567'), '01551234567');
  assert.equal(normalizeEgyptianPhone('0101234'), '');
  assert.equal(normalizeEgyptianPhone('0223456789'), '');
  assert.equal(normalizeEgyptianPhone(null), '');
  assert.equal(isValidEgyptianPhone('01099887766'), true);
  assert.equal(isValidEgyptianPhone('12345'), false);
});

test('receiptModeOptions and defaultInvoiceReceiptMode follow PLAN.md §10 rules', () => {
  assert.deepEqual(receiptModeOptions('off'), [
    ['wa', 'واتساب'],
    ['none', 'بدون'],
  ]);
  assert.deepEqual(receiptModeOptions('on'), [
    ['print', 'طباعة'],
    ['wa', 'واتساب'],
    ['both', 'الاتنين'],
    ['none', 'بدون'],
  ]);

  assert.equal(effectiveReceiptSetting('print', 'off'), 'wa');
  assert.equal(effectiveReceiptSetting('both', 'off'), 'wa');
  assert.equal(effectiveReceiptSetting('none', 'off'), 'none');
  assert.equal(effectiveReceiptSetting('both', 'on'), 'both');

  // Walk-in customer (no phone) defaults to 'none' when printer is off, or 'print' when printer is on.
  assert.equal(defaultInvoiceReceiptMode('wa', 'off', null), 'none');
  assert.equal(defaultInvoiceReceiptMode('wa', 'on', null), 'print');
  // Customer with a valid phone defaults to 'wa' (or 'both' if configured).
  assert.equal(defaultInvoiceReceiptMode('wa', 'off', '01099887766'), 'wa');
  assert.equal(defaultInvoiceReceiptMode('both', 'on', '01099887766'), 'both');
});

test('formatWhatsAppMessage and buildWhatsAppUrl substitute placeholders and build wa.me link', () => {
  const msg = formatWhatsAppMessage(
    'أهلاً {الاسم}، دي فاتورتك رقم {رقم} من {المحل} بمبلغ {الإجمالي}. الضمان لحد {تاريخ_الضمان}.',
    {
      customerName: 'أحمد سمير',
      reference: '20261018-0005',
      shopName: 'سنتر بيتر',
      totalMinor: 925_000,
      warrantyDate: '18 أكتوبر 2027',
    }
  );
  assert.equal(
    msg,
    'أهلاً أحمد سمير، دي فاتورتك رقم 20261018-0005 من سنتر بيتر بمبلغ 9,250 ج.م. الضمان لحد 18 أكتوبر 2027.'
  );

  const msgWithClause = formatWhatsAppMessage(
    'أهلاً {الاسم}، فاتورة {رقم} من {المحل} بمبلغ {الإجمالي}.{الضمان}',
    {
      customerName: null,
      reference: '20261018-0006',
      shopName: 'سنتر بيتر',
      totalMinor: 8_000,
      warrantyDate: '2027/10/18',
    }
  );
  assert.equal(
    msgWithClause,
    'أهلاً عميلنا العزيز، فاتورة 20261018-0006 من سنتر بيتر بمبلغ 80 ج.م. الضمان ساري لحد 2027/10/18.'
  );

  const url = buildWhatsAppUrl('01099887766', msg);
  assert.ok(url.startsWith('https://wa.me/201099887766?text='));
  assert.ok(decodeURIComponent(url.split('?text=')[1] ?? '').includes('سنتر بيتر'));
  assert.equal(
    receiptModeDoneLabel('wa'),
    'واتساب جاهز',
    'the app opens the chat; WhatsApp does the sending, so the label says «جاهز»'
  );
  assert.equal(receiptModeDoneLabel('none'), 'من غير إيصال');
});
