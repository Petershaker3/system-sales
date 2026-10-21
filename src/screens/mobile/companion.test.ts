// Unit tests for LAN Companion Server & Mobile Helper (`ADR-037`, Plan item 3.2).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { UserSummary } from '../../api/identity.ts';
import type { ProductUnit } from '../../api/inventory.ts';
import type { PosProduct } from '../../api/pos.ts';
import type { SaleHistoryEntry } from '../../api/sales.ts';
import { dg } from '../../ui/format.ts';
import {
  barcodeScannerLabel,
  buildEtaEReceiptDraft,
  deviceLinkLabel,
  formatHostAddress,
  hostLinkState,
  intakeProgressLabel,
  lanRoleFor,
  outboxSummary,
  parseImeiList,
  parsePairPayload,
  relativeLinkAge,
  validateCaptureDraft,
  buildMobileSalesSnapshot,
  buildPairingQrMatrix,
  buildRemoteOwnerSnapshot,
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

  });

  it('builds Phase 4 remote owner snapshot with separate repair/software money and canonical ETA e-Receipt v1.2 draft', () => {
    const remote = buildRemoteOwnerSnapshot({
      shopName: 'سنتر بيتر للموبايلات',
      remoteCode: 'RMT-9042',
      remoteEnabled: true,
      salesMinor: 1_925_900,
      invoicesCount: 9,
      profitMinor: 429_620,
      hardwareRevenueMinor: 415_000,
      softwareRevenueMinor: 55_000,
      expectedDrawerCashMinor: 275_920,
      shiftNumber: 2,
    });
    assert.equal(remote.remoteEnabled, true);
    assert.equal(remote.hardwareRevenueMinor, 415_000);
    assert.equal(remote.softwareRevenueMinor, 55_000);

    const draft = buildEtaEReceiptDraft({
      receiptNumber: 'INV-20261019-0009',
      issuedAtMs: 1_760_875_200_000,
      lines: [
        {
          itemCode: 'EG-2000000000015',
          description: 'شاحن سامسونج 25 وات',
          quantity: 1,
          unitPriceMinor: 45_000,
          discountMinor: 0,
          netTotalMinor: 45_000,
        },
      ],
      invoiceDiscountMinor: 5_000,
    });
    assert.equal(draft.receiptType, 'S');
    assert.equal(draft.typeVersion, '1.2');
    assert.equal(draft.totalMinor, 40_000);
    assert.equal(draft.taxMinor, 0);
    assert.equal(draft.canonicalHashHex.length, 32);
  });
});

