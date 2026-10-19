// Unit tests for Smart Alerts & Daily WhatsApp Summary (`ADR-036`, Plan item 3.1).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProductUnit } from '../../api/inventory.ts';
import type { PosProduct } from '../../api/pos.ts';
import type { RepairTicket } from '../../api/repairs.ts';
import type { SaleHistoryEntry } from '../../api/sales.ts';
import type { ShortagesOverview } from '../../api/shortages.ts';
import {
  buildSmartAlertsBundle,
  computeOverdueRepairs,
  computeStagnantProducts,
  formatDailyWhatsAppSummary,
} from './smart-alerts.ts';

describe('Smart Alerts & Daily WhatsApp Summary (Plan 3.1 / ADR-036)', () => {
  it('detects stagnant products with zero sales in the last 30 days and calculates exact frozen cost', () => {
    const now = new Date(2026, 9, 19, 18, 0, 0);
    const posProducts: PosProduct[] = [
      {
        id: 'p-active',
        name: 'شاحن سامسونج 25 وات',
        disposition: 'quantity',
        barcode: '8801',
        categoryId: 'c-acc',
        brandId: null,
        salePriceMinor: 35_000,
        onHand: 10,
        soldRecently: 5,
        tracking: 'none',
      },
      {
        id: 'p-stagnant-phone',
        name: 'Samsung Galaxy A15 128GB',
        disposition: 'serialized',
        barcode: null,
        categoryId: 'c-phones',
        brandId: 'b-sam',
        salePriceMinor: 750_000,
        onHand: 2,
        soldRecently: 0,
        tracking: 'serial_optional',
      },
      {
        id: 'p-stagnant-item',
        name: 'وصلة OTG',
        disposition: 'quantity',
        barcode: null,
        categoryId: 'c-cables',
        brandId: null,
        salePriceMinor: 5_000,
        onHand: 8,
        soldRecently: 0,
        tracking: 'none',
      },
    ];

    const units: ProductUnit[] = [
      {
        id: 'u-1',
        productId: 'p-stagnant-phone',
        imei: '356938035643809',
        imei2: null,
        color: 'أسود',
        conditionGrade: null,
        batteryHealthPct: null,
        accessories: null,
        sellerName: null,
        sellerPhone: null,
        sellerNationalId: null,
        intakeNote: null,
        unitCostMinor: 640_000,
        createdAt: now.getTime() - 45 * 86_400_000,
      },
      {
        id: 'u-2',
        productId: 'p-stagnant-phone',
        imei: '352099001761481',
        imei2: null,
        color: 'أزرق',
        conditionGrade: null,
        batteryHealthPct: null,
        accessories: null,
        sellerName: null,
        sellerPhone: null,
        sellerNationalId: null,
        intakeNote: null,
        unitCostMinor: 650_000,
        createdAt: now.getTime() - 40 * 86_400_000,
      },
    ];

    const oldSale: SaleHistoryEntry = {
      saleId: 's-old',
      reference: 'INV-20260801-0001',
      occurredAt: now.getTime() - 50 * 86_400_000,
      soldBy: 'u-peter',
      sellerName: 'بيتر',
      customerId: null,
      customerName: null,
      customerPhone: null,
      linesSubtotalMinor: 750_000,
      discountMinor: 0,
      totalMinor: 750_000,
      costTotalMinor: 640_000,
      profitMinor: 110_000,
      alreadyRefundedMinor: 0,
      isCancelled: false,
      lines: [
        {
          lineId: 'l-1',
          lineNo: 1,
          productId: 'p-stagnant-phone',
          productName: 'Samsung Galaxy A15 128GB',
          categoryId: 'c-phones',
          categoryName: 'موبايلات جديدة',
          parentCategoryId: null,
          quantity: 1,
          unitSellingPriceMinor: 750_000,
          discountMinor: 0,
          lineTotalMinor: 750_000,
          warrantyStart: null,
          warrantyEnd: null,
          unitId: null,
          imei: null,
        },
      ],
      payments: [{ method: 'cash', amountMinor: 750_000, reference: null }],
    };

    const stagnant = computeStagnantProducts(
      posProducts,
      units,
      [oldSale],
      now,
      30,
    );
    assert.equal(stagnant.length, 2);
    assert.equal(stagnant[0]?.productId, 'p-stagnant-phone');
    assert.equal(stagnant[0]?.frozenCostMinor, 1_290_000);
    assert.equal(stagnant[0]?.daysSinceLastSale, 50);
    assert.equal(stagnant[1]?.productId, 'p-stagnant-item');
    assert.equal(stagnant[1]?.daysSinceLastSale, null);
  });

  it('detects overdue repairs and formats the daily WhatsApp summary with separate repair & software revenue', () => {
    const now = new Date(2026, 9, 19, 20, 0, 0);
    const tickets: RepairTicket[] = [
      {
        id: 'r-1',
        ticketNo: 'R-1092',
        serviceKind: 'hardware',
        customerName: 'سارة محمود',
        customerPhone: '01234567890',
        deviceName: 'شاومي ريدمي نوت 12',
        imei: null,
        deviceLock: '',
        issue: 'تغيير سوكت شحن',
        accessories: 'شاحن',
        dueLabel: 'بكره',
        status: 'diagnosing',
        estimatedPriceMinor: 45_000,
        finalPriceMinor: 0,
        partsCostMinor: 12_000,
        netProfitMinor: null,
        depositMinor: 10_000,
        collectedMinor: 10_000,
        remainingMinor: 35_000,
        payMethod: 'cash',
        technicianName: 'م. حسن',
        warrantyDays: 14,
        note: '',
        createdBy: 'u-peter',
        createdByName: 'بيتر',
        createdAt: now.getTime() - 72 * 3_600_000,
        deliveredAt: null,
      },
    ];

    const overdue = computeOverdueRepairs(tickets, now.getTime());
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0]?.kind, 'overdue_work');
    assert.equal(overdue[0]?.ageDays, 3);

    const shortages: ShortagesOverview = {
      items: [
        {
          id: 'sh-1',
          productId: null,
          name: 'جراب S25 الترا',
          qty: 2,
          note: '',
          customerName: 'أحمد سمير',
          customerPhone: '01001234567',
          status: 'open',
          createdBy: 'u-peter',
          createdByName: 'بيتر',
          createdAt: now.getTime(),
          resolvedAt: null,
          onHand: null,
          minQty: null,
        },
      ],
      suggestions: [],
    };

    const bundle = buildSmartAlertsBundle({
      shortages,
      repairTickets: tickets,
      posProducts: [],
      units: [],
      salesHistory: [],
      now,
    });

    const msg = formatDailyWhatsAppSummary({
      shopName: 'موبايل ستور',
      date: now,
      shiftNumber: 2,
      salesMinor: 1_925_900,
      invoicesCount: 9,
      goodsProfitMinor: 429_620,
      hardwareRevenueMinor: 270_000,
      softwareRevenueMinor: 30_000,
      walletFeesMinor: 1_500,
      expectedDrawerCashMinor: 2_101_400,
      alerts: bundle,
    });

    assert.ok(msg.includes('موبايل ستور'));
    assert.ok(msg.includes('فلوس الصيانة لوحدها: 2,700 ج.م'));
    assert.ok(msg.includes('فلوس السوفت وير لوحدها: 300 ج.م'));
    assert.ok(msg.includes('R-1092'));
    assert.ok(msg.includes('عميل منتظر'));
  });
});
