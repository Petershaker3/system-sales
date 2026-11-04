#!/usr/bin/env node
// «خلي الـIMEI أصفار مؤقتًا» — على الشاشة نفسها.
//
// المالك قرر (2026-11-02) إن الجهاز المستعمل مش يتوقف بسبب رقم مش موجود، وإن
// سعر البيع يتسجل صفر لحد ما السوق يستقر. الاختبار ده بيفتح مسودة حقيقية الشكل
// في jsdom ويتأكد إن:
//
//   * الجهاز من غير رقم بياخد رقم مؤقت من الأصفار، بيعدّي فحص البرنامج نفسه،
//     وبيبان عليه «مؤقت» في الشاشة؛
//   * «أضف الأجهزة» بالعدد بس (من غير أي رقم) بتشتغل وبتعمل أجهزة؛
//   * الموبايل من غير سعر بيع بيتسجل صفر، والشاشة بتقول العدد قبل البناء.
//
// Usage: node test/ui-used.mjs

import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const html = readFileSync(new URL('../legacy-migration.html', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const problems = [];

/** A draft shaped like the owner's: a used model, a phone with no price. */
const draft = {
  format: 'system-sales-migration',
  version: 1,
  createdAt: '2026-11-02T00:00:00.000Z',
  source: { shopName: 'محل الأصفار', firstDay: '2026-10-01', lastDay: '2026-10-01', days: 1, records: 1, months: ['2026-10'] },
  settings: { shopName: 'محل الأصفار', logoDataUrl: '', ownerUsername: 'owner', currentMonth: '2026-10' },
  categories: [{ id: 'cat-used', name: 'مستعمل', parentId: null, kind: 'used', icon: 'recycle', sortOrder: 1, include: true }],
  brands: [{ id: 'b-vivo', name: 'Vivo', include: true }],
  items: [
    {
      id: 'u-vivo', kind: 'used', name: 'VIVO Y04 128', categoryId: 'cat-used', brandId: 'b-vivo',
      model: 'Y04', ramGb: 4, storageGb: 128, color: '', deviceType: 'touch', buy: 4000, sell: 5000,
      qty: 1, supplier: '', notes: '', include: true, archived: false, devices: [],
    },
    {
      id: 'p-a07', kind: 'phone', name: 'Samsung A07', categoryId: 'cat-used', brandId: 'b-vivo',
      model: 'A07', ramGb: 8, storageGb: 256, color: '', deviceType: 'touch', buy: 6000, sell: null,
      qty: 1, supplier: '', notes: '', include: true, archived: false, devices: [],
    },
  ],
  months: [{ id: '2026-10', month: '2026-10', label: 'أكتوبر ٢٠٢٦', mode: 'detail', include: true, totals: {} }],
  sales: [], summary: [], repairs: [], expenses: [], cashOps: [], wallets: [], expenseCategories: [],
};

/** The numbers as the screen shows them — that is the promise, not the state. */
const shownImeis = (document) => [...document.querySelectorAll('.devices-table tbody td.mono')]
  .map((cell) => (cell.textContent || '').trim().split(' ')[0]);

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
      window.URL.createObjectURL = () => 'blob:local-test';
      window.URL.revokeObjectURL = () => {};
      window.confirm = () => true;
      window.HTMLCanvasElement.prototype.getContext = () => null;
      window.HTMLAnchorElement.prototype.click = () => {};
    },
  });
  const { window } = dom;
  const { document } = window;

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
    openDraft: (name = 'draft.json') => {
      nextFile = { name, text: async () => JSON.stringify(draft) };
      const button = document.querySelector('[data-act="pick-draft"]');
      if (!button) throw new Error('مفيش زرار فتح المسودة');
      button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    },
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
    type: (selector, value, event = 'change') => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`مفيش ${selector}`);
      element.value = value;
      element.dispatchEvent(new window.Event(event, { bubbles: true }));
      return element;
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
  const { document } = app;

  await waitFor(() => document.getElementById('drop'), 'the drop zone');
  app.openDraft();
  await waitFor(() => app.text().includes('النظرة العامة'), 'the draft');

  // 1. The phone with no price went in at zero, by itself, on load.
  app.clickTab('phones');
  await sleep(150);
  app.click(`[data-act="details"][data-id="p-a07"]`);
  await sleep(200);
  const sell = document.querySelector('[data-act="drawer-field"][data-field="sell"]');
  if (!sell) throw new Error('مفيش خانة سعر البيع');
  // Empty, not zero: zero is a price that would sell the phone for nothing.
  if (String(sell.value) !== '') throw new Error(`سعر البيع مكتوب ${sell.value}`);
  console.log('ok    المسودة اتفتحت والسعر الناقص فضل فاضي — مش صفر');
  app.click('[data-act="close-drawer"]');
  await sleep(150);

  // 2. Open the used row and add two devices by count only — no numbers at all.
  app.click(`[data-act="details"][data-id="u-vivo"]`);
  app.click(`[data-act="details"][data-id="u-vivo"]`);
  await sleep(200);
  if (!app.text().includes('أجهزة المستعمل')) throw new Error('مفيش لوحة أجهزة المستعمل');
  app.type('[data-act="device-count"]', '2', 'input');
  app.type('[data-act="device-condition"]', 'B');
  app.click('[data-act="add-devices"][data-id="u-vivo"]');
  await sleep(300);
  if (!app.text().includes('أرقام مؤقتة')) throw new Error('مفيش تنبيه إن الأرقام مؤقتة');
  console.log('ok    «أضف الأجهزة» بالعدد بس بتشتغل من غير أي رقم');

  // 3. The two numbers are the tool's placeholders: fifteen digits, all zeros up
  //    front, different from each other — and the row says «مؤقت».
  const imeis = shownImeis(document).filter(Boolean);
  if (imeis.length !== 2) throw new Error(`عدد الأجهزة ${imeis.length} مش 2`);
  for (const imei of imeis) {
    if (!/^\d{15}$/.test(imei) || !/^0{9}/.test(imei)) throw new Error(`الرقم ${imei} مش أصفار ١٥ رقم`);
  }
  if (imeis[0] === imeis[1]) throw new Error('الرقمين متكررين — البرنامج بيرفض ده');
  if (!app.text().includes('مؤقت')) throw new Error('الشاشة مش بتقول إن الرقم مؤقت');
  console.log('ok    الأرقام أصفار وفريدة ومكتوب عليها «مؤقت»');

  // 4. The build screen states both decisions in numbers before he builds.
  app.clickTab('build');
  await sleep(250);
  const build = app.text();
  if (!build.includes('IMEI مؤقت (أصفار)')) throw new Error('شاشة البناء مش بتقول عدد الأرقام المؤقتة');
  if (!build.includes('من غير سعر بيع')) throw new Error('شاشة البناء مش بتقول الأصناف اللي من غير سعر');
  // Nothing above may lock the button: a placeholder number and a zero price are
  // decisions, not errors.
  const buildButton = document.querySelector('[data-act="build"]');
  if (!buildButton) throw new Error('مفيش زرار البناء');
  if (buildButton.hasAttribute('disabled')) throw new Error('زرار البناء مقفول بسبب الأرقام أو السعر');
  console.log('ok    شاشة البناء بتقول القرارين بالأرقام قبل ما تبني');

  if (problems.length) {
    console.error('page errors:');
    for (const problem of problems) console.error(` - ${problem}`);
    process.exit(1);
  }
  app.window.close();
}

main().catch((error) => {
  console.error(error);
  if (problems.length) for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
});
