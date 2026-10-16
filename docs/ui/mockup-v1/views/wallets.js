'use strict';
// شاشة «المحافظ». الكود متقسم ملف لكل شاشة — الترتيب في index.html، والدليل: docs/ENGINEERING.md
/* ===== المحافظ (docs/ui/STORE-CATALOG-WALLETS.md، المرحلة 4) =====
   المالك: «تستورد الأفكار من السيستم القديم وتطوّرها… وفارض إني أكتب نمرة اللي بحوّله أو بسحب منه وده غلط».
   من القديم: ملخص المحافظ فوق دايمًا (الإجمالي واللي محتاجة انتباه وكارت لكل محفظة)، والرصيد الافتتاحي، وحد التنبيه، والترتيب،
   وسجل العمليات والتراجع بسبب، والتقرير بالمحفظة. التطوير: المبلغ والعمولة خانتين (المبلغ بس بيحرّك الرصيد)، ومكتوب تحت كل نوع
   بيحصل إيه في الدرج والمحفظة، والإيداع ما يعدّيش الرصيد، ورقم محفظة المحل بيظهر في السحب، وشحن وتفريغ وتحويل بين محفظتين،
   وجرد المحفظة، وفلوس البيع اللي اتدفعت بمحفظة بتنزل في رصيدها. كل الأرقام من analytics.js (walletBalance و walletStats و servicesOf). */
const W_TYPES = {
  deposit: ['إيداع', 'arrow-up-from-line'], withdraw: ['سحب', 'arrow-down-to-line'], topup: ['شحن المحفظة', 'circle-plus'],
  unload: ['تفريغ المحفظة', 'download'], move: ['من محفظة لمحفظة', 'arrow-left-right'], adjust: ['تسوية جرد', 'scan-line'],
};
const W_STATE = { low: ['warn', 'قربت تخلص'], near: ['warn', 'قرّبت من أقصى رصيد'], over: ['danger', 'عدّت أقصى رصيد'], neg: ['danger', 'بالسالب'] };
const walById = (id) => DATA.wallets.find((w) => w.id === id);
const walShown = () => DATA.wallets.filter((w) => !w.hidden);
const wBal = (w) => walletBalance(w, DATA.walletOps, DATA.history, DATA.walletSince);
// اسم البيّاع: userName من views/reports.js
const opWhen = (d) => (sameDay(d, new Date()) ? fmtTime(d) : `${fmtDate(d)} ${fmtTime(d)}`);
const signed = (v, cls = true) => (v === 0 ? '<span class="muted">—</span>' : `<span class="num ${cls ? (v > 0 ? 'ok-t' : 'danger-t') : ''}">${v > 0 ? '+' : '−'} ${money(Math.abs(v))}</span>`);
// الكلام اللي بيوصف الحركة في السجل
function opWhat(op) {
  if (op.type === 'topup') return op.via === 'drawer' ? 'من الدرج' : 'من برّه';
  if (op.type === 'unload') return op.via === 'drawer' ? 'للدرج' : 'لبرّه';
  if (op.type === 'move') { const a = walById(op.wallet), b = walById(op.to); return `من ${a ? a.name : ''} لـ${b ? b.name : ''}`; }
  return '';
}
const W_PERIODS = [['today', 'النهارده'], ['yday', 'امبارح'], ['month', 'الشهر ده'], ['prev', 'الشهر اللي فات']];
function wPeriod(id) {
  const t0 = dayStart(new Date());
  if (id === 'yday') return [addDays(t0, -1), t0];
  if (id === 'month') return [monthStart(t0), FAR];
  if (id === 'prev') return [monthStart(addMonths(t0, -1)), monthStart(t0)];
  return [t0, FAR];
}
const walState = () => S.wal || (S.wal = { p: 'today', w: '', all: false });

