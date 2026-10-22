// The screen.
//
// One page, no framework, no network. It reads the old backup, shows what the
// tool understood, lets the owner add, change, delete, move and choose rows,
// and then writes the new system's backup file in the browser.
//
// Everything the screen shows comes from `plan` — the same object the builder
// writes and the tests check. There is no second copy of the data and no hidden
// state: an edit is a change to the plan, and Undo is the inverse of that change.

import initSqlJs from 'sql.js';
import wasmBase64 from 'virtual:sql-wasm';

import { preparePlan, buildFromPlan, backupFileName } from './pipeline.mjs';
import { buildDefaultPlan, validatePlan, planTotals, CATEGORY_ICONS } from './plan.mjs';
import { buildReport } from './report.mjs';
import { monthLabel, nameKey, newId, normalizeText } from './util.mjs';

const PAGE_SIZE = 120;

const state = {
  view: 'load',
  tab: 'overview',
  plan: null,
  legacy: null,
  problems: [],
  history: [],
  future: [],
  page: {},
  filters: { search: '', kind: 'all', category: 'all', month: 'all', repairKind: 'all' },
  password: '',
  password2: '',
  includeLogo: true,
  fastKdf: false,
  built: null,
  building: false,
  notice: null,
  sql: null,
};

// ── Small formatting helpers ───────────────────────────────────────────────
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

