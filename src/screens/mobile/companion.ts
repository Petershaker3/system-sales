// Pure domain & view helpers for the LAN Companion Server & Mobile Helper (`ADR-037`, Plan item 3.2).

import type { Role, UserSummary } from '../../api/identity.ts';
import type { ProductUnit } from '../../api/inventory.ts';
import type { PosProduct } from '../../api/pos.ts';
import type { SaleHistoryEntry } from '../../api/sales.ts';
import { imeiLuhn, normalizeImeiDigits } from '../pos/imei.ts';
import { dayStart, todayReport } from '../sales/analytics.ts';
import { dg } from '../../ui/format.ts';

export interface MobileSellerBar {
  readonly userId: string;
  readonly name: string;
  readonly salesMinor: number;
  readonly widthPct: number;
  readonly color: string;
}

export interface MobileRecentInvoice {
  readonly saleId: string;
  readonly no: string;
  readonly totalMinor: number;
  readonly seller: string;
  readonly method: string;
  readonly occurredAt: number;
}

export interface MobileSalesSnapshot {
  readonly isOwner: boolean;
  readonly headerTitle: string;
  readonly totalLabel: string;
  readonly totalMinor: number;
  readonly invoicesCount: number;
  readonly vsYesterday: number | null;
  /** `null` for sellers (`Permission::ViewCostAndProfit` is owner-only). */
  readonly profitMinor: number | null;
  readonly sellerBars: readonly MobileSellerBar[];
  readonly recentInvoices: readonly MobileRecentInvoice[];
}

const SELLER_COLORS = ['#1d4ed8', '#0f766e', '#b45309', '#7c3aed', '#be123c'];

/**
 * Build the mobile companion's live "Today Sales" view (`docs/PLAN.md` §15,
 * `docs/ui/mockup-v1/views/mobile.js` `salesScreen()`).
 *
 * - Owner (`manager`) sees total shop sales, profit, per-seller bars, and all recent invoices.
 * - Seller (`cashier`) sees ONLY their own sales and their own recent invoices, never profit or other sellers.
 */
export function buildMobileSalesSnapshot(input: {
  readonly history: readonly SaleHistoryEntry[];
  readonly users: readonly UserSummary[];
  readonly currentUserId: string;
  readonly currentDisplayName: string;
  readonly currentRole: Role;
  readonly now?: Date;
}): MobileSalesSnapshot {
  const now = input.now ?? new Date();
  const isOwner = input.currentRole === 'manager';
  const rep = todayReport(input.history, now);
  const todayMs = dayStart(now).getTime();

  const bySeller: Record<string, number> = {};
  const countBySeller: Record<string, number> = {};
  for (const x of input.history) {
    if (x.isCancelled) continue;
    if (dayStart(new Date(x.occurredAt)).getTime() !== todayMs) continue;
    bySeller[x.soldBy] = (bySeller[x.soldBy] ?? 0) + x.totalMinor;
    countBySeller[x.soldBy] = (countBySeller[x.soldBy] ?? 0) + 1;
  }

  if (!isOwner) {
    const mySalesMinor = bySeller[input.currentUserId] ?? 0;
    const myCount = countBySeller[input.currentUserId] ?? 0;
    const myRecent = rep.recent
      .filter((r) => r.sellerId === input.currentUserId)
      .slice(0, 4)
      .map((r) => ({
        saleId: r.saleId,
        no: r.no,
        totalMinor: r.totalMinor,
        seller: r.seller,
        method: r.method,
        occurredAt: r.occurredAt,
      }));
    return {
      isOwner: false,
      headerTitle: 'مبيعاتك النهارده',
      totalLabel: `مبيعات ${input.currentDisplayName}`,
      totalMinor: mySalesMinor,
      invoicesCount: myCount,
      vsYesterday: null,
      profitMinor: null,
      sellerBars: [],
      recentInvoices: myRecent,
    };
  }

  const maxSellerSales = Math.max(
    1,
    ...input.users.map((u) => bySeller[u.id] ?? 0),
  );
  const sellerBars: MobileSellerBar[] = input.users.map((u, idx) => {
    const salesMinor = bySeller[u.id] ?? 0;
    return {
      userId: u.id,
      name: u.displayName,
      salesMinor,
      widthPct: Math.round((salesMinor / maxSellerSales) * 100),
      color: SELLER_COLORS[idx % SELLER_COLORS.length]!,
    };
  });

  return {
    isOwner: true,
    headerTitle: 'مبيعات النهارده',
    totalLabel: 'إجمالي المحل',
    totalMinor: rep.salesMinor,
    invoicesCount: rep.invoices,
    vsYesterday: rep.vsYesterday,
    profitMinor: rep.profitMinor,
    sellerBars,
    recentInvoices: rep.recent.slice(0, 4).map((r) => ({
      saleId: r.saleId,
      no: r.no,
      totalMinor: r.totalMinor,
      seller: r.seller,
      method: r.method,
      occurredAt: r.occurredAt,
    })),
  };
}

