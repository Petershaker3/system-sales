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
// سجل المبيعات: البيعة اتضافت للسجل، وإجمالي النهارده في التقارير = مجموع فواتير النهارده في السجل
ok(await p.evaluate(() => { const no = S.modal.sale.no, now = new Date(); const td = DATA.history.filter((x) => x.at.toDateString() === now.toDateString());
  return DATA.history.some((x) => x.no === no && x.session) && DATA.dash.today.sales === td.reduce((a, x) => a + x.total, 0) && DATA.dash.today.invoices === td.length; }), 'sale goes into the sales record; today in reports = sum of today\'s invoices');
ok(await p.evaluate(() => { const h = DATA.history.filter((x) => !x.session), first = DATA.history.find((x) => x.session);
  return h.length > 10000 && byMonth(h).length === 14 && h[0].no === 1001 && DATA.history.every((x, i) => i === 0 || (x.no === DATA.history[i - 1].no + 1 && x.at >= DATA.history[i - 1].at))
    && first.no === h[h.length - 1].no + 1; }), 'sales record: 14 months in time order, numbered from 1001 with no gaps; the first sale of the session follows the last one');
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
ok(await p.evaluate(() => !document.querySelector('#svc-ph') && !!document.querySelector('#svc-note')), 'wallet form asks for no customer number (owner 2026-10-17), only an optional note');
await key('Enter');
ok(await p.evaluate(() => document.querySelector('.err-msg').textContent.includes('العمولة') && document.activeElement.id === 'svc-fee' && !S.services.length), 'missing commission refused → cursor jumps to it');
await type('15'); await shot('09-services-wallet');
ok(await p.evaluate(() => document.querySelector('.due-box .grand').textContent.includes('1,015')), 'typed commission updates the total (1,015)');
await key('Enter');
ok(await p.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('1,015')) && S.services.at(-1).fee === 15 && !('phone' in S.services.at(-1))), 'wallet transfer recorded with the typed commission, no number');
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
// 17) المخزن
await p.evaluate(() => document.querySelector('.nav-btn[data-v="inventory"]').click()); await sleep(200);
ok(await p.evaluate(() => document.querySelector('.topbar h1').textContent.trim() === 'المخزن' && document.querySelector('.nav-btn[data-v="inventory"]').textContent.includes('المخزن') && !document.body.innerText.includes('المخزون')), 'the screen is called «المخزن», and «المخزون» appears nowhere (owner 2026-10-17)');
await p.evaluate(() => document.querySelector('[data-act="invOpen"]').click()); await sleep(150);
ok(await p.evaluate(() => document.querySelectorAll('tr.sub').length > 1), 'inventory expands IMEI units');
await shot('15-inventory');
await checkOverflow('inventory');
// 17b) صور الأصناف (اختياري): رفع صورة ← بتتصغّر ← تظهر في المخزن
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
ok(await p.evaluate(() => { const now = new Date(), sum = DATA.history.filter((x) => x.at.toDateString() === now.toDateString()).reduce((a, x) => a + x.total, 0);
  return document.querySelector('.cards .kpi .value').textContent.trim() === money(sum); }), 'reports show today\'s sales computed from the sales record');
