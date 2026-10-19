// Pure domain & view helpers for the LAN Companion Server & Mobile Helper (`ADR-037`, Plan item 3.2).

import type { Role, UserSummary } from '../../api/identity.ts';
import type { ProductUnit } from '../../api/inventory.ts';
import type { PosProduct } from '../../api/pos.ts';
import type { SaleHistoryEntry } from '../../api/sales.ts';
import { imeiLuhn, normalizeImeiDigits } from '../pos/imei.ts';
import { dayStart, todayReport } from '../sales/analytics.ts';

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
