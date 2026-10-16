// Full QA for the UI mockup: ~70 behaviour checks + layout-overflow detection + screenshots in /tmp/shots.
// Needs the preview server (serve.py) on 127.0.0.1:4173 (or MOCKUP_URL). Run: node qa.mjs
import { launch, URL } from './launch.mjs';
import fs from 'node:fs';
const OUT = '/tmp/shots'; fs.mkdirSync(OUT, { recursive: true });
const b = await launch(); const p = await b.newPage();
const errs = [], fails = [], notes = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
const ok = (c, msg) => { if (!c) fails.push(msg); else notes.push('✔ ' + msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (n) => { await sleep(250); await p.screenshot({ path: `${OUT}/${n}.png` }); };
const lines = () => p.$$eval('.line', (e) => e.length);
const key = async (k, mods = []) => { for (const m of mods) await p.keyboard.down(m); await p.keyboard.press(k); for (const m of mods.reverse()) await p.keyboard.up(m); await sleep(120); };
const type = async (t) => { await p.keyboard.type(t, { delay: 15 }); await sleep(150); };
const clickText = async (sel, text) => {
  const ok2 = await p.evaluate((sel, text) => { const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(text)); if (el) { el.click(); return true; } return false; }, sel, text);
  await sleep(150); return ok2;
};
const overflow = () => p.evaluate(() => {
  const bad = [];
  document.querySelectorAll('.modal, .modal *, .cart-actions .btn, .tile, .topbar, .keys-bar, .card, .ticket, .phone *, .sw-menu *, .cat-row *, .chips .chip, .line *').forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.overflowX === 'auto' || cs.overflowX === 'scroll' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return;
    if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) bad.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} ${el.scrollWidth}>${el.clientWidth} "${el.textContent.trim().slice(0, 30)}"`);
  });
  return bad.slice(0, 8);
});
const checkOverflow = async (label) => { const o = await overflow(); if (o.length) fails.push(`overflow @${label}: ${o.join(' | ')}`); };

await p.setViewport({ width: 1366, height: 768 });
await p.goto(URL, { waitUntil: 'networkidle0' });
await p.evaluate(() => localStorage.clear()); await p.reload({ waitUntil: 'networkidle0' });
await shot('01-pos-empty');

// 1) بحث بالتعريب: ردمي -> الموبايل يتضاف على طول (IMEI اختياري) -> تسجيل IMEI من السطر
await p.focus('#q'); await type('ردمي');
ok((await p.$$eval('.result', (e) => e.length)) >= 2, 'search "ردمي" finds Redmi products');
await key('Enter');
ok(await p.evaluate(() => !document.querySelector('.modal') && cur().lines.length === 1 && !cur().lines[0].imei && !!document.querySelector('.line .imei-add')), 'phone added directly — IMEI optional («سجّل IMEI» on the line)');
await p.evaluate(() => document.querySelector('.line .imei-add').click()); await sleep(150);
ok(await p.$('.modal[aria-label="تسجيل IMEI"]'), 'line button opens the IMEI dialog');
await shot('02-imei-picker');
await checkOverflow('imei');
await key('Enter');
ok(await p.evaluate(() => cur().lines.length === 1 && !!cur().lines[0].imei), 'IMEI attached to the phone line');
// 2) إكسسوار بحروف مختلفة + زيادة كمية
await type('اسكرينه'); await key('Enter');
ok((await lines()) === 2, 'accessory added via normalized search (ة/ه)');
await key('+'); await key('+');
ok(await p.evaluate(() => document.querySelector('.line.sel .qty span').textContent.trim() === '3'), '+ key raises qty to 3');
await key('-');
// 3) آخر 4 أرقام IMEI
const last4 = await p.evaluate(() => DATA.units.find((u) => u.pid === 'p1' && u.status === 'in').imei.slice(-4));
await type(last4);
ok(await p.evaluate(() => !!document.querySelector('.result .tag.accent')), 'last-4 IMEI digits find the exact unit');
await key('Enter');
ok((await lines()) === 3, 'unit added from IMEI digits');
// 4) أرقام عربية
await type('١٢٨');
ok((await p.$$eval('.result', (e) => e.length)) > 0, 'Arabic-Indic digits search works');
await key('Escape');
// 5) IMEI غلط (Luhn)
await type('123456789012345'); await key('Enter');
ok(await p.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('مش IMEI صحيح'))), 'invalid IMEI (Luhn) is rejected with message');
await key('Escape');
await shot('03-pos-cart-light');
await checkOverflow('pos-cart');
// 6) خصم كمالك (من غير PIN)
await key('F3'); await type('10');
ok(!(await p.$('#disc-pin')), 'owner discount needs no PIN');
await shot('04-discount-owner');
await key('Enter');
ok(await p.evaluate(() => !!document.querySelector('.totals .disc')), 'discount row shown');
// 7) عميل
await key('F4'); await type('مينا'); await shot('05-customer'); await key('Enter');
ok(await p.evaluate(() => document.querySelector('.cust-row b').textContent.includes('مينا')), 'customer picked by name');
// 8) تعليق والرجوع
await key('F8');
ok(await p.evaluate(() => document.querySelectorAll('.inv-tab').length === 3 && document.querySelectorAll('.line').length === 0), 'F8 holds invoice and opens a new one');
await p.evaluate(() => document.querySelectorAll('.inv-tab')[0].click()); await sleep(150);
ok((await lines()) === 3, 'switch back to held invoice');
// 9) دفع كاش بمبلغ أكبر -> باقي -> تم -> فاتورة جديدة
await key('F12');
ok(await p.$('.modal[aria-label="الدفع"]'), 'F12 opens pay modal');
await type('30000');
ok(await p.evaluate(() => !!document.querySelector('.change-box') && !document.querySelector('.change-box.short')), 'change box shows change');
await shot('06-pay');
await checkOverflow('pay');
await key('Enter');
ok(await p.$('.modal[aria-label="تم البيع"]'), 'Enter confirms → done screen');
await shot('07-done-receipt');
await checkOverflow('done');
await key('Enter');
ok((await lines()) === 0 && !(await p.$('.modal')), 'Enter on done → fresh invoice');
// 10) دفع مقسّم: فودافون كاش جزئي + كاش
await p.evaluate(() => document.querySelector('.tile[data-id="a9"]').click()); await sleep(120);
await p.evaluate(() => document.querySelector('.tile[data-id="a4"]').click()); await sleep(120);
await key('F12');
await clickText('.method', 'فودافون كاش'); await type('500');
await clickText('.btn', 'دفع جزئي');
ok(await p.evaluate(() => document.querySelectorAll('.paid-item').length === 1), 'partial payment recorded');
await shot('08-split');
await key('Enter');
ok(await p.$('.modal[aria-label="تم البيع"]'), 'split payment completes');
await key('Enter');
// 11) آجل من غير عميل
await p.evaluate(() => document.querySelector('.tile[data-id="a6"]').click()); await sleep(120);
await key('F12'); await clickText('.method', 'آجل'); await key('Enter');
ok(await p.evaluate(() => document.querySelector('.err-msg').textContent.includes('عميل')), 'credit (آجل) requires a customer');
await key('Escape');
// 12) كاش بالظبط
await clickText('.btn', 'كاش بالظبط');
ok(await p.$('.modal[aria-label="تم البيع"]'), 'exact-cash completes instantly');
await key('Escape');
// 13) خدمات
await key('F9');
ok(await p.$('.modal[aria-label="خدمات سريعة"]'), 'F9 opens services');
await type('1000');
ok(await p.evaluate(() => document.querySelector('.due-box b').textContent.includes('10')), 'wallet fee 1% = 10');
await p.focus('#svc-ph'); await type('01012345678'); await shot('09-services-wallet'); await key('Enter');
ok(await p.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('1,010'))), 'wallet transfer recorded (collect 1,010)');
await checkOverflow('services-wallet');
await clickText('.seg button', 'كروت شحن'); await clickText('.btn', 'كارت 50');
await shot('10-services-cards');
await checkOverflow('services-cards');
await clickText('.seg button', 'فواتير'); await type('450'); await key('Enter');
ok(await p.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('455'))), 'bill recorded with 5 fee');
await checkOverflow('services-bills');
await key('Escape');
ok((await lines()) === 1, 'recharge card added to invoice');
// 14) F2 كمية (سطر الكارت = 1) + سطر إكسسوار
await p.evaluate(() => document.querySelector('.tile[data-id="a1"]').click()); await sleep(120);
await key('F2'); await type('4'); await key('Enter');
ok(await p.evaluate(() => document.querySelector('.line.sel .qty span').textContent.trim() === '4'), 'F2 sets quantity');
// 15) قفل -> بيّاع
await key('l', ['Control']);
ok(await p.$('.lock'), 'Ctrl+L locks');
await shot('11-lock');
await p.keyboard.press('2'); await sleep(150);
await type('9999');
ok(await p.evaluate(() => document.querySelector('.err-msg').textContent.includes('غلط')), 'wrong PIN rejected');
await type('2222');
ok(await p.evaluate(() => S.user.name === 'يوسف' && !document.querySelector('.lock')), 'seller unlock with PIN 2222');
ok(await p.evaluate(() => !!document.querySelector('.nav-btn[data-v="dashboard"] .lock-badge')), 'reports locked for seller');
ok(await p.evaluate(() => !document.querySelector('.totals .profit')), 'seller does not see profit');
await key('F3'); await type('10');
ok(await p.$('#disc-pin'), 'seller discount >5% asks owner PIN');
await shot('12-discount-seller-pin');
await p.focus('#disc-pin'); await type('1111');
ok(await p.evaluate(() => document.querySelector('.totals .disc') && document.querySelector('.totals .disc').textContent.includes('المالك')), 'owner PIN approves discount');
await p.evaluate(() => document.querySelector('.nav-btn[data-v="settings"]').click()); await sleep(150);
ok(await p.evaluate(() => S.view === 'pos'), 'seller cannot open settings');
// رجوع للمالك
await key('l', ['Control']); await p.keyboard.press('1'); await sleep(100); await type('1111');
// 15b) تبديل سريع من فوق: تأشير ← باقي البياعين ← الرقم السري
const nL = await lines();
await p.hover('.user-chip'); await sleep(400);
ok(await p.evaluate(() => document.querySelectorAll('.sw-menu .sw-item[data-act="swPick"]').length === 2), 'hover on the user shows the other sellers');
await shot('12b-switch-menu');
await checkOverflow('switch-menu');
await p.evaluate(() => document.querySelector('.sw-item[data-act="swPick"][data-id="u3"]').click()); await sleep(150);
await type('1234');
ok(await p.evaluate(() => S.user.id === 'u1' && document.querySelector('.sw-menu .err-msg').textContent.includes('غلط')), 'quick switch: wrong PIN rejected');
await shot('12c-switch-pin');
await checkOverflow('switch-pin');
await type('3333');
ok(await p.evaluate((n) => S.user.id === 'u3' && document.querySelectorAll('.line').length === n && !document.querySelector('.sw-menu') && document.querySelector('#q').value === '', nL), 'quick switch to مارينا with PIN keeps the open invoice');
await p.evaluate(() => document.querySelector('.user-chip').click()); await sleep(120);
await p.evaluate(() => document.querySelector('.sw-item[data-act="swPick"][data-id="u1"]').click()); await sleep(120);
await type('1111');
ok(await p.evaluate(() => S.user.id === 'u1'), 'quick switch back to the owner');
// 16) الصيانة
await p.evaluate(() => document.querySelector('.nav-btn[data-v="repairs"]').click()); await sleep(200);
await shot('13-repairs');
await checkOverflow('repairs');
await clickText('.btn', 'استلام جهاز جديد');
await type('01012345678');
ok(await p.evaluate(() => document.querySelector('#in-name').value.includes('محمد')), 'intake auto-fills known customer');
await p.focus('#in-device'); await type('Samsung A32');
await clickText('.chip', 'شاشة');
await shot('14-intake');
await checkOverflow('intake');
await key('Enter');
ok(await p.evaluate(() => S.repairs[0].no === 'R-1053'), 'intake saved as R-1053');
await clickText('.btn', 'سلّم وحصّل');
ok(await p.evaluate(() => S.view === 'pos' && cur().lines.some((l) => l.repairNo)), 'deliver adds repair to invoice');
// 17) المخزون
await p.evaluate(() => document.querySelector('.nav-btn[data-v="inventory"]').click()); await sleep(200);
await p.evaluate(() => document.querySelector('[data-act="invOpen"]').click()); await sleep(150);
ok(await p.evaluate(() => document.querySelectorAll('tr.sub').length > 1), 'inventory expands IMEI units');
await shot('15-inventory');
await checkOverflow('inventory');
// 17b) صور الأصناف (اختياري): رفع صورة ← بتتصغّر ← تظهر في المخزون
const b64 = await p.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 640; c.height = 420; const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 640, 420); gr.addColorStop(0, '#dbeafe'); gr.addColorStop(1, '#93c5fd'); g.fillStyle = gr; g.fillRect(0, 0, 640, 420);
  g.fillStyle = '#1e3a8a'; g.beginPath(); g.roundRect(230, 50, 180, 320, 34); g.fill(); g.fillStyle = '#e0f2fe'; g.beginPath(); g.roundRect(246, 70, 148, 280, 24); g.fill();
  return c.toDataURL('image/png').split(',')[1];
});
fs.writeFileSync('/tmp/qa-img.png', Buffer.from(b64, 'base64'));
await p.evaluate(() => { S._imgFor = 'a1'; });
await (await p.$('#img-file')).uploadFile('/tmp/qa-img.png'); await sleep(700);
ok(await p.evaluate(() => typeof IMGS.a1 === 'string' && IMGS.a1.startsWith('data:image/jpeg') && IMGS.a1.length < 60000 && !!document.querySelector('[data-act="imgPick"][data-id="a1"].has img')), 'product image uploaded, shrunk (<45KB) and shown in inventory');
// 18) التقارير
await p.evaluate(() => document.querySelector('.nav-btn[data-v="dashboard"]').click()); await sleep(200);
await shot('16-dashboard-light');
await checkOverflow('dashboard');
// 19) الموبايل: مسح -> الفاتورة
await p.evaluate(() => document.querySelector('.nav-btn[data-v="mobile"]').click()); await sleep(200);
const before = await p.evaluate(() => cur().lines.length);
await clickText('.btn', 'امسح علبة موبايل');
ok(await p.evaluate((n) => cur().lines.length === n + 1, before), 'mobile scan adds to desktop invoice');
await clickText('.btn', 'امسح الجهاز اللي بعده');
ok(await p.evaluate(() => document.querySelector('.phone .ph-head b').textContent.includes('مبيعات النهارده') && document.querySelectorAll('.ph-sale.fresh').length >= 1), "phone shows today's sales incl. the new invoices");
ok(await p.evaluate(() => { const no = String(S.sales[S.sales.length - 1].no); return document.querySelector('.ph-sale').textContent.includes(no); }), 'latest desktop invoice is first on the phone');
await shot('17-mobile');
await checkOverflow('mobile');
const p5s = await p.evaluate(() => prod('p5').stock);
await clickText('.ph-seg button', 'بالعدد');
await p.evaluate(() => document.querySelector('[data-act="mRecvQty"][data-d="1"]').click()); await sleep(100);
await p.evaluate(() => document.querySelector('[data-act="mRecvSaveQty"]').click()); await sleep(150);
ok(await p.evaluate((x) => prod('p5').stock === x + 2, p5s), 'receive by quantity (no IMEI) adds stock');
await clickText('.ph-seg button', 'بالـ IMEI');
await p.evaluate(() => document.querySelector('.user-chip').click()); await sleep(120);
await p.evaluate(() => document.querySelector('.sw-item[data-act="swPick"][data-id="u2"]').click()); await sleep(120);
await type('2222');
ok(await p.evaluate(() => document.querySelector('.phone .ph-head b').textContent.includes('مبيعاتك') && ![...document.querySelectorAll('.ph-sale')].some((e) => e.textContent.includes('مارينا'))), 'seller sees only own sales on the phone');
await p.evaluate(() => document.querySelector('.user-chip').click()); await sleep(120);
await p.evaluate(() => document.querySelector('.sw-item[data-act="swPick"][data-id="u1"]').click()); await sleep(120);
await type('1111');
// 19c) التصنيفات في شاشة البيع
await p.evaluate(() => document.querySelector('.nav-btn[data-v="pos"]').click()); await sleep(150);
ok(await p.evaluate(() => new Set([...document.querySelectorAll('.chips.cats .chip')].map((c) => Math.round(c.getBoundingClientRect().top))).size === 1), 'main categories fit one row at 1366');
await clickText('.chips.cats .chip', 'إكسسوارات');
ok(await p.evaluate(() => document.querySelectorAll('.tile').length === 19 && document.querySelectorAll('.chips.subcats .chip').length === 7), 'accessories main category: 19 items + 7 sub-categories');
ok(await p.evaluate(() => new Set([...document.querySelectorAll('.chips.subcats .chip')].map((c) => Math.round(c.getBoundingClientRect().top))).size === 1), 'sub-categories fit one row at 1366');
ok(await p.evaluate(() => !!document.querySelector('.tile[data-id="a1"] .ico.img img')), 'product image shows on the sales tile');
await clickText('.chips.subcats .chip', 'سماعات');
ok(await p.evaluate(() => document.querySelectorAll('.tile').length === 4), 'sub-category filter (سماعات = 4)');
await shot('17b-pos-categories');
await checkOverflow('pos-categories');
await p.focus('#q'); await type('اكسسوار');
ok(await p.evaluate(() => document.querySelectorAll('.result').length >= 5), 'search «اكسسوار» finds accessories by category');
await key('Escape');
// 19d) جهاز اتسلّم من غير IMEI: الـ IMEI يتكتب وقت البيع
await clickText('.chips.cats .chip', 'موبايلات جديدة');
await p.evaluate(() => document.querySelector('.tile[data-id="p11"]').click()); await sleep(120);
await p.evaluate(() => document.querySelector('.line.sel .imei-add').click()); await sleep(150);
const newIm = await p.evaluate(() => DATA.makeImei(prod('p11').tac));
await type(newIm);
ok(await p.$('.result.new-imei'), 'unregistered phone: typed IMEI offered for registration');
await shot('17c-imei-new');
await checkOverflow('imei-new');
await key('Enter');
ok(await p.evaluate((x) => cur().lines.some((l) => l.imei === x) && DATA.units.some((u) => u.imei === x), newIm), 'new IMEI registered at sale');
const stk = await p.evaluate(() => ({ p11: prod('p11').stock, p9: prod('p9').stock }));
await p.evaluate(() => document.querySelector('.tile[data-id="p9"]').click()); await sleep(120);
await clickText('.btn', 'كاش بالظبط'); await key('Escape');
ok(await p.evaluate((x) => prod('p11').stock === x.p11 - 1 && prod('p9').stock === x.p9 - 1 && unitsIn('p9').length <= prod('p9').stock, stk), 'sale reduces phone stock with or without IMEI');
// 20) الإعدادات
await p.evaluate(() => document.querySelector('.nav-btn[data-v="settings"]').click()); await sleep(200);
await shot('18-settings-shop');
for (const tab of ['look', 'catalog', 'users', 'pay', 'receipt', 'backup', 'devices']) {
  await p.evaluate((t) => document.querySelector(`.s-nav [data-id="${t}"]`).click(), tab); await sleep(150);
  await checkOverflow('settings-' + tab);
  if (tab === 'look' || tab === 'receipt' || tab === 'devices' || tab === 'catalog') await shot('19-settings-' + tab);
}
await p.evaluate(() => document.querySelector('.s-nav [data-id="catalog"]').click()); await sleep(120);
await clickText('.seg button', 'إجباري');
await p.evaluate(() => document.querySelector('.nav-btn[data-v="pos"]').click()); await sleep(150);
await clickText('.chips.cats .chip', 'موبايلات جديدة');
await p.evaluate(() => document.querySelector('.tile[data-id="p2"]').click()); await sleep(150);
ok(await p.$('.modal[aria-label="اختيار الجهاز"]'), 'IMEI required mode: phone tile opens the picker');
await key('Escape');
await p.evaluate(() => document.querySelector('.nav-btn[data-v="settings"]').click()); await sleep(150);
await p.evaluate(() => document.querySelector('.s-nav [data-id="catalog"]').click()); await sleep(120);
await clickText('.seg button', 'اختياري');
await p.focus('#cat-new'); await type('خطوط');
await p.evaluate(() => document.querySelector('[data-act="catIcon"][data-ic="signal"]').click()); await sleep(100);
await p.evaluate(() => document.querySelector('[data-act="catAdd"]').click()); await sleep(150);
await p.evaluate(() => document.querySelector('input[data-change="catShow"][data-id="smart"]').click()); await sleep(150);
await p.evaluate(() => document.querySelector('[data-act="catMove"][data-id="acc"][data-d="-1"]').click()); await sleep(150);
await shot('19-settings-catalog-edited');
await checkOverflow('settings-catalog-edited');
await p.evaluate(() => document.querySelector('.nav-btn[data-v="pos"]').click()); await sleep(150);
ok(await p.evaluate(() => { const t = [...document.querySelectorAll('.chips.cats .chip')].map((c) => c.textContent); return t.some((x) => x.includes('خطوط')) && !t.some((x) => x.includes('ساعات')) && t.findIndex((x) => x.includes('إكسسوارات')) < t.findIndex((x) => x.includes('مستعمل')); }), 'category add / hide / reorder reflected on the sales screen');
await p.evaluate(() => document.querySelector('.nav-btn[data-v="settings"]').click()); await sleep(150);
await p.evaluate(() => document.querySelector('input[data-change="showImages"]').click()); await sleep(150);
await p.evaluate(() => document.querySelector('.nav-btn[data-v="pos"]').click()); await sleep(150);
ok(await p.evaluate(() => !document.querySelector('.tile .ico.img') && !!IMGS.a1), 'product images can be turned off from settings (image kept)');
await p.evaluate(() => document.querySelector('.nav-btn[data-v="settings"]').click()); await sleep(150);
await p.evaluate(() => document.querySelector('input[data-change="showImages"]').click()); await sleep(150);
await p.evaluate(() => document.querySelector('.s-nav [data-id="look"]').click()); await sleep(100);
await p.evaluate(() => document.querySelector('.swatch[data-c="#0d9488"]').click()); await sleep(100);
ok(await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#0d9488'), 'accent swatch applies');
await p.evaluate(() => document.querySelector('[data-act="setFont"][data-id="cairo"]').click()); await sleep(100);
ok(await p.evaluate(() => document.documentElement.dataset.font === 'cairo' && document.fonts.check('16px Cairo', 'أ')), 'font switch applies (Cairo loaded)');
await p.evaluate(() => document.querySelector('[data-act="setDigits"][data-id="arabic"]').click()); await sleep(100);
ok(await p.evaluate(() => /[٠-٩]/.test(document.querySelector('.font-card .fs').textContent)), 'Arabic-Indic digits option applies');
await p.evaluate(() => document.querySelector('.s-nav [data-id="shop"]').click()); await sleep(100);
await p.focus('#set-shopName'); await p.evaluate(() => { const i = document.querySelector('#set-shopName'); i.select(); }); await type('بيتر موبايل');
ok(await p.evaluate(() => document.querySelector('.rc-name').textContent === 'بيتر موبايل' && JSON.parse(localStorage.getItem('mshop.mockup.settings.v1')).shopName === 'بيتر موبايل'), 'shop name updates receipt and persists');
await p.reload({ waitUntil: 'networkidle0' });
ok(await p.evaluate(() => SET.shopName === 'بيتر موبايل' && SET.digits === 'arabic' && SET.accent === '#0d9488'), 'settings survive reload');
ok(await p.evaluate(() => SET.cats.some((c) => c.name === 'خطوط' && c.custom) && catById('smart').hidden && !!IMGS.a1), 'category settings and product images survive reload');
await shot('20-pos-custom-settings');
// 21) الوضع الغامق
await p.evaluate(() => { ACT.resetSettings(); }); await sleep(100);
await p.evaluate(() => document.querySelector('[data-act="toggleTheme"]').click()); await sleep(150);
ok(await p.evaluate(() => document.documentElement.dataset.theme === 'dark'), 'dark theme toggle');
await p.evaluate(() => { const pick = (id) => document.querySelector(`.tile[data-id="${id}"]`).click(); pick('a2'); pick('a1'); }); await sleep(150);
await p.focus('#q'); await type('a16'); await key('Enter');
await shot('21-pos-dark');
await checkOverflow('pos-dark');
await key('F12'); await shot('22-pay-dark'); await key('Escape');
await key('F9'); await shot('23-services-dark'); await key('Escape');
await p.evaluate(() => document.querySelector('[data-act="shiftClose"]').click()); await sleep(150);
for (const [i, v] of [[0, '40'], [1, '35'], [2, '10'], [3, '20'], [4, '10']]) { await p.focus(`#den-${i}`); await type(v); }
ok(await p.evaluate(() => !!document.querySelector('.change-box')), 'shift close shows difference');
await shot('24-shift-dark');
await checkOverflow('shift');
await key('Escape');
await p.evaluate(() => document.querySelector('.nav-btn[data-v="dashboard"]').click()); await sleep(200);
await shot('25-dashboard-dark');
await p.evaluate(() => document.querySelector('.nav-btn[data-v="repairs"]').click()); await sleep(200);
await shot('26-repairs-dark');
await p.evaluate(() => document.querySelector('.nav-btn[data-v="mobile"]').click()); await sleep(200);
await shot('27-mobile-dark');
// 22) شاشة كبيرة 1920
await p.evaluate(() => document.querySelector('[data-act="toggleTheme"]').click());
await p.evaluate(() => document.querySelector('.nav-btn[data-v="pos"]').click());
await p.setViewport({ width: 1920, height: 1080 }); await sleep(300);
await shot('28-pos-1920');
await checkOverflow('pos-1920');
// 23) حجم كبير
await p.evaluate(() => { SET.scale = 'large'; applySettings(); render(); }); await sleep(200);
await p.setViewport({ width: 1366, height: 768 }); await sleep(200);
await shot('29-pos-large-1366');
await checkOverflow('pos-large');
await p.evaluate(() => ACT.resetSettings());

console.log(notes.join('\n'));
console.log(`\nPASSED: ${notes.length}`);
console.log('FAILS:', fails.length ? '\n' + fails.join('\n') : 'none');
console.log('ERRORS:', errs.length ? '\n' + errs.join('\n') : 'none');
await b.close();
