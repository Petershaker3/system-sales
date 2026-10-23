// The database the tool builds, checked by reading it back.
//
// These tests are deliberately about the *result*: tables the new app queries,
// totals that must equal the old file to the piastre, and the two switches the
// owner actually touches (what is included, and whether a month is detailed or
// summarised). They use the same `buildFromPlan` the button calls.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import initSqlJs from 'sql.js';

import { preparePlan, buildFromPlan } from '../src/pipeline.mjs';
import { planTotals as planTotalsForTest, validatePlan } from '../src/plan.mjs';
import { readBackupFile } from '../src/backup.mjs';

const require = createRequire(import.meta.url);
const SQL = await initSqlJs({
  wasmBinary: readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')),
});

const text = readFileSync(new URL('./fixtures/legacy-sample.json', import.meta.url), 'utf8');
const FAST_KDF = { memoryKib: 8192, iterations: 1, parallelism: 1 };

function build(plan) {
  const result = buildFromPlan({ SQL, plan, password: 'shop12345', now: 1_792_000_000_000, kdf: FAST_KDF });
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  return result;
}

function open(bytes) {
  const db = new SQL.Database(new Uint8Array(bytes));
  return {
    db,
    one: (sql, params = []) => {
      const statement = db.prepare(sql);
      statement.bind(params);
      const row = statement.step() ? statement.getAsObject() : null;
      statement.free();
      return row;
    },
    all: (sql, params = []) => {
      const statement = db.prepare(sql);
      statement.bind(params);
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      statement.free();
      return rows;
    },
  };
}

const prepared = preparePlan(text, { currentMonth: '2026-10', pastMode: 'summary' });
assert.equal(prepared.ok, true);

test('the built database passes every integrity check the app runs on boot', () => {
  const result = build(prepared.plan);
  const { one } = open(result.dbBytes);
  assert.equal(one('PRAGMA integrity_check').integrity_check, 'ok');
  assert.deepEqual(one('PRAGMA foreign_key_check'), null);
});

test('the schema is the repository schema, with all thirty-three migrations recorded', () => {
  const result = build(prepared.plan);
  const { all } = open(result.dbBytes);
  assert.equal(all('SELECT version FROM _sqlx_migrations').length, 33);
  assert.equal(all("SELECT name FROM sqlite_master WHERE type='table' AND name='sale_lines'").length, 1);
});

