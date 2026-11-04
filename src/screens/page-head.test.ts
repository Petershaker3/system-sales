import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// Every screen opens the same way (owner, 2026-11-02: «ترتيب الشاشات»).
//
// The rule is one line, and it is checked here rather than in a screenshot:
//
//   title (h2) — one line saying what the screen is for (class="sub") — …
//
// «وضع البيع» is the one exception: its header is the search box and the cart
// bar, because the seller's first action is typing, not reading a heading.

const SCREENS_DIR = join(import.meta.dirname, '..');

/** Every `*Screen.vue` under `src/screens`, except the point of sale. */
function screenFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(SCREENS_DIR)) {
    const dir = join(SCREENS_DIR, entry);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('Screen.vue')) continue;
      if (file === 'PosScreen.vue') continue;
      out.push(join(dir, file));
    }
  }
  return out.sort();
}

/** The text between `class="page-h"` and the end of its opening block. */
function headerOf(source: string): string {
  const at = source.indexOf('class="page-h"');
  if (at < 0) return '';
  return source.slice(at, at + 1600);
}

test('every screen names itself with the same heading level', () => {
  for (const file of screenFiles()) {
    const source = readFileSync(file, 'utf8');
    assert.equal(source.includes('<h1'), false, `${file} uses an h1 where every other screen uses h2`);
  }
});

test('every screen has a header, and a line that says what it is for', () => {
  for (const file of screenFiles()) {
    const source = readFileSync(file, 'utf8');
    const header = headerOf(source);
    assert.ok(header !== '', `${file} has no page header`);
    assert.ok(header.includes('<h2'), `${file}: the header starts with the title`);
    assert.ok(header.includes('class="sub'), `${file}: the header needs its «what is this screen» line`);
  }
});
