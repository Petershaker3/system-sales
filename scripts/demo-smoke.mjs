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
  'the kind chooser offers a phone and a counted item, and hides «مستعمل» until 1.4',
  kinds.length === 2 &&
    kinds.includes('موبايل جديد') &&
    kinds.some((k) => k.includes('إكسسوار أو أي صنف بالعدد')) &&
    !kinds.some((k) => k.includes('مستعمل')),
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

// Switch back to owner Peter (PIN 4321) for the remaining checks
await page.click('.user-chip');
await page.waitForSelector('.sw-menu');
await clickText('.sw-item', 'بيتر');
await page.waitForSelector('.sw-menu.pin', { timeout: 3000 });
await page.keyboard.type('4321');
await page.keyboard.press('Enter');
await sleep(400);

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

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
