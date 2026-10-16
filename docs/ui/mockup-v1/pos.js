'use strict';
/* ===== البحث الذكي: توحيد الحروف والأرقام + كلمات مفتاحية + آخر أرقام الـ IMEI ===== */
function normalize(s) {
  return toLatin(String(s ?? '').toLowerCase())
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/\s+/g, ' ').trim();
}
/* ===== التصنيفات: رئيسية + فرعية (من الإعدادات) ===== */
const catById = (id) => SET.cats.find((c) => c.id === id);
const catName = (id) => (catById(id) || {}).name || '';
const mainOf = (id) => { const c = catById(id); return c && c.parent ? c.parent : id; };
const catFull = (id) => { const c = catById(id); return !c ? '' : c.parent ? `${catName(c.parent)} · ${c.name}` : c.name; };
const mainCats = () => SET.cats.filter((c) => !c.parent && !c.hidden);
const subCats = (mainId) => SET.cats.filter((c) => c.parent === mainId && !c.hidden);
const inCat = (p, id) => p.cat === id || mainOf(p.cat) === id;
const catCount = (id) => DATA.products.filter((p) => inCat(p, id)).length;
const catVisible = (id) => { const c = catById(id); return !!c && !c.hidden && (!c.parent || !(catById(c.parent) || {}).hidden); };
// اسم التصنيف (والرئيسي بتاعه) داخل في البحث: «اكسسوار» بتجيب كل الإكسسوارات
function indexProducts() { DATA.products.forEach((p) => { p._hay = normalize([p.name, p.kw, p.sku, catFull(p.cat)].join(' ')); p._nn = normalize(p.name); }); }
indexProducts();
// شريط التصنيفات: صف رئيسي، وتحته الفرعي بتاع التصنيف المختار (لو ليه فرعي)
function catChipsHTML(sel, act) {
  const fixed = act === 'cat' ? [{ id: 'top', name: 'الأكثر مبيعًا', icon: 'flame' }, { id: 'all', name: 'الكل', icon: 'layout-grid' }] : [{ id: 'all', name: 'الكل', icon: 'layout-grid' }];
  const selMain = sel === 'top' || sel === 'all' ? null : mainOf(sel);
  const chip = (c, on, n, cls = '') => `<button type="button" class="chip ${cls} ${on ? 'on' : ''}" data-act="${act}" data-id="${c.id}">${icon(c.icon)}<bdi dir="rtl">${esc(c.name)}</bdi>${n != null ? `<span class="cnt num">${num(n)}</span>` : ''}</button>`;
  const subs = selMain ? subCats(selMain) : [];
  return `<div class="chips cats">${fixed.map((c) => chip(c, sel === c.id)).join('')}${mainCats().map((c) => chip(c, selMain === c.id, catCount(c.id))).join('')}</div>`
    + (subs.length ? `<div class="chips subcats" aria-label="أقسام ${esc(catName(selMain))}">${subs.map((c) => chip(c, sel === c.id, catCount(c.id), 'sub')).join('')}</div>` : '');
}
const prod = (id) => DATA.products.find((p) => p.id === id);
const inAnyCart = (imei) => S.invoices.some((inv) => inv.lines.some((l) => l.imei === imei));
/* المخزون: p.stock = كل الأجهزة. منهم اللي متسجّل له IMEI (units) واللي اتسلّم بالعدد من غير IMEI */
const imeiRequired = () => SET.imeiMode === 'required';
const unitsIn = (pid) => DATA.units.filter((u) => u.pid === pid && u.status === 'in');
const unitsFree = (pid) => unitsIn(pid).filter((u) => !inAnyCart(u.imei));
const unitLines = (pid) => S.invoices.reduce((a, inv) => a + inv.lines.filter((l) => l.kind === 'unit' && l.pid === pid).length, 0);
const stockOf = (p) => (p.serial ? Math.max(0, p.stock - unitLines(p.id)) : p.stock);
const avgCost = (p) => { const us = unitsIn(p.id); return us.length ? Math.round(us.reduce((a, u) => a + u.cost, 0) / us.length) : p.cost; };
const warrantyOf = (p) => (p.cat === 'used' ? +SET.warrantyUsed : p.cat === 'phones' ? +SET.warrantyNew : p.warranty);
const luhnOk = (s) => /^\d{15}$/.test(s) && DATA.luhnDigit(s.slice(0, 14)) === s[14];
const imeiHTML = (imei) => `<bdi dir="ltr" class="mono">${imei.slice(0, -4)}<b>${imei.slice(-4)}</b></bdi>`;
const methodName = (id) => (DATA.payMethods.find((x) => x.id === id) || {}).name || id;
const methodIcon = (id) => (DATA.payMethods.find((x) => x.id === id) || {}).icon || 'wallet';
const payName = (p) => methodName(p.method) + (p.provider ? ` · ${p.provider}` : '');
const payLabel = (ps) => ps.map(payName).join(' + ');

