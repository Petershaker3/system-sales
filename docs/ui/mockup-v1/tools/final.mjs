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
// 5) المخزون: «إكسسوارات» + عدد اللي بالـ IMEI والأجهزة اللي من غير IMEI
await p.evaluate(() => { S.view = 'inventory'; S.inv.cat = 'phones'; S.inv.open = { p4: true }; render(); });
await snap('05-inventory.png');
// 6) التقارير غامق
await p.evaluate(() => { SET.theme = 'dark'; applySettings(); S.view = 'dashboard'; render(); });
await snap('06-dashboard-dark.png');
await p.evaluate(() => localStorage.clear());
console.log('screens:', fs.readdirSync(OUT).join(', '));
console.log('screens ERRORS:', errs.length ? errs.join(' | ') : 'none');
await b.close();
