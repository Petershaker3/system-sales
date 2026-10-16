'use strict';
/* ===== طبقة الحسابات: كل أرقام المبيعات بتتحسب هنا بس =====
   التقارير وشاشة المبيعات والموبايل بيعرضوا بس، والأرقام كلها من سجل الفواتير DATA.history. وتكلفة الاستلام (المتوسط المرجح) هنا كمان.
   الدوال دي من غير رسم ولا DOM، فبتتفحص من غير متصفح (tools/unit.mjs). الدليل: docs/ENGINEERING.md */

/* --- التواريخ --- */
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const sameDay = (a, b) => dayStart(a).getTime() === dayStart(b).getTime();
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthStart = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const monthEnd = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const sameMonth = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const daysIn = (from, to) => Math.round((dayStart(to) - dayStart(from)) / 864e5) + 1;
// نسبة التغيير (٪) — null لو مفيش أساس للمقارنة
const pct = (now, before) => (before ? Math.round(((now - before) / before) * 100) : null);
// الفواتير في فترة، والطرفين محسوبين (من أول يوم from لآخر يوم to)
function inRange(list, from, to) { const a = dayStart(from).getTime(), b = addDays(to, 1).getTime(); return list.filter((x) => { const t = x.at.getTime(); return t >= a && t < b; }); }
// الفترة اللي بنقارن بيها. الشهر: الشهر اللي قبله، ولو الشهر لسه ماخلصش فبنفس عدد الأيام من أوله
// (16 يوم من الشهر ده قصاد أول 16 يوم من اللي قبله). غير كده: نفس الطول على طول قبلها
function prevPeriod(from, to, month = false) {
  const len = daysIn(from, to);
  if (!month) return { from: addDays(from, -len), to: addDays(to, -len), partial: false };
  const pf = new Date(from.getFullYear(), from.getMonth() - 1, 1), pe = monthEnd(pf);
  const partial = dayStart(to).getTime() < monthEnd(from).getTime(), last = partial ? addDays(pf, len - 1) : pe;
  return { from: pf, to: last > pe ? pe : last, partial };
}
const catMain = (id) => { const c = catById(id); return c && c.parent ? c.parent : id; };
const svCatName = (id) => (id === 'svc' ? 'خدمات وصيانة' : catName(id) || id);

/* --- التجميع: الصف = { x: الفاتورة، lines: السطور المطابقة، lineLevel: هل الفلتر على السطور } --- */
const asRows = (list) => list.map((x) => ({ x, lines: x.lines, lineLevel: false }));
const rowAmount = (r) => (r.lineLevel ? r.lines.reduce((a, l) => a + l.price * l.qty, 0) : r.x.total);
const rowProfit = (r) => (r.lineLevel ? r.lines.reduce((a, l) => a + (l.price - l.cost) * l.qty, 0) : r.x.profit);
function totalsOf(rows) {
  const sales = rows.reduce((a, r) => a + rowAmount(r), 0), profit = rows.reduce((a, r) => a + rowProfit(r), 0);
  const pcs = rows.reduce((a, r) => a + r.lines.reduce((b, l) => b + l.qty, 0), 0);
  return { sales, profit, pcs, invoices: rows.length, avg: rows.length ? Math.round(sales / rows.length) : 0, partial: rows.some((r) => r.lineLevel) };
}
function byProduct(rows) {
  const m = new Map();
  for (const r of rows) for (const l of r.lines) {
    const k = l.pid || l.name, e = m.get(k) || { name: l.name, cat: l.cat, qty: 0, sales: 0, profit: 0 };
    e.qty += l.qty; e.sales += l.price * l.qty; e.profit += (l.price - l.cost) * l.qty; m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.sales - a.sales);
}
function byCategory(rows) {
  const m = new Map(), add = (k, l) => { const e = m.get(k) || { id: k, qty: 0, sales: 0, profit: 0, subs: new Map() }; e.qty += l.qty; e.sales += l.price * l.qty; e.profit += (l.price - l.cost) * l.qty; m.set(k, e); return e; };
  for (const r of rows) for (const l of r.lines) {
    const main = add(catMain(l.cat), l);
    if (main.id !== l.cat) { const s = main.subs.get(l.cat) || { id: l.cat, qty: 0, sales: 0, profit: 0 }; s.qty += l.qty; s.sales += l.price * l.qty; s.profit += (l.price - l.cost) * l.qty; main.subs.set(l.cat, s); }
  }
  return [...m.values()].sort((a, b) => b.sales - a.sales);
}
// يوم بيوم في الفترة، والأيام اللي من غير مبيعات بصفر — بنفس تعريف totalsOf
function byDay(rows, from, to) {
  const out = [], idx = new Map();
  for (let d = dayStart(from); d <= to; d = addDays(d, 1)) { const e = { day: d, sales: 0, profit: 0, invoices: 0, pcs: 0 }; idx.set(isoDay(d), e); out.push(e); }
  for (const r of rows) { const e = idx.get(isoDay(r.x.at)); if (!e) continue; e.sales += rowAmount(r); e.profit += rowProfit(r); e.invoices++; e.pcs += r.lines.reduce((a, l) => a + l.qty, 0); }
  return out;
}
// الشهور اللي فيها مبيعات بالترتيب (الأقدم الأول): { key، from، sales، profit، invoices، pcs }
function byMonth(list) {
  const m = new Map();
  for (const x of list) {
    const k = monthKey(x.at); let e = m.get(k);
    if (!e) m.set(k, (e = { key: k, from: monthStart(x.at), sales: 0, profit: 0, invoices: 0, pcs: 0 }));
    e.sales += x.total; e.profit += x.profit; e.invoices++; e.pcs += x.lines.reduce((a, l) => a + l.qty, 0);
  }
  return [...m.values()].sort((a, b) => a.from - b.from);
}

