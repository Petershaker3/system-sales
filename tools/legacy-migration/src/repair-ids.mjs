// Give every row an id the app can parse, and carry every reference with it.
//
// The app reads row ids as UUIDs (`Uuid::parse_str`). A prefixed id — `item-…`,
// `cat-…`, `sale-…`, `mv-…`, `unit-…` — is rejected at the door, and the row looks
// perfectly fine in a listing while being impossible to sell, return or refund.
// The 2026-11-02 delivery shipped 4,000+ of them.
//
// This runs over a finished database: it finds every id that is not a UUID, gives
// it a new one derived from the old, and rewrites every column that pointed at it
// (the schema's own foreign keys, plus the self-references below). New ids are
// derived rather than random, so the same input always yields the same file.

import { idFor, isUuid } from './util.mjs';

// Ids the app itself defines as short, human keys — never rewritten.
const KEEP = new Set(['wallets', 'expense_categories', 'app_settings', 'schema_migrations']);

/**
 * @param db an sql.js `Database`, already open.
 * @returns {{ids:number, references:number, tables:string[]}}
 */
export function repairIds(db) {
  const tables = (db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")[0]?.values ?? [])
    .map(([name]) => name)
    .filter((name) => !KEEP.has(name));

  const columnsOf = (table) => (db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? []).map((row) => row[1]);
  const foreignKeys = (table) => (db.exec(`PRAGMA foreign_key_list(${table})`)[0]?.values ?? [])
    .map((row) => ({ from: row[3], table: row[2], to: row[4] }));

  // Every table's remap, before anything is touched, so a reference can always be
  // resolved against the table it points at.
  const maps = new Map();
  let ids = 0;
  for (const table of tables) {
    const columns = columnsOf(table);
    if (!columns.includes('id')) continue;
    const map = new Map();
    for (const [id] of db.exec(`SELECT id FROM ${table}`)[0]?.values ?? []) {
      if (id === null || id === undefined || id === '') continue;
      if (isUuid(String(id))) continue;
      map.set(String(id), idFor(`${table}:${id}`));
    }
    if (map.size > 0) {
      maps.set(table, map);
      ids += map.size;
    }
  }
  if (maps.size === 0) return { ids: 0, references: 0, tables: [] };

  // Triggers guard append-only tables (`sales`, `stock_movements`); the rewrite is
  // deliberate, and the same triggers go back afterwards.
  const triggers = db.exec("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")[0]?.values ?? [];
  for (const [name] of triggers) db.run(`DROP TRIGGER IF EXISTS ${name}`);
  db.run('PRAGMA foreign_keys = OFF');

  let references = 0;
  const apply = (table, column, map) => {
    if (!column || !map || map.size === 0) return;
    if (!columnsOf(table).includes(column)) return;
    db.run(`CREATE TEMP TABLE IF NOT EXISTS _map (old TEXT PRIMARY KEY, new TEXT)`);
    db.run('DELETE FROM _map');
    const insert = db.prepare('INSERT INTO _map (old, new) VALUES (?, ?)');
    for (const [oldId, newId] of map) {
      insert.run([oldId, newId]);
    }
    insert.free();
    db.run(`UPDATE ${table} SET ${column} = (SELECT new FROM _map WHERE old = ${table}.${column})
            WHERE ${column} IN (SELECT old FROM _map)`);
    references += db.getRowsModified();
  };

  for (const [table, map] of maps) apply(table, 'id', map);
  for (const table of tables) {
    for (const fk of foreignKeys(table)) {
      const map = maps.get(fk.table);
      if (map) apply(table, fk.from, map);
    }
  }
  // References the schema does not declare as foreign keys.
  apply('sale_lines', 'unit_id', maps.get('units'));
  apply('damaged_stock', 'unit_id', maps.get('units'));
  apply('product_price_history', 'actor_id', maps.get('users'));

  db.run('DROP TABLE IF EXISTS _map');
  for (const [, sql] of triggers) {
    if (sql) db.run(sql);
  }

  const violations = db.exec('PRAGMA foreign_key_check')[0]?.values ?? [];
  if (violations.length > 0) {
    throw new Error(`repair left ${violations.length} broken reference(s)`);
  }

  return { ids, references, tables: [...maps.keys()].sort() };
}
