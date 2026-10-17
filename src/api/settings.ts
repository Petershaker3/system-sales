/**
 * Device settings API (SP-1b).
 *
 * A thin typed wrapper over `invoke`, mirroring `catalog.ts`. Both reading and
 * updating are blanket re-authenticated on the backend (`ManageSettings`), so
 * callers are expected to sit behind a re-authentication prompt — the backend
 * would refuse regardless; this is about not letting an operator discover that
 * from an error.
 *
 * Values cross the boundary as strings because that is how the domain parses
 * them (`SettingsSnapshot::set`): `0`/`1` for booleans, an integer string for
 * basis points, and the empty string clearing `default_vat_rate_bp` back to
 * "never set" — a recorded `0` and an absent rate are different things.
 */

import { invoke } from '@tauri-apps/api/core';

import type { CommandError } from './errors';

/**
 * The stored costing method (`CostMethod::as_str`). Inert since plan item 1.3:
 * every quantity product is moving average. Kept for the settings snapshot,
 * which still reports it.
 */
export type CostMethod = 'moving_average' | 'fifo';

export type DiscountKind = 'money' | 'percentage';

/** The device's configuration, defaults applied for anything never set. */
export interface SettingsSnapshot {
  readonly defaultCostMethod: CostMethod;
  readonly invoicePrefix: string;
  readonly defaultVatEnabled: boolean;
  /**
   * Null is meaningful: never set, as distinct from a recorded `0`.
   */
  readonly defaultVatRateBp: number | null;
  readonly defaultVatInclusive: boolean;
  readonly maxDiscountKind: DiscountKind;
  readonly maxDiscountValue: number;
}

/**
 * The seven stored keys, exactly as `SettingKey` spells them. Anything else is
 * refused by the domain with `SETTING_UNKNOWN_KEY`.
 */
export type SettingKey =
  | 'default_cost_method'
  | 'invoice_prefix'
  | 'default_vat_enabled'
  | 'default_vat_rate_bp'
  | 'default_vat_inclusive'
  | 'max_discount_kind'
  | 'max_discount_value';

/** Read the snapshot. Requires a freshly re-authenticated session. */
export async function readSettings(): Promise<SettingsSnapshot> {
  return invoke<SettingsSnapshot>('read_settings');
}

/**
 * Change one setting. The value is parsed and validated by the domain before
 * anything is written; `unknownKey` and malformed values never reach the table.
 */
export async function updateSetting(key: SettingKey, value: string): Promise<void> {
  return invoke<void>('update_setting', { key, value });
}

export type { CommandError };