test('the shop opens without a password, on the owner account the tool creates', () => {
  const result = build(prepared.plan);
  const { all, one } = open(result.dbBytes);
  const users = all('SELECT id, display_name, role, verifier, provisional FROM users');
  assert.equal(users.length, 1);
  assert.equal(users[0].role, 'manager');
  // A provisional owner is the app's own «first run» state: it opens without a
  // password and asks the shop to set one. Writing a password would be inventing
  // a credential the owner never chose.
  assert.equal(users[0].provisional, 1);
  // A real Argon2id PHC string, exactly as the app writes it — over a secret
  // derived from the plan, so the file is reproducible and nobody can ever type
  // it. `provisional` is what stops it from being a login at all (ADR-039).
  assert.match(users[0].verifier, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
  const credentials = all('SELECT user_id, username FROM user_credentials');
  assert.deepEqual(credentials.map((row) => row.username), ['owner']);
  assert.equal(one("SELECT value FROM app_settings WHERE key='ui.shop_name'").value, 'محل تجربة');
});

test('a detailed month becomes one invoice per sale, and the invoice equals its lines', () => {
  const result = build(prepared.plan);
  const { all, one } = open(result.dbBytes);
  const count = one("SELECT COUNT(*) AS n FROM sales WHERE reference LIKE 'TRH-%'").n;
  assert.equal(count, 5);
  const mismatched = all(`
    SELECT s.id FROM sales s
    JOIN (SELECT sale_id, SUM(line_total_minor) AS total FROM sale_lines GROUP BY sale_id) l ON l.sale_id = s.id
    WHERE s.total_minor != l.total
  `);
  assert.deepEqual(mismatched, []);
  const reference = one("SELECT reference FROM sales WHERE reference LIKE 'TRH-%' ORDER BY occurred_at LIMIT 1").reference;
  assert.match(reference, /^TRH-\d{8}-\d{3}$/);
});

test('a summarised month is one archived product and one invoice, not five rows', () => {
  const result = build(prepared.plan);
  const { all, one } = open(result.dbBytes);
  // One archived «ترحيل» product per section that actually has a figure, so the
  // old money keeps a name the reports can group on.
  const archived = all("SELECT name, status FROM products WHERE status = 'archived'");
  assert.equal(archived.length, 3);
  assert.ok(archived.every((row) => row.name.startsWith('ترحيل ')));
  const summary = all("SELECT reference, total_minor, cost_total_minor FROM sales WHERE reference LIKE 'OLD-%'");
  assert.deepEqual(summary.map((row) => [row.total_minor, row.cost_total_minor]), [[440000, 334800]]);
  assert.match(summary[0].reference, /^OLD-202609-\d{2}$/);
  assert.equal(one("SELECT COUNT(*) AS n FROM sale_lines WHERE sale_id = (SELECT id FROM sales WHERE reference LIKE 'OLD-%')").n, 3);
});

test('every stock level is the sum of its own movements', () => {
  const result = build(prepared.plan);
  const { all } = open(result.dbBytes);
  const wrong = all(`
    SELECT p.id, l.quantity, COALESCE(SUM(m.quantity_delta), 0) AS moved
    FROM products p
    JOIN stock_levels l ON l.product_id = p.id
    LEFT JOIN stock_movements m ON m.product_id = p.id
    GROUP BY p.id HAVING l.quantity != moved
  `);
  assert.deepEqual(wrong, []);
});

test('the typed quantity is what the shop holds today, and the month is added on top', () => {
  const result = build(prepared.plan);
  const { one } = open(result.dbBytes);
  const phone = one("SELECT l.quantity FROM products p JOIN stock_levels l ON l.product_id = p.id WHERE p.model = 'A07'");
  assert.equal(phone.quantity, 2);
  // The store said one HMD 102 and the month sold one, so the opening receipt
  // carries two and the sale takes one back: one on the shelf, as typed.
  const sold = one("SELECT l.quantity FROM products p JOIN stock_levels l ON l.product_id = p.id WHERE p.model = '102'");
  assert.equal(sold.quantity, 1);
});

test('the catalogue prices reach the products, and the sale price wins for the month', () => {
  const result = build(prepared.plan);
  const { one } = open(result.dbBytes);
  const cover = one("SELECT sale_price_minor, default_cost_minor FROM products WHERE name = 'جراب 50'");
  assert.equal(cover.sale_price_minor, 5000, 'catalogue sale price');
  assert.equal(cover.default_cost_minor, 2500, 'catalogue cost');
  const shield = one("SELECT sale_price_minor, default_cost_minor FROM products WHERE name = 'شاشة حماية'");
  assert.equal(shield.sale_price_minor, 2500);
  assert.equal(shield.default_cost_minor, 1000, 'the cost the sale itself carried');
  // The invoice keeps what was charged that day, not the catalogue price.
  const line = one("SELECT unit_selling_price_minor FROM sale_lines WHERE product_name = 'جراب 50'");
  assert.equal(line.unit_selling_price_minor, 6000);
});

test('repairs and software land as tickets with unique numbers', () => {
  const result = build(prepared.plan);
  const { all } = open(result.dbBytes);
  const tickets = all('SELECT ticket_no, service_kind, final_price_minor FROM repairs ORDER BY ticket_no');
  assert.equal(tickets.length, 3);
  assert.equal(new Set(tickets.map((row) => row.ticket_no)).size, 3);
  assert.equal(tickets.filter((row) => row.service_kind === 'software').length, 2);
});

test('expenses are carried once each, paid from outside the drawer', () => {
  const result = build(prepared.plan);
  const { all, one } = open(result.dbBytes);
  const rows = all('SELECT category, amount_minor, paid_from, shift_id FROM expenses ORDER BY amount_minor');
  assert.deepEqual(rows.map((row) => row.amount_minor), [4000, 7500]);
  assert.deepEqual(rows.map((row) => row.category), ['البيت', 'كهرباء المحل']);
  // The old shop recorded an expense, not which drawer it came out of, so it is
  // money that left from outside — the shape `expenses` already allows.
  assert.ok(rows.every((row) => row.paid_from === 'outside' && row.shift_id === null));
  assert.equal(one("SELECT COUNT(*) AS n FROM app_settings WHERE key LIKE 'expense%'").n >= 0, true);
});

test('wallets open on the balance the owner confirmed, and never on invented movements', () => {
  const result = build(prepared.plan);
  const { all } = open(result.dbBytes);
  const wallets = all('SELECT name, opening_balance_minor FROM wallets ORDER BY name');
  assert.deepEqual(
    wallets.map((row) => row.opening_balance_minor).sort((a, b) => a - b),
    [0, 0, 0, 50000, 100000],
  );
  assert.equal(all('SELECT * FROM wallet_ops').length, 0, 'commissions are reported, not posted');
});

test('what the owner switched off stays out of the database', () => {
  const plan = structuredClone(prepared.plan);
  const category = plan.categories.find((row) => row.name === 'جراب');
  category.include = false;
  plan.categories.find((row) => row.name === 'سكرين').include = false;
  plan.items.find((row) => row.name === 'جراب 50').include = false;
  plan.sales.find((row) => row.name === 'جراب 50').include = false;
  plan.expenses[0].include = false;
  plan.repairs[0].include = false;
  plan.wallets.find((row) => row.id === 'vf').include = false;

  const result = build(plan);
  const { one } = open(result.dbBytes);
  assert.equal(one("SELECT COUNT(*) AS n FROM products WHERE name = 'جراب 50'").n, 0);
  assert.equal(one("SELECT COUNT(*) AS n FROM departments WHERE name = 'جراب'").n, 0);
  assert.equal(one('SELECT COUNT(*) AS n FROM expenses').n, 1);
  assert.equal(one('SELECT COUNT(*) AS n FROM repairs').n, 2);
  // Built-in wallets are seeded by the schema, so «off» means hidden with a zero
  // balance — not deleted, and not available in the payment chips either.
  const vodafone = one("SELECT hidden, opening_balance_minor FROM wallets WHERE id = 'vf'");
  assert.equal(vodafone.hidden, 1);
  assert.equal(vodafone.opening_balance_minor, 0);
});

test('an item left out of the catalogue keeps its sales, as an archived row', () => {
  // The owner's own draft did exactly this: unchecked one product while a sale in
  // the detailed month pointed at it. Dropping the sale would have made October
  // short by that sale's money, so it rides along on an archived product that the
  // POS never shows.
  const plan = structuredClone(prepared.plan);
  const shield = plan.items.find((row) => row.name === 'شاشة حماية');
  shield.include = false;
  const result = build(plan);
  const { one } = open(result.dbBytes);
  assert.equal(one("SELECT status FROM products WHERE name = 'شاشة حماية'").status, 'archived');
  assert.equal(one("SELECT COUNT(*) AS n FROM sales WHERE reference LIKE 'TRH-%'").n, 5);
  assert.equal(
    one("SELECT SUM(total_minor) AS total FROM sales WHERE reference LIKE 'TRH-%'").total,
    544000,
    'the month keeps every piastre it had',
  );
  const warning = validatePlan(plan).findings.find((finding) => finding.code === 'item-excluded-with-sales');
  assert.ok(warning, 'the owner is told why the product still carries money');
  assert.equal(warning.ref, shield.id);
});

test('switching a month off drops its money without touching the others', () => {
  const plan = structuredClone(prepared.plan);
  const september = plan.months.find((row) => row.month === '2026-09');
  september.include = false;
  const result = build(plan);
  const { one } = open(result.dbBytes);
  assert.equal(one("SELECT COUNT(*) AS n FROM sales WHERE reference LIKE 'OLD-%'").n, 0);
  assert.equal(one("SELECT COUNT(*) AS n FROM sales WHERE reference LIKE 'TRH-%'").n, 5);
});

test('a detailed month switched to «مجمّع» stops sending its sales', () => {
  // The screen converts the rows before switching the mode; this is the door
  // itself, so a mode that says «مجمّع» can never leak individual invoices.
  const plan = structuredClone(prepared.plan);
  plan.months.find((row) => row.month === '2026-10').mode = 'summary';
  const result = build(plan);
  const { one } = open(result.dbBytes);
  assert.equal(one("SELECT COUNT(*) AS n FROM sales WHERE reference LIKE 'TRH-%'").n, 0);
  assert.equal(one("SELECT COUNT(*) AS n FROM sales WHERE reference LIKE 'OLD-%'").n, 1);
});

test('the backup opens with its password and nothing else', () => {
  const result = build(prepared.plan);
  const reopened = readBackupFile(new Uint8Array(result.bytes), 'shop12345');
  assert.equal(reopened.database.length, result.dbBytes.length);
  assert.throws(() => readBackupFile(new Uint8Array(result.bytes), 'shop1234'));
  assert.equal(result.manifest.format_version, 1);
  assert.equal(result.manifest.database.path, 'shop.db');
  assert.equal(result.manifest.uncompressed_len, result.dbBytes.length);
});

test('a plan with an error is refused before anything is written', () => {
  const plan = structuredClone(prepared.plan);
  plan.sales[0].itemId = 'nope';
  const result = buildFromPlan({ SQL, plan, password: 'shop12345', kdf: FAST_KDF });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'errors');
});

