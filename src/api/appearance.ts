/**
 * Display choices (`ui.*` settings; DESIGN.md).
 *
 * Readable before anyone signs in, because the sign-in screen is drawn in the
 * shop's look. The light/dark switch may be changed by any role; the look, the
 * shop colour, the font, the size and the digits are the owner's, and Rust
 * asks for a fresh password (`REAUTHENTICATION_REQUIRED`) like every setting.
 */

import { invoke } from '@tauri-apps/api/core';

export interface AppearanceDto {
  readonly look: string;
  readonly theme: string;
  readonly accent: string;
  readonly font: string;
  readonly scale: string;
  readonly digits: string;
}

export type AppearanceKey = 'ui.look' | 'ui.theme' | 'ui.accent' | 'ui.font' | 'ui.scale' | 'ui.digits';

export function readAppearance(): Promise<AppearanceDto> {
  return invoke<AppearanceDto>('read_appearance');
}

/** Change one choice; returns all of them as stored. */
export function updateAppearance(key: AppearanceKey, value: string): Promise<AppearanceDto> {
  return invoke<AppearanceDto>('update_appearance', { key, value });
}
