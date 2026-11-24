// يتأكد إن mockup-offline.html بيشتغل لوحده من الديسك: صفر طلبات شبكة، الخطوط العربي محمّلة، مفيش أخطاء.
// Verifies the single-file build opens from file:// with zero network requests and real fonts.
//   node offline-check.mjs
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { launch } from './launch.mjs';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'mockup-offline.html');
const url = pathToFileURL(FILE).href;
const b = await launch();
const p = await b.newPage();
const errs = []; const net = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
p.on('request', (r) => { const u = r.url(); if (!u.startsWith('data:') && u !== url) net.push(u); });
await p.setViewport({ width: 1366, height: 768 });
await p.goto(url, { waitUntil: 'load' });
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: 'load' });
await p.evaluate(() => document.fonts.ready);
const info = await p.evaluate(async () => {
  await Promise.all([document.fonts.load('400 16px "IBM Plex Sans Arabic"', 'مبيعات'), document.fonts.load('700 16px "IBM Plex Sans Arabic"', 'مبيعات')]);
  const faces = [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family} ${f.weight}`);
  return {
    title: document.title,
    tiles: document.querySelectorAll('.tile').length,
    icons: document.querySelectorAll('svg').length,
    loadedFaces: faces.length,
    plexArabic: document.fonts.check('400 16px "IBM Plex Sans Arabic"', 'مبيعات'),
    bodyFont: getComputedStyle(document.body).fontFamily.split(',')[0],
  };
});
// تبديل الوضع الداكن وحفظ الإعداد بيشتغل من file:// كمان؟
const persisted = await p.evaluate(() => { try { localStorage.setItem('mshop.offline.probe', '1'); return localStorage.getItem('mshop.offline.probe') === '1'; } catch { return false; } });
mkdirSync('/tmp/shots', { recursive: true });
await p.screenshot({ path: '/tmp/shots/offline-1366.png' });
console.log(JSON.stringify({ url, ...info, localStorage: persisted, networkRequests: net.length, net: net.slice(0, 5), errors: errs }, null, 1));
await b.close();
const ok = info.tiles > 0 && info.plexArabic && info.loadedFaces > 0 && net.length === 0 && errs.length === 0 && persisted;
console.log(ok ? 'OFFLINE OK' : 'OFFLINE FAIL');
process.exit(ok ? 0 : 1);
