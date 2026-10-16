// Static snapshots of every screen in both looks × both themes, for the impeccable design detector.
// Needs the preview server (serve.py) on 127.0.0.1:4173 (or MOCKUP_URL). Output: /tmp/snap/<look>-<theme>-<screen>.html
// (scripts removed, <base> pointing at the server so the real CSS and fonts load). Review flow: docs/ui/REDESIGN.md
//   node snapshots.mjs && sh detect-snapshots.sh
import fs from 'node:fs';
import { launch, URL } from './launch.mjs';

const OUT = process.env.SNAP_DIR || '/tmp/snap';
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const b = await launch(); const p = await b.newPage();
await p.setViewport({ width: 1366, height: 768 });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = async (k) => { await p.keyboard.press(k); await sleep(140); };
const nav = (v) => p.evaluate((id) => document.querySelector(`.nav-btn[data-v="${id}"]`).click(), v);
const saved = [];
async function save(name) {
  await sleep(160);
  const html = await p.evaluate((base) => {
    const d = document.documentElement.cloneNode(true);
    d.querySelectorAll('script').forEach((s) => s.remove());
    const tag = document.createElement('base'); tag.href = base; d.querySelector('head').prepend(tag);
    return `<!doctype html>\n${d.outerHTML}`;
  }, URL);
  fs.writeFileSync(`${OUT}/${name}.html`, html); saved.push(name);
}

for (const look of ['plate', 'box']) {
  for (const theme of ['light', 'dark']) {
    const t = `${look}-${theme}`;
    await p.goto(URL, { waitUntil: 'networkidle0' });
    await p.evaluate((lk, th) => { localStorage.clear(); localStorage.setItem('mshop.mockup.settings.v1', JSON.stringify({ look: lk, theme: th })); }, look, theme);
    await p.reload({ waitUntil: 'networkidle0' }); await p.evaluate(() => document.fonts.ready);
    await save(`${t}-pos-empty`);
    await p.evaluate(() => { const pick = (id) => document.querySelector(`.tile[data-id="${id}"]`).click(); pick('a2'); pick('a1'); });
    await p.focus('#q'); await p.keyboard.type('a16', { delay: 10 }); await sleep(160); await key('Enter');
    await save(`${t}-pos-cart`);
    await key('F12'); await save(`${t}-pay`);
    await key('Enter'); await sleep(200); await save(`${t}-done`); await key('Escape');
    await key('F9'); await save(`${t}-services`); await key('Escape');
    await p.evaluate(() => document.querySelector('[data-act="shiftClose"]').click()); await save(`${t}-shift`); await key('Escape');
    // الرسايل بتختفي بعد ثواني: قبل باقي الشاشات بنشيل رسايل البيع اللي فاتت (زي ما الوقت يعدّي)، عشان ما تتحسبش على تصميم الصفحة
    await p.evaluate(() => document.querySelectorAll('.toast').forEach((x) => x.remove()));
    for (const v of ['repairs', 'inventory', 'dashboard', 'mobile']) { await nav(v); await sleep(200); await save(`${t}-${v}`); }
    await nav('settings'); await sleep(150);
    for (const tab of ['shop', 'look', 'catalog', 'pay', 'receipt', 'devices']) {
      await p.evaluate((id) => document.querySelector(`.s-nav [data-id="${id}"]`).click(), tab); await save(`${t}-settings-${tab}`);
    }
    await p.evaluate(() => ACT.lock()); await save(`${t}-lock`);
  }
}
await b.close();
fs.writeFileSync(`${OUT}/index.txt`, saved.map((n) => `${n}.html`).join('\n') + '\n');
console.log(`snapshots: ${saved.length} in ${OUT}`);
console.log('ERRORS:', errs.length ? errs.join(' | ') : 'none');