/* --- الكارت: رصيد المحفظة وحالتها ورقمها، ومقياس لحد أقصى رصيد --- */
function walCardHTML(w, sel) {
  const bal = wBal(w), st = walletState(w, bal), today = walletStats(w, DATA.walletOps, DATA.history, dayStart(new Date()), FAR), tag = W_STATE[st];
  const pct = w.max ? clamp(Math.round((bal / w.max) * 100), 0, 100) : 0, minPct = w.max && w.min ? clamp(Math.round((w.min / w.max) * 100), 0, 100) : 0;
  return `<button type="button" class="wl-card st-${st} ${sel ? 'on' : ''}" data-act="walPick" data-id="${w.id}" aria-pressed="${sel}" title="${sel ? 'اعرض كل المحافظ' : `اعرض عمليات ${esc(w.name)} بس`}">
    <span class="wl-h"><span class="dot" style="background:${w.color}"></span><b>${esc(w.name)}</b>${tag ? `<span class="tag ${tag[0]}">${tag[1]}</span>` : ''}</span>
    <span class="wl-bal num">${money(bal)}</span>
    ${w.max ? `<span class="wl-meter" aria-hidden="true"><i style="width:${pct}%"></i>${minPct ? `<em style="inset-inline-start:${minPct}%"></em>` : ''}</span><span class="wl-sub muted">${w.min ? `الأدنى ${num(w.min)} والأقصى ${num(w.max)}` : `أقصى رصيد ${num(w.max)}`}</span>` : ''}
    ${w.number ? `<span class="wl-sub"><bdi dir="ltr" class="mono">${esc(w.number)}</bdi></span>` : ''}
    <span class="wl-sub muted">${today.ops ? `النهارده ${countWord(today.ops, 'عملية', 'عمليتين', 'عمليات')}، عمولة ${money(today.fees)}` : 'مفيش عمليات النهارده'}</span>
    ${w.limitDay ? `<span class="wl-sub ${today.used > w.limitDay * 0.9 ? 'warn-t' : 'muted'}">الحد اليومي: ${num(today.used)} من ${num(w.limitDay)}</span>` : ''}
  </button>`;
}
function viewWallets() {
  const W = walState(), own = isOwner(), list = walShown();
  if (!list.length) return `<div class="page"><div class="page-h"><h2>المحافظ</h2></div>
    <div class="sv-empty">${icon('wallet')}<b>لسه مفيش محافظ</b><span>${own ? 'ضيف محافظ المحل من الإعدادات، في «المحافظ والدفع»: الاسم، ورقم المحفظة، والرصيد اللي فيها النهارده.' : 'المالك بيضيف محافظ المحل من الإعدادات.'}</span>
      ${own ? `<button type="button" class="btn primary" data-act="walSettings">${icon('settings')} ضيف محفظة</button>` : ''}</div></div>`;
  if (W.w && !list.some((w) => w.id === W.w)) W.w = '';
  const bals = list.map(wBal), total = bals.reduce((a, b) => a + b, 0), warn = list.filter((w, i) => walletState(w, bals[i]) !== 'ok').length;
  const [from, end] = wPeriod(W.p), stats = list.map((w) => walletStats(w, DATA.walletOps, DATA.history, from, end));
  const T = stats.reduce((a, s) => ({ depN: a.depN + s.depN, dep: a.dep + s.dep, witN: a.witN + s.witN, wit: a.wit + s.wit, fees: a.fees + s.fees, payIn: a.payIn + s.payIn }), { depN: 0, dep: 0, witN: 0, wit: 0, fees: 0, payIn: 0 });
  const ops = DATA.walletOps.filter((o) => o.at >= from && o.at < end && (!W.w || o.wallet === W.w || o.to === W.w)).slice().reverse(), shown = W.all ? ops : ops.slice(0, 40);
  const pName = W_PERIODS.find((x) => x[0] === W.p)[1], selW = W.w ? walById(W.w) : null;
  const row = (op) => {
    const w = walById(op.wallet), [lbl, ic] = W_TYPES[op.type], d = op.type === 'move' && W.w === op.to ? op.amount : walletDelta({ ...op, void: null }, op.wallet === W.w || !W.w ? op.wallet : op.to);
    return `<tr class="${op.void ? 'void' : ''}"><td class="num">${opWhen(op.at)}</td><td><span class="wl-type">${icon(ic)} ${lbl}</span>${opWhat(op) ? ` <small class="muted">${esc(opWhat(op))}</small>` : ''}</td>
      <td><span class="dot" style="background:${w ? w.color : 'transparent'}"></span> ${esc(w ? w.name : '')}</td><td class="ta-n">${signed(d)}</td><td class="ta-n num">${op.fee ? money(op.fee) : '<span class="muted">—</span>'}</td>
      <td class="ta-n">${signed(opCash({ ...op, void: null }), false)}</td><td>${esc(userName(op.by))}</td>
      <td class="wl-why">${op.void ? `<span class="tag danger">اتلغت: ${esc(op.void.reason)}</span>` : esc(op.note)}</td>
      ${own ? `<td class="ta-n">${op.void ? '' : `<button type="button" class="icon-btn sm" data-act="walVoid" data-id="${op.id}" title="إلغاء العملية (بسبب)" aria-label="إلغاء العملية">${icon('undo-2')}</button>`}</td>` : ''}</tr>`;
  };
  return `<div class="page">
    <div class="page-h"><h2>المحافظ</h2><span class="sub">${countWord(list.length, 'محفظة', 'محفظتين', 'محافظ')}، والإجمالي <b class="num">${money(total)}</b></span>${warn ? `<span class="tag warn">${icon('triangle-alert')} ${countWord(warn, 'محفظة', 'محفظتين', 'محافظ')} محتاجة انتباه</span>` : ''}<span class="sp"></span>
      <button type="button" class="btn primary" data-act="services">${icon('wallet')} إيداع أو سحب <kbd>F9</kbd></button>
      ${own ? `<button type="button" class="btn" data-act="walMove">${icon('arrow-left-right')} شحن أو تفريغ</button><button type="button" class="btn" data-act="walCount">${icon('scan-line')} جرد محفظة</button>` : ''}</div>
    <div class="wl-cards">${list.map((w) => walCardHTML(w, W.w === w.id)).join('')}</div>
    <div class="wl-bar"><div class="seg" role="group" aria-label="الفترة">${W_PERIODS.map(([id, l]) => `<button type="button" class="${W.p === id ? 'on' : ''}" data-act="walPeriod" data-id="${id}" aria-pressed="${W.p === id}">${l}</button>`).join('')}</div>
      ${selW ? `<span class="chip on">${esc(selW.name)}<button type="button" class="rc-x" data-act="walPick" data-id="${selW.id}" aria-label="كل المحافظ">${icon('x')}</button></span>` : '<span class="muted">دوس على محفظة تشوف عملياتها بس</span>'}</div>
    <div class="wl-grid">
      <div class="card"><h3>${pName} لكل محفظة</h3><div class="table-wrap" style="border:0"><table class="t sv-t"><thead><tr><th>المحفظة</th><th class="ta-n">إيداع</th><th class="ta-n">سحب</th><th class="ta-n">العمولة</th><th class="ta-n">فلوس البيع</th></tr></thead><tbody>
        ${list.map((w, i) => { const s = stats[i]; return `<tr><td><span class="dot" style="background:${w.color}"></span> ${esc(w.name)}</td><td class="ta-n num">${s.depN ? `${money(s.dep)} <small class="muted">(${num(s.depN)})</small>` : '—'}</td><td class="ta-n num">${s.witN ? `${money(s.wit)} <small class="muted">(${num(s.witN)})</small>` : '—'}</td><td class="ta-n num"><b>${money(s.fees)}</b></td><td class="ta-n num">${w.pay ? money(s.payIn) : '<span class="muted">—</span>'}</td></tr>`; }).join('')}
        <tr class="tot"><td><b>الإجمالي</b></td><td class="ta-n num"><b>${money(T.dep)}</b> <small class="muted">(${num(T.depN)})</small></td><td class="ta-n num"><b>${money(T.wit)}</b> <small class="muted">(${num(T.witN)})</small></td><td class="ta-n num"><b>${money(T.fees)}</b></td><td class="ta-n num"><b>${money(T.payIn)}</b></td></tr>
      </tbody></table></div>
      <div class="muted wl-foot">العمولة دخل للمحل. «فلوس البيع» فواتير اتدفعت على المحفظة، وبتزوّد رصيدها لوحدها.</div></div>
      <div class="card"><h3>العمليات ${selW ? `على ${esc(selW.name)}` : ''}<small class="muted"> ${pName}، ${countWord(ops.length, 'عملية', 'عمليتين', 'عمليات')}</small></h3>
        ${ops.length ? `<div class="table-wrap" style="border:0" data-scroll="wl-log"><table class="t wl-log"><thead><tr><th>الوقت</th><th>العملية</th><th>المحفظة</th><th class="ta-n">حركة المحفظة</th><th class="ta-n">العمولة</th><th class="ta-n">حركة الدرج</th><th>مين</th><th>ملاحظة</th>${own ? '<th aria-hidden="true"></th>' : ''}</tr></thead><tbody>${shown.map(row).join('')}</tbody></table></div>
          ${ops.length > shown.length ? `<button type="button" class="btn sm ghost" data-act="walAll">${icon('chevron-down')} اعرض الـ ${num(ops.length - shown.length)} الباقيين</button>` : ''}`
        : `<div class="muted wl-none">مفيش عمليات ${pName}</div>`}
      </div>
    </div>
  </div>`;
}
VIEWS.wallets = viewWallets;
function walletsKey(e) { if (e.key === 'F9') { e.preventDefault(); openServices(); } }