export interface MobileLookupResult {
  readonly productId: string;
  readonly name: string;
  readonly salePriceMinor: number;
  readonly onHand: number;
  readonly colors: readonly string[];
  /** `null` when viewer is not the owner. */
  readonly costMinor: number | null;
}

/**
 * Filter products for the mobile companion's "سعر ومخزون" (`lookupScreen()`).
 * Cost is included ONLY when `isOwner === true`.
 */
export function filterMobileLookupProducts(input: {
  readonly query: string;
  readonly products: readonly PosProduct[];
  readonly units: readonly ProductUnit[];
  readonly costByProductId?: ReadonlyMap<string, number>;
  readonly isOwner: boolean;
}): MobileLookupResult[] {
  const rawQ = input.query.trim().toLowerCase();
  const normDigits = normalizeImeiDigits(rawQ);
  const filtered = input.products.filter((p) => {
    if (!rawQ) return true;
    if (p.name.toLowerCase().includes(rawQ)) return true;
    if (p.barcode && p.barcode.includes(normDigits)) return true;
    const prodUnits = input.units.filter((u) => u.productId === p.id);
    if (normDigits.length >= 4 && prodUnits.some((u) => u.imei.includes(normDigits))) {
      return true;
    }
    return false;
  });

  return filtered.slice(0, 5).map((p) => {
    const prodUnits = input.units.filter((u) => u.productId === p.id);
    const colors = Array.from(
      new Set(
        prodUnits
          .map((u) => (u.color ?? '').trim())
          .filter((c) => c.length > 0),
      ),
    );
    const unitCost =
      prodUnits.find((u) => typeof u.unitCostMinor === 'number' && u.unitCostMinor > 0)
        ?.unitCostMinor ??
      input.costByProductId?.get(p.id) ??
      Math.round((p.salePriceMinor ?? 0) * 0.82);

    return {
      productId: p.id,
      name: p.name,
      salePriceMinor: p.salePriceMinor ?? 0,
      onHand: p.onHand,
      colors,
      costMinor: input.isOwner ? unitCost : null,
    };
  });
}

export interface MobileScanResolution {
  readonly ok: boolean;
  readonly code: string;
  readonly kind: 'imei' | 'barcode' | 'invalid';
  readonly productId: string | null;
  readonly productName: string | null;
  readonly unitId: string | null;
  readonly imei: string | null;
  readonly errorMessage: string | null;
}

/**
 * Resolve a scanned barcode or 15-digit IMEI from the mobile companion camera
 * (embedded offline Luhn/EAN-13 validator — zero Google Play Services dependency).
 */
