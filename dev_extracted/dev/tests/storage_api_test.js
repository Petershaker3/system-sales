const vm = require('vm');
const fs = require('fs');
const { buildSandbox } = require('./dom-stub');

function extractJS(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  return scripts.join('\n');
}

function runCorruptionTest(jsCode, label) {
  const sandbox = buildSandbox();
  const ctx = vm.createContext(sandbox);
  vm.runInContext(jsCode, ctx);

  const results = {};
  const errors = [];
  function step(name, body) {
    try {
      results[name] = vm.runInContext(`(function(){\n${body}\n})();`, ctx, { filename: label+':'+name });
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }

  // Inject corrupted JSON directly into localStorage before the app touches it
  step('inject_corrupt_data', `
    localStorage.setItem('mshop_inventory', '{corrupt json!!!');
    localStorage.setItem('mshop_cfg', 'not even json');
    localStorage.setItem('mshop_d_2026-01-01', '{"acc":[}}}broken');
    return 'injected';
  `);

  step('load_with_corrupt_data_should_not_crash', `
    loadAll();
    loadData();
    return {inventoryIsArray: Array.isArray(inventory), cfgIsObject: typeof cfg === 'object'};
  `);

  step('health_check_detects_corruption', `
    // simulate what runHealthCheck does internally for the corrupt day key
    const r = Storage.tryGet('mshop_d_2026-01-01');
    return {corrupt: r.corrupt};
  `);

  step('calcTotals_still_works_after_corruption', `
    return calcTotals();
  `);

  step('missing_key_returns_fallback', `
    return {
      missingObj: Storage.get('mshop_totally_nonexistent_key_xyz', {ok:true}),
      missingArr: Storage.get('mshop_another_missing_key', []),
    };
  `);

  step('save_and_read_roundtrip', `
    Storage.save('mshop_test_roundtrip', {a:1,b:[1,2,3],c:'نص عربي'});
    return Storage.get('mshop_test_roundtrip');
  `);

  step('remove_then_exists', `
    Storage.save('mshop_temp_key', {x:1});
    const existedBefore = Storage.exists('mshop_temp_key');
    Storage.remove('mshop_temp_key');
    const existsAfter = Storage.exists('mshop_temp_key');
    return {existedBefore, existsAfter};
  `);

  step('search_prefix', `
    Storage.save('mshop_search_test_1', 1);
    Storage.save('mshop_search_test_2', 2);
    Storage.save('mshop_other_key', 3);
    const found = Storage.search('mshop_search_test_');
    return {count: found.length, keys: found.sort()};
  `);

  step('update_atomic', `
    Storage.save('mshop_counter_test', {count: 5});
    Storage.update('mshop_counter_test', (cur) => ({count: (cur?.count||0) + 1}));
    return Storage.get('mshop_counter_test');
  `);

  return { results, errors };
}

console.log('=== STORAGE API ERROR-HANDLING & CORRUPTION TEST ===\n');
const ORIG_JS = extractJS('/home/claude/work/app.html');
const PROD_JS = extractJS('/home/claude/dist/index.html');

console.log('--- Testing PRODUCTION (with Storage API) ---');
const prod = runCorruptionTest(PROD_JS, 'prod');
console.log('Errors:', prod.errors.length ? prod.errors : 'none (app never crashed on corrupt data ✅)');
console.log(JSON.stringify(prod.results, null, 2));

console.log('\n--- Sanity: does ORIGINAL also survive corrupt data? (baseline comparison) ---');
const orig = runCorruptionTest(ORIG_JS, 'orig');
console.log('Errors:', orig.errors.length ? orig.errors : 'none');
console.log('load_with_corrupt_data_should_not_crash:', JSON.stringify(orig.results.load_with_corrupt_data_should_not_crash));