/* --- عملية لعميل (إيداع أو سحب): نفس النموذج في «المحافظ» وفي خدمات البيع (F9)، ومن غير رقم العميل --- */
function walletFormHTML(m) {
  const list = walShown();
  if (!list.length) return `<div class="sv-empty">${icon('wallet')}<b>لسه مفيش محافظ</b><span>${isOwner() ? 'ضيف محافظ المحل من الإعدادات، في «المحافظ والدفع».' : 'المالك بيضيف محافظ المحل من الإعدادات.'}</span></div>`;
  const w = list.find((x) => x.id === m.wallet) || list[0]; m.wallet = w.id;
  const a = parseNum(m.amount), ok = !isNaN(a) && a > 0, bal = wBal(w), dep = m.op === 'deposit', after = ok ? bal + (dep ? -a : a) : bal;
  const autoFee = ok ? walletFee(a) : 0, fee = svcFee(m, autoFee), used = walletStats(w, DATA.walletOps, DATA.history, dayStart(new Date()), FAR).used;
  const hint = feeAuto() ? `محسوبة ${num(SET.feePct)}%، وأقل حاجة ${money(SET.feeMin)}. تقدر تغيّرها` : 'مش ثابتة، اكتبها';
  const notes = [];
  if (ok && dep && a > bal) notes.push(['danger', `الرصيد مش كفاية: في ${w.name} ${money(bal)} بس. اشحن المحفظة الأول، أو اختار محفظة تانية`]);
  else if (ok && w.limitDay && used + a > w.limitDay) notes.push(['warn', `كده هتعدّي الحد اليومي لـ${w.name} (${money(w.limitDay)}). اتحوّل النهارده ${money(used)}`]);
  if (ok && dep && a <= bal && w.min && after < w.min) notes.push(['warn', `${w.name} هتقرب تخلص: هيفضل فيها ${money(after)}`]);
  if (ok && !dep && w.max && after > w.max) notes.push(['warn', `${w.name} هتعدّي أقصى رصيد (${money(w.max)}). فرّغها لما تقدر`]);
  return `<div class="seg wl-op" role="group" aria-label="نوع العملية">${[['deposit', 'إيداع', 'arrow-up-from-line', 'العميل بيدفع كاش، وانت بتحوّل من محفظتك'], ['withdraw', 'سحب', 'arrow-down-to-line', 'العميل بيحوّل على محفظتك، وانت بتديله كاش']].map(([id, l, ic, d]) => `<button type="button" class="${m.op === id ? 'on' : ''}" data-act="svcOp" data-id="${id}" aria-pressed="${m.op === id}"><b>${icon(ic)} ${l}</b><small>${d}</small></button>`).join('')}</div>
    <div class="wallets">${list.map((x) => { const b = wBal(x), st = walletState(x, b); return `<button type="button" class="wallet ${w.id === x.id ? 'on' : ''}" data-act="svcWallet" data-id="${x.id}" aria-pressed="${w.id === x.id}"><span class="dot" style="background:${x.color}"></span><span class="t"><b>${esc(x.name)}</b><small class="num ${st === 'ok' ? '' : W_STATE[st][0] === 'danger' ? 'danger-t' : 'warn-t'}">${money(b)}</small></span></button>`; }).join('')}</div>
    ${!dep && w.number ? `<div class="wl-pay-to">${icon('smartphone')}<span>خلّي العميل يحوّل على</span><bdi dir="ltr" class="mono">${esc(w.number)}</bdi></div>` : ''}
    <div class="grid2">
      <div class="field"><label for="svc-amt">المبلغ</label><input id="svc-amt" class="big-in num" data-input="svc" data-k="amount" ${m.focusFee ? '' : 'data-autofocus'} dir="ltr" inputmode="decimal" value="${esc(m.amount)}" autocomplete="off"></div>
      <div class="field"><label for="svc-note">ملاحظة <span class="muted">(اختياري)</span></label><input id="svc-note" class="wl-note" data-input="svc" data-k="note" value="${esc(m.note)}" placeholder="لو حابب تكتب حاجة" autocomplete="off"></div>
    </div>
    <div class="due-box">${feeField(m, 'svc-fee', 'العمولة', hint, autoFee, ok)}
      <div class="r"><span>رصيد ${esc(w.name)} بعدها</span><b class="num ${after < 0 ? 'danger-t' : ''}">${money(after)}</b></div>
      <div class="r grand"><span>${dep ? 'تحصّل من العميل كاش' : 'تدفع للعميل كاش'}</span><b class="num">${!ok ? money(0) : isNaN(fee) ? '<small class="muted">اكتب العمولة</small>' : money(dep ? a + fee : a - fee)}</b></div></div>
    ${notes.map(([k, t]) => `<div class="note ${k}" ${k === 'danger' ? 'role="alert"' : ''}>${icon('triangle-alert')} ${esc(t)}</div>`).join('')}`;
}
function walletRecord(m) {
  const w = walById(m.wallet), a = parseNum(m.amount);
  if (!w) return;
  if (!(a > 0)) { m.err = 'اكتب المبلغ'; beep(); render(); return; }
  const fee = svcFee(m, walletFee(a));
  if (isNaN(fee) || fee < 0) { Object.assign(m, { err: 'اكتب العمولة، ولو مفيش عمولة اكتب 0', focusFee: true, _mounted: false }); beep(); render(); return; }
  if (m.op === 'withdraw' && fee > a) { m.err = 'العمولة أكبر من مبلغ السحب'; beep(); render(); return; }
  const bal = wBal(w);
  if (m.op === 'deposit' && a > bal) { m.err = `الرصيد مش كفاية: في ${w.name} ${money(bal)} بس`; beep(); render(); return; }
  const op = { id: `w${DATA.walletOps.length + 1}`, at: new Date(), type: m.op, wallet: w.id, amount: a, fee, by: S.user.id, note: m.note.trim() };
  DATA.walletOps.push(op); refreshDash();
  const cash = opCash(op);
  toast(m.op === 'deposit' ? `اتسجّل إيداع ${money(a)} من ${w.name}. حصّل ${money(cash)} من العميل` : `اتسجّل سحب ${money(a)} على ${w.name}. ادفع للعميل ${money(-cash)}`);
  Object.assign(m, { amount: '', note: '', err: '', ...svcReset, _mounted: false }); render();
}

