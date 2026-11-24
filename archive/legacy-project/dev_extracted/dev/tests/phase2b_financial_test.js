const vm = require('vm');
const fs = require('fs');
const { buildSandbox } = require('./dom-stub');

function extractJS(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  return scripts.join('\n');
}

function run(jsCode, label) {
  const sandbox = buildSandbox();
  const ctx = vm.createContext(sandbox);
  vm.runInContext(jsCode, ctx);
  vm.runInContext('loadAll(); loadData();', ctx);

  const results = {};
  const errors = [];
  function step(name, body) {
    try { results[name] = vm.runInContext(`(function(){\n${body}\n})();`, ctx, { filename: label+':'+name }); }
    catch (e) { errors.push(`${name}: ${e.message}`); }
  }

  // Seed one representative day of data covering every section, including a cancelled repair
  step('seed', `
    data.acc.push({name:'كفر', mainCat:'اكسسوار', buy:20, sell:50, profit:30, time:ts()});
    data.used.push({name:'iPhone مستعمل', sell:5000, profit:800, time:ts()});
    data.cash.push({cashType:'ايداع', service:'فودافون كاش', amount:15, time:ts()});
    data.sw.push({name:'تفعيل', price:100, time:ts()});
    data.exp.push({category:'كهرباء', amount:200, time:ts()});
    data.phones.push({modelId:'ph1', modelName:'Samsung A54', qty:1, sellPrice:9000, profit:1200, time:ts()});
    data.repairs.push({id:'r1', brand:'iPhone', model:'11', servicePrice:500, profit:200, status:'inProgress', time:ts()});
    data.repairs.push({id:'r2', brand:'iPhone', model:'12', servicePrice:700, profit:300, status:'cancelled', time:ts()});
    save();
    return 'seeded';
  `);

  step('calc_totals', `return calcTotals();`);

  step('manual_expected_total', `
    // Manually compute what Total Sales SHOULD be per the mandated rule:
    // ONLY accessories(full) + software(full) + cash(as-is)
    return { expectedTotal: 50 + 100 + 15 };
  `);
  step('manual_expected_profit', `
    // profit = aP+uP+cT+sT+phP+repP(non-cancelled only) - eT
    return { expectedProfit: 30 + 800 + 15 + 100 + 1200 + 200 - 200 };
  `);

  step('month_totals_same_data', `
    const md = {acc:data.acc, used:data.used, cash:data.cash, sw:data.sw, exp:data.exp, phones:data.phones, repairs:data.repairs};
    return monthTotals(md);
  `);

  step('daily_vs_monthly_consistency', `
    const t1 = calcTotals();
    const md = {acc:data.acc, used:data.used, cash:data.cash, sw:data.sw, exp:data.exp, phones:data.phones, repairs:data.repairs};
    const t2 = monthTotals(md);
    return {
      totalMatches: t1.total === t2.total,
      profitMatches: t1.profit === t2.profit,
      daily: {total:t1.total, profit:t1.profit},
      monthly: {total:t2.total, profit:t2.profit}
    };
  `);

  step('analytics_uses_same_engine', `
    // Save today's data as a day-record and verify computeFinancialTotals(dd).profit matches calcTotals().profit
    const dk = DK();
    const dd = Storage.get(dk);
    const viaEngine = computeFinancialTotals(dd).profit;
    const viaCalcTotals = calcTotals().profit;
    return { viaEngine, viaCalcTotals, match: viaEngine === viaCalcTotals };
  `);

  step('cancelled_repair_excluded_everywhere', `
    const t = calcTotals();
    // repP should only include r1 (200), not r2 (300, cancelled)
    return { repP: t.repP, expectedRepP: 200, correct: t.repP === 200 };
  `);

  step('phone_and_used_and_repair_never_in_total', `
    const t = calcTotals();
    // total should be exactly aS+sT+cT = 50+100+15 = 165, regardless of phone/used/repair profit sizes
    return { total: t.total, expected: 165, correct: t.total === 165 };
  `);

  step('rollback_recomputes_consistently', `
    const beforeTotal = calcTotals().total;
    const beforeProfit = calcTotals().profit;
    data.acc[0]._rolled = true; // roll back the accessory sale
    save();
    const afterTotal = calcTotals().total;
    const afterProfit = calcTotals().profit;
    return {
      totalDiff: beforeTotal - afterTotal, expectedTotalDiff: 50,
      profitDiff: beforeProfit - afterProfit, expectedProfitDiff: 30,
      correct: (beforeTotal-afterTotal===50) && (beforeProfit-afterProfit===30)
    };
  `);

  return { results, errors };
}

console.log('=== PHASE 2B — UNIFIED FINANCIAL ENGINE VALIDATION ===\n');
const PROD_JS = extractJS('/home/claude/dist/index.html');
const r = run(PROD_JS, 'prod');

console.log('Errors:', r.errors.length ? r.errors : 'none');
console.log('\n--- Results ---');
for (const [name, val] of Object.entries(r.results)) {
  console.log(`${name}:`, JSON.stringify(val));
}

console.log('\n--- Verdicts ---');
console.log('Daily calcTotals() matches manual expected total:', r.results.calc_totals.total === r.results.manual_expected_total.expectedTotal);
console.log('Daily calcTotals() matches manual expected profit:', r.results.calc_totals.profit === r.results.manual_expected_profit.expectedProfit);
console.log('Daily vs Monthly totals IDENTICAL (same data):', r.results.daily_vs_monthly_consistency.totalMatches);
console.log('Daily vs Monthly profit IDENTICAL (same data):', r.results.daily_vs_monthly_consistency.profitMatches);
console.log('Smart Analytics uses same engine as dashboard:', r.results.analytics_uses_same_engine.match);
console.log('Cancelled repair correctly excluded from profit:', r.results.cancelled_repair_excluded_everywhere.correct);
console.log('New phones / used phones / repairs correctly excluded from Total Sales:', r.results.phone_and_used_and_repair_never_in_total.correct);
console.log('Rollback recomputes totals/profit correctly:', r.results.rollback_recomputes_consistently.correct);
