/**
 * Product & shop images API («صور الأصناف» & «لوجو المحل», ADR-018 §5, ADR-022 §2.2).
 *
 * Each product may carry one optional 192×192 JPEG thumbnail stored as an
 * external file under `images/<product_id>.jpg` beside `shop.db`, with only its
 * path, dimensions, and byte length recorded in `product_images` (XC-10).
 * The optional shop logo lives at `images/shop-logo.jpg` (192×192 JPEG).
 */

import { invoke } from '@tauri-apps/api/core';

export interface ProductImage {
  readonly productId: string;
  readonly file: string;
  readonly w: number;
  readonly h: number;
  readonly bytes: number;
  readonly dataUrl: string;
}

/** List all stored product images for the store, sales screen, and settings. */
export async function listProductImages(): Promise<ProductImage[]> {
  return invoke<ProductImage[]>('list_product_images');
}

/** Store or replace a product's 192×192 JPEG thumbnail. */
export async function setProductImage(productId: string, dataUrl: string): Promise<ProductImage> {
  return invoke<ProductImage>('set_product_image', { productId, dataUrl });
}

/** Remove a product's stored 192×192 JPEG thumbnail. */
export async function removeProductImage(productId: string): Promise<void> {
  return invoke<void>('remove_product_image', { productId });
}

/** Read the optional 192×192 JPEG shop logo data URL, or `null` if none is stored (`ADR-022` §2.2). */
export async function getShopLogo(): Promise<string | null> {
  return invoke<string | null>('get_shop_logo');
}

/** Store or replace the shop's 192×192 JPEG logo (`ADR-022` §2.2). */
export async function setShopLogo(dataUrl: string): Promise<string> {
  return invoke<string>('set_shop_logo', { dataUrl });
}

/** Remove the shop's stored 192×192 JPEG logo (`ADR-022` §2.2). */
export async function removeShopLogo(): Promise<void> {
  return invoke<void>('remove_shop_logo');
}
