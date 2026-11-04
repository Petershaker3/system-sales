#!/usr/bin/env node
// Repair a delivered/restored `.msb1` in place, without rebuilding it from a draft.
//
// Two faults from the 2026-11-02 delivery are fixed here, because both make a
// correct-looking product unreachable in the app:
//
//   1. **Ids that are not UUIDs.** Rows the owner added inside the tool were given
//      prefixed ids (`item-…`, `cat-…`). The app parses product, category and brand
//      ids as UUIDs, so `record_sale` refuses them (`SALE_INVALID_PRODUCT_ID`) and a
//      department is refused the same way. 191 products in the delivered file had
//      them — including the «وصلة» that could not be sold.
//   2. **Phones stored as `serialized`.** The app's own phones are `quantity` with
//      `tracking = 'serial_optional'`, and the sale path accepts nothing else.
//
// Every reference is carried: a product's department, a sale line's product, the
// stock counter, the units and the movements. The file keeps its password.
//
// Usage:
//   node scripts/repair-backup.mjs <in.msb1> <out.msb1> --password <the same password>

import { readFileSync, writeFileSync } from 'node:fs';

import initSqlJs from 'sql.js';

import { buildBackupFile, readBackupFile } from '../src/backup.mjs';
import { repairIds } from '../src/repair-ids.mjs';
import { archiveEmptyProducts } from '../src/cleanup.mjs';

function argValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const [, , input, output] = process.argv;
const password = argValue(process.argv, '--password');
if (!input || !output || !password) {
  console.error('الاستخدام: node scripts/repair-backup.mjs <in.msb1> <out.msb1> --password <كلمة السر>');
  process.exit(2);
}

const file = readBackupFile(new Uint8Array(readFileSync(input)), password);
const images = (file.images ?? []).map(([path, bytes]) => ({ path, bytes }));
const SQL = await initSqlJs({
  locateFile: (name) => new URL(`../node_modules/sql.js/dist/${name}`, import.meta.url).pathname,
});
const db = new SQL.Database(file.database);
// `stock_movements` and `sales` are append-only by trigger; the repair is the one
// deliberate rewrite, and it runs with the triggers off inside this process only.
db.run('PRAGMA foreign_keys = OFF');

const result = repairIds(db);
const archived = archiveEmptyProducts(db);

// Phones: the app's own shape. `tracking` keeps them devices the screens count.
let phones = 0;
const tableNames = new Set((db.exec("SELECT name FROM sqlite_master WHERE type = 'table'")[0]?.values ?? []).map(([name]) => name));
if (tableNames.has('products')) {
  // `serialized` is the old way of writing a phone: it was also `tracking = 'none'`,
  // so moving the disposition alone would file every phone under accessories.
  db.run("UPDATE products SET tracking = 'serial_optional' WHERE disposition = 'serialized' AND (tracking IS NULL OR tracking = 'none')");
  phones += db.getRowsModified();
  db.run("UPDATE products SET disposition = 'quantity' WHERE disposition = 'serialized'");
  phones += db.getRowsModified();
  // A historical line is `serialized` only because its product was; the product
  // is `quantity` now, and a return reads the line.
  db.run("UPDATE sale_lines SET disposition = 'quantity' WHERE disposition = 'serialized'");
  phones += db.getRowsModified();
}

// A rewrite can leave the file inconsistent if a trigger came back wrong: the
// foreign-key check is the cheapest proof that it did not.
const violations = db.exec('PRAGMA foreign_key_check')[0]?.values ?? [];
if (violations.length > 0) {
  console.error(`الملف فيه ${violations.length} مرجع مكسور — متكتبش الملف.`);
  process.exit(1);
}

db.run('VACUUM');
const dbBytes = db.export();
const built = buildBackupFile({
  dbBytes,
  password,
  images,
  createdAt: Date.now(),
});
writeFileSync(output, Buffer.from(built.bytes));

console.log(`ids repaired: ${result.ids}`);
console.log(`references moved: ${result.references}`);
console.log(`tables: ${result.tables.join(', ')}`);
console.log(`phones made sellable: ${phones}`);
console.log(`empty placeholder products archived: ${archived}`);
console.log(`database: ${dbBytes.length} bytes → ${output}`);
