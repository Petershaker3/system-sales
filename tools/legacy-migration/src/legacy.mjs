// Reading the old program's backup.
//
// The export is one JSON object whose keys are the legacy storage keys: a day
// per `mshop_d_YYYY-MM-DD`, plus a handful of collections (`mshop_inventory`,
// `mshop_ca`, `mshop_cu`, ...). The values are JSON *strings*, not nested
// objects, because the old program stored everything as text.
//
// This module turns that into plain data and nothing else: it decides no
// mapping and writes no row. Every judgement about what survives lives in
// `plan.mjs`, so the screen and the tests reason about the same object.

import {
  normalizeText,
  numberOr,
  parseClock,
  latinDigits,
  monthOf,
} from './util.mjs';

export const DAY_KEY = /^mshop_d_(\d{4}-\d{2}-\d{2})$/;

/** The seven daily sections, as the old program wrote them. */
export const SECTIONS = ['acc', 'used', 'sw', 'cash', 'exp', 'phones', 'repairs'];

/** Keys the old program wrote that this tool never moves into the new system. */
export const NEVER_IMPORTED = {
  mshop_notes: 'الملاحظات',
  mshop_notifs: 'التنبيهات',
  mshop_trash: 'سلة المحذوفات',
  mshop_calc_hist: 'تاريخ الآلة الحاسبة',
  mshop_rep_log: 'عدّادات أسماء الصيانة',
  mshop_tab_order: 'ترتيب التابات',
  mshop_last_backup: 'تاريخ آخر نسخة',
  mshop_drive_return: 'علم رجوع درايف',
  mshop_brands_keypad: 'قديم: ماركات الزراير',
};

/** Keys that carry no business rows but should still be shown as seen. */
export const OPAQUE_KEYS = ['mshop_cfg'];

function parseJson(value, key, problems) {
  if (typeof value !== 'string') {
    // Some exports store the inner value as real JSON. Accept both.
    return value;
  }
  const text = value.trim();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    problems.push({ level: 'warn', code: 'legacy-value-not-json', key, detail: text.slice(0, 80) });
    return null;
  }
}

function readArray(value, key, problems) {
  const parsed = parseJson(value, key, problems);
  if (Array.isArray(parsed)) return parsed;
  if (parsed === null || parsed === undefined) return [];
  problems.push({ level: 'warn', code: 'legacy-value-not-array', key });
  return [];
}

function readObject(value, key, problems) {
  const parsed = parseJson(value, key, problems);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  return {};
}

function clockOrNull(value) {
  return value ? parseClock(value) : null;
}

/**
 * Normalize one cash record.
 *
 * The old system's two money fields mean different things, and the difference
 * decides whether the new wallet balance would be right: `transferAmount` is
 * the money that actually moved, `amount` is the shop's commission. For about a
 * fortnight in July 2026 the owner recorded both; before and after that he
 * recorded only the commission. So a record is `exact` only when the moved
 * amount is known — everything else is a commission entry and cannot move a
 * balance without inventing one.
 */
function cashRecord(raw, day, index) {
  const cashType = normalizeText(raw.cashType);
  const moved = numberOr(raw.transferAmount, 0);
  const fee = numberOr(raw.amount, 0);
  return {
    id: `cash-${day}-${index}`,
    date: day,
    clock: normalizeText(raw.time),
    hasClock: Boolean(clockOrNull(raw.time)),
    service: normalizeText(raw.service) || 'غير محدد',
    walletId: raw.walletId === null || raw.walletId === undefined ? '' : normalizeText(raw.walletId),
    // Missing `cashType` is the oldest shape; those rows were deposits.
    kind: cashType === 'سحب' ? 'withdraw' : 'deposit',
    kindWasMissing: cashType === '',
    moved,
    fee,
    hasMovedAmount: moved > 0,
    include: true,
  };
}

