// Shop colour → readable interface colours (DESIGN.md, docs/ui/REDESIGN.md).
//
// Ported from the approved mockup (docs/ui/mockup-v1/app.js, `accentTokens`).
// Any colour the owner picks must stay readable: text on it, and text in it,
// passes WCAG 4.5:1. The colour is moved toward black or white by the smallest
// step that passes, and every candidate is tested after rounding to whole
// numbers — the value that is actually written — so rounding cannot drop the
// contrast below the bar.
//
// Pure: no DOM. The caller reads the computed ground colours of the current
// look and theme and passes them in (see `appearance.ts`).

export type Rgb = readonly [number, number, number];

export const WHITE: Rgb = [255, 255, 255];
export const BLACK: Rgb = [0, 0, 0];
/** The dark ink used for text on a light shop colour. */
export const INK: Rgb = [17, 19, 23];

/** `#rrggbb` → `[r, g, b]`, or `null` for anything else. */
export function rgbOf(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (match === null || match[1] === undefined) return null;
  const n = parseInt(match[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

export function hexOf(c: Rgb): string {
  return `#${c
    .map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0'))
    .join('')}`;
}

function luminance(c: Rgb): number {
  const f = (v: number): number => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}

/** WCAG contrast ratio between two colours (1 … 21). */
export function ratio(a: Rgb, b: Rgb): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const rounded = (c: Rgb): Rgb => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])];

/**
 * The smallest move of `c` toward `toward` that reaches `target` contrast
 * against every ground. Falls back to `toward` itself.
 */
export function fitOn(c: Rgb, grounds: readonly Rgb[], toward: Rgb, target = 4.5): Rgb {
  for (let i = 0; i <= 50; i++) {
    const x = rounded(mix(c, toward, i / 50));
    if (grounds.every((g) => ratio(x, g) >= target)) return x;
  }
  return toward;
}

/** Text on a background of the shop colour: white or dark ink, whichever reads better. */
export function onAccent(c: Rgb): Rgb {
  return ratio(WHITE, c) >= ratio(INK, c) ? WHITE : INK;
}

/** The ground colours of the current look and theme, as computed by the browser. */
export interface Grounds {
  readonly bg: Rgb;
  readonly surface: Rgb;
  readonly surface2: Rgb;
  readonly surface3: Rgb;
  /** The look's own muted text colour, before any shop-colour correction. */
  readonly muted: Rgb;
}

/** The CSS custom properties derived from the shop colour. */
export interface AccentTokens {
  readonly '--accent-fill': string;
  readonly '--on-accent': string;
  readonly '--accent-text': string;
  readonly '--accent-weak': string;
  readonly '--muted': string;
}

export const DEFAULT_ACCENT = '#1d4f91';

/**
 * Derive every accent token from the shop colour, so all of them pass 4.5:1:
 *
 * - `--accent-fill` / `--on-accent`: a filled button and its label;
 * - `--accent-text`: the shop colour used as text, on every surface;
 * - `--accent-weak`: the selection tint, made from the readable text colour so
 *   it shows even for a very light or very dark shop colour;
 * - `--muted`: the look's quiet text, re-checked because a light shop colour
 *   lightens the surfaces and the tint in the dark theme.
 */
export function accentTokens(hex: string, dark: boolean, grounds: Grounds): AccentTokens {
  const a = rgbOf(hex) ?? (rgbOf(DEFAULT_ACCENT) as Rgb);
  const surfaces: Rgb[] = [grounds.bg, grounds.surface, grounds.surface2, grounds.surface3];

  let fill: Rgb = a;
  let on: Rgb = onAccent(a);
  if (ratio(on, fill) < 4.5) {
    fill = fitOn(a, [WHITE], BLACK);
    on = WHITE;
  }

  const toward = dark ? WHITE : BLACK;
  let text = fitOn(a, surfaces, toward);
  const weak = mix(grounds.surface, text, dark ? 0.18 : 0.12);
  if (ratio(text, weak) < 4.5) text = fitOn(text, [...surfaces, weak], toward);
  const muted = fitOn(grounds.muted, [...surfaces, weak], toward);

  return {
    '--accent-fill': hexOf(fill),
    '--on-accent': hexOf(on),
    '--accent-text': hexOf(text),
    '--accent-weak': hexOf(weak),
    '--muted': hexOf(muted),
  };
}

/** Parse a computed CSS colour (`rgb(…)`, `rgba(…)` or `color(srgb …)`). */
export function parseCssColor(value: string): Rgb | null {
  let m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value);
  if (m !== null) return [Number(m[1]), Number(m[2]), Number(m[3])];
  m = /color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)/.exec(value);
  if (m !== null) return [Number(m[1]) * 255, Number(m[2]) * 255, Number(m[3]) * 255];
  return null;
}
