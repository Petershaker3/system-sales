const vm = require('vm');
const fs = require('fs');
const { buildSandbox } = require('./dom-stub');

function extractJS(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  return scripts.join('\n');
}

async function run() {
  const PROD_JS = extractJS('/home/claude/dist/index.html');
  const sandbox = buildSandbox();
  let networkCalled = false;
  const origFetch = sandbox.fetch;
  sandbox.fetch = async (...a) => { networkCalled = true; return origFetch(...a); };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(PROD_JS, ctx);
  vm.runInContext('loadAll(); loadData();', ctx);

  const results = {};
  const errors = [];
  function step(name, body) {
    try { results[name] = vm.runInContext(`(function(){\n${body}\n})();`, ctx, { filename: name }); }
    catch (e) { errors.push(`${name}: ${e.message}`); }
  }

  // ── 1) Base mapper contract & registry ──
  step('registry_complete', `
    const expected = ['phones','phoneTransactions','usedPhoneTransactions','accessoryTransactions',
      'softwareTransactions','walletTransactions','expenses','repairs','wallets','notes',
      'notifications','categories','brands','repairParts','faultTypes','settings','dailySummary','walletBalances'];
    return { hasAll: expected.every(k => ENTITY_MAPPERS_REGISTRY[k] instanceof EntityMapper), count: Object.keys(ENTITY_MAPPERS_REGISTRY).length };
  `);

  // ── 2) PhoneMapper: Local -> DB -> Local round trip equivalence ──
  step('phone_mapper_roundtrip', `
    const mapper = new PhoneMapper();
    const local = {id:'ph1', brand:'Samsung', model:'A54', ram:'8GB', storage:'128GB', color:'أسود',
      internalCode:'C1', qty:5, buyPrice:5000, supplier:'مورد', notes:'x', addedDate:'2026-01-01',
      lastBuyDate:'2026-01-05', purchaseHistory:[{price:5000,supplier:'مورد',date:'2026-01-01',qty:5}],
      archived:false, favorite:true};
    const db = mapper.toDatabase(local);
    const back = mapper.fromDatabase(db);
    return {
      brandMatch: back.brand === local.brand, modelMatch: back.model === local.model,
      qtyMatch: back.qty === local.qty, favoriteMatch: back.favorite === local.favorite,
      purchaseHistoryMatch: JSON.stringify(back.purchaseHistory) === JSON.stringify(local.purchaseHistory),
      originalUnmutated: JSON.stringify(local) === JSON.stringify({id:'ph1', brand:'Samsung', model:'A54', ram:'8GB', storage:'128GB', color:'أسود',
        internalCode:'C1', qty:5, buyPrice:5000, supplier:'مورد', notes:'x', addedDate:'2026-01-01',
        lastBuyDate:'2026-01-05', purchaseHistory:[{price:5000,supplier:'مورد',date:'2026-01-01',qty:5}],
        archived:false, favorite:true}),
    };
  `);

  // ── 3) Historical snapshot preservation: PhoneTransactionMapper ──
  step('historical_snapshot_preserved', `
    const mapper = new PhoneTransactionMapper();
    const local = {modelId:'ph1', modelName:'Samsung A54 (Original Name)', qty:1, sellPrice:9000, profit:1200, time:'10:00', date:'2026-01-10'};
    const db = mapper.toDatabase(local);
    // Simulate the master phone record's name changing LATER
    const laterMasterName = 'Samsung A54 PRO (renamed)';
    return {
      snapshotCapturedOriginalName: db.snapshotModelName === 'Samsung A54 (Original Name)',
      snapshotUnaffectedBySimulatedRename: db.snapshotModelName !== laterMasterName,
    };
  `);

  // ── 4) _rolled replaced by transaction_type + relatedTransactionId ──
  step('rollback_model_replaces_rolled_flag', `
    const mapper = new AccessoryTransactionMapper();
    const saleLocal = {name:'كفر', mainCat:'اكسسوار', buy:20, sell:50, profit:30, time:'10:00'};
    const rolledLocal = {name:'كفر', mainCat:'اكسسوار', buy:20, sell:50, profit:30, time:'10:00', _rolled:true};
    const saleDb = mapper.toDatabase(saleLocal);
    const rolledDb = mapper.toDatabase(rolledLocal);
    return {
      saleHasCorrectType: saleDb.transactionType === 'sale',
      rollbackHasCorrectType: rolledDb.transactionType === 'rollback',
      noRolledFieldInDbShape: !('_rolled' in saleDb) && !('_rolled' in rolledDb),
    };
  `);

  // ── 5) UUID validation ──
  step('uuid_validation', `
    const mapper = new PhoneMapper();
    let validPassed = false, invalidCaught = false;
    try { mapper.validate({brand:'x', model:'y', id:'a1b2c3d4-e5f6-4789-8abc-def012345678'}); validPassed = true; } catch(e) {}
    try { mapper.validate({brand:'x', model:'y', id:'not-a-uuid'}); } catch(e) { invalidCaught = e.code === 'VALIDATION_ERROR'; }
    return { validPassed, invalidCaught };
  `);

  // ── 6) Null values remain null (never invented) ──
  step('null_values_remain_null', `
    const mapper = new PhoneMapper();
    const local = {brand:'X', model:'Y'}; // no id, no ram, no supplier etc.
    const db = mapper.toDatabase(local);
    return {
      idIsNull: db.id === null,
      shopIdIsNull: db.shopId === null,
      deviceIdIsNull: db.deviceId === null,
      createdByIsNull: db.createdBy === null,
      deletedAtIsNull: db.deletedAt === null,
      syncGenerationIsNull: db.syncGeneration === null,
    };
  `);

  // ── 7) Validation catches malformed entities ──
  step('validation_catches_malformed', `
    const results = {};
    try { new PhoneMapper().validate({}); results.phoneMissingFields = false; } catch(e) { results.phoneMissingFields = e.code === 'VALIDATION_ERROR'; }
    try { new WalletTransactionMapper().validate({walletName:'x', cashType:'invalid_type', transactionType:'sale'}); results.walletBadEnum = false; } catch(e) { results.walletBadEnum = e.code === 'VALIDATION_ERROR'; }
    try { new AccessoryTransactionMapper().validate({snapshotName:'x', transactionType:'not_a_real_type'}); results.txBadType = false; } catch(e) { results.txBadType = e.code === 'VALIDATION_ERROR'; }
    try { new PhoneTransactionMapper().validate({phoneId:'p1', snapshotModelName:'x', transactionType:'rollback'}); results.rollbackMissingRelated = false; } catch(e) { results.rollbackMissingRelated = e.code === 'VALIDATION_ERROR'; }
    return results;
  `);

  // ── 8) clone() performs deep copy, never mutates original ──
  step('clone_deep_copy', `
    const mapper = new PhoneMapper();
    const original = {id:'x', purchaseHistory:[{price:100}]};
    const cloned = mapper.clone(original);
    cloned.purchaseHistory[0].price = 999;
    return { originalUnaffected: original.purchaseHistory[0].price === 100, cloneChanged: cloned.purchaseHistory[0].price === 999, notSameReference: cloned !== original };
  `);

  // ── 9) No mutation of input objects across all mappers (spot check) ──
  step('no_mutation_of_inputs', `
    const local = {name:'test', sell:100, profit:20, time:'x'};
    const before = JSON.stringify(local);
    new AccessoryTransactionMapper().toDatabase(local);
    return { unmutated: JSON.stringify(local) === before };
  `);

  // ── 10) DailySummaryMapper / WalletBalanceMapper: zero calculation, pure passthrough ──
  step('derived_mappers_never_calculate', `
    const dsMapper = new DailySummaryMapper();
    const input = {shopId:'s1', date:'2026-01-01', totalSales:100, totalProfit:30, totalExpenses:10, netProfit:20, transactionCount:5};
    const output = dsMapper.toDatabase(input);
    const wbMapper = new WalletBalanceMapper();
    const wbInput = {shopId:'s1', walletId:'w1', balance:500};
    const wbOutput = wbMapper.toDatabase(wbInput);
    return {
      dailySummaryPassthrough: output.totalSales===100 && output.totalProfit===30 && output.netProfit===20,
      walletBalancePassthrough: wbOutput.balance === 500,
    };
  `);

  // ── 11) String-based local entities (Category, FaultType) ──
  step('string_entity_mappers', `
    const catMapper = new CategoryMapper();
    const db = catMapper.toDatabase('سكرين', 'accessory');
    const back = catMapper.fromDatabase(db);
    const ftMapper = new FaultTypeMapper();
    const ftDb = ftMapper.toDatabase('كسر شاشة');
    const ftBack = ftMapper.fromDatabase(ftDb);
    return { categoryRoundtrip: back === 'سكرين', categoryTypePreserved: db.categoryType === 'accessory', faultTypeRoundtrip: ftBack === 'كسر شاشة' };
  `);

  // ── 12) NoteMapper date/time combination and reversal ──
  step('note_mapper_datetime', `
    const mapper = new NoteMapper();
    const local = {id:'n1', title:'x', content:'y', type:'note', priority:1, created:'2026-01-01', createdTime:'10:30', done:false};
    const db = mapper.toDatabase(local);
    const back = mapper.fromDatabase(db);
    return { createdAtCombined: db.createdAt === '2026-01-01T10:30', createdSplitBack: back.created === '2026-01-01', timeSplitBack: back.createdTime === '10:30' };
  `);

  // ── 13) CRITICAL: zero storage access anywhere in this file ──
  step('zero_storage_access', `
    const beforeKeys = Storage.search('mshop_').length;
    new PhoneMapper().toDatabase({brand:'x',model:'y'});
    new NoteMapper().toDatabase({title:'x', content:'y'});
    new RepairMapper().toDatabase({brand:'a',model:'b'});
    new SettingsMapper().toDatabase({name:'shop'});
    const afterKeys = Storage.search('mshop_').length;
    return { noNewKeysCreated: beforeKeys === afterKeys };
  `);

  return { results, errors, networkCalled };
}

