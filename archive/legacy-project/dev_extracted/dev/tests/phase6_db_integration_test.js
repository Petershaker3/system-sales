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
  const ctx = vm.createContext(sandbox);
  vm.runInContext(PROD_JS, ctx);
  vm.runInContext('loadAll(); loadData();', ctx);

  const results = {};
  const errors = [];
  async function astep(name, body) {
    try { results[name] = await vm.runInContext(`(async function(){\n${body}\n})()`, ctx, { filename: name }); }
    catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  function step(name, body) {
    try { results[name] = vm.runInContext(`(function(){\n${body}\n})();`, ctx, { filename: name }); }
    catch (e) { errors.push(`${name}: ${e.message}`); }
  }

  step('provider_registry', `
    return {
      activeName: DatabaseProviderRegistry.getActiveName(),
      activeIsLocalAdapter: DatabaseProviderRegistry.getActive() instanceof LocalAdapter,
      activeIsDatabaseAdapter: DatabaseProviderRegistry.getActive() instanceof DatabaseAdapter,
    };
  `);

  await astep('phone_repo_create_delegates_to_storage', `
    const repo = new PhoneRepository();
    const before = Storage.get('mshop_inventory', []).length;
    const created = await repo.create({brand:'TestBrand', model:'TestModel', qty:5, buyPrice:1000});
    const afterInStorage = Storage.get('mshop_inventory', []);
    return {
      hasGeneratedId: !!created.id,
      storageGrew: afterInStorage.length === before + 1,
      storageHasRecord: afterInStorage.some(p => p.id === created.id && p.brand === 'TestBrand'),
    };
  `);

  await astep('phone_repo_read_update_delete_roundtrip', `
    const repo = new PhoneRepository();
    const created = await repo.create({brand:'RoundtripBrand', model:'X1', qty:3});
    const read = await repo.findById(created.id);
    const updated = await repo.update(created.id, {qty: 99});
    const readAfterUpdate = await repo.findById(created.id);
    await repo.delete(created.id);
    let deletedConfirmed = false;
    try { await repo.findById(created.id); } catch(e) { deletedConfirmed = e.code === 'NOT_FOUND'; }
    return {
      readMatchesCreated: read.brand === 'RoundtripBrand',
      updateApplied: updated.qty === 99,
      readAfterUpdateReflectsChange: readAfterUpdate.qty === 99,
      deleteRemovedFromStorage: deletedConfirmed,
    };
  `);

  await astep('phone_repo_find_all_with_filter', `
    const repo = new PhoneRepository();
    await repo.create({brand:'FilterTest', model:'A', qty:1});
    await repo.create({brand:'FilterTest', model:'B', qty:2});
    await repo.create({brand:'Other', model:'C', qty:3});
    const filtered = await repo.findAll(p => p.brand === 'FilterTest');
    return { filteredCount: filtered.length, allMatch: filtered.every(p=>p.brand==='FilterTest') };
  `);

  await astep('note_repo_full_crud', `
    const repo = new NoteRepository();
    const created = await repo.create({title:'Test Note', content:'x', type:'note', priority:1});
    const inStorage = Storage.get('mshop_notes', []);
    const found = inStorage.some(n => n.id === created.id);
    await repo.update(created.id, {title:'Updated'});
    const afterUpdate = await repo.findById(created.id);
    await repo.delete(created.id);
    return { createdInStorage: found, updateWorked: afterUpdate.title==='Updated' };
  `);

  await astep('not_found_error_normalized', `
    const repo = new PhoneRepository();
    let caught = null;
    try { await repo.findById('nonexistent-id-xyz'); } catch(e) { caught = e; }
    return {
      isDatabaseError: caught instanceof DatabaseError,
      hasNormalizedCode: caught.code === 'NOT_FOUND',
      hasMessage: !!caught.message,
    };
  `);

  step('unsupported_entity_type_rejected', `
    const adapter = DatabaseProviderRegistry.getActive();
    let caught = null;
    try { adapter._getCollectionConfig('some_unknown_entity'); } catch(e) { caught = e; }
    return { rejected: caught instanceof DatabaseError, code: caught?.code };
  `);

  await astep('repair_repo_read_works_writes_rejected', `
    const repo = new RepairRepository();
    let readErr = null, createErr = null;
    let readResult = null;
    try { readResult = await repo.findAll(); } catch(e) { readErr = e; }
    try { await repo.create({}); } catch(e) { createErr = e; }
    return {
      readSucceeded: Array.isArray(readResult),
      createProperlyRejected: createErr instanceof DatabaseError && createErr.code === 'NOT_IMPLEMENTED',
    };
  `);

  await astep('wallet_repo_reflects_real_config', `
    loadWallets();
    walletOrder = ['فودافون كاش', 'اتصالات كاش'];
    walletOpening = {'فودافون كاش': 500};
    walletLimits = {};
    const repo = new WalletRepository();
    const all = await repo.findAll();
    const found = await repo.findById('فودافون كاش');
    return {
      countMatches: all.length === 2,
      openingMatches: found.opening === 500,
    };
  `);

  await astep('zero_side_effects_on_unrelated_state', `
    const beforeData = JSON.stringify(data);
    const beforeCfg = JSON.stringify(cfg);
    const repo = new PhoneRepository();
    await repo.create({brand:'IsolationTest', model:'Y'});
    const afterData = JSON.stringify(data);
    const afterCfg = JSON.stringify(cfg);
    return { dataUntouched: beforeData === afterData, cfgUntouched: beforeCfg === afterCfg };
  `);

  await astep('existing_phones_js_logic_unaffected', `
    const beforeCount = inventory.length;
    inventory.push({id:'ph_manual', brand:'Manual', model:'Z', ram:'8GB', storage:'128GB', color:'', internalCode:'', qty:1, buyPrice:100, supplier:'', notes:'', addedDate:td(), lastBuyDate:td(), purchaseHistory:[]});
    saveInventory();
    const afterCount = inventory.length;
    const repo = new PhoneRepository();
    const viaRepo = await repo.findAll(p => p.id === 'ph_manual');
    return {
      inventoryGrew: afterCount === beforeCount + 1,
      repositorySeesSameData: viaRepo.length === 1 && viaRepo[0].brand === 'Manual',
    };
  `);

  return { results, errors };
}

