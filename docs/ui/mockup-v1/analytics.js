'use strict';
/* ===== طبقة الحسابات: كل أرقام المبيعات بتتحسب هنا بس =====
   التقارير وشاشة المبيعات والموبايل بيعرضوا بس، والأرقام كلها من سجل الفواتير DATA.history.
   الدوال دي من غير رسم ولا DOM، فبتتفحص من غير متصفح (tools/unit.mjs). الدليل: docs/ENGINEERING.md */

/* --- التواريخ --- */
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const sameDay = (a, b) => dayStart(a).getTime() === dayStart(b).getTime();
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthStart = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const monthEnd = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const daysIn = (from, to) => Math.round((dayStart(to) - dayStart(from)) / 864e5) + 1;
// نسبة التغيير (٪) — null لو مفيش أساس للمقارنة
const pct = (now, before) => (before ? Math.round(((now - before) / before) * 100) : null);
// الفواتير في فترة، والطرفين محسوبين (من أول يوم from لآخر يوم to)
function inRange(list, from, to) { const a = dayStart(from).getTime(), b = addDays(to, 1).getTime(); return list.filter((x) => { const t = x.at.getTime(); return t >= a && t < b; }); }
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

/* --- سجل المبيعات: البيعة اللي خلصت بتتضاف، والتقارير والموبايل بيتحسبوا من السجل --- */
// البيعة اللي خلصت ← سطر في السجل بنفس شكل الفواتير التجريبية (والخدمات زي تسليم الصيانة تصنيفها «svc»)
function histRecord(sale) {
  return {
    no: sale.no, at: sale.at, sellerId: sale.seller.id, customerId: sale.customer ? sale.customer.id : null, session: true,
    lines: sale.lines.map((l) => { const p = l.pid ? prod(l.pid) : null; return { pid: p ? p.id : null, name: l.name, cat: p ? p.cat : 'svc', qty: l.qty || 1, price: l.price, cost: p ? p.cost : 0, imei: l.imei || null, warranty: l.warranty || 0 }; }),
    disc: sale.disc || 0, total: sale.total, profit: sale.profit, payments: sale.payments.map((x) => ({ method: x.method, amount: x.amount, provider: x.provider || '' })),
  };
}
// أرقام التقارير والموبايل بتتحسب من السجل (عدادات الخدمات زي ما هي: مش فواتير بيع)
function refreshDash() {
  const D = DATA.dash, now = new Date(), today = dayStart(now);
  const t = { sales: 0, invoices: 0, profit: 0, yesterday: 0, bySeller: {}, countBySeller: {}, services: D.today.services, servicesFee: D.today.servicesFee };
  const week = [0, 0, 0, 0, 0, 0, 0], pay = {}, top = {}, todays = [], month = { phones: 0, accessories: 0 };
  const pm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  for (const x of DATA.history) {
    const back = Math.round((today - dayStart(x.at)) / 864e5);
    if (back >= 0 && back < 7) week[6 - back] += x.total;
    if (back === 1) t.yesterday += x.total;
    if (x.at.getFullYear() === pm.getFullYear() && x.at.getMonth() === pm.getMonth()) for (const l of x.lines) { if (l.cat === 'phones' || l.cat === 'used') month.phones += l.price * l.qty; else if (l.cat !== 'svc') month.accessories += l.price * l.qty; }
    if (back !== 0) continue;
    todays.push(x); t.sales += x.total; t.invoices++; t.profit += x.profit;
    t.bySeller[x.sellerId] = (t.bySeller[x.sellerId] || 0) + x.total; t.countBySeller[x.sellerId] = (t.countBySeller[x.sellerId] || 0) + 1;
    for (const p of x.payments) { const n = methodName(p.method); pay[n] = (pay[n] || 0) + p.amount; }
    for (const l of x.lines) { const r = top[l.name] || (top[l.name] = [l.name, 0, 0]); r[1] += l.qty; r[2] += l.price * l.qty; }
  }
  const paySum = Object.values(pay).reduce((a, v) => a + v, 0);
  const split = Object.entries(pay).sort((a, b) => b[1] - a[1]).map(([name, v]) => ({ name, v: paySum ? Math.round((v / paySum) * 100) : 0 }));
  if (split.length) split[0].v += 100 - split.reduce((a, p) => a + p.v, 0);
  Object.assign(D, {
    today: t, week, pay: split, top: Object.values(top).sort((a, b) => b[1] - a[1] || b[2] - a[2]).slice(0, 5),
    month: { label: new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric' }).format(pm), phones: month.phones, accessories: month.accessories, ops: D.month.ops },
    recent: todays.slice().reverse().slice(0, 8).map((x) => {
      const u = DATA.users.find((y) => y.id === x.sellerId), c = DATA.customers.find((y) => y.id === x.customerId);
      return { no: x.no, at: fmtTime(x.at), seller: u ? u.name : '', sellerId: x.sellerId, customer: c ? c.name : 'نقدي', method: payLabel(x.payments), total: x.total, fresh: !!x.session };
    }),
  });
}