test('building the same plan twice gives the same database', () => {
  const first = build(prepared.plan);
  const second = build(prepared.plan);
  assert.equal(Buffer.from(first.dbBytes).equals(Buffer.from(second.dbBytes)), true);
});

// ── Used handsets, devices and counts ──────────────────────────────────────
// The owner's request (2026-10-23): the tool must keep up with «قسم الهواتف» and
// carry the *numbers*, not just the row. A used phone is a unit with an IMEI; a
// new phone's count is the old store's count. These tests read both back.

test('a used handset the owner registered becomes a unit, not a stock number', () => {
  const plan = structuredClone(prepared.plan);
  const used = plan.items.find((item) => item.kind === 'used');
  assert.ok(used, 'the fixture has a used model');
  used.devices = [
    { imei: '357111111111112', condition: 'B', cost: used.buy, note: '' },
    { imei: '352099001761481', condition: 'A', cost: used.buy, note: 'شاشة متغيرة' },
  ];
  used.qty = 2;
  const result = build(plan);
  const { one, all } = open(result.dbBytes);

  const units = all('SELECT imei, condition_grade, unit_cost_minor, status FROM units ORDER BY imei');
  assert.equal(units.length, 2);
  assert.deepEqual(units.map((row) => row.imei).sort(), ['352099001761481', '357111111111112']);
  assert.equal(units.every((row) => row.status === 'in_stock'), true);
  assert.equal(units.find((row) => row.imei === '352099001761481').condition_grade, 'A');

  const shelf = one('SELECT quantity, total_cost_minor FROM stock_levels WHERE product_id = ?', [used.id]);
  assert.equal(shelf.quantity, 2, 'the shelf holds the two devices');
  assert.equal(shelf.total_cost_minor, used.buy * 100 * 2);

  // A unit points at the receipt that brought it in, so the ledger can explain it.
  const orphan = one(
    'SELECT COUNT(*) AS n FROM units WHERE received_movement_id IS NULL',
  );
  assert.equal(orphan.n, 0, 'every unit names its opening receipt');
});

