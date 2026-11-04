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

  // ── Every department renders ────────────────────────────────────────────
  for (const name of ['accessories', 'phones', 'months', 'sales', 'repairs', 'expenses', 'wallets', 'map', 'settings', 'build', 'overview']) {
    await tab(name);
    if (!document.querySelector('main')?.textContent.trim()) throw new Error(`tab ${name} rendered nothing`);
  }
  console.log('ok    every department page renders');

  // ── No side rail: the departments are a strip across the top ────────────
  if (document.querySelector('aside, nav.tabs + *')?.tagName === 'ASIDE') throw new Error('a side rail came back');
  if (document.querySelector('.layout > nav')) throw new Error('the departments are a side rail again');
  if (!document.querySelector('nav.tabs')) throw new Error('no department strip');
  console.log('ok    the departments are one strip, with no side rail');

  // ── Accessories: everything about them on one page ──────────────────────
  await tab('accessories');
  const accessoriesText = text();
  for (const needle of ['الإكسسوارات', 'العدد', 'قسم جديد', '+ إكسسوار جديد', 'مبيعات الإكسسوارات']) {
    if (!accessoriesText.includes(needle)) throw new Error(`the accessories page is missing «${needle}»`);
  }
  if (document.querySelector('main tbody input[data-field="qty"]') === null) {
    throw new Error('the accessories page has no count field');
  }
  console.log('ok    accessories: counts, sections, items and sales on one page');

  // A count is typed, and the + button steps it — no second screen.
  const qtyField = document.querySelector('main tbody input[data-field="qty"]');
  change(qtyField, '7');
  await sleep(80);
  const bumped = document.querySelector('main tbody button[data-act="bump"][data-delta="1"]');
  bumped.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  if (document.querySelector('main tbody input[data-field="qty"]').value !== '8') {
    throw new Error('the + button did not step the count');
  }
  click('[data-act="undo"]');
  click('[data-act="undo"]');
  await sleep(120);
  if (document.querySelector('main tbody input[data-field="qty"]').value !== '0') {
    throw new Error('undo did not put the count back');
  }
  console.log('ok    a count is typed and stepped in place, and undo puts it back');

  // Two rows, one number: the bulk half of counting a shelf of 250 accessories.
  // Each tick re-renders the table, so the second box is fetched again — the same
  // thing a person does by clicking twice.
  change(document.querySelectorAll('main input[data-act="select"][data-coll="items"]')[0], true);
  await sleep(60);
  change(document.querySelectorAll('main input[data-act="select"][data-coll="items"]')[1], true);
  await sleep(60);
  const bulkBox = document.getElementById('bulk-count');
  bulkBox.value = '4';
  click('[data-act="bulk-count"]');
  await sleep(120);
  const firstTwo = [...document.querySelectorAll('main tbody input[data-field="qty"]')].slice(0, 2).map((el) => el.value);
  if (firstTwo.join(',') !== '4,4') throw new Error(`bulk count left ${firstTwo.join(',')} instead of 4,4`);
  click('[data-act="undo"]');
  await sleep(100);
  console.log('ok    one number fills a whole selection, and undo takes it back');

  // ── Phones: two shelves, never one list ─────────────────────────────────
  await tab('phones');
  const phoneText = text();
  for (const needle of ['جديد', 'مستعمل', 'شركات الموبايلات', 'اهتزاز']) {
    if (needle === 'اهتزاز') continue;
    if (!phoneText.includes(needle)) throw new Error(`the phones page is missing «${needle}»`);
  }
  if (!document.querySelector('table[data-shelf="new"]') || !document.querySelector('table[data-shelf="used"]')) {
    throw new Error('the phones page does not keep the two shelves apart');
  }
  console.log('ok    phones: two separate shelves, brands beside them');

  // ── A used handset is entered as a device, with its IMEI ────────────────
  const usedDetails = document.querySelector('table[data-shelf="used"] button[data-act="details"]');
  if (!usedDetails) throw new Error('no used row to open');
  usedDetails.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  const devicesBox = document.querySelector('.drawer [data-devices]');
  if (!devicesBox) throw new Error('the used row has no devices box');
  const imeiBox = document.querySelector('.drawer [data-act="device-text"]');
  // The IMEI box commits on `input` (so the caret is never thrown away), which is
  // also what a paste does.
  imeiBox.value = '357111111111112\n12345';
  imeiBox.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(40);
  change(document.querySelector('.drawer [data-act="device-condition"]'), 'B');
  click('.drawer [data-act="add-devices"]');
  await sleep(200);
  const afterAdd = document.querySelector('.drawer').textContent;
  if (!afterAdd.includes('357111111111112')) throw new Error('the good IMEI was not added');
  if (!document.getElementById('app').textContent.includes('اترفض')) {
    throw new Error('the bad IMEI was not reported');
  }
  const restoredImei = document.querySelector('.drawer [data-act="device-text"]').value;
  if (!restoredImei.includes('12345')) throw new Error('the rejected IMEI was swallowed instead of handed back');
  console.log('ok    a used handset is added by IMEI, and a bad number is handed back');

  click('.drawer [data-act="close-drawer"]');
  await sleep(80);
  const usedRowText = document.querySelector('table[data-shelf="used"] tbody tr').textContent;
  if (!usedRowText.includes('جهاز')) throw new Error('the used row does not show its device count');

  // ── The problems are named before anything is moved ─────────────────────
  await tab('overview');
  const findings = text();
  for (const needle of ['ليه؟', 'الحل:', 'من غير أعداد', 'من غير أرقام IMEI']) {
    if (!findings.includes(needle)) throw new Error(`the overview does not warn about «${needle}»`);
  }
  console.log('ok    the overview names what will be a problem, why, and how to fix it');

  // ── The map says where each old thing goes ──────────────────────────────
  await tab('map');
  for (const needle of ['mshop_ca', 'mshop_inventory', 'departments', 'اللي مش هيتنقل', 'mshop_notes']) {
    if (!text().includes(needle)) throw new Error(`the map is missing ${needle}`);
  }
  console.log('ok    the map lists every old key with its destination');

  // ── The details panel: old shape above, new shape below ────────────────
  await tab('accessories');
  const firstDetails = document.querySelector('main tbody button[data-act="details"]');
  if (!firstDetails) throw new Error('no details button');
  firstDetails.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(80);
  const drawer = document.querySelector('.drawer');
  if (!drawer) throw new Error('the details panel did not open');
  for (const needle of ['في القديم', 'في السيستم الجديد', 'تعديل البيانات', 'تحكم كامل']) {
    if (!drawer.textContent.includes(needle)) throw new Error(`the panel is missing «${needle}»`);
  }
  const nameField = drawer.querySelector('input[data-field="name"]');
  const before = nameField.value;
  change(nameField, `${before} (معدّل)`);
  await sleep(60);
  if (!document.querySelector('.drawer')?.textContent.includes('(معدّل)')) throw new Error('the panel edit did not stick');
  click('[data-act="undo"]');
  await sleep(60);
  click(`.drawer [data-act="close-drawer"]`);
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
  await tab('accessories');
  const firstToggle = document.querySelector('main tbody input[data-act="include"]');
  const wasChecked = firstToggle.checked;
  change(firstToggle, !wasChecked);
  await waitFor(() => document.querySelector('main tbody input[data-act="include"]').checked === !wasChecked, 'the include toggle');
  click('[data-act="undo"]');
  await waitFor(() => document.querySelector('main tbody input[data-act="include"]').checked === wasChecked, 'undo');
  console.log('ok    a row toggles and undoes');

  // ── Merge two categories, then take it back ────────────────────────────
  await tab('accessories');
  const sectionRows = () => document.querySelectorAll('main .card:last-of-type tbody tr').length;
  const rowsBefore = document.querySelectorAll('main input[data-act="select"][data-coll="categories"]').length;
  if (rowsBefore < 2) throw new Error('no category rows to merge');
  change(document.querySelectorAll('main input[data-act="select"][data-coll="categories"]')[0], true);
  change(document.querySelectorAll('main input[data-act="select"][data-coll="categories"]')[1], true);
  await sleep(60);
  click('[data-act="merge"][data-coll="categories"]');
  await sleep(150);
  const rowsAfter = document.querySelectorAll('main input[data-act="select"][data-coll="categories"]').length;
  if (rowsAfter !== rowsBefore - 1) throw new Error(`merge left ${rowsAfter} rows, expected ${rowsBefore - 1}`);
  click('[data-act="undo"]');
  await sleep(100);
  if (document.querySelectorAll('main input[data-act="select"][data-coll="categories"]').length !== rowsBefore) {
    throw new Error('undo did not restore the merged row');
  }
  console.log('ok    two categories merge into one, and undo brings it back');

  // ── Add a category, then remove the addition ────────────────────────────
  click('[data-act="add-category"]');
  await sleep(80);
  if (document.querySelectorAll('main input[data-act="select"][data-coll="categories"]').length <= rowsBefore) {
    throw new Error('add category did nothing');
  }
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