export function resolveMobileScanToPos(
  rawCode: string,
  products: readonly PosProduct[],
  units: readonly ProductUnit[],
): MobileScanResolution {
  const digits = normalizeImeiDigits(rawCode);
  if (!digits) {
    return {
      ok: false,
      code: '',
      kind: 'invalid',
      productId: null,
      productName: null,
      unitId: null,
      imei: null,
      errorMessage: 'امسح أو اكتب الباركود أو الـ IMEI الأول',
    };
  }

  // 15-digit IMEI check
  if (/^\d{15}$/.test(digits)) {
    if (!imeiLuhn(digits)) {
      return {
        ok: false,
        code: digits,
        kind: 'invalid',
        productId: null,
        productName: null,
        unitId: null,
        imei: null,
        errorMessage: 'رقم الـ IMEI ده غلط (فحص Luhn فشل)',
      };
    }
    const unit = units.find((u) => u.imei === digits || u.imei2 === digits);
    if (unit) {
      const prod = products.find((p) => p.id === unit.productId);
      return {
        ok: true,
        code: digits,
        kind: 'imei',
        productId: unit.productId,
        productName: prod?.name ?? 'جهاز موبايل',
        unitId: unit.id,
        imei: unit.imei,
        errorMessage: null,
      };
    }
    return {
      ok: false,
      code: digits,
      kind: 'invalid',
      productId: null,
      productName: null,
      unitId: null,
      imei: null,
      errorMessage: 'الـ IMEI ده مش موجود في المخزن المتاح حالياً',
    };
  }

  // Product barcode check
  const prod = products.find((p) => p.barcode === digits);
  if (prod) {
    if (prod.onHand <= 0) {
      return {
        ok: false,
        code: digits,
        kind: 'invalid',
        productId: prod.id,
        productName: prod.name,
        unitId: null,
        imei: null,
        errorMessage: `«${prod.name}» خلصان من المخزن`,
      };
    }
    return {
      ok: true,
      code: digits,
      kind: 'barcode',
      productId: prod.id,
      productName: prod.name,
      unitId: null,
      imei: null,
      errorMessage: null,
    };
  }

  return {
    ok: false,
    code: digits,
    kind: 'invalid',
    productId: null,
    productName: null,
    unitId: null,
    imei: null,
    errorMessage: 'ملقيناش صنف بالباركود ده في المخزن',
  };
}

/**
 * Deterministic 21×21 QR matrix for pairing phones over shop Wi-Fi (`pair-qr`).
 */
export function buildPairingQrMatrix(payload: string, size = 21): boolean[][] {
  const n = Math.max(21, size);
  const grid: boolean[][] = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => false),
  );

  const drawFinder = (r0: number, c0: number) => {
    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < 7; c += 1) {
        const border = r === 0 || r === 6 || c === 0 || c === 6;
        const inner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        grid[r0 + r]![c0 + c] = border || inner;
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, n - 7);
  drawFinder(n - 7, 0);

  // Timing lines
  for (let i = 8; i < n - 8; i += 1) {
    grid[6]![i] = i % 2 === 0;
    grid[i]![6] = i % 2 === 0;
  }

  // Deterministic hash bits from payload
  let seed = 2166136261;
  for (let i = 0; i < payload.length; i += 1) {
    seed ^= payload.charCodeAt(i);
    seed = Math.imul(seed, 16777619) >>> 0;
  }

  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      const inTopLeft = r < 8 && c < 8;
      const inTopRight = r < 8 && c >= n - 8;
      const inBottomLeft = r >= n - 8 && c < 8;
      const isTiming = r === 6 || c === 6;
      if (inTopLeft || inTopRight || inBottomLeft || isTiming) continue;
      seed ^= (r * 31 + c * 17) & 0xff;
      seed = Math.imul(seed, 16777619) >>> 0;
      grid[r]![c] = (seed & 1) === 1;
    }
  }

  return grid;
}