/* --- شحن وتفريغ وتحويل بين محفظتين (المالك بس) --- */
const MOVE_KINDS = [['topup', 'شحن المحفظة'], ['unload', 'تفريغ المحفظة'], ['move', 'من محفظة لمحفظة']];
function openWalletMove() {
  const list = walShown();
  if (!list.length) return;
  openModal({ type: 'walletMove', kind: 'topup', wallet: list[0].id, to: (list[1] || list[0]).id, via: 'drawer', amount: '', note: '', err: '' });
}
MODALS.walletMove = {
  html(m) {
    const list = walShown(), w = walById(m.wallet), to = walById(m.to), a = parseNum(m.amount), ok = a > 0, bal = wBal(w);
    const delta = !ok ? 0 : m.kind === 'topup' ? a : -a, cash = !ok || m.kind === 'move' || m.via !== 'drawer' ? 0 : m.kind === 'topup' ? -a : a;
    const pick = (act, cur, skip) => `<div class="wallets">${list.filter((x) => x.id !== skip).map((x) => `<button type="button" class="wallet ${cur === x.id ? 'on' : ''}" data-act="${act}" data-id="${x.id}" aria-pressed="${cur === x.id}"><span class="dot" style="background:${x.color}"></span><span class="t"><b>${esc(x.name)}</b><small class="num">${money(wBal(x))}</small></span></button>`).join('')}</div>`;
    const vias = m.kind === 'topup' ? [['drawer', 'من الدرج'], ['out', 'من برّه (حسابك أو البنك)']] : [['drawer', 'للدرج'], ['out', 'لبرّه (البنك أو مورد)']];
    return `<div class="modal md" role="dialog" aria-label="شحن أو تفريغ">
      ${modalHead('شحن أو تفريغ', 'حركة فلوس للمالك، من غير عميل ومن غير عمولة')}
      <div class="modal-b stack">
        <div class="seg" role="group" aria-label="نوع الحركة">${MOVE_KINDS.map(([id, l]) => `<button type="button" class="${m.kind === id ? 'on' : ''}" data-act="wmvKind" data-id="${id}" aria-pressed="${m.kind === id}">${l}</button>`).join('')}</div>
        <div class="ni-row"><span class="label">${m.kind === 'move' ? 'من' : 'المحفظة'}</span>${pick('wmvWallet', m.wallet)}</div>
        ${m.kind === 'move' ? `<div class="ni-row"><span class="label">لـ</span>${pick('wmvTo', m.to, m.wallet)}</div>` : `<div class="seg" role="group" aria-label="منين أو لفين">${vias.map(([id, l]) => `<button type="button" class="${m.via === id ? 'on' : ''}" data-act="wmvVia" data-id="${id}" aria-pressed="${m.via === id}">${l}</button>`).join('')}</div>`}
        <div class="grid2"><div class="field"><label for="wmv-amt">المبلغ</label><input id="wmv-amt" class="big-in num" data-input="wmv" data-k="amount" data-autofocus dir="ltr" inputmode="decimal" value="${esc(m.amount)}" autocomplete="off"></div>
          <div class="field"><label for="wmv-note">ملاحظة <span class="muted">(اختياري)</span></label><input id="wmv-note" class="big-in" data-input="wmv" data-k="note" value="${esc(m.note)}" placeholder="مثلًا: تحويل للبنك" autocomplete="off"></div></div>
        <div class="due-box"><div class="r"><span>رصيد ${esc(w.name)} بعدها</span><b class="num">${money(bal + delta)}</b></div>
          ${m.kind === 'move' && to ? `<div class="r"><span>رصيد ${esc(to.name)} بعدها</span><b class="num">${money(wBal(to) + (ok ? a : 0))}</b></div>` : `<div class="r"><span>الدرج</span><b>${signed(cash)}</b></div>`}</div>
        <div class="err-msg">${esc(m.err)}</div>
      </div>
      <div class="modal-f"><span class="sp"></span><button type="button" class="btn ghost" data-act="closeModal">قفل <kbd>Esc</kbd></button><button type="button" class="btn primary" data-act="wmvDo">${icon('check')} سجّل <kbd>Enter</kbd></button></div>
    </div>`;
  },
  enter: () => ACT.wmvDo(),
};

