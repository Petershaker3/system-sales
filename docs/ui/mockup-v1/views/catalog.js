'use strict';
// «صنف جديد» واختيار النوع في شاشة البيع. الكود متقسم ملف لكل شاشة — الترتيب في index.html، والدليل: docs/ENGINEERING.md
/* ===== صنف جديد (docs/ui/STORE-CATALOG-WALLETS.md، المرحلة 2) =====
   المالك: «أول مرة نسجّل بضاعة بتفاصيلها… الإكسسوار بتفرعاته، والموبايلات بشركاتها وأنواعها، والمستعمل».
   بيتفتح فوق «استلام بضاعة» (من الاستلام نفسه، أو من المخزن وبيفتح الاستلام تحته). تلات أنواع، وكل نوع بيسأل عن تفاصيله بس:
   - موبايل جديد: تاتش أو زراير (زي السيستم القديم)، والشركة، والموديل، والمساحة والرام، والألوان. كل جهاز بالـ IMEI بتاعه في الاستلام.
   - مستعمل: جهاز جهاز بالـ IMEI والحالة والبطارية واللي معاه وسعره، وبيانات اللي باعه (اختياري).
   - إكسسوار أو أي صنف بالعدد: التصنيف، والاسم، والتفرعات (لموبايل، اللون، المقاس…) ولكل نوع عدده وسعره وباركوده.
   بعد التسجيل الصنف بينزل في الاستلام بعدده وتكلفته، والرصيد بيدخل لما الاستلام يتحفظ (applyReceipt). */
const NI_KINDS = [
  ['phone', 'smartphone', 'موبايل جديد', 'الشركة والموديل والمساحة والألوان. كل جهاز بالـ IMEI بتاعه وقت الاستلام'],
  ['used', 'recycle', 'موبايل مستعمل', 'جهاز جهاز: الـ IMEI والحالة والبطارية واللي معاه وسعره'],
  ['item', 'package', 'إكسسوار أو أي صنف بالعدد', 'جرابات وشواحن وسماعات وقطع غيار، بالتصنيف والتفرعات والباركود'],
];
const NI_ROMS = ['32GB', '64GB', '128GB', '256GB', '512GB', '1TB'], NI_RAMS = ['2GB', '3GB', '4GB', '6GB', '8GB', '12GB', '16GB'];
const NI_COLORS = ['أسود', 'أبيض', 'أزرق', 'أخضر', 'رمادي', 'فضي', 'ذهبي', 'بنفسجي', 'بينك', 'أحمر'];
const NI_GRADES = [['A', 'زي الجديد'], ['B', 'خدوش خفيفة'], ['C', 'عيوب واضحة']], NI_BOX = ['علبة', 'شاحن', 'فاتورة'];
// أسماء التفرعات، ولكل اسم اقتراحات بتتضاف بدوسة (الموبايل: موديلات المحل نفسه)
const NI_DIMS = ['الموبايل', 'اللون', 'النوع', 'المقاس', 'القوة', 'الطول', 'المساحة'];
const niSuggest = (label) => ({
  'الموبايل': [...new Set(DATA.products.filter((p) => p.serial).sort((a, b) => b.sold - a.sold).map((p) => p.model))].slice(0, 10),
  'اللون': NI_COLORS, 'القوة': ['20W', '25W', '33W', '45W', '65W'], 'الطول': ['1م', '2م', '3م'], 'المساحة': ['32GB', '64GB', '128GB', '256GB'],
}[label] || []);
const NI_MAX_VARIANTS = 60;
const brandByName = (n) => SET.brands.find((b) => b.name === n);
const brandsFor = (ptype) => SET.brands.filter((b) => !b.hidden && (b.type === 'both' || b.type === ptype));
const kindCats = (kind) => SET.cats.filter((c) => !c.parent && c.kind === kind);
// التصنيفات اللي الصنف بالعدد بيتسجّل فيها: فرعي الرئيسي اللي نوعه «بالعدد»، أو الرئيسي نفسه لو ملوش فرعي
function itemCats() {
  const out = [];
  for (const c of SET.cats.filter((x) => !x.parent && (x.kind || 'item') === 'item')) {
    const subs = SET.cats.filter((x) => x.parent === c.id);
    out.push(...(subs.length ? subs : [c]));
  }
  return out;
}
// نفس الافتراضيات بتاعة الأصناف في data.js
const newProd = (o) => ({ stock: 0, serial: false, warranty: 0, icon: 'package', kw: '', sold: 0, min: 5, sku: '', ...o });
let NI_SEQ = 0;
const niId = () => `n${Date.now().toString(36)}${(++NI_SEQ).toString(36)}`;
function niBlank(kind) {
  return {
    kind, err: '', errAt: '', dup: null, ptype: 'touch', brand: '', brandNew: null, model: '', rom: '', ram: '', colors: [], colorQ: '', color: '',
    price: '', cost: '', min: '', warranty: '', cat: '', catNew: null, imei: '', imei2: '', grade: 'A', battery: '', box: [], notes: '',
    seller: { name: '', phone: '', nid: '' }, sellerOn: false, name: '', ibrand: '', sku: '',
    varOn: false, confirmClose: false, dims: [{ label: 'الموبايل', vals: [], q: '' }, { label: 'اللون', vals: [], q: '' }], rows: {},
  };
}
// الاسم اللي اتكتب في بحث الاستلام بينزل في مكانه: الموديل (ولو أوله اسم شركة، الشركة بتتختار) أو اسم الصنف
function niSeed(m, text) {
  const t = String(text || '').trim();
  if (!t) return;
  if (m.kind === 'item') { m.name = t; return; }
  const first = t.split(' ')[0].toLowerCase(), b = SET.brands.find((x) => x.name.toLowerCase() === first);
  if (b) { m.brand = b.name; m.model = t.slice(first.length).trim(); if (b.type === 'keypad') m.ptype = 'keypad'; } else m.model = t;
}
function openNewItem(opts = {}) {
  const prev = S.modal && S.modal.type === 'receive' ? S.modal : null;
  if (prev) prev._mounted = false;
  const m = { type: 'newItem', prev, seed: opts.name || '', ...niBlank(opts.kind || null), ...(opts.keep || {}) };
  if (m.kind) niSeed(m, m.seed);
  openModal(m);
}
const niKindName = (k) => (NI_KINDS.find((x) => x[0] === k) || [])[2] || '';
const niTitle = (m) => (m.kind === 'item' ? m.name.trim() : phoneTitle(brandByName(m.brand), m.model, m.ptype === 'touch' ? m.rom : ''));
const usedTitle = (m) => `${niTitle(m)} مستعمل فئة ${m.grade}`;
const niCombos = (m) => (m.varOn ? variantCombos(m.dims.map((d) => d.vals)) : []);