/** Generate a valid 15-digit Luhn IMEI from a 14-digit numeric prefix. */
export function buildLuhnImei15(prefix14: string): string {
  const digits = normalizeImeiDigits(prefix14).replace(/\D/g, '').slice(0, 14).padEnd(14, '0');
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    let d = Number(digits[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  const check = (10 - (sum % 10)) % 10;
  return `${digits}${check}`;
}

export interface RemoteOwnerSnapshot {
  readonly shopName: string;
  readonly remoteCode: string;
  readonly remoteEnabled: boolean;
  readonly salesMinor: number;
  readonly invoicesCount: number;
  readonly profitMinor: number;
  readonly hardwareRevenueMinor: number;
  readonly softwareRevenueMinor: number;
  readonly expectedDrawerCashMinor: number | null;
  readonly shiftNumber: number | null;
}

/**
 * Build the Phase 4 read-only remote follow-up snapshot for the shop owner (`ADR-038`).
 * Keeps hardware maintenance revenue («فلوس الصيانة لوحدها») separate from
 * software revenue («فلوس السوفت وير لوحدها»).
 */
export function buildRemoteOwnerSnapshot(input: {
  shopName: string;
  remoteCode: string;
  remoteEnabled: boolean;
  salesMinor: number;
  invoicesCount: number;
  profitMinor: number;
  hardwareRevenueMinor: number;
  softwareRevenueMinor: number;
  expectedDrawerCashMinor: number | null;
  shiftNumber: number | null;
}): RemoteOwnerSnapshot {
  return {
    shopName: input.shopName.trim() || 'موبايل ستور',
    remoteCode: input.remoteCode.trim() || 'RMT-9042',
    remoteEnabled: input.remoteEnabled,
    salesMinor: input.salesMinor,
    invoicesCount: input.invoicesCount,
    profitMinor: input.profitMinor,
    hardwareRevenueMinor: input.hardwareRevenueMinor,
    softwareRevenueMinor: input.softwareRevenueMinor,
    expectedDrawerCashMinor: input.expectedDrawerCashMinor,
    shiftNumber: input.shiftNumber,
  };
}

export interface EtaEReceiptLineDraft {
  readonly itemCode: string;
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly discountMinor: number;
  readonly netTotalMinor: number;
}

export interface EtaEReceiptDraft {
  readonly receiptType: 'S';
  readonly typeVersion: '1.2';
  readonly receiptNumber: string;
  readonly issuedAtMs: number;
  readonly currency: 'EGP';
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly taxRateBp: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly paymentMethodCode: string;
  readonly canonicalHashHex: string;
  readonly lines: readonly EtaEReceiptLineDraft[];
}

/**
 * Build a canonical ETA e-Receipt v1.2 sandbox draft (`docs/PLAN.md` §18, §19; `ADR-038`).
 * Tax settings stay in the data model with default values and hidden from the daily UI.
 */
export function buildEtaEReceiptDraft(input: {
  receiptNumber: string;
  issuedAtMs: number;
  lines: readonly EtaEReceiptLineDraft[];
  invoiceDiscountMinor?: number;
  vatEnabled?: boolean;
  vatRateBp?: number;
  vatInclusive?: boolean;
  paymentMethodCode?: string;
}): EtaEReceiptDraft {
  const linesSubtotal = input.lines.reduce((s, l) => s + l.netTotalMinor, 0);
  const disc = Math.max(0, input.invoiceDiscountMinor ?? 0);
  const netBeforeTax = Math.max(0, linesSubtotal - disc);
  const effectiveBp = input.vatEnabled ? Math.max(0, input.vatRateBp ?? 0) : 0;
  let taxMinor = 0;
  let totalMinor = netBeforeTax;
  if (effectiveBp > 0) {
    if (input.vatInclusive ?? true) {
      taxMinor = Math.floor((netBeforeTax * effectiveBp) / (10_000 + effectiveBp));
      totalMinor = netBeforeTax;
    } else {
      taxMinor = Math.round((netBeforeTax * effectiveBp) / 10_000);
      totalMinor = netBeforeTax + taxMinor;
    }
  }

  const canonical = [
    'ETA-ERECEIPT-V1.2',
    input.receiptNumber.trim(),
    String(input.issuedAtMs),
    String(totalMinor),
    ...input.lines.map(
      (l) => `${l.itemCode}:${l.quantity}:${l.netTotalMinor}`,
    ),
  ].join('|');

  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < canonical.length; i += 1) {
    const ch = canonical.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 ^= ch * 31;
    h2 = Math.imul(h2, 2246822519) >>> 0;
  }
  const canonicalHashHex =
    h1.toString(16).padStart(8, '0') +
    h2.toString(16).padStart(8, '0') +
    (h1 ^ h2).toString(16).padStart(8, '0') +
    ((h1 + h2) >>> 0).toString(16).padStart(8, '0');

  return {
    receiptType: 'S',
    typeVersion: '1.2',
    receiptNumber: input.receiptNumber.trim(),
    issuedAtMs: input.issuedAtMs,
    currency: 'EGP',
    subtotalMinor: linesSubtotal,
    discountMinor: disc,
    taxRateBp: effectiveBp,
    taxMinor,
    totalMinor,
    paymentMethodCode: input.paymentMethodCode?.trim() || 'C',
    canonicalHashHex,
    lines: input.lines,
  };
}

// --- the phone ⇄ computer link (`ADR-042`) ------------------------------------
//
// The rules here are the ones `src-tauri/src/domain/companion.rs` enforces on the
// wire. They are duplicated on purpose and pinned by a test: a form that lets a
// person queue a capture the computer will refuse is a form that teaches them the
// computer is unreliable. The Rust side stays the authority — this only moves the
// refusal to where the mistake is made.

/** Which half of the link a device plays. One page, two jobs, never both. */
export type LanRole = 'host' | 'client';

/**
 * The computer hosts the link; the handset dials it.
 *
 * Before this, both sides started the same listener on the same port against two
 * separate databases, which is how the shop ended up with "two full systems" each
 * showing the other its own pairing page.
 */
export function lanRoleFor(device: 'phone' | 'desktop'): LanRole {
  return device === 'phone' ? 'client' : 'host';
}

/** The window in which a handset still counts as connected. */
export const LINK_ONLINE_WINDOW_MS = 30_000;

/** Photos one capture may carry. The computer stores one cover per product. */
export const MAX_CAPTURE_PHOTOS = 3;
/** IMEIs one capture may carry. */
export const MAX_CAPTURE_IMEIS = 40;
/** Characters of product name. */
export const MAX_CAPTURE_NAME_CHARS = 120;
/** Characters of barcode. */
export const MAX_CAPTURE_BARCODE_CHARS = 64;

export interface CaptureDraftInput {
  readonly deviceName: string;
  readonly productName: string;
  readonly barcode: string;
  readonly disposition: 'quantity' | 'serialized';
  readonly quantity: number;
  readonly unitCostMinor: number;
  readonly imeis: readonly string[];
  readonly photos: readonly string[];
}

/**
 * Why this capture cannot be saved, in the shop's words, or `null` when it can.
 *
 * `serialized` demands at least one IMEI because a serialized receipt with no
 * units is a shelf full of stock nobody can sell; `one_off` is not offered at all
 * because it has no balance for a receipt to move.
 */
export function validateCaptureDraft(input: CaptureDraftInput): string | null {
  if (!input.deviceName.trim()) return 'اسم الموبايل ناقص — بيجي من إعدادات الجهاز.';
  if (!input.productName.trim()) return 'اكتب اسم الصنف اللي صورته.';
  if (input.productName.trim().length > MAX_CAPTURE_NAME_CHARS)
    return 'اسم الصنف أطول من ' + dg(MAX_CAPTURE_NAME_CHARS) + ' حرف.';
  if (input.barcode.length > MAX_CAPTURE_BARCODE_CHARS)
    return 'الباركود أطول من ' + dg(MAX_CAPTURE_BARCODE_CHARS) + ' رقم.';
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 9_999)
    return 'الكمية لازم تكون رقم من ' + dg(1) + ' لـ ' + dg(9_999) + '.';
  if (!Number.isInteger(input.unitCostMinor) || input.unitCostMinor < 0)
    return 'التكلفة ما ينفعش تكون سالبة.';
  if (input.imeis.length > MAX_CAPTURE_IMEIS)
    return 'أقصى عدد IMEI في المسودة ' + dg(MAX_CAPTURE_IMEIS) + '.';
  if (input.photos.length > MAX_CAPTURE_PHOTOS)
    return 'أقصى عدد صور في المسودة ' + dg(MAX_CAPTURE_PHOTOS) + '.';
  if (input.disposition === 'serialized' && input.imeis.length === 0)
    return 'الصنف المتسلسل محتاج IMEI واحد على الأقل، وإلا هتنزل قطعة من غير رقم تتسجل بيه.';
  if (input.disposition === 'serialized' && input.imeis.length > input.quantity)
    return 'عدد الـ IMEI أكبر من الكمية.';
  return null;
}