function searchAll(q) {
  const qn = normalize(q);
  if (!qn) return [];
  const out = [];
  const digits = qn.replace(/\s/g, '');
  if (/^\d{4,15}$/.test(digits)) {
    DATA.units.filter((u) => u.status === 'in' && !inAnyCart(u.imei) &&
      (u.imei.endsWith(digits) || (u.imei2 && u.imei2.endsWith(digits)) || (digits.length >= 8 && (u.imei.includes(digits) || (u.imei2 && u.imei2.includes(digits))))))
      .slice(0, 6).forEach((u) => out.push({ type: 'unit', u, p: prod(u.pid) }));
    DATA.products.filter((p) => p.sku && p.sku.includes(digits)).slice(0, 4).forEach((p) => out.push({ type: 'prod', p }));
    if (out.length) return out;
  }
  const toks = qn.split(' ');
  const scored = [];
  for (const p of DATA.products) {
    if (!toks.every((t) => p._hay.includes(t))) continue;
    let sc = p.sold;
    if (p._nn.startsWith(toks[0])) sc += 1000;
    if (p._nn.includes(qn)) sc += 500;
    scored.push([sc, p]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, 8).map(([, p]) => ({ type: 'prod', p }));
}
function resultsHTML() {
  if (!S.q.trim()) return '';
  const res = S._res || [];
  if (!res.length) return `<div class="results"><div class="no-res">${icon('search')} مفيش نتيجة لـ «${esc(S.q)}» — ${dg('جرّب جزء من الاسم أو آخر 4 أرقام من الـ IMEI')}</div></div>`;
  return `<div class="results" data-scroll="results">${res.map((r, i) => resultRow(r, i)).join('')}</div>`;
}
function resultRow(r, i) {
  const on = i === S.qi ? ' on' : '';
  const enter = on ? '<span class="enter"><kbd>Enter</kbd></span>' : '';
  if (r.type === 'unit') {
    const { u, p } = r;
    return `<div class="result${on}" data-act="pickRes" data-i="${i}"><div class="ico">${icon('scan-barcode')}</div>
      <div class="t"><div class="n"><bdi dir="rtl">${esc(p.name)}</bdi></div>
      <div class="s"><span>IMEI ${imeiHTML(u.imei)}</span>${u.color ? `<span>${esc(u.color)}</span>` : ''}<span class="tag accent">جهاز محدد</span></div></div>
      <div class="p num">${money(p.price)}</div>${enter}</div>`;
  }
  const p = r.p, st = stockOf(p);
  return `<div class="result${on}" data-act="pickRes" data-i="${i}"><div class="ico ${prodImg(p) ? 'img' : ''}">${prodVisual(p)}</div>
    <div class="t"><div class="n"><bdi dir="rtl">${esc(p.name)}</bdi></div>
    <div class="s"><span class="${st <= 0 ? 'danger-t' : st <= p.min ? 'warn-t' : ''}">${st <= 0 ? 'خلصان' : `متاح ${num(st)}`}</span>${p.serial && imeiRequired() ? `<span>${icon('scan-barcode')} هتختار الجهاز بالـ IMEI</span>` : ''}${p.sku ? `<span><bdi dir="ltr" class="mono">${p.sku}</bdi></span>` : ''}</div></div>
    <div class="p num">${money(p.price)}</div>${enter}</div>`;
}
function refreshResults() {
  const w = $('#res-wrap'); if (!w) return;
  w.innerHTML = resultsHTML();
  const a = w.querySelector('.result.on'); if (a) a.scrollIntoView({ block: 'nearest' });
}
function clearSearch() { S.q = ''; S._res = []; S.qi = 0; const q = $('#q'); if (q) q.value = ''; refreshResults(); }
function pickResult(i) {
  const r = (S._res || [])[i]; if (!r) return;
  S.q = ''; S._res = []; S.qi = 0;
  if (r.type === 'unit') addUnit(r.u); else pickProduct(r.p);
}
function notFound() {
  const qn = toLatin(S.q).replace(/\s/g, '');
  beep();
  if (/^\d{15}$/.test(qn)) toast(luhnOk(qn) ? 'الـ IMEI ده مش متسجّل — لو الجهاز اتسلّم من غير IMEI: ضيف الموبايل ودوس «سجّل IMEI» في السطر' : 'الرقم ده مش IMEI صحيح (رقم المراجعة غلط) — راجع الرقم', 'err', 4200);
  else toast(`مفيش صنف بالاسم أو الكود «${S.q}»`, 'err');
}
INPUT.q = (el) => { S.q = el.value; S.qi = 0; S._res = searchAll(S.q); refreshResults(); };

/* ===== الفاتورة ===== */
const cur = () => S.invoices[S.active];
function totals(inv = cur()) {
  const sub = inv.lines.reduce((a, l) => a + l.price * l.qty, 0);
  const cost = inv.lines.reduce((a, l) => a + l.cost * l.qty, 0);
  let disc = 0;
  if (inv.discount) disc = inv.discount.type === 'pct' ? Math.round((sub * inv.discount.value) / 100) : Math.min(inv.discount.value, sub);
  const total = sub - disc;
  return { sub, disc, total, profit: total - cost, count: inv.lines.reduce((a, l) => a + l.qty, 0) };
}
function pickProduct(p) {
  if (!p) return;
  if (p.serial) {
    if (imeiRequired()) { openImeiPicker(p); return; }
    if (stockOf(p) <= 0) { toast(`«${p.name}» خلصان من المخزون`, 'err'); beep(); render(); return; }
    addPhone(p); return;
  }
  if (stockOf(p) <= 0) { toast(`«${p.name}» خلصان من المخزون`, 'err'); beep(); render(); return; }
  addItem(p);
}
function addItem(p, qty = 1) {
  const inv = cur();
  let i = inv.lines.findIndex((l) => l.kind === 'item' && l.pid === p.id);
  if (i >= 0) {
    if (inv.lines[i].qty + qty > p.stock) { toast(`المتاح من «${p.name}» ${num(p.stock)} بس`, 'err'); beep(); render(); return; }
    inv.lines[i].qty += qty;
  } else {
    inv.lines.push({ kind: 'item', pid: p.id, name: p.name, price: p.price, cost: p.cost, qty, warranty: warrantyOf(p), icon: p.icon });
    i = inv.lines.length - 1;
  }
  S.sel = i; S._scrollSel = true;
  render(); focusSearch();
}
// سطر موبايل: من غير IMEI (imei: null) لحد ما تسجّله — أو بالـ IMEI على طول
const phoneLine = (p) => ({ kind: 'unit', pid: p.id, name: p.name, price: p.price, cost: avgCost(p), qty: 1, imei: null, color: null, warranty: warrantyOf(p), icon: p.icon, used: p.cat === 'used' });
function addPhone(p) {
  const inv = cur();
  inv.lines.push(phoneLine(p));
  S.sel = inv.lines.length - 1; S._scrollSel = true;
  render(); focusSearch();
  if (!S._imeiHint) { S._imeiHint = true; toast('اتضاف الموبايل — الـ IMEI اختياري: دوس «سجّل IMEI» في السطر أو امسح العلبة لو حبيت', 'info', 4500); }
}
function addUnit(u) {
  if (!u) return;
  if (inAnyCart(u.imei)) { toast('الجهاز ده موجود في فاتورة بالفعل', 'err'); beep(); return; }
  const p = prod(u.pid), inv = cur();
  // لو السطر المختار نفس الموبايل ومن غير IMEI: الـ IMEI بيتسجّل عليه (ضفت الموبايل وبعدين مسحت العلبة)
  const sl = inv.lines[S.sel];
  if (sl && sl.kind === 'unit' && sl.pid === p.id && !sl.imei) { attachUnit(S.sel, u); return; }
  if (stockOf(p) <= 0) { toast(`«${p.name}» خلصان من المخزون`, 'err'); beep(); render(); return; }
  inv.lines.push({ ...phoneLine(p), cost: u.cost, imei: u.imei, color: u.color });
  S.sel = inv.lines.length - 1; S._scrollSel = true;
  render(); focusSearch();
  toast(`اتضاف ${p.name} — IMEI …${u.imei.slice(-4)}`);
}
function attachUnit(i, u) {
  const l = cur().lines[i]; if (!l || !u) return;
  Object.assign(l, { imei: u.imei, color: u.color || null, cost: u.cost });
  S.sel = i; S._scrollSel = true;
  render(); focusSearch();
  toast(`اتسجّل IMEI …${u.imei.slice(-4)} على ${l.name}`);
}
function addService(line) {
  const inv = cur();
  inv.lines.push({ kind: 'service', qty: 1, cost: 0, warranty: 0, ...line });
  S.sel = inv.lines.length - 1; S._scrollSel = true;
}
function changeQty(delta) {
  const inv = cur(); if (!inv.lines.length) return;
  if (S.sel < 0) S.sel = inv.lines.length - 1;
  const l = inv.lines[S.sel]; if (!l) return;
  if (l.kind === 'unit') { if (delta < 0) removeLine(S.sel); else pickProduct(prod(l.pid)); return; } // كل موبايل في سطر لوحده
  if (l.kind !== 'item') { toast('السطر ده كميته 1', 'info'); return; }
  if (delta > 0 && l.qty + delta > prod(l.pid).stock) { toast(`المتاح ${num(prod(l.pid).stock)} بس`, 'err'); beep(); return; }
  l.qty += delta;
  if (l.qty <= 0) { inv.lines.splice(S.sel, 1); S.sel = Math.min(S.sel, inv.lines.length - 1); }
  render();
}
function removeLine(i = S.sel) {
  const inv = cur(); if (!inv.lines.length) return;
  if (i < 0) i = inv.lines.length - 1;
  const [l] = inv.lines.splice(i, 1);
  S.sel = Math.min(i, inv.lines.length - 1);
  render(); toast(`اتشال: ${l.name}`, 'info');
}
function moveSel(d) {
  const n = cur().lines.length; if (!n) return;
  S.sel = S.sel < 0 ? (d > 0 ? 0 : n - 1) : clamp(S.sel + d, 0, n - 1);
  S._scrollSel = true; render();
}
function holdInvoice() {
  const inv = cur();
  if (!inv.lines.length) { toast('الفاتورة فاضية — مفيش حاجة تتعلّق', 'info'); return; }
  inv.held = true;
  S.invoices.push(newInvoice()); S.active = S.invoices.length - 1; S.sel = -1;
  render(); focusSearch();
  toast(`اتعلّقت الفاتورة${inv.customer ? ` — ${inv.customer.name}` : ''}. ترجعلها من التبويبات فوق الفاتورة`);
}
function switchInvoice(i) {
  if (i === S.active) return;
  const now = cur(), target = S.invoices[i];
  if (!now.lines.length && !now.customer) S.invoices.splice(S.active, 1); else now.held = true;
  target.held = false;
  S.active = S.invoices.indexOf(target); S.sel = target.lines.length - 1;
  render(); focusSearch();
}
function clearDo() { const inv = cur(); inv.lines = []; inv.discount = null; S.sel = -1; S.modal = null; render(); focusSearch(); toast('اتمسحت الفاتورة', 'info'); }

/* ===== شاشة البيع ===== */
function tilesHTML() {
  let list = DATA.products;
  if (S.cat === 'top') list = [...list].sort((a, b) => b.sold - a.sold).slice(0, 12);
  else if (S.cat !== 'all') list = list.filter((p) => inCat(p, S.cat)).sort((a, b) => b.sold - a.sold);
  if (!list.length) return `<div class="tiles-empty">${icon('folder-plus')}<b>التصنيف ده لسه فاضي</b><span>الأصناف بتتضاف له من المخزون — وتقدر تغيّر اسمه أو تخفيه من الإعدادات ← الأصناف والبيع</span></div>`;
  return list.map(tileHTML).join('');
}
function tileHTML(p) {
  const st = stockOf(p);
  const cls = st <= 0 ? 'out' : st <= p.min ? 'low' : '';
  return `<button type="button" class="tile" data-act="tile" data-id="${p.id}">
    <div class="ico ${prodImg(p) ? 'img' : ''}">${prodVisual(p)}</div>
    ${p.serial && imeiRequired() ? `<span class="corner tag accent">${icon('scan-barcode')} IMEI</span>` : ''}
    <div class="name"><bdi dir="rtl">${esc(p.name)}</bdi></div>
    <div class="foot"><span class="price num">${money(p.price)}</span><span class="stock ${cls}">${st <= 0 ? 'خلصان' : `${num(st)} متاح`}</span></div>
  </button>`;
}
function lineHTML(l, i) {
  const meta = [];
  if (l.imei) meta.push(`<span class="tag accent imei-tag">${icon('scan-barcode')} IMEI ${imeiHTML(l.imei)}</span>`);
  else if (l.kind === 'unit') meta.push(`<button type="button" class="tag imei-add" data-act="lineImei" data-i="${i}" title="اختياري — للضمان والمرتجع">${icon('scan-barcode')} سجّل IMEI</button>`);
  if (l.color) meta.push(`<span class="tag">${esc(l.color)}</span>`);
  if (l.used) meta.push('<span class="tag warn">مستعمل</span>');
  if (l.warranty) meta.push(`<span class="tag ok">${icon('shield-check')} ضمان ${monthsTxt(l.warranty)}</span>`);
  if (l.note) meta.push(`<span class="tag">${esc(l.note)}</span>`);
  return `<div class="line ${i === S.sel ? 'sel' : ''}" data-act="selLine" data-i="${i}">
    <div class="lm"><div class="ln"><bdi dir="rtl">${esc(l.name)}</bdi></div>${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}</div>
    <div class="side">
      <span class="lt num">${money(l.price * l.qty)}</span>
      ${l.qty > 1 ? `<span class="lu num">${num(l.qty)} × ${money(l.price)}</span>` : ''}
      <div class="ctl">
        ${l.kind === 'item' ? `<div class="qty"><button type="button" data-act="qtyPlus" data-i="${i}" title="زوّد (+)">${icon('plus')}</button><span class="num">${num(l.qty)}</span><button type="button" data-act="qtyMinus" data-i="${i}" title="قلّل (−)">${icon('minus')}</button></div>` : ''}
        <button type="button" class="icon-btn sm danger" data-act="rmLine" data-i="${i}" title="شيل السطر (Delete)">${icon('trash-2')}</button>
      </div>
    </div>
  </div>`;
}
const emptyCart = () => `<div class="empty"><div class="big-i">${icon('shopping-cart')}</div><b>الفاتورة فاضية</b>
  <div>${dg('اكتب اسم الصنف أو آخر 4 أرقام من الـ IMEI، أو دوس على صنف من اليمين')}</div>
  <div class="keys"><span><kbd>/</kbd> بحث</span><span><kbd>F9</kbd> خدمات</span><span><kbd>F4</kbd> عميل</span></div></div>`;
function invTab(x, i) {
  const t = totals(x), on = i === S.active;
  const label = on ? (x.customer ? esc(x.customer.name) : 'الفاتورة الحالية') : `${x.customer ? esc(x.customer.name) : 'معلّقة'} · ${money(t.total)}`;
  return `<button type="button" class="inv-tab ${on ? 'on' : ''} ${x.held ? 'held' : ''}" data-act="invTab" data-i="${i}">${icon(on ? 'receipt' : 'pause')}<span class="tl">${label}</span>${on ? '' : `<span class="x" data-act="dropInv" data-i="${i}" title="إلغاء الفاتورة المعلّقة">${icon('x')}</span>`}</button>`;
}
function viewPOS() {
  if (S.cat !== 'top' && S.cat !== 'all' && !catVisible(S.cat)) S.cat = 'top';
  const inv = cur(), t = totals(inv), empty = !inv.lines.length;
  const c = inv.customer;
  return `<div class="pos-wrap"><div class="pos">
    <section class="catalog">
      <div class="search-row">
        <div class="search">
          <label class="search-box">${icon('search')}<input id="q" data-input="q" value="${esc(S.q)}" placeholder="${dg('ابحث بالاسم أو الكود أو آخر 4 أرقام من الـ IMEI…')}" autocomplete="off" spellcheck="false" aria-label="بحث"><kbd>/</kbd></label>
          <div id="res-wrap">${resultsHTML()}</div>
        </div>
        <button type="button" class="btn svc-btn" data-act="services">${icon('wallet')} خدمات <kbd>F9</kbd></button>
      </div>
      ${catChipsHTML(S.cat, 'cat')}
      <div class="tiles" data-scroll="tiles">${tilesHTML()}</div>
    </section>
    <aside class="cart" aria-label="الفاتورة">
      <div class="inv-tabs">${S.invoices.map(invTab).join('')}<button type="button" class="inv-tab" data-act="newInv" title="فاتورة جديدة">${icon('plus')}</button></div>
      <button type="button" class="cust-row ${c ? 'set' : ''}" data-act="customer">
        <span class="ci">${icon(c ? 'user-round' : 'user-plus')}</span>
        <span class="t">${c ? `<b>${esc(c.name)}</b><small><bdi dir="ltr" class="mono">${c.phone}</bdi>${c.balance ? ` · عليه ${money(c.balance)} آجل` : ''}</small>` : '<b>عميل نقدي</b><small>اختار عميل عشان الضمان والواتساب والآجل</small>'}</span>
        <kbd>F4</kbd>
      </button>
      <div class="lines" data-scroll="lines">${empty ? emptyCart() : inv.lines.map(lineHTML).join('')}</div>
      <div class="totals">
        <div class="r"><span>الإجمالي <small class="muted">(${num(t.count)} قطعة)</small></span><span class="num">${money(t.sub)}</span></div>
        ${t.disc ? `<div class="r disc"><span>خصم${inv.discount.type === 'pct' ? ` ${num(inv.discount.value)}%` : ''}${inv.discount.by === 'المالك' ? ' · بموافقة المالك' : ''}</span><span class="num">− ${money(t.disc)}</span></div>` : ''}
        <div class="r grand"><span>المطلوب</span><span class="num">${money(t.total)}</span></div>
        ${isOwner() && !empty ? `<div class="r profit"><button type="button" class="reveal" data-act="toggleProfit">${icon(S.showProfit ? 'eye-off' : 'eye')} ربح الفاتورة (للمالك بس)</button><span class="num">${S.showProfit ? money(t.profit) : '****'}</span></div>` : ''}
      </div>
      <div class="cart-actions">
        <button type="button" class="btn primary btn-pay" data-act="pay" ${empty ? 'disabled' : ''}>${icon('banknote')} ادفع <span class="amt num">${money(t.total)}</span> <kbd>F12</kbd></button>
        <button type="button" class="btn" data-act="exactCash" ${empty ? 'disabled' : ''}>${icon('check')} كاش بالظبط</button>
        <button type="button" class="btn" data-act="discount" ${empty ? 'disabled' : ''}>خصم <kbd>F3</kbd></button>
        <button type="button" class="btn" data-act="hold" ${empty ? 'disabled' : ''}>تعليق <kbd>F8</kbd></button>
        <button type="button" class="btn ghost danger" data-act="clear" ${empty ? 'disabled' : ''} title="مسح الفاتورة">${icon('trash-2')}</button>
      </div>
    </aside>
  </div>${keysBar()}</div>`;
}
function keysBar() {
  const K = [['Enter', 'إضافة ثم دفع'], ['F2', 'الكمية'], ['F3', 'خصم'], ['F4', 'عميل'], ['F8', 'تعليق'], ['F9', 'خدمات'], ['F12', 'دفع'], ['Del', 'حذف سطر'], ['+ / −', 'الكمية'], ['↑ ↓', 'اختيار سطر'], ['Ctrl+L', 'قفل']];
  return `<div class="keys-bar">${K.map(([k, l]) => `<span><kbd>${k}</kbd>${l}</span>`).join('')}<span class="sp"></span><span>${icon('smartphone')} موبايل يوسف جاهز كماسح</span></div>`;
}
VIEWS.pos = viewPOS;

/* ===== لوحة المفاتيح في شاشة البيع ===== */
function posKey(e) {
  const k = e.key, ae = document.activeElement;
  const inSearch = ae && ae.id === 'q';
  const typing = !inSearch && ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName);
  const fk = { F2: openQty, F3: openDiscount, F4: () => openCustomer(), F8: holdInvoice, F9: openServices, F12: openPay };
  if (fk[k]) { e.preventDefault(); fk[k](); return; }
  if (k === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openPay(); return; }
  if (typing) return;
  if (k === '/' && !inSearch) { e.preventDefault(); focusSearch(); return; }
  const hasQ = S.q.trim() !== '';
  if (k === 'ArrowDown' || k === 'ArrowUp') {
    e.preventDefault();
    if (hasQ && S._res.length) { S.qi = clamp(S.qi + (k === 'ArrowDown' ? 1 : -1), 0, S._res.length - 1); refreshResults(); }
    else moveSel(k === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (k === 'Enter') {
    e.preventDefault();
    if (hasQ) { if (S._res.length) pickResult(S.qi); else notFound(); }
    else if (cur().lines.length) openPay();
    return;
  }
  if (k === 'Escape') { if (hasQ) clearSearch(); else if (S.sel >= 0) { S.sel = -1; render(); } return; }
  if (!hasQ) {
    if (k === 'Delete') { e.preventDefault(); removeLine(); return; }
    if (k === '+') { e.preventDefault(); changeQty(1); return; }
    if (k === '-' || k === '−') { e.preventDefault(); changeQty(-1); return; }
  }
  if (!inSearch && k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) focusSearch();
}
function listKey(e, m) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); m.hi = Math.max(0, (m.hi || 0) + (e.key === 'ArrowDown' ? 1 : -1)); render(); return true; }
  return false;
}
function modalKey(e) {
  const m = S.modal, k = e.key, def = MODALS[m.type];
  if (k === 'Escape') { e.preventDefault(); if (m.type === 'pay' && m.step === 'done') finishAfterSale(); else closeModal(); return; }
  if (/^F([1-9]|1[0-2])$/.test(k) && k !== 'F5') e.preventDefault();
  if (def.key && def.key(e, m) === true) return;
  if (k === 'Enter' && !e.isComposing && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); if (def.enter) def.enter(m, e); }
}

