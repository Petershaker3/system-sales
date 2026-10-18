import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ShiftSummary } from '../../api/shift.ts';
import {
  DEFAULT_EXPENSE_CATEGORIES,
  denomTotalMinor,
  EGYPTIAN_DENOMS,
  formatShiftWhatsAppReport,
  shiftDifferenceState,
} from './shift.ts';

test('denomTotalMinor sums Egyptian banknotes and 0.5 EGP coins into piastres', () => {
  assert.deepEqual(EGYPTIAN_DENOMS, [200, 100, 50, 20, 10, 5, 1, 0.5]);
  assert.equal(DEFAULT_EXPENSE_CATEGORIES.length, 6);

  const totalMinor = denomTotalMinor({
    '200': 5, // 1,000 EGP
    '100': 3, // 300 EGP
    '50': 2, // 100 EGP
    '20': 1, // 20 EGP
    '10': 2, // 20 EGP
    '5': 1, // 5 EGP
    '1': 4, // 4 EGP
    '0.5': 2, // 1 EGP
  });
  // Total = 1,450 EGP = 145,000 piastres
  assert.equal(totalMinor, 145_000);
});

test('shiftDifferenceState classifies exact, shortage, and overage', () => {
  const exact = shiftDifferenceState(0);
  assert.equal(exact.state, 'exact');
  assert.match(exact.label, /مظبوط/);

  const shortage = shiftDifferenceState(-2_500);
  assert.equal(shortage.state, 'shortage');
  assert.match(shortage.label, /عجز/);

  const overage = shiftDifferenceState(1_500);
  assert.equal(overage.state, 'overage');
  assert.match(overage.label, /زيادة/);
});

test('formatShiftWhatsAppReport includes drawer math, non-cash sales, and close note', () => {
  const summary: ShiftSummary = {
    shift: {
      id: 'shift-1',
      shiftNumber: 1,
      status: 'open',
      openingCashMinor: 100_000,
      expectedCashMinor: null,
      countedCashMinor: null,
      differenceMinor: null,
      closeNote: null,
      openedBy: 'u-1',
      openedAt: 1_760_000_000_000,
      closedBy: null,
      closedAt: null,
    },
    totals: {
      openingCashMinor: 100_000,
      cashSalesMinor: 250_000,
      vfSalesMinor: 40_000,
      instapaySalesMinor: 60_000,
      cardSalesMinor: 0,
      installSalesMinor: 0,
      creditSalesMinor: 50_000,
      salesTotalMinor: 400_000,
      salesCostMinor: 300_000,
      salesCount: 4,
      customerCashInMinor: 20_000,
      servicesCount: 0,
      servicesFeeMinor: 0,
      servicesCashInMinor: 0,
      servicesCashOutMinor: 0,
      walletDrawerNetMinor: 0,
      cashInMinor: 10_000,
      ownerDrawMinor: 30_000,
      expensesMinor: 5_000,
      expectedCashMinor: 345_000,
      grossProfitMinor: 100_000,
      netProfitMinor: 95_000,
    },
    expenses: [],
    cashMovements: [],
  };

  const report = formatShiftWhatsAppReport(summary, 'موبايل ستور', 345_000, 'الدرج مظبوط تمام');
  assert.match(report, /تقرير تقفيل الوردية #1/);
  assert.match(report, /المتوقع في الدرج/);
  assert.match(report, /المعدود الفعلي/);
  assert.match(report, /مظبوط/);
  assert.match(report, /فودافون كاش/);
  assert.match(report, /إنستاباي/);
  assert.match(report, /الدرج مظبوط تمام/);
});
