'use strict';
// نافذة «استلام بضاعة» من الكمبيوتر. الكود متقسم ملف لكل شاشة — الترتيب في index.html، والدليل: docs/ENGINEERING.md
/* ===== الاستلام (docs/ui/MONTHS-REPORTS-RECEIVING.md، المرحلة 4) =====
   زي البرنامج الحقيقي (commands/inventory.rs: receive_stock): الصنف والعدد وتكلفة الوحدة، والمورد اسم اختياري.
   - التكلفة بالمتوسط المرجح (ADR-002، receiveCost في analytics.js)، والجهاز اللي بالـ IMEI بيحتفظ بتكلفته هو.
   - تكلفة الوحدة بتظهر وتتكتب للمالك بس. البيّاع بيستلم بآخر تكلفة، فالمتوسط ما يتغيرش.
   - الـ IMEI اختياري أو إجباري حسب الإعدادات، ويتكتب أو يتمسح بالماسح أو بالموبايل.
   - الصنف اللي في «النواقص» بيتشال لوحده لما يوصل، ولو فيه عميل مستنيه بيتقال اسمه ورقمه.
   السرعة: الاسم ← Enter ← العدد ← Enter ← التكلفة ← Enter ← اللي بعده. والموبايل: كل علبة تتمسح ← Enter.
   الصنف اللي مش متسجّل: «صنف جديد» (views/catalog.js) أو Enter لما البحث ما يلاقيش، وبعد التسجيل بينزل هنا.
   «بضاعة موجودة عندي (أول مرة)» للمالك بس: البضاعة اللي في المحل يوم ما بيبدأ، من غير مورد، وما بتتحسبش مشتريات (PLAN §11). */
const rcOpen = (o = {}) => openModal({ type: 'receive', mode: isOwner() && o.mode === 'opening' ? 'opening' : 'supplier', supplier: '', q: '', hi: 0, lines: [], err: '', imErr: null, confirmClose: false, focusId: '' });
// البحث: الباركود بالأرقام، أو الاسم بنفس ترتيب شاشة البيع (rankProducts في pos.js)
function rcResults(m) {
  const raw = toLatin(m.q).trim(), qn = normalize(raw), digits = raw.replace(/\s/g, '');
  if (!qn) return [];
  if (/^\d{6,}$/.test(digits)) return DATA.products.filter((p) => p.sku && p.sku.includes(digits)).slice(0, 6);
  return rankProducts(qn, 6);
}
const rcFocus = (id) => { const el = document.getElementById(id); if (el) { el.focus({ preventScroll: false }); if (el.select) el.select(); } };
const rcTotals = (m) => ({ qty: m.lines.reduce((a, l) => a + l.qty, 0), cost: m.lines.reduce((a, l) => a + l.qty * l.cost, 0) });
function rcAdd(pid) {
  const m = S.modal, p = prod(pid);
  if (!p) return;
  let i = m.lines.findIndex((l) => l.pid === pid);
  if (i < 0) { m.lines.push({ pid, qty: 1, qtyT: '1', cost: p.cost, costT: String(p.cost), imeis: [], imQ: '' }); i = m.lines.length - 1; }
  Object.assign(m, { q: '', hi: 0, err: '', confirmClose: false });
  render(); rcFocus(p.serial ? `rc-im-${i}` : `rc-qty-${i}`);
}
// IMEI: 15 رقم ورقم المراجعة صح، ومش متسجّل قبل كده ولا مكتوب مرتين في الاستلام ده. والعدد بيزيد لوحده
function rcImei(i, raw) {
  const m = S.modal, l = m.lines[i], f = toLatin(raw).replace(/\D/g, '');
  const fail = (msg) => { m.imErr = { i, msg }; render(); rcFocus(`rc-im-${i}`); };
  if (f.length !== 15) return fail('الـ IMEI لازم يكون 15 رقم');
  if (!luhnOk(f)) return fail('الرقم ده مش IMEI صحيح: رقم المراجعة غلط');
  const other = DATA.units.find((u) => u.imei === f || u.imei2 === f);
  if (other) return fail(`الـ IMEI ده متسجّل قبل كده على «${prod(other.pid).name}»`);
  if (m.lines.some((x) => x.imeis.includes(f))) return fail('الـ IMEI ده اتكتب في الاستلام ده قبل كده');
  l.imeis.push(f); l.imQ = '';
  if (l.imeis.length > l.qty) { l.qty = l.imeis.length; l.qtyT = String(l.qty); }
  m.imErr = null; m.err = ''; render(); rcFocus(`rc-im-${i}`);
}
// الجهاز المستعمل: الـ IMEI وتفاصيله اتكتبوا في «صنف جديد»، فالسطر بيعرضهم والعدد واحد
const metaTags = (l) => [`<span class="tag accent">IMEI ${imeiHTML(l.imeis[0])}</span>`, `<span class="tag">${esc(l.meta.condition)}</span>`,
  l.meta.battery ? `<span class="tag">بطارية ${num(l.meta.battery)}%</span>` : '', l.meta.color ? `<span class="tag">${esc(l.meta.color)}</span>` : '',
  l.meta.box.length ? `<span class="tag">معاه ${esc(l.meta.box.join(' و'))}</span>` : '', l.meta.notes ? `<span class="muted">${esc(l.meta.notes)}</span>` : ''].join('');
