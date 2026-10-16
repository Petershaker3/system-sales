'use strict';
// شاشة «معاينة تطبيق الموبايل». الكود متقسم ملف لكل شاشة — الترتيب في index.html، والدليل: docs/ENGINEERING.md
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
  const vsY = d.vsYesterday; // امبارح لنفس الساعة، ومحسوب في analytics.js
  const recent = DATA.dash.recent.filter((r) => own || r.sellerId === me.id).slice(0, own ? 3 : 4);
  const maxV = Math.max(1, ...DATA.users.map((u) => d.bySeller[u.id] || 0));
  return `<div class="ph-head"><b>${own ? 'مبيعات النهارده' : 'مبيعاتك النهارده'}</b><span class="tag ok"><span class="dot"></span> مباشر</span></div>
    <div class="ph-body">
      <div class="ph-card ph-total"><span class="muted">${own ? 'إجمالي المحل' : `مبيعات ${esc(me.name)}`}</span><b class="num big">${money(total)}</b>
        <div class="r"><span class="muted">${num(count)} فاتورة</span>${own && vsY !== null ? `<span class="${vsY >= 0 ? 'ok-t' : 'danger-t'}">${icon(vsY >= 0 ? 'trending-up' : 'trending-down')} ${num(Math.abs(vsY))}% عن امبارح لنفس الساعة</span>` : ''}</div>
        ${own ? `<div class="r"><span class="muted">الربح (للمالك بس)</span><b class="num">${money(d.profit)}</b></div>` : ''}</div>
      ${own ? `<div class="ph-card"><span class="muted" style="font-size:.8rem">مين باع كام</span>${DATA.users.map((u) => { const v = d.bySeller[u.id] || 0; return `<div class="seller-bar"><span class="nm">${esc(u.name)}</span><span class="bar-track"><i style="width:${Math.round((v / maxV) * 100)}%;background:${u.color}"></i></span><b class="num">${money(v)}</b></div>`; }).join('')}</div>` : ''}
      <div class="ph-list">${recent.map((r) => `<div class="ph-sale ${r.fresh ? 'fresh' : ''}"><div class="r"><b class="num">فاتورة ${dg(r.no)}</b><b class="num">${money(r.total)}</b></div><div class="r muted"><span>${dg(r.at)}، ${esc(r.seller)}</span>${r.fresh ? '<span class="tag accent">جديدة</span>' : `<span>${esc(r.method)}</span>`}</div></div>`).join('') || '<div class="muted" style="font-size:.85rem;text-align:center">لسه مفيش مبيعات</div>'}</div>
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
      <div class="ph-card"><div class="r"><span class="muted">فاتورة الكاشير دلوقتي</span><b class="num">${money(t.total)}</b></div><div class="muted" style="font-size:.8rem">${pcsWord(t.count)}</div></div>
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
      <div class="muted" style="font-size:.8rem">الأجهزة بتدخل المخزون من غير IMEI، ولو حبيت تسجّله بيتسجّل وقت البيع</div></div>
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
    <div class="page-h"><h2>تطبيق الموبايل</h2><span class="sub">مساعد جوه المحل على نفس الـ Wi-Fi، بيكلّم الكمبيوتر على طول ومن غير إنترنت</span><span class="sp"></span>
      <span class="status"><span class="dot"></span>${icon('wifi')} شبكة المحل <bdi dir="ltr" class="mono">192.168.1.10</bdi></span></div>
    <div class="phones">
      ${phoneFrame('مبيعات النهارده', 'chart-column', isOwner() ? 'أي بيعة بتتسجّل على الكمبيوتر بتظهر هنا في نفس اللحظة. المالك يشوف كل المبيعات ومين باع كام' : 'البيّاع يشوف مبيعاته هو بس، وإجمالي المحل والربح للمالك', salesScreen())}
      ${phoneFrame('ماسح للكاشير', 'scan-line', 'الكاميرا بتقرا الـ IMEI أو الباركود وتبعته لشاشة البيع على طول، بدل جهاز الباركود', scanScreen())}
      ${phoneFrame('سعر ومخزون', 'search', 'أي بيّاع يعرف السعر والمتاح والألوان وهو واقف مع الزبون', lookupScreen())}
      ${phoneFrame('استلام بضاعة', 'package-plus', 'بالـ IMEI (تمسح العلب) أو بالعدد من غير IMEI، زي ما يناسبك', recvScreen())}
    </div>
    <div class="note phones-note">${icon('wifi')} ده شغال طول ما الموبايل على Wi-Fi المحل، من غير إنترنت. متابعة المبيعات من برّه المحل (من البيت مثلًا) محتاجة مزامنة على الإنترنت، ودي مرحلة جاية في الخطة.</div>
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
