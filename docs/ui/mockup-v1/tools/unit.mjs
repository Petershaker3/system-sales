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

// 5) الشهور: 14 شهر، والأيام، والمقارنة بالشهر اللي فات
const D0 = (y, m, d) => new Date(y, m - 1, d), iso = run('isoDay');
const months = run('byMonth')(h);
const now = new Date(), firstMonth = new Date(now.getFullYear(), now.getMonth() - 13, 1);
ok(months.length === 14, `history covers 14 months (${months.length})`);
ok(h[0].no === 1001 && iso(h[0].at) === iso(firstMonth), 'history starts on the 1st, 13 months back, at invoice 1001');
ok(sum(months.map((m) => m.sales)) === sum(h.map((x) => x.total)) && sum(months.map((m) => m.invoices)) === h.length, 'months add up to the whole history');
ok(months.every((m, i) => i === 0 || m.from > months[i - 1].from), 'months in order, oldest first');
const mFrom = run('monthStart')(today), mRows = run('asRows')(run('inRange')(h, mFrom, today)), days = run('byDay')(mRows, mFrom, today);
ok(days.length === run('daysIn')(mFrom, today), 'by day: one row per day, including days with no sales');
ok(sum(days.map((d) => d.sales)) === run('totalsOf')(mRows).sales && sum(days.map((d) => d.invoices)) === mRows.length, 'by day adds up to the period totals');
const pp = run('prevPeriod'), same = (r, a, b) => iso(r.from) === iso(a) && iso(r.to) === iso(b);
ok(same(pp(D0(2026, 10, 16), D0(2026, 10, 16)), D0(2026, 10, 15), D0(2026, 10, 15)), 'compare: one day with the day before');
ok(same(pp(D0(2026, 10, 10), D0(2026, 10, 16)), D0(2026, 10, 3), D0(2026, 10, 9)), 'compare: 7 days with the 7 days before');
const p1 = pp(D0(2026, 10, 1), D0(2026, 10, 16), true);
ok(same(p1, D0(2026, 9, 1), D0(2026, 9, 16)) && p1.partial, 'compare: month to date with the same days of last month');
ok(same(pp(D0(2026, 3, 1), D0(2026, 3, 31), true), D0(2026, 2, 1), D0(2026, 2, 28)), 'compare: a full month with the whole month before');
ok(same(pp(D0(2026, 3, 1), D0(2026, 3, 30), true), D0(2026, 2, 1), D0(2026, 2, 28)), 'compare: 30 days of March stop at the end of February');
const mk = (y, m) => months.find((e) => e.key === `${y}-${String(m).padStart(2, '0')}`);
ok(!mk(2026, 2) || !mk(2026, 3) || mk(2026, 3).sales > mk(2026, 2).sales, 'seasons: Eid al-Fitr month (March 2026) sells more than February');

// 7) المقارنة لحد نفس الساعة، وتقرير الشهر والتقييم
const at = (d, h, m) => { const x = new Date(d); x.setHours(h, m, 0, 0); return x; };
const nowX = at(D0(2026, 10, 16), 20, 30), cpLive = run('comparePeriod')(D0(2026, 10, 1), D0(2026, 10, 16), true, nowX);
ok(cpLive.live && cpLive.end.getTime() === at(D0(2026, 9, 16), 20, 30).getTime(), 'compare: a live month stops at the same clock time on the same day of last month');
const cpPast = run('comparePeriod')(D0(2026, 3, 1), D0(2026, 3, 31), true, nowX);
ok(!cpPast.live && cpPast.end.getTime() === D0(2026, 3, 1).getTime(), 'compare: a finished month takes the whole month before');
const ya = run('yearAgo')(D0(2028, 2, 1), D0(2028, 2, 29), nowX);
ok(iso(ya.from) === '2027-02-01' && iso(ya.to) === '2027-02-28', 'year ago: 29 February falls back to the 28th');
const R0 = run('monthReport')(h, today), list0 = run('inRange')(h, run('monthStart')(today), today);
ok(R0.T.sales === sum(list0.map((x) => x.total)) && R0.T.invoices === list0.length, 'month report: totals = the month\'s invoices');
ok(sum(R0.sellers.map((e) => e.sales)) === R0.T.sales && sum(R0.methods.map((e) => e.amount)) === R0.T.sales, 'month report: sellers and payment methods both add up to sales');
const prevList = run('inSpan')(h, R0.P.from, R0.P.end);
ok(R0.PT.sales === sum(prevList.map((x) => x.total)) && prevList.every((x) => x.at < R0.P.end), 'month report: the comparison uses last month up to the same moment');
const doneDays = R0.days.slice(0, -1);
ok(!doneDays.length || (R0.perDay === Math.round(sum(doneDays.map((d) => d.sales)) / doneDays.length) && R0.projection === R0.perDay * run('daysIn')(R0.from, R0.last)), 'month report: projection = average of the finished days × days in the month');
ok(R0.months.length <= 12 && R0.months[R0.months.length - 1].key === run('monthKey')(today) && (R0.rank === null || (R0.rank >= 1 && R0.rank <= R0.of)), 'month report: the last 12 months end with this month, and the rank is within them');
const vk = R0.rank === null ? 'early' : R0.of < 3 ? 'few' : R0.rank === 1 ? 'best' : R0.rank <= 3 ? 'top3' : R0.of >= 6 && R0.rank > R0.of - 3 ? 'low3' : 'mid';
ok(R0.verdict.key === vk, `month report: the verdict follows the rank (${R0.verdict.key}, ${R0.rank}/${R0.of})`);
const sN = R0.notes.find((n) => n.key === 'sales'), chS = run('pct')(R0.T.sales, R0.PT.sales);
ok(sN && sN.ch === chS && sN.tone === (chS >= 3 ? 'good' : chS <= -3 ? 'warn' : 'info'), 'evaluation: the sales note follows the ±3% rule');
const Rp = run('monthReport')(h, D0(2026, 3, 1));
ok(Rp.projection === null && !Rp.live && Rp.days.length === 31, 'a finished month has no projection and all its days');
const Rf = run('monthReport')(h, h[0].at);
ok(Rf.PT.sales === 0 && Rf.verdict.key === 'few' && !Rf.notes.some((n) => ['margin', 'avg', 'disc', 'credit', 'catUp', 'catDown'].includes(n.key)), 'the first month has no judgements without a month before it');
run('refreshDash()'); const yEnd = new Date(run('addDays')(today, -1).getTime() + (Date.now() - today.getTime())), yd = run('DATA.dash.today');
ok(yd.yesterday === sum(h.filter((x) => run('sameDay')(x.at, run('addDays')(today, -1)) && x.at < yEnd).map((x) => x.total)) && yd.vsYesterday === (yd.yesterday ? run('pct')(yd.sales, yd.yesterday) : null), 'reports: yesterday is counted up to the same time as now');

