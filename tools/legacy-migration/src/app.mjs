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
import { buildDefaultPlan, validatePlan, planTotals, isValidImei, normalizeImei, CATEGORY_ICONS } from './plan.mjs';
import { buildReport } from './report.mjs';
import { monthLabel, nameKey, newId, normalizeText } from './util.mjs';
import {
  LEGACY_MAP,
  describeRow,
  explainFinding,
  fieldsOf,
  fieldValue,
  stateOf,
} from './mapping.mjs';

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
  filters: { search: '', kind: 'all', category: 'all', month: 'all', repairKind: 'all', shelf: 'all', missing: 'all' },
  password: '',
  password2: '',
  includeLogo: true,
  fastKdf: false,
  built: null,
  building: false,
  notice: null,
  sql: null,
  // Rows ticked for a bulk action (merge / move / delete). Kept apart from
  // `include` on purpose: "I want this row" and "I am working on this row" are
  // two different questions, and mixing them is how a merge eats a whole table.
  selected: {},
  drawer: null,
  highlight: null,
  // What is typed in the «أجهزة المستعمل» box but not committed yet. Kept out of
  // the plan so a half-typed IMEI can never end up in the file.
  deviceDraft: { text: '', condition: '', cost: '' },
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

// ── Selection, merge, order, and the row panel ────────────────────────────
// A whole-plan edit keeps its own snapshot: merging two products rewrites sales,
// stock and categories at once, and the owner must be able to take it back with
// one click like any other edit.
// The plan is plain JSON, so a JSON round-trip is an exact copy — and unlike
// `structuredClone` it exists in every browser this tool has to run in.
const clonePlan = (plan) => JSON.parse(JSON.stringify(plan));

function planEdit(mutate) {
  const before = clonePlan(state.plan);
  const draft = clonePlan(state.plan);
  mutate(draft);
  perform({
    do: () => { state.plan = draft; },
    undo: () => { state.plan = before; },
  });
}

function selectedIds(coll) {
  return state.selected[coll] || [];
}

function isSelected(coll, id) {
  return selectedIds(coll).includes(id);
}

function setSelection(coll, ids) {
  state.selected[coll] = ids;
}

function toggleSelection(coll, id, on) {
  const ids = selectedIds(coll).filter((entry) => entry !== id);
  if (on) ids.push(id);
  setSelection(coll, ids);
}

function selectAllVisible(coll, on) {
  setSelection(coll, on ? visibleIds(coll) : []);
}

/** The ticked rows, in the order they appear in the plan (not click order). */
function orderedSelection(coll) {
  const ids = new Set(selectedIds(coll));
  return collection(coll).filter((row) => ids.has(row.id));
}

function openDrawer(coll, id) {
  state.deviceDraft = { text: '', condition: '', cost: '' };
  state.drawer = { coll, id };
  render();
}

function closeDrawer() {
  state.drawer = null;
  render();
}

/**
 * Merge rows into the first ticked one.
 *
 * Everything that pointed at a dropped row is pointed at the kept one — that is
 * what makes a merge safe rather than a delete with a nicer name. Quantities are
 * summed because two rows with the same name were two shelves holding the same
 * thing.
 */
function mergeGroup(coll, keepId, dropIds) {
  if (!dropIds.length) return;
  const drop = new Set(dropIds);
  planEdit((plan) => {
    if (coll === 'categories') {
      for (const category of plan.categories) if (category.parentId && drop.has(category.parentId)) category.parentId = keepId;
      for (const item of plan.items) if (item.categoryId && drop.has(item.categoryId)) item.categoryId = keepId;
      for (const row of plan.summary) if (row.categoryId && drop.has(row.categoryId)) row.categoryId = keepId;
    }
    if (coll === 'brands') {
      for (const item of plan.items) if (item.brandId && drop.has(item.brandId)) item.brandId = keepId;
    }
    if (coll === 'items') {
      const keep = plan.items.find((item) => item.id === keepId);
      const others = plan.items.filter((item) => drop.has(item.id));
      for (const other of others) {
        if (!keep) break;
        keep.qty += other.qty;
        if (other.devices?.length) {
          keep.devices = [...(keep.devices ?? []), ...other.devices];
        }
        if (!keep.sell && other.sell) keep.sell = other.sell;
        if (!keep.buy && other.buy) keep.buy = other.buy;
        if (!keep.categoryId && other.categoryId) keep.categoryId = other.categoryId;
        if (!keep.brandId && other.brandId) keep.brandId = other.brandId;
        if (!keep.model && other.model) keep.model = other.model;
      }
      for (const sale of plan.sales) if (drop.has(sale.itemId)) sale.itemId = keepId;
    }
    plan[coll] = plan[coll].filter((row) => !drop.has(row.id));
  });
}

function mergeSelected(coll) {
  const rows = orderedSelection(coll);
  if (rows.length < 2) {
    state.notice = { level: 'warn', text: 'اختار صفّين على الأقل من عمود «تحديد» الأول، وبعدين دوس دمج.' };
    render();
    return;
  }
  const [keep, ...rest] = rows;
  if (!confirm(`هدمج ${rows.length} صف في صف واحد باسم «${keep.name || keep.label}»، وكل اللي بيتحول عليهم هيتحوّل عليه. كمّل؟`)) return;
  mergeGroup(coll, keep.id, rest.map((row) => row.id));
  setSelection(coll, []);
  state.notice = {
    level: 'info',
    text: coll === 'items'
      ? `اتدمجوا في «${keep.name}». الكميات اتجمعت — راجع الرقم النهائي.`
      : `اتدمجوا في «${keep.name}».`,
  };
  render();
}

/** Move one row up or down where order is meaningful (categories, brands, lines). */
function moveRow(coll, id, delta) {
  if (coll === 'summary') {
    const row = recordOf('summary', id);
    const siblings = state.plan.summary.filter((entry) => entry.month === row.month);
    const index = siblings.findIndex((entry) => entry.id === id);
    const target = index + delta;
    if (target < 0 || target >= siblings.length) return;
    planEdit((plan) => {
      const list = plan.summary;
      const from = list.findIndex((entry) => entry.id === siblings[index].id);
      const to = list.findIndex((entry) => entry.id === siblings[target].id);
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
    });
    render();
    return;
  }
  const sorted = [...collection(coll)].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const index = sorted.findIndex((row) => row.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= sorted.length) return;
  planEdit((plan) => {
    // Renumber the whole list so two rows that shared a sort order still move.
    sorted.forEach((row, position) => {
      const record = plan[coll].find((entry) => entry.id === row.id);
      if (record) record.sortOrder = (position + 1) * 10;
    });
    const a = plan[coll].find((entry) => entry.id === sorted[index].id);
    const b = plan[coll].find((entry) => entry.id === sorted[target].id);
    const swap = a.sortOrder;
    a.sortOrder = b.sortOrder;
    b.sortOrder = swap;
  });
  render();
}

/** Fix the findings the tool can fix without inventing a value. */
function autoFix(finding) {
  const code = finding.code;
  if (code === 'orphan-category') {
    editRecord('categories', finding.ref, { parentId: null });
  } else if (code === 'item-category') {
    editRecord('items', finding.ref, { categoryId: null });
  } else if (code === 'item-excluded-with-sales') {
    editRecord('items', finding.ref, { include: true });
  } else if (code === 'month-skipped') {
    editRecord('months', finding.ref, { include: false });
  } else {
    return false;
  }
  render();
  return true;
}

/** Merge every row that shares a name with this one. */
function mergeDuplicates(coll, refId) {
  const row = recordOf(coll, refId);
  if (!row) return false;
  const key = nameKey(row.name);
  const group = collection(coll).filter((entry) => nameKey(entry.name) === key);
  if (group.length < 2) return false;
  mergeGroup(coll, group[0].id, group.slice(1).map((entry) => entry.id));
  setSelection(coll, []);
  state.notice = { level: 'info', text: `اتدمج ${group.length} صف باسم «${group[0].name}» في واحد.` };
  render();
  return true;
}

function runAutoFix(finding) {
  const guide = explainFinding(finding, state.plan);
  if (guide.auto === 'merge-duplicate') {
    if (mergeDuplicates(guide.tab === 'brands' ? 'brands' : guide.tab === 'items' ? 'items' : 'categories', finding.ref)) return;
    state.notice = { level: 'warn', text: 'مفيش صف تاني بنفس الاسم أدمجه معاه — راجع الاسم يدوي.' };
    render();
    return;
  }
  if (!autoFix(finding)) {
    state.notice = { level: 'warn', text: 'التنبيه ده محتاج قرارك إنت — مفيش حل تلقائي آمن.' };
    render();
  }
}

