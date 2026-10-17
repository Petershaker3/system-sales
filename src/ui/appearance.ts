// The look of the screens: the two looks («لافتة الشارع» / «علبة الموبايل»),
// light or dark, the shop colour, the font, the text size and the digits
// (DESIGN.md, docs/ui/REDESIGN.md; owner decisions in ADR-016).
//
// # Where it is kept
//
// In the shop database, as `ui.*` settings (src/api/appearance.ts). They are
// read before anyone signs in, so the sign-in screen already wears the shop's
// look. Nothing is kept in the WebView's storage: no file under src/ touches web
// storage, and this one keeps it that way. Until the stored choices arrive the
// approved defaults are applied, so the first frame is never unstyled.
//
// The light/dark switch on the rail is for whoever works the counter; every
// other choice is the owner's, behind a fresh password (Rust decides).
//
// # How it is applied
//
// `<html data-look data-theme data-font data-scale>` picks the token set in
// styles/tokens.css, and `--accent` plus the derived accent tokens (color.ts)
// are written as inline custom properties, after the look's grounds are known.

import { reactive } from 'vue';

import * as api from '../api/appearance';
import type { AppearanceKey } from '../api/appearance';
import { accentTokens, DEFAULT_ACCENT, parseCssColor, rgbOf, WHITE } from './color.ts';
import type { Grounds, Rgb } from './color.ts';
import { setDigits } from './format.ts';
import type { Digits } from './format.ts';

export type Look = 'plate' | 'box';
export type ThemeChoice = 'light' | 'dark' | 'auto';
export type FontChoice = 'auto' | 'plex' | 'cairo' | 'tajawal' | 'readex';
export type Scale = 'normal' | 'large';

export interface Appearance {
  look: Look;
  theme: ThemeChoice;
  accent: string;
  font: FontChoice;
  scale: Scale;
  digits: Digits;
}

export const DEFAULT_APPEARANCE: Readonly<Appearance> = {
  look: 'plate',
  theme: 'light',
  accent: DEFAULT_ACCENT,
  font: 'auto',
  scale: 'normal',
  digits: 'latin',
};

/** Ready-made shop colours; «لون تاني» accepts any colour and stays readable. */
export const ACCENTS: readonly string[] = [
  '#1d4f91',
  '#0f6e5a',
  '#b3261e',
  '#0e6170',
  '#6b2f73',
  '#a86b00',
  '#2f3437',
];

export const LOOKS: readonly { id: Look; name: string; hint: string }[] = [
  { id: 'plate', name: 'لافتة الشارع', hint: 'أرضية هادية فيها لمسة من لون المحل، وحواف ناعمة' },
  { id: 'box', name: 'علبة الموبايل', hint: 'أبيض وحبر وخطوط رفيعة، زي علبة موبايل جديدة' },
];

export const FONTS: readonly { id: FontChoice; name: string }[] = [
  { id: 'auto', name: 'خط الطابع' },
  { id: 'plex', name: 'IBM Plex' },
  { id: 'cairo', name: 'Cairo' },
  { id: 'tajawal', name: 'Tajawal' },
  { id: 'readex', name: 'Readex Pro' },
];

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

/** Anything read back from the backend → a valid appearance (unknown values fall back). */
export function normalizeAppearance(raw: unknown): Appearance {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const accent = typeof r['accent'] === 'string' && rgbOf(r['accent']) !== null ? r['accent'] : DEFAULT_APPEARANCE.accent;
  return {
    look: oneOf(r['look'], ['plate', 'box'] as const, DEFAULT_APPEARANCE.look),
    theme: oneOf(r['theme'], ['light', 'dark', 'auto'] as const, DEFAULT_APPEARANCE.theme),
    accent: accent.toLowerCase(),
    font: oneOf(r['font'], ['auto', 'plex', 'cairo', 'tajawal', 'readex'] as const, DEFAULT_APPEARANCE.font),
    scale: oneOf(r['scale'], ['normal', 'large'] as const, DEFAULT_APPEARANCE.scale),
    digits: oneOf(r['digits'], ['latin', 'arabic'] as const, DEFAULT_APPEARANCE.digits),
  };
}

/** The single, reactive appearance every component reads. */
export const appearance: Appearance = reactive({ ...DEFAULT_APPEARANCE });

export function resolvedTheme(a: Appearance = appearance): 'light' | 'dark' {
  if (a.theme !== 'auto') return a.theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** A colour variable as the browser computed it (after color-mix). */
function cssColor(name: string): Rgb {
  const probe = document.createElement('i');
  probe.style.cssText = `position:absolute;visibility:hidden;color:var(${name})`;
  document.body.appendChild(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return parseCssColor(value) ?? WHITE;
}

/** Write the appearance onto <html>. Safe to call repeatedly. */
export function applyAppearance(a: Appearance = appearance): void {
  const root = document.documentElement;
  const theme = resolvedTheme(a);
  root.dataset['theme'] = theme;
  root.dataset['look'] = a.look;
  root.dataset['font'] = a.font;
  root.dataset['scale'] = a.scale;
  root.style.setProperty('--accent', a.accent);
  setDigits(a.digits);

  // The grounds depend on the look, the theme and the accent tint, so they are
  // read after those are set, with the previous muted correction removed.
  root.style.removeProperty('--muted');
  const grounds: Grounds = {
    bg: cssColor('--bg'),
    surface: cssColor('--surface'),
    surface2: cssColor('--surface-2'),
    surface3: cssColor('--surface-3'),
    muted: cssColor('--muted'),
  };
  const tokens = accentTokens(a.accent, theme === 'dark', grounds);
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
}

const KEYS: Record<keyof Appearance, AppearanceKey> = {
  look: 'ui.look',
  theme: 'ui.theme',
  accent: 'ui.accent',
  font: 'ui.font',
  scale: 'ui.scale',
  digits: 'ui.digits',
};

/**
 * Change part of the appearance: repaint at once, then store it. When the store
 * refuses (no permission, or a fresh password is needed) the previous look is
 * put back and the error is rethrown for the caller to handle.
 */
export async function setAppearance(patch: Partial<Appearance>): Promise<void> {
  const before: Appearance = { ...appearance };
  const next = normalizeAppearance({ ...appearance, ...patch });
  Object.assign(appearance, next);
  applyAppearance();
  try {
    for (const field of Object.keys(patch) as (keyof Appearance)[]) {
      if (before[field] === next[field]) continue;
      const stored = await api.updateAppearance(KEYS[field], next[field]);
      Object.assign(appearance, normalizeAppearance(stored));
    }
    applyAppearance();
  } catch (err) {
    Object.assign(appearance, before);
    applyAppearance();
    throw err;
  }
}

export function toggleTheme(): Promise<void> {
  return setAppearance({ theme: resolvedTheme() === 'dark' ? 'light' : 'dark' });
}

/**
 * Apply the defaults at once, then the stored choices as soon as they are read,
 * and follow the system theme when «auto» is chosen.
 */
export async function startAppearance(): Promise<void> {
  applyAppearance();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (appearance.theme === 'auto') applyAppearance();
  });
  try {
    Object.assign(appearance, normalizeAppearance(await api.readAppearance()));
    applyAppearance();
  } catch {
    // The backend is not reachable yet: the defaults stay, which is a fine look.
  }
}
