'use strict';
// شاشة «النواقص». الكود متقسم ملف لكل شاشة — الترتيب في index.html، والدليل: docs/ENGINEERING.md
/* ===== النواقص: اللي بتكتبه بإيدك + اقتراحات السيستم (docs/ui/SALES-SHORTAGES.md) =====
   بتتحفظ في المتصفح زي الإعدادات. أول مرة: 3 أمثلة. نفس الصنف مرتين ← الكمية بتزيد بدل سطر جديد. */
const SHORT_KEY = 'mshop.mockup.shortages.v1';
let SHORT = (() => {
  try { const v = JSON.parse(localStorage.getItem(SHORT_KEY) || 'null'); if (Array.isArray(v)) return v; } catch { /* أول مرة */ }
  const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  return [
    { id: 'sh1', pid: null, name: 'جراب Samsung A16 أسود', qty: 3, note: 'اتسأل عليه مرتين النهارده', cust: null, status: 'open', by: 'u2', at: ago(3) },
    { id: 'sh2', pid: 'a7', name: 'كابل لايتنينج للآيفون', qty: 10, note: '', cust: null, status: 'ordered', by: 'u1', at: ago(26) },
    { id: 'sh3', pid: null, name: 'شاحن 65 وات تايب سي', qty: 1, note: '', cust: { name: 'كريم مصطفى', phone: '01011122233' }, status: 'open', by: 'u3', at: ago(50) },
  ];
})();
const saveShort = () => { try { localStorage.setItem(SHORT_KEY, JSON.stringify(SHORT)); } catch { toast('مساحة التخزين مش كفاية', 'err'); } };
// الكمية المقترحة: توصّل الصنف لضعف أقل حد
const suggestQty = (p) => Math.max(1, p.min * 2 - stockOf(p));
const shortSuggest = () => DATA.products.filter((p) => stockOf(p) <= p.min && !SHORT.some((x) => x.pid === p.id)).sort((a, b) => stockOf(a) - stockOf(b));
function shortAdd({ pid = null, name = '', qty = 1, note = '', cust = null }) {
  const p = pid ? prod(pid) : null, nm = p ? p.name : String(name).trim();
  if (!nm) return false;
  const ex = SHORT.find((x) => (p && x.pid === p.id) || (!p && !x.pid && normalize(x.name) === normalize(nm)));
  if (ex) { ex.qty += qty; saveShort(); toast(`«${nm}» موجود في النواقص، والكمية بقت ${num(ex.qty)}`, 'info'); return true; }
  SHORT.unshift({ id: `sh${Date.now()}${Math.floor(Math.random() * 1000)}`, pid: p ? p.id : null, name: nm, qty, note: note.trim(), cust, status: 'open', by: S.user.id, at: new Date().toISOString() });
  saveShort(); toast(`اتضاف «${nm}» للنواقص`); return true;
}
const shortForm = () => S.shortF || (S.shortF = { q: '', pid: null, qty: '1', note: '', cust: '', hi: 0, err: '' });
function shortMatches() { const F = shortForm(), q = normalize(F.q); return q && !F.pid ? DATA.products.filter((p) => p._hay.includes(q)).slice(0, 6) : []; }
const whenTxt = (iso) => { const d = new Date(iso); return sameDay(d, new Date()) ? `النهارده ${fmtTime(d)}` : sameDay(d, addDays(dayStart(new Date()), -1)) ? `امبارح ${fmtTime(d)}` : fmtDate(d); };
function shortView() {
  const F = shortForm(), sug = shortSuggest(), m = shortMatches(), own = isOwner(), picked = F.pid ? prod(F.pid) : null;
  const stockTxt = (p) => `<small class="${stockOf(p) <= 0 ? 'danger-t' : stockOf(p) <= p.min ? 'warn-t' : 'muted'}">${stockOf(p) <= 0 ? 'خلصان' : `متاح ${num(stockOf(p))}`}</small>`;
  return `
    <section class="sh-add" aria-label="ضيف ناقص">
      <div class="sh-name">
        <label class="inline-search">${icon('package-search')}<input id="sh-q" data-input="shQ" value="${esc(F.q)}" placeholder="اسم الصنف، أو اختار من المخزن" autocomplete="off" aria-label="اسم الصنف الناقص"></label>
        ${m.length ? `<div class="results sh-res">${m.map((p, i) => `<div class="result ${i === F.hi ? 'on' : ''}" data-act="shPick" data-id="${p.id}"><div class="t"><div class="n"><bdi dir="rtl">${esc(p.name)}</bdi></div><div class="s"><span>${esc(catFull(p.cat))}</span>${stockTxt(p)}</div></div></div>`).join('')}</div>` : ''}
      </div>
      <label class="sh-f sh-qty"><span>الكمية</span><input id="sh-qty" data-input="shQty" value="${esc(F.qty)}" inputmode="numeric" autocomplete="off"></label>
      <label class="sh-f"><span>ملاحظة</span><input id="sh-note" data-input="shNote" value="${esc(F.note)}" placeholder="اختياري" autocomplete="off"></label>
      <label class="sh-f"><span>عميل مستني</span><input id="sh-cust" data-input="shCust" value="${esc(F.cust)}" placeholder="اسم أو رقم، اختياري" autocomplete="off"></label>
      <button type="button" class="btn primary" data-act="shAdd">${icon('plus')} ضيف للنواقص</button>
    </section>
    ${picked ? `<div class="sh-picked">${icon('package')} من المخزن: <b><bdi dir="rtl">${esc(picked.name)}</bdi></b> ${stockTxt(picked)}<button type="button" class="icon-btn xs" data-act="shUnpick" title="اكتب اسم تاني">${icon('x')}</button></div>` : ''}
    ${F.err ? `<div class="err-msg">${esc(F.err)}</div>` : ''}
    <h3 class="sh-h">النواقص <span class="muted num">${num(SHORT.length)}</span></h3>
    ${SHORT.length ? `<div class="table-wrap"><table class="t sh-t"><thead><tr><th>الصنف</th><th class="ta-n">الكمية</th><th>ملاحظة</th><th>عميل مستني</th><th>أضافه</th><th>الحالة</th><th></th></tr></thead><tbody>
      ${SHORT.map((x) => { const p = x.pid ? prod(x.pid) : null, u = DATA.users.find((y) => y.id === x.by), mine = own || x.by === S.user.id;
        return `<tr data-id="${x.id}"><td><bdi dir="rtl">${esc(x.name)}</bdi> ${p ? stockTxt(p) : '<small class="muted">مش في المخزن</small>'}</td><td class="ta-n num"><b>${num(x.qty)}</b></td><td class="muted">${esc(x.note)}</td>
          <td>${x.cust ? `${esc(x.cust.name || '')}${x.cust.phone ? ` <bdi dir="ltr" class="mono">${esc(x.cust.phone)}</bdi>` : ''}` : ''}</td><td class="muted">${u ? esc(u.name) : ''}، ${whenTxt(x.at)}</td>
          <td><div class="seg sh-st"><button type="button" class="${x.status === 'open' ? 'on' : ''}" data-act="shStatus" data-id="${x.id}" data-s="open" aria-pressed="${x.status === 'open'}">ناقص</button><button type="button" class="${x.status === 'ordered' ? 'on' : ''}" data-act="shStatus" data-id="${x.id}" data-s="ordered" aria-pressed="${x.status === 'ordered'}">اتطلب</button></div></td>
          <td class="sh-act"><button type="button" class="btn sm" data-act="shDone" data-id="${x.id}">${icon('check')} وصل</button>${mine ? `<button type="button" class="icon-btn sm danger" data-act="shDel" data-id="${x.id}" title="شيله من النواقص">${icon('trash-2')}</button>` : ''}</td></tr>`; }).join('')}
    </tbody></table></div>` : `<div class="sv-empty">${icon('clipboard-list')}<b>مفيش نواقص مكتوبة</b><span>ضيف من فوق، أو من الاقتراحات تحت، أو من البحث في شاشة البيع.</span></div>`}
    <div class="sh-hrow"><h3 class="sh-h">اقتراحات السيستم <span class="muted">الأصناف اللي وصلت لأقل حد أو خلصت</span></h3>${sug.length > 1 ? `<button type="button" class="btn sm" data-act="shSugAll">${icon('plus')} ضيف الكل (${num(sug.length)})</button>` : ''}</div>
    ${sug.length ? `<div class="table-wrap"><table class="t sh-t"><thead><tr><th>الصنف</th><th>التصنيف</th><th class="ta-n">المتاح</th><th class="ta-n">أقل حد</th><th class="ta-n">الكمية المقترحة</th><th></th></tr></thead><tbody>
      ${sug.map((p) => `<tr data-pid="${p.id}"><td><bdi dir="rtl">${esc(p.name)}</bdi></td><td class="muted">${esc(catFull(p.cat))}</td><td class="ta-n num ${stockOf(p) <= 0 ? 'danger-t' : 'warn-t'}">${stockOf(p) <= 0 ? 'خلصان' : num(stockOf(p))}</td><td class="ta-n num">${num(p.min)}</td><td class="ta-n num">${num(suggestQty(p))}</td><td class="sh-act"><button type="button" class="btn sm" data-act="shSug" data-id="${p.id}">${icon('plus')} ضيفه للنواقص</button></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="muted sh-none">كل الأصناف فوق أقل حد.</div>'}`;
}
function shAddNow() {
  const F = shortForm(), qty = parseInt(toLatin(F.qty), 10);
  if (!F.pid && !F.q.trim()) { F.err = 'اكتب اسم الصنف أو اختاره من المخزن'; render(); return; }
  if (!qty || qty < 1) { F.err = 'الكمية لازم تبقى رقم 1 أو أكتر'; render(); return; }
  const c = F.cust.trim(), digits = toLatin(c).replace(/\D/g, '');
  const cust = c ? (digits.length >= 8 ? { name: c.replace(/[\d\s+]+/g, ' ').trim(), phone: digits } : { name: c, phone: '' }) : null;
  if (shortAdd({ pid: F.pid, name: F.q, qty, note: F.note, cust })) { S.shortF = null; render(); }
}
Object.assign(ACT, {
  // تبويب المخزن (الأصناف / النواقص) — اسم مختلف عن invTab بتاع تبويبات الفواتير في شاشة البيع
  invView: (d) => { S.inv.tab = d.id === 'short' ? 'short' : 'items'; render(); },
  shPick: (d) => { const F = shortForm(), p = prod(d.id); if (p) { Object.assign(F, { pid: p.id, q: p.name, hi: 0, err: '' }); if (F.qty === '1') F.qty = String(suggestQty(p)); render(); } },
  shUnpick: () => { Object.assign(shortForm(), { pid: null, q: '', qty: '1' }); render(); },
  shAdd: () => shAddNow(),
  shStatus: (d) => { const x = SHORT.find((y) => y.id === d.id); if (x) { x.status = d.s === 'ordered' ? 'ordered' : 'open'; saveShort(); render(); } },
  shDone: (d) => { const i = SHORT.findIndex((y) => y.id === d.id); if (i >= 0) { const [x] = SHORT.splice(i, 1); saveShort(); render(); toast(`«${x.name}» وصل واتشال من النواقص`); } },
  shDel: (d) => { const i = SHORT.findIndex((y) => y.id === d.id); if (i >= 0) { const [x] = SHORT.splice(i, 1); saveShort(); render(); toast(`اتشال «${x.name}» من النواقص`, 'info'); } },
  shSug: (d) => { const p = prod(d.id); if (p && shortAdd({ pid: p.id, qty: suggestQty(p) })) render(); },
  shSugAll: () => { const list = shortSuggest(); for (const p of list) SHORT.unshift({ id: `sh${Date.now()}${p.id}`, pid: p.id, name: p.name, qty: suggestQty(p), note: '', cust: null, status: 'open', by: S.user.id, at: new Date().toISOString() }); saveShort(); render(); toast(`اتضاف ${num(list.length)} صنف للنواقص`); },
  // من شاشة البيع: البحث ما لقاش الصنف، أو الصنف خلصان
  shortQuick: (d) => { if (shortAdd({ pid: d.id || null, name: d.name || '' })) render(); },
});
INPUT.shQ = (el) => { Object.assign(shortForm(), { q: el.value, pid: null, hi: 0, err: '' }); render(); };
INPUT.shQty = (el) => { const F = shortForm(); F.qty = el.value; if (F.err) { F.err = ''; render(); } };
INPUT.shNote = (el) => { shortForm().note = el.value; };
INPUT.shCust = (el) => { shortForm().cust = el.value; };
document.addEventListener('keydown', (e) => {
  const id = e.target && e.target.id;
  if (!id || !id.startsWith('sh-') || S.view !== 'inventory') return;
  const F = shortForm(), m = shortMatches();
  if (id === 'sh-q' && m.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); F.hi = (F.hi + (e.key === 'ArrowDown' ? 1 : m.length - 1)) % m.length; render(); return; }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (id === 'sh-q' && m.length) ACT.shPick({ id: m[F.hi].id }); else shAddNow();
});