/* --- المقارنة: لو الفترة فيها النهارده، بنقارن لحد نفس الساعة (النهارده لسه ماخلصش) --- */
// الفواتير من أول يوم from لحد لحظة end (end نفسها مش داخلة)
function inSpan(list, from, end) { const a = dayStart(from).getTime(), b = end.getTime(); return list.filter((x) => { const t = x.at.getTime(); return t >= a && t < b; }); }
// آخر لحظة في فترة المقارنة: آخر اليوم، أو لحد نفس الساعة لو الفترة الحالية فيها النهارده
const spanEnd = (to, live, now) => (live ? new Date(dayStart(to).getTime() + (now - dayStart(now))) : addDays(to, 1));
function comparePeriod(from, to, month = false, now = new Date()) {
  const p = prevPeriod(from, to, month), live = sameDay(to, now);
  return { from: p.from, to: p.to, partial: p.partial, live, end: spanEnd(p.to, live, now) };
}
// نفس الفترة السنة اللي فاتت (ولحد نفس اليوم والساعة لو الفترة فيها النهارده)
function yearAgo(from, to, now = new Date()) {
  const f = new Date(from.getFullYear() - 1, from.getMonth(), from.getDate());
  let t = new Date(to.getFullYear() - 1, to.getMonth(), to.getDate());
  if (t.getMonth() !== to.getMonth()) t = monthEnd(new Date(to.getFullYear() - 1, to.getMonth(), 1)); // 29 فبراير
  const live = sameDay(to, now);
  return { from: f, to: t, live, end: spanEnd(t, live, now) };
}

/* --- البيّاعين وطرق الدفع، وكل عنصر بتغيّره --- */
function bySeller(rows) {
  const m = new Map();
  for (const r of rows) { const k = r.x.sellerId, e = m.get(k) || { id: k, sales: 0, profit: 0, invoices: 0 }; e.sales += rowAmount(r); e.profit += rowProfit(r); e.invoices++; m.set(k, e); }
  return [...m.values()].map((e) => ({ ...e, avg: Math.round(e.sales / e.invoices) })).sort((a, b) => b.sales - a.sales);
}
// من مدفوعات الفاتورة نفسها (الفاتورة ممكن تتدفع بطريقتين)، فالمجموع = إجمالي الفواتير
function byMethod(rows) {
  const m = new Map();
  for (const r of rows) for (const p of r.x.payments) { const e = m.get(p.method) || { id: p.method, amount: 0, count: 0 }; e.amount += p.amount; e.count++; m.set(p.method, e); }
  return [...m.values()].sort((a, b) => b.amount - a.amount);
}
// before = قيمته في الفترة اللي قبلها، وch = التغيير٪ (null لو ماكانش موجود)
function withChange(now, before, key = 'id', val = 'sales') {
  const m = new Map(before.map((e) => [e[key], e]));
  return now.map((e) => { const b = m.get(e[key]); return { ...e, before: b ? b[val] : 0, ch: b ? pct(e[val], b[val]) : null }; });
}

