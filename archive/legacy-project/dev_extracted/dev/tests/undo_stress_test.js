const vm = require('vm');
const fs = require('fs');
const { buildSandbox } = require('./dom-stub');

function extractJS(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  return scripts.join('\n');
}

function iife(body) {
  return `(function(){\n${body}\n})();`;
}

function runStressCycle(jsCode, label) {
  const sandbox = buildSandbox();
  const ctx = vm.createContext(sandbox);
  vm.runInContext(jsCode, ctx);
  vm.runInContext('loadAll(); loadData();', ctx);

  const log = [];
  const errors = [];

  function step(name, body) {
    try {
      const val = vm.runInContext(iife(body), ctx, { filename: label + ':' + name });
      log.push({ name, val });
      return val;
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
      log.push({ name, error: e.message });
      return undefined;
    }
  }

  step('seed_phone', `
    inventory.push({id:'ph_u1', brand:'براند', model:'موديل', ram:'8GB', storage:'128GB',
      color:'', internalCode:'', qty:10, buyPrice:5000, supplier:'مورد', notes:'',
      addedDate:td(), lastBuyDate:td(), purchaseHistory:[]});
    saveInventory();
    return {qty: inventory[0].qty};
  `);

  for (let i = 0; i < 20; i++) {
    step(`cycle${i}_add_acc`, `
      data.acc.push({name:'دورة${i}', mainCat:'اكسسوار', buy:10, sell:30, profit:20, time:ts()});
      save();
      return {len: data.acc.length};
    `);
    step(`cycle${i}_edit_acc`, `
      const item = data.acc[data.acc.length-1];
      item.sell = 40; item.profit = 30;
      save();
      return {profit: item.profit};
    `);
    step(`cycle${i}_delete_acc`, `
      const idx = data.acc.length-1;
      const profitBefore = data.acc.filter(a=>!a._rolled).reduce((t,a)=>t+a.profit,0);
      softDel('acc', idx);
      const profitAfter = data.acc.filter(a=>!a._rolled).reduce((t,a)=>t+a.profit,0);
      return {profitBefore, profitAfter, diff: profitBefore - profitAfter, trashLen: trash.length};
    `);
    step(`cycle${i}_restore_acc`, `
      restoreTrash(trash.length-1);
      const profitAfterRestore = data.acc.filter(a=>!a._rolled).reduce((t,a)=>t+a.profit,0);
      return {profitAfterRestore, trashLenAfter: trash.length};
    `);
  }

  step('phone_qty_before_cycles', `return {qty: inventory.find(p=>p.id==='ph_u1').qty};`);

  for (let i = 0; i < 5; i++) {
    step(`sell_cycle${i}`, `
      const ph = inventory.find(p=>p.id==='ph_u1');
      ph.qty -= 1;
      data.phones.push({modelId:ph.id, modelName:ph.brand+' '+ph.model, qty:1, sellPrice:9000, profit:1000, time:ts()});
      saveInventory(); save();
      return {qty: ph.qty};
    `);
  }
  step('phone_qty_after_5_sales', `return {qty: inventory.find(p=>p.id==='ph_u1').qty};`);

  step('rollback_all_5_sales', `
    const ph = inventory.find(p=>p.id==='ph_u1');
    let rolledCount = 0;
    for (let i=data.phones.length-1; i>=0 && rolledCount<5; i--){
      const s = data.phones[i];
      if (s.modelId==='ph_u1' && !s._rolled){
        s._rolled = true;
        ph.qty += (s.qty||1);
        rolledCount++;
      }
    }
    saveInventory(); save();
    return {finalQty: ph.qty, rolledCount};
  `);

  step('wallet_cycles', `
    loadWallets();
    walletOrder = ['فودافون كاش'];
    walletOpening = {'فودافون كاش': 500};
    walletLimits = {};
    let expectedBal = 500;
    for (let i=0;i<10;i++){
      const dep = 20 + i;
      data.cash.push({cashType:'ايداع', service:'فودافون كاش', amount:dep, time:ts()});
      expectedBal += dep;
    }
    for (let i=0;i<5;i++){
      const wd = 10 + i;
      data.cash.push({cashType:'سحب', service:'فودافون كاش', amount:wd, time:ts()});
      expectedBal -= wd;
    }
    save();
    const actualBal = getWalletBalance('فودافون كاش');
    return {expectedBal, actualBal, match: expectedBal===actualBal};
  `);

  step('final_totals_sanity', `
    const t = calcTotals();
    const hasNaN = Object.values(t).some(v => typeof v === 'number' && isNaN(v));
    const hasUndefined = Object.values(t).some(v => v === undefined);
    return {totals: t, hasNaN, hasUndefined};
  `);

  return { log, errors };
}

console.log('=== UNDO / ROLLBACK STRESS TEST ===\n');
const ORIG_JS = extractJS('/home/claude/work/app.html');
const PROD_JS = extractJS('/home/claude/dist/index.html');

const orig = runStressCycle(ORIG_JS, 'orig');
const prod = runStressCycle(PROD_JS, 'prod');

console.log('Original errors:', orig.errors.length ? orig.errors.slice(0,5) : 'none', orig.errors.length ? `(total ${orig.errors.length})` : '');
console.log('Production errors:', prod.errors.length ? prod.errors.slice(0,5) : 'none', prod.errors.length ? `(total ${prod.errors.length})` : '');

let mismatches = 0;
for (let i = 0; i < orig.log.length; i++) {
  const o = orig.log[i], p = prod.log[i];
  const same = JSON.stringify(o) === JSON.stringify(p);
  if (!same) {
    mismatches++;
    console.log(`❌ ${o.name}: ORIG=${JSON.stringify(o)} PROD=${JSON.stringify(p)}`);
  }
}
console.log(`\nMismatches between original and refactored: ${mismatches} / ${orig.log.length} steps`);

const findStep = (name) => orig.log.find(s => s.name === name)?.val;
console.log('\n--- Key correctness assertions ---');
console.log('20 add→edit→delete→restore cycles completed with zero errors:', orig.errors.length === 0);

const qtyBefore = findStep('phone_qty_before_cycles')?.qty;
const qtyAfter5 = findStep('phone_qty_after_5_sales')?.qty;
console.log(`Phone qty: before=${qtyBefore}, after 5 sales=${qtyAfter5}, expected=${qtyBefore-5}, correct: ${qtyAfter5 === qtyBefore-5}`);

const rollbackResult = findStep('rollback_all_5_sales');
console.log(`Rollback restored qty to ${rollbackResult?.finalQty} of original ${qtyBefore}, rolledCount=${rollbackResult?.rolledCount}, correct: ${rollbackResult?.finalQty === qtyBefore}`);

const walletResult = findStep('wallet_cycles');
console.log(`Wallet balance after 15 deposit/withdraw cycles: expected=${walletResult?.expectedBal} actual=${walletResult?.actualBal} match=${walletResult?.match}`);

const lastRestoreStep = orig.log.filter(s => s.name.includes('restore_acc')).slice(-1)[0];
console.log(`Final restore-cycle trash length (should be 0, all restored):`, lastRestoreStep?.val?.trashLenAfter);

const finalSanity = findStep('final_totals_sanity');
console.log(`Final totals sanity: hasNaN=${finalSanity?.hasNaN} hasUndefined=${finalSanity?.hasUndefined}`);
console.log('Final totals:', JSON.stringify(finalSanity?.totals));

console.log('\n=== VERDICT ===');
console.log('Original vs Production fully identical across entire stress sequence:', mismatches === 0);
console.log('Zero runtime errors in either version:', orig.errors.length === 0 && prod.errors.length === 0);