/* --- جرد المحفظة: الرصيد الحقيقي من تطبيق المحفظة قصاد اللي في السيستم، والفرق تسوية بسببها (المالك بس) --- */
const COUNT_WHY = ['رسوم الشبكة', 'عملية ماتسجّلتش', 'غلط في عملية', 'سبب تاني'];
function openWalletCount(wid) { const list = walShown(); if (!list.length) return; openModal({ type: 'walletCount', wallet: wid || list[0].id, real: '', why: '', note: '', err: '' }); }
MODALS.walletCount = {
  html(m) {
    const list = walShown(), w = walById(m.wallet), bal = wBal(w), real = parseNum(m.real), has = !isNaN(real) && String(m.real).trim() !== '', diff = has ? real - bal : 0;
    return `<div class="modal md" role="dialog" aria-label="جرد محفظة">
      ${modalHead('جرد محفظة', 'افتح تطبيق المحفظة واكتب الرصيد اللي فيه')}
      <div class="modal-b stack">
        <div class="wallets">${list.map((x) => `<button type="button" class="wallet ${m.wallet === x.id ? 'on' : ''}" data-act="wcWallet" data-id="${x.id}" aria-pressed="${m.wallet === x.id}"><span class="dot" style="background:${x.color}"></span><span class="t"><b>${esc(x.name)}</b><small class="num">${money(wBal(x))}</small></span></button>`).join('')}</div>
        <div class="grid2"><div class="due-box"><div class="r"><span>المفروض حسب السيستم</span><b class="num">${money(bal)}</b></div></div>
          <div class="field"><label for="wc-real">الرصيد الحقيقي</label><input id="wc-real" class="big-in num" data-input="wc" data-k="real" data-autofocus dir="ltr" inputmode="decimal" value="${esc(m.real)}" autocomplete="off"></div></div>
        ${has ? `<div class="change-box ${diff < 0 ? 'short' : ''}"><span>${diff === 0 ? 'مظبوط' : diff < 0 ? 'عجز' : 'زيادة'}</span><b class="num">${money(Math.abs(diff))}</b></div>` : ''}
        ${has && diff !== 0 ? `<div class="ni-row"><span class="label">السبب</span><div class="chips wrap">${COUNT_WHY.map((x) => `<button type="button" class="chip ${m.why === x ? 'on' : ''}" data-act="wcWhy" data-v="${x}" aria-pressed="${m.why === x}">${x}</button>`).join('')}</div></div>
          <div class="field"><label for="wc-note">ملاحظة <span class="muted">(اختياري)</span></label><input id="wc-note" data-input="wc" data-k="note" value="${esc(m.note)}" autocomplete="off"></div>` : ''}
        <div class="err-msg">${esc(m.err)}</div>
      </div>
      <div class="modal-f"><span class="muted">الفرق بيتسجّل «تسوية جرد» في السجل، والرصيد بيبقى زي الحقيقي</span><span class="sp"></span><button type="button" class="btn ghost" data-act="closeModal">قفل <kbd>Esc</kbd></button><button type="button" class="btn primary" data-act="wcDo">${icon('check')} سجّل الجرد <kbd>Enter</kbd></button></div>
    </div>`;
  },
  enter: () => ACT.wcDo(),
};