/* ===== أفعال شاشة البيع ===== */
Object.assign(ACT, {
  cat: (d) => { const c = catById(d.id); S.cat = S.cat === d.id && c && c.parent ? c.parent : d.id; render(); }, // دوسة تانية على الفرعي بترجع للرئيسي
  lineImei: (d) => { const l = cur().lines[+d.i]; if (!l) return; S.sel = +d.i; openImeiPicker(prod(l.pid), +d.i); },
  tile: (d) => pickProduct(prod(d.id)),
  pickRes: (d) => pickResult(+d.i),
  selLine: (d) => { S.sel = +d.i; render(); },
  qtyPlus: (d) => { S.sel = +d.i; changeQty(1); },
  qtyMinus: (d) => { S.sel = +d.i; changeQty(-1); },
  rmLine: (d) => removeLine(+d.i),
  customer: () => openCustomer(),
  pay: () => openPay(),
  exactCash: () => exactCash(),
  discount: () => openDiscount(),
  hold: () => holdInvoice(),
  clear: () => { if (cur().lines.length) openModal({ type: 'confirmClear' }); },
  clearDo: () => clearDo(),
  services: () => openServices(),
  invTab: (d, el, e) => { if (e && e.target.closest('[data-act="dropInv"]')) return; switchInvoice(+d.i); },
  newInv: () => { const c = cur(); if (!c.lines.length) { focusSearch(); return; } c.held = true; S.invoices.push(newInvoice()); S.active = S.invoices.length - 1; S.sel = -1; render(); },
  dropInv: (d) => {
    const i = +d.i, keep = cur();
    S.invoices.splice(i, 1);
    S.active = S.invoices.indexOf(keep);
    render(); toast('اتلغت الفاتورة المعلّقة', 'info');
  },
  toggleProfit: () => { S.showProfit = !S.showProfit; render(); },
  shiftClose: () => openShiftClose(),
});

