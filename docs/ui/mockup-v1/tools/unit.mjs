// فحوص سريعة لطبقة الحسابات (analytics.js) وبيانات التجربة (data.js) من غير متصفح — أقل من ثانية.
// الاستعمال: node unit.mjs   (من فولدر tools). الدليل: docs/ENGINEERING.md
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = vm.createContext({ console, Intl, Date, Math, JSON, Map, Set, Object, Array, Number, String, Error });
const load = (f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
const run = (code) => vm.runInContext(code, ctx);

load('data.js');
// اللي طبقة الحسابات محتاجاه من باقي الملفات (في البرنامج: pos.js و app.js) — نسخ بسيطة هنا
run(`
  const catById = (id) => DATA.categories.find((c) => c.id === id);
  const catName = (id) => (catById(id) || {}).name || '';
  const methodName = (id) => (DATA.payMethods.find((m) => m.id === id) || {}).name || id;
  const payLabel = (ps) => ps.map((p) => methodName(p.method)).join(' + ');
  const fmtTime = (d) => d.toTimeString().slice(0, 5);
  const locale = () => 'ar-EG-u-nu-latn';
  const prod = (id) => DATA.products.find((p) => p.id === id);
`);
load('analytics.js');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { if (cond) pass++; else fails.push(msg); };
const sum = (a) => a.reduce((x, y) => x + y, 0);

// 1) كل فاتورة في السجل سليمة
const h = run('DATA.history');
ok(h.length > 1000, `history has invoices (${h.length})`);
ok(h.every((x, i) => i === 0 || x.no === h[i - 1].no + 1), 'invoice numbers are consecutive');
ok(h.every((x, i) => i === 0 || x.at >= h[i - 1].at), 'invoices are in time order');
ok(h.every((x) => sum(x.payments.map((p) => p.amount)) === x.total), 'payments add up to the invoice total');
ok(h.every((x) => x.total === sum(x.lines.map((l) => l.price * l.qty)) - x.disc), 'total = lines − discount');
ok(h.every((x) => x.profit === sum(x.lines.map((l) => (l.price - l.cost) * l.qty)) - x.disc), 'profit = (price − cost) × qty − discount');
ok(h.every((x) => !x.payments.some((p) => p.method === 'credit') || x.customerId), 'credit (آجل) only on a registered customer');
ok(h.every((x) => !x.payments.some((p) => p.method === 'install') || x.lines.some((l) => l.imei)), 'instalments only on a phone');
ok(h.every((x) => x.lines.every((l) => !l.imei || /^\d{15}$/.test(l.imei))), 'every IMEI has 15 digits');

// 2) الفترات: الطرفين محسوبين
const today = run('dayStart(new Date())');
const td = h.filter((x) => run('sameDay')(x.at, today));
ok(run('inRange')(h, today, today).length === td.length, 'inRange(today, today) = today\'s invoices');
const wk = run('inRange')(h, run('addDays')(today, -6), today);
ok(wk.length === h.filter((x) => x.at >= run('addDays')(today, -6)).length, 'inRange over 7 days includes both ends');

// 3) الإجماليات والتجميع
const rows = run('asRows')(wk);
const T = run('totalsOf')(rows);
ok(T.sales === sum(wk.map((x) => x.total)), 'totals: sales = sum of invoice totals');
ok(T.invoices === wk.length && T.pcs === sum(wk.flatMap((x) => x.lines.map((l) => l.qty))), 'totals: invoices and pieces');
ok(T.avg === Math.round(T.sales / wk.length), 'totals: average invoice');
const gross = sum(wk.flatMap((x) => x.lines.map((l) => l.price * l.qty)));
ok(sum(run('byProduct')(rows).map((e) => e.sales)) === gross, 'by product adds up to the lines');
const cats = run('byCategory')(rows);
ok(sum(cats.map((e) => e.sales)) === gross, 'by category adds up to the lines');
ok(cats.every((e) => sum([...e.subs.values()].map((s) => s.sales)) <= e.sales), 'sub-categories never exceed their main category');
const caseRows = wk.map((x) => ({ x, lines: x.lines.filter((l) => l.cat === 'cases'), lineLevel: true })).filter((r) => r.lines.length);
ok(run('totalsOf')(caseRows).sales === sum(wk.flatMap((x) => x.lines.filter((l) => l.cat === 'cases').map((l) => l.price * l.qty))), 'a category filter counts only the matching lines');

// 4) التقارير بتتحسب من السجل
run('refreshDash()');
const D = run('DATA.dash');
ok(D.today.sales === sum(td.map((x) => x.total)) && D.today.invoices === td.length, 'reports: today = sum of today\'s invoices');
ok(D.week[6] === D.today.sales, 'reports: the week chart ends with today');
ok(!td.length || sum(D.pay.map((p) => p.v)) === 100, 'reports: payment split adds up to 100%');
ok(D.recent.every((r, i) => i === 0 || r.no < D.recent[i - 1].no), 'reports: latest invoices newest first');
ok(D.top.every((e, i) => i === 0 || e[1] <= D.top[i - 1][1]), 'reports: best sellers by quantity');

console.log(`UNIT PASSED: ${pass}`);
console.log('UNIT FAILS:', fails.length ? `\n${fails.join('\n')}` : 'none');
process.exit(fails.length ? 1 : 0);
