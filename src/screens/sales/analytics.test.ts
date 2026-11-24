// Unit tests for pure sales history & period analytics (`ADR-029`, Plan item 1.14).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SaleHistoryEntry } from '../../api/sales.ts';
import {
  asRows,
  byCategory,
  byDay,
  byMonth,
  byProduct,
  chgFormat,
  comparePeriod,
  dayStart,
  daysIn,
  extractInvoiceDigits,
  filterSalesRows,
  inRange,
  isoDay,
  kShortMinor,
  monthReport,
  monthStart,
  moreItemsLabel,
  nMonthsLabel,
  parseIsoDay,
  paymentSummaryLabel,
  paySplit,
  pct,
  prevPeriod,
  rateDay,
  rateMonthVerdict,
  todayReport,
  totalsOf,
  yearAgo,
} from './analytics.ts';

function makeSale(overrides: Partial<SaleHistoryEntry> = {}): SaleHistoryEntry {
  return {
    saleId: overrides.saleId ?? 's-1',
    reference: overrides.reference ?? 'INV-20261018-0001',
    occurredAt: overrides.occurredAt ?? new Date(2026, 9, 18, 14, 30).getTime(),
    soldBy: overrides.soldBy ?? 'u-peter',
    sellerName: overrides.sellerName ?? 'بيتر',
    customerId: overrides.customerId ?? null,
    customerName: overrides.customerName ?? null,
    customerPhone: overrides.customerPhone ?? null,
    linesSubtotalMinor: overrides.linesSubtotalMinor ?? 20_000,
    discountMinor: overrides.discountMinor ?? 0,
    totalMinor: overrides.totalMinor ?? 20_000,
    costTotalMinor: overrides.costTotalMinor ?? 12_000,
    profitMinor: overrides.profitMinor ?? 8_000,
    alreadyRefundedMinor: overrides.alreadyRefundedMinor ?? 0,
    isCancelled: overrides.isCancelled ?? false,
    lines: overrides.lines ?? [
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
    ],
    payments: overrides.payments ?? [
      { method: 'cash', amountMinor: 20_000, reference: null },
    ],
  };
}