/* --- تقرير الشهر والتقييم --- */
const TH = { sales: 3, avg: 5, margin: 1, cat: 10 }; // حدود «كويس / خلي بالك» (٪، والهامش بالنقطة)
const toneOf = (ch, th) => (ch === null ? 'info' : ch >= th ? 'good' : ch <= -th ? 'warn' : 'info');
// تقرير شهر من السجل: الإجماليات، والمقارنة بالشهر اللي فات وبنفس الشهر السنة اللي فاتت، والمتوقع،
// ويوم بيوم، والتصنيفات والأصناف والبيّاعين وطرق الدفع بتغيّرهم، وآخر 12 شهر، والتقييم. الشاشة بتعرض بس
function monthReport(list, month, now = new Date()) {
  const from = monthStart(month), last = monthEnd(month), today = dayStart(now);
  const to = last > today ? today : last, live = sameDay(to, now);
  const rows = asRows(inRange(list, from, to)), T = totalsOf(rows);
  const P = comparePeriod(from, to, true, now), pRows = asRows(inSpan(list, P.from, P.end)), PT = totalsOf(pRows);
  const Y = yearAgo(from, to, now), yRows = asRows(inSpan(list, Y.from, Y.end)), YT = yRows.length ? totalsOf(yRows) : null;
  const days = byDay(rows, from, to), done = live ? days.slice(0, -1) : days;
  const doneSales = done.reduce((a, d) => a + d.sales, 0), perDay = done.length ? Math.round(doneSales / done.length) : 0;
  const projection = live && done.length ? perDay * daysIn(from, last) : null;
  const units = (rs, cat) => rs.reduce((a, r) => a + r.lines.filter((l) => l.imei && (!cat || l.cat === cat)).reduce((b, l) => b + l.qty, 0), 0);
  const phones = { all: units(rows), fresh: units(rows, 'phones'), used: units(rows, 'used'), before: units(pRows) };
  const cats = withChange(byCategory(rows).map(({ subs, ...e }) => e), byCategory(pRows).map(({ subs, ...e }) => e));
  const products = withChange(byProduct(rows), byProduct(pRows), 'name');
  const sellers = withChange(bySeller(rows), bySeller(pRows));
  const methods = withChange(byMethod(rows), byMethod(pRows), 'id', 'amount');
  // آخر 12 شهر لحد الشهر ده. الترتيب بمتوسط اليوم، عشان الشهر اللي لسه ماخلصش والشهور القصيرة يتقارنوا صح
  const key = monthKey(from), months = byMonth(list).filter((m) => m.from <= from).slice(-12)
    .map((m) => ({ ...m, perDay: m.key === key ? perDay : Math.round(m.sales / daysIn(m.from, monthEnd(m.from))), live: m.key === key && live }));
  const rank = done.length ? 1 + months.filter((m) => m.key !== key && m.perDay > perDay).length : null;
  // التقييم: حقائق من الأرقام، كل واحدة كويسة أو محتاجة انتباه أو معلومة
  const notes = [], add = (k, tone, data = {}) => notes.push({ key: k, tone, ...data });
  const chSales = PT.sales ? pct(T.sales, PT.sales) : null;
  add('sales', toneOf(chSales, TH.sales), { ch: chSales });
  if (YT) { const ch = pct(T.sales, YT.sales); add('yoy', toneOf(ch, TH.sales), { ch }); }
  const mNow = T.sales ? (T.profit / T.sales) * 100 : 0, mBefore = PT.sales ? (PT.profit / PT.sales) * 100 : 0;
  // نسبة الموبايلات من المبيعات: لو اتغيرت كتير فهي غالبًا سبب تغيّر الهامش (هامش الموبايل أقل من الإكسسوار)
  const phoneShare = (rs, t) => (t.sales ? Math.round((rs.reduce((a, r) => a + r.lines.filter((l) => l.imei).reduce((b, l) => b + l.price * l.qty, 0), 0) / t.sales) * 100) : 0);
  const mix = { now: phoneShare(rows, T), before: phoneShare(pRows, PT) };
  if (PT.sales && Math.abs(mNow - mBefore) >= TH.margin) {
    const down = mNow < mBefore, why = (down && mix.now - mix.before >= 5) || (!down && mix.before - mix.now >= 5);
    add('margin', down ? 'warn' : 'good', { now: Math.round(mNow), before: Math.round(mBefore), mix: why ? mix : null });
  }
  const chAvg = PT.avg ? pct(T.avg, PT.avg) : null;
  if (chAvg !== null && Math.abs(chAvg) >= TH.avg) add('avg', chAvg > 0 ? 'good' : 'warn', { ch: chAvg, now: T.avg });
  const movers = cats.filter((c) => c.ch !== null && c.before >= Math.max(1000, PT.sales * 0.02));
  const up = movers.reduce((a, c) => (!a || c.ch > a.ch ? c : a), null), down = movers.reduce((a, c) => (!a || c.ch < a.ch ? c : a), null);
  if (up && up.ch >= TH.cat) add('catUp', 'good', { id: up.id, ch: up.ch });
  if (down && down.ch <= -TH.cat) add('catDown', 'warn', { id: down.id, ch: down.ch });
  // الخصم والآجل بنسبتهم من المبيعات، مش بالمبلغ: شهر فيه موبايلات أكتر طبيعي خصوماته تزيد. ومن غير شهر قبله مفيش حكم
  const disc = rows.reduce((a, r) => a + r.x.disc, 0), discBefore = pRows.reduce((a, r) => a + r.x.disc, 0);
  const rate = (v, t) => (t.sales ? (v / t.sales) * 100 : 0);
  if (PT.sales && disc - discBefore >= 500 && rate(disc, T) - rate(discBefore, PT) >= 0.3) add('disc', 'warn', { now: disc, before: discBefore });
  const credit = (methods.find((m) => m.id === 'credit') || { amount: 0, before: 0 });
  if (PT.sales && credit.amount >= T.sales * 0.02 && rate(credit.amount, T) - rate(credit.before, PT) >= 0.5) add('credit', 'warn', { now: credit.amount, before: credit.before });
  if (products.length) add('top', 'info', { name: products[0].name, qty: products[0].qty, sales: products[0].sales });
  const best = days.reduce((a, d) => (d.sales > a.sales ? d : a), days[0]);
  if (best && best.sales) add('bestDay', 'info', { day: best.day, sales: best.sales });
  const wd = [0, 0, 0, 0, 0, 0, 0]; for (const d of days) wd[d.day.getDay()] += d.sales;
  const top2 = wd.map((v, i) => [i, v]).sort((a, b) => b[1] - a[1]).slice(0, 2);
  if (T.sales && days.length >= 14) add('weekdays', 'info', { days: top2.map(([i]) => i), share: Math.round(((top2[0][1] + top2[1][1]) / T.sales) * 100) });
  if (sellers.length > 1 && T.sales) add('seller', 'info', { id: sellers[0].id, share: Math.round((sellers[0].sales / T.sales) * 100) });
  const of = months.length;
  const verdict = rank === null ? { key: 'early', tone: 'info' } : of < 3 ? { key: 'few', tone: 'info' } : rank === 1 ? { key: 'best', tone: 'good' } : rank <= 3 ? { key: 'top3', tone: 'good' } : of >= 6 && rank > of - 3 ? { key: 'low3', tone: 'warn' } : { key: 'mid', tone: 'info' };
  return { from, to, last, live, rows, T, P, PT, Y, YT, days, done: done.length, perDay, projection, phones, mix, cats, products, sellers, methods, months, rank, of, verdict, notes, disc };
}

