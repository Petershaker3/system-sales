const vm = require('vm');
const fs = require('fs');
const { buildSandbox } = require('./dom-stub');

function extractJS(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  return scripts.join('\n');
}

function timeIt(ctx, label, code, iterations = 1) {
  try {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      vm.runInContext(code, ctx, { filename: label });
    }
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6 / iterations;
    return { label, ms: ms.toFixed(3), ok: true };
  } catch (e) {
    return { label, ms: null, ok: false, error: e.message };
  }
}

function seedDataset(ctx, {phones=50, sales=100, repairs=50, acc=100, cash=100}) {
  const code = `
    (function(){
      for (let i=0;i<${phones};i++){
        inventory.push({id:'ph_s'+i, brand:'براند'+(i%10), model:'موديل'+i, ram:'8GB', storage:'128GB',
          color:'أسود', internalCode:'', qty: (i%7), buyPrice: 3000+i*10, supplier:'مورد'+(i%5),
          notes:'', addedDate: td(), lastBuyDate: td(), purchaseHistory:[{price:3000+i*10,supplier:'مورد',date:td(),qty:5}]});
      }
      saveInventory();
      for (let i=0;i<${acc};i++){ data.acc.push({name:'اكسسوار'+i, mainCat:'اكسسوار', buy:20+i, sell:50+i, profit:30, time:ts()}); }
      for (let i=0;i<${cash};i++){ data.cash.push({cashType: i%2?'ايداع':'سحب', service:'فودافون كاش', amount:10+i, time:ts()}); }
      for (let i=0;i<${repairs};i++){ data.repairs.push({id:'rep_s'+i, brand:'iPhone', model:'X', faultType:'كسر شاشة', servicePrice:300+i, profit:100, status:'inProgress', time:ts()}); }
      save();
      // simulate ${sales} historical phone sale day-records
      for (let d=0; d<20; d++){
        const dateKey='mshop_d_2026-06-'+String(d+1).padStart(2,'0');
        const dayPhones=[];
        for (let s=0; s<${Math.ceil(sales/20)}; s++){
          dayPhones.push({modelId:'ph_s'+(s%${phones||1}), modelName:'موديل'+s, qty:1, sellPrice:9000, profit:1200});
        }
        localStorage.setItem(dateKey, JSON.stringify({acc:[],used:[],cash:[],sw:[],exp:[],phones:dayPhones,repairs:[]}));
      }
      true;
    })();
  `;
  vm.runInContext(code, ctx);
}

function runBaseline(jsCode, label, datasetSize) {
  const sandbox = buildSandbox();
  const ctx = vm.createContext(sandbox);
  vm.runInContext(jsCode, ctx);

  const timings = [];
  timings.push(timeIt(ctx, 'app_startup (loadAll)', `loadAll();`, 5));
  timings.push(timeIt(ctx, 'load_all_data (loadData)', `loadData();`, 5));

  seedDataset(ctx, datasetSize);

  timings.push(timeIt(ctx, 'open_phones_section (renderPhonesList-equivalent calc)', `
    (function(){ inventory.filter(p=>!p.archived).map(p=>({...p, mv: getMovement(p.id)})); })();
  `, 20));

  timings.push(timeIt(ctx, 'calc_totals (dashboard totals)', `calcTotals();`, 50));

  timings.push(timeIt(ctx, 'add_new_phone', `
    inventory.push({id:'ph_new'+Math.random(), brand:'Test', model:'X', ram:'8GB', storage:'128GB',
      color:'', internalCode:'', qty:1, buyPrice:1000, supplier:'', notes:'', addedDate:td(), lastBuyDate:td(), purchaseHistory:[]});
    saveInventory();
  `, 20));

  timings.push(timeIt(ctx, 'record_phone_sale', `
    (function(){
      const ph = inventory[0];
      data.phones.push({modelId: ph.id, modelName: ph.brand+' '+ph.model, qty:1, sellPrice:9000, profit:1000, time:ts()});
      save();
    })();
  `, 20));

  timings.push(timeIt(ctx, 'record_repair', `
    data.repairs.push({id:'rep_new'+Math.random(), brand:'Test', model:'Y', faultType:'x', servicePrice:200, profit:80, status:'inProgress', time:ts()});
    save();
  `, 20));

  timings.push(timeIt(ctx, 'undo_rollback (mark _rolled + recalc)', `
    if (data.acc.length){ data.acc[0]._rolled = true; save(); calcTotals(); }
  `, 20));

  timings.push(timeIt(ctx, 'monthly_report_aggregation', `
    typeof getMonthData==='function' ? monthTotals(getMonthData(selMonth)) : null;
  `, 10));

  timings.push(timeIt(ctx, 'smart_analytics (movement calc over inventory)', `
    inventory.map(p => getMovement(p.id));
  `, 10));

  timings.push(timeIt(ctx, 'wallet_balance_all', `
    loadWallets(); walletOrder.map(w => getWalletBalance(w));
  `, 10));

  return timings;
}

const ORIG_JS = extractJS('/home/claude/work/app.html');
const PROD_JS = extractJS('/home/claude/dist/index.html');

const size = {phones:50, sales:100, repairs:50, acc:100, cash:100};

console.log('=== PERFORMANCE BASELINE (moderate dataset) ===\n');
console.log('Dataset:', JSON.stringify(size));

const origT = runBaseline(ORIG_JS, 'orig', size);
const prodT = runBaseline(PROD_JS, 'prod', size);

console.log('\n%-45s %12s %12s %10s', 'Operation', 'Original(ms)', 'Refactored(ms)', 'Δ');
console.log('-'.repeat(85));
for (let i = 0; i < origT.length; i++) {
  const o = origT[i], p = prodT[i];
  const oMs = o.ok ? parseFloat(o.ms) : NaN;
  const pMs = p.ok ? parseFloat(p.ms) : NaN;
  const delta = (o.ok && p.ok) ? (pMs - oMs).toFixed(3) : 'N/A';
  console.log(
    o.label.padEnd(45),
    (o.ok ? o.ms : 'ERR').padStart(12),
    (p.ok ? p.ms : 'ERR').padStart(12),
    String(delta).padStart(10)
  );
  if (!o.ok) console.log('   ORIG ERROR:', o.error);
  if (!p.ok) console.log('   PROD ERROR:', p.error);
}
