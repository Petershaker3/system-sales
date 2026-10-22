#!/usr/bin/env node
// «زر ابن النسخة لا يعمل» — the regression this test exists for.
//
// The shop's draft carries a 1280×1280 logo. When the browser never finishes
// decoding that picture (no canvas, a blocked data URL, a machine that hands back
// nothing), the old build waited on it forever: the overlay stayed up, no error
// appeared, and from the owner's chair the button simply did nothing. The button
// must always end somewhere — a backup, or a sentence explaining what stopped it.
//
// Usage: node test/ui-draft.mjs

import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

import { readLegacyBackup } from '../src/legacy.mjs';
import { buildDefaultPlan } from '../src/plan.mjs';

import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../legacy-migration.html', import.meta.url), 'utf8');
const legacyText = readFileSync(new URL('./fixtures/legacy-sample.json', import.meta.url), 'utf8');
const plan = buildDefaultPlan(readLegacyBackup(legacyText));
// A logo that no headless browser can decode — the same shape as the shop's.
plan.settings.logoDataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==';
const draft = JSON.stringify(plan);

const problems = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => {
  const text = String(error.message || error);
  if (text.includes('Not implemented: navigation')) return;
  problems.push(text);
});

let downloaded = null;
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
    window.HTMLAnchorElement.prototype.click = function click() {
      downloaded = this.download;
    };
    const create = window.document.createElement.bind(window.document);
    window.document.createElement = (tag) => {
      const element = create(tag);
      if (tag === 'input') {
        element.click = function clickInput() {
          if (this.type !== 'file') return;
          Object.defineProperty(this, 'files', { value: [{ name: 'draft.json', text: async () => draft }] });
          this.dispatchEvent(new window.Event('change'));
        };
      }
      return element;
    };
  },
});

const { window } = dom;
const { document } = window;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = () => document.getElementById('app')?.textContent || '';
const click = (selector) => document.querySelector(selector).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const change = (element, value) => {
  element.value = value;
  element.dispatchEvent(new window.Event('change', { bubbles: true }));
};

async function main() {
  await sleep(300);
  click('[data-act="pick-draft"]');
  await sleep(600);
  if (!text().includes('النظرة العامة')) throw new Error('the draft did not open');

  click('[data-act="tab"][data-tab="build"]');
  await sleep(150);
  const button = document.querySelector('[data-act="build"]');
  if (!button) throw new Error('no build button');
  if (button.disabled) throw new Error('the build button is disabled with a clean plan');

  change(document.querySelector('input[data-field="password"]'), 'shop12345');
  change(document.querySelector('input[data-field="password2"]'), 'shop12345');
  const started = Date.now();
  click('[data-act="build"]');

  // 40s: the logo deadline is 5s and the encryption is a couple of seconds, so a
  // build that has not finished by now is the hang this test exists to catch.
  while (Date.now() - started < 40000) {
    await sleep(200);
    if (text().includes('النسخة جاهزة')) break;
    if (text().includes('البناء وقف') || text().includes('منعت البناء')) break;
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  if (document.getElementById('overlay')) throw new Error('the progress overlay never closed — the build hung');
  if (!text().includes('النسخة جاهزة')) {
    throw new Error(`the build did not finish in ${seconds}s: ${text().slice(0, 200)}`);
  }
  console.log(`ok    a draft with an undecodable logo still builds (${seconds}s)`);

  if (!text().includes('الشعار')) throw new Error('the owner was not told the logo was skipped');
  console.log('ok    the screen says the logo was skipped instead of failing silently');

  click('[data-act="download"][data-which="backup"]');
  await sleep(100);
  if (!downloaded) throw new Error('no file was offered');
  console.log(`ok    the backup downloads (${downloaded})`);

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
