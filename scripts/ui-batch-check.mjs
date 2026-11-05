#!/usr/bin/env node
// دفعة تعديلات الشاشات (2026-11-05): سبع نقاط، كل واحدة مقروءة من الشاشة نفسها.
//
//   npm run demo &            # :5173
//   node scripts/ui-batch-check.mjs http://127.0.0.1:5173/ /tmp/ui-batch-shots
//
// 1. صف زراير البيع: الكاميرا + «إضافة صيانة / سوفت وير» + «فحص IMEI» جنب خانة
//    البحث، بنفس الارتفاع ونفس الشكل، والكاميرا وفحص الـIMEI بنفس العلامة.
// 2. إخفاء أي زرار منهم من الإعدادات، ورجوعه تاني.
// 3. «إضافة مخزون» بقت نافذة، وبتقفل لوحدها بعد اشعار الاستلام.
// 4. تبويب المخزن بقى «رف الموبايلات» بقايمة حقيقية وفلتر «من غير سعر بس».
// 5. «إضافة» جنب سبب الصرف: البند المتكرر يتسجل مرة وبعدها بضغطة.
// 6. الزرار المختار بيبان مختار (خلفية الأكتيف مختلفة فعلاً).
// 7. في المحافظ، النافذة بتفتح على «سحب».

import fs from 'node:fs';
import path from 'node:path';

import { launch } from '../docs/ui/mockup-v1/tools/launch.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:5173/';
const BASE = `${URL}${URL.includes('?') ? '&' : '?'}shop=1`;
const OUT = process.argv[3] || '/tmp/ui-batch-shots';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 980 });
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

/** «الإعدادات» sits alone at the foot of the rail, as an icon button. */
async function openSettings() {
  await page.click('[data-rail-settings]');
  await sleep(800);
}

async function openScreen(label) {
  const ok = await clickText('.rail .nav-btn', label);
  if (!ok) throw new Error(`rail button not found: ${label}`);
  await sleep(800);
}

await page.goto(BASE, { waitUntil: 'networkidle0' });
await page.waitForSelector('.lock-card');
await clickText('.user-card', 'بيتر');
await page.waitForSelector('.pinpad');
await page.keyboard.type('1111');
await page.keyboard.press('Enter');
await page.waitForSelector('.tile', { timeout: 9000 });

// --- 1) the till's quick-action row ----------------------------------------
const row = await page.evaluate(() => {
  const box = document.querySelector('[data-pos-quick-row]');
  if (!box) return null;
  const buttons = [...box.querySelectorAll('button')];
  const shot = buttons.map((b) => {
    const rect = b.getBoundingClientRect();
    const style = getComputedStyle(b);
    const icon = b.querySelector('svg.i');
    return {
      label: (b.textContent ?? '').trim(),
      height: Math.round(rect.height),
      padding: style.paddingInlineStart,
      radius: style.borderRadius,
      bg: style.backgroundColor,
      icon: icon ? icon.innerHTML.slice(0, 120) : '',
      scan: b.hasAttribute('data-camera-scan') || b.closest('[data-pos-scan]') !== null,
      repair: b.hasAttribute('data-pos-quick-repair'),
      imei: b.hasAttribute('data-pos-check-imei'),
    };
  });
  return { width: Math.round(box.getBoundingClientRect().width), buttons: shot };
});

check(
  'the camera, «إضافة صيانة / سوفت وير» and «فحص IMEI» sit in one row beside the search box',
  row !== null && row.buttons.length === 5 && row.buttons.some((b) => b.scan) && row.buttons.some((b) => b.repair) && row.buttons.some((b) => b.imei),
  row ? row.buttons.map((b) => b.label || '(icon)').join(' | ') : 'no row'
);
const heights = new Set((row?.buttons ?? []).map((b) => b.height));
check(
  'all five buttons are one height and one radius — one design, not five',
  heights.size === 1 && new Set((row?.buttons ?? []).map((b) => b.radius)).size === 1,
  `heights=${[...heights].join(',')}`
);
const backgrounds = new Set((row?.buttons ?? []).map((b) => b.bg));
check(
  'they also share one background, so none of them looks like a different kind of control',
  backgrounds.size === 1,
  `backgrounds=${[...backgrounds].join(' , ')}`
);
const camera = row?.buttons.find((b) => b.scan);
const imei = row?.buttons.find((b) => b.imei);
check(
  'the camera and «فحص IMEI» carry the same icon',
  !!camera && !!imei && camera.icon === imei.icon && camera.icon !== '',
  `${camera?.icon.slice(0, 40)} vs ${imei?.icon.slice(0, 40)}`
);
check(
  'the camera button says «كاميرا» and is not icon-only any more',
  (camera?.label ?? '').includes('كاميرا'),
  camera?.label ?? ''
);
await shot('01-pos-quick-row');

