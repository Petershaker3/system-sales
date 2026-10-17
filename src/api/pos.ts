/**
 * The sales screen's catalogue (`pos_catalog`, plan item 1.6).
 *
 * Readable by a seller (`Sell`). Active products with price, barcode,
 * category, stock on hand and units sold in the last 30 days, plus the live
 * categories in the owner's order (ADR-018 §1). It carries no cost of any kind.
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
  readonly categoryId: string | null;
  readonly onHand: number;
  readonly soldRecently: number;
}

/** A category: `parentId` null for a main one; hidden ones get no chip. */
export interface PosCategory {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly kind: 'item' | 'phone' | 'used';
  readonly icon: string;
  readonly hidden: boolean;
  readonly sortOrder: number;
}

export interface PosCatalog {
  readonly products: readonly PosProduct[];
  readonly categories: readonly PosCategory[];
}

export function posCatalog(): Promise<PosCatalog> {
  return invoke<PosCatalog>('pos_catalog');
}
