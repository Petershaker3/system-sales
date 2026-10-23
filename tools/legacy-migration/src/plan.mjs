// From the old program's export to a plan the owner can read and edit.
//
// The plan is the whole contract of this tool: the screen edits it, the SQLite
// builder writes it, and the report explains it. It is plain JSON with pounds
// (not piastres) so a shop owner can look at it and see his own numbers; the
// builder is the only place that converts money to minor units.
//
// Every default here is a decision, and each one is written down where it is
// made. Where the old data cannot answer a question — an accessory's current
// quantity, a wallet's real balance today — the plan carries a clearly-marked
// guess rather than a silent zero.

import {
  dayOf,
  groupBy,
  idFor,
  monthLabel,
  monthOf,
  nameKey,
  normalizeText,
  numberOr,
  stampMs,
} from './util.mjs';

export const PLAN_FORMAT = 'system-sales-migration';
export const PLAN_VERSION = 1;

/** The icon set the new system accepts; anything else is refused by its domain. */
export const CATEGORY_ICONS = [
  'tag', 'package', 'smartphone', 'watch', 'headphones', 'plug-zap', 'cable',
  'shield', 'layers', 'battery-charging', 'memory-stick', 'car', 'wallet-cards',
  'signal', 'wrench', 'sparkles', 'recycle',
];

const ICON_HINTS = [
  [/سكرين|شاش|سكرين/, 'layers'],
  [/جراب|كاتر|كفر/, 'shield'],
  [/وصل|كابل/, 'cable'],
  [/شاحن|شواحن/, 'plug-zap'],
  [/سماع|ايربودز|هيدفون|طوق/, 'headphones'],
  [/ساع/, 'watch'],
  [/بطار/, 'battery-charging'],
  [/كروت|فلاش|ميمور/, 'memory-stick'],
  [/بوربنك|باور/, 'battery-charging'],
  [/كمبيوتر|لابتوب/, 'tag'],
  [/موبايل|هاتف|تليفون/, 'smartphone'],
  [/مستعمل/, 'recycle'],
  [/صيان|تصليح/, 'wrench'],
];

function iconFor(name) {
  for (const [pattern, icon] of ICON_HINTS) if (pattern.test(name)) return icon;
  return 'tag';
}

/** The old program's accessory categories are counted goods. */
function kindForLegacyCategory() {
  return 'item';
}

/** Map a company name to the way the new system records keypad versus touch. */
function deviceTypeFor(brand) {
  const keypadOnly = ['hmd', 'micromax', 'sulean', 'nokia', 'itel'];
  return keypadOnly.includes(nameKey(brand)) ? 'both' : 'touch';
}

function sortOrder(index) {
  return (index + 1) * 10;
}

/**
 * Build the default plan.
 *
 * `options.currentMonth` chooses which month keeps its individual sales; every
 * earlier month is summarised (`mode: 'summary'`) or skipped. The owner's
 * request was exactly this: past months as monthly figures, not as thousands of
 * line items.
 */
