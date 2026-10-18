/**
 * Display, POS, shop, and receipt choices (`ui.*` settings; DESIGN.md, ADR-022).
 *
 * Readable before anyone signs in, because the sign-in screen is drawn in the
 * shop's look. The light/dark switch may be changed by any role; the rest are
 * the owner's.
 */

import { invoke } from '@tauri-apps/api/core';

export interface AppearanceDto {
  readonly look: string;
  readonly theme: string;
  readonly accent: string;
  readonly font: string;
  readonly scale: string;
  readonly digits: string;
  readonly images?: string;
  readonly imeiMode?: string;
  readonly payMethods?: string;
  readonly discountLimitPct?: string;
  readonly shopName?: string;
  readonly shopPhone?: string;
  readonly shopAddress?: string;
  readonly receiptFooter?: string;
  readonly waTemplate?: string;
  readonly receiptMode?: string;
  readonly printerEnabled?: string;
  readonly receiptPaper?: string;
  readonly warrantyNew?: string;
  readonly warrantyUsed?: string;
  readonly warrantyItem?: string;
}

export type AppearanceKey =
  | 'ui.look'
  | 'ui.theme'
  | 'ui.accent'
  | 'ui.font'
  | 'ui.scale'
  | 'ui.digits'
  | 'ui.images'
  | 'ui.imei_mode'
  | 'ui.pay_methods'
  | 'ui.discount_limit_pct'
  | 'ui.shop_name'
  | 'ui.shop_phone'
  | 'ui.shop_address'
  | 'ui.receipt_footer'
  | 'ui.wa_template'
  | 'ui.receipt_mode'
  | 'ui.printer_enabled'
  | 'ui.receipt_paper'
  | 'ui.warranty_new'
  | 'ui.warranty_used'
  | 'ui.warranty_item';

export function readAppearance(): Promise<AppearanceDto> {
  return invoke<AppearanceDto>('read_appearance');
}

/** Change one choice; returns all of them as stored. */
export function updateAppearance(key: AppearanceKey, value: string): Promise<AppearanceDto> {
  return invoke<AppearanceDto>('update_appearance', { key, value });
}
