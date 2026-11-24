#!/usr/bin/env node
// Bring a draft up to date with a newer old-system backup — from the terminal.
//
// The screen does the same two steps (`فتح باكب أحدث` and `وصّلهم تلقائيًا`); this
// script exists so the operation is repeatable, reviewable and testable without a
// browser, and so a draft can be repaired and merged in one command:
//
//   node scripts/merge-newer.mjs <draft.json> <newer-legacy.json> --out <file.json>
//
// It prints what it did before writing anything: which days came in, how much
// money, which counts moved, and where every orphaned sale went.

import { readFileSync, writeFileSync } from 'node:fs';

import { preparePlan } from '../src/pipeline.mjs';
import { applyOwnerDefaults, validatePlan, planTotals, placeholderDeviceCount } from '../src/plan.mjs';
import { describeOrphanSales, repairOrphanSales } from '../src/repair.mjs';
import { describeNewDays, applyNewDays } from '../src/merge-days.mjs';

const [draftPath, legacyPath] = process.argv.slice(2);
const argValue = (args, name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const outPath = argValue(process.argv, '--out');

if (!draftPath || !legacyPath) {
  console.error('usage: merge-newer.mjs <draft.json> <newer-legacy.json> [--out <file.json>]');
  process.exit(2);
}

const money = (value) => Math.round(Number(value) || 0).toLocaleString('en-US');
const draft = JSON.parse(readFileSync(draftPath, 'utf8'));
const prepared = preparePlan(readFileSync(legacyPath, 'utf8'), {});
if (!prepared.ok) {
  console.error('الملف ده مش باكب السيستم القديم.');
  process.exit(1);
}
let plan = draft;
// The owner's two decisions of 2026-11-02 are applied before anything is measured,
// so what this prints is exactly what the build will write.
const defaults = applyOwnerDefaults(plan);

// ── 1. Sales whose item was deleted ───────────────────────────────────────
const orphans = describeOrphanSales(plan);
if (orphans.totalSales) {
  console.log(`\n== بيعات معلّقة: ${orphans.totalSales} بيعة بـ${money(orphans.totalMoney)} ج على ${orphans.matched.length + orphans.guessed.length + orphans.recreated.length} صنف`);
  for (const group of orphans.matched) console.log(`  = «${group.name}» ${group.count} بيعة ← «${group.toName}» (نفس الاسم)`);
  for (const group of orphans.guessed) console.log(`  ~ «${group.name}» ${group.count} بيعة ← «${group.toName}» (الاسم جوه اسم)`);
  for (const group of orphans.recreated) console.log(`  + «${group.name}» ${group.count} بيعة ← صنف رجع بعدد صفر ومش هيتنقل`);
  plan = repairOrphanSales(plan).plan;
}

// ── 2. The days the draft does not have yet ───────────────────────────────
const days = describeNewDays(plan, prepared.legacy);
if (days.days.length) {
  const headline = days.topUpDays
    ? `${days.newDayCount} يوم جديد + تكميل ${days.topUpDays} يوم`
    : `${days.newDayCount} يوم جديد`;
  console.log(`\n== ${headline} (${days.firstDay} ← ${days.lastDay})`);
  for (const day of days.days) {
    console.log(`  ${day.day}${day.topUp ? ' (تكملة)' : ''}: ${day.sales} بيعة بـ${money(day.total)} ج · ${day.repairs} صيانة · مصاريف ${money(day.expenses)} ج · ${day.cash} كاش`);
  }
  console.log(`  الإجمالي: ${days.sales} بيعة بـ${money(days.saleTotal)} ج`);
  if (days.newItems.length) console.log(`  أصناف جديدة: ${days.newItems.map((item) => item.name).join(' · ')}`);
  console.log(`  أعداد هتتظبط: ${days.counts.length} صنف`);
  for (const row of days.counts) console.log(`    ${row.name}: ${row.before} ← ${row.after} (اتباع ${row.sold})${row.clamped ? '  ⚠ راجع الجرد' : ''}`);
  for (const line of days.warnings) console.log(`  ! ${line}`);
  plan = applyNewDays(plan, prepared.legacy).plan;
} else {
  console.log('\n== مفيش أيام جديدة: المسودة فيها كل الأيام اللي في الباكب.');
}

// ── 3. Say what the new file holds, and refuse to write a broken one ──────
const validation = validatePlan(plan);
const errors = validation.findings.filter((finding) => finding.level === 'error');
const warnings = validation.findings.filter((finding) => finding.level === 'warn');
const totals = planTotals(plan);
console.log(`\n== الملف بعد الدمج`);
console.log(`  ${plan.items.length} صنف · ${plan.sales.length} بيعة تفصيلية · ${plan.summary.length} بند مجمّع · ${plan.repairs.length} صيانة · ${plan.expenses.length} مصروف`);
console.log(`  الشهور: ${plan.months.map((month) => `${month.month}=${month.mode}`).join(' · ')}`);
console.log(`  مبيعات تفصيلية ${money(totals.saleTotal)} ج + مجمّعة ${money(totals.summaryTotal)} ج`);
console.log(`  آخر يوم ${plan.source.lastDay} · ${plan.source.days} يوم`);
if (errors.length) {
  console.log(`\n  ✗ ${errors.length} مانع:`);
  for (const finding of errors.slice(0, 10)) console.log(`    - ${finding.code}: ${finding.message}`);
} else {
  console.log('  ✓ مفيش مانع للبناء');
}
if (warnings.length) console.log(`  (${warnings.length} تنبيه عادي)`);

if (outPath) {
  if (errors.length) {
    console.error('\nمش هكتب الملف وفيه موانع.');
    process.exit(1);
  }
  writeFileSync(outPath, JSON.stringify(plan, null, 1));
  console.log(`\nاتكتب: ${outPath}`);
}