/* ===== نافذة الـ IMEI: تسجيله على سطر موجود (attach) أو اختيار الجهاز لما يكون إجباري ===== */
function openImeiPicker(p, attach = null) { openModal({ type: 'imei', pid: p.id, f: '', hi: 0, attach }); }
function imeiUnits(m) { const f = toLatin(m.f).replace(/\D/g, ''); return unitsFree(m.pid).filter((u) => !f || u.imei.includes(f) || (u.imei2 && u.imei2.includes(f))); }
// IMEI كامل (15 رقم) مكتوب ومش في القايمة: جهاز اتسلّم بالعدد من غير IMEI → يتسجّل دلوقتي
function newImeiState(m) {
  const f = toLatin(m.f).replace(/\D/g, '');
  if (f.length !== 15 || imeiUnits(m).length) return null;
  if (!luhnOk(f)) return { ok: false, msg: 'الرقم ده مش IMEI صحيح (رقم المراجعة غلط) — راجع الرقم' };
  const other = DATA.units.find((u) => u.imei === f || u.imei2 === f);
  if (other) {
    if (other.pid !== m.pid) return { ok: false, msg: `الـ IMEI ده متسجّل على «${prod(other.pid).name}»` };
    return { ok: false, msg: other.status !== 'in' ? 'الجهاز ده اتباع قبل كده' : 'الجهاز ده في فاتورة تانية' };
  }
  const p = prod(m.pid);
  if (unitsIn(p.id).length >= p.stock) return { ok: false, msg: 'كل أجهزة الصنف ده متسجّلة بالـ IMEI — اختار من القايمة' };
  return { ok: true, imei: f };
}
function unitRow(u, on) {
  return `<div class="result ${on ? 'on' : ''}" data-act="imeiPick" data-imei="${u.imei}">
    <div class="ico">${icon('smartphone')}</div>
    <div class="t"><div class="n">IMEI ${imeiHTML(u.imei)}</div>
      <div class="s">${u.color ? `<span>${esc(u.color)}</span>` : ''}<span>${esc(u.storage)}</span><span>${esc(u.condition)}</span>${u.battery ? `<span>بطارية ${num(u.battery)}%</span>` : ''}${u.customs ? `<span class="tag ok">${icon('badge-check')} ${esc(u.customs)}</span>` : ''}<span>استلام ${fmtDate(new Date(u.received))}</span></div></div>
    ${isOwner() ? `<div class="p muted num" title="تكلفة الجهاز ده بالظبط">تكلفة ${money(u.cost)}</div>` : ''}
  </div>`;
}
MODALS.imei = {
  html(m) {
    const p = prod(m.pid), list = imeiUnits(m), nw = newImeiState(m), att = m.attach != null;
    const unreg = Math.max(0, p.stock - unitsIn(p.id).length);
    m.hi = clamp(m.hi, 0, Math.max(0, list.length - 1));
    const canGo = list.length || (nw && nw.ok);
    return `<div class="modal md" role="dialog" aria-label="${att ? 'تسجيل IMEI' : 'اختيار الجهاز'}">
      ${modalHead('scan-barcode', `${att ? 'سجّل الـ IMEI' : 'اختار الجهاز'} — <bdi dir="rtl">${esc(p.name)}</bdi>`, att ? 'اختياري' : money(p.price))}
      <div class="modal-b stack">
        <label class="inline-search">${icon('search')}<input id="imei-f" data-input="imeiF" data-autofocus inputmode="numeric" value="${esc(m.f)}" placeholder="${dg('آخر 4 أرقام من الـ IMEI أو الرقم كله (15 رقم)')}" autocomplete="off"></label>
        ${nw ? (nw.ok ? `<div class="result on new-imei" data-act="imeiNew"><div class="ico">${icon('circle-plus')}</div><div class="t"><div class="n">IMEI جديد ${imeiHTML(nw.imei)}</div><div class="s"><span>هيتسجّل للجهاز ده دلوقتي — من اللي اتسلموا من غير IMEI</span></div></div><span class="enter"><kbd>Enter</kbd></span></div>` : `<div class="err-msg">${esc(nw.msg)}</div>`) : ''}
        <div class="cust-list">${list.length ? list.map((u, i) => unitRow(u, i === m.hi)).join('') : nw ? '' : `<div class="no-res">${m.f ? 'مفيش جهاز متسجّل بالرقم ده' : 'مفيش أجهزة متسجّلة بالـ IMEI من الصنف ده'}${unreg ? ' — اكتب الـ IMEI كامل (15 رقم) عشان يتسجّل' : ''}</div>`}</div>
        ${unreg ? `<div class="note">${icon('info')} ${num(unreg)} من الصنف ده اتسلموا بالعدد من غير IMEI — لو الجهاز اللي في إيدك منهم، اكتب الـ IMEI بتاعه كامل وهيتسجّل.</div>` : ''}
        <div class="note">${icon('smartphone')} أو امسح الـ IMEI من على العلبة بكاميرا الموبايل — بيتحدد هنا على طول.</div>
      </div>
      <div class="modal-f"><span class="muted">${num(list.length)} جهاز متسجّل متاح</span><span class="sp"></span>
        ${att ? '<button type="button" class="btn ghost" data-act="closeModal">من غير IMEI</button>' : ''}
        <button type="button" class="btn primary" data-act="imeiPickHi" ${canGo ? '' : 'disabled'}>${icon(att ? 'check' : 'plus')} ${att ? 'سجّل' : 'أضف الجهاز'} <kbd>Enter</kbd></button></div>
    </div>`;
  },
  enter(m) {
    const nw = newImeiState(m);
    if (nw && nw.ok) { imeiUseNew(m, nw.imei); return; }
    const u = imeiUnits(m)[m.hi];
    if (u) imeiUse(m, u); else beep();
  },
  key: listKey,
};
function imeiUse(m, u) { S.modal = null; if (m.attach != null) attachUnit(m.attach, u); else addUnit(u); }
function imeiUseNew(m, imei) {
  const p = prod(m.pid);
  const u = { imei, imei2: '', pid: p.id, color: null, storage: p.storage, condition: p.cat === 'used' ? p.grade : 'جديد', battery: null, customs: null, cost: p.cost, received: new Date().toISOString().slice(0, 10), status: 'in', late: true };
  DATA.units.push(u);
  imeiUse(m, u);
}
INPUT.imeiF = (el) => {
  const m = S.modal; m.f = el.value; m.hi = 0;
  const f = toLatin(m.f).replace(/\D/g, ''), list = imeiUnits(m);
  if (f.length === 15 && list.length === 1) { imeiUse(m, list[0]); return; }
  render();
};
ACT.imeiPick = (d) => imeiUse(S.modal, DATA.units.find((x) => x.imei === d.imei));
ACT.imeiPickHi = () => MODALS.imei.enter(S.modal);
ACT.imeiNew = () => MODALS.imei.enter(S.modal);

/* ===== نافذة: العميل ===== */
function openCustomer(prev) { openModal({ type: 'customer', f: '', hi: 0, adding: false, name: '', phone: '', err: '', prev }); }
function custList(m) {
  const q = normalize(m.f), d = toLatin(m.f).replace(/\D/g, '');
  return DATA.customers.filter((c) => !q || normalize(c.name).includes(q) || (d.length >= 3 && c.phone.includes(d))).slice(0, 8);
}
const custRow = (c, on) => `<div class="result ${on ? 'on' : ''}" data-act="custPick" data-id="${c.id}"><div class="ico">${icon('user-round')}</div>
  <div class="t"><div class="n">${esc(c.name)}</div><div class="s"><span><bdi dir="ltr" class="mono">${c.phone}</bdi></span><span>${num(c.visits)} زيارة</span>${c.balance ? `<span class="tag warn">عليه ${money(c.balance)} آجل</span>` : ''}</div></div></div>`;
