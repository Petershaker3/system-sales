/**
 * Stock and costing API (SP-2, `ADR-013`, `ADR-015`).
 *
 * A thin typed wrapper over `invoke`, mirroring `pattern.ts`. Every function is a
 * use case that already exists in Rust; this file decides nothing about
 * permission, rounding or cost. In particular it never computes an average — the
 * ceiling rule lives in `domain/costing` and the value comes back from Rust
 * already rounded.
 *
 * `totalCostMinor` is nullable and the null is meaningful: `null` means FIFO
 * holds the cost, `0` would mean free stock. Nothing here collapses them.
 */

import { invoke } from '@tauri-apps/api/core';

import type { CostMethod } from './departments';

/** One FIFO layer: a quantity at the unit cost it arrived with. */
export interface FifoLayer {
  readonly quantity: number;
  readonly unitCostMinor: number;
}

/**
 * A product's stock position, and which representation owns the cost.
 *
 * `effectiveCostMinor` is derived in Rust, never stored: the stored total drifts
 * under Moving Average and the layers are the truth under FIFO, so the panel is
 * handed one number whichever method is in charge.
 */
export interface StockPosition {
  readonly productId: string;
  readonly quantity: number;
  /** `null` when the method is FIFO. Not the same as zero. */
  readonly totalCostMinor: number | null;
  readonly costMethod: CostMethod;
  readonly effectiveCostMinor: number;
  /** Oldest first. Empty unless the method is FIFO. */
  readonly layers: readonly FifoLayer[];
}

/** What one movement changed. */
export interface StockOutcome {
  readonly productId: string;
  readonly quantity: number;
  /** Cost of the units removed; zero for a receipt. */
  readonly costMinor: number;
}

/**
 * Receive stock at a known unit cost. Routine work: no re-authentication.
 * Refuses a negative quantity or unit cost (`COST_*`).
 *
 * `supplierName` is the operator's own label for who delivered it (decision D1):
 * optional, and blank means nobody named one. There is no supplier registry and
 * no purchase document — the shop's supplier list is derived from the receipts
 * themselves, so this is a label on one delivery and nothing more.
 */
export async function receiveStock(
  productId: string,
  quantity: number,
  unitCostMinor: number,
  supplierName?: string
): Promise<StockOutcome> {
  return invoke<StockOutcome>('receive_stock', {
    productId,
    quantity,
    unitCostMinor,
    supplierName: supplierName ?? null,
  });
}

/**
 * Remove stock and report what it cost under the governing method.
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

/**
 * Switch a department's costing method, converting the stock it already holds.
 *
 * Sensitive: re-authentication, and the Pattern when protection is on. This is the
 * only path that may change the method — an ordinary department edit refuses it,
 * because relabelling a department without converting its stock would state a
 * cost the stock does not have.
 */
export async function switchCostMethod(
  departmentId: string,
  target: CostMethod
): Promise<void> {
  return invoke<void>('switch_cost_method', { departmentId, target });
}