/**
 * Product catalogue API.
 *
 * A thin typed wrapper over `invoke`. Mirrors `identity.ts`: no token is ever
 * read or sent, because the backend resolves the operator from the OS
 * credential store. Every failure arrives as a `CommandError` carrying a stable
 * code, and rendering happens in `errors.ts`.
 */

import { invoke } from '@tauri-apps/api/core';

import type { CommandError } from './errors';

/**
 * How a product is tracked.
 *
 * `one_off` is a distinct third class, not a synonym for `quantity` (`spec:175`):
 * it is sold once as an individual occurrence and keeps no stock balance. These
 * strings are the stored values Rust parses, so they must match
 * `Disposition::as_str` exactly.
 */
export type Disposition = 'quantity' | 'serialized' | 'one_off';
export type ProductStatus = 'active' | 'archived';

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly disposition: Disposition;
  readonly barcode: string | null;
  /**
   * Sale price in piastres (EGP × 100).
   *
   * NULL is meaningful and must not be collapsed: `null` means the price is not
   * set, whereas `0` means the product is genuinely free. Enforcing a price
   * before a sale is the responsibility of the `pos-sales` slice, not here
   * (ADR-010).
   */
  readonly salePriceMinor: number | null;
  readonly status: ProductStatus;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Payload for creating a product. A missing sale price is allowed. */
export interface NewProduct {
  readonly name: string;
  readonly disposition: Disposition;
  readonly barcode?: string | null;
  readonly salePriceMinor?: number | null;
}

/**
 * Payload for editing a product.
 *
 * A field left `undefined` is untouched. A field set to `null` is *cleared*,
 * which is why these are not simply `NewProduct`: `barcode: null` and an absent
 * `barcode` mean different things.
 */
export interface ProductPatch {
  readonly name?: string;
  readonly disposition?: Disposition;
  readonly barcode?: string | null;
  readonly salePriceMinor?: number | null;
}

export async function createProduct(input: NewProduct): Promise<Product> {
  return invoke<Product>('create_product', {
    name: input.name,
    disposition: input.disposition,
    barcode: input.barcode ?? null,
    salePriceMinor: input.salePriceMinor ?? null,
  });
}

export async function getProduct(id: string): Promise<Product> {
  return invoke<Product>('get_product', { id });
}

/**
 * List products. Defaults to the active catalogue; pass `'archived'` to see the
 * archived ones. There is no combined view, so an operator can never mix a
 * sellable product into an archived list by accident.
 */
export async function listProducts(status?: ProductStatus): Promise<Product[]> {
  return invoke<Product[]>('list_products', { status: status ?? null });
}

export async function updateProduct(id: string, patch: ProductPatch): Promise<Product> {
  return invoke<Product>('update_product', {
    id,
    name: patch.name ?? null,
    disposition: patch.disposition ?? null,
    barcode: patch.barcode ?? null,
    salePriceMinor: patch.salePriceMinor ?? null,
  });
}

/**
 * Archive or reactivate a product. Never deletes: `spec:221` keeps products
 * referenced by history, and the row stays for reporting.
 */
export async function setProductArchived(
  id: string,
  archived: boolean,
): Promise<Product> {
  return invoke<Product>('set_product_archived', { id, archived });
}

/**
 * Look up a product by a typed or pasted barcode.
 *
 * Case-insensitive. Needs no camera and no decoder, so the blocked barcode
 * decision (ADR-008) is untouched by this.
 */
export async function findProductByBarcode(barcode: string): Promise<Product> {
  return invoke<Product>('find_product_by_barcode', { barcode });
}

export type { CommandError };
