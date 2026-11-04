// Sales whose item was deleted from the draft.
//
// The owner reorganised the shop's catalogue by hand: hundreds of merges, renames
// and deletes. Merging moves a row's sales onto the surviving row (`mergeGroup`),
// but deleting the row outright leaves its sales pointing at an id that is no
// longer there — and the builder refuses to write an invoice for a product that
// does not exist (2026-11-02: 301 sales, 42 items, all in the detailed month).
//
// The money is real and the month's total must not move, so the repair looks for
// a home for every orphaned sale, in this order:
//
//   1. an item with the **same name** — the duplicate the owner kept;
//   2. an item whose name **contains** it (or the other way round) — what a merge
//      leaves behind when it renames «سكرين غزالة» to «سكرين غزالة/اميجو/اوهاي»;
//   3. otherwise the item is put back from the sale's own numbers, **excluded**
//      from the catalogue and with a count of zero — the month keeps its money,
//      and the shelf gains nothing that was never counted.
//
// Nothing is guessed silently: `describeOrphanSales` says which sale went where
// and why, and the screen prints that before and after the repair.

import { nameKey } from './util.mjs';

const KIND_OF_SECTION = { acc: 'accessory', used: 'used', phones: 'phone' };

function groupOrphans(plan) {
  const ids = new Set(plan.items.map((item) => item.id));
  const groups = new Map();
  for (const sale of plan.sales) {
    if (sale.include === false || ids.has(sale.itemId)) continue;
    const group = groups.get(sale.itemId) || {
      itemId: sale.itemId,
      name: sale.name,
      section: sale.section,
      count: 0,
      money: 0,
      sales: [],
    };
    group.count += 1;
    group.money += (Number(sale.sell) || 0) * (Number(sale.qty) || 1);
    group.sales.push(sale);
    groups.set(sale.itemId, group);
  }
  return [...groups.values()];
}

/** Where each orphaned sale would go, without changing anything. */
export function describeOrphanSales(plan) {
  const groups = groupOrphans(plan);
  const byName = new Map();
  for (const item of plan.items) {
    const key = nameKey(item.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(item);
  }

  const plan_ = { matched: [], guessed: [], recreated: [], totalSales: 0, totalMoney: 0 };
  for (const group of groups) {
    plan_.totalSales += group.count;
    plan_.totalMoney += group.money;
    const key = nameKey(group.name);
    const exact = byName.get(key)?.[0];
    if (exact) {
      plan_.matched.push({ ...group, to: exact.id, toName: exact.name, why: 'نفس الاسم' });
      continue;
    }
    // A merged row carries both names in one label; the orphan is a part of it.
    // Only an **unambiguous** one counts: two items that both contain the name
    // mean the tool cannot tell which shelf the sale came from, and guessing
    // between them would move money to the wrong product.
    const candidates = plan.items.filter((item) => {
      const other = nameKey(item.name);
      if (!other || !key) return false;
      return other.includes(key) || key.includes(other);
    });
    const partial = candidates.length === 1 ? candidates[0] : null;
    if (partial) {
      plan_.guessed.push({ ...group, to: partial.id, toName: partial.name, why: 'الاسم جوه اسم الصنف اللي دمجته' });
      continue;
    }
    plan_.recreated.push(group);
  }
  return plan_;
}

/**
 * Put the money back where it belongs.
 *
 * Returns a new plan; the caller keeps the old one for undo.
 */
export function repairOrphanSales(plan) {
  const described = describeOrphanSales(plan);
  if (!described.totalSales) return { plan, report: described, changed: false };

  const next = JSON.parse(JSON.stringify(plan));
  const assign = (group, toId) => {
    for (const sale of next.sales) {
      if (sale.itemId === group.itemId) sale.itemId = toId;
    }
  };

  for (const group of [...described.matched, ...described.guessed]) assign(group, group.to);

  for (const group of described.recreated) {
    // The sale says what the shop sold it for; the item is put back excluded so
    // the catalogue is not re-filled with rows the owner deleted on purpose.
    const first = group.sales[0];
    const source = plan.items.find((item) => item.id === group.itemId) ?? null;
    const categoryId = source?.categoryId
      ?? plan.categories.find((category) => category.include && category.kind === (KIND_OF_SECTION[group.section] ?? 'item'))?.id
      ?? null;
    const item = {
      id: group.itemId,
      kind: KIND_OF_SECTION[group.section] ?? 'accessory',
      name: group.name,
      categoryId,
      brandId: source?.brandId ?? null,
      model: source?.model ?? '',
      ramGb: source?.ramGb ?? null,
      storageGb: source?.storageGb ?? null,
      color: source?.color ?? '',
      deviceType: source?.deviceType ?? null,
      buy: Number(first?.buy) || 0,
      sell: Number(first?.sell) || null,
      qty: 0,
      supplier: '',
      notes: 'الصنف اتشال من المسودة وكان عليه بيعات — رجع عشان فلوس الشهر ما تضيعش.',
      include: false,
      archived: true,
      priceSource: '',
      sourceRef: '',
      devices: [],
    };
    next.items.push(item);
  }

  return { plan: next, report: described, changed: true };
}
