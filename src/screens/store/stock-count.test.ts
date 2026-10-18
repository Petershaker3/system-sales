import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildReconcilePayload,
  computeStockCountSummary,
  createStockCountRows,
  markAllRowsMatched,
  resolveScanInput,
  setRowCountedQty,
  toggleUnitScanned,
} from './stock-count.ts';

const SAMPLE_PRODUCTS = [
  {
    id: 'p-phone',
    name: 'Samsung Galaxy A54 128GB مستعمل فئة A',
    categoryId: 'cat-used',
    categoryLabel: 'مستعمل',
    barcode: null,
    isSerialized: true,
    onHand: 2,
  },
  {
    id: 'p-charger',
    name: 'شاحن سامسونج 25 وات أصلي',
    categoryId: 'cat-acc',
    categoryLabel: 'شواحن',
    barcode: '8806090000011',
    isSerialized: false,
    onHand: 5,
  },
] as const;

const SAMPLE_UNITS = [
  {
    id: 'u-1',
    productId: 'p-phone',
    imei: '352099001761481',
    imei2: null,
    color: 'أسود',
    conditionGrade: 'A',
    batteryHealthPct: 92,
    unitCostMinor: 900_000,
  },
  {
    id: 'u-2',
    productId: 'p-phone',
    imei: '864219042345679',
    imei2: null,
    color: 'أبيض',
    conditionGrade: 'A',
    batteryHealthPct: 89,
    unitCostMinor: 850_000,
  },
] as const;

test('createStockCountRows starts IMEI units unscanned to reveal missing IMEIs', () => {
  const rows = createStockCountRows(SAMPLE_PRODUCTS, SAMPLE_UNITS);
  assert.equal(rows.length, 2);

  const phoneRow = rows[0]!;
  assert.equal(phoneRow.expectedQty, 2);
  assert.equal(phoneRow.countedQty, 0);
  assert.equal(phoneRow.units.length, 2);

  const summary = computeStockCountSummary(rows);
  assert.equal(summary.totalUnits, 2);
  assert.equal(summary.scannedUnits, 0);
  assert.equal(summary.missingUnits.length, 2);
  assert.equal(summary.shortageQtyTotal, 2);
});

test('resolveScanInput matches 15-digit IMEI, prevents duplicate scan, and leaves remaining IMEI missing', () => {
  let rows = createStockCountRows(SAMPLE_PRODUCTS, SAMPLE_UNITS);

  // Scan first IMEI (with Arabic digits to verify normalization)
  const res1 = resolveScanInput(rows, '٣٥٢٠٩٩٠٠١٧٦١٤٨١');
  assert.equal(res1.kind, 'matched_imei');
  if (res1.kind === 'matched_imei') {
    rows = [...res1.nextRows];
  }

  // Duplicate scan of the same IMEI is detected
  const resDup = resolveScanInput(rows, '352099001761481');
  assert.equal(resDup.kind, 'duplicate_imei');

  // Unknown 15-digit IMEI is flagged
  const resUnknown = resolveScanInput(rows, '490154203237518');
  assert.equal(resUnknown.kind, 'unknown_imei');

  const summary = computeStockCountSummary(rows);
  assert.equal(summary.scannedUnits, 1);
  assert.equal(summary.missingUnits.length, 1);
  assert.equal(summary.missingUnits[0]?.id, 'u-2');
  assert.equal(summary.missingUnits[0]?.imei, '864219042345679');

  const payload = buildReconcilePayload(rows);
  assert.equal(payload.length, 1);
  assert.deepEqual(payload[0], {
    productId: 'p-phone',
    countedQuantity: 1,
    missingUnitIds: ['u-2'],
  });
});

test('resolveScanInput increments counted items on barcode scan and markAllRowsMatched clears discrepancies', () => {
  let rows = createStockCountRows(SAMPLE_PRODUCTS, SAMPLE_UNITS);

  // First barcode scan on untouched counted item sets countedQty to 1, second scan to 2
  const scan1 = resolveScanInput(rows, '8806090000011');
  assert.equal(scan1.kind, 'matched_barcode');
  if (scan1.kind === 'matched_barcode') {
    assert.equal(scan1.row.countedQty, 1);
    rows = [...scan1.nextRows];
  }
  const scan2 = resolveScanInput(rows, '8806090000011');
  if (scan2.kind === 'matched_barcode') {
    assert.equal(scan2.row.countedQty, 2);
    rows = [...scan2.nextRows];
  }

  // Toggle second phone unit scanned and set charger count to 6 (surplus +1)
  rows = toggleUnitScanned(rows, 'u-1', true);
  rows = toggleUnitScanned(rows, 'u-2', true);
  rows = setRowCountedQty(rows, 'p-charger', 6);

  const summary = computeStockCountSummary(rows);
  assert.equal(summary.missingUnits.length, 0);
  assert.equal(summary.surplusQtyTotal, 1);
  assert.equal(summary.shortageQtyTotal, 0);

  // Mark all matched clears all discrepancies
  const matched = markAllRowsMatched(rows);
  assert.equal(buildReconcilePayload(matched).length, 0);
});
