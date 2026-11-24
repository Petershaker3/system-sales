#!/usr/bin/env node
// مراجعة تكميلية للاستلام (2026-11-05): المورد، والرقم المتأخر، والفصل بين الأدوار.
//
//   npm run demo &            # :5173
//   node scripts/receiving-followup-check.mjs http://127.0.0.1:5173/ /tmp/receiving-shots
//
// Three claims, driven on the real screens:
//
// 1. the delivery form has an explicit **supplier/merchant** field, and the name
//    typed there comes back in the product's receiving history;
// 2. a serial-tracked product shows **tracked + untracked** side by side, and the
//    two add up to the balance;
// 3. the three people the module deals with are three different things on screen:
//    the supplier (delivery form), the recording employee (the session, not a
//    field), and the customer who sold a used phone (its own form).

import fs from 'node:fs';
import path from 'node:path';

import { launch } from '../docs/ui/mockup-v1/tools/launch.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:5173/';
const BASE = `${URL}${URL.includes('?') ? '&' : '?'}shop=1`;
const OUT = process.argv[3] || '/tmp/receiving-shots';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 950 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const text = (sel) => page.$eval(sel, (el) => el.textContent?.trim() ?? '').catch(() => '');
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

async function openScreen(label) {
  const ok = await clickText('.rail .nav-btn', label);
  if (!ok) throw new Error(`rail button not found: ${label}`);
  await sleep(700);
}

/** Answer the owner's password (position carries cost) or the approval PIN. */
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

const num = (raw) => Number.parseInt(raw.replace(/[^\d]/g, ''), 10);

await page.goto(BASE, { waitUntil: 'networkidle0' });
await page.waitForSelector('.lock-card');
await clickText('.user-card', 'بيتر');
await page.waitForSelector('.pinpad');
await page.keyboard.type('1111');
await page.keyboard.press('Enter');
await page.waitForSelector('.tile', { timeout: 9000 });

// --- 1) the delivery form names the supplier, and says who it is not --------
await openScreen('المخزن');
await sleep(1400);
await clickText('[data-store-tab]', 'الاستلام');
await page.waitForSelector('#stock-product', { timeout: 8000 });
await page.waitForFunction(() => document.querySelectorAll('#stock-product option').length > 1, {
  timeout: 8000,
});

check(
  'the delivery form asks for «المورد / التاجر» as its own field',
  (await count('[data-receive-supplier]')) === 1
);
const supplierLabel = await text('[data-receive-supplier]');
check(
  'the supplier field is empty by default and is not the invoice number',
  supplierLabel === '' && (await count('[data-receive-ref]')) === 1
);
const hint = await page.$eval('[data-receive-supplier]', (el) => {
  const field = el.closest('.field');
  return field?.querySelector('.field-hint')?.textContent?.trim() ?? '';
});
check(
  'the field says it is the merchant, not the employee and not the used-phone seller',
  hint.includes('مش الموظف') && hint.includes('موبايل مستعمل'),
  hint.replace(/\s+/g, ' ').slice(0, 70)
);

// --- 2) pick a serial-tracked product and read tracked + untracked ---------
const options = await page.$$eval('#stock-product option', (els) =>
  els.map((e) => ({ value: e.value, label: e.textContent ?? '' })).filter((o) => o.value !== '')
);
const phone = options.find((o) => /Samsung|iPhone|Redmi|Galaxy|مستعمل/i.test(o.label));
check('a phone model is on the shelf to test the serial counters', phone !== undefined, phone?.label);

if (phone) {
  await page.select('#stock-product', phone.value);
  await sleep(400);
  await page.click('#stock-reveal');
  await proveOwner();
  await page.waitForSelector('[data-receive-tracked]', { timeout: 8000 });

  const trackedText = await text('[data-receive-tracked]');
  const untrackedText = await text('[data-receive-untracked]');
  const current = num(await text('[data-receive-current]'));
  // «متسجّل 1 من 5» → 1, and «4 قطعة» → 4.
  const tracked = num(trackedText.split('من')[0]);
  const untracked = num(untrackedText);
  check(
    'the panel shows tracked and untracked side by side',
    (await count('[data-receive-tracked]')) === 1 && (await count('[data-receive-untracked]')) === 1,
    `${trackedText} · ${untrackedText}`
  );
  check(
    'tracked + untracked equals the balance — one number, not two shelves',
    tracked + untracked === current,
    `${tracked} + ${untracked} = ${current}`
  );
  check(
    'the untracked line says registering a number moves a piece, never adds one',
    untrackedText.includes('الرصيد الكلي ما بيتغيّرش')
  );
  await shot('01-tracked-untracked');

  // --- 3) a named supplier rides into the receiving history ---------------
  const supplier = 'مورد الاختبار';
  await fill('[data-receive-supplier]', supplier);
  await fill('[data-receive-ref]', 'INV-2026-77');
  await fill('[data-receive-date]', '2026-11-04');
  await fill('#stock-qty', '1');
  await fill('#stock-cost', '1500');
  await page.click('[data-stock-receive]');
  await sleep(900);
  await proveOwner();
  await sleep(900);

  const notice = await text('[data-stock-notice]');
  check(
    'the receipt is saved and the new balance is announced',
    notice.includes('تم الاستلام') && notice.includes('الرصيد الآن'),
    notice
  );

  const history = await text('[data-receive-history]');
  check(
    'the receiving history shows the supplier that was typed',
    history.includes(supplier),
    history.replace(/\s+/g, ' ').slice(0, 90)
  );
  check(
    'and it shows the invoice reference and the purchase day beside it',
    history.includes('INV-2026-77') && history.includes('2026-11-04')
  );
  await shot('02-receiving-history');

  const afterTracked = num((await text('[data-receive-tracked]')).split('من')[0]);
  const afterCurrent = num(await text('[data-receive-current]'));
  check(
    'receiving one piece without an IMEI grew the balance and the untracked pool, not the serials',
    afterCurrent === current + 1 && afterTracked === tracked,
    `${current} → ${afterCurrent}، مرقّم ${tracked} → ${afterTracked}`
  );
}

// --- 4) the used-phone seller is somebody else -----------------------------
await clickText('[data-receive-door]', 'موبايل مستعمل');
await sleep(900);
if ((await count('#nu-model')) === 0) {
  await clickText('[data-receive-door]', 'موبايل مستعمل');
  await sleep(900);
}
// The delivery form is still mounted behind the modal, so the question is what
// is inside the open form, not what is anywhere on the page.
const supplierInUsedForm = await page.$$eval('.overlay [data-receive-supplier]', (els) => els.length);
check(
  'the used-phone form has its own seller fields and no supplier field',
  (await count('#nu-seller-name')) === 1 && supplierInUsedForm === 0,
  `seller name ${await count('#nu-seller-name')}, supplier inside the form ${supplierInUsedForm}`
);
await shot('03-used-phone-seller');

check('no page errors while driving the receiving screens', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} ok · shots in ${OUT}`);
process.exit(passed === results.length ? 0 : 1);