function daySection(records, day, section) {
  if (!Array.isArray(records)) return [];
  return records.map((raw, index) => {
    const base = {
      id: `${section}-${day}-${index}`,
      date: day,
      clock: normalizeText(raw.time),
      hasClock: Boolean(clockOrNull(raw.time)),
      rolled: raw._rolled === true,
      raw,
    };
    switch (section) {
      case 'acc':
        return {
          ...base,
          name: normalizeText(raw.name) || '(بدون اسم)',
          category: normalizeText(raw.mainCat),
          buy: numberOr(raw.buy, 0),
          sell: numberOr(raw.sell, 0),
          profit: numberOr(raw.profit, 0),
        };
      case 'used':
        return {
          ...base,
          name: normalizeText(raw.name) || '(بدون اسم)',
          buy: numberOr(raw.buy, 0),
          sell: numberOr(raw.sell, 0),
          profit: numberOr(raw.profit, 0),
          note: normalizeText(raw.note),
        };
      case 'phones':
        return {
          ...base,
          productLegacyId: normalizeText(raw.modelId),
          name: normalizeText(raw.modelName) || `${normalizeText(raw.brand)} ${normalizeText(raw.model)}`,
          brand: normalizeText(raw.brand),
          model: normalizeText(raw.model),
          qty: Math.max(1, numberOr(raw.qty, 1)),
          buy: numberOr(raw.buyPrice, 0),
          sell: numberOr(raw.sellPrice, 0),
          profit: numberOr(raw.profit, 0),
        };
      case 'sw':
        return {
          ...base,
          name: normalizeText(raw.name) || '(بدون اسم)',
          price: numberOr(raw.price, 0),
          note: normalizeText(raw.note),
          paid: raw.paid !== false,
          delivered: raw.delivered !== false,
        };
      case 'exp':
        return {
          ...base,
          category: normalizeText(raw.category) || 'مصاريف',
          amount: numberOr(raw.amount, 0),
        };
      case 'repairs':
        return {
          ...base,
          ticketNo: normalizeText(raw.no),
          clientName: normalizeText(raw.clientName),
          clientPhone: normalizeText(raw.clientPhone),
          brand: normalizeText(raw.brand),
          model: normalizeText(raw.model),
          deviceType: normalizeText(raw.deviceType) || 'موبايل',
          fault: normalizeText(raw.faultType),
          partName: normalizeText(raw.partName),
          partCost: numberOr(raw.partBuyPrice, 0),
          servicePrice: numberOr(raw.servicePrice, 0),
          profit: numberOr(raw.profit, 0),
          supplier: normalizeText(raw.supplier),
          notes: normalizeText(raw.notes),
          status: normalizeText(raw.status),
          fixed: raw.fixed === true,
          delivered: raw.delivered === true,
          paid: raw.paid === true,
        };
      case 'cash':
        return cashRecord(raw, day, index);
      default:
        return base;
    }
  });
}

/**
 * Read the whole export.
 *
 * Returns `{ ok, problems, ... }`. A file that is not the old program's JSON is
 * refused here with a reason, before any screen shows an empty table and lets
 * the owner believe his data is gone.
 */
export function readLegacyBackup(text) {
  const problems = [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, problems: [{ level: 'error', code: 'not-json', detail: String(error.message || error) }] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, problems: [{ level: 'error', code: 'not-object' }] };
  }

  const keys = Object.keys(parsed);
  const days = [];
  const seen = new Set();
  const excluded = [];
  const unknown = [];

  for (const key of keys) {
    const match = key.match(DAY_KEY);
    if (!match) continue;
    const day = match[1];
    seen.add(day);
    const raw = parseJson(parsed[key], key, problems);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push({ level: 'warn', code: 'legacy-day-not-object', key });
      continue;
    }
    const sections = {};
    for (const section of SECTIONS) {
      sections[section] = daySection(raw[section], day, section);
    }
    days.push({ day, sections });
  }
  days.sort((a, b) => a.day.localeCompare(b.day));

  const cfg = readObject(parsed.mshop_cfg, 'mshop_cfg', problems);
  const walletsCfg = readObject(parsed.mshop_wallets_cfg, 'mshop_wallets_cfg', problems);
  const walletsList = readArray(parsed.mshop_wallets_list, 'mshop_wallets_list', problems);
  const categories = readArray(parsed.mshop_cats, 'mshop_cats', problems)
    .map((name) => normalizeText(typeof name === 'string' ? name : name?.name))
    .filter(Boolean);
  const expenseCategories = readArray(parsed.mshop_ce, 'mshop_ce', problems)
    .map((name) => normalizeText(typeof name === 'string' ? name : name?.name))
    .filter(Boolean);
  const accessories = readArray(parsed.mshop_ca, 'mshop_ca', problems)
    .map((row, index) => ({
      id: `ca-${index}`,
      name: normalizeText(row.name) || `إكسسوار ${index + 1}`,
      buy: numberOr(row.buy, 0),
      sell: numberOr(row.sell, 0),
    }))
    .filter((row) => row.name);
  const usedCatalog = readArray(parsed.mshop_cu, 'mshop_cu', problems)
    .map((row, index) => ({
      id: `cu-${index}`,
      name: normalizeText(row.name) || `مستعمل ${index + 1}`,
      buy: numberOr(row.buy, 0),
      sell: numberOr(row.sell, 0),
    }))
    .filter((row) => row.name);
  const inventory = readArray(parsed.mshop_inventory, 'mshop_inventory', problems).map((row, index) => ({
    id: normalizeText(row.id) || `ph_${index}`,
    brand: normalizeText(row.brand),
    model: normalizeText(row.model),
    ram: normalizeText(row.ram),
    storage: normalizeText(row.storage),
    color: normalizeText(row.color),
    internalCode: normalizeText(row.internalCode),
    qty: Math.max(0, numberOr(row.qty, 0)),
    buyPrice: numberOr(row.buyPrice, 0),
    supplier: normalizeText(row.supplier),
    notes: normalizeText(row.notes),
    addedDate: normalizeText(row.addedDate),
    lastBuyDate: normalizeText(row.lastBuyDate),
    archived: row.archived === true,
    eventLog: Array.isArray(row.eventLog) ? row.eventLog : [],
  }));

  const brands = new Set();
  for (const row of inventory) if (row.brand) brands.add(row.brand);
  for (const row of readArray(parsed.mshop_brands2_keypad, 'mshop_brands2_keypad', problems)) {
    const name = normalizeText(typeof row === 'string' ? row : row?.name);
    if (name) brands.add(name);
  }
  for (const row of readArray(parsed.mshop_brands_keypad, 'mshop_brands_keypad', problems)) {
    const name = normalizeText(row);
    if (name) brands.add(name);
  }
  for (const day of days) {
    for (const sale of day.sections.phones) if (sale.brand) brands.add(sale.brand);
    for (const repair of day.sections.repairs) if (repair.brand) brands.add(repair.brand);
  }

  const suppliers = new Set();
  for (const row of inventory) {
    if (row.supplier) suppliers.add(row.supplier);
    for (const entry of row.eventLog || []) {
      if (entry && entry.supplier) suppliers.add(normalizeText(entry.supplier));
    }
  }
  for (const day of days) {
    for (const repair of day.sections.repairs) if (repair.supplier) suppliers.add(repair.supplier);
  }

  // Every top-level key not consumed above is reported rather than ignored: a
  // backup from a newer version of the old program must not lose a section in
  // silence.
  const consumed = new Set([
    'mshop_cfg', 'mshop_wallets_cfg', 'mshop_wallets_list', 'mshop_cats', 'mshop_ce',
    'mshop_ca', 'mshop_cu', 'mshop_inventory', 'mshop_brands2_keypad',
  ]);
  for (const key of keys) {
    if (DAYS_HAS(key) || consumed.has(key)) continue;
    if (NEVER_IMPORTED[key]) {
      excluded.push({ key, label: NEVER_IMPORTED[key] });
      continue;
    }
    unknown.push(key);
  }

  const months = new Map();
  for (const day of days) {
    const month = monthOf(day.day);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(day);
  }

  const stats = {
    days: days.length,
    firstDay: days[0]?.day || null,
    lastDay: days[days.length - 1]?.day || null,
    records: days.reduce(
      (total, day) => total + SECTIONS.reduce((inner, section) => inner + day.sections[section].length, 0),
      0,
    ),
    rolled: days.reduce(
      (total, day) => total + SECTIONS.filter((section) => section !== 'cash' && section !== 'exp')
        .reduce((inner, section) => inner + day.sections[section].filter((record) => record.rolled).length, 0),
      0,
    ),
  };

  return {
    ok: true,
    problems,
    shopName: normalizeText(cfg.name) || 'المحل',
    logoDataUrl: typeof cfg.logoImg === 'string' && cfg.logoImg.startsWith('data:image/') ? cfg.logoImg : '',
    days,
    months: [...months.keys()].sort(),
    daysByMonth: months,
    categories,
    expenseCategories,
    accessories,
    usedCatalog,
    inventory,
    wallets: { cfg: walletsCfg, list: walletsList },
    brands: [...brands].sort((a, b) => a.localeCompare(b, 'ar')),
    suppliers: [...suppliers].sort((a, b) => a.localeCompare(b, 'ar')),
    excluded,
    unknown,
    stats,
    // Legacy passwords and the Google client id are deliberately not carried.
    legacySecretsSeen: Object.keys(cfg).filter((key) => /pass|clientid|token/i.test(key)),
  };
}

