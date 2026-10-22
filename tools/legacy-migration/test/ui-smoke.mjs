#!/usr/bin/env node
// A headless run of the real single-file tool.
//
// It loads `legacy-migration.html` into jsdom, opens the shop's backup the way
// the owner does (drop on the page), walks every tab, opens the details panel,
// merges two rows and takes it back, then builds a backup through the screen and
// writes the produced file out. The caller hands that file to the Python
// verifier, so the file the *screen* produces is the file that gets checked —
// not a second code path.
//
// Usage: node test/ui-smoke.mjs <legacy.json> <out.msb1>

import { readFileSync, writeFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const [legacyPath, outputPath] = process.argv.slice(2);
if (!legacyPath || !outputPath) {
  console.error('usage: ui-smoke.mjs <legacy.json> <out.msb1>');
  process.exit(2);
}

const html = readFileSync(new URL('../legacy-migration.html', import.meta.url), 'utf8');
const legacyText = readFileSync(legacyPath, 'utf8');

const problems = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => {
  const text = String(error.message || error);
  // jsdom does not implement navigation; a download anchor is not navigation.
  if (text.includes('Not implemented: navigation')) return;
  problems.push(text);
});
virtualConsole.on('error', (...args) => problems.push(args.join(' ')));

let lastBlob = null;
let lastBlobName = null;

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://local.test/',
  virtualConsole,
  beforeParse(window) {
    window.WebAssembly = WebAssembly;
    if (!window.crypto?.getRandomValues) window.crypto = globalThis.crypto;
    window.URL.createObjectURL = (blob) => {
      lastBlob = blob;
      return 'blob:local-test';
    };
    window.URL.revokeObjectURL = () => {};
    window.confirm = () => true;
    window.HTMLCanvasElement.prototype.getContext = () => null;
    window.HTMLAnchorElement.prototype.click = function click() {
      lastBlobName = this.download;
    };
  },
});

const { window } = dom;
const { document } = window;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, label, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await sleep(40);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Scoped to the app, not the whole body: the bundled script is part of the
// document, so `body.textContent` would also contain every Arabic string in the
// code and every assertion would pass before anything rendered.
const text = () => document.getElementById('app')?.textContent || '';
const click = (selector) => {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`missing element: ${selector}`);
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  return element;
};
const change = (element, value) => {
  if (!element) throw new Error('missing input');
  if (element.type === 'checkbox') {
    element.checked = value;
  } else {
    element.value = value;
  }
  element.dispatchEvent(new window.Event('change', { bubbles: true }));
};
const tab = async (name) => {
  click(`[data-act="tab"][data-tab="${name}"]`);
  await sleep(60);
};

