// Pure domain helpers for Phase 2 Item 2.4: الجرد بالمسح (`Stock Count`) (`ADR-034`).
// Handles barcode & 15-digit IMEI scan resolution, missing-IMEI detection,
// discrepancy summaries, and reconciliation payload generation.

import type { StockCountItemInput } from '../../api/inventory.ts';
import { toLatinDigits } from '../../ui/format.ts';

export type StockCountScope = 'all' | 'imei' | 'items';
export type StockCountFilterTab = 'all' | 'discrepancies' | 'missing_imeis' | 'matched';

export const STOCK_COUNT_REASONS: readonly string[] = [
  'جرد دوري للمخزن',
  'عجز ظهر في الجرد',
  'تالف أو مفقود على الرف',
  'بضاعة لقيناها في الجرد',
];

export interface StockCountUnitState {
  readonly id: string;
  readonly productId: string;
  readonly productName: string;
  readonly imei: string;
  readonly imei2: string | null;
  readonly color: string | null;
  readonly conditionGrade: string | null;
  readonly batteryHealthPct: number | null;
  readonly unitCostMinor: number;
  readonly scanned: boolean;
}

export interface StockCountRowState {
  readonly productId: string;
  readonly name: string;
  readonly categoryId: string | null;
  readonly categoryLabel: string;
  readonly barcode: string | null;
  readonly isSerialized: boolean;
  readonly expectedQty: number;
  readonly countedQty: number;
  readonly touched: boolean;
  readonly units: readonly StockCountUnitState[];
}

export type ScanResolution =
  | {
      readonly kind: 'matched_imei';
      readonly unit: StockCountUnitState;
      readonly row: StockCountRowState;
      readonly nextRows: readonly StockCountRowState[];
    }
  | {
      readonly kind: 'duplicate_imei';
      readonly unit: StockCountUnitState;
      readonly row: StockCountRowState;
    }
  | {
      readonly kind: 'unknown_imei';
      readonly query: string;
    }
  | {
      readonly kind: 'matched_barcode';
      readonly row: StockCountRowState;
      readonly nextRows: readonly StockCountRowState[];
    }
  | {
      readonly kind: 'not_found';
      readonly query: string;
    };

/**
 * Build initial Stock Count rows from active products and their `in_stock` IMEI units.
 *
 * - For products with registered `in_stock` IMEI units: each registered unit starts
 *   with `scanned = false` so scanning devices on the shelf immediately reveals which
 *   IMEIs are still missing (`countedQty` starts at any unregistered quantity on hand,
 *   and increments by +1 as each IMEI is scanned).
 * - For quantity-only products without registered IMEIs: `countedQty` starts equal to
 *   `expectedQty` (`touched = false`), and scanning a barcode or typing a count updates it.
 */
export function createStockCountRows(
  products: readonly {
    readonly id: string;
    readonly name: string;
    readonly categoryId: string | null;
    readonly categoryLabel: string;
    readonly barcode: string | null;
    readonly isSerialized: boolean;
    readonly onHand: number;
  }[],
  units: readonly {
    readonly id: string;
    readonly productId: string;
    readonly imei: string;
    readonly imei2: string | null;
    readonly color: string | null;
    readonly conditionGrade?: string | null;
    readonly batteryHealthPct?: number | null;
    readonly unitCostMinor?: number;
  }[]
): StockCountRowState[] {
  const unitsByProduct = new Map<string, StockCountUnitState[]>();
  const productNames = new Map<string, string>(products.map((p) => [p.id, p.name]));

  for (const u of units) {
    const list = unitsByProduct.get(u.productId) ?? [];
    list.push({
      id: u.id,
      productId: u.productId,
      productName: productNames.get(u.productId) ?? '',
      imei: u.imei,
      imei2: u.imei2 ?? null,
      color: u.color ?? null,
      conditionGrade: u.conditionGrade ?? null,
      batteryHealthPct: u.batteryHealthPct ?? null,
      unitCostMinor: u.unitCostMinor ?? 0,
      scanned: false,
    });
    unitsByProduct.set(u.productId, list);
  }

  return products.map((p) => {
    const pUnits = unitsByProduct.get(p.id) ?? [];
    const hasUnits = pUnits.length > 0;
    const unregQty = Math.max(0, p.onHand - pUnits.length);
    return {
      productId: p.id,
      name: p.name,
      categoryId: p.categoryId,
      categoryLabel: p.categoryLabel,
      barcode: p.barcode,
      isSerialized: p.isSerialized || hasUnits,
      expectedQty: p.onHand,
      countedQty: hasUnits ? unregQty : p.onHand,
      touched: false,
      units: pUnits,
    };
  });
}

