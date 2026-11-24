// Adding the days that happened *after* the draft was made.
//
// The owner works on a draft for days. The shop keeps selling. When he exports a
// fresh backup from the old program, the draft is behind by however many days
// passed — and he asked for exactly one thing (2026-11-02): «عاوز أضيفهم على
// المسودة بدون تغيير شيء في المسودة غير إضافة المبيعات وتظبيط الأعداد».
//
// So this module does one job and refuses the rest: it takes the **new days
// only**, maps their rows onto the items the draft already has, appends the
// sales, and lowers each item's count by what sold — because the count the owner
// typed means «اللي عندي دلوقتي» on the day he typed it. Nothing already in the
// draft is renamed, merged, re-categorised, re-priced or re-ticked.
//
// The plan it returns is a new object; the caller decides whether to keep it, and
// the screen always shows the diff (which days, how much money, which counts
// move) before anything is written.

import { buildDefaultPlan } from './plan.mjs';
import { nameKey, monthOf, monthLabel } from './util.mjs';

const KIND_OF_SALE = { acc: 'accessory', used: 'used', phones: 'phone' };
const money0 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * The days in this backup that the draft does not have *whole*.
 *
 * Comparing dates alone is not enough: the draft was exported in the middle of a
 * day (2026-10-29, 13:00), so that day is in the draft and still short of its
 * afternoon. Rows carry the old program's own ids, so the test is per row — a day
 * is «new» when any of its rows is missing. Everything else is a day the draft
 * already has and is left alone.
 */
export function newDaysOf(plan, legacy) {
  const knownSales = new Set((plan?.sales ?? []).map((sale) => sale.sourceId ?? sale.id.replace(/^sale-/, '')));
  const knownRepairs = new Set((plan?.repairs ?? []).map((row) => row.sourceId ?? row.id.replace(/^repair-/, '')));
  const knownExpenses = new Set((plan?.expenses ?? []).map((row) => row.sourceId ?? row.id.replace(/^expense-/, '')));
  const knownCash = new Set((plan?.cashOps ?? []).map((row) => row.sourceId ?? row.id.replace(/^cash-/, '')));

  // A month the draft keeps as one «مجمّع» line has no sale rows at all, so the
  // row test cannot be used on it: the month is already accounted for. Only a
  // date that is genuinely past the draft's last day still belongs in it.
  const monthMode = new Map((plan?.months ?? []).map((month) => [month.month, month.include === false ? 'skip' : month.mode]));
  const lastDay = plan?.source?.lastDay ?? '';

  return legacy.days
    .filter((day) => {
      const mode = monthMode.get(monthOf(day.day));
      if (mode === 'summary') return day.day > lastDay;
      if (mode === 'skip') return false;
      const sections = day.sections;
      const salePending = [...sections.acc, ...sections.used, ...sections.phones]
        .some((row) => !row.rolled && !knownSales.has(row.id));
      const repairPending = [...sections.repairs, ...sections.sw]
        .some((row) => !row.rolled && !knownRepairs.has(row.id));
      const expensePending = sections.exp.some((row) => !knownExpenses.has(row.id));
      const cashPending = sections.cash.some((row) => !knownCash.has(row.id));
      return salePending || repairPending || expensePending || cashPending;
    });
}

function dayTotals(day, knownDates = new Set()) {
  const sectionTotal = (rows, field) => rows.reduce((sum, row) => sum + (Number(row[field]) || 0) * (Number(row.qty) || 1), 0);
  const sales = [...day.sections.acc, ...day.sections.used, ...day.sections.phones].filter((row) => !row.rolled);
  return {
    day: day.day,
    // A day the draft already has, but not all of: the backup was taken in the
    // middle of it, so its afternoon is missing. Said plainly, because «٣ أيام»
    // when one of them is a top-up reads like the tool lost a day.
    topUp: knownDates.has(day.day),
    sales: sales.length,
    total: money0(sectionTotal(sales, 'sell')),
    cost: money0(sectionTotal(sales, 'buy')),
    repairs: day.sections.repairs.filter((row) => !row.rolled).length + day.sections.sw.filter((row) => !row.rolled).length,
    expenses: money0(day.sections.exp.reduce((sum, row) => sum + (Number(row.amount) || 0), 0)),
    cash: day.sections.cash.length,
  };
}