async function main() {
  // ── Open the backup by dropping it on the page ──────────────────────────
  const drop = document.getElementById('drop');
  if (!drop) throw new Error('the load screen did not render');
  const event = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [{ name: 'legacy.json', text: async () => legacyText }] } });
  drop.dispatchEvent(event);

  await waitFor(() => text().includes('النظرة العامة'), 'the overview');
  // The shop name comes from the file itself, so the check works for the
  // synthetic fixture and for the owner's real backup alike.
  const expectedShop = JSON.parse(JSON.parse(legacyText).mshop_cfg).name;
  if (!text().includes(expectedShop)) throw new Error(`the shop name «${expectedShop}» did not reach the overview`);
  console.log('ok    the backup opens and the overview shows the shop');

  // ── Every tab renders ───────────────────────────────────────────────────
  for (const name of ['map', 'categories', 'brands', 'items', 'months', 'sales', 'repairs', 'expenses', 'wallets', 'settings', 'build', 'overview']) {
    await tab(name);
    if (!document.querySelector('main')?.textContent.trim()) throw new Error(`tab ${name} rendered nothing`);
  }
  console.log('ok    all twelve tabs render');

  // ── The map says where each old thing goes ──────────────────────────────
  await tab('map');
  for (const needle of ['mshop_ca', 'mshop_inventory', 'departments', 'اللي مش هيتنقل', 'mshop_notes']) {
    if (!text().includes(needle)) throw new Error(`the map is missing ${needle}`);
  }
  console.log('ok    the map lists every old key with its destination');

  // ── The details panel: old shape above, new shape below ────────────────
  await tab('items');
  const firstDetails = document.querySelector('tbody button[data-act="details"]');
  if (!firstDetails) throw new Error('no details button');
  firstDetails.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(80);
  const drawer = document.querySelector('.drawer');
  if (!drawer) throw new Error('the details panel did not open');
  for (const needle of ['في القديم', 'في السيستم الجديد', 'المخزن ← الأصناف', 'تعديل البيانات', 'تحكم كامل']) {
    if (!drawer.textContent.includes(needle)) throw new Error(`the panel is missing «${needle}»`);
  }
  const nameField = drawer.querySelector('input[data-field="name"]');
  const before = nameField.value;
  change(nameField, `${before} (معدّل)`);
  await sleep(60);
  if (!document.querySelector('.drawer')?.textContent.includes('(معدّل)')) throw new Error('the panel edit did not stick');
  click('[data-act="undo"]');
  await sleep(60);
  click(`[data-act="details"][data-coll="items"]`);
  await sleep(60);
  const restored = document.querySelector('.drawer input[data-field="name"]').value;
  if (restored !== before) throw new Error(`undo left «${restored}» instead of «${before}»`);
  click('[data-act="close-drawer"]');
  await sleep(60);
  if (document.querySelector('.drawer')) throw new Error('the panel did not close');
  console.log('ok    a row opens, shows both shapes, edits, undoes, closes');

  // ── Include toggle, undo, redo ──────────────────────────────────────────
  await tab('items');
  const firstToggle = document.querySelector('tbody input[data-act="include"]');
  const wasChecked = firstToggle.checked;
  change(firstToggle, !wasChecked);
  await waitFor(() => document.querySelector('tbody input[data-act="include"]').checked === !wasChecked, 'the include toggle');
  click('[data-act="undo"]');
  await waitFor(() => document.querySelector('tbody input[data-act="include"]').checked === wasChecked, 'undo');
  console.log('ok    a row toggles and undoes');

  // ── Merge two categories, then take it back ────────────────────────────
  await tab('categories');
  const rowsBefore = document.querySelectorAll('tbody tr').length;
  await tab('categories');
  const ticks = [...document.querySelectorAll('tbody input[data-act="select"]')];
  if (ticks.length < 2) throw new Error('no selection checkboxes');
  change(document.querySelectorAll('tbody input[data-act="select"]')[0], true);
  change(document.querySelectorAll('tbody input[data-act="select"]')[1], true);
  await sleep(60);
  click('[data-act="merge"][data-coll="categories"]');
  await sleep(120);
  const rowsAfter = document.querySelectorAll('tbody tr').length;
  if (rowsAfter !== rowsBefore - 1) throw new Error(`merge left ${rowsAfter} rows, expected ${rowsBefore - 1}`);
  click('[data-act="undo"]');
  await sleep(80);
  if (document.querySelectorAll('tbody tr').length !== rowsBefore) throw new Error('undo did not restore the merged row');
  console.log('ok    two categories merge into one, and undo brings it back');

  // ── Add a category, then remove the addition ────────────────────────────
  click('[data-act="add-category"]');
  await sleep(60);
  if (document.querySelectorAll('tbody tr').length <= rowsBefore) throw new Error('add category did nothing');
  click('[data-act="undo"]');
  await sleep(60);
  console.log('ok    adding and undoing a category works');

  // ── Findings explain themselves ────────────────────────────────────────
  await tab('overview');
  if (!text().includes('الفحص')) throw new Error('no findings card');
  if (text().includes('مانع للبناء') || text().includes('تنبيه')) {
    if (!text().includes('ليه؟') || !text().includes('الحل:')) throw new Error('findings do not explain why and how');
    console.log('ok    findings say why they happened and how to fix them');
  } else {
    console.log('ok    findings card is clean (synthetic backup)');
  }

  // ── Build ───────────────────────────────────────────────────────────────
  await tab('settings');
  const logo = document.querySelector('input[data-act="logo-include"]');
  if (logo && logo.checked) change(logo, false);

  await tab('build');
  change(document.querySelector('input[data-field="password"]'), 'shop12345');
  change(document.querySelector('input[data-field="password2"]'), 'shop12345');
  click('[data-act="build"]');

  await waitFor(() => text().includes('النسخة جاهزة'), 'the finished backup', 120000);
  console.log('ok    the screen built a backup and self-checked it');

  click('[data-act="download"][data-which="backup"]');
  await waitFor(() => lastBlob, 'the downloaded blob');
  const bytes = new Uint8Array(await lastBlob.arrayBuffer());
  writeFileSync(outputPath, bytes);
  console.log(`ok    downloaded ${lastBlobName} (${(bytes.length / 1024 / 1024).toFixed(2)} MB)`);

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