MODALS.customer = {
  html(m) {
    if (m.adding) {
      return `<div class="modal sm" role="dialog" aria-label="عميل جديد">
        ${modalHead('user-plus', 'عميل جديد')}
        <div class="modal-b stack">
          <div class="field"><label for="cust-phone">موبايل العميل</label><input id="cust-phone" data-input="custF2" data-k="phone" data-autofocus dir="ltr" inputmode="tel" value="${esc(m.phone)}" placeholder="01xxxxxxxxx" autocomplete="off"></div>
          <div class="field"><label for="cust-name">الاسم</label><input id="cust-name" data-input="custF2" data-k="name" value="${esc(m.name)}" autocomplete="off"></div>
          <div class="err-msg">${esc(m.err)}</div>
        </div>
        <div class="modal-f"><button type="button" class="btn ghost" data-act="custBack">${icon('arrow-right')} رجوع</button><span class="sp"></span><button type="button" class="btn primary" data-act="custSave">${icon('check')} حفظ واختيار <kbd>Enter</kbd></button></div>
      </div>`;
    }
    const list = custList(m); m.hi = clamp(m.hi, 0, Math.max(0, list.length - 1));
    return `<div class="modal md" role="dialog" aria-label="العميل">
      ${modalHead('user-round', 'اختار العميل', 'عشان الضمان والواتساب والآجل')}
      <div class="modal-b stack">
        <label class="inline-search">${icon('search')}<input id="cust-f" data-input="custF" data-autofocus value="${esc(m.f)}" placeholder="اسم العميل أو رقم موبايله…" autocomplete="off"></label>
        <div class="cust-list">${list.length ? list.map((c, i) => custRow(c, i === m.hi)).join('') : '<div class="no-res">مفيش عميل بالاسم أو الرقم ده — سجّله كعميل جديد</div>'}</div>
      </div>
      <div class="modal-f"><button type="button" class="btn ghost" data-act="custAdd">${icon('user-plus')} عميل جديد</button>${cur().customer ? '<button type="button" class="btn ghost danger" data-act="custClear">خليه عميل نقدي</button>' : ''}<span class="sp"></span>
        <button type="button" class="btn primary" data-act="custPickHi" ${list.length ? '' : 'disabled'}>${icon('check')} اختار <kbd>Enter</kbd></button></div>
    </div>`;
  },
  enter(m) {
    if (m.adding) { custSave(); return; }
    const c = custList(m)[m.hi];
    if (c) pickCustomer(c); else ACT.custAdd();
  },
  key: (e, m) => (m.adding ? false : listKey(e, m)),
};
INPUT.custF = (el) => { S.modal.f = el.value; S.modal.hi = 0; render(); };
INPUT.custF2 = (el) => { S.modal[el.dataset.k] = el.value; S.modal.err = ''; };
function pickCustomer(c) {
  const prev = S.modal && S.modal.prev;
  cur().customer = c;
  if (prev) { prev._mounted = false; if (prev.type === 'pay') { prev.err = ''; if (!prev.wa) prev.wa = c.phone; } S.modal = prev; render(); } else { S.modal = null; render(); focusSearch(); }
  toast(`العميل: ${c.name}`);
}
function custSave() {
  const m = S.modal, ph = toLatin(m.phone).replace(/\D/g, ''), name = m.name.trim();
  if (!/^01\d{9}$/.test(ph)) { m.err = 'رقم الموبايل لازم يكون 11 رقم ويبدأ بـ 01'; beep(); render(); return; }
  if (!name) { m.err = 'اكتب اسم العميل'; beep(); render(); return; }
  let c = DATA.customers.find((x) => x.phone === ph);
  if (!c) { c = { id: `c${Date.now()}`, name, phone: ph, balance: 0, visits: 0 }; DATA.customers.unshift(c); }
  pickCustomer(c);
}
Object.assign(ACT, {
  custPick: (d) => pickCustomer(DATA.customers.find((c) => c.id === d.id)),
  custPickHi: () => MODALS.customer.enter(S.modal),
  custAdd: () => { const m = S.modal, d = toLatin(m.f).replace(/\D/g, ''); Object.assign(m, { adding: true, phone: /^01/.test(d) ? d : '', name: /\d/.test(m.f) ? '' : m.f.trim(), err: '', _mounted: false }); render(); },
  custBack: () => { Object.assign(S.modal, { adding: false, err: '', _mounted: false }); render(); },
  custSave: () => custSave(),
  custClear: () => { cur().customer = null; S.modal = null; render(); focusSearch(); toast('بقى عميل نقدي', 'info'); },
});

/* ===== نافذة: الكمية (F2) ===== */
function openQty() {
  const inv = cur(); if (!inv.lines.length) { toast('الفاتورة فاضية', 'info'); return; }
  if (S.sel < 0) S.sel = inv.lines.length - 1;
  const l = inv.lines[S.sel];
  if (l.kind !== 'item') { toast(l.kind === 'unit' ? 'كل موبايل في سطر لوحده — دوس + عشان تضيف واحد كمان' : 'السطر ده كميته 1', 'info'); return; }
  openModal({ type: 'qty', i: S.sel, v: String(l.qty), err: '' });
}
MODALS.qty = {
  html(m) {
    const l = cur().lines[m.i], p = prod(l.pid);
    return `<div class="modal sm" role="dialog" aria-label="الكمية">
      ${modalHead('hash', 'الكمية', `<bdi dir="rtl">${esc(l.name)}</bdi>`)}
      <div class="modal-b stack"><div class="field"><label for="qty-v">الكمية (المتاح ${num(p.stock)})</label><input id="qty-v" class="big-in num" data-input="qtyV" data-autofocus dir="ltr" inputmode="numeric" value="${esc(m.v)}" autocomplete="off"></div>
        <div class="err-msg">${esc(m.err)}</div></div>
      <div class="modal-f"><span class="sp"></span><button type="button" class="btn primary" data-act="qtyApply">${icon('check')} تمام <kbd>Enter</kbd></button></div>
    </div>`;
  },
  enter: () => qtyApply(),
};
INPUT.qtyV = (el) => { S.modal.v = el.value; S.modal.err = ''; };
function qtyApply() {
  const m = S.modal, l = cur().lines[m.i], p = prod(l.pid), v = Math.round(parseNum(m.v));
  if (!(v >= 1)) { m.err = 'اكتب رقم من 1 أو أكتر'; beep(); render(); return; }
  if (v > p.stock) { m.err = `المتاح ${num(p.stock)} بس`; beep(); render(); return; }
  l.qty = v; S.sel = m.i; S.modal = null; render(); focusSearch();
}
ACT.qtyApply = () => qtyApply();

/* ===== نافذة: الخصم (F3) — أكتر من الحد بيطلب PIN المالك ===== */
function openDiscount() {
  if (!cur().lines.length) { toast('الفاتورة فاضية', 'info'); return; }
  openModal({ type: 'discount', mode: 'pct', v: '', pin: '', err: '' });
}
function discCalc(m) {
  const t = totals(), v = parseNum(m.v), ok = !isNaN(v) && v > 0;
  const disc = !ok ? 0 : m.mode === 'pct' ? Math.round((t.sub * Math.min(v, 100)) / 100) : Math.min(v, t.sub);
  const pct = t.sub ? (disc / t.sub) * 100 : 0;
  return { sub: t.sub, v, ok, disc, pct, total: t.sub - disc, needPin: ok && !isOwner() && pct > +SET.discountLimit + 1e-9 };
}
MODALS.discount = {
  html(m) {
    const c = discCalc(m);
    return `<div class="modal sm" role="dialog" aria-label="خصم">
      ${modalHead('badge-percent', 'خصم على الفاتورة')}
      <div class="modal-b stack">
        <div class="seg"><button type="button" class="${m.mode === 'pct' ? 'on' : ''}" data-act="discMode" data-id="pct">نسبة %</button><button type="button" class="${m.mode === 'amt' ? 'on' : ''}" data-act="discMode" data-id="amt">مبلغ ج.م</button></div>
        <div class="field"><label for="disc-v">${m.mode === 'pct' ? 'نسبة الخصم %' : 'مبلغ الخصم (ج.م)'}</label><input id="disc-v" class="big-in num" data-input="discV" data-autofocus dir="ltr" inputmode="decimal" value="${esc(m.v)}" autocomplete="off"></div>
        <div class="sum-box"><div class="r"><span>الإجمالي</span><span class="num">${money(c.sub)}</span></div><div class="r"><span>الخصم</span><span class="num">− ${money(c.disc)}</span></div><div class="r grand"><span>بعد الخصم</span><b class="num">${money(c.total)}</b></div></div>
        ${c.needPin ? `<div class="note warn">${icon('lock')} الخصم أكبر من ${num(SET.discountLimit)}% — محتاج الرقم السري بتاع المالك</div>
          <div class="field"><label for="disc-pin">PIN المالك</label><input id="disc-pin" type="password" class="num" data-input="discPin" dir="ltr" inputmode="numeric" maxlength="4" value="${esc(m.pin)}" autocomplete="off"></div>` : ''}
        <div class="err-msg">${esc(m.err)}</div>
      </div>
      <div class="modal-f">${cur().discount ? '<button type="button" class="btn ghost danger" data-act="discRemove">شيل الخصم</button>' : ''}<span class="sp"></span><button type="button" class="btn primary" data-act="discApply" ${c.ok ? '' : 'disabled'}>${icon('check')} طبّق <kbd>Enter</kbd></button></div>
    </div>`;
  },
  enter: () => discApply(),
};
INPUT.discV = (el) => { S.modal.v = el.value; S.modal.err = ''; render(); };
INPUT.discPin = (el) => {
  const m = S.modal; m.pin = toLatin(el.value).replace(/\D/g, '').slice(0, 4); m.err = '';
  if (m.pin.length === 4) {
    const owner = DATA.users.find((u) => u.role === 'owner');
    if (m.pin === owner.pin) { discApply(true); return; }
    m.err = 'الرقم السري غلط'; m.pin = ''; beep();
  }
  render();
};
function discApply(approved = false) {
  const m = S.modal, c = discCalc(m);
  if (!c.ok) { beep(); return; }
  if (c.needPin && !approved) { m.err = 'محتاج الرقم السري بتاع المالك'; beep(); render(); return; }
  cur().discount = { type: m.mode, value: c.v, by: c.needPin ? 'المالك' : S.user.name };
  S.modal = null; render(); focusSearch();
  toast(`اتطبق خصم ${money(c.disc)}`);
}
Object.assign(ACT, {
  discMode: (d) => { S.modal.mode = d.id; S.modal.err = ''; render(); },
  discApply: () => discApply(),
  discRemove: () => { cur().discount = null; S.modal = null; render(); focusSearch(); toast('اتشال الخصم', 'info'); },
});

/* ===== نافذة: مسح الفاتورة ===== */
MODALS.confirmClear = {
  html: () => `<div class="modal sm" role="dialog" aria-label="مسح الفاتورة">
    ${modalHead('trash-2', 'تمسح الفاتورة كلها؟')}
    <div class="modal-b"><div class="muted">هتتشال كل السطور (${num(cur().lines.length)}) من الفاتورة دي.</div></div>
    <div class="modal-f"><span class="sp"></span><button type="button" class="btn ghost" data-act="closeModal">لأ <kbd>Esc</kbd></button><button type="button" class="btn danger-solid" data-act="clearDo">${icon('trash-2')} امسح <kbd>Enter</kbd></button></div>
  </div>`,
  enter: () => clearDo(),
};