run().then(({results, errors}) => {
  console.log('=== PHASE 6 — DATABASE INTEGRATION LAYER VALIDATION ===\n');
  console.log('Errors:', errors.length ? errors : 'none');
  console.log('\n--- Results ---');
  for (const [name, val] of Object.entries(results)) console.log(`${name}:`, JSON.stringify(val));

  console.log('\n--- Verdicts ---');
  const p1 = results.provider_registry || {};
  console.log('1. Local Adapter is the sole active, registered provider:', p1.activeIsLocalAdapter && p1.activeIsDatabaseAdapter && p1.activeName==='local');
  const p2 = results.phone_repo_create_delegates_to_storage || {};
  console.log('2. PhoneRepository.create() genuinely delegates to Storage API:', p2.hasGeneratedId && p2.storageGrew && p2.storageHasRecord);
  const p3 = results.phone_repo_read_update_delete_roundtrip || {};
  console.log('3. Full CRUD roundtrip (read/update/delete) works correctly:', Object.values(p3).every(v=>v===true));
  console.log('4. findAll() filtering works correctly:', results.phone_repo_find_all_with_filter?.filteredCount===2 && results.phone_repo_find_all_with_filter?.allMatch);
  console.log('5. NoteRepository (different collection) works with same generic pattern:', results.note_repo_full_crud?.createdInStorage && results.note_repo_full_crud?.updateWorked);
  const p6 = results.not_found_error_normalized || {};
  console.log('6. Errors are normalized DatabaseError instances with proper codes:', p6.isDatabaseError && p6.hasNormalizedCode && p6.hasMessage);
  console.log('7. Unsupported entity types clearly rejected (not silently wrong):', results.unsupported_entity_type_rejected?.rejected && results.unsupported_entity_type_rejected?.code==='UNSUPPORTED_OPERATION');
  console.log('8. RepairRepository: honest partial support (read works, write clearly rejected):', results.repair_repo_read_works_writes_rejected?.readSucceeded && results.repair_repo_read_works_writes_rejected?.createProperlyRejected);
  console.log('9. WalletRepository reflects real wallet configuration:', results.wallet_repo_reflects_real_config?.countMatches && results.wallet_repo_reflects_real_config?.openingMatches);
  console.log('10. CRITICAL — zero side effects on unrelated app state (data/cfg):', results.zero_side_effects_on_unrelated_state?.dataUntouched && results.zero_side_effects_on_unrelated_state?.cfgUntouched);
  console.log('11. Existing phones.js logic (saveInventory) still works, AND repository sees same underlying data:', results.existing_phones_js_logic_unaffected?.inventoryGrew && results.existing_phones_js_logic_unaffected?.repositorySeesSameData);
}).catch(e => { console.error('FATAL:', e); process.exit(1); });
