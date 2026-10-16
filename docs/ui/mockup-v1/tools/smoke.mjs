// Quick load check: title, tiles, focus, console errors. Needs the preview server running (serve.py).
import { launch, URL } from './launch.mjs';
const b = await launch(); const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.setViewport({ width: 1366, height: 768 });
await p.goto(URL, { waitUntil: 'networkidle0' });
await p.evaluate(() => localStorage.clear()); await p.reload({ waitUntil: 'networkidle0' });
console.log('title:', await p.title());
console.log('tiles:', await p.$$eval('.tile', (e) => e.length), 'focused:', await p.evaluate(() => document.activeElement && document.activeElement.id));
console.log('ERRORS:', errs.length ? errs.join(' | ') : 'none');
await b.close();