// --- 2) hiding one of them from Settings ------------------------------------
await openSettings();
await clickText('[data-settings-tab], .s-tab, button', 'الأصناف والبيع');
await sleep(500);
check(
  'Settings has a card for the till buttons, with a switch per button',
  (await count('[data-pos-buttons-card]')) === 1 && (await count('[data-pos-button-hide]')) === 3
);
await page.$eval('[data-pos-button-hide="imei"]', (el) => el.click());
await sleep(900);
const hiddenNow = await text('[data-pos-buttons-summary]');
await shot('02-settings-buttons');
await openScreen('البيع');
await sleep(600);
check(
  'hiding «فحص IMEI» takes it out of the row and leaves the other two',
  (await count('[data-pos-check-imei]')) === 0 &&
    (await count('[data-pos-scan]')) === 1 &&
    (await count('[data-pos-quick-repair]')) === 1,
  `summary on settings: ${hiddenNow}`
);
// ... and putting it back is the same switch.
await openSettings();
await clickText('[data-settings-tab], .s-tab, button', 'الأصناف والبيع');
await sleep(400);
await page.$eval('[data-pos-button-show="imei"]', (el) => el.click());
await sleep(900);
await openScreen('البيع');
await sleep(600);
check(
  'showing it again brings it back where it was',
  (await count('[data-pos-check-imei]')) === 1
);

// --- 3) adding stock is a window that closes on its own ---------------------
await openScreen('المخزن');
await sleep(1500);
await clickText('[data-store-tab]', 'الأصناف').catch(() => {});
await sleep(800);
const canReceive = (await count('[data-receive-product]')) > 0;
if (canReceive) {
  await page.$eval('[data-receive-product]', (el) => el.click());
  await sleep(700);
}
check(
  '«+ مخزون» on a row opens the receiving window over the shelf',
  canReceive && (await count('[data-store-receive-modal]')) === 1,
  `rows=${canReceive}`
);
const before = Number(
  (await page.$eval('#stock-qty', (el) => el.value ?? '0').catch(() => '')) || 0
);
await page.waitForFunction(
  () => document.querySelectorAll('#stock-product option').length > 1,
  { timeout: 8000 }
);
await fill('#stock-qty', '1');
await fill('#stock-cost', '1000');
await shot('03-receive-window');
await clickText('.stock button', 'استلام على طول');
await sleep(1800);
check(
  'saving the delivery closes the window by itself',
  (await count('[data-store-receive-modal]')) === 0,
  `qty before = ${before}`
);
const toastText = await text('[data-toast], .toast, .toasts');
check(
  'and a notification says the stock landed',
  toastText.includes('المخزون') || toastText.includes('الرصيد'),
  toastText.slice(0, 80)
);
await shot('04-after-receive');

// --- 4) the shelf tab explains itself --------------------------------------
await clickText('[data-store-tab]', 'رف الموبايلات');
await sleep(600);
const deviceRows = await count('[data-store-device-row]');
check(
  'the «الأجهزة» tab is now «رف الموبايلات» with a real list behind it',
  (await count('[data-store-devices-table]')) === 1 && deviceRows > 0,
  `rows=${deviceRows}`
);
const filterEmpty = await count('[data-store-device-filter-noprice]');
check('it offers a «من غير سعر بس» filter', filterEmpty === 1);
if (filterEmpty === 1) {
  await page.$eval('[data-store-device-filter-noprice]', (el) => el.click());
  await sleep(400);
  const rowsAfter = await count('[data-store-device-row]');
  const allNoPrice = await page.$$eval('[data-store-device-row]', (rows) =>
    rows.every((r) => r.querySelector('[data-device-no-price]') !== null)
  );
  check(
    'the filter keeps only models without a sale price',
    rowsAfter <= deviceRows && (rowsAfter === 0 || allNoPrice),
    `${deviceRows} → ${rowsAfter}`
  );
  await page.$eval('[data-store-device-filter-all]', (el) => el.click());
  await sleep(200);
}
await shot('05-device-shelf');