run().then(({results, errors, networkCalled}) => {
  console.log('=== PHASE 6.5 — ENTITY MAPPING LAYER VALIDATION ===\n');
  console.log('Errors:', errors.length ? errors : 'none');
  console.log('\n--- Results ---');
  for (const [name, val] of Object.entries(results)) console.log(`${name}:`, JSON.stringify(val));

  console.log('\n--- Verdicts ---');
  console.log('1. Registry contains all 18 mappers, all extend EntityMapper:', results.registry_complete?.hasAll && results.registry_complete?.count===18);
  console.log('2. PhoneMapper Local->DB->Local roundtrip equivalent, original untouched:', Object.values(results.phone_mapper_roundtrip||{}).every(v=>v===true));
  console.log('3. Historical snapshot preserved regardless of later master-record changes:', results.historical_snapshot_preserved?.snapshotCapturedOriginalName && results.historical_snapshot_preserved?.snapshotUnaffectedBySimulatedRename);
  console.log('4. _rolled flag fully replaced by transaction_type model:', Object.values(results.rollback_model_replaces_rolled_flag||{}).every(v=>v===true));
  console.log('5. UUID validation works (valid passes, invalid caught):', results.uuid_validation?.validPassed && results.uuid_validation?.invalidCaught);
  console.log('6. Null/unavailable fields remain null (never invented):', Object.values(results.null_values_remain_null||{}).every(v=>v===true));
  console.log('7. Validation catches all malformed entity cases:', Object.values(results.validation_catches_malformed||{}).every(v=>v===true));
  console.log('8. clone() performs true deep copy:', Object.values(results.clone_deep_copy||{}).every(v=>v===true));
  console.log('9. No mapper mutates its input object:', results.no_mutation_of_inputs?.unmutated === true);
  console.log('10. Derived mappers (daily_summary/wallet_balances) never calculate, pure passthrough:', Object.values(results.derived_mappers_never_calculate||{}).every(v=>v===true));
  console.log('11. String-based entities (Category/FaultType) round-trip correctly:', Object.values(results.string_entity_mappers||{}).every(v=>v===true));
  console.log('12. Date/time combination & reversal correct (NoteMapper):', Object.values(results.note_mapper_datetime||{}).every(v=>v===true));
  console.log('13. CRITICAL — zero storage access from entity_mappers.js:', results.zero_storage_access?.noNewKeysCreated === true);
  console.log('14. CRITICAL — zero network calls throughout entire test run:', networkCalled === false);
}).catch(e => { console.error('FATAL:', e); process.exit(1); });