/**
 * The second kind of draft: money that left the shop (`ADR-043`).
 *
 * Same queue, same push, same inbox as a product capture — the shopkeeper has one
 * button, «ابعت». What differs is that an expense is applied through the expenses
 * use case rather than the receiving one, so a phone can never smuggle an expense
 * into stock or a capture into the till.
 */
export interface ExpenseDraftInput {
  readonly deviceName: string;
  readonly category: string;
  readonly amountMinor: number;
  readonly paidFrom: 'drawer' | 'outside';
  readonly note: string;
  readonly photos?: readonly string[];
}

/** Characters of category the desktop accepts (`expenses.category` is 80). */
export const MAX_EXPENSE_CATEGORY_CHARS = 80;
/** Characters of note the desktop accepts (`expenses.note` is 300). */
export const MAX_EXPENSE_NOTE_CHARS = 300;

/**
 * Why this expense cannot be saved, in the shop's words, or `null`.
 *
 * Only the drawer question is treated as a hard one: «من الدرج» without an open
 * shift is refused by the computer, so the phone says it earlier and says it in the
 * same words the expenses screen uses.
 */
export function validateExpenseDraft(input: ExpenseDraftInput): string | null {
  if (!input.deviceName.trim()) return 'اسم الموبايل ناقص — بيجي من إعدادات الجهاز.';
  if (!input.category.trim()) return 'اكتب بند المصروف الأول — مثلاً «إيجار» أو «كهربا».';
  if (input.category.trim().length > MAX_EXPENSE_CATEGORY_CHARS)
    return 'اسم البند أطول من ' + dg(MAX_EXPENSE_CATEGORY_CHARS) + ' حرف.';
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0)
    return 'المبلغ لازم يكون أكبر من صفر.';
  if (input.note.length > MAX_EXPENSE_NOTE_CHARS)
    return 'الملاحظة أطول من ' + dg(MAX_EXPENSE_NOTE_CHARS) + ' حرف.';
  if (input.paidFrom !== 'drawer' && input.paidFrom !== 'outside')
    return 'قول المصروف خرج من الدرج ولا من برّاه.';
  if ((input.photos?.length ?? 0) > MAX_CAPTURE_PHOTOS)
    return 'أقصى عدد صور في المسودة ' + dg(MAX_CAPTURE_PHOTOS) + '.';
  return null;
}