// تقسيم طرق الدفع: 5 درجات بس من لون المحل (styles.css: --c0…--c4)، فاليوم اللي فيه 6 طرق بيجمع الزيادة في «تاني»
const ps = run('typeof paySplit === "function" ? paySplit : null');
const six = ps ? ps({ 'كاش': 5000, 'فودافون كاش': 2000, 'إنستاباي': 1500, 'فيزا / ميزة': 900, 'تقسيط': 300, 'آجل': 100 }) : [];
ok(ps && six.length === 5 && six[4].name === 'تاني' && six.reduce((a, x) => a + x.v, 0) === 100 && six[0].name === 'كاش', 'payment split: at most 5 parts (6 methods → the smallest two become «تاني»), summing to 100%');
ok(ps && ps({ 'كاش': 1 }).length === 1 && ps({}).length === 0, 'payment split: one method is one part, and no sales is no parts');

// 8) تكلفة الاستلام بالمتوسط المرجح (ADR-002): (قيمة الرصيد + قيمة الاستلام) ÷ العدد الجديد، والكسر لفوق
const rc = run('receiveCost');
ok(rc(4, 90, 20, 85) === 86, 'receiving cost: 4 at 90 + 20 at 85 = 85.83 → 86 (rounded up, like the real app)');
ok(rc(3, 520, 5, 480) === 495, 'receiving cost: an exact average stays exact (495)');
ok(rc(0, 999, 5, 480) === 480 && rc(-2, 100, 3, 120) === 120, 'receiving cost: empty or negative stock takes the new unit cost');
ok(rc(10, 100, 10, 100) === 100, 'receiving cost: the same cost keeps the average as it was');

// 6) كل اسم متعرّف في ملف واحد (اسم متكرر بين ملفين = الصفحة كلها تقف)
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const files = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]), seen = new Map(), dups = [];
for (const f of files) for (const m of fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
  if (seen.has(m[1])) dups.push(`${m[1]} (${seen.get(m[1])} + ${f})`); else seen.set(m[1], f);
}
ok(files.length >= 13 && !dups.length, `every top-level name is declared once across ${files.length} files${dups.length ? `: ${dups.join(', ')}` : ''}`);

// 7) قاموس الكلام (DESIGN.md): كلمات المالك قرر نشيلها ما ترجعش في أي ملف
const WORDS = [['المخزون', 'المخزن (المالك 2026-10-17)'], ['تعليق', 'انتظار (الجولة 2)']], badWords = [];
for (const f of files) { const src = fs.readFileSync(path.join(ROOT, f), 'utf8'); for (const [w, use] of WORDS) if (src.includes(w)) badWords.push(`«${w}» في ${f} — استعمل «${use}»`); }
ok(!badWords.length, `the wording rules hold in every file${badWords.length ? `: ${badWords.join('، ')}` : ''}`);

console.log(`UNIT PASSED: ${pass}`);
console.log('UNIT FAILS:', fails.length ? `\n${fails.join('\n')}` : 'none');
process.exit(fails.length ? 1 : 0);