export function buildDefaultPlan(legacy, options = {}) {
  const months = legacy.months.length ? legacy.months : [];
  const currentMonth = options.currentMonth || months[months.length - 1] || monthOf(dayOf(Date.now()));
  const pastMode = options.pastMode || 'summary';

  // ── Categories ────────────────────────────────────────────────────────────
  const categories = [];
  const categoryByName = new Map();
  const addCategory = (name, extra = {}) => {
    const clean = normalizeText(name);
    if (!clean) return null;
    const existing = categoryByName.get(nameKey(clean));
    if (existing) return existing;
    const category = {
      id: idFor(`category:${nameKey(clean)}`),
      name: clean,
      parentId: null,
      kind: 'item',
      icon: iconFor(clean),
      sortOrder: sortOrder(categories.length),
      include: true,
      ...extra,
    };
    categories.push(category);
    categoryByName.set(nameKey(clean), category);
    return category;
  };

  for (const name of legacy.categories) addCategory(name);
  // The three kinds the new system registers differently. They are added only
  // when the old categories do not already carry the name.
  addCategory('موبايلات جديدة', { kind: 'phone', icon: 'smartphone' });
  addCategory('مستعمل', { kind: 'used', icon: 'recycle' });
  if (legacy.usedCatalog.length === 0 && !categoryByName.has(nameKey('مستعمل'))) {
    addCategory('مستعمل', { kind: 'used', icon: 'recycle' });
  }

  // Learned category per accessory name: a sale row is the only place the old
  // program records which chip an item belonged to.
  const learnedCategory = new Map();
  for (const day of legacy.days) {
    for (const row of day.sections.acc) {
      if (!row.category) continue;
      const key = nameKey(row.name);
      if (!learnedCategory.has(key)) learnedCategory.set(key, row.category);
    }
  }

  const categoryForAccessory = (name) => {
    const learned = learnedCategory.get(nameKey(name));
    if (learned) return categoryByName.get(nameKey(learned)) || null;
    // Longest matching old category name is the safest prefix guess: "ضهر كاتر"
    // must win over a shorter unrelated word.
    const candidates = legacy.categories
      .filter((category) => nameKey(name).startsWith(nameKey(category)))
      .sort((a, b) => b.length - a.length);
    if (candidates.length) return categoryByName.get(nameKey(candidates[0])) || null;
    return null;
  };

  const phoneCategory = addCategory('موبايلات جديدة', { kind: 'phone', icon: 'smartphone' });
  const usedCategory = addCategory('مستعمل', { kind: 'used', icon: 'recycle' });

  // ── Brands ────────────────────────────────────────────────────────────────
  // Deduplicated case-insensitively: the old file lists `Samsung` and `samsung`
  // as different strings, and the new system's unique index would refuse the
  // second one — a whole build failing over a capital letter.
  // Two spellings of one brand are one brand, and the one with capitals is the
  // one a customer should read: `samsung` came from a sale, `Samsung` from the
  // catalogue. Picking the prettier spelling only changes the label — the id is
  // derived from the case-folded key, so it stays the same either way.
  const preferredSpelling = (variants) => {
    const score = (name) => (/[A-Z]/.test(name) ? 2 : 0) + (/[a-z]/.test(name) ? 1 : 0);
    return variants.slice().sort((a, b) => score(b) - score(a) || b.length - a.length)[0];
  };
  const brands = [];
  const brandVariants = new Map();
  for (const name of legacy.brands) {
    const key = nameKey(name);
    if (!key) continue;
    const variants = brandVariants.get(key);
    if (variants) {
      variants.push(name);
      continue;
    }
    brandVariants.set(key, [name]);
    brands.push({
      id: idFor(`brand:${key}`),
      name,
      deviceType: deviceTypeFor(name),
      sortOrder: sortOrder(brands.length),
      include: true,
    });
  }
  const seenBrands = brandVariants;
  for (const brand of brands) {
    const variants = seenBrands.get(nameKey(brand.name));
    if (variants && variants.length > 1) brand.name = preferredSpelling(variants);
  }
  const brandByName = new Map(brands.map((brand) => [nameKey(brand.name), brand]));
  const brandIdFor = (name) => {
    const clean = normalizeText(name);
    if (!clean) return null;
    const key = nameKey(clean);
    if (!brandByName.has(key)) {
      const brand = {
        id: idFor(`brand:${key}`),
        name: clean,
        deviceType: deviceTypeFor(clean),
        sortOrder: sortOrder(brands.length),
        include: true,
      };
      brands.push(brand);
      brandByName.set(key, brand);
    }
    return brandByName.get(key).id;
  };

  // ── Items: accessories, used phones, new phones ───────────────────────────
  const items = [];
  const itemByName = new Map();
  const addItem = (item) => {
    const record = {
      id: item.id || idFor(`item:${item.kind}:${item.sourceRef || nameKey(item.name)}`),
      kind: item.kind,
      name: normalizeText(item.name),
      categoryId: item.categoryId ?? null,
      brandId: item.brandId ?? null,
      model: item.model ?? '',
      ramGb: item.ramGb ?? null,
      storageGb: item.storageGb ?? null,
      color: item.color ?? '',
      deviceType: item.deviceType ?? null,
      buy: numberOr(item.buy, 0),
      sell: item.sell === null || item.sell === undefined ? null : numberOr(item.sell, 0),
      qty: Math.max(0, Math.trunc(numberOr(item.qty, 0))),
      supplier: item.supplier ?? '',
      notes: item.notes ?? '',
      include: item.include !== false,
      sourceRef: item.sourceRef ?? '',
      archived: item.archived === true,
      priceSource: item.priceSource ?? '',
      // ── Used handsets ────────────────────────────────────────────────────
      // A used phone is a *device*, not a count: the new system files it on the
      // «مستعمل» shelf with its IMEI and its condition, and a shelf row without a
      // device cannot be sold. The old catalogue (`mshop_cu`) knows models and
      // prices only — it has no count and no numbers — so the owner types the
      // devices he still holds. `qty` mirrors the devices for the used kind and is
      // never a second opinion (`devices` is what the builder writes).
      devices: item.kind === 'used' && Array.isArray(item.devices)
        ? item.devices.map((device) => ({
          imei: normalizeText(device.imei ?? ''),
          condition: device.condition ?? '',
          cost: device.cost === null || device.cost === undefined ? null : numberOr(device.cost, 0),
          note: device.note ?? '',
        }))
        : [],
    };
    items.push(record);
    if (record.kind !== 'phone') itemByName.set(nameKey(record.name), record);
    return record;
  };

  for (const row of legacy.accessories) {
    const category = categoryForAccessory(row.name);
    addItem({
      kind: 'accessory',
      name: row.name,
      buy: row.buy,
      sell: row.sell,
      qty: 0, // the old catalogue never stored a quantity
      categoryId: category?.id ?? null,
      sourceRef: row.id,
      priceSource: 'mshop_ca',
    });
  }

  for (const row of legacy.usedCatalog) {
    addItem({
      kind: 'used',
      name: row.name,
      buy: row.buy,
      sell: row.sell,
      qty: 0,
      devices: [],
      categoryId: usedCategory?.id ?? null,
      priceSource: 'mshop_cu',
    });
  }

  // A phone's last recorded sale price is the only selling price the old
  // inventory does not store; it is offered as a suggestion, never as a fact.
  const lastPhonePrice = new Map();
  for (const day of legacy.days) {
    for (const sale of day.sections.phones) {
      if (sale.sell > 0) lastPhonePrice.set(sale.productLegacyId || nameKey(sale.name), sale.sell);
    }
  }

  for (const row of legacy.inventory) {
    const brandId = brandIdFor(row.brand);
    const storage = row.storage ? Number(String(row.storage).replace(/[^\d]/g, '')) : null;
    const ram = row.ram ? Number(String(row.ram).replace(/[^\d]/g, '')) : null;
    const keypad = brandId ? (brands.find((brand) => brand.id === brandId)?.deviceType === 'both') : false;
    addItem({
      kind: 'phone',
      name: phoneName(row),
      categoryId: phoneCategory?.id ?? null,
      brandId,
      model: row.model,
      ramGb: !keypad && ram ? ram : null,
      storageGb: !keypad && storage ? storage : null,
      color: row.color,
      deviceType: keypad ? 'keypad' : 'touch',
      buy: row.buyPrice,
      sell: lastPhonePrice.get(row.id) ?? null,
      qty: row.qty,
      supplier: row.supplier,
      notes: row.notes,
      sourceRef: row.id,
      priceSource: 'mshop_inventory',
      archived: row.archived,
    });
  }

  // ── Months and sales ──────────────────────────────────────────────────────
  const monthModes = months.map((month) => ({
    id: month,
    month,
    label: monthLabel(month),
    mode: month === currentMonth ? 'detail' : pastMode,
    include: true,
    totals: monthTotalsOf(legacy.daysByMonth.get(month) || []),
  }));

  const detailMonths = new Set(monthModes.filter((entry) => entry.include && entry.mode === 'detail').map((entry) => entry.month));
  const summaryMonths = new Set(monthModes.filter((entry) => entry.include && entry.mode === 'summary').map((entry) => entry.month));

  const sales = [];
  const summary = [];

  for (const day of legacy.days) {
    const month = monthOf(day.day);
    const isDetail = detailMonths.has(month);
    const isSummary = summaryMonths.has(month);
    if (!isDetail && !isSummary) continue;

    for (const section of ['acc', 'used', 'phones']) {
      for (const row of day.sections[section]) {
        if (row.rolled) continue;
        if (isDetail) {
          const item = ensureItemForSale(row, section, {
            items, itemByName, addItem, categoryByName, usedCategory, phoneCategory, brandIdFor,
          });
          if (!item) continue;
          sales.push({
            id: `sale-${row.id}`,
            sourceId: row.id,
            date: row.day ?? day.day,
            clock: row.clock,
            section,
            itemId: item.id,
            name: item.name,
            qty: section === 'phones' ? row.qty : 1,
            buy: row.buy,
            sell: row.sell,
            recordedProfit: row.profit ?? null,
            include: true,
          });
        }
      }
      if (isSummary) {
        // Per-category for accessories (that is the breakdown the old reports
        // had); one line for used devices; one line per model for phones.
        const rows = day.sections[section].filter((row) => !row.rolled);
        const keyOf = section === 'acc'
          ? (row) => row.category || 'بدون تصنيف'
          : section === 'used'
            ? () => 'مستعمل'
            : (row) => row.name;
        const grouped = groupBy(rows, keyOf);
        for (const [label, group] of grouped) {
          const quantity = section === 'phones' ? group.reduce((total, row) => total + row.qty, 0) : group.length;
          const total = section === 'phones'
            ? group.reduce((value, row) => value + row.sell * row.qty, 0)
            : group.reduce((value, row) => value + row.sell, 0);
          const cost = section === 'phones'
            ? group.reduce((value, row) => value + row.buy * row.qty, 0)
            : group.reduce((value, row) => value + row.buy, 0);
          const categoryId = section === 'acc'
            ? categoryByName.get(nameKey(label))?.id ?? null
            : section === 'used'
              ? usedCategory?.id ?? null
              : phoneCategory?.id ?? null;
          summary.push({
            id: `sum-${month}-${section}-${nameKey(label)}`,
            month,
            section,
            label,
            categoryId,
            count: group.length,
            qty: quantity,
            total,
            cost,
            include: true,
          });
        }
      }
    }
  }

  // ── Repairs and software ──────────────────────────────────────────────────
  // Both are small in the old data and they are *not* sales: the new system
  // keeps them as tickets with their own price and parts cost, so every month's
  // repair figure stays exact without keeping thousands of sale rows.
  const repairs = [];
  let repairCounter = 0;
  for (const day of legacy.days) {
    for (const row of day.sections.repairs) {
      if (row.rolled) continue;
      repairCounter += 1;
      const device = [row.brand, row.model].filter(Boolean).join(' ').trim();
      repairs.push({
        id: `repair-${row.id}`,
        sourceId: row.id,
        date: day.day,
        clock: row.clock,
        kind: 'hardware',
        ticketNo: row.ticketNo || `OLD-${String(repairCounter).padStart(4, '0')}`,
        customerName: row.clientName,
        customerPhone: row.clientPhone,
        deviceName: device || row.deviceType || 'جهاز',
        issue: row.fault || row.partName || 'صيانة',
        note: [row.partName ? `القطعة: ${row.partName}` : '', row.supplier ? `المورد: ${row.supplier}` : '', row.notes]
          .filter(Boolean).join(' — '),
        partsCost: row.partCost,
        price: row.servicePrice,
        delivered: row.delivered === true,
        paid: row.paid !== false,
        include: true,
      });
    }
    for (const row of day.sections.sw) {
      if (row.rolled) continue;
      repairCounter += 1;
      repairs.push({
        id: `repair-${row.id}`,
        sourceId: row.id,
        date: day.day,
        clock: row.clock,
        kind: 'software',
        ticketNo: `SW-${String(repairCounter).padStart(4, '0')}`,
        customerName: '',
        customerPhone: '',
        deviceName: row.name,
        issue: 'سوفت وير',
        note: row.note,
        partsCost: 0,
        price: row.price,
        delivered: row.delivered !== false,
        paid: row.paid !== false,
        include: true,
      });
    }
  }

  // ── Expenses ──────────────────────────────────────────────────────────────
  const expenses = [];
  for (const day of legacy.days) {
    for (const row of day.sections.exp) {
      expenses.push({
        id: `expense-${row.id}`,
        sourceId: row.id,
        date: day.day,
        clock: row.clock,
        category: row.category,
        amount: row.amount,
        include: true,
      });
    }
  }

  // ── Wallets ───────────────────────────────────────────────────────────────
  const wallets = buildWallets(legacy);

  // ── Cash / wallet services ────────────────────────────────────────────────
  // The old cash rows are commissions, not money flows (see `legacy.mjs`), so
  // they are counted and reported, never written as wallet operations: doing so
  // would invent balances. Only their totals reach the new system's report.
  const cashOps = [];
  for (const day of legacy.days) {
    for (const row of day.sections.cash) {
      cashOps.push({
        id: `cash-${row.id}`,
        sourceId: row.id,
        date: day.day,
        clock: row.clock,
        service: row.service,
        kind: row.kind,
        moved: row.moved,
        fee: row.fee,
        hasMovedAmount: row.hasMovedAmount,
        include: true,
      });
    }
  }

  const settings = {
    shopName: legacy.shopName,
    logoDataUrl: legacy.logoDataUrl,
    ownerUsername: 'owner',
    currentMonth,
    // The new system opens with an unclaimed owner row (`ADR-039`), so the shop
    // is usable the moment the backup is restored, and the owner sets his own
    // password (or PIN) from the settings screen when he wants to.
    openOwnerAccount: true,
  };

  return {
    format: PLAN_FORMAT,
    version: PLAN_VERSION,
    createdAt: new Date().toISOString(),
    source: {
      shopName: legacy.shopName,
      firstDay: legacy.stats.firstDay,
      lastDay: legacy.stats.lastDay,
      days: legacy.stats.days,
      records: legacy.stats.records,
      months: legacy.months,
      excludedKeys: legacy.excluded,
      unknownKeys: legacy.unknown,
      suppliers: legacy.suppliers,
    },
    settings,
    categories,
    brands,
    items,
    months: monthModes,
    sales,
    summary,
    repairs,
    expenses,
    cashOps,
    wallets,
    expenseCategories: legacy.expenseCategories.map((name, index) => ({
      id: `expcat-${index}`,
      name,
      include: true,
    })),
  };
}

