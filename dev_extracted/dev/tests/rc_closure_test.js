'use strict';
// rc_closure_test.js — Tests for RC-1, RC-2, RC-3 after Phase 24 integration.

const vm   = require('vm');
const fs   = require('fs');
const path = require('path');
const { buildSandbox } = require('./dom-stub');

const JS_DIR = path.join(__dirname, '..', 'js');
const SOURCE_ORDER = [
  'helpers.js', 'storage.js', 'db_foundation.js',
  'db_integration.js', 'entity_mappers.js', 'sync.js', 'phones.js',
];

function loadSources() {
  return SOURCE_ORDER.map(f => {
    const p = path.join(JS_DIR, f);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : `/* MISSING: ${f} */`;
  }).join('\n');
}

// ── Sandbox: render stubs + tracking globals (accessible inside VM as plain names) ──
const sandbox = buildSandbox();
// These become globals inside the VM context
sandbox._trackLoadAll      = false;
sandbox._trackLoadData     = false;
sandbox._trackRenderAll    = false;
sandbox._trackRenderInv    = false;
sandbox.renderAll          = () => { sandbox._trackRenderAll = true; };
sandbox.renderInvWidget    = () => { sandbox._trackRenderInv  = true; };

const ctx = vm.createContext(sandbox);
vm.runInContext(loadSources(), ctx);

// Patch loadAll/loadData AFTER source load — references plain globals accessible in VM
vm.runInContext(`
  (function(){
    const _origLA = loadAll, _origLD = loadData;
    loadAll  = function(){ _trackLoadAll  = true; try{_origLA(); }catch(e){} };
    loadData = function(){ _trackLoadData = true; try{_origLD();}catch(e){} };
  })();
`, ctx);

function resetFlags() {
  sandbox._trackLoadAll = sandbox._trackLoadData =
  sandbox._trackRenderAll = sandbox._trackRenderInv = false;
  vm.runInContext('_trackLoadAll = _trackLoadData = _trackRenderAll = _trackRenderInv = false;', ctx);
}

// ── Test harness ──
const results = {};
const errors  = [];

async function step(id, fn) {
  try { await fn(); results[id] = 'PASS'; }
  catch(e) { results[id] = 'FAIL: ' + e.message; errors.push(id + ': ' + e.message); }
}

// ── Sync primitives for VM async calls ──
async function vmAsync(code) {
  const p = vm.runInContext(`(async()=>{${code}})()`, ctx);
  return p; // Node awaits cross-realm thenables
}