const money = (value) => `${(Number(value) || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const num = (value) => (Number(value) || 0).toLocaleString('en-US');
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Uint8Array ? new Blob([data], { type }) : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ── History: every edit is an action with its own inverse ─────────────────
function perform(action) {
  action.do();
  state.history.push(action);
  if (state.history.length > 200) state.history.shift();
  state.future.length = 0;
}

function undo() {
  const action = state.history.pop();
  if (!action) return;
  action.undo();
  state.future.push(action);
  render();
}

function redo() {
  const action = state.future.pop();
  if (!action) return;
  action.do();
  state.history.push(action);
  render();
}

function collection(name) {
  return state.plan[name];
}

function recordOf(name, id) {
  return collection(name).find((row) => row.id === id);
}

function editRecord(name, id, patch) {
  const record = recordOf(name, id);
  if (!record) return;
  const before = {};
  for (const key of Object.keys(patch)) before[key] = record[key];
  perform({
    do: () => Object.assign(record, patch),
    undo: () => Object.assign(record, before),
  });
}

function addRecord(name, record) {
  perform({
    do: () => collection(name).push(record),
    undo: () => {
      const list = collection(name);
      const index = list.findIndex((row) => row.id === record.id);
      if (index >= 0) list.splice(index, 1);
    },
  });
}

function deleteRecord(name, id) {
  const list = collection(name);
  const index = list.findIndex((row) => row.id === id);
  if (index < 0) return;
  const [record] = list.splice(index, 1);
  perform({
    do: () => {
      const current = collection(name);
      const at = current.findIndex((row) => row.id === id);
      if (at >= 0) current.splice(at, 1);
    },
    undo: () => {
      const current = collection(name);
      if (!current.some((row) => row.id === id)) current.splice(Math.min(index, current.length), 0, record);
    },
  });
}

function bulkInclude(name, ids, value) {
  const list = collection(name);
  const before = new Map();
  for (const row of list) if (ids.includes(row.id)) before.set(row.id, row.include);
  const apply = (target) => {
    for (const row of list) if (before.has(row.id)) row.include = target;
  };
  perform({
    do: () => apply(value),
    undo: () => { for (const row of list) if (before.has(row.id)) row.include = before.get(row.id); },
  });
}

function bulkPatch(name, ids, patch) {
  const list = collection(name);
  const before = new Map();
  for (const row of list) {
    if (!ids.includes(row.id)) continue;
    const snapshot = {};
    for (const key of Object.keys(patch)) snapshot[key] = row[key];
    before.set(row.id, snapshot);
  }
  const run = () => { for (const row of list) if (before.has(row.id)) Object.assign(row, patch); };
  perform({
    do: run,
    undo: () => { for (const row of list) if (before.has(row.id)) Object.assign(row, before.get(row.id)); },
  });
}

function bulkDelete(name, ids) {
  const list = collection(name);
  const removed = list
    .map((row, index) => ({ row, index }))
    .filter((entry) => ids.includes(entry.row.id));
  const run = () => {
    const current = collection(name);
    for (const entry of removed) {
      const index = current.findIndex((row) => row.id === entry.row.id);
      if (index >= 0) current.splice(index, 1);
    }
  };
  perform({
    do: run,
    undo: () => {
      const current = collection(name);
      for (const entry of [...removed].sort((a, b) => a.index - b.index)) {
        if (!current.some((row) => row.id === entry.row.id)) {
          current.splice(Math.min(entry.index, current.length), 0, entry.row);
        }
      }
    },
  });
}

// ── Reading the file ──────────────────────────────────────────────────────
async function loadLegacyFile(file) {
  try {
    const text = await file.text();
    const prepared = preparePlan(text, {});
    if (!prepared.ok) {
      state.notice = { level: 'danger', text: 'الملف ده مش باكب السيستم القديم (مش JSON سليم).' };
      render();
      return;
    }
    state.plan = prepared.plan;
    state.legacy = prepared.legacy;
    state.problems = prepared.problems;
    state.view = 'review';
    state.tab = 'overview';
    state.history = [];
    state.future = [];
    state.built = null;
    state.notice = null;
    render();
  } catch (error) {
    state.notice = { level: 'danger', text: `تعذّر فتح الملف: ${error.message}` };
    render();
  }
}

function loadDraft(file) {
  file.text().then((text) => {
    try {
      const plan = JSON.parse(text);
      if (plan.format !== 'system-sales-migration') throw new Error('الملف مش مسودة الأداة.');
      state.plan = plan;
      state.view = 'review';
      state.history = [];
      state.future = [];
      state.built = null;
      state.notice = { level: 'info', text: 'فتحت المسودة. كمّل من أي تاب وابنِ النسخة.' };
      render();
    } catch (error) {
      state.notice = { level: 'danger', text: `تعذّر فتح المسودة: ${error.message}` };
      render();
    }
  });
}

// ── Month conversions ─────────────────────────────────────────────────────
// Turning a detailed month into a summary is one-way arithmetic: the detail can
// be grouped, but a group cannot be split back into sales that were never kept.
// So «مجمّع» is available from a detailed month, and going the other way rebuilds
// the whole plan around that month (which the owner is told about first).
function convertDetailToSummary(month) {
  const beforeSales = state.plan.sales.slice();
  const beforeSummary = state.plan.summary.slice();
  const rows = beforeSales.filter((sale) => sale.date.startsWith(month));
  if (!rows.length) return;
  const itemById = new Map(state.plan.items.map((item) => [item.id, item]));
  const categoryName = new Map(state.plan.categories.map((category) => [category.id, category.name]));
  const grouped = new Map();
  for (const sale of rows) {
    const item = itemById.get(sale.itemId);
    const label = sale.section === 'acc'
      ? (categoryName.get(item?.categoryId) || sale.name)
      : sale.section === 'used' ? 'مستعمل' : sale.name;
    const key = `${sale.section}:${nameKey(label)}`;
    const entry = grouped.get(key) || {
      id: `sum-${month}-${sale.section}-${nameKey(label)}`,
      month,
      section: sale.section,
      label,
      categoryId: item?.categoryId ?? null,
      count: 0,
      qty: 0,
      total: 0,
      cost: 0,
      include: true,
    };
    entry.count += 1;
    entry.qty += sale.qty;
    entry.total += sale.sell * sale.qty;
    entry.cost += sale.buy * sale.qty;
    grouped.set(key, entry);
  }
  const nextSales = beforeSales.filter((sale) => !sale.date.startsWith(month));
  const nextSummary = [...beforeSummary.filter((row) => row.month !== month), ...grouped.values()];
  perform({
    do: () => { state.plan.sales = nextSales; state.plan.summary = nextSummary; },
    undo: () => { state.plan.sales = beforeSales; state.plan.summary = beforeSummary; },
  });
}

function rebuildPlanAround(month) {
  if (!state.legacy) {
    state.notice = { level: 'warn', text: 'مفيش باكب مفتوح، فمش ممكن أعيد بناء الخطة. افتح الباكب تاني.' };
    return;
  }
  const plan = buildDefaultPlan(state.legacy, { currentMonth: month, pastMode: 'summary' });
  const before = state.plan;
  perform({ do: () => { state.plan = plan; }, undo: () => { state.plan = before; } });
  // Earlier actions point at rows of the old plan; keeping them would make Undo
  // edit an object nobody is looking at.
  state.history = [];
  state.future = [];
  state.notice = { level: 'info', text: `أعدت بناء الخطة: ${monthLabel(month)} بقى تفصيلي، والباقي مجمّع. أي تعديلات سابقة اتمسحت.` };
}

// ── Derived views ─────────────────────────────────────────────────────────
function filteredAndPaged(name, rows, match) {
  const query = normalizeText(state.filters.search).toLowerCase();
  const filtered = query ? rows.filter((row) => match(row).toLowerCase().includes(query)) : rows;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(state.page[name] || 1, pageCount);
  const slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return { filtered, slice, page, pageCount };
}

function pager(name, page, pageCount, total) {
  if (pageCount <= 1) return `<div class="pager">${num(total)} صف</div>`;
  return `<div class="pager">
    <button class="small" data-act="page" data-name="${name}" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>السابق</button>
    <span>صفحة ${page} من ${pageCount} — ${num(total)} صف</span>
    <button class="small" data-act="page" data-name="${name}" data-page="${page + 1}" ${page >= pageCount ? 'disabled' : ''}>التالي</button>
  </div>`;
}

function categoryOptions(selected) {
  return `<option value="">— بدون تصنيف —</option>${state.plan.categories
    .filter((category) => category.include)
    .map((category) => `<option value="${esc(category.id)}" ${category.id === selected ? 'selected' : ''}>${esc(category.name)}</option>`)
    .join('')}`;
}

function brandOptions(selected) {
  return `<option value="">— بدون شركة —</option>${state.plan.brands
    .filter((brand) => brand.include)
    .map((brand) => `<option value="${esc(brand.id)}" ${brand.id === selected ? 'selected' : ''}>${esc(brand.name)}</option>`)
    .join('')}`;
}

function tabCounts() {
  const plan = state.plan;
  if (!plan) return {};
  return {
    categories: plan.categories.length,
    brands: plan.brands.length,
    items: plan.items.length,
    months: plan.months.length,
    sales: plan.sales.length,
    repairs: plan.repairs.length,
    expenses: plan.expenses.length,
    wallets: plan.wallets.length,
  };
}

// ── Views ─────────────────────────────────────────────────────────────────
function viewLoad() {
  return `<div class="card">
    <div class="drop" id="drop">
      <h2>افتح باكب السيستم القديم</h2>
      <p>ملف <span class="mono">.json</span> اللي البرنامج القديم بيطلّعه (زي <span class="mono">محل_كل_البيانات.json</span>).</p>
      <p class="hint">اسحب الملف هنا، أو</p>
      <p><button class="primary" data-act="pick-legacy">اختار الملف من الجهاز</button></p>
      <p class="hint" style="margin-top:18px">الأداة بتشتغل على جهازك بس. مفيش بيانات بتطلع على الإنترنت.</p>
    </div>
    <div class="row between" style="margin-top:14px">
      <span class="muted small">عندك مسودة شغل من قبل؟</span>
      <button class="small" data-act="pick-draft">افتح مسودة (JSON)</button>
    </div>
  </div>
  ${state.notice ? note(state.notice) : ''}`;
}

function note(notice) {
  return `<div class="note ${notice.level}">${esc(notice.text)}</div>`;
}

function viewOverview() {
  const plan = state.plan;
  const totals = planTotals(plan);
  const validation = validatePlan(plan);
  const errors = validation.findings.filter((finding) => finding.level === 'error');
  const warnings = validation.findings.filter((finding) => finding.level === 'warn');
  const source = plan.source;
  return `
  ${state.notice ? note(state.notice) : ''}
  <div class="card">
    <h2>النظرة العامة</h2>
    <p class="lead">ده اللي الأداة فهمته من الباكب، واللي هيتنقل للسيستم الجديد.</p>
    <div class="grid-2">
      <div class="stat"><span>المحل</span><b>${esc(plan.settings.shopName)}</b></div>
      <div class="stat"><span>الفترة</span><b>${esc(source.firstDay || '—')} ← ${esc(source.lastDay || '—')}</b></div>
      <div class="stat"><span>أيام فيها حركة</span><b>${num(source.days)}</b></div>
      <div class="stat"><span>حركات في الملف القديم</span><b>${num(source.records)}</b></div>
    </div>
    <div class="grid-2" style="margin-top:12px">
      <div class="stat"><span>مبيعات الشهر التفصيلي</span><b>${money(totals.saleTotal)} ج</b></div>
      <div class="stat"><span>أرباح الشهر التفصيلي</span><b>${money(totals.saleProfit)} ج</b></div>
      <div class="stat"><span>مبيعات الشهور المجمّعة</span><b>${money(totals.summaryTotal)} ج</b></div>
      <div class="stat"><span>أرباح الشهور المجمّعة</span><b>${money(totals.summaryProfit)} ج</b></div>
      <div class="stat"><span>مصاريف</span><b>${money(totals.expenseTotal)} ج</b></div>
      <div class="stat"><span>صيانة وسوفت وير</span><b>${money(totals.repairTotal)} ج</b></div>
    </div>
  </div>

  <div class="card">
    <h2>اللي هيتنقل</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>العنصر</th><th class="num">مختار</th><th class="num">إجمالي</th><th></th></tr></thead>
      <tbody>
        ${[
          ['التصنيفات', 'categories', validation.includes.categories],
          ['الماركات', 'brands', validation.includes.brands],
          ['الأصناف', 'items', validation.includes.items],
          ['المبيعات التفصيلية', 'sales', validation.includes.sales],
          ['ملخّصات الشهور', 'summary', validation.includes.summary],
          ['الصيانة والسوفت وير', 'repairs', validation.includes.repairs],
          ['المصاريف', 'expenses', validation.includes.expenses],
          ['المحافظ', 'wallets', validation.includes.wallets],
        ].map(([label, key, count]) => `<tr>
          <td>${label}</td>
          <td class="num">${num(count)}</td>
          <td class="num">${num(plan[key].length)}</td>
          <td><button class="small ghost" data-act="tab" data-tab="${key === 'sales' || key === 'summary' ? 'months' : key === 'repairs' ? 'repairs' : key}">افتح</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </div>

  <div class="card">
    <h2>الفحص</h2>
    ${errors.length ? `<div class="note danger"><b>${errors.length} مشكلة لازم تتصلح قبل البناء.</b><ul class="findings">${errors.slice(0, 8).map((finding) => `<li class="error">${esc(finding.message)}</li>`).join('')}</ul></div>` : `<div class="note info">مفيش أخطاء تمنع البناء.${warnings.length ? ` فيه ${warnings.length} تنبيه للمراجعة.` : ''}</div>`}
    <div class="row" style="margin-top:12px">
      <button class="primary" data-act="tab" data-tab="build">روح لبناء النسخة</button>
      <button data-act="tab" data-tab="months">راجع الشهور</button>
      <button class="ghost" data-act="save-draft">حفظ مسودة</button>
    </div>
  </div>`;
}

function viewCategories() {
  const { filtered, slice, page, pageCount } = filteredAndPaged('categories', state.plan.categories, (row) => `${row.name} ${row.kind}`);
  const kinds = { item: 'بضاعة بالعدد', phone: 'موبايلات جديدة', used: 'مستعمل' };
  const mains = state.plan.categories.filter((category) => !category.parentId);
  return `
  <div class="card">
    <h2>التصنيفات</h2>
    <p class="lead">التصنيف في السيستم الجديد هو نفسه قسم الصنف. تقدر تضيف، تعدّل، تشيل، وتنقل تصنيف تحت تصنيف أب.</p>
    <div class="row" style="margin-bottom:10px">
      <input type="text" class="grow" placeholder="دوّر بالاسم…" data-act="search" value="${esc(state.filters.search)}">
      <button data-act="add-category">+ تصنيف جديد</button>
      <button class="small" data-act="bulk" data-coll="categories" data-op="include">اشمل الظاهر</button>
      <button class="small" data-act="bulk" data-coll="categories" data-op="exclude">استبعد الظاهر</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th></th><th>الاسم</th><th>النوع</th><th>تحت تصنيف</th><th>الأيقونة</th><th class="num">الترتيب</th><th>الأصناف</th><th></th></tr></thead>
      <tbody>
        ${slice.map((category) => {
          const count = state.plan.items.filter((item) => item.categoryId === category.id).length;
          return `<tr class="${category.include ? '' : 'excluded'}">
            <td><input type="checkbox" ${category.include ? 'checked' : ''} data-act="include" data-coll="categories" data-id="${esc(category.id)}" title="يتنقل"></td>
            <td><input type="text" value="${esc(category.name)}" data-act="field" data-coll="categories" data-id="${esc(category.id)}" data-field="name"></td>
            <td><select data-act="field" data-coll="categories" data-id="${esc(category.id)}" data-field="kind" ${category.parentId ? 'disabled title="بياخد نوع الأب"' : ''}>
              ${Object.entries(kinds).map(([value, label]) => `<option value="${value}" ${category.kind === value ? 'selected' : ''}>${label}</option>`).join('')}
            </select></td>
            <td><select data-act="field" data-coll="categories" data-id="${esc(category.id)}" data-field="parentId">
              <option value="">— تصنيف رئيسي —</option>
              ${mains.filter((main) => main.id !== category.id).map((main) => `<option value="${esc(main.id)}" ${category.parentId === main.id ? 'selected' : ''}>${esc(main.name)}</option>`).join('')}
            </select></td>
            <td><select data-act="field" data-coll="categories" data-id="${esc(category.id)}" data-field="icon">
              ${CATEGORY_ICONS.map((icon) => `<option value="${icon}" ${category.icon === icon ? 'selected' : ''}>${icon}</option>`).join('')}
            </select></td>
            <td class="num"><input type="number" value="${category.sortOrder}" data-act="field" data-coll="categories" data-id="${esc(category.id)}" data-field="sortOrder" data-type="int" style="width:80px"></td>
            <td><span class="badge plain">${num(count)}</span></td>
            <td class="actions"><button class="small danger" data-act="del" data-coll="categories" data-id="${esc(category.id)}">حذف</button></td>
          </tr>`;
        }).join('') || emptyRow(8, 'مفيش تصنيفات مطابقة.')}
      </tbody>
    </table></div>
    ${pager('categories', page, pageCount, filtered.length)}
  </div>`;
}

function viewBrands() {
  const { filtered, slice, page, pageCount } = filteredAndPaged('brands', state.plan.brands, (row) => row.name);
  const types = { touch: 'تاتش', keypad: 'زراير', both: 'الاتنين' };
  return `
  <div class="card">
    <h2>الماركات</h2>
    <p class="lead">شركات الموبايلات. السيستم الجديد بيسأل على نوع الجهاز عشان «صنف جديد» يعرف يطلب إيه.</p>
    <div class="row" style="margin-bottom:10px">
      <input type="text" class="grow" placeholder="دوّر بالاسم…" data-act="search" value="${esc(state.filters.search)}">
      <button data-act="add-brand">+ ماركة جديدة</button>
      <button class="small" data-act="bulk" data-coll="brands" data-op="include">اشمل الظاهر</button>
      <button class="small" data-act="bulk" data-coll="brands" data-op="exclude">استبعد الظاهر</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th></th><th>الاسم</th><th>النوع</th><th class="num">الترتيب</th><th>أصناف</th><th></th></tr></thead>
      <tbody>
        ${slice.map((brand) => {
          const count = state.plan.items.filter((item) => item.brandId === brand.id).length;
          return `<tr class="${brand.include ? '' : 'excluded'}">
            <td><input type="checkbox" ${brand.include ? 'checked' : ''} data-act="include" data-coll="brands" data-id="${esc(brand.id)}"></td>
            <td><input type="text" value="${esc(brand.name)}" data-act="field" data-coll="brands" data-id="${esc(brand.id)}" data-field="name"></td>
            <td><select data-act="field" data-coll="brands" data-id="${esc(brand.id)}" data-field="deviceType">
              ${Object.entries(types).map(([value, label]) => `<option value="${value}" ${brand.deviceType === value ? 'selected' : ''}>${label}</option>`).join('')}
            </select></td>
            <td class="num"><input type="number" value="${brand.sortOrder}" data-act="field" data-coll="brands" data-id="${esc(brand.id)}" data-field="sortOrder" data-type="int" style="width:80px"></td>
            <td><span class="badge plain">${num(count)}</span></td>
            <td class="actions"><button class="small danger" data-act="del" data-coll="brands" data-id="${esc(brand.id)}">حذف</button></td>
          </tr>`;
        }).join('') || emptyRow(6, 'مفيش ماركات مطابقة.')}
      </tbody>
    </table></div>
    ${pager('brands', page, pageCount, filtered.length)}
  </div>`;
}

function viewItems() {
  const kindFilter = state.filters.kind;
  const categoryFilter = state.filters.category;
  let rows = state.plan.items;
  if (kindFilter !== 'all') rows = rows.filter((item) => item.kind === kindFilter);
  if (categoryFilter !== 'all') rows = rows.filter((item) => (item.categoryId || '') === categoryFilter);
  const { filtered, slice, page, pageCount } = filteredAndPaged('items', rows, (row) => `${row.name} ${row.model}`);
  const added = state.plan.items.filter((item) => item.priceSource === 'daily-sales').length;
  const kinds = { accessory: 'إكسسوار', phone: 'موبايل', used: 'مستعمل' };
  return `
  <div class="card">
    <h2>الأصناف</h2>
    <p class="lead">
      ${num(state.plan.items.length)} صنف: الإكسسوارات من كتالوج القديم (${num(state.plan.items.filter((item) => item.priceSource === 'mshop_ca').length)}،
      الموبايلات من المخزن (${num(state.plan.items.filter((item) => item.priceSource === 'mshop_inventory').length)},
      وأصناف ظهرت في مبيعات الشهر (${num(added)}).
      <b>الكمية هي اللي عندك دلوقتي</b> — القديم مكانش بيسجّل كمية للإكسسوارات، فاكتبها هنا.
    </p>
    <div class="row" style="margin-bottom:10px">
      <input type="text" class="grow" placeholder="دوّر بالاسم أو الموديل…" data-act="search" value="${esc(state.filters.search)}">
      <select data-act="filter" data-filter="kind" style="max-width:170px">
        <option value="all" ${kindFilter === 'all' ? 'selected' : ''}>كل الأنواع</option>
        ${Object.entries(kinds).map(([value, label]) => `<option value="${value}" ${kindFilter === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      <select data-act="filter" data-filter="category" style="max-width:220px">
        <option value="all" ${categoryFilter === 'all' ? 'selected' : ''}>كل التصنيفات</option>
        ${state.plan.categories.filter((category) => category.include).map((category) => `<option value="${esc(category.id)}" ${categoryFilter === category.id ? 'selected' : ''}>${esc(category.name)}</option>`).join('')}
      </select>
      <button data-act="add-item">+ صنف جديد</button>
    </div>
    <div class="row" style="margin-bottom:10px">
      <span class="muted small">على الظاهر (${num(filtered.length)}):</span>
      <button class="small" data-act="bulk-filtered" data-coll="items" data-op="include">اشمل</button>
      <button class="small" data-act="bulk-filtered" data-coll="items" data-op="exclude">استبعد</button>
      <select id="bulk-category" style="max-width:220px">${categoryOptions('')}</select>
      <button class="small" data-act="bulk-filtered" data-coll="items" data-op="move">انقل للتصنيف</button>
      <button class="small danger" data-act="bulk-filtered" data-coll="items" data-op="delete">احذف</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr>
        <th></th><th>الاسم</th><th>النوع</th><th>التصنيف</th><th>الشركة</th><th>الموديل</th>
        <th class="num">رام</th><th class="num">مساحة</th><th class="num">شراء</th><th class="num">بيع</th><th class="num">الكمية</th><th></th>
      </tr></thead>
      <tbody>
        ${slice.map((item) => `<tr class="${item.include ? '' : 'excluded'}">
          <td><input type="checkbox" ${item.include ? 'checked' : ''} data-act="include" data-coll="items" data-id="${esc(item.id)}"></td>
          <td><input type="text" value="${esc(item.name)}" data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="name" style="min-width:180px"></td>
          <td><span class="badge ${item.kind === 'phone' ? '' : 'plain'}">${kinds[item.kind] || item.kind}</span></td>
          <td><select data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="categoryId" style="min-width:150px">${categoryOptions(item.categoryId)}</select></td>
          <td>${item.kind === 'phone'
            ? `<select data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="brandId" style="min-width:130px">${brandOptions(item.brandId)}</select>`
            : '<span class="muted">—</span>'}</td>
          <td>${item.kind === 'phone'
            ? `<input type="text" value="${esc(item.model)}" data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="model" style="min-width:110px">`
            : '<span class="muted">—</span>'}</td>
          <td class="num">${item.kind === 'phone' ? `<input type="number" value="${item.ramGb ?? ''}" data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="ramGb" data-type="int" style="width:70px">` : '—'}</td>
          <td class="num">${item.kind === 'phone' ? `<input type="number" value="${item.storageGb ?? ''}" data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="storageGb" data-type="int" style="width:80px">` : '—'}</td>
          <td class="num"><input type="number" step="0.01" value="${item.buy}" data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="buy" data-type="float" style="width:90px"></td>
          <td class="num"><input type="number" step="0.01" value="${item.sell ?? ''}" placeholder="—" data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="sell" data-type="float" style="width:90px"></td>
          <td class="num"><input type="number" step="1" value="${item.qty}" data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="qty" data-type="int" style="width:70px"></td>
          <td class="actions"><button class="small danger" data-act="del" data-coll="items" data-id="${esc(item.id)}">حذف</button></td>
        </tr>`).join('') || emptyRow(12, 'مفيش أصناف مطابقة.')}
      </tbody>
    </table></div>
    ${pager('items', page, pageCount, filtered.length)}
  </div>`;
}

function viewMonths() {
  const plan = state.plan;
  return `
  <div class="card">
    <h2>الشهور</h2>
    <p class="lead">
      كل شهر تختار: <b>تفصيلي</b> (كل بيعة لوحدها)، أو <b>مجمّع</b> (سطر لكل تصنيف — رقم الشهر بس)،
      أو <b>مش متنقل</b>. الشهور القديمة مجمّعة افتراضيًا زي ما طلبت.
    </p>
    ${state.legacy ? `<div class="row" style="margin-bottom:12px">
      <span class="muted small">الشهر اللي عايزه تفصيلي:</span>
      <select id="detail-month" style="max-width:200px">
        ${plan.months.map((month) => `<option value="${esc(month.month)}" ${plan.settings.currentMonth === month.month ? 'selected' : ''}>${esc(month.label)}</option>`).join('')}
      </select>
      <button class="small" data-act="rebuild-month">أعد بناء الخطة على الشهر ده</button>
      <span class="muted small">(بيمسح التعديلات)</span>
    </div>` : ''}
    <div class="table-wrap"><table>
      <thead><tr><th></th><th>الشهر</th><th>الطريقة</th><th class="num">مبيعات</th><th class="num">تكلفة</th><th class="num">ربح</th><th class="num">مصاريف</th><th class="num">صيانة</th><th class="num">كاش</th><th class="num">فواتير هتتنقل</th></tr></thead>
      <tbody>
        ${plan.months.map((month) => {
          const detailCount = plan.sales.filter((sale) => sale.include && sale.date.startsWith(month.month)).length;
          const summaryCount = plan.summary.filter((row) => row.include && row.month === month.month).length;
          const totals = month.totals || {};
          return `<tr class="${month.include && month.mode !== 'skip' ? '' : 'excluded'}">
            <td><input type="checkbox" ${month.include ? 'checked' : ''} data-act="include" data-coll="months" data-id="${esc(month.month)}"></td>
            <td><b>${esc(month.label)}</b></td>
            <td><select data-act="field" data-coll="months" data-id="${esc(month.month)}" data-field="mode" style="min-width:150px">
              <option value="detail" ${month.mode === 'detail' ? 'selected' : ''}>تفصيلي</option>
              <option value="summary" ${month.mode === 'summary' ? 'selected' : ''}>مجمّع</option>
              <option value="skip" ${month.mode === 'skip' ? 'selected' : ''}>مش متنقل</option>
            </select></td>
            <td class="num">${money(totals.sales)}</td>
            <td class="num">${money(totals.cost)}</td>
            <td class="num">${money(totals.profit)}</td>
            <td class="num">${money(totals.expenses)}</td>
            <td class="num">${money(totals.repairs)}</td>
            <td class="num">${money(totals.fees)}</td>
            <td class="num">${month.mode === 'detail' ? num(detailCount) : month.mode === 'summary' ? `${num(summaryCount)} سطر` : '—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>
    <div class="note info" style="margin-top:12px">
      الصيانة والسوفت وير والمصاريف وعمولات الكاش بتتنقل <b>كلها</b> بأرقامها، لأنها مش مبيعات ومش كتير — وده اللي بيخلي رقم كل شهر في التقارير صح.
    </div>
  </div>

  <div class="card">
    <h2>ملخّصات الشهور المجمّعة</h2>
    <p class="lead">كل سطر هنا بيبقى بند جوه فاتورة الشهر. تقدر تشيل أي سطر مش عايزه.</p>
    <div class="table-wrap"><table>
      <thead><tr><th></th><th>الشهر</th><th>القسم</th><th>البند</th><th class="num">عدد</th><th class="num">مبيعات</th><th class="num">تكلفة</th></tr></thead>
      <tbody>
        ${plan.summary.slice(0, 400).map((row) => `<tr class="${row.include ? '' : 'excluded'}">
          <td><input type="checkbox" ${row.include ? 'checked' : ''} data-act="include" data-coll="summary" data-id="${esc(row.id)}"></td>
          <td>${esc(monthLabel(row.month))}</td>
          <td><span class="badge plain">${row.section === 'acc' ? 'إكسسوار' : row.section === 'used' ? 'مستعمل' : 'موبايل'}</span></td>
          <td>${esc(row.label)}</td>
          <td class="num">${num(row.count)}</td>
          <td class="num">${money(row.total)}</td>
          <td class="num">${money(row.cost)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    ${plan.summary.length > 400 ? `<div class="pager">بيعرض أول 400 سطر من ${num(plan.summary.length)} — الباقي بيتنقل زي ما هو.</div>` : ''}
  </div>`;
}

function viewSales() {
  const detailMonths = state.plan.months.filter((month) => month.include && month.mode === 'detail').map((month) => month.month);
  let rows = state.plan.sales.filter((sale) => detailMonths.includes(sale.date.slice(0, 7)));
  if (state.filters.month !== 'all') rows = rows.filter((sale) => sale.date.startsWith(state.filters.month));
  const { filtered, slice, page, pageCount } = filteredAndPaged('sales', rows, (row) => `${row.name} ${row.date}`);
  const total = filtered.filter((row) => row.include).reduce((sum, row) => sum + row.sell * row.qty, 0);
  const cost = filtered.filter((row) => row.include).reduce((sum, row) => sum + row.buy * row.qty, 0);
  return `
  <div class="card">
    <h2>المبيعات التفصيلية</h2>
    <p class="lead">
      ${num(filtered.length)} بيعة — إجمالي ${money(total)} ج، تكلفة ${money(cost)} ج، ربح ${money(total - cost)} ج.
      كل بيعة بتتحول لفاتورة بسطر واحد، والكمية بتتخصم من المخزون.
    </p>
    <div class="row" style="margin-bottom:10px">
      <input type="text" class="grow" placeholder="دوّر باسم الصنف…" data-act="search" value="${esc(state.filters.search)}">
      <select data-act="filter" data-filter="month" style="max-width:200px">
        <option value="all" ${state.filters.month === 'all' ? 'selected' : ''}>كل الشهور التفصيلية</option>
        ${detailMonths.map((month) => `<option value="${month}" ${state.filters.month === month ? 'selected' : ''}>${monthLabel(month)}</option>`).join('')}
      </select>
      <button class="small" data-act="bulk-filtered" data-coll="sales" data-op="include">اشمل الظاهر</button>
      <button class="small" data-act="bulk-filtered" data-coll="sales" data-op="exclude">استبعد الظاهر</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th></th><th>التاريخ</th><th>الوقت</th><th>الصنف</th><th>القسم</th><th class="num">الكمية</th><th class="num">شراء</th><th class="num">بيع</th><th class="num">الإجمالي</th><th></th></tr></thead>
      <tbody>
        ${slice.map((sale) => `<tr class="${sale.include ? '' : 'excluded'}">
          <td><input type="checkbox" ${sale.include ? 'checked' : ''} data-act="include" data-coll="sales" data-id="${esc(sale.id)}"></td>
          <td class="mono">${esc(sale.date)}</td>
          <td class="mono">${esc(sale.clock)}</td>
          <td>${esc(sale.name)}</td>
          <td><span class="badge plain">${sale.section === 'acc' ? 'إكسسوار' : sale.section === 'used' ? 'مستعمل' : 'موبايل'}</span></td>
          <td class="num"><input type="number" value="${sale.qty}" data-act="field" data-coll="sales" data-id="${esc(sale.id)}" data-field="qty" data-type="int" style="width:65px"></td>
          <td class="num"><input type="number" step="0.01" value="${sale.buy}" data-act="field" data-coll="sales" data-id="${esc(sale.id)}" data-field="buy" data-type="float" style="width:85px"></td>
          <td class="num"><input type="number" step="0.01" value="${sale.sell}" data-act="field" data-coll="sales" data-id="${esc(sale.id)}" data-field="sell" data-type="float" style="width:85px"></td>
          <td class="num">${money(sale.sell * sale.qty)}</td>
          <td class="actions"><button class="small danger" data-act="del" data-coll="sales" data-id="${esc(sale.id)}">حذف</button></td>
        </tr>`).join('') || emptyRow(10, 'مفيش مبيعات تفصيلية — يمكن كل الشهور مجمّعة.')}
      </tbody>
    </table></div>
    ${pager('sales', page, pageCount, filtered.length)}
  </div>`;
}

function viewRepairs() {
  let rows = state.plan.repairs;
  if (state.filters.repairKind !== 'all') rows = rows.filter((row) => row.kind === state.filters.repairKind);
  const { filtered, slice, page, pageCount } = filteredAndPaged('repairs', rows, (row) => `${row.ticketNo} ${row.deviceName} ${row.issue}`);
  const total = filtered.filter((row) => row.include).reduce((sum, row) => sum + row.price, 0);
  return `
  <div class="card">
    <h2>الصيانة والسوفت وير</h2>
    <p class="lead">${num(filtered.length)} تذكرة — إجمالي ${money(total)} ج. كل تذكرة بتتنقل بتاريخها وحالتها.</p>
    <div class="row" style="margin-bottom:10px">
      <input type="text" class="grow" placeholder="دوّر برقم التذكرة أو الجهاز…" data-act="search" value="${esc(state.filters.search)}">
      <select data-act="filter" data-filter="repairKind" style="max-width:180px">
        <option value="all" ${state.filters.repairKind === 'all' ? 'selected' : ''}>النوعين</option>
        <option value="hardware" ${state.filters.repairKind === 'hardware' ? 'selected' : ''}>صيانة</option>
        <option value="software" ${state.filters.repairKind === 'software' ? 'selected' : ''}>سوفت وير</option>
      </select>
      <button data-act="add-repair">+ تذكرة</button>
      <button class="small" data-act="bulk-filtered" data-coll="repairs" data-op="include">اشمل الظاهر</button>
      <button class="small" data-act="bulk-filtered" data-coll="repairs" data-op="exclude">استبعد الظاهر</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th></th><th>التاريخ</th><th>النوع</th><th>التذكرة</th><th>الجهاز</th><th>العيب</th><th class="num">قطعة</th><th class="num">المبلغ</th><th>تسليم</th><th></th></tr></thead>
      <tbody>
        ${slice.map((repair) => `<tr class="${repair.include ? '' : 'excluded'}">
          <td><input type="checkbox" ${repair.include ? 'checked' : ''} data-act="include" data-coll="repairs" data-id="${esc(repair.id)}"></td>
          <td class="mono">${esc(repair.date)}</td>
          <td><select data-act="field" data-coll="repairs" data-id="${esc(repair.id)}" data-field="kind">
            <option value="hardware" ${repair.kind === 'hardware' ? 'selected' : ''}>صيانة</option>
            <option value="software" ${repair.kind === 'software' ? 'selected' : ''}>سوفت وير</option>
          </select></td>
          <td><input type="text" value="${esc(repair.ticketNo)}" data-act="field" data-coll="repairs" data-id="${esc(repair.id)}" data-field="ticketNo" style="width:110px"></td>
          <td><input type="text" value="${esc(repair.deviceName)}" data-act="field" data-coll="repairs" data-id="${esc(repair.id)}" data-field="deviceName" style="min-width:150px"></td>
          <td><input type="text" value="${esc(repair.issue)}" data-act="field" data-coll="repairs" data-id="${esc(repair.id)}" data-field="issue" style="min-width:140px"></td>
          <td class="num"><input type="number" step="0.01" value="${repair.partsCost}" data-act="field" data-coll="repairs" data-id="${esc(repair.id)}" data-field="partsCost" data-type="float" style="width:85px"></td>
          <td class="num"><input type="number" step="0.01" value="${repair.price}" data-act="field" data-coll="repairs" data-id="${esc(repair.id)}" data-field="price" data-type="float" style="width:85px"></td>
          <td><input type="checkbox" ${repair.delivered ? 'checked' : ''} data-act="field" data-coll="repairs" data-id="${esc(repair.id)}" data-field="delivered" data-type="bool"></td>
          <td class="actions"><button class="small danger" data-act="del" data-coll="repairs" data-id="${esc(repair.id)}">حذف</button></td>
        </tr>`).join('') || emptyRow(10, 'مفيش تذاكر مطابقة.')}
      </tbody>
    </table></div>
    ${pager('repairs', page, pageCount, filtered.length)}
  </div>`;
}

function viewExpenses() {
  const { filtered, slice, page, pageCount } = filteredAndPaged('expenses', state.plan.expenses, (row) => row.category);
  const total = filtered.filter((row) => row.include).reduce((sum, row) => sum + row.amount, 0);
  return `
  <div class="card">
    <h2>المصاريف</h2>
    <p class="lead">${num(filtered.length)} مصروف — ${money(total)} ج. بتتنقل كـ«مدفوعة من برّه الدرج» بتاريخها، عشان متتحاجش وردية مفتوحة.</p>
    <div class="row" style="margin-bottom:10px">
      <input type="text" class="grow" placeholder="دوّر بالتصنيف…" data-act="search" value="${esc(state.filters.search)}">
      <button data-act="add-expense">+ مصروف</button>
      <button class="small" data-act="bulk-filtered" data-coll="expenses" data-op="include">اشمل الظاهر</button>
      <button class="small" data-act="bulk-filtered" data-coll="expenses" data-op="exclude">استبعد الظاهر</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th></th><th>التاريخ</th><th>التصنيف</th><th class="num">المبلغ</th><th></th></tr></thead>
      <tbody>
        ${slice.map((expense) => `<tr class="${expense.include ? '' : 'excluded'}">
          <td><input type="checkbox" ${expense.include ? 'checked' : ''} data-act="include" data-coll="expenses" data-id="${esc(expense.id)}"></td>
          <td class="mono">${esc(expense.date)}</td>
          <td><input type="text" value="${esc(expense.category)}" data-act="field" data-coll="expenses" data-id="${esc(expense.id)}" data-field="category">
              <datalist id="expense-cats">${state.plan.expenseCategories.filter((category) => category.include).map((category) => `<option value="${esc(category.name)}"></option>`).join('')}</datalist></td>
          <td class="num"><input type="number" step="0.01" value="${expense.amount}" data-act="field" data-coll="expenses" data-id="${esc(expense.id)}" data-field="amount" data-type="float" style="width:100px"></td>
          <td class="actions"><button class="small danger" data-act="del" data-coll="expenses" data-id="${esc(expense.id)}">حذف</button></td>
        </tr>`).join('') || emptyRow(5, 'مفيش مصاريف مطابقة.')}
      </tbody>
    </table></div>
    ${pager('expenses', page, pageCount, filtered.length)}
  </div>`;
}

function viewWallets() {
  const methods = { vf: 'فودافون كاش', instapay: 'إنستاباي' };
  return `
  <div class="card">
    <h2>المحافظ</h2>
    <p class="lead">اكتب <b>الرصيد اللي فيها دلوقتي</b>. ده اللي هتفتح بيه في السيستم الجديد.</p>
    <div class="note warn">
      القديم كان بيسجّل <b>العمولة</b> في خانة «المبلغ» (ومرة واحدة بس سجّل المبلغ اللي اتحرك في خانة تانية).
      عشان كده الأداة <b>مش</b> بتحوّل حركات الكاش لحركات محفظة — كانت هتخترع أرصدة.
      الأرقام الشهرية للعمولات موجودة في التقرير وفي جدول الشهور.
    </div>
    <div class="table-wrap" style="margin-top:12px"><table>
      <thead><tr><th></th><th>الاسم</th><th>الرقم</th><th>نوع الدفع</th><th class="num">الرصيد الحالي</th><th class="num">حد يومي</th></tr></thead>
      <tbody>
        ${state.plan.wallets.map((wallet) => `<tr class="${wallet.include ? '' : 'excluded'}">
          <td><input type="checkbox" ${wallet.include ? 'checked' : ''} data-act="include" data-coll="wallets" data-id="${esc(wallet.id)}"></td>
          <td><input type="text" value="${esc(wallet.name)}" data-act="field" data-coll="wallets" data-id="${esc(wallet.id)}" data-field="name"></td>
          <td><input type="text" value="${esc(wallet.number)}" data-act="field" data-coll="wallets" data-id="${esc(wallet.id)}" data-field="number" style="width:140px"></td>
          <td>${wallet.payMethod ? `<span class="badge">${methods[wallet.payMethod] || wallet.payMethod}</span>` : '<span class="muted small">محفظة عادية</span>'}</td>
          <td class="num"><input type="number" step="0.01" value="${wallet.currentBalance}" data-act="field" data-coll="wallets" data-id="${esc(wallet.id)}" data-field="currentBalance" data-type="float" style="width:120px"></td>
          <td class="num"><input type="number" step="0.01" value="${wallet.dailyLimit}" data-act="field" data-coll="wallets" data-id="${esc(wallet.id)}" data-field="dailyLimit" data-type="float" style="width:110px"></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </div>`;
}

function viewSettings() {
  const plan = state.plan;
  return `
  <div class="card">
    <h2>إعدادات الترحيل</h2>
    <p class="lead">حاجات بسيطة بتتحفظ في السيستم الجديد مع البيانات.</p>
    <div class="grid-2">
      <label class="stat"><span>اسم المحل</span>
        <input type="text" value="${esc(plan.settings.shopName)}" data-act="setting" data-field="shopName">
      </label>
      <label class="stat"><span>اسم مستخدم المالك</span>
        <input type="text" value="${esc(plan.settings.ownerUsername)}" data-act="setting" data-field="ownerUsername">
      </label>
    </div>
    <div style="margin-top:14px">
      <label class="row"><input type="checkbox" ${plan.settings.logoDataUrl ? '' : 'disabled'} ${state.includeLogo && plan.settings.logoDataUrl ? 'checked' : ''} data-act="logo-include">
        <span>انقل شعار المحل${plan.settings.logoDataUrl ? '' : ' (مفيش شعار في الباكب)'}</span></label>
      ${plan.settings.logoDataUrl ? `<img src="${plan.settings.logoDataUrl}" alt="الشعار" style="max-height:96px;border:1px solid var(--line);border-radius:10px;margin-top:8px">` : ''}
    </div>
    <div class="note info" style="margin-top:16px">
      السيستم الجديد هيفتح بحساب المالك <b>بدون كلمة سر</b> (زي أول تشغيل)، وبعد كده تحط كلمة السر أو الـPIN من الإعدادات.
      كلمات سر البرنامج القديم مش بتتنقل.
    </div>
  </div>

  <div class="card">
    <h2>حركات الكاش القديمة</h2>
    <p class="lead">${num(state.plan.cashOps.length)} حركة — بتتقرأ للتقرير بس.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>الشهر</th><th class="num">حركات</th><th class="num">عمولات</th><th class="num">مبالغ اتحركت (معروفة)</th></tr></thead>
      <tbody>
        ${Object.entries(state.plan.cashOps.reduce((map, row) => {
          const month = row.date.slice(0, 7);
          map[month] = map[month] || { count: 0, fees: 0, moved: 0 };
          map[month].count += 1;
          map[month].fees += row.fee;
          map[month].moved += row.hasMovedAmount ? row.moved : 0;
          return map;
        }, {})).map(([month, entry]) => `<tr>
          <td>${esc(monthLabel(month))}</td>
          <td class="num">${num(entry.count)}</td>
          <td class="num">${money(entry.fees)}</td>
          <td class="num">${money(entry.moved)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </div>`;
}

function viewBuild() {
  const validation = validatePlan(state.plan);
  const errors = validation.findings.filter((finding) => finding.level === 'error');
  const warnings = validation.findings.filter((finding) => finding.level === 'warn');
  const totals = planTotals(state.plan);
  const built = state.built;
  return `
  <div class="build-grid">
    <div class="card">
      <h2>ابنِ نسخة السيستم الجديد</h2>
      <p class="lead">النسخة دي بتتدخل على البرنامج الجديد من «الإعدادات ← النسخة الاحتياطية ← استيراد نسخة».</p>

      <div class="grid-2">
        <label class="stat"><span>كلمة سر النسخة (8 حروف أو أكتر)</span>
          <input type="password" value="${esc(state.password)}" data-act="password" data-field="password" autocomplete="new-password">
        </label>
        <label class="stat"><span>تأكيد كلمة السر</span>
          <input type="password" value="${esc(state.password2)}" data-act="password" data-field="password2" autocomplete="new-password">
        </label>
      </div>
      <label class="row small" style="margin-top:10px"><input type="checkbox" ${state.fastKdf ? 'checked' : ''} data-act="fast-kdf">
        <span>تشفير أسرع (8 ميجا/مرة) — للتجربة بس؛ التطبيق بيقبلها لكن التشفير الافتراضي أقوى</span></label>

      ${errors.length ? `<div class="note danger" style="margin-top:12px"><b>${errors.length} خطأ لازم يتصلح:</b><ul class="findings">${errors.slice(0, 12).map((finding) => `<li class="error">${esc(finding.message)}</li>`).join('')}</ul></div>` : ''}
      ${warnings.length ? `<details style="margin-top:12px"><summary class="muted small">${warnings.length} تنبيه (مش مانع للبناء)</summary><ul class="findings">${warnings.slice(0, 40).map((finding) => `<li>${esc(finding.message)}</li>`).join('')}</ul></details>` : ''}

      <div class="row" style="margin-top:14px">
        <button class="primary" data-act="build" ${state.building || errors.length ? 'disabled' : ''}>ابنِ النسخة (${money(totals.saleTotal + totals.summaryTotal)} ج مبيعات)</button>
        <button class="ghost" data-act="save-draft">حفظ مسودة</button>
      </div>
      <div class="note warn" style="margin-top:14px">
        الاستيراد بيستبدل قاعدة بيانات الجهاز بالكامل. لو الجهاز عليه شغل حالي، خد نسخة منه الأول.
      </div>
    </div>

    <div class="card">
      ${built ? `
        <h2>النسخة جاهزة</h2>
        <p class="lead">${esc(built.name)} — ${(built.bytes.length / 1024 / 1024).toFixed(2)} ميجا.</p>
        <div class="row" style="flex-direction:column;align-items:stretch">
          <button class="primary" data-act="download" data-which="backup">حمّل النسخة (.msb1)</button>
          <button data-act="download" data-which="package">حمّل ملف البيانات (JSON)</button>
          <button data-act="download" data-which="report">حمّل التقرير (Markdown)</button>
        </div>
        <h3 style="margin-top:18px;font-size:15px">ترجّعها إزاي</h3>
        <ol class="steps">
          <li>افتح السيستم الجديد ← الإعدادات ← النسخة الاحتياطية.</li>
          <li>«استيراد نسخة» وحدد الملف اللي حمّلته.</li>
          <li>اكتب كلمة السر اللي كتبتها فوق.</li>
          <li>اقفل البرنامج وافتحه تاني زي ما هيطلب.</li>
          <li>راجع المخزن والمحافظ وأرقام الشهور.</li>
        </ol>
        <div class="note info">
          الفحص الذاتي نجح: الأداة فتحت النسخة اللي كتبتها بكلمة السر وقرأت قاعدة البيانات جواها.
        </div>
      ` : `
        <h2>قبل ما تبني</h2>
        <div class="table-wrap"><table>
          <tbody>
            <tr><td>التصنيفات</td><td class="num">${num(validation.includes.categories)}</td></tr>
            <tr><td>الماركات</td><td class="num">${num(validation.includes.brands)}</td></tr>
            <tr><td>الأصناف</td><td class="num">${num(validation.includes.items)}</td></tr>
            <tr><td>فواتير تفصيلية</td><td class="num">${num(validation.includes.sales)}</td></tr>
            <tr><td>بنود مجمّعة</td><td class="num">${num(validation.includes.summary)}</td></tr>
            <tr><td>تذاكر صيانة</td><td class="num">${num(validation.includes.repairs)}</td></tr>
            <tr><td>مصاريف</td><td class="num">${num(validation.includes.expenses)}</td></tr>
            <tr><td>محافظ</td><td class="num">${num(validation.includes.wallets)}</td></tr>
          </tbody>
        </table></div>
        <p class="muted small">البناء بياخد حوالي 5–10 ثواني (تشفير النسخة).</p>
      `}
    </div>
  </div>`;
}

function emptyRow(columns, text) {
  return `<tr><td colspan="${columns}" class="muted" style="text-align:center;padding:26px">${esc(text)}</td></tr>`;
}

// ── Shell ─────────────────────────────────────────────────────────────────
const TABS = [
  ['overview', 'النظرة العامة'],
  ['categories', 'التصنيفات'],
  ['brands', 'الماركات'],
  ['items', 'الأصناف'],
  ['months', 'الشهور'],
  ['sales', 'المبيعات التفصيلية'],
  ['repairs', 'الصيانة'],
  ['expenses', 'المصاريف'],
  ['wallets', 'المحافظ'],
  ['settings', 'الإعدادات'],
  ['build', 'بناء النسخة'],
];

function render() {
  const app = document.getElementById('app');
  if (state.view === 'load') {
    app.innerHTML = `<div class="layout" style="grid-template-columns:1fr;max-width:900px">${viewLoad()}</div>
      <footer class="foot">أداة ترحيل بيانات — بتشتغل أوفلاين على جهازك</footer>`;
    bindDropZone();
    return;
  }

  const counts = tabCounts();
  const totals = planTotals(state.plan);
  const validation = validatePlan(state.plan);
  const errors = validation.findings.filter((finding) => finding.level === 'error').length;

  const views = {
    overview: viewOverview,
    categories: viewCategories,
    brands: viewBrands,
    items: viewItems,
    months: viewMonths,
    sales: viewSales,
    repairs: viewRepairs,
    expenses: viewExpenses,
    wallets: viewWallets,
    settings: viewSettings,
    build: viewBuild,
  };

  app.innerHTML = `
    <div class="topbar">
      <div class="brand">
        <strong>ترحيل البيانات للسيستم الجديد</strong>
        <span>${esc(state.plan.settings.shopName)} — ${num(state.plan.source.days)} يوم</span>
      </div>
      <div class="spacer"></div>
      <div class="totals">
        <div><span>مبيعات منقولة</span><b>${money(totals.saleTotal + totals.summaryTotal)} ج</b></div>
        <div><span>أصناف</span><b>${num(totals.itemCount)}</b></div>
        <div><span>الفحص</span><b style="color:${errors ? 'var(--danger)' : 'var(--ok)'}">${errors ? `${errors} خطأ` : 'سليم'}</b></div>
      </div>
      <button class="small" data-act="undo" ${state.history.length ? '' : 'disabled'} title="تراجع">↶ تراجع</button>
      <button class="small" data-act="redo" ${state.future.length ? '' : 'disabled'} title="إعادة">↷ إعادة</button>
    </div>
    <div class="layout">
      <nav class="tabs">
        ${TABS.map(([key, label]) => `<button data-act="tab" data-tab="${key}" class="${state.tab === key ? 'active' : ''}">
          <span>${label}</span><span class="count">${key === 'overview' || key === 'settings' || key === 'build' ? '' : num(counts[key] ?? '')}</span>
        </button>`).join('')}
        <hr>
        <button data-act="pick-legacy" class="small">افتح باكب تاني</button>
        <button data-act="pick-draft" class="small">افتح مسودة</button>
      </nav>
      <main>${views[state.tab]()}</main>
    </div>
    <footer class="foot">كل حاجة بتشتغل على جهازك — مفيش بيانات بتطلع على الإنترنت.</footer>
  `;
}

// ── Events ────────────────────────────────────────────────────────────────
function bindDropZone() {
  const drop = document.getElementById('drop');
  if (!drop) return;
  ['dragenter', 'dragover'].forEach((type) => drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.add('hover');
  }));
  ['dragleave', 'drop'].forEach((type) => drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.remove('hover');
  }));
  drop.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) loadLegacyFile(file);
  });
}

function pickFile(accept, handler) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) handler(file);
  });
  input.click();
}

function visibleIds(coll) {
  const query = normalizeText(state.filters.search).toLowerCase();
  if (coll === 'items') {
    let rows = state.plan.items;
    if (state.filters.kind !== 'all') rows = rows.filter((item) => item.kind === state.filters.kind);
    if (state.filters.category !== 'all') rows = rows.filter((item) => (item.categoryId || '') === state.filters.category);
    if (query) rows = rows.filter((item) => `${item.name} ${item.model}`.toLowerCase().includes(query));
    return rows.map((row) => row.id);
  }
  if (coll === 'sales') {
    const detailMonths = state.plan.months.filter((month) => month.include && month.mode === 'detail').map((month) => month.month);
    let rows = state.plan.sales.filter((sale) => detailMonths.includes(sale.date.slice(0, 7)));
    if (state.filters.month !== 'all') rows = rows.filter((sale) => sale.date.startsWith(state.filters.month));
    if (query) rows = rows.filter((sale) => sale.name.toLowerCase().includes(query));
    return rows.map((row) => row.id);
  }
  if (coll === 'repairs') {
    let rows = state.plan.repairs;
    if (state.filters.repairKind !== 'all') rows = rows.filter((row) => row.kind === state.filters.repairKind);
    if (query) rows = rows.filter((row) => `${row.ticketNo} ${row.deviceName} ${row.issue}`.toLowerCase().includes(query));
    return rows.map((row) => row.id);
  }
  const rows = state.plan[coll] || [];
  if (!query) return rows.map((row) => row.id);
  return rows.filter((row) => `${row.name ?? ''} ${row.category ?? ''}`.toLowerCase().includes(query)).map((row) => row.id);
}

function handleAction(target) {
  const act = target.dataset.act;
  if (!act) return;

  switch (act) {
    case 'pick-legacy':
      pickFile('.json,application/json', loadLegacyFile);
      return;
    case 'pick-draft':
      pickFile('.json,application/json', loadDraft);
      return;
    case 'tab':
      state.tab = target.dataset.tab;
      state.filters.search = '';
      state.page = {};
      render();
      return;
    case 'undo':
      undo();
      return;
    case 'redo':
      redo();
      return;
    case 'page':
      state.page[target.dataset.name] = Number(target.dataset.page);
      render();
      return;
    case 'search':
      state.filters.search = target.value;
      state.page = {};
      render();
      return;
    case 'filter':
      state.filters[target.dataset.filter] = target.value;
      state.page = {};
      render();
      return;
    case 'include': {
      const coll = target.dataset.coll;
      const id = target.dataset.id;
      editRecord(coll, id, { include: target.checked });
      render();
      return;
    }
    case 'field': {
      const coll = target.dataset.coll;
      const field = target.dataset.field;
      const type = target.dataset.type;
      let value = target.type === 'checkbox' ? target.checked : target.value;
      if (type === 'int') value = Math.max(0, Math.trunc(Number(value) || 0));
      if (type === 'float') value = value === '' ? null : Number(value);
      if (type === 'bool') value = target.checked;
      const record = recordOf(coll, target.dataset.id);
      if (!record) return;
      if (value === '' && (field === 'sell' || field === 'parentId' || field === 'categoryId' || field === 'brandId')) {
        value = field === 'sell' ? null : '';
      }
      if (coll === 'months' && field === 'mode') {
        const month = state.plan.months.find((row) => row.month === target.dataset.id);
        const previous = month?.mode;
        if (!month) return;
        if (value === 'detail' && previous !== 'detail') {
          if (!state.legacy || !confirm(`هتعيد بناء الخطة على ${month.label} تفصيلي، وأي تعديلات هتتمسح. تكمل؟`)) {
            render();
            return;
          }
          rebuildPlanAround(month.month);
          render();
          return;
        }
        if (value === 'summary' && previous === 'detail') convertDetailToSummary(month.month);
        editRecord('months', target.dataset.id, { mode: value });
        state.notice = null;
        render();
        return;
      }
      editRecord(coll, target.dataset.id, { [field]: value });
      render();
      return;
    }
    case 'setting': {
      const field = target.dataset.field;
      state.plan.settings[field] = target.value;
      render();
      return;
    }
    case 'password':
      state[target.dataset.field] = target.value;
      return;
    case 'fast-kdf':
      state.fastKdf = target.checked;
      render();
      return;
    case 'logo-include':
      state.includeLogo = target.checked;
      return;
    case 'add-category': {
      const category = {
        id: newId('cat'),
        name: 'تصنيف جديد',
        parentId: null,
        kind: 'item',
        icon: 'tag',
        sortOrder: (state.plan.categories.length + 1) * 10,
        include: true,
      };
      addRecord('categories', category);
      render();
      return;
    }
    case 'add-brand': {
      addRecord('brands', {
        id: newId('brand'),
        name: 'ماركة جديدة',
        deviceType: 'touch',
        sortOrder: (state.plan.brands.length + 1) * 10,
        include: true,
      });
      render();
      return;
    }
    case 'add-item': {
      addRecord('items', {
        id: newId('item'),
        kind: 'accessory',
        name: 'صنف جديد',
        categoryId: state.filters.category !== 'all' ? state.filters.category : null,
        brandId: null,
        model: '',
        ramGb: null,
        storageGb: null,
        color: '',
        deviceType: null,
        buy: 0,
        sell: 0,
        qty: 0,
        supplier: '',
        notes: '',
        include: true,
        sourceRef: '',
        archived: false,
        priceSource: 'added',
      });
      render();
      return;
    }
    case 'add-repair': {
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      addRecord('repairs', {
        id: newId('repair'),
        sourceId: '',
        date,
        clock: '',
        kind: 'hardware',
        ticketNo: `NEW-${String(state.plan.repairs.length + 1).padStart(4, '0')}`,
        customerName: '',
        customerPhone: '',
        deviceName: 'جهاز',
        issue: 'صيانة',
        note: '',
        partsCost: 0,
        price: 0,
        delivered: true,
        paid: true,
        include: true,
      });
      render();
      return;
    }
    case 'add-expense': {
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      addRecord('expenses', {
        id: newId('expense'),
        sourceId: '',
        date,
        clock: '',
        category: state.plan.expenseCategories[0]?.name || 'مصاريف',
        amount: 0,
        include: true,
      });
      render();
      return;
    }
    case 'del': {
      deleteRecord(target.dataset.coll, target.dataset.id);
      render();
      return;
    }
    case 'bulk': {
      const coll = target.dataset.coll;
      const ids = state.plan[coll].map((row) => row.id);
      if (target.dataset.op === 'include') bulkInclude(coll, ids, true);
      if (target.dataset.op === 'exclude') bulkInclude(coll, ids, false);
      render();
      return;
    }
    case 'bulk-filtered': {
      const coll = target.dataset.coll;
      const op = target.dataset.op;
      const ids = visibleIds(coll);
      if (op === 'include') bulkInclude(coll, ids, true);
      else if (op === 'exclude') bulkInclude(coll, ids, false);
      else if (op === 'delete') {
        if (confirm(`هتحذف ${ids.length} صف من الأداة. متأكد؟`)) bulkDelete(coll, ids);
      } else if (op === 'move') {
        const select = document.getElementById('bulk-category');
        const categoryId = select?.value || '';
        bulkPatch(coll, ids, { categoryId: categoryId || null });
      }
      render();
      return;
    }
    case 'rebuild-month': {
      const select = document.getElementById('detail-month');
      const month = select?.value;
      if (!month) return;
      if (!confirm(`هعيد بناء الخطة على ${monthLabel(month)} تفصيلي، وأي تعديلات هتتمسح. تكمل؟`)) return;
      rebuildPlanAround(month);
      render();
      return;
    }
    case 'save-draft':
      download('مسودة-الترحيل.json', JSON.stringify(state.plan), 'application/json');
      return;
    case 'build':
      runBuild();
      return;
    case 'download': {
      if (!state.built) return;
      const which = target.dataset.which;
      if (which === 'backup') download(state.built.name, state.built.bytes, 'application/octet-stream');
      if (which === 'package') download('بيانات-الترحيل.json', JSON.stringify(state.plan, null, 2), 'application/json');
      if (which === 'report') download('تقرير-الترحيل.md', state.built.report, 'text/markdown;charset=utf-8');
      return;
    }
    default:
  }
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-act]');
  if (!target) return;
  if (target.tagName === 'SELECT') return; // handled on change
  if (target.tagName === 'INPUT' && ['checkbox'].includes(target.type) && event.type === 'click') {
    // Checkboxes are handled on `change` so the DOM state is final.
    return;
  }
  handleAction(target);
});

document.addEventListener('change', (event) => {
  const target = event.target.closest('[data-act]');
  if (!target) return;
  const act = target.dataset.act;
  if (target.tagName === 'INPUT' && target.type === 'checkbox') handleAction(target);
  else if (act === 'field' || act === 'setting' || act === 'filter' || act === 'password') handleAction(target);
});

document.addEventListener('input', (event) => {
  const target = event.target;
  if (target.dataset.act === 'search') {
    state.filters.search = target.value;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.dataset.act === 'search') {
    state.page = {};
    render();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo(); else undo();
  }
});

// ── Build ─────────────────────────────────────────────────────────────────
function overlay(title, text) {
  const existing = document.getElementById('overlay');
  if (existing) existing.remove();
  const element = document.createElement('div');
  element.className = 'overlay';
  element.id = 'overlay';
  element.innerHTML = `<div class="box"><h3>${esc(title)}</h3><p>${esc(text)}</p><div class="progress"><div class="bar"><div></div></div></div></div>`;
  document.body.appendChild(element);
  return {
    step: (titleText, textText, percent) => {
      element.querySelector('h3').textContent = titleText;
      element.querySelector('p').textContent = textText;
      element.querySelector('.bar > div').style.width = `${percent}%`;
    },
    close: () => element.remove(),
  };
}

async function ensureSql() {
  if (state.sql) return state.sql;
  const SQL = await initSqlJs({ wasmBinary: base64ToBytes(wasmBase64) });
  state.sql = SQL;
  return SQL;
}

/** 192×192 JPEG, the size the app insists on for the shop logo. */
async function shrinkLogo(dataUrl) {
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = reject;
      element.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    canvas.height = 192;
    const context = canvas.getContext('2d');
    const scale = Math.max(192 / image.width, 192 / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 192, 192);
    context.drawImage(image, (192 - width) / 2, (192 - height) / 2, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) return null;
    const buffer = new Uint8Array(await blob.arrayBuffer());
    return buffer.length <= 64 * 1024 ? buffer : null;
  } catch {
    return null;
  }
}

async function runBuild() {
  const validation = validatePlan(state.plan);
  const errors = validation.findings.filter((finding) => finding.level === 'error');
  if (errors.length) {
    state.notice = { level: 'danger', text: 'فيه أخطاء لازم تتصلح الأول.' };
    render();
    return;
  }
  if (!state.password || state.password.length < 8) {
    state.notice = { level: 'warn', text: 'كلمة السر لازم 8 حروف أو أكتر.' };
    render();
    return;
  }
  if (state.password !== state.password2) {
    state.notice = { level: 'warn', text: 'كلمة السر وتأكيدها مش زي بعض.' };
    render();
    return;
  }

  state.building = true;
  const progress = overlay('بنجهّز النسخة…', 'بنجهّز قاعدة البيانات على مخطط السيستم الجديد.');
  await tick();
  try {
    let logo = null;
    if (state.includeLogo && state.plan.settings.logoDataUrl) {
      progress.step('بنجهّز الشعار…', 'بنصغّر الشعار لـ192×192 زي ما التطبيق بيطلب.', 15);
      await tick();
      logo = await shrinkLogo(state.plan.settings.logoDataUrl);
    }
    progress.step('بنكتب قاعدة البيانات…', 'بنطبّق ترحيلات السيستم الجديد وبنكتب الصفوف.', 35);
    await tick();
    const SQL = await ensureSql();

    progress.step('بنشفّر النسخة…', 'التشفير بياخد ثانيتين تقريبًا — ده اللي بيحمي نسخة المحل.', 65);
    await tick();
    const result = buildFromPlan({
      SQL,
      plan: state.plan,
      password: state.password,
      logoJpeg: logo,
      now: Date.now(),
      kdf: state.fastKdf ? { memoryKib: 8 * 1024, iterations: 1, parallelism: 1 } : undefined,
    });
    if (!result.ok) {
      progress.close();
      state.building = false;
      state.notice = { level: 'danger', text: 'فيه أخطاء في الخطة منعت البناء.' };
      render();
      return;
    }
    progress.step('بنراجع النسخة…', 'بنتأكد إن الملف اللي كتبناه بيتفتح ويتقرأ.', 90);
    await tick();
    const report = buildReport({
      plan: state.plan,
      legacy: state.legacy || { stats: { rolled: 0 } },
      result,
      manifest: result.manifest,
      backupName: backupFileName(state.plan.settings.shopName),
      passwordLength: state.password.length,
    });
    state.built = {
      name: backupFileName(state.plan.settings.shopName),
      bytes: result.bytes,
      report,
      stats: result.stats,
    };
    state.building = false;
    state.notice = null;
    progress.close();
    render();
  } catch (error) {
    state.building = false;
    progress.close();
    state.notice = { level: 'danger', text: `البناء وقف: ${error.message}` };
    render();
  }
}

// Start.
render();