/* --- إلغاء عملية: المالك بس وبسبب، والعملية بتفضل في السجل متشطّبة (زي «التراجع» في القديم، من غير مسح) --- */
MODALS.walletVoid = {
  html(m) {
    const op = DATA.walletOps.find((o) => o.id === m.id), w = walById(op.wallet), [lbl] = W_TYPES[op.type];
    return `<div class="modal md" role="dialog" aria-label="إلغاء عملية">
      ${modalHead('إلغاء عملية', `${lbl} ${money(op.amount)} على ${esc(w ? w.name : '')}، ${opWhen(op.at)}`)}
      <div class="modal-b stack"><div class="note warn">${icon('triangle-alert')} الإلغاء بيرجّع أثرها على الرصيد${opCash(op) ? ' والدرج' : ''}، والعملية بتفضل ظاهرة في السجل متشطّبة ومعاها السبب.</div>
        <div class="field"><label for="wv-why">السبب</label><input id="wv-why" data-input="wv" value="${esc(m.why)}" data-autofocus placeholder="مثلًا: اتسجّلت مرتين" autocomplete="off"></div><div class="err-msg">${esc(m.err)}</div></div>
      <div class="modal-f"><span class="sp"></span><button type="button" class="btn ghost" data-act="closeModal">رجوع <kbd>Esc</kbd></button><button type="button" class="btn danger" data-act="wvDo">${icon('undo-2')} ألغي العملية <kbd>Enter</kbd></button></div>
    </div>`;
  },
  enter: () => ACT.wvDo(),
};