function DAYS_HAS(key) {
  return DAY_KEY.test(key);
}

/** Scores used by the report: what each month holds, in pounds. */
export function monthTotals(days) {
  const totals = {
    acc: { count: 0, sell: 0, buy: 0 },
    used: { count: 0, sell: 0, buy: 0 },
    phones: { count: 0, sell: 0, buy: 0, qty: 0 },
    sw: { count: 0, price: 0 },
    repairs: { count: 0, service: 0, parts: 0 },
    cash: { count: 0, fees: 0, deposits: 0, withdrawals: 0 },
    exp: { count: 0, amount: 0 },
  };
  for (const day of days) {
    for (const row of day.sections.acc) {
      totals.acc.count += 1;
      totals.acc.sell += row.sell;
      totals.acc.buy += row.buy;
    }
    for (const row of day.sections.used) {
      totals.used.count += 1;
      totals.used.sell += row.sell;
      totals.used.buy += row.buy;
    }
    for (const row of day.sections.phones) {
      totals.phones.count += 1;
      totals.phones.qty += row.qty;
      totals.phones.sell += row.sell * row.qty;
      totals.phones.buy += row.buy * row.qty;
    }
    for (const row of day.sections.sw) {
      totals.sw.count += 1;
      totals.sw.price += row.price;
    }
    for (const row of day.sections.repairs) {
      totals.repairs.count += 1;
      totals.repairs.service += row.servicePrice;
      totals.repairs.parts += row.partCost;
    }
    for (const row of day.sections.cash) {
      totals.cash.count += 1;
      totals.cash.fees += row.fee;
      if (row.kind === 'withdraw') totals.cash.withdrawals += row.moved;
      else totals.cash.deposits += row.moved;
    }
    for (const row of day.sections.exp) {
      totals.exp.count += 1;
      totals.exp.amount += row.amount;
    }
  }
  return totals;
}

export function clockTextOf(record) {
  return record?.clock ? latinDigits(record.clock) : '';
}
