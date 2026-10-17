// Unit tests for the shop colour → readable tokens. Run: npm run test:unit
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { accentTokens, fitOn, hexOf, parseCssColor, ratio, rgbOf, WHITE } from './color.ts';
import type { Grounds, Rgb } from './color.ts';

const light: Grounds = {
  bg: [233, 235, 238],
  surface: [255, 255, 255],
  surface2: [245, 246, 247],
  surface3: [236, 238, 240],
  muted: [84, 91, 101],
};
const dark: Grounds = {
  bg: [15, 18, 22],
  surface: [23, 27, 32],
  surface2: [28, 32, 38],
  surface3: [35, 40, 47],
  muted: [166, 175, 185],
};

const rgb = (hex: string): Rgb => rgbOf(hex) as Rgb;

test('hex round-trips', () => {
  assert.deepEqual(rgbOf('#1d4f91'), [29, 79, 145]);
  assert.equal(hexOf([29, 79, 145]), '#1d4f91');
  assert.equal(rgbOf('blue'), null);
});

test('fitOn moves a colour only as far as it must', () => {
  const navy = rgb('#1d4f91');
  assert.deepEqual(fitOn(navy, [WHITE], [0, 0, 0]), navy, 'already readable on white');
  const yellow = rgb('#ffe14d');
  const fixed = fitOn(yellow, [WHITE], [0, 0, 0]);
  assert.ok(ratio(fixed, WHITE) >= 4.5);
});

test('every shop colour yields readable tokens in both themes', () => {
  const colours = ['#1d4f91', '#0f6e5a', '#b3261e', '#ffe14d', '#ffffff', '#000000', '#7fffd4', '#2f3437'];
  for (const hex of colours) {
    for (const [isDark, g] of [[false, light], [true, dark]] as const) {
      const t = accentTokens(hex, isDark, g);
      const fill = rgb(t['--accent-fill']);
      const on = rgb(t['--on-accent']);
      const text = rgb(t['--accent-text']);
      const weak = rgb(t['--accent-weak']);
      const muted = rgb(t['--muted']);
      assert.ok(ratio(on, fill) >= 4.5, `${hex} ${isDark ? 'dark' : 'light'}: label on fill`);
      for (const ground of [g.bg, g.surface, g.surface2, g.surface3, weak]) {
        assert.ok(ratio(text, ground) >= 4.5, `${hex} ${isDark ? 'dark' : 'light'}: accent text`);
        assert.ok(ratio(muted, ground) >= 4.5, `${hex} ${isDark ? 'dark' : 'light'}: muted text`);
      }
    }
  }
});

test('computed colours parse in both syntaxes', () => {
  assert.deepEqual(parseCssColor('rgb(29, 79, 145)'), [29, 79, 145]);
  assert.deepEqual(parseCssColor('rgba(29, 79, 145, 0.5)'), [29, 79, 145]);
  assert.deepEqual(parseCssColor('color(srgb 1 0.5 0)'), [255, 127.5, 0]);
  assert.equal(parseCssColor('transparent'), null);
});