/* ===== نافذة: الدفع (F12) — كاش / محافظ / فيزا / تقسيط / آجل + دفع مقسّم ===== */
function openPay() {
  const inv = cur(); if (!inv.lines.length) return;
  const mode = (SET.receiptMode === 'wa' || SET.receiptMode === 'both') && !inv.customer ? 'print' : SET.receiptMode;
  openModal({ type: 'pay', step: 'pay', method: 'cash', payments: [], amount: '', provider: 'valU', receipt: mode, wa: inv.customer ? inv.customer.phone : '', err: '' });
}
function payCalc(m) {
  const t = totals(), paid = m.payments.reduce((a, p) => a + p.amount, 0);
  const remaining = Math.max(0, t.total - paid), v = parseNum(m.amount);
  let change = 0, short = 0, box = '';
  if (m.method === 'cash' && !isNaN(v)) {
    if (v >= remaining) { change = v - remaining; box = `<div class="change-box"><span>الباقي للعميل</span><b class="num">${money(change)}</b></div>`; }
    else { short = remaining - v; box = `<div class="change-box short"><span>ناقص</span><b class="num">${money(short)}</b></div>`; }
  }
  return { total: t.total, paid, remaining, v, change, short, box, canPartial: !isNaN(v) && v > 0 && v < remaining };
}
function cashSuggestions(r) {
  const out = [r];
  for (const step of [50, 100, 200, 500, 1000]) { const v = Math.ceil(r / step) * step; if (v > r && !out.includes(v)) out.push(v); }
  return out.slice(0, 4);
}
function payFormHTML(m) {
  const inv = cur(), c = payCalc(m), isCash = m.method === 'cash';
  const methods = DATA.payMethods.filter((x) => x.id === 'cash' || SET.methods[x.id] !== false);
  const needCust = m.method === 'credit' && !inv.customer;
  return `<div class="modal wide" role="dialog" aria-label="الدفع">
    ${modalHead('banknote', 'الدفع', `المطلوب ${money(c.total)}`)}
    <div class="modal-b"><div class="pay">
      <div class="stack">
        <div class="methods">${methods.map((x) => `<button type="button" class="method ${m.method === x.id ? 'on' : ''}" data-act="payMethod" data-id="${x.id}">${icon(x.icon)}<span>${x.name}</span></button>`).join('')}</div>
        ${m.method === 'install' ? `<div class="seg">${DATA.installProviders.map((p) => `<button type="button" class="${m.provider === p ? 'on' : ''}" data-act="payProv" data-id="${esc(p)}">${esc(p)}</button>`).join('')}</div>` : ''}
        <div class="field"><label for="pay-amt">${isCash ? 'المبلغ اللي استلمته من العميل' : `المبلغ بـ${methodName(m.method)} (فاضي = الباقي كله)`}</label>
          <input id="pay-amt" class="big-in num" data-input="payAmt" data-autofocus dir="ltr" inputmode="decimal" value="${esc(m.amount)}" placeholder="${num(c.remaining)}" autocomplete="off"></div>
        ${isCash ? `<div class="sugs">${cashSuggestions(c.remaining).map((v) => `<button type="button" class="btn sm" data-act="paySug" data-v="${v}">${money(v)}</button>`).join('')}</div>` : ''}
        ${c.box}
        <div class="err-msg">${esc(m.err)}</div>
        ${needCust ? `<button type="button" class="btn soft" data-act="payCust">${icon('user-plus')} اختار عميل للآجل <kbd>F4</kbd></button>` : ''}
      </div>
      <div class="stack">
        <div class="sum-box">
          <div class="r"><span>الإجمالي</span><b class="num">${money(c.total)}</b></div>
          ${m.payments.map((p, i) => `<div class="paid-item">${icon(methodIcon(p.method))}<span>${esc(payName(p))}</span><span class="sp"></span><b class="num">${money(p.amount)}</b><button type="button" class="icon-btn xs" data-act="payDel" data-i="${i}" title="شيل">${icon('x')}</button></div>`).join('')}
          <div class="r grand"><span>${m.payments.length ? 'الباقي المطلوب' : 'المطلوب'}</span><b class="num">${money(c.remaining)}</b></div>
        </div>
        <button type="button" class="btn" data-act="payPartial" ${c.canPartial ? '' : 'disabled'}>${icon('plus')} دفع جزئي بالطريقة دي</button>
        <div class="field"><span class="label">الإيصال</span><div class="seg">${[['print', 'طباعة'], ['wa', 'واتساب'], ['both', 'الاتنين'], ['none', 'بدون']].map(([id, l]) => `<button type="button" class="${m.receipt === id ? 'on' : ''}" data-act="payRMode" data-id="${id}">${l}</button>`).join('')}</div></div>
        ${m.receipt === 'wa' || m.receipt === 'both' ? `<div class="field"><label for="pay-wa">رقم الواتساب</label><input id="pay-wa" data-input="payWa" dir="ltr" inputmode="tel" value="${esc(m.wa)}" placeholder="01xxxxxxxxx" autocomplete="off"></div>` : ''}
      </div>
    </div></div>
    <div class="modal-f"><span class="muted">${inv.customer ? `العميل: ${esc(inv.customer.name)}` : 'عميل نقدي'}</span><span class="sp"></span>
      <button type="button" class="btn ghost" data-act="closeModal">رجوع <kbd>Esc</kbd></button>
      <button type="button" class="btn primary lg" data-act="payConfirm">${icon('check')} تأكيد الدفع <kbd>Enter</kbd></button></div>
  </div>`;
}
function payPartial() {
  const m = S.modal, c = payCalc(m);
  if (!c.canPartial) return;
  if (m.method === 'credit' && !cur().customer) { m.err = 'الآجل لازم يكون على عميل — اختار عميل (F4)'; beep(); render(); return; }
  const p = { method: m.method, amount: c.v, provider: m.method === 'install' ? m.provider : null };
  if (m.method === 'cash') p.received = c.v;
  m.payments.push(p);
  Object.assign(m, { amount: '', method: 'cash', err: '', _mounted: false }); render();
}
function payConfirm() {
  const m = S.modal, inv = cur(), c = payCalc(m);
  if (m.method === 'credit' && !inv.customer) { m.err = 'الآجل لازم يكون على عميل — اختار عميل (F4)'; beep(); render(); return; }
  if (m.method === 'cash' && c.short) { m.err = `المبلغ أقل من المطلوب بـ ${money(c.short)} — كمّل أو اعمل دفع جزئي`; beep(); render(); return; }
  if (m.method !== 'cash' && c.canPartial) { payPartial(); return; }
  const wa = toLatin(m.wa).replace(/\D/g, '');
  if ((m.receipt === 'wa' || m.receipt === 'both') && !/^01\d{9}$/.test(wa)) { m.err = 'اكتب رقم واتساب صحيح أو غيّر طريقة الإيصال'; beep(); render(); return; }
  const last = { method: m.method, amount: c.remaining, provider: m.method === 'install' ? m.provider : null };
  if (m.method === 'cash') last.received = isNaN(c.v) ? c.remaining : c.v;
  const payments = c.remaining > 0 || !m.payments.length ? [...m.payments, last] : m.payments;
  completeSale(payments, m.method === 'cash' ? c.change : 0, m.receipt, wa);
}
function exactCash() {
  const inv = cur(); if (!inv.lines.length) return;
  const t = totals(inv);
  const mode = (SET.receiptMode === 'wa' || SET.receiptMode === 'both') && !inv.customer ? 'print' : SET.receiptMode;
  S.sw = null;
  S.modal = { type: 'pay', step: 'pay', method: 'cash', payments: [], amount: '', provider: 'valU', receipt: mode, wa: inv.customer ? inv.customer.phone : '', err: '' };
  completeSale([{ method: 'cash', amount: t.total, received: t.total }], 0, mode, S.modal.wa);
}
function completeSale(payments, change, receiptMode, wa) {
  const inv = cur(), t = totals(inv);
  const sale = { no: S.nextNo++, at: new Date(), seller: S.user, customer: inv.customer, lines: inv.lines.map((l) => ({ ...l })), ...t, discount: inv.discount, payments, change, receiptMode, wa };
  for (const l of inv.lines) {
    if (l.kind === 'unit') {
      const p = prod(l.pid);
      if (l.imei) { const u = DATA.units.find((x) => x.imei === l.imei); if (u) u.status = 'sold'; }
      p.stock = Math.max(0, p.stock - 1); p.sold += 1;
      // اتباع من غير IMEI والمتسجّل بقى أكتر من اللي فاضل: أقدم جهاز متسجّل بيتشال من الحساب (الأقدم الأول)
      const reg = unitsIn(p.id);
      if (reg.length > p.stock) { const old = reg.filter((u) => !inAnyCart(u.imei)).sort((x, y) => x.received.localeCompare(y.received))[0]; if (old) { old.status = 'sold'; old.auto = true; } }
    } else if (l.kind === 'item') { const p = prod(l.pid); p.stock = Math.max(0, p.stock - l.qty); p.sold += l.qty; }
    if (l.repairNo) { const r = S.repairs.find((x) => x.no === l.repairNo); if (r) r.status = 'delivered'; }
  }
  const credit = payments.filter((p) => p.method === 'credit').reduce((a, p) => a + p.amount, 0);
  if (credit && inv.customer) inv.customer.balance += credit;
  if (inv.customer) inv.customer.visits++;
  const d = DATA.dash.today;
  d.sales += t.total; d.invoices++; d.profit += t.profit; DATA.dash.week[6] += t.total;
  d.bySeller[S.user.id] = (d.bySeller[S.user.id] || 0) + t.total; d.countBySeller[S.user.id] = (d.countBySeller[S.user.id] || 0) + 1;
  DATA.shift.cashSales += payments.filter((p) => p.method === 'cash').reduce((a, p) => a + p.amount, 0);
  DATA.dash.recent.unshift({ no: sale.no, at: fmtTime(sale.at), seller: S.user.name, sellerId: S.user.id, customer: inv.customer ? inv.customer.name : 'نقدي', method: payLabel(payments), total: t.total, fresh: true });
  S.sales.push(sale);
  Object.assign(S.modal, { step: 'done', sale, err: '', _mounted: false });
  render();
  if (receiptMode === 'print' || receiptMode === 'both') toast(`بيطبع الإيصال رقم ${sale.no} (كصورة عشان العربي يطلع مظبوط)`, 'info');
  if (receiptMode === 'wa' || receiptMode === 'both') toast(`اتبعت الإيصال على واتساب ${wa}`);
}
function finishAfterSale() {
  S.invoices.splice(S.active, 1);
  S.invoices.push(newInvoice()); S.active = S.invoices.length - 1; S.sel = -1;
  S.modal = null; render(); focusSearch();
}
function receiptHTML(sale) {
  const lines = sale.lines.map((l) => `<div class="it">
      <div class="r"><span><bdi dir="rtl">${esc(l.name)}</bdi>${l.qty > 1 ? ` <bdi dir="ltr">×${l.qty}</bdi>` : ''}</span><span>${num(l.price * l.qty)}</span></div>
      ${l.imei ? `<div class="s">IMEI: <bdi dir="ltr">${l.imei}</bdi></div>` : ''}
      ${l.warranty ? `<div class="s">ضمان ${monthsTxt(l.warranty)} — لحد ${fmtDate(addMonths(sale.at, l.warranty))}</div>` : ''}
    </div>`).join('');
  return `<div class="receipt ${SET.paper === '58' ? 'w58' : ''}">
    <div class="c">${SET.logo ? `<div class="rc-logo"><img src="${SET.logo}" alt=""></div>` : ''}<div class="rc-name">${esc(SET.shopName)}</div>
      <div class="s">${esc(SET.address)}</div><div class="s">تليفون: <bdi dir="ltr">${esc(SET.phone)}</bdi></div></div>
    <hr>
    <div class="r s"><span>فاتورة رقم ${dg(sale.no)}</span><span>${fmtDate(sale.at)} · ${fmtTime(sale.at)}</span></div>
    <div class="r s"><span>البيّاع: ${esc(sale.seller.name)}</span><span>${sale.customer ? `العميل: ${esc(sale.customer.name)}` : 'عميل نقدي'}</span></div>
    <hr>${lines}<hr>
    <div class="r"><span>الإجمالي</span><span>${num(sale.sub)}</span></div>
    ${sale.disc ? `<div class="r"><span>خصم</span><span>− ${num(sale.disc)}</span></div>` : ''}
    <div class="r tot"><span>المطلوب</span><span>${money(sale.total)}</span></div>
    ${sale.payments.map((p) => `<div class="r s"><span>${esc(payName(p))}</span><span>${num(p.received ?? p.amount)}</span></div>`).join('')}
    ${sale.change ? `<div class="r s"><span>الباقي للعميل</span><span>${num(sale.change)}</span></div>` : ''}
    <hr>
    <div class="rc-foot">${SET.showQR ? `${fakeQR(`INV-${sale.no}`)}<div class="s">مكان QR الإيصال الإلكتروني (لما يتفعّل)</div>` : ''}<div class="s">${esc(SET.footer)}</div></div>
  </div>`;
}
function payDoneHTML(m) {
  const s = m.sale, rm = { print: 'اتطبع', wa: 'اتبعت على واتساب', both: 'اتطبع واتبعت واتساب', none: 'من غير إيصال' }[s.receiptMode] || '';
  return `<div class="modal wide" role="dialog" aria-label="تم البيع">
    ${modalHead('circle-check', `تم البيع — فاتورة رقم ${dg(s.no)}`)}
    <div class="modal-b"><div class="done-wrap">
      <div class="stack">
        <div class="done-hero">${icon('circle-check')}<div><b class="num">${money(s.total)}</b><small>${esc(payLabel(s.payments))}</small></div></div>
        ${s.change ? `<div class="change-box"><span>الباقي للعميل</span><b class="num">${money(s.change)}</b></div>` : ''}
        <div class="sum-box">
          <div class="r"><span>البيّاع</span><b>${esc(s.seller.name)}</b></div>
          <div class="r"><span>العميل</span><b>${s.customer ? esc(s.customer.name) : 'نقدي'}</b></div>
          <div class="r"><span>الإيصال</span><b>${rm}</b></div>
          <div class="r"><span>عدد القطع</span><b class="num">${num(s.count)}</b></div>
        </div>
        <div class="row wrap">
          <button type="button" class="btn primary lg" data-act="payDone">${icon('plus')} فاتورة جديدة <kbd>Enter</kbd></button>
          <button type="button" class="btn" data-act="reprint">${icon('printer')} اطبع تاني</button>
          <button type="button" class="btn" data-act="waSend">${icon('message-circle')} واتساب</button>
        </div>
      </div>
      ${receiptHTML(s)}
    </div></div>
  </div>`;
}
MODALS.pay = {
  html: (m) => (m.step === 'done' ? payDoneHTML(m) : payFormHTML(m)),
  enter: (m) => { if (m.step === 'done') finishAfterSale(); else payConfirm(); },
  key: (e, m) => { if (m.step !== 'done' && e.key === 'F4') { openCustomer(m); return true; } return false; },
};
INPUT.payAmt = (el) => { S.modal.amount = el.value; S.modal.err = ''; render(); };
INPUT.payWa = (el) => { S.modal.wa = el.value; S.modal.err = ''; };
Object.assign(ACT, {
  payMethod: (d) => { Object.assign(S.modal, { method: d.id, amount: '', err: '' }); render(); },
  payProv: (d) => { S.modal.provider = d.id; render(); },
  paySug: (d) => { S.modal.amount = String(d.v); S.modal.err = ''; render(); },
  payPartial: () => payPartial(),
  payDel: (d) => { S.modal.payments.splice(+d.i, 1); render(); },
  payRMode: (d) => { S.modal.receipt = d.id; S.modal.err = ''; render(); },
  payConfirm: () => payConfirm(),
  payCust: () => openCustomer(S.modal),
  payDone: () => finishAfterSale(),
  reprint: () => toast(`بيطبع الإيصال رقم ${S.modal.sale.no} تاني`, 'info'),
  waSend: () => { const s = S.modal.sale; toast(s.customer ? `اتبعت الإيصال على واتساب ${s.customer.phone}` : 'اختار عميل الأول عشان الواتساب', s.customer ? 'ok' : 'info'); },
});