Object.assign(INPUT, {
  wmv: (el) => { Object.assign(S.modal, { [el.dataset.k]: el.value, err: '' }); render(); },
  wc: (el) => { Object.assign(S.modal, { [el.dataset.k]: el.value, err: '' }); render(); },
  wv: (el) => { Object.assign(S.modal, { why: el.value, err: '' }); render(); },
});
Object.assign(ACT, {
  walPick: (d) => { const W = walState(); W.w = W.w === d.id ? '' : d.id; W.all = false; render(); },
  walPeriod: (d) => { const W = walState(); W.p = d.id; W.all = false; render(); },
  walAll: () => { walState().all = true; render(); },
  walSettings: () => { S.view = 'settings'; S.settingsTab = 'pay'; render(); },
  walMove: () => openWalletMove(),
  walCount: () => openWalletCount(walState().w),
  walVoid: (d) => { if (!isOwner()) return; openModal({ type: 'walletVoid', id: d.id, why: '', err: '' }); },
  wmvKind: (d) => { const m = S.modal; m.kind = d.id; m.err = ''; if (m.kind === 'move' && m.to === m.wallet) m.to = (walShown().find((x) => x.id !== m.wallet) || {}).id; render(); },
  wmvWallet: (d) => { const m = S.modal; m.wallet = d.id; if (m.to === d.id) m.to = (walShown().find((x) => x.id !== d.id) || {}).id; m.err = ''; render(); },
  wmvTo: (d) => { S.modal.to = d.id; render(); },
  wmvVia: (d) => { S.modal.via = d.id; render(); },
  wmvDo: () => {
    const m = S.modal, w = walById(m.wallet), a = parseNum(m.amount);
    if (!(a > 0)) { m.err = 'اكتب المبلغ'; beep(); render(); return; }
    if (m.kind === 'move' && (!m.to || m.to === m.wallet)) { m.err = 'اختار المحفظة اللي هتحوّل لها'; beep(); render(); return; }
    if (m.kind !== 'topup' && a > wBal(w)) { m.err = `في ${w.name} ${money(wBal(w))} بس`; beep(); render(); return; }
    const op = { id: `w${DATA.walletOps.length + 1}`, at: new Date(), type: m.kind, wallet: w.id, amount: a, fee: 0, by: S.user.id, note: m.note.trim() };
    if (m.kind === 'move') op.to = m.to; else op.via = m.via;
    DATA.walletOps.push(op); refreshDash(); closeModal();
    toast(m.kind === 'move' ? `اتحوّل ${money(a)} من ${w.name} لـ${walById(op.to).name}` : `${m.kind === 'topup' ? 'اتشحنت' : 'اتفرّغت'} ${w.name} بـ ${money(a)}${op.via === 'drawer' ? (m.kind === 'topup' ? '، وخرجوا من الدرج' : '، ودخلوا الدرج') : ''}`);
  },
  wcWallet: (d) => { Object.assign(S.modal, { wallet: d.id, real: '', why: '', err: '' }); render(); },
  wcWhy: (d) => { S.modal.why = d.v; S.modal.err = ''; render(); },
  wcDo: () => {
    const m = S.modal, w = walById(m.wallet), real = parseNum(m.real);
    if (String(m.real).trim() === '' || isNaN(real) || real < 0) { m.err = 'اكتب الرصيد اللي في تطبيق المحفظة'; beep(); render(); return; }
    const diff = Math.round((real - wBal(w)) * 100) / 100;
    if (diff === 0) { closeModal(); toast(`${w.name} مظبوطة: ${money(real)}`); return; }
    if (!m.why) { m.err = 'اختار سبب الفرق'; beep(); render(); return; }
    DATA.walletOps.push({ id: `w${DATA.walletOps.length + 1}`, at: new Date(), type: 'adjust', wallet: w.id, amount: diff, fee: 0, by: S.user.id, note: `جرد: ${m.why}${m.note.trim() ? `، ${m.note.trim()}` : ''}` });
    refreshDash(); closeModal(); toast(`اتسجّل الجرد: ${diff < 0 ? 'عجز' : 'زيادة'} ${money(Math.abs(diff))}، و${w.name} بقت ${money(real)}`, 'info');
  },
  wvDo: () => {
    const m = S.modal, op = DATA.walletOps.find((o) => o.id === m.id);
    if (!m.why.trim()) { m.err = 'اكتب سبب الإلغاء'; beep(); render(); return; }
    op.void = { by: S.user.id, at: new Date(), reason: m.why.trim() }; refreshDash(); closeModal(); toast('اتلغت العملية، وفضلت في السجل متشطّبة', 'info');
  },
});

