// Writing the new system's `shop.db`.
//
// This is the only module that turns a plan into rows, and it does so under the
// real schema: the migrations in `migrations.generated.mjs` are the application's
// own files, byte for byte, and the `_sqlx_migrations` rows carry the SHA-384 of
// each file. SQLx validates those checksums when the app opens the database, so
// an exact match is what makes the restored backup open without re-running a
// migration over tables that already exist.
//
// Everything the new system refuses, this builder refuses first: money is
// integer piastres, a phone has a company and a model together, an archived
// product is never sold in the catalog, and a repair names its device.

import { MIGRATIONS } from './migrations.generated.mjs';
import { argon2id } from '@noble/hashes/argon2';
import {
  base64NoPad,
  dayOf,
  idFor,
  nameKey,
  normalizeText,
  sha256Bytes,
  sha256Hex,
  sha384Bytes,
  toMinor,
  utf8Of,
} from './util.mjs';
import { normalizeImei, scheduleOf } from './plan.mjs';

/** The identity a restored shop runs on until the owner claims it (`ADR-039`). */
export const OPEN_OWNER_NAME = 'المالك';

// The app's own Argon2id cost (`services/identity/crypto.rs`): a verifier this
// tool writes must be the shape the app would have written, or a future login
// attempt fails on parameters instead of on a password.
const ARGON_MEMORY_KIB = 19 * 1024;
const ARGON_TIME_COST = 2;
const ARGON_PARALLELISM = 1;
const ARGON_OUTPUT_LEN = 32;

/**
 * A real Argon2id PHC verifier for the open owner row.
 *
 * ADR-039 gives that row the hash of a secret nobody is told. The secret here is
 * derived from the plan instead of drawn at random, so two builds of the same
 * backup produce the same file — and `provisional = 1` is what keeps it from
 * ever being a login, exactly as it does for the hash the app writes itself.
 */
function openOwnerVerifier(plan) {
  const seed = sha256Bytes(utf8Of(`system-sales-migration:${plan.settings?.shopName ?? ''}:${plan.ownerId ?? ''}`));
  const salt = seed.slice(0, 16);
  const secret = seed.slice(16, 32);
  const hash = argon2id(secret, salt, {
    m: ARGON_MEMORY_KIB,
    t: ARGON_TIME_COST,
    p: ARGON_PARALLELISM,
    dkLen: ARGON_OUTPUT_LEN,
  });
  return `$argon2id$v=19$m=${ARGON_MEMORY_KIB},t=${ARGON_TIME_COST},p=${ARGON_PARALLELISM}$${base64NoPad(salt)}$${base64NoPad(hash)}`;
}

const DEFAULT_CATEGORY_ICON = 'tag';

function idOf(planId) {
  return planId;
}

function summaryProductName(row) {
  const section = row.section === 'acc' ? 'إكسسوارات' : row.section === 'used' ? 'مستعمل' : 'موبايلات';
  return `ترحيل ${section} — ${row.label}`;
}

function departmentKindOf(item, categoriesById) {
  const category = categoriesById.get(item.categoryId);
  if (category?.kind === 'phone' || category?.kind === 'used') return category.kind;
  return 'item';
}

function lastDayOfMonth(month) {
  const [year, index] = month.split('-').map(Number);
  const date = new Date(year, index, 0);
  return dayOf(date.getTime());
}

/**
 * Build the database bytes.
 *
 * `SQL` is the sql.js module (initialised by the caller with the wasm binary).
 * The build is synchronous after that: sql.js has no async work to do and an
 * interrupted build must not leave a half-written file anywhere.
 */
