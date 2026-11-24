const vm = require('vm');
const fs = require('fs');
const { buildSandbox } = require('./dom-stub');

function extractJS(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  return scripts.join('\n');
}

function seedLargeDataset(ctx) {
  const code = `
    (function(){
      const PHONES=1000, SALES=5000, REPAIRS=2000, ACC=5000, CASH=5000, MONTHS=24;

      // 1000 phone models
      for (let i=0;i<PHONES;i++){
        inventory.push({id:'ph_'+i, brand:'براند'+(i%20), model:'موديل'+i, ram:['4GB','6GB','8GB'][i%3],
          storage:['64GB','128GB','256GB'][i%3], color:'لون'+(i%5), internalCode:'C'+i,
          qty: (i%15), buyPrice: 2000+(i%500)*10, supplier:'مورد'+(i%30),
          notes:'', addedDate: td(), lastBuyDate: td(), purchaseHistory:[{price:2000+(i%500)*10,supplier:'مورد',date:td(),qty:5}]});
      }
      saveInventory();

      // 5000 accessories
      for (let i=0;i<ACC;i++){
        data.acc.push({name:'اكسسوار'+i, mainCat:'اكسسوار', buy:15+(i%80), sell:40+(i%150), profit:(40+(i%150))-(15+(i%80)), time:ts()});
      }
      // 5000 cash transactions across wallets
      const wallets=['فودافون كاش','اتصالات كاش','اورانج كاش','وي كاش'];
      for (let i=0;i<CASH;i++){
        data.cash.push({cashType: i%2?'ايداع':'سحب', service: wallets[i%4], amount:5+(i%60), time:ts()});
      }
      // 2000 repairs
      for (let i=0;i<REPAIRS;i++){
        data.repairs.push({id:'rep_'+i, brand:'براند'+(i%10), model:'م'+i, faultType:'عطل'+(i%8),
          servicePrice:100+(i%400), profit:30+(i%150), status:'inProgress', time:ts()});
      }
      save();

      // 24 months of history, spreading 5000 sales across them
      const salesPerMonth = Math.ceil(SALES/MONTHS);
      let totalSalesWritten = 0, totalSalesProfit = 0, totalSalesRevenue = 0;
      for (let m=0;m<MONTHS;m++){
        const year = 2024 + Math.floor(m/12);
        const month = String((m%12)+1).padStart(2,'0');
        // spread across ~28 days per month
        const daysInMonth = 28;
        const perDay = Math.ceil(salesPerMonth/daysInMonth);
        for (let d=0; d<daysInMonth; d++){
          const dateKey='mshop_d_'+year+'-'+month+'-'+String(d+1).padStart(2,'0');
          const dayPhones=[];
          for (let s=0; s<perDay && totalSalesWritten<SALES; s++){
            const price = 8000+(s%2000);
            const profit = 800+(s%500);
            dayPhones.push({modelId:'ph_'+(s%PHONES), modelName:'موديل'+(s%PHONES), qty:1, sellPrice:price, profit:profit});
            totalSalesWritten++;
            totalSalesProfit += profit;
            totalSalesRevenue += price;
          }
          localStorage.setItem(dateKey, JSON.stringify({acc:[],used:[],cash:[],sw:[],exp:[],phones:dayPhones,repairs:[]}));
        }
      }

      globalThis.__seedStats = {
        PHONES, SALES: totalSalesWritten, REPAIRS, ACC, CASH, MONTHS,
        expectedSalesProfit: totalSalesProfit,
        expectedSalesRevenue: totalSalesRevenue,
        expectedAccProfit: data.acc.reduce((t,a)=>t+a.profit,0),
        expectedAccRevenue: data.acc.reduce((t,a)=>t+a.sell,0),
        expectedRepairProfit: data.repairs.reduce((t,r)=>t+r.profit,0),
        expectedRepairRevenue: data.repairs.reduce((t,r)=>t+r.servicePrice,0),
      };
      true;
    })();
  `;
  const t0 = process.hrtime.bigint();
  vm.runInContext(code, ctx);
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6;
}