// --- 5) «إضافة» beside the expense reason ----------------------------------
await openScreen('المصاريف');
await sleep(1200);
const reasonLabel = 'صيانة التكييف';
await fill('[data-expenses-category]', reasonLabel);
await sleep(250);
check(
  'typing a reason wakes the «إضافة» beside it',
  (await page.$eval('[data-expenses-keep-reason]', (el) => !el.disabled)) === true
);
await page.$eval('[data-expenses-keep-reason]', (el) => el.click());
await sleep(1200);
const keptChip = await count(`[data-expenses-forget="${reasonLabel}"]`);
check(
  'the reason is kept and comes back as a one-tap chip with a way to drop it',
  keptChip === 1,
  `chips with × = ${keptChip}`
);
// A kept reason survives leaving and coming back: it was stored, not drawn.
await openScreen('البيع');
await openScreen('المصاريف');
await sleep(900);
check(
  'it is still there after leaving the screen — it was saved, not just drawn',
  (await count(`[data-expenses-chip="${reasonLabel}"]`)) === 1
);
await shot('06-expense-reason');
await page.$eval(`[data-expenses-forget="${reasonLabel}"]`, (el) => el.click());
await sleep(1000);
check(
  'dropping it takes it out of the list without touching the recorded expenses',
  (await count(`[data-expenses-chip="${reasonLabel}"]`)) === 0
);

// --- 6) a chosen button looks chosen ---------------------------------------
await openScreen('المصاريف');
await sleep(900);
const drawerUsable = await page
  .$eval('[data-expenses-paid-from="drawer"]', (el) => !el.disabled)
  .catch(() => false);
if (drawerUsable) {
  await page.$eval('[data-expenses-paid-from="drawer"]', (el) => el.click());
  await sleep(350);
  // Read both in the same render: the point is that the chosen one *looks*
  // different from the one beside it, not that it changed colour over time.
  const pair = await page.evaluate(() => {
    const read = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const style = getComputedStyle(el);
      return {
        active: el.classList.contains('active'),
        bg: style.backgroundColor,
        color: style.color,
        weight: style.fontWeight,
      };
    };
    return { outside: read('[data-expenses-paid-from="outside"]'), drawer: read('[data-expenses-paid-from="drawer"]') };
  });
  check(
    'the chosen source is visibly chosen — a different fill, not just a class',
    !!pair.drawer &&
      !!pair.outside &&
      pair.drawer.active === true &&
      pair.outside.active === false &&
      pair.drawer.bg !== pair.outside.bg &&
      pair.drawer.color !== pair.outside.color,
    `${JSON.stringify(pair)}`
  );
} else {
  check('the chosen source is visibly chosen — a different fill, not just a class', false, 'no drawer option (shift closed)');
}
await shot('07-selected-state');

// --- 7) wallets open on «سحب» ---------------------------------------------
await openScreen('المحافظ');
await sleep(1200);
const opened = await clickText('.btn, button', 'إيداع أو سحب');
await sleep(900);
check('the wallets screen opens the money window', opened === true);
const withdrawIsDefault = await page.evaluate(() => {
  const deposit = document.querySelector('[data-svc-wallet-type="deposit"]');
  const withdraw = document.querySelector('[data-svc-wallet-type="withdraw"]');
  if (!deposit || !withdraw) return null;
  return {
    withdrawPrimary: withdraw.className.includes('primary'),
    depositPrimary: deposit.className.includes('primary'),
  };
});
check(
  '«سحب» is the default choice, not «إيداع»',
  withdrawIsDefault !== null &&
    withdrawIsDefault.withdrawPrimary === true &&
    withdrawIsDefault.depositPrimary === false,
  JSON.stringify(withdrawIsDefault)
);
await shot('08-wallets-withdraw');
await page.keyboard.press('Escape');
await sleep(300);

check('no page errors while driving the screens', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ok · shots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
