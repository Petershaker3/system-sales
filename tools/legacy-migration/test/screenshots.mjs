#!/usr/bin/env node
// Pictures of the real single-file tool, from the real shop's backup.
//
// The headless browser ships no Arabic font, so the HTML must carry it: `build.mjs`
// inlines Changa, and these screenshots are the check that it does. A screenshot
// with empty boxes is a missing-font bug, not a layout bug.
//
// Usage: node test/screenshots.mjs <legacy.json> <out-dir>
//
// Needs the browser that `docs/ui/mockup-v1/tools/launch.mjs` unpacks; run
// `npm ci` once inside `docs/ui/mockup-v1/tools`.

import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { launch } from '../../../docs/ui/mockup-v1/tools/launch.mjs';

const [legacyPath, outDir] = process.argv.slice(2);
if (!legacyPath || !outDir) {
  console.error('usage: screenshots.mjs <legacy.json> <out-dir>');
  process.exit(2);
}

const here = path.dirname(new URL(import.meta.url).pathname);
const file = 'file://' + path.resolve(here, '..', 'legacy-migration.html');
const out = path.resolve(process.cwd(), outDir);
mkdirSync(out, { recursive: true });

const legacyText = readFileSync(legacyPath, 'utf8');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
await page.goto(file);

// Drop the backup the way the owner does. A file input cannot be scripted from a
// plain `file://` page in headless Chromium, but a drop event can.
await page.evaluate((text) => {
  const transfer = new DataTransfer();
  transfer.items.add(new File([text], 'legacy.json', { type: 'application/json' }));
  document.getElementById('drop').dispatchEvent(
    new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
  );
}, legacyText);
await page.waitForFunction(() => document.querySelectorAll('table').length > 0, { timeout: 120000 });
await wait(800);

const shoot = async (name) => {
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log('wrote', path.join(out, `${name}.png`));
};
const openTab = async (tab) => {
  await page.click(`nav.tabs [data-act="tab"][data-tab="${tab}"]`);
  await wait(600);
};

await openTab('overview');
await shoot('01-overview');

// The same screen at night. The theme is a real switch, so the picture is taken
// by pressing it, not by forcing colours in the test.
await page.click('[data-act="theme"]');
await wait(300);
await shoot('01b-overview-dark');
await page.click('[data-act="theme"]');
await wait(300);

await openTab('accessories');
await shoot('02-accessories');

await openTab('phones');
await shoot('03-phones');

// The used shelf's drawer: the IMEI panel, with one device added and one bad number
// handed back to be fixed.
await page.evaluate(() => document.querySelector('table[data-shelf="used"] [data-act="details"]')?.click());
await wait(600);
await page.evaluate(() => {
  const box = document.querySelector('[data-act="device-text"]');
  box.value = '357111111111112\n1234';
  box.dispatchEvent(new Event('input', { bubbles: true }));
});
await wait(200);
await page.select('[data-act="device-condition"]', 'B');
await page.click('[data-act="add-devices"]');
await wait(600);
const panel = await page.$('.drawer [data-devices]');
if (panel) {
  await panel.screenshot({ path: path.join(out, '04-used-devices.png') });
  console.log('wrote', path.join(out, '04-used-devices.png'));
}

await browser.close();
if (problems.length) {
  console.error('page errors:', problems.join(' | '));
  process.exit(1);
}