/* --- المخزن: التكلفة بعد الاستلام بالمتوسط المرجح المتحرك (ADR-002) --- */
// (قيمة الرصيد + قيمة الاستلام) ÷ العدد الجديد، والكسر لفوق زي البرنامج الحقيقي (domain/costing/moving_average.rs):
// تقريب لفوق بيقلّل الربح قرش ولا يعمل ربح وهمي. الرصيد بالسالب بيتحسب صفر
function receiveCost(stock, avg, qty, unitCost) {
  const q0 = Math.max(0, stock), q = q0 + qty;
  return q > 0 ? Math.ceil((q0 * avg + qty * unitCost) / q) : unitCost;
}

/* --- سجل المبيعات: البيعة اللي خلصت بتتضاف، والتقارير والموبايل بيتحسبوا من السجل --- */
// البيعة اللي خلصت ← سطر في السجل بنفس شكل الفواتير التجريبية (والخدمات زي تسليم الصيانة تصنيفها «svc»)
function histRecord(sale) {
  return {
    no: sale.no, at: sale.at, sellerId: sale.seller.id, customerId: sale.customer ? sale.customer.id : null, session: true,
    lines: sale.lines.map((l) => { const p = l.pid ? prod(l.pid) : null; return { pid: p ? p.id : null, name: l.name, cat: p ? p.cat : 'svc', qty: l.qty || 1, price: l.price, cost: p ? p.cost : 0, imei: l.imei || null, warranty: l.warranty || 0 }; }),
    disc: sale.disc || 0, total: sale.total, profit: sale.profit, payments: sale.payments.map((x) => ({ method: x.method, amount: x.amount, provider: x.provider || '' })),
  };
}
// تقسيم طرق الدفع بالنسبة: الألوان 5 درجات بس من لون المحل (styles.css: --c0…--c4)، فلو الطرق أكتر من 5
// الأصغر بيتجمعوا في «تاني» (يوم فيه الست طرق كان الجزء السادس بيطلع من غير لون). المجموع 100 دايمًا
function paySplit(pay, max = 5) {
  const sum = Object.values(pay).reduce((a, v) => a + v, 0);
  let rows = Object.entries(pay).sort((a, b) => b[1] - a[1]);
  if (rows.length > max) rows = [...rows.slice(0, max - 1), ['تاني', rows.slice(max - 1).reduce((a, r) => a + r[1], 0)]];
  const split = rows.map(([name, v]) => ({ name, v: sum ? Math.round((v / sum) * 100) : 0 }));
  if (split.length) split[0].v += 100 - split.reduce((a, p) => a + p.v, 0);
  return split;
}
// أرقام التقارير والموبايل بتتحسب من السجل (عدادات الخدمات زي ما هي: مش فواتير بيع)
function refreshDash() {
  const D = DATA.dash, now = new Date(), today = dayStart(now);
  const t = { sales: 0, invoices: 0, profit: 0, yesterday: 0, bySeller: {}, countBySeller: {}, services: D.today.services, servicesFee: D.today.servicesFee };
  const week = [0, 0, 0, 0, 0, 0, 0], pay = {}, top = {}, todays = [];
  const ySame = spanEnd(addDays(today, -1), true, now); // امبارح لحد نفس الساعة: النهارده لسه ماخلصش
  for (const x of DATA.history) {
    const back = Math.round((today - dayStart(x.at)) / 864e5);
    if (back >= 0 && back < 7) week[6 - back] += x.total;
    if (back === 1 && x.at < ySame) t.yesterday += x.total;
    if (back !== 0) continue;
    todays.push(x); t.sales += x.total; t.invoices++; t.profit += x.profit;
    t.bySeller[x.sellerId] = (t.bySeller[x.sellerId] || 0) + x.total; t.countBySeller[x.sellerId] = (t.countBySeller[x.sellerId] || 0) + 1;
    for (const p of x.payments) { const n = methodName(p.method); pay[n] = (pay[n] || 0) + p.amount; }
    for (const l of x.lines) { const r = top[l.name] || (top[l.name] = [l.name, 0, 0]); r[1] += l.qty; r[2] += l.price * l.qty; }
  }
  const split = paySplit(pay);
  Object.assign(D, {
    today: { ...t, vsYesterday: t.yesterday ? pct(t.sales, t.yesterday) : null }, week, pay: split, top: Object.values(top).sort((a, b) => b[1] - a[1] || b[2] - a[2]).slice(0, 5),
    recent: todays.slice().reverse().slice(0, 8).map((x) => {
      const u = DATA.users.find((y) => y.id === x.sellerId), c = DATA.customers.find((y) => y.id === x.customerId);
      return { no: x.no, at: fmtTime(x.at), seller: u ? u.name : '', sellerId: x.sellerId, customer: c ? c.name : 'نقدي', method: payLabel(x.payments), total: x.total, fresh: !!x.session };
    }),
  });
}
