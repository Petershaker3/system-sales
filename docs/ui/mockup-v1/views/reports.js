'use strict';
// شاشة «التقارير». الكود متقسم ملف لكل شاشة — الترتيب في index.html، والدليل: docs/ENGINEERING.md
/* ===== التقارير (للمالك) ===== */
const kpi = (label, value, sub) => `<div class="card kpi"><div class="label">${label}</div><div class="value num">${value}</div>${sub}</div>`;
function viewDashboard() {
  const d = DATA.dash, t = d.today, vsY = Math.round(((t.sales - t.yesterday) / t.yesterday) * 100), maxW = Math.max(...d.week);
  const days = d.week.map((v, i) => { const dt = new Date(); dt.setDate(dt.getDate() - (6 - i)); return [i === 6 ? 'النهارده' : fmtDay(dt), v]; });
  return `<div class="page">
    <div class="page-h"><h2>التقارير</h2><span class="sub">${fmtLong()}</span><span class="sp"></span>
      <button type="button" class="btn" data-act="soon">${icon('download')} تصدير Excel</button><button type="button" class="btn" data-act="soon">${icon('printer')} طباعة</button></div>
    <div class="cards">
      ${kpi('مبيعات النهارده', money(t.sales), `<div class="sub ${vsY >= 0 ? 'ok-t' : 'danger-t'}">${icon(vsY >= 0 ? 'trending-up' : 'trending-down')} ${num(Math.abs(vsY))}% عن امبارح</div>`)}
      ${kpi('عدد الفواتير', num(t.invoices), `<div class="sub muted">متوسط الفاتورة ${money(Math.round(t.sales / t.invoices))}</div>`)}
      ${kpi('الربح', money(t.profit), `<div class="sub muted">هامش ${num(Math.round((t.profit / t.sales) * 100))}%</div>`)}
      ${kpi('خدمات المحافظ والفواتير', num(t.services), `<div class="sub muted">عمولات ${money(t.servicesFee)}</div>`)}
      ${kpi('المفروض في الدرج', money(expectedCash()), `<div class="sub muted">وردية #${num(DATA.shift.no)}</div>`)}
    </div>
    <div class="dash-grid">
      <div class="card"><h3>المبيعات آخر 7 أيام</h3>
        <div class="bars">${days.map(([l, v], i) => `<div class="bar-col"><span class="bv num">${num(Math.round(v / 100) / 10)}k</span><div class="bar ${i === 6 ? 'today' : ''}" style="height:${Math.max(4, Math.round((v / maxW) * 100))}%"></div><span class="bl">${l}</span></div>`).join('')}</div></div>
      <div class="card"><h3>طرق الدفع النهارده</h3>
        <div class="split">${d.pay.map((p, i) => `<i style="width:${p.v}%;background:var(--c${i})"></i>`).join('')}</div>
        ${d.pay.map((p, i) => `<div class="li"><span class="dot" style="background:var(--c${i})"></span>${p.name}<span class="sp"></span><b class="num">${num(p.v)}%</b></div>`).join('')}</div>
    </div>
    <div class="dash-grid">
      <div class="card"><h3>آخر الفواتير</h3>
        <div class="table-wrap" style="border:0"><table class="t"><thead><tr><th>رقم</th><th>الوقت</th><th>البيّاع</th><th>العميل</th><th>الدفع</th><th>المبلغ</th></tr></thead>
        <tbody>${d.recent.slice(0, 7).map((r) => `<tr class="hov"><td class="num">${dg(r.no)}</td><td>${dg(r.at)}</td><td>${esc(r.seller)}</td><td>${esc(r.customer)}</td><td>${esc(r.method)}</td><td><b class="num">${money(r.total)}</b></td></tr>`).join('')}</tbody></table></div></div>
      <div class="stack">
        <div class="card"><h3>الأكثر مبيعًا النهارده</h3>${d.top.map(([n, q, v], i) => `<div class="li"><span class="rank">${num(i + 1)}</span><bdi dir="rtl" class="ell">${esc(n)}</bdi><span class="sp"></span><span class="muted num">${num(q)} قطعة</span><b class="num">${money(v)}</b></div>`).join('')}</div>
        <div class="card"><h3>${d.month.label}</h3>
          <div class="li">موبايلات جديدة<span class="sp"></span><b class="num">${money(d.month.phones)}</b></div>
          <div class="li">إكسسوارات<span class="sp"></span><b class="num">${money(d.month.accessories)}</b></div>
          <div class="li">عدد العمليات<span class="sp"></span><b class="num">${num(d.month.ops)}</b></div></div>
      </div>
    </div>
  </div>`;
}
VIEWS.dashboard = viewDashboard;
