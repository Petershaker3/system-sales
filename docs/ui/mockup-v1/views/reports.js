'use strict';
// شاشة «التقارير». الكود متقسم ملف لكل شاشة — الترتيب في index.html، والدليل: docs/ENGINEERING.md
/* ===== التقارير (للمالك): «النهارده»، و«الشهر» بمقارناته وتقييمه (docs/ui/MONTHS-REPORTS-RECEIVING.md) =====
   الأرقام كلها من طبقة الحسابات (analytics.js: refreshDash و monthReport). هنا عرض بس. */
const kpi = (label, value, sub) => `<div class="card kpi"><div class="label">${label}</div><div class="value num">${value}</div>${sub}</div>`;
const repState = () => S.rep || (S.rep = { tab: 'today', month: monthStart(new Date()) });
// التغيير: سهم ولون ونسبة، و«عن إيه». مفيش أساس للمقارنة = مفيش سطر
const chgLine = (ch, what) => (ch === null ? '' : `<div class="sub ${ch >= 0 ? 'ok-t' : 'danger-t'}">${icon(ch >= 0 ? 'trending-up' : 'trending-down')} ${num(Math.abs(ch))}% عن ${what}</div>`);
// في الجداول: صفر من غير سهم، وزيادة كبيرة على أساس صغير بالأضعاف (×79) بدل ٪ مالهاش معنى
const chgCell = (ch) => (ch === null ? '<span class="muted">جديد</span>' : ch === 0 ? '<span class="ch muted">0%</span>'
  : `<span class="ch ${ch > 0 ? 'ok-t' : 'danger-t'}">${icon(ch > 0 ? 'trending-up' : 'trending-down')}${ch >= 300 ? `×${num(Math.round(ch / 100 + 1))}` : `${num(Math.abs(ch))}%`}</span>`);
// «آخر 7 شهور» و«آخر 12 شهر»
const nMonths = (n) => `${num(n)} ${n >= 3 && n <= 10 ? 'شهور' : 'شهر'}`;
// فوق الأعمدة: «2.37 مليون» و«171.5 ألف»
const kShort = (v) => (v >= 1e6 ? `${num(Math.round(v / 1e4) / 100)} مليون` : v >= 1e3 ? `${num(Math.round(v / 100) / 10)} ألف` : num(v));
const userName = (id) => { const u = DATA.users.find((x) => x.id === id); return u ? u.name : ''; };
const weekdayName = (i) => fmtDay(new Date(2024, 0, 7 + i)); // 7 يناير 2024 كان حد

function viewDashboard() {
  const st = repState();
  return `<div class="page">
    <div class="page-h"><h2>التقارير</h2>
      <div class="seg" role="tablist" aria-label="نوع التقرير">${[['today', 'النهارده'], ['month', 'الشهر']].map(([id, l]) => `<button type="button" role="tab" aria-selected="${st.tab === id}" class="${st.tab === id ? 'on' : ''}" data-act="repTab" data-id="${id}">${l}</button>`).join('')}</div>
      <span class="sub">${st.tab === 'today' ? fmtLong() : 'الشهر كله ومقارنته وتقييمه'}</span><span class="sp"></span>
      <button type="button" class="btn" data-act="soon">${icon('download')} تصدير Excel</button><button type="button" class="btn" data-act="soon">${icon('printer')} طباعة</button></div>
    ${st.tab === 'month' ? repMonth(st) : repToday()}
  </div>`;
}

