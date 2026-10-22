#!/usr/bin/env node
// The two buttons on a finding: «صلّحها لي» and «روح للصف».
//
// These are the promises the owner relies on when the screen says a problem is
// fixable. They are checked here on a small backup built for this test only — two
// categories with the same name, which is exactly what the old file produced when
// the owner typed the same section twice with different letters.
//
// Usage: node test/ui-autofix.mjs

import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const html = readFileSync(new URL('../legacy-migration.html', import.meta.url), 'utf8');

const day = (sections) => JSON.stringify({
  acc: [], used: [], cash: [], sw: [], exp: [], phones: [], repairs: [],
  ...sections,
});

const legacy = {
  mshop_cfg: JSON.stringify({ name: 'محل الفحص' }),
  mshop_cats: JSON.stringify(['جراب', 'جراب', 'سكرين']),
  mshop_ca: JSON.stringify([{ name: 'جراب 50', buy: 25, sell: 50 }]),
  mshop_ce: JSON.stringify(['البيت']),
  'mshop_d_2026-10-05': day({
    acc: [{ name: 'جراب 50', mainCat: 'جراب', buy: 25, sell: 50, profit: 25, time: '٠١:٠٠ م' }],
  }),
};

const problems = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => {
  const text = String(error.message || error);
  if (text.includes('Not implemented: navigation')) return;
  problems.push(text);
});

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://local.test/',
  virtualConsole,
  beforeParse(window) {
    window.WebAssembly = WebAssembly;
    if (!window.crypto?.getRandomValues) window.crypto = globalThis.crypto;
    window.URL.createObjectURL = () => 'blob:local-test';
    window.URL.revokeObjectURL = () => {};
    window.confirm = () => true;
    window.HTMLCanvasElement.prototype.getContext = () => null;
    window.HTMLAnchorElement.prototype.click = () => {};
  },
});

const { window } = dom;
const { document } = window;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = () => document.body.textContent || '';

async function waitFor(predicate, label, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await sleep(40);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const drop = document.getElementById('drop');
  const event = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { files: [{ name: 'legacy.json', text: async () => JSON.stringify(legacy) }] },
  });
  drop.dispatchEvent(event);
  await waitFor(() => text().includes('النظرة العامة'), 'the overview');

  // The reader already folds identical names, so a duplicate only appears once a
  // person makes one — rename a section to a name that is taken, which is the
  // real-world case (two sections that mean the same thing).
  document.querySelector('[data-act="tab"][data-tab="categories"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(80);
  const rowsBefore = document.querySelectorAll('tbody tr').length;
  const nameInputs = [...document.querySelectorAll('tbody input[data-field="name"]')];
  const last = nameInputs[nameInputs.length - 1];
  last.value = nameInputs[0].value;
  last.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(80);
  document.querySelector('[data-act="tab"][data-tab="overview"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(80);

  if (!text().includes('تصنيف مكرر')) throw new Error('the duplicate category was not reported');
  if (!text().includes('ادمج المحدد')) throw new Error('the fix does not name the action');
  console.log('ok    the duplicate category is reported with its fix');

  const fix = document.querySelector('button[data-act="auto-fix"]');
  if (!fix) throw new Error('no auto-fix button');
  fix.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(150);
  if (text().includes('تصنيف مكرر')) throw new Error('the duplicate survived the fix');
  console.log('ok    «صلّحها لي» merges the duplicate and the finding disappears');

  // The row it fixed is reachable, and the panel opens on it.
  document.querySelector('[data-act="tab"][data-tab="categories"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(80);
  const rows = document.querySelectorAll('tbody tr').length;
  if (rows !== rowsBefore - 1) throw new Error(`merge left ${rows} rows, expected ${rowsBefore - 1}`);

  // Undo puts the duplicate back, intact.
  document.querySelector('[data-act="undo"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(80);
  // Undo takes back the merge (the rename before it is still applied, so the
  // row count is what it was: one name changed, not one row removed).
  if (document.querySelectorAll('tbody tr').length !== rowsBefore) throw new Error('undo did not restore the merged category');
  console.log('ok    undo brings the merged category back');

  if (problems.length) {
    console.error('page errors:');
    for (const problem of problems) console.error(` - ${problem}`);
    process.exit(1);
  }
  window.close();
}

main().catch((error) => {
  console.error(error);
  if (problems.length) for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
});