const af = (m, id) => (m.focusId === id ? 'data-autofocus' : '');
function rcLineHTML(m, l, i, own) {
  const p = prod(l.pid), cols = own ? 7 : 4, need = imeiRequired() && l.imeis.length < l.qty;
  if (l.meta) {
    return `<tr><td><bdi dir="rtl">${esc(p.name)}</bdi><small class="muted">${esc(catFull(p.cat))}</small></td><td class="ta-n num">${num(stockOf(p))}</td>
    <td class="ta-n"><input id="rc-qty-${i}" class="rc-in num" value="1" readonly dir="ltr" aria-label="عدد «${esc(p.name)}»" title="الجهاز المستعمل جهاز واحد"></td>
    ${own ? `<td class="ta-n"><input id="rc-cost-${i}" class="rc-in num" data-input="rcCost" data-i="${i}" value="${esc(l.costT)}" inputmode="numeric" dir="ltr" autocomplete="off" ${af(m, `rc-cost-${i}`)} aria-label="تكلفة «${esc(p.name)}»"></td><td class="ta-n num">${money(l.cost)}</td><td class="ta-n"><span class="muted">بتكلفته</span></td>` : ''}
    <td class="ta-n"><button type="button" class="icon-btn sm danger" data-act="rcDel" data-i="${i}" title="شيل الجهاز ده" aria-label="شيل «${esc(p.name)}»">${icon('x')}</button></td></tr>
    <tr class="rc-imrow"><td colspan="${cols}"><div class="rc-imei">${metaTags(l)}</div></td></tr>`;
  }
  const after = p.serial ? '<span class="muted">كل جهاز بتكلفته</span>' : money(receiveCost(p.stock, p.cost, l.qty, l.cost));
  let html = `<tr><td><bdi dir="rtl">${esc(p.name)}</bdi><small class="muted">${esc(catFull(p.cat))}</small></td><td class="ta-n num">${num(stockOf(p))}</td>
    <td class="ta-n"><input id="rc-qty-${i}" class="rc-in num" data-input="rcQty" data-i="${i}" value="${esc(l.qtyT)}" inputmode="numeric" dir="ltr" autocomplete="off" ${af(m, `rc-qty-${i}`)} aria-label="عدد «${esc(p.name)}»"></td>
    ${own ? `<td class="ta-n"><input id="rc-cost-${i}" class="rc-in num" data-input="rcCost" data-i="${i}" value="${esc(l.costT)}" inputmode="numeric" dir="ltr" autocomplete="off" aria-label="تكلفة الوحدة «${esc(p.name)}»"></td>
      <td class="ta-n num">${money(l.qty * l.cost)}</td><td class="ta-n num" title="بالمتوسط المرجح: (قيمة اللي في المخزن + قيمة الاستلام) ÷ العدد الجديد">${after}</td>` : ''}
    <td class="ta-n"><button type="button" class="icon-btn sm danger" data-act="rcDel" data-i="${i}" title="شيل الصنف ده" aria-label="شيل «${esc(p.name)}»">${icon('x')}</button></td></tr>`;
  if (p.serial) {
    html += `<tr class="rc-imrow"><td colspan="${cols}"><div class="rc-imei">
      <label class="inline-search rc-ims">${icon('scan-barcode')}<input id="rc-im-${i}" data-input="rcImQ" data-i="${i}" value="${esc(l.imQ)}" ${af(m, `rc-im-${i}`)} placeholder="اكتب أو امسح الـ IMEI ودوس Enter" inputmode="numeric" dir="ltr" autocomplete="off" aria-label="IMEI «${esc(p.name)}»"></label>
      <button type="button" class="btn sm" data-act="rcPhone" data-i="${i}" title="افتح الموبايل على «استلام» وامسح العلب: الأرقام بتنزل هنا على طول">${icon('smartphone')} امسح بالموبايل</button>
      <span class="rc-cnt ${need ? 'warn-t' : 'muted'}">${num(l.imeis.length)} من ${num(l.qty)} بالـ IMEI${!imeiRequired() && l.imeis.length < l.qty ? '، والباقي بالعدد' : ''}</span>
      ${m.imErr && m.imErr.i === i ? `<span class="danger-t rc-err" role="alert">${icon('triangle-alert')} ${esc(m.imErr.msg)}</span>` : ''}
      ${l.imeis.length ? `<div class="rc-chips">${l.imeis.map((im, k) => `<span class="tag accent">${imeiHTML(im)}<button type="button" class="rc-x" data-act="rcImDel" data-i="${i}" data-k="${k}" title="شيل الـ IMEI ده" aria-label="شيل الـ IMEI اللي آخره ${im.slice(-4)}">${icon('x')}</button></span>`).join('')}</div>` : ''}
    </div></td></tr>`;
  }
  return html;
}
MODALS.receive = {
  html: (m) => {
    const own = isOwner(), L = m.lines, T = rcTotals(m), res = rcResults(m), last = DATA.receipts[DATA.receipts.length - 1];
    const sups = [...new Set(DATA.receipts.map((r) => r.supplier).filter(Boolean))];
    const opening = m.mode === 'opening';
    return `<div class="modal wide" role="dialog" aria-label="استلام بضاعة">
      ${modalHead('استلام بضاعة', last ? `آخر استلام ${fmtDate(last.at)}${last.supplier ? ` من «${esc(last.supplier)}»` : last.kind === 'opening' ? '، بضاعة أول مرة' : ''}` : 'أول مرة: سجّل البضاعة اللي في المحل')}
      <div class="modal-b stack">
        ${own ? `<div class="seg rc-mode" role="group" aria-label="نوع الاستلام">${[['supplier', 'package-plus', 'من مورد'], ['opening', 'store', 'بضاعة موجودة عندي (أول مرة)']].map(([id, ic, l]) => `<button type="button" class="${m.mode === id ? 'on' : ''}" data-act="rcMode" data-id="${id}" aria-pressed="${m.mode === id}">${icon(ic)} ${l}</button>`).join('')}</div>` : ''}
        ${opening ? `<div class="note">${icon('info')} بتسجّل البضاعة اللي في المحل دلوقتي وتكلفتها، عشان تبدأ صح. من غير مورد، وما بتتحسبش مشتريات.</div>` : ''}
        <div class="rc-top ${opening ? 'solo' : ''}">
          ${opening ? '' : `<div class="field rc-sup"><label for="rc-sup">المورد <span class="muted">(اختياري)</span></label><input id="rc-sup" data-input="rcSup" list="rc-sups" value="${esc(m.supplier)}" placeholder="مين اللي جاب البضاعة" autocomplete="off"><datalist id="rc-sups">${sups.map((s) => `<option value="${esc(s)}"></option>`).join('')}</datalist></div>`}
          <div class="field rc-find"><label for="rc-q">ضيف صنف</label><div class="rc-find-row"><label class="inline-search">${icon('search')}<input id="rc-q" data-input="rcQ" ${m.focusId ? '' : 'data-autofocus'} value="${esc(m.q)}" placeholder="اسم الصنف أو الباركود…" autocomplete="off" aria-controls="rc-res"></label>
            <button type="button" class="btn" data-act="rcNew" title="صنف لسه مش متسجّل: موبايل جديد أو مستعمل أو إكسسوار">${icon('circle-plus')} صنف جديد</button></div></div>
        </div>
        ${m.q ? `<div class="rc-res" id="rc-res" role="listbox" aria-label="الأصناف">${res.length ? res.map((p, i) => `<div class="result ${i === m.hi ? 'on' : ''}" role="option" aria-selected="${i === m.hi}" data-act="rcAdd" data-id="${p.id}">
            <div class="ico">${icon(p.serial ? 'smartphone' : 'package')}</div>
            <div class="t"><div class="n"><bdi dir="rtl">${esc(p.name)}</bdi></div><div class="s"><span>${esc(catFull(p.cat))}</span><span>المتاح ${num(stockOf(p))}</span>${p.serial ? '<span>بالـ IMEI</span>' : ''}</div></div>
            ${own ? `<div class="p muted num">آخر تكلفة ${money(p.cost)}</div>` : ''}</div>`).join('')
          : `<div class="rc-none"><span class="muted">مفيش صنف بالاسم ده.</span> <button type="button" class="btn sm soft" data-act="rcNew">${icon('circle-plus')} سجّل «${esc(m.q.trim())}» صنف جديد <kbd>Enter</kbd></button></div>`}</div>` : ''}
        ${L.length ? `<div class="table-wrap"><table class="t rc-t"><thead><tr><th>الصنف</th><th class="ta-n">المتاح دلوقتي</th><th class="ta-n">العدد</th>${own ? '<th class="ta-n">تكلفة الوحدة</th><th class="ta-n">الإجمالي</th><th class="ta-n">التكلفة بعد الاستلام</th>' : ''}<th aria-hidden="true"></th></tr></thead>
          <tbody>${L.map((l, i) => rcLineHTML(m, l, i, own)).join('')}</tbody></table></div>`
        : `<div class="sv-empty">${icon('package-plus')}<b>لسه مفيش أصناف</b><span>دوّر على الصنف وضيفه، وبعدين اكتب العدد${own ? ' وتكلفة الوحدة' : ''}. الموبايلات تتمسح علبها بالماسح أو بالموبايل. والصنف اللي مش متسجّل: «صنف جديد».</span></div>`}
        ${m.err ? `<div class="note warn" role="alert">${icon('triangle-alert')} ${esc(m.err)}</div>` : ''}
      </div>
      <div class="modal-f"><span class="muted">${L.length ? `${pcsWord(T.qty)} من ${itemsWord(L.length)}${own ? `، التكلفة ${money(T.cost)}` : ''}` : (own ? 'تكلفة الوحدة بتتحسب بالمتوسط المرجح' : 'التكلفة بيكتبها المالك')}</span><span class="sp"></span>
        <button type="button" class="btn ghost" data-act="closeModal">إلغاء <kbd>Esc</kbd></button>
        <button type="button" class="btn primary" data-act="rcSave" ${L.length ? '' : 'disabled'}>${icon('save')} ${opening ? 'سجّل البضاعة' : 'حفظ الاستلام'} <kbd>Ctrl+Enter</kbd></button></div>
    </div>`;
  },
  key: (e, m) => {
    const t = e.target, id = (t && t.id) || '';
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ACT.rcSave(); return true; }
    if (id === 'rc-q') {
      const res = rcResults(m);
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && res.length) { e.preventDefault(); m.hi = (m.hi + (e.key === 'ArrowDown' ? 1 : res.length - 1)) % res.length; render(); return true; }
      if (e.key === 'Enter') { e.preventDefault(); if (res[m.hi]) rcAdd(res[m.hi].id); else if (m.q.trim()) openNewItem({ name: m.q }); return true; }
    }
    if (e.key !== 'Enter') return false;
    const n = (pre) => Number(id.slice(pre.length)), serial = (i) => prod(m.lines[i].pid).serial && !m.lines[i].meta;
    if (id.startsWith('rc-im-')) { e.preventDefault(); if (t.value.trim()) rcImei(n('rc-im-'), t.value); else rcFocus('rc-q'); return true; }
    if (id.startsWith('rc-qty-')) { e.preventDefault(); const i = n('rc-qty-'); rcFocus(isOwner() ? `rc-cost-${i}` : serial(i) ? `rc-im-${i}` : 'rc-q'); return true; }
    if (id.startsWith('rc-cost-')) { e.preventDefault(); const i = n('rc-cost-'); rcFocus(serial(i) ? `rc-im-${i}` : 'rc-q'); return true; }
    return false;
  },
  // فيه أصناف لسه ماتحفظتش: أول قفل بينبّه، والتاني بيقفل
  canClose: (m) => {
    if (m.saved || !m.lines.length || m.confirmClose) return true;
    m.confirmClose = true; m.err = 'فيه أصناف لسه ماتحفظتش. لو عايز تقفل من غير حفظ دوس «إلغاء» أو Esc تاني'; render();
    return false;
  },
};
// الاستلام نفسه، من الكمبيوتر ومن الموبايل: رصيد المخزن، والتكلفة بالمتوسط المرجح، والأجهزة بالـ IMEI بتكلفتها،
// والسجل، والنواقص. lines: [{ pid, qty, cost, imeis }]، وcost هي تكلفة الوحدة (اللي بيكتبها المالك، وغير كده آخر تكلفة).
// بترجّع النواقص اللي اتقفلت عشان الشاشة تقول عليها
// kind: «supplier» من مورد، أو «opening» بضاعة أول مرة. l.meta = تفاصيل الجهاز المستعمل من «صنف جديد»
function applyReceipt(supplier, lines, kind = 'supplier') {
  const today = isoDay(new Date());
  for (const l of lines) {
    const p = prod(l.pid), mt = l.meta;
    if (p.serial) {
      // الجهاز اللي بالـ IMEI بتكلفته هو، واللي بالعدد بيدخل في متوسط الأجهزة اللي من غير IMEI
      const unreg = Math.max(0, p.stock - unitsIn(p.id).length), byCount = l.qty - l.imeis.length;
      l.imeis.forEach((im, k) => DATA.units.push(mt
        ? { imei: im, imei2: mt.imei2, pid: p.id, color: mt.color, storage: p.storage, condition: mt.condition, battery: mt.battery, box: mt.box, notes: mt.notes, seller: mt.seller, customs: null, cost: l.cost, received: today, status: 'in' }
        : { imei: im, imei2: DATA.makeImei(p.tac), pid: p.id, color: p.colors && p.colors.length ? p.colors[k % p.colors.length] : null, storage: p.storage, condition: catKind(p.cat) === 'used' ? 'مستعمل' : 'جديد', battery: null, customs: null, cost: l.cost, received: today, status: 'in' }));
      if (byCount > 0) p.cost = receiveCost(unreg, p.cost, byCount, l.cost);
    } else p.cost = receiveCost(p.stock, p.cost, l.qty, l.cost);
    p.stock += l.qty;
  }
  const last = DATA.receipts[DATA.receipts.length - 1];
  DATA.receipts.push({ no: last ? last.no + 1 : 1, at: new Date(), kind, supplier: kind === 'opening' ? '' : supplier, by: S.user.id, lines: lines.map((l) => ({ pid: l.pid, qty: l.qty, cost: l.cost, imeis: [...l.imeis] })) });
  const arrived = SHORT.filter((x) => x.pid && lines.some((l) => l.pid === x.pid));
  if (arrived.length) { for (const x of arrived) SHORT.splice(SHORT.indexOf(x), 1); saveShort(); }
  return arrived;
}
// الأصناف اللي اتسجّلت في «صنف جديد» بتنزل هنا بعددها وتكلفتها، والمؤشر على أول واحد فيهم
function rcAddLines(m, items) {
  const at = m.lines.length;
  for (const x of items) m.lines.push({ pid: x.p.id, qty: x.qty, qtyT: String(x.qty), cost: x.p.cost, costT: String(x.p.cost), imeis: [...x.imeis], imQ: '', meta: x.meta || null });
  const f = items[0], i = at;
  Object.assign(m, { q: '', hi: 0, err: '', confirmClose: false, _mounted: false, focusId: !f ? '' : f.meta ? (isOwner() ? `rc-cost-${i}` : '') : f.p.serial ? `rc-im-${i}` : `rc-qty-${i}` });
}
const arrivedToasts = (arrived) => arrived.forEach((x) => toast(x.cust ? `«${x.name}» وصل، و${x.cust.name} مستنيه: ${x.cust.phone}` : `«${x.name}» وصل واتشال من النواقص`, 'info'));
const rcNum = (v) => { const n = parseInt(toLatin(v).replace(/[^\d]/g, ''), 10); return Number.isFinite(n) ? n : 0; };
Object.assign(INPUT, {
  rcSup: (el) => { S.modal.supplier = el.value; },
  rcQ: (el) => { Object.assign(S.modal, { q: el.value, hi: 0, focusId: '' }); render(); },
  rcQty: (el) => { const l = S.modal.lines[+el.dataset.i]; l.qtyT = el.value; l.qty = rcNum(el.value); S.modal.confirmClose = false; render(); },
  rcCost: (el) => { const l = S.modal.lines[+el.dataset.i]; l.costT = el.value; l.cost = rcNum(el.value); render(); },
  rcImQ: (el) => { S.modal.lines[+el.dataset.i].imQ = el.value; },
});
Object.assign(ACT, {
  recvOpen: () => rcOpen(),
  rcMode: (d) => { Object.assign(S.modal, { mode: d.id, err: '' }); render(); },
  rcNew: () => openNewItem({ name: S.modal.q }),
  rcAdd: (d) => rcAdd(d.id),
  rcDel: (d) => { const m = S.modal; m.lines.splice(+d.i, 1); m.imErr = null; render(); rcFocus('rc-q'); },
  rcImDel: (d) => { const l = S.modal.lines[+d.i]; l.imeis.splice(+d.k, 1); render(); },
  // الموبايل بيمسح العلبة والرقم بينزل هنا (في المعاينة: رقم تجريبي صحيح)
  rcPhone: (d) => { const i = +d.i, im = DATA.makeImei(prod(S.modal.lines[i].pid).tac); rcImei(i, im); toast(`الموبايل مسح IMEI …${im.slice(-4)}`, 'info'); },
  rcSave: () => {
    const m = S.modal;
    if (!m || m.type !== 'receive') return;
    const own = isOwner(), L = m.lines.filter((l) => l.qty > 0);
    const bad = (msg) => { m.err = msg; render(); };
    if (!L.length) return bad('اكتب عدد صنف واحد على الأقل');
    const less = m.lines.find((l) => l.qty < l.imeis.length);
    if (less) return bad(`عدد «${prod(less.pid).name}» أقل من الـ IMEI المكتوبة (${num(less.imeis.length)})`);
    if (imeiRequired()) { const miss = L.find((l) => prod(l.pid).serial && l.imeis.length < l.qty); if (miss) return bad(`الإعدادات بتقول IMEI لكل جهاز: «${prod(miss.pid).name}» ناقصه ${num(miss.qty - miss.imeis.length)}`); }
    // البيّاع بيستلم بآخر تكلفة، فالمتوسط ما يتغيرش
    const lines = L.map((l) => ({ pid: l.pid, qty: l.qty, cost: own ? l.cost : prod(l.pid).cost, imeis: l.imeis, meta: l.meta || null })), T = rcTotals({ lines });
    const arrived = applyReceipt(m.supplier.trim(), lines, m.mode);
    m.saved = true; closeModal();
    toast(`${m.mode === 'opening' ? 'اتسجّلت بضاعة أول مرة:' : 'اتاستلم'} ${pcsWord(T.qty)} من ${itemsWord(L.length)}${own ? `، التكلفة ${money(T.cost)}` : ''}`);
    arrivedToasts(arrived);
  },
});
