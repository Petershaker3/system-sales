/**
 * The sales screen's catalogue (`pos_catalog`, plan item 1.6).
 *
 * Readable by a seller (`Sell`). Active products with price, barcode,
 * department, stock on hand and units sold in the last 30 days, plus active
 * departments in the owner's order. It carries no cost of any kind.
 */

import { invoke } from '@tauri-apps/api/core';

export type Disposition = 'quantity' | 'serialized' | 'one_off';

export interface PosProduct {
  readonly id: string;
  readonly name: string;
  readonly disposition: Disposition;
  readonly barcode: string | null;
  /** `null` when no price was ever set: such a product cannot be sold yet. */
  readonly salePriceMinor: number | null;
  readonly departmentId: string | null;
  readonly onHand: number;
  readonly soldRecently: number;
}

export interface PosDepartment {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
}

export interface PosCatalog {
  readonly products: readonly PosProduct[];
  readonly departments: readonly PosDepartment[];
}

export function posCatalog(): Promise<PosCatalog> {
  return invoke<PosCatalog>('pos_catalog');
}
