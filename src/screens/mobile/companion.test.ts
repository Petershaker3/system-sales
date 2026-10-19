// Unit tests for LAN Companion Server & Mobile Helper (`ADR-037`, Plan item 3.2).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { UserSummary } from '../../api/identity.ts';
import type { ProductUnit } from '../../api/inventory.ts';
import type { PosProduct } from '../../api/pos.ts';
import type { SaleHistoryEntry } from '../../api/sales.ts';
import {
  buildMobileSalesSnapshot,
  buildPairingQrMatrix,
  filterMobileLookupProducts,
  resolveMobileScanToPos,
} from './companion.ts';

describe('LAN Companion & Mobile Helper (Plan 3.2 / ADR-037)', () => {
  const now = new Date(2026, 9, 19, 16, 0, 0);
  const users: UserSummary[] = [
    { id: 'u-peter', username: 'peter', displayName: 'بيتر', role: 'manager', hasPin: true, disabled: false },
    { id: 'u-youssef', username: 'youssef', displayName: 'يوسف', role: 'sales', hasPin: true, disabled: false },
  ];

  const history: SaleHistoryEntry[] = [
    {
      saleId: 's-1',
      reference: 'INV-20261019-0001',
      occurredAt: new Date(2026, 9, 19, 12, 0, 0).getTime(),
      soldBy: 'u-peter',
      sellerName: 'بيتر',
      customerId: null,
      customerName: null,
      customerPhone: null,
      linesSubtotalMinor: 100_000,
      discountMinor: 0,
      totalMinor: 100_000,
      costTotalMinor: 80_000,
      profitMinor: 20_000,
      alreadyRefundedMinor: 0,
      isCancelled: false,
      lines: [],
      payments: [{ method: 'cash', amountMinor: 100_000, reference: null }],
    },
    {
      saleId: 's-2',
      reference: 'INV-20261019-0002',
      occurredAt: new Date(2026, 9, 19, 14, 0, 0).getTime(),
      soldBy: 'u-youssef',
      sellerName: 'يوسف',
      customerId: null,
      customerName: null,
      customerPhone: null,
      linesSubtotalMinor: 40_000,
      discountMinor: 0,
      totalMinor: 40_000,
      costTotalMinor: 25_000,
      profitMinor: 15_000,
      alreadyRefundedMinor: 0,
      isCancelled: false,
      lines: [],
      payments: [{ method: 'cash', amountMinor: 40_000, reference: null }],
    },
  ];

  it('scopes mobile sales view to shop total + profit for owner, and seller-only without profit for cashier', () => {
    const ownerSnap = buildMobileSalesSnapshot({
      history,
      users,
      currentUserId: 'u-peter',
      currentDisplayName: 'بيتر',
      currentRole: 'manager',
      now,
    });
    assert.equal(ownerSnap.isOwner, true);
    assert.equal(ownerSnap.totalMinor, 140_000);
    assert.equal(ownerSnap.invoicesCount, 2);
    assert.equal(ownerSnap.profitMinor, 35_000);
    assert.equal(ownerSnap.sellerBars.length, 2);

    const sellerSnap = buildMobileSalesSnapshot({
      history,
      users,
      currentUserId: 'u-youssef',
      currentDisplayName: 'يوسف',
      currentRole: 'sales',
      now,
    });
    assert.equal(sellerSnap.isOwner, false);
    assert.equal(sellerSnap.totalMinor, 40_000);
    assert.equal(sellerSnap.invoicesCount, 1);
    assert.equal(sellerSnap.profitMinor, null);
    assert.equal(sellerSnap.sellerBars.length, 0);
    assert.equal(sellerSnap.recentInvoices.length, 1);
  });

  it('resolves valid 15-digit Luhn IMEIs and product barcodes and hides cost from sellers in lookup', () => {
    const products: PosProduct[] = [
      {
        id: 'p-1',
        name: 'Samsung Galaxy A16 128GB',
        disposition: 'serialized',
        barcode: '2000000000015',
        salePriceMinor: 925_000,
        categoryId: 'c-phones',
        brandId: 'b-sam',
        onHand: 2,
        soldRecently: 5,
      },
    ];
    const units: ProductUnit[] = [
      {
        id: 'u-1',
        productId: 'p-1',
        imei: '356938035643809',
        imei2: null,
        color: 'أسود',
        unitCostMinor: 860_000,
        createdAt: now.getTime(),
      },
    ];

    const imeiScan = resolveMobileScanToPos('356938035643809', products, units);
    assert.equal(imeiScan.ok, true);
    assert.equal(imeiScan.kind, 'imei');
    assert.equal(imeiScan.productId, 'p-1');

    const badImei = resolveMobileScanToPos('356938035643800', products, units);
    assert.equal(badImei.ok, false);

    const ownerLook = filterMobileLookupProducts({
      query: 'A16',
      products,
      units,
      isOwner: true,
    });
    assert.equal(ownerLook.length, 1);
    assert.equal(ownerLook[0]!.costMinor, 860_000);

    const sellerLook = filterMobileLookupProducts({
      query: 'A16',
      products,
      units,
      isOwner: false,
    });
    assert.equal(sellerLook[0]!.costMinor, null);

    const qr = buildPairingQrMatrix('MSHOP-PAIR|v1|سنتر بيتر|192.168.1.10:8787|PAIR-8787');
    assert.equal(qr.length, 21);
    assert.equal(qr[0]![0], true);
  });
});