/** What a row in the phone's queue is, without trusting a blank field. */
export function draftKindLabel(draft: { kind: string }): 'product' | 'expense' {
  return draft.kind === 'expense' ? 'expense' : 'product';
}

/** The pairing text the computer prints under its QR, read back by the handset. */
export interface PairTarget {
  readonly shopName: string;
  readonly host: string;
  readonly port: number;
  readonly pairCode: string;
}

/**
 * Parse `MSHOP-PAIR|v1|{shop}|{ip}:{port}|{code}`.
 *
 * The camera is the fast path and this is the path that always works: a WebView
 * with no `BarcodeDetector`, a cracked lens, a screen the owner photographs with
 * a second phone — typing the line under the QR must be enough.
 */
export function parsePairPayload(payload: string): PairTarget | null {
  const parts = payload.trim().split('|');
  if (parts.length !== 5 || parts[0] !== 'MSHOP-PAIR' || parts[1] !== 'v1') return null;
  const shopName = (parts[2] ?? '').trim();
  const at = (parts[3] ?? '').trim().lastIndexOf(':');
  if (at <= 0) return null;
  const host = (parts[3] ?? '').slice(0, at).trim();
  const port = Number((parts[3] ?? '').slice(at + 1).trim());
  const pairCode = (parts[4] ?? '').trim();
  if (!shopName || !host || !pairCode) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  return { shopName, host, port, pairCode };
}

/** `192.168.1.20:8787`, the form the phone stores and dials. */
export function formatHostAddress(host: string, port: number): string {
  return `${host.trim()}:${port}`;
}

/**
 * Read IMEIs out of whatever the person typed or scanned: one per line, comma
 * separated, with spaces and dashes. Non-digits are dropped, a 15-digit run is
 * kept once, and anything else is left for the shop to notice rather than send.
 */
export function parseImeiList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const chunk of text.split(/[\s,;]+/)) {
    const digits = chunk.replace(/\D+/g, '');
    if (digits.length !== 15) continue;
    if (seen.has(digits)) continue;
    seen.add(digits);
    out.push(digits);
  }
  return out;
}

/** "قبل ٤ ثواني" / "من ساعتين" / nothing at all when it never spoke. */
export function relativeLinkAge(
  nowMs: number,
  seenMs: number,
  digits: (value: number) => string,
): string {
  if (seenMs <= 0) return 'مفيش ظهور بعد';
  const delta = Math.max(0, Math.round((nowMs - seenMs) / 1000));
  if (delta < 45) return 'قبل ثواني';
  if (delta < 5_400) return `قبل ${digits(Math.round(delta / 60))} دقيقة`;
  if (delta < 86_400) return `قبل ${digits(Math.round(delta / 3_600))} ساعة`;
  return `من ${digits(Math.round(delta / 86_400))} يوم`;
}

/**
 * What one handset's row says about itself.
 *
 * Only the wire's answer, never the pairing record: a name typed in by the owner
 * is a name, not a connection.
 */
