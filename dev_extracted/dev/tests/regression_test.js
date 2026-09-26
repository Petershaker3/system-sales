const vm = require('vm');
const fs = require('fs');
const { buildSandbox } = require('./dom-stub');

function extractJS(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  return scripts.join('\n');
}

function runScenario(jsCode, label) {
  const sandbox = buildSandbox();
  const context = vm.createContext(sandbox);
  const results = {};
  const errors = [];

  try {
    vm.runInContext(jsCode, context, { filename: label });
  } catch (e) {
    errors.push('LOAD ERROR: ' + e.message);
    return { results, errors, sandbox };
  }

  // Helper to safely run a snippet and capture result or error
  function step(name, code) {
    try {
      const val = vm.runInContext(code, context, { filename: label + ':' + name });
      results[name] = val;
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }

  // ── Scenario: fresh boot ──
  step('boot_loadAll', `loadAll(); loadData(); 'ok'`);
  step('initial_calcTotals', `JSON.stringify(calcTotals())`);

  // ── Scenario: add accessory transaction ──
  step('add_accessory', `
    data.acc.push({name:'كفر تجريبي', mainCat:'اكسسوار', buy:20, sell:50, profit:30, time:'10:00', qty:2});
    save();
    JSON.stringify(calcTotals())
  `);

  // ── Scenario: add cash wallet transaction + wallet balance ──
  step('wallet_setup', `
    loadWallets();
    walletOrder = ['فودافون كاش','اتصالات كاش'];
    walletOpening = {'فودافون كاش': 1000};
    walletLimits = {};
    data.cash.push({cashType:'ايداع', service:'فودافون كاش', amount:15, time:'10:05'});
    save();
    JSON.stringify({bal: getWalletBalance('فودافون كاش')})
  `);

  // ── Scenario: add phone to inventory + sell ──
  step('add_phone_inventory', `
    inventory.push({id:'ph_test1', brand:'Samsung', model:'A54', ram:'8GB', storage:'128GB',
      color:'أسود', internalCode:'', qty:5, buyPrice:8000, supplier:'مورد تجريبي',
      notes:'', addedDate: td(), lastBuyDate: td(), purchaseHistory:[]});
    saveInventory();
    JSON.stringify({qty: inventory.find(p=>p.id==='ph_test1').qty})
  `);
  step('sell_phone', `
    const ph = inventory.find(p=>p.id==='ph_test1');
    ph.qty -= 1;
    data.phones.push({modelId:'ph_test1', modelName: ph.brand+' '+ph.model, qty:1, sellPrice:9500, profit:1500, time:'10:10'});
    saveInventory(); save();
    JSON.stringify({qtyAfter: ph.qty, totals: calcTotals()})
  `);

  // ── Scenario: repair record ──
  step('add_repair', `
    data.repairs.push({id:'rep_test1', brand:'iPhone', model:'11', faultType:'كسر شاشة',
      servicePrice:500, profit:200, status:'inProgress', time:'10:15', clientName:'أحمد'});
    save();
    JSON.stringify(calcTotals())
  `);

  // ── Scenario: rollback a transaction ──
  step('rollback_accessory', `
    const before = JSON.parse(JSON.stringify(calcTotals()));
    data.acc[0]._rolled = true;
    save();
    const after = calcTotals();
    JSON.stringify({before, after})
  `);

  // ── Scenario: soft delete + trash restore ──
  step('softdel_and_trash', `
    const lenBefore = data.exp.length;
    data.exp.push({name:'مصروف تجريبي', amount:100, time:'10:20'});
    save();
    softDel('exp', data.exp.length-1);
    JSON.stringify({trashLen: trash.length, expLenAfter: data.exp.length})
  `);

  // ── Scenario: monthly totals aggregation ──
  step('month_totals', `
    typeof monthTotals === 'function' ? JSON.stringify(monthTotals(getMonthData(selMonth))) : 'monthTotals not directly testable (needs full month data context)'
  `);

  // ── Scenario: notes ──
  step('add_note', `
    notes.push({id:'n1', text:'ملاحظة تجريبية', type:'note', done:false, priority:2, time:ts(), date:td()});
    saveNotes();
    JSON.stringify({notesCount: notes.length})
  `);

  return { results, errors, sandbox };
}

const ORIG_JS = extractJS('/home/claude/work/app.html');
const PROD_JS = extractJS('/home/claude/dist/index.html');

console.log('=== Running scenario on ORIGINAL app.html ===');
const origRun = runScenario(ORIG_JS, 'original');
console.log('Errors:', origRun.errors.length ? origRun.errors : 'none');

console.log('\n=== Running scenario on PRODUCTION build (post-refactor) ===');
const prodRun = runScenario(PROD_JS, 'production');
console.log('Errors:', prodRun.errors.length ? prodRun.errors : 'none');

console.log('\n=== Comparing results step by step ===');
let allMatch = true;
const allKeys = new Set([...Object.keys(origRun.results), ...Object.keys(prodRun.results)]);
for (const key of allKeys) {
  const o = origRun.results[key];
  const p = prodRun.results[key];
  const match = JSON.stringify(o) === JSON.stringify(p);
  if (!match) allMatch = false;
  console.log(`${match ? '✅' : '❌'} ${key}${match ? '' : `\n   ORIG: ${JSON.stringify(o)}\n   PROD: ${JSON.stringify(p)}`}`);
}

console.log('\n=== FINAL VERDICT ===');
console.log('All scenario results identical:', allMatch);
console.log('Original load errors:', origRun.errors.length);
console.log('Production load errors:', prodRun.errors.length);