async function run() {

  // ════ RC-1 — Auto-poll ════

  await step('RC1-T1', () => {
    const ok = vm.runInContext(
      'typeof SyncManager !== "undefined" && typeof SyncManager.startAutoSync === "function"', ctx);
    if (!ok) throw new Error('SyncManager.startAutoSync not a function');
  });

  await step('RC1-T2', () => {
    const src  = fs.readFileSync(path.join(JS_DIR, 'sync_auth.js'), 'utf-8');
    const eIdx = src.indexOf('SyncManager.enabled = true');
    const aIdx = src.indexOf('SyncManager.startAutoSync()');
    if (eIdx === -1) throw new Error('enabled=true not found in sync_auth.js');
    if (aIdx === -1) throw new Error('startAutoSync() not found in sync_auth.js');
    if (aIdx < eIdx)  throw new Error('startAutoSync() appears BEFORE enabled=true');
  });

  await step('RC1-T3', () => {
    vm.runInContext('SyncManager.stopAutoSync(); SyncManager.startAutoSync(60000);', ctx);
    const timer = vm.runInContext('SyncManager._autoSyncTimer !== null', ctx);
    const lstnr = vm.runInContext('SyncManager._onlineListener !== null', ctx);
    vm.runInContext('SyncManager.stopAutoSync();', ctx);
    if (!timer) throw new Error('_autoSyncTimer null after startAutoSync');
    if (!lstnr) throw new Error('_onlineListener null after startAutoSync');
  });

  await step('RC1-T4', () => {
    vm.runInContext('SyncManager.startAutoSync(60000); SyncManager.startAutoSync(60000);', ctx);
    const ok = vm.runInContext('SyncManager._autoSyncTimer !== null', ctx);
    vm.runInContext('SyncManager.stopAutoSync();', ctx);
    if (!ok) throw new Error('No timer after double startAutoSync');
  });

  // ════ RC-2 — UI refresh ════

  await step('RC2-T1', () => {
    if (!vm.runInContext('typeof SyncManager.syncNow === "function"', ctx))
      throw new Error('syncNow not a function');
  });

  await step('RC2-T2', async () => {
    resetFlags();
    vm.runInContext('SyncState.reset();', ctx);

    // Payload is LOCAL shape — same as what SyncQueue stores from the originating device
    await vmAsync(`
      SyncManager.init({
        uploadBatch:      async()=>({ok:true,results:[]}),
        downloadChanges:  async()=>({ok:true, changes:[{
          entityType:'phoneTransactions', entityId:'rc2-test-id',
          payload:{modelId:'model-rc2',modelName:'RC2 Phone',brand:'RC2',model:'T1',
                   qty:1,buyPrice:3000,sellPrice:4000,profit:1000,date:'2026-08-18',time:'10:00'},
          deleted:false, clientTimestamp:'2026-08-18T10:00:00Z', serverRevision:1
        }], nextCursor:1, hasMore:false}),
        downloadSnapshot: async()=>({ok:true,records:[],snapshotRevision:0,hasMore:false}),
        disconnect:       async()=>({ok:true}),
      }, 'owner-rc2');
      SyncManager.enabled = true;
      const r = await SyncManager.syncNow();
      if(!r.ok)       throw new Error('syncNow failed: '+r.error);
      if(r.applied<1) throw new Error('applied='+r.applied+' expected>=1, failed='+r.failed);
    `);

    if (!vm.runInContext('_trackLoadAll',  ctx)) throw new Error('loadAll() not called');
    if (!vm.runInContext('_trackLoadData', ctx)) throw new Error('loadData() not called');
    if (!vm.runInContext('_trackRenderAll',ctx)) throw new Error('renderAll() not called');
  });

  await step('RC2-T3', async () => {
    resetFlags();
    vm.runInContext('SyncState.reset();', ctx);
    await vmAsync(`
      SyncManager.init({
        uploadBatch:      async()=>({ok:true,results:[]}),
        downloadChanges:  async()=>({ok:true,changes:[],nextCursor:0,hasMore:false}),
        downloadSnapshot: async()=>({ok:true,records:[],snapshotRevision:0,hasMore:false}),
        disconnect:       async()=>({ok:true}),
      }, 'owner-no-changes');
      SyncManager.enabled = true;
      await SyncManager.syncNow();
    `);
    if (vm.runInContext('_trackRenderAll', ctx)) throw new Error('renderAll() called when applied===0');
    if (vm.runInContext('_trackLoadAll',   ctx)) throw new Error('loadAll() called when applied===0');
  });

  // ════ RC-3 — Transaction date/time ════

  await step('RC3-T1', () => {
    const mapper = vm.runInContext('ENTITY_MAPPERS_REGISTRY["phoneTransactions"]', ctx);
    const db = mapper.toDatabase({
      modelId:'m1', modelName:'Test', qty:1, buyPrice:3000, sellPrice:4000, profit:1000,
      date:'2026-08-18', time:'14:30',
    });
    if (!db.createdAt) throw new Error('createdAt null');
    if (db.createdAt !== '2026-08-18T14:30') throw new Error('createdAt wrong: ' + db.createdAt);
  });

  await step('RC3-T2', () => {
    const mapper = vm.runInContext('ENTITY_MAPPERS_REGISTRY["phoneTransactions"]', ctx);
    const local = mapper.fromDatabase({
      phoneId:'m1', snapshotModelName:'Test', qty:1, sellPrice:4000, profit:1000,
      transactionType:'sale', createdAt:'2026-08-18T14:30', serverRevision:null, syncGeneration:null,
    });
    if (local.time !== '14:30')      throw new Error('time wrong: ' + local.time);
    if (local.date !== '2026-08-18') throw new Error('date wrong: ' + local.date);
  });

  await step('RC3-T3', async () => {
    const today = vm.runInContext('td()', ctx);
    await vmAsync(`
      phoneTransactionRepo.create({
        modelId:'ph-rc3', modelName:'RC3 Phone', brand:'X', model:'Y',
        qty:1, buyPrice:2000, sellPrice:3000, profit:1000, date:td(), time:ts(),
      });`);
    const raw = vm.runInContext(`Storage.get('mshop_d_${today}')`, ctx);
    if (!raw?.phones?.length) throw new Error('No phones in daily partition');
    const last = raw.phones[raw.phones.length - 1];
    if (!last.createdAt) throw new Error('createdAt null — date not passed to mapper');
  });

  await step('RC3-T4', () => {
    const mapper = vm.runInContext('ENTITY_MAPPERS_REGISTRY["phoneTransactions"]', ctx);
    const db = mapper.toDatabase({
      modelId:'m1', modelName:'T', qty:1, buyPrice:0, sellPrice:0, profit:0, time:'10:00',
    });
    if (db.createdAt !== null) throw new Error('Expected null when date omitted, got: ' + db.createdAt);
  });

  // ── Report ──
  const GROUPS = {
    'RC-1 Auto-poll':          ['RC1-T1','RC1-T2','RC1-T3','RC1-T4'],
    'RC-2 UI refresh':         ['RC2-T1','RC2-T2','RC2-T3'],
    'RC-3 date/time':          ['RC3-T1','RC3-T2','RC3-T3','RC3-T4'],
  };
  const pass  = Object.values(results).filter(v => v === 'PASS').length;
  const total = Object.keys(results).length;

  console.log('\n══ RC Closure Tests — Phase 24 Integration ══');
  for (const [group, ids] of Object.entries(GROUPS)) {
    console.log('\n── ' + group + ' ──');
    ids.forEach(k => console.log(`  [${results[k]==='PASS'?'✓':'✗'}] ${k}: ${results[k]}`));
  }
  console.log(`\n${pass}/${total} passed`);
  if (errors.length) {
    console.error('\nFailed:'); errors.forEach(e => console.error('  ✗', e)); process.exit(1);
  }
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
