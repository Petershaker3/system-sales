#!/usr/bin/env node
// ثلاثة وعود على الشاشة: الشغل مبيضيعش، الوضع الليلي بيفضل على حاله، وقيمة
// العدد بتتحسب بسعر الجملة.
//
// The autosave check is the important one, and it is done the way the promise is
// actually made: a value is typed into a field and **not committed** (no `change`
// — the browser died first), then a second window is opened on the same storage
// and has to come up with that value. A test that only saved after `change` would
// pass while the real case still lost the last thing typed.
//
// Usage: node test/ui-autosave.mjs

import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const html = readFileSync(new URL('../legacy-migration.html', import.meta.url), 'utf8');
const AUTOSAVE_KEY = 'system-sales.migration.autosave';
const THEME_KEY = 'system-sales.migration.theme';

const day = (sections) => JSON.stringify({
  acc: [], used: [], cash: [], sw: [], exp: [], phones: [], repairs: [],
  ...sections,
});

const legacy = {
  mshop_cfg: JSON.stringify({ name: 'محل الحفظ' }),
  mshop_cats: JSON.stringify(['جراب']),
  mshop_ca: JSON.stringify([
    { name: 'جراب 50', buy: 240, sell: 400 },
    { name: 'سكرين HD', buy: 12, sell: 30 },
  ]),
  mshop_ce: JSON.stringify(['البيت']),
  'mshop_d_2026-10-05': day({
    acc: [{ name: 'جراب 50', mainCat: 'جراب', buy: 240, sell: 400, profit: 160, time: '٠١:٠٠ م' }],
  }),
};