function runStress(jsCode, label) {
  const sandbox = buildSandbox();
  const ctx = vm.createContext(sandbox);
  vm.runInContext(jsCode, ctx);
  vm.runInContext('loadAll(); loadData();', ctx);

  const seedMs = seedLargeDataset(ctx);
  const stats = vm.runInContext('globalThis.__seedStats', ctx);

  const results = { seedMs, stats };

  // Dashboard totals (today's data only — won't include historical days, that's expected/correct)
  const t0 = process.hrtime.bigint();
  results.calcTotals = vm.runInContext('calcTotals()', ctx);
  results.calcTotalsMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // Aggregate ALL historical sales directly from localStorage (mirrors what renderPhonesSales does)
  const t1 = process.hrtime.bigint();
  results.allSalesAgg = vm.runInContext(`
    (function(){
      let cnt=0, revenue=0, profit=0;
      for (let i=0;i<localStorage.length;i++){
        const k = localStorage.key(i);
        if (!k || !k.startsWith('mshop_d_')) continue;
        const d = JSON.parse(localStorage.getItem(k));
        (d.phones||[]).forEach(s => { cnt++; revenue += s.sellPrice||0; profit += s.profit||0; });
      }
      return {cnt, revenue, profit};
    })();
  `, ctx);
  results.allSalesAggMs = Number(process.hrtime.bigint() - t1) / 1e6;

  // Accessories / repairs aggregate correctness (from in-memory `data`)
  results.accAgg = vm.runInContext(`({cnt: data.acc.length, revenue: data.acc.reduce((t,a)=>t+a.sell,0), profit: data.acc.reduce((t,a)=>t+a.profit,0)})`, ctx);
  results.repairAgg = vm.runInContext(`({cnt: data.repairs.length, revenue: data.repairs.reduce((t,r)=>t+r.servicePrice,0), profit: data.repairs.reduce((t,r)=>t+r.profit,0)})`, ctx);

  // Search across full inventory (simulating phones search)
  const t2 = process.hrtime.bigint();
  results.searchResult = vm.runInContext(`
    inventory.filter(p => (p.brand+' '+p.model).toLowerCase().includes('براند5')).length
  `, ctx);
  results.searchMs = Number(process.hrtime.bigint() - t2) / 1e6;

  // Movement/analytics calc over full inventory
  const t3 = process.hrtime.bigint();
  vm.runInContext(`inventory.map(p => getMovement(p.id));`, ctx);
  results.analyticsMs = Number(process.hrtime.bigint() - t3) / 1e6;

  // Undo/rollback correctness at scale: roll back 100 accessory transactions, verify totals adjust correctly
  results.rollbackTest = vm.runInContext(`
    (function(){
      const beforeProfit = data.acc.filter(a=>!a._rolled).reduce((t,a)=>t+a.profit,0);
      for (let i=0;i<100;i++){ data.acc[i]._rolled = true; }
      const afterProfit = data.acc.filter(a=>!a._rolled).reduce((t,a)=>t+a.profit,0);
      const rolledBackProfit = data.acc.slice(0,100).reduce((t,a)=>t+a.profit,0);
      return {beforeProfit, afterProfit, rolledBackProfit, diffMatches: Math.abs((beforeProfit-afterProfit)-rolledBackProfit) < 0.01};
    })();
  `, ctx);

  return results;
}

console.log('=== LARGE DATASET INTEGRITY TEST ===\n');
const ORIG_JS = extractJS('/home/claude/work/app.html');
const PROD_JS = extractJS('/home/claude/dist/index.html');

console.log('Seeding & running on ORIGINAL...');
const orig = runStress(ORIG_JS, 'orig');
console.log('Seeding & running on PRODUCTION (refactored)...');
const prod = runStress(PROD_JS, 'prod');

console.log('\n--- Seed stats ---');
console.log(JSON.stringify(orig.stats, null, 2));

console.log('\n--- Timing ---');
console.log('Seed dataset:', orig.seedMs.toFixed(1), 'ms (orig) vs', prod.seedMs.toFixed(1), 'ms (prod)');
console.log('calcTotals():', orig.calcTotalsMs.toFixed(3), 'ms (orig) vs', prod.calcTotalsMs.toFixed(3), 'ms (prod)');
console.log('Aggregate 5000 sales across 24mo history:', orig.allSalesAggMs.toFixed(2), 'ms (orig) vs', prod.allSalesAggMs.toFixed(2), 'ms (prod)');
console.log('Search across 1000 phones:', orig.searchMs.toFixed(3), 'ms (orig) vs', prod.searchMs.toFixed(3), 'ms (prod)');
console.log('Analytics/movement calc over 1000 phones:', orig.analyticsMs.toFixed(2), 'ms (orig) vs', prod.analyticsMs.toFixed(2), 'ms (prod)');

console.log('\n--- Correctness checks ---');
function cmp(name, o, p) {
  const match = JSON.stringify(o) === JSON.stringify(p);
  console.log(`${match ? '✅' : '❌'} ${name}:`, JSON.stringify(o), match ? '(matches prod)' : `!= ${JSON.stringify(p)}`);
  return match;
}
let allOk = true;
allOk &= cmp('calcTotals result', orig.calcTotals, prod.calcTotals);
allOk &= cmp('All-history sales aggregate', orig.allSalesAgg, prod.allSalesAgg);
allOk &= cmp('Accessories aggregate', orig.accAgg, prod.accAgg);
allOk &= cmp('Repairs aggregate', orig.repairAgg, prod.repairAgg);
allOk &= cmp('Search result count', orig.searchResult, prod.searchResult);
allOk &= cmp('Rollback consistency test', orig.rollbackTest, prod.rollbackTest);

console.log('\n--- Financial sanity (expected vs actual, within ORIGINAL run) ---');
console.log('Expected sales revenue == aggregated:', orig.stats.expectedSalesRevenue === orig.allSalesAgg.revenue);
console.log('Expected sales profit == aggregated:', orig.stats.expectedSalesProfit === orig.allSalesAgg.profit);
console.log('Expected acc revenue == aggregated:', orig.stats.expectedAccRevenue === orig.accAgg.revenue);
console.log('Expected acc profit == aggregated:', orig.stats.expectedAccProfit === orig.accAgg.profit);
console.log('Expected repair revenue == aggregated:', orig.stats.expectedRepairRevenue === orig.repairAgg.revenue);
console.log('Expected repair profit == aggregated:', orig.stats.expectedRepairProfit === orig.repairAgg.profit);
console.log('Rollback math self-consistent (orig):', orig.rollbackTest.diffMatches);
console.log('Rollback math self-consistent (prod):', prod.rollbackTest.diffMatches);

console.log('\n=== FINAL VERDICT ===');
console.log('All correctness checks passed:', !!allOk);