describe('Sales analytics (Plan 1.14 / ADR-029)', () => {
  it('computes inclusive date ranges, previous periods, and live same-hour comparison', () => {
    const d16 = new Date(2026, 9, 16);
    const d15 = new Date(2026, 9, 15);
    const pp1 = prevPeriod(d16, d16);
    assert.equal(isoDay(pp1.from), isoDay(d15));
    assert.equal(isoDay(pp1.to), isoDay(d15));

    const pp7 = prevPeriod(new Date(2026, 9, 10), d16);
    assert.equal(isoDay(pp7.from), '2026-10-03');
    assert.equal(isoDay(pp7.to), '2026-10-09');

    const ppMtd = prevPeriod(new Date(2026, 9, 1), d16, true);
    assert.equal(isoDay(ppMtd.from), '2026-09-01');
    assert.equal(isoDay(ppMtd.to), '2026-09-16');
    assert.equal(ppMtd.partial, true);

    const ppMar = prevPeriod(new Date(2026, 2, 1), new Date(2026, 2, 31), true);
    assert.equal(isoDay(ppMar.from), '2026-02-01');
    assert.equal(isoDay(ppMar.to), '2026-02-28');

    const nowAt2030 = new Date(2026, 9, 16, 20, 30, 0, 0);
    const cpLive = comparePeriod(new Date(2026, 9, 1), d16, true, nowAt2030);
    assert.equal(cpLive.live, true);
    assert.equal(cpLive.end.getTime(), new Date(2026, 8, 16, 20, 30, 0, 0).getTime());
  });

  it('aggregates totals, days, products, categories, and months accurately', () => {
    const s1 = makeSale({
      saleId: 's-1',
      reference: 'INV-20261017-0001',
      occurredAt: new Date(2026, 9, 17, 11, 0).getTime(),
      totalMinor: 20_000,
      costTotalMinor: 12_000,
      profitMinor: 8_000,
    });
    const s2 = makeSale({
      saleId: 's-2',
      reference: 'INV-20261018-0001',
      occurredAt: new Date(2026, 9, 18, 15, 0).getTime(),
      soldBy: 'u-youssef',
      sellerName: 'يوسف',
      customerId: 'c-1',
      customerName: 'أحمد سمير',
      customerPhone: '01001234567',
      totalMinor: 1_250_000,
      costTotalMinor: 1_100_000,
      profitMinor: 150_000,
      lines: [
        {
          lineId: 'l-2',
          lineNo: 1,
          productId: 'p-phone',
          productName: 'Samsung Galaxy A15 128GB',
          categoryId: 'c-phones',
          categoryName: 'موبايلات جديدة',
          parentCategoryId: null,
          quantity: 1,
          unitSellingPriceMinor: 1_250_000,
          discountMinor: 0,
          lineTotalMinor: 1_250_000,
          unitCostMinor: 1_100_000,
          lineCostMinor: 1_100_000,
          lineProfitMinor: 150_000,
          warrantyStart: '2026-10-18',
          warrantyEnd: '2027-10-18',
          unitId: 'u-1',
          imei: '356938035643809',
        },
      ],
      payments: [
        { method: 'cash', amountMinor: 1_000_000, reference: null },
        { method: 'vf', amountMinor: 250_000, reference: null },
      ],
    });
    const sCancelled = makeSale({
      saleId: 's-cancelled',
      reference: 'INV-20261018-0002',
      occurredAt: new Date(2026, 9, 18, 16, 0).getTime(),
      totalMinor: 50_000,
      isCancelled: true,
    });

    const history = [s1, s2, sCancelled];
    const from = new Date(2026, 9, 16);
    const to = new Date(2026, 9, 18);
    const rangeList = inRange(history, from, to);
    assert.equal(rangeList.length, 2);

    const rows = asRows(rangeList);
    const tot = totalsOf(rows);
    assert.equal(tot.salesMinor, 1_270_000);
    assert.equal(tot.profitMinor, 158_000);
    assert.equal(tot.invoices, 2);
    assert.equal(tot.pcs, 3);
    assert.equal(tot.avgMinor, 635_000);
    assert.equal(tot.partial, false);

    const days = byDay(rows, from, to);
    assert.equal(days.length, daysIn(from, to));
    assert.equal(days[0]!.invoices, 0);
    assert.equal(days[1]!.salesMinor, 20_000);
    assert.equal(days[2]!.salesMinor, 1_250_000);

    const prods = byProduct(rows);
    assert.equal(prods.length, 2);
    assert.equal(prods[0]!.name, 'Samsung Galaxy A15 128GB');
    assert.equal(prods[1]!.qty, 2);

    const cats = byCategory(rows, (id) => (id === 'c-acc' ? 'إكسسوارات' : ''));
    assert.equal(cats.length, 2);
    const accMain = cats.find((c) => c.id === 'c-acc');
    assert.ok(accMain);
    assert.equal(accMain.name, 'إكسسوارات');
    assert.equal(accMain.subs.length, 1);
    assert.equal(accMain.subs[0]!.id, 'c-cables');

    const months = byMonth(history);
    assert.equal(months.length, 1);
    assert.equal(months[0]!.invoices, 2);
  });

  it('filters by seller role, category (line-level), payment method, and Arabic/Latin search queries', () => {
    const s1 = makeSale({
      saleId: 's-1',
      reference: 'INV-20261018-0001',
      soldBy: 'u-peter',
    });
    const s2 = makeSale({
      saleId: 's-2',
      reference: 'INV-20261018-0002',
      soldBy: 'u-youssef',
      customerName: 'أحمد سمير',
      customerPhone: '01001234567',
      totalMinor: 127_000,
      lines: [
        {
          lineId: 'l-a',
          lineNo: 1,
          productId: 'p-cable',
          productName: 'كابل تايب سي 1 متر',
          categoryId: 'c-cables',
          categoryName: 'كابلات وشواحن',
          parentCategoryId: 'c-acc',
          quantity: 1,
          unitSellingPriceMinor: 10_000,
          discountMinor: 0,
          lineTotalMinor: 10_000,
          unitCostMinor: 6_000,
          lineCostMinor: 6_000,
          lineProfitMinor: 4_000,
          warrantyStart: null,
          warrantyEnd: null,
          unitId: null,
          imei: null,
        },
        {
          lineId: 'l-b',
          lineNo: 2,
          productId: 'p-phone',
          productName: 'Samsung Galaxy A15 128GB',
          categoryId: 'c-phones',
          categoryName: 'موبايلات جديدة',
          parentCategoryId: null,
          quantity: 1,
          unitSellingPriceMinor: 117_000,
          discountMinor: 0,
          lineTotalMinor: 117_000,
          unitCostMinor: 100_000,
          lineCostMinor: 100_000,
          lineProfitMinor: 17_000,
          warrantyStart: '2026-10-18',
          warrantyEnd: '2027-10-18',
          unitId: 'u-1',
          imei: '356938035643809',
        },
      ],
      payments: [{ method: 'vf', amountMinor: 127_000, reference: null }],
    });

    const d = dayStart(new Date(2026, 9, 18));
    // Seller Youssef sees only his own sales
    const sellerRows = filterSalesRows(
      [s1, s2],
      d,
      d,
      { q: '', cat: '', seller: '', method: '' },
      { isOwner: false, userId: 'u-youssef' },
    );
    assert.equal(sellerRows.length, 1);
    assert.equal(sellerRows[0]!.x.saleId, 's-2');

    // Category filter matches parent category `c-acc` and sets lineLevel = true
    const catRows = filterSalesRows(
      [s1, s2],
      d,
      d,
      { q: '', cat: 'c-acc', seller: '', method: '' },
      { isOwner: true, userId: 'u-peter' },
    );
    assert.equal(catRows.length, 2);
    assert.equal(catRows[1]!.lineLevel, true);
    assert.equal(catRows[1]!.lines.length, 1);
    assert.equal(totalsOf(catRows).salesMinor, 30_000);
    assert.equal(totalsOf(catRows).partial, true);

    // Search by IMEI in Arabic-Indic digits
    const imeiRows = filterSalesRows(
      [s1, s2],
      d,
      d,
      { q: '٣٥٦٩٣٨٠٣٥٦٤٣٨٠٩', cat: '', seller: '', method: '' },
      { isOwner: true, userId: 'u-peter' },
    );
    assert.equal(imeiRows.length, 1);
    assert.equal(imeiRows[0]!.x.saleId, 's-2');
    assert.equal(imeiRows[0]!.lineLevel, true);
    assert.equal(imeiRows[0]!.lines.length, 1);

    // Exact invoice sequence search (`1`) finds invoice #1 only
    const exactRows = filterSalesRows(
      [s1, s2],
      d,
      d,
      { q: '1', cat: '', seller: '', method: '' },
      { isOwner: true, userId: 'u-peter' },
    );
    assert.equal(exactRows.length, 1);
    assert.equal(exactRows[0]!.x.saleId, 's-1');

    // Helpers
    assert.equal(extractInvoiceDigits('INV-20261018-0002'), '2');
    assert.equal(moreItemsLabel(1), 'وصنف كمان');
    assert.equal(moreItemsLabel(2), 'وصنفين كمان');
    assert.equal(moreItemsLabel(4), 'و4 أصناف كمان');
    assert.equal(
      paymentSummaryLabel([
        { method: 'cash', amountMinor: 100, reference: null },
        { method: 'vf', amountMinor: 200, reference: null },
      ]),
      'كاش + فودافون كاش',
    );
    assert.equal(pct(120, 100), 20);
    assert.equal(pct(100, 0), null);
    assert.ok(parseIsoDay('2026-10-18'));
    assert.equal(parseIsoDay('2026-02-30'), null);
    assert.equal(isoDay(monthStart(new Date(2026, 9, 18))), '2026-10-01');
  });

  it('computes monthReport, evaluation verdict & notes, todayReport, and display helpers (Plan 2.5 / ADR-035)', () => {
    const now = new Date(2026, 9, 19, 16, 0, 0, 0); // Oct 19, 2026 16:00

    const augSale = makeSale({
      saleId: 's-aug',
      reference: 'INV-20260810-0001',
      occurredAt: new Date(2026, 7, 10, 12, 0).getTime(),
      totalMinor: 900_000,
      costTotalMinor: 750_000,
      profitMinor: 150_000,
    });
    const sepSale = makeSale({
      saleId: 's-sep',
      reference: 'INV-20260910-0001',
      occurredAt: new Date(2026, 8, 10, 12, 0).getTime(),
      totalMinor: 1_000_000,
      costTotalMinor: 800_000,
      profitMinor: 200_000,
    });
    const octNewPhone = makeSale({
      saleId: 's-oct-1',
      reference: 'INV-20261005-0001',
      occurredAt: new Date(2026, 9, 5, 14, 0).getTime(),
      soldBy: 'u-peter',
      sellerName: 'بيتر',
      totalMinor: 1_500_000,
      costTotalMinor: 1_320_000,
      profitMinor: 180_000,
      lines: [
        {
          lineId: 'l-oct-1',
          lineNo: 1,
          productId: 'p-new',
          productName: 'Samsung Galaxy A15 128GB',
          categoryId: '01a14728-8400-7000-8000-000000000001',
          categoryName: 'موبايلات جديدة',
          parentCategoryId: null,
          quantity: 1,
          unitSellingPriceMinor: 1_500_000,
          discountMinor: 0,
          lineTotalMinor: 1_500_000,
          unitCostMinor: 1_320_000,
          lineCostMinor: 1_320_000,
          lineProfitMinor: 180_000,
          warrantyStart: null,
          warrantyEnd: null,
          unitId: 'u-new-1',
          imei: '356938035643809',
        },
      ],
      payments: [{ method: 'cash', amountMinor: 1_500_000, reference: null }],
    });
    const octUsedPhoneToday = makeSale({
      saleId: 's-oct-2',
      reference: 'INV-20261019-0001',
      occurredAt: new Date(2026, 9, 19, 13, 0).getTime(),
      soldBy: 'u-youssef',
      sellerName: 'يوسف',
      totalMinor: 850_000,
      costTotalMinor: 720_000,
      profitMinor: 130_000,
      lines: [
        {
          lineId: 'l-oct-2',
          lineNo: 1,
          productId: 'p-used',
          productName: 'iPhone 13 128GB',
          categoryId: '01a14728-8400-7000-8000-000000000002',
          categoryName: 'مستعمل',
          parentCategoryId: null,
          quantity: 1,
          unitSellingPriceMinor: 850_000,
          discountMinor: 0,
          lineTotalMinor: 850_000,
          unitCostMinor: 720_000,
          lineCostMinor: 720_000,
          lineProfitMinor: 130_000,
          warrantyStart: null,
          warrantyEnd: null,
          unitId: 'u-used-1',
          imei: '353912108456786',
        },
      ],
      payments: [{ method: 'vf', amountMinor: 850_000, reference: null }],
    });

    const history = [augSale, sepSale, octNewPhone, octUsedPhoneToday];
    const report = monthReport(history, new Date(2026, 9, 1), now);

    assert.equal(report.live, true);
    assert.equal(report.T.salesMinor, 2_350_000);
    assert.equal(report.T.profitMinor, 310_000);
    assert.equal(report.PT.salesMinor, 1_000_000);
    assert.equal(report.phones.all, 2);
    assert.equal(report.phones.fresh, 1);
    assert.equal(report.phones.used, 1);
    assert.equal(report.months.length, 3);
    assert.equal(report.verdict.key, 'best');
    assert.equal(report.verdict.tone, 'good');
    assert.ok(report.projectionMinor !== null && report.projectionMinor > 0);
    assert.ok(report.notes.some((n) => n.key === 'sales' && n.tone === 'good'));
    assert.ok(report.notes.some((n) => n.key === 'top'));

    const td = todayReport(history, now);
    assert.equal(td.salesMinor, 850_000);
    assert.equal(td.invoices, 1);
    assert.equal(td.week.length, 7);
    assert.equal(td.week[6]?.salesMinor, 850_000);

    const ya = yearAgo(new Date(2024, 1, 1), new Date(2024, 1, 29), now);
    assert.equal(isoDay(ya.to), '2023-02-28');

    const split = paySplit({ كاش: 600, فودافون: 400 });
    assert.equal(split.reduce((a, s) => a + s.v, 0), 100);

    assert.equal(nMonthsLabel(7), '7 شهور');
    assert.equal(nMonthsLabel(12), '12 شهر');
    assert.equal(kShortMinor(237_000_000), '2.37 مليون');
    assert.equal(kShortMinor(17_150_000), '171.5 ألف');
    assert.deepEqual(chgFormat(null), { kind: 'new', text: 'جديد' });
    assert.deepEqual(chgFormat(0), { kind: 'zero', text: '0%' });
    assert.deepEqual(chgFormat(400), { kind: 'up', text: '×5' });
    assert.deepEqual(chgFormat(-15), { kind: 'down', text: '15%' });
  });
});

