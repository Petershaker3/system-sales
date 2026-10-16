// Regenerates the reference screenshots in ../screens (1366×768). Needs the preview server (serve.py).
import { launch, URL } from './launch.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'screens');
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.endsWith('.png')) fs.unlinkSync(path.join(OUT, f));
const b = await launch(); const p = await b.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clearToasts = () => p.evaluate(() => { document.getElementById('toasts').innerHTML = ''; });
const snap = async (name) => { await clearToasts(); await sleep(300); await p.screenshot({ path: path.join(OUT, name) }); };
await p.setViewport({ width: 1366, height: 768 });
await p.goto(URL, { waitUntil: 'networkidle0' });
await p.evaluate(() => localStorage.clear()); await p.reload({ waitUntil: 'networkidle0' });
// 1) شاشة البيع: «إكسسوارات» + الفرعي، وفاتورة فيها موبايل من غير IMEI (زرار «سجّل IMEI») وموبايل بالـ IMEI
await p.evaluate(() => {
  S._imeiHint = true;
  addPhone(prod('p4'));
  S.sel = -1; addUnit(DATA.units.find((u) => u.pid === 'p1' && u.status === 'in'));
  const s = prod('a2'); addItem(s); addItem(s); addItem(prod('a15'));
  cur().customer = DATA.customers[0]; S.sel = 0; S.cat = 'acc'; render();
});
await p.focus('#q'); await p.evaluate(() => { document.querySelector('.lines').scrollTop = 0; });
await snap('01-pos-light.png');
// 2) تبديل البيّاع من فوق (تأشير)
await p.hover('.user-chip'); await sleep(450);
await snap('02-switch-user.png');
await p.mouse.move(800, 500); await sleep(500);
// 3) مبيعات النهارده على الموبايل (بعد بيعة)
await p.evaluate(() => { exactCash(); finishAfterSale(); S.view = 'mobile'; render(); });
await snap('03-mobile-sales.png');
// 4) الإعدادات ← الأصناف والبيع (الـ IMEI + الصور + التصنيفات)
await p.evaluate(() => { S.view = 'settings'; S.settingsTab = 'catalog'; render(); });
await snap('04-settings-catalog.png');
// 5) المخزن: «إكسسوارات» + عدد اللي بالـ IMEI والأجهزة اللي من غير IMEI
await p.evaluate(() => { S.view = 'inventory'; S.inv.cat = 'phones'; S.inv.open = { p4: true }; render(); });
await snap('05-inventory.png');
// 6) التقارير غامق
await p.evaluate(() => { SET.theme = 'dark'; applySettings(); S.view = 'dashboard'; render(); });
await snap('06-dashboard-dark.png');
// 7–10) الطابعين (docs/ui/REDESIGN.md): نفس الفاتورة في «علبة الموبايل» فاتح وغامق، و«لافتة الشارع» غامق، واختيار الطابع من الإعدادات
const cartFor = async (look, theme) => {
  await p.evaluate(() => localStorage.clear()); await p.reload({ waitUntil: 'networkidle0' });
  await p.evaluate((lk, th) => {
    SET.look = lk; SET.theme = th; applySettings(); S._imeiHint = true;
    addPhone(prod('p4')); S.sel = -1; addUnit(DATA.units.find((u) => u.pid === 'p1' && u.status === 'in'));
    const s = prod('a2'); addItem(s); addItem(s); addItem(prod('a15'));
    cur().customer = DATA.customers[0]; S.sel = 0; S.cat = 'acc'; render();
  }, look, theme);
  await p.focus('#q'); await p.evaluate(() => { document.querySelector('.lines').scrollTop = 0; });
};
await cartFor('box', 'light'); await snap('07-pos-box.png');
await cartFor('box', 'dark'); await snap('08-pos-box-dark.png');
await cartFor('plate', 'dark'); await snap('09-pos-plate-dark.png');
await p.evaluate(() => { SET.theme = 'light'; applySettings(); S.view = 'settings'; S.settingsTab = 'look'; render(); });
await snap('10-settings-look.png');
// 11–13) شاشة المبيعات (النهارده، وبالتصنيفات لآخر 7 أيام) والنواقص (docs/ui/SALES-SHORTAGES.md)
await p.evaluate(() => { S.view = 'sales'; S.salesv = null; render(); });
await snap('11-sales-today.png');
await p.evaluate(() => { ACT.svRange({ id: 'week' }); ACT.svView({ id: 'cat' }); });
await snap('12-sales-categories.png');
await p.evaluate(() => { S.view = 'inventory'; S.inv.tab = 'short'; render(); });
await snap('13-shortages.png');
// 14–17) الشهور في المبيعات، وتقرير الشهر، وآخر 12 شهر، والاستلام من الكمبيوتر (docs/ui/MONTHS-REPORTS-RECEIVING.md)
await p.evaluate(() => { S.inv.tab = 'items'; S.view = 'sales'; S.salesv = null; render(); ACT.svRange({ id: 'month' }); svShift(-1); ACT.svView({ id: 'day' }); });
await snap('14-sales-month-days.png');
await p.evaluate(() => { S.view = 'dashboard'; S.rep = { tab: 'month', month: monthStart(new Date()) }; render(); });
await snap('15-reports-month.png');
await p.evaluate(() => { const c = document.querySelector('.content'); c.scrollTop = c.scrollHeight; });
await snap('16-reports-12-months.png');
await p.evaluate(() => { S.view = 'inventory'; S.rep = null; render(); ACT.recvOpen(); rcAdd('a7'); Object.assign(S.modal.lines[0], { qty: 20, qtyT: '20', cost: 85, costT: '85' }); rcAdd('p1'); ACT.rcPhone({ i: '1' }); ACT.rcPhone({ i: '1' }); S.modal.supplier = 'النور للتوزيع'; render(); });
await snap('17-receive.png');
await p.evaluate(() => { S.modal.confirmClose = true; closeModal(); localStorage.clear(); });
console.log('screens:', fs.readdirSync(OUT).join(', '));
console.log('screens ERRORS:', errs.length ? errs.join(' | ') : 'none');
await b.close();