/**
 * Resolve a barcode or IMEI scan against the current Stock Count rows.
 */
export function resolveScanInput(
  rows: readonly StockCountRowState[],
  rawInput: string
): ScanResolution {
  const clean = toLatinDigits(rawInput).trim();
  if (!clean) {
    return { kind: 'not_found', query: '' };
  }

  // 1. Check exact IMEI / IMEI2 match across all in-stock units.
  const allUnits: { row: StockCountRowState; unit: StockCountUnitState }[] = [];
  for (const row of rows) {
    for (const unit of row.units) {
      allUnits.push({ row, unit });
    }
  }

  let matchedPair = allUnits.find(
    ({ unit }) => unit.imei === clean || (unit.imei2 !== null && unit.imei2 === clean)
  );

  // Also allow scanning/typing last 4..14 digits if they uniquely identify one in_stock IMEI unit.
  if (!matchedPair && /^\d{4,14}$/.test(clean)) {
    const suffixMatches = allUnits.filter(
      ({ unit }) =>
        unit.imei.endsWith(clean) || (unit.imei2 !== null && unit.imei2.endsWith(clean))
    );
    if (suffixMatches.length === 1) {
      matchedPair = suffixMatches[0];
    }
  }

  if (matchedPair) {
    if (matchedPair.unit.scanned) {
      return {
        kind: 'duplicate_imei',
        unit: matchedPair.unit,
        row: matchedPair.row,
      };
    }
    const nextRows = toggleUnitScanned(rows, matchedPair.unit.id, true);
    const updatedRow =
      nextRows.find((r) => r.productId === matchedPair.row.productId) ?? matchedPair.row;
    const updatedUnit =
      updatedRow.units.find((u) => u.id === matchedPair.unit.id) ?? matchedPair.unit;
    return {
      kind: 'matched_imei',
      unit: updatedUnit,
      row: updatedRow,
      nextRows,
    };
  }

  // 2. If the input is 15 digits (an IMEI) and didn't match any in_stock unit, report unknown IMEI.
  if (/^\d{15}$/.test(clean)) {
    return { kind: 'unknown_imei', query: clean };
  }

  // 3. Check product barcode match.
  const barcodeRow = rows.find(
    (r) => r.barcode !== null && toLatinDigits(r.barcode).trim() === clean
  );
  if (barcodeRow) {
    // If the counted item hasn't been scanned yet, start at 1 on first scan; otherwise +1.
    const nextCount = barcodeRow.touched ? barcodeRow.countedQty + 1 : 1;
    const nextRows = setRowCountedQty(rows, barcodeRow.productId, nextCount);
    const updatedRow =
      nextRows.find((r) => r.productId === barcodeRow.productId) ?? barcodeRow;
    return {
      kind: 'matched_barcode',
      row: updatedRow,
      nextRows,
    };
  }

  return { kind: 'not_found', query: clean };
}

/**
 * Mark a specific `in_stock` IMEI unit as scanned (`true`) or missing (`false`),
 * automatically recalculating its parent product's `countedQty`.
 */
