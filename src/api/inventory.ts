/**
 * Stock and costing API (SP-2, `ADR-013`, `ADR-015`).
 *
 * A thin typed wrapper over `invoke`, like the other `api/` files. Every function is a
 * use case that already exists in Rust; this file decides nothing about
 * permission, rounding or cost. In particular it never computes an average — the
 * ceiling rule lives in `domain/costing` and the value comes back from Rust
 * already rounded.
 *
 * Every product counted by quantity is costed by moving average (ADR-016 #7);
 * FIFO and switching the method were retired in plan item 1.3.
 *
 * `totalCostMinor` is nullable and the null is meaningful: `null` means the
 * product was never stocked, `0` would mean free stock. Nothing here collapses
 * them.
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * A product's stock position.
 *
 * `effectiveCostMinor` comes from Rust: the moving-average total, or zero for a
 * product nobody has received yet.
 */
export interface StockPosition {
  readonly productId: string;
  readonly quantity: number;
  /** `null` when the product was never stocked. Not the same as zero. */
  readonly totalCostMinor: number | null;
  readonly effectiveCostMinor: number;
}

/** What one movement changed. */
export interface StockOutcome {
  readonly productId: string;
  readonly quantity: number;
  /** Cost of the units removed; zero for a receipt. */
  readonly costMinor: number;
}

/** One registered `in_stock` device unit (`ADR-019`, `ADR-032`). */
export interface ProductUnit {
  readonly id: string;
  readonly productId: string;
  readonly imei: string;
  readonly imei2: string | null;
  readonly color: string | null;
  readonly unitCostMinor?: number;
  readonly conditionGrade?: 'A' | 'B' | 'C' | string | null;
  readonly batteryHealthPct?: number | null;
  readonly accessories?: string | null;
  readonly intakeNote?: string | null;
  readonly sellerName?: string | null;
  readonly sellerPhone?: string | null;
  readonly sellerNationalId?: string | null;
  readonly createdAt: number;
}

/**
 * Receive stock at a known unit cost. Routine work: no re-authentication.
 * Refuses a negative quantity or unit cost (`COST_*`).
 *
 * `supplierName` is the operator's own label for who delivered it (decision D1):
 * optional, and blank means nobody named one. There is no supplier registry and
 * no purchase document — the shop's supplier list is derived from the receipts
 * themselves, so this is a label on one delivery and nothing more.
 *
 * `imeis` is the optional list of 15-digit Luhn-checked IMEIs for serialized
 * products (`ADR-019`).
 */
export async function receiveStock(
  productId: string,
  quantity: number,
  unitCostMinor: number,
  supplierName?: string,
  imeis?: readonly string[]
): Promise<StockOutcome> {
  return invoke<StockOutcome>('receive_stock', {
    productId,
    quantity,
    unitCostMinor,
    supplierName: supplierName ?? null,
    imeis: imeis ? [...imeis] : null,
  });
}

/**
 * Receive first-time opening stock already on the shelf (`ADR-016` #30, `ADR-019`).
 * Sensitive: spends one owner PIN approval (`OWNER_APPROVAL_REQUIRED` without one)
 * and takes no supplier name.
 */
export async function receiveOpeningStock(
  productId: string,
  quantity: number,
  unitCostMinor: number,
  imeis?: readonly string[]
): Promise<StockOutcome> {
  return invoke<StockOutcome>('receive_opening_stock', {
    productId,
    quantity,
    unitCostMinor,
    imeis: imeis ? [...imeis] : null,
  });
}

/** List registered `in_stock` device units for a product (`ADR-019`). */
export async function listProductUnits(productId: string): Promise<ProductUnit[]> {
  return invoke<ProductUnit[]>('list_product_units', { productId });
}

/** List all registered `in_stock` device units across all active products (`ADR-034`, Plan item 2.4). */
export async function listAllProductUnits(): Promise<ProductUnit[]> {
  return invoke<ProductUnit[]>('list_all_product_units');
}

/** One product's physical count input during a Stock Count reconciliation (`ADR-034`). */
export interface StockCountItemInput {
  readonly productId: string;
  readonly countedQuantity: number;
  readonly missingUnitIds?: readonly string[];
  readonly unitCostMinor?: number | null;
}

/** Summary of what a Stock Count reconciliation changed (`ADR-034`). */
export interface StockCountReconcileOutcome {
  readonly adjustedProducts: number;
  readonly retiredUnits: number;
  readonly netQuantityDelta: number;
  readonly netCostDeltaMinor: number;
}

/**
 * Reconcile physical stock count discrepancies and missing IMEI units (`ADR-034`, Plan item 2.4).
 * Sensitive: requires `Permission::ManageInventory` and spends one Owner PIN approval.
 */
export async function reconcileStockCount(
  reason: string,
  items: readonly StockCountItemInput[]
): Promise<StockCountReconcileOutcome> {
  return invoke<StockCountReconcileOutcome>('reconcile_stock_count', {
    reason,
    items: items.map((item) => ({
      productId: item.productId,
      countedQuantity: item.countedQuantity,
      missingUnitIds: item.missingUnitIds ? [...item.missingUnitIds] : [],
      unitCostMinor: item.unitCostMinor ?? null,
    })),
  });
}

/**
 * Remove stock and report what it cost at the moving average.
 * Refused whole when there is not enough on hand (`COST_INSUFFICIENT_STOCK`) —
 * never partially applied.
 */
export async function removeStock(productId: string, quantity: number): Promise<StockOutcome> {
  return invoke<StockOutcome>('remove_stock', { productId, quantity });
}

/**
 * Read a position. Costs money, so it is gated behind a freshly proven password
 * exactly like the wholesale figures are; expect `REAUTHENTICATION_REQUIRED`.
 */
export async function getPosition(productId: string): Promise<StockPosition> {
  return invoke<StockPosition>('get_position', { productId });
}