function phoneName(row) {
  const parts = [row.brand, row.model].filter(Boolean).join(' ');
  const memory = [row.ram, row.storage].filter(Boolean).join('/');
  return normalizeText(`${parts}${memory ? ` ${memory}` : ''}`) || 'موبايل';
}

function ensureItemForSale(row, section, context) {
  const { items, itemByName, addItem, categoryByName, usedCategory, phoneCategory, brandIdFor } = context;
  if (section === 'phones') {
    const existing = items.find((item) => item.kind === 'phone' && (item.sourceRef === row.productLegacyId || nameKey(item.name) === nameKey(row.name)));
    if (existing) return existing;
    return addItem({
      kind: 'phone',
      name: row.name,
      categoryId: phoneCategory?.id ?? null,
      brandId: brandIdFor(row.brand),
      model: row.model,
      buy: row.buy,
      sell: row.sell || null,
      qty: 0,
      deviceType: 'touch',
      sourceRef: row.productLegacyId,
      priceSource: 'daily-sales',
    });
  }
  if (section === 'used') {
    const existing = itemByName.get(nameKey(row.name));
    if (existing) return existing;
    return addItem({
      kind: 'used',
      name: row.name,
      buy: row.buy,
      sell: row.sell,
      qty: 0,
      devices: [],
      categoryId: usedCategory?.id ?? null,
      priceSource: 'daily-sales',
    });
  }
  const existing = itemByName.get(nameKey(row.name));
  if (existing) return existing;
  return addItem({
    kind: 'accessory',
    name: row.name,
    buy: row.buy,
    sell: row.sell,
    qty: 0,
    categoryId: categoryByName.get(nameKey(row.category))?.id ?? null,
    priceSource: 'daily-sales',
  });
}