export function buildShopDatabase({ SQL, plan, logoJpeg = null, now = Date.now() }) {
  const warnings = [];
  const db = new SQL.Database();
  try {
    db.run('PRAGMA foreign_keys = ON;');
    db.run('PRAGMA journal_mode = DELETE;');

    // ── Schema ──────────────────────────────────────────────────────────────
    // SQLx's own bookkeeping table, created with the exact definition from
    // `sqlx-sqlite/src/migrate.rs`. The app reads it on every start: an applied
    // version missing here would make it re-run a migration over existing
    // tables, and a checksum that disagrees would make it refuse to open.
    db.run(`
      CREATE TABLE IF NOT EXISTS _sqlx_migrations (
          version BIGINT PRIMARY KEY,
          description TEXT NOT NULL,
          installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          success BOOLEAN NOT NULL,
          checksum BLOB NOT NULL,
          execution_time BIGINT NOT NULL
      );`);
    for (const migration of MIGRATIONS) {
      db.run(migration.sql);
      const checksum = sha384Bytes(migration.sql);
      db.run(
        `INSERT INTO _sqlx_migrations (version, description, installed_on, success, checksum, execution_time)
         VALUES (?, ?, ?, 1, ?, 0)`,
        [migration.version, migration.description, new Date(now).toISOString().replace('T', ' ').replace('Z', ''), checksum],
      );
    }

    // ── Identity ────────────────────────────────────────────────────────────
    const ownerId = plan.ownerId || idForOwner(plan);
    const stamp = now;
    const verifier = plan.ownerVerifier || openOwnerVerifier(plan);
    // The open owner row of ADR-039: provisional, manager, and no usable
    // password — the app opens straight into the shop and the owner claims this
    // row from settings. `find_open` looks at `provisional`, nothing else.
    db.run(
      `INSERT INTO users (id, display_name, role, verifier, failed_attempts, locked_until,
                          created_at, updated_at, disabled_at, disabled_by, provisional)
       VALUES (?, ?, 'manager', ?, 0, NULL, ?, ?, NULL, NULL, 1)`,
      [ownerId, OPEN_OWNER_NAME, verifier, stamp, stamp],
    );
    const username = uniqueUsername(db, plan.settings.ownerUsername || 'owner');
    db.run(
      'INSERT INTO user_credentials (user_id, username, must_change_password) VALUES (?, ?, 0)',
      [ownerId, username],
    );
    db.run(
      `INSERT INTO audit_events (id, user_id, event_type, occurred_at, detail)
       VALUES (?, ?, 'migration_imported', ?, ?)`,
      [
        `audit-${stamp}`,
        ownerId,
        stamp,
        JSON.stringify({
          tool: 'legacy-migration',
          source_first_day: plan.source?.firstDay ?? null,
          source_last_day: plan.source?.lastDay ?? null,
          source_days: plan.source?.days ?? null,
          current_month: plan.settings.currentMonth,
        }),
      ],
    );

    // ── Settings ────────────────────────────────────────────────────────────
    const setSetting = (key, value) => {
      db.run(
        `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        [key, String(value), ownerId, stamp],
      );
    };
    setSetting('ui.shop_name', normalizeText(plan.settings.shopName) || 'المحل');

    // ── Categories ──────────────────────────────────────────────────────────
    const categoriesById = new Map();
    const includedCategories = plan.categories.filter((row) => row.include);
    const categoryIds = new Set(includedCategories.map((row) => row.id));
    // Parents first so the tree triggers see a main category before a child.
    const ordered = [
      ...includedCategories.filter((row) => !row.parentId),
      ...includedCategories.filter((row) => row.parentId),
    ];
    for (const category of ordered) {
      const parentId = category.parentId && categoryIds.has(category.parentId) ? category.parentId : null;
      const kind = parentId
        ? (categoriesById.get(parentId)?.kind ?? category.kind ?? 'item')
        : (['item', 'phone', 'used'].includes(category.kind) ? category.kind : 'item');
      const icon = category.icon || DEFAULT_CATEGORY_ICON;
      db.run(
        `INSERT INTO departments (id, name, status, cost_method, vat_enabled, vat_rate_bp, vat_inclusive,
                                  created_by, updated_by, created_at, updated_at,
                                  parent_id, kind, icon, hidden, sort_order)
         VALUES (?, ?, 'active', 'moving_average', 0, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          category.id,
          normalizeText(category.name),
          ownerId,
          ownerId,
          stamp,
          stamp,
          parentId,
          kind,
          icon,
          category.hidden ? 1 : 0,
          Number(category.sortOrder) || 0,
        ],
      );
      categoriesById.set(category.id, { ...category, kind, parentId });
    }

    // ── Brands ──────────────────────────────────────────────────────────────
    const brandsById = new Map();
    for (const brand of plan.brands.filter((row) => row.include)) {
      db.run(
        `INSERT INTO brands (id, name, device_type, sort_order, hidden, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          brand.id,
          normalizeText(brand.name),
          ['touch', 'keypad', 'both'].includes(brand.deviceType) ? brand.deviceType : 'touch',
          Number(brand.sortOrder) || 0,
          brand.hidden ? 1 : 0,
          ownerId,
          ownerId,
          stamp,
          stamp,
        ],
      );
      brandsById.set(brand.id, brand);
    }

    // ── Items ───────────────────────────────────────────────────────────────
    // An item the owner left out of the catalogue still ships when a sale in a
    // detailed month points at it: the invoice must keep its money, and a sale
    // line cannot exist without a product row. It travels as an *archived*
    // product, so it never shows up in the POS — the catalogue decision and the
    // month's total are both respected.
    const soldItemIds = new Set(
      plan.sales
        .filter((sale) => sale.include)
        .map((sale) => sale.itemId),
    );
    const products = plan.items
      .filter((row) => row.include || soldItemIds.has(row.id))
      .map((row) => (row.include ? row : { ...row, archived: true }));
    const productIds = new Set(products.map((row) => row.id));
    const itemsById = new Map(products.map((row) => [row.id, row]));

    for (const item of products) {
      const departmentId = item.categoryId && categoriesById.has(item.categoryId) ? item.categoryId : null;
      const departmentKind = departmentKindOf(item, categoriesById);
      const isPhoneLike = item.kind === 'phone' || departmentKind === 'phone' || departmentKind === 'used';
      const disposition = isPhoneLike ? 'serialized' : 'quantity';
      const brandId = item.brandId && brandsById.has(item.brandId) ? item.brandId : null;
      const hasPhoneDetails = Boolean(brandId && normalizeText(item.model));
      const keypad = hasPhoneDetails && item.deviceType === 'keypad';
      const salePrice = item.sell === null || item.sell === undefined ? null : toMinor(item.sell);
      const cost = item.buy ? toMinor(item.buy) : null;
      db.run(
        `INSERT INTO products (id, name, disposition, barcode, sale_price_minor, department_id,
                               default_cost_minor, vat_rate_bp, status, created_by, updated_by,
                               created_at, updated_at,
                               brand_id, model, device_type, storage_gb, ram_gb,
                               parent_id, variant_1, variant_2, variant_order, tracking)
         VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
        [
          item.id,
          normalizeText(item.name),
          disposition,
          salePrice,
          departmentId,
          cost,
          item.archived ? 'archived' : 'active',
          ownerId,
          ownerId,
          stamp,
          stamp,
          hasPhoneDetails ? brandId : null,
          hasPhoneDetails ? normalizeText(item.model) : null,
          hasPhoneDetails ? (keypad ? 'keypad' : 'touch') : null,
          hasPhoneDetails && !keypad && item.storageGb ? Number(item.storageGb) : null,
          hasPhoneDetails && !keypad && item.ramGb ? Number(item.ramGb) : null,
          hasPhoneDetails ? 'serial_optional' : 'none',
        ],
      );
    }

    // ── Stock: an opening count, then the month's sales ─────────────────────
    const soldByProduct = new Map();
    // Only months the owner left on «تفصيلي» become invoices: switching a month
    // to «مجمّع» or «مش متنقل» must actually stop its rows at the door.
    const detailMonths = new Set(
      plan.months.filter((month) => month.include && month.mode === 'detail').map((month) => month.month),
    );
    const summaryMonths = new Set(
      plan.months.filter((month) => month.include && month.mode === 'summary').map((month) => month.month),
    );
    const detailSales = plan.sales.filter(
      (row) => row.include && productIds.has(row.itemId) && detailMonths.has(row.date.slice(0, 7)),
    );
    for (const sale of detailSales) {
      soldByProduct.set(sale.itemId, (soldByProduct.get(sale.itemId) || 0) + sale.qty);
    }

    const stockByProduct = new Map();
    const addStock = (productId, quantity, totalCostMinor) => {
      const entry = stockByProduct.get(productId) || { quantity: 0, cost: 0 };
      entry.quantity += quantity;
      entry.cost += totalCostMinor;
      stockByProduct.set(productId, entry);
    };

    let movementSeq = 0;
    const nextMovementId = (productId) => `mv-${sha256Hex(`${productId}:${movementSeq += 1}`).slice(0, 24)}`;
    // The receipt a used handset came in on: `units.received_movement_id` points at
    // the movement that put it on the shelf, and the stock counter is that same
    // movement. One receipt, so the shelf and its handsets can never disagree.
    const openingMovementByProduct = new Map();

    // The owner's typed quantity is *today's* count. To end there after the
    // imported sales, the opening receipt carries today's count plus what the
    // month sold — otherwise a shop that has two of something and sold one would
    // end with one instead of two.
    for (const item of products) {
      const sold = soldByProduct.get(item.id) || 0;
      const devices = Array.isArray(item.devices) ? item.devices : [];
      // The old catalogue has no count for a used model, and a used handset is
      // registered by its IMEI — so the number on the shelf is the number of
      // devices the owner typed, never an invented quantity.
      const target = item.kind === 'used'
        ? devices.length
        : Math.max(0, Math.trunc(Number(item.qty) || 0));
      const openingQty = target + sold;
      if (openingQty > 0) {
        // The opening batch carries the cost the month actually paid for what it
        // sold, rounded up by at most a piastre, so the ledger can never end with
        // a negative cost after the sales consume their own quantity.
        const soldCost = detailSales
          .filter((sale) => sale.itemId === item.id)
          .reduce((total, sale) => total + (toMinor(sale.buy) || 0) * Math.max(1, Math.trunc(Number(sale.qty) || 1)), 0);
        const deviceCosts = devices.map((device) => toMinor(
          device.cost === null || device.cost === undefined ? item.buy : device.cost,
        ) || 0);
        const devicesCost = deviceCosts.reduce((total, value) => total + value, 0);
        const unitCost = devicesCost > 0
          ? Math.round(devicesCost / devices.length)
          : sold > 0 ? Math.ceil(soldCost / sold) : (toMinor(item.buy) || 0);
        const receiptCost = devicesCost > 0 ? devicesCost + unitCost * sold : unitCost * openingQty;
        const firstSale = detailSales
          .filter((sale) => sale.itemId === item.id)
          .map((sale) => scheduleOf(sale) || stamp)
          .sort((a, b) => a - b)[0];
        const occurredAt = Math.min(stamp, firstSale ? firstSale - 60_000 : stamp);
        const movementId = nextMovementId(item.id);
        db.run(
          `INSERT INTO stock_movements (id, product_id, kind, quantity_delta, unit_cost_minor,
                                        cost_delta_minor, occurred_at, actor_id, sale_id, sale_line_id,
                                        fifo_layer_id, fifo_received_at, reverses_movement_id,
                                        supplier_name, receipt_kind)
           VALUES (?, ?, 'receipt', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 'opening')`,
          [movementId, item.id, openingQty, unitCost, receiptCost, occurredAt, ownerId],
        );
        openingMovementByProduct.set(item.id, movementId);
        addStock(item.id, openingQty, receiptCost);
      } else {
        addStock(item.id, 0, 0);
      }
    }

    // ── Used handsets, each one a unit ──────────────────────────────────────
    // `units` is what the «هواتف» section reads for the used shelf: its IMEI, its
    // condition (A/B/C — that is what makes it used) and the cost it was bought
    // at. Writing a stock count without units would put the money on the new
    // shelf and mix the two kinds the owner asked to keep apart.
    let unitCount = 0;
    for (const item of products) {
      const devices = Array.isArray(item.devices) ? item.devices : [];
      if (item.kind !== 'used' || devices.length === 0) continue;
      const movementId = openingMovementByProduct.get(item.id) ?? null;
      for (const device of devices) {
        const imei = normalizeImei(device.imei);
        const costMinor = toMinor(
          device.cost === null || device.cost === undefined ? item.buy : device.cost,
        ) || 0;
        db.run(
          `INSERT INTO units (id, product_id, imei, imei2, color, unit_cost_minor, status,
                              received_movement_id, sale_line_id, retired_reason, created_by,
                              created_at, condition_grade, battery_health_pct, accessories,
                              seller_name, seller_phone, seller_national_id, intake_note)
           VALUES (?, ?, ?, NULL, ?, ?, 'in_stock', ?, NULL, NULL, ?, ?, ?, NULL, NULL,
                   NULL, NULL, NULL, ?)`,
          [
            `unit-${sha256Hex(`${item.id}:${imei}`).slice(0, 24)}`,
            item.id,
            imei,
            normalizeText(item.color) || null,
            costMinor,
            movementId,
            ownerId,
            stamp,
            device.condition,
            normalizeText(device.note) || null,
          ],
        );
        unitCount += 1;
      }
    }

    // ── Sales for the detailed months ───────────────────────────────────────
    const salesByDay = new Map();
    for (const sale of detailSales) {
      const key = sale.date;
      if (!salesByDay.has(key)) salesByDay.set(key, []);
      salesByDay.get(key).push(sale);
    }

    let saleStats = { count: 0, total: 0, cost: 0 };
    for (const [day, daySales] of [...salesByDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      daySales.sort((a, b) => (scheduleOf(a) || 0) - (scheduleOf(b) || 0));
      let sequence = 0;
      for (const sale of daySales) {
        sequence += 1;
        const item = itemsById.get(sale.itemId);
        const quantity = Math.max(1, Math.trunc(Number(sale.qty) || 1));
        const unitPrice = toMinor(sale.sell) || 0;
        const unitCost = toMinor(sale.buy) || 0;
        const totalMinor = unitPrice * quantity;
        const costMinor = unitCost * quantity;
        const saleId = `sale-${sale.id}`;
        const lineId = `line-${sale.id}`;
        const occurredAt = scheduleOf(sale) || stamp;
        const reference = `TRH-${day.replace(/-/g, '')}-${String(sequence).padStart(3, '0')}`;

        db.run(
          `INSERT INTO sales (id, reference, occurred_at, sold_by, kind, reverses_sale_id,
                              total_minor, cost_total_minor, customer_id, customer_name_snapshot,
                              discount_minor, approved_by)
           VALUES (?, ?, ?, ?, 'sale', NULL, ?, ?, NULL, NULL, 0, NULL)`,
          [saleId, reference, occurredAt, ownerId, totalMinor, costMinor],
        );
        const departmentId = item.categoryId && categoriesById.has(item.categoryId) ? item.categoryId : null;
        db.run(
          `INSERT INTO sale_lines (id, sale_id, line_no, product_id, product_name, disposition,
                                   quantity, unit_selling_price_minor, line_total_minor,
                                   unit_cost_minor, line_cost_minor, department_id, cost_method,
                                   warranty_start, warranty_end, unit_id, reverses_line_id,
                                   return_condition, discount_minor)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'moving_average', NULL, NULL, NULL, NULL, NULL, 0)`,
          [
            lineId,
            saleId,
            item.id,
            normalizeText(sale.name || item.name),
            item.kind === 'phone' || departmentKindOf(item, categoriesById) !== 'item' ? 'serialized' : 'quantity',
            quantity,
            unitPrice,
            totalMinor,
            unitCost,
            costMinor,
            departmentId,
          ],
        );
        db.run(
          `INSERT INTO sale_payments (id, sale_id, payment_no, method, amount_minor, reference, occurred_at, wallet_id)
           VALUES (?, ?, 1, 'cash', ?, NULL, ?, NULL)`,
          [`pay-${sale.id}`, saleId, totalMinor, occurredAt],
        );
        db.run(
          `INSERT INTO stock_movements (id, product_id, kind, quantity_delta, unit_cost_minor,
                                        cost_delta_minor, occurred_at, actor_id, sale_id, sale_line_id,
                                        fifo_layer_id, fifo_received_at, reverses_movement_id,
                                        supplier_name, receipt_kind)
           VALUES (?, ?, 'sale', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`,
          [
            nextMovementId(item.id),
            item.id,
            -quantity,
            unitCost,
            -costMinor,
            occurredAt,
            ownerId,
            saleId,
            lineId,
          ],
        );
        addStock(item.id, -quantity, -costMinor);
        saleStats = { count: saleStats.count + 1, total: saleStats.total + totalMinor, cost: saleStats.cost + costMinor };
      }
    }

    // ── Summarised past months ──────────────────────────────────────────────
    // One archived product per (section, category) and one invoice per month.
    // Archived on purpose: a summary is history, not something to sell again, and
    // the POS lists active products only.
    // A category the owner switched off takes its history with it: leaving the
    // archived row behind would put the very money he excluded back on the
    // month's invoice, under a name he said he does not want.
    const summaryRows = plan.summary.filter(
      (row) => row.include
        && summaryMonths.has(row.month)
        && (!row.categoryId || categoriesById.has(row.categoryId)),
    );
    const summaryProductIds = new Map();
    let summarySaleCount = 0;
    const summaryByMonth = new Map();
    for (const row of summaryRows) {
      const key = `${row.section}:${nameKey(row.label)}`;
      if (!summaryProductIds.has(key)) {
        const productId = `old-${sha256Hex(`${row.section}:${row.label}`).slice(0, 24)}`;
        const departmentId = row.categoryId && categoriesById.has(row.categoryId) ? row.categoryId : null;
        db.run(
          `INSERT INTO products (id, name, disposition, barcode, sale_price_minor, department_id,
                                 default_cost_minor, vat_rate_bp, status, created_by, updated_by,
                                 created_at, updated_at, brand_id, model, device_type, storage_gb,
                                 ram_gb, parent_id, variant_1, variant_2, variant_order, tracking)
           VALUES (?, ?, 'quantity', NULL, NULL, ?, NULL, NULL, 'archived', ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'none')`,
          [productId, summaryProductName(row), departmentId, ownerId, ownerId, stamp, stamp],
        );
        summaryProductIds.set(key, productId);
      }
      if (!summaryByMonth.has(row.month)) summaryByMonth.set(row.month, []);
      summaryByMonth.get(row.month).push({ ...row, productId: summaryProductIds.get(key) });
    }

    for (const [month, rows] of [...summaryByMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      summarySaleCount += 1;
      const occurredAt = new Date(`${lastDayOfMonth(month)}T23:00:00`).getTime() || stamp;
      const totalMinor = Math.round(rows.reduce((total, row) => total + row.total, 0) * 100);
      const costMinor = Math.round(rows.reduce((total, row) => total + row.cost, 0) * 100);
      const saleId = `old-sale-${month}`;
      db.run(
        `INSERT INTO sales (id, reference, occurred_at, sold_by, kind, reverses_sale_id,
                            total_minor, cost_total_minor, customer_id, customer_name_snapshot,
                            discount_minor, approved_by)
         VALUES (?, ?, ?, ?, 'sale', NULL, ?, ?, NULL, ?, 0, NULL)`,
        [saleId, `OLD-${month.replace('-', '')}-01`, occurredAt, ownerId, totalMinor, costMinor, `مبيعات ${month} (مجمّعة)`],
      );
      let lineNo = 0;
      for (const row of rows) {
        lineNo += 1;
        const lineTotal = Math.round(row.total * 100);
        const lineCost = Math.round(row.cost * 100);
        db.run(
          `INSERT INTO sale_lines (id, sale_id, line_no, product_id, product_name, disposition,
                                   quantity, unit_selling_price_minor, line_total_minor, unit_cost_minor,
                                   line_cost_minor, department_id, cost_method, warranty_start,
                                   warranty_end, unit_id, reverses_line_id, return_condition, discount_minor)
           VALUES (?, ?, ?, ?, ?, 'quantity', 1, ?, ?, ?, ?, ?, 'moving_average', NULL, NULL, NULL, NULL, NULL, 0)`,
          [
            `old-line-${month}-${lineNo}`,
            saleId,
            lineNo,
            row.productId,
            summaryProductName(row),
            lineTotal,
            lineTotal,
            lineCost,
            lineCost,
            row.categoryId && categoriesById.has(row.categoryId) ? row.categoryId : null,
          ],
        );
      }
      db.run(
        `INSERT INTO sale_payments (id, sale_id, payment_no, method, amount_minor, reference, occurred_at, wallet_id)
         VALUES (?, ?, 1, 'cash', ?, NULL, ?, NULL)`,
        [`old-pay-${month}`, saleId, totalMinor, occurredAt],
      );
    }

    // ── Repairs and software ────────────────────────────────────────────────
    const tickets = new Set();
    for (const repair of plan.repairs.filter((row) => row.include)) {
      let ticket = normalizeText(repair.ticketNo) || `OLD-${repair.id}`;
      if (tickets.has(ticket.toLowerCase())) {
        let suffix = 2;
        while (tickets.has(`${ticket}-${suffix}`.toLowerCase())) suffix += 1;
        ticket = `${ticket}-${suffix}`;
      }
      tickets.add(ticket.toLowerCase());
      const occurredAt = scheduleOf(repair) || stamp;
      const delivered = repair.delivered === true;
      db.run(
        `INSERT INTO repairs (id, ticket_no, service_kind, customer_name, customer_phone,
                              device_name, imei, device_lock, issue, accessories, due_label, status,
                              estimated_price_minor, final_price_minor, parts_cost_minor, deposit_minor,
                              pay_method, pay_wallet_id, technician_name, warranty_days, note,
                              created_by, created_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, '', ?, '', 'بكره', ?, ?, ?, ?, 0, 'cash', NULL, NULL, 0, ?, ?, ?, ?)`,
        [
          repair.id,
          ticket,
          repair.kind === 'software' ? 'software' : 'hardware',
          normalizeText(repair.customerName),
          normalizeText(repair.customerPhone),
          normalizeText(repair.deviceName) || 'جهاز',
          normalizeText(repair.issue) || 'صيانة',
          delivered ? 'delivered' : 'received',
          toMinor(repair.price) || 0,
          toMinor(repair.price) || 0,
          toMinor(repair.partsCost) || 0,
          normalizeText(repair.note).slice(0, 400),
          ownerId,
          occurredAt,
          delivered ? occurredAt : null,
        ],
      );
    }

    // ── Expenses ────────────────────────────────────────────────────────────
    // `paid_from = 'outside'` and no shift: the old drawer was never a shift, and
    // attaching history to a shift this device never opened would fail the
    // "a drawer expense needs an open shift" trigger for every row.
    for (const expense of plan.expenses.filter((row) => row.include && row.amount > 0)) {
      db.run(
        `INSERT INTO expenses (id, shift_id, paid_from, category, amount_minor, note, created_by, created_at)
         VALUES (?, NULL, 'outside', ?, ?, ?, ?, ?)`,
        [
          expense.id,
          normalizeText(expense.category) || 'مصاريف',
          toMinor(expense.amount),
          'ترحيل من السيستم القديم',
          ownerId,
          scheduleOf(expense) || stamp,
        ],
      );
    }

    // ── Wallets ─────────────────────────────────────────────────────────────
    // The five built-in rows exist already (migration `0024`), so they are
    // updated rather than re-inserted: a second row for the same pay method would
    // break the app's one-wallet-per-method rule.
    const builtInIds = new Set(['vf', 'et', 'or', 'we', 'ip']);
    let walletCount = 0;
    // A built-in wallet is seeded by the schema and cannot be deleted — the app
    // guarantees `vf` and `instapay` have somewhere to land. Switching one off
    // therefore hides it with its zero balance, so it stops showing up in the
    // payment chips instead of pretending to be a number the shop uses.
    for (const wallet of plan.wallets.filter((row) => !row.include && builtInIds.has(row.id))) {
      db.run('UPDATE wallets SET hidden = 1, number = \'\' WHERE id = ?', [wallet.id]);
    }
    for (const wallet of plan.wallets.filter((row) => row.include)) {
      walletCount += 1;
      const openingMinor = Math.max(0, toMinor(wallet.currentBalance) || 0);
      const name = normalizeText(wallet.name).slice(0, 80);
      const number = normalizeText(wallet.number).slice(0, 80);
      const limit = Math.max(0, toMinor(wallet.dailyLimit) || 0);
      if (builtInIds.has(wallet.id)) {
        db.run(
          `UPDATE wallets SET name = ?, number = ?, opening_balance_minor = ?, daily_limit_minor = ?
           WHERE id = ?`,
          [name, number, openingMinor, limit, wallet.id],
        );
      } else {
        const sort = 100 + walletCount;
        db.run(
          `INSERT INTO wallets (id, name, number, color, opening_balance_minor, min_alert_minor,
                                max_limit_minor, daily_limit_minor, pay_method, sort, hidden,
                                is_custom, created_at, company)
           VALUES (?, ?, ?, '#1d4f91', ?, 0, 0, ?, NULL, ?, 0, 1, ?, NULL)`,
          [wallet.id, name, number, openingMinor, limit, sort, stamp],
        );
      }
    }

    // ── Stock levels ────────────────────────────────────────────────────────
    for (const [productId, entry] of stockByProduct) {
      if (!productIds.has(productId)) continue;
      const quantity = Math.max(0, entry.quantity);
      db.run(
        `INSERT INTO stock_levels (product_id, quantity, total_cost_minor, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(product_id) DO UPDATE SET quantity = excluded.quantity,
           total_cost_minor = excluded.total_cost_minor, updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
        [productId, quantity, Math.max(0, Math.round(entry.cost)), ownerId, stamp],
      );
    }

    // ── Checks before the bytes leave this function ─────────────────────────
    const fk = db.exec('PRAGMA foreign_key_check;');
    if (fk.length && fk[0].values.length) {
      throw new Error(`foreign key check failed: ${JSON.stringify(fk[0].values.slice(0, 5))}`);
    }
    const integrity = db.exec('PRAGMA integrity_check;');
    const integrityValue = integrity?.[0]?.values?.[0]?.[0];
    if (integrityValue !== 'ok') {
      throw new Error(`integrity_check: ${integrityValue}`);
    }
    const negative = db.exec('SELECT COUNT(*) FROM stock_levels WHERE quantity < 0;')?.[0]?.values?.[0]?.[0];
    if (Number(negative) > 0) {
      throw new Error(`stock went negative in ${negative} rows`);
    }

    const bytes = db.export();
    return {
      bytes,
      stats: {
        categories: categoriesById.size,
        brands: brandsById.size,
        products: products.length,
        sales: saleStats.count,
        salesTotal: saleStats.total,
        summaryMonths: summaryByMonth.size,
        summarySales: summarySaleCount,
        repairs: tickets.size,
        expenses: plan.expenses.filter((row) => row.include && row.amount > 0).length,
        wallets: walletCount,
        units: unitCount,
        logoIncluded: Boolean(logoJpeg && logoJpeg.length),
      },
      warnings,
    };
  } finally {
    db.close();
  }
}

function idForOwner(plan) {
  // A real UUID: `users.id` is parsed as one (`find_open`), so a prefixed string
  // would make the app refuse its own owner row.
  return idFor(`owner:${plan.settings.shopName}`);
}

function uniqueUsername(db, preferred) {
  const clean = normalizeText(preferred).slice(0, 40) || 'owner';
  let candidate = clean;
  let suffix = 1;
  const exists = (value) => {
    const result = db.exec('SELECT 1 FROM user_credentials WHERE username = ? COLLATE NOCASE;', [value]);
    return Boolean(result.length && result[0].values.length);
  };
  while (exists(candidate)) {
    suffix += 1;
    candidate = `${clean}${suffix}`;
  }
  return candidate;
}

