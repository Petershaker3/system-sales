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
  /** The category it is in (ADR-018 §1), or `null` while unclassified. */
  readonly categoryId: string | null;
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
  /** The category it goes in, or `null`/absent to leave it unclassified. */
  readonly categoryId?: string | null;
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
    categoryId: input.categoryId ?? null,
  });
}

/**
 * Put a product in a category, or take it out with `null`. Its own command:
 * a `null` in `update_product` means "leave it", so it could not say "take it
 * out".
 */
export async function setProductCategory(id: string, categoryId: string | null): Promise<Product> {
  return invoke<Product>('set_product_category', { id, categoryId });
}

/**
 * The next free barcode the shop makes for itself (ADR-018 §3, `PLAN` §6).
 *
 * An EAN-13 starting with 2, one past the highest internal code already stored.
 * It reserves nothing; `createProduct` with the same barcode is what claims it.
 */
export async function nextShopCode(): Promise<string> {
  return invoke<string>('next_shop_code');
}

/**
 * The next `count` free barcodes for «اعمل أكواد للي من غير باركود» on a
 * variant item (ADR-018 §4), advancing past both stored codes and any
 * `reserved` codes already typed into the variant table.
 */
export async function nextShopCodes(
  count: number,
  reserved?: readonly string[],
): Promise<string[]> {
  return invoke<string[]>('next_shop_codes', {
    count,
    reserved: reserved === undefined ? null : [...reserved],
  });
}

/** One combination's optional barcode and sale-price override. */
export interface NewVariantRowInput {
  readonly barcode?: string | null;
  readonly salePriceMinor?: number | null;
}

/** The parent of a variant family (`product_parents`). */
export interface VariantParent {
  readonly id: string;
  readonly name: string;
  readonly categoryId: string;
  readonly dimension1: string;
  readonly dimension2: string | null;
}

/** One registered variant product and its place in the parent. */
export interface RegisteredVariant {
  readonly product: Product;
  readonly parentId: string;
  readonly variant1: string;
  readonly variant2: string | null;
  readonly variantOrder: number;
}

/** What `createVariants` returns. */
export interface RegisteredVariants {
  readonly parent: VariantParent;
  readonly variants: readonly RegisteredVariant[];
}

/** Input to `createVariants` (`ADR-018` §4). */
export interface CreateVariantsInput {
  readonly categoryId: string;
  readonly name: string;
  readonly dimension1: string;
  readonly values1: readonly string[];
  readonly dimension2?: string | null;
  readonly values2?: readonly string[];
  readonly defaultPriceMinor: number;
  readonly rows?: readonly NewVariantRowInput[];
}

/** Register a counted item with variants («الصنف ده ليه تفرعات», `ADR-018` §4). */
export async function createVariants(
  input: CreateVariantsInput,
): Promise<RegisteredVariants> {
  return invoke<RegisteredVariants>('create_variants', {
    categoryId: input.categoryId,
    name: input.name,
    dimension1: input.dimension1,
    values1: [...input.values1],
    dimension2: input.dimension2 ?? null,
    values2: input.values2 === undefined ? null : [...input.values2],
    salePriceMinor: input.defaultPriceMinor,
    rows:
      input.rows === undefined
        ? null
        : input.rows.map((r) => ({
            barcode: r.barcode ?? null,
            salePriceMinor: r.salePriceMinor ?? null,
          })),
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