function monthTotalsOf(days) {
  const totals = { sales: 0, cost: 0, profit: 0, expenses: 0, fees: 0, repairs: 0, count: 0 };
  for (const day of days) {
    for (const row of day.sections.acc) {
      totals.sales += row.sell; totals.cost += row.buy; totals.profit += row.sell - row.buy; totals.count += 1;
    }
    for (const row of day.sections.used) {
      totals.sales += row.sell; totals.cost += row.buy; totals.profit += row.sell - row.buy; totals.count += 1;
    }
    for (const row of day.sections.phones) {
      totals.sales += row.sell * row.qty; totals.cost += row.buy * row.qty;
      totals.profit += (row.sell - row.buy) * row.qty; totals.count += 1;
    }
    for (const row of day.sections.sw) {
      totals.repairs += row.price; totals.profit += row.price; totals.count += 1;
    }
    for (const row of day.sections.repairs) {
      totals.repairs += row.servicePrice; totals.profit += row.servicePrice - row.partCost; totals.count += 1;
    }
    for (const row of day.sections.exp) {
      totals.expenses += row.amount; totals.profit -= row.amount; totals.count += 1;
    }
    for (const row of day.sections.cash) {
      totals.fees += row.fee; totals.profit += row.fee; totals.count += 1;
    }
  }
  return totals;
}

