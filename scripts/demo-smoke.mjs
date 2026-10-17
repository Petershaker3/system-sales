#!/usr/bin/env node
// Smoke test of the real app's screens in the browser demo (`npm run demo`).
//
// Drives the actual Vue app (not the mockup) on its in-memory demo backend:
// sign in as a seller, sell with the keyboard and the mouse, hold an invoice,
// pay cash, then sign in as the owner and change the look behind a fresh
// password. Saves screenshots to the directory given as the second argument.
//
//   npm run demo &   # serves on :5173
//   node scripts/demo-smoke.mjs http://127.0.0.1:5173/ /tmp/demo-shots
//
// Uses the headless Chromium that the mockup tools install
// (docs/ui/mockup-v1/tools: `npm ci` there first). Not part of CI.

import fs from 'node:fs';
import path from 'node:path';

import { launch } from '../docs/ui/mockup-v1/tools/launch.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:5173/';
const OUT = process.argv[3] || '/tmp/demo-shots';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: 1366, height: 800 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const text = (sel) => page.$eval(sel, (el) => el.textContent?.trim() ?? '').catch(() => '');
const count = (sel) => page.$$eval(sel, (els) => els.length);
async function clickText(selector, label) {
  const handles = await page.$$(selector);
  for (const h of handles) {
    const t = await h.evaluate((el) => el.textContent ?? '');
    if (t.includes(label)) {
      await h.click();
      return true;
    }
  }
  return false;
}
async function signIn(name) {
  await page.waitForSelector('.user-card');
  await clickText('.user-card', name);
  await page.waitForSelector('#login-pass');
  await page.type('#login-pass', '1234');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.shell', { timeout: 5000 });
}

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.waitForSelector('.lock-card');
check('sign-in card shows the three demo accounts', (await count('.user-card')) === 3);
check('demo hint is shown on the sign-in card', (await text('.demo-hint')).includes('1234'));
check('the plate look is applied before sign-in', (await page.$eval('html', (h) => h.dataset.look)) === 'plate');
await shot('01-login');

// --- a seller sells ---------------------------------------------------------
await signIn('يوسف');
await page.waitForSelector('.tile');
check('seller lands on the sales screen', (await text('.topbar h1')) === 'البيع');
const rail = await page.$$eval('.rail .nav-btn span', (els) => els.map((e) => e.textContent));
check('seller sees no owner screens on the rail', !rail.includes('المخزن') && !rail.includes('الإعدادات'), rail.join(','));
check('tiles show the best sellers (12)', (await count('.tile')) === 12);
check('the demo marker is in the top bar', (await text('.fresh-tag')).includes('تجربة'));
await shot('02-pos-seller');

await page.focus('#q');
await page.type('#q', 'شاحن ايفون');
await page.waitForSelector('.result');
check('search normalises أ/ا and finds the charger', (await text('.result .n')).includes('شاحن آيفون'));
await page.keyboard.press('Enter');
await sleep(100);
check('Enter adds the highlighted result', (await count('.line')) === 1);

await clickText('.tile', 'كابل تايب سي');
await sleep(50);
await page.keyboard.press('+');
await sleep(50);
const qty = await page.$$eval('.line .qty span', (els) => els.map((e) => e.textContent));
check('+ raises the selected line to 2', qty.includes('2'), qty.join(','));
check('the total adds up: 450 + 2×80 = 610', (await text('.totals .grand .num')).includes('610'));

await clickText('.tile', 'فلاشة 32 جيجا').then(async (found) => {
  if (!found) {
    await clickText('.chip', 'الكل');
    await sleep(50);
    await clickText('.tile', 'فلاشة 32 جيجا');
  }
});
await sleep(150);
check('an out-of-stock item is refused with a message', (await text('#toasts')).includes('خلصان'));

await page.keyboard.press('F8');
await sleep(100);
check('F8 holds the invoice and opens a new one', (await count('.inv-tab.held')) === 1 && (await count('.line')) === 0);
await page.focus('#q');
await page.type('#q', 'اسكرينه ايفون');
await page.waitForSelector('.result');
await page.keyboard.press('Enter');
await sleep(80);
await shot('03-pos-held');

await page.keyboard.press('F12');
await page.waitForSelector('.modal');
check('F12 opens the cash payment', (await text('.modal-h h2')).includes('الدفع'));
await page.type('#cash-in', '100');
await sleep(50);
check('change is computed: 100 − 75 = 25', (await text('.change-box b')).includes('25'));
await shot('04-pay');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.querySelector('.modal-h h2')?.textContent?.includes('تم البيع'));
check('the sale is recorded with a reference', /INV-\d{8}-0001/.test(await text('.done-t .ref')));
await shot('05-done');
await page.keyboard.press('Enter');
await sleep(150);
check('a fresh invoice is open after paying', (await count('.line')) === 0);
check('the held invoice is still waiting', (await count('.inv-tab.held')) === 1);

// stock went down on the tile
await clickText('.chip', 'الكل');
await sleep(60);
const screenTile = await page.$$eval('.tile', (els) =>
  els.map((e) => e.textContent ?? '').find((t) => t.includes('اسكرينة زجاج آيفون 13')) ?? ''
);
check('stock on the tile went down after the sale (60 → 59)', screenTile.includes('59'), screenTile.replace(/\s+/g, ' '));

// theme switch for everyone
await clickText('.rail .nav-btn', 'غامق');
await sleep(150);
check('a seller can switch to dark', (await page.$eval('html', (h) => h.dataset.theme)) === 'dark');
await shot('06-pos-dark');
await clickText('.rail .nav-btn', 'فاتح');
await sleep(100);

// --- the owner changes the look --------------------------------------------
await clickText('.rail .nav-btn', 'خروج');
await page.waitForSelector('.lock-card');
await signIn('بيتر');
const ownerRail = await page.$$eval('.rail .nav-btn span', (els) => els.map((e) => e.textContent));
check('the owner sees المخزن and الإعدادات', ownerRail.includes('المخزن') && ownerRail.includes('الإعدادات'));
await clickText('.rail .nav-btn', 'الإعدادات');
await page.waitForSelector('.look-card');
await clickText('.look-card', 'علبة الموبايل');
await page.waitForSelector('#look-pass', { timeout: 3000 });
check('changing the look asks for the owner password', true);
await page.type('#look-pass', '1234');
await page.keyboard.press('Enter');
await sleep(300);
check('the box look is applied and stored', (await page.$eval('html', (h) => h.dataset.look)) === 'box');
await shot('07-settings-box');
await clickText('.swatch', '');
await clickText('.rail .nav-btn', 'البيع');
await page.waitForSelector('.tile');
await shot('08-pos-box');
await clickText('.rail .nav-btn', 'المخزن');
await sleep(300);
await shot('09-store');

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