export function toggleUnitScanned(
  rows: readonly StockCountRowState[],
  unitId: string,
  scanned: boolean
): StockCountRowState[] {
  return rows.map((row) => {
    const hasUnit = row.units.some((u) => u.id === unitId);
    if (!hasUnit) return row;

    const nextUnits = row.units.map((u) =>
      u.id === unitId ? { ...u, scanned } : u
    );
    const scannedCount = nextUnits.filter((u) => u.scanned).length;
    const unregQty = Math.max(0, row.expectedQty - nextUnits.length);
    return {
      ...row,
      units: nextUnits,
      countedQty: unregQty + scannedCount,
      touched: true,
    };
  });
}

/**
 * Update a product row's physical `countedQty`.
 * If `countedQty >= expectedQty` on a serialized product, all its units are marked `scanned = true`.
 */
export function setRowCountedQty(
  rows: readonly StockCountRowState[],
  productId: string,
  countedQty: number
): StockCountRowState[] {
  const safeQty = Math.max(0, Math.round(countedQty));
  return rows.map((row) => {
    if (row.productId !== productId) return row;
    if (row.units.length > 0 && safeQty >= row.expectedQty) {
      return {
        ...row,
        countedQty: safeQty,
        touched: true,
        units: row.units.map((u) => ({ ...u, scanned: true })),
      };
    }
    return {
      ...row,
      countedQty: safeQty,
      touched: true,
    };
  });
}

/**
 * Mark all unscanned IMEI units and untouched rows as matching system stock.
 */
export function markAllRowsMatched(
  rows: readonly StockCountRowState[]
): StockCountRowState[] {
  return rows.map((row) => ({
    ...row,
    countedQty: row.expectedQty,
    touched: true,
    units: row.units.map((u) => ({ ...u, scanned: true })),
  }));
}

export interface StockCountSummary {
  readonly totalProducts: number;
  readonly matchedProducts: number;
  readonly discrepancyProducts: number;
  readonly totalUnits: number;
  readonly scannedUnits: number;
  readonly missingUnits: readonly StockCountUnitState[];
  readonly shortageQtyTotal: number;
  readonly surplusQtyTotal: number;
  readonly missingUnitsCostMinor: number;
}

/**
 * Compute live KPIs and the list of missing IMEI units for the Stock Count screen.
 */
export function computeStockCountSummary(
  rows: readonly StockCountRowState[]
): StockCountSummary {
  let matchedProducts = 0;
  let discrepancyProducts = 0;
  let totalUnits = 0;
  let scannedUnits = 0;
  const missingUnits: StockCountUnitState[] = [];
  let shortageQtyTotal = 0;
  let surplusQtyTotal = 0;
  let missingUnitsCostMinor = 0;

  for (const row of rows) {
    let rowMissingUnits = 0;
    for (const u of row.units) {
      totalUnits += 1;
      if (u.scanned) {
        scannedUnits += 1;
      } else {
        rowMissingUnits += 1;
        missingUnits.push(u);
        missingUnitsCostMinor += u.unitCostMinor;
      }
    }

    const diff = row.countedQty - row.expectedQty;
    if (diff === 0 && rowMissingUnits === 0) {
      matchedProducts += 1;
    } else {
      discrepancyProducts += 1;
      if (diff < 0) {
        shortageQtyTotal += -diff;
      } else if (diff > 0) {
        surplusQtyTotal += diff;
      }
    }
  }

  return {
    totalProducts: rows.length,
    matchedProducts,
    discrepancyProducts,
    totalUnits,
    scannedUnits,
    missingUnits,
    shortageQtyTotal,
    surplusQtyTotal,
    missingUnitsCostMinor,
  };
}

/**
 * Build the reconciliation items payload for `reconcile_stock_count`.
 * Only rows with a quantity discrepancy or missing IMEI units are included.
 */
export function buildReconcilePayload(
  rows: readonly StockCountRowState[]
): StockCountItemInput[] {
  const items: StockCountItemInput[] = [];
  for (const row of rows) {
    const missingUnitIds = row.units.filter((u) => !u.scanned).map((u) => u.id);
    if (row.countedQty !== row.expectedQty || missingUnitIds.length > 0) {
      items.push({
        productId: row.productId,
        countedQuantity: row.countedQty,
        missingUnitIds,
      });
    }
  }
  return items;
}