const problems = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A window of the real tool. `seed` is what this browser already had stored. */
function openTool(seed = {}) {
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
      window.URL.createObjectURL = () => 'blob:local-test';
      window.URL.revokeObjectURL = () => {};
      window.confirm = () => true;
      window.HTMLCanvasElement.prototype.getContext = () => null;
      window.HTMLAnchorElement.prototype.click = () => {};
      for (const [key, value] of Object.entries(seed)) window.localStorage.setItem(key, value);
    },
  });
  const { document } = dom.window;
  return {
    dom,
    window: dom.window,
    document,
    text: () => document.getElementById('app')?.textContent || '',
    click: (selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`مفيش ${selector}`);
      element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      return element;
    },
    clickTab: (tab) => {
      const element = document.querySelector(`[data-act="tab"][data-tab="${tab}"]`);
      if (!element) throw new Error(`مفيش قسم ${tab}`);
      element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    },
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
  const { window, document } = app;

  // ── 1. The screen opens, and the save chip says nothing has happened yet ──
  await waitFor(() => document.getElementById('drop'), 'the drop zone');
  if (!document.querySelector('[data-act="theme"]')) throw new Error('مفيش زرار الوضع الليلي على شاشة البداية');
  if (document.querySelector('#save-chip')) throw new Error('خانة الحفظ ظاهرة قبل ما يبقى فيه شغل أصلًا');
  console.log('ok    شاشة البداية فيها زرار الوضع الليلي، ومفيش حالة حفظ قبل الشغل');

  // ── 2. Dark mode flips, and is remembered ─────────────────────────────────
  app.click('[data-act="theme"]');
  await sleep(120);
  if (document.documentElement.dataset.theme !== 'dark') throw new Error('الوضع الليلي مافيش اشتغل');
  if (window.localStorage.getItem(THEME_KEY) !== 'dark') throw new Error('الوضع الليلي ماتحفظش للفتحة الجاية');
  if (!app.text().includes('الوضع النهاري')) throw new Error('الزرار مش بيقول إزاي ترجع');
  app.click('[data-act="theme"]');
  await sleep(120);
  if (document.documentElement.dataset.theme !== 'light') throw new Error('الرجوع للوضع النهاري مافيش اشتغل');
  console.log('ok    الوضع الليلي بيتقلّب ويفضل محفوظ');

  app.click('[data-act="theme"]');
  await sleep(80);

  // ── 3. Open the shop's backup ─────────────────────────────────────────────
  const drop = document.getElementById('drop');
  const event = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { files: [{ name: 'legacy.json', text: async () => JSON.stringify(legacy) }] },
  });
  drop.dispatchEvent(event);
  await waitFor(() => app.text().includes('النظرة العامة'), 'the overview');
  if (!document.getElementById('save-chip')) throw new Error('مفيش خانة حالة الحفظ بعد ما الشغل بدأ');

  // ── 4. قيمة العدد بسعر الجملة، مش سعر البيع ───────────────────────────────
  app.clickTab('accessories');
  await sleep(120);
  const row = () => [...document.querySelectorAll('main tbody tr')]
    .find((tr) => tr.querySelector('input[data-field="name"]')?.value === 'جراب 50');
  const quantity = row().querySelector('input[data-field="qty"]');
  quantity.value = '3';
  quantity.dispatchEvent(new window.Event('input', { bubbles: true }));
  // Typed, not committed: the browser closes here. No `change` is ever sent.
  await sleep(1200);

  const stored = window.localStorage.getItem(AUTOSAVE_KEY);
  if (!stored) throw new Error('مفيش حاجة اتحفظت تلقائيًا');
  const saved = JSON.parse(stored);
  const savedItem = saved.plan.items.find((item) => item.name === 'جراب 50');
  if (savedItem.qty !== 3) throw new Error(`العدد اللي في الحفظ ${savedItem.qty} مش 3 — الكتابة اللي مخلصتش ضاعت`);
  console.log('ok    العدد اللي اتكتب ولسه مخرجش من الخانة اتحفظ');

  // The value column reads the wholesale price: 3 × 240, never 3 × 400.
  quantity.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(200);
  const cells = [...row().querySelectorAll('td')].map((td) => td.textContent.trim());
  if (!cells.includes('720')) throw new Error(`قيمة العدد مش بسعر الجملة: ${cells.join(' | ')}`);
  if (cells.includes('1200')) throw new Error('قيمة العدد لسه بتتحسب بسعر البيع');
  console.log('ok    قيمة العدد = العدد × سعر الجملة');

  // ── 5. زر الحفظ بيقول إنه حفظ ─────────────────────────────────────────────
  app.click('[data-act="save-now"]');
  await sleep(200);
  if (!/اتحفظ/.test(app.text())) throw new Error('زرار الحفظ مش بيقول إنه حفظ');
  const chip = document.getElementById('save-chip').textContent;
  if (!/اتحفظ \d{2}:\d{2}/.test(chip)) throw new Error(`حالة الحفظ مش واضحة: ${chip}`);
  console.log('ok    زرار «حفظ» بيحفظ فورًا وبيقول الساعة كام');

  // ── 6. A second window comes up with the work, not with an empty screen ───
  const seed = {
    [AUTOSAVE_KEY]: window.localStorage.getItem(AUTOSAVE_KEY),
    [THEME_KEY]: window.localStorage.getItem(THEME_KEY),
  };
  window.close();

  const again = openTool(seed);
  await waitFor(() => again.text().includes('رجّعت الشغل'), 'the restore notice', 30000);
  await sleep(200);
  if (again.document.documentElement.dataset.theme !== 'dark') throw new Error('الوضع الليلي مارجعش مع الشغل');
  if (!again.document.querySelector('[data-act="tab"][data-tab="accessories"]')) throw new Error('مارجعش لقسم الإكسسوارات');
  again.clickTab('accessories');
  await sleep(200);
  const restoredQty = [...again.document.querySelectorAll('main input[data-field="qty"]')][0]?.value;
  if (restoredQty !== '3') throw new Error(`العدد رجع ${restoredQty} مش 3`);
  console.log('ok    فتحت الأداة تاني والشغل رجع زي ما هو (والوضع الليلي معاه)');

  // ── 7. «ابدأ من جديد» بيمسح المحفوظ فعلًا ─────────────────────────────────
  again.clickTab('settings');
  await sleep(150);
  const stamp = again.document.getElementById('settings-saved-at');
  if (!stamp || !/\d{2}:\d{2}/.test(stamp.textContent)) throw new Error('كارت الحفظ مش بيقول آخر حفظ امتى');
  console.log('ok    كارت «الحفظ والوضع الليلي» بيقول آخر حفظ امتى');
  const startOver = again.document.querySelector('[data-act="start-over"]');
  if (!startOver) throw new Error('مفيش زرار «ابدأ من جديد» في الإعدادات');
  startOver.dispatchEvent(new again.window.MouseEvent('click', { bubbles: true }));
  await sleep(250);
  if (again.window.localStorage.getItem(AUTOSAVE_KEY)) throw new Error('«ابدأ من جديد» مامسحش الشغل المحفوظ');
  if (!again.document.getElementById('drop')) throw new Error('مارجعش لشاشة فتح الباكب');
  console.log('ok    «ابدأ من جديد» بيمسح المحفوظ ويرجع لشاشة البداية');

  // ── 8. نافذة تانية بتحفظ: الأداة بتقول، مش بتسكت ───────────────────────────
  const second = openTool({ [AUTOSAVE_KEY]: window.localStorage.getItem(AUTOSAVE_KEY) });
  await waitFor(() => second.text().includes('رجّعت الشغل'), 'restore in the second window');
  // Putting the work back is not an edit: the stored copy stays exactly as it was.
  await sleep(1200);
  if (second.window.localStorage.getItem(AUTOSAVE_KEY) !== window.localStorage.getItem(AUTOSAVE_KEY)) {
    throw new Error('مجرد فتح الأداة بيكتب حفظ جديد');
  }
  const storageEvent = new second.window.StorageEvent('storage', {
    key: AUTOSAVE_KEY,
    newValue: '{}',
    storageArea: second.window.localStorage,
  });
  second.window.dispatchEvent(storageEvent);
  await sleep(200);
  if (!second.text().includes('نافذة تانية')) throw new Error('ماحذّرش من النافذتين');
  // …and the warning itself must not start a save, or two windows would keep
  // writing over each other in a loop.
  const beforeSecond = second.window.localStorage.getItem(AUTOSAVE_KEY);
  await sleep(1400);
  if (second.window.localStorage.getItem(AUTOSAVE_KEY) !== beforeSecond) {
    throw new Error('التحذير من النافذة التانية بينشر حفظ جديد — حلقة مفرغة');
  }
  console.log('ok    لو نافذة تانية بتحفظ، الأداة بتحذّر بدل ما تسكت — ومن غير حلقة حفظ');
  second.window.close();

  again.window.close();

  if (problems.length) {
    console.error('page errors:');
    for (const problem of problems) console.error(` - ${problem}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  if (problems.length) for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
});
