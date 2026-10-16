// ═══════════════════════════════════════════════════════════
// helpers.js — تم توليده تلقائيًا أثناء إعادة التنظيم (Phase 1 Refactor)
// كل الدوال هنا منقولة حرفيًا بدون أي تغيير في المنطق أو السلوك
// ═══════════════════════════════════════════════════════════

// ── أدوات عامة أساسية (DOM / تنسيق / تاريخ) — منقولة من app.js ──
const $=id=>document.getElementById(id), g=id=>$(id)?.value?.trim()||'';
const n=v=>parseFloat(v)||0, fmt=v=>n(v).toLocaleString('ar-EG');
const clr=(...ids)=>ids.forEach(id=>{if($(id))$(id).value='';});
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const ts=()=>new Date().toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit'});
const td=()=>new Date().toISOString().split('T')[0];
const DK=(d=sel)=>'mshop_d_'+d; // ملاحظة: يعتمد على المتغير العام sel المُعرَّف في app.js — آمن لأنه يُقرأ فقط عند الاستدعاء الفعلي، بعد تحميل كل الملفات

function showToast(msg,type='info'){
  const d=document.createElement('div');
  const bg=type==='ok'?'#052e16':type==='err'?'#450a0a':'#1e293b';
  const col=type==='ok'?'#4ade80':type==='err'?'#f87171':'#94a3b8';
  d.style.cssText=`position:fixed;top:16px;left:50%;transform:translateX(-50%);background:${bg};color:${col};padding:9px 18px;border-radius:9px;font-size:12px;z-index:9997;border:1px solid ${col}40;font-weight:600;white-space:nowrap`;
  d.textContent=msg;document.body.appendChild(d);setTimeout(()=>d.remove(),3000);
}

function debounce(fn, ms) {
  let t;
  return function(...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms || 300); };
}

function updateCarouselArrows() {
  const el = document.getElementById('dash-carousel');
  const rArr = document.querySelector('.dc-arr-r');
  const lArr = document.querySelector('.dc-arr-l');
  if (!el || !rArr || !lArr) return;
  const maxScroll = el.scrollWidth - el.clientWidth;
  const scrollPos = Math.abs(el.scrollLeft);
  const atStart = scrollPos < 5;          // at rightmost (RTL start)
  const atEnd   = scrollPos > maxScroll - 5; // at leftmost (RTL end)
  rArr.style.opacity = atEnd   ? '0' : '1';
  rArr.style.pointerEvents = atEnd ? 'none' : '';
  lArr.style.opacity = atStart ? '0' : '1';
  lArr.style.pointerEvents = atStart ? 'none' : '';
}

function scrollDash(dir) {
  const el = document.getElementById('dash-carousel');
  if (!el) return;
  el.scrollBy({left: dir * -160, behavior:'smooth'});
  setTimeout(updateCarouselArrows, 350);
}
