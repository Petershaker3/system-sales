#!/usr/bin/env node
// 2026-11-02 22:13 — the three edits the owner asked for, applied to *his* file.
//
// The backup is the owner's own database (`backup-2026-11-02-2213.msb1`), not a
// rebuild: every sale he recorded today, every product he added and every shift
// stays exactly as the app wrote it. Only these rows change:
//
//   1. `Samsung A07 8GB/256GB` — cost 13,000 EGP. The phone had been opened with
//      cost 0, so «المخزن» showed a shelf worth nothing and a sale of it read as
//      pure profit. The unit on the shelf, the opening receipt and the stock
//      counter all carry the same cost, because the app derives the shelf value
//      from the counter and the phone's own cost from its unit.
//   2. Repairs and software that never left `received` — marked delivered on the
//      day they were received. They were handed over long ago; they only showed up
//      as pending because the old file never closed them.
//   3. `R-1001` (software, A15, 100 EGP, 2026-11-02 20:17) — deleted. It is a
//      duplicate of the software work already recorded in the old months, so the
//      صيانة/سوفتوير pages end up empty.
//
// Usage:
//   node scripts/owner-edits-2213.mjs <in.msb1> <out.msb1> --password <same>

import { readFileSync, writeFileSync } from 'node:fs';

import initSqlJs from 'sql.js';

import { buildBackupFile, readBackupFile } from '../src/backup.mjs';

const A07_COST_MINOR = 13_000 * 100;
const A07_ID = '84fd395f-6db3-7a28-851f-f802f8c92d6e'; // Samsung A07 8GB/256GB
const DUPLICATE_TICKET = 'R-1001';

const indexOf = (name) => process.argv.indexOf(name);
const input = process.argv[2];
const output = process.argv[3];
const password = indexOf('--password') > 0 ? process.argv[indexOf('--password') + 1] : null;
if (!input || !output || !password) {
  console.error('الاستخدام: node scripts/owner-edits-2213.mjs <in.msb1> <out.msb1> --password <كلمة السر>');
  process.exit(2);
}

const file = readBackupFile(new Uint8Array(readFileSync(input)), password);
const images = (file.images ?? []).map(([path, bytes]) => ({ path, bytes }));
const SQL = await initSqlJs({
  locateFile: (name) => new URL(`../node_modules/sql.js/dist/${name}`, import.meta.url).pathname,
});
const db = new SQL.Database(file.database);

const one = (sql, params = []) => {
  const statement = db.prepare(sql);
  statement.bind(params);
  const row = statement.step() ? statement.getAsObject() : null;
  statement.free();
  return row;
};
const all = (sql, params = []) => {
  const statement = db.prepare(sql);
  statement.bind(params);
  const rows = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
};

db.run('BEGIN');

// ── 1. The A07's cost ───────────────────────────────────────────────────────
const phone = one('SELECT id, name, default_cost_minor FROM products WHERE id = ?', [A07_ID]);
if (!phone) throw new Error('الصنف مش موجود في النسخة');
db.run('UPDATE products SET default_cost_minor = ? WHERE id = ?', [A07_COST_MINOR, A07_ID]);

// The shelf: the counter and its money move together, or the average cost the app
// computes is a number nobody can explain.
const position = one('SELECT quantity, total_cost_minor FROM stock_levels WHERE product_id = ?', [A07_ID]);
if (position && Number(position.quantity) > 0) {
  db.run('UPDATE stock_levels SET total_cost_minor = ? WHERE product_id = ?', [
    A07_COST_MINOR * Number(position.quantity),
    A07_ID,
  ]);
}
// The handsets on the shelf carry their own cost; `هواتف` reads them, not the counter.
db.run("UPDATE units SET unit_cost_minor = ? WHERE product_id = ? AND status = 'in_stock'", [A07_COST_MINOR, A07_ID]);

// The opening receipt is what the shelf counted as its cost: `stock_movements` is
// append-only, so its triggers come off for this one correction and go straight back.
const triggers = all("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'stock_movements'");
for (const trigger of triggers) db.run(`DROP TRIGGER IF EXISTS ${trigger.name}`);
db.run(
  `UPDATE stock_movements
      SET unit_cost_minor = ?, cost_delta_minor = ? * ABS(quantity_delta)
    WHERE product_id = ? AND kind = 'receipt' AND receipt_kind = 'opening'`,
  [A07_COST_MINOR, A07_COST_MINOR, A07_ID],
);
for (const trigger of triggers) if (trigger.sql) db.run(trigger.sql);

// ── 2. Work that was handed over, closed on the day it came in ──────────────
const openRepairs = all("SELECT id, ticket_no, created_at FROM repairs WHERE status = 'received'");
for (const repair of openRepairs) {
  // `delivered_at >= created_at` is a constraint; the day it was received is the
  // honest one, and it keeps the money in the month it was earned.
  db.run("UPDATE repairs SET status = 'delivered', delivered_at = created_at WHERE id = ?", [repair.id]);
}

// ── 3. The duplicate software ticket ────────────────────────────────────────
const duplicate = one('SELECT id FROM repairs WHERE ticket_no = ?', [DUPLICATE_TICKET]);
if (duplicate) db.run('DELETE FROM repairs WHERE id = ?', [duplicate.id]);

db.run('COMMIT');

const violations = db.exec('PRAGMA foreign_key_check')[0]?.values ?? [];
if (violations.length > 0) throw new Error(`النسخة فيها ${violations.length} مرجع مكسور`);
const integrity = db.exec('PRAGMA integrity_check')[0]?.values?.[0]?.[0];
if (integrity !== 'ok') throw new Error(`integrity_check: ${integrity}`);

db.run('VACUUM');
const dbBytes = db.export();
const built = buildBackupFile({ dbBytes, password, images, createdAt: Date.now() });
writeFileSync(output, Buffer.from(built.bytes));

const check = one('SELECT p.default_cost_minor, s.quantity, s.total_cost_minor FROM products p LEFT JOIN stock_levels s ON s.product_id = p.id WHERE p.id = ?', [A07_ID]);
console.log(`A07: cost ${check.default_cost_minor} · على الرف ${check.quantity} · قيمة ${check.total_cost_minor}`);
console.log(`صيانة/سوفتوير مقفولة: ${openRepairs.length}`);
console.log(`R-1001: ${duplicate ? 'اتشالت' : 'مش موجودة'}`);
console.log(`صيانة/سوفتوير لسه مفتوحة: ${one("SELECT COUNT(*) AS n FROM repairs WHERE status NOT IN ('delivered','cancelled')").n}`);
console.log(`الفواتير زي ما هي: ${one('SELECT COUNT(*) AS n FROM sales').n} · الأصناف ${one('SELECT COUNT(*) AS n FROM products').n}`);
console.log(`database ${dbBytes.length} bytes → ${output}`);