/* --- النهارده --- */
function repToday() {
  const d = DATA.dash, t = d.today, maxW = Math.max(1, ...d.week), M = monthReport(DATA.history, new Date());
  const days = d.week.map((v, i) => { const dt = new Date(); dt.setDate(dt.getDate() - (6 - i)); return [i === 6 ? 'النهارده' : fmtDay(dt), v]; });
  const vsM = M.PT.sales ? pct(M.T.sales, M.PT.sales) : null;
  return `<div class="cards">
      ${kpi('مبيعات النهارده', money(t.sales), chgLine(t.vsYesterday, 'امبارح لنفس الساعة'))}
      ${kpi('عدد الفواتير', num(t.invoices), `<div class="sub muted">متوسط الفاتورة ${money(t.invoices ? Math.round(t.sales / t.invoices) : 0)}</div>`)}
      ${kpi('الربح', money(t.profit), `<div class="sub muted">هامش ${num(t.sales ? Math.round((t.profit / t.sales) * 100) : 0)}%</div>`)}
      ${kpi('خدمات المحافظ والفواتير', num(t.services), `<div class="sub muted">عمولات ${money(t.servicesFee)}</div>`)}
      ${kpi('المفروض في الدرج', money(expectedCash()), `<div class="sub muted">وردية #${num(DATA.shift.no)}</div>`)}
    </div>
    <div class="dash-grid">
      <div class="card"><h3>المبيعات آخر 7 أيام</h3>
        <div class="bars">${days.map(([l, v], i) => `<div class="bar-col"><span class="bv num">${kShort(v)}</span><div class="bar ${i === 6 ? 'today' : ''}" style="height:${Math.max(4, Math.round((v / maxW) * 100))}%"></div><span class="bl">${l}</span></div>`).join('')}</div></div>
      <div class="card"><h3>طرق الدفع النهارده</h3>
        <div class="split">${d.pay.map((p, i) => `<i style="width:${p.v}%;background:var(--c${i})"></i>`).join('')}</div>
        ${d.pay.map((p, i) => `<div class="li"><span class="dot" style="background:var(--c${i})"></span>${p.name}<span class="sp"></span><b class="num">${num(p.v)}%</b></div>`).join('')}</div>
    </div>
    <div class="dash-grid">
      <div class="card"><h3>آخر الفواتير</h3>
        <div class="table-wrap" style="border:0"><table class="t"><thead><tr><th>رقم</th><th>الوقت</th><th>البيّاع</th><th>العميل</th><th>الدفع</th><th>المبلغ</th></tr></thead>
        <tbody>${d.recent.slice(0, 7).map((r) => `<tr class="hov"><td class="num">${dg(r.no)}</td><td>${dg(r.at)}</td><td>${esc(r.seller)}</td><td>${esc(r.customer)}</td><td>${esc(r.method)}</td><td><b class="num">${money(r.total)}</b></td></tr>`).join('')}</tbody></table></div></div>
      <div class="stack">
        <div class="card"><h3>الأكثر مبيعًا النهارده</h3>${d.top.map(([n, q, v], i) => `<div class="li"><span class="rank">${num(i + 1)}</span><bdi dir="rtl" class="ell">${esc(n)}</bdi><span class="sp"></span><span class="muted num">${pcsWord(q)}</span><b class="num">${money(v)}</b></div>`).join('')}</div>
        <div class="card"><h3>${esc(fmtMonth(M.from))} لحد النهارده</h3>
          <div class="li">المبيعات<span class="sp"></span><b class="num">${money(M.T.sales)}</b></div>
          <div class="li">عن نفس الوقت من ${esc(monthName(M.P.from))}<span class="sp"></span>${chgCell(vsM)}</div>
          <div class="li">المتوقع لآخر الشهر<span class="sp"></span><b class="num">${M.projection ? money(M.projection) : '—'}</b></div>
          <button type="button" class="btn ghost rep-more" data-act="repTab" data-id="month">${icon('chart-column')} تقرير الشهر كامل</button></div>
      </div>
    </div>`;
}

/* --- الشهر --- */
function repMonth(st) {
  const R = monthReport(DATA.history, st.month), T = R.T, today = dayStart(new Date());
  const firstMonth = DATA.history.length ? monthStart(DATA.history[0].at) : monthStart(today);
  const atFirst = R.from.getTime() <= firstMonth.getTime(), atLast = sameMonth(R.from, today);
  const vsPrev = R.P.live ? `نفس الوقت من ${monthName(R.P.from)}` : monthName(R.P.from);
  const vsYear = R.Y.live ? `نفس الوقت من ${fmtMonth(R.Y.from)}` : fmtMonth(R.Y.from);
  const chSales = R.PT.sales ? pct(T.sales, R.PT.sales) : null, mrg = T.sales ? Math.round((T.profit / T.sales) * 100) : 0;
  const months = byMonth(DATA.history).reverse();
  const monthSel = `<select class="sv-sel sv-month" data-change="repMonth" aria-label="اختار شهر"><option value="" selected>اختار شهر</option>${months.map((m) => `<option value="${m.key}">${fmtMonth(m.from)}${monthKey(R.from) === m.key ? ' (المعروض)' : ''}</option>`).join('')}</select>`;
  const title = `${fmtMonth(R.from)}${R.live ? ' (لحد النهارده)' : ''}`;

  // التقييم
  const V = { best: `أحسن شهر في آخر ${nMonths(R.of)}`, top3: `من أحسن 3 شهور في آخر ${nMonths(R.of)}: ترتيبه ${num(R.rank)}`, low3: `من أضعف 3 شهور في آخر ${nMonths(R.of)}: ترتيبه ${num(R.rank)}`,
    mid: `شهر متوسط: ترتيبه ${num(R.rank)} من ${num(R.of)}`, early: 'لسه بدري نحكم على الشهر ده', few: 'مفيش شهور كفاية قبله نقارن بيها' }[R.verdict.key];
  const near = (ch) => Math.abs(ch) < TH.sales;
  const text = (n) => {
    switch (n.key) {
      case 'sales': return n.ch === null ? 'مفيش شهر قبله في السجل نقارن بيه' : near(n.ch) ? `المبيعات قريبة من ${vsPrev}` : `المبيعات ${n.ch > 0 ? 'زادت' : 'قلّت'} ${num(Math.abs(n.ch))}% عن ${vsPrev}`;
      case 'yoy': return near(n.ch) ? `قريبة من ${vsYear}` : `${n.ch > 0 ? 'وزادت' : 'وقلّت'} ${num(Math.abs(n.ch))}% عن ${vsYear}`;
      case 'margin': return `هامش الربح ${n.now > n.before ? 'طلع' : 'نزل'} من ${num(n.before)}% لـ ${num(n.now)}%${n.mix ? `، لأن الموبايلات بقت ${num(n.mix.now)}% من المبيعات (كانت ${num(n.mix.before)}%)` : ''}`;
      case 'avg': return `متوسط الفاتورة ${n.ch > 0 ? 'زاد' : 'قلّ'} ${num(Math.abs(n.ch))}%: بقى ${money(n.now)}`;
      case 'catUp': return `مبيعات «${esc(svCatName(n.id))}» زادت ${num(n.ch)}%`;
      case 'catDown': return `مبيعات «${esc(svCatName(n.id))}» قلّت ${num(Math.abs(n.ch))}%`;
      case 'disc': return `الخصومات زادت: ${money(n.now)} (كانت ${money(n.before)})`;
      case 'credit': return `الآجل زاد: ${money(n.now)} (كان ${money(n.before)})، يعني فلوس لسه برّه المحل`;
      case 'top': return `أكتر صنف جاب فلوس: <bdi dir="rtl">${esc(n.name)}</bdi> (${pcsWord(n.qty)}، ${money(n.sales)})`;
      case 'bestDay': return `أعلى يوم: ${fmtDayDate(n.day)} (${money(n.sales)})`;
      case 'weekdays': return `${weekdayName(n.days[0])} و${weekdayName(n.days[1])} عملوا ${num(n.share)}% من المبيعات`;
      case 'seller': return `${esc(userName(n.id))} عمل ${num(n.share)}% من المبيعات`;
      default: return '';
    }
  };
  const toneTag = (tone) => (tone === 'good' ? '<span class="tag ok">كويس</span>' : tone === 'warn' ? '<span class="tag warn">خلي بالك</span>' : '<span class="tag">معلومة</span>');
  const evaluation = `<div class="card ev"><h3>التقييم</h3>
      <div class="ev-verdict ${R.verdict.tone}">${icon(R.verdict.tone === 'good' ? 'trending-up' : R.verdict.tone === 'warn' ? 'trending-down' : 'chart-column')}<div><b>${V}</b>${R.rank ? `<small>الترتيب بمتوسط مبيعات اليوم${R.live ? '، من غير النهارده' : ''}</small>` : ''}</div></div>
      ${R.notes.map((n) => `<div class="ev-li" data-note="${n.key}" data-tone="${n.tone}">${toneTag(n.tone)}<span>${text(n)}</span></div>`).join('')}</div>`;

  // يوم بيوم: الشهر كله، والأيام اللي لسه ماجتش فاضية
  const byIso = new Map(R.days.map((x) => [isoDay(x.day), x])), maxD = Math.max(1, ...R.days.map((x) => x.sales));
  const best = R.days.reduce((a, x) => (x.sales > a.sales ? x : a), R.days[0]);
  const cols = [];
  for (let d = R.from; d <= R.last; d = addDays(d, 1)) {
    const x = byIso.get(isoDay(d));
    cols.push(x ? `<button type="button" class="bar-col" data-act="repDay" data-d="${isoDay(d)}" title="${fmtDayDate(d)}: ${money(x.sales)} — افتح فواتيره" aria-label="${fmtDayDate(d)}: ${money(x.sales)}"><span class="bv num">${x === best && x.sales ? kShort(x.sales) : ''}</span><div class="bar ${x === best && x.sales ? 'today' : ''}" style="height:${Math.max(2, Math.round((x.sales / maxD) * 100))}%"></div><span class="bl num">${num(d.getDate())}</span></button>`
      : `<div class="bar-col later" aria-hidden="true"><span class="bv"></span><div class="bar ghost" style="height:6%"></div><span class="bl num">${num(d.getDate())}</span></div>`);
  }
  const daily = `<div class="card"><h3>يوم بيوم<span class="sp"></span><span class="muted rep-hint">دوس على أي يوم تشوف فواتيره</span></h3><div class="bars dense">${cols.join('')}</div></div>`;

  // التفاصيل بتغيّرها عن الشهر اللي فات
  const share = (v, tot) => { const s = tot ? Math.round((v / tot) * 100) : 0; return `<span class="sv-share"><i style="width:${s}%"></i></span><span class="num">${num(s)}%</span>`; };
  const tbl = (head, body) => `<div class="table-wrap" style="border:0"><table class="t sv-t"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  const cats = `<div class="card narrow"><h3>التصنيفات</h3>${tbl('<th>التصنيف</th><th class="ta-n">المبيعات</th><th>النسبة</th><th class="ta-n">التغيير</th>',
    R.cats.map((c) => `<tr><td>${esc(svCatName(c.id))}</td><td class="ta-n num"><b>${money(c.sales)}</b></td><td>${share(c.sales, R.cats.reduce((a, e) => a + e.sales, 0))}</td><td class="ta-n">${chgCell(c.ch)}</td></tr>`).join(''))}</div>`;
  const prods = `<div class="card"><h3>الأصناف الأكتر مبيعًا</h3>${tbl('<th>الصنف</th><th class="ta-n">القطع</th><th class="ta-n">المبيعات</th><th class="ta-n">التغيير</th>',
    R.products.slice(0, 8).map((p) => `<tr><td><bdi dir="rtl">${esc(p.name)}</bdi></td><td class="ta-n num">${num(p.qty)}</td><td class="ta-n num"><b>${money(p.sales)}</b></td><td class="ta-n">${chgCell(p.ch)}</td></tr>`).join(''))}</div>`;
  const sellers = `<div class="card narrow"><h3>البيّاعين</h3>${tbl('<th>البيّاع</th><th class="ta-n">الفواتير</th><th class="ta-n">المبيعات</th><th class="ta-n">متوسط الفاتورة</th><th class="ta-n">التغيير</th>',
    R.sellers.map((u) => `<tr><td>${esc(userName(u.id))}</td><td class="ta-n num">${num(u.invoices)}</td><td class="ta-n num"><b>${money(u.sales)}</b></td><td class="ta-n num">${money(u.avg)}</td><td class="ta-n">${chgCell(u.ch)}</td></tr>`).join(''))}</div>`;
  const methods = `<div class="card narrow"><h3>طرق الدفع</h3>${tbl('<th>الطريقة</th><th class="ta-n">المبلغ</th><th>النسبة</th><th class="ta-n">التغيير</th>',
    R.methods.map((m) => `<tr><td>${esc(methodName(m.id))}</td><td class="ta-n num"><b>${money(m.amount)}</b></td><td>${share(m.amount, T.sales)}</td><td class="ta-n">${chgCell(m.ch)}</td></tr>`).join(''))}</div>`;

  // آخر 12 شهر: أعمدة، والشهر اللي لسه ماخلصش عليه المتوقع متقطّع، وجدول
  const maxM = Math.max(1, ...R.months.map((m) => (m.live && R.projection ? R.projection : m.sales)));
  const mBars = R.months.map((m) => {
    const on = m.key === monthKey(R.from), extra = m.live && R.projection ? Math.max(0, R.projection - m.sales) : 0;
    return `<button type="button" class="bar-col" data-act="repMonthPick" data-m="${m.key}" title="${fmtMonth(m.from)}: ${money(m.sales)}${extra ? ` — المتوقع ${money(R.projection)}` : ''}" aria-label="${fmtMonth(m.from)}: ${money(m.sales)}"><span class="bv num">${kShort(m.live && R.projection ? R.projection : m.sales)}</span>
      <div class="bar-stack" style="height:${Math.max(3, Math.round(((m.sales + extra) / maxM) * 100))}%">${extra ? `<div class="bar ghost" style="flex:${extra}"></div>` : ''}<div class="bar ${on ? 'today' : ''}" style="flex:${m.sales || 1}"></div></div><span class="bl">${monthName(m.from)}</span></button>`;
  }).join('');
  const rowsM = R.months.slice().reverse().map((m, i, arr) => {
    const prevM = arr[i + 1], ch = prevM && !m.live ? pct(m.sales, prevM.sales) : m.live ? chSales : null;
    return `<tr class="hov click ${m.key === monthKey(R.from) ? 'on' : ''}" data-act="repMonthPick" data-m="${m.key}"><td>${fmtMonth(m.from)}${m.live ? ' <span class="muted">(لحد النهارده)</span>' : ''}</td><td class="ta-n num"><b>${money(m.sales)}</b></td><td class="ta-n">${prevM || m.live ? chgCell(ch) : '<span class="muted">—</span>'}</td><td class="ta-n num">${money(m.profit)}</td><td class="ta-n num">${num(m.sales ? Math.round((m.profit / m.sales) * 100) : 0)}%</td><td class="ta-n num">${num(m.invoices)}</td><td class="ta-n num">${money(m.perDay)}</td></tr>`;
  }).join('');
  const year = `<div class="card"><h3>آخر ${nMonths(R.months.length)}</h3><div class="bars months">${mBars}</div>
    ${tbl('<th>الشهر</th><th class="ta-n">المبيعات</th><th class="ta-n">عن اللي قبله</th><th class="ta-n">الربح</th><th class="ta-n">الهامش</th><th class="ta-n">الفواتير</th><th class="ta-n">متوسط اليوم</th>', rowsM)}</div>`;

  return `<div class="sv-bar">
      <div class="day-nav">
        <button type="button" class="icon-btn" data-act="repShift" data-d="-1" ${atFirst ? 'disabled' : ''} title="الشهر اللي قبله (السهم يمين)" aria-label="الشهر اللي قبله">${icon('chevron-right')}</button>
        <span class="day-pick static">${icon('calendar')}<span class="dl">${title}</span></span>
        <button type="button" class="icon-btn" data-act="repShift" data-d="1" ${atLast ? 'disabled' : ''} title="الشهر اللي بعده (السهم شمال)" aria-label="الشهر اللي بعده">${icon('chevron-left')}</button>
      </div>
      ${monthSel}<span class="sp"></span>
      <button type="button" class="btn ghost" data-act="repSales">${icon('receipt-text')} فواتير الشهر</button>
    </div>
    <div class="cards">
      ${kpi('المبيعات', money(T.sales), chgLine(chSales, vsPrev) + (R.YT ? chgLine(pct(T.sales, R.YT.sales), vsYear) : ''))}
      ${kpi('الربح', money(T.profit), `<div class="sub muted">هامش ${num(mrg)}%</div>${chgLine(R.PT.profit ? pct(T.profit, R.PT.profit) : null, vsPrev)}`)}
      ${kpi('عدد الفواتير', num(T.invoices), `<div class="sub muted">متوسط الفاتورة ${money(T.avg)}</div>`)}
      ${kpi('الموبايلات', num(R.phones.all), `<div class="sub muted">جديد ${num(R.phones.fresh)} · مستعمل ${num(R.phones.used)}</div>`)}
      ${R.live ? kpi('المتوقع لآخر الشهر', R.projection ? money(R.projection) : '—', `<div class="sub muted">${R.projection ? `لو فضل متوسط اليوم ${money(R.perDay)}` : 'بيبان بعد أول يوم'}</div>`)
        : kpi('متوسط اليوم', money(R.perDay), `<div class="sub muted">في ${num(R.days.length)} يوم</div>`)}
    </div>
    <div class="dash-grid">${evaluation}<div class="stack">${cats}${sellers}</div></div>
    ${daily}
    <div class="dash-grid">${prods}${methods}</div>
    ${year}`;
}

