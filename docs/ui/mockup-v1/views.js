'use strict';
/* ===== التقارير (للمالك) ===== */
const kpi = (ic, label, value, sub) => `<div class="card kpi"><div class="label">${icon(ic)} ${label}</div><div class="value num">${value}</div>${sub}</div>`;
function viewDashboard() {
  const d = DATA.dash, t = d.today, vsY = Math.round(((t.sales - t.yesterday) / t.yesterday) * 100), maxW = Math.max(...d.week);
  const days = d.week.map((v, i) => { const dt = new Date(); dt.setDate(dt.getDate() - (6 - i)); return [i === 6 ? 'النهارده' : fmtDay(dt), v]; });
  return `<div class="page">
    <div class="page-h"><h2>التقارير</h2><span class="sub">${fmtLong()}</span><span class="sp"></span>
      <button type="button" class="btn" data-act="soon">${icon('download')} تصدير Excel</button><button type="button" class="btn" data-act="soon">${icon('printer')} طباعة</button></div>
    <div class="cards">
      ${kpi('banknote', 'مبيعات النهارده', money(t.sales), `<div class="sub ${vsY >= 0 ? 'ok-t' : 'danger-t'}">${icon(vsY >= 0 ? 'trending-up' : 'trending-down')} ${num(Math.abs(vsY))}% عن امبارح</div>`)}
      ${kpi('receipt', 'عدد الفواتير', num(t.invoices), `<div class="sub muted">متوسط الفاتورة ${money(Math.round(t.sales / t.invoices))}</div>`)}
      ${kpi('coins', 'الربح', money(t.profit), `<div class="sub muted">هامش ${num(Math.round((t.profit / t.sales) * 100))}%</div>`)}
      ${kpi('wallet', 'خدمات المحافظ والفواتير', num(t.services), `<div class="sub muted">عمولات ${money(t.servicesFee)}</div>`)}
      ${kpi('calculator', 'المفروض في الدرج', money(expectedCash()), `<div class="sub muted">وردية #${num(DATA.shift.no)}</div>`)}
    </div>
    <div class="dash-grid">
      <div class="card"><h3>${icon('chart-column')} المبيعات آخر 7 أيام</h3>
        <div class="bars">${days.map(([l, v], i) => `<div class="bar-col"><span class="bv num">${num(Math.round(v / 100) / 10)}k</span><div class="bar ${i === 6 ? 'today' : ''}" style="height:${Math.max(4, Math.round((v / maxW) * 100))}%"></div><span class="bl">${l}</span></div>`).join('')}</div></div>
      <div class="card"><h3>${icon('credit-card')} طرق الدفع النهارده</h3>
        <div class="split">${d.pay.map((p, i) => `<i style="width:${p.v}%;background:var(--c${i})"></i>`).join('')}</div>
        ${d.pay.map((p, i) => `<div class="li"><span class="dot" style="background:var(--c${i})"></span>${p.name}<span class="sp"></span><b class="num">${num(p.v)}%</b></div>`).join('')}</div>
    </div>
    <div class="dash-grid">
      <div class="card"><h3>${icon('history')} آخر الفواتير</h3>
        <div class="table-wrap" style="border:0"><table class="t"><thead><tr><th>رقم</th><th>الوقت</th><th>البيّاع</th><th>العميل</th><th>الدفع</th><th>المبلغ</th></tr></thead>
        <tbody>${d.recent.slice(0, 7).map((r) => `<tr class="hov"><td class="num">${dg(r.no)}</td><td>${dg(r.at)}</td><td>${esc(r.seller)}</td><td>${esc(r.customer)}</td><td>${esc(r.method)}</td><td><b class="num">${money(r.total)}</b></td></tr>`).join('')}</tbody></table></div></div>
      <div class="stack">
        <div class="card"><h3>${icon('star')} الأكثر مبيعًا النهارده</h3>${d.top.map(([n, q, v], i) => `<div class="li"><span class="rank">${num(i + 1)}</span><bdi dir="rtl" class="ell">${esc(n)}</bdi><span class="sp"></span><span class="muted num">${num(q)} قطعة</span><b class="num">${money(v)}</b></div>`).join('')}</div>
        <div class="card"><h3>${icon('calendar')} ${d.month.label}</h3>
          <div class="li">موبايلات جديدة<span class="sp"></span><b class="num">${money(d.month.phones)}</b></div>
          <div class="li">إكسسوارات<span class="sp"></span><b class="num">${money(d.month.accessories)}</b></div>
          <div class="li">عدد العمليات<span class="sp"></span><b class="num">${num(d.month.ops)}</b></div></div>
      </div>
    </div>
  </div>`;
}
VIEWS.dashboard = viewDashboard;

/* ===== الصيانة: لوحة بالمراحل + استلام جهاز ===== */
const nextRepairNo = () => 1 + Math.max(...S.repairs.map((r) => +r.no.replace(/\D/g, '')));
function ticketHTML(r) {
  const st = DATA.repairStatuses, idx = st.findIndex((s) => s.id === r.status), next = st[idx + 1];
  const left = Math.max(0, r.estimate - r.deposit);
  return `<div class="ticket ${r.status}">
    <div class="tk-h"><b class="num">${r.no}</b><span class="muted">${dg(r.at)}</span><span class="sp"></span>${r.due && r.status !== 'delivered' ? `<span class="tag ${/النهارده/.test(r.due) ? 'warn' : ''}">${icon('clock')} ${dg(r.due)}</span>` : ''}</div>
    <div class="dev"><bdi dir="ltr">${esc(r.device)}</bdi></div>
    <div class="iss">${esc(r.issue)}</div>
    ${r.note ? `<div class="note-s">${icon('info')} ${esc(r.note)}</div>` : ''}
    <div class="who">${icon('user')} ${esc(r.customer)} · <bdi dir="ltr" class="mono">${r.phone}</bdi></div>
    <div class="money-row">${r.estimate ? `<span>التكلفة <b class="num">${money(r.estimate)}</b></span>` : '<span class="muted">لسه بيتفحص</span>'}${r.deposit ? `<span>عربون <b class="num">${money(r.deposit)}</b></span>` : ''}</div>
    ${r.status === 'ready' ? `<div class="tk-f"><button type="button" class="btn sm primary" data-act="deliver" data-no="${r.no}">${icon('banknote')} سلّم وحصّل${left ? ` ${money(left)}` : ''}</button><button type="button" class="icon-btn sm" data-act="repWa" data-no="${r.no}" title="ابعت للعميل إن الجهاز جاهز">${icon('message-circle')}</button></div>`
    : next && r.status !== 'delivered' ? `<div class="tk-f"><button type="button" class="btn sm" data-act="repMove" data-no="${r.no}">${icon('arrow-left')} ${next.name}</button></div>` : ''}
  </div>`;
}
function viewRepairs() {
  const q = normalize(S.repQ || '');
  const list = S.repairs.filter((r) => !q || normalize([r.no, r.device, r.issue, r.customer, r.phone].join(' ')).includes(q));
  return `<div class="page">
    <div class="page-h"><h2>الصيانة</h2><span class="sub">${num(S.repairs.filter((r) => r.status !== 'delivered').length)} جهاز في المحل</span><span class="sp"></span>
      <label class="inline-search">${icon('search')}<input id="rep-q" data-input="repQ" value="${esc(S.repQ || '')}" placeholder="رقم التذكرة أو العميل أو الجهاز…" autocomplete="off"></label>
      <button type="button" class="btn primary" data-act="intake">${icon('package-plus')} استلام جهاز جديد</button></div>
    <div class="kanban" data-scroll="kanban">${DATA.repairStatuses.map((s) => { const col = list.filter((r) => r.status === s.id); return `<div class="kcol"><div class="kh">${icon(s.icon)} ${s.name}<span class="cnt num">${num(col.length)}</span></div>${col.map(ticketHTML).join('') || '<div class="k-empty">مفيش</div>'}</div>`; }).join('')}</div>
  </div>`;
}
VIEWS.repairs = viewRepairs;
INPUT.repQ = (el) => { S.repQ = el.value; render(); };
function openIntake() { openModal({ type: 'intake', name: '', phone: '', device: '', imei: '', issues: [], notes: '', lock: '', acc: [], estimate: '', deposit: '', due: 'بكره', err: '' }); }
MODALS.intake = {
  html(m) {
    const ACC = ['شاحن', 'جراب', 'شريحة', 'ميموري', 'علبة'];
    return `<div class="modal wide" role="dialog" aria-label="استلام جهاز صيانة">
      ${modalHead('package-plus', 'استلام جهاز صيانة', `تذكرة R-${nextRepairNo()}`)}
      <div class="modal-b"><div class="intake">
        <div class="stack">
          <div class="field"><label for="in-phone">موبايل العميل</label><input id="in-phone" data-input="inF" data-k="phone" data-autofocus dir="ltr" inputmode="tel" value="${esc(m.phone)}" placeholder="01xxxxxxxxx" autocomplete="off"><span class="hint">لو العميل متسجّل، اسمه بيظهر لوحده</span></div>
          <div class="field"><label for="in-name">اسم العميل</label><input id="in-name" data-input="inF" data-k="name" value="${esc(m.name)}" autocomplete="off"></div>
          <div class="field"><label for="in-device">الجهاز</label><input id="in-device" data-input="inF" data-k="device" dir="auto" value="${esc(m.device)}" placeholder="مثلًا: Samsung A32" autocomplete="off"></div>
          <div class="field"><label for="in-imei">IMEI (اختياري)</label><input id="in-imei" data-input="inF" data-k="imei" dir="ltr" inputmode="numeric" value="${esc(m.imei)}" autocomplete="off"></div>
        </div>
        <div class="stack">
          <div class="field"><span class="label">العطل</span><div class="chips cats">${DATA.repairIssues.map((x) => `<button type="button" class="chip ${m.issues.includes(x) ? 'on' : ''}" data-act="inIssue" data-v="${x}">${x}</button>`).join('')}</div></div>
          <div class="field"><label for="in-notes">ملاحظات</label><input id="in-notes" data-input="inF" data-k="notes" value="${esc(m.notes)}" placeholder="أي تفاصيل تانية" autocomplete="off"></div>
          <div class="field"><span class="label">مع الجهاز</span><div class="chips cats">${ACC.map((x) => `<button type="button" class="chip sub ${m.acc.includes(x) ? 'on' : ''}" data-act="inAcc" data-v="${x}">${x}</button>`).join('')}</div></div>
          <div class="grid2"><div class="field"><label for="in-est">التكلفة المتوقعة</label><input id="in-est" class="num" data-input="inF" data-k="estimate" dir="ltr" inputmode="decimal" value="${esc(m.estimate)}" autocomplete="off"></div>
            <div class="field"><label for="in-dep">العربون</label><input id="in-dep" class="num" data-input="inF" data-k="deposit" dir="ltr" inputmode="decimal" value="${esc(m.deposit)}" autocomplete="off"></div></div>
          <div class="grid2"><div class="field"><label for="in-lock">باسورد أو نمط القفل</label><input id="in-lock" data-input="inF" data-k="lock" dir="ltr" value="${esc(m.lock)}" autocomplete="off"></div>
            <div class="field"><span class="label">التسليم</span><div class="seg">${['النهارده', 'بكره', 'بعده'].map((x) => `<button type="button" class="${m.due === x ? 'on' : ''}" data-act="inDue" data-v="${x}">${x}</button>`).join('')}</div></div></div>
        </div>
      </div><div class="err-msg">${esc(m.err)}</div></div>
      <div class="modal-f"><span class="muted">${hasPrinter() ? `${icon('printer')} بيطبع إيصال استلام للعميل وملصق للجهاز` : `${icon('message-circle')} إيصال الاستلام بيتبعت للعميل واتساب`}</span><span class="sp"></span><button type="button" class="btn primary" data-act="intakeSave">${icon('check')} سجّل الاستلام <kbd>Enter</kbd></button></div>
    </div>`;
  },
  enter: () => intakeSave(),
};
function intakeSave() {
  const m = S.modal, ph = toLatin(m.phone).replace(/\D/g, '');
  if (!/^01\d{9}$/.test(ph)) { m.err = 'رقم الموبايل لازم يكون 11 رقم ويبدأ بـ 01'; beep(); render(); return; }
  if (!m.name.trim() || !m.device.trim()) { m.err = 'اكتب اسم العميل والجهاز'; beep(); render(); return; }
  if (!m.issues.length && !m.notes.trim()) { m.err = 'اختار العطل أو اكتب ملاحظة'; beep(); render(); return; }
  const no = `R-${nextRepairNo()}`;
  S.repairs.unshift({ no, device: m.device.trim(), issue: m.issues.join(' + ') || m.notes.trim(), customer: m.name.trim(), phone: ph, status: 'received', estimate: parseNum(m.estimate) || 0, deposit: parseNum(m.deposit) || 0, due: m.due, tech: '—', at: fmtTime() });
  if (!DATA.customers.some((c) => c.phone === ph)) DATA.customers.unshift({ id: `c${Date.now()}`, name: m.name.trim(), phone: ph, balance: 0, visits: 1 });
  S.modal = null; render();
  toast(`اتسجّلت تذكرة ${no} — بيطبع إيصال الاستلام`);
}
INPUT.inF = (el) => {
  const m = S.modal, k = el.dataset.k; m[k] = el.value; m.err = '';
  if (k === 'phone') {
    const c = DATA.customers.find((x) => x.phone === toLatin(el.value).replace(/\D/g, ''));
    if (c && !m.name) { m.name = c.name; render(); toast(`عميل متسجّل: ${c.name}`, 'info'); }
  }
};
Object.assign(ACT, {
  intake: () => openIntake(),
  inIssue: (d) => { const a = S.modal.issues, i = a.indexOf(d.v); if (i >= 0) a.splice(i, 1); else a.push(d.v); S.modal.err = ''; render(); },
  inAcc: (d) => { const a = S.modal.acc, i = a.indexOf(d.v); if (i >= 0) a.splice(i, 1); else a.push(d.v); render(); },
  inDue: (d) => { S.modal.due = d.v; render(); },
  intakeSave: () => intakeSave(),
  repMove: (d) => {
    const r = S.repairs.find((x) => x.no === d.no), st = DATA.repairStatuses, i = st.findIndex((s) => s.id === r.status);
    r.status = st[Math.min(i + 1, st.length - 1)].id; render();
    toast(`${r.no} ← ${st.find((s) => s.id === r.status).name}${r.status === 'ready' ? ' — تقدر تبعت للعميل واتساب' : ''}`);
  },
  repWa: (d) => toast(`اتبعت لعميل ${d.no} رسالة واتساب إن الجهاز جاهز`),
  deliver: (d) => {
    const r = S.repairs.find((x) => x.no === d.no), left = Math.max(0, r.estimate - r.deposit);
    addService({ name: `صيانة ${r.no} — ${r.device}`, price: left, icon: 'wrench', note: `${r.issue}${r.deposit ? ` · العربون ${money(r.deposit)} اتخصم` : ''}`, repairNo: r.no });
    if (!cur().customer) { const c = DATA.customers.find((x) => x.phone === r.phone); if (c) cur().customer = c; }
    S.view = 'pos'; render(); focusSearch();
    toast(`اتضافت صيانة ${r.no} للفاتورة — حصّل ${money(left)}`);
  },
});

/* ===== المخزون ===== */
// قيمة المخزون بالتكلفة: الأجهزة المتسجّلة بتكلفتها الفعلية، واللي من غير IMEI بتكلفة الصنف
function stockValue(p) {
  if (!p.serial) return p.cost * p.stock;
  const reg = unitsIn(p.id);
  return reg.reduce((a, u) => a + u.cost, 0) + Math.max(0, p.stock - reg.length) * p.cost;
}
function invRow(p, own) {
  const st = stockOf(p), open = S.inv.open[p.id], img = IMGS[p.id];
  const status = st <= 0 ? '<span class="tag danger">خلصان</span>' : st <= p.min ? '<span class="tag warn">قرب يخلص</span>' : '<span class="tag ok">متوفر</span>';
  const reg = p.serial ? unitsIn(p.id) : [], unreg = p.serial ? Math.max(0, p.stock - reg.length) : 0;
  const avg = p.serial && p.stock ? Math.round(stockValue(p) / p.stock) : p.cost;
  const margin = Math.round(((p.price - avg) / p.price) * 100);
  let html = `<tr class="hov">
    <td><div class="row">${p.serial ? `<button type="button" class="icon-btn sm" data-act="invOpen" data-id="${p.id}" title="الأجهزة بالـ IMEI">${icon(open ? 'chevron-up' : 'chevron-down')}</button>` : '<span class="exp-sp"></span>'}<button type="button" class="pic ${img ? 'has' : ''}" data-act="imgPick" data-id="${p.id}" title="${img ? 'غيّر صورة الصنف' : 'ضيف صورة للصنف (اختياري)'}">${img ? `<img src="${img}" alt="">` : icon(p.icon)}<span class="cam">${icon('camera')}</span></button>${img ? `<button type="button" class="icon-btn xs" data-act="imgDel" data-id="${p.id}" title="شيل الصورة">${icon('x')}</button>` : ''}<bdi dir="rtl" class="ell"><b>${esc(p.name)}</b></bdi></div></td>
    <td><bdi dir="rtl">${esc(catFull(p.cat))}</bdi></td>
    <td>${p.sku ? `<bdi dir="ltr" class="mono">${p.sku}</bdi>` : p.serial ? `<span class="muted">${imeiRequired() ? 'IMEI لكل جهاز' : 'IMEI اختياري'}</span>` : '—'}</td>
    <td class="num">${money(p.price)}</td>
    ${own ? `<td class="num">${money(avg)}${p.serial ? ' <small class="muted">متوسط</small>' : ''}</td><td class="num">${num(margin)}%</td>` : ''}
    <td class="num"><b>${num(st)}</b>${p.serial && p.stock ? `<small class="muted imei-cnt">${reg.length === p.stock ? 'كلهم بالـ IMEI' : `${num(reg.length)} بالـ IMEI`}</small>` : ''}</td><td>${status}</td></tr>`;
  if (open) {
    const units = DATA.units.filter((u) => u.pid === p.id);
    html += `<tr class="sub"><td class="muted">IMEI</td><td class="muted">اللون</td><td class="muted">المساحة</td><td class="muted">الحالة</td>${own ? '<td class="muted">تكلفة الجهاز</td><td></td>' : ''}<td class="muted">اتاستلم</td><td></td></tr>`;
    html += units.map((u) => `<tr class="sub"><td>${imeiHTML(u.imei)}</td><td>${esc(u.color || '—')}</td><td>${esc(u.storage)}</td><td>${esc(u.condition)}${u.battery ? ` · بطارية ${num(u.battery)}%` : ''}</td>${own ? `<td class="num">${money(u.cost)}</td><td></td>` : ''}<td>${fmtDate(new Date(u.received))}</td><td>${u.status === 'in' ? (inAnyCart(u.imei) ? '<span class="tag accent">في فاتورة</span>' : '<span class="tag ok">متاح</span>') : '<span class="tag">اتباع</span>'}</td></tr>`).join('');
    if (unreg) html += `<tr class="sub"><td colspan="${own ? 8 : 6}"><span class="tag">${icon('hash')} ${num(unreg)} جهاز اتسلموا بالعدد من غير IMEI</span> <span class="muted">— الـ IMEI بتاعهم ممكن يتسجّل وقت البيع</span></td></tr>`;
  }
  return html;
}
function viewInventory() {
  const I = S.inv, q = normalize(I.q), own = isOwner();
  const qd = toLatin(I.q).replace(/\D/g, '');
  if (I.cat !== 'all' && !catById(I.cat)) I.cat = 'all';
  let list = DATA.products.filter((p) => (I.cat === 'all' || inCat(p, I.cat)) &&
    (!q || p._hay.includes(q) || (qd.length >= 4 && DATA.units.some((u) => u.pid === p.id && u.imei.includes(qd)))));
  if (I.low) list = list.filter((p) => stockOf(p) <= p.min);
  const value = DATA.products.reduce((a, p) => a + stockValue(p), 0);
  return `<div class="page">
    <div class="page-h"><h2>المخزون</h2><span class="sub">${num(DATA.products.length)} صنف · ${num(DATA.units.filter((u) => u.status === 'in').length)} جهاز بالـ IMEI</span>${own ? `<span class="tag accent">قيمة المخزون بالتكلفة ${money(value)}</span>` : ''}<span class="sp"></span>
      <label class="inline-search">${icon('search')}<input id="inv-q" data-input="invQ" value="${esc(I.q)}" placeholder="اسم أو كود أو IMEI…" autocomplete="off"></label>
      <button type="button" class="btn ${I.low ? 'soft' : ''}" data-act="invLow">${icon('triangle-alert')} النواقص بس</button>
      <button type="button" class="btn" data-act="goMobileRecv">${icon('package-plus')} استلام بضاعة</button>
      <button type="button" class="btn" data-act="soon">${icon('tag')} طباعة ملصقات</button></div>
    ${catChipsHTML(I.cat, 'invCat')}
    <div class="table-wrap"><table class="t">
      <thead><tr><th>الصنف</th><th>القسم</th><th>الكود</th><th>سعر البيع</th>${own ? '<th>التكلفة</th><th>الهامش</th>' : ''}<th>المتاح</th><th>الحالة</th></tr></thead>
      <tbody>${list.map((p) => invRow(p, own)).join('') || '<tr><td colspan="8" class="muted" style="text-align:center;padding:24px">مفيش أصناف</td></tr>'}</tbody>
    </table></div>
    <div class="note">${icon('camera')} دوس على أيقونة أي صنف عشان تضيفله صورة (اختياري) — بتظهر في شاشة البيع والبحث وتطبيق الموبايل.${own ? '' : ' · التكلفة والهامش بيظهروا للمالك بس.'}</div>
    <input type="file" id="img-file" accept="image/*" hidden data-change="imgFile">
  </div>`;
}
VIEWS.inventory = viewInventory;
INPUT.invQ = (el) => { S.inv.q = el.value; render(); };
// صورة الصنف: بتتقص مربع وتتصغّر لـ 192 بكسل (JPEG) — حوالي 10–20 ك.ب
function shrinkImage(file, cb) {
  const rd = new FileReader();
  rd.onload = () => {
    const img = new Image();
    img.onload = () => {
      const S2 = 192, side = Math.min(img.width, img.height), c = document.createElement('canvas');
      c.width = S2; c.height = S2;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, S2, S2);
      g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S2, S2);
      cb(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => toast('الملف ده مش صورة', 'err');
    img.src = rd.result;
  };
  rd.readAsDataURL(file);
}
CHANGE.imgFile = (el) => {
  const f = el.files && el.files[0], pid = S._imgFor; el.value = '';
  if (!f || !pid) return;
  shrinkImage(f, (url) => {
    const prev = IMGS[pid]; IMGS[pid] = url;
    if (saveImages()) { render(); toast(`اتحفظت صورة «${prod(pid).name}» (${num(Math.round((url.length * 3) / 4 / 1024))} ك.ب)`); } else { if (prev) IMGS[pid] = prev; else delete IMGS[pid]; }
  });
};
Object.assign(ACT, {
  invCat: (d) => { const c = catById(d.id); S.inv.cat = S.inv.cat === d.id && c && c.parent ? c.parent : d.id; render(); },
  invLow: () => { S.inv.low = !S.inv.low; render(); },
  invOpen: (d) => { S.inv.open[d.id] = !S.inv.open[d.id]; render(); },
  imgPick: (d) => { S._imgFor = d.id; const f = $('#img-file'); if (f) f.click(); },
  imgDel: (d) => { delete IMGS[d.id]; saveImages(); render(); toast('اتشالت الصورة — الصنف رجع بالأيقونة', 'info'); },
  goMobileRecv: () => { S.view = 'mobile'; render(); toast('الاستلام بيتعمل من الموبايل — بالـ IMEI أو بالعدد', 'info'); },
});

/* ===== الإعدادات ===== */
function sampleSale() {
  const p = prod('p1'), u = DATA.units.find((x) => x.pid === 'p1');
  const lines = [
    { kind: 'unit', name: p.name, price: p.price, qty: 1, imei: u ? u.imei : '352867150000004', warranty: warrantyOf(p) },
    { kind: 'item', name: 'جراب سيليكون شفاف', price: 120, qty: 2, warranty: 0 },
  ];
  const sub = p.price + 240, got = Math.ceil(sub / 100) * 100;
  return { no: 10452, at: new Date(), seller: S.user, customer: DATA.customers[0], lines, sub, disc: 0, total: sub, payments: [{ method: 'cash', amount: sub, received: got }], change: got - sub };
}
const setField = (k, label, attrs = '') => `<div class="field"><label for="set-${k}">${label}</label><input id="set-${k}" data-input="set" data-k="${k}" value="${esc(SET[k])}" ${attrs}></div>`;
function setShop() {
  return `<div class="card"><h3>${icon('store')} بيانات المحل</h3>
    <div class="preview-pair"><div class="stack">
      ${setField('shopName', 'اسم المحل')}
      <div class="grid2">${setField('phone', 'التليفون', 'dir="ltr" inputmode="tel"')}${setField('address', 'العنوان')}</div>
      <div class="field"><span class="label">اللوجو</span><div class="logo-up">${logoHTML()}<div class="stack" style="gap:8px">
        <label class="btn sm">${icon('upload')} ارفع لوجو<input type="file" accept="image/*" data-change="logo" hidden></label>
        ${SET.logo ? `<button type="button" class="btn sm ghost danger" data-act="logoRemove">${icon('trash-2')} شيل اللوجو</button>` : ''}
        <span class="hint">PNG أو JPG — بيتصغّر لوحده. بيظهر في البرنامج وعلى الإيصال</span></div></div></div>
    </div>${receiptHTML(sampleSale())}</div></div>`;
}
function setLook() {
  const themes = [['light', 'sun', 'فاتح'], ['dark', 'moon', 'غامق'], ['auto', 'monitor', 'زي الجهاز']];
  const looks = [['plate', 'لافتة الشارع', 'لون المحل لوح بإطار رفيع جوّه، وخط Changa'], ['box', 'علبة الموبايل', 'أبيض وحبر وخطوط رفيعة، ولون المحل شريط واحد، وخط Vazirmatn']];
  const fonts = [['auto', 'خط الطابع', SET.look === 'box' ? 'Vazirmatn مع علبة الموبايل' : 'Changa مع لافتة الشارع'], ['plex', 'IBM Plex Sans Arabic', 'واضح ومتوازن'], ['cairo', 'Cairo', 'مألوف وعريض شوية'], ['tajawal', 'Tajawal', 'خفيف وعصري'], ['readex', 'Readex Pro', 'أرقامه مقروءة جدًا']];
  const acc = SET.accent.toLowerCase();
  return `<div class="card"><h3>${icon('palette')} الشكل</h3>
    <div class="s-row" style="align-items:flex-start"><div class="t"><b>الطابع</b><small>شكل الواجهة كلها. أماكن الحاجات والخطوات والاختصارات زي ما هي</small></div>
      <div class="look-cards">${looks.map(([id, name, d]) => `<button type="button" class="look-card ${SET.look === id ? 'on' : ''}" data-act="setLookStyle" data-id="${id}" aria-pressed="${SET.look === id}"><span class="lk lk-${id}" aria-hidden="true"><i class="lk-rail"></i><i class="lk-a"></i><i class="lk-b"></i><i class="lk-pay"></i></span><b>${name}</b><small>${d}</small></button>`).join('')}</div></div>
    <div class="s-row"><div class="t"><b>الوضع</b><small>فاتح للنهار، وغامق للليل أو لو النور قوي على الشاشة</small></div><div class="seg">${themes.map(([id, ic, l]) => `<button type="button" class="${SET.theme === id ? 'on' : ''}" data-act="setTheme" data-id="${id}">${icon(ic)} ${l}</button>`).join('')}</div></div>
    <div class="s-row"><div class="t"><b>اللون الأساسي</b><small>لون واحد للأزرار والتحديد — وألوان الحالة (أخضر وأصفر وأحمر) ثابتة</small></div>
      <div class="swatches">${ACCENTS.map((c) => `<button type="button" class="swatch ${acc === c ? 'on' : ''}" style="background:${c};color:${onAccent(c)}" data-act="setAccent" data-c="${c}" title="${c}">${acc === c ? icon('check') : ''}</button>`).join('')}
        <label class="color-in">${icon('palette')} لون تاني<input type="color" value="${esc(SET.accent)}" data-input="accent" data-change="accentDone" aria-label="لون مخصص"></label></div></div>
    <div class="s-row" style="align-items:flex-start"><div class="t"><b>الخط</b><small>كل الخطوط مجانية وشغالة من غير إنترنت</small></div>
      <div class="font-cards">${fonts.map(([id, name, d]) => `<button type="button" class="font-card ${SET.font === id ? 'on' : ''}" data-act="setFont" data-id="${id}" style="font-family:${id === 'auto' ? 'var(--font-look)' : `'${name}'`}"><span class="fs">أهلاً بيك، ${money(9250)}</span><small>${name}: ${d}</small></button>`).join('')}</div></div>
    <div class="s-row"><div class="t"><b>حجم الكلام</b><small>«كبير» مريح لو الشاشة بعيدة شوية</small></div><div class="seg"><button type="button" class="${SET.scale === 'normal' ? 'on' : ''}" data-act="setScale" data-id="normal">عادي</button><button type="button" class="${SET.scale === 'large' ? 'on' : ''}" data-act="setScale" data-id="large">كبير</button></div></div>
    <div class="s-row"><div class="t"><b>شكل الأرقام</b><small>الـ IMEI وأرقام التليفونات بتفضل إنجليزي دايمًا عشان المطابقة</small></div><div class="seg"><button type="button" class="${SET.digits === 'latin' ? 'on' : ''}" data-act="setDigits" data-id="latin">123</button><button type="button" class="${SET.digits === 'arabic' ? 'on' : ''}" data-act="setDigits" data-id="arabic">١٢٣</button></div></div>
  </div>`;
}
// الأصناف والبيع: الـ IMEI (اختياري/إجباري) + صور الأصناف + التصنيفات اللي بتظهر في شاشة البيع
const CAT_ICONS = ['tag', 'package', 'smartphone', 'watch', 'headphones', 'plug-zap', 'cable', 'shield', 'layers', 'battery-charging', 'memory-stick', 'car', 'wallet-cards', 'signal', 'wrench', 'sparkles'];
function catRowHTML(c, sibs, k) {
  const n = catCount(c.id), kids = SET.cats.some((x) => x.parent === c.id);
  return `<div class="cat-row ${c.parent ? 'sub' : ''} ${c.hidden ? 'off' : ''}">
    <span class="t-ico">${icon(c.icon)}</span>
    <input class="cat-name" id="cat-n-${c.id}" data-input="catName" data-id="${c.id}" value="${esc(c.name)}" aria-label="اسم التصنيف" autocomplete="off">
    <span class="muted num cat-n">${num(n)} صنف</span>
    <button type="button" class="icon-btn sm" data-act="catMove" data-id="${c.id}" data-d="-1" title="لفوق" ${k === 0 ? 'disabled' : ''}>${icon('arrow-up')}</button>
    <button type="button" class="icon-btn sm" data-act="catMove" data-id="${c.id}" data-d="1" title="لتحت" ${k === sibs.length - 1 ? 'disabled' : ''}>${icon('arrow-down')}</button>
    <label class="switch" title="يظهر في شاشة البيع"><input type="checkbox" data-change="catShow" data-id="${c.id}" ${c.hidden ? '' : 'checked'} aria-label="يظهر في شاشة البيع"><span></span></label>
    ${c.custom && !n && !kids ? `<button type="button" class="icon-btn sm danger" data-act="catDel" data-id="${c.id}" title="امسح التصنيف">${icon('trash-2')}</button>` : '<span class="cat-del-sp"></span>'}
  </div>`;
}
function setCatalog() {
  const req = imeiRequired(), N = S.catNew, nImg = Object.keys(IMGS).length;
  const mains = SET.cats.filter((c) => !c.parent);
  const rows = mains.map((c, k) => { const subs = SET.cats.filter((x) => x.parent === c.id); return catRowHTML(c, mains, k) + subs.map((x, j) => catRowHTML(x, subs, j)).join(''); }).join('');
  return `<div class="card"><h3>${icon('scan-barcode')} تسجيل الـ IMEI</h3>
    <div class="s-row"><div class="t"><b>الـ IMEI عند البيع</b><small>${req ? 'إجباري: لازم تختار الجهاز بالـ IMEI قبل ما يتضاف للفاتورة' : 'اختياري: الموبايل بيتضاف للفاتورة على طول زي أي صنف — وتسجّل الـ IMEI من السطر أو بمسح العلبة لو حبيت'}</small></div>
      <div class="seg"><button type="button" class="${req ? '' : 'on'}" data-act="setImei" data-id="optional">اختياري</button><button type="button" class="${req ? 'on' : ''}" data-act="setImei" data-id="required">إجباري للموبايلات</button></div></div>
    <div class="note" style="margin-top:12px">${icon('info')} في الحالتين: البحث بآخر 4 أرقام من الـ IMEI شغال، والإيصال بيطبع الـ IMEI لو متسجّل، والاستلام ممكن يبقى بالـ IMEI أو بالعدد.</div>
  </div>
  <div class="card"><h3>${icon('image')} صور الأصناف</h3>
    <div class="s-row"><div class="t"><b>اعرض صور الأصناف</b><small>في مربعات البيع ونتايج البحث وتطبيق الموبايل — والصنف اللي ملوش صورة بتفضل أيقونته</small></div><label class="switch"><input type="checkbox" data-change="showImages" ${SET.showImages ? 'checked' : ''} aria-label="اعرض صور الأصناف"><span></span></label></div>
    <div class="note" style="margin-top:12px">${icon('info')} اختيارية: بتتضاف من المخزون بالدوس على أيقونة الصنف. الصورة بتتقص مربع وتتصغّر لوحدها (حوالي 15 ك.ب) — يعني ألف صنف بصورهم حوالي 15 م.ب بس. ${nImg ? `عندك ${num(nImg)} صنف بصورة دلوقتي.` : 'لسه مفيش صور.'}</div>
  </div>
  <div class="card"><h3>${icon('tags')} التصنيفات في شاشة البيع</h3>
    <div class="muted" style="font-size:.85rem;margin-bottom:8px">«الأكثر مبيعًا» و«الكل» ثابتين في الأول. غيّر الاسم بالكتابة عليه، ورتّب بالأسهم، واقفل اللي مش عايزه يظهر.</div>
    <div class="cat-list">${rows}</div>
    <div class="cat-add">
      <div class="field"><label for="cat-new">تصنيف جديد</label><input id="cat-new" data-input="catNew" value="${esc(N.name)}" placeholder="مثلًا: خطوط، كروت شحن، قطع غيار" autocomplete="off"></div>
      <div class="field"><label for="cat-parent">مكانه</label><select id="cat-parent" data-change="catParent"><option value="">تصنيف رئيسي</option>${mains.map((c) => `<option value="${c.id}" ${N.parent === c.id ? 'selected' : ''}>تحت «${esc(c.name)}»</option>`).join('')}</select></div>
      <button type="button" class="btn soft" data-act="catAdd" ${N.name.trim() ? '' : 'disabled'}>${icon('circle-plus')} ضيف</button>
      <div class="icon-pick" role="radiogroup" aria-label="أيقونة التصنيف">${CAT_ICONS.map((ic) => `<button type="button" class="icon-btn sm ${N.icon === ic ? 'on' : ''}" data-act="catIcon" data-ic="${ic}" role="radio" aria-checked="${N.icon === ic}" title="${ic}">${icon(ic)}</button>`).join('')}</div>
    </div>
  </div>`;
}
const saveCats = () => { saveSettings(); indexProducts(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target && e.target.id === 'cat-new') { e.preventDefault(); ACT.catAdd(); } });
INPUT.catName = (el) => { const c = catById(el.dataset.id), v = el.value.trim(); if (!c || !v) return; c.name = v; saveCats(); };
INPUT.catNew = (el) => { const had = !!S.catNew.name.trim(); S.catNew.name = el.value; if (had !== !!el.value.trim()) render(); };
CHANGE.catParent = (el) => { S.catNew.parent = el.value; };
CHANGE.catShow = (el) => { const c = catById(el.dataset.id); if (!c) return; c.hidden = !el.checked; saveCats(); render(); };
CHANGE.showImages = (el) => { SET.showImages = el.checked; saveSettings(); render(); };
Object.assign(ACT, {
  setImei: (d) => { SET.imeiMode = d.id === 'required' ? 'required' : 'optional'; saveSettings(); render(); toast(d.id === 'required' ? 'الـ IMEI بقى إجباري للموبايلات' : 'الـ IMEI بقى اختياري — الموبايل بيتضاف على طول', 'info'); },
  catMove: (d) => {
    const c = catById(d.id); if (!c) return;
    const sibs = SET.cats.filter((x) => x.parent === c.parent), k = sibs.indexOf(c), t = sibs[k + +d.d]; if (!t) return;
    const i = SET.cats.indexOf(c), j = SET.cats.indexOf(t);
    [SET.cats[i], SET.cats[j]] = [SET.cats[j], SET.cats[i]]; saveCats(); render();
  },
  catDel: (d) => { const c = catById(d.id); if (!c || !c.custom || catCount(c.id)) return; SET.cats = SET.cats.filter((x) => x !== c); saveCats(); render(); toast(`اتمسح التصنيف «${c.name}»`, 'info'); },
  catIcon: (d) => { S.catNew.icon = d.ic; render(); },
  catAdd: () => {
    const N = S.catNew, name = N.name.trim();
    if (!name) return;
    if (SET.cats.some((c) => normalize(c.name) === normalize(name))) { toast(`فيه تصنيف اسمه «${name}» بالفعل`, 'err'); beep(); return; }
    SET.cats.push({ id: `c${Date.now().toString(36)}`, name, icon: N.icon, parent: N.parent || null, hidden: false, custom: true });
    saveCats(); S.catNew = { name: '', parent: N.parent, icon: 'tag' }; render();
    toast(`اتضاف «${name}»${N.parent ? ` تحت «${catName(N.parent)}»` : ''} — هيظهر في شاشة البيع`);
  },
});
function setUsers() {
  const perms = [['seeCost', 'يشوف التكلفة والربح'], ['refunds', 'يعمل مرتجع من غير المالك'], ['closeShift', 'يقفل الوردية'], ['reports', 'يفتح التقارير'], ['editPrices', 'يغيّر الأسعار']];
  return `<div class="card"><h3>${icon('users')} المستخدمين</h3>
    <div class="table-wrap" style="border:0"><table class="t"><thead><tr><th>الاسم</th><th>الدور</th><th>PIN</th><th></th></tr></thead><tbody>
    ${DATA.users.map((u) => `<tr><td><div class="row">${avatar(u)}<b>${esc(u.name)}</b></div></td><td>${roleName(u)}</td><td class="mono">****</td><td><button type="button" class="btn sm" data-act="soon">${icon('pencil')} تغيير الـ PIN</button></td></tr>`).join('')}
    </tbody></table></div>
    <button type="button" class="btn soft" data-act="soon" style="margin-top:10px">${icon('user-plus')} بيّاع جديد</button>
    <div class="note" style="margin-top:12px">${icon('arrow-left-right')} التبديل السريع: تأشّر على اسمك فوق، تختار البيّاع، وتكتب الرقم السري بتاعه — والفاتورة المفتوحة بتفضل زي ما هي.</div></div>
  <div class="card"><h3>${icon('lock')} صلاحيات البيّاع</h3>
    ${perms.map(([k, l]) => `<div class="s-row"><div class="t"><b>${l}</b></div><label class="switch"><input type="checkbox" data-change="perm" data-k="${k}" ${SET.perms[k] ? 'checked' : ''} aria-label="${l}"><span></span></label></div>`).join('')}
    <div class="s-row"><div class="t"><b>أقصى خصم من غير المالك</b><small>أكتر من كده بيطلب PIN المالك</small></div><div class="field" style="width:110px"><input id="set-discountLimit" data-input="set" data-k="discountLimit" class="num" dir="ltr" inputmode="decimal" value="${esc(SET.discountLimit)}" aria-label="أقصى خصم"></div><span>%</span></div>
    <div class="note">${icon('info')} في النموذج ده «أقصى خصم» و«يقفل الوردية» شغالين فعلًا — الباقي للعرض بس.</div></div>`;
}
function setPay() {
  return `<div class="card"><h3>${icon('wallet')} محافظ المحل</h3>
    <div class="table-wrap" style="border:0"><table class="t"><thead><tr><th>المحفظة</th><th>الرقم</th><th>الرصيد</th><th>الحد اليومي</th></tr></thead><tbody>
    ${DATA.wallets.map((w) => `<tr><td><div class="row"><span class="dot" style="background:${w.color}"></span><b>${w.name}</b></div></td><td><bdi dir="ltr" class="mono">${w.number}</bdi></td><td class="num">${money(w.balance)}</td><td class="num">${w.limitDay ? money(w.limitDay) : '<span class="muted">—</span>'}</td></tr>`).join('')}
    </tbody></table></div></div>
  <div class="card"><h3>${icon('percent')} عمولات الخدمات</h3>
    <div class="s-row"><div class="t"><b>العمولة والرسوم</b><small>${feeAuto() ? 'بتتحسب لوحدها من النسبة والحد الأدنى، والبيّاع يقدر يغيّرها في العملية' : 'مش ثابتة: البيّاع بيكتبها في كل عملية، وبتتسجّل في دفتر الخدمات والتقارير'}</small></div>
      <div class="seg">${[['manual', 'تتكتب في كل عملية'], ['auto', 'محسوبة تلقائي']].map(([id, l]) => `<button type="button" class="${SET.feeMode === id ? 'on' : ''}" data-act="setFeeMode" data-id="${id}">${l}</button>`).join('')}</div></div>
    ${feeAuto() ? `<div class="grid3" style="margin-top:8px">${setField('feePct', 'عمولة التحويل والسحب %', 'class="num" dir="ltr" inputmode="decimal"')}${setField('feeMin', 'أقل عمولة (ج.م)', 'class="num" dir="ltr" inputmode="decimal"')}${setField('billFee', 'رسوم دفع الفواتير (ج.م)', 'class="num" dir="ltr" inputmode="decimal"')}</div>
    <div class="note" style="margin-top:12px">${icon('info')} مثال: تحويل ${money(1000)} عمولته ${money(walletFee(1000))} · تحويل ${money(200)} عمولته ${money(walletFee(200))}</div>` : `<div class="note" style="margin-top:12px">${icon('info')} في شاشة الخدمات (F9) فيه خانة «العمولة» فاضية — البيّاع بيكتب اللي اتفق عليه مع العميل (ولو مفيش يكتب ${num(0)}).</div>`}</div>
  <div class="card"><h3>${icon('credit-card')} طرق الدفع اللي بتظهر في شاشة الدفع</h3>
    ${DATA.payMethods.map((x) => `<div class="s-row"><div class="t"><b>${icon(x.icon)} ${x.name}</b>${x.id === 'install' ? `<small>${DATA.installProviders.join(' · ')}</small>` : x.id === 'credit' ? '<small>لازم يكون على عميل متسجّل</small>' : ''}</div><label class="switch"><input type="checkbox" data-change="method" data-k="${x.id}" ${SET.methods[x.id] !== false ? 'checked' : ''} ${x.id === 'cash' ? 'disabled' : ''} aria-label="${x.name}"><span></span></label></div>`).join('')}
  </div>`;
}
function setReceipt() {
  return `<div class="preview-pair"><div class="stack">
    <div class="card"><h3>${icon('receipt')} الإيصال</h3>
      ${hasPrinter() ? `<div class="s-row"><div class="t"><b>مقاس الورق</b><small>بيتطبع كصورة عشان العربي يطلع مظبوط على أي طابعة حرارية</small></div><div class="seg"><button type="button" class="${SET.paper === '80' ? 'on' : ''}" data-act="setPaper" data-id="80">${num(80)} مم</button><button type="button" class="${SET.paper === '58' ? 'on' : ''}" data-act="setPaper" data-id="58">${num(58)} مم</button></div></div>` : ''}
      <div class="s-row"><div class="t"><b>بعد الدفع</b><small>${hasPrinter() ? 'الاختيار اللي بيبقى متعلّم في شاشة الدفع' : 'مفيش طابعة: الإيصال بيتبعت واتساب (صورة + رسالة). من غير عميل بتبقى «بدون» وتقدر تختار واتساب وتكتب الرقم'}</small></div><div class="seg">${receiptOpts().map(([id, l]) => `<button type="button" class="${receiptSetting() === id ? 'on' : ''}" data-act="setRMode" data-id="${id}">${l}</button>`).join('')}</div></div>
      <div class="s-row"><div class="t"><b>مكان QR الإيصال الإلكتروني</b><small>بيتفعّل لما المحل يدخل منظومة الإيصال الإلكتروني</small></div><label class="switch"><input type="checkbox" data-change="showQR" ${SET.showQR ? 'checked' : ''} aria-label="QR"><span></span></label></div>
      <div class="field" style="margin-top:8px"><label for="set-footer">الجملة اللي في آخر الإيصال</label><textarea id="set-footer" data-input="set" data-k="footer">${esc(SET.footer)}</textarea></div>
      <div class="field" style="margin-top:8px"><label for="set-waTemplate">رسالة الواتساب</label><textarea id="set-waTemplate" data-input="set" data-k="waTemplate">${esc(SET.waTemplate)}</textarea><span class="hint">{الاسم} و{رقم} و{المحل} و{تاريخ_الضمان} بيتبدّلوا لوحدهم</span></div>
    </div>
    <div class="card"><h3>${icon('shield-check')} الضمان الافتراضي</h3><div class="grid2">
      ${setField('warrantyNew', 'موبايل جديد (شهور)', 'class="num" dir="ltr" inputmode="numeric"')}${setField('warrantyUsed', 'موبايل مستعمل (شهور)', 'class="num" dir="ltr" inputmode="numeric"')}</div></div>
  </div>${receiptHTML(sampleSale())}</div>`;
}
function setBackup() {
  return `<div class="card"><h3>${icon('database')} النسخ الاحتياطي</h3>
    <div class="s-row"><div class="t"><b>آخر نسخة</b><small>النهارده ${dg('9:00')} ص — تلقائي مع فتح الوردية · مشفّرة</small></div><span class="tag ok">${icon('circle-check')} سليمة</span></div>
    <div class="s-row"><div class="t"><b>نسخة تلقائية</b><small>كل يوم مع تقفيل الوردية + كل ساعتين</small></div><label class="switch"><input type="checkbox" checked aria-label="نسخة تلقائية"><span></span></label></div>
    <div class="s-row"><div class="t"><b>نسخة على فلاشة USB</b><small>أول ما تتوصل فلاشة اسمها MSHOP-BACKUP</small></div><label class="switch"><input type="checkbox" checked aria-label="فلاشة"><span></span></label></div>
    <div class="row wrap" style="margin-top:12px"><button type="button" class="btn primary" data-act="backupNow">${icon('hard-drive')} خد نسخة دلوقتي</button><button type="button" class="btn" data-act="soon">${icon('usb')} انسخ على فلاشة</button><button type="button" class="btn danger" data-act="soon">${icon('rotate-ccw')} استرجاع نسخة</button></div>
    <div class="note warn" style="margin-top:12px">${icon('triangle-alert')} الاسترجاع بيرجّع البيانات لوقت النسخة — وبيطلب PIN المالك.</div>
  </div>`;
}
function setDevices() {
  return `<div class="card"><h3>${icon('smartphone')} الموبايلات المتوصلة</h3>
    ${DATA.devices.map((d) => `<div class="s-row"><span class="t-ico">${icon('smartphone')}</span><div class="t"><b>${esc(d.name)}</b><small><bdi dir="rtl">${esc(d.model)}</bdi> · ${d.last}</small></div><span class="tag ok"><span class="dot"></span> متصل</span><button type="button" class="btn sm ghost danger" data-act="soon">فصل</button></div>`).join('')}
  </div>
  <div class="card"><h3>${icon('qr-code')} توصيل موبايل جديد</h3>
    <div class="qr-box">${fakeQR(`PAIR-${SET.shopName}`, 168, 'pair-qr')}<div class="stack" style="gap:6px">
      <b>${dg('1.')} افتح تطبيق المحل على الموبايل</b><span>${dg('2.')} اتأكد إنه على نفس الـ Wi-Fi بتاع المحل</span><span>${dg('3.')} امسح الكود ده، وبعدها اختار البيّاع واكتب الـ PIN</span>
      <span class="muted">عنوان الكمبيوتر: <bdi dir="ltr" class="mono">192.168.1.10:8787</bdi></span></div></div>
  </div>
  <div class="card"><h3>${icon('printer')} الطابعة</h3>
    ${hasPrinter()
      ? `<div class="s-row"><div class="t"><b>XP-80 (USB)</b><small>طابعة حرارية ${num(80)} مم · الطباعة كصورة</small></div><span class="tag ok">جاهزة</span><button type="button" class="btn sm" data-act="testPrint">${icon('printer')} صفحة تجربة</button></div>`
      : `<div class="s-row"><span class="t-ico">${icon('message-circle')}</span><div class="t"><b>مفيش طابعة دلوقتي</b><small>الإيصال بيتبعت للعميل على واتساب: صورة الإيصال + رسالة الواتساب اللي في إعدادات الإيصال</small></div><span class="tag">واتساب بس</span></div>`}
    <div class="s-row"><div class="t"><b>عندي طابعة إيصالات</b><small>لما تجيب طابعة حرارية فعّل ده — هترجع «طباعة» و«الاتنين» في شاشة الدفع</small></div><label class="switch"><input type="checkbox" data-change="printer" ${hasPrinter() ? 'checked' : ''} aria-label="عندي طابعة إيصالات"><span></span></label></div>
  </div>`;
}
const S_TABS = [['shop', 'store', 'المحل'], ['look', 'palette', 'الشكل'], ['catalog', 'tags', 'الأصناف والبيع'], ['users', 'users', 'المستخدمين والصلاحيات'], ['pay', 'wallet', 'المحافظ والدفع'], ['receipt', 'receipt', 'الإيصال والضمان'], ['backup', 'database', 'النسخ الاحتياطي'], ['devices', 'wifi', 'الأجهزة والطابعة']];
function viewSettings() {
  const body = { shop: setShop, look: setLook, catalog: setCatalog, users: setUsers, pay: setPay, receipt: setReceipt, backup: setBackup, devices: setDevices }[S.settingsTab]();
  return `<div class="page"><div class="page-h"><h2>الإعدادات</h2><span class="sub">كل تغيير بيتحفظ لوحده</span></div>
    <div class="settings"><nav class="s-nav">${S_TABS.map(([id, ic, l]) => `<button type="button" class="${S.settingsTab === id ? 'on' : ''}" data-act="setTab" data-id="${id}">${icon(ic)} ${l}</button>`).join('')}
      <button type="button" data-act="resetSettings" style="margin-top:10px">${icon('rotate-ccw')} رجّع الإعدادات الأصلية</button></nav>
    <div class="s-sec">${body}</div></div></div>`;
}
VIEWS.settings = viewSettings;
const setAndRender = (k, v) => { SET[k] = v; saveSettings(); applySettings(); render(); };
INPUT.set = (el) => setAndRender(el.dataset.k, el.value);
INPUT.accent = (el) => { SET.accent = el.value; applySettings(); };
CHANGE.accentDone = (el) => setAndRender('accent', el.value);
CHANGE.perm = (el) => { SET.perms[el.dataset.k] = el.checked; saveSettings(); render(); };
CHANGE.method = (el) => { SET.methods[el.dataset.k] = el.checked; saveSettings(); render(); };
CHANGE.showQR = (el) => setAndRender('showQR', el.checked);
// الطابعة اختيارية: لو اتشالت والإعداد كان «طباعة»/«الاتنين» يرجع واتساب
CHANGE.printer = (el) => { SET.printer = el.checked; if (!SET.printer && (SET.receiptMode === 'print' || SET.receiptMode === 'both')) SET.receiptMode = 'wa'; saveSettings(); applySettings(); render(); toast(SET.printer ? 'الطباعة رجعت في شاشة الدفع' : 'الإيصال هيتبعت واتساب بس', 'info'); };
CHANGE.logo = (el) => {
  const f = el.files && el.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, 256 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * s)); c.height = Math.max(1, Math.round(img.height * s));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const prev = SET.logo; SET.logo = c.toDataURL('image/png');
      if (saveSettings()) { render(); toast('اتحفظ اللوجو'); } else { SET.logo = prev; }
    };
    img.onerror = () => toast('الملف ده مش صورة', 'err');
    img.src = rd.result;
  };
  rd.readAsDataURL(f);
};
Object.assign(ACT, {
  setTab: (d) => { S.settingsTab = d.id; render(); },
  setTheme: (d) => setAndRender('theme', d.id),
  setAccent: (d) => setAndRender('accent', d.c),
  setFont: (d) => setAndRender('font', d.id),
  setLookStyle: (d) => { if (LOOKS.includes(d.id)) setAndRender('look', d.id); },
  setScale: (d) => setAndRender('scale', d.id),
  setDigits: (d) => setAndRender('digits', d.id),
  setPaper: (d) => setAndRender('paper', d.id),
  setRMode: (d) => setAndRender('receiptMode', d.id),
  setFeeMode: (d) => setAndRender('feeMode', d.id),
  logoRemove: () => setAndRender('logo', ''),
  resetSettings: () => { SET = JSON.parse(JSON.stringify(DEFAULTS)); saveSettings(); applySettings(); indexProducts(); render(); toast('رجعت الإعدادات الأصلية', 'info'); },
  backupNow: () => toast(`اتعملت نسخة احتياطية مشفّرة — ${fmtTime()}`),
  testPrint: () => toast('بيطبع صفحة تجربة على XP-80', 'info'),
});

/* ===== شاشة القفل: اختيار المستخدم ثم PIN من 4 أرقام ===== */
function viewLock() {
  const u = S.lockUser;
  const body = !u
    ? `<div class="muted">مين هيشتغل دلوقتي؟</div>
       <div class="users">${DATA.users.map((x) => `<button type="button" class="user-card" data-act="lockPick" data-id="${x.id}">${avatar(x, 'lg')}<b>${esc(x.name)}</b><small>${roleName(x)}</small></button>`).join('')}</div>`
    : `<div class="row" style="justify-content:center;margin-top:12px">${avatar(u, 'lg')}</div>
       <div style="margin-top:6px"><b>${esc(u.name)}</b> <span class="muted">· ${roleName(u)}</span></div>
       <div class="pin-dots">${[0, 1, 2, 3].map((i) => `<i class="${i < S.pin.length ? 'on' : ''}"></i>`).join('')}</div>
       <div class="err-msg">${esc(S.pinErr)}</div>
       <div class="numpad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-act="pinKey" data-k="${n}">${num(n)}</button>`).join('')}
         <button type="button" data-act="lockBack" title="رجوع (Esc)">${icon('arrow-right')}</button>
         <button type="button" data-act="pinKey" data-k="0">${num(0)}</button>
         <button type="button" data-act="pinKey" data-k="del" title="مسح">${icon('delete')}</button></div>`;
  return `<div class="lock"><div class="lock-card ${S.pinErr ? 'shake' : ''}">
    ${logoHTML()}<h2>${esc(SET.shopName)}</h2>${body}
    <div class="demo-hint">للتجربة بس: ${DATA.users.map((x) => `${esc(x.name)} <bdi dir="ltr" class="mono">${x.pin}</bdi>`).join(' · ')}</div>
  </div></div>`;
}
function digitFromKey(e) {
  if (/^Digit[0-9]$/.test(e.code)) return +e.code.slice(5);
  if (/^Numpad[0-9]$/.test(e.code)) return +e.code.slice(6);
  const t = toLatin(e.key);
  return /^[0-9]$/.test(t) ? +t : null;
}
function lockKey(e) {
  const d = digitFromKey(e);
  if (!S.lockUser) { if (d && d <= DATA.users.length) { e.preventDefault(); S.lockUser = DATA.users[d - 1]; render(); } return; }
  if (d !== null) { e.preventDefault(); pinPress(String(d)); return; }
  if (e.key === 'Backspace') { e.preventDefault(); pinPress('del'); return; }
  if (e.key === 'Escape') { S.lockUser = null; S.pin = ''; S.pinErr = ''; render(); }
}
function pinPress(k) {
  if (!S.lockUser) return;
  if (k === 'del') { S.pin = S.pin.slice(0, -1); S.pinErr = ''; render(); return; }
  if (S.pin.length >= 4) return;
  S.pin += k; S.pinErr = '';
  if (S.pin.length === 4) {
    if (S.pin === S.lockUser.pin) { unlockAs(S.lockUser); return; }
    S.pinErr = 'الـ PIN غلط — جرّب تاني'; S.pin = ''; beep();
  }
  render();
}
function unlockAs(u) {
  Object.assign(S, { user: u, locked: false, lockUser: null, pin: '', pinErr: '' });
  const n = NAV.find((x) => x.id === S.view);
  if (n && n.owner && u.role !== 'owner') S.view = 'pos';
  render(); focusSearch(); toast(`أهلاً يا ${u.name}`);
}
Object.assign(ACT, {
  lockPick: (d) => { S.lockUser = DATA.users.find((u) => u.id === d.id); S.pin = ''; S.pinErr = ''; render(); },
  pinKey: (d) => pinPress(d.k),
  lockBack: () => { S.lockUser = null; S.pin = ''; S.pinErr = ''; render(); },
});

/* ===== معاينة تطبيق الموبايل (مساعد جوه المحل على الـ Wi-Fi) ===== */
function phoneFrame(cap, ic, sub, screen) {
  return `<div class="phone-wrap"><div class="cap">${icon(ic)} ${cap}</div>
    <div class="phone"><div class="screen"><div class="ph-status"><span>${fmtTime()}</span><span>${icon('wifi')} ${icon('signal')}</span></div>${screen}</div></div>
    <div class="cap-s">${sub}</div></div>`;
}
// مبيعات النهارده على الموبايل: بتتقري من الكمبيوتر على طول (Wi-Fi المحل). المالك يشوف كله، والبيّاع مبيعاته بس
function salesScreen() {
  const d = DATA.dash.today, own = isOwner(), me = S.user;
  const total = own ? d.sales : (d.bySeller[me.id] || 0), count = own ? d.invoices : (d.countBySeller[me.id] || 0);
  const vsY = Math.round(((d.sales - d.yesterday) / d.yesterday) * 100);
  const recent = DATA.dash.recent.filter((r) => own || r.sellerId === me.id).slice(0, own ? 3 : 4);
  const maxV = Math.max(1, ...DATA.users.map((u) => d.bySeller[u.id] || 0));
  return `<div class="ph-head"><b>${own ? 'مبيعات النهارده' : 'مبيعاتك النهارده'}</b><span class="tag ok"><span class="dot"></span> مباشر</span></div>
    <div class="ph-body">
      <div class="ph-card ph-total"><span class="muted">${own ? 'إجمالي المحل' : `مبيعات ${esc(me.name)}`}</span><b class="num big">${money(total)}</b>
        <div class="r"><span class="muted">${num(count)} فاتورة</span>${own ? `<span class="${vsY >= 0 ? 'ok-t' : 'danger-t'}">${icon(vsY >= 0 ? 'trending-up' : 'trending-down')} ${num(Math.abs(vsY))}% عن امبارح</span>` : ''}</div>
        ${own ? `<div class="r"><span class="muted">الربح (للمالك بس)</span><b class="num">${money(d.profit)}</b></div>` : ''}</div>
      ${own ? `<div class="ph-card"><span class="muted" style="font-size:.8rem">مين باع كام</span>${DATA.users.map((u) => { const v = d.bySeller[u.id] || 0; return `<div class="seller-bar"><span class="nm">${esc(u.name)}</span><span class="bar-track"><i style="width:${Math.round((v / maxV) * 100)}%;background:${u.color}"></i></span><b class="num">${money(v)}</b></div>`; }).join('')}</div>` : ''}
      <div class="ph-list">${recent.map((r) => `<div class="ph-sale ${r.fresh ? 'fresh' : ''}"><div class="r"><b class="num">فاتورة ${dg(r.no)}</b><b class="num">${money(r.total)}</b></div><div class="r muted"><span>${dg(r.at)} · ${esc(r.seller)}</span>${r.fresh ? '<span class="tag accent">جديدة</span>' : `<span>${esc(r.method)}</span>`}</div></div>`).join('') || '<div class="muted" style="font-size:.85rem;text-align:center">لسه مفيش مبيعات</div>'}</div>
    </div>`;
}
function scanScreen() {
  const t = totals(), last = S.mobile.last;
  return `<div class="ph-head"><b>ماسح الكاشير</b><span class="tag ok"><span class="dot"></span> متصل</span></div>
    <div class="ph-body">
      <div class="viewfinder"><div class="box-art"></div><div class="scan-frame"><div class="scan-line"></div></div><span class="vf-cap">وجّه الكاميرا على باركود الـ IMEI</span></div>
      <button type="button" class="btn primary block" data-act="mScan">${icon('scan-barcode')} امسح علبة موبايل</button>
      <button type="button" class="btn block" data-act="mScanAcc">${icon('scan-line')} امسح باركود إكسسوار</button>
      ${last ? `<div class="ph-card"><div class="r"><b><bdi dir="rtl">${esc(last.name)}</bdi></b><span class="ok-t">${icon('circle-check')}</span></div>${last.imei ? `<div class="muted" style="font-size:.8rem">IMEI ${imeiHTML(last.imei)}</div>` : ''}<div class="muted" style="font-size:.8rem">اتبعت لشاشة البيع</div></div>` : ''}
      <div class="ph-card"><div class="r"><span class="muted">فاتورة الكاشير دلوقتي</span><b class="num">${money(t.total)}</b></div><div class="muted" style="font-size:.8rem">${num(t.count)} قطعة</div></div>
    </div>`;
}
function lookupScreen() {
  const found = searchAll(S.mobile.lookupQ).filter((r) => r.type === 'prod').map((r) => r.p).slice(0, 3);
  return `<div class="ph-head"><b>سعر ومخزون</b></div><div class="ph-body">
    <label class="inline-search">${icon('search')}<input id="m-look" data-input="mLook" value="${esc(S.mobile.lookupQ)}" placeholder="اسم الصنف…" autocomplete="off"></label>
    ${found.length ? found.map((p) => {
      const st = stockOf(p), colors = p.serial ? [...new Set(unitsFree(p.id).map((u) => u.color).filter(Boolean))] : [], img = prodImg(p);
      return `<div class="ph-card"><div class="ph-prod">${img ? `<img class="ph-thumb" src="${img}" alt="">` : ''}<b><bdi dir="rtl">${esc(p.name)}</bdi></b></div>
        <div class="r"><span class="num" style="font-size:1.2rem;font-weight:700">${money(p.price)}</span><span class="tag ${st <= 0 ? 'danger' : st <= p.min ? 'warn' : 'ok'}">${st <= 0 ? 'خلصان' : `متاح ${num(st)}`}</span></div>
        ${colors.length ? `<div class="muted" style="font-size:.8rem">الألوان: ${colors.map(esc).join('، ')}</div>` : ''}
        ${isOwner() ? `<div class="muted" style="font-size:.8rem">التكلفة (للمالك): ${money(p.cost)}</div>` : ''}</div>`;
    }).join('') : '<div class="muted" style="text-align:center;padding:20px 0">اكتب اسم الصنف</div>'}
  </div>`;
}
function recvScreen() {
  const M = S.mobile, p = prod(M.recvPid), byQty = M.recvMode === 'qty';
  const head = `<div class="ph-head"><b>استلام بضاعة</b></div><div class="ph-body">
    <div class="ph-card"><div class="r"><span class="muted">المورد</span><b>شركة النور</b></div><div class="r"><span class="muted">الصنف</span><b><bdi dir="rtl">${esc(p.name)}</bdi></b></div><div class="r"><span class="muted">تكلفة الجهاز</span><b class="num">${isOwner() ? money(p.cost) : '****'}</b></div></div>
    <div class="seg ph-seg"><button type="button" class="${byQty ? '' : 'on'}" data-act="mRecvMode" data-id="imei">${icon('scan-barcode')} بالـ IMEI</button><button type="button" class="${byQty ? 'on' : ''}" data-act="mRecvMode" data-id="qty">${icon('hash')} بالعدد</button></div>`;
  if (byQty) {
    return `${head}
    <div class="ph-card"><div class="r"><b>العدد</b><div class="qty"><button type="button" data-act="mRecvQty" data-d="1" title="زوّد">${icon('plus')}</button><span class="num">${num(M.recvQty)}</span><button type="button" data-act="mRecvQty" data-d="-1" title="قلّل">${icon('minus')}</button></div></div>
      <div class="muted" style="font-size:.8rem">الأجهزة بتدخل المخزون من غير IMEI — ولو حبيت تسجّله، بيتسجّل وقت البيع</div></div>
    <button type="button" class="btn primary block" data-act="mRecvSaveQty">${icon('save')} حفظ الاستلام</button>
  </div>`;
  }
  return `${head}
    <div class="ph-card"><div class="r"><b>اتمسح ${num(M.recv.length)} من ${num(5)}</b><span class="tag accent">${icon('scan-barcode')} IMEI</span></div></div>
    <div class="ph-list">${M.recv.map((im, i) => `<div class="ph-item"><span class="rank">${num(i + 1)}</span>${imeiHTML(im)}<span class="sp"></span><span class="ok-t">${icon('circle-check')}</span></div>`).join('') || '<div class="muted" style="font-size:.85rem">لسه مفيش</div>'}</div>
    <button type="button" class="btn primary block" data-act="mRecvScan" ${M.recv.length >= 5 ? 'disabled' : ''}>${icon('scan-barcode')} امسح الجهاز اللي بعده</button>
    <button type="button" class="btn block" data-act="mRecvSave" ${M.recv.length ? '' : 'disabled'}>${icon('save')} حفظ الاستلام</button>
  </div>`;
}
function viewMobile() {
  return `<div class="page">
    <div class="page-h"><h2>تطبيق الموبايل</h2><span class="sub">مساعد جوه المحل على نفس الـ Wi-Fi — بيكلّم الكمبيوتر على طول ومن غير إنترنت</span><span class="sp"></span>
      <span class="status"><span class="dot"></span>${icon('wifi')} شبكة المحل · <bdi dir="ltr" class="mono">192.168.1.10</bdi></span></div>
    <div class="phones">
      ${phoneFrame('مبيعات النهارده', 'chart-column', isOwner() ? 'أي بيعة بتتسجّل على الكمبيوتر بتظهر هنا في نفس اللحظة. المالك يشوف كل المبيعات ومين باع كام' : 'البيّاع يشوف مبيعاته هو بس — إجمالي المحل والربح للمالك', salesScreen())}
      ${phoneFrame('ماسح للكاشير', 'scan-line', 'الكاميرا بتقرا الـ IMEI أو الباركود وتبعته لشاشة البيع على طول — بدل جهاز الباركود', scanScreen())}
      ${phoneFrame('سعر ومخزون', 'search', 'أي بيّاع يعرف السعر والمتاح والألوان وهو واقف مع الزبون', lookupScreen())}
      ${phoneFrame('استلام بضاعة', 'package-plus', 'بالـ IMEI (تمسح العلب) أو بالعدد من غير IMEI — زي ما يناسبك', recvScreen())}
    </div>
    <div class="note phones-note">${icon('wifi')} ده شغال طول ما الموبايل على Wi-Fi المحل، من غير إنترنت. متابعة المبيعات من برّه المحل (من البيت مثلًا) محتاجة مزامنة على الإنترنت — مرحلة جاية في الخطة.</div>
  </div>`;
}
VIEWS.mobile = viewMobile;
INPUT.mLook = (el) => { S.mobile.lookupQ = el.value; render(); };
Object.assign(ACT, {
  mScan: () => {
    const free = DATA.units.filter((u) => u.status === 'in' && !inAnyCart(u.imei) && stockOf(prod(u.pid)) > 0);
    if (!free.length) { toast('مفيش أجهزة متاحة', 'err'); return; }
    const u = free[Math.floor(Math.random() * free.length)];
    S.mobile.last = { name: prod(u.pid).name, imei: u.imei };
    addUnit(u);
  },
  mScanAcc: () => {
    const acc = DATA.products.filter((p) => !p.serial && p.stock > 0);
    const p = acc[Math.floor(Math.random() * acc.length)];
    S.mobile.last = { name: p.name };
    addItem(p); toast(`اتضاف ${p.name} من الموبايل لفاتورة الكاشير`);
  },
  mRecvMode: (d) => { S.mobile.recvMode = d.id === 'qty' ? 'qty' : 'imei'; render(); },
  mRecvQty: (d) => { S.mobile.recvQty = clamp(S.mobile.recvQty + +d.d, 1, 99); render(); },
  mRecvSaveQty: () => {
    const M = S.mobile, p = prod(M.recvPid), n = M.recvQty;
    p.stock += n; M.recvQty = 1; render();
    toast(`اتضاف ${num(n)} جهاز «${p.name}» للمخزون من غير IMEI`);
  },
  mRecvScan: () => { const M = S.mobile, im = DATA.makeImei(prod(M.recvPid).tac); M.recv.push(im); render(); toast(`اتمسح IMEI …${im.slice(-4)}`); },
  mRecvSave: () => {
    const M = S.mobile, p = prod(M.recvPid), today = new Date().toISOString().slice(0, 10);
    M.recv.forEach((im, i) => DATA.units.push({ imei: im, imei2: DATA.makeImei(p.tac), pid: p.id, color: p.colors[i % p.colors.length], storage: p.storage, condition: 'جديد', battery: null, customs: null, cost: p.cost, received: today, status: 'in' }));
    p.stock += M.recv.length;
    toast(`اتضاف ${num(M.recv.length)} جهاز «${p.name}» للمخزون`);
    M.recv = []; render();
  },
});

/* ===== تشغيل ===== */
S.mobile.recv = [DATA.makeImei(prod('p5').tac), DATA.makeImei(prod('p5').tac)];
applySettings();
render();
focusSearch();