/** Jump to the row a finding is about, with the details panel already open. */
function gotoFinding(finding) {
  const guide = explainFinding(finding, state.plan);
  const coll = {
    categories: 'categories',
    items: 'items',
    brands: 'brands',
    sales: 'sales',
    months: 'months',
    repairs: 'repairs',
    expenses: 'expenses',
    wallets: 'wallets',
  }[guide.tab] || null;
  state.tab = guide.tab;
  state.filters.search = '';
  state.page = {};
  state.drawer = finding.ref && coll && recordOf(coll, finding.ref) ? { coll, id: finding.ref } : null;
  render();
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

/**
 * Change how a month travels.
 *
 * Detail › summary can be done by grouping what is already there; summary ›
 * detail cannot, because the individual sales were never kept. So the second
 * direction rebuilds the plan around that month and says so first.
 */
function setMonthMode(monthId, mode) {
  const month = state.plan.months.find((row) => row.month === monthId);
  if (!month || month.mode === mode) return;
  if (mode === 'detail') {
    if (!state.legacy) {
      state.notice = { level: 'warn', text: 'الشهر ده ملخّص في القديم — مفيش بيعات تفصيلية ترجع لها. لو عايزه تفصيلي، لازم تعيد فتح الباكب وتختاره من الأول.' };
      render();
      return;
    }
    if (!confirm(`هعيد بناء الخطة على ${month.label} تفصيلي، وأي تعديلات هتتمسح. تكمل؟`)) {
      render();
      return;
    }
    rebuildPlanAround(month.month);
    return;
  }
  if (mode === 'summary' && month.mode === 'detail') convertDetailToSummary(month.month);
  editRecord('months', monthId, { mode });
  state.notice = null;
  render();
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
    accessories: plan.items.filter((item) => item.kind === 'accessory').length,
    phones: plan.items.filter((item) => item.kind === 'phone' || item.kind === 'used').length,
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
    <h2 style="font-size:24px;margin-bottom:2px">من السيستم القديم للجديد</h2>
    <p class="lead">بتفتح باكب المحل القديم، وتشوف كل حاجة هتبقى إيه في السيستم الجديد، وتعدّل وترتّب وتدمج، وبعدين تطلّع نسخة جاهزة للاستيراد.</p>
    <div class="flow" style="margin-bottom:18px">
      <div class="flow-side"><span class="flow-title">١. افتح الباكب</span><span class="flow-item">ملف JSON من البرنامج القديم</span></div>
      <div class="flow-arrow">‹</div>
      <div class="flow-side"><span class="flow-title">٢. راجع وعدّل</span><span class="flow-item">خريطة قديم/جديد، تفاصيل كل صف، ترتيب ودمج ومسح</span></div>
      <div class="flow-arrow">‹</div>
      <div class="flow-side new"><span class="flow-title">٣. ابنِ النسخة</span><span class="flow-item">ملف <span class="mono">.msb1</span> يستورده البرنامج الجديد</span></div>
    </div>
    <div class="drop" id="drop">
      <h2>ارمي باكب السيستم القديم هنا</h2>
      <p>ملف <span class="mono">.json</span> اللي البرنامج القديم بيطلّعه (زي <span class="mono">محل_كل_البيانات.json</span>).</p>
      <p class="hint">اسحب الملف هنا، أو</p>
      <p><button class="primary" data-act="pick-legacy">اختار الملف من الجهاز</button></p>
      <p class="hint" style="margin-top:18px">الأداة بتشتغل على جهازك بس. مفيش بيانات بتطلع على الإنترنت، والملف الأصلي مش بيتغير.</p>
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

// ── Shared cells ──────────────────────────────────────────────────────────
const includeCell = (coll, row) => `<td class="tick">
  <input type="checkbox" ${row.include ? 'checked' : ''} data-act="include" data-coll="${coll}" data-id="${esc(row.id)}"
    title="${row.include ? 'هيتنقل — شيل العلامة لو مش عايزه' : 'مش هيتنقل'}">
</td>`;

const selectCell = (coll, row) => `<td class="tick">
  <input type="checkbox" ${isSelected(coll, row.id) ? 'checked' : ''} data-act="select" data-coll="${coll}" data-id="${esc(row.id)}"
    title="تحديد للدمج أو النقل أو المسح">
</td>`;

const detailsCell = (coll, row) => `<td class="actions">
  <button class="small ghost" data-act="details" data-coll="${coll}" data-id="${esc(row.id)}">تفاصيل</button>
</td>`;

const selectHeader = (coll, visible) => {
  const all = visible.length > 0 && visible.every((row) => isSelected(coll, row.id));
  return `<th class="tick"><input type="checkbox" ${all ? 'checked' : ''} data-act="select-visible" data-coll="${coll}"
    data-on="${all ? '0' : '1'}" title="تحديد كل الظاهر"></th>`;
};

/** «حط نفس العدد للمحدد» — the bulk half of counting a shelf. */
function bulkCountBar(coll) {
  const count = selectedIds(coll).length;
  if (coll !== 'items') return '';
  return `<div class="row" style="margin:0 0 10px">
    <span class="muted small">عدد واحد للمحدد:</span>
    <input type="number" min="0" step="1" id="bulk-count" style="max-width:110px" placeholder="0">
    <button class="small" data-act="bulk-count" data-coll="items">حط العدد للمحدد</button>
    ${count ? `<span class="muted small">${num(count)} صف محدد</span>` : '<span class="muted small">حدد الصفوف من عمود «تحديد» الأول</span>'}
  </div>`;
}

function selectionBar(coll, options = {}) {
  const count = selectedIds(coll).length;
  return `<div class="selbar ${count ? 'active' : ''}">
    <b>${count ? `${num(count)} صف محدد` : 'مفيش صف محدد'}</b>
    ${options.merge ? `<button class="small" data-act="merge" data-coll="${coll}" ${count < 2 ? 'disabled' : ''}>ادمج المحدد</button>` : ''}
    ${options.moveToCategory ? `<select id="bulk-category" style="max-width:200px">${categoryOptions('')}</select>
      <button class="small" data-act="bulk-move" data-coll="${coll}" ${count ? '' : 'disabled'}>انقل المحدد للقسم</button>` : ''}
    <button class="small" data-act="bulk-selected" data-coll="${coll}" data-op="include" ${count ? '' : 'disabled'}>اشمل المحدد</button>
    <button class="small" data-act="bulk-selected" data-coll="${coll}" data-op="exclude" ${count ? '' : 'disabled'}>استبعد المحدد</button>
    <button class="small danger" data-act="bulk-selected" data-coll="${coll}" data-op="delete" ${count ? '' : 'disabled'}>امسح المحدد</button>
    <button class="small ghost" data-act="clear-selection" data-coll="${coll}" ${count ? '' : 'disabled'}>إلغاء التحديد</button>
    <button class="small ghost" data-act="select-visible" data-coll="${coll}" data-on="1">حدد الكل</button>
    <span class="sep"></span>
    <span class="muted small">على الظاهر بس:</span>
    <button class="small ghost" data-act="bulk-filtered" data-coll="${coll}" data-op="include">اشمل</button>
    <button class="small ghost" data-act="bulk-filtered" data-coll="${coll}" data-op="exclude">استبعد</button>
  </div>`;
}

// ── Findings, in the owner's language ─────────────────────────────────────
// One entry per *kind* of problem, not per row: 42 rows of "duplicate item" is
// one decision the owner makes once, with a button that does it for all of them.
function groupFindings(findings) {
  const groups = new Map();
  for (const finding of findings) {
    if (!groups.has(finding.code)) {
      groups.set(finding.code, { code: finding.code, level: finding.level, items: [] });
    }
    groups.get(finding.code).items.push(finding);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.level !== b.level) return a.level === 'error' ? -1 : 1;
    return b.items.length - a.items.length;
  });
}

function findingsCard(findings, options = {}) {
  state.findings = findings;
  const title = options.title || 'الفحص — قبل ما تبني النسخة';
  if (!findings.length) {
    return `<div class="card"><h2>${title}</h2>
      <div class="note info">مفيش أي تنبيه. كل حاجة جاهزة للبناء.</div></div>`;
  }
  const groups = groupFindings(findings);
  const errors = findings.filter((finding) => finding.level === 'error').length;
  const warns = findings.filter((finding) => finding.level !== 'error').length;
  const body = groups.map((group) => {
    const guide = explainFinding({ code: group.code, level: group.level, message: '' });
    const rows = group.items.slice(0, options.limit || 4);
    const indexOf = (finding) => findings.indexOf(finding);
    return `<div class="finding ${group.level === 'error' ? 'blocking' : ''}">
      <div class="finding-head">
        <span class="badge ${group.level === 'error' ? 'danger' : 'warn'}">${group.level === 'error' ? 'مانع للبناء' : 'تنبيه'}</span>
        <b>${esc(guide.title)}</b>
        <span class="muted small">${num(group.items.length)} ${group.items.length === 1 ? 'صف' : 'صفوف'}</span>
      </div>
      <p class="why"><b>ليه؟</b> ${esc(guide.why)}</p>
      <p class="fix"><b>الحل:</b> ${esc(guide.fix)}</p>
      <div class="finding-rows">
        ${rows.map((finding) => `<div class="finding-row">
          <span class="msg">${esc(finding.message)}</span>
          ${finding.ref ? `<button class="small ghost" data-act="goto" data-i="${indexOf(finding)}">روح للصف</button>` : ''}
          ${guide.auto ? `<button class="small" data-act="auto-fix" data-i="${indexOf(finding)}">صلّحها لي</button>` : ''}
        </div>`).join('')}
        ${group.items.length > rows.length ? `<div class="muted small">و ${num(group.items.length - rows.length)} صف كمان بنفس المشكلة — نفس الحل بينطبق عليهم.</div>` : ''}
      </div>
    </div>`;
  }).join('');
  return `<div class="card">
    <h2>${title}</h2>
    <p class="lead">
      ${errors ? `<b style="color:var(--danger)">${num(errors)} مشكلة مانعة</b> لازم تتصلح قبل البناء. ` : '<b style="color:var(--ok)">مفيش حاجة مانعة للبناء.</b> '}
      ${warns ? `وفيه ${num(warns)} تنبيه مش مانع — يستحسن تشوفه.` : ''}
    </p>
    ${body}
  </div>`;
}

