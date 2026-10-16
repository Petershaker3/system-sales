'use strict';
// شاشة «الإعدادات». الكود متقسم ملف لكل شاشة — الترتيب في index.html، والدليل: docs/ENGINEERING.md
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
  return `<div class="card"><h3>بيانات المحل</h3>
    <div class="preview-pair"><div class="stack">
      ${setField('shopName', 'اسم المحل')}
      <div class="grid2">${setField('phone', 'التليفون', 'dir="ltr" inputmode="tel"')}${setField('address', 'العنوان')}</div>
      <div class="field"><span class="label">اللوجو</span><div class="logo-up">${logoHTML()}<div class="stack" style="gap:8px">
        <label class="btn sm">${icon('upload')} ارفع لوجو<input type="file" accept="image/*" data-change="logo" hidden></label>
        ${SET.logo ? `<button type="button" class="btn sm ghost danger" data-act="logoRemove">${icon('trash-2')} شيل اللوجو</button>` : ''}
        <span class="hint">PNG أو JPG، وبيتصغّر لوحده. بيظهر في البرنامج وعلى الإيصال</span></div></div></div>
    </div>${receiptHTML(sampleSale())}</div></div>`;
}
function setLook() {
  const themes = [['light', 'sun', 'فاتح'], ['dark', 'moon', 'غامق'], ['auto', 'monitor', 'زي الجهاز']];
  const looks = [['plate', 'لافتة الشارع', 'لون المحل لوح بإطار رفيع جوّه، وخط Changa'], ['box', 'علبة الموبايل', 'أبيض وحبر وخطوط رفيعة، ولون المحل شريط واحد، وخط Vazirmatn']];
  const fonts = [['auto', 'خط الطابع', SET.look === 'box' ? 'Vazirmatn مع علبة الموبايل' : 'Changa مع لافتة الشارع'], ['plex', 'IBM Plex Sans Arabic', 'واضح ومتوازن'], ['cairo', 'Cairo', 'مألوف وعريض شوية'], ['tajawal', 'Tajawal', 'خفيف وعصري'], ['readex', 'Readex Pro', 'أرقامه مقروءة جدًا']];
  const acc = SET.accent.toLowerCase();
  return `<div class="card"><h3>الشكل</h3>
    <div class="s-row" style="align-items:flex-start"><div class="t"><b>الطابع</b><small>شكل الواجهة كلها. أماكن الحاجات والخطوات والاختصارات زي ما هي</small></div>
      <div class="look-cards">${looks.map(([id, name, d]) => `<button type="button" class="look-card ${SET.look === id ? 'on' : ''}" data-act="setLookStyle" data-id="${id}" aria-pressed="${SET.look === id}"><span class="lk lk-${id}" aria-hidden="true"><i class="lk-rail"></i><i class="lk-a"></i><i class="lk-b"></i><i class="lk-pay"></i></span><b>${name}</b><small>${d}</small></button>`).join('')}</div></div>
    <div class="s-row"><div class="t"><b>الوضع</b><small>فاتح للنهار، وغامق للليل أو لو النور قوي على الشاشة</small></div><div class="seg">${themes.map(([id, ic, l]) => `<button type="button" class="${SET.theme === id ? 'on' : ''}" data-act="setTheme" data-id="${id}">${icon(ic)} ${l}</button>`).join('')}</div></div>
    <div class="s-row"><div class="t"><b>اللون الأساسي</b><small>لون المحل للأزرار والتحديد، والكلام عليه بيتظبط لوحده عشان يفضل مقروء. ألوان الحالة (أخضر وأصفر وأحمر) ثابتة</small></div>
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
  return `<div class="card"><h3>تسجيل الـ IMEI</h3>
    <div class="s-row"><div class="t"><b>الـ IMEI عند البيع</b><small>${req ? 'إجباري: لازم تختار الجهاز بالـ IMEI قبل ما يتضاف للفاتورة' : 'اختياري: الموبايل بيتضاف للفاتورة على طول زي أي صنف، وتسجّل الـ IMEI من السطر أو بمسح العلبة لو حبيت'}</small></div>
      <div class="seg"><button type="button" class="${req ? '' : 'on'}" data-act="setImei" data-id="optional">اختياري</button><button type="button" class="${req ? 'on' : ''}" data-act="setImei" data-id="required">إجباري للموبايلات</button></div></div>
    <div class="note" style="margin-top:12px">${icon('info')} في الحالتين: البحث بآخر 4 أرقام من الـ IMEI شغال، والإيصال بيطبع الـ IMEI لو متسجّل، والاستلام ممكن يبقى بالـ IMEI أو بالعدد.</div>
  </div>
  <div class="card"><h3>صور الأصناف</h3>
    <div class="s-row"><div class="t"><b>اعرض صور الأصناف</b><small>في مربعات البيع ونتايج البحث وتطبيق الموبايل، والصنف اللي ملوش صورة بتفضل أيقونته</small></div><label class="switch"><input type="checkbox" data-change="showImages" ${SET.showImages ? 'checked' : ''} aria-label="اعرض صور الأصناف"><span></span></label></div>
    <div class="note" style="margin-top:12px">${icon('info')} اختيارية: بتتضاف من المخزون بالدوس على أيقونة الصنف. الصورة بتتقص مربع وتتصغّر لوحدها (حوالي 15 ك.ب)، يعني ألف صنف بصورهم حوالي 15 م.ب بس. ${nImg ? `عندك ${num(nImg)} صنف بصورة دلوقتي.` : 'لسه مفيش صور.'}</div>
  </div>
  <div class="card"><h3>التصنيفات في شاشة البيع</h3>
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
  setImei: (d) => { SET.imeiMode = d.id === 'required' ? 'required' : 'optional'; saveSettings(); render(); toast(d.id === 'required' ? 'الـ IMEI بقى إجباري للموبايلات' : 'الـ IMEI بقى اختياري، والموبايل بيتضاف على طول', 'info'); },
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
    toast(`اتضاف «${name}»${N.parent ? ` تحت «${catName(N.parent)}»` : ''}، وهيظهر في شاشة البيع`);
  },
});
function setUsers() {
  const perms = [['seeCost', 'يشوف التكلفة والربح'], ['refunds', 'يعمل مرتجع من غير المالك'], ['closeShift', 'يقفل الوردية'], ['reports', 'يفتح التقارير'], ['editPrices', 'يغيّر الأسعار']];
  return `<div class="card"><h3>المستخدمين</h3>
    <div class="table-wrap" style="border:0"><table class="t"><thead><tr><th>الاسم</th><th>الدور</th><th>PIN</th><th></th></tr></thead><tbody>
    ${DATA.users.map((u) => `<tr><td><div class="row">${avatar(u)}<b>${esc(u.name)}</b></div></td><td>${roleName(u)}</td><td class="mono">****</td><td><button type="button" class="btn sm" data-act="soon">${icon('pencil')} تغيير الـ PIN</button></td></tr>`).join('')}
    </tbody></table></div>
    <button type="button" class="btn soft" data-act="soon" style="margin-top:10px">${icon('user-plus')} بيّاع جديد</button>
    <div class="note" style="margin-top:12px">${icon('arrow-left-right')} التبديل السريع: تأشّر على اسمك فوق، تختار البيّاع، وتكتب الرقم السري بتاعه، والفاتورة المفتوحة بتفضل زي ما هي.</div></div>
  <div class="card"><h3>صلاحيات البيّاع</h3>
    ${perms.map(([k, l]) => `<div class="s-row"><div class="t"><b>${l}</b></div><label class="switch"><input type="checkbox" data-change="perm" data-k="${k}" ${SET.perms[k] ? 'checked' : ''} aria-label="${l}"><span></span></label></div>`).join('')}
    <div class="s-row"><div class="t"><b>أقصى خصم من غير المالك</b><small>أكتر من كده بيطلب PIN المالك</small></div><div class="field" style="width:110px"><input id="set-discountLimit" data-input="set" data-k="discountLimit" class="num" dir="ltr" inputmode="decimal" value="${esc(SET.discountLimit)}" aria-label="أقصى خصم"></div><span>%</span></div>
    <div class="note">${icon('info')} في النموذج ده «أقصى خصم» و«يقفل الوردية» شغالين فعلًا، والباقي للعرض بس.</div></div>`;
}
function setPay() {
  return `<div class="card"><h3>محافظ المحل</h3>
    <div class="table-wrap" style="border:0"><table class="t"><thead><tr><th>المحفظة</th><th>الرقم</th><th>الرصيد</th><th>الحد اليومي</th></tr></thead><tbody>
    ${DATA.wallets.map((w) => `<tr><td><div class="row"><span class="dot" style="background:${w.color}"></span><b>${w.name}</b></div></td><td><bdi dir="ltr" class="mono">${w.number}</bdi></td><td class="num">${money(w.balance)}</td><td class="num">${w.limitDay ? money(w.limitDay) : '<span class="muted">—</span>'}</td></tr>`).join('')}
    </tbody></table></div></div>
  <div class="card"><h3>عمولات الخدمات</h3>
    <div class="s-row"><div class="t"><b>العمولة والرسوم</b><small>${feeAuto() ? 'بتتحسب لوحدها من النسبة والحد الأدنى، والبيّاع يقدر يغيّرها في العملية' : 'مش ثابتة: البيّاع بيكتبها في كل عملية، وبتتسجّل في دفتر الخدمات والتقارير'}</small></div>
      <div class="seg">${[['manual', 'تتكتب في كل عملية'], ['auto', 'محسوبة تلقائي']].map(([id, l]) => `<button type="button" class="${SET.feeMode === id ? 'on' : ''}" data-act="setFeeMode" data-id="${id}">${l}</button>`).join('')}</div></div>
    ${feeAuto() ? `<div class="grid3" style="margin-top:8px">${setField('feePct', 'عمولة التحويل والسحب %', 'class="num" dir="ltr" inputmode="decimal"')}${setField('feeMin', 'أقل عمولة (ج.م)', 'class="num" dir="ltr" inputmode="decimal"')}${setField('billFee', 'رسوم دفع الفواتير (ج.م)', 'class="num" dir="ltr" inputmode="decimal"')}</div>
    <div class="note" style="margin-top:12px">${icon('info')} مثال: تحويل ${money(1000)} عمولته ${money(walletFee(1000))}، وتحويل ${money(200)} عمولته ${money(walletFee(200))}</div>` : `<div class="note" style="margin-top:12px">${icon('info')} في شاشة الخدمات (F9) فيه خانة «العمولة» فاضية، والبيّاع بيكتب اللي اتفق عليه مع العميل (ولو مفيش يكتب ${num(0)}).</div>`}</div>
  <div class="card"><h3>طرق الدفع اللي بتظهر في شاشة الدفع</h3>
    ${DATA.payMethods.map((x) => `<div class="s-row"><div class="t"><b>${icon(x.icon)} ${x.name}</b>${x.id === 'install' ? `<small>${DATA.installProviders.join('، ')}</small>` : x.id === 'credit' ? '<small>لازم يكون على عميل متسجّل</small>' : ''}</div><label class="switch"><input type="checkbox" data-change="method" data-k="${x.id}" ${SET.methods[x.id] !== false ? 'checked' : ''} ${x.id === 'cash' ? 'disabled' : ''} aria-label="${x.name}"><span></span></label></div>`).join('')}
  </div>`;
}
function setReceipt() {
  return `<div class="preview-pair"><div class="stack">
    <div class="card"><h3>الإيصال</h3>
      ${hasPrinter() ? `<div class="s-row"><div class="t"><b>مقاس الورق</b><small>بيتطبع كصورة عشان العربي يطلع مظبوط على أي طابعة حرارية</small></div><div class="seg"><button type="button" class="${SET.paper === '80' ? 'on' : ''}" data-act="setPaper" data-id="80">${num(80)} مم</button><button type="button" class="${SET.paper === '58' ? 'on' : ''}" data-act="setPaper" data-id="58">${num(58)} مم</button></div></div>` : ''}
      <div class="s-row"><div class="t"><b>بعد الدفع</b><small>${hasPrinter() ? 'الاختيار اللي بيبقى متعلّم في شاشة الدفع' : 'مفيش طابعة: الإيصال بيتبعت واتساب (صورة + رسالة). من غير عميل بتبقى «بدون» وتقدر تختار واتساب وتكتب الرقم'}</small></div><div class="seg">${receiptOpts().map(([id, l]) => `<button type="button" class="${receiptSetting() === id ? 'on' : ''}" data-act="setRMode" data-id="${id}">${l}</button>`).join('')}</div></div>
      <div class="s-row"><div class="t"><b>مكان QR الإيصال الإلكتروني</b><small>بيتفعّل لما المحل يدخل منظومة الإيصال الإلكتروني</small></div><label class="switch"><input type="checkbox" data-change="showQR" ${SET.showQR ? 'checked' : ''} aria-label="QR"><span></span></label></div>
      <div class="field" style="margin-top:8px"><label for="set-footer">الجملة اللي في آخر الإيصال</label><textarea id="set-footer" data-input="set" data-k="footer">${esc(SET.footer)}</textarea></div>
      <div class="field" style="margin-top:8px"><label for="set-waTemplate">رسالة الواتساب</label><textarea id="set-waTemplate" data-input="set" data-k="waTemplate">${esc(SET.waTemplate)}</textarea><span class="hint">{الاسم} و{رقم} و{المحل} و{تاريخ_الضمان} بيتبدّلوا لوحدهم</span></div>
    </div>
    <div class="card"><h3>الضمان الافتراضي</h3><div class="grid2">
      ${setField('warrantyNew', 'موبايل جديد (شهور)', 'class="num" dir="ltr" inputmode="numeric"')}${setField('warrantyUsed', 'موبايل مستعمل (شهور)', 'class="num" dir="ltr" inputmode="numeric"')}</div></div>
  </div>${receiptHTML(sampleSale())}</div>`;
}
function setBackup() {
  return `<div class="card"><h3>النسخ الاحتياطي</h3>
    <div class="s-row"><div class="t"><b>آخر نسخة</b><small>النهارده ${dg('9:00')} ص، تلقائي مع فتح الوردية، ومشفّرة</small></div><span class="tag ok">${icon('circle-check')} سليمة</span></div>
    <div class="s-row"><div class="t"><b>نسخة تلقائية</b><small>كل يوم مع تقفيل الوردية + كل ساعتين</small></div><label class="switch"><input type="checkbox" checked aria-label="نسخة تلقائية"><span></span></label></div>
    <div class="s-row"><div class="t"><b>نسخة على فلاشة USB</b><small>أول ما تتوصل فلاشة اسمها MSHOP-BACKUP</small></div><label class="switch"><input type="checkbox" checked aria-label="فلاشة"><span></span></label></div>
    <div class="row wrap" style="margin-top:12px"><button type="button" class="btn primary" data-act="backupNow">${icon('hard-drive')} خد نسخة دلوقتي</button><button type="button" class="btn" data-act="soon">${icon('usb')} انسخ على فلاشة</button><button type="button" class="btn danger" data-act="soon">${icon('rotate-ccw')} استرجاع نسخة</button></div>
    <div class="note warn" style="margin-top:12px">${icon('triangle-alert')} الاسترجاع بيرجّع البيانات لوقت النسخة، وبيطلب PIN المالك.</div>
  </div>`;
}
function setDevices() {
  return `<div class="card"><h3>الموبايلات المتوصلة</h3>
    ${DATA.devices.map((d) => `<div class="s-row"><span class="t-ico">${icon('smartphone')}</span><div class="t"><b>${esc(d.name)}</b><small><bdi dir="rtl">${esc(d.model)}</bdi>، ${d.last}</small></div><span class="tag ok"><span class="dot"></span> متصل</span><button type="button" class="btn sm ghost danger" data-act="soon">فصل</button></div>`).join('')}
  </div>
  <div class="card"><h3>توصيل موبايل جديد</h3>
    <div class="qr-box">${fakeQR(`PAIR-${SET.shopName}`, 168, 'pair-qr')}<div class="stack" style="gap:6px">
      <b>${dg('1.')} افتح تطبيق المحل على الموبايل</b><span>${dg('2.')} اتأكد إنه على نفس الـ Wi-Fi بتاع المحل</span><span>${dg('3.')} امسح الكود ده، وبعدها اختار البيّاع واكتب الـ PIN</span>
      <span class="muted">عنوان الكمبيوتر: <bdi dir="ltr" class="mono">192.168.1.10:8787</bdi></span></div></div>
  </div>
  <div class="card"><h3>الطابعة</h3>
    ${hasPrinter()
      ? `<div class="s-row"><div class="t"><b>XP-80 (USB)</b><small>طابعة حرارية ${num(80)} مم، والطباعة كصورة</small></div><span class="tag ok">جاهزة</span><button type="button" class="btn sm" data-act="testPrint">${icon('printer')} صفحة تجربة</button></div>`
      : `<div class="s-row"><span class="t-ico">${icon('message-circle')}</span><div class="t"><b>مفيش طابعة دلوقتي</b><small>الإيصال بيتبعت للعميل على واتساب: صورة الإيصال + رسالة الواتساب اللي في إعدادات الإيصال</small></div><span class="tag">واتساب بس</span></div>`}
    <div class="s-row"><div class="t"><b>عندي طابعة إيصالات</b><small>لما تجيب طابعة حرارية فعّل ده، وهترجع «طباعة» و«الاتنين» في شاشة الدفع</small></div><label class="switch"><input type="checkbox" data-change="printer" ${hasPrinter() ? 'checked' : ''} aria-label="عندي طابعة إيصالات"><span></span></label></div>
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
  backupNow: () => toast(`اتعملت نسخة احتياطية مشفّرة الساعة ${fmtTime()}`),
  testPrint: () => toast('بيطبع صفحة تجربة على XP-80', 'info'),
});