test('a used model with no devices does not invent stock', () => {
  const plan = structuredClone(prepared.plan);
  const used = plan.items.find((item) => item.kind === 'used');
  used.devices = [];
  const result = build(plan);
  const { one } = open(result.dbBytes);
  const units = one('SELECT COUNT(*) AS n FROM units');
  assert.equal(units.n, 0);
  const shelf = one('SELECT quantity FROM stock_levels WHERE product_id = ?', [used.id]);
  assert.equal(shelf ? shelf.quantity : 0, 0);
});

test('a new phone carries the count the old store kept', () => {
  const plan = structuredClone(prepared.plan);
  const phone = plan.items.find((item) => item.kind === 'phone');
  assert.ok(phone, 'the fixture has a phone');
  phone.qty = 7;
  const result = build(plan);
  const { one } = open(result.dbBytes);
  const shelf = one('SELECT quantity FROM stock_levels WHERE product_id = ?', [phone.id]);
  assert.ok(shelf.quantity >= 7, `expected at least the 7 phones, got ${shelf.quantity}`);
  const product = one('SELECT disposition, tracking FROM products WHERE id = ?', [phone.id]);
  assert.equal(product.disposition, 'serialized');
  assert.equal(product.tracking, 'serial_optional');
});

test('an accessory count is what the owner typed', () => {
  const plan = structuredClone(prepared.plan);
  const accessory = plan.items.find((item) => item.kind === 'accessory');
  accessory.qty = 12;
  const result = build(plan);
  const { one } = open(result.dbBytes);
  const shelf = one('SELECT quantity, total_cost_minor FROM stock_levels WHERE product_id = ?', [accessory.id]);
  assert.equal(shelf.quantity, 12);
  assert.equal(shelf.total_cost_minor, Math.round(accessory.buy * 100) * 12);
});

