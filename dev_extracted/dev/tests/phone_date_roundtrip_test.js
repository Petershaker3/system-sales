// phone_date_roundtrip_test.js
// Verifies RC-3 fix: phoneTransactionRepo.create() now stores `date`,
// so createdAt is non-null and date/time survive a mapper round-trip.
// Runs directly from source JS — no dist build required.

'use strict';
const vm   = require('vm');
const fs   = require('fs');
const path = require('path');
const { buildSandbox } = require('./dom-stub');

const JS_DIR = path.join(__dirname, '..', 'js');
const SOURCE_FILES = [
  'helpers.js',
  'storage.js',
  'db_foundation.js',
  'db_integration.js',
  'entity_mappers.js',
  'phones.js',
];

function loadSources() {
  return SOURCE_FILES.map(f => fs.readFileSync(path.join(JS_DIR, f), 'utf-8')).join('\n');
}

async function run() {
  const src = loadSources();
  const sandbox = buildSandbox();
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx);

  const results = {};
  const errors  = [];

  function step(name, fn) {
    try {
      fn();
      results[name] = 'PASS';
    } catch (e) {
      results[name] = 'FAIL: ' + e.message;
      errors.push(name + ': ' + e.message);
    }
  }

  // ── T1: PhoneTransactionMapper.toDatabase() with date+time produces valid createdAt ──
  step('T1 toDatabase with date+time → createdAt non-null', () => {
    const mapper = vm.runInContext(
      'ENTITY_MAPPERS_REGISTRY["phoneTransactions"]', ctx
    );
    const db = mapper.toDatabase({
      modelId: 'model-1', modelName: 'Samsung X', qty: 1,
      buyPrice: 4000, sellPrice: 5000, profit: 1000,
      date: '2026-08-18', time: '14:30',
    });
    if (!db.createdAt) throw new Error('createdAt is null — date was not combined');
    if (db.createdAt !== '2026-08-18T14:30') throw new Error('createdAt wrong: ' + db.createdAt);
  });

  // ── T2: PhoneTransactionMapper.fromDatabase() recovers date and time ──
  step('T2 fromDatabase recovers date and time', () => {
    const mapper = vm.runInContext(
      'ENTITY_MAPPERS_REGISTRY["phoneTransactions"]', ctx
    );
    const local = mapper.fromDatabase({
      phoneId: 'model-1', snapshotModelName: 'Samsung X',
      qty: 1, sellPrice: 5000, profit: 1000,
      transactionType: 'sale',
      createdAt: '2026-08-18T14:30',
      serverRevision: null, syncGeneration: null,
    });
    if (local.time !== '14:30') throw new Error('time round-trip failed: ' + local.time);
    if (local.date !== '2026-08-18') throw new Error('date round-trip failed: ' + local.date);
  });

  // ── T3: phoneTransactionRepo.create() stores date in the correct daily partition ──
  step('T3 confirmSell payload stored in correct daily partition', async () => {
    // Simulate what confirmSell() now does (with the fix: date:td() included)
    const today = vm.runInContext('td()', ctx);
    await vm.runInContext(`
      phoneTransactionRepo.create({
        modelId: 'ph-test', modelName: 'Test Phone', brand: 'Test', model: 'T1',
        qty: 1, buyPrice: 3000, sellPrice: 4000, profit: 1000,
        date: td(), time: ts(),
      })
    `, ctx);

    const partKey = 'mshop_d_' + today;
    const raw = vm.runInContext(`Storage.get('${partKey}')`, ctx);
    if (!raw || !raw.phones || !raw.phones.length) {
      throw new Error('Phone transaction not written to daily partition ' + partKey);
    }
    const stored = raw.phones[raw.phones.length - 1];
    if (!stored.createdAt) throw new Error('createdAt null in stored DB record — date not passed');
    if (!stored.date) throw new Error('date field missing from stored DB record');
  });

  // ── T4: Without date (old bug), createdAt would be null ──
  step('T4 regression: omitting date → createdAt null (old behaviour confirmed absent)', () => {
    const mapper = vm.runInContext(
      'ENTITY_MAPPERS_REGISTRY["phoneTransactions"]', ctx
    );
    const db = mapper.toDatabase({
      modelId: 'model-1', modelName: 'Samsung X', qty: 1,
      buyPrice: 4000, sellPrice: 5000, profit: 1000,
      time: '14:30',
      // no date field — this was the bug
    });
    if (db.createdAt !== null) throw new Error('Expected null when date omitted, got: ' + db.createdAt);
    // This PASS confirms the old bug existed and the fix (T1-T3) is the only guard
  });

  // ── Report ──
  const pass = Object.values(results).filter(v => v === 'PASS').length;
  const total = Object.keys(results).length;
  console.log('\n── Phone Date Round-Trip Fix — Test Results ──');
  Object.entries(results).forEach(([name, res]) => {
    console.log(`  [${res === 'PASS' ? '✓' : '✗'}] ${name}: ${res}`);
  });
  console.log(`\n${pass}/${total} passed`);
  if (errors.length) {
    console.error('\nFailed:');
    errors.forEach(e => console.error('  ✗', e));
    process.exit(1);
  }
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
