'use strict';
// شاشة «المخزون». الكود متقسم ملف لكل شاشة — الترتيب في index.html، والدليل: docs/ENGINEERING.md
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
    html += units.map((u) => `<tr class="sub"><td>${imeiHTML(u.imei)}</td><td>${esc(u.color || '—')}</td><td>${esc(u.storage)}</td><td>${esc(u.condition)}${u.battery ? `، بطارية ${num(u.battery)}%` : ''}</td>${own ? `<td class="num">${money(u.cost)}</td><td></td>` : ''}<td>${fmtDate(new Date(u.received))}</td><td>${u.status === 'in' ? (inAnyCart(u.imei) ? '<span class="tag accent">في فاتورة</span>' : '<span class="tag ok">متاح</span>') : '<span class="tag">اتباع</span>'}</td></tr>`).join('');
    if (unreg) html += `<tr class="sub"><td colspan="${own ? 8 : 6}"><span class="tag">${icon('hash')} ${num(unreg)} جهاز اتسلموا بالعدد من غير IMEI</span> <span class="muted">— الـ IMEI بتاعهم ممكن يتسجّل وقت البيع</span></td></tr>`;
  }
  return html;
}
function viewInventory() {
  const I = S.inv, q = normalize(I.q), own = isOwner();
  const tabs = `<div class="seg inv-seg"><button type="button" class="${I.tab !== 'short' ? 'on' : ''}" data-act="invView" data-id="items">الأصناف</button><button type="button" class="${I.tab === 'short' ? 'on' : ''}" data-act="invView" data-id="short">النواقص <span class="cnt num">${num(SHORT.length)}</span></button></div>`;
  if (I.tab === 'short') return `<div class="page">
    <div class="page-h"><h2>المخزون</h2>${tabs}<span class="sub">اكتب الناقص بإيدك، أو ضيفه من اقتراحات السيستم</span><span class="sp"></span>
      <button type="button" class="btn" data-act="goMobileRecv">${icon('package-plus')} استلام بضاعة</button></div>
    ${shortView()}
  </div>`;
  const qd = toLatin(I.q).replace(/\D/g, '');
  if (I.cat !== 'all' && !catById(I.cat)) I.cat = 'all';
  let list = DATA.products.filter((p) => (I.cat === 'all' || inCat(p, I.cat)) &&
    (!q || p._hay.includes(q) || (qd.length >= 4 && DATA.units.some((u) => u.pid === p.id && u.imei.includes(qd)))));
  const value = DATA.products.reduce((a, p) => a + stockValue(p), 0);
  return `<div class="page">
    <div class="page-h"><h2>المخزون</h2>${tabs}<span class="sub">${num(DATA.products.length)} صنف و${num(DATA.units.filter((u) => u.status === 'in').length)} جهاز بالـ IMEI</span>${own ? `<span class="tag accent">قيمة المخزون بالتكلفة ${money(value)}</span>` : ''}<span class="sp"></span>
      <label class="inline-search">${icon('search')}<input id="inv-q" data-input="invQ" value="${esc(I.q)}" placeholder="اسم أو كود أو IMEI…" autocomplete="off"></label>
      <button type="button" class="btn" data-act="goMobileRecv">${icon('package-plus')} استلام بضاعة</button>
      <button type="button" class="btn" data-act="soon">${icon('tag')} طباعة ملصقات</button></div>
    ${catChipsHTML(I.cat, 'invCat')}
    <div class="table-wrap"><table class="t">
      <thead><tr><th>الصنف</th><th>القسم</th><th>الكود</th><th>سعر البيع</th>${own ? '<th>التكلفة</th><th>الهامش</th>' : ''}<th>المتاح</th><th>الحالة</th></tr></thead>
      <tbody>${list.map((p) => invRow(p, own)).join('') || '<tr><td colspan="8" class="muted" style="text-align:center;padding:24px">مفيش أصناف</td></tr>'}</tbody>
    </table></div>
    <div class="note">${icon('camera')} دوس على أيقونة أي صنف عشان تضيفله صورة (اختياري). بتظهر في شاشة البيع والبحث وتطبيق الموبايل.${own ? '' : ' والتكلفة والهامش بيظهروا للمالك بس.'}</div>
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
  invOpen: (d) => { S.inv.open[d.id] = !S.inv.open[d.id]; render(); },
  imgPick: (d) => { S._imgFor = d.id; const f = $('#img-file'); if (f) f.click(); },
  imgDel: (d) => { delete IMGS[d.id]; saveImages(); render(); toast('اتشالت الصورة، والصنف رجع بالأيقونة', 'info'); },
  goMobileRecv: () => { S.view = 'mobile'; render(); toast('الاستلام بيتعمل من الموبايل، بالـ IMEI أو بالعدد', 'info'); },
});