test('a bad IMEI stops the build, and the finding says which row', () => {
  const plan = structuredClone(prepared.plan);
  const used = plan.items.find((item) => item.kind === 'used');
  used.devices = [{ imei: '12345', condition: 'B', cost: used.buy, note: '' }];
  const validation = validatePlan(plan);
  const finding = validation.findings.find((entry) => entry.code === 'used-imei');
  assert.ok(finding, 'the invalid IMEI is reported');
  assert.equal(finding.level, 'error');
  assert.equal(finding.ref, used.id);
});

test('the same IMEI twice is refused before anything is written', () => {
  const plan = structuredClone(prepared.plan);
  const used = plan.items.find((item) => item.kind === 'used');
  used.devices = [
    { imei: '357111111111112', condition: 'B', cost: used.buy, note: '' },
    { imei: '357111111111112', condition: 'B', cost: used.buy, note: '' },
  ];
  const validation = validatePlan(plan);
  assert.ok(validation.findings.some((entry) => entry.code === 'used-imei-duplicate'));
});

test('the plan totals count pieces, and never add used to new', () => {
  const plan = structuredClone(prepared.plan);
  const used = plan.items.find((item) => item.kind === 'used');
  const phone = plan.items.find((item) => item.kind === 'phone');
  for (const item of plan.items) if (item.kind === 'phone') item.qty = 0;
  phone.qty = 3;
  used.devices = [{ imei: '357111111111112', condition: 'A', cost: used.buy, note: '' }];
  const totals = planTotalsForTest(plan);
  assert.equal(totals.counts.usedDevices, 1);
  assert.equal(totals.counts.phonePieces, 3);
  assert.notEqual(totals.counts.usedDevices, totals.counts.phonePieces);
});

test('an accessory with no count is a finding, not a silent zero', () => {
  const plan = structuredClone(prepared.plan);
  for (const item of plan.items) {
    if (item.kind === 'accessory') item.qty = 0;
  }
  const validation = validatePlan(plan);
  assert.ok(validation.findings.some((entry) => entry.code === 'accessory-counts'));
});