/* ===== نافذة: خدمات سريعة (F9) — محافظ · كروت شحن · فواتير ===== */
const walletFee = (a) => Math.max(+SET.feeMin, Math.round((a * +SET.feePct) / 100));
function openServices() { openModal({ type: 'services', tab: 'wallet', op: 'send', wallet: 'vf', phone: '', amount: '', opr: 'vf', bill: 'net', acct: '', billAmt: '', added: 0, err: '' }); }
function svcWallet(m) {
  const w = DATA.wallets.find((x) => x.id === m.wallet), a = parseNum(m.amount), ok = !isNaN(a) && a > 0;
  const fee = ok ? walletFee(a) : 0, over = ok && w.limitDay && w.usedToday + a > w.limitDay;
  return `<div class="seg">${[['send', 'تحويل لرقم', 'arrow-up-from-line'], ['withdraw', 'سحب كاش', 'arrow-down-to-line']].map(([id, l, ic]) => `<button type="button" class="${m.op === id ? 'on' : ''}" data-act="svcOp" data-id="${id}">${icon(ic)} ${l}</button>`).join('')}</div>
    <div class="wallets">${DATA.wallets.map((x) => `<button type="button" class="wallet ${m.wallet === x.id ? 'on' : ''}" data-act="svcWallet" data-id="${x.id}"><span class="dot" style="background:${x.color}"></span><span class="t"><b>${x.name}</b><small class="num">${money(x.balance)}</small></span></button>`).join('')}</div>
    <div class="grid2">
      <div class="field"><label for="svc-amt">المبلغ</label><input id="svc-amt" class="big-in num" data-input="svc" data-k="amount" data-autofocus dir="ltr" inputmode="decimal" value="${esc(m.amount)}" autocomplete="off"></div>
      <div class="field"><label for="svc-ph">${m.op === 'send' ? 'الرقم اللي هيتحوّل له' : 'رقم محفظة العميل'}</label><input id="svc-ph" class="big-in mono" data-input="svc" data-k="phone" dir="ltr" inputmode="tel" value="${esc(m.phone)}" placeholder="01xxxxxxxxx" autocomplete="off"></div>
    </div>
    <div class="due-box"><div class="r"><span>العمولة (${num(SET.feePct)}% · أقل حاجة ${money(SET.feeMin)})</span><b class="num">${money(fee)}</b></div>
      <div class="r grand"><span>${m.op === 'send' ? 'تحصّل من العميل كاش' : 'تدفع للعميل كاش'}</span><b class="num">${money(ok ? (m.op === 'send' ? a + fee : a - fee) : 0)}</b></div></div>
    ${over ? `<div class="note warn">${icon('triangle-alert')} كده هتعدّي الحد اليومي لـ${w.name} (${money(w.limitDay)})</div>` : ''}`;
}
function svcCards(m) {
  return `<div class="wallets">${DATA.operators.map((o) => `<button type="button" class="wallet ${m.opr === o.id ? 'on' : ''}" data-act="svcOpr" data-id="${o.id}"><span class="dot" style="background:${o.color}"></span><span class="t"><b>${o.name}</b></span></button>`).join('')}</div>
    <div class="card-vals">${DATA.cardValues.map((v) => `<button type="button" class="btn" data-act="svcCard" data-v="${v}">${icon('signal')} كارت ${num(v)}</button>`).join('')}</div>
    <div class="note">${icon('info')} الكارت بيتضاف للفاتورة المفتوحة ويتحاسب معاها.</div>`;
}
function svcBills(m) {
  const a = parseNum(m.billAmt), ok = !isNaN(a) && a > 0, fee = +SET.billFee;
  return `<div class="wallets">${DATA.billTypes.map((b) => `<button type="button" class="wallet ${m.bill === b.id ? 'on' : ''}" data-act="svcBill" data-id="${b.id}">${icon(b.icon)}<span class="t"><b>${b.name}</b></span></button>`).join('')}</div>
    <div class="grid2">
      <div class="field"><label for="bill-amt">مبلغ الفاتورة</label><input id="bill-amt" class="big-in num" data-input="svc" data-k="billAmt" data-autofocus dir="ltr" inputmode="decimal" value="${esc(m.billAmt)}" autocomplete="off"></div>
      <div class="field"><label for="bill-acct">رقم الحساب أو التليفون (اختياري)</label><input id="bill-acct" class="big-in mono" data-input="svc" data-k="acct" dir="ltr" value="${esc(m.acct)}" autocomplete="off"></div>
    </div>
    <div class="due-box"><div class="r"><span>رسوم الخدمة</span><b class="num">${money(fee)}</b></div><div class="r grand"><span>تحصّل من العميل</span><b class="num">${money(ok ? a + fee : 0)}</b></div></div>`;
}
MODALS.services = {
  html(m) {
    return `<div class="modal md" role="dialog" aria-label="خدمات سريعة">
      ${modalHead('wallet', 'خدمات سريعة', 'محافظ · كروت شحن · فواتير')}
      <div class="modal-b stack">
        <div class="seg tabs">${[['wallet', 'wallet', 'محافظ'], ['cards', 'signal', 'كروت شحن'], ['bills', 'receipt', 'فواتير']].map(([id, ic, l]) => `<button type="button" class="${m.tab === id ? 'on' : ''}" data-act="svcTab" data-id="${id}">${icon(ic)} ${l}</button>`).join('')}</div>
        ${m.tab === 'wallet' ? svcWallet(m) : m.tab === 'cards' ? svcCards(m) : svcBills(m)}
        <div class="err-msg">${esc(m.err)}</div>
      </div>
      <div class="modal-f"><span class="muted">${m.added ? `اتضاف ${num(m.added)} للفاتورة` : 'المحافظ والفواتير بتتسجّل في دفتر الخدمات'}</span><span class="sp"></span>
        <button type="button" class="btn ghost" data-act="closeModal">قفل <kbd>Esc</kbd></button>
        ${m.tab !== 'cards' ? `<button type="button" class="btn primary" data-act="svcDo">${icon('check')} سجّل <kbd>Enter</kbd></button>` : ''}</div>
    </div>`;
  },
  enter: (m) => { if (m.tab === 'wallet') recordWallet(m); else if (m.tab === 'bills') recordBill(m); },
};
function recordWallet(m) {
  const w = DATA.wallets.find((x) => x.id === m.wallet), a = parseNum(m.amount), ph = toLatin(m.phone).replace(/\D/g, '');
  if (!(a > 0)) { m.err = 'اكتب المبلغ'; beep(); render(); return; }
  if (!/^01\d{9}$/.test(ph)) { m.err = 'رقم الموبايل لازم يكون 11 رقم ويبدأ بـ 01'; beep(); render(); return; }
  const fee = walletFee(a), cash = m.op === 'send' ? a + fee : a - fee;
  if (m.op === 'send') { w.balance -= a; DATA.shift.servicesIn += cash; } else { w.balance += a; DATA.shift.servicesOut += cash; }
  w.usedToday += a; DATA.dash.today.services++; DATA.dash.today.servicesFee += fee;
  S.services.push({ kind: 'wallet', op: m.op, wallet: w.id, phone: ph, amount: a, fee, at: new Date(), by: S.user.name });
  toast(m.op === 'send' ? `اتسجّل تحويل ${money(a)} على ${w.name} — حصّل ${money(cash)} من العميل` : `اتسجّل سحب ${money(a)} — ادفع للعميل ${money(cash)}`);
  Object.assign(m, { amount: '', phone: '', err: '', _mounted: false }); render();
}
function recordBill(m) {
  const a = parseNum(m.billAmt), fee = +SET.billFee, b = DATA.billTypes.find((x) => x.id === m.bill);
  if (!(a > 0)) { m.err = 'اكتب مبلغ الفاتورة'; beep(); render(); return; }
  DATA.shift.servicesIn += a + fee; DATA.dash.today.services++; DATA.dash.today.servicesFee += fee;
  S.services.push({ kind: 'bill', bill: b.id, acct: m.acct, amount: a, fee, at: new Date(), by: S.user.name });
  toast(`اتسجّل دفع فاتورة ${b.name} — حصّل ${money(a + fee)}`);
  Object.assign(m, { billAmt: '', acct: '', err: '', _mounted: false }); render();
}
INPUT.svc = (el) => { S.modal[el.dataset.k] = el.value; S.modal.err = ''; render(); };
Object.assign(ACT, {
  svcTab: (d) => { Object.assign(S.modal, { tab: d.id, err: '', _mounted: false }); render(); },
  svcOp: (d) => { S.modal.op = d.id; render(); },
  svcWallet: (d) => { S.modal.wallet = d.id; render(); },
  svcOpr: (d) => { S.modal.opr = d.id; render(); },
  svcBill: (d) => { S.modal.bill = d.id; S.modal._mounted = false; render(); },
  svcDo: () => MODALS.services.enter(S.modal),
  svcCard: (d) => {
    const m = S.modal, o = DATA.operators.find((x) => x.id === m.opr), v = +d.v;
    addService({ name: `كارت شحن ${o.name} ${v}`, price: v, icon: 'signal', note: 'كارت شحن' });
    m.added++; render(); toast(`اتضاف كارت ${o.name} ${num(v)} للفاتورة`);
  },
});

