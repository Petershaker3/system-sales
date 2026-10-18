import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReturnableSaleInspection, ReturnableSaleLine } from '../../api/sales.ts';
import {
  allocateDefaultRefundPayments,
  computeExchangeDifference,
  computePartialLineReturn,
  computeReturnSummaryPreview,
} from './returns.ts';

function makeLine(overrides: Partial<ReturnableSaleLine> = {}): ReturnableSaleLine {
  return {
    lineId: 'l-1',
    lineNo: 1,
    productId: 'p-1',
    productName: 'Anker Cable',
    quantity: 3,
    alreadyReturnedQty: 0,
    remainingQty: 3,
    unitSellingPriceMinor: 10_000,
    discountMinor: 1_000,
    lineTotalMinor: 29_000,
    unitCostMinor: 6_000,
    lineCostMinor: 18_000,
    warrantyStart: null,
    warrantyEnd: null,
    unitId: null,
    imei: null,
    ...overrides,
  };
}

test('computePartialLineReturn pro-rates partial return and preserves exact remainder on final return', () => {
  const line = makeLine();
  const r1 = computePartialLineReturn(line, 1, 'intact');
  assert.ok(r1);
  assert.equal(r1.quantity, 1);
  assert.equal(r1.discountMinor, 333);
  assert.equal(r1.lineTotalMinor, 9_667);
  assert.equal(r1.lineCostMinor, 6_000);

  const afterFirst = makeLine({
    alreadyReturnedQty: 1,
    remainingQty: 2,
  });
  const r2 = computePartialLineReturn(afterFirst, 2, 'damaged');
  assert.ok(r2);
  assert.equal(r1.discountMinor + r2.discountMinor, 1_000);
  assert.equal(r1.lineTotalMinor + r2.lineTotalMinor, 29_000);
  assert.equal(r1.lineCostMinor + r2.lineCostMinor, 18_000);
  assert.equal(r2.condition, 'damaged');
});

test('computeReturnSummaryPreview separates intact and damaged quantities and costs', () => {
  const l1 = makeLine({ lineId: 'l-1', quantity: 2, remainingQty: 2, discountMinor: 0, lineTotalMinor: 20_000, lineCostMinor: 12_000 });
  const l2 = makeLine({ lineId: 'l-2', quantity: 1, remainingQty: 1, unitSellingPriceMinor: 35_000, discountMinor: 0, lineTotalMinor: 35_000, lineCostMinor: 22_000 });
  const inspection: ReturnableSaleInspection = {
    saleId: 's-1',
    reference: '20261018-0001',
    occurredAt: 1_000,
    soldBy: 'u-1',
    customerId: null,
    customerName: null,
    customerPhone: null,
    totalMinor: 50_000, // 5,000 invoice discount off 55,000
    discountMinor: 5_000,
    alreadyRefundedMinor: 0,
    remainingRefundableMinor: 50_000,
    isCancelled: false,
    lines: [l1, l2],
    payments: [
      {
        method: 'cash',
        amountMinor: 50_000,
        reference: null,
        alreadyRefundedMinor: 0,
        remainingMinor: 50_000,
      },
    ],
    returns: [],
  };

  const summary = computeReturnSummaryPreview(inspection, {
    'l-1': { quantity: 1, condition: 'damaged' },
    'l-2': { quantity: 1, condition: 'intact' },
  });

  assert.equal(summary.totalQty, 2);
  assert.equal(summary.intactQty, 1);
  assert.equal(summary.damagedQty, 1);
  assert.equal(summary.intactCostMinor, 22_000);
  assert.equal(summary.damagedCostMinor, 6_000);
  assert.equal(summary.linesNetMinor, 45_000);
  assert.ok(summary.refundMinor > 0 && summary.refundMinor < 45_000);
});

test('allocateDefaultRefundPayments and computeExchangeDifference handle split payments and exchange directions', () => {
  const alloc = allocateDefaultRefundPayments(
    [
      { method: 'cash', amountMinor: 10_000, reference: null, alreadyRefundedMinor: 0, remainingMinor: 10_000 },
      { method: 'vf', amountMinor: 20_000, reference: 'VF-1', alreadyRefundedMinor: 0, remainingMinor: 20_000 },
    ],
    18_000
  );
  assert.equal(alloc.length, 2);
  assert.equal(alloc[0]?.method, 'cash');
  assert.equal(alloc[0]?.amountMinor, 10_000);
  assert.equal(alloc[1]?.method, 'vf');
  assert.equal(alloc[1]?.amountMinor, 8_000);

  const pays = computeExchangeDifference(20_000, 35_000);
  assert.equal(pays.direction, 'customer_pays');
  assert.equal(pays.absDifferenceMinor, 15_000);

  const receives = computeExchangeDifference(35_000, 20_000);
  assert.equal(receives.direction, 'customer_receives');
  assert.equal(receives.absDifferenceMinor, 15_000);

  const even = computeExchangeDifference(20_000, 20_000);
  assert.equal(even.direction, 'even');
  assert.equal(even.absDifferenceMinor, 0);
});