// `ADR-042`: the two halves of the link are not symmetric, and nothing in this
// file may claim a connection that the wire did not report.
describe('the link reports the wire (ADR-042)', () => {
  const digits = (value: number): string => `[${value}]`;

  it('makes the computer the host and the handset the caller', () => {
    assert.equal(lanRoleFor('desktop'), 'host');
    assert.equal(lanRoleFor('phone'), 'client');
  });

  it('reads back the line printed under the QR, and nothing else', () => {
    const target = parsePairPayload('MSHOP-PAIR|v1|موبايل ستور|192.168.1.20:8787|PAIR-8787');
    assert.deepEqual(target, {
      shopName: 'موبايل ستور',
      host: '192.168.1.20',
      port: 8787,
      pairCode: 'PAIR-8787',
    });
    assert.equal(formatHostAddress('192.168.1.20', 8787), '192.168.1.20:8787');
    // The owner-only follow-up line is a different contract, and must not be
    // swallowed by the pairing parser just because a phone scanned it.
    assert.equal(parsePairPayload('MSHOP-REMOTE|v1|موبايل ستور|RMT-9042'), null);
    assert.equal(parsePairPayload('MSHOP-PAIR|v1|متجر|192.168.1.20|PAIR-8787'), null);
    assert.equal(parsePairPayload('MSHOP-PAIR|v2|متجر|192.168.1.20:8787|PAIR-8787'), null);
    assert.equal(parsePairPayload('MSHOP-PAIR|v1||192.168.1.20:8787|PAIR-8787'), null);
    assert.equal(parsePairPayload('MSHOP-PAIR|v1|متجر|192.168.1.20:99999|PAIR-8787'), null);
  });

  it('refuses a draft the computer would refuse, in the shop’s words', () => {
    const ok = {
      deviceName: 'موبايل بيتر',
      productName: 'شاومي ريدمي نوت ١٣',
      barcode: '',
      disposition: 'quantity' as const,
      quantity: 2,
      unitCostMinor: 4_500_00,
      imeis: [],
      photos: [],
    };
    assert.equal(validateCaptureDraft(ok), null);
    assert.match(validateCaptureDraft({ ...ok, productName: '  ' }) ?? '', /اسم الصنف/);
    const longName = validateCaptureDraft({ ...ok, productName: 'ص'.repeat(121) }) ?? '';
    const longCode = validateCaptureDraft({ ...ok, barcode: '9'.repeat(65) }) ?? '';
    assert.ok(longName.includes(dg(120)), 'the cap is quoted through dg(), the one digit renderer');
    assert.ok(longCode.includes(dg(64)), 'same for the barcode cap');
    assert.match(validateCaptureDraft({ ...ok, quantity: 0 }) ?? '', /الكمية/);
    assert.match(validateCaptureDraft({ ...ok, unitCostMinor: -1 }) ?? '', /التكلفة/);
    assert.match(validateCaptureDraft({ ...ok, photos: ['a', 'b', 'c', 'd'] }) ?? '', /صور/);
    assert.match(
      validateCaptureDraft({ ...ok, disposition: 'serialized', imeis: [] }) ?? '',
      /IMEI واحد على الأقل/,
      'a serialized receipt with no units is stock nobody can sell',
    );
    assert.match(
      validateCaptureDraft({ ...ok, disposition: 'serialized', quantity: 1, imeis: ['356930023095058', '356930023095066'] }) ?? '',
      /أكبر من الكمية/,
    );
  });

  it('keeps only 15-digit IMEIs a person could actually record', () => {
    assert.deepEqual(
      parseImeiList('356930023095058\n356930023095066, 356930023095058\n12345'),
      ['356930023095058', '356930023095066'],
    );
    assert.deepEqual(parseImeiList('35693-02309-5058'), [], 'a torn run is not an IMEI');
  });

  it('names a handset by what it did, not by what was typed about it', () => {
    const seen = 1_000;
    assert.equal(deviceLinkLabel({ online: true, lastSeenAt: seen }, 1_000, digits), 'متصل دلوقتي');
    assert.equal(
      deviceLinkLabel({ online: false, lastSeenAt: 0 }, 1_000, digits),
      'متسجّل — لسه ما كلّمش الجهاز',
      'a pairing record alone never earns a green dot',
    );
    assert.match(
      deviceLinkLabel({ online: false, lastSeenAt: seen }, 3 * 86_400_000, digits),
      /من \[3\] يوم/,
    );
    assert.equal(relativeLinkAge(1_000, 0, digits), 'مفيش ظهور بعد');
    assert.equal(relativeLinkAge(2_000, 1_990, digits), 'قبل ثواني');
  });

  it('will not call the link alive with nobody on it', () => {
    const base = {
      running: true,
      port: 8787,
      rejectedPushes: 0,
      pendingIntakes: [] as unknown[],
    };
    const quiet = hostLinkState({ ...base, pairedDevices: [{ online: false }, { online: false }] }, digits);
    assert.equal(quiet.tone, 'warn');
    assert.equal(quiet.label, 'سامع، ومفيش موبايل كلّمه');
    const alive = hostLinkState({ ...base, pairedDevices: [{ online: true }, { online: false }] }, digits);
    assert.equal(alive.tone, 'ok');
    assert.equal(alive.label, '[1] موبايل متصل', 'only the online rows are counted');
    const waiting = hostLinkState(
      { ...base, pairedDevices: [{ online: true }], pendingIntakes: [{}, {}] },
      digits,
    );
    assert.match(waiting.label, /مسودة مستنياك/);
    const refused = hostLinkState(
      { ...base, pairedDevices: [{ online: true }], rejectedPushes: 3 },
      digits,
    );
    assert.equal(refused.tone, 'warn', 'a refused code is not a clean link');
    assert.match(refused.detail, /بكود ربط غلط/);
    assert.equal(hostLinkState(null, digits).tone, 'bad', 'no answer is not an ok');
    assert.equal(
      hostLinkState({ ...base, running: false, pairedDevices: [{ online: true }] }, digits).tone,
      'bad',
      'a port nobody holds is not a listener',
    );
  });

  it('counts the phone’s queue without stealing the computer’s decision', () => {
    const summary = outboxSummary([
      { pushedAt: null, pushError: null },
      { pushedAt: 5, pushError: null },
      { pushedAt: null, pushError: 'كود الربط مرفوض' },
    ]);
    assert.deepEqual(summary, { waiting: 1, delivered: 1, failed: 1 });
    assert.equal(intakeProgressLabel({ pushedAt: null, pushError: null }, 10, digits), 'مستنية البعته');
    assert.match(
      intakeProgressLabel({ pushedAt: 9, pushError: null }, 10, digits),
      /هو يقرر امتى يتسجل/,
      '“delivered” is the phone’s word for bytes received, not for stock recorded',
    );
    assert.match(intakeProgressLabel({ pushedAt: null, pushError: 'مرفوض' }, 10, digits), /الكمبيوتر ردّ: مرفوض/);
    assert.equal(barcodeScannerLabel(false), 'كاميرا المتصفح على الجهاز ده ما بتقرأش الباركود — اكتب الرقم أو الصقه');
    assert.match(barcodeScannerLabel(false), /^\D+$/, 'an excuse needs no numbers');
  });
});

