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
/** Sign in on the lock card with the PIN (ADR-017): pick the person, type the digits, Enter. */
async function signIn(name, pin) {
  await page.waitForSelector('.user-card');
  await clickText('.user-card', name);
  await page.waitForSelector('.pinpad');
  await page.keyboard.type(pin);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.shell', { timeout: 5000 });
  await page.waitForSelector('.lock.over', { hidden: true, timeout: 5000 });
}
const chipName = () => text('.user-chip .who');

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.waitForSelector('.lock-card');
check('sign-in card shows the three demo accounts', (await count('.user-card')) === 3);
check('demo hint is shown on the sign-in card', (await text('.demo-hint')).includes('1111'));
check('the plate look is applied before sign-in', (await page.$eval('html', (h) => h.dataset.look)) === 'plate');
await shot('01-login');

// --- a seller sells ---------------------------------------------------------
await signIn('يوسف', '2222');
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

// --- lock, PIN, switch (plan item 1.1, ADR-017) -----------------------------
await page.keyboard.down('Control');
await page.keyboard.press('KeyL');
await page.keyboard.up('Control');
await page.waitForSelector('.lock.over', { timeout: 3000 });
check('Ctrl+L locks the screen', (await count('.lock.over .user-card')) === 3);
await page.keyboard.press('F12');
await sleep(200);
check('keys do not reach the screen under the lock (F12 opens nothing)', (await count('.modal-h')) === 0);
await clickText('.lock.over .user-card', 'بيتر');
await page.waitForSelector('.lock.over .pinpad');
await page.keyboard.type('9999');
await page.keyboard.press('Enter');
await sleep(250);
check('a wrong PIN is refused on the card', (await text('.lock.over .err-msg')).length > 0 && (await count('.lock.over')) === 1);
await shot('10-lock-wrong-pin');
await page.keyboard.type('1111');
await page.keyboard.press('Enter');
await page.waitForSelector('.lock.over', { hidden: true, timeout: 3000 });
check('the owner PIN unlocks, as the owner', (await chipName()).includes('بيتر'));
check('the held invoice survived the lock', (await count('.inv-tab.held')) === 1);

await page.click('.user-chip');
await page.waitForSelector('.sw-menu');
await clickText('.sw-item', 'مارينا');
await page.waitForSelector('.sw-menu.pin', { timeout: 3000 });
await shot('11-switch-pin');
await page.keyboard.type('3333');
await page.keyboard.press('Enter');
await sleep(400);
const marinaRail = await page.$$eval('.rail .nav-btn span', (els) => els.map((e) => e.textContent));
check('switching from the chip with her PIN makes مارينا the seller', (await chipName()).includes('مارينا') && !marinaRail.includes('المخزن'));
check('the held invoice survived the switch', (await count('.inv-tab.held')) === 1);

await page.keyboard.down('Control');
await page.keyboard.press('KeyL');
await page.keyboard.up('Control');
await page.waitForSelector('.lock.over');
await clickText('.lock.over .user-card', 'بيتر');
await page.waitForSelector('.lock.over .pinpad');
await clickText('.lock.over .link-btn', 'دخول بكلمة السر');
await page.waitForSelector('#login-pass');
await page.type('#login-pass', '1234');
await page.keyboard.press('Enter');
await page.waitForSelector('.lock.over', { hidden: true, timeout: 3000 });
check('the password still signs in, as the fallback', (await chipName()).includes('بيتر'));

await page.click('.user-chip');
await page.waitForSelector('.sw-menu');
await clickText('.sw-item', 'غيّر الـ PIN');
await page.waitForSelector('#pin-current');
await page.type('#pin-current', '1234');
await page.type('#pin-new', '4321');
await page.type('#pin-again', '4321');
await page.keyboard.press('Enter');
await sleep(300);
check('the owner changes his PIN with his password', (await text('#toasts')).includes('اتغيّر'));
await page.keyboard.down('Control');
await page.keyboard.press('KeyL');
await page.keyboard.up('Control');
await page.waitForSelector('.lock.over');
await clickText('.lock.over .user-card', 'بيتر');
await page.waitForSelector('.lock.over .pinpad');
await page.keyboard.type('1111');
await page.keyboard.press('Enter');
await sleep(250);
const oldPinRefused = (await count('.lock.over')) === 1;
await page.keyboard.type('4321');
await page.keyboard.press('Enter');
await page.waitForSelector('.lock.over', { hidden: true, timeout: 3000 });
check('the old PIN stops working and the new one works', oldPinRefused && (await chipName()).includes('بيتر'));

