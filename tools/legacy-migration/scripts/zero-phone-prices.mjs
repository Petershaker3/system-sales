#!/usr/bin/env node
// «انا مفيش جهاز كاتبله سعر بيع في السيستم الجديد» — المالك، 2026-11-02.
//
// A draft made before that call carries a sale price for every phone that had
// ever been sold — the old program's *last* sale, which reads like a price the
// owner set. This removes them: each phone goes to zero, and the old number is
// kept beside the empty field as «آخر سعر في القديم» so he can take it back with
// one click in the screen instead of losing it.
//
// Usage: node scripts/zero-phone-prices.mjs <draft.json> [--out <file.json>]

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const input = args.find((arg) => !arg.startsWith('--'));
const outIndex = args.indexOf('--out');
const out = outIndex >= 0 ? args[outIndex + 1] : null;

if (!input) {
  console.error('usage: zero-phone-prices.mjs <draft.json> [--out <file.json>]');
  process.exit(2);
}

const plan = JSON.parse(readFileSync(input, 'utf8'));
let zeroed = 0;
let kept = 0;
for (const item of plan.items ?? []) {
  if (item.kind !== 'phone') continue;
  if (item.sell > 0) {
    item.sellSuggested = item.sell;
    // Empty, not zero: zero is a price that would sell the phone for nothing.
    item.sell = null;
    zeroed += 1;
  } else if (item.sellSuggested > 0) {
    kept += 1;
  }
}

const phones = (plan.items ?? []).filter((item) => item.kind === 'phone' && item.include);
console.log(`اتصفّر سعر بيع ${zeroed} موديل — و${kept} كانوا صفر أصلًا.`);
console.log(`الموبايلات الجديدة: ${phones.length} موديل، منهم ${phones.filter((item) => item.sell > 0).length} بسعر.`);

if (out) {
  writeFileSync(out, JSON.stringify(plan, null, 1));
  console.log(`اتكتب: ${out}`);
}
