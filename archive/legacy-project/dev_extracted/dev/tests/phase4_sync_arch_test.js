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
  let networkCallMade = false;
  sandbox.fetch = async (...args) => { networkCallMade = true; throw new Error('network should never be called'); };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(PROD_JS, ctx);
  vm.runInContext('loadAll(); loadData();', ctx);

  const results = {};
  const errors = [];
  function step(name, body) {
    try { results[name] = vm.runInContext(`(function(){\n${body}\n})();`, ctx, { filename: name }); }
    catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  async function astep(name, body) {
    try { results[name] = await vm.runInContext(`(async function(){\n${body}\n})()`, ctx, { filename: name }); }
    catch (e) { errors.push(`${name}: ${e.message}`); }
  }

  // ── 1) Modules exist with expected interfaces ──
  step('modules_exist', `
    return {
      syncManager: typeof SyncManager === 'object',
      syncQueue: typeof SyncQueue === 'object',
      syncState: typeof SyncState === 'object',
      conflictResolver: typeof SyncConflictResolver === 'object',
      providerInterface: typeof SyncProviderInterface === 'object',
    };
  `);

  // ── 2) SyncManager is disabled by default; sync is fully offline ──
  step('sync_disabled_by_default', `
    return { enabled: SyncManager.enabled, provider: SyncManager.provider, connectionStatus: SyncState.get().connectionStatus };
  `);

  // ── 3) Hooks are no-ops when disabled (don't enqueue anything) ──
  step('hooks_are_noop_when_disabled', `
    SyncQueue.clear();
    SyncManager.afterSave('phone', 'ph1', {test:1});
    SyncManager.afterUpdate('phone', 'ph1', {test:2});
    SyncManager.afterDelete('phone', 'ph1');
    return { queueLength: SyncQueue.list().length };
  `);

  // ── 4) Queue works correctly when manually exercised (architecture validation) ──
  step('queue_enqueue_and_metadata_shape', `
    SyncQueue.clear();
    const entry = SyncQueue.enqueue({operationType:'create', entityType:'phone', entityId:'ph1', payload:{brand:'Samsung'}});
    return {
      hasOperationId: typeof entry.operationId === 'string' && entry.operationId.length > 10,
      hasOperationType: entry.operationType === 'create',
      hasEntityType: entry.entityType === 'phone',
      hasEntityId: entry.entityId === 'ph1',
      hasCreatedAt: !!entry.createdAt,
      hasUpdatedAt: !!entry.updatedAt,
      hasDeviceId: !!entry.deviceId,
      hasSyncGeneration: entry.syncGeneration === 0,
      hasPayload: entry.payload.brand === 'Samsung',
      hasStatus: entry.status === 'Pending',
    };
  `);

  step('queue_status_transitions', `
    SyncQueue.clear();
    const entry = SyncQueue.enqueue({operationType:'update', entityType:'repair', entityId:'r1', payload:null});
    SyncQueue.updateStatus(entry.operationId, SyncQueue.STATUS.PROCESSING);
    const afterProcessing = SyncQueue.list().find(e=>e.operationId===entry.operationId);
    SyncQueue.updateStatus(entry.operationId, SyncQueue.STATUS.SYNCED);
    const afterSynced = SyncQueue.list().find(e=>e.operationId===entry.operationId);
    return { processingStatus: afterProcessing.status, syncedStatus: afterSynced.status };
  `);

  step('queue_persists_across_reload', `
    SyncQueue.clear();
    SyncQueue.enqueue({operationType:'create', entityType:'accessory', entityId:'a1', payload:null});
    const raw = Storage.get('mshop_sync_queue');
    return { persistedToStorage: Array.isArray(raw) && raw.length === 1 };
  `);

  step('queue_remove_and_clear', `
    SyncQueue.clear();
    const e1 = SyncQueue.enqueue({operationType:'create', entityType:'x', entityId:'1', payload:null});
    SyncQueue.enqueue({operationType:'create', entityType:'x', entityId:'2', payload:null});
    SyncQueue.removeById(e1.operationId);
    const afterRemove = SyncQueue.list().length;
    SyncQueue.clear();
    const afterClear = SyncQueue.list().length;
    return { afterRemove, afterClear };
  `);

  // ── 5) SyncState round-trip ──
  step('sync_state_get_set_reset', `
    SyncState.reset();
    const before = SyncState.get();
    SyncState.set({lastError:'test error', syncGeneration:5});
    const after = SyncState.get();
    SyncState.reset();
    const afterReset = SyncState.get();
    return {
      beforeGenZero: before.syncGeneration === 0,
      afterHasError: after.lastError === 'test error',
      afterGenUpdated: after.syncGeneration === 5,
      resetClearsError: afterReset.lastError === null,
      resetGenBackToZero: afterReset.syncGeneration === 0,
    };
  `);

  // ── 6) Conflict resolver: architecture only, always "no conflict" ──
  step('conflict_resolver_placeholders', `
    const detect1 = SyncConflictResolver.detectConflict({id:1}, null);
    const detect2 = SyncConflictResolver.detectConflict({id:1}, {id:1, updatedAt:'x'});
    const resolve = SyncConflictResolver.resolveConflict({id:1,v:'local'}, {id:1,v:'remote'});
    const merge = SyncConflictResolver.mergeChanges({id:1}, {a:1}, {b:2});
    return {
      detect1NoConflict: detect1.hasConflict === false,
      detect2NoConflict: detect2.hasConflict === false,
      resolveReturnsLocal: resolve.resolved.v === 'local',
      resolveMarkedUnimplemented: resolve.implemented === false,
      mergeAppliesLocal: merge.a === 1,
      mergeMarkedUnimplemented: merge.implemented === false,
    };
  `);

  // ── 7) Provider interface: all methods throw (no real provider) ──
  await astep('provider_interface_all_throw', `
    const outcomes = {};
    try { await SyncProviderInterface.connect({}); outcomes.connect = 'DID NOT THROW'; } catch(e) { outcomes.connect = 'threw'; }
    try { await SyncProviderInterface.uploadBatch([]); outcomes.upload = 'DID NOT THROW'; } catch(e) { outcomes.upload = 'threw'; }
    try { await SyncProviderInterface.downloadChanges(0); outcomes.download = 'DID NOT THROW'; } catch(e) { outcomes.download = 'threw'; }
    try { await SyncProviderInterface.disconnect(); outcomes.disconnect = 'DID NOT THROW'; } catch(e) { outcomes.disconnect = 'threw'; }
    return outcomes;
  `);

  // ── 8) SyncManager.syncNow refuses to run (no provider, disabled) ──
  await astep('sync_now_refuses_without_provider', `
    const result = await SyncManager.syncNow();
    return { ok: result.ok, reason: result.reason };
  `);

  // ── 9) Zero network calls made throughout ANY of the above ──
  step('zero_network_calls', `return { networkCallMade: globalThis.__networkCallMade || false };`);

  return { results, errors, networkCallMade };
}