/* --- الرسم --- */
const niLabel = (text, opt) => `<span class="label">${text}${opt ? ' <span class="muted">(اختياري)</span>' : ''}</span>`;
function niInput(id, label, k, val, attrs = '', opt = false, hint = '') {
  return `<div class="field"><label for="${id}">${label}${opt ? ' <span class="muted">(اختياري)</span>' : ''}</label><input id="${id}" data-input="ni" data-k="${k}" value="${esc(val)}" ${attrs} autocomplete="off">${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
}
const niMoney = (id, label, k, val, opt, ph = '') => niInput(id, label, k, val, `class="num" dir="ltr" inputmode="numeric" placeholder="${ph}"`, opt);
const niChip = (on, act, attrs, label) => `<button type="button" class="chip ${on ? 'on' : ''}" data-act="${act}" ${attrs} aria-pressed="${on}">${label}</button>`;
function niTags(list, listKey, inputId, k, q, ph, sugg) {
  const left = sugg.filter((v) => !list.includes(v));
  return `<div class="ni-tags">${list.map((v, i) => `<span class="tag accent"><bdi>${esc(v)}</bdi><button type="button" class="rc-x" data-act="niTagDel" data-list="${listKey}" data-i="${i}" aria-label="شيل «${esc(v)}»">${icon('x')}</button></span>`).join('')}
    <input id="${inputId}" class="ni-tag-in" data-input="ni" data-k="${k}" value="${esc(q)}" placeholder="${ph}" autocomplete="off"></div>
    ${left.length ? `<div class="chips wrap ni-sugg">${left.map((v) => `<button type="button" class="chip sub" data-act="niTagAdd" data-list="${listKey}" data-v="${esc(v)}">${icon('plus')}<bdi>${esc(v)}</bdi></button>`).join('')}</div>` : ''}`;
}
function niBrandRow(m) {
  const list = brandsFor(m.ptype);
  return `<div class="ni-row">${niLabel('الشركة')}<div class="chips wrap" id="ni-brands">${list.map((b) => niChip(m.brand === b.name, 'niBrand', `data-v="${esc(b.name)}"`, `<bdi dir="ltr">${esc(b.name)}</bdi>`)).join('')}
    ${m.brandNew === null ? `<button type="button" class="chip ghost-chip" data-act="niBrandNew">${icon('plus')} شركة تانية</button>`
      : `<span class="ni-inline"><input id="ni-brand-new" data-input="ni" data-k="brandNew" value="${esc(m.brandNew)}" placeholder="اسم الشركة" autocomplete="off" aria-label="اسم الشركة الجديدة"><button type="button" class="btn sm soft" data-act="niBrandAdd">${icon('check')} ضيف</button></span>`}</div></div>`;
}
const niPtypeRow = (m) => `<div class="ni-row">${niLabel('نوع الجهاز')}<div class="seg">${[['touch', 'تاتش'], ['keypad', 'زراير']].map(([v, l]) => `<button type="button" class="${m.ptype === v ? 'on' : ''}" data-act="niPtype" data-v="${v}" aria-pressed="${m.ptype === v}">${l}</button>`).join('')}</div></div>`;
function niSpecRows(m) {
  if (m.ptype !== 'touch') return '';
  const row = (title, list, cur, act, opt) => `<div class="ni-row">${niLabel(title, opt)}<div class="chips wrap">${list.map((v) => niChip(cur === v, act, `data-v="${v}"`, `<span class="num" dir="ltr">${v}</span>`)).join('')}</div></div>`;
  return row('المساحة', NI_ROMS, m.rom, 'niRom', false) + row('الرام', NI_RAMS, m.ram, 'niRam', true);
}
function niModelField(m) {
  const models = [...new Set(DATA.products.filter((p) => p.brand && p.brand === m.brand).map((p) => p.model))];
  return niInput('ni-model', 'الموديل', 'model', m.model, `list="ni-models" placeholder="${m.ptype === 'keypad' ? 'مثلًا: 105، 110' : 'مثلًا: Galaxy A16، Redmi 14C'}" data-autofocus`)
    + `<datalist id="ni-models">${models.map((x) => `<option value="${esc(x)}"></option>`).join('')}</datalist>`;
}
const niCatRow = (m, cats, label) => (cats.length > 1 ? `<div class="ni-row">${niLabel(label)}<div class="chips wrap">${cats.map((c) => niChip((m.cat || cats[0].id) === c.id, 'niCat', `data-v="${c.id}"`, `${icon(c.icon)}<bdi>${esc(c.name)}</bdi>`)).join('')}</div></div>` : '');
function niNameLine(m, title, extra = '') {
  return title ? `<div class="ni-name">${icon('tag')} هيتسجّل باسم <b><bdi dir="auto">${esc(title)}</bdi></b>${extra}</div>` : '';
}
function niPhone(m) {
  const own = isOwner(), spec = m.ptype === 'touch' && m.ram ? `رام ${m.ram}` : ''; // المساحة جوه الاسم، والرام جنبه
  return `${niCatRow(m, kindCats('phone'), 'التصنيف')}${niPtypeRow(m)}${niBrandRow(m)}${niModelField(m)}${niSpecRows(m)}
    <div class="ni-row">${niLabel('الألوان', true)}${niTags(m.colors, 'colors', 'ni-color-q', 'colorQ', m.colorQ, 'اكتب لون ودوس Enter', NI_COLORS)}</div>
    <div class="grid3">${niMoney('ni-price', 'سعر البيع', 'price', m.price)}${own ? niMoney('ni-cost', 'التكلفة', 'cost', m.cost, true, 'بتتكتب في الاستلام') : ''}${niMoney('ni-min', 'نبّهني لما يفضل', 'min', m.min, true, '2')}</div>
    ${niNameLine(m, niTitle(m), spec ? `، <span class="num">${esc(spec)}</span>` : '')}
    <div class="muted ni-foot">${icon('shield-check')} الضمان من الإعدادات: ${monthsTxt(+SET.warrantyNew)}. والـ IMEI بيتكتب أو بيتمسح لكل جهاز في الاستلام${imeiRequired() ? '، وهو إجباري حسب الإعدادات' : '، وهو اختياري'}.</div>`;
}
function niUsed(m) {
  const own = isOwner();
  return `${niPtypeRow(m)}${niBrandRow(m)}${niModelField(m)}${niSpecRows(m)}
    <div class="ni-row">${niLabel('اللون', true)}<div class="chips wrap">${NI_COLORS.map((c) => niChip(m.color === c, 'niColor', `data-v="${c}"`, c)).join('')}</div></div>
    <div class="grid2">
      <div class="field"><label for="ni-imei">IMEI</label><div class="ni-inline"><input id="ni-imei" class="mono" data-input="ni" data-k="imei" value="${esc(m.imei)}" dir="ltr" inputmode="numeric" placeholder="15 رقم" autocomplete="off"><button type="button" class="btn sm" data-act="niScan" title="الموبايل بيمسح الرقم من على الجهاز (*#06#)">${icon('smartphone')} امسح</button></div></div>
      ${niInput('ni-imei2', 'IMEI التاني', 'imei2', m.imei2, 'class="mono" dir="ltr" inputmode="numeric" placeholder="للموبايل اللي بخطين"', true)}
    </div>
    <div class="ni-row">${niLabel('الحالة')}<div class="seg">${NI_GRADES.map(([g, d]) => `<button type="button" class="${m.grade === g ? 'on' : ''}" data-act="niGrade" data-v="${g}" aria-pressed="${m.grade === g}"><b dir="ltr">${g}</b> ${d}</button>`).join('')}</div></div>
    <div class="grid2">${niInput('ni-battery', 'البطارية %', 'battery', m.battery, 'class="num" dir="ltr" inputmode="numeric" placeholder="مثلًا 86"', true)}
      <div class="ni-row">${niLabel('معاه')}<div class="chips wrap">${NI_BOX.map((x) => niChip(m.box.includes(x), 'niBox', `data-v="${x}"`, x)).join('')}</div></div></div>
    ${niInput('ni-notes', 'العيوب أو ملاحظات', 'notes', m.notes, 'placeholder="مثلًا: خدش في الضهر، الشاشة مغيّرة"', true)}
    <div class="grid3">${own ? niMoney('ni-cost', 'اشتريته بكام', 'cost', m.cost, true) : ''}${niMoney('ni-price', 'هيتباع بكام', 'price', m.price)}</div>
    <button type="button" class="btn sm ghost ni-more" data-act="niSeller" aria-expanded="${m.sellerOn}">${icon(m.sellerOn ? 'chevron-up' : 'chevron-down')} بيانات اللي باعه (اختياري)</button>
    ${m.sellerOn ? `<div class="grid3">${niInput('ni-s-name', 'الاسم', 'seller.name', m.seller.name)}${niInput('ni-s-phone', 'التليفون', 'seller.phone', m.seller.phone, 'class="mono" dir="ltr" inputmode="tel" placeholder="01xxxxxxxxx"')}${niInput('ni-s-nid', 'رقم البطاقة', 'seller.nid', m.seller.nid, 'class="mono" dir="ltr" inputmode="numeric" placeholder="14 رقم"')}</div>` : ''}
    ${niNameLine(m, m.brand && m.model.trim() ? usedTitle(m) : '')}
    <div class="muted ni-foot">${icon('shield-check')} ضمان المستعمل من الإعدادات: ${monthsTxt(+SET.warrantyUsed)}.</div>`;
}
function niVariants(m) {
  const own = isOwner(), combos = niCombos(m), price = parseNum(m.price), cost = parseNum(m.cost);
  const dimRow = (d, i) => `<div class="ni-dim"><div class="field"><label for="ni-dim-${i}">${i ? 'وتاني' : 'متفرّع حسب'}${i ? ' <span class="muted">(اختياري)</span>' : ''}</label><select id="ni-dim-${i}" data-change="niDimLabel" data-i="${i}">${NI_DIMS.map((x) => `<option ${d.label === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
    <div class="ni-row">${niTags(d.vals, `dims.${i}`, `ni-dq-${i}`, `dims.${i}.q`, d.q, 'اكتب ودوس Enter', niSuggest(d.label))}</div></div>`;
  const table = combos.length ? `<div class="table-wrap"><table class="t rc-t ni-var"><thead><tr><th>النوع</th><th>الباركود</th><th class="ta-n">العدد</th>${own ? '<th class="ta-n">التكلفة</th>' : ''}<th class="ta-n">السعر</th></tr></thead><tbody>
    ${combos.map((c) => { const key = c.join('|'), r = m.rows[key] || {}; const cell = (f, ph, cls = 'num', attrs = 'inputmode="numeric"') => `<input class="rc-in ${cls}" data-input="niRow" data-r="${esc(key)}" data-f="${f}" value="${esc(r[f] || '')}" placeholder="${ph}" dir="ltr" ${attrs} autocomplete="off" aria-label="${f} «${esc(c.join('، '))}»">`;
      return `<tr><td><bdi dir="rtl">${esc(c.join('، '))}</bdi></td><td>${cell('sku', '', 'mono ni-sku')}</td><td class="ta-n">${cell('qty', '0')}</td>${own ? `<td class="ta-n">${cell('cost', isNaN(cost) ? '' : String(cost))}</td>` : ''}<td class="ta-n">${cell('price', isNaN(price) ? '' : String(price))}</td></tr>`; }).join('')}
    </tbody></table></div>
    <div class="row wrap ni-var-f"><span class="muted">${kindsWord(combos.length)}. السعر${own ? ' والتكلفة' : ''} الفاضي = اللي فوق</span><span class="sp"></span><button type="button" class="btn sm" data-act="niCodes">${icon('scan-barcode')} اعمل أكواد للي من غير باركود</button></div>` : '';
  return `${m.dims.map(dimRow).join('')}${table}`;
}
function niItem(m) {
  const own = isOwner(), cats = itemCats(), cur = m.cat || '';
  return `<div class="ni-row">${niLabel('التصنيف')}<div class="chips wrap" id="ni-cats">${cats.map((c) => niChip(cur === c.id, 'niCat', `data-v="${c.id}"`, `${icon(c.icon)}<bdi>${esc(c.name)}</bdi>`)).join('')}
      ${m.catNew === null ? `<button type="button" class="chip ghost-chip" data-act="niCatNew">${icon('plus')} تصنيف جديد</button>`
        : `<span class="ni-inline"><input id="ni-cat-new" data-input="ni" data-k="catNew" value="${esc(m.catNew)}" placeholder="مثلًا: قطع غيار، خطوط" autocomplete="off" aria-label="اسم التصنيف الجديد"><button type="button" class="btn sm soft" data-act="niCatAdd">${icon('check')} ضيف</button></span>`}</div></div>
    <div class="grid2">${niInput('ni-name', 'اسم الصنف', 'name', m.name, 'placeholder="مثلًا: جراب سيليكون شفاف" data-autofocus')}${niInput('ni-ibrand', 'الماركة', 'ibrand', m.ibrand, 'placeholder="مثلًا: Anker"', true)}</div>
    <label class="ni-switch"><span class="switch"><input type="checkbox" data-change="niVarOn" ${m.varOn ? 'checked' : ''}><span></span></span><span class="t"><b>الصنف ده ليه تفرعات</b><small>زي جراب لكل موديل ولون، أو شاحن بأكتر من قوة. كل نوع ليه عدده وسعره وباركوده</small></span></label>
    ${m.varOn ? niVariants(m) : `<div class="field"><label for="ni-sku">الباركود <span class="muted">(اختياري)</span></label><div class="ni-inline"><input id="ni-sku" class="mono" data-input="ni" data-k="sku" value="${esc(m.sku)}" dir="ltr" inputmode="numeric" placeholder="امسحه بالماسح" autocomplete="off"><button type="button" class="btn sm" data-act="niCode" title="كود للمحل نفسه، بيتطبع على الملصق">${icon('scan-barcode')} اعمل كود</button></div></div>`}
    <div class="grid3">${niMoney('ni-price', 'سعر البيع', 'price', m.price)}${own ? niMoney('ni-cost', 'التكلفة', 'cost', m.cost, true, 'بتتكتب في الاستلام') : ''}${niMoney('ni-min', 'نبّهني لما يفضل', 'min', m.min, true, '5')}</div>
    ${niMoney('ni-warranty', 'الضمان بالشهور', 'warranty', m.warranty, true, '0')}
    ${niNameLine(m, m.varOn ? '' : niTitle(m), cur ? `، في «${esc(catFull(cur))}»` : '')}`;
}
const niKinds = () => `<div class="ni-kinds">${NI_KINDS.map(([id, ic, t, d], i) => `<button type="button" class="ni-kind" data-act="niKind" data-v="${id}" ${i === 0 ? 'data-autofocus' : ''}><span class="t-ico">${icon(ic)}</span><span class="t"><b>${t}</b><small>${d}</small></span><kbd>${num(i + 1)}</kbd></button>`).join('')}</div>
  <div class="note">${icon('info')} الشركات والتصنيفات بتتغيّر من الإعدادات، في «الأصناف والبيع». وأي صنف بيتسجّل هنا بيظهر على طول في البيع والبحث والمخزن.</div>`;
MODALS.newItem = {
  html: (m) => {
    const body = !m.kind ? niKinds() : m.kind === 'phone' ? niPhone(m) : m.kind === 'used' ? niUsed(m) : niItem(m);
    const sub = !m.kind ? 'اختار نوعه' : `${niKindName(m.kind)}${m.prev ? '. بعد التسجيل بينزل في الاستلام' : ''}`;
    return `<div class="modal ni" role="dialog" aria-label="صنف جديد">
      ${modalHead('صنف جديد', sub)}
      <div class="modal-b stack">${m.kind ? `<div class="ni-kind-bar"><span class="tag accent">${icon(NI_KINDS.find((x) => x[0] === m.kind)[1])} ${niKindName(m.kind)}</span><button type="button" class="btn sm ghost" data-act="niKind" data-v="">${icon('arrow-right')} غيّر النوع</button></div>` : ''}
        ${body}
        ${m.err ? `<div class="note warn" role="alert">${icon('triangle-alert')} <span>${esc(m.err)}${m.dup ? ` <button type="button" class="btn sm soft" data-act="niUseDup" data-id="${m.dup}">${icon('package-plus')} ضيف الموجود للاستلام</button>` : ''}</span></div>` : ''}
      </div>
      <div class="modal-f">${m.kind ? '' : '<span class="muted">دوس 1 أو 2 أو 3</span>'}<span class="sp"></span>
        <button type="button" class="btn ghost" data-act="closeModal">رجوع <kbd>Esc</kbd></button>
        ${m.kind === 'used' ? `<button type="button" class="btn" data-act="niSave" data-more="1">${icon('circle-plus')} سجّل وضيف جهاز تاني</button>` : ''}
        ${m.kind ? `<button type="button" class="btn primary" data-act="niSave">${icon('save')} ${m.prev ? 'سجّل وضيفه للاستلام' : 'سجّل الصنف'} <kbd>Enter</kbd></button>` : ''}</div>
    </div>`;
  },
  key: (e, m) => {
    const id = (e.target && e.target.id) || '';
    // Enter على زرار (نوع أو شركة أو مساحة…) بيدوسه، مش بيسجّل
    if (e.key === 'Enter' && e.target && e.target.tagName === 'BUTTON') { e.preventDefault(); e.target.click(); return true; }
    if (!m.kind) { const k = toLatin(e.key); if (/^[1-3]$/.test(k)) { e.preventDefault(); ACT.niKind({ v: NI_KINDS[+k - 1][0] }); return true; } return false; }
    // خانات الكلمات: Enter (أو الفاصلة) بيضيف الكلمة بدل ما يسجّل
    const tag = id === 'ni-color-q' ? ['colors', 'colorQ'] : /^ni-dq-[01]$/.test(id) ? [`dims.${id.slice(-1)}`, `dims.${id.slice(-1)}.q`] : null;
    if (tag && (e.key === 'Enter' || e.key === ',' || e.key === '،')) { e.preventDefault(); niTagPush(m, tag[0], niGet(m, tag[1])); niSet(m, tag[1], ''); render(); return true; }
    if (e.key === 'Enter' && id === 'ni-brand-new') { e.preventDefault(); ACT.niBrandAdd(); return true; }
    if (e.key === 'Enter' && id === 'ni-cat-new') { e.preventDefault(); ACT.niCatAdd(); return true; }
    return false;
  },
  enter: () => ACT.niSave({}),
  // فيه بيانات اتكتبت ولسه ماتسجّلتش: أول رجوع بينبّه
  canClose: (m) => {
    const typed = m.kind && (m.model || m.name || m.price || m.imei || m.colors.length || m.dims[0].vals.length);
    if (m.saved || !typed || m.confirmClose) return true;
    Object.assign(m, { confirmClose: true, err: 'فيه بيانات لسه ماتسجّلتش. لو عايز ترجع من غير تسجيل دوس Esc تاني', dup: null }); render();
    return false;
  },
};
const niGet = (m, path) => path.split('.').reduce((o, k) => o[k], m);
function niSet(m, path, v) { const ks = path.split('.'), last = ks.pop(); ks.reduce((o, k) => o[k], m)[last] = v; }
// path بيشاور على لستة (colors أو dims.0) أو على عنصر فيه vals
function niTagPush(m, path, raw) {
  const v = String(raw || '').trim().replace(/[،,]+$/, '').trim();
  if (!v) return;
  const t = niGet(m, path), list = Array.isArray(t) ? t : t.vals;
  if (!list.some((x) => normalize(x) === normalize(v))) list.push(v);
}

/* --- الفحص والتسجيل --- */
const niNum = (v) => { const n = parseNum(v); return Number.isFinite(n) ? n : NaN; };
const usedImeis = (m) => (m.prev ? m.prev.lines.flatMap((l) => l.imeis) : []);
function niImeiErr(raw, m, label = 'الـ IMEI') {
  const f = toLatin(raw).replace(/\D/g, '');
  if (f.length !== 15) return `${label} لازم يكون 15 رقم`;
  if (!luhnOk(f)) return `${label} ده مش صحيح: رقم المراجعة غلط. راجع الرقم`;
  const other = DATA.units.find((u) => u.imei === f || u.imei2 === f);
  if (other) return `${label} ده متسجّل قبل كده على «${prod(other.pid).name}»`;
  if (usedImeis(m).includes(f)) return `${label} ده مكتوب في الاستلام ده بالفعل`;
  return '';
}
function niCheck(m) {
  const own = isOwner(), price = niNum(m.price), bad = (msg, at, dup = null) => ({ msg, at, dup });
  if (m.kind === 'phone' || m.kind === 'used') {
    if (!m.brand) return bad('اختار الشركة، ولو مش موجودة دوس «شركة تانية»', 'ni-brands');
    if (!m.model.trim()) return bad('اكتب الموديل', 'ni-model');
    if (m.ptype === 'touch' && !m.rom) return bad('اختار المساحة', 'ni-model');
  }
  if (m.kind === 'phone') {
    const nm = normalize(m.model), dup = DATA.products.find((p) => p.serial && catKind(p.cat) === 'phone' && p.brand === m.brand && normalize(p.model) === nm && (p.rom || '') === (m.ptype === 'touch' ? m.rom : '') && (p.ram || '') === (m.ptype === 'touch' ? m.ram : ''));
    if (dup) return bad(`الموديل ده متسجّل قبل كده: «${dup.name}»`, 'ni-model', dup.id);
  }
  if (m.kind === 'used') {
    const e1 = niImeiErr(m.imei, m); if (e1) return bad(e1, 'ni-imei');
    if (m.imei2.trim()) { const e2 = niImeiErr(m.imei2, m, 'الـ IMEI التاني'); if (e2) return bad(e2, 'ni-imei2'); if (toLatin(m.imei2).replace(/\D/g, '') === toLatin(m.imei).replace(/\D/g, '')) return bad('الـ IMEI التاني هو هو الأولاني', 'ni-imei2'); }
    const bt = m.battery.trim() ? niNum(m.battery) : 0;
    if (isNaN(bt) || bt < 0 || bt > 100) return bad('البطارية رقم من 1 لـ 100', 'ni-battery');
  }
  if (m.kind === 'item') {
    if (!m.cat) return bad('اختار التصنيف، ولو مش موجود دوس «تصنيف جديد»', 'ni-cats');
    if (!m.name.trim()) return bad('اكتب اسم الصنف', 'ni-name');
    if (!m.varOn) {
      const dup = DATA.products.find((p) => !p.fam && p.cat === m.cat && normalize(p.name) === normalize(m.name));
      if (dup) return bad(`فيه صنف بنفس الاسم في «${catFull(m.cat)}»`, 'ni-name', dup.id);
      const e = niSkuErr(m.sku, []); if (e) return bad(e, 'ni-sku');
    } else {
      const combos = niCombos(m);
      if (!combos.length) return bad(`اكتب نوع واحد على الأقل في «${m.dims[0].label}»، ودوس Enter بعد كل واحد`, 'ni-dq-0');
      if (combos.length > NI_MAX_VARIANTS) return bad(`${kindsWord(combos.length)} كتير على صنف واحد (الحد ${num(NI_MAX_VARIANTS)}). قسّمه لأكتر من صنف`, 'ni-dq-1');
      if (DATA.products.some((p) => p.fam && normalize(p.base) === normalize(m.name) && p.cat === m.cat)) return bad(`فيه صنف بتفرعات بنفس الاسم في «${catFull(m.cat)}»`, 'ni-name');
      const seen = [];
      for (const c of combos) { const r = m.rows[c.join('|')] || {}, e = niSkuErr(r.sku || '', seen); if (e) return bad(`«${c.join('، ')}»: ${e}`, 'ni-name'); if (r.sku) seen.push(toLatin(r.sku).trim()); }
    }
  }
  if (!(price > 0)) return bad(m.kind === 'used' ? 'اكتب هيتباع بكام' : 'اكتب سعر البيع', 'ni-price');
  if (own && m.cost.trim() && !(niNum(m.cost) >= 0)) return bad('التكلفة لازم تكون رقم', 'ni-cost');
  for (const [k, id] of [['min', 'ni-min'], ['warranty', 'ni-warranty']]) if (String(m[k]).trim() && !(niNum(m[k]) >= 0)) return bad('الخانة دي رقم بس', id);
  return null;
}
function niSkuErr(raw, taken) {
  const v = toLatin(raw).trim();
  if (!v) return '';
  if (!/^\d{6,14}$/.test(v)) return 'الباركود أرقام بس (من 6 لـ 14 رقم)';
  const other = DATA.products.find((p) => p.sku === v);
  if (other || taken.includes(v)) return `الباركود ده على «${other ? other.name : 'نوع تاني هنا'}»`;
  return '';
}
// كود داخلي EAN-13 بيبدأ بـ 2: اللي بعد آخر كود عمله المحل
function nextCode(extra = []) {
  const mine = [...DATA.products.map((p) => p.sku), ...extra].filter((c) => /^2\d{12}$/.test(c || '')).map((c) => Number(c.slice(1, 12)));
  return ean13(`2${String((mine.length ? Math.max(...mine) : 0) + 1).padStart(11, '0')}`);
}
// بيرجّع الأصناف الجديدة، ومع كل واحد سطر الاستلام بتاعه (العدد والتكلفة والـ IMEI وتفاصيل المستعمل)
function niCreate(m) {
  const own = isOwner(), price = niNum(m.price), cost = own && m.cost.trim() ? niNum(m.cost) : 0;
  const min = String(m.min).trim() ? niNum(m.min) : null, b = brandByName(m.brand);
  if (m.kind === 'phone' || m.kind === 'used') {
    const rom = m.ptype === 'touch' ? m.rom : '', ram = m.ptype === 'touch' ? m.ram : '', used = m.kind === 'used';
    const base = { serial: true, icon: used ? 'recycle' : 'smartphone', brand: m.brand, model: m.model.trim().replace(/\s+/g, ' '), rom, ram, ptype: m.ptype, storage: specText(rom, ram), tac: '', kw: `${b && b.ar ? b.ar : ''}${used ? ' مستعمل' : ''}` };
    if (!used) return [{ p: newProd({ ...base, id: niId(), cat: m.cat || kindCats('phone')[0].id, name: niTitle(m), price, cost, min: min ?? 2, colors: [...m.colors] }), qty: 1, imeis: [], meta: null }];
    const imei = toLatin(m.imei).replace(/\D/g, ''), imei2 = toLatin(m.imei2).replace(/\D/g, '') || null;
    const meta = { imei2, color: m.color || null, condition: `فئة ${m.grade}`, battery: m.battery.trim() ? niNum(m.battery) : null, box: [...m.box], notes: m.notes.trim(), seller: m.sellerOn && m.seller.name.trim() ? { ...m.seller } : null };
    return [{ p: newProd({ ...base, id: niId(), cat: kindCats('used')[0].id, name: usedTitle(m), price, cost, min: min ?? 0, grade: `فئة ${m.grade}`, colors: m.color ? [m.color] : [] }), qty: 1, imeis: [imei], meta }];
  }
  const cat = catById(m.cat), name = m.name.trim().replace(/\s+/g, ' ');
  const common = { cat: m.cat, icon: (cat && cat.icon) || 'package', min: min ?? 5, warranty: String(m.warranty).trim() ? niNum(m.warranty) : 0, kw: [name, m.ibrand].join(' '), ibrand: m.ibrand.trim() };
  if (!m.varOn) return [{ p: newProd({ ...common, id: niId(), name, price, cost, sku: toLatin(m.sku).trim() }), qty: 1, imeis: [], meta: null }];
  const fam = niId(), dims = m.dims.filter((d) => d.vals.length).map((d) => d.label);
  return niCombos(m).map((c) => {
    const r = m.rows[c.join('|')] || {}, pr = r.price && niNum(r.price) > 0 ? niNum(r.price) : price, co = own && r.cost && niNum(r.cost) >= 0 ? niNum(r.cost) : cost;
    return { p: newProd({ ...common, id: niId(), name: `${name} ${c.join(' ')}`, price: pr, cost: co, sku: toLatin(r.sku || '').trim(), fam, base: name, vr: c, dims }), qty: Math.max(0, Math.floor(niNum(r.qty) || 0)), imeis: [], meta: null };
  });
}
function niFocus(at) { const el = document.getElementById(at); if (!el) return; if (el.tagName === 'INPUT') { el.focus(); el.select(); } else { const b = el.querySelector('button'); if (b) b.focus(); } }
INPUT.ni = (el) => { const m = S.modal; niSet(m, el.dataset.k, el.value); Object.assign(m, { err: '', dup: null, confirmClose: false }); render(); };
INPUT.niRow = (el) => { const m = S.modal, r = m.rows[el.dataset.r] || (m.rows[el.dataset.r] = {}); r[el.dataset.f] = el.value; m.err = ''; render(); };
CHANGE.niDimLabel = (el) => { S.modal.dims[+el.dataset.i].label = el.value; render(); };
CHANGE.niVarOn = (el) => { Object.assign(S.modal, { varOn: el.checked, err: '' }); render(); if (el.checked) niFocus('ni-dq-0'); };
const niPick = (k, v, toggle = false) => { const m = S.modal; m[k] = toggle && m[k] === v ? '' : v; Object.assign(m, { err: '', dup: null }); render(); };
Object.assign(ACT, {
  newItem: () => openNewItem(),
  niKind: (d) => { const m = S.modal, keep = m.prev; Object.assign(m, niBlank(d.v || null), { prev: keep, _mounted: false }); if (m.kind) niSeed(m, m.seed); render(); },
  niPtype: (d) => { const m = S.modal; m.ptype = d.v; const b = brandByName(m.brand); if (b && b.type !== 'both' && b.type !== d.v) m.brand = ''; render(); },
  niBrand: (d) => { niPick('brand', d.v); niFocus('ni-model'); },
  niBrandNew: () => { S.modal.brandNew = ''; render(); niFocus('ni-brand-new'); },
  niBrandAdd: () => {
    const m = S.modal, name = String(m.brandNew || '').trim();
    if (!name) { m.brandNew = null; render(); return; }
    const had = SET.brands.find((b) => normalize(b.name) === normalize(name));
    if (!had) { SET.brands.push({ id: `b${Date.now().toString(36)}`, name, type: m.ptype, hidden: false, custom: true }); saveSettings(); toast(`اتضافت «${name}» لشركات الموبايلات`); }
    Object.assign(m, { brand: had ? had.name : name, brandNew: null }); render(); niFocus('ni-model');
  },
  niRom: (d) => niPick('rom', d.v),
  niRam: (d) => niPick('ram', d.v, true),
  niColor: (d) => niPick('color', d.v, true),
  niGrade: (d) => niPick('grade', d.v),
  niBox: (d) => { const b = S.modal.box, i = b.indexOf(d.v); if (i < 0) b.push(d.v); else b.splice(i, 1); render(); },
  niSeller: () => { S.modal.sellerOn = !S.modal.sellerOn; render(); },
  niScan: () => { const m = S.modal; m.imei = DATA.makeImei('35'); Object.assign(m, { err: '', dup: null }); render(); toast(`الموبايل مسح IMEI …${m.imei.slice(-4)}`, 'info'); },
  niTagAdd: (d) => { niTagPush(S.modal, d.list, d.v); render(); },
  niTagDel: (d) => { const t = niGet(S.modal, d.list); (Array.isArray(t) ? t : t.vals).splice(+d.i, 1); render(); },
  niCat: (d) => niPick('cat', d.v),
  niCatNew: () => { S.modal.catNew = ''; render(); niFocus('ni-cat-new'); },
  niCatAdd: () => {
    const m = S.modal, name = String(m.catNew || '').trim();
    if (!name) { m.catNew = null; render(); return; }
    const had = SET.cats.find((c) => normalize(c.name) === normalize(name));
    if (had) { Object.assign(m, { cat: had.id, catNew: null }); render(); return; }
    const parent = (SET.cats.find((c) => !c.parent && c.kind === 'item' && SET.cats.some((x) => x.parent === c.id)) || {}).id || null;
    const c = { id: `c${Date.now().toString(36)}`, name, icon: 'tag', parent, hidden: false, custom: true, kind: parent ? null : 'item' };
    SET.cats.push(c); saveCats(); Object.assign(m, { cat: c.id, catNew: null }); render();
    toast(`اتضاف التصنيف «${name}»${parent ? ` تحت «${catName(parent)}»` : ''}`);
  },
  niCode: () => { S.modal.sku = nextCode(); render(); },
  niCodes: () => {
    const m = S.modal, made = [];
    for (const c of niCombos(m)) { const key = c.join('|'), r = m.rows[key] || (m.rows[key] = {}); if (!String(r.sku || '').trim()) { r.sku = nextCode(made); made.push(r.sku); } }
    render(); toast(made.length ? `اتعمل ${num(made.length)} كود للمحل، بيتطبعوا على الملصقات` : 'كل الأنواع ليها باركود', 'info');
  },
  niUseDup: (d) => { const m = S.modal; m.saved = true; const prev = m.prev; closeModal(); if (prev && S.modal === prev) rcAdd(d.id); },
  niSave: (d = {}) => {
    const m = S.modal;
    if (!m || m.type !== 'newItem' || !m.kind) return;
    const bad = niCheck(m);
    if (bad) { Object.assign(m, { err: bad.msg, dup: bad.dup }); render(); niFocus(bad.at); beep(); return; }
    const made = niCreate(m), keep = d.more ? { ptype: m.ptype, brand: m.brand, model: m.model, rom: m.rom, ram: m.ram } : null;
    for (const x of made) DATA.products.push(x.p);
    indexProducts();
    m.saved = true;
    const prev = m.prev, lines = made.filter((x) => x.qty > 0 || x.p.serial);
    closeModal();
    if (prev && S.modal === prev) rcAddLines(prev, lines);
    const first = made[0].p;
    toast(made.length > 1 ? `اتسجّل «${first.base}» بـ ${kindsWord(made.length)}${prev ? `، و${num(lines.length)} منهم نزلوا في الاستلام بعددهم` : ''}` : `اتسجّل «${first.name}»${prev ? '، اكتب العدد والتكلفة في الاستلام' : ''}`);
    if (keep && prev) openNewItem({ kind: 'used', keep });
    else render();
  },
});

/* ===== شاشة البيع: الصنف اللي ليه تفرعات بيتختار نوعه ===== */
function openVariantPicker(fam) {
  const vs = famOf(fam);
  if (!vs.length) return;
  openModal({ type: 'variant', fam, hi: Math.max(0, vs.findIndex((v) => stockOf(v) > 0)) });
}
MODALS.variant = {
  html: (m) => {
    const vs = famOf(m.fam), p = vs[0];
    return `<div class="modal md" role="dialog" aria-label="اختار النوع">
      ${modalHead(esc(p.base), `اختار ${esc(p.dims.join(' و'))}`)}
      <div class="modal-b"><div class="vr-grid" role="listbox" aria-label="الأنواع">${vs.map((v, i) => { const st = stockOf(v);
        return `<button type="button" class="vr ${i === m.hi ? 'on' : ''}" role="option" aria-selected="${i === m.hi}" data-act="vrPick" data-id="${v.id}" ${st <= 0 ? 'disabled' : ''}>
          <b><bdi dir="rtl">${esc(v.vr.join('، '))}</bdi></b><span class="num">${money(v.price)}</span><small class="${st <= 0 ? 'danger-t' : st <= v.min ? 'warn-t' : 'muted'}">${st <= 0 ? 'خلصان' : `${num(st)} متاح`}</small></button>`; }).join('')}</div></div>
      <div class="modal-f"><span class="muted">الأسهم وEnter، أو دوس على النوع</span><span class="sp"></span><button type="button" class="btn ghost" data-act="closeModal">قفل <kbd>Esc</kbd></button></div>
    </div>`;
  },
  key: (e, m) => {
    const vs = famOf(m.fam), ok = vs.map((v) => stockOf(v) > 0);
    const step = { ArrowLeft: 1, ArrowDown: 1, ArrowRight: -1, ArrowUp: -1 }[e.key];
    if (step) { e.preventDefault(); for (let k = 1; k <= vs.length; k++) { const j = (m.hi + step * k + vs.length * k) % vs.length; if (ok[j]) { m.hi = j; break; } } render(); return true; }
    if (e.key === 'Enter') { e.preventDefault(); if (vs[m.hi] && ok[m.hi]) ACT.vrPick({ id: vs[m.hi].id }); return true; }
    return false;
  },
};
ACT.vrPick = (d) => { const p = prod(d.id); S.modal = null; pickProduct(p); };