describe('rateDay — the day in one word (`ADR-047`)', () => {
  const base = {
    salesMinor: 0,
    goodsProfitMinor: 0,
    servicesProfitMinor: 0,
    walletFeesMinor: 0,
    expensesMinor: 0,
    invoices: 0,
    vsYesterday: null,
  };

  it('calls a day that has not started «لسه بدري», not «تحت المتوسط»', () => {
    const r = rateDay(base);
    assert.equal(r.key, 'idle');
    assert.equal(r.word, 'لسه بدري');
    assert.equal(r.reasons.length, 0);
    assert.equal(r.netMinor, 0);
  });

  it('says «ممتاز» for a day that beat yesterday, kept a margin, was busy and had help', () => {
    const r = rateDay({
      ...base,
      salesMinor: 100_000,
      goodsProfitMinor: 20_000,
      servicesProfitMinor: 7_000,
      walletFeesMinor: 3_000,
      expensesMinor: 5_000,
      invoices: 7,
      vsYesterday: 25,
    });
    assert.equal(r.key, 'excellent');
    assert.equal(r.word, 'ممتاز');
    assert.equal(r.grossMinor, 30_000);
    assert.equal(r.netMinor, 25_000, 'expenses are taken out of the day, not ignored');
  });

  it('says «جيد» when the day is ahead but small', () => {
    const r = rateDay({
      ...base,
      salesMinor: 40_000,
      goodsProfitMinor: 8_000,
      invoices: 2,
      vsYesterday: 4,
    });
    assert.equal(r.key, 'good');
    assert.equal(r.word, 'جيد');
  });

  it('says «تحت المتوسط» when sales fell and the expenses ate the profit', () => {
    const r = rateDay({
      ...base,
      salesMinor: 30_000,
      goodsProfitMinor: 900,
      invoices: 1,
      expensesMinor: 5_000,
      vsYesterday: -40,
    });
    assert.equal(r.key, 'below');
    assert.equal(r.word, 'تحت المتوسط');
    assert.equal(r.netMinor, -4_100);
    assert.ok(r.reasons.some((why) => why.includes('مصاريف')));
  });

  it('rates the whole shop, so services and wallet fees count as income', () => {
    const goodsOnly = rateDay({
      ...base,
      salesMinor: 20_000,
      goodsProfitMinor: 4_000,
      invoices: 3,
      vsYesterday: -5,
    });
    const withServices = rateDay({
      ...base,
      salesMinor: 20_000,
      goodsProfitMinor: 4_000,
      servicesProfitMinor: 6_000,
      invoices: 3,
      vsYesterday: -5,
    });
    assert.equal(goodsOnly.key, 'average');
    assert.equal(withServices.key, 'good', 'a repair beside the sale is a better day');
    assert.ok(withServices.netMinor > goodsOnly.netMinor);
  });

  it('keeps at most three reasons, and never a fake one', () => {
    const r = rateDay({
      ...base,
      salesMinor: 100_000,
      goodsProfitMinor: 20_000,
      servicesProfitMinor: 5_000,
      walletFeesMinor: 1_000,
      expensesMinor: 2_000,
      invoices: 9,
      vsYesterday: 30,
    });
    assert.ok(r.reasons.length <= 3);
    assert.ok(r.reasons.every((why) => why.trim().length > 0));
  });
});

describe('rateMonthVerdict — the month speaks the same four words (`ADR-047`)', () => {
  it('grades a best month «ممتاز» and a weak one «تحت المتوسط»', () => {
    assert.equal(rateMonthVerdict({ key: 'best', tone: 'good' }, 1, 8).word, 'ممتاز');
    assert.equal(rateMonthVerdict({ key: 'top3', tone: 'good' }, 2, 8).word, 'ممتاز');
    assert.equal(rateMonthVerdict({ key: 'low3', tone: 'warn' }, 7, 8).word, 'تحت المتوسط');
  });

  it('splits the middle by rank: upper half «جيد», lower half «متوسط»', () => {
    assert.equal(rateMonthVerdict({ key: 'mid', tone: 'info' }, 3, 8).word, 'جيد');
    assert.equal(rateMonthVerdict({ key: 'mid', tone: 'info' }, 6, 8).word, 'متوسط');
  });

  it('does not grade a month it cannot compare', () => {
    assert.equal(rateMonthVerdict({ key: 'early', tone: 'info' }, null, 1).word, 'لسه بدري');
    assert.equal(rateMonthVerdict({ key: 'few', tone: 'info' }, null, 2).word, 'لسه بدري');
  });
});
