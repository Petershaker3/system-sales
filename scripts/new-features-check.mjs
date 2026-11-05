#!/usr/bin/env node
// مراجعة بالعين للشغل الجديد (2026-11-05)، على التطبيق الحقيقي في المتصفح.
//
//   npm run demo &            # :5173
//   node scripts/new-features-check.mjs http://127.0.0.1:5173/ /tmp/new-shots
//
// Drives the real Vue screens on the demo backend and asserts the new hooks end to
// end: a sale, the return door on «المبيعات» opened from that very invoice, the
// wallet month meter moving after a real wallet operation, a two-line supplier
// receipt, the POS quick-repair ticket, the phones services strip, «النهارده»
// frames, and the catalogue search. Writes a screenshot per step.

import fs from 'node:fs';
import path from 'node:path';

import { launch } from '../docs/ui/mockup-v1/tools/launch.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:5173/';
const BASE = `${URL}${URL.includes('?') ? '&' : '?'}shop=1`;
const OUT = process.argv[3] || '/tmp/new-shots';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const text = (sel) => page.$eval(sel, (el) => el.textContent?.trim() ?? '').catch(() => '');
const body = () => text('body');
const count = (sel) => page.$$eval(sel, (els) => els.length).catch(() => 0);
const fill = (sel, value) =>
  page.$eval(
    sel,
    (el, v) => {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    value
  );

async function clickText(selector, label) {
  for (const h of await page.$$(selector)) {
    const t = await h.evaluate((el) => el.textContent ?? '');
    if (t.includes(label)) {
      await h.click();
      return true;
    }
  }
  return false;
}

async function signIn(name, pin) {
  await page.waitForSelector('.user-card');
  await clickText('.user-card', name);
  await page.waitForSelector('.pinpad');
  await page.keyboard.type(pin);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.shell', { timeout: 8000 });
  await page.waitForSelector('.lock.over', { hidden: true, timeout: 8000 });
}

async function openScreen(label) {
  const ok = await clickText('.rail .nav-btn', label);
  if (!ok) throw new Error(`rail button not found: ${label}`);
  await sleep(600);
}

/**
 * Prove the owner's identity where the panel asks for it: `StockPanel` wants the
 * manager's password (the position carries cost), and the approval prompt wants the
 * PIN. Both are answered the way the owner would answer them.
 */
async function proveOwner() {
  const reauth = await page.$('.stock .overlay input[type="password"]');
  if (reauth) {
    await reauth.type('1234');
    await page.keyboard.press('Enter');
    await sleep(900);
    return;
  }
  const approve = await page.$('.approve');
  if (approve) {
    await page.keyboard.type('1111');
    await page.keyboard.press('Enter');
    await sleep(900);
  }
}

await page.goto(BASE, { waitUntil: 'networkidle0' });
await page.waitForSelector('.lock-card');
await signIn('بيتر', '1111');
await page.waitForSelector('.tile', { timeout: 8000 });
check('owner lands on the till', (await text('.topbar h1')) === 'البيع');

// --- 1) the quick repair ticket from the till ------------------------------
check('the till offers «إضافة صيانة / سوفت وير»', (await count('[data-pos-quick-repair]')) === 1);
check('the till offers «خدمات» too (both stayed here, 2026-11-05)', (await count('[data-open-services]')) === 1);
await page.click('[data-pos-quick-repair]');
await page.waitForSelector('[data-quick-repair]', { timeout: 5000 });
check('the quick ticket opens without leaving the invoice', (await count('[data-quick-repair]')) === 1);
check(
  'it offers the real pay methods',
  (await count('[data-quick-repair-pay="cash"]')) === 1 &&
    (await count('[data-quick-repair-pay="instapay"]')) === 1
);
await page.click('[data-quick-repair-kind="hardware"]');
await sleep(150);
check('hardware issues appear for a hardware ticket', (await count('[data-quick-repair-issue="شاشة"]')) === 1);
await fill('[data-quick-repair-device]', 'A15 TEST');
await page.click('[data-quick-repair-issue="شاشة"]');
await fill('[data-quick-repair-price]', '350');
const paidOn = await page.$eval('[data-quick-repair-paid]', (el) => el.checked);
check('«مدفوع واتسلّم دلوقتي» is on by default', paidOn === true);
await shot('01-quick-repair');
await page.click('[data-quick-repair-save]');
await sleep(1000);
check('the ticket is saved and the till comes back', (await count('[data-quick-repair]')) === 0);
check('a toast names the ticket', (await text('#toasts')).includes('تذكرة'), (await text('#toasts')).slice(0, 60));

// --- 2) a real sale, so «المبيعات» has an invoice to return from ------------
// A cheap accessory, so the cash tendered below is always enough.
await page.focus('#q');
await page.type('#q', 'كابل تايب سي');
await page.waitForSelector('.result', { timeout: 5000 });
await page.keyboard.press('Enter');
await sleep(300);
check('a search result adds a line to the invoice', (await count('.line')) === 1);
await page.keyboard.press('F12');
await page.waitForSelector('.modal', { timeout: 5000 });
check('F12 opens the payment', (await text('.modal-h h2')).includes('الدفع'));
await page.type('#cash-in', '100');
await sleep(150);
await page.click('#confirm-pay-btn');
await page.waitForFunction(() => document.querySelector('.modal-h h2')?.textContent?.includes('تم البيع'), {
  timeout: 6000,
});
await page.keyboard.press('Enter');
await sleep(400);
await shot('02-sold');

// --- 3) the return door on «المبيعات» ---------------------------------------
await openScreen('المبيعات');
await sleep(1200);
check('«المبيعات» has its own return button', (await count('[data-sales-return]')) === 1);
const invoices = await count('[data-sales-inv-row]');
check('the sale we just made is in the list', invoices > 0, `${invoices} invoice(s)`);
if (invoices > 0) {
  await page.click('[data-sales-inv-row]');
  await page.waitForSelector('[data-sales-detail-modal]', { timeout: 5000 });
  check('an invoice opens with «مرتجع من الفاتورة دي»', (await count('[data-sales-detail-return]')) === 1);
  await shot('03-invoice');
  await page.click('[data-sales-detail-return]');
  await page.waitForSelector('.modal', { timeout: 6000 });
  await sleep(1200);
  const dialog = await body();
  check(
    'the return dialog opens on that invoice (reason + customer)',
    dialog.includes('سبب المرتجع'),
    dialog.includes('مرتجع') ? 'dialog opened' : 'no dialog'
  );
  await shot('04-return-dialog');
  await page.keyboard.press('Escape');
  await sleep(500);
}

// --- 4) the phones strip: exchange + IMEI check only ------------------------
await openScreen('الهواتف');
await sleep(900);
check('phones has the phone strip', (await count('[data-phone-actions]')) === 1);
check(
  'the strip is استبدال مستعمل · فحص آيمي — services and repair moved to the till',
  (await count('[data-phone-act="tradein"]')) === 1 &&
    (await count('[data-phone-act="imei"]')) === 1 &&
    (await count('[data-phone-act="services"]')) === 0 &&
    (await count('[data-phone-act="repair"]')) === 0 &&
    (await count('[data-phone-act="returns"]')) === 0
);
await shot('05-phones');

// --- 5) the wallet month meter moves on a real operation --------------------
await openScreen('المحافظ');
await sleep(1400);
check('wallet cards carry the month meter', (await count('[data-wal-month]')) > 0);
check('the today frame is on', (await count('[data-wallets-today-frame="true"]')) === 1);
const before = await text('[data-wal-month="vf"]');

await page.click('[data-wal-open-services]');
await page.waitForSelector('[data-services-modal]', { timeout: 6000 });
await sleep(600);
const walletPick = await page.$('[data-svc-wallet="vf"]');
if (walletPick) await walletPick.click();
else await page.click('[data-svc-wallet]');
await sleep(400);
await page.click('[data-svc-wallet-type="deposit"]');
await fill('[data-svc-amt]', '250');
// The commission is the shop's own number: in manual mode the operation is refused
// until it is typed, even when it is zero.
const fee = await page.$('[data-svc-fee]');
if (fee) await fill('[data-svc-fee]', '0');
await sleep(200);
await shot('06-wallet-op');
await page.click('[data-svc-wallet-submit]');
await sleep(1600);
const after = await text('[data-wal-month="vf"]');
check(
  'a 250 EGP deposit moves the month meter',
  before !== after && after.includes('250'),
  `before «${before}» → after «${after}»`
);
await shot('07-wallets-month');

// --- 6) a two-line supplier receipt ----------------------------------------
await openScreen('المخزن');
await sleep(1400);
await clickText('[data-store-tab]', 'الاستلام');
await page.waitForSelector('#stock-product', { timeout: 8000 });
// The picker is filled from `list_products` after the tab mounts.
await page.waitForFunction(() => document.querySelectorAll('#stock-product option').length > 1, {
  timeout: 8000,
});
const productValues = await page.$$eval('#stock-product option', (els) =>
  els.map((e) => e.value).filter((v) => v !== '')
);
check('the receive tab lists products', productValues.length >= 2, `${productValues.length} products`);
if (productValues.length >= 2) {
  const pick = async (value) => page.select('#stock-product', value);
  await pick(productValues[0]);
  await sleep(300);
  await page.click('#stock-reveal');
  await proveOwner();
  await page.waitForSelector('#stock-qty', { timeout: 8000 });
  check('receive offers both «على طول» and «أضف للتوريد»', (await count('[data-stock-add-to-batch]')) === 1 && (await count('[data-stock-receive]')) === 1);
  check('the batch cart is not drawn while it is empty', (await count('[data-stock-batch]')) === 0);

  await fill('#stock-qty', '5');
  await fill('#stock-cost', '40');
  await page.click('[data-stock-add-to-batch]');
  await sleep(500);
  check('the first line goes into the batch cart', (await count('[data-stock-batch-line]')) === 1);

  await pick(productValues[1]);
  await sleep(600);
  await fill('#stock-qty', '3');
  await fill('#stock-cost', '100');
  await page.click('[data-stock-add-to-batch]');
  await sleep(500);
  check('the second line joins the same receipt', (await count('[data-stock-batch-line]')) === 2);
  const cart = await text('[data-stock-batch]');
  check(
    'the cart totals both lines (5×40 + 3×100 = 500 ج.م)',
    cart.includes('500'),
    cart.replace(/\s+/g, ' ').slice(0, 90)
  );
  check('the unit cost is read as money, not as piastres (40 → 40 ج.م)', cart.includes('40 ج.م'), cart.replace(/\s+/g, ' ').slice(0, 90));
  await shot('08-stock-batch');

  const removeOne = await page.$('[data-stock-batch-remove]');
  check('a line can be taken out before saving', removeOne !== null);
  if (removeOne) {
    await removeOne.click();
    await sleep(300);
    check('removing a line leaves the other', (await count('[data-stock-batch-line]')) === 1);
  }
  await page.click('[data-stock-save-batch]');
  await sleep(1800);
  check('saving the batch empties the cart', (await count('[data-stock-batch]')) === 0);
  check('saving the batch reports what it did', (await text('[data-stock-notice]')).includes('توريد'), await text('[data-stock-notice]'));
  await shot('09-stock-saved');
}

// --- 7) expenses open on today --------------------------------------------
await openScreen('المصاريف');
await sleep(900);
check('«المصاريف» opens on «النهارده»', (await count('[data-expenses-today-frame="true"]')) === 1);
await shot('10-expenses');

// --- 8) the catalogue search ----------------------------------------------
await openScreen('المخزن');
await sleep(1200);
await clickText('[data-store-tab]', 'الأصناف');
await sleep(800);
check('the catalogue has one search box', (await count('[data-catalog-search]')) === 1);
await fill('[data-catalog-search-input]', 'شاحن');
await sleep(500);
check('searching the catalogue returns rows', (await count('[data-edit-product]')) > 0, `${await count('[data-edit-product]')} row(s)`);
await shot('11-catalog');

// --- 9) the repair we opened really is in «الصيانة» ------------------------
await openScreen('الصيانة');
await sleep(1200);
check('the quick ticket landed in «الصيانة»', (await body()).includes('A15 TEST'));
await shot('12-repairs');

check('no page errors while driving the app', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ok · shots in ${OUT}`);
if (failed.length > 0) process.exitCode = 1;
