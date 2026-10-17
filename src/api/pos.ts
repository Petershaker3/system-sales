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
  /** The phone's company (ADR-018 §2), or `null` for anything but a phone. */
  readonly brandId: string | null;
  /** The variant parent this product belongs to (ADR-018 §4), or `null`. */
  readonly parentId?: string | null;
  /** The parent's base name («جراب سيليكون ملون») shown on the family tile. */
  readonly parentName?: string | null;
  /** The parent's first dimension («الموبايل»). */
  readonly dimension1?: string | null;
  /** The parent's second dimension («اللون»), if two-dimensional. */
  readonly dimension2?: string | null;
  /** This product's value on the first dimension («Galaxy A16»). */
  readonly variant1?: string | null;
  /** This product's value on the second dimension («أسود»). */
  readonly variant2?: string | null;
  /** Order of this variant inside its parent's picker. */
  readonly variantOrder?: number | null;
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

/** A phone company: a chip under a phone category, and words search matches. */
export interface PosBrand {
  readonly id: string;
  readonly name: string;
  /** Its Arabic spellings («سامسونج»), empty for a company the owner added. */
  readonly aliases: string;
  readonly sortOrder: number;
}

export interface PosCatalog {
  readonly products: readonly PosProduct[];
  readonly categories: readonly PosCategory[];
  readonly brands: readonly PosBrand[];
}

export function posCatalog(): Promise<PosCatalog> {
  return invoke<PosCatalog>('pos_catalog');
}