/**
 * Everything the merge would do, without doing it.
 *
 * `plan` is the draft; `legacy` is the freshly-read old backup. The returned
 * object is what the screen prints: which days are new, what they bring, and —
 * the part the owner must see — which item counts go down and by how much.
 */
export function describeNewDays(plan, legacy) {
  const days = newDaysOf(plan, legacy);
  const knownDates = new Set([
    ...plan.sales.map((sale) => sale.date),
    ...(plan.repairs ?? []).map((row) => row.date),
    ...(plan.expenses ?? []).map((row) => row.date),
  ]);
  const out = {
    days: days.map((day) => dayTotals(day, knownDates)),
    topUpDays: days.filter((day) => knownDates.has(day.day)).length,
    sales: 0,
    saleTotal: 0,
    repairs: 0,
    expenses: 0,
    cash: 0,
    counts: [],
    newItems: [],
    newDayCount: days.filter((day) => !knownDates.has(day.day)).length,
    firstDay: days[0]?.day ?? null,
    lastDay: days[days.length - 1]?.day ?? null,
    warnings: [],
  };
  if (!days.length) return out;

  const lastDay = days[days.length - 1].day;
  const lastMonth = monthOf(lastDay);
  // The full plan is the reference mapping: it already knows how a legacy row
  // becomes a sale, a repair or an expense. Only the rows of the new days are
  // taken from it, so the rest of the draft is never rebuilt.
  const full = buildDefaultPlan(legacy, { currentMonth: lastMonth, pastMode: 'summary' });
  const knownSales = new Set(plan.sales.map((sale) => sale.id));
  const freshSales = full.sales.filter((sale) => !knownSales.has(sale.id));

  const items = plan.items;
  const byRef = new Map();
  const byName = new Map();
  for (const item of items) {
    if (item.sourceRef) byRef.set(`${item.kind}:${item.sourceRef}`, item);
    const key = `${item.kind}:${nameKey(item.name)}`;
    if (!byName.has(key)) byName.set(key, item);
  }
  const kindById = new Map(full.items.map((item) => [item.id, item.kind]));
  const fullById = new Map(full.items.map((item) => [item.id, item]));

  const soldByItem = new Map();
  const itemsToCreate = new Map();
  const seenSaleIds = new Set(plan.sales.map((sale) => sale.id));

  for (const sale of freshSales) {
    if (seenSaleIds.has(sale.id)) continue;
    const kind = kindById.get(sale.itemId) ?? (sale.section === 'phones' ? 'phone' : 'accessory');
    const source = fullById.get(sale.itemId);
    const target = (source?.sourceRef && byRef.get(`${kind}:${source.sourceRef}`))
      || byName.get(`${kind}:${nameKey(sale.name)}`)
      || null;
    if (target) {
      soldByItem.set(target.id, (soldByItem.get(target.id) ?? 0) + (Number(sale.qty) || 1));
    } else {
      // A handset or accessory the draft has never seen. It is created with the
      // numbers from the sale itself and a count of zero: everything of it sold,
      // nothing of it is on the shelf.
      const key = `${kind}:${nameKey(sale.name)}`;
      if (!itemsToCreate.has(key)) {
        itemsToCreate.set(key, { source, sale, kind, qty: 0 });
      }
      const created = itemsToCreate.get(key);
      created.qty += Number(sale.qty) || 1;
    }
    out.sales += 1;
    out.saleTotal = money0(out.saleTotal + (Number(sale.sell) || 0) * (Number(sale.qty) || 1));
  }

  const knownRepairs = new Set(plan.repairs.map((row) => row.id));
  const knownExpenses = new Set(plan.expenses.map((row) => row.id));
  const knownCash = new Set(plan.cashOps.map((row) => row.id));
  const freshRepairs = full.repairs.filter((row) => !knownRepairs.has(row.id));
  const freshExpenses = full.expenses.filter((row) => !knownExpenses.has(row.id));
  const freshCash = full.cashOps.filter((row) => !knownCash.has(row.id));
  out.repairs = freshRepairs.length;
  out.expenses = money0(freshExpenses.reduce((sum, row) => sum + (Number(row.amount) || 0), 0));
  out.cash = freshCash.length;

  for (const [itemId, sold] of soldByItem) {
    const item = items.find((row) => row.id === itemId);
    if (!item) continue;
    const before = Number(item.qty) || 0;
    const after = Math.max(0, before - sold);
    out.counts.push({ id: item.id, kind: item.kind, name: item.name, sold, before, after, clamped: after === 0 && sold > before });
    if (after === 0 && sold > before) {
      out.warnings.push(`«${item.name}» اتباع منه ${sold} والعدد اللي في المسودة ${before} — العدد هينزل صفر، راجع الجرد.`);
    }
  }
  out.counts.sort((a, b) => b.sold - a.sold || a.name.localeCompare(b.name));

  out.newItems = [...itemsToCreate.values()].map((entry) => ({
    kind: entry.kind,
    name: entry.sale.name,
    buy: entry.source?.buy ?? entry.sale.buy,
    sell: entry.source?.sell ?? entry.sale.sell,
    sold: entry.qty,
  }));

  return out;
}