/* --- التنقل --- */
function repSetMonth(d) {
  const st = repState(), t = new Date(), first = DATA.history.length ? monthStart(DATA.history[0].at) : monthStart(t), m = monthStart(d);
  st.month = m > monthStart(t) ? monthStart(t) : m < first ? first : m; st.tab = 'month'; render();
}
function reportsKey(e) {
  const tg = e.target, typing = tg && (tg.tagName === 'INPUT' || tg.tagName === 'SELECT' || tg.tagName === 'TEXTAREA');
  if (typing || e.ctrlKey || e.metaKey || e.altKey || repState().tab !== 'month') return;
  const m = repState().month;
  if (e.key === 'ArrowRight') { e.preventDefault(); repSetMonth(new Date(m.getFullYear(), m.getMonth() - 1, 1)); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); repSetMonth(new Date(m.getFullYear(), m.getMonth() + 1, 1)); }
}
Object.assign(ACT, {
  repTab: (d) => { repState().tab = d.id; render(); },
  repShift: (d) => { const m = repState().month; repSetMonth(new Date(m.getFullYear(), m.getMonth() + Number(d.d), 1)); },
  repMonthPick: (d) => { const [y, m] = d.m.split('-').map(Number); repSetMonth(new Date(y, m - 1, 1)); },
  // من التقرير لفواتير اليوم أو الشهر في شاشة المبيعات
  repDay: (d) => { const [y, m, dd] = d.d.split('-').map(Number); S.view = 'sales'; S.salesv = null; svSetDay(new Date(y, m - 1, dd)); },
  repSales: () => { S.view = 'sales'; S.salesv = null; svSetMonth(repState().month); },
});
CHANGE.repMonth = (el) => { const [y, m] = el.value.split('-').map(Number); if (y) repSetMonth(new Date(y, m - 1, 1)); };
VIEWS.dashboard = viewDashboard;
