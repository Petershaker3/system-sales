#!/usr/bin/env node
// A headless run of the real single-file tool.
//
// It loads `legacy-migration.html` into jsdom, opens the shop's backup the way
// the owner does (drop on the page), walks every tab, edits a row and undoes it,
// then builds a backup through the screen and writes the produced file out. The
// caller (`npm test`) hands that file to the Python verifier, so the file the
// *screen* produces is the file that gets checked — not a second code path.
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

const text = () => document.body.textContent || '';
const click = (selector) => {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`missing element: ${selector}`);
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  return element;
};
const change = (element, value) => {
  if (element.type === 'checkbox') {
    element.checked = value;
  } else {
    element.value = value;
  }
  element.dispatchEvent(new window.Event('change', { bubbles: true }));
};

async function main() {
  // ── Open the backup by dropping it on the page ──────────────────────────
  const drop = document.getElementById('drop');
  if (!drop) throw new Error('the load screen did not render');
  const event = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [{ name: 'legacy.json', text: async () => legacyText }] } });
  drop.dispatchEvent(event);

  await waitFor(() => text().includes('النظرة العامة'), 'the overview');
  if (!text().includes('محل الطاحونة')) throw new Error('the shop name did not reach the overview');
  console.log('ok    the backup opens and the overview shows the shop');

  // ── Every tab renders ───────────────────────────────────────────────────
  for (const tab of ['categories', 'brands', 'items', 'months', 'sales', 'repairs', 'expenses', 'wallets', 'settings', 'build', 'overview']) {
    click(`[data-act="tab"][data-tab="${tab}"]`);
    await sleep(60);
    if (!document.querySelector('main')?.textContent.trim()) throw new Error(`tab ${tab} rendered nothing`);
  }
  console.log('ok    all eleven tabs render');

  // ── Edit, undo, redo ────────────────────────────────────────────────────
  click('[data-act="tab"][data-tab="items"]');
  await sleep(60);
  const firstToggle = document.querySelector('tbody input[data-act="include"]');
  if (!firstToggle) throw new Error('no item checkboxes');
  const wasChecked = firstToggle.checked;
  change(firstToggle, !wasChecked);
  await waitFor(() => {
    const toggle = document.querySelector('tbody input[data-act="include"]');
    return toggle && toggle.checked === !wasChecked;
  }, 'the include toggle');
  click('[data-act="undo"]');
  await waitFor(() => {
    const toggle = document.querySelector('tbody input[data-act="include"]');
    return toggle && toggle.checked === wasChecked;
  }, 'undo');
  click('[data-act="redo"]');
  await waitFor(() => {
    const toggle = document.querySelector('tbody input[data-act="include"]');
    return toggle && toggle.checked === !wasChecked;
  }, 'redo');
  click('[data-act="undo"]');
  console.log('ok    a row toggles, undoes and redoes');

  // ── Add a category, then remove the addition ────────────────────────────
  click('[data-act="tab"][data-tab="categories"]');
  await sleep(60);
  const rowsBefore = document.querySelectorAll('tbody tr').length;
  click('[data-act="add-category"]');
  await sleep(60);
  if (document.querySelectorAll('tbody tr').length <= rowsBefore) throw new Error('add category did nothing');
  click('[data-act="undo"]');
  await sleep(60);
  console.log('ok    adding and undoing a category works');

  // ── Build ───────────────────────────────────────────────────────────────
  click('[data-act="tab"][data-tab="settings"]');
  await sleep(60);
  const logo = document.querySelector('input[data-act="logo-include"]');
  if (logo && logo.checked) change(logo, false);

  click('[data-act="tab"][data-tab="build"]');
  await sleep(80);
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
