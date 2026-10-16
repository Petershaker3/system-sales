// Full QA for the UI mockup: ~90 behaviour checks + layout-overflow detection + screenshots in /tmp/shots.
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
// 8) انتظار والرجوع (الكلمة «انتظار» بدل «تعليق» — قرار المالك 2026-10-16)
await key('F8');
ok(await p.evaluate(() => document.querySelectorAll('.inv-tab').length === 3 && document.querySelectorAll('.line').length === 0), 'F8 holds invoice and opens a new one');
ok(await p.evaluate(() => !document.body.textContent.includes('تعليق') && document.querySelector('[data-act="hold"]').textContent.includes('انتظار') && document.querySelector('.keys-bar').textContent.includes('انتظار')), 'hold is worded «انتظار» (no «تعليق» anywhere)');
await p.evaluate(() => document.querySelectorAll('.inv-tab')[0].click()); await sleep(150);
ok((await lines()) === 3, 'switch back to held invoice');
// 9) دفع كاش بمبلغ أكبر -> باقي -> تم -> فاتورة جديدة
await key('F12');
ok(await p.$('.modal[aria-label="الدفع"]'), 'F12 opens pay modal');
ok(await p.evaluate(() => { const b = [...document.querySelectorAll('[data-act="payRMode"]')]; const on = b.find((x) => x.classList.contains('on')); return b.map((x) => x.textContent.trim()).join('|') === 'واتساب|بدون' && on && on.dataset.id === 'wa' && document.querySelector('#pay-wa').value === '01287654321'; }), 'no printer: receipt is WhatsApp/none — customer sale defaults to WhatsApp on his number');
ok(await p.evaluate(() => document.querySelector('.topbar').textContent.includes('الإيصال: واتساب') && !document.querySelector('.topbar').textContent.includes('الطابعة')), 'top bar shows WhatsApp receipt instead of printer');
await type('30000');
ok(await p.evaluate(() => !!document.querySelector('.change-box') && !document.querySelector('.change-box.short')), 'change box shows change');
await shot('06-pay');
await checkOverflow('pay');
await key('Enter');
ok(await p.$('.modal[aria-label="تم البيع"]'), 'Enter confirms → done screen');
ok(await p.evaluate(() => !document.querySelector('[data-act="reprint"]') && S.modal.sale.receiptMode === 'wa' && [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('اتبعت الإيصال على واتساب 01287654321'))), 'receipt sent on WhatsApp (no reprint button without a printer)');
await shot('07-done-receipt');
await checkOverflow('done');
await key('Enter');
ok((await lines()) === 0 && !(await p.$('.modal')), 'Enter on done → fresh invoice');
// 10) دفع مقسّم: فودافون كاش جزئي + كاش
await p.evaluate(() => document.querySelector('.tile[data-id="a9"]').click()); await sleep(120);
await p.evaluate(() => document.querySelector('.tile[data-id="a4"]').click()); await sleep(120);
await key('F12');
ok(await p.evaluate(() => document.querySelector('[data-act="payRMode"].on').dataset.id === 'none' && !document.querySelector('#pay-wa')), 'walk-in sale defaults to no receipt (no number demanded)');
await clickText('.method', 'فودافون كاش'); await type('500');
await clickText('.btn', 'دفع جزئي');
ok(await p.evaluate(() => document.querySelectorAll('.paid-item').length === 1), 'partial payment recorded');
await shot('08-split');
await key('Enter');
ok(await p.$('.modal[aria-label="تم البيع"]'), 'split payment completes');
await clickText('.btn', 'ابعت الإيصال واتساب');
ok(await p.evaluate(() => document.activeElement && document.activeElement.id === 'done-wa'), 'done screen: WhatsApp asks for a number when there is no customer');
await type('0101234'); await key('Enter');
ok(await p.evaluate(() => document.querySelector('.err-msg').textContent.includes('11 رقم') && S.modal.step === 'done'), 'short WhatsApp number refused');
await type('5678');
ok(await p.evaluate(() => document.querySelector('.err-msg').textContent.trim() === '' && document.querySelector('#done-wa').value === '01012345678' && document.activeElement.id === 'done-wa'), 'error clears as soon as the number is corrected (cursor kept)');
await shot('08b-done-wa'); await key('Enter');
ok(await p.evaluate(() => S.modal && S.modal.step === 'done' && S.modal.sale.wa === '01012345678' && [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('01012345678'))), 'receipt sent to the typed number after payment');
await checkOverflow('done-wa');
await key('Enter');
ok((await lines()) === 0 && !(await p.$('.modal')), 'Enter after sending → fresh invoice');
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
ok(await p.evaluate(() => document.querySelector('#svc-fee').value === '' && document.querySelector('.due-box .grand').textContent.includes('اكتب العمولة')), 'commission is typed per transaction (empty by default)');
await p.focus('#svc-ph'); await type('01012345678'); await key('Enter');
ok(await p.evaluate(() => document.querySelector('.err-msg').textContent.includes('العمولة') && document.activeElement.id === 'svc-fee' && !S.services.length), 'missing commission refused → cursor jumps to it');
await type('15'); await shot('09-services-wallet');
ok(await p.evaluate(() => document.querySelector('.due-box .grand').textContent.includes('1,015')), 'typed commission updates the total (1,015)');
await key('Enter');
ok(await p.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('1,015')) && S.services.at(-1).fee === 15), 'wallet transfer recorded with the typed commission');
await checkOverflow('services-wallet');
await clickText('.seg button', 'كروت شحن'); await clickText('.btn', 'كارت 50');
await shot('10-services-cards');
await checkOverflow('services-cards');
await clickText('.seg button', 'فواتير'); await type('450'); await p.focus('#bill-fee'); await type('5'); await key('Enter');
ok(await p.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('455')) && S.services.at(-1).fee === 5), 'bill recorded with the typed fee (5)');
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
await clickText('.btn', 'كاش بالظبط'); await p.waitForSelector('.modal[aria-label="تم البيع"]', { timeout: 3000 }); await key('Escape');
ok(await p.evaluate((x) => prod('p11').stock === x.p11 - 1 && prod('p9').stock === x.p9 - 1 && unitsIn('p9').length <= prod('p9').stock, stk), 'sale reduces phone stock with or without IMEI');
// 20) الإعدادات
await p.evaluate(() => document.querySelector('.nav-btn[data-v="settings"]').click()); await sleep(200);
await shot('18-settings-shop');
for (const tab of ['look', 'catalog', 'users', 'pay', 'receipt', 'backup', 'devices']) {
  await p.evaluate((t) => document.querySelector(`.s-nav [data-id="${t}"]`).click(), tab); await sleep(150);
  await checkOverflow('settings-' + tab);
  if (tab === 'look' || tab === 'receipt' || tab === 'devices' || tab === 'catalog' || tab === 'pay') await shot('19-settings-' + tab);
}
ok(await p.evaluate(() => document.querySelector('input[data-change="printer"]') && !document.querySelector('input[data-change="printer"]').checked && document.body.textContent.includes('مفيش طابعة دلوقتي')), 'devices: no printer by default — receipt on WhatsApp');
await p.evaluate(() => document.querySelector('.s-nav [data-id="pay"]').click()); await sleep(120);
ok(await p.evaluate(() => !document.querySelector('#set-feePct') && document.querySelector('[data-act="setFeeMode"].on').dataset.id === 'manual'), 'settings: commission typed per transaction by default (no fixed rate)');
await clickText('[data-act="setFeeMode"]', 'محسوبة تلقائي');
ok(await p.$('#set-feePct'), 'auto commission shows the rate fields');
await shot('19-settings-pay-auto');
await checkOverflow('settings-pay-auto');
await p.evaluate(() => document.querySelector('.nav-btn[data-v="pos"]').click()); await sleep(150);
await key('F9'); await type('1000');
ok(await p.evaluate(() => document.querySelector('#svc-fee').value === '10'), 'auto mode pre-fills the commission (1% = 10)');
await p.focus('#svc-fee'); await p.evaluate(() => document.querySelector('#svc-fee').select()); await type('12');
ok(await p.evaluate(() => document.querySelector('.due-box .grand').textContent.includes('1,012')), 'auto commission stays editable (1,012)');
await key('Escape');
await p.evaluate(() => document.querySelector('.nav-btn[data-v="settings"]').click()); await sleep(150);
await p.evaluate(() => document.querySelector('.s-nav [data-id="pay"]').click()); await sleep(120);
await clickText('[data-act="setFeeMode"]', 'تتكتب في كل عملية');
await p.evaluate(() => document.querySelector('.s-nav [data-id="devices"]').click()); await sleep(120);
await p.evaluate(() => document.querySelector('input[data-change="printer"]').click()); await sleep(150);
ok(await p.evaluate(() => document.querySelector('.topbar').textContent.includes('الطابعة جاهزة') && receiptOpts().length === 4 && !!document.querySelector('[data-act="testPrint"]')), 'printer switch (optional) brings back print options');
await p.evaluate(() => document.querySelector('.s-nav [data-id="receipt"]').click()); await sleep(120);
ok(await p.evaluate(() => !!document.querySelector('[data-act="setPaper"]') && document.querySelectorAll('[data-act="setRMode"]').length === 4), 'with a printer: paper size + 4 receipt choices');
await p.evaluate(() => document.querySelector('.s-nav [data-id="devices"]').click()); await sleep(120);
await p.evaluate(() => document.querySelector('input[data-change="printer"]').click()); await sleep(150);
await p.evaluate(() => document.querySelector('.s-nav [data-id="receipt"]').click()); await sleep(120);
ok(await p.evaluate(() => document.querySelector('.topbar').textContent.includes('الإيصال: واتساب') && !document.querySelector('[data-act="setPaper"]') && [...document.querySelectorAll('[data-act="setRMode"]')].map((b) => b.textContent.trim()).join('|') === 'واتساب|بدون' && SET.feeMode === 'manual'), 'printer off → WhatsApp only, no paper size');
ok(await p.evaluate(() => !!document.querySelector('#set-footer') && !!document.querySelector('#set-warrantyNew') && !!document.querySelector('#set-warrantyUsed')), 'warranty months and receipt footer are set from settings');
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
ok(await p.evaluate(() => document.documentElement.dataset.look === 'plate' && getComputedStyle(document.body).fontFamily.includes('Changa') && document.fonts.check('16px Changa', 'أ')), 'default look is «لافتة الشارع» with its own font (Changa loaded)');
await p.evaluate(() => document.querySelector('.look-card[data-id="box"]').click()); await sleep(150);
ok(await p.evaluate(() => document.documentElement.dataset.look === 'box' && getComputedStyle(document.body).fontFamily.includes('Vazirmatn') && document.fonts.check('16px Vazirmatn', 'أ') && JSON.parse(localStorage.getItem('mshop.mockup.settings.v1')).look === 'box' && document.querySelector('.look-card[data-id="box"]').getAttribute('aria-pressed') === 'true'), 'look switches to «علبة الموبايل» (Vazirmatn loaded) and is saved');
await shot('19b-settings-look-box');
await checkOverflow('settings-look-box');
await p.evaluate(() => document.querySelector('.look-card[data-id="plate"]').click()); await sleep(150);
// أي لون يختاره المالك: الكلام عليه وبلونه ≥ 4.5:1 في الطابعين والوضعين (حساب مستقل عن app.js)
const cx = await p.evaluate(() => {
  const L = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const R = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const col = (v) => { const el = document.createElement('i'); el.style.color = `var(${v})`; document.body.appendChild(el); const c = getComputedStyle(el).color; el.remove();
    let m = /rgba?\(([\d.]+),?\s*([\d.]+),?\s*([\d.]+)/.exec(c); if (m) return [+m[1], +m[2], +m[3]];
    m = /color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)/.exec(c); return m ? [m[1] * 255, m[2] * 255, m[3] * 255] : [128, 128, 128]; };
  const bad = [], keep = { look: SET.look, theme: SET.theme, accent: SET.accent };
  for (const accent of ['#facc15', '#e5e7eb', '#111111', '#22d3ee', '#ff00ff', '#1d4f91']) for (const look of ['plate', 'box']) for (const theme of ['light', 'dark']) {
    Object.assign(SET, { accent, look, theme }); applySettings();
    const grounds = ['--bg', '--surface', '--surface-2', '--surface-3', '--accent-weak'].map(col), t = col('--accent-text');
    const acc = Math.min(...grounds.map((g) => R(t, g))), on = R(col('--on-accent'), col('--accent-fill'));
    const body = Math.min(R(col('--text'), col('--bg')), R(col('--text'), col('--surface-3')), R(col('--muted'), col('--surface-3')), R(col('--muted'), col('--bg')));
    if (acc < 4.5 || on < 4.5 || body < 4.5) bad.push(`${accent}/${look}/${theme}: accent-text ${acc.toFixed(2)} on-accent ${on.toFixed(2)} body ${body.toFixed(2)}`);
  }
  Object.assign(SET, keep); applySettings(); return bad;
});
ok(cx.length === 0, `text stays readable (≥4.5:1) with any shop colour in both looks and themes${cx.length ? ': ' + cx.join(' | ') : ''}`);
await p.evaluate(() => document.querySelector('.swatch[data-c="#0f6e5a"]').click()); await sleep(100);
ok(await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#0f6e5a'), 'accent swatch applies');
await p.evaluate(() => document.querySelector('[data-act="setFont"][data-id="cairo"]').click()); await sleep(100);
ok(await p.evaluate(() => document.documentElement.dataset.font === 'cairo' && document.fonts.check('16px Cairo', 'أ')), 'font switch applies (Cairo loaded)');
await p.evaluate(() => document.querySelector('[data-act="setDigits"][data-id="arabic"]').click()); await sleep(100);
ok(await p.evaluate(() => /[٠-٩]/.test(document.querySelector('.font-card .fs').textContent)), 'Arabic-Indic digits option applies');
await p.evaluate(() => document.querySelector('.s-nav [data-id="shop"]').click()); await sleep(100);
await p.focus('#set-shopName'); await p.evaluate(() => { const i = document.querySelector('#set-shopName'); i.select(); }); await type('بيتر موبايل');
ok(await p.evaluate(() => document.querySelector('.rc-name').textContent === 'بيتر موبايل' && JSON.parse(localStorage.getItem('mshop.mockup.settings.v1')).shopName === 'بيتر موبايل'), 'shop name updates receipt and persists');
await p.reload({ waitUntil: 'networkidle0' });
ok(await p.evaluate(() => SET.shopName === 'بيتر موبايل' && SET.digits === 'arabic' && SET.accent === '#0f6e5a' && SET.look === 'plate'), 'settings survive reload');
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
// 24) طابع «علبة الموبايل»: نفس الشاشات من غير ما الكلام يطلع برّه (الخط عرضه مختلف)
await p.evaluate(() => { SET.look = 'box'; saveSettings(); applySettings(); render(); }); await sleep(200);
await p.evaluate(() => document.querySelector('.nav-btn[data-v="pos"]').click()); await sleep(150);
await p.evaluate(() => { const pick = (id) => document.querySelector(`.tile[data-id="${id}"]`).click(); pick('a2'); pick('a1'); }); await sleep(150);
await p.focus('#q'); await type('a16'); await key('Enter');
await shot('30-pos-box'); await checkOverflow('pos-box');
await key('F12'); await shot('31-pay-box'); await checkOverflow('pay-box'); await key('Escape');
await key('F9'); await shot('32-services-box'); await checkOverflow('services-box'); await key('Escape');
await p.evaluate(() => document.querySelector('[data-act="toggleTheme"]').click()); await sleep(150);
await shot('33-pos-box-dark'); await checkOverflow('pos-box-dark');
await p.evaluate(() => document.querySelector('.nav-btn[data-v="dashboard"]').click()); await sleep(200);
await shot('34-dashboard-box-dark'); await checkOverflow('dashboard-box-dark');
await p.evaluate(() => ACT.resetSettings()); await sleep(100);
// 25) إعدادات من قبل الطابعين: اللون والخط الافتراضيين القدام بيتغيروا، واللي المالك اختاره بيفضل
await p.evaluate(() => localStorage.setItem('mshop.mockup.settings.v1', JSON.stringify({ shopName: 'محل قديم', font: 'plex', accent: '#2563eb', theme: 'light' })));
await p.reload({ waitUntil: 'networkidle0' });
ok(await p.evaluate(() => SET.font === 'auto' && SET.accent === '#1d4f91' && SET.look === 'plate' && SET.shopName === 'محل قديم' && document.documentElement.dataset.font === 'auto'), 'old saved settings move to the new look defaults (custom values kept)');
await p.evaluate(() => localStorage.setItem('mshop.mockup.settings.v1', JSON.stringify({ font: 'cairo', accent: '#b3261e' })));
await p.reload({ waitUntil: 'networkidle0' });
ok(await p.evaluate(() => SET.font === 'cairo' && SET.accent === '#b3261e'), 'a font or colour the owner picked himself survives the migration');
await p.evaluate(() => ACT.resetSettings());

console.log(notes.join('\n'));
console.log(`\nPASSED: ${notes.length}`);
console.log('FAILS:', fails.length ? '\n' + fails.join('\n') : 'none');
console.log('ERRORS:', errs.length ? '\n' + errs.join('\n') : 'none');
await b.close();