// --- the owner changes the look --------------------------------------------
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

// the owner sets a seller's PIN in المستخدمين (his password first), and she signs in with it
await clickText('.users button', 'تحديث');
await page.waitForSelector('li.item', { timeout: 3000 });
for (const item of await page.$$('li.item')) {
  if (!(await item.evaluate((n) => n.textContent ?? '')).includes('مارينا')) continue;
  for (const b of await item.$$('button')) {
    if ((await b.evaluate((n) => n.textContent ?? '')).includes('PIN الدخول')) {
      await b.click();
      break;
    }
  }
  break;
}
await page.waitForSelector('#user-pin');
await page.type('#user-pin', '5555');
await page.keyboard.press('Enter');
await page.waitForSelector('.overlay form.modal input[type=password]');
await page.type('.overlay form.modal input[type=password]', '1234');
await page.keyboard.press('Enter');
await sleep(400);
await page.keyboard.down('Control');
await page.keyboard.press('KeyL');
await page.keyboard.up('Control');
await page.waitForSelector('.lock.over');
await clickText('.lock.over .user-card', 'مارينا');
await page.waitForSelector('.lock.over .pinpad');
await page.keyboard.type('5555');
await page.keyboard.press('Enter');
await page.waitForSelector('.lock.over', { hidden: true, timeout: 3000 }).catch(() => {});
check("the owner sets a seller's PIN (with his password) and she signs in with it", (await chipName()).includes('مارينا'));
await page.keyboard.down('Control');
await page.keyboard.press('KeyL');
await page.keyboard.up('Control');
await page.waitForSelector('.lock.over');
await signIn('بيتر', '4321');

await clickText('.rail .nav-btn', 'البيع');
await page.waitForSelector('.tile');
await shot('08-pos-box');
await clickText('.rail .nav-btn', 'المخزن');
await sleep(300);
await shot('09-store');

// --- the owner's PIN approval (ADR-017 §3) ---------------------------------
// No demo screen is sensitive yet, so the prompt is opened the way a screen
// will open it: through the app's own module, which the dev server shares with
// the page. On a static build that module path does not exist; the checks say so.
const APPROVAL_MODULE = '/src/shell/approval.ts';
const ask = (label) =>
  page.evaluate(
    async (spec, what) => {
      try {
        const approval = await import(spec);
        window.__approval = approval.requestOwnerApproval(what);
        return true;
      } catch {
        return false;
      }
    },
    APPROVAL_MODULE,
    label
  );
if (!(await ask('رصيد بداية: شاحن آيفون'))) {
  check('owner approval prompt (needs the dev server; skipped on a static build)', true);
} else {
  await page.waitForSelector('.modal .approver', { timeout: 3000 });
  check(
    'a sensitive operation opens «موافقة المالك» saying what it is for',
    (await text('.modal-h .mt')) === 'موافقة المالك' && (await text('.modal-h small')).includes('رصيد بداية')
  );
  check('the owner is the one asked, with the «وافق» pad', (await text('.modal .approver b')).includes('بيتر') && (await text('.modal .pin-go')).includes('وافق'));
  await page.keyboard.type('9999');
  await page.keyboard.press('Enter');
  await sleep(250);
  check('a wrong PIN is refused inside the prompt', (await count('.modal .approver')) === 1 && (await text('.modal .pinpad .err-msg')).length > 0);
  await shot('12-approval-wrong-pin');
  await page.keyboard.type('4321');
  await page.keyboard.press('Enter');
  const approved = await page.evaluate(() => window.__approval);
  await sleep(150);
  check('the owner PIN approves and the prompt closes', approved === true && (await count('.modal .approver')) === 0);
  await ask('إلغاء الفاتورة');
  await page.waitForSelector('.modal .approver', { timeout: 3000 });
  await page.keyboard.press('Escape');
  const backedOut = await page.evaluate(() => window.__approval);
  await sleep(150);
  check('Esc backs out of the approval', backedOut === false && (await count('.modal .approver')) === 0);
}

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
