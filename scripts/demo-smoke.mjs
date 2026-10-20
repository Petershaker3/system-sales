#!/usr/bin/env node
// Smoke test of the real app's screens in the browser demo (`npm run demo`).
//
// Drives the actual Vue app (not the mockup) on its in-memory demo backend:
// sign in as a seller, sell with the keyboard and the mouse, hold an invoice,
// pay cash, browse the categories and the phone companies, then sign in as the
// owner, change the look behind a fresh password, manage the categories and the
// companies, and register a new phone. Saves screenshots to the directory given as the second argument.
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
// The demo opens on a shop with no account (`ADR-039`). This suite is the fake-data
// shop — three accounts, a lock card, stock — because most of its flows sign somebody
// in, and `?shop=1` is the flag that still has people in it.
const BASE = `${URL}${URL.includes('?') ? '&' : '?'}shop=1`;
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
/** Click the first element whose whole trimmed text is `label` (chips like «8GB» vs «128GB»). */
async function clickExact(selector, label) {
  for (const h of await page.$$(selector)) {
    if (((await h.evaluate((el) => el.textContent ?? '')).trim()) === label) {
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

await page.goto(BASE, { waitUntil: 'networkidle0' });
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

// --- categories on the sales screen (plan item 1.2, ADR-018 §1) -------------
const mainChipNames = await page.$$eval('.chips.cats .chip', (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
check(
  'the main categories follow «الأكثر مبيعًا» and «الكل», each with its count',
  mainChipNames.length === 7 && mainChipNames.some((t) => t.startsWith('إكسسوارات') && t.endsWith('16')),
  mainChipNames.join('، ')
);
await clickText('.chips.cats .chip', 'إكسسوارات');
await sleep(80);
const subChipNames = await page.$$eval('.chips.subcats .chip', (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
check('a main category opens its sub-categories in a second row', subChipNames.length === 7 && subChipNames.some((t) => t.includes('شواحن')), subChipNames.join('، '));
await clickText('.chips.subcats .chip', 'شواحن');
await sleep(80);
const chargerTiles = await page.$$eval('.tile .name', (els) => els.map((e) => e.textContent?.trim() ?? ''));
check('a sub-category shows only its products', chargerTiles.length === 2 && chargerTiles.every((n) => n.includes('شاحن')), chargerTiles.join('، '));
await shot('15-pos-subcategories');
await clickText('.chips.subcats .chip', 'شواحن');
await sleep(80);
check(
  'clicking the chosen sub-category again goes back to its main',
  (await count('.chips.subcats .chip.on')) === 0 && (await text('.chips.cats .chip.on')).includes('إكسسوارات')
);
await page.focus('#q');
await page.type('#q', 'حوامل');
await page.waitForSelector('.result');
check('search finds a product by its category\'s name', (await text('.result .n')).includes('حامل'));
await page.keyboard.press('Escape');

// --- phone companies on the sales screen (ADR-018 §2) -----------------------
await clickText('.chips.cats .chip', 'موبايلات جديدة');
await sleep(80);
const brandChipNames = await page.$$eval('.chips.subcats .chip', (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
check(
  'a phone category shows its companies in the second row, in the owner\'s order',
  brandChipNames.join('|') === 'Samsung1|Apple1|Xiaomi1',
  brandChipNames.join('، ')
);
await clickText('.chips.subcats .chip', 'Apple');
await sleep(80);
const appleTiles = await page.$$eval('.tile .name', (els) => els.map((e) => e.textContent?.trim() ?? ''));
check('a company chip shows only its phones', appleTiles.length === 1 && appleTiles[0] === 'iPhone 16 128GB', appleTiles.join('، '));
await page.focus('#q');
await page.type('#q', 'سامسونج');
await page.waitForSelector('.result');
const arabicHits = await page.$$eval('.result .n', (els) => els.map((e) => e.textContent?.trim() ?? ''));
check(
  'search finds a phone by its company in Arabic (its name has no Arabic)',
  arabicHits.some((n) => n.includes('Samsung Galaxy A16')),
  arabicHits.join('، ')
);
await page.keyboard.press('Escape');
await clickText('.chips.cats .chip', 'الكل');
await sleep(60);

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

// --- the owner's categories (plan item 1.2, ADR-018 §1) --------------------
const catRowNames = () =>
  page.$$eval('.categories-card .cat-row', (els) =>
    els.map((e) => ({ name: e.querySelector('.cat-name')?.value ?? '', sub: e.classList.contains('sub'), off: e.classList.contains('off'), del: !!e.querySelector('.danger') }))
  );
await page.waitForSelector('.categories-card .cat-row');
const startRows = await catRowNames();
check(
  'the settings list the default tree, subs under their main, nothing with products deletable',
  startRows.length === 12 && startRows.filter((r) => r.sub).length === 7 && startRows.every((r) => !r.del),
  String(startRows.length)
);
await page.type('#cat-new', 'جرابات تابلت');
const accValue = await page.$eval('#cat-parent', (sel) => [...sel.options].find((o) => (o.textContent ?? '').includes('إكسسوارات'))?.value ?? '');
await page.select('#cat-parent', accValue);
await sleep(60);
const kindLocked = await page.$eval('#cat-kind', (sel) => sel.disabled);
await page.click('.icon-pick button[title="shield"]');
await page.click('.categories-card .cat-add button[type=submit]');
await sleep(200);
const afterAdd = await catRowNames();
const added = afterAdd.find((r) => r.name === 'جرابات تابلت');
check('a sub-category is added under its main, with the main\'s kind', kindLocked && added?.sub === true && added?.del === true, JSON.stringify(added));
await page.type('#cat-new', 'شواحن');
await page.select('#cat-parent', '');
await page.click('.categories-card .cat-add button[type=submit]');
await sleep(200);
check('a name already in the tree is refused', (await text('#toasts')).includes('فيه تصنيف بالاسم ده'));
await page.$eval('#cat-new', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
for (const row of await page.$$('.categories-card .cat-row')) {
  if ((await row.$eval('.cat-name', (el) => el.value)) !== 'حوامل') continue;
  await row.$eval('.cat-name', (el) => { el.value = 'حوامل عربية'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  break;
}
await sleep(200);
check('a category is renamed by typing on its name', (await catRowNames()).some((r) => r.name === 'حوامل عربية'));
for (const row of await page.$$('.categories-card .cat-row')) {
  if ((await row.$eval('.cat-name', (el) => el.value)) !== 'كروت شحن') continue;
  await row.$eval('input[type=checkbox]', (el) => el.click());
  break;
}
await sleep(200);
for (const row of await page.$$('.categories-card .cat-row')) {
  if ((await row.$eval('.cat-name', (el) => el.value)) !== 'كروت شحن') continue;
  await (await row.$('button[title="لفوق"]')).click();
  break;
}
await sleep(200);
const mainsNow = (await catRowNames()).filter((r) => !r.sub);
check(
  'a hidden category is greyed, and the arrows move it among the mains',
  mainsNow.find((r) => r.name === 'كروت شحن')?.off === true &&
    mainsNow.findIndex((r) => r.name === 'كروت شحن') < mainsNow.findIndex((r) => r.name === 'ساعات ذكية'),
  mainsNow.map((r) => r.name).join('، ')
);
await shot('16-settings-categories');
for (const row of await page.$$('.categories-card .cat-row')) {
  if ((await row.$eval('.cat-name', (el) => el.value)) !== 'جرابات تابلت') continue;
  await (await row.$('.danger')).click();
  break;
}
await sleep(200);
check('an empty category the owner made is deleted', !(await catRowNames()).some((r) => r.name === 'جرابات تابلت'));

// --- the owner's phone companies (ADR-018 §2) ------------------------------
const brandRows = () =>
  page.$$eval('.brands-card .cat-row', (els) =>
    els.map((e) => ({ name: e.querySelector('.cat-name')?.value ?? '', type: e.querySelector('select')?.value ?? '', off: e.classList.contains('off'), del: !!e.querySelector('.danger') }))
  );
await page.waitForSelector('.brands-card .cat-row');
const firstBrands = await brandRows();
check(
  'the settings list the twelve default companies, none deletable',
  firstBrands.length === 12 && firstBrands[0].name === 'Samsung' && firstBrands.every((r) => !r.del) && firstBrands.find((r) => r.name === 'itel')?.type === 'keypad',
  String(firstBrands.length)
);
await page.type('#br-new', 'Motorola');
await page.click('.brands-card .cat-add button[type=submit]');
await sleep(200);
const withMotorola = await brandRows();
check('a company is added at the end, deletable while it has no phone', withMotorola.at(-1)?.name === 'Motorola' && withMotorola.at(-1)?.del === true);
await page.type('#br-new', 'samsung');
await page.click('.brands-card .cat-add button[type=submit]');
await sleep(200);
check('a company name already used is refused, whatever the case', (await text('#toasts')).includes('فيه شركة بالاسم ده'));
await page.$eval('#br-new', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
for (const row of await page.$$('.brands-card .cat-row')) {
  if ((await row.$eval('.cat-name', (el) => el.value)) !== 'vivo') continue;
  await row.$eval('input[type=checkbox]', (el) => el.click());
  break;
}
await sleep(200);
check('a company is hidden from «موبايل جديد»', (await brandRows()).find((r) => r.name === 'vivo')?.off === true);
await shot('17-settings-brands');

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
const hiddenChipGone = !(await text('.chips.cats')).includes('كروت شحن');
await clickText('.chips.cats .chip', 'الكل');
await sleep(60);
const hiddenStillSold = (await page.$$eval('.tile .name', (els) => els.map((e) => e.textContent ?? ''))).some((t) => t.includes('كارت شحن فودافون'));
check('a hidden category has no chip, and its products still sell from «الكل»', hiddenChipGone && hiddenStillSold);
await clickText('.rail .nav-btn', 'المخزن');
await sleep(300);
await shot('09-store');

// --- «صنف جديد»: the kind chooser and a counted item (ADR-018 §3) ----------
check('the store offers «صنف جديد», not a lone «موبايل جديد»', (await text('.page-h button')).includes('صنف جديد'));
check('the receiving panel has its own «صنف جديد»', (await text('.stock-head')).includes('صنف جديد'));
await clickText('.page-h button', 'صنف جديد');
await page.waitForSelector('.ni-kinds');
const kinds = await page.$$eval('.ni-kind .t b', (els) => els.map((e) => (e.textContent ?? '').trim()));
check(
  'the kind chooser offers a new phone, a used phone («موبايل مستعمل»), and a counted item',
  kinds.length === 3 &&
    kinds.includes('موبايل جديد') &&
    kinds.includes('موبايل مستعمل') &&
    kinds.some((k) => k.includes('إكسسوار أو أي صنف بالعدد')),
  kinds.join('، ')
);
await clickText('.ni-kind', 'إكسسوار أو أي صنف بالعدد');
await page.waitForSelector('#ni-name');
await sleep(100);
const itemCatNames = await page.$$eval('#ni-cats .chip', (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
check(
  'counted items are offered the counted categories, not the phone ones',
  itemCatNames.includes('جرابات') && itemCatNames.includes('ساعات ذكية') && !itemCatNames.includes('موبايلات جديدة'),
  itemCatNames.join('، ')
);
await shot('19-new-item-empty');

// inline «تصنيف جديد»: under the main of the chosen category, then chosen
await clickText('#ni-cats .chip', 'تصنيف جديد');
await page.waitForSelector('#ni-cat-new');
await page.type('#ni-cat-new', 'قطع غيار');
await page.keyboard.press('Enter');
await page.waitForSelector('#ni-cat-new', { hidden: true, timeout: 3000 });
await sleep(200);
const chosenCat = await page.$$eval('#ni-cats .chip.on', (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
check('an inline «تصنيف جديد» is added under the chosen main and becomes the choice', chosenCat.some((t) => t.includes('قطع غيار')), chosenCat.join('، '));

await page.type('#ni-name', 'جراب سيليكون شفاف');
await clickText('.new-item button', 'اعمل كود للمحل');
await page.waitForFunction(() => (document.querySelector('#ni-sku')?.value.length ?? 0) === 13);
const shopCode = await page.$eval('#ni-sku', (el) => el.value);
const checkDigit = (body) => {
  const sum = [...body].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10;
};
check(
  'the shop code is an EAN-13 starting with 2 and its check digit is right',
  /^2\d{12}$/.test(shopCode) && checkDigit(shopCode.slice(0, 12)) === Number(shopCode[12]),
  shopCode
);
check('the form says the code is the shop’s own', (await text('.new-item .field .hint')).includes('كود المحل'));
await page.type('#ni-price', '75');
await sleep(80);
await shot('20-new-item');
await page.keyboard.press('Enter');
await page.waitForSelector('#ni-name', { hidden: true, timeout: 3000 });
check('the counted item is registered from «صنف جديد»', (await text('#toasts')).includes('اتسجّل «جراب سيليكون شفاف»'));
// The hand-off the owner asked for: the product he just registered is what the receive
// form is sitting on, with the cursor in the quantity box, so the cost is one field away.
await page
  .waitForFunction(() => document.activeElement?.id === 'stock-qty', { timeout: 3000 })
  .catch(() => {});
const handoff = await page.evaluate(() => {
  const sel = document.querySelector('#stock-product');
  const opt = sel && sel.options[sel.selectedIndex];
  return {
    label: (opt?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    active: document.activeElement?.id ?? '',
  };
});
// The hand-off the owner asked for: the product he just registered is what «استلام
// توريد» is sitting on, and the cursor is on the next real step — the quantity box where
// the shop needs no password, the reveal button where it does.
check(
  'a saved item arrives already chosen in «استلام توريد» with the cursor on the next step',
  handoff.label.includes('جراب سيليكون شفاف') &&
    (handoff.active === 'stock-qty' || handoff.active === 'stock-reveal'),
  JSON.stringify(handoff),
);
if (handoff.active === 'stock-reveal') {
  await page.keyboard.press('Enter');
  await page.waitForSelector('.overlay .modal input[type=password]', { timeout: 3000 });
  await page.type('.overlay .modal input[type=password]', '1234');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#stock-qty', { timeout: 3000 });
  check(
    'two keys later the receive form is open on that product',
    (await text('.position-title')).includes('جراب سيليكون شفاف'),
  );
}

// The same hand-off on a device with no account yet (`ADR-039`): there is no password to
// prove and no reveal button to stop at, so it goes the whole way into the quantity box.
{
  const open = await browser.newPage();
  await open.setViewport({ width: 1366, height: 900 });
  await open.goto(URL, { waitUntil: 'networkidle0' });
  await open.waitForSelector('[data-open-mode-note]', { timeout: 5000 });
  const click = (sel, text) =>
    open.evaluate(
      ([ss, tt]) => {
        [...document.querySelectorAll(ss)]
          .find((e) => (e.textContent ?? '').includes(tt))
          ?.click();
      },
      [sel, text],
    );
  const typeIn = (sel, value) =>
    open.evaluate(
      ([ss, vv]) => {
        const el = document.querySelector(ss);
        if (el === null) return;
        el.value = vv;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      },
      [sel, value],
    );
  await click('.rail .nav-btn', 'المخزن');
  await open.waitForSelector('.ni-kinds', { state: 'attached', timeout: 3000 }).catch(() => {});
  await click('.page-h button', 'صنف جديد');
  await open.waitForSelector('.ni-kind', { timeout: 3000 });
  await click('.ni-kind', 'إكسسوار أو أي صنف بالعدد');
  await open.waitForSelector('#ni-name', { timeout: 3000 });
  // The category chips arrive with the catalogue, and the form refuses a product with
  // no category - waiting for one is the validation, not politeness.
  await open.waitForSelector('#ni-cats .chip', { timeout: 3000 });
  await open.evaluate(() => {
    const chip = [...document.querySelectorAll('#ni-cats .chip')].find(
      (c) => !c.textContent.includes('تصنيف جديد'),
    );
    chip?.click();
  });
  // Real keystrokes, not a value set from outside: implicit submission needs the caret
  // inside the form, and a field filled by script leaves the focus on the body.
  await (await open.$('#ni-name')).type('جراب من غير حساب');
  await (await open.$('#ni-price')).type('40');
  await open.keyboard.press('Enter');
  await open.waitForSelector('#ni-name', { hidden: true, timeout: 4000 });
  await open
    .waitForFunction(() => document.activeElement?.id === 'stock-qty', { timeout: 3000 })
    .catch(() => {});
  const landed = await open.evaluate(() => ({
    active: document.activeElement?.id ?? '',
    qty: document.getElementById('stock-qty')?.value ?? null,
  }));
  check(
    'an open shop walks the new item straight into the quantity box, with no password in the way',
    landed.active === 'stock-qty' && landed.qty === '',
    JSON.stringify(landed),
  );
  await open.screenshot({ path: path.join(OUT, '66-handoff-open-shop.png') });
  await open.close();
}


// the same barcode again is refused, as the real backend refuses it
await clickText('.page-h button', 'صنف جديد');
await page.waitForSelector('.ni-kinds');
await clickText('.ni-kind', 'إكسسوار أو أي صنف بالعدد');
await page.waitForSelector('#ni-name');
await page.type('#ni-name', 'جراب تاني');
await page.type('#ni-sku', shopCode);
await page.type('#ni-price', '90');
await page.keyboard.press('Enter');
await sleep(300);
check('a barcode already used is refused with its Arabic message', (await text('.new-item .err-msg')).includes('الباركود'));
await page.keyboard.press('Escape');
await sleep(150);

// --- «الصنف ده ليه تفرعات» (ADR-018 §4, plan item 1.2 step 4) ---------------
await clickText('.page-h button', 'صنف جديد');
await page.waitForSelector('.ni-kinds');
await clickText('.ni-kind', 'إكسسوار أو أي صنف بالعدد');
await page.waitForSelector('#ni-name');
await page.type('#ni-name', 'جراب سيليكون ملون');
await page.$eval('#ni-var-on', (el) => el.click());
await sleep(100);
check(
  'turning variants on puts the cursor in the first dimension input',
  await page.evaluate(() => document.activeElement?.id === 'ni-dq-0')
);
await page.type('#ni-dq-0', 'Galaxy A16');
await page.keyboard.press('Enter');
await page.type('#ni-dq-0', 'iPhone 16');
await page.keyboard.press('Enter');
await clickText('.ni-sugg .chip', '+ أسود');
await clickText('.ni-sugg .chip', '+ بينك');
await sleep(100);
check(
  'two models × two colours build 4 variant rows',
  (await count('.ni-var tbody tr')) === 4 && (await text('.ni-var-f')).includes('4 أنواع')
);
await page.click('#ni-make-codes');
await page.waitForFunction(() => {
  const inputs = [...document.querySelectorAll('.ni-var input.ni-sku')];
  return inputs.length === 4 && inputs.every((el) => el.value.length === 13);
});
const varCodes = await page.$$eval('.ni-var input.ni-sku', (els) => els.map((el) => el.value));
check(
  '«اعمل أكواد للي من غير باركود» fills consecutive valid EAN-13 shop codes',
  new Set(varCodes).size === 4 &&
    varCodes.every((c) => /^2\d{12}$/.test(c) && checkDigit(c.slice(0, 12)) === Number(c[12])),
  varCodes.join(', ')
);
await page.$$eval('.ni-var input[data-f="price"]', (els) => {
  if (els[2]) {
    els[2].value = '90';
    els[2].dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (els[3]) {
    els[3].value = '90';
    els[3].dispatchEvent(new Event('input', { bubbles: true }));
  }
});
await page.type('#ni-price', '70');
await sleep(80);
await shot('21-new-variants');
await page.click('button[form="ni-form"]');
await page.waitForSelector('#ni-name', { hidden: true, timeout: 3000 });

check(
  'the variant family is registered in one step',
  (await text('#toasts')).includes('اتسجّل «جراب سيليكون ملون (4 أنواع)»')
);

// Receive stock for one variant («جراب سيليكون ملون Galaxy A16 بينك») so it can be sold
await clickText('.rail .nav-btn', 'البيع');
await sleep(100);
await clickText('.rail .nav-btn', 'المخزن');
await page.waitForSelector('.stock select');
const pinkVariantId = await page.$eval('.stock select', (sel) => {
  const opt = [...sel.options].find((o) => (o.textContent ?? '').includes('جراب سيليكون ملون Galaxy A16 بينك'));
  return opt?.value ?? '';
});
await page.select('.stock select', pinkVariantId);
await clickText('.stock .gate button', 'عرض المخزن');
await page.waitForSelector('.stock .overlay form.modal input[type=password]');
await page.type('.stock .overlay form.modal input[type=password]', '1234');
await page.keyboard.press('Enter');
await page.waitForSelector('.stock .position');
const receiveInputs = await page.$$('.stock .position form.form input');
await receiveInputs[0].type('5');
await receiveInputs[1].type('4500');
await clickText('.stock .position form.form button', 'استلام');
await sleep(200);
check(
  'stock is received onto the individual variant product',
  (await text('.stock .notice')).includes('الرصيد الآن 5')
);

// --- «موبايل جديد» (ADR-018 §2) ---------------------------------------------

await clickText('.page-h button', 'صنف جديد');
await page.waitForSelector('.ni-kinds');
await clickText('.ni-kind', 'موبايل جديد');
await page.waitForSelector('#np-model');
await sleep(150);
const touchBrands = await page.$$eval('#np-brands .chip', (els) => els.map((e) => e.textContent?.trim() ?? ''));
check(
  'a touch phone is offered the shown touch companies (not vivo, hidden; not itel, keypad)',
  touchBrands.includes('Samsung') && touchBrands.includes('Motorola') && !touchBrands.includes('vivo') && !touchBrands.includes('itel'),
  touchBrands.join('، ')
);
await clickExact('#np-brands .chip', 'Samsung');
await page.type('#np-model', 'Galaxy A26');
await clickExact('.new-phone .chip', '256GB');
await clickExact('.new-phone .chip', '8GB');
await page.type('#np-price', '13999');
await sleep(80);
check('the name is previewed as it will be stored', (await text('.new-phone .ni-name')).includes('Samsung Galaxy A26 256GB'));
await shot('18-new-phone');
await page.keyboard.press('Enter');
await sleep(300);
check(
  'the phone is registered with its built name',
  (await count('#np-model')) === 0 && (await text('#toasts')).includes('اتسجّل «Samsung Galaxy A26 256GB»')
);
await clickText('.page-h button', 'صنف جديد');
await page.waitForSelector('.ni-kinds');
await clickText('.ni-kind', 'موبايل جديد');
await page.waitForSelector('#np-model');
await clickText('.new-phone .seg button', 'زراير');
await sleep(80);
const keypadBrands = await page.$$eval('#np-brands .chip', (els) => els.map((e) => e.textContent?.trim() ?? ''));
check(
  'a keypad phone has no storage or RAM, and only companies that make keypad phones',
  (await count('.new-phone .chip .num')) === 0 && keypadBrands.includes('itel') && keypadBrands.includes('Nokia') && !keypadBrands.includes('Samsung'),
  keypadBrands.join('، ')
);
await clickText('.new-phone .seg button', 'تاتش');
await clickExact('#np-brands .chip', 'Samsung');
await page.type('#np-model', 'galaxy a26');
await clickExact('.new-phone .chip', '256GB');
await clickExact('.new-phone .chip', '8GB');
await page.type('#np-price', '13999');
await page.keyboard.press('Enter');
await sleep(300);
check('the same phone twice is refused', (await text('.new-phone .err-msg')).includes('متسجّل بالفعل'));
await page.keyboard.press('Escape');
await sleep(150);
await clickText('.rail .nav-btn', 'البيع');
await page.waitForSelector('.tile');
await clickText('.chips.cats .chip', 'موبايلات جديدة');
await sleep(80);
check(
  'the new phone sells under its company on the sales screen',
  (await page.$$eval('.chips.subcats .chip', (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()))).includes('Samsung2')
);
await clickText('.chips.cats .chip', 'إكسسوارات');
await sleep(80);
await clickText('.chips.subcats .chip', 'قطع غيار');
await sleep(80);
check(
  'the new counted item sells under its category',
  (await page.$$eval('.tile .name', (els) => els.map((e) => e.textContent ?? ''))).some((t) => t.includes('جراب سيليكون شفاف'))
);
await clickText('.chips.subcats .chip', 'جرابات');
await sleep(80);
const famTileText = (await text('.tile.fam')).replace(/\s+/g, ' ').trim();
check(
  'a variant family collapses into one tile showing its kind count, lowest price and total stock',
  (await count('.tile.fam')) === 1 &&
    famTileText.includes('جراب سيليكون ملون') &&
    famTileText.includes('4 أنواع') &&
    famTileText.includes('من 70') &&
    famTileText.includes('5 متاح'),
  famTileText
);
await page.click('.tile.fam');
await page.waitForSelector('.vr-grid .vr');
await sleep(80);
await shot('22-variant-picker');
const vrStates = await page.$$eval('.vr-grid .vr', (els) =>
  els.map((el) => ({
    label: el.querySelector('b')?.textContent?.trim() ?? '',
    disabled: el.disabled,
    on: el.classList.contains('on'),
  }))
);
check(
  'the variant picker disables out-of-stock options and highlights the first available one',
  vrStates.length === 4 &&
    vrStates.filter((v) => !v.disabled).length === 1 &&
    vrStates.find((v) => v.on)?.label === 'Galaxy A16، بينك',
  JSON.stringify(vrStates)
);
await page.keyboard.press('Enter');
await sleep(120);
check(
  'Enter in the variant picker adds the chosen variant to the invoice',
  (await count('.line')) === 1 && (await text('.line .ln')).includes('جراب سيليكون ملون Galaxy A16 بينك')
);
await page.type('#q', varCodes[1] ?? 'Galaxy A16 بينك');
await sleep(100);
check(
  'barcode/search on the sales screen finds the variant itself',
  (await text('.result .n')).includes('جراب سيليكون ملون Galaxy A16 بينك')
);
await page.keyboard.press('Escape');
await sleep(60);
await page.click('.line .icon-btn.danger');
await sleep(80);
await clickText('.chips.cats .chip', 'الكل');
await sleep(60);

// --- product images (ADR-018 §5, plan item 1.2 step 5) ---------------------
await clickText('.rail .nav-btn', 'المخزن');
await sleep(250);
const imgUploaded = await page.evaluate(async () => {
  const btn = document.querySelector('[data-act="imgPick"]');
  if (!btn) return { ok: false, reason: 'no .pic button' };
  const pid = btn.getAttribute('data-id');
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 240;
  const x = c.getContext('2d');
  x.fillStyle = '#0f6e5a';
  x.fillRect(0, 0, 320, 240);
  x.fillStyle = '#ffffff';
  x.fillRect(80, 40, 160, 160);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const file = new File([blob], 'sample.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  btn.click();
  const inp = document.querySelector('#img-file');
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
  const imgEl = document.querySelector(`[data-act="imgPick"][data-id="${pid}"] img`);
  const src = imgEl?.getAttribute('src') ?? '';
  return {
    ok: src.startsWith('data:image/jpeg;base64,') && src.length < 45000,
    pid,
    len: src.length,
  };
});
check(
  'picking a product image in the store centre-crops and shrinks it to a 192×192 JPEG (<45 KB)',
  imgUploaded.ok && (await text('.catalog .notice')).includes('اتحفظت صورة'),
  JSON.stringify(imgUploaded)
);
await shot('23-store-product-image');

await clickText('.rail .nav-btn', 'البيع');
await page.waitForSelector('.tile');
await sleep(120);
check(
  'the product image appears on its tile on the sales screen when «اعرض صور الأصناف» is on',
  (await count('.tile .ico.img img')) >= 1
);
await shot('24-pos-product-image');

await clickText('.rail .nav-btn', 'الإعدادات');
await page.waitForSelector('#show-product-images');
await sleep(120);
check(
  'the «صور الأصناف» card in settings shows the count of products with images',
  (await text('.page')).includes('عندك 1 صنف بصورة دلوقتي')
);
await page.$eval('#show-product-images', (el) => el.click());
await sleep(150);
await clickText('.rail .nav-btn', 'البيع');
await page.waitForSelector('.tile');
await sleep(100);
check(
  'turning off «اعرض صور الأصناف» hides product images on the sales screen without deleting them',
  (await count('.tile .ico.img img')) === 0
);
await clickText('.rail .nav-btn', 'الإعدادات');
await page.waitForSelector('#show-product-images');
await page.$eval('#show-product-images', (el) => el.click());
await sleep(150);

await clickText('.rail .nav-btn', 'المخزن');
await sleep(200);
await page.click('[data-act="imgDel"]');
await sleep(200);
check(
  'removing a product image in the store restores its category icon',
  (await count('[data-act="imgDel"]')) === 0 &&
    (await text('.catalog .notice')).includes('اتشالت الصورة، والصنف رجع بالأيقونة')
);

// --- optional IMEI units & receiving (ADR-019, plan item 1.4) --------------
await page.evaluate(() => {
  const sel = document.querySelector('#stock-product');
  if (!sel) return;
  const opt = [...sel.options].find((o) => o.textContent?.includes('Samsung Galaxy A26 256GB'));
  if (opt) {
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
});
await clickText('.stock .gate button', 'عرض المخزن');
await page.waitForSelector('.stock .overlay form.modal input[type=password]');
await page.type('.stock .overlay form.modal input[type=password]', '1234');
await page.keyboard.press('Enter');
await page.waitForSelector('.stock .position');
await sleep(150);
check(
  'selecting a phone in the stock panel shows the optional IMEI box and receipt mode switcher',
  (await count('#stock-imei-input')) === 1 && (await count('#stock-mode-opening')) === 1
);
await page.type('#stock-imei-input', '356938035643800');
await page.click('#stock-imei-add');
await sleep(100);
check(
  'an IMEI with a wrong Luhn check digit is refused before receiving',
  (await count('.imei-chip')) === 0
);
await page.$eval('#stock-imei-input', (el) => {
  el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.type('#stock-imei-input', '356938035643809');
await page.click('#stock-imei-add');
await sleep(100);
check(
  'a valid 15-digit Luhn IMEI is added as a chip in the stock panel',
  (await count('.imei-chip')) === 1 && (await text('.imei-chip')).includes('356938035643809')
);
await page.$eval('#stock-qty', (el) => {
  el.value = '2';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.$eval('#stock-cost', (el) => {
  el.value = '800000';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.click('.stock form button[type="submit"]');
await sleep(250);
check(
  'receiving 2 phones with 1 registered IMEI updates on-hand to 2 and lists the registered IMEI in stock',
  (await text('.stock')).includes('متسجّل 1 من 2') &&
    (await text('.units-box')).includes('356938035643809')
);
await shot('25-store-imei-units');

await clickText('.rail .nav-btn', 'البيع');
await page.waitForSelector('.tile');
await sleep(150);
await page.type('#q', '3809');
await sleep(120);
check(
  'typing the last 4 digits of a registered IMEI in POS search finds that exact device',
  (await count('.result.unit-res')) === 1 && (await text('.result.unit-res')).includes('…3809')
);
await page.keyboard.press('Escape');
await sleep(80);

await clickText('.chips.cats .chip', 'الكل');
await sleep(100);
await clickText('.tile', 'Samsung Galaxy A26 256GB');
await sleep(150);
check(
  'in optional IMEI mode, clicking a phone tile adds it to the invoice immediately with «سجّل IMEI»',
  (await count('.line')) === 1 && (await text('.line-imei-btn')).includes('سجّل IMEI')
);
await page.click('.line-imei-btn');
await page.waitForSelector('#imei-in');
await sleep(100);
await page.type('#imei-in', '490154203237518');
await sleep(120);
check(
  'typing an unregistered Luhn-valid 15-digit IMEI in the picker offers late registration from unregistered stock',
  (await count('#imei-register-btn')) === 1
);
await page.click('#imei-register-btn');
await sleep(150);
check(
  'picking the late-registered IMEI links it to the phone line on the invoice',
  (await text('.line-imei-btn')).includes('…7518')
);
await shot('26-pos-imei-linked');
await page.click('.line .icon-btn.danger');
await sleep(100);

await clickText('.rail .nav-btn', 'الإعدادات');
await page.waitForSelector('#imei-mode-required');
await page.$eval('#imei-mode-required', (el) => el.click());
await sleep(150);
await clickText('.rail .nav-btn', 'البيع');
await page.waitForSelector('.tile');
await sleep(120);
await clickText('.chips.cats .chip', 'الكل');
await sleep(100);
await clickText('.tile', 'Samsung Galaxy A26 256GB');
await sleep(150);
check(
  'in required IMEI mode, clicking a phone tile opens the IMEI picker modal before adding to the invoice',
  (await count('#imei-in')) === 1 && (await count('.line')) === 0
);
await page.click('.imei-row');
await sleep(150);
check(
  'choosing a registered unit in required IMEI mode adds the phone line with its IMEI linked',
  (await count('.line')) === 1 && (await text('.line-imei-btn')).includes('…3809')
);
await page.click('.line .icon-btn.danger');
await sleep(100);
await clickText('.rail .nav-btn', 'الإعدادات');
await page.waitForSelector('#imei-mode-optional');
await page.$eval('#imei-mode-optional', (el) => el.click());
await sleep(150);

// --- invoice payments, split payments & customer credit ledger (ADR-020, plan item 1.5) ---
await page.waitForSelector('[data-card="payment-methods"]');
check(
  'settings shows the payment methods card with cash always enabled and 5 toggleable methods',
  (await count('[data-pay-method-row]')) === 6 &&
    (await page.$eval('#pay-method-toggle-cash', (el) => el.disabled && el.checked))
);
await page.$eval('[data-card="payment-methods"]', (el) => el.scrollIntoView({ block: 'center' }));
await page.$eval('#pay-method-toggle-install', (el) => el.click());
await sleep(150);
await shot('27-settings-payment-methods');

await clickText('.rail .nav-btn', 'البيع');
await page.waitForSelector('.tile');
await sleep(120);
await clickText('.chips.cats .chip', 'الكل');
await sleep(100);
await clickText('.tile', 'شاحن آيفون 20 وات');
await sleep(120);
await page.keyboard.press('F12');
await page.waitForSelector('.methods');
await sleep(120);
check(
  'turning off «تقسيط» in settings hides it from the POS pay modal while keeping enabled methods',
  (await count('[data-method="install"]')) === 0 &&
    (await count('[data-method="cash"]')) === 1 &&
    (await count('[data-method="vf"]')) === 1 &&
    (await count('[data-method="credit"]')) === 1
);
await page.click('[data-method="credit"]');
await sleep(100);
check(
  'choosing «آجل» without a linked customer warns the seller and disables «تم الدفع» until a customer is chosen',
  (await count('[data-credit-needs-customer]')) === 1 &&
    (await page.$eval('#confirm-pay-btn', (el) => el.disabled))
);
await page.click('#pick-credit-customer-btn');
await page.waitForSelector('#toggle-new-customer-btn');
await page.click('#toggle-new-customer-btn');
await page.waitForSelector('#new-cust-name-in');
await page.type('#new-cust-name-in', 'محمود عبد الرحمن');
await page.type('#new-cust-contact-in', '01099887766');
await page.click('#save-new-customer-btn');
await sleep(200);
check(
  'creating and picking a customer from inside the pay modal links them to the invoice and shows their آجل balance summary',
  (await count('[data-credit-customer-summary]')) === 1 &&
    (await text('[data-credit-customer-summary]')).includes('محمود عبد الرحمن')
);

await page.click('[data-method="cash"]');
await sleep(100);
await page.type('#cash-in', '150');
await sleep(100);
check(
  'typing a partial cash amount less than the invoice total offers «دفع جزئي» to split the invoice',
  (await count('#add-split-payment-btn')) === 1
);
await page.click('#add-split-payment-btn');
await sleep(120);
await page.click('[data-method="credit"]');
await sleep(120);
check(
  'adding a 150 EGP cash split leaves 300 EGP remaining on the 450 EGP invoice for the second payment method',
  (await count('.split-box .paid-item')) === 1 &&
    (await text('.due-box')).includes('300')
);
await shot('28-pos-split-and-credit-pay');
await page.click('#confirm-pay-btn');
await page.waitForSelector('.done-hero');
await sleep(150);
check(
  'completing a split cash + credit sale shows both payment parts in «تم البيع»',
  (await text('.modal')).includes('كاش') && (await text('.modal')).includes('آجل')
);
await page.keyboard.press('Enter');
await sleep(150);

await page.click('#pos-customer-btn');
await page.waitForSelector('#cust-search-in');
await sleep(120);
check(
  'after the credit sale, the customer picker shows the customer’s 300 EGP آجل balance',
  (await text('.cust-list')).includes('محمود عبد الرحمن') &&
    (await text('.cust-list')).includes('عليه 300 ج.م آجل')
);
await clickText('.cust-list .result button', 'تحصيل');
await page.waitForSelector('#repay-amount-in');
await page.$eval('#repay-amount-in', (el) => {
  el.value = '50';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(100);
await shot('29-customer-credit-repay');
await page.click('#confirm-repay-btn');
await sleep(200);
check(
  'recording a 50 EGP repayment updates the customer’s آجل balance to 250 EGP immediately',
  (await text('.cust-list')).includes('عليه 250 ج.م آجل')
);
await page.keyboard.press('Escape');
await sleep(120);

await clickText('.rail .nav-btn', 'الإعدادات');
await page.waitForSelector('#pay-method-toggle-install');
await page.$eval('#pay-method-toggle-install', (el) => el.click());
await sleep(120);

// --- sale discounts, seller limit & exact cash (ADR-021, plan item 1.6) ----
await page.waitForSelector('[data-card="discount-limit"]');
check(
  'the settings screen shows the «حد خصم البيّاع» card with 5% selected by default',
  (await count('[data-card="discount-limit"] #discount-limit-preset-5.on')) === 1
);
await page.click('#discount-limit-preset-10');
await sleep(120);
check(
  'the owner can change the seller discount limit to 10% in settings',
  (await count('[data-card="discount-limit"] #discount-limit-preset-10.on')) === 1
);
await shot('30-settings-discount-limit');
await page.click('#discount-limit-preset-5');
await sleep(120);

await clickText('.rail .nav-btn', 'البيع');
await page.waitForSelector('.tile');
await sleep(80);
await clickText('.tile', 'شاحن آيفون 20 وات');
await sleep(100);
await page.keyboard.press('F3');
await page.waitForSelector('#discount-value-input');
await sleep(100);
await page.click('#discount-quick-pct-5');
await sleep(100);
check(
  'a 5% discount within the 5% seller limit does not show the owner PIN warning',
  (await count('#discount-limit-warning')) === 0 &&
    (await text('.due-box')).includes('22.5')
);
await page.click('#discount-apply-btn');
await sleep(150);
check(
  'applying the 5% discount updates the invoice totals row to 427.5 EGP without asking for a PIN',
  (await count('#pos-discount-row')) === 1 &&
    (await text('#pos-discount-row')).includes('22.5') &&
    (await text('.totals .grand')).includes('427.5')
);

// Now press F3 and pick a 10% discount (above the 5% limit) -> requires owner PIN approval.
await page.keyboard.press('F3');
await page.waitForSelector('#discount-value-input');
await sleep(100);
await page.click('#discount-quick-pct-10');
await sleep(100);
check(
  'a 10% discount above the 5% seller limit shows the owner PIN approval warning',
  (await count('#discount-limit-warning')) === 1 &&
    (await text('#discount-apply-btn')).includes('موافقة المالك')
);
await shot('31-pos-discount-modal');
await page.click('#discount-apply-btn');
await page.waitForSelector('.modal .approver', { timeout: 3000 });
await sleep(150);
check(
  'applying a discount above the seller limit opens the «موافقة المالك» PIN prompt',
  (await count('.modal .approver')) === 1 &&
    (await text('body')).includes('موافقة المالك') &&
    (await text('body')).includes('فوق حد البيّاع')
);
await page.keyboard.type('4321');
await page.keyboard.press('Enter');
await sleep(200);
check(
  'after the owner enters his PIN, the 10% discount (45 EGP) is applied with «بموافقة المالك»',
  (await count('#pos-discount-row')) === 1 &&
    (await text('#pos-discount-row')).includes('بموافقة المالك') &&
    (await text('.totals .grand')).includes('405')
);
await shot('32-pos-discount-applied');

await page.click('#pos-exact-cash-btn');
await sleep(200);
check(
  'clicking «كاش بالظبط» records the discounted cash sale in one tap and clears the invoice',
  (await count('.cart .line')) === 0 &&
    (await text('body')).includes('اتسجّلت الفاتورة')
);

// --- Arabic receipt on WhatsApp & shop profile (ADR-022, plan item 1.7) ----
await clickText('.rail .nav-btn', 'الإعدادات');
await page.waitForSelector('[data-card="shop-profile"]');
await sleep(150);
check(
  'settings shows both «بيانات المحل» and «الإيصال والواتساب» cards with live receipt previews',
  (await count('[data-card="shop-profile"]')) === 1 &&
    (await count('[data-card="receipt-settings"]')) === 1 &&
    (await count('[data-receipt-preview]')) >= 2
);

await page.$eval('#set-shopName', (el) => {
  el.value = 'سنتر بيتر للموبايلات';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.$eval('#set-shopPhone', (el) => {
  el.value = '01288887777';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.$eval('#set-shopAddress', (el) => {
  el.value = 'ميدان المحطة، أسيوط';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(200);
check(
  'updating shop name, phone, and address updates the topbar and live receipt preview immediately',
  (await text('[data-topbar-shop-name]')) === 'سنتر بيتر للموبايلات' &&
    (await text('[data-receipt-preview]')).includes('سنتر بيتر للموبايلات') &&
    (await text('[data-receipt-preview]')).includes('01288887777') &&
    (await text('[data-receipt-preview]')).includes('ميدان المحطة، أسيوط')
);

const shopLogoUploaded = await page.evaluate(async () => {
  const inp = document.querySelector('#shop-logo-file');
  if (!inp) return { ok: false, reason: 'no #shop-logo-file' };
  const c = document.createElement('canvas');
  c.width = 240;
  c.height = 240;
  const x = c.getContext('2d');
  x.fillStyle = '#1d4f91';
  x.fillRect(0, 0, 240, 240);
  x.fillStyle = '#ffffff';
  x.fillRect(60, 60, 120, 120);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const file = new File([blob], 'logo.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  const railLogo = document.querySelector('.rail .logo img');
  const receiptLogo = document.querySelector('[data-receipt-preview] .rc-logo img');
  const src = railLogo?.getAttribute('src') ?? '';
  return {
    ok:
      src.startsWith('data:image/jpeg;base64,') &&
      src.length < 45000 &&
      Boolean(receiptLogo),
    len: src.length,
  };
});
check(
  'uploading a shop logo shrinks it to a 192×192 JPEG and displays it in the rail and on the receipt preview',
  shopLogoUploaded.ok,
  JSON.stringify(shopLogoUploaded)
);

await page.$eval('#set-receiptFooter', (el) => {
  el.value = 'شكراً لثقتكم · الضمان بالفاتورة والعلبة السليمة';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.$eval('#set-waTemplate', (el) => {
  el.value = 'منور يا {الاسم}، فاتورة {رقم} من {المحل} بمبلغ {الإجمالي}.{الضمان}';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(200);
check(
  'updating receipt footer and WhatsApp template updates the live receipt footer and WhatsApp preview',
  (await text('[data-receipt-preview] .rc-foot')).includes('شكراً لثقتكم') &&
    (await text('[data-wa-template-preview]')).includes('منور يا أحمد سمير') &&
    (await text('[data-wa-template-preview]')).includes('سنتر بيتر للموبايلات')
);
await shot('33-settings-shop-and-receipt');

await clickText('.rail .nav-btn', 'البيع');
await page.waitForSelector('.tile');
await sleep(150);
await clickText('.chips.cats .chip', 'الكل');
await sleep(100);
await clickText('.tile', 'كابل تايب سي 1 متر');
await sleep(100);
await page.keyboard.press('F12');
await page.waitForSelector('#confirm-pay-btn');
await sleep(150);
check(
  'without a linked customer, PayModal defaults the receipt mode to «بدون» so fast walk-in sales do not ask for a phone number',
  (await count('#pay-receipt-mode-none.on')) === 1 &&
    (await count('#pay-wa')) === 0
);

// Link a customer with a phone number from inside PayModal -> switches to «واتساب» and prefills #pay-wa.
await page.click('[data-pay-receipt-section] #pay-receipt-mode-wa');
await sleep(100);
check(
  'switching receipt mode to «واتساب» reveals the customer WhatsApp phone field',
  (await count('#pay-wa')) === 1
);
await page.type('#pay-wa', '01099');
await page.click('#confirm-pay-btn');
await sleep(100);
check(
  'an invalid Egyptian WhatsApp number is refused before completing the sale',
  (await text('.modal .err-msg')).includes('11 رقم')
);
await page.$eval('#pay-wa', (el) => {
  el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.type('#pay-wa', '01012345678');
await shot('34-pos-pay-whatsapp-receipt');
await page.click('#confirm-pay-btn');
await page.waitForSelector('.done-wrap', { timeout: 3000 });
await sleep(250);
const waSentPre = await page.evaluate(() => window.__lastWhatsAppSent);
check(
  'completing a sale with «واتساب» renders the Arabic receipt preview and dispatches the WhatsApp message + receipt image',
  (await count('.done-wrap [data-receipt-preview]')) === 1 &&
    Boolean(waSentPre) &&
    waSentPre.phone === '01012345678' &&
    waSentPre.url.startsWith('https://wa.me/201012345678?text=') &&
    waSentPre.message.includes('سنتر بيتر للموبايلات') &&
    waSentPre.imageDataUrl.startsWith('data:image/png;base64,')
);
await shot('35-pos-done-receipt-preview');
await page.click('#finish-sale-btn');
await sleep(150);

// Now test walk-in sale with «بدون» followed by post-sale «ابعت الإيصال واتساب» in «تم البيع».
await clickText('.tile', 'كابل تايب سي 1 متر');
await sleep(100);
await page.keyboard.press('F12');
await page.waitForSelector('#confirm-pay-btn');
await sleep(100);
await page.click('#confirm-pay-btn');
await page.waitForSelector('.done-wrap', { timeout: 3000 });
await sleep(150);
check(
  'after a walk-in sale with «بدون», the done screen shows «ابعت الإيصال واتساب»',
  (await text('#send-wa-receipt-btn')).includes('ابعت الإيصال واتساب')
);
await page.$eval('#send-wa-receipt-btn', (el) => el.click());
await page.waitForSelector('#done-wa', { timeout: 3000 });
await page.$eval('#done-wa', (el) => {
  el.value = '01122334455';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.$eval('#done-wa-send-btn', (el) => el.click());
await sleep(300);
const waSentPost = await page.evaluate(() => window.__lastWhatsAppSent);
check(
  'typing a phone number in «تم البيع» after payment sends the WhatsApp receipt and switches the button to «ابعت تاني واتساب»',
  Boolean(waSentPost) &&
    waSentPost.phone === '01122334455' &&
    (await text('#send-wa-receipt-btn')).includes('ابعت تاني واتساب'),
  JSON.stringify(waSentPost?.phone)
);
await page.click('#finish-sale-btn');
await sleep(150);

// --- Plan item 1.8: Default warranty periods & line warranty (ADR-023) ------
await clickText('.rail .nav-btn', 'الإعدادات');
await page.waitForSelector('#set-warrantyUsed', { timeout: 3000 });
await sleep(150);
const initialWarranties = await page.evaluate(() => ({
  wNew: document.querySelector('#set-warrantyNew')?.value,
  wUsed: document.querySelector('#set-warrantyUsed')?.value,
  wItem: document.querySelector('#set-warrantyItem')?.value,
}));
check(
  'Settings «الضمان الافتراضي» shows default warranty periods: new phone = 12, used phone = 1, item = 0',
  initialWarranties.wNew === '12' &&
    initialWarranties.wUsed === '1' &&
    initialWarranties.wItem === '0',
  JSON.stringify(initialWarranties)
);

await page.$eval('#set-warrantyUsed', (el) => {
  el.scrollIntoView({ block: 'center' });
  el.value = '3';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(200);
check(
  'Owner updates used phone default warranty («موبايل مستعمل») in Settings to 3 months',
  (await page.$eval('#set-warrantyUsed', (el) => el.value)) === '3' &&
    (await text('#toasts')).includes('موبايل مستعمل')
);
await shot('36-settings-warranty-defaults');

await clickText('.rail .nav-btn', 'البيع');
await page.waitForSelector('.tile');
await sleep(150);
await clickText('.chips.cats .chip', 'الكل');
await sleep(100);
await clickText('.tile', 'Redmi 14C 128GB');
await sleep(100);
await clickText('.tile', 'كابل تايب سي 1 متر');
await sleep(100);
check(
  'Adding a phone automatically assigns its 12-month default warranty badge while an accessory starts with no warranty badge',
  (await count('.line-warranty-btn')) === 1 &&
    (await text('.line-warranty-btn')).includes('ضمان 12 شهر')
);

// Open WarrantyModal on the accessory line (index 1) and assign 3 months warranty
await page.click('[data-line-warranty="1"]');
await page.waitForSelector('#warranty-months-in', { timeout: 3000 });
await sleep(100);
await clickText('.quick-warranty-chips .chip', '3 شهور');
await sleep(100);
check(
  'WarrantyModal quick chip sets the line warranty to 3 months and previews start/end YYYY-MM-DD dates',
  (await page.$eval('#warranty-months-in', (el) => el.value)) === '3' &&
    (await text('.warranty-preview-box')).includes('ضمان 3 شهور')
);
await shot('37-pos-warranty-modal');
await page.keyboard.press('Enter');
await sleep(150);
const lineWarrantyTexts = await page.$$eval('.line-warranty-btn', (els) =>
  els.map((e) => (e.textContent ?? '').trim())
);
check(
  'Both lines now display their warranty badges on the invoice',
  lineWarrantyTexts.length === 2 &&
    lineWarrantyTexts.some((t) => t.includes('12 شهر')) &&
    lineWarrantyTexts.some((t) => t.includes('3 شهور')),
  lineWarrantyTexts.join(' | ')
);

await page.keyboard.press('F12');
await page.waitForSelector('#confirm-pay-btn');
await sleep(100);
await page.click('#confirm-pay-btn');
await page.waitForSelector('.done-wrap', { timeout: 3000 });
await sleep(200);
const lastDemoSale = await page.evaluate(() => window.__lastDemoSale);
const receiptTextAfterWarranty = await text('.done-wrap [data-receipt-preview]');
check(
  'Completing the sale persists YYYY-MM-DD warrantyStart/warrantyEnd on sale lines and prints warranty lines on the receipt',
  Boolean(lastDemoSale) &&
    Array.isArray(lastDemoSale.lines) &&
    lastDemoSale.lines.length === 2 &&
    /^\d{4}-\d{2}-\d{2}$/.test(lastDemoSale.lines[0].warrantyStart ?? '') &&
    /^\d{4}-\d{2}-\d{2}$/.test(lastDemoSale.lines[0].warrantyEnd ?? '') &&
    /^\d{4}-\d{2}-\d{2}$/.test(lastDemoSale.lines[1].warrantyStart ?? '') &&
    /^\d{4}-\d{2}-\d{2}$/.test(lastDemoSale.lines[1].warrantyEnd ?? '') &&
    receiptTextAfterWarranty.includes('ضمان 12 شهر لحد') &&
    receiptTextAfterWarranty.includes('ضمان 3 شهور لحد'),
  JSON.stringify(lastDemoSale?.lines)
);
await shot('38-pos-receipt-warranty-lines');
await page.click('#finish-sale-btn');
await sleep(150);

// --- Plan item 1.9: Shift, drawer expenses, cash movements & closing (`ADR-024`) ---
check(
  'Topbar displays open Shift #1 status and drawer/shift action buttons',
  (await text('[data-topbar-shift-status]')).includes('وردية #1 مفتوحة') &&
    (await count('[data-open-drawer-expense]')) === 1 &&
    (await count('[data-open-shift-modal]')) === 1
);

await page.click('[data-open-drawer-expense]');
await page.waitForSelector('[data-drawer-expense-modal]', { timeout: 3000 });
await sleep(150);
await page.click('[data-expense-chip="شاي وضيافة"]');
await page.click('[data-expense-quick="50"]');
await page.type('[data-expense-note]', 'شاي وقهوة للعملاء');
await page.click('[data-expense-submit]');
await sleep(200);

await page.click('[data-drawer-tab="movement"]');
await sleep(100);
await page.click('[data-movement-kind="owner_draw"]');
await page.click('[data-movement-quick="200"]');
await page.click('[data-movement-submit]');
await sleep(200);

check(
  'Drawer modal records 50 EGP expense and 200 EGP owner draw and updates shift ledger',
  (await text('[data-drawer-expenses-total]')).includes('50') &&
    (await text('[data-drawer-owner-draw-total]')).includes('200') &&
    (await count('[data-shift-ledger-row]')) === 2
);
await shot('39-drawer-expenses-and-movements');
await page.click('[data-drawer-close]');
await page.waitForSelector('[data-drawer-expense-modal]', { hidden: true, timeout: 3000 });
await sleep(150);

// Open Shift Close modal and verify denomination counter, expected vs counted cash, WhatsApp report, and close
await page.click('[data-open-shift-modal]');
await page.waitForSelector('[data-close-shift-view]', { timeout: 3000 });
await sleep(150);
await page.click('[data-shift-match-expected]');
await sleep(100);
const diffState = await page.$eval('[data-shift-diff-banner]', (el) => el.getAttribute('data-shift-diff-state'));
const diffLabel = await text('[data-shift-diff-label]');
check(
  'Shift close modal reconciles opening cash + cash sales + customer cash - expenses - owner draw with zero difference («مظبوط»)',
  diffState === 'exact' &&
    diffLabel.includes('مظبوط') &&
    (await text('[data-shift-expenses]')).includes('50') &&
    (await text('[data-shift-owner-draw]')).includes('200'),
  `${diffState}: ${diffLabel}`
);

await page.type('[data-shift-close-note]', 'الدرج مطابق بالملليم');
await page.click('[data-shift-wa-send]');
await sleep(150);
const lastShiftWa = await page.evaluate(() => window.__lastShiftWhatsAppSent);
check(
  'Sending shift report on WhatsApp builds Arabic shift summary for the owner phone',
  Boolean(lastShiftWa) &&
    lastShiftWa.shiftNumber === 1 &&
    lastShiftWa.differenceMinor === 0 &&
    lastShiftWa.url.startsWith('https://wa.me/201288887777?text=') &&
    lastShiftWa.text.includes('تقرير تقفيل الوردية #1') &&
    lastShiftWa.text.includes('مظبوط'),
  lastShiftWa?.url
);
await shot('40-shift-close-reconciliation');

await page.click('[data-close-shift-submit]');
await page.waitForSelector('[data-close-shift-view]', { hidden: true, timeout: 3000 });
await sleep(200);
check(
  'After closing Shift #1, topbar shows no open shift and offers «فتح وردية»',
  (await text('[data-topbar-shift-status]')).includes('مفيش وردية مفتوحة') &&
    (await text('[data-open-shift-modal]')).includes('فتح وردية')
);

await page.click('[data-open-shift-modal]');
await page.waitForSelector('[data-open-shift-view]', { timeout: 3000 });
await sleep(150);
check(
  'Open Shift modal pre-fills previous closed shift counted cash and lists recent closed shifts',
  (await count('[data-last-closed-shift-hint]')) === 1 &&
    (await count('[data-recent-closed-shifts]')) === 1
);
await shot('41-open-next-shift');
await page.click('[data-open-shift-submit]');
await page.waitForSelector('[data-open-shift-view]', { hidden: true, timeout: 3000 });
await sleep(200);
check(
  'Opening the next shift starts Shift #2 in the topbar',
  (await text('[data-topbar-shift-status]')).includes('وردية #2 مفتوحة')
);

// --- Plan item 1.10 (ADR-025): Quick Services (F9), Wallets screen, and Wallets/Commission settings ---
await clickText('.rail .nav-btn', 'البيع');
await page.waitForSelector('[data-open-services]', { timeout: 3000 });
await page.click('[data-open-services]');
await page.waitForSelector('[data-services-modal]', { timeout: 3000 });
await sleep(150);
check(
  'Quick Services modal (F9) opens from POS with 3 tabs (محافظ · كروت شحن · فواتير — software moved under Maintenance per ADR-016 #35) and no customer phone input',
  (await count('[data-svc-tab]')) === 3 &&
    (await count('[data-svc-tab="software"]')) === 0 &&
    (await count('[data-svc-wallet]')) === 5 &&
    (await count('#svc-phone')) === 0
);

// In manual commission mode (default), submitting a deposit without typing commission blocks and focuses #svc-fee
await page.type('[data-svc-amt]', '1000');
await page.click('[data-svc-wallet-submit]');
await sleep(150);
const feeFocused = await page.evaluate(() => document.activeElement?.getAttribute('id') === 'svc-fee');
check(
  'In manual fee mode, forgetting the commission blocks submission and focuses #svc-fee',
  feeFocused && (await count('[data-services-modal]')) === 1
);

// Type 10 EGP commission and verify live wallet balance & drawer cash preview
await page.type('[data-svc-fee]', '10');
await sleep(100);
check(
  'Services modal previews wallet balance after deposit and cash collected (amount + fee)',
  (await text('[data-svc-cash-delta]')).includes('1,010'),
  await text('[data-svc-cash-delta]')
);
await shot('42-services-f9-modal');

await page.click('[data-svc-wallet-submit]');
await page.waitForSelector('[data-services-modal]', { hidden: true, timeout: 3000 });
await sleep(200);

// Open F9 again to record an internet bill (200 EGP + 5 EGP fee)
await page.click('[data-open-services]');
await page.waitForSelector('[data-services-modal]', { timeout: 3000 });
await page.click('[data-svc-tab="bills"]');
await page.waitForSelector('[data-svc-bills-panel]', { timeout: 3000 });
await page.type('[data-svc-bill-amt]', '200');
await page.type('[data-svc-bill-acct]', '0223456789');
await page.type('[data-svc-bill-fee]', '5');
await page.click('[data-svc-bill-submit]');
await page.waitForSelector('[data-services-modal]', { hidden: true, timeout: 3000 });
await sleep(200);

// Navigate to «المحافظ» screen
await clickText('.rail .nav-btn', 'المحافظ');
await page.waitForSelector('[data-wallets-screen]', { timeout: 3000 });
await sleep(200);
check(
  'Wallets screen displays the 5 shop wallet cards, period summary table, and operations log',
  (await count('[data-wal-card]')) === 5 &&
    (await count('[data-wal-summary-row]')) === 5 &&
    (await count('[data-wal-op-row]')) >= 2
);

// Owner tops up Etisalat Cash (`et`) by 300 EGP from the drawer
await page.click('[data-wal-open-move]');
await page.waitForSelector('[data-wallet-move-modal]', { timeout: 3000 });
await page.click('[data-wm-wal="et"]');
await page.type('[data-wm-amt]', '300');
await page.click('[data-wm-submit]');
await page.waitForSelector('[data-wallet-move-modal]', { hidden: true, timeout: 3000 });
await sleep(200);
check(
  'Owner wallet top-up increases Etisalat Cash balance from 5,000 to 5,300 EGP',
  (await text('[data-wal-balance="et"]')).includes('5,300'),
  await text('[data-wal-balance="et"]')
);

// Owner voids the last operation with a reason and verifies it remains struck through in the log
const firstVoidBtn = await page.$('[data-wal-void-op]');
await firstVoidBtn.click();
await page.waitForSelector('[data-wallet-void-modal]', { timeout: 3000 });
await page.type('[data-void-reason]', 'اتكتبت للتجربة');
await page.click('[data-void-submit]');
await page.waitForSelector('[data-wallet-void-modal]', { hidden: true, timeout: 3000 });
await sleep(200);
check(
  'Voided wallet operation remains visible struck-through in the log with its reason',
  (await count('.wl-log tr.void')) === 1 &&
    (await text('[data-wal-op-void-tag]')).includes('اتلغت: اتكتبت للتجربة')
);
await shot('43-wallets-screen');

// Navigate to «الإعدادات» and verify «محافظ المحل» & «عمولات الخدمات» cards
await clickText('.rail .nav-btn', 'الإعدادات');
await page.waitForSelector('[data-card="shop-wallets"]', { timeout: 3000 });
await sleep(150);
check(
  'Settings displays «محافظ المحل» and «عمولات الخدمات» cards',
  (await count('[data-card="shop-wallets"]')) === 1 &&
    (await count('[data-card="service-fees"]')) === 1 &&
    (await count('[data-wal-settings-row]')) === 5
);
await page.click('[data-fee-mode="auto"]');
await sleep(150);
check(
  'Switching service fee mode to «محسوبة تلقائي» reveals percentage, min fee, and bill fee inputs',
  (await count('[data-set-fee-pct]')) === 1 &&
    (await count('[data-set-fee-min]')) === 1 &&
    (await count('[data-set-bill-fee]')) === 1
);
await shot('44-wallets-settings');
await page.click('[data-fee-mode="manual"]');
await sleep(150);

// --- Plan item 1.11 (ADR-026): Partial Returns, Damaged Stock, and Single-Operation Exchange ---
await clickText('.rail .nav-btn', 'البيع');
await page.waitForSelector('[data-open-returns]', { timeout: 3000 });
await sleep(150);

// Sell 3 units of a product via exact cash so we can test partial damaged return + intact exchange
await clickText('.tiles .tile', 'كابل تايب سي 1 متر');
await clickText('.tiles .tile', 'كابل تايب سي 1 متر');
await clickText('.tiles .tile', 'كابل تايب سي 1 متر');
await sleep(100);
await page.click('#pos-exact-cash-btn');
await sleep(250);

// Open ReturnModal via F10 button (`[data-open-returns]`)
await page.click('[data-open-returns]');
await page.waitForSelector('[data-return-modal]', { timeout: 3000 });
await sleep(200);
check(
  'Return / Exchange modal (F10) opens and displays the most recent invoice with line quantities',
  (await count('[data-return-inspection]')) === 1 &&
    (await count('[data-return-line-row="1"]')) === 1
);

// Increment return qty to 1 and mark as «تالف (مخزون تالف)»
await page.click('[data-return-qty-inc="1"]');
await page.click('[data-return-cond-damaged="1"]');
await sleep(150);
check(
  'Selecting 1 damaged unit in ReturnModal previews refund total and damaged tag',
  (await text('[data-return-summary-box]')).includes('تالف (مخزون تالف): 1 قطعة') &&
    !(await text('[data-return-refund-total]')).startsWith('0'),
  await text('[data-return-summary-box]')
);
await shot('45-pos-return-modal');

// Submit return -> requires owner PIN approval (`4321`)
await page.click('[data-return-submit]');
await page.waitForSelector('.modal .approver', { timeout: 3000 });
await page.keyboard.type('4321');
await page.keyboard.press('Enter');
await page.waitForSelector('[data-return-modal]', { hidden: true, timeout: 3000 });
await sleep(250);
check(
  'Partial damaged return completes after owner PIN approval and closes modal',
  (await count('[data-return-modal]')) === 0
);

// Add a replacement product to the POS cart and open ReturnModal to execute a single-operation exchange
await clickText('.tiles .tile', 'جراب شفاف');
await sleep(100);
await page.click('[data-open-returns]');
await page.waitForSelector('[data-return-modal]', { timeout: 3000 });
await sleep(200);

// Select the partially returned invoice (which has 2 remaining units)
const partialSaleBtn = await page.$('[data-return-recent-list] .chip');
if (partialSaleBtn) await partialSaleBtn.click();
await sleep(150);
await page.click('[data-return-qty-inc="1"]');
await page.click('[data-return-cond-intact="1"]');
await sleep(150);
check(
  'When POS cart has replacement items, ReturnModal displays exchange net difference preview and exchange submit button',
  (await count('[data-return-exchange-box]')) === 1 &&
    (await count('[data-exchange-submit]')) === 1,
  await text('[data-return-exchange-box]')
);
await shot('46-pos-exchange-modal');

await page.click('[data-exchange-submit]');
await page.waitForSelector('.modal .approver', { timeout: 3000 });
await page.keyboard.type('4321');
await page.keyboard.press('Enter');
await page.waitForSelector('[data-return-modal]', { hidden: true, timeout: 3000 });
await sleep(250);
check(
  'Single-operation exchange completes with owner PIN approval and clears the POS cart',
  (await count('[data-return-modal]')) === 0 &&
    (await count('.cart .lines .empty')) === 1
);

// Navigate to «المخزن» and verify «مخزون تالف» card shows the damaged returned item at its original line cost
await clickText('.rail .nav-btn', 'المخزن');
await page.waitForSelector('[data-damaged-stock-card]', { timeout: 3000 });
await sleep(250);
check(
  'Store screen («المخزن») displays «مخزون تالف» card with the damaged returned item and its cost',
  (await text('[data-damaged-total-qty]')).includes('1') &&
    (await count('[data-damaged-table] tbody tr')) === 1 &&
    (await text('[data-damaged-table]')).includes('كابل تايب سي 1 متر'),
  await text('[data-damaged-stock-card]')
);
await shot('47-store-damaged-stock');

// --- Plan item 1.12: Automatic backup policy (ADR-027) ----------------------
await clickText('.rail .nav-btn', 'الإعدادات');
await page.waitForSelector('[data-backup-policy-card]', { timeout: 3000 });
await sleep(200);
const backupCardText = await text('[data-backup-policy-card]');
check(
  'settings show automatic backup policy card with all 4 policy rows and MSHOP-BACKUP',
  backupCardText.includes('النسخ الاحتياطي التلقائي') &&
    backupCardText.includes('نسخة مع فتح وقفل الوردية') &&
    backupCardText.includes('نسخة كل ساعتين أثناء الشغل') &&
    backupCardText.includes('MSHOP-BACKUP') &&
    backupCardText.includes('فحص سلامة كل نسخة بعد الإنشاء'),
  backupCardText
);
const initialSavedRows = await count('[data-saved-backup-row]');
check('saved backups table shows initial shift and periodic backups', initialSavedRows >= 4, String(initialSavedRows));

// Toggle USB auto off, take a manual backup («خد نسخة دلوقتي»), verify it shows «الكمبيوتر» and «سليمة ✓»
await page.click('[data-backup-toggle="backupUsbAuto"]');
await sleep(150);
await page.click('[data-backup-now-btn]');
await sleep(250);
const afterManualRows = await count('[data-saved-backup-row]');
const firstSavedRowText = await text('[data-saved-backups-table] tbody tr:first-child');
check(
  '«خد نسخة دلوقتي» adds a verified manual backup row at the top of the table',
  afterManualRows === initialSavedRows + 1 &&
    firstSavedRowText.includes('يدوي') &&
    firstSavedRowText.includes('الكمبيوتر') &&
    !firstSavedRowText.includes('فلاشة USB') &&
    firstSavedRowText.includes('سليمة'),
  firstSavedRowText
);

// Click «انسخ على فلاشة» and verify the latest backup row updates to «الكمبيوتر + فلاشة USB»
await page.click('[data-backup-usb-btn]');
await sleep(250);
const afterUsbRowText = await text('[data-saved-backups-table] tbody tr:first-child');
check(
  '«انسخ على فلاشة» copies the latest backup to MSHOP-BACKUP and updates its location',
  afterUsbRowText.includes('الكمبيوتر + فلاشة USB'),
  afterUsbRowText
);
await page.click('[data-backup-toggle="backupUsbAuto"]');
await sleep(150);
await page.$eval('[data-backup-policy-card]', (el) => el.scrollIntoView({ block: 'start' }));
await sleep(150);
await shot('48-settings-automatic-backup-policy');

// Click «استرجاع» on the first row -> requires Owner PIN approval («استرجاع نسخة احتياطية»)
await page.click('[data-saved-backups-table] tbody tr:first-child [data-backup-restore-btn]');
await page.waitForSelector('.modal .approver', { timeout: 3000 });
const restoreApproveTitle = await text('.modal');
check(
  'restoring a saved backup prompts for Owner PIN approval',
  restoreApproveTitle.includes('استرجاع نسخة احتياطية'),
  restoreApproveTitle
);
await page.keyboard.type('4321');
await page.keyboard.press('Enter');
await sleep(300);
check(
  'owner PIN approval completes the saved backup restore and closes the prompt',
  (await count('.modal .approver')) === 0
);

// --- Plan item 1.13: Eight Settings screens & Devices/Printer tab (ADR-028) --
const settingsTabLabels = await page.$$eval(
  '[data-settings-nav] button[data-settings-tab]',
  (els) => els.map((e) => (e.textContent ?? '').trim()),
);
check(
  'Settings sidebar lists all 8 approved settings tabs in exact order',
  settingsTabLabels.join('، ') ===
    'المحل، الشكل، الأصناف والبيع، المستخدمين والصلاحيات، المحافظ والدفع، الإيصال والضمان، النسخ الاحتياطي، الأجهزة والطابعة',
  settingsTabLabels.join('، ')
);

await page.click('[data-settings-tab="devices"]');
await sleep(150);
const devicesVisible = await page.$eval(
  '[data-settings-panel="devices"]',
  (el) => getComputedStyle(el).display !== 'none',
);
const shopHidden = await page.$eval(
  '[data-settings-panel="shop"]',
  (el) => getComputedStyle(el).display === 'none',
);
check(
  'clicking «الأجهزة والطابعة» filters settings to the Devices & Printer tab',
  devicesVisible && shopHidden
);

const initialPrinterCard = await text('[data-devices-printer-card]');
check(
  'Devices & Printer tab defaults to «مفيش طابعة دلوقتي» and «واتساب بس»',
  initialPrinterCard.includes('مفيش طابعة دلوقتي') &&
    initialPrinterCard.includes('واتساب بس') &&
    initialPrinterCard.includes('عندي طابعة إيصالات'),
  initialPrinterCard
);

await page.click('[data-devices-printer-toggle]');
await sleep(200);
const enabledPrinterCard = await text('[data-devices-printer-card]');
check(
  'enabling «عندي طابعة إيصالات» reveals XP-80 (USB) ready badge, paper sizes, and test print button',
  enabledPrinterCard.includes('XP-80 (USB)') &&
    enabledPrinterCard.includes('جاهزة') &&
    enabledPrinterCard.includes('صفحة تجربة') &&
    enabledPrinterCard.includes('مقاس الورق'),
  enabledPrinterCard
);

await page.click('[data-devices-paper="58"]');
await sleep(150);
const paper58PrinterCard = await text('[data-devices-printer-card]');
check(
  'choosing 58mm paper in «الأجهزة والطابعة» updates the printer status description',
  paper58PrinterCard.includes('58 مم'),
  paper58PrinterCard
);
await shot('49-settings-eight-tabs-devices-printer');
check(
  '«الأجهزة والطابعة» displays paired mobile phones, pairing QR code, and local LAN server address',
  (await count('[data-paired-devices-card]')) === 1 &&
    (await count('[data-companion-qr]')) === 1 &&
    (await text('[data-companion-host-address]')).includes(':8787')
);

await page.click('[data-remote-followup-toggle]');
await sleep(200);
check(
  'Enabling «مرحّل المتابعة البعيدة للمالك» in «الأجهزة والطابعة» reveals the encrypted read-only remote QR code',
  (await count('[data-remote-followup-card]')) === 1 &&
    (await count('[data-remote-qr]')) === 1 &&
    (await text('[data-remote-followup-card]')).includes('RMT-9042')
);

// Restore printerEnabled to off and switch back to all settings sections
await page.click('[data-devices-printer-toggle]');
await sleep(150);
await page.click('[data-settings-tab="all"]');
await sleep(150);

// --- Plan item 1.14: Sales history & analytics screen (`ADR-029`) -----------
await clickText('.rail .nav-btn', 'المبيعات');
await page.waitForSelector('[data-sales-screen]', { timeout: 3000 });
await sleep(250);

check(
  'Owner lands on «المبيعات» seeing «كل مبيعات المحل» and all 4 KPI cards including profit',
  (await text('[data-sales-subtitle]')) === 'كل مبيعات المحل' &&
    (await count('[data-sales-kpi="sales"]')) === 1 &&
    (await count('[data-sales-kpi="invoices"]')) === 1 &&
    (await count('[data-sales-kpi="pcs"]')) === 1 &&
    (await count('[data-sales-kpi="profit"]')) === 1 &&
    (await count('[data-sales-seller]')) === 1
);

const ownerTodayInvoicesCount = await count('[data-sales-inv-row]');
check(
  'Owner sees all today sales recorded by both sellers in the invoices table',
  ownerTodayInvoicesCount >= 2,
  `invoices=${ownerTodayInvoicesCount}`
);

// Switch range to «آخر 7 أيام» and test «الأيام», «الأصناف», and «التصنيفات» views
await page.click('[data-sales-range="week"]');
await sleep(150);
check(
  'Selecting «آخر 7 أيام» enables the «الأيام» view tab',
  (await count('[data-sales-view="day"]')) === 1
);

await page.click('[data-sales-view="day"]');
await sleep(150);
check(
  '«الأيام» view lists 7 days with «أعلى يوم» badge on the top day',
  (await count('[data-sales-day-row]')) === 7 &&
    (await text('[data-sales-table="day"]')).includes('أعلى يوم')
);

await page.click('[data-sales-view="prod"]');
await sleep(150);
check(
  '«الأصناف» view aggregates sold products with quantities, revenue, and profit',
  (await count('[data-sales-prod-row]')) >= 2 &&
    (await text('[data-sales-table="prod"]')).includes('الربح')
);

await page.click('[data-sales-view="cat"]');
await sleep(150);
check(
  '«التصنيفات» view aggregates main and sub-categories with share percentage',
  (await count('[data-sales-cat-row]')) >= 1 &&
    (await text('[data-sales-table="cat"]')).includes('%')
);

// Return to «النهارده» and «الفواتير» view, test seller filter & clear filters
await page.click('[data-sales-range="today"]');
await sleep(100);
await page.click('[data-sales-view="inv"]');
await sleep(150);
await page.select('[data-sales-seller]', 'u-youssef');
await sleep(150);
const youssefFilteredCount = await count('[data-sales-inv-row]');
check(
  'Filtering by seller «يوسف» shows only Youssef’s invoice(s) and reveals «مسح الفلاتر»',
  youssefFilteredCount === 1 && (await count('[data-sales-clear-filters]')) === 1,
  `youssefFilteredCount=${youssefFilteredCount}`
);

await page.click('[data-sales-clear-filters]');
await sleep(150);
check(
  'Clicking «مسح الفلاتر» restores all invoices for the period',
  (await count('[data-sales-inv-row]')) === ownerTodayInvoicesCount
);

// Open an invoice detail modal and resend its receipt on WhatsApp
await page.click('[data-sales-inv-row]');
await page.waitForSelector('[data-sales-detail-modal]', { timeout: 3000 });
await sleep(150);
check(
  'Invoice detail modal displays lines, total, and profit for the owner',
  (await count('[data-sales-detail-total]')) === 1 &&
    (await count('[data-sales-detail-profit]')) === 1 &&
    (await count('[data-sales-detail-cancel-open]')) === 1
);
if ((await count('[data-sales-detail-wa-phone]')) > 0) {
  await page.type('[data-sales-detail-wa-phone]', '01001234567');
  await sleep(100);
}
await page.click('[data-sales-detail-resend]');
await sleep(200);
check(
  'Clicking «ابعت الإيصال تاني واتساب» in invoice detail modal sends the receipt and shows confirmation toast',
  (await text('#toasts')).includes('اتبعت الإيصال تاني على واتساب')
);
await shot('50-sales-history-owner');
await page.click('[data-sales-detail-close]');
await sleep(150);

// Switch to seller Youssef and verify seller-scoped Sales screen (own sales only, no cost/profit)
await page.click('.user-chip');
await page.waitForSelector('.sw-menu');
await clickText('.sw-item', 'يوسف');
await page.waitForSelector('.sw-menu.pin', { timeout: 3000 });
await page.keyboard.type('2222');
await page.keyboard.press('Enter');
await sleep(400);

check(
  'Seller sees «المبيعات» on the rail, scoped to «مبيعاتك انت بس» without profit KPI or seller filter',
  (await text('[data-sales-subtitle]')) === 'مبيعاتك انت بس' &&
    (await count('[data-sales-kpi="profit"]')) === 0 &&
    (await count('[data-sales-seller]')) === 0 &&
    (await count('[data-sales-inv-row]')) === 1
);
await shot('51-sales-history-seller');

// --- Plan item 1.15: Shortages («النواقص», ADR-030) ------------------------
// 1. Seller Youssef adds a free-text item and an out-of-stock product from POS search without leaving the invoice
await clickText('.rail .nav-btn', 'البيع');
await page.waitForSelector('#q', { timeout: 3000 });
await page.focus('#q');
await page.type('#q', 'جراب جالاكسي S25 الترا');
await page.waitForSelector('[data-pos-shortage-free]', { timeout: 3000 });
await page.click('[data-pos-shortage-free]');
await sleep(200);
check(
  'POS search with no results offers «لو العميل طالبه: ضيف ... للنواقص» and adds it without leaving POS',
  (await text('#toasts')).includes('اتسجّل «جراب جالاكسي S25 الترا» في النواقص') &&
    (await page.$eval('#q', (el) => el.value)) === ''
);

await page.focus('#q');
await page.type('#q', 'فلاشة 32 جيجا');
await page.waitForSelector('[data-pos-shortage-prod]', { timeout: 3000 });
await page.click('[data-pos-shortage-prod]');
await sleep(200);
check(
  'POS search for an out-of-stock product offers «ضيف للنواقص» with suggested quantity (10 pieces)',
  (await text('#toasts')).includes('اتضاف «فلاشة 32 جيجا» للنواقص (10 قطع)') &&
    (await page.$eval('#q', (el) => el.value)) === ''
);

// Switch back to owner Peter (PIN 4321) for the Store Shortages tab and remaining checks
await page.click('.user-chip');
await page.waitForSelector('.sw-menu');
await clickText('.sw-item', 'بيتر');
await page.waitForSelector('.sw-menu.pin', { timeout: 3000 });
await page.keyboard.type('4321');
await page.keyboard.press('Enter');
await sleep(400);

// 2. Navigate to «المخزن» and verify the two tabs («الأصناف» and «النواقص (عددها)»)
await clickText('.rail .nav-btn', 'المخزن');
await page.waitForSelector('[data-store-tabs]', { timeout: 3000 });
await sleep(200);
check(
  'Store screen shows «الأصناف» and «النواقص (4)» tabs',
  (await count('[data-store-tab="items"]')) === 1 &&
    (await count('[data-store-tab="shortages"]')) === 1 &&
    (await text('[data-store-shortages-badge]')) === '4'
);

await page.click('[data-store-tab="shortages"]');
await page.waitForSelector('[data-shortages-panel]', { timeout: 3000 });
await sleep(200);
check(
  'Shortages tab displays seeded shortages and items added by seller from POS',
  (await count('[data-sh-row]')) === 4 &&
    (await text('[data-sh-list]')).includes('شاحن لاسلكي ماج سيف') &&
    (await text('[data-sh-list]')).includes('جراب جالاكسي S25 الترا') &&
    (await text('[data-sh-list]')).includes('فلاشة 32 جيجا') &&
    (await text('[data-sh-list]')).includes('كريم مصطفى')
);

// 3. Manual add with waiting customer & duplicate merge
await page.type('[data-sh-name-input]', 'شاحن 65 وات تايب سي');
await page.$eval('[data-sh-qty-input]', (el) => {
  el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.type('[data-sh-qty-input]', '3');
await page.type('[data-sh-cust-input]', 'أحمد سمير 01234567890');
await page.type('[data-sh-note-input]', 'لون أبيض أصلي');
await page.click('[data-sh-add-submit]');
await sleep(200);
check(
  'Manual shortage add records item, quantity, waiting customer name & phone, and note',
  (await count('[data-sh-row]')) === 5 &&
    (await text('[data-sh-list]')).includes('شاحن 65 وات تايب سي') &&
    (await text('[data-sh-list]')).includes('أحمد سمير') &&
    (await text('[data-sh-list]')).includes('01234567890')
);

// Adding the same item again increments its required quantity instead of creating a duplicate
await page.type('[data-sh-name-input]', 'شاحن 65 وات تايب سي');
await page.$eval('[data-sh-qty-input]', (el) => {
  el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.type('[data-sh-qty-input]', '2');
await page.click('[data-sh-add-submit]');
await sleep(200);
check(
  'Adding an existing shortage again increments its quantity to 5 pieces',
  (await count('[data-sh-row]')) === 5 &&
    (await text('#toasts')).includes('زوّدنا الكمية المطلوبة لـ 5 قطع')
);

// 4. Add a system-suggested low-stock item from «مقترح من المخزن»
const sugBefore = await count('[data-sh-suggest-row]');
await page.click('[data-sh-add-suggested]');
await sleep(200);
check(
  'Clicking «ضيفه للنواقص» in «مقترح من المخزن» moves the low-stock product into the active shortages list',
  sugBefore > 0 &&
    (await count('[data-sh-suggest-row]')) === sugBefore - 1 &&
    (await count('[data-sh-row]')) === 6
);

// 5. Toggle status «اتطلب» (`ordered`) and filter by status
await page.click('[data-sh-row] [data-sh-status-toggle="ordered"]');
await sleep(200);
await page.click('[data-sh-filter="ordered"]');
await sleep(150);
check(
  'Marking a shortage as «اتطلب» updates its status and filters under «اتطلب»',
  (await count('[data-sh-row]')) === 2 &&
    (await text('#toasts')).includes('اتعلّم')
);
await page.click('[data-sh-filter="all"]');
await sleep(150);

// 6. Click «وصل» on the item with waiting customer («شاحن لاسلكي ماج سيف»)
await page.click('[data-sh-row="sh-demo-1"] [data-sh-resolve]');
await sleep(200);
check(
  'Clicking «وصل» resolves the shortage and alerts about the waiting customer («كريم مصطفى: 01011122233»)',
  (await count('[data-sh-row="sh-demo-1"]')) === 0 &&
    (await text('#toasts')).includes('«شاحن لاسلكي ماج سيف» وصل، وكريم مصطفى مستنيه: 01011122233')
);
await shot('52-store-shortages');

// 7. Receiving stock in «الأصناف» auto-resolves the matching shortage («فلاشة 32 جيجا»)
await page.click('[data-store-tab="items"]');
await page.waitForSelector('#stock-product', { timeout: 3000 });
await page.evaluate(() => {
  const sel = document.querySelector('#stock-product');
  if (!sel) return;
  const opt = [...sel.options].find((o) => o.textContent?.includes('فلاشة 32 جيجا'));
  if (opt) {
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
});
if ((await count('.stock .gate button')) > 0) {
  await clickText('.stock .gate button', 'عرض المخزن');
  await page.waitForSelector('.stock .overlay form.modal input[type=password]', { timeout: 3000 });
  await page.type('.stock .overlay form.modal input[type=password]', '1234');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.stock .position', { timeout: 3000 });
}
const flashReceiveInputs = await page.$$('.stock .position form.form input');
await flashReceiveInputs[0].type('10');
await flashReceiveInputs[1].type('12000');
await clickText('.stock .position form.form button', 'استلام');
await sleep(250);
check(
  'Receiving stock for «فلاشة 32 جيجا» automatically removes it from shortages and updates the badge count',
  (await text('#toasts')).includes('«فلاشة 32 جيجا» وصل واتشال من النواقص') &&
    (await text('[data-store-shortages-badge]')) === '4'
);

// --- Repairs & Software («الصيانة والسوفت وير», Plan 2.1 / ADR-031) ----------
await clickText('.rail .nav-btn', 'الصيانة');
await page.waitForSelector('[data-repairs-screen]', { timeout: 3000 });
await sleep(200);
check(
  'Repairs & Software screen shows 5 Kanban stages and separate Hardware vs Software money cards',
  (await count('[data-kanban-col]')) === 5 &&
    (await count('[data-repairs-hw-card]')) === 1 &&
    (await count('[data-repairs-sw-card]')) === 1 &&
    (await text('[data-hw-revenue]')).includes('1,450') &&
    (await text('[data-sw-revenue]')).includes('250')
);

// Record a walk-in Software operation (`+ عملية سوفت وير`, 300 EGP, delivered immediately by يوسف)
await page.click('[data-repairs-new-software]');
await page.waitForSelector('[data-intake-phone]', { timeout: 3000 });
await page.type('[data-intake-phone]', '01066778899');
await page.type('[data-intake-customer]', 'رامي نبيل');
await page.type('[data-intake-device]', 'شاومي ريدمي 13C');
await page.click('[data-intake-issue-chip="تخطي حساب جوجل FRP"]');
await page.type('[data-intake-tech]', 'يوسف');
await page.type('[data-intake-price]', '300');
await page.click('[data-intake-submit]');
await page.waitForSelector('[data-intake-phone]', { hidden: true, timeout: 3000 });
await sleep(200);
check(
  'Recording a 300 EGP Software operation increases Software revenue to 550 EGP without touching Hardware money',
  (await text('[data-sw-revenue]')).includes('550') &&
    (await text('[data-sw-profit]')).includes('550') &&
    (await text('[data-hw-revenue]')).includes('1,450'),
  `sw=${await text('[data-sw-revenue]')} hw=${await text('[data-hw-revenue]')}`
);

// Deliver ready Hardware ticket R-1091 (`سلّم وحصّل`, 3,200 EGP final, 2,100 EGP parts cost, 500 EGP prior deposit -> 2,700 EGP remaining)
await page.click('[data-repair-wa-ready="R-1091"]');
await sleep(100);
check(
  'Ready ticket WhatsApp button prepares the ready-for-pickup message for the customer',
  (await text('[data-repairs-ok-banner]')).includes('جاهز للاستلام')
);
await page.click('[data-repair-deliver-open="R-1091"]');
await page.waitForSelector('[data-deliver-final-price]', { timeout: 3000 });
check(
  'Deliver modal calculates remaining 2,700 EGP (3,200 final − 500 deposit) and 1,100 EGP net profit',
  (await text('[data-deliver-remaining]')).includes('2,700') &&
    (await text('[data-deliver-net-profit]')).includes('1,100')
);
await page.click('[data-deliver-confirm]');
await page.waitForSelector('[data-deliver-final-price]', { hidden: true, timeout: 3000 });
await sleep(200);
check(
  'Delivering R-1091 adds 2,700 EGP to Hardware revenue (1,450 -> 4,150 EGP) while Software revenue stays 550 EGP',
  (await text('[data-hw-revenue]')).includes('4,150') &&
    (await text('[data-sw-revenue]')).includes('550'),
  `hw=${await text('[data-hw-revenue]')} sw=${await text('[data-sw-revenue]')}`
);

// Receive a new Hardware repair into Kanban (`استلام جهاز صيانة`) and advance it one stage
await page.click('[data-repairs-new]');
await page.waitForSelector('[data-intake-phone]', { timeout: 3000 });
await page.type('[data-intake-phone]', '01200112233');
await page.type('[data-intake-customer]', 'ماجد شوقي');
await page.type('[data-intake-device]', 'سامسونج A54');
await page.click('[data-intake-issue-chip="شاشة"]');
await page.click('[data-intake-acc-chip="جراب"]');
await page.type('[data-intake-tech]', 'م. حسن');
await page.type('[data-intake-price]', '1800');
await page.click('[data-intake-submit]');
await page.waitForSelector('[data-intake-phone]', { hidden: true, timeout: 3000 });
await sleep(200);
check(
  'New hardware repair R-1096 lands in «استلام» column and advances to «فحص» on click',
  (await count('[data-kanban-col="received"] [data-ticket-no="R-1096"]')) === 1
);
await page.click('[data-repair-advance="R-1096"]');
await sleep(200);
check(
  'Advancing R-1096 moves it from «استلام» to «فحص»',
  (await count('[data-kanban-col="diagnosing"] [data-ticket-no="R-1096"]')) === 1
);
  await page.evaluate(() => {
    document.querySelector('.content')?.scrollTo(0, 0);
    document.querySelectorAll('.toast').forEach((el) => el.remove());
  });
  await new Promise((r) => setTimeout(r, 150));
  await shot('53-repairs-and-software');

  // --- Phase 2 Item 2.2: Used phones, trade-in, IMEI check, and opening used stock (ADR-032) ---
  await clickText('.rail .nav-btn', 'المخزن');
  await page.waitForSelector('[data-open-used-phone]', { timeout: 3000 });
  await page.click('[data-open-used-phone]');
  await page.waitForSelector('#nu-model', { timeout: 3000 });
  await page.type('#nu-model', 'Galaxy A54');
  await page.type('#nu-color', 'أسود');
  await page.type('#nu-imei', '358240051111110');
  await page.click('[data-nu-check-imei]');
  await page.waitForSelector('[data-nu-imei-report]', { timeout: 3000 });
  check(
    'Inline IMEI check inside NewUsedPhoneModal verifies Luhn + TAC and confirms the device is not in shop stock',
    (await text('[data-nu-imei-report]')).includes('35824005')
  );
  await page.$eval('#nu-batt', (el) => {
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.type('#nu-batt', '91');
  await page.type('#nu-note', 'حالة ممتازة بدون خدوش');
  await page.type('#nu-cost', '9500');
  await page.type('#nu-price', '11500');
  await page.click('[data-nu-seller-summary]');
  await page.waitForSelector('#nu-seller-name', { timeout: 3000 });
  await page.type('#nu-seller-name', 'أحمد سمير');
  await page.type('#nu-seller-phone', '01012345678');
  await page.type('#nu-seller-nid', '29501011234567');
  check(
    'NewUsedPhoneModal builds the automatic used phone title with grade («Samsung Galaxy A54 128GB مستعمل فئة A»)',
    (await text('#nu-preview')).includes('Samsung Galaxy A54 128GB مستعمل فئة A')
  );
  await shot('54-used-phone-modal');
  await page.click('[data-nu-submit]');
  await page.waitForSelector('#nu-model', { hidden: true, timeout: 3000 });
  await sleep(250);

  // Open IMEI Check modal and inspect the newly registered used phone
  await page.click('[data-open-imei-check]');
  await page.waitForSelector('#imei-check-input', { timeout: 3000 });
  await page.type('#imei-check-input', '358240051111110');
  await page.click('[data-imei-check-submit]');
  await page.waitForSelector('[data-imei-local-unit]', { timeout: 3000 });
  const imeiModalTxt = await text('[data-imei-check-result]');
  check(
    'ImeiCheckModal verifies Luhn + TAC and shows the local used phone unit with grade, battery %, cost, and seller details',
    (await count('[data-imei-luhn-ok]')) === 1 &&
      imeiModalTxt.includes('Samsung Galaxy A54 128GB مستعمل فئة A') &&
      imeiModalTxt.includes('91%') &&
      imeiModalTxt.includes('أحمد سمير') &&
      imeiModalTxt.includes('29501011234567')
  );
  await shot('55-imei-check-modal');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#imei-check-input', { hidden: true, timeout: 3000 });

  // Register an opening-stock used phone («المستعمل اللي في المحل يوم البداية») with owner PIN approval
  await page.click('[data-open-used-phone]');
  await page.waitForSelector('[data-used-opening-toggle]', { timeout: 3000 });
  check(
    'the opening-stock toggle is a row with its caption beside the switch, not over the form',
    await page.evaluate(() => {
      const cap = document.querySelector('[data-used-opening-toggle] .cap');
      const first = document.querySelector('.modal .field');
      if (cap === null || first === null) return false;
      const c = cap.getBoundingClientRect();
      const f = first.getBoundingClientRect();
      // The caption must have a place of its own: a caption painted as the switch's
      // track sits inside a 44×26 box, and its text then covers the first field.
      return c.height > 14 && c.bottom <= f.top + 1;
    }),
  );
  await page.click('[data-used-opening-toggle]');
  await page.click('[data-grade="B"]');
  await page.type('#nu-model', 'Galaxy A34');
  await page.type('#nu-imei', '352099001761481');
  await page.type('#nu-cost', '7200');
  await page.type('#nu-price', '8600');
  await page.click('[data-nu-submit]');
  await page.waitForSelector('.modal .approver', { timeout: 3000 });
  await page.keyboard.type('4321');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#nu-model', { hidden: true, timeout: 3000 });
  await sleep(250);
  check(
    'Opening-stock used phone requires owner PIN approval and registers «Samsung Galaxy A34 128GB مستعمل فئة B»',
    (await text('.page')).includes('Samsung Galaxy A34 128GB مستعمل فئة B')
  );

  // Switch to POS and perform a Trade-in («استبدال مستعمل: شراء + بيع في فاتورة واحدة»)
  await clickText('.rail .nav-btn', 'البيع');
  await page.waitForSelector('[data-pos-tradein]', { timeout: 3000 });
  await clickText('.chips.cats .chip', 'الكل');
  await sleep(150);
  await clickText('.tile', 'Samsung Galaxy A54 128GB مستعمل فئة A');
  await sleep(200);
  if ((await count('#imei-in')) > 0) {
    await page.click('.imei-row');
    await sleep(150);
  }
  await page.click('[data-pos-tradein]');
  await page.waitForSelector('#nu-model', { timeout: 3000 });
  await page.click('[data-grade="B"]');
  await page.type('#nu-model', 'Galaxy A24');
  await page.type('#nu-imei', '864219042345679');
  await page.type('#nu-cost', '4500');
  await page.type('#nu-price', '5600');
  await page.type('#nu-seller-name', 'محمود عادل');
  await page.type('#nu-seller-phone', '01122334455');
  await page.click('[data-nu-submit]');
  await page.waitForSelector('#nu-model', { hidden: true, timeout: 3000 });
  await sleep(250);
  check(
    'POS trade-in («استبدال مستعمل») registers the customer device into stock and deducts 4,500 EGP from the active invoice',
    (await count('[data-pos-tradein-row]')) === 1 &&
      (await text('[data-pos-tradein-row]')).includes('Samsung Galaxy A24 128GB مستعمل فئة B') &&
      (await text('.totals .grand')).includes('7,000')
  );
  await shot('56-pos-tradein');
  await page.click('#pos-exact-cash-btn');
  await sleep(300);
  check(
    'Completing the trade-in sale clears the invoice and removes the sold used phone from available POS tiles',
    (await count('.line')) === 0 && (await count('[data-pos-tradein-row]')) === 0
  );

  // --- Phase 2 Item 2.3: Labels & Internal Shop Barcodes (ADR-033) -----------
  await clickText('.rail .nav-btn', 'المخزن');
  await page.waitForSelector('[data-open-labels]', { timeout: 3000 });
  await page.click('[data-open-labels]');
  await page.waitForSelector('[data-labels-modal]', { timeout: 3000 });
  await sleep(250);

  check(
    'LabelsModal opens with a barcoded product queued and renders a real SVG barcode sticker',
    (await count('[data-sticker-svg] rect')) >= 10 &&
      (await count('[data-sticker-digits]')) >= 1
  );

  if ((await count('[data-labels-generate-all-missing]')) > 0) {
    await page.click('[data-labels-generate-all-missing]');
    await sleep(300);
  }
  check(
    'Generating missing internal shop codes assigns valid 200... EAN-13 barcodes to all active products',
    (await count('[data-labels-generate-all-missing]')) === 0 &&
      (await count('[data-labels-internal-badge]')) >= 1
  );

  await page.click('[data-labels-tab="units"]');
  await sleep(200);
  await page.type('[data-labels-search]', 'A34');
  await sleep(150);
  await page.click('[data-labels-add-unit]');
  await sleep(200);
  check(
    'Adding an IMEI unit to the label queue renders a Code-128 IMEI sticker with used-phone grade & battery subtitle',
    (await count('[data-sticker-unit-subtitle]')) >= 1 &&
      (await text('[data-sticker-unit-subtitle]')).includes('فئة B') &&
      (await text('[data-labels-preview]')).includes('IMEI:')
  );

  await page.click('[data-labels-toggle-tspl]');
  await sleep(150);
  await page.click('[data-labels-print]');
  await sleep(250);
  check(
    'TSPL thermal printer preview and Print Labels action confirm ready-to-print stickers',
    (await text('[data-labels-tspl-code]')).includes('SIZE 40 mm, 30 mm') &&
      (await text('[data-labels-tspl-code]')).includes('BARCODE') &&
      (await count('[data-labels-print-status]')) === 1
  );
  await shot('57-labels-modal');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-labels-modal]', { hidden: true, timeout: 3000 });
  await sleep(150);

  // --- Phase 2 Item 2.4: Stock Count by Scan & Missing IMEI Detection (ADR-034)
  await page.click('[data-open-stock-count]');
  await page.waitForSelector('[data-stock-count-modal]', { timeout: 3000 });
  await sleep(250);

  check(
    'StockCountModal opens and flags all 3 registered in-stock IMEI units until scanned',
    (await text('[data-sc-kpi-missing-units]')).includes('3 جهاز')
  );

  await page.type('[data-sc-scan-input]', '356938035643809');
  await page.keyboard.press('Enter');
  await sleep(150);
  await page.type('[data-sc-scan-input]', '352099001761481');
  await page.keyboard.press('Enter');
  await sleep(150);
  check(
    'Scanning 2 IMEIs updates scanned count to 2 / 3 and isolates the 1 missing IMEI',
    (await text('[data-sc-kpi-scanned-units]')).includes('2 / 3') &&
      (await text('[data-sc-kpi-missing-units]')).includes('1 جهاز') &&
      (await text('[data-sc-scan-feedback]')).includes('اتمسح الموبايل ✓')
  );

  await page.click('[data-sc-tab="missing_imeis"]');
  await sleep(150);
  check(
    '«IMEI ناقص» tab pinpoints the exact missing device (Galaxy A24 · IMEI 864219042345679)',
    (await count('[data-sc-missing-unit]')) === 1 &&
      (await text('[data-sc-missing-list]')).includes('864219042345679') &&
      (await text('[data-sc-missing-list]')).includes('Samsung Galaxy A24 128GB مستعمل فئة B')
  );
  await shot('58-stock-count-modal');

  await page.click('[data-sc-submit]');
  await page.waitForSelector('.modal .approver', { timeout: 3000 });
  await page.keyboard.type('4321');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-stock-count-modal]', { hidden: true, timeout: 3000 });
  await sleep(250);
  check(
    'Approving Stock Count reconciliation with Owner PIN retires the missing IMEI and updates stock',
    (await text('#toasts')).includes('اتسجّلت تسوية الجرد') &&
      (await text('#toasts')).includes('استبعاد 1 جهاز IMEI ناقص')
  );

  // --- Phase 2 Item 2.5: Monthly Reports & Evaluation (ADR-035) ------------
  await clickText('.rail .nav-btn', 'التقارير');
  await page.waitForSelector('[data-reports-screen]', { timeout: 3000 });
  await sleep(250);

  check(
    'Owner opens «التقارير» on the «النهارده» tab with 5 KPI cards, 7-day bars, and separate repair/software revenue',
    (await count('[data-reports-today-kpi]')) === 5 &&
      (await text('[data-reports-today-kpi="services"]')).includes('صيانة') &&
      (await text('[data-reports-today-kpi="services"]')).includes('سوفت') &&
      (await count('[data-reports-open-month]')) === 1
  );
  await shot('59-reports-today');

  // --- Phase 3 Item 3.1: Smart Alerts & Daily WhatsApp Summary (ADR-036) ---
  check(
    'Smart Alerts section in «النهارده» displays shortages, overdue repairs, and stagnant items (+30 days)',
    (await count('[data-reports-smart-alerts]')) === 1 &&
      (await count('[data-smart-alert-shortages]')) === 1 &&
      (await count('[data-smart-alert-repairs]')) === 1 &&
      (await count('[data-smart-alert-overdue-row]')) >= 1 &&
      (await count('[data-smart-alert-stagnant]')) === 1 &&
      (await count('[data-smart-alert-stagnant-row]')) >= 1 &&
      (await text('[data-smart-alert-stagnant]')).includes('رأس مال مجمد')
  );

  await page.click('[data-reports-wa-summary]');
  await page.waitForSelector('[data-reports-wa-preview]', { timeout: 3000 });
  await sleep(200);
  const waSummaryBody = await text('[data-reports-wa-preview]');
  check(
    'Clicking «ملخص اليوم واتساب للمالك» generates a structured Arabic summary with separate repair & software revenue, drawer cash, and smart alerts',
    waSummaryBody.includes('ملخص اليوم') &&
      waSummaryBody.includes('فلوس الصيانة لوحدها') &&
      waSummaryBody.includes('فلوس السوفت وير لوحدها') &&
      waSummaryBody.includes('المفروض في الدرج') &&
      waSummaryBody.includes('التنبيهات الذكية') &&
      (await text('#toasts')).includes('اتبعت ملخص اليوم على واتساب المالك'),
    waSummaryBody.slice(0, 120)
  );
  await shot('61-smart-alerts-whatsapp');

  await page.click('[data-reports-open-month]');
  await page.waitForSelector('[data-reports-evaluation]', { timeout: 3000 });
  await sleep(250);

  check(
    'Switching to «الشهر» displays monthly KPIs, evaluation verdict & notes, daily bars, 12-month trend, and separate repair/software buckets',
    (await count('[data-reports-kpi]')) === 5 &&
      (await count('[data-reports-verdict]')) === 1 &&
      (await count('.ev-li')) >= 3 &&
      (await count('[data-reports-day-bar]')) >= 1 &&
      (await count('[data-reports-month-row]')) >= 3 &&
      (await text('[data-reports-repairs-summary]')).includes('فلوس الصيانة لوحدها') &&
      (await text('[data-reports-repairs-summary]')).includes('فلوس السوفت وير لوحدها')
  );
  await shot('60-reports-month');

  const curMonthTitle = await text('[data-reports-month-title]');
  await page.click('[data-reports-shift="-1"]');
  await sleep(200);
  const prevMonthTitle = await text('[data-reports-month-title]');
  check(
    'Clicking previous month arrow shifts the monthly report to the prior month',
    prevMonthTitle !== '' && prevMonthTitle !== curMonthTitle,
    `${curMonthTitle} -> ${prevMonthTitle}`
  );

  await page.click('[data-reports-open-sales]');
  await page.waitForSelector('[data-sales-screen]', { timeout: 3000 });
  await sleep(200);
  check(
    'Clicking «فواتير الشهر» in Reports opens the Sales screen filtered to that month',
    (await text('.topbar h1')) === 'المبيعات' &&
      (await count('[data-sales-inv-row]')) >= 1
  );

  // --- Phase 3 Item 3.2 (ADR-037): LAN Companion Server & Mobile Helper -----
  await clickText('.rail .nav-btn', 'الموبايل');
  await page.waitForSelector('[data-mobile-screen]', { timeout: 3000 });
  await sleep(250);
  check(
    'Mobile Companion screen renders all 4 helper phones and the stateless LAN note',
    (await text('.topbar h1')) === 'تطبيق الموبايل' &&
      (await count('[data-mobile-frame="sales"]')) === 1 &&
      (await count('[data-mobile-frame="scan"]')) === 1 &&
      (await count('[data-mobile-frame="lookup"]')) === 1 &&
      (await count('[data-mobile-frame="receive"]')) === 1 &&
      (await text('[data-mobile-screen]')).includes('مفيش قاعدة بيانات على الموبايل')
  );
  await shot('62-mobile-companion');

  await page.click('[data-mobile-mode="remote"]');
  await sleep(200);
  const remoteSummaryTxt = await text('[data-mobile-remote-summary]');
  check(
    'Switching Mobile Companion to «من برّه المحل (للمالك)» displays separate repair & software money and drawer cash',
    remoteSummaryTxt.includes('فلوس الصيانة لوحدها') &&
      remoteSummaryTxt.includes('فلوس السوفت وير لوحدها') &&
      remoteSummaryTxt.includes('المفروض في الدرج'),
    remoteSummaryTxt
  );
  await shot('63-mobile-remote-owner');

  await page.click('[data-mobile-scan-acc]');
  await sleep(250);
  await page.click('[data-mobile-go-pos]');
  await page.waitForSelector('.pos', { timeout: 3000 });
  await sleep(300);
  check(
    'Scanning on the mobile helper and jumping to POS delivers the scanned item to the open invoice',
    (await text('.topbar h1')) === 'البيع' &&
      (await count('.pos .line')) >= 1
  );

// --- the owner's PIN approval (ADR-017 §3) ---------------------------------
// No demo screen is sensitive yet, so the prompt is opened the way a screen
// will open it: through the app's own module, which the dev server shares with
// the page. The exact URL the app loaded is used — after an edit Vite adds a
// `?t=` stamp, and another URL would be another module instance. On a static
// build that module does not exist; the checks say so.
const APPROVAL_MODULE = '/src/shell/approval.ts';
const ask = (label) =>
  page.evaluate(
    async (spec, what) => {
      try {
        const loaded = performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((name) => new URL(name).pathname === spec);
        const approval = await import(loaded ?? spec);
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

// --- the recovery code (ADR-017 §4) ----------------------------------------
// The owner makes a new code in الإعدادات (his password), it is shown once in
// groups, and «تمام» waits for «كتبته». Then, locked out of his password, he
// uses it from the card: a wrong code is refused, the right one sets a new
// password and shows the next code once.
const CODE_SHAPE = /^[2-9A-HJKMNP-Z]{4}(-[2-9A-HJKMNP-Z]{4}){4}$/;
const shownCode = () => page.$$eval('.rc-code span', (els) => els.map((e) => e.textContent?.trim() ?? '').join('-'));
await clickText('.rail .nav-btn', 'الإعدادات');
await page.waitForSelector('.recovery-card', { timeout: 3000 });
await sleep(200);
check('the settings show the recovery code card with its date', (await text('.recovery-card .s-row b')).includes('اتعمل'));
await clickText('.recovery-card button', 'اعمل كود جديد');
await page.waitForSelector('#rc-current', { timeout: 3000 });
await page.type('#rc-current', '1234');
await page.keyboard.press('Enter');
await page.waitForSelector('.rc-code', { timeout: 3000 });
const madeCode = await shownCode();
check('a new code is shown once, in five groups of four without 0/O/1/I/L', CODE_SHAPE.test(madeCode), madeCode);
const okLocked = await page.$eval('.modal-f .btn.primary', (b) => b.disabled);
await sleep(300); // the window fades in
await shot('13-recovery-code');
await page.click('.rc-check input');
const okFree = await page.$eval('.modal-f .btn.primary', (b) => !b.disabled);
check('«تمام» waits until the code is written down', okLocked && okFree);
await page.click('.modal-f .btn.primary');
await page.waitForSelector('.rc-code', { hidden: true, timeout: 3000 });

await page.keyboard.down('Control');
await page.keyboard.press('KeyL');
await page.keyboard.up('Control');
await page.waitForSelector('.lock.over');
await clickText('.lock.over .user-card', 'بيتر');
await page.waitForSelector('.lock.over .pinpad');
await clickText('.lock.over .link-btn', 'دخول بكلمة السر');
await page.waitForSelector('#login-pass');
await clickText('.lock.over .link-btn', 'نسيت كلمة السر؟');
await page.waitForSelector('#rc-code', { timeout: 3000 });
await page.type('#rc-code', '2222-3333-4444-5555-6666');
await page.type('#rc-pass', 'new password 9');
await page.type('#rc-again', 'new password 9');
await page.keyboard.press('Enter');
await sleep(250);
check('a wrong recovery code is refused', (await text('.modal .err-msg')).includes('الكود غلط'));
await shot('14-recover-wrong-code');
await page.$eval('#rc-code', (el) => {
  el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.type('#rc-code', madeCode.toLowerCase().replaceAll('-', ' '));
await page.keyboard.press('Enter');
await page.waitForSelector('.rc-code', { timeout: 3000 });
const nextCode = await shownCode();
check('the right code (typed loosely) sets a new password and shows the next code', CODE_SHAPE.test(nextCode) && nextCode !== madeCode, nextCode);
await page.click('.rc-check input');
await page.click('.modal-f .btn.primary');
await page.waitForSelector('.rc-code', { hidden: true, timeout: 3000 });
check('the card asks for the new password', (await text('.lock.over .ok-msg')).includes('اتغيّرت'));
await page.type('#login-pass', 'new password 9');
await page.keyboard.press('Enter');
await page.waitForSelector('.lock.over', { hidden: true, timeout: 3000 }).catch(() => {});
check('the new password signs the owner in', (await count('.lock.over')) === 0 && (await chipName()).includes('بيتر'));

// --- In-App System Guide (دليل السيستم الشامل) ----------------------------
await page.click('[data-open-system-guide]');
await page.waitForSelector('[data-guide-screen]', { timeout: 3000 });
await sleep(250);
const guideText = await text('[data-guide-screen]');
check(
  'In-App System Guide («دليل السيستم الشامل») opens with shortcuts and all feature topics',
  guideText.includes('دليل السيستم الشامل') &&
    guideText.includes('اختصارات الكيبورد السريعة') &&
    guideText.includes('فلوس الصيانة لوحدها') &&
    guideText.includes('فلوس السوفت وير لوحدها') &&
    guideText.includes('تثبيت وتشغيل السيستم على الكمبيوتر (Windows) والموبايل (Android)'),
  guideText.slice(0, 140),
);
await shot('64-system-guide');

// --- The device with no accounts at all (`?empty=1`) ------------------------------
// `ADR-039` deleted the first-run form, so this is the one state where the program can
// leave a person at the lock card with nobody to sign in as. It has to say something.
{
  const dead = await browser.newPage();
  await dead.setViewport({ width: 1366, height: 800 });
  await dead.goto(`${BASE}${BASE.includes('?') ? '&' : '?'}empty=1`, {
    waitUntil: 'networkidle0',
  });
  await sleep(400);
  const noteText = await dead
    .$$eval('.empty-device', (els) => els.map((el) => (el.textContent ?? '').trim()).join(' '))
    .then((v) => v.replace(/\s+/g, ' ').trim())
    .catch(() => '');
  check(
    'a device with no accounts says what to do instead of offering an empty picker',
    noteText.includes('مفيش على الجهاز ده أي حساب') &&
      noteText.includes('shop.db-wal') &&
      (await dead.$$('.user-card')).length === 0,
    noteText.slice(0, 80),
  );
  await dead.screenshot({ path: path.join(OUT, '65-lock-no-accounts.png') });
  await dead.close();
}

// --- `ADR-040`: two numbers of one company, each with its own money ---
await clickText('.rail .nav-btn', 'المحافظ');
await page.waitForSelector('[data-wal-card]', { timeout: 3000 });
await sleep(300);
const vfBalBefore = await text('[data-wal-balance="vf"]');
const walletCardsBefore = await count('[data-wal-card]');

await clickText('.rail .nav-btn', 'الإعدادات');
await page.waitForSelector('[data-card="shop-wallets"]', { timeout: 3000 });
await sleep(250);
await page.type('[data-wal-new-name]', 'فودافون كاش ٢');
await page.type('[data-wal-new-number]', '01009999999');
await page.type('[data-wal-new-company]', 'فودافون كاش');
await page.click('[data-wal-add-submit]');
await sleep(400);
check(
  'a second wallet number of the same company is created and filed under the company name',
  (await count('[data-wal-settings-row]')) === walletCardsBefore + 1 &&
    (await count('[data-wal-group]')) === 1 &&
    (await text('[data-wal-group]')).includes('فودافون كاش'),
  `rows=${await count('[data-wal-settings-row]')} header=${(await text('[data-wal-group]')).slice(0, 40)}`
);

// The second number is the second row of the group; link it to the method it sits under.
const paySelects = await page.$$('[data-wal-set-pay]');
if (paySelects[1]) await paySelects[1].select('vf');
await sleep(450);
const payValues = await page.$$eval('[data-wal-set-pay]', (els) =>
  els.map((el) => el.value)
);
check(
  'two numbers receive the same method — the first keeps it, so nothing moves by itself',
  payValues.filter((v) => v === 'vf').length === 2 &&
    (await count('[data-wal-settings-row]')) === walletCardsBefore + 1,
  payValues.join(',')
);
check(
  'a shared method says out loud where a sale lands until the cashier picks a number',
  (await count('[data-wal-shared-note]')) === 1 &&
    (await text('[data-wal-shared-note]')).includes('لحد ما الكاشير يختار')
);

await clickText('.rail .nav-btn', 'المحافظ');
await page.waitForSelector('[data-wal-card]', { timeout: 3000 });
await sleep(300);
check(
  'the wallets screen shows the new number and marks it with its company',
  (await count('[data-wal-card]')) === walletCardsBefore + 1 &&
    (await count('[data-wal-card-company]')) === 1 &&
    (await text('[data-wal-card-company]')).includes('فودافون كاش')
);
check(
  'linking a second number neither moves nor doubles the money of the first one',
  (await text('[data-wal-balance="vf"]')) === vfBalBefore && vfBalBefore.length > 0,
  `vf balance ${vfBalBefore}`
);
await shot('67-two-numbers-one-company');

// --- `ADR-041`: every flow that moves money names the number that took it ---
async function walletCards() {
  return page.$$eval('[data-wal-card]', (els) =>
    els.map((el) => ({
      id: el.getAttribute('data-wal-card') ?? '',
      balance: Number(
        (el.querySelector('[data-wal-balance]')?.textContent ?? '0').replace(/[^\d.-]/g, '')
      )
    }))
  );
}

const namedBefore = await walletCards();
const lastBefore = namedBefore[namedBefore.length - 1] || { id: '', balance: -1 };
const secondId = lastBefore.id;
const primaryBefore = (namedBefore.find((w) => w.id === 'vf') || { balance: -1 }).balance;
const secondBefore = lastBefore.balance;

await clickText('.rail .nav-btn', 'البيع');
await page.waitForSelector('.tile', { timeout: 3000 });
await sleep(150);
await clickText('.tiles .tile', 'كابل تايب سي 1 متر');
await sleep(120);
await page.keyboard.press('F12');
await page.waitForSelector('.methods', { timeout: 3000 });
await page.click('[data-method="vf"]');
await sleep(300);
check(
  'the till asks which of the two numbers took the money, and offers both',
  (await count('[data-wallet-choice]')) === 2,
  `choices=${await count('[data-wallet-choice]')}`
);
const numberButtons = await page.$$('[data-wallet-choice]');
if (numberButtons[1]) await numberButtons[1].click();
await sleep(200);
await shot('68a-pay-screen-names-the-number');
await page.click('#confirm-pay-btn');
await sleep(400);
await page.keyboard.press('Escape');
await sleep(250);

await clickText('.rail .nav-btn', 'المحافظ');
await page.waitForSelector('[data-wal-card]', { timeout: 3000 });
await sleep(300);
const namedAfter = await walletCards();
const primaryAfter = (namedAfter.find((w) => w.id === 'vf') || { balance: -1 }).balance;
const secondAfter = (namedAfter.find((w) => w.id === secondId) || { balance: -1 }).balance;
check(
  'the number named at the till is the one that grew; the other number of the company did not move',
  secondAfter > secondBefore && primaryAfter === primaryBefore,
  `picked ${secondBefore}→${secondAfter}, primary ${primaryBefore}→${primaryAfter}`
);

// The refund asks the same question, and stops asking it for cash.
await clickText('.rail .nav-btn', 'البيع');
await page.waitForSelector('[data-open-returns]', { timeout: 3000 });
await sleep(150);
await page.click('[data-open-returns]');
await page.waitForSelector('[data-return-modal]', { timeout: 3000 });
await sleep(250);
await page.click('[data-return-method="vf"]');
await sleep(250);
check(
  'the return modal names the number that pays the refund out',
  (await count('[data-wallet-choice]')) === 2,
  `choices=${await count('[data-wallet-choice]')}`
);
await page.click('[data-return-method="cash"]');
await sleep(250);
check(
  'a method no wallet holds is not offered a number',
  (await count('[data-wallet-choice]')) === 0
);
await page.keyboard.press('Escape');
await sleep(200);
await shot('68-money-names-its-wallet');

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