/* --- الإعدادات ← المحافظ والدفع: إدارة المحافظ (زي السيستم القديم: الترتيب، والرصيد الافتتاحي، وحد التنبيه) --- */
const W_PRESETS = [['فودافون كاش', '#e60000'], ['اتصالات كاش', '#719e19'], ['أورنج كاش', '#ff7900'], ['وي باي', '#5c2d91'], ['إنستاباي', '#3b2a85'], ['حساب بنك', '#1d4f91'], ['محفظة تانية', '#59616b']];
const W_PAY = [['', 'لأ'], ['vf', 'فودافون كاش'], ['instapay', 'إنستاباي']];
function walletsManageHTML() {
  const f = (w, k, label, attrs = '', hint = '') => `<div class="field"><label for="wm-${k}-${w.id}">${label}</label><input id="wm-${k}-${w.id}" data-change="wmField" data-id="${w.id}" data-k="${k}" value="${esc(w[k] || (k === 'number' ? '' : ''))}" ${attrs} autocomplete="off">${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
  const num0 = 'class="num" dir="ltr" inputmode="numeric" placeholder="0"';
  return `<div class="card"><h3>محافظ المحل</h3>
    <div class="muted" style="font-size:.85rem;margin-bottom:10px">زي السيستم القديم: الترتيب، والرصيد الافتتاحي، وحد التنبيه. بعد كده الرصيد بيتحسب لوحده من العمليات وفلوس البيع.</div>
    ${DATA.wallets.length ? DATA.wallets.map((w, i) => { const used = DATA.walletOps.some((o) => o.wallet === w.id || o.to === w.id); return `<div class="wm-item ${w.hidden ? 'off' : ''}">
      <div class="wm-h"><input type="color" class="wm-color" value="${w.color}" data-change="wmColor" data-id="${w.id}" aria-label="لون «${esc(w.name)}»">
        <input class="cat-name" data-change="wmField" data-id="${w.id}" data-k="name" value="${esc(w.name)}" aria-label="اسم المحفظة" autocomplete="off">
        <span class="muted num">الرصيد دلوقتي ${money(wBal(w))}</span>
        <button type="button" class="icon-btn sm" data-act="wmMove" data-id="${w.id}" data-d="-1" title="لفوق" ${i === 0 ? 'disabled' : ''}>${icon('arrow-up')}</button>
        <button type="button" class="icon-btn sm" data-act="wmMove" data-id="${w.id}" data-d="1" title="لتحت" ${i === DATA.wallets.length - 1 ? 'disabled' : ''}>${icon('arrow-down')}</button>
        <label class="switch" title="تظهر في المحافظ والبيع"><input type="checkbox" data-change="wmShow" data-id="${w.id}" ${w.hidden ? '' : 'checked'} aria-label="تظهر"><span></span></label>
        ${used ? '<span class="cat-del-sp"></span>' : `<button type="button" class="icon-btn sm danger" data-act="wmDel" data-id="${w.id}" title="امسح المحفظة">${icon('trash-2')}</button>`}</div>
      <div class="wm-g">${f(w, 'number', 'رقم محفظة المحل', 'class="mono" dir="ltr" placeholder="01xxxxxxxxx"', 'بيظهر للعميل في السحب')}
        ${f(w, 'opening', 'الرصيد الافتتاحي', num0, `يوم ${fmtDate(DATA.walletSince)}`)}${f(w, 'min', 'نبّهني لما تقل عن', num0)}${f(w, 'max', 'أقصى رصيد', num0, 'قبله بـ 10% تنبيه، و0 يعني من غير حد')}${f(w, 'limitDay', 'الحد اليومي', num0, 'للتحويلات، و0 يعني من غير حد')}
        <div class="field"><label for="wm-pay-${w.id}">فلوس البيع بتنزل فيها؟</label><select id="wm-pay-${w.id}" data-change="wmPay" data-id="${w.id}">${W_PAY.map(([v, l]) => `<option value="${v}" ${(w.pay || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
    </div>`; }).join('') : '<div class="muted">لسه مفيش محافظ. ضيف أول واحدة من تحت.</div>'}
    <div class="wm-add"><span class="label">ضيف محفظة</span><div class="chips wrap">${W_PRESETS.map(([n, c]) => `<button type="button" class="chip" data-act="wmAdd" data-v="${esc(n)}" data-c="${c}">${icon('plus')} ${n}</button>`).join('')}</div></div>
  </div>`;
}
const WM_NUM = ['opening', 'min', 'max', 'limitDay'];
CHANGE.wmField = (el) => {
  const w = walById(el.dataset.id), k = el.dataset.k, v = el.value.trim();
  if (!w) return;
  if (WM_NUM.includes(k)) { const n = v === '' ? 0 : parseNum(v); if (isNaN(n) || n < 0) { toast('الخانة دي رقم بس', 'err'); beep(); render(); return; } w[k] = n; }
  else if (k === 'name') { if (!v) { toast('اسم المحفظة مايبقاش فاضي', 'err'); render(); return; } w.name = v; } else w[k] = toLatin(v);
  refreshDash(); render();
  if (k === 'opening') toast(`رصيد ${w.name} بقى ${money(wBal(w))}`, 'info');
};
CHANGE.wmColor = (el) => { const w = walById(el.dataset.id); if (w) { w.color = el.value; render(); } };
CHANGE.wmShow = (el) => { const w = walById(el.dataset.id); if (w) { w.hidden = !el.checked; render(); } };
CHANGE.wmPay = (el) => {
  const w = walById(el.dataset.id); if (!w) return;
  // طريقة الدفع الواحدة بتنزل في محفظة واحدة بس
  if (el.value) DATA.wallets.forEach((x) => { if (x !== w && x.pay === el.value) x.pay = null; });
  w.pay = el.value || null; refreshDash(); render();
};
Object.assign(ACT, {
  wmMove: (d) => { const L = DATA.wallets, i = L.findIndex((w) => w.id === d.id), j = i + +d.d; if (i < 0 || !L[j]) return; [L[i], L[j]] = [L[j], L[i]]; render(); },
  wmDel: (d) => { const w = walById(d.id); if (!w || DATA.walletOps.some((o) => o.wallet === w.id || o.to === w.id)) return; DATA.wallets.splice(DATA.wallets.indexOf(w), 1); render(); toast(`اتمسحت «${w.name}»`, 'info'); },
  wmAdd: (d) => {
    let name = d.v, k = 2;
    while (DATA.wallets.some((w) => w.name === name)) name = `${d.v} ${num(k++)}`;
    DATA.wallets.push({ id: `wl${Date.now().toString(36)}`, name, number: '', color: d.c, opening: 0, min: 0, max: 0, limitDay: 0, pay: null, hidden: false, custom: true });
    render(); toast(`اتضافت «${name}». اكتب رقمها والرصيد اللي فيها`);
    const el = document.getElementById(`wm-number-${DATA.wallets[DATA.wallets.length - 1].id}`); if (el) el.focus();
  },
});
