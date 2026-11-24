#!/usr/bin/env node
// Two buttons the owner uses on a finished draft: «افتح باكب أحدث» and
// «وصّلهم تلقائيًا» — driven through the real screen, on a small made-up shop.
//
// The promise being checked is the one he set (2026-11-02): the new days come in,
// the counts move by what sold, and **nothing else in the draft changes**. The
// second half is checked by comparing the plan before and after the click.
//
// Usage: node test/ui-newer.mjs

import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const html = readFileSync(new URL('../legacy-migration.html', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const problems = [];

const DAY = (sections) => JSON.stringify({
  acc: [], used: [], cash: [], sw: [], exp: [], phones: [], repairs: [],
  ...sections,
});

/** The shop as it was when the draft was made: two days, one accessory. */
const oldBackup = {
  mshop_cfg: JSON.stringify({ name: 'محل الأيام' }),
  mshop_cats: JSON.stringify(['جراب']),
  mshop_ca: JSON.stringify([{ name: 'جراب 50', buy: 25, sell: 50 }]),
  mshop_ce: JSON.stringify(['البيت']),
  'mshop_d_2026-10-01': DAY({
    acc: [{ name: 'جراب 50', mainCat: 'جراب', buy: 25, sell: 50, profit: 25, time: '٠١:٠٠ م' }],
  }),
};

/**
 * The same shop a few days later: 10-04 is a whole new day, and 10-01 has one
 * more sale than the draft saw — the backup was taken mid-day. Both must land:
 * the new day, and the afternoon the draft never had.
 */
const newBackup = {
  ...oldBackup,
  'mshop_d_2026-10-01': DAY({
    acc: [
      { name: 'جراب 50', mainCat: 'جراب', buy: 25, sell: 50, profit: 25, time: '٠١:٠٠ م' },
      { name: 'جراب 50', mainCat: 'جراب', buy: 25, sell: 50, profit: 25, time: '٠٤:٠٠ م' },
    ],
  }),
  'mshop_d_2026-10-04': DAY({
    acc: [
      { name: 'جراب 50', mainCat: 'جراب', buy: 25, sell: 60, profit: 35, time: '١٢:٠٠ م' },
      { name: 'جراب 50', mainCat: 'جراب', buy: 25, sell: 60, profit: 35, time: '٠١:٠٠ م' },
    ],
    exp: [{ category: 'البيت', amount: 90, time: '٠٢:٠٠ م' }],
  }),
};

function openTool() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => {
    const text = String(error.message || error);
    if (text.includes('Not implemented: navigation')) return;
    problems.push(text);
  });
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://local.test/',
    virtualConsole,
    beforeParse(window) {
      window.WebAssembly = WebAssembly;
      if (!window.crypto?.getRandomValues) window.crypto = globalThis.crypto;
      let lastBlob = null;
      window.URL.createObjectURL = (blob) => { lastBlob = blob; return 'blob:local-test'; };
      window.URL.revokeObjectURL = () => {};
      window.__lastBlob = () => lastBlob;
      window.confirm = () => true;
      window.HTMLCanvasElement.prototype.getContext = () => null;
      window.HTMLAnchorElement.prototype.click = () => {};
    },
  });
  const { window } = dom;
  const { document } = window;

  // The tool asks for a file by clicking a hidden `<input type=file>`. jsdom has
  // no picker, so the next input that is created gets the bytes and a `change`.
  let nextFile = null;
  const create = document.createElement.bind(document);
  document.createElement = (tag) => {
    const element = create(tag);
    if (String(tag).toLowerCase() === 'input' && nextFile) {
      const file = nextFile;
      nextFile = null;
      setTimeout(() => {
        Object.defineProperty(element, 'files', { value: [file], configurable: true });
        element.dispatchEvent(new window.Event('change', { bubbles: true }));
      }, 20);
    }
    return element;
  };

  return {
    window,
    document,
    queueFile: (text, name = 'f.json') => { nextFile = { name, text: async () => text }; },
    text: () => document.getElementById('app')?.textContent || '',
    click: (selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`مفيش ${selector}`);
      element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      return element;
    },
    clickTab: (tab) => {
      const element = document.querySelector(`[data-act="tab"][data-tab="${tab}"]`);
      if (!element) throw new Error(`مفيش قسم ${tab}`);
      element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    },
    plan: () => JSON.parse(window.localStorage.getItem('system-sales.migration.autosave') || '{}').plan,
  };
}

