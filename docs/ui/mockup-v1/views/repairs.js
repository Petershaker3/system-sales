'use strict';
// شاشة «الصيانة». الكود متقسم ملف لكل شاشة — الترتيب في index.html، والدليل: docs/ENGINEERING.md
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
    <div class="who">${icon('user')} ${esc(r.customer)} <bdi dir="ltr" class="mono">${r.phone}</bdi></div>
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
      ${modalHead('استلام جهاز صيانة', `تذكرة R-${nextRepairNo()}`)}
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
  toast(`اتسجّلت تذكرة ${no}. ${hasPrinter() ? 'إيصال الاستلام بيتطبع' : `إيصال الاستلام اتبعت على واتساب ${ph}`}`);
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
    toast(`${r.no} بقت «${st.find((s) => s.id === r.status).name}»${r.status === 'ready' ? '. تقدر تبعت للعميل واتساب' : ''}`);
  },
  repWa: (d) => toast(`اتبعت لعميل ${d.no} رسالة واتساب إن الجهاز جاهز`),
  deliver: (d) => {
    const r = S.repairs.find((x) => x.no === d.no), left = Math.max(0, r.estimate - r.deposit);
    addService({ name: `صيانة ${r.no}: ${r.device}`, price: left, icon: 'wrench', note: `${r.issue}${r.deposit ? `، والعربون ${money(r.deposit)} اتخصم` : ''}`, repairNo: r.no });
    if (!cur().customer) { const c = DATA.customers.find((x) => x.phone === r.phone); if (c) cur().customer = c; }
    S.view = 'pos'; render(); focusSearch();
    toast(`اتضافت صيانة ${r.no} للفاتورة. حصّل ${money(left)}`);
  },
});