// تقسيم طرق الدفع: كل جزء ونقطته ليهم لون فعلي (الألوان بتتبني بالاسم var(--c${i}) فلازم تكون معرّفة)
ok(await p.evaluate(() => { const seg = [...document.querySelectorAll('.split i')]; const dots = [...document.querySelectorAll('.li .dot')];
  const painted = (el) => { const c = getComputedStyle(el).backgroundColor; return c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent'; };
  return seg.length >= 3 && seg.every(painted) && dots.length >= 3 && dots.every(painted) && new Set(seg.map((e) => getComputedStyle(e).backgroundColor)).size === seg.length; }), 'payment split bar and legend dots are painted, each segment a distinct shade');
await checkOverflow('dashboard');
// 18b) التقارير: الشهر. كل رقم بيتحسب هنا من السجل مباشرة (من غير analytics.js) ويتقارن باللي ظاهر
ok(await p.evaluate(() => { const t = new Date(), y = addDays(dayStart(t), -1), cut = new Date(y.getTime() + (t - dayStart(t)));
  const ys = DATA.history.filter((x) => sameDay(x.at, y) && x.at < cut).reduce((a, x) => a + x.total, 0), td = DATA.history.filter((x) => sameDay(x.at, t)).reduce((a, x) => a + x.total, 0);
  const sub = document.querySelector('.cards .kpi .sub');
  return !ys ? !sub || !sub.textContent.includes('امبارح') : sub.textContent.includes('امبارح لنفس الساعة') && sub.textContent.includes(`${num(Math.abs(Math.round(((td - ys) / ys) * 100)))}%`); }), 'today is compared with yesterday up to the same time');
await p.evaluate(() => document.querySelector('[data-act="repTab"][data-id="month"]').click()); await sleep(250);
ok(await p.evaluate(() => { const t = new Date(), f = new Date(t.getFullYear(), t.getMonth(), 1), list = DATA.history.filter((x) => x.at >= f), cur = list.reduce((a, x) => a + x.total, 0);
  const pf = new Date(t.getFullYear(), t.getMonth() - 1, 1), pe = new Date(t.getFullYear(), t.getMonth(), 0), d = new Date(pf.getFullYear(), pf.getMonth(), t.getDate());
  const lastP = d > pe ? pe : d, pEnd = new Date(lastP.getTime() + (t - dayStart(t))), prev = DATA.history.filter((x) => x.at >= pf && x.at < pEnd).reduce((a, x) => a + x.total, 0);
  const vals = [...document.querySelectorAll('.cards .kpi .value')].map((e) => e.textContent.trim()), first = document.querySelector('.cards .kpi').textContent;
  return S.rep.tab === 'month' && vals[0] === money(cur) && vals[2] === num(list.length) && first.includes(`${num(Math.abs(Math.round(((cur - prev) / prev) * 100)))}% عن نفس الوقت من ${monthName(pf)}`); }), 'month tab: this month from the record, compared with last month up to the same moment');
ok(await p.evaluate(() => { const t = dayStart(new Date()), done = []; for (let d = new Date(t.getFullYear(), t.getMonth(), 1); d < t; d = addDays(d, 1)) done.push(DATA.history.filter((x) => sameDay(x.at, d)).reduce((a, x) => a + x.total, 0));
  if (!done.length) return true; const per = Math.round(done.reduce((a, b) => a + b, 0) / done.length), days = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  return [...document.querySelectorAll('.cards .kpi')].some((k) => k.querySelector('.label').textContent.includes('المتوقع') && k.querySelector('.value').textContent.trim() === money(per * days)); }), 'month tab: projection = average of the finished days × days in the month');
ok(await p.evaluate(() => { const t = dayStart(new Date()), key = (d) => `${d.getFullYear()}-${d.getMonth()}`, m = new Map();
  for (const x of DATA.history) { const k = key(x.at); const e = m.get(k) || { f: new Date(x.at.getFullYear(), x.at.getMonth(), 1), s: 0 }; e.s += x.total; m.set(k, e); }
  const done = DATA.history.filter((x) => x.at >= new Date(t.getFullYear(), t.getMonth(), 1) && x.at < t).reduce((a, x) => a + x.total, 0), per = Math.round(done / (t.getDate() - 1));
  const others = [...m.values()].filter((e) => key(e.f) !== key(t)).slice(-11).map((e) => Math.round(e.s / new Date(e.f.getFullYear(), e.f.getMonth() + 1, 0).getDate()));
  const rank = 1 + others.filter((v) => v > per).length, txt = document.querySelector('.ev-verdict b').textContent, notes = document.querySelectorAll('.ev-li');
  return t.getDate() === 1 || ((rank === 1 ? txt.includes('أحسن شهر') : txt.includes(`ترتيبه ${num(rank)}`)) && notes.length >= 4 && notes[0].dataset.note === 'sales' && [...notes].every((n) => n.querySelector('.tag'))); }), 'evaluation: the rank among the last 12 months is right, and every observation is tagged');
await shot('16b-reports-month'); await checkOverflow('reports-month');
await key('ArrowRight'); await sleep(200);
ok(await p.evaluate(() => { const t = new Date(), pm = new Date(t.getFullYear(), t.getMonth() - 1, 1), e = new Date(t.getFullYear(), t.getMonth(), 1), list = DATA.history.filter((x) => x.at >= pm && x.at < e);
  return document.querySelector('.day-pick .dl').textContent.trim() === fmtMonth(pm) && document.querySelector('.cards .kpi .value').textContent.trim() === money(list.reduce((a, x) => a + x.total, 0))
    && [...document.querySelectorAll('.cards .kpi .label')].some((l) => l.textContent.includes('متوسط اليوم')) && !document.querySelector('[data-act="repShift"][data-d="1"]').disabled; }), 'keyboard arrow opens last month in full (average per day instead of a projection)');
await p.evaluate(() => { const el = document.querySelector('[data-change="repMonth"]'), t = new Date(); el.value = monthKey(new Date(t.getFullYear() - 1, t.getMonth() + 1, 1)); el.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(200);
ok(await p.evaluate(() => { const t = new Date(), f = new Date(t.getFullYear() - 1, t.getMonth() + 1, 1), avail = byMonth(DATA.history).filter((m) => m.from <= f).length;
  const rows = document.querySelectorAll('.bars.months .bar-col').length, trs = [...document.querySelectorAll('[data-act="repMonthPick"]')].filter((e) => e.tagName === 'TR');
  return document.querySelector('.day-pick .dl').textContent.trim() === fmtMonth(f) && rows === Math.min(12, avail) && trs.length === rows && trs[0].classList.contains('on'); }), 'a month from the list opens with its own last months (bars and table)');
await p.evaluate(() => [...document.querySelectorAll('tr[data-act="repMonthPick"]')][1].click()); await sleep(200);
ok(await p.evaluate(() => { const t = new Date(), f = new Date(t.getFullYear() - 1, t.getMonth(), 1); return document.querySelector('.day-pick .dl').textContent.trim() === fmtMonth(f); }), 'clicking a month in the table opens it');
ok(await p.evaluate(() => { for (let i = 0; i < 20; i++) ACT.repShift({ d: '-1' }); return sameMonth(S.rep.month, DATA.history[0].at) && document.querySelector('[data-act="repShift"][data-d="-1"]').disabled; }), 'month arrows stop at the first month with sales');
await p.evaluate(() => { S.rep.tab = 'month'; S.rep.month = monthStart(new Date()); render(); }); await sleep(150);
await p.evaluate(() => document.querySelectorAll('.bars.dense button.bar-col')[4].click()); await sleep(200);
ok(await p.evaluate(() => { const v = S.salesv, d = new Date(new Date().getFullYear(), new Date().getMonth(), 5), n = DATA.history.filter((x) => sameDay(x.at, d)).length;
  return S.view === 'sales' && sameDay(v.from, d) && sameDay(v.to, d) && document.querySelectorAll('.cards .kpi .value')[1].textContent.trim() === num(n); }), 'clicking a day in the chart opens its invoices in the sales screen');
await p.evaluate(() => { S.view = 'dashboard'; render(); document.querySelector('[data-act="repSales"]').click(); }); await sleep(200);
ok(await p.evaluate(() => S.view === 'sales' && S.salesv.range === 'month' && sameMonth(S.salesv.from, new Date())), '«فواتير الشهر» opens the same month in the sales screen');
await p.evaluate(() => { S.view = 'dashboard'; render(); });
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
// المسح من الموبايل في خطوة قبل كده بيختار جهاز عشوائي، فممكن الفاتورة يبقى فيها موبايل تاني من نفس الموديل: النقص = عدد سطوره في الفاتورة
const stkAfter = await p.evaluate(() => { const ls = S.sales[S.sales.length - 1].lines, n = (id) => ls.filter((l) => l.pid === id).length;
  return { p11: prod('p11').stock, p9: prod('p9').stock, u9: unitsIn('p9').length, n11: n('p11'), n9: n('p9') }; });
ok(stkAfter.n11 >= 1 && stkAfter.n9 >= 1 && stkAfter.p11 === stk.p11 - stkAfter.n11 && stkAfter.p9 === stk.p9 - stkAfter.n9 && stkAfter.u9 <= stkAfter.p9, `sale reduces phone stock with or without IMEI (before ${JSON.stringify(stk)}, after ${JSON.stringify(stkAfter)})`);
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
    const body = Math.min(R(col('--text'), col('--bg')), R(col('--text'), col('--surface-3')), R(col('--muted'), col('--surface-3')), R(col('--muted'), col('--bg')), R(col('--muted'), col('--accent-weak')), R(col('--text'), col('--accent-weak')));
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
// 23b) المبيعات: الأيام والفلترة والعرض بالفواتير والأصناف والتصنيفات
const inRange = (days) => `(() => { const t = new Date(); const a = new Date(t.getFullYear(), t.getMonth(), t.getDate() - ${days}); return DATA.history.filter((x) => x.at >= a); })()`;
await p.evaluate(() => { S.user = DATA.users[0]; S.salesv = null; S.modal = null; render(); document.querySelector('.nav-btn[data-v="sales"]').click(); }); await sleep(200);
ok(await p.evaluate(() => { const now = new Date(), td = DATA.history.filter((x) => x.at.toDateString() === now.toDateString());
  return document.querySelectorAll('.sv-t tbody tr').length === Math.min(150, td.length) && document.querySelector('.cards .kpi .value').textContent.trim() === money(td.reduce((a, x) => a + x.total, 0)); }), 'sales screen: today by default, every invoice listed, total matches the record');
await shot('36-sales-today'); await checkOverflow('sales-today');
await p.evaluate(() => document.querySelector('[data-act="svShift"][data-d="-1"]').click()); await sleep(150);
ok(await p.evaluate(() => { const y = new Date(); y.setDate(y.getDate() - 1); const yd = DATA.history.filter((x) => x.at.toDateString() === y.toDateString());
  return document.querySelectorAll('.sv-t tbody tr').length === Math.min(150, yd.length) && S.salesv.range === 'yesterday' && !document.querySelector('[data-act="svShift"][data-d="1"]').disabled; }), 'previous-day arrow shows yesterday, and the next arrow comes back');
await p.keyboard.press('ArrowLeft'); await sleep(150);
ok(await p.evaluate(() => S.salesv.range === 'today' && document.querySelector('[data-act="svShift"][data-d="1"]').disabled), 'keyboard arrow goes forward to today, and never past today');
await p.evaluate(() => document.querySelector('[data-act="svRange"][data-id="week"]').click()); await sleep(150);
ok(await p.evaluate((src) => { const n = eval(src).length; return document.querySelectorAll('.cards .kpi .value')[1].textContent.trim() === num(n); }, inRange(6)), 'last 7 days: invoice count matches the record');
await p.evaluate(() => { const el = document.querySelector('[data-change="svCat"]'); el.value = 'cases'; el.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(150);
await p.evaluate(() => document.querySelector('[data-act="svView"][data-id="prod"]').click()); await sleep(150);
ok(await p.evaluate((src) => { const sum = eval(src).flatMap((x) => x.lines).filter((l) => l.cat === 'cases').reduce((a, l) => a + l.price * l.qty, 0);
  const cats = [...document.querySelectorAll('.sv-t tbody tr td:nth-child(2)')].map((e) => e.textContent.trim());
  return cats.length > 0 && cats.every((c) => c === 'جرابات') && document.querySelector('.cards .kpi .value').textContent.trim() === money(sum) && !!document.querySelector('.sv-note'); }, inRange(6)), 'category filter + products view: only cases, and the total is the cases lines');
await shot('37-sales-products'); await checkOverflow('sales-products');
await p.evaluate(() => document.querySelector('[data-act="svClear"]').click()); await sleep(100);
await p.evaluate(() => document.querySelector('[data-act="svView"][data-id="cat"]').click()); await sleep(150);
ok(await p.evaluate(() => { const shares = [...document.querySelectorAll('.sv-t tbody tr:not(.sub) td:nth-child(4) .num')].map((e) => parseInt(e.textContent.replace(/\D/g, ''), 10));
  const sum = shares.reduce((a, b) => a + b, 0); return shares.length >= 3 && sum >= 98 && sum <= 102; }), 'categories view: main categories add up to about 100%');
await checkOverflow('sales-categories');
await p.evaluate(() => document.querySelector('[data-act="svView"][data-id="inv"]').click()); await sleep(100);
const probe = await p.evaluate((src) => { const x = eval(src).filter((y) => y.lines.some((l) => l.imei)).pop(); return { no: x.no, im: x.lines.find((l) => l.imei).imei.slice(-6) }; }, inRange(6));
await p.focus('#sv-q'); await type(String(probe.no));
ok(await p.evaluate((no) => { const r = [...document.querySelectorAll('.sv-t tbody tr')]; return r.length === 1 && r[0].dataset.no === String(no); }, probe.no), 'search by invoice number finds exactly that invoice');
await p.evaluate(() => { const i = document.querySelector('#sv-q'); i.select(); }); await type(String(probe.no).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]));
ok(await p.evaluate((no) => { const r = [...document.querySelectorAll('.sv-t tbody tr')]; return r.length === 1 && r[0].dataset.no === String(no); }, probe.no), 'the invoice number typed in Arabic digits finds it too');
await p.evaluate(() => { const i = document.querySelector('#sv-q'); i.select(); }); await type(probe.im);
ok(await p.evaluate((no) => [...document.querySelectorAll('.sv-t tbody tr')].some((r) => r.dataset.no === String(no)), probe.no), 'search by part of an IMEI finds the invoice');
await p.evaluate((no) => document.querySelector(`.sv-t tbody tr[data-no="${no}"]`).click(), probe.no); await sleep(150);
ok(await p.evaluate(() => !!document.querySelector('.modal[aria-label="تفاصيل الفاتورة"]') && document.querySelectorAll('.modal .t tbody tr').length >= 1 && !!document.querySelector('.modal .imei-tag')), 'an invoice opens with its lines and IMEI');
await shot('38-sales-invoice'); await checkOverflow('sales-invoice'); await key('Escape');
await p.evaluate(() => { S.user = DATA.users[1]; S.salesv = null; render(); }); await sleep(150);
ok(await p.evaluate(() => { const t = new Date(), mine = DATA.history.filter((x) => x.at.toDateString() === t.toDateString() && x.sellerId === 'u2');
  return !document.querySelector('[data-change="svSeller"]') && ![...document.querySelectorAll('.cards .kpi .label')].some((e) => e.textContent.includes('الربح'))
    && document.querySelectorAll('.sv-t tbody tr').length === Math.min(150, mine.length) && document.querySelector('.page-h .sub').textContent.includes('مبيعاتك'); }), 'a seller sees only his own sales, with no profit and no seller filter');
// الشهر: اللي قبله كامل، والرجوع للشهر ده لحد النهارده. والأسبوع: 7 أيام قبلها، والرجوع
ok(await p.evaluate(() => { S.user = DATA.users[0]; S.salesv = null; render(); ACT.svRange({ id: 'month' }); const t = dayStart(new Date());
  svShift(-1); const v = S.salesv, pm = new Date(t.getFullYear(), t.getMonth() - 1, 1), pmEnd = new Date(t.getFullYear(), t.getMonth(), 0);
  const prevOk = v.from.getTime() === pm.getTime() && v.to.getTime() === pmEnd.getTime() && !document.querySelector('[data-act="svShift"][data-d="1"]').disabled;
  svShift(1); return prevOk && S.salesv.from.getTime() === new Date(t.getFullYear(), t.getMonth(), 1).getTime() && S.salesv.to.getTime() === t.getTime() && S.salesv.range === 'month'; }), 'month range: previous month in full, then back to this month up to today');
ok(await p.evaluate(() => { ACT.svRange({ id: 'week' }); const t = dayStart(new Date()); svShift(-1); const a = S.salesv.from.getTime() === addDays(t, -13).getTime() && S.salesv.to.getTime() === addDays(t, -7).getTime();
  svShift(1); return a && S.salesv.range === 'week' && S.salesv.to.getTime() === t.getTime(); }), 'week range moves back 7 days and returns');
// الشهور: القايمة، وشهر من السنة اللي فاتت، والأيام، والمقارنة، وأول شهر
await p.evaluate(() => { S.user = DATA.users[0]; S.salesv = null; render(); ACT.svRange({ id: 'month' }); }); await sleep(150);
ok(await p.evaluate(() => { const o = [...document.querySelectorAll('[data-change="svMonth"] option')], t = new Date(), pm = new Date(t.getFullYear(), t.getMonth() - 1, 1);
  const sub = document.querySelector('.cards .kpi .sub').textContent;
  return o.length === 15 && o[0].value === '' && o[0].selected && o[1].value === monthKey(t) && o[1].textContent.includes('المعروض') && o[14].value === monthKey(new Date(t.getFullYear(), t.getMonth() - 13, 1))
    && document.querySelector('.day-pick .dl').textContent.includes('لحد النهارده') && sub.includes(`نفس الوقت من ${monthName(pm)}`); }), 'months list: 14 months, newest first; this month is compared with last month up to the same time');
await p.evaluate(() => { const el = document.querySelector('[data-change="svMonth"]'), t = new Date(); el.value = monthKey(new Date(t.getFullYear() - 1, t.getMonth(), 1)); el.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(150);
ok(await p.evaluate(() => { const t = new Date(), f = new Date(t.getFullYear() - 1, t.getMonth(), 1), e = monthEnd(f), list = DATA.history.filter((x) => x.at >= f && x.at < addDays(e, 1));
  return S.salesv.range === 'month-x' && document.querySelector('.cards .kpi .value').textContent.trim() === money(list.reduce((a, x) => a + x.total, 0))
    && document.querySelectorAll('.cards .kpi .value')[1].textContent.trim() === num(list.length) && document.querySelector('.day-pick .dl').textContent.trim() === fmtMonth(f)
    && !document.querySelector('[data-act="svShift"][data-d="1"]').disabled; }), 'a month from last year opens from the list, and its totals match the record');
await shot('39a-sales-month'); await checkOverflow('sales-month');
await p.evaluate(() => document.querySelector('[data-act="svView"][data-id="day"]').click()); await sleep(150);
ok(await p.evaluate(() => { const v = S.salesv, rows = document.querySelectorAll('.sv-days tbody tr'), list = DATA.history.filter((x) => x.at >= v.from && x.at < addDays(v.to, 1));
  const best = Math.max(...byDay(asRows(list), v.from, v.to).map((d) => d.sales));
  return rows.length === daysIn(v.from, v.to) && document.querySelectorAll('.sv-days .tag').length === 1 && document.querySelector('.sv-days .tag').closest('tr').querySelector('td:nth-child(4)').textContent.trim() === money(best); }), 'days view: one row per day of the month, and the best day is marked once');
await checkOverflow('sales-days');
await p.evaluate(() => document.querySelectorAll('.sv-days tbody tr')[9].click()); await sleep(150);
ok(await p.evaluate(() => { const v = S.salesv, d = addDays(monthStart(v.from), 0); return daysIn(v.from, v.to) === 1 && v.from.getDate() === 10 && v.view === 'inv' && !!document.querySelector('.sv-t tbody tr[data-no]') && !document.querySelector('[data-act="svView"][data-id="day"]'); }), 'clicking a day opens that day with its invoices');
ok(await p.evaluate(() => { ACT.svRange({ id: 'month' }); for (let i = 0; i < 20; i++) svShift(-1); const v = S.salesv, first = DATA.history[0].at;
  return sameMonth(v.from, first) && document.querySelector('[data-act="svShift"][data-d="-1"]').disabled; }), 'month arrows stop at the first month with sales');
await p.evaluate(() => { S.user = DATA.users[0]; S.salesv = null; svSetDay(addDays(svFirstDay(), -1)); }); await sleep(120);
ok(await p.evaluate(() => !!document.querySelector('.sv-empty') && document.querySelector('.sv-empty b').textContent.includes('اليوم ده')), 'a day without sales says so');
await p.evaluate(() => { S.salesv = null; S.view = 'pos'; render(); });
// 23c) النواقص: بإيدك، ومن اقتراحات السيستم، والحالة، ومن شاشة البيع
await p.evaluate(() => { S.user = DATA.users[0]; S.modal = null; S.view = 'inventory'; S.inv.tab = 'items'; render(); document.querySelector('[data-act="invView"][data-id="short"]').click(); }); await sleep(150);
ok(await p.evaluate(() => { const t = document.querySelectorAll('.sh-t'); return t.length === 2 && t[0].querySelectorAll('tbody tr').length === SHORT.length && t[1].querySelectorAll('tbody tr').length === shortSuggest().length
  && shortSuggest().length > 0 && shortSuggest().every((x) => stockOf(x) <= x.min && !SHORT.some((y) => y.pid === x.id)); }), 'shortages tab: the written list + system suggestions (at or under the minimum, not already listed)');
await p.focus('#sh-q'); await type('سماعة JBL Tune 520');
await p.focus('#sh-qty'); await p.evaluate(() => document.querySelector('#sh-qty').select()); await type('2');
await p.focus('#sh-note'); await type('لون أبيض');
await p.focus('#sh-cust'); await type('هاني 01099988877');
await p.evaluate(() => document.querySelector('[data-act="shAdd"]').click()); await sleep(150);
ok(await p.evaluate(() => { const x = SHORT[0]; return x.name === 'سماعة JBL Tune 520' && x.qty === 2 && x.note === 'لون أبيض' && x.cust && x.cust.phone === '01099988877' && x.cust.name === 'هاني' && !x.pid && x.by === 'u1'
  && JSON.parse(localStorage.getItem('mshop.mockup.shortages.v1'))[0].id === x.id; }), 'add a shortage by hand (typed name, quantity, note, waiting customer) and it is saved');
await p.focus('#sh-q'); await type('باور بانك'); await sleep(100);
ok(await p.$('.sh-res .result'), 'typing a name suggests matching items from inventory');
await p.keyboard.press('Enter'); await sleep(120);
ok(await p.evaluate(() => shortForm().pid === 'a11' && !!document.querySelector('.sh-picked')), 'Enter picks the item from inventory');
await p.evaluate(() => document.querySelector('[data-act="shAdd"]').click()); await sleep(150);
ok(await p.evaluate(() => SHORT[0].pid === 'a11'), 'the picked inventory item is added, linked to the product');
await p.evaluate(() => ACT.shortQuick({ id: 'a11' })); await sleep(100);
ok(await p.evaluate(() => SHORT.filter((x) => x.pid === 'a11').length === 1 && SHORT.find((x) => x.pid === 'a11').qty >= 2), 'the same item again raises its quantity instead of a second line');
const sp = await p.evaluate(() => shortSuggest()[0].id);
await p.evaluate((id) => document.querySelector(`[data-act="shSug"][data-id="${id}"]`).click(), sp); await sleep(150);
ok(await p.evaluate((id) => SHORT.some((x) => x.pid === id && x.qty === suggestQty(prod(id))) && !shortSuggest().some((x) => x.id === id), sp), 'a system suggestion is added with the suggested quantity and leaves the suggestions');
const sid = await p.evaluate(() => SHORT[0].id);
await p.evaluate((id) => document.querySelector(`[data-act="shStatus"][data-id="${id}"][data-s="ordered"]`).click(), sid); await sleep(100);
ok(await p.evaluate((id) => SHORT.find((x) => x.id === id).status === 'ordered' && document.querySelector(`[data-act="shStatus"][data-id="${id}"][data-s="ordered"]`).getAttribute('aria-pressed') === 'true', sid), 'a shortage can be marked as ordered');
await shot('39-shortages'); await checkOverflow('shortages');
await p.evaluate((id) => document.querySelector(`[data-act="shDone"][data-id="${id}"]`).click(), sid); await sleep(120);
ok(await p.evaluate((id) => !SHORT.some((x) => x.id === id) && [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('وصل')), sid), '«وصل» takes it off the list');
await p.evaluate(() => { S.view = 'pos'; S.q = ''; S.modal = null; render(); }); await p.focus('#q'); await type('شاحن 100 وات جالكسي'); await sleep(150);
ok(await p.$('.no-res [data-act="shortQuick"]'), 'a sales search with no result offers adding it to shortages');
await shot('40-pos-search-shortage'); await checkOverflow('pos-search-shortage');
await p.evaluate(() => document.querySelector('.no-res [data-act="shortQuick"]').click()); await sleep(120);
ok(await p.evaluate(() => SHORT[0].name === 'شاحن 100 وات جالكسي' && !SHORT[0].pid), 'added to shortages straight from the sales search');
await p.evaluate(() => { prod('a13').stock = 0; S.q = ''; render(); }); await p.focus('#q'); await type('حامل موبايل للعربية'); await sleep(150);
await p.evaluate(() => document.querySelector('.result [data-act="shortQuick"][data-id="a13"]').click()); await sleep(120);
ok(await p.evaluate(() => SHORT.some((x) => x.pid === 'a13') && cur().lines.every((l) => l.pid !== 'a13')), 'an out-of-stock item in the sales search goes to shortages in one click (not into the invoice)');
await p.evaluate(() => { S.user = DATA.users[2]; ACT.shortQuick({ name: 'جراب iPhone 15 شفاف' }); S.view = 'inventory'; S.inv.tab = 'short'; render(); }); await sleep(120);
ok(await p.evaluate(() => SHORT[0].by === 'u3' && [...document.querySelectorAll('.sh-t')[0].querySelectorAll('tbody tr')].every((tr) => { const x = SHORT.find((y) => y.id === tr.dataset.id); return !!tr.querySelector('[data-act="shDel"]') === (x.by === 'u3'); })), 'a seller can add; he can delete only what he added');
const shN = await p.evaluate(() => SHORT.length);
await p.reload({ waitUntil: 'networkidle0' });
ok(await p.evaluate((n) => SHORT.length === n, shN), 'shortages survive closing and reopening');
// 23d) استلام بضاعة من الكمبيوتر: بالكيبورد، والمتوسط المرجح، والـ IMEI، والنواقص، والبيّاع، والإعدادات، وحماية القفل
await p.evaluate(() => { S.user = DATA.users[0]; S.modal = null; S.view = 'inventory'; S.inv.tab = 'items'; render(); document.querySelector('[data-act="recvOpen"]').click(); }); await sleep(200);
ok(await p.evaluate(() => S.view === 'inventory' && S.modal && S.modal.type === 'receive' && document.activeElement.id === 'rc-q'), 'inventory «استلام بضاعة» opens the receiving window on the computer, search focused');
const rcBefore = await p.evaluate(() => ({ a7: [prod('a7').stock, prod('a7').cost], a10: [prod('a10').stock, prod('a10').cost], p1: [prod('p1').stock, DATA.units.length] }));
await type('كابل لايتنينج'); await key('Enter'); const rf1 = await p.evaluate(() => document.activeElement.id);
await type('20'); await key('Enter'); const rf2 = await p.evaluate(() => document.activeElement.id);
await type('85'); await key('Enter'); const rf3 = await p.evaluate(() => document.activeElement.id);
ok(rf1 === 'rc-qty-0' && rf2 === 'rc-cost-0' && rf3 === 'rc-q', 'keyboard: name → Enter → count → Enter → unit cost → Enter → back to search');
await type('A16'); await key('Enter');
ok(await p.evaluate(() => document.activeElement.id === 'rc-im-1'), 'a phone goes straight to its IMEI box');
await p.evaluate(() => { ACT.rcPhone({ i: '1' }); ACT.rcPhone({ i: '1' }); }); await sleep(120);
await type('123456789012345'); await key('Enter');
ok(await p.evaluate(() => S.modal.lines[1].imeis.length === 2 && S.modal.lines[1].qty === 2 && document.querySelector('.rc-err').textContent.includes('رقم المراجعة')), 'IMEIs scanned by the phone raise the count; a wrong IMEI is refused');
const taken = await p.evaluate(() => { const u = DATA.units.find((x) => x.pid !== 'p1'); return { imei: u.imei, name: prod(u.pid).name }; });
await p.evaluate(() => document.querySelector('#rc-im-1').select()); await type(taken.imei); await key('Enter');
ok(await p.evaluate((t) => document.querySelector('.rc-err').textContent.includes(t.name), taken), 'an IMEI already in stock is refused, naming the product it belongs to');
await p.evaluate(() => SHORT.unshift({ id: 'shqa', pid: 'a10', name: 'إيربودز برو (هاي كوبي)', qty: 2, note: '', cust: { name: 'هاني', phone: '01099988877' }, status: 'ordered', by: 'u1', at: new Date().toISOString() }));
await p.focus('#rc-q'); await type('إيربودز'); await key('Enter'); await type('5'); await key('Enter'); await type('480'); await key('Enter');
await p.focus('#rc-sup'); await type('النور للتوزيع');
await shot('40-receive'); await checkOverflow('receive');
await key('Escape');
ok(await p.evaluate(() => S.modal && S.modal.type === 'receive' && S.modal.lines.length === 3 && S.modal.err.includes('ماتحفظتش')), 'Esc with unsaved lines warns first instead of losing them');
await key('Enter', ['Control']); await sleep(150);
ok(await p.evaluate((b) => { const avg = (s, c, q, k) => Math.ceil((Math.max(0, s) * c + q * k) / (Math.max(0, s) + q)), a = prod('a7'), e = prod('a10');
  return !S.modal && a.stock === b.a7[0] + 20 && a.cost === avg(b.a7[0], b.a7[1], 20, 85) && e.stock === b.a10[0] + 5 && e.cost === avg(b.a10[0], b.a10[1], 5, 480); }, rcBefore), 'saving adds the stock, and the cost follows the moving average (ADR-002)');
ok(await p.evaluate((b) => { const added = DATA.units.slice(b.p1[1]); return prod('p1').stock === b.p1[0] + 2 && added.length === 2 && added.every((u) => u.pid === 'p1' && u.cost === 8600 && u.status === 'in'); }, rcBefore), 'phones go into stock with their IMEIs, each at its own cost');
ok(await p.evaluate(() => { const r = DATA.receipts[DATA.receipts.length - 1]; return r.supplier === 'النور للتوزيع' && r.lines.length === 3 && !SHORT.some((x) => x.id === 'shqa') && [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('هاني') && t.textContent.includes('01099988877')); }), 'the receipt is kept with its supplier; the shortage clears itself and the waiting customer is named');
await p.evaluate(() => { S.user = DATA.users[1]; S.modal = null; render(); ACT.recvOpen(); }); await sleep(150);
await type('جراب سيليكون'); await key('Enter');
ok(await p.evaluate(() => !document.querySelector('[id^="rc-cost-"]') && ![...document.querySelectorAll('.rc-t th')].some((th) => th.textContent.includes('تكلفة'))), 'a seller receives without seeing or typing the cost');
const rcSeller = await p.evaluate(() => [prod('a1').stock, prod('a1').cost]);
await type('10'); await key('Enter'); await key('Enter', ['Control']); await sleep(150);
ok(await p.evaluate((c) => !S.modal && prod('a1').stock === c[0] + 10 && prod('a1').cost === c[1], rcSeller), 'a seller\'s receipt leaves the average cost as it was');
const imMode = await p.evaluate(() => SET.imeiMode);
await p.evaluate(() => { S.user = DATA.users[0]; SET.imeiMode = 'required'; ACT.recvOpen(); }); await sleep(150);
await type('Redmi 14C'); await key('Enter'); await p.evaluate(() => { const l = S.modal.lines[0]; l.qty = 3; l.qtyT = '3'; render(); });
await key('Enter', ['Control']); await sleep(120);
ok(await p.evaluate(() => S.modal && S.modal.err.includes('ناقصه')), 'with «IMEI required» a phone line can\'t be saved short of IMEIs');
await p.evaluate((m) => { S.modal.confirmClose = true; closeModal(); SET.imeiMode = m; saveSettings(); render(); }, imMode);
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
await p.evaluate(() => document.querySelector('.nav-btn[data-v="sales"]').click()); await sleep(200);
await shot('34b-sales-box-dark'); await checkOverflow('sales-box-dark');
await p.evaluate(() => { S.view = 'inventory'; S.inv.tab = 'short'; render(); }); await sleep(150);
await shot('34c-shortages-box-dark'); await checkOverflow('shortages-box-dark');
await p.evaluate(() => { S.inv.tab = 'items'; render(); });
// 24b) العلبة بحجم كلام كبير على 1366 (أضيق حالة)
await p.evaluate(() => { SET.theme = 'light'; SET.scale = 'large'; applySettings(); render(); }); await sleep(200);
await p.evaluate(() => document.querySelector('.nav-btn[data-v="pos"]').click()); await sleep(150);
await shot('35-pos-box-large'); await checkOverflow('pos-box-large');
await key('F12'); await checkOverflow('pay-box-large'); await key('Escape');
await p.evaluate(() => ACT.resetSettings()); await sleep(100);
// 24c) التركيز باين على لوح «لافتة الشارع» (≥ 3:1 قدام لون اللوح)
await p.evaluate(() => document.querySelector('.nav-btn[data-v="pos"]').click()); await sleep(100);
await p.focus('.rail .nav-btn[data-v="repairs"]'); await p.keyboard.press('Shift'); await sleep(80);
const fr = await p.evaluate(() => { const el = document.activeElement, cs = getComputedStyle(el); return { vis: el.matches(':focus-visible'), oc: cs.outlineColor, ow: parseFloat(cs.outlineWidth), st: cs.outlineStyle, rail: getComputedStyle(document.querySelector('.rail')).backgroundColor }; });
const rgb = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const cr = (a, b) => { const x = lum(rgb(a)), y = lum(rgb(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
ok(fr.vis && fr.st !== 'none' && fr.ow >= 2 && cr(fr.oc, fr.rail) >= 3, `keyboard focus ring is visible on the plate rail (${cr(fr.oc, fr.rail).toFixed(1)}:1)`);
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