function buildWallets(legacy) {
  const list = Array.isArray(legacy.wallets.list) ? legacy.wallets.list : [];
  const cfg = legacy.wallets.cfg || {};
  const builtIn = new Map([
    [nameKey('فودافون كاش'), { id: 'vf', payMethod: 'vf', name: 'فودافون كاش' }],
    [nameKey('اتصالات كاش'), { id: 'et', payMethod: null, name: 'اتصالات كاش' }],
    [nameKey('اورانج كاش'), { id: 'or', payMethod: null, name: 'أورنج كاش' }],
    [nameKey('أورنج كاش'), { id: 'or', payMethod: null, name: 'أورنج كاش' }],
    [nameKey('وي كاش'), { id: 'we', payMethod: null, name: 'وي باي' }],
    [nameKey('وي باي'), { id: 'we', payMethod: null, name: 'وي باي' }],
    [nameKey('انستا باي'), { id: 'ip', payMethod: 'instapay', name: 'إنستاباي' }],
    [nameKey('إنستاباي'), { id: 'ip', payMethod: 'instapay', name: 'إنستاباي' }],
  ]);

  // Which service names appear in the cash rows, and how much commission each
  // earned: the only evidence the old file offers about a wallet's activity.
  const activity = new Map();
  for (const day of legacy.days) {
    for (const row of day.sections.cash) {
      const key = nameKey(row.service);
      const entry = activity.get(key) || { moved: 0, fees: 0 };
      entry.moved += row.moved;
      entry.fees += row.fee;
      activity.set(key, entry);
    }
  }

  const wallets = [];
  const seen = new Set();
  const push = (entry) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    wallets.push(entry);
  };

  for (const row of list) {
    const legacyName = normalizeText(row.label) ? normalizeText(row.service) : normalizeText(row.service);
    const builtin = builtIn.get(nameKey(legacyName));
    const config = cfg[legacyName] || cfg[row.id] || {};
    const openingDate = normalizeText(config.openingDate) || '2026-07-01';
    const opening = numberOr(config.openingBalance, 0);
    const number = normalizeText(row.number) || '';
    if (builtin) {
      push({
        id: builtin.id,
        legacyId: row.id,
        name: builtin.name,
        number,
        payMethod: builtin.payMethod,
        custom: false,
        include: true,
        // The old file has an opening figure, not a balance today. The tool
        // asks the owner for today's figure; this one is the starting guess.
        openingBalance: opening,
        openingDate,
        currentBalance: opening,
        balanceIsGuess: true,
        dailyLimit: numberOr(config.dailyLimit, 0),
      });
    } else {
      push({
        id: idFor(`wallet:${nameKey(row.id || legacyName)}`),
        legacyId: row.id,
        name: legacyName,
        number,
        payMethod: null,
        custom: true,
        include: true,
        openingBalance: opening,
        openingDate,
        currentBalance: opening,
        balanceIsGuess: true,
        dailyLimit: numberOr(config.dailyLimit, 0),
      });
    }
  }

  // Wallets the cash rows mention but the wallet list never did.
  for (const [key, entry] of activity) {
    const name = key === nameKey('أخري') ? 'أخرى' : key;
    const builtin = builtIn.get(key);
    if (builtin && seen.has(builtin.id)) continue;
    if (!builtin && wallets.some((wallet) => nameKey(wallet.name) === nameKey(name))) continue;
    push({
      id: builtin ? builtin.id : idFor(`wallet:${key}`),
      legacyId: '',
      name: builtin ? builtin.name : normalizeText(entry.fees ? name : name),
      number: '',
      payMethod: builtin ? builtin.payMethod : null,
      custom: !builtin,
      include: Boolean(entry.fees || entry.moved),
      openingBalance: 0,
      openingDate: '2026-07-01',
      currentBalance: 0,
      balanceIsGuess: true,
      dailyLimit: 0,
    });
  }

  return wallets;
}