run().then(({results, errors, networkCallMade}) => {
  console.log('=== PHASE 4 — SYNC PREPARATION ARCHITECTURE TEST ===\n');
  console.log('Errors:', errors.length ? errors : 'none');
  console.log('\n--- Results ---');
  for (const [name, val] of Object.entries(results)) console.log(`${name}:`, JSON.stringify(val));
  console.log('\nAny fetch/network call made during entire test run:', networkCallMade);

  console.log('\n--- Verdicts ---');
  const m = results.modules_exist || {};
  console.log('1. All 5 modules exist:', Object.values(m).every(v=>v===true));
  console.log('2. Sync disabled by default, offline status:', results.sync_disabled_by_default?.enabled===false && results.sync_disabled_by_default?.provider===null && results.sync_disabled_by_default?.connectionStatus==='offline');
  console.log('3. Hooks are no-ops while disabled (zero queue growth):', results.hooks_are_noop_when_disabled?.queueLength === 0);
  const qm = results.queue_enqueue_and_metadata_shape || {};
  console.log('4a. Queue entry has full required metadata shape:', Object.values(qm).every(v=>v===true));
  console.log('4b. Status transitions work correctly:', results.queue_status_transitions?.processingStatus==='Processing' && results.queue_status_transitions?.syncedStatus==='Synced');
  console.log('4c. Queue persists to Storage (survives reload):', results.queue_persists_across_reload?.persistedToStorage === true);
  console.log('4d. Remove/clear operations work:', results.queue_remove_and_clear?.afterRemove===1 && results.queue_remove_and_clear?.afterClear===0);
  const ss = results.sync_state_get_set_reset || {};
  console.log('5. SyncState get/set/reset round-trip correctly:', Object.values(ss).every(v=>v===true));
  const cr = results.conflict_resolver_placeholders || {};
  console.log('6. Conflict resolver: pure placeholders, always no-conflict:', Object.values(cr).every(v=>v===true));
  const pi = results.provider_interface_all_throw || {};
  console.log('7. Provider interface: every method throws (no real provider):', Object.values(pi).every(v=>v==='threw'));
  console.log('8. syncNow() refuses to run without provider/enabled:', results.sync_now_refuses_without_provider?.ok === false);
  console.log('9. Zero network calls throughout entire test:', networkCallMade === false);
}).catch(e => { console.error('FATAL:', e); process.exit(1); });