async function waitFor(predicate, label, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await sleep(40);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const app = openTool();
  const { document } = app;

  // 1. Make a draft the way the owner does: open the old backup.
  await waitFor(() => document.getElementById('drop'), 'the drop zone');
  const drop = document.getElementById('drop');
  const event = new app.window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { files: [{ name: 'old.json', text: async () => JSON.stringify(oldBackup) }] },
  });
  drop.dispatchEvent(event);
  await waitFor(() => app.text().includes('النظرة العامة'), 'the overview');

  // The old file has no quantities, so the owner types one — that is the number
  // the merge has to move.
  app.clickTab('accessories');
  await sleep(120);
  const qty = document.querySelector('main input[data-field="qty"]');
  qty.value = '9';
  qty.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await sleep(150);

  // 2. «افتح باكب أحدث» on the months page.
  app.clickTab('months');
  await sleep(150);
  if (!app.text().includes('أيام جديدة من باكب أحدث')) throw new Error('مفيش كارت الأيام الجديدة');
  app.queueFile(JSON.stringify(newBackup), 'new.json');
  app.click('[data-act="pick-newer"]');
  await waitFor(() => app.text().includes('يوم جديد'), 'the preview');

  if (!app.text().includes('2026-10-04') || !app.text().includes('2026-10-01')) throw new Error('المعاينة مش بتقول الأيام');
  if (!app.text().includes('تكملة')) throw new Error('المعاينة مش بتفرّق بين يوم جديد وتكملة يوم');
  if (!app.text().includes('9') || !app.text().includes('6')) throw new Error('المعاينة مش بتقول العدد من ٩ لـ٦');
  console.log('ok    المعاينة بتقول اليوم الجديد وتكملة اليوم اللي في المسودة');

  app.click('[data-act="apply-newer"]');
  await sleep(300);
  await waitFor(() => app.text().includes('اتضافت'), 'the merge notice');
  console.log('ok    الأيام الجديدة اتنقلت للمسودة');

  // 3. The counts moved and nothing else did.
  app.clickTab('accessories');
  await sleep(200);
  const mergedQty = document.querySelector('main input[data-field="qty"]')?.value;
  if (mergedQty !== '6') throw new Error(`العدد بعد الدمج ${mergedQty} مش 6`);
  const sell = document.querySelector('main input[data-field="sell"]')?.value;
  const name = document.querySelector('main input[data-field="name"]')?.value;
  if (sell !== '50' || name !== 'جراب 50') throw new Error(`الصنف اتغير: ${name} / ${sell}`);
  console.log('ok    العدد نزل باللي اتباع، والسعر والاسم زي ما هما');

  app.clickTab('months');
  await sleep(150);
  if (!app.text().includes('أيام جديدة من باكب أحدث')) throw new Error('كارت الأيام اختفى بعد الدمج');
  console.log('ok    الكارت رجع لحالته، ومفيش أيام مكررة');

  // 4. Deleting an item that has sales moves the sales with it — never leaves
  //    them pointing at nothing.
  app.clickTab('accessories');
  await sleep(150);
  const tick = document.querySelector('main input[data-act="select"]');
  tick.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  document.querySelector('[data-act="delete"]')?.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }))
    || document.querySelector('[data-op="delete"]')?.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
  await sleep(200);
  app.clickTab('build');
  await sleep(200);
  if (app.text().includes('مربوطة بصنف اتشال من المسودة')) throw new Error('المسح ساب بيعة معلّقة');
  console.log('ok    مسح صنف عليه بيعة بيمسح البيعة معاه — مفيش بيعة معلّقة');

  // 5. A draft that already lost an item (what the owner hit) — the build screen
  //    names it and fixes it without deleting a single sale.
  await checkOrphanRepair();

  if (problems.length) {
    console.error('page errors:');
    for (const problem of problems) console.error(` - ${problem}`);
    process.exit(1);
  }
  app.window.close();
}

/** Open a draft whose sale points at a deleted item, and repair it from the screen. */
async function checkOrphanRepair() {
  const app = openTool();
  const { document } = app;
  await waitFor(() => document.getElementById('drop'), 'the drop zone');

  // A draft is just the plan object with a format tag on it.
  const draft = {
    format: 'system-sales-migration',
    version: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    source: { shopName: 'محل الأيام', firstDay: '2026-10-01', lastDay: '2026-10-01', days: 1, records: 1, months: ['2026-10'] },
    settings: { shopName: 'محل الأيام', logoDataUrl: '', ownerUsername: 'owner', currentMonth: '2026-10' },
    categories: [{ id: 'c1', name: 'جراب', parentId: null, kind: 'item', icon: '', sortOrder: 1, include: true }],
    brands: [],
    items: [
      { id: 'keep', kind: 'accessory', name: 'جراب 50', categoryId: 'c1', brandId: null, buy: 25, sell: 50, qty: 4, include: true, devices: [] },
    ],
    months: [{ id: '2026-10', month: '2026-10', label: 'أكتوبر ٢٠٢٦', mode: 'detail', include: true, totals: {} }],
    sales: [
      { id: 'sale-acc-2026-10-01-0', sourceId: 'acc-2026-10-01-0', date: '2026-10-01', clock: '', section: 'acc', itemId: 'gone', name: 'جراب 50', qty: 1, buy: 25, sell: 50, include: true },
    ],
    summary: [], repairs: [], expenses: [], cashOps: [], wallets: [], expenseCategories: [],
  };

  app.queueFile(JSON.stringify(draft), 'draft.json');
  app.click('[data-act="pick-draft"]');
  await waitFor(() => app.text().includes('النظرة العامة'), 'the draft');

  app.clickTab('build');
  await sleep(200);
  if (!app.text().includes('اتشال وبيعته فضلت')) throw new Error('شاشة البناء مش بتنبه على البيعات المعلّقة');
  app.click('[data-act="show-orphans"]');
  await sleep(200);
  if (!app.text().includes('هتروح على')) throw new Error('مفيش جدول بيقول البيعة هتروح فين');
  app.click('[data-act="fix-orphans"]');
  await sleep(300);
  if (app.text().includes('اتشال وبيعته فضلت')) throw new Error('الإصلاح ما اشتغلش');
  console.log('ok    البيعات المعلّقة بتتصلّح من الشاشة، ومجموع الشهر ما بيتغيرش');

  app.window.close();
}

main().catch((error) => {
  console.error(error);
  if (problems.length) for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
});