// The pairing QR is what a handset's camera must decode to join the shop's
// link (`ADR-042`). What stood here before was decoration that scanned as
// nothing; these tests hold the real thing to what a scanner needs.
describe('the pairing QR is a real QR code (owner request 2026-10-21)', () => {
  const payload = 'MSHOP-PAIR|v1|سنتر بيتر للموبايلات|192.168.1.10:8787|PAIR-8787';

  /** The 7×7 finder every QR carries in three of its corners. */
  function finderAt(grid: boolean[][], r0: number, c0: number): void {
    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < 7; c += 1) {
        const border = r === 0 || r === 6 || c === 0 || c === 6;
        const inner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        assert.equal(
          grid[r0 + r]![c0 + c],
          border || inner,
          `finder module ${r},${c} at corner ${r0},${c0}`,
        );
      }
    }
  }

  it('encodes the payload as a square a scanner recognises', async () => {
    const qr = await buildPairingQrMatrix(payload);
    assert.ok(qr.length >= 21, `version 1 or bigger, got ${qr.length}`);
    assert.ok(qr.every((row) => row.length === qr.length), 'a QR is square');
    finderAt(qr, 0, 0);
    finderAt(qr, 0, qr.length - 7);
    finderAt(qr, qr.length - 7, 0);
  });

  it('is deterministic, and a new pair code is a new picture', async () => {
    const again = await buildPairingQrMatrix(payload);
    const rotated = await buildPairingQrMatrix(payload.replace('PAIR-8787', 'PAIR-4242'));
    assert.deepEqual(again, await buildPairingQrMatrix(payload));
    assert.notDeepEqual(again, rotated);
  });

  it('decodes back to exactly the payload, Arabic shop name included', async () => {
    const {
      BinaryBitmap,
      HybridBinarizer,
      QRCodeReader,
      RGBLuminanceSource,
    } = await import('@zxing/library');
    const qr = await buildPairingQrMatrix(payload);

    // The screen shows the modules on a white plate with a four-module quiet
    // zone around them (`CompanionPairQr.vue`); decode what the camera sees.
    const quiet = 4;
    const n = qr.length + quiet * 2;
    const luminances = new Int32Array(n * n).fill(0xff);
    qr.forEach((row, r) => {
      row.forEach((cell, c) => {
        if (cell) luminances[(r + quiet) * n + (c + quiet)] = 0;
      });
    });

    const bitmap = new BinaryBitmap(
      new HybridBinarizer(new RGBLuminanceSource(luminances, n, n)),
    );
    const decoded = new QRCodeReader().decode(bitmap);
    assert.equal(decoded.getText(), payload);
  });
});