/**
 * The draft with the new days added — and nothing else touched.
 *
 * Every collection already in the plan is copied as-is; only `sales`, `repairs`,
 * `expenses`, `cashOps`, the counts they sold, and the source's date range change.
 */
export function applyNewDays(plan, legacy) {
  const described = describeNewDays(plan, legacy);
  if (!described.days.length) return { plan, report: described, changed: false };

  const next = JSON.parse(JSON.stringify(plan));
  const lastDay = plan.source?.lastDay ?? '';
  const lastMonth = monthOf(described.lastDay);
  const full = buildDefaultPlan(legacy, { currentMonth: lastMonth, pastMode: 'summary' });

  const kindById = new Map(full.items.map((item) => [item.id, item.kind]));
  const fullById = new Map(full.items.map((item) => [item.id, item]));
  const byRef = new Map();
  const byName = new Map();
  for (const item of next.items) {
    if (item.sourceRef) byRef.set(`${item.kind}:${item.sourceRef}`, item);
    const key = `${item.kind}:${nameKey(item.name)}`;
    if (!byName.has(key)) byName.set(key, item);
  }

  const createdByKey = new Map();
  const seenSaleIds = new Set(next.sales.map((sale) => sale.id));
  const salesToAdd = [];

  for (const sale of full.sales) {
    if (seenSaleIds.has(sale.id)) continue;
    const kind = kindById.get(sale.itemId) ?? (sale.section === 'phones' ? 'phone' : 'accessory');
    const source = fullById.get(sale.itemId);
    let target = (source?.sourceRef && byRef.get(`${kind}:${source.sourceRef}`))
      || byName.get(`${kind}:${nameKey(sale.name)}`)
      || null;

    if (!target) {
      const key = `${kind}:${nameKey(sale.name)}`;
      target = createdByKey.get(key);
      if (!target) {
        // Created from the sale's own numbers: the shop sold it, so it existed.
        // `include` is true and the count is zero, so the month's money is kept
        // without putting a made-up shelf on the new system.
        target = {
          ...(source ?? {}),
          id: `item-new-${kind}-${nameKey(sale.name).slice(0, 24)}-${next.items.length}`,
          kind,
          name: sale.name,
          qty: 0,
          include: true,
          archived: false,
          devices: [],
          sourceRef: source?.sourceRef ?? '',
        };
        createdByKey.set(key, target);
        next.items.push(target);
        byName.set(key, target);
      }
    }

    salesToAdd.push({ ...sale, itemId: target.id, name: target.name, include: true });
    // The count means «اللي عندي دلوقتي» — so what sold after that day comes off.
    target.qty = Math.max(0, (Number(target.qty) || 0) - (Number(sale.qty) || 1));
  }

  next.sales.push(...salesToAdd);

  // A month the draft has in «مجمّع» mode must not suddenly get detailed rows:
  // the whole month is one line there. Same grouping the months screen uses.
  const summaryMonths = new Set((next.months ?? []).filter((month) => month.include && month.mode === 'summary').map((month) => month.month));
  const detailMonths = new Set((next.months ?? []).filter((month) => month.include && month.mode === 'detail').map((month) => month.month));
  const kept = [];
  for (const sale of salesToAdd) {
    const month = monthOf(sale.date);
    if (summaryMonths.has(month)) {
      foldIntoSummary(next, sale);
      continue;
    }
    if (!detailMonths.has(month)) {
      // A month the draft has never seen: it arrives exactly as the old file has
      // it, detailed, so its money is visible row by row.
      next.months.push({
        id: month,
        month,
        label: monthLabel(month),
        mode: 'detail',
        include: true,
        totals: { sales: 0, cost: 0, profit: 0 },
      });
      detailMonths.add(month);
    }
    kept.push(sale);
  }
  const keptIds = new Set(kept.map((sale) => sale.id));
  const originalIds = new Set(plan.sales.map((sale) => sale.id));
  next.sales = next.sales.filter((sale) => originalIds.has(sale.id) || keptIds.has(sale.id));

  const repairIds = new Set(next.repairs.map((row) => row.id));
  const expenseIds = new Set(next.expenses.map((row) => row.id));
  const cashIds = new Set(next.cashOps.map((row) => row.id));
  const repairs = full.repairs.filter((row) => !repairIds.has(row.id));
  const expenses = full.expenses.filter((row) => !expenseIds.has(row.id));
  const cashOps = full.cashOps.filter((row) => !cashIds.has(row.id));
  next.repairs.push(...repairs);
  next.expenses.push(...expenses);
  next.cashOps.push(...cashOps);

  const pendingDays = newDaysOf(plan, legacy);
  const knownDates = new Set(plan.sales.map((sale) => sale.date));
  for (const row of plan.repairs ?? []) knownDates.add(row.date);
  for (const row of plan.expenses ?? []) knownDates.add(row.date);
  const brandNewDays = pendingDays.filter((day) => !knownDates.has(day.day)).length;
  const newRecords = pendingDays.reduce(
    (total, day) => total + Object.values(day.sections).reduce((inner, rows) => inner + rows.length, 0),
    0,
  );
  // The newest date the file itself carries, and the newest date the draft ends
  // up holding — whichever is later. Never a date derived from a row count.
  const dates = [legacy.stats.lastDay, plan.source?.lastDay, ...[...knownDates]]
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')))
    .sort();
  next.source = {
    ...next.source,
    lastDay: dates[dates.length - 1],
    firstDay: next.source?.firstDay ?? legacy.stats.firstDay,
    days: (Number(next.source?.days) || 0) + brandNewDays,
    records: (Number(next.source?.records) || 0) + newRecords,
    months: [...new Set([...(next.source?.months ?? []), ...(legacy.months ?? [])])],
  };

  return { plan: next, report: described, changed: true, added: { sales: salesToAdd.length, repairs: repairs.length, expenses: expenses.length, cashOps: cashOps.length } };
}

/** Fold one sale into a summary month's list of lines (same shape as the plan's). */
function foldIntoSummary(plan, sale) {
  const month = monthOf(sale.date);
  const label = sale.section === 'used' ? 'مستعمل' : sale.section === 'phones' ? sale.name : (sale.name);
  const key = `sum-${month}-${sale.section}-${nameKey(label)}`;
  const qty = Number(sale.qty) || 1;
  const total = (Number(sale.sell) || 0) * qty;
  const cost = (Number(sale.buy) || 0) * qty;
  const existing = plan.summary.find((row) => row.id === key);
  if (existing) {
    existing.count += 1;
    existing.qty += qty;
    existing.total = money0(existing.total + total);
    existing.cost = money0(existing.cost + cost);
    return;
  }
  plan.summary.push({
    id: key,
    month,
    section: sale.section,
    label,
    categoryId: null,
    count: 1,
    qty,
    total,
    cost,
    include: true,
  });
}