/**
 * Cross-check the plan before it becomes a database.
 *
 * Every finding names the record it is about, because a warning nobody can act
 * on is noise. `error` blocks the build; `warn` does not.
 */
// ── Used handsets: the IMEI rule, shared by the screen and the builder ──────
//
// A used phone in the new system is a *unit* with an IMEI, a condition and its
// own cost. The database refuses anything but fifteen digits and a unique value,
// and the counter refuses a bad check digit; a migration that wrote a number the
// app cannot use would look fine in the file and fail at the first sale.

/** Arabic-Indic digits and separators are what a person types; keep the digits. */
export function normalizeImei(raw) {
  let out = '';
  for (const ch of String(raw ?? '')) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '-' || ch === '|') continue;
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x0660 && code <= 0x0669) out += String(code - 0x0660);
    else if (code >= 0x06f0 && code <= 0x06f9) out += String(code - 0x06f0);
    else out += ch;
  }
  return out;
}

/** Fifteen digits with a correct Luhn check digit — the app's own rule. */
export function isValidImei(raw) {
  const digits = normalizeImei(raw);
  if (!/^\d{15}$/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < 14; index += 1) {
    let digit = Number(digits[index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return (10 - (sum % 10)) % 10 === Number(digits[14]);
}

/** The device count of a used row; what the builder will write. */
export function usedDeviceCount(item) {
  return Array.isArray(item.devices) ? item.devices.length : 0;
}

export function validatePlan(plan) {
  const findings = [];
  const push = (level, code, message, ref = null) => findings.push({ level, code, message, ref });

  const categories = new Map(plan.categories.map((category) => [category.id, category]));
  const activeNames = new Map();
  for (const category of plan.categories) {
    if (!category.include) continue;
    const key = nameKey(category.name);
    if (activeNames.has(key)) {
      push('error', 'duplicate-category', `التصنيف «${category.name}» مكرر — أسماء التصنيفات لازم تكون مختلفة.`, category.id);
    }
    activeNames.set(key, category);
    if (!category.name.trim()) push('error', 'empty-category', 'تصنيف من غير اسم.', category.id);
    if (!CATEGORY_ICONS.includes(category.icon)) {
      push('warn', 'category-icon', `أيقونة «${category.name}» غير معروفة، هتتحول لـ tag.`, category.id);
    }
  }
  for (const category of plan.categories) {
    if (category.parentId && !categories.has(category.parentId)) {
      push('warn', 'orphan-category', `التصنيف «${category.name}» مربوط بتصنيف أب مش موجود.`, category.id);
    }
  }

  const itemsById = new Map(plan.items.map((item) => [item.id, item]));
  const names = new Set();
  for (const item of plan.items) {
    if (!item.include) continue;
    if (!normalizeText(item.name)) push('error', 'empty-item', 'صنف من غير اسم.', item.id);
    if (item.buy < 0 || (item.sell !== null && item.sell < 0)) {
      push('error', 'negative-price', `«${item.name}» فيه سعر سالب.`, item.id);
    }
    if (item.categoryId && !categories.has(item.categoryId)) {
      push('warn', 'item-category', `«${item.name}» في تصنيف مش موجود.`, item.id);
    }
    if (item.kind === 'phone') {
      if (!item.model) push('warn', 'phone-model', `«${item.name}» من غير موديل.`, item.id);
      if (!item.brandId) push('warn', 'phone-brand', `«${item.name}» من غير شركة.`, item.id);
    }
    if (item.sell === null || item.sell === undefined) {
      push('warn', 'no-sale-price', `«${item.name}» من غير سعر بيع — هيتسجل بلا سعر لحد ما تحدده.`, item.id);
    }
    // A phone whose cost is zero reports profit as the whole price. That is a
    // wrong number in every report after it, so it is named before the build.
    if (item.kind !== 'accessory' && !(item.buy > 0)) {
      push('warn', 'phone-cost-zero', `«${item.name}» بتكلفة صفر — الربح في التقارير هيطلع أكتر من الحقيقة.`, item.id);
    }
    {
      const key = nameKey(item.name);
      if (names.has(key)) {
        push(
          'warn',
          'duplicate-item',
          item.kind === 'phone'
            ? `«${item.name}» مكرر بنفس الشركة والموديل والذاكرة — هيتعملهم موديلين في «الهواتف» والعدد بيتقسم عليهم.`
            : `«${item.name}» متكرر — هيتعمله صنفين منفصلين.`,
          item.id,
        );
      }
      names.add(key);
    }
  }

  // ── Used handsets: every device must be sellable ─────────────────────────
  // The new system files a used phone as a unit with an IMEI. A used model with
  // no devices is a row in the catalogue that never reaches the «مستعمل» shelf,
  // so the owner is told before he finds an empty shelf after the restore.
  const seenImei = new Map();
  for (const item of plan.items) {
    if (!item.include || item.kind !== 'used') continue;
    const devices = Array.isArray(item.devices) ? item.devices : [];
    if (devices.length === 0) {
      push('warn', 'used-no-device', `مستعمل «${item.name}» من غير أجهزة مسجّلة — هيتنقل كصنف في الكتالوج، ومش هيبان في رف «مستعمل».`, item.id);
    }
    for (const device of devices) {
      const imei = normalizeImei(device.imei);
      if (!isValidImei(imei)) {
        push('error', 'used-imei', `رقم الجهاز «${device.imei || 'فاضي'}» في «${item.name}» مش رقم IMEI صحيح (١٥ رقم مع رقم تحقق سليم).`, item.id);
        continue;
      }
      if (seenImei.has(imei)) {
        push('error', 'used-imei-duplicate', `الرقم ${imei} متسجل مرتين — مرة في «${seenImei.get(imei)}» ومرة في «${item.name}»، والبرنامج بيرفض الرقم المتكرر.`, item.id);
        continue;
      }
      seenImei.set(imei, item.name);
      if (device.condition !== 'A' && device.condition !== 'B' && device.condition !== 'C') {
        push('error', 'used-condition', `جهاز ${imei} في «${item.name}» من غير حالة (A / B / C) — والحالة هي اللي بتخليه «مستعمل» في السيستم.`, item.id);
      }
      const cost = device.cost === null || device.cost === undefined ? item.buy : device.cost;
      if (!(cost > 0)) {
        push('warn', 'used-cost-zero', `جهاز ${imei} في «${item.name}» بتكلفة صفر — الربح عليه هيطلع غلط.`, item.id);
      }
    }
  }

  // ── Counts: what the shop actually has of each thing ─────────────────────
  // The old program kept a count for phones only. Everything else lands at zero,
  // which is a legal number and a useless shelf: the shop restores the backup and
  // finds nothing to sell. One finding per kind, so it is a to-do and not noise.
  const accessories = plan.items.filter((item) => item.include && item.kind === 'accessory');
  const accessoriesWithoutCount = accessories.filter((item) => !(item.qty > 0));
  if (accessories.length && accessoriesWithoutCount.length) {
    push(
      'warn',
      'accessory-counts',
      `${accessoriesWithoutCount.length} من ${accessories.length} إكسسوار من غير عدد — هيتنقلوا برصيد صفر ومش هتقدروا تبيعوهم من الكاشير.`,
      null,
    );
  }
  const freshPhones = plan.items.filter((item) => item.include && item.kind === 'phone');
  const freshPieces = freshPhones.reduce((total, item) => total + (item.qty > 0 ? item.qty : 0), 0);
  if (freshPieces > 0) {
    push(
      'warn',
      'phone-no-imei',
      `${freshPieces} جهاز جديد هينزلوا بالعدد من غير أرقام IMEI — بيعدّوا في «الهواتف» وبينزلوا المخزن، بس مش هتقدر تبيع الواحد برقمه لحد ما تسجّله.`,
      null,
    );
  }

  for (const sale of plan.sales) {
    if (!sale.include) continue;
    if (!itemsById.has(sale.itemId)) {
      push('error', 'sale-item-missing', `بيعة «${sale.name}» مربوطة بصنف مش موجود.`, sale.id);
    }
  }

  // An item left out of the catalogue, with sales in a detailed month: the
  // builder keeps the sales on an archived row so the month's money stays right.
  // Saying it here means the owner is not surprised by a product they excluded
  // still carrying its monthly figures.
  const soldByItem = new Map();
  for (const sale of plan.sales) {
    if (!sale.include) continue;
    soldByItem.set(sale.itemId, (soldByItem.get(sale.itemId) || 0) + sale.sell * sale.qty);
  }
  for (const item of plan.items) {
    if (item.include) continue;
    const money = soldByItem.get(item.id);
    if (money) {
      push('warn', 'item-excluded-with-sales', `«${item.name}» مش محدد للنقل، بس عليه مبيعات بـ${money} ج — المبيعات هتتنقل على صنف مؤرشف باسمه عشان رقم الشهر يفضل صح.`, item.id);
    }
  }

  for (const month of plan.months) {
    if (month.mode === 'skip' && month.include) {
      push('warn', 'month-skipped', `شهر ${month.label} متحدد إنه ما يتنقلش.`, month.month);
    }
  }

  for (const wallet of plan.wallets) {
    if (!wallet.include) continue;
    if (wallet.currentBalance < 0) push('error', 'wallet-negative', `رصيد «${wallet.name}» سالب.`, wallet.id);
    if (wallet.number.length > 80) push('warn', 'wallet-number', `رقم «${wallet.name}» طويل.`, wallet.id);
  }

  for (const expense of plan.expenses) {
    if (!expense.include) continue;
    if (!(expense.amount > 0)) push('warn', 'expense-zero', `مصروف «${expense.category}» بمبلغ صفر — هيتشال.`, expense.id);
  }

  for (const repair of plan.repairs) {
    if (!repair.include) continue;
    if (!(repair.price >= 0) || !(repair.partsCost >= 0)) {
      push('error', 'repair-price', `تذكرة ${repair.ticketNo}: مبلغ سالب.`, repair.id);
    }
  }

  const includes = {
    categories: plan.categories.filter((row) => row.include).length,
    brands: plan.brands.filter((row) => row.include).length,
    items: plan.items.filter((row) => row.include).length,
    sales: plan.sales.filter((row) => row.include).length,
    summary: plan.summary.filter((row) => row.include).length,
    repairs: plan.repairs.filter((row) => row.include).length,
    expenses: plan.expenses.filter((row) => row.include).length,
    wallets: plan.wallets.filter((row) => row.include).length,
  };

  return { findings, includes };
}

/** The plan's own arithmetic, so the report and the screen agree. */
export function planTotals(plan) {
  const sales = plan.sales.filter((row) => row.include);
  const summary = plan.summary.filter((row) => row.include);
  const expenses = plan.expenses.filter((row) => row.include);
  const repairs = plan.repairs.filter((row) => row.include);

  const saleTotal = sales.reduce((total, row) => total + row.sell * row.qty, 0);
  const saleCost = sales.reduce((total, row) => total + row.buy * row.qty, 0);
  const summaryTotal = summary.reduce((total, row) => total + row.total, 0);
  const summaryCost = summary.reduce((total, row) => total + row.cost, 0);
  const expenseTotal = expenses.reduce((total, row) => total + row.amount, 0);
  const repairTotal = repairs.reduce((total, row) => total + row.price, 0);
  const repairCost = repairs.reduce((total, row) => total + row.partsCost, 0);

  // ── Pieces, not just rows ────────────────────────────────────────────────
  // The «هواتف» section is read in pieces, and the shop thinks in pieces. The
  // overview, the report and the screen all read these numbers from here so no
  // two of them can disagree about how many phones are coming across.
  const countedItems = plan.items.filter((row) => row.include);
  const counts = {
    accessoryItems: countedItems.filter((row) => row.kind === 'accessory').length,
    accessoryPieces: countedItems
      .filter((row) => row.kind === 'accessory')
      .reduce((total, row) => total + Math.max(0, Math.trunc(Number(row.qty) || 0)), 0),
    phoneModels: countedItems.filter((row) => row.kind === 'phone').length,
    phonePieces: countedItems
      .filter((row) => row.kind === 'phone')
      .reduce((total, row) => total + Math.max(0, Math.trunc(Number(row.qty) || 0)), 0),
    usedModels: countedItems.filter((row) => row.kind === 'used').length,
    usedDevices: countedItems
      .filter((row) => row.kind === 'used')
      .reduce((total, row) => total + usedDeviceCount(row), 0),
  };

  return {
    counts,
    saleTotal,
    saleCost,
    saleProfit: saleTotal - saleCost,
    summaryTotal,
    summaryCost,
    summaryProfit: summaryTotal - summaryCost,
    expenseTotal,
    repairTotal,
    repairCost,
    monthCount: plan.months.filter((row) => row.include).length,
    itemCount: plan.items.filter((row) => row.include).length,
    saleCount: sales.length,
    summaryCount: summary.length,
    repairCount: repairs.length,
    expenseCount: expenses.length,
  };
}

/** A stable stamp for a plan record, used by the builder. */
export function scheduleOf(record) {
  const ms = stampMs(record.date, record.clock);
  return ms === null ? stampMs(record.date, '12:00') : ms;
}

export { monthOf, dayOf };