// ── Views ─────────────────────────────────────────────────────────────────
function viewOverview() {
  const plan = state.plan;
  const totals = planTotals(plan);
  const validation = validatePlan(plan);
  const source = plan.source;
  const errors = validation.findings.filter((finding) => finding.level === 'error').length;
  // The two things the owner actually stocks, side by side and never added
  // together: a phone is not an accessory, and a used phone is not a new one.
  const counts = totals.counts;
  const moving = [
    ['أقسام الإكسسوارات', validation.includes.categories, 'accessories', `${num(plan.categories.length)} قسم`],
    ['أصناف الإكسسوارات', counts.accessoryItems, 'accessories', `${num(counts.accessoryPieces)} قطعة`],
    ['الهواتف الجديدة', counts.phoneModels, 'phones', `${num(counts.phonePieces)} جهاز`],
    ['الهواتف المستعملة', counts.usedModels, 'phones', `${num(counts.usedDevices)} جهاز برقمه`],
    ['المبيعات التفصيلية', validation.includes.sales, 'sales', `${num(plan.sales.length)} بيعة`],
    ['بنود الشهور المجمّعة', validation.includes.summary, 'months', `${num(plan.summary.length)} بند`],
    ['الصيانة والسوفت وير', validation.includes.repairs, 'repairs', `${num(plan.repairs.length)} تذكرة`],
    ['المصاريف', validation.includes.expenses, 'expenses', `${num(plan.expenses.length)} مصروف`],
    ['المحافظ', validation.includes.wallets, 'wallets', `${num(plan.wallets.length)} محفظة`],
  ];
  return `
  ${state.notice ? note(state.notice) : ''}
  <div class="card">
    <h2>النظرة العامة</h2>
    <p class="lead">ده اللي الأداة فهمته من باكب القديم. من هنا: راجع الخريطة، عدّل اللي تحبه، وصلّح التنبيهات، وبعدين ابنِ النسخة.</p>
    <div class="grid-2">
      <div class="stat"><span>المحل</span><b>${esc(plan.settings.shopName)}</b></div>
      <div class="stat"><span>الفترة</span><b dir="ltr">${esc(source.firstDay || '—')} — ${esc(source.lastDay || '—')}</b></div>
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
    <h2>الأقسام — كل قسم في صفحته</h2>
    <p class="lead">مفيش قايمة جانبية: دوس على القسم تلاقي أصنافه وأعداده وأسعاره وأقسامه ومبيعاته في نفس الصفحة.</p>
    <div class="shelf-strip">
      <div class="shelf">
        <h3>الإكسسوارات</h3>
        ${countCard('أصناف', num(counts.accessoryItems))}
        ${countCard('قطع', num(counts.accessoryPieces), counts.accessoryPieces === 0 ? 'محتاجة أعداد' : 'هتنزل المخزن')}
        <div class="row" style="margin-top:10px">
          <button data-act="tab" data-tab="accessories">افتح الإكسسوارات</button>
        </div>
      </div>
      <div class="shelf used">
        <h3>الهواتف</h3>
        ${countCard('موديلات جديدة', num(counts.phoneModels), `${num(counts.phonePieces)} جهاز`)}
        ${countCard('موديلات مستعملة', num(counts.usedModels), `${num(counts.usedDevices)} جهاز برقمه`)}
        <div class="row" style="margin-top:10px">
          <button data-act="tab" data-tab="phones">افتح الهواتف</button>
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>من القديم للجديد — باختصار</h2>
    <div class="flow">
      <div class="flow-side">
        <span class="flow-title">في السيستم القديم</span>
        <span class="flow-item">كتالوج إكسسوارات + مخزن موبايلات + تصنيفات</span>
        <span class="flow-item">${num(source.days)} يوم فيه ${num(source.records)} حركة</span>
        <span class="flow-item">مبيعات، صيانة، سوفت وير، مصاريف، كاش</span>
      </div>
      <div class="flow-arrow">‹</div>
      <div class="flow-side new">
        <span class="flow-title">في السيستم الجديد</span>
        <span class="flow-item">المخزن ‹ ${num(validation.includes.items)} صنف تحت ${num(validation.includes.categories)} قسم</span>
        <span class="flow-item">المبيعات ‹ ${num(validation.includes.sales)} فاتورة تفصيلية + ${num(validation.includes.summary)} بند مجمّع</span>
        <span class="flow-item">الصيانة ‹ ${num(validation.includes.repairs)} تذكرة، والمصاريف ${num(validation.includes.expenses)}، والمحافظ ${num(validation.includes.wallets)}</span>
      </div>
    </div>
    <div class="row" style="margin-top:14px">
      <button class="primary" data-act="tab" data-tab="map">افتح الخريطة الكاملة</button>
      <span class="muted small">كل مفتاح في الملف القديم، رايح فين، وبأي شكل.</span>
    </div>
  </div>

  <div class="card">
    <h2>اللي هيتنقل</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>العنصر</th><th>فين في الجديد</th><th class="num">هيتنقل</th><th class="num">الإجمالي</th><th></th></tr></thead>
      <tbody>
        ${moving.map(([label, count, tab, total]) => `<tr>
          <td>${label}</td>
          <td class="muted small">${esc(DESTINATION_TEXT[tab] || '')}</td>
          <td class="num"><b>${num(count)}</b></td>
          <td class="num muted">${esc(total)}</td>
          <td class="actions"><button class="small ghost" data-act="tab" data-tab="${tab}">افتح</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </div>

  ${findingsCard(validation.findings, { title: `الفحص — قبل ما تبني النسخة (${errors ? `${num(errors)} مانع` : 'سليم'})` })}

  <div class="card">
    <h2>خطوات النقل</h2>
    <ol class="steps">
      <li><b>راجع الخريطة</b> — تعرف كل حاجة في القديم هتبقى إيه في الجديد. <button class="small ghost" data-act="tab" data-tab="map">افتح الخريطة</button></li>
      <li><b>راجع الإكسسوارات</b> — الأصناف وأقسامها، واكتب <b>الأعداد</b> اللي عندك دلوقتي. <button class="small ghost" data-act="tab" data-tab="accessories">افتح الإكسسوارات</button></li>
      <li><b>راجع الهواتف</b> — الجديد بعدده من مخزن القديم، والمستعمل بأجهزته وأرقامه. <button class="small ghost" data-act="tab" data-tab="phones">افتح الهواتف</button></li>
      <li><b>راجع الشهور</b> — تفصيلي للشهر الحالي، ومجمّع للي قبله. <button class="small ghost" data-act="tab" data-tab="months">افتح الشهور</button></li>
      <li><b>عدّل اللي تحبه</b> — أي صف فيه زرار «تفاصيل» بيفتح شكله في القديم والجديد، وتقدر تعدّل وترتّب وتدمج وتمسح.</li>
      <li><b>صلّح التنبيهات</b> — كل تنبيه فوق مكتوب فيه السبب والحل.</li>
      <li><b>ابنِ النسخة</b> — كلمة سر، وبعدين حمّل الملف واسترجعه في السيستم الجديد. <button class="small ghost" data-act="tab" data-tab="build">افتح البناء</button></li>
    </ol>
  </div>`;
}

const DESTINATION_TEXT = {
  categories: 'المخزن ‹ التصنيفات',
  brands: 'المخزن ‹ الماركات',
  items: 'المخزن ‹ الأصناف',
  accessories: 'صفحة الإكسسوارات ‹ المخزن',
  phones: 'قسم الهواتف ‹ رف جديد / رف مستعمل',
  sales: 'المبيعات ‹ الفواتير',
  months: 'المبيعات (تفصيلي / مجمّع)',
  summary: 'المبيعات ‹ الفاتورة المجمّعة',
  repairs: 'الصيانة ‹ التذاكر',
  expenses: 'المصاريف',
  wallets: 'المحافظ',
};

// ── The map: every old key, where it lands, and how many rows ─────────────
function viewMap() {
  const plan = state.plan;
  const legacy = state.legacy || { excluded: [], unknown: [] };
  const cashTotals = plan.cashOps.reduce((map, row) => {
    const month = row.date.slice(0, 7);
    map[month] = map[month] || { count: 0, fees: 0, moved: 0 };
    map[month].count += 1;
    map[month].fees += row.fee;
    map[month].moved += row.hasMovedAmount ? row.moved : 0;
    return map;
  }, {});
  return `
  <div class="card">
    <h2>كل حاجة في القديم... وتروح فين في الجديد</h2>
    <p class="lead">
      كل مفتاح في باكب السيستم القديم، ومعناه، والشكل اللي هيبقى عليه في السيستم الجديد، ومكانه بالظبط.
      دوس «افتح» عشان تشوف الصفوف نفسها وتعدّلها.
    </p>
    <div class="table-wrap"><table class="map-table">
      <thead><tr>
        <th>في السيستم القديم</th><th>هيتبقى إيه</th><th>فين في الجديد</th><th class="num">العدد</th><th></th>
      </tr></thead>
      <tbody>
        ${LEGACY_MAP.map((entry) => `<tr>
          <td>
            <b>${esc(entry.title)}</b>
            <div class="mono tiny">${esc(entry.key)}</div>
            <div class="muted small">${esc(entry.legacy)}</div>
          </td>
          <td>${esc(entry.plan)}</td>
          <td>
            <div>${esc(entry.dest)}</div>
            <div class="mono tiny muted">${esc(entry.inNew)}</div>
          </td>
          <td class="num"><b>${num(entry.count(legacy, plan))}</b></td>
          <td class="actions">${entry.tab ? `<button class="small ghost" data-act="tab" data-tab="${entry.tab}">افتح</button>` : '<span class="muted small">—</span>'}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </div>

  <div class="card">
    <h2>اللي مش هيتنقل</h2>
    <p class="lead">حاجات موجودة في الملف القديم، واتفقنا إنها متتنقلش. مفيش حاجة بتضيع من غير سبب مكتوب.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>الحاجة</th><th>المفتاح</th><th>ليه</th></tr></thead>
      <tbody>
        ${[
          ['الملاحظات', 'mshop_notes', 'ملاحظات شخصية مش بيانات محل'],
          ['التنبيهات', 'mshop_notifs', 'بتتولد من جديد في السيستم الجديد'],
          ['سلة المحذوفات', 'mshop_trash', 'حاجات اتمسحت أصلًا'],
          ['تاريخ الآلة الحاسبة', 'mshop_calc_hist', 'سجل أداة، مش بيانات'],
          ['كلمات السر', 'mshop_cfg.passMain / passAdmin', 'مش بتتنقل — وبعد الترحيل المحل بيفتح من غير كلمة سر وتعمل واحدة جديدة'],
          ['مفاتيح تشغيل', 'mshop_last_backup / drive_return / tab_order', 'إعدادات البرنامج القديم نفسه'],
        ].map(([label, key, why]) => `<tr><td>${label}</td><td class="mono tiny">${esc(key)}</td><td class="muted small">${why}</td></tr>`).join('')}
      </tbody>
    </table></div>
    ${(legacy.excluded || []).length ? `<div class="note info" style="margin-top:12px">
      <b>لقيت في ملفك كمان:</b> ${legacy.excluded.map((entry) => esc(entry.label || entry.key)).join('، ')}.
      دول مش بيتنقلوا لنفس الأسباب اللي فوق.
    </div>` : ''}
    ${(legacy.unknown || []).length ? `<div class="note warn" style="margin-top:12px">
      <b>مفاتيح مش معروفة للأداة:</b> <span class="mono tiny">${legacy.unknown.map((entry) => esc(entry.key || entry)).join('، ')}</span> —
      دي حاجات مش في النسخة اللي الأداة متعودة عليه. مش هتتنقل، ولو ليها قيمة عندك قولّي وأنا أضيفها.
    </div>` : ''}
  </div>

  <div class="card">
    <h2>حركات الكاش — بتتحسب بس</h2>
    <p class="lead">
      ${num(plan.cashOps.length)} حركة في القديم. البرنامج القديم كان بيسجّل <b>العمولة</b> في خانة «المبلغ»
      (ومرّة واحدة بس سجّل المبلغ اللي اتحرك). عشان كده مش بتتحول لحركات محافظ — كانت هتخترع أرصدة.
      أرقام العمولات دي بتظهر في التقرير وفي جدول الشهور.
    </p>
    <div class="table-wrap"><table>
      <thead><tr><th>الشهر</th><th class="num">حركات</th><th class="num">عمولات</th><th class="num">مبالغ اتحركت (معروفة)</th></tr></thead>
      <tbody>
        ${Object.entries(cashTotals).map(([month, entry]) => `<tr>
          <td>${esc(monthLabel(month))}</td>
          <td class="num">${num(entry.count)}</td>
          <td class="num">${money(entry.fees)} ج</td>
          <td class="num">${money(entry.moved)} ج</td>
        </tr>`).join('') || emptyRow(4, 'مفيش حركات كاش.')}
      </tbody>
    </table></div>
  </div>`;
}

// ── Departments ───────────────────────────────────────────────────────────
// One page per department: the shop's accessories are a page, the shop's phones
// are a page, and each page holds everything about its own kind — the sections it
// is filed under, the items themselves with their numbers and prices, and the
// money they made. No side list, no tab-hunting: adding a row, changing a count
// and fixing a name all happen in the row you are looking at.

/** The items of one department, as the page shows them. */
function departmentRows(kind) {
  const shelf = state.filters.shelf ?? 'all';
  return state.plan.items.filter((item) => {
    if (kind === 'accessory') return item.kind === 'accessory';
    if (kind === 'phone') return item.kind === 'phone';
    if (kind === 'used') return item.kind === 'used';
    return item.kind === 'phone' || item.kind === 'used';
  }).filter((item) => {
    if (kind === 'all' && shelf !== 'all' && item.kind !== shelf) return false;
    if (state.filters.category !== 'all' && (item.categoryId || '') !== state.filters.category) return false;
    if (state.filters.missing === '1') {
      const empty = item.kind === 'used' ? (item.devices ?? []).length === 0 : !(item.qty > 0);
      if (!empty) return false;
    }
    const query = normalizeText(state.filters.search).toLowerCase();
    if (query && !`${item.name} ${item.model}`.toLowerCase().includes(query)) return false;
    return true;
  });
}

const piecesOf = (item) => (item.kind === 'used' ? (item.devices ?? []).length : Math.max(0, Math.trunc(Number(item.qty) || 0)));
const sumBy = (rows, pick) => rows.reduce((total, row) => total + (Number(pick(row)) || 0), 0);

/** A count cell that can be typed into or stepped, without a second screen. */
function countCell(item) {
  if (item.kind === 'used') {
    const devices = (item.devices ?? []).length;
    return `<td class="num">
      <button class="small" data-act="details" data-coll="items" data-id="${esc(item.id)}" title="أضف أجهزة بأرقام IMEI">
        ${num(devices)} جهاز ${devices ? '· عدّل' : '· أضف'}
      </button></td>`;
  }
  return `<td class="num"><span class="stepper">
    <button class="tiny" data-act="bump" data-coll="items" data-id="${esc(item.id)}" data-delta="-1" title="أقل بواحد">-</button>
    <input type="number" step="1" min="0" value="${item.qty}" data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="qty" data-type="int">
    <button class="tiny" data-act="bump" data-coll="items" data-id="${esc(item.id)}" data-delta="1" title="أكتر بواحد">+</button>
  </span></td>`;
}

function countCard(label, value, hint = '') {
  return `<div class="count-card"><span>${esc(label)}</span><b>${value}</b>${hint ? `<small>${esc(hint)}</small>` : ''}</div>`;
}

/** The sections this department's rows are filed under, with their own controls. */
function departmentSections(coll, rows, kinds) {
  const ids = new Set(rows.map((row) => row.categoryId).filter(Boolean));
  const categories = state.plan.categories.filter((category) => ids.has(category.id) || kinds.includes(category.kind));
  return `<div class="card">
    <h2>الأقسام اللي بيتحط تحتها</h2>
    <p class="lead">
      دي الأقسام اللي هتظهر في <b>المخزن ‹ التصنيفات</b>. تقدر تسمّيها، ترتّبها، تدمج اتنين
      في واحد (وكل الأصناف تتحوّل على الباقي)، أو تضيف قسم جديد من هنا.
    </p>
    <div class="row" style="margin-bottom:10px">
      <button data-act="add-category" data-kind="${kinds[0]}">+ قسم جديد</button>
      ${selectionBar('categories', { merge: true })}
    </div>
    <div class="table-wrap"><table>
      <thead><tr>
        ${selectHeader('categories', categories)}<th>يتنقل</th><th>الاسم</th><th>النوع</th><th>الترتيب</th><th class="num">أصناف</th><th></th>
      </tr></thead>
      <tbody>
        ${categories.map((category) => `<tr class="${category.include ? '' : 'excluded'}">
          ${selectCell('categories', category)}
          ${includeCell('categories', category)}
          <td><input type="text" value="${esc(category.name)}" data-act="field" data-coll="categories" data-id="${esc(category.id)}" data-field="name"></td>
          <td><select data-act="field" data-coll="categories" data-id="${esc(category.id)}" data-field="kind">
            ${[['item', 'بضاعة بالعدد'], ['phone', 'موبايلات جديدة'], ['used', 'مستعمل']].map(([value, label]) => `<option value="${value}" ${category.kind === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select></td>
          <td><div class="order">
            <button class="tiny" data-act="up" data-coll="categories" data-id="${esc(category.id)}" title="فوق"><span class="tri up"></span></button>
            <span>${category.sortOrder}</span>
            <button class="tiny" data-act="down" data-coll="categories" data-id="${esc(category.id)}" title="تحت"><span class="tri down"></span></button>
          </div></td>
          <td class="num"><span class="badge plain">${num(state.plan.items.filter((item) => item.categoryId === category.id).length)}</span></td>
          ${detailsCell('categories', category)}
        </tr>`).join('') || emptyRow(7, 'مفيش أقسام لسه — دوس «+ قسم جديد».')}
      </tbody>
    </table></div>
  </div>`;
}

/** What one department sold, from the months that keep their sales. */
function departmentSalesCard(label, sections) {
  const rows = state.plan.sales.filter((sale) => sale.include && sections.includes(sale.section));
  const byMonth = new Map();
  for (const sale of rows) {
    const month = sale.date.slice(0, 7);
    const entry = byMonth.get(month) || { count: 0, pieces: 0, total: 0, cost: 0 };
    entry.count += 1;
    entry.pieces += sale.qty;
    entry.total += sale.sell * sale.qty;
    entry.cost += sale.buy * sale.qty;
    byMonth.set(month, entry);
  }
  const total = {
    count: sumBy([...byMonth.values()], (entry) => entry.count),
    pieces: sumBy([...byMonth.values()], (entry) => entry.pieces),
    total: sumBy([...byMonth.values()], (entry) => entry.total),
    cost: sumBy([...byMonth.values()], (entry) => entry.cost),
  };
  return `<div class="card">
    <h2>مبيعات ${label} — في الشهور اللي بتتنقل بالتفصيل</h2>
    <p class="lead">
      الشهور القديمة بتتنقل مجمّعة (رقم الشهر بس)، فمبيعاتها مش بتتفصّل هنا. الجدول ده للشهور
      اللي اخترت إنها تتنقل <b>تفصيلي</b> — نفس اللي هيبان في «المبيعات ‹ الفواتير».
    </p>
    <div class="table-wrap"><table>
      <thead><tr><th>الشهر</th><th class="num">بيعات</th><th class="num">قطع</th><th class="num">المبيعات</th><th class="num">التكلفة</th><th class="num">الربح</th></tr></thead>
      <tbody>
        ${[...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, entry]) => `<tr>
          <td>${esc(monthLabel(month))}</td>
          <td class="num">${num(entry.count)}</td>
          <td class="num">${num(entry.pieces)}</td>
          <td class="num">${money(entry.total)}</td>
          <td class="num">${money(entry.cost)}</td>
          <td class="num">${money(entry.total - entry.cost)}</td>
        </tr>`).join('') || emptyRow(6, 'مفيش مبيعات تفصيلية للقسم ده.')}
      </tbody>
      ${byMonth.size ? `<tfoot><tr><th>الإجمالي</th><th class="num">${num(total.count)}</th><th class="num">${num(total.pieces)}</th><th class="num">${money(total.total)}</th><th class="num">${money(total.cost)}</th><th class="num">${money(total.total - total.cost)}</th></tr></tfoot>` : ''}
    </table></div>
  </div>`;
}

// ── Accessories ───────────────────────────────────────────────────────────
function viewAccessories() {
  const all = state.plan.items.filter((item) => item.kind === 'accessory');
  const rows = departmentRows('accessory');
  const sliced = rows.slice(0, PAGE_SIZE * 3);
  const withoutCount = all.filter((item) => !(item.qty > 0)).length;
  const categoryName = new Map(state.plan.categories.map((category) => [category.id, category.name]));
  return `
  ${state.notice ? note(state.notice) : ''}
  <div class="card">
    <h2>الإكسسوارات — كل حاجة خاصة بيهم في صفحة واحدة</h2>
    <p class="lead">
      الأصناف وأقسامها والأعداد والأسعار ومبيعاتهم. <b>العدد اللي بتكتبه هو اللي عندك دلوقتي</b>،
      وهو اللي هيفتح بيه المخزن في السيستم الجديد.
    </p>
    <div class="counts-strip">
      ${countCard('أصناف', num(all.length), `منهم ${num(all.filter((item) => item.include).length)} هيتنقلوا`)}
      ${countCard('قطع', num(sumBy(all.filter((item) => item.include), piecesOf)), 'اللي هتنزل المخزن')}
      ${countCard('قيمة الشراء', `${money(sumBy(all, (item) => item.buy * piecesOf(item)))} ج`, 'بعدد اليوم')}
      ${countCard('قيمة البيع', `${money(sumBy(all, (item) => (item.sell ?? 0) * piecesOf(item)))} ج`, 'لو اتباعوا بسعرهم')}
      ${countCard('من غير عدد', num(withoutCount), withoutCount ? 'محتاجين عدد' : 'كلهم بعددهم')}
    </div>
    ${withoutCount
      ? `<div class="note warn">
          <b>${num(withoutCount)} صنف من غير عدد.</b> القديم مكانش بيسجّل عدد الإكسسوارات خالص، فالأعداد هنا
          هي اللي هتنزل المخزن. دوس <b>«الأعداد»</b> تحت وهتلاقي الأصناف اللي محتاجة رقم جنب خانة العدد.
        </div>`
      : ''}
  </div>

  <div class="card" data-dept="accessories">
    <div class="row between" style="margin-bottom:10px">
      <div class="row">
        <input type="text" class="grow" placeholder="دوّر بالاسم…" data-act="search" value="${esc(state.filters.search)}">
        <select data-act="filter" data-filter="category" style="max-width:220px">
          <option value="all" ${state.filters.category === 'all' ? 'selected' : ''}>كل الأقسام</option>
          ${state.plan.categories.filter((category) => category.include).map((category) => `<option value="${esc(category.id)}" ${state.filters.category === category.id ? 'selected' : ''}>${esc(category.name)}</option>`).join('')}
        </select>
        <button class="small ${state.filters.missing === '1' ? 'primary' : ''}" data-act="filter-toggle" data-filter="missing" data-on="${state.filters.missing === '1' ? '0' : '1'}" data-dept="accessories">
          الأعداد (${num(withoutCount)})
        </button>
      </div>
      <button data-act="add-item" data-kind="accessory">+ إكسسوار جديد</button>
    </div>
    ${selectionBar('items', { merge: true, moveToCategory: true })}
    ${bulkCountBar('items')}
    <div class="table-wrap"><table>
      <thead><tr>
        ${selectHeader('items', rows)}<th>يتنقل</th><th>الاسم</th><th>القسم</th>
        <th class="num">شراء</th><th class="num">بيع</th><th class="num">العدد</th><th class="num">قيمة العدد</th><th></th>
      </tr></thead>
      <tbody>
        ${sliced.map((item) => `<tr class="${item.include ? '' : 'excluded'}">
          ${selectCell('items', item)}
          ${includeCell('items', item)}
          <td><input type="text" value="${esc(item.name)}" data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="name" style="min-width:190px"></td>
          <td><select data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="categoryId" style="min-width:150px">${categoryOptions(item.categoryId)}</select></td>
          <td class="num"><input type="number" step="0.01" value="${item.buy}" data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="buy" data-type="float" style="width:90px"></td>
          <td class="num"><input type="number" step="0.01" value="${item.sell ?? ''}" placeholder="—" data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="sell" data-type="float" style="width:90px"></td>
          ${countCell(item)}
          <td class="num">${money((item.sell ?? 0) * piecesOf(item))}</td>
          ${detailsCell('items', item)}
        </tr>`).join('') || emptyRow(9, 'مفيش إكسسوارات مطابقة.')}
      </tbody>
    </table></div>
    ${rows.length > sliced.length ? `<p class="muted small">بيبان ${num(sliced.length)} من ${num(rows.length)} — استخدم البحث لتضييق اللستة.</p>` : ''}
    <p class="muted small" style="margin:10px 0 0">
      إجمالي الظاهر: <b>${num(sumBy(rows, piecesOf))}</b> قطعة، بيع بـ<b>${money(sumBy(rows, (item) => (item.sell ?? 0) * piecesOf(item)))}</b> ج.
      ${categoryName.size ? '' : ''}
    </p>
  </div>

  ${departmentSections('categories', all, ['item'])}
  ${departmentSalesCard('الإكسسوارات', ['acc'])}
  `;
}

// ── Phones ────────────────────────────────────────────────────────────────
function viewPhones() {
  const fresh = state.plan.items.filter((item) => item.kind === 'phone');
  const used = state.plan.items.filter((item) => item.kind === 'used');
  const shelf = state.filters.shelf ?? 'all';
  const rows = departmentRows('all');
  const freshRows = rows.filter((item) => item.kind === 'phone');
  const usedRows = rows.filter((item) => item.kind === 'used');
  const brands = state.plan.brands;
  const brandName = new Map(brands.map((brand) => [brand.id, brand.name]));
  const devicesTotal = sumBy(used, (item) => (item.devices ?? []).length);
  const usedWithoutDevices = used.filter((item) => !(item.devices ?? []).length).length;

  return `
  ${state.notice ? note(state.notice) : ''}
  <div class="card">
    <h2>الهواتف — رفّين، كل واحد لوحده</h2>
    <p class="lead">
      زي قسم «الهواتف» في السيستم الجديد بالظبط: <b>الجديد</b> و<b>المستعمل</b> مبيختلطوش — لا في
      جدول ولا في إجمالي. الجديد بينزل بعدده من مخزن القديم، والمستعمل بينزل بأجهزته وأرقامها.
    </p>
    <div class="shelf-strip">
      <div class="shelf new">
        <h3>جديد</h3>
        ${countCard('موديلات', num(fresh.length))}
        ${countCard('أجهزة', num(sumBy(fresh.filter((item) => item.include), piecesOf)), 'بتنزل المخزن بالعدد')}
        ${countCard('تكلفة', `${money(sumBy(fresh, (item) => item.buy * piecesOf(item)))} ج`)}
        ${countCard('سعر البيع', `${money(sumBy(fresh, (item) => (item.sell ?? 0) * piecesOf(item)))} ج`)}
      </div>
      <div class="shelf used">
        <h3>مستعمل</h3>
        ${countCard('موديلات', num(used.length))}
        ${countCard('أجهزة', num(devicesTotal), 'بأرقام IMEI')}
        ${countCard('تكلفة', `${money(sumBy(used, (item) => (item.devices ?? []).reduce((total, device) => total + (device.cost ?? item.buy), 0)))} ج`)}
        ${countCard('سعر البيع', `${money(sumBy(used, (item) => (item.sell ?? 0) * (item.devices ?? []).length))} ج`)}
      </div>
    </div>
    ${usedWithoutDevices
      ? `<div class="note warn">
          <b>${num(usedWithoutDevices)} موديل مستعمل من غير أجهزة مسجّلة.</b> القديم كان بيسجّل اسم المستعمل
          وسعره بس — مفيش عدد ولا أرقام. قسم «الهواتف» بيرفع المستعمل بالرقم والحالة، فالموديل من غير
          أجهزة هيفضل في الكتالوج ومش هيبان على الرف. لو عندك منه دلوقتي: دوس <b>«أضف جهاز»</b> والصق الأرقام.
        </div>`
      : ''}
  </div>

  <div class="card" data-dept="phones">
    <div class="row between" style="margin-bottom:10px">
      <div class="row">
        <input type="text" class="grow" placeholder="دوّر بالموديل أو الشركة…" data-act="search" value="${esc(state.filters.search)}">
        <select data-act="filter" data-filter="shelf" style="max-width:170px">
          <option value="all" ${shelf === 'all' ? 'selected' : ''}>الرفّين</option>
          <option value="phone" ${shelf === 'phone' ? 'selected' : ''}>جديد بس</option>
          <option value="used" ${shelf === 'used' ? 'selected' : ''}>مستعمل بس</option>
        </select>
        <button class="small ${state.filters.missing === '1' ? 'primary' : ''}" data-act="filter-toggle" data-filter="missing" data-on="${state.filters.missing === '1' ? '0' : '1'}">
          اللي من غير عدد/أجهزة
        </button>
      </div>
      <div class="row">
        <button data-act="add-item" data-kind="phone">+ موبايل جديد</button>
        <button data-act="add-item" data-kind="used">+ مستعمل</button>
      </div>
    </div>
    ${selectionBar('items', { merge: true, moveToCategory: true })}

    <h3 class="shelf-title new">رف «جديد» — من مخزن القديم بعدده</h3>
    <div class="table-wrap"><table data-shelf="new">
      <thead><tr>
        ${selectHeader('items', freshRows)}<th>يتنقل</th><th>الموديل</th><th>الشركة</th>
        <th class="num">رام</th><th class="num">مساحة</th><th class="num">شراء</th><th class="num">بيع</th>
        <th class="num">العدد</th><th class="num">تكلفة العدد</th><th></th>
      </tr></thead>
      <tbody>
        ${freshRows.map((item) => `<tr class="${item.include ? '' : 'excluded'}">
          ${selectCell('items', item)}
          ${includeCell('items', item)}
          <td><input type="text" value="${esc(item.name)}" data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="name" style="min-width:180px"></td>
          <td><select data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="brandId" style="min-width:130px">${brandOptions(item.brandId)}</select></td>
          <td class="num"><input type="number" value="${item.ramGb ?? ''}" data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="ramGb" data-type="int" style="width:70px"></td>
          <td class="num"><input type="number" value="${item.storageGb ?? ''}" data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="storageGb" data-type="int" style="width:80px"></td>
          <td class="num"><input type="number" step="0.01" value="${item.buy}" data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="buy" data-type="float" style="width:95px"></td>
          <td class="num"><input type="number" step="0.01" value="${item.sell ?? ''}" placeholder="—" data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="sell" data-type="float" style="width:95px"></td>
          ${countCell(item)}
          <td class="num">${money(item.buy * piecesOf(item))}</td>
          ${detailsCell('items', item)}
        </tr>`).join('') || emptyRow(11, 'مفيش موبايلات جديدة مطابقة.')}
      </tbody>
      ${freshRows.length ? `<tfoot><tr><th colspan="7">إجمالي الجديد</th><th class="num">${num(sumBy(freshRows, piecesOf))}</th><th class="num">${money(sumBy(freshRows, (item) => item.buy * piecesOf(item)))}</th><th></th></tr></tfoot>` : ''}
    </table></div>

    <h3 class="shelf-title used">رف «مستعمل» — كل جهاز برقمه وحالته</h3>
    <div class="table-wrap"><table data-shelf="used">
      <thead><tr>
        ${selectHeader('items', usedRows)}<th>يتنقل</th><th>الموديل</th><th class="num">شراء</th><th class="num">بيع</th>
        <th class="num">أجهزة (IMEI)</th><th class="num">تكلفة الأجهزة</th><th></th>
      </tr></thead>
      <tbody>
        ${usedRows.map((item) => `<tr class="${item.include ? '' : 'excluded'}">
          ${selectCell('items', item)}
          ${includeCell('items', item)}
          <td><input type="text" value="${esc(item.name)}" data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="name" style="min-width:190px"></td>
          <td class="num"><input type="number" step="0.01" value="${item.buy}" data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="buy" data-type="float" style="width:95px"></td>
          <td class="num"><input type="number" step="0.01" value="${item.sell ?? ''}" placeholder="—" data-act="field" data-coll="items" data-id="${esc(item.id)}" data-field="sell" data-type="float" style="width:95px"></td>
          ${countCell(item)}
          <td class="num">${money((item.devices ?? []).reduce((total, device) => total + (device.cost ?? item.buy), 0))}</td>
          ${detailsCell('items', item)}
        </tr>`).join('') || emptyRow(8, 'مفيش مستعمل مطابق.')}
      </tbody>
      ${usedRows.length ? `<tfoot><tr><th colspan="5">إجمالي المستعمل</th><th class="num">${num(sumBy(usedRows, (item) => (item.devices ?? []).length))}</th><th class="num">${money(sumBy(usedRows, (item) => (item.devices ?? []).reduce((total, device) => total + (device.cost ?? item.buy), 0)))}</th><th></th></tr></tfoot>` : ''}
    </table></div>
  </div>

  <div class="card">
    <div class="row between" style="margin-bottom:10px">
      <div>
        <h2>شركات الموبايلات</h2>
        <p class="lead" style="margin:0">
          «صنف جديد» في السيستم الجديد بيطلب الشركة الأول. ادمج أي شركتين في واحدة من هنا.
        </p>
      </div>
      <div class="row">
        <button data-act="add-brand">+ شركة جديدة</button>
      </div>
    </div>
    ${selectionBar('brands', { merge: true })}
    <div class="table-wrap"><table>
      <thead><tr>${selectHeader('brands', brands)}<th>يتنقل</th><th>الاسم</th><th>النوع</th><th>الترتيب</th><th class="num">موبايلات</th><th></th></tr></thead>
      <tbody>
        ${brands.map((brand) => `<tr class="${brand.include ? '' : 'excluded'}">
          ${selectCell('brands', brand)}
          ${includeCell('brands', brand)}
          <td><input type="text" value="${esc(brand.name)}" data-act="field" data-coll="brands" data-id="${esc(brand.id)}" data-field="name"></td>
          <td><select data-act="field" data-coll="brands" data-id="${esc(brand.id)}" data-field="deviceType">
            ${[['touch', 'تاتش'], ['keypad', 'زراير'], ['both', 'الاتنين']].map(([value, label]) => `<option value="${value}" ${brand.deviceType === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select></td>
          <td><div class="order">
            <button class="tiny" data-act="up" data-coll="brands" data-id="${esc(brand.id)}"><span class="tri up"></span></button>
            <span>${brand.sortOrder}</span>
            <button class="tiny" data-act="down" data-coll="brands" data-id="${esc(brand.id)}"><span class="tri down"></span></button>
          </div></td>
          <td class="num"><span class="badge plain">${num(state.plan.items.filter((item) => item.brandId === brand.id).length)}</span></td>
          ${detailsCell('brands', brand)}
        </tr>`).join('') || emptyRow(7, 'مفيش شركات.')}
      </tbody>
    </table></div>
    <p class="muted small">${num(brands.length)} شركة — ${num(fresh.length)} موديل جديد و${num(used.length)} موديل مستعمل عليهم.</p>
  </div>

  ${departmentSalesCard('الموبايلات', ['phones', 'used'])}
  `;
}

// ── Months ────────────────────────────────────────────────────────────────
function viewMonths() {
  const plan = state.plan;
  return `
  ${state.notice ? note(state.notice) : ''}
  <div class="card">
    <h2>الشهور ‹ شكل المبيعات في السيستم الجديد</h2>
    <p class="lead">
      كل شهر تختار: <b>تفصيلي</b> (كل بيعة لوحدها)، أو <b>مجمّع</b> (فاتورة واحدة للشهر بسطر لكل قسم — رقم الشهر بس)،
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
      <thead><tr><th>يتنقل</th><th>الشهر</th><th>الطريقة</th><th class="num">مبيعات</th><th class="num">تكلفة</th><th class="num">ربح</th><th class="num">مصاريف</th><th class="num">صيانة</th><th class="num">كاش</th><th>هينتقل إيه</th><th></th></tr></thead>
      <tbody>
        ${plan.months.map((month) => {
          const detailCount = plan.sales.filter((sale) => sale.include && sale.date.startsWith(month.month)).length;
          const summaryCount = plan.summary.filter((row) => row.include && row.month === month.month).length;
          const totals = month.totals || {};
          return `<tr class="${month.include && month.mode !== 'skip' ? '' : 'excluded'}">
            ${includeCell('months', month)}
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
            <td class="small">${month.mode === 'detail' ? `${num(detailCount)} فاتورة تفصيلية` : month.mode === 'summary' ? `${num(summaryCount)} بند في فاتورة واحدة` : '<span class="muted">—</span>'}</td>
            ${detailsCell('months', month)}
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>
    <div class="note info" style="margin-top:12px">
      الصيانة والسوفت وير والمصاريف وعمولات الكاش بتتنقل <b>كلها</b> بأرقامها، لأنها مش مبيعات ومش كتير — وده اللي بيخلي رقم كل شهر في التقارير صح.
    </div>
  </div>

  <div class="card">
    <h2>بنود الشهور المجمّعة</h2>
    <p class="lead">كل سطر هنا بيبقى بند جوه فاتورة الشهر. تقدر تشيل أي سطر، أو ترتّبه (الترتيب هو ترتيب البنود في الفاتورة).</p>
    ${selectionBar('summary')}
    <div class="table-wrap"><table>
      <thead><tr>${selectHeader('summary', plan.summary.slice(0, 500))}<th>يتنقل</th><th>الشهر</th><th>القسم</th><th>البند</th><th class="num">عدد</th><th class="num">مبيعات</th><th class="num">تكلفة</th><th>ترتيب</th><th></th></tr></thead>
      <tbody>
        ${plan.summary.slice(0, 500).map((row) => `<tr class="${row.include ? '' : 'excluded'}">
          ${selectCell('summary', row)}
          ${includeCell('summary', row)}
          <td>${esc(monthLabel(row.month))}</td>
          <td><span class="badge plain">${row.section === 'acc' ? 'إكسسوار' : row.section === 'used' ? 'مستعمل' : 'موبايل'}</span></td>
          <td>${esc(row.label)}</td>
          <td class="num">${num(row.count)}</td>
          <td class="num">${money(row.total)}</td>
          <td class="num">${money(row.cost)}</td>
          <td><div class="order"><button class="tiny" data-act="up" data-coll="summary" data-id="${esc(row.id)}"><span class="tri up"></span></button>
            <button class="tiny" data-act="down" data-coll="summary" data-id="${esc(row.id)}"><span class="tri down"></span></button></div></td>
          ${detailsCell('summary', row)}
        </tr>`).join('')}
      </tbody>
    </table></div>
    ${plan.summary.length > 500 ? `<div class="pager">بيعرض أول 500 سطر من ${num(plan.summary.length)} — الباقي بيتنقل زي ما هو.</div>` : ''}
  </div>`;
}

// ── Sales ─────────────────────────────────────────────────────────────────
function viewSales() {
  const detailMonths = state.plan.months.filter((month) => month.include && month.mode === 'detail').map((month) => month.month);
  let rows = state.plan.sales.filter((sale) => detailMonths.includes(sale.date.slice(0, 7)));
  if (state.filters.month !== 'all') rows = rows.filter((sale) => sale.date.startsWith(state.filters.month));
  const { filtered, slice, page, pageCount } = filteredAndPaged('sales', rows, (row) => `${row.name} ${row.date}`);
  const total = filtered.filter((row) => row.include).reduce((sum, row) => sum + row.sell * row.qty, 0);
  const cost = filtered.filter((row) => row.include).reduce((sum, row) => sum + row.buy * row.qty, 0);
  const categoryName = new Map(state.plan.categories.map((category) => [category.id, category.name]));
  return `
  <div class="card">
    <h2>المبيعات التفصيلية ‹ المبيعات ‹ الفواتير</h2>
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
    </div>
    ${selectionBar('sales')}
    <div class="table-wrap"><table>
      <thead><tr>${selectHeader('sales', filtered)}<th>يتنقل</th><th>التاريخ</th><th>الوقت</th><th>الصنف</th><th>القسم</th><th class="num">الكمية</th><th class="num">شراء</th><th class="num">بيع</th><th class="num">الإجمالي</th><th></th></tr></thead>
      <tbody>
        ${slice.map((sale) => {
          const item = state.plan.items.find((entry) => entry.id === sale.itemId);
          return `<tr class="${sale.include ? '' : 'excluded'}">
            ${selectCell('sales', sale)}
            ${includeCell('sales', sale)}
            <td class="mono">${esc(sale.date)}</td>
            <td class="mono">${esc(sale.clock)}</td>
            <td>${esc(sale.name)}</td>
            <td class="small">${esc(categoryName.get(item?.categoryId) || (sale.section === 'used' ? 'مستعمل' : sale.section === 'phones' ? 'موبايلات' : 'إكسسوارات'))}</td>
            <td class="num"><input type="number" value="${sale.qty}" data-act="field" data-coll="sales" data-id="${esc(sale.id)}" data-field="qty" data-type="int" style="width:65px"></td>
            <td class="num"><input type="number" step="0.01" value="${sale.buy}" data-act="field" data-coll="sales" data-id="${esc(sale.id)}" data-field="buy" data-type="float" style="width:85px"></td>
            <td class="num"><input type="number" step="0.01" value="${sale.sell}" data-act="field" data-coll="sales" data-id="${esc(sale.id)}" data-field="sell" data-type="float" style="width:85px"></td>
            <td class="num">${money(sale.sell * sale.qty)}</td>
            ${detailsCell('sales', sale)}
          </tr>`;
        }).join('') || emptyRow(11, 'مفيش مبيعات تفصيلية — يمكن كل الشهور مجمّعة.')}
      </tbody>
    </table></div>
    ${pager('sales', page, pageCount, filtered.length)}
  </div>`;
}

// ── Repairs ───────────────────────────────────────────────────────────────
function viewRepairs() {
  let rows = state.plan.repairs;
  if (state.filters.repairKind !== 'all') rows = rows.filter((row) => row.kind === state.filters.repairKind);
  const { filtered, slice, page, pageCount } = filteredAndPaged('repairs', rows, (row) => `${row.ticketNo} ${row.deviceName} ${row.issue}`);
  const total = filtered.filter((row) => row.include).reduce((sum, row) => sum + row.price, 0);
  return `
  <div class="card">
    <h2>الصيانة والسوفت وير ‹ الصيانة ‹ التذاكر</h2>
    <p class="lead">${num(filtered.length)} تذكرة — إجمالي ${money(total)} ج. كل تذكرة بتتنقل بتاريخها وحالتها.</p>
    <div class="row" style="margin-bottom:10px">
      <input type="text" class="grow" placeholder="دوّر برقم التذكرة أو الجهاز…" data-act="search" value="${esc(state.filters.search)}">
      <select data-act="filter" data-filter="repairKind" style="max-width:180px">
        <option value="all" ${state.filters.repairKind === 'all' ? 'selected' : ''}>النوعين</option>
        <option value="hardware" ${state.filters.repairKind === 'hardware' ? 'selected' : ''}>صيانة</option>
        <option value="software" ${state.filters.repairKind === 'software' ? 'selected' : ''}>سوفت وير</option>
      </select>
      <button data-act="add-repair">+ تذكرة</button>
    </div>
    ${selectionBar('repairs')}
    <div class="table-wrap"><table>
      <thead><tr>${selectHeader('repairs', filtered)}<th>يتنقل</th><th>التاريخ</th><th>النوع</th><th>التذكرة</th><th>الجهاز</th><th>العيب</th><th class="num">قطعة</th><th class="num">المبلغ</th><th>تسليم</th><th></th></tr></thead>
      <tbody>
        ${slice.map((repair) => `<tr class="${repair.include ? '' : 'excluded'}">
          ${selectCell('repairs', repair)}
          ${includeCell('repairs', repair)}
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
          ${detailsCell('repairs', repair)}
        </tr>`).join('') || emptyRow(11, 'مفيش تذاكر مطابقة.')}
      </tbody>
    </table></div>
    ${pager('repairs', page, pageCount, filtered.length)}
  </div>`;
}

// ── Expenses ──────────────────────────────────────────────────────────────
function viewExpenses() {
  const { filtered, slice, page, pageCount } = filteredAndPaged('expenses', state.plan.expenses, (row) => row.category);
  const total = filtered.filter((row) => row.include).reduce((sum, row) => sum + row.amount, 0);
  return `
  <div class="card">
    <h2>المصاريف ‹ المصاريف</h2>
    <p class="lead">${num(filtered.length)} مصروف — ${money(total)} ج. بتتنقل كـ«مدفوعة من برّه الدرج» بتاريخها، عشان متتحاجش وردية مفتوحة.</p>
    <div class="row" style="margin-bottom:10px">
      <input type="text" class="grow" placeholder="دوّر بالتصنيف…" data-act="search" value="${esc(state.filters.search)}">
      <button data-act="add-expense">+ مصروف</button>
    </div>
    ${selectionBar('expenses')}
    <div class="table-wrap"><table>
      <thead><tr>${selectHeader('expenses', filtered)}<th>يتنقل</th><th>التاريخ</th><th>التصنيف</th><th class="num">المبلغ</th><th></th></tr></thead>
      <tbody>
        ${slice.map((expense) => `<tr class="${expense.include ? '' : 'excluded'}">
          ${selectCell('expenses', expense)}
          ${includeCell('expenses', expense)}
          <td class="mono">${esc(expense.date)}</td>
          <td><input type="text" value="${esc(expense.category)}" list="expense-cats" data-act="field" data-coll="expenses" data-id="${esc(expense.id)}" data-field="category"></td>
          <td class="num"><input type="number" step="0.01" value="${expense.amount}" data-act="field" data-coll="expenses" data-id="${esc(expense.id)}" data-field="amount" data-type="float" style="width:100px"></td>
          ${detailsCell('expenses', expense)}
        </tr>`).join('') || emptyRow(5, 'مفيش مصاريف مطابقة.')}
      </tbody>
    </table></div>
    <datalist id="expense-cats">${state.plan.expenseCategories.filter((category) => category.include).map((category) => `<option value="${esc(category.name)}"></option>`).join('')}</datalist>
    ${pager('expenses', page, pageCount, filtered.length)}
  </div>`;
}

// ── Wallets ───────────────────────────────────────────────────────────────
function viewWallets() {
  const methods = { vf: 'فودافون كاش', instapay: 'إنستاباي' };
  return `
  ${state.notice ? note(state.notice) : ''}
  <div class="card">
    <h2>المحافظ ‹ المحافظ</h2>
    <p class="lead">اكتب <b>الرصيد اللي فيها دلوقتي</b>. ده اللي هتفتح بيه في السيستم الجديد. المحافظ الخمسة الأساسية موجودة في النظام أصلًا، فلو شلت علامة واحدة هتتخفي وتبقى برصيد صفر.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>يتنقل</th><th>الاسم</th><th>الرقم</th><th>نوع الدفع</th><th class="num">الرصيد اللي هتفتح بيه</th><th class="num">حد يومي</th><th></th></tr></thead>
      <tbody>
        ${state.plan.wallets.map((wallet) => `<tr class="${wallet.include ? '' : 'excluded'}">
          ${includeCell('wallets', wallet)}
          <td><input type="text" value="${esc(wallet.name)}" data-act="field" data-coll="wallets" data-id="${esc(wallet.id)}" data-field="name"></td>
          <td><input type="text" value="${esc(wallet.number)}" data-act="field" data-coll="wallets" data-id="${esc(wallet.id)}" data-field="number" style="width:140px"></td>
          <td>${wallet.payMethod ? `<span class="badge">${methods[wallet.payMethod] || wallet.payMethod}</span>` : '<span class="muted small">محفظة عادية</span>'}</td>
          <td class="num"><input type="number" step="0.01" value="${wallet.currentBalance}" data-act="field" data-coll="wallets" data-id="${esc(wallet.id)}" data-field="currentBalance" data-type="float" style="width:120px"></td>
          <td class="num"><input type="number" step="0.01" value="${wallet.dailyLimit}" data-act="field" data-coll="wallets" data-id="${esc(wallet.id)}" data-field="dailyLimit" data-type="float" style="width:110px"></td>
          ${detailsCell('wallets', wallet)}
        </tr>`).join('')}
      </tbody>
    </table></div>
    <div class="note warn" style="margin-top:12px">
      الرصيد اللي جاي من القديم هو <b>رصيد البداية</b> اللي كان مسجّل، مش رصيد النهارده — عدّله على اللي في المحفظة فعلًا قبل البناء.
    </div>
  </div>`;
}

// ── Settings ──────────────────────────────────────────────────────────────
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
  </div>`;
}

// ── Build ─────────────────────────────────────────────────────────────────
function viewBuild() {
  const validation = validatePlan(state.plan);
  const errors = validation.findings.filter((finding) => finding.level === 'error');
  const totals = planTotals(state.plan);
  const built = state.built;
  return `
  ${state.notice ? note(state.notice) : ''}
  <div class="build-grid">
    <div class="card">
      <h2>ابنِ نسخة السيستم الجديد</h2>
      <p class="lead">النسخة دي بتتدخل على البرنامج الجديد من «الإعدادات ‹ النسخة الاحتياطية ‹ استيراد نسخة».</p>

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

      <div class="row" style="margin-top:14px">
        <button class="primary" data-act="build" ${state.building || errors.length ? 'disabled' : ''}>ابنِ النسخة (${money(totals.saleTotal + totals.summaryTotal)} ج مبيعات)</button>
        <button class="ghost" data-act="save-draft">حفظ مسودة</button>
        ${errors.length ? '<span class="muted small">الزرار متقفل لحد ما التنبيهات الحمراء تتصلح.</span>' : ''}
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
          <li>افتح السيستم الجديد ‹ الإعدادات ‹ النسخة الاحتياطية.</li>
          <li>«استيراد نسخة» وحدد الملف اللي حمّلته.</li>
          <li>اكتب كلمة السر اللي كتبتها فوق.</li>
          <li>اقفل البرنامج وافتحه تاني زي ما هيطلب.</li>
          <li>راجع المخزن والمحافظ وأرقام الشهور.</li>
        </ol>
        <div class="note info">
          الفحص الذاتي نجح: الأداة فتحت النسخة اللي كتبتها بكلمة السر وقرأت قاعدة البيانات جواها.
        </div>
      ` : `
        <h2>اللي هيتنقل</h2>
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
        <p class="muted small">البناء بياخد حوالي ٥–١٠ ثواني (تشفير النسخة).</p>
      `}
    </div>
  </div>
  ${findingsCard(validation.findings, { title: 'الفحص — إيه اللي ناقص قبل النسخة، وإزاي تحله' })}`;
}

// ── The row panel: old shape above, new shape below ───────────────────────
/**
 * «أجهزة المستعمل» — the one place a used handset is entered.
 *
 * The old catalogue has a name and a price for a used model and nothing else, so
 * the count has to come from the owner. It is typed as devices — IMEI, condition,
 * cost — because that is what the new system puts on the «مستعمل» shelf; a bare
 * number would land on the «جديد» shelf and mix the two kinds.
 */
function devicesPanel(row) {
  const devices = row.devices ?? [];
  const draft = state.deviceDraft;
  const conditionLabel = { A: 'A — زي الجديد', B: 'B — خدوش خفيفة', C: 'C — عيوب واضحة' };
  return `<section class="panel devices" data-devices="${esc(row.id)}">
    <h4>أجهزة المستعمل (IMEI) — ${num(devices.length)} جهاز</h4>
    <p class="muted small" style="margin:0 0 8px">
      كل جهاز بيتسجل برقمه وحالته وتكلفته، وينزل على رف «مستعمل» في قسم الهواتف. العدد هنا
      مش رقم مكتوب — هو عدد الأجهزة اللي بتضيفها.
    </p>
    ${devices.length
      ? `<div class="table-wrap"><table class="devices-table">
          <thead><tr><th>IMEI</th><th>الحالة</th><th class="num">التكلفة</th><th></th></tr></thead>
          <tbody>
            ${devices.map((device, index) => `<tr>
              <td class="mono" dir="ltr">${esc(device.imei)}</td>
              <td><select data-act="device-field" data-id="${esc(row.id)}" data-index="${index}" data-field="condition">
                ${['A', 'B', 'C'].map((grade) => `<option value="${grade}" ${device.condition === grade ? 'selected' : ''}>${esc(conditionLabel[grade])}</option>`).join('')}
              </select></td>
              <td class="num"><input type="number" step="0.01" value="${device.cost ?? ''}" placeholder="${esc(String(row.buy))}"
                data-act="device-field" data-id="${esc(row.id)}" data-index="${index}" data-field="cost" data-type="float" style="width:100px"></td>
              <td><button class="small danger" data-act="remove-device" data-id="${esc(row.id)}" data-index="${index}" title="امسح الجهاز">×</button></td>
            </tr>`).join('')}
          </tbody>
        </table></div>`
      : '<div class="note warn">مفيش أجهزة. الموديل ده مش هيبان على رف «مستعمل» لحد ما تضيف جهاز برقمه.</div>'}
    <div class="stack" style="gap:8px;margin-top:10px">
      <textarea rows="3" data-act="device-text" placeholder="الصق أرقام IMEI — رقم في كل سطر (أو مفصولين بفاصلة)">${esc(draft.text)}</textarea>
      <div class="row">
        <select data-act="device-condition" style="max-width:200px">
          <option value="">— حالة الأجهزة —</option>
          ${['A', 'B', 'C'].map((grade) => `<option value="${grade}" ${draft.condition === grade ? 'selected' : ''}>${esc(conditionLabel[grade])}</option>`).join('')}
        </select>
        <input type="number" step="0.01" data-act="device-cost" value="${esc(draft.cost)}" placeholder="تكلفة الجهاز (اختياري — الافتراضي سعر الشراء)" style="max-width:280px">
        <button class="primary" data-act="add-devices" data-id="${esc(row.id)}">أضف الأجهزة</button>
      </div>
      <p class="muted small" style="margin:0">
        الرقم لازم يكون ١٥ رقم ورقم التحقق صح — تقدر تلاقيه على علبة الجهاز أو بـ<span class="mono" dir="ltr">*#06#</span>.
      </p>
    </div>
  </section>`;
}

function viewDrawer() {
  if (!state.drawer) return '';
  const { coll, id } = state.drawer;
  const row = recordOf(coll, id);
  if (!row) {
    state.drawer = null;
    return '';
  }
  const described = describeRow(state.plan, coll, row);
  const fields = fieldsOf(state.plan, coll, row);
  const status = stateOf(row);
  const label = row.name || row.label || row.ticketNo || monthLabel(row.month || '') || 'الصف';
  const canOrder = coll === 'categories' || coll === 'brands' || coll === 'summary';
  const field = (entry) => {
    const raw = fieldValue(row, entry.field);
    if (entry.type === 'select') {
      return `<label class="field ${entry.wide ? 'wide' : ''}"><span>${esc(entry.label)}</span>
        <select data-act="drawer-field" data-coll="${coll}" data-id="${esc(row.id)}" data-field="${entry.field}" data-type="select">
          ${entry.options.map(([value, text]) => `<option value="${esc(value)}" ${raw === String(value) ? 'selected' : ''}>${esc(text)}</option>`).join('')}
        </select></label>`;
    }
    if (entry.type === 'bool') {
      return `<label class="field check"><span>${esc(entry.label)}</span>
        <input type="checkbox" ${row[entry.field] ? 'checked' : ''} data-act="drawer-field" data-coll="${coll}" data-id="${esc(row.id)}" data-field="${entry.field}" data-type="bool"></label>`;
    }
    return `<label class="field ${entry.wide ? 'wide' : ''}"><span>${esc(entry.label)}</span>
      <input type="${entry.type === 'text' ? 'text' : 'number'}" ${entry.step ? `step="${entry.step}"` : ''} ${entry.min ? `min="${entry.min}"` : ''}
        value="${esc(raw)}" data-act="drawer-field" data-coll="${coll}" data-id="${esc(row.id)}"
        data-field="${entry.field}" data-type="${entry.type}"></label>`;
  };
  return `<div class="drawer-backdrop" data-act="close-drawer"></div>
  <aside class="drawer" role="dialog" aria-label="تفاصيل الصف">
    <header class="drawer-head">
      <div>
        <div class="muted small">${esc(DESTINATION_TEXT[coll] || '')}</div>
        <h3>${esc(String(label))}</h3>
      </div>
      <div class="row">
        <span class="badge ${status.tone === 'on' ? '' : 'plain'}">${status.label}</span>
        <button class="small ghost" data-act="close-drawer">إغلاق ×</button>
      </div>
    </header>
    <div class="drawer-body">
      <section class="panel old">
        <h4>${esc(described.old.title)}</h4>
        <dl class="kv">
          ${described.old.fields.length
            ? described.old.fields.map((entry) => `<div><dt>${esc(entry.label)}</dt><dd>${esc(String(entry.value))}</dd></div>`).join('')
            : '<div class="muted small">مفيش صف خام من القديم — الصف ده اتضاف من الأداة.</div>'}
        </dl>
      </section>

      <div class="arrow-down">هيبقى في الجديد</div>

      <section class="panel new">
        <h4>${esc(described.next.title)}</h4>
        <div class="where">${esc(described.next.where)}</div>
        <div class="mono tiny muted">${esc(described.next.table)}</div>
        <dl class="kv">
          ${described.next.fields.map((entry) => `<div><dt>${esc(entry.label)}</dt><dd>${esc(String(entry.value))}</dd></div>`).join('')}
        </dl>
        ${described.note ? `<div class="note info small">${esc(described.note)}</div>` : ''}
      </section>

      <section class="panel">
        <h4>تعديل البيانات</h4>
        <div class="fields">${fields.map(field).join('') || '<p class="muted small">الصف ده مفيش له حقول قابلة للتعديل.</p>'}</div>
      </section>

      ${coll === 'items' && row.kind === 'used' ? devicesPanel(row) : ''}

      <section class="panel">
        <h4>تحكم كامل</h4>
        <div class="row">
          <button class="small" data-act="include" data-coll="${coll}" data-id="${esc(row.id)}" data-toggle="1">
            ${row.include ? 'شيله من النقل' : 'اشمله في النقل'}
          </button>
          ${canOrder ? `<button class="small ghost" data-act="up" data-coll="${coll}" data-id="${esc(row.id)}"><span class="tri up"></span> فوق</button>
          <button class="small ghost" data-act="down" data-coll="${coll}" data-id="${esc(row.id)}"><span class="tri down"></span> تحت</button>` : ''}
          <button class="small danger" data-act="del" data-coll="${coll}" data-id="${esc(row.id)}">امسح الصف</button>
        </div>
        <p class="muted small" style="margin-top:10px">أي تعديل هنا بيدخل في «رجوع» — تقدر ترجّعه بـCtrl+Z.</p>
      </section>
    </div>
  </aside>`;
}

function emptyRow(columns, text) {
  return `<tr><td colspan="${columns}" class="muted" style="text-align:center;padding:26px">${esc(text)}</td></tr>`;
}

// ── Shell ─────────────────────────────────────────────────────────────────
// The tool is organised by **department**, not by table.
//
// The owner asked for this in as many words (2026-10-23): «افصل بين الأقسام —
// الإكسسوارات ألاقي كل حاجة خاصة بيه، وكذلك الهواتف، وأقدر أضيف أو أعدّل أي حاجة
// في نفس المكان، من غير قايمة جانبية». So there is no side rail any more: a
// strip of departments across the top, and each department is one page where its
// categories, its items, its numbers and its money all live together.
const TABS = [
  ['overview', 'النظرة العامة'],
  ['accessories', 'الإكسسوارات'],
  ['phones', 'الهواتف'],
  ['months', 'الشهور'],
  ['sales', 'المبيعات التفصيلية'],
  ['repairs', 'الصيانة'],
  ['expenses', 'المصاريف'],
  ['wallets', 'المحافظ'],
  ['map', 'الخريطة'],
  ['settings', 'الإعدادات'],
  ['build', 'بناء النسخة'],
];

const TAB_LABEL = Object.fromEntries(TABS);
const NEXT_TAB = {};
const PREV_TAB = {};
TABS.forEach(([key], index) => {
  NEXT_TAB[key] = TABS[index + 1]?.[0];
  PREV_TAB[key] = TABS[index - 1]?.[0];
});

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
    map: viewMap,
    accessories: viewAccessories,
    phones: viewPhones,
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
        <button class="small" data-act="tab" data-tab="build" title="التنبيهات قبل البناء">
          <span>الفحص</span>
          <b style="color:${errors ? 'var(--danger)' : 'var(--ok)'}">${errors ? `${num(errors)} مانع` : 'سليم'}</b>
        </button>
      </div>
      <button class="small" data-act="undo" ${state.history.length ? '' : 'disabled'} title="تراجع">تراجع</button>
      <button class="small" data-act="redo" ${state.future.length ? '' : 'disabled'} title="إعادة">إعادة</button>
    </div>
    <div class="legend">
      <span><i class="dot on"></i> علامة «يتنقل» = الصف ده هيدخل السيستم الجديد</span>
      <span><i class="dot off"></i> من غير علامة = هيفضل في القديم بس</span>
      <span><i class="dot pick"></i> «تحديد» = تختار صفوف للدمج / النقل / المسح</span>
      <span class="muted">كل صف فيه «تفاصيل» بيوريك شكله في القديم والجديد.</span>
    </div>
    <nav class="tabs" aria-label="أقسام الأداة">
      ${TABS.map(([key, label]) => `<button data-act="tab" data-tab="${key}" class="${state.tab === key ? 'active' : ''}">
        <span>${label}</span><span class="count">${key === 'overview' || key === 'settings' || key === 'build' ? '' : num(counts[key] ?? '')}</span>
      </button>`).join('')}
      <span class="tabs-files">
        <button data-act="pick-legacy" class="small ghost">باكب تاني</button>
        <button data-act="pick-draft" class="small ghost">مسودة</button>
      </span>
    </nav>
    <div class="layout">
      <main>${views[state.tab] ? views[state.tab]() : viewOverview()}
        <div class="row" style="margin:18px 0 4px">
          <button class="ghost small" data-act="tab" data-tab="${PREV_TAB[state.tab] || 'overview'}">› اللي قبله</button>
          <span class="muted small">${esc(TAB_LABEL[state.tab] || '')}</span>
          <button class="ghost small" data-act="tab" data-tab="${NEXT_TAB[state.tab] || 'build'}">اللي بعده ‹</button>
        </div>
      </main>
    </div>
    ${viewDrawer()}
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
    // Bulk actions work on what the owner can see: the department page he is
    // standing on, with its search and its «من غير عدد» switch.
    const kind = state.tab === 'accessories' ? 'accessory' : state.tab === 'phones' ? 'all' : state.filters.kind;
    let rows = state.plan.items;
    if (state.tab === 'accessories') rows = rows.filter((item) => item.kind === 'accessory');
    else if (state.tab === 'phones') {
      rows = rows.filter((item) => item.kind === 'phone' || item.kind === 'used');
      const shelf = state.filters.shelf ?? 'all';
      if (shelf !== 'all') rows = rows.filter((item) => item.kind === shelf);
    } else if (kind !== 'all') rows = rows.filter((item) => item.kind === kind);
    if (state.filters.category !== 'all') rows = rows.filter((item) => (item.categoryId || '') === state.filters.category);
    if (state.filters.missing === '1') {
      rows = rows.filter((item) => (item.kind === 'used' ? (item.devices ?? []).length === 0 : !(item.qty > 0)));
    }
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
      // A department's own switches (which shelf, «من غير عدد») belong to the
      // department you left; carrying them into the next one hides rows for a
      // reason nobody can see.
      state.filters.shelf = 'all';
      state.filters.missing = 'all';
      state.filters.kind = 'all';
      state.page = {};
      state.selected = {};
      state.drawer = null;
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
      const row = recordOf(coll, id);
      if (!row) return;
      // The table uses a checkbox (its state is final on `change`); the details
      // panel uses a button, which has no `checked` at all.
      const next = target.dataset.toggle ? !row.include : target.checked;
      editRecord(coll, id, { include: next });
      render();
      return;
    }
    case 'select': {
      toggleSelection(target.dataset.coll, target.dataset.id, target.checked);
      render();
      return;
    }
    case 'select-visible':
      selectAllVisible(target.dataset.coll, target.dataset.on === '1');
      render();
      return;
    case 'clear-selection':
      setSelection(target.dataset.coll, []);
      render();
      return;
    case 'bulk-selected': {
      const coll = target.dataset.coll;
      const ids = selectedIds(coll);
      const op = target.dataset.op;
      if (!ids.length) return;
      if (op === 'include') bulkInclude(coll, ids, true);
      else if (op === 'exclude') bulkInclude(coll, ids, false);
      else if (op === 'delete' && confirm(`هتحذف ${ids.length} صف من الأداة (مش من الباكب). متأكد؟`)) bulkDelete(coll, ids);
      setSelection(coll, []);
      render();
      return;
    }
    case 'bulk-move': {
      const coll = target.dataset.coll;
      const ids = selectedIds(coll);
      const select = document.getElementById('bulk-category');
      const categoryId = select?.value || '';
      if (!ids.length) return;
      bulkPatch(coll, ids, { categoryId: categoryId || null });
      setSelection(coll, []);
      state.notice = { level: 'info', text: categoryId ? 'الأصناف اتنقلت للقسم المختار.' : 'الأصناف بقت من غير قسم.' };
      render();
      return;
    }
    case 'merge':
      mergeSelected(target.dataset.coll);
      return;
    case 'details':
      openDrawer(target.dataset.coll, target.dataset.id);
      return;
    case 'close-drawer':
      closeDrawer();
      return;
    case 'drawer-field': {
      const coll = target.dataset.coll;
      const field = target.dataset.field;
      const type = target.dataset.type;
      let next = target.type === 'checkbox' ? target.checked : target.value;
      if (type === 'int') next = Math.max(0, Math.trunc(Number(next) || 0));
      if (type === 'float') next = next === '' ? null : Number(next);
      if (type === 'bool') next = target.checked;
      if (type === 'select' && (field === 'categoryId' || field === 'brandId' || field === 'parentId' || field === 'itemId')) {
        next = next === '' ? null : next;
      }
      if (coll === 'months' && field === 'mode') {
        setMonthMode(target.dataset.id, next);
        return;
      }
      if (field === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(next))) {
        state.notice = { level: 'warn', text: 'التاريخ لازم يكون بالشكل 2026-10-21.' };
        render();
        return;
      }
      editRecord(coll, target.dataset.id, { [field]: next });
      render();
      return;
    }
    case 'up':
      moveRow(target.dataset.coll, target.dataset.id, -1);
      return;
    case 'down':
      moveRow(target.dataset.coll, target.dataset.id, 1);
      return;
    case 'goto': {
      const finding = state.findings?.[Number(target.dataset.i)];
      if (finding) gotoFinding(finding);
      return;
    }
    case 'auto-fix': {
      const finding = state.findings?.[Number(target.dataset.i)];
      if (finding) runAutoFix(finding);
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
        setMonthMode(target.dataset.id, value);
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
        kind: ['item', 'phone', 'used'].includes(target.dataset.kind) ? target.dataset.kind : 'item',
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
    case 'filter-toggle': {
      const key = target.dataset.filter;
      state.filters[key] = target.dataset.on === '1' ? '1' : 'all';
      state.page = {};
      render();
      return;
    }
    case 'bulk-count': {
      const ids = new Set(selectedIds('items'));
      const box = document.getElementById('bulk-count');
      const value = Math.max(0, Math.trunc(Number(box?.value) || 0));
      if (ids.size === 0) {
        state.notice = { level: 'warn', text: 'حدد الصفوف الأولى من عمود «تحديد».' };
        render();
        return;
      }
      planEdit((plan) => {
        for (const item of plan.items) {
          if (!ids.has(item.id) || item.kind === 'used') continue;
          item.qty = value;
        }
      });
      setSelection('items', []);
      state.notice = { level: 'info', text: `العدد ${num(value)} اتحط على ${num(ids.size)} صنف.` };
      render();
      return;
    }
    case 'bump': {
      // One tap per piece. Typing 250 counts one by one is the reason the counts
      // never got filled in the first place, so the common case is a button.
      const row = recordOf('items', target.dataset.id);
      if (!row) return;
      const next = Math.max(0, Math.trunc(Number(row.qty) || 0) + Number(target.dataset.delta || 0));
      editRecord('items', row.id, { qty: next });
      render();
      return;
    }
    case 'add-item': {
      addRecord('items', {
        id: newId('item'),
        kind: target.dataset.kind === 'phone' || target.dataset.kind === 'used' ? target.dataset.kind : 'accessory',
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
        devices: [],
      });
      state.notice = { level: 'info', text: 'اتضاف صف جديد — عدّل الاسم والسعر والعدد في مكانه، وبعدين املأ الأجهزة لو مستعمل.' };
      render();
      return;
    }
    case 'add-devices': {
      const row = recordOf('items', target.dataset.id);
      if (!row) return;
      const raw = state.deviceDraft.text
        .split(/[\n,;]+/)
        .map((line) => normalizeImei(line))
        .filter((line) => line !== '');
      if (raw.length === 0) {
        state.notice = { level: 'warn', text: 'الصق أرقام IMEI الأول — رقم في كل سطر.' };
        render();
        return;
      }
      if (!['A', 'B', 'C'].includes(state.deviceDraft.condition)) {
        state.notice = { level: 'warn', text: 'اختار حالة الأجهزة (A / B / C) — الحالة هي اللي بتخليها «مستعمل» في الهواتف.' };
        render();
        return;
      }
      const cost = state.deviceDraft.cost === '' ? null : Number(state.deviceDraft.cost);
      const existing = new Set((row.devices ?? []).map((device) => normalizeImei(device.imei)));
      const added = [];
      const rejected = [];
      for (const imei of raw) {
        if (!isValidImei(imei)) {
          rejected.push(imei);
          continue;
        }
        if (existing.has(imei)) continue;
        existing.add(imei);
        added.push({ imei, condition: state.deviceDraft.condition, cost, note: '' });
      }
      if (added.length === 0) {
        state.notice = {
          level: 'warn',
          text: rejected.length
            ? `مفيش رقم اتقبل — ${num(rejected.length)} رقم مش IMEI صحيح (١٥ رقم + رقم تحقق). اتأكد منهم وجرّب تاني.`
            : 'الأرقام دي متسجلة عند الصنف ده بالفعل.',
        };
        render();
        return;
      }
      editRecord('items', row.id, {
        devices: [...(row.devices ?? []), ...added],
        qty: (row.devices ?? []).length + added.length,
      });
      state.deviceDraft = { text: rejected.join('\n'), condition: '', cost: '' };
      state.notice = {
        level: rejected.length ? 'warn' : 'info',
        text: `اتضاف ${num(added.length)} جهاز على «${row.name}»، و${rejected.length ? `${num(rejected.length)} رقم اترفض — سايبه في الصندوق عشان تصحّحه.` : 'كلهم بأرقام صحيحة.'}`,
      };
      render();
      return;
    }
    case 'remove-device': {
      const row = recordOf('items', target.dataset.id);
      if (!row) return;
      const index = Number(target.dataset.index);
      const devices = (row.devices ?? []).filter((_, at) => at !== index);
      editRecord('items', row.id, { devices, qty: devices.length });
      render();
      return;
    }
    case 'device-field': {
      const row = recordOf('items', target.dataset.id);
      if (!row) return;
      const index = Number(target.dataset.index);
      const field = target.dataset.field;
      const devices = (row.devices ?? []).map((device, at) => (at === index
        ? { ...device, [field]: field === 'cost' ? (target.value === '' ? null : Number(target.value)) : target.value }
        : device));
      editRecord('items', row.id, { devices });
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
      const coll = target.dataset.coll;
      const id = target.dataset.id;
      const row = recordOf(coll, id);
      const name = row?.name || row?.label || 'الصف';
      if (!confirm(`هتحذف «${name}» من الخطة (الباكب الأصلي مش بيتغير). كمّل؟`)) return;
      deleteRecord(coll, id);
      if (state.drawer?.coll === coll && state.drawer?.id === id) state.drawer = null;
      state.notice = { level: 'info', text: `«${name}» اتشال من الترحيل — تقدر ترجّعه بـCtrl+Z.` };
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
  // Anything the owner types into or picks from is committed on `change`, when
  // the value is final. Handling it on `click` too would re-render mid-typing and
  // drop the caret out of the field.
  if (['INPUT', 'SELECT', 'TEXTAREA', 'OPTION'].includes(target.tagName)) return;
  handleAction(target);
});

document.addEventListener('change', (event) => {
  const target = event.target.closest('[data-act]');
  if (!target) return;
  const act = target.dataset.act;
  if (target.tagName === 'INPUT' && target.type === 'checkbox') handleAction(target);
  else if (['field', 'drawer-field', 'setting', 'filter', 'password', 'device-field', 'device-condition'].includes(act)) {
    if (act === 'device-condition') state.deviceDraft.condition = target.value;
    else handleAction(target);
  }
});

document.addEventListener('input', (event) => {
  const target = event.target;
  if (target.dataset.act === 'search') {
    state.filters.search = target.value;
  }
  // The IMEI box edits the draft only. Re-rendering on every keystroke would
  // throw the caret out of a field someone is pasting fifteen digits into.
  if (target.dataset.act === 'device-text') state.deviceDraft.text = target.value;
  if (target.dataset.act === 'device-cost') state.deviceDraft.cost = target.value;
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

/**
 * 192×192 JPEG, the size the app insists on for the shop logo.
 *
 * Every way this can fail returns `null` instead of hanging: a logo is a nice
 * extra, and a build that never finishes because a picture would not decode is a
 * build the owner cannot use. The image decode and the canvas encode each get a
 * deadline for the same reason.
 */
async function shrinkLogo(dataUrl) {
  const withDeadline = (promise, ms) => Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
  try {
    const image = await withDeadline(new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('الصورة مش مقروءة'));
      element.src = dataUrl;
    }), 5000);
    if (!image) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    canvas.height = 192;
    const context = canvas.getContext('2d');
    // A browser with canvas turned off (privacy settings, old GPU driver) gives
    // `null` here. That is a reason to skip the logo, not to stop the backup.
    if (!context) return null;
    const scale = Math.max(192 / image.width, 192 / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 192, 192);
    context.drawImage(image, (192 - width) / 2, (192 - height) / 2, width, height);
    const blob = await withDeadline(new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9)), 5000);
    if (!blob) return null;
    const buffer = new Uint8Array(await blob.arrayBuffer());
    return buffer.length <= 64 * 1024 ? buffer : null;
  } catch {
    return null;
  }
}

/**
 * Build the backup, reporting every way it can stop.
 *
 * The rule here: no step may hang and no failure may be silent. A picture that
 * will not decode, a canvas the browser refuses to give, or an encryption cost
 * the machine cannot afford each end in a sentence the owner can act on — never
 * in a spinner that never closes.
 */
async function runBuild() {
  if (state.building) return;
  const validation = validatePlan(state.plan);
  const errors = validation.findings.filter((finding) => finding.level === 'error');
  if (errors.length) {
    state.notice = { level: 'danger', text: 'فيه أخطاء لازم تتصلح الأول — شوف كارت «الفحص» تحت.' };
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
  const startedAt = Date.now();
  const progress = overlay('بنجهّز النسخة…', 'بنجهّز قاعدة البيانات على مخطط السيستم الجديد.');
  // A build that stops halfway must give the screen back. This watchdog is the
  // last resort for a browser that never resolves a promise we are waiting on.
  let finished = false;
  const watchdog = setTimeout(() => {
    if (finished) return;
    finished = true;
    state.building = false;
    progress.close();
    state.notice = {
      level: 'danger',
      text: 'البناء خد وقت أطول من المعتاد ووقف. جرّب تشغيل «تشفير أسرع» من الإعدادات تحت، ولو حصل تاني ابعتلي الرسالة دي.',
    };
    render();
  }, 180000);
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
    let result;
    let kdfNote = '';
    try {
      result = buildFromPlan({
        SQL,
        plan: state.plan,
        password: state.password,
        logoJpeg: logo,
        now: Date.now(),
        kdf: state.fastKdf ? { memoryKib: 8 * 1024, iterations: 1, parallelism: 1 } : undefined,
      });
    } catch (error) {
      // The heavy Argon2id setting can run out of memory on a small machine. The
      // lighter cost is still inside what the app accepts, and the parameters are
      // recorded inside the file, so the restore opens it either way.
      const message = String(error?.message || error);
      if (state.fastKdf || !/memory|allocat|out of|RangeError/i.test(message)) throw error;
      progress.step('بنشفّر بتشفير أخف…', 'الجهاز مش قادر على التشفير القوي — بنستخدم إعداد أخف بيقبله التطبيق.', 70);
      await tick();
      result = buildFromPlan({
        SQL,
        plan: state.plan,
        password: state.password,
        logoJpeg: logo,
        now: Date.now(),
        kdf: { memoryKib: 32 * 1024, iterations: 2, parallelism: 1 },
      });
      kdfNote = 'التشفير اتعمل بإعداد أخف (32 ميجا/مرتين) لأن الجهاز مش قادر على الإعداد الافتراضي. النسخة سليمة ويقبلها التطبيق.';
    }
    if (!result.ok) {
      finished = true;
      clearTimeout(watchdog);
      progress.close();
      state.building = false;
      state.notice = { level: 'danger', text: 'فيه أخطاء في الخطة منعت البناء — شوف كارت «الفحص» تحت.' };
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
      seconds: Math.round((Date.now() - startedAt) / 1000),
      logoIncluded: Boolean(logo),
      wantedLogo: Boolean(state.includeLogo && state.plan.settings.logoDataUrl),
    };
    state.building = false;
    finished = true;
    clearTimeout(watchdog);
    progress.close();
    state.notice = kdfNote
      ? { level: 'warn', text: kdfNote }
      : (!state.built.logoIncluded && state.built.wantedLogo
        ? { level: 'warn', text: 'النسخة اتبنت، بس الشعار ماتصغّرش في المتصفح ده فاتنقل من غير شعار. تقدر تحطه من «الإعدادات ‹ الشعار» بعد الاستيراد.' }
        : null);
    // No programmatic scrolling: the build tab re-renders with the result at the
    // top, and some embedded browsers refuse `scrollTo` outright.
    render();
  } catch (error) {
    finished = true;
    clearTimeout(watchdog);
    state.building = false;
    progress.close();
    state.notice = { level: 'danger', text: `البناء وقف: ${error?.message || error}. جرّب تشغيل «تشفير أسرع» ولو حصل تاني ابعتلي الرسالة دي.` };
    render();
  }
}

// Start.
render();