/* ===== نافذة: تقفيل الوردية — عدّ الفلوس بالفئات ===== */
const DENOMS = [200, 100, 50, 20, 10, 5, 1, 0.5];
function expectedCash() { const s = DATA.shift; return s.opening + s.cashSales + s.servicesIn - s.servicesOut - s.expenses.reduce((a, e) => a + e.amount, 0) - s.ownerDraw; }
function openShiftClose() {
  if (!isOwner() && !SET.perms.closeShift) { toast('تقفيل الوردية للمالك بس (من الإعدادات)', 'err'); beep(); return; }
  openModal({ type: 'shift', counts: DENOMS.map(() => '') });
}
function shiftCalc(m) {
  const counted = DENOMS.reduce((a, d, i) => a + d * (parseNum(m.counts[i]) || 0), 0), exp = expectedCash();
  return { counted, exp, diff: Math.round((counted - exp) * 100) / 100, any: m.counts.some((c) => String(c).trim() !== '') };
}
MODALS.shift = {
  html(m) {
    const c = shiftCalc(m), s = DATA.shift;
    const rows = [['رصيد أول الوردية', s.opening], ['مبيعات كاش', s.cashSales], ['خدمات داخلة كاش', s.servicesIn], ['خدمات خارجة كاش', -s.servicesOut], ...s.expenses.map((e) => [`مصروف: ${e.name}`, -e.amount]), ['سحب المالك', -s.ownerDraw]];
    return `<div class="modal wide" role="dialog" aria-label="تقفيل الوردية">
      ${modalHead('calculator', `تقفيل الوردية #${num(s.no)}`, `من ${dg(s.opened)} · فتحها ${esc(s.by)}`)}
      <div class="modal-b"><div class="shift">
        <div class="stack"><b>عدّ الفلوس اللي في الدرج</b>
          <div class="denoms">${DENOMS.map((d, i) => `<div class="denom"><span class="dv num">${money(d)}</span><input id="den-${i}" class="num" data-input="den" data-i="${i}" dir="ltr" inputmode="numeric" value="${esc(m.counts[i])}" placeholder="0" ${i === 0 ? 'data-autofocus' : ''} autocomplete="off" aria-label="عدد فئة ${d}"><span class="ds num">${money(d * (parseNum(m.counts[i]) || 0))}</span></div>`).join('')}</div></div>
        <div class="stack">
          <div class="sum-box">${rows.map(([l, v]) => `<div class="r"><span>${esc(l)}</span><span class="num ${v < 0 ? 'danger-t' : ''}">${v < 0 ? '− ' : ''}${money(Math.abs(v))}</span></div>`).join('')}
            <div class="r grand"><span>المفروض في الدرج</span><b class="num">${money(c.exp)}</b></div>
            <div class="r"><span>اللي اتعدّ</span><b class="num">${money(c.counted)}</b></div></div>
          ${c.any ? `<div class="change-box ${c.diff < 0 ? 'short' : ''}"><span>${c.diff === 0 ? 'مظبوط' : c.diff < 0 ? 'عجز' : 'زيادة'}</span><b class="num">${money(Math.abs(c.diff))}</b></div>` : '<div class="muted">اكتب عدد كل فئة — والفرق بيظهر لوحده</div>'}
        </div>
      </div></div>
      <div class="modal-f"><button type="button" class="btn ghost" data-act="soon">${icon('printer')} اطبع تقرير الوردية</button><span class="sp"></span><button type="button" class="btn primary" data-act="shiftDo" ${c.any ? '' : 'disabled'}>${icon('check')} قفّل الوردية</button></div>
    </div>`;
  },
};
INPUT.den = (el) => { S.modal.counts[+el.dataset.i] = el.value; render(); };
ACT.shiftDo = () => { const c = shiftCalc(S.modal); S.modal = null; render(); toast(c.diff === 0 ? 'اتقفلت الوردية — الدرج مظبوط' : `اتقفلت الوردية — ${c.diff < 0 ? 'عجز' : 'زيادة'} ${money(Math.abs(c.diff))} اتسجّل`, c.diff === 0 ? 'ok' : 'info'); };
