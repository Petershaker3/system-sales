'use strict';
// شاشة «المبيعات». الكود متقسم ملف لكل شاشة — الترتيب في index.html، والدليل: docs/ENGINEERING.md
/* ===== المبيعات: الأيام والفلترة، والعرض بالفواتير أو الأصناف أو التصنيفات (docs/ui/SALES-SHORTAGES.md) ===== */
function salesState() {
  if (!S.salesv) { const t = dayStart(new Date()); S.salesv = { from: t, to: t, range: 'today', q: '', cat: '', seller: '', method: '', view: 'inv', limit: 150 }; }
  return S.salesv;
}
// الفواتير المطابقة في الفترة. فلتر التصنيف أو البحث باسم صنف أو IMEI بيخلّي المطابق هو السطور مش الفاتورة كلها (lineLevel)
// end (اختياري): لحظة النهاية للمقارنة لحد نفس الساعة (analytics.js: comparePeriod)
function salesRows(from, to, end = null) {
  // الأرقام العربي (١٢٣) بتتحوّل الأول، عشان رقم الفاتورة والـ IMEI والتليفون يتلاقوا بأي أرقام
  const v = salesState(), own = isOwner(), raw = toLatin(v.q), q = normalize(raw), qd = raw.replace(/\D/g, '');
  const out = [], list = end ? inSpan(DATA.history, from, end) : inRange(DATA.history, from, to);
  // رقم فاتورة بالظبط بيكسب: الفاتورة دي بس، من غير أجهزة أو تليفونات فيها نفس الأرقام
  const exact = qd && /^\d+$/.test(raw.trim()) ? list.find((x) => String(x.no) === qd) : null;
  for (const x of exact ? [exact] : list) {
    if (!own && x.sellerId !== S.user.id) continue;
    if (own && v.seller && x.sellerId !== v.seller) continue;
    if (v.method && !x.payments.some((p) => p.method === v.method)) continue;
    let lines = x.lines, lineLevel = false;
    if (v.cat) { lines = lines.filter((l) => l.cat === v.cat || catMain(l.cat) === v.cat); lineLevel = true; }
    if (q) {
      const c = DATA.customers.find((y) => y.id === x.customerId);
      const hit = (qd && String(x.no) === qd) || (c && (normalize(c.name).includes(q) || (qd.length >= 4 && c.phone.includes(qd))));
      if (!hit) { lines = lines.filter((l) => normalize(l.name).includes(q) || (qd.length >= 4 && l.imei && l.imei.includes(qd))); lineLevel = true; }
    }
    if (lines.length) out.push({ x, lines, lineLevel });
  }
  return out;
}
// «وصنف كمان»، «وصنفين كمان»، «و3 أصناف كمان»
const moreItems = (k) => (k === 1 ? 'وصنف كمان' : k === 2 ? 'وصنفين كمان' : `و${num(k)} ${k <= 10 ? 'أصناف' : 'صنف'} كمان`);
const itemsSummary = (lines) => { const n = lines.length; return `<bdi dir="rtl">${esc(lines[0].name)}</bdi>${n > 1 ? ` <span class="muted">${moreItems(n - 1)}</span>` : ''}`; };
function viewSales() {
  const v = salesState(), own = isOwner(), today = dayStart(new Date());
  const rows = salesRows(v.from, v.to), T = totalsOf(rows);
  const len = daysIn(v.from, v.to), isMonth = v.range === 'month' || v.range === 'month-x';
  const P = comparePeriod(v.from, v.to, isMonth), prev = own ? totalsOf(salesRows(P.from, P.to, P.end)) : null;
  const ch = prev ? pct(T.sales, prev.sales) : null;
  const atToday = v.to.getTime() >= today.getTime(), atFirst = v.from.getTime() <= svFirstDay().getTime();
  const label = isMonth ? `${fmtMonth(v.from)}${v.range === 'month' ? ' (لحد النهارده)' : ''}` : len === 1 ? fmtLong(v.from) : `من ${fmtDate(v.from)} لحد ${fmtDate(v.to)}`;
  // لو الفترة فيها النهارده فالمقارنة لحد نفس الساعة (زي التقارير بالظبط)
  const vsWhat = len === 1 ? (P.live ? 'امبارح لنفس الساعة' : 'اليوم اللي قبله') : isMonth ? (P.live ? `نفس الوقت من ${monthName(P.from)}` : monthName(P.from)) : 'الفترة اللي قبلها';
  const months = byMonth(DATA.history).reverse();
  // قايمة للنقل بس: العنوان هو اللي بيقول إنت فين، فالقايمة بتفضل «اختار شهر» من غير ما تكرر اسم الشهر
  const monthSel = `<select class="sv-sel sv-month" data-change="svMonth" aria-label="اختار شهر"><option value="" selected>اختار شهر</option>${months.map((m) => `<option value="${m.key}">${fmtMonth(m.from)}${isMonth && monthKey(v.from) === m.key ? ' (المعروض)' : ''}</option>`).join('')}</select>`;
  const ranges = [['today', 'النهارده'], ['yesterday', 'امبارح'], ['week', 'آخر 7 أيام'], ['month', 'الشهر ده']];
  const filtered = !!(v.q || v.cat || v.seller || v.method);
  const mains = SET.cats.filter((c) => !c.parent);
  const catOpts = mains.map((c) => { const subs = SET.cats.filter((s) => s.parent === c.id); return subs.length
    ? `<optgroup label="${esc(c.name)}"><option value="${c.id}" ${v.cat === c.id ? 'selected' : ''}>كل ${esc(c.name)}</option>${subs.map((s) => `<option value="${s.id}" ${v.cat === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</optgroup>`
    : `<option value="${c.id}" ${v.cat === c.id ? 'selected' : ''}>${esc(c.name)}</option>`; }).join('') + `<option value="svc" ${v.cat === 'svc' ? 'selected' : ''}>خدمات وصيانة</option>`;
  const sub = ch === null ? '' : `<div class="sub ${ch >= 0 ? 'ok-t' : 'danger-t'}">${icon(ch >= 0 ? 'trending-up' : 'trending-down')} ${num(Math.abs(ch))}% عن ${vsWhat}</div>`;
  let table;
  if (!rows.length) {
    table = `<div class="sv-empty">${icon('receipt-text')}<b>${filtered ? 'مفيش مبيعات بالفلاتر دي' : len === 1 ? 'مفيش مبيعات في اليوم ده' : isMonth ? 'مفيش مبيعات في الشهر ده' : 'مفيش مبيعات في الفترة دي'}</b>
      <span>${filtered ? 'شيل فلتر أو جرّب يوم تاني.' : 'جرّب يوم تاني بالأسهم أو اختار تاريخ.'}</span>${filtered ? `<button type="button" class="btn sm" data-act="svClear">${icon('x')} مسح الفلاتر</button>` : ''}</div>`;
  } else if (v.view === 'day' && len > 1) {
    const days = byDay(rows, v.from, v.to), top = days.reduce((a, d) => (d.sales > a.sales ? d : a), days[0]), max = top.sales || 1;
    table = `<div class="table-wrap"><table class="t sv-t sv-days"><thead><tr><th>اليوم</th><th class="ta-n">الفواتير</th><th class="ta-n">القطع</th><th class="ta-n">المبيعات</th><th aria-hidden="true"></th>${own ? '<th class="ta-n">الربح</th>' : ''}</tr></thead><tbody>
      ${days.map((d) => `<tr class="hov click ${d.invoices ? '' : 'zero'}" data-act="svDay" data-d="${isoDay(d.day)}" title="افتح اليوم ده"><td>${fmtDayDate(d.day)}${d === top && d.sales ? ' <span class="tag ok">أعلى يوم</span>' : ''}</td><td class="ta-n num">${num(d.invoices)}</td><td class="ta-n num">${num(d.pcs)}</td><td class="ta-n num"><b>${money(d.sales)}</b></td><td aria-hidden="true"><span class="sv-share"><i style="width:${Math.round((d.sales / max) * 100)}%"></i></span></td>${own ? `<td class="ta-n num">${money(d.profit)}</td>` : ''}</tr>`).join('')}
    </tbody></table></div>`;
  } else if (v.view === 'prod') {
    const list = byProduct(rows);
    table = `<div class="table-wrap"><table class="t sv-t"><thead><tr><th>الصنف</th><th>التصنيف</th><th class="ta-n">القطع</th><th class="ta-n">المبيعات</th>${own ? '<th class="ta-n">الربح</th>' : ''}</tr></thead><tbody>
      ${list.map((e) => `<tr class="hov click" data-act="svProd" data-name="${esc(e.name)}" title="اعرض فواتيره"><td><bdi dir="rtl">${esc(e.name)}</bdi></td><td class="muted">${esc(svCatName(e.cat))}</td><td class="ta-n num">${num(e.qty)}</td><td class="ta-n num"><b>${money(e.sales)}</b></td>${own ? `<td class="ta-n num">${money(e.profit)}</td>` : ''}</tr>`).join('')}
    </tbody></table></div>`;
  } else if (v.view === 'cat') {
    const list = byCategory(rows), tot = list.reduce((a, e) => a + e.sales, 0) || 1;
    const row = (e, subRow) => { const share = Math.round((e.sales / tot) * 100); return `<tr class="hov click ${subRow ? 'sub' : ''}" data-act="svCatPick" data-id="${e.id}" title="اعرض أصنافه"><td>${esc(svCatName(e.id))}</td><td class="ta-n num">${num(e.qty)}</td><td class="ta-n num"><b>${money(e.sales)}</b></td><td><span class="sv-share"><i style="width:${share}%"></i></span><span class="num">${num(share)}%</span></td>${own ? `<td class="ta-n num">${money(e.profit)}</td>` : ''}</tr>`; };
    table = `<div class="table-wrap"><table class="t sv-t"><thead><tr><th>التصنيف</th><th class="ta-n">القطع</th><th class="ta-n">المبيعات</th><th>النسبة</th>${own ? '<th class="ta-n">الربح</th>' : ''}</tr></thead><tbody>
      ${list.map((e) => row(e, false) + [...e.subs.values()].sort((a, b) => b.sales - a.sales).map((s) => row(s, true)).join('')).join('')}
    </tbody></table></div>`;
  } else {
    const list = rows.slice().reverse(), shown = list.slice(0, v.limit);
    table = `<div class="table-wrap"><table class="t sv-t"><thead><tr><th>رقم</th><th>${len === 1 ? 'الوقت' : 'اليوم'}</th>${own ? '<th>البيّاع</th>' : ''}<th>العميل</th><th>الأصناف</th><th>الدفع</th><th class="ta-n">الإجمالي</th></tr></thead><tbody>
      ${shown.map((r) => { const x = r.x, u = DATA.users.find((y) => y.id === x.sellerId), c = DATA.customers.find((y) => y.id === x.customerId);
        return `<tr class="hov click" data-act="svOpen" data-no="${x.no}"><td class="num">${dg(x.no)}</td><td class="num">${len === 1 ? fmtTime(x.at) : `${fmtDate(x.at)} <span class="muted">${fmtTime(x.at)}</span>`}</td>${own ? `<td>${u ? esc(u.name) : ''}</td>` : ''}<td>${c ? esc(c.name) : '<span class="muted">نقدي</span>'}</td><td>${itemsSummary(r.lines)}</td><td>${esc(payLabel(x.payments))}</td><td class="ta-n num"><b>${money(rowAmount(r))}</b>${r.lineLevel ? `<small class="muted">من ${money(x.total)}</small>` : ''}</td></tr>`; }).join('')}
    </tbody></table></div>${list.length > shown.length ? `<button type="button" class="btn ghost sv-more" data-act="svMore">اعرض ${num(Math.min(150, list.length - shown.length))} فاتورة كمان (فاضل ${num(list.length - shown.length)})</button>` : ''}`;
  }
  return `<div class="page sales">
    <div class="page-h"><h2>المبيعات</h2><span class="sub">${own ? 'كل مبيعات المحل' : 'مبيعاتك انت بس'}</span><span class="sp"></span>
      <button type="button" class="btn" data-act="soon">${icon('download')} تصدير Excel</button></div>
    <div class="sv-bar">
      <div class="day-nav">
        <button type="button" class="icon-btn" data-act="svShift" data-d="-1" ${atFirst ? 'disabled' : ''} title="${len === 1 ? 'اليوم اللي قبله' : 'الفترة اللي قبلها'} (السهم يمين)" aria-label="${len === 1 ? 'اليوم اللي قبله' : 'الفترة اللي قبلها'}">${icon('chevron-right')}</button>
        <label class="day-pick" title="اختار يوم">${icon('calendar')}<span class="dl">${label}</span><input type="date" data-change="svDate" value="${isoDay(v.to)}" min="${isoDay(svFirstDay())}" max="${isoDay(today)}" aria-label="اختار يوم"></label>
        <button type="button" class="icon-btn" data-act="svShift" data-d="1" ${atToday ? 'disabled' : ''} title="${len === 1 ? 'اليوم اللي بعده' : 'الفترة اللي بعدها'} (السهم شمال)" aria-label="${len === 1 ? 'اليوم اللي بعده' : 'الفترة اللي بعدها'}">${icon('chevron-left')}</button>
      </div>
      <div class="seg">${ranges.map(([id, l]) => `<button type="button" class="${v.range === id ? 'on' : ''}" data-act="svRange" data-id="${id}">${l}</button>`).join('')}</div>
      ${monthSel}
    </div>
    <div class="sv-filters">
      <label class="inline-search">${icon('search')}<input id="sv-q" data-input="svQ" value="${esc(v.q)}" placeholder="صنف، رقم فاتورة، IMEI، عميل أو رقمه" autocomplete="off" aria-label="بحث في المبيعات"></label>
      <select class="sv-sel" data-change="svCat" aria-label="التصنيف"><option value="">كل التصنيفات</option>${catOpts}</select>
      ${own ? `<select class="sv-sel" data-change="svSeller" aria-label="البيّاع"><option value="">كل البيّاعين</option>${DATA.users.map((u) => `<option value="${u.id}" ${v.seller === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>` : ''}
      <select class="sv-sel" data-change="svMethod" aria-label="طريقة الدفع"><option value="">كل طرق الدفع</option>${DATA.payMethods.map((m) => `<option value="${m.id}" ${v.method === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
      ${filtered ? `<button type="button" class="btn ghost" data-act="svClear">${icon('x')} مسح الفلاتر</button>` : ''}
    </div>
    <div class="cards">
      ${kpi('المبيعات', money(T.sales), sub)}
      ${kpi('عدد الفواتير', num(T.invoices), `<div class="sub muted">متوسط الفاتورة ${money(T.avg)}</div>`)}
      ${kpi('القطع', num(T.pcs), `<div class="sub muted">${len === 1 ? 'في اليوم ده' : `في ${num(len)} يوم`}</div>`)}
      ${own ? kpi('الربح', money(T.profit), `<div class="sub muted">هامش ${num(T.sales ? Math.round((T.profit / T.sales) * 100) : 0)}%</div>`) : ''}
    </div>
    <div class="sv-head"><div class="seg">${[['inv', 'الفواتير'], ...(len > 1 ? [['day', 'الأيام']] : []), ['prod', 'الأصناف'], ['cat', 'التصنيفات']].map(([id, l]) => `<button type="button" class="${v.view === id ? 'on' : ''}" data-act="svView" data-id="${id}">${l}</button>`).join('')}</div>
      ${T.partial ? '<span class="muted sv-note">المبالغ للأصناف المطابقة بس، قبل خصم الفاتورة</span>' : ''}</div>
    ${table}
  </div>`;
}
VIEWS.sales = viewSales;
// يوم واحد: اليوم اللي قبله أو بعده. فترة: نفس طولها. الشهر: الشهر اللي قبله أو بعده. ومفيش بعد النهارده
function svSetDay(d) { const v = salesState(), t = dayStart(new Date()), x = d > t ? t : d; if (v.view === 'day') v.view = 'inv'; v.from = x; v.to = x; v.range = x.getTime() === t.getTime() ? 'today' : x.getTime() === addDays(t, -1).getTime() ? 'yesterday' : ''; v.limit = 150; render(); }
// أول يوم فيه مبيعات: السهم والتاريخ ما يرجعوش قبله
const svFirstDay = () => (DATA.history.length ? dayStart(DATA.history[0].at) : dayStart(new Date()));
// شهر كامل، أو الشهر الحالي لحد النهارده
function svSetMonth(f) { const v = salesState(), t = dayStart(new Date()), e = monthEnd(f); v.from = monthStart(f); v.to = e > t ? t : e; v.range = sameMonth(f, t) ? 'month' : 'month-x'; v.limit = 150; render(); }
function svShift(dir) {
  const v = salesState(), t = dayStart(new Date()), len = daysIn(v.from, v.to);
  if (dir > 0 && v.to.getTime() >= t.getTime()) return;
  if (dir < 0 && v.from.getTime() <= svFirstDay().getTime()) return;
  if (len === 1) { svSetDay(addDays(v.from, dir)); return; }
  if (v.range === 'month' || v.range === 'month-x') { svSetMonth(new Date(v.from.getFullYear(), v.from.getMonth() + dir, 1)); return; }
  v.from = addDays(v.from, dir * len); v.to = addDays(v.to, dir * len);
  if (v.to > t) { v.to = t; v.from = addDays(t, -(len - 1)); }
  v.range = v.to.getTime() === t.getTime() && len === 7 ? 'week' : '';
  v.limit = 150; render();
}
function salesKey(e) {
  const tg = e.target, typing = tg && (tg.tagName === 'INPUT' || tg.tagName === 'SELECT' || tg.tagName === 'TEXTAREA');
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); svShift(-1); } else if (e.key === 'ArrowLeft') { e.preventDefault(); svShift(1); }
}
Object.assign(ACT, {
  svShift: (d) => svShift(Number(d.d)),
  svRange: (d) => {
    const v = salesState(), t = dayStart(new Date());
    if (d.id === 'today') svSetDay(t); else if (d.id === 'yesterday') svSetDay(addDays(t, -1));
    else if (d.id === 'month') svSetMonth(t);
    else { v.from = addDays(t, -6); v.to = t; v.range = d.id; v.limit = 150; render(); }
  },
  svDay: (d) => { const [y, m, dd] = d.d.split('-').map(Number); salesState().view = 'inv'; svSetDay(new Date(y, m - 1, dd)); },
  svView: (d) => { salesState().view = d.id; render(); },
  svClear: () => { Object.assign(salesState(), { q: '', cat: '', seller: '', method: '', limit: 150 }); render(); },
  svMore: () => { salesState().limit += 150; render(); },
  svProd: (d) => { Object.assign(salesState(), { q: d.name, view: 'inv', limit: 150 }); render(); },
  svCatPick: (d) => { Object.assign(salesState(), { cat: d.id, view: 'prod' }); render(); },
  svOpen: (d) => { S.modal = { type: 'saleView', no: Number(d.no) }; render(); },
  svResend: () => { const x = DATA.history.find((y) => y.no === S.modal.no), c = x && DATA.customers.find((y) => y.id === x.customerId); if (c) toast(`اتبعت الإيصال تاني على واتساب ${c.phone} (صورة الإيصال + رسالة)`); },
});
INPUT.svQ = (el) => { Object.assign(salesState(), { q: el.value, limit: 150 }); render(); };
CHANGE.svMonth = (el) => { const [y, m] = el.value.split('-').map(Number); if (y) svSetMonth(new Date(y, m - 1, 1)); };
CHANGE.svDate = (el) => { const [y, m, d] = el.value.split('-').map(Number); if (y) svSetDay(new Date(y, m - 1, d)); };
CHANGE.svCat = (el) => { Object.assign(salesState(), { cat: el.value, limit: 150 }); render(); };
CHANGE.svSeller = (el) => { Object.assign(salesState(), { seller: el.value, limit: 150 }); render(); };
CHANGE.svMethod = (el) => { Object.assign(salesState(), { method: el.value, limit: 150 }); render(); };
// تفاصيل الفاتورة: أصنافها ومدفوعاتها وضمانها، وإعادة إرسال الإيصال على واتساب لو عليها رقم
MODALS.saleView = {
  html: (m) => {
    const x = DATA.history.find((y) => y.no === m.no);
    if (!x) return `<div class="modal sm" role="dialog" aria-label="تفاصيل الفاتورة">${modalHead('الفاتورة مش موجودة')}</div>`;
    const u = DATA.users.find((y) => y.id === x.sellerId), c = DATA.customers.find((y) => y.id === x.customerId), own = isOwner();
    return `<div class="modal md" role="dialog" aria-label="تفاصيل الفاتورة">
      ${modalHead(`فاتورة رقم ${dg(x.no)}`, `${fmtLong(x.at)} الساعة ${fmtTime(x.at)}، البيّاع ${u ? esc(u.name) : ''}`)}
      <div class="modal-b stack">
        <div class="sv-cust">${icon(c ? 'user-round' : 'user')}<span>${c ? `<b>${esc(c.name)}</b> <bdi dir="ltr" class="mono">${c.phone}</bdi>` : 'عميل نقدي'}</span></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>الصنف</th><th class="ta-n">الكمية</th><th class="ta-n">السعر</th><th class="ta-n">الإجمالي</th></tr></thead><tbody>
          ${x.lines.map((l) => `<tr><td><bdi dir="rtl">${esc(l.name)}</bdi>${l.imei ? `<div class="sv-meta"><span class="tag accent imei-tag">${icon('scan-barcode')}<span class="k">IMEI</span>${imeiHTML(l.imei)}</span></div>` : ''}${l.warranty ? `<div class="sv-meta muted">ضمان ${monthsTxt(l.warranty)} لحد ${fmtDate(addMonths(x.at, l.warranty))}</div>` : ''}</td><td class="ta-n num">${num(l.qty)}</td><td class="ta-n num">${money(l.price)}</td><td class="ta-n num">${money(l.price * l.qty)}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="sum-box">
          ${x.disc ? `<div class="r"><span>خصم</span><span class="num">− ${money(x.disc)}</span></div>` : ''}
          <div class="r grand"><span>الإجمالي</span><span class="num">${money(x.total)}</span></div>
          ${x.payments.map((p) => `<div class="r"><span>${esc(payName(p))}</span><span class="num">${money(p.amount)}</span></div>`).join('')}
          ${own ? `<div class="r muted"><span>الربح</span><span class="num">${money(x.profit)}</span></div>` : ''}
        </div>
      </div>
      <div class="modal-f"><span class="sp"></span>
        ${c ? `<button type="button" class="btn" data-act="svResend">${icon('message-circle')} ابعت الإيصال تاني واتساب</button>` : ''}
        <button type="button" class="btn ghost" data-act="closeModal">اقفل <kbd>Esc</kbd></button>
      </div>
    </div>`;
  },
};