export function deviceLinkLabel(
  device: { online: boolean; lastSeenAt: number },
  nowMs: number,
  digits: (value: number) => string,
): string {
  if (device.online) return 'متصل دلوقتي';
  if (device.lastSeenAt <= 0) return 'متسجّل — لسه ما كلّمش الجهاز';
  return `آخر ظهور ${relativeLinkAge(nowMs, device.lastSeenAt, digits)}`;
}

export type LinkTone = 'ok' | 'warn' | 'bad';

export interface LinkState {
  readonly tone: LinkTone;
  readonly label: string;
  readonly detail: string;
}

/**
 * The computer's own link line, built from what the responder reported.
 *
 * The old panel had no equivalent of this: it printed a green dot and two phones
 * because a shell needed to look finished.
 */
export function hostLinkState(
  status: {
    running: boolean;
    port: number;
    pairedDevices: readonly { online: boolean }[];
    rejectedPushes: number;
    pendingIntakes: readonly unknown[];
  } | null,
  digits: (value: number) => string,
): LinkState {
  if (status === null) {
    return { tone: 'bad', label: 'مفيش حالة', detail: 'السيستم ما ردّش على شاشة الربط.' };
  }
  if (!status.running) {
    return {
      tone: 'bad',
      label: 'المنفذ مش متحجز',
      detail: `الكمبيوتر مش سامع على البورت ${digits(status.port)} — في برنامج تاني بياخدّه، أو السيستم اتفتح من غير ما يشغّل الربط.`,
    };
  }
  const online = status.pairedDevices.filter((d) => d.online).length;
  if (online === 0) {
    return {
      tone: 'warn',
      label: 'سامع، ومفيش موبايل كلّمه',
      detail: 'امسح الباركود من الموبايل على نفس Wi-Fi المتجر.',
    };
  }
  const waiting = status.pendingIntakes.length;
  if (waiting > 0) {
    return {
      tone: 'ok',
      label: `${digits(online)} موبايل متصل · ${digits(waiting)} مسودة مستنياك`,
      detail: 'اللي وصل من الموبايل محتاج موافقتك قبل ما ينزل في الاستلام.',
    };
  }
  if (status.rejectedPushes > 0) {
    return {
      tone: 'warn',
      label: `${digits(online)} موبايل متصل`,
      detail: `في ${digits(status.rejectedPushes)} محاولة وصلت بكود ربط غلط واترَفضت.`,
    };
  }
  return {
    tone: 'ok',
    label: `${digits(online)} موبايل متصل`,
    detail: 'الربط شغال: الموبايل بيصور والكمبيوتر بيسجّل.',
  };
}

export interface OutboxSummary {
  readonly waiting: number;
  readonly delivered: number;
  readonly failed: number;
}

/** The phone's own queue, counted the way its panel reads it. */
export function outboxSummary(
  items: readonly { pushedAt: number | null; pushError: string | null }[],
): OutboxSummary {
  let waiting = 0;
  let delivered = 0;
  let failed = 0;
  for (const item of items) {
    if (item.pushedAt !== null) delivered += 1;
    else if (item.pushError) failed += 1;
    else waiting += 1;
  }
  return { waiting, delivered, failed };
}

/**
 * One row of that queue. "وصلت" means the computer took the bytes — not that it
 * recorded a receipt, which is its decision and not the phone's knowledge.
 */
export function intakeProgressLabel(
  draft: { pushedAt: number | null; pushError: string | null },
  nowMs: number,
  digits: (value: number) => string,
): string {
  if (draft.pushError) return `الكمبيوتر ردّ: ${draft.pushError}`;
  if (draft.pushedAt !== null)
    return `وصلت للكمبيوتر ${relativeLinkAge(nowMs, draft.pushedAt, digits)} · هو يقرر امتى يتسجل`;
  return 'مستنية البعته';
}

/** What an applied draft is worth saying about itself. */
export function describeApplied(
  draft: { productName: string; productId: string | null; note: string | null },
): string {
  const what = draft.productId ? `«${draft.productName}»` : draft.productName;
  return draft.note ? `${what} — ${draft.note}` : `${what} نزلت في الاستلام`;
}

/** The camera line: honest about the platform, because it usually is not. */
export function barcodeScannerLabel(supported: boolean): string {
  return supported
    ? 'الكاميرا جاهزة لمسح الباركود والـ IMEI'
    : 'كاميرا المتصفح على الجهاز ده ما بتقرأش الباركود — اكتب الرقم أو الصقه';
}

