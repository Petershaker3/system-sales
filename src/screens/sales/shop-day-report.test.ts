// The shop's day and the shop's money, as the reports must read them (audit 2026-11-02).
//
// Two rules are pinned here:
//  1. A filtered report may not drop the invoice's own discount. Line totals carry only
//     the line discount, so summing them under a filter used to read higher than the
//     same sale unfiltered — the shop's money changing with a filter.
//  2. A day is the owner's day (`ui.day_start`), not the calendar's, on *every* screen:
//     the day bar chart, the shortages line, and the expenses window.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { SaleHistoryEntry } from '../../api/sales.ts';
import {
  asRows,
  byCategory,
  byDay,
  byProduct,
  filterSalesRows,
  isoDay,
  rowAmountMinor,
  rowProfitMinor,
  setBusinessDayStartHour,
  totalsOf,
} from './analytics.ts';
import { expensePeriodBounds } from '../expenses/expenses.ts';
import { formatShortageWhen } from '../store/shortages.ts';

afterEach(() => setBusinessDayStartHour(0));

/** A sale of two accessories, 500.00 total before the invoice discount of 50.00. */
function twoLineSale(): SaleHistoryEntry {
  return {
    saleId: 's-1',
    reference: 'INV-20261102-0001',
    occurredAt: new Date(2026, 10, 2, 14, 0).getTime(),
    soldBy: 'u-peter',
    sellerName: 'بيتر',
    customerId: null,
    customerName: null,
    customerPhone: null,
    // lines: 200.00 + 300.00 = 500.00; the invoice takes 50.00 off → 450.00
    linesSubtotalMinor: 50_000,
    discountMinor: 5_000,
    totalMinor: 45_000,
    costTotalMinor: 30_000,
    profitMinor: 15_000,
    alreadyRefundedMinor: 0,
    isCancelled: false,
    lines: [
      {
        lineId: 'l-1',
        lineNo: 1,
        productId: 'p-cable',
        productName: 'كابل تايب سي 1 متر',
        categoryId: 'c-cables',
        categoryName: 'كابلات وشواحن',
        parentCategoryId: 'c-acc',
        quantity: 2,
        unitSellingPriceMinor: 10_000,
        discountMinor: 0,
        lineTotalMinor: 20_000,
        unitCostMinor: 6_000,
        lineCostMinor: 12_000,
        lineProfitMinor: 8_000,
        warrantyStart: null,
        warrantyEnd: null,
        unitId: null,
        imei: null,
      },
      {
        lineId: 'l-2',
        lineNo: 2,
        productId: 'p-charger',
        productName: 'شاحن 25 وات',
        categoryId: 'c-chargers',
        categoryName: 'شواحن',
        parentCategoryId: 'c-acc',
        quantity: 1,
        unitSellingPriceMinor: 30_000,
        discountMinor: 0,
        lineTotalMinor: 30_000,
        unitCostMinor: 18_000,
        lineCostMinor: 18_000,
        lineProfitMinor: 12_000,
        warrantyStart: null,
        warrantyEnd: null,
        unitId: null,
        imei: null,
      },
    ],
    payments: [{ method: 'cash', amountMinor: 45_000, reference: null }],
  };
}

function rowsFor(cat: string) {
  const d = new Date(2026, 10, 2);
  return filterSalesRows(
    [twoLineSale()],
    d,
    d,
    { q: '', cat, seller: '', method: '' },
    { isOwner: true, userId: 'u-peter' },
  );
}

