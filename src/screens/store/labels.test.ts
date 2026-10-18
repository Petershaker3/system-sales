import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTsplScript,
  buildUnitLabelSubtitle,
  ean13CheckDigit,
  encodeBarcode,
  encodeCode128Bars,
  encodeEan13Bars,
  expandLabelQueue,
  isInternalShopCode,
  isValidEan13,
  type LabelQueueItem,
  totalLabelsCount,
} from './labels.ts';

test('EAN-13 check digit, validation, and internal shop code detection work', () => {
  assert.equal(ean13CheckDigit('200000000001'), 5);
  assert.equal(isValidEan13('2000000000015'), true);
  assert.equal(isValidEan13('٢٠٠٠٠٠٠٠٠٠٠١٥'), true);
  assert.equal(isValidEan13('2000000000010'), false);
  assert.equal(isInternalShopCode('2000000000015'), true);
  assert.equal(isInternalShopCode('6221234567896'), false);
});

test('encodeEan13Bars produces exact 95-module GS1 bar pattern with guards', () => {
  const bars = encodeEan13Bars('2000000000015');
  assert.ok(bars !== null);
  assert.equal(bars.length, 95);
  assert.equal(bars.slice(0, 3), '101');
  assert.equal(bars.slice(45, 50), '01010');
  assert.equal(bars.slice(92, 95), '101');
  assert.equal(encodeEan13Bars('356938035643809'), null);
});

test('encodeBarcode selects ean13 for 13-digit EAN-13 and code128 for 15-digit IMEIs', () => {
  const ean = encodeBarcode('2000000000015');
  assert.equal(ean.kind, 'ean13');
  assert.equal(ean.totalModules, 95);
  assert.ok(ean.rects.length > 10);

  const imei = encodeBarcode('356938035643809');
  assert.equal(imei.kind, 'code128');
  // Start B (11) + 15 chars * 11 (165) + Checksum (11) + Stop (13) = 200 modules
  assert.equal(imei.totalModules, 200);
  assert.equal(encodeCode128Bars('356938035643809').length, 200);
});

test('buildTsplScript and queue helpers format EAN13 and Code-128 labels with copies', () => {
  const queue: LabelQueueItem[] = [
    {
      key: 'prod:p1',
      kind: 'product',
      productId: 'p1',
      name: 'جراب آيفون 16 شفاف',
      categoryLabel: 'جرابات',
      barcode: '2000000000015',
      salePriceMinor: 15000,
      onHand: 5,
      copies: 3,
    },
    {
      key: 'unit:u1',
      kind: 'unit',
      productId: 'p2',
      unitId: 'u1',
      name: 'Samsung Galaxy A54 128GB مستعمل فئة A',
      categoryLabel: 'مستعمل',
      barcode: '356938035643809',
      salePriceMinor: 1150000,
      onHand: 1,
      conditionGrade: 'A',
      batteryHealthPct: 91,
      color: 'أسود',
      copies: 1,
    },
  ];

  assert.equal(totalLabelsCount(queue), 4);
  assert.equal(expandLabelQueue(queue).length, 4);
  assert.equal(buildUnitLabelSubtitle(queue[1]!), 'فئة A · بطارية 91% · أسود');

  const tspl = buildTsplScript(
    queue,
    {
      size: '40x30',
      showShopName: true,
      showPrice: true,
      showUnitDetails: true,
    },
    'محل النور للموبايلات',
  );
  assert.ok(tspl.includes('SIZE 40 mm, 30 mm'));
  assert.ok(tspl.includes('BARCODE 24,96,"EAN13",56,1,0,2,2,"2000000000015"'));
  assert.ok(tspl.includes('PRINT 3,1'));
  assert.ok(tspl.includes('BARCODE 24,96,"128",56,1,0,2,2,"356938035643809"'));
  assert.ok(tspl.includes('فئة A · بطارية 91% · أسود'));
});