describe('a filtered report keeps the invoice discount (audit 2026-11-02)', () => {
  it('reads the whole invoice the same whether or not a filter is on', () => {
    const whole = totalsOf(asRows([twoLineSale()]));
    assert.equal(whole.salesMinor, 45_000);
    assert.equal(whole.profitMinor, 15_000);

    // «إكسسوارات» matches both lines, so nothing is hidden and nothing changes.
    const both = totalsOf(rowsFor('c-acc'));
    assert.equal(both.salesMinor, 45_000);
    assert.equal(both.profitMinor, 15_000);
  });

  it('takes each visible line’s share of the invoice discount, and the shares add up', () => {
    const cable = rowsFor('c-cables');
    assert.equal(cable.length, 1);
    assert.equal(cable[0]!.lineLevel, true);
    // The cable line is 200.00 of 500.00 → 20.00 of the 50.00 discount.
    assert.equal(rowAmountMinor(cable[0]!), 20_000 - 2_000);
    assert.equal(rowProfitMinor(cable[0]!), 8_000 - 2_000);

    const charger = rowsFor('c-chargers');
    assert.equal(rowAmountMinor(charger[0]!), 30_000 - 3_000);
    assert.equal(rowProfitMinor(charger[0]!), 12_000 - 3_000);

    // 180.00 + 270.00 = 450.00 and 60.00 + 90.00 = 150.00: the parts add back up.
    assert.equal(rowAmountMinor(cable[0]!) + rowAmountMinor(charger[0]!), 45_000);
    assert.equal(rowProfitMinor(cable[0]!) + rowProfitMinor(charger[0]!), 15_000);
  });

  it('a table of what sold adds up to the total above it', () => {
    const rows = asRows([twoLineSale()]);
    const prods = byProduct(rows);
    assert.equal(
      prods.reduce((a, p) => a + p.salesMinor, 0),
      45_000,
    );
    assert.equal(
      prods.reduce((a, p) => a + p.profitMinor, 0),
      15_000,
    );

    const cats = byCategory(rows, () => '');
    assert.equal(
      cats.reduce((a, c) => a + c.salesMinor, 0),
      45_000,
    );
    // The parent row and its categories must agree with each other too.
    const acc = cats.find((c) => c.id === 'c-acc');
    assert.ok(acc);
    assert.equal(
      acc.subs.reduce((a, sub) => a + sub.salesMinor, 0),
      acc.salesMinor,
    );
  });

  it('never takes more discount than the line is worth', () => {
    const sale = twoLineSale();
    const rows = filterSalesRows(
      [sale],
      new Date(2026, 10, 2),
      new Date(2026, 10, 2),
      { q: '', cat: 'c-cables', seller: '', method: '' },
      { isOwner: true, userId: 'u-peter' },
    );
    const row = rows[0]!;
    const huge: typeof row = {
      ...row,
      x: { ...row.x, linesSubtotalMinor: 50_000, totalMinor: 0 },
    };
    // The whole 500.00 is discounted away; the visible 200.00 line cannot go below zero.
    assert.equal(rowAmountMinor(huge), 0);
  });
});

describe('the day is the shop’s day on every screen (audit 2026-11-02)', () => {
  it('bars a 1:30 AM sale into the day that is ending', () => {
    setBusinessDayStartHour(5);
    const sale: SaleHistoryEntry = {
      ...twoLineSale(),
      saleId: 's-night',
      occurredAt: new Date(2026, 10, 2, 1, 30).getTime(),
      linesSubtotalMinor: 20_000,
      discountMinor: 0,
      totalMinor: 20_000,
      costTotalMinor: 12_000,
      profitMinor: 8_000,
    };
    const from = new Date(2026, 10, 1);
    const to = new Date(2026, 10, 2);
    const days = byDay(asRows([sale]), from, to);
    assert.equal(days.length, 2);
    assert.equal(days[0]!.salesMinor, 20_000, 'belongs to 1 November, not 2 November');
    assert.equal(days[1]!.salesMinor, 0);
    // …and the same 20,000 is what the headline above the bars says.
    assert.equal(totalsOf(asRows([sale])).salesMinor, 20_000);
  });

  it('says «النهارده» for a shortage added at 1 AM, and «امبارح» for one from the day before', () => {
    setBusinessDayStartHour(5);
    const now = new Date(2026, 10, 2, 1, 30);
    assert.match(formatShortageWhen(new Date(2026, 10, 2, 0, 40).getTime(), now), /^النهارده/);
    assert.match(formatShortageWhen(new Date(2026, 10, 1, 23, 0).getTime(), now), /^النهارده/);
    assert.match(formatShortageWhen(new Date(2026, 10, 1, 3, 0).getTime(), now), /^امبارح/);
  });

  it('opens «النهارده» in المصاريف where the till opened, not at midnight', () => {
    setBusinessDayStartHour(5);
    const nowMs = new Date(2026, 10, 2, 1, 30).getTime();
    const today = expensePeriodBounds('today', nowMs);
    assert.equal(today.fromMs, new Date(2026, 10, 1, 5, 0).getTime());
    assert.equal(today.toMs, new Date(2026, 10, 2, 5, 0).getTime() - 1);

    const yesterday = expensePeriodBounds('yesterday', nowMs);
    assert.equal(yesterday.fromMs, new Date(2026, 9, 31, 5, 0).getTime());
    assert.equal(yesterday.toMs, new Date(2026, 10, 1, 5, 0).getTime() - 1);

    // An expense booked at 00:40 belongs to «النهارده» and must be inside the window.
    const at0040 = new Date(2026, 10, 2, 0, 40).getTime();
    assert.ok(at0040 >= today.fromMs! && at0040 <= today.toMs!);
  });

  it('opens «الشهر ده» on 1 November at 05:00, not on 31 October', () => {
    setBusinessDayStartHour(5);
    const bounds = expensePeriodBounds('month', new Date(2026, 10, 2, 12, 0).getTime());
    assert.equal(bounds.fromMs, new Date(2026, 10, 1, 5, 0).getTime());
    assert.equal(isoDay(new Date(bounds.fromMs!)), '2026-11-01');
  });
});
