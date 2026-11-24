// ═══════════════════════════════════════════════════════════
// app.js — الحالة العامة والتشغيل (INIT) — تم توليده تلقائيًا أثناء إعادة التنظيم (Phase 1 Refactor)
// كل الدوال هنا منقولة حرفيًا بدون أي تغيير في المنطق أو السلوك
// ═══════════════════════════════════════════════════════════


// ══[1] CONSTANTS & STATE ══════════════════════════════════
const TODAY=new Date().toISOString().split('T')[0];
const DEFAULT_CATS=['سكرين','جراب','وصلات','شواحن','سماعات','ايربودز','سماعات طوق','هيدفون','صبات','بوربنك','كونفرتات','كروت وفلاشات','كمبيوتر','ساعات','أخري'];
const LOGOS_LIST=['📲','📱','🔧','🛠️','💻','🖥️','🏪','⚡','💎','🎯','📟','🌟'];
const SVC_C={'فودافون كاش':'#ef4444','اتصالات كاش':'#3b82f6','اورانج كاش':'#f97316','وي كاش':'#a78bfa','انستا باي':'#10b981','أخري':'#64748b'};
const DEFAULT_WALLETS=['فودافون كاش','اتصالات كاش','اورانج كاش','وي كاش','انستا باي','أخري'];
let walletOrder=[],walletLimits={},walletOpening={};
const DAYS_AR=['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const NOTE_TYPE_LABELS={note:'📝 عادية',reminder:'⏰ تذكير',conditional:'⚡ شرطية'};
const NOTE_TYPE_COLORS={note:'#06b6d4',reminder:'#f59e0b',conditional:'#a78bfa'};
const PRI_ICONS={3:'🔴',2:'🔵',1:'⚪'};
const DEVICE_TYPES=['موبايل','تابلت','لاب توب','ساعة ذكية','إيربودز','أخري'];
const DEFAULT_FAULT_TYPES=[{id:'ft_default_1',name:'كسر شاشة',hidden:false},{id:'ft_default_2',name:'شاشة لا تعمل',hidden:false},{id:'ft_default_3',name:'بطارية ضعيفة',hidden:false},{id:'ft_default_4',name:'مشكلة شاحن',hidden:false},{id:'ft_default_5',name:'ميكروفون',hidden:false},{id:'ft_default_6',name:'سماعة',hidden:false},{id:'ft_default_7',name:'كاميرا',hidden:false},{id:'ft_default_8',name:'مفاتيح',hidden:false},{id:'ft_default_9',name:'مشكلة برمجة',hidden:false},{id:'ft_default_10',name:'مشكلة شبكة',hidden:false},{id:'ft_default_11',name:'أخري',hidden:false}];
const REPAIR_STATUS={inProgress:{lbl:'جاري الإصلاح',color:'#f59e0b',icon:'🔧'},done:{lbl:'تم الإصلاح',color:'#3b82f6',icon:'✅'},delivered:{lbl:'تم التسليم',color:'#4ade80',icon:'📦'},cancelled:{lbl:'ملغي',color:'#ef4444',icon:'❌'}};

let sel=TODAY,ctab='acc',selSvcVal='فودافون كاش',selCashType='ايداع';
let showProfits=false,adminUnlocked=false,pendingAdminCb=null,adminLockTimer=null;
let selMonth=new Date().toISOString().slice(0,7);
let actCat=null,addSubMode=false;
let calcHistVis=false,calcVis=false;
let noteFilter='all',notifFilter='all',noteTypeAdding='note',editingNoteId=null;
let currentNotifPopup=null;
let editingRepairId=null,sellingPhoneId=null,stockingPhoneId=null,detailPhoneId=null,editingPhoneId=null;
let CS={expr:'',cur:'0',op:null,prev:null,nn:true};

let data={acc:[],used:[],cash:[],sw:[],exp:[],phones:[],repairs:[]};
let catA=[],catU=[],catE=[],accCats=[...DEFAULT_CATS];
let notes=[],notifs=[],calcHist=[],trash=[],inventory=[],repairParts=[],faultTypes=[...DEFAULT_FAULT_TYPES];
let cfg={name:'محل الموبايلات',logo:'📲',logoImg:null,passMain:'1234',passAdmin:'5678',adminTimeout:1,googleClientId:''};

let _lastRender = null; // track which screen to refresh after unlock


// ── موحّد: أي قيمة مالية محمية (إجماليات، مؤشرات) تتبع نفس آلية إظهار الأرباح ──



// ══[2] STORAGE & MIGRATION ════════════════════════════════



let _st;














// ══[3] AUTH & AUTO-LOCK ═══════════════════════════════════
const SCREENS=['S-lock','S-main','S-monthly','S-analytics','S-notes','S-notifications','S-search','S-settings','S-repairs'];
















// AUTO-LOCK PROFITS


// ══[4] SETTINGS ═══════════════════════════════════════════










// ══[5] DYNAMIC CATEGORIES ════════════════════════════════


















// ══[6] DATE NAVIGATION ════════════════════════════════════







// ══[7] TOTALS & SUMMARY (SINGLE CLEAN FUNCTION) ══════════



// ══[8] TABS ════════════════════════════════════════════════
const TC={acc:{icon:'🎧',lbl:'إكسسوار',color:'#3b82f6'},used:{icon:'📱',lbl:'مستعمل',color:'#8b5cf6'},cash:{icon:'💳',lbl:'الكاش',color:'#ef4444'},sw:{icon:'⚙️',lbl:'سوفت وير',color:'#10b981'},exp:{icon:'💸',lbl:'مصاريف',color:'#f59e0b'},phones:{icon:'📦',lbl:'هواتف',color:'#06b6d4'},repairs:{icon:'🔧',lbl:'صيانة',color:'#f97316'}};



// ══[9] ACC CATEGORIES UI ══════════════════════════════════






// ══[10] CASH SELECTORS ════════════════════════════════════



// ══[11] ADD / SOFT-DEL ════════════════════════════════════












// ══ WALLETS (المحافظ الإلكترونية) ═══════════════════════════











// ══[12] LIST RENDERING ════════════════════════════════════





// ══[13] NOTES (UNIFIED) ═══════════════════════════════════









// ══[14] NOTIFICATIONS ═════════════════════════════════════








// ══[15] CALCULATOR ════════════════════════════════════════








// ══[16] MONTHLY ════════════════════════════════════════════














// ══[17] ANALYTICS ═════════════════════════════════════════






// ══[18] NLP SEARCH ════════════════════════════════════════





// ══[19] GOOGLE DRIVE (GAS) ════════════════════════════════
// NOTE (Phase 3): the GAS endpoint lives ONLY in js/app_config.js (APP_CONFIG).
// Do NOT define any endpoint literal here — see docs/SECURITY_CONFIGURATION_PROPOSAL.md









// ══[20] EXPORT/IMPORT ════════════════════════════════════





// ══[21] INVENTORY (PHONES) ════════════════════════════════

// [تنظيف] تم حذف نسخة قديمة مكررة من getMovement هنا — النسخة الفعّالة معرّفة لاحقًا في قسم "Movement with stagnant"




// [تنظيف] تم حذف نسخ قديمة مكررة من renderPhonesList و renderPhones و openAddPhone هنا
// النسخ الفعّالة معرّفة لاحقًا: renderPhonesList "final override"، renderPhones "override"، openAddPhone "UPDATED"


// [تنظيف] تم حذف نسخة قديمة مكررة من savePhone هنا — النسخة الفعّالة هي savePhoneNew (يستدعيها savePhone لاحقًا)









// [تنظيف] تم حذف نسخة قديمة مكررة من renderPhoneDetail هنا — النسخة الفعّالة هي renderPhoneDetailFull (يستدعيها renderPhoneDetail لاحقًا)





// ══[22] REPAIRS (صيانة) ═══════════════════════════════════
let repairCounter=0;






// ══ REPAIR AUTOCOMPLETE ════════════════════════════════════════









// Global repairs list

// [تنظيف] تم حذف نسخة قديمة مكررة من renderRepairPanel هنا (كانت تعتمد على status نصي بدل fixed/delivered/paid)
// النسخة الفعّالة معرّفة لاحقًا في قسم "renderRepairPanel (final override)"









// ══[23] KEYBOARD & AUTOSAVE ════════════════════════════════
document.addEventListener('keydown',e=>{
  if(e.key!=='Enter'||e.target.tagName!=='INPUT'||['date','time','month'].includes(e.target.type))return;
  if($('S-lock')?.style.display!=='none')tryUnlock();
  else if($('modal-admin')?.style.display==='flex')confirmAdmin();
  else if($('S-main')?.style.display==='block')({acc:addAcc,used:addUsed,cash:addCash,sw:addSw,exp:addExp})[ctab]?.();
});
document.addEventListener('visibilitychange',()=>{if(document.hidden)save();});
window.addEventListener('beforeunload',save);
setInterval(checkReminders,60000);
setInterval(checkRepairNotifications,120000);

// ══[24] INIT ═══════════════════════════════════════════════
(async () => {
try{migrate();}catch(e){}
try{loadAll();}catch(e){}
try{loadData();}catch(e){}
try{await faultTypeRepo.initCache();}catch(e){}
try{applyId();}catch(e){}
try{updateDateUI();}catch(e){}
try{renderAll();}catch(e){console.error('renderAll',e);}
try{rAccCats();rCatQ('used');rExpQ();populateCatSelect();}catch(e){}
try{setCashType('ايداع',$('ct-dep'));}catch(e){}
try{const firstSvc=document.querySelector('.svc-btn');if(firstSvc)selSvc(firstSvc);}catch(e){}
try{ST('acc');}catch(e){}
try{updateBadges();}catch(e){}
try{renderInvWidget();}catch(e){}
try{checkReminders();}catch(e){}
try{checkInvNotifications();}catch(e){}
try{checkRepairNotifications();}catch(e){}
showScreen('S-lock');setTimeout(()=>{try{$('pin-inp').focus();}catch(e){}},200);
})();


window.onerror=function(msg,src,line,col,err){
  var el=document.getElementById('pin-err');
  if(el&&el.textContent==='')el.textContent='خطأ تقني: '+String(msg).slice(0,80);
  return false;
};

// ══ PHONES SUB-TABS ═══════════════════════════════════════════
let phonesTab = 'inv';

// [تنظيف] تم حذف نسخة قديمة مكررة من renderPhones هنا — النسخة الفعّالة هي "renderPhones override" لاحقًا (تضيف renderQuickKPI وrenderBrandFilterBar)

// ── Movement with "stagnant" ──────────────────────────────────


// ── Archive instead of delete ─────────────────────────────────



// renderPhonesList — final version defined below in new phones section

// ── Sales sub-tab ─────────────────────────────────────────────
const revealedSales = new Set(); // per-item profit reveal





// ── Analytics sub-tab ─────────────────────────────────────────




// [تنظيف] تم حذف نسخة قديمة مكررة من renderPhonesShortage هنا (كانت تعرض qty<=2)
// النسخة الفعّالة renderPhonesShortageFixed تعرض فقط qty===0 (النواقص الكاملة)، ويستدعيها renderPhonesShortage لاحقًا

// ── Reorder sub-tab ───────────────────────────────────────────


// ── Suppliers sub-tab ─────────────────────────────────────────


// ══ JARD (QUICK INVENTORY AUDIT) ══════════════════════════════






// ══ PHONE EVENT LOG ═══════════════════════════════════════════


// ══ FAVORITE TOGGLE ═══════════════════════════════════════════


// ══ QUICK KPI BAR ════════════════════════════════════════════


// ══ BRAND FILTER BAR ════════════════════════════════════════
let currentBrandFilter = '';


// ══ HIERARCHICAL INVENTORY VIEW ══════════════════════════════
// All brands collapsed by default; open state tracked per session
let collapsedBrands = null; // null = uninitialized → collapse all





// ══ NEW renderPhonesList (final override) ════════════════════




// ══ renderPhones override ════════════════════════════════════


// ══ FULL renderPhoneDetail with price history avg + timeline ═


// Hook renderPhoneDetail to call new version


// ══ DEBOUNCE UTILITY ══════════════════════════════════════════


// Apply debounce to all search-triggered renders
(function applyDebounce() {
  // Debounce phone search specifically
  const phSearch = document.getElementById('ph-search');
  if (phSearch) {
    const _dSearch = debounce(renderPhonesList, 320);
    phSearch.oninput = _dSearch;
  }
  const phFilter = document.getElementById('ph-filter');
  if (phFilter) phFilter.onchange = renderPhonesList;

  // Phone sales search
  const phSalesSearch = document.getElementById('ph-sales-search');
  if (phSalesSearch) phSalesSearch.oninput = debounce(renderPhonesSales, 320);
  const phSalesFilter = document.getElementById('ph-sales-filter');
  if (phSalesFilter) phSalesFilter.onchange = renderPhonesSales;

  // Jard search
  const jardSearch = document.getElementById('jard-search');
  if (jardSearch) jardSearch.oninput = debounce(renderJard, 300);

  // Repairs search (full list, can grow large)
  const repSearch = document.getElementById('rep-search');
  if (repSearch) repSearch.oninput = debounce(renderRepairList, 300);

  // Notes search
  const notesSearch = document.getElementById('notes-search');
  if (notesSearch) notesSearch.oninput = debounce(renderNotes, 300);

  // Monthly/global search across sections
  const monthSearch = document.getElementById('msearch-inp');
  if (monthSearch) monthSearch.oninput = debounce(doMonthSearch, 350);

  // NLP smart search
  const nlpInp = document.getElementById('nlp-inp');
  if (nlpInp) nlpInp.oninput = debounce(doNLPSearch, 400);
})();

// ══ POINTER-EVENTS FIX — hidden modals ════════════════════════
// Ensure all display:none modals don't capture events
(function fixModalPointerEvents() {
  document.querySelectorAll('.modal-bg').forEach(m => {
    const observer = new MutationObserver(() => {
      m.style.pointerEvents = m.style.display === 'none' ? 'none' : '';
    });
    observer.observe(m, {attributes:true, attributeFilter:['style']});
    // Initial state
    if (m.style.display === 'none') m.style.pointerEvents = 'none';
  });
})();

// ══ MODAL-CENTER Z-INDEX ══════════════════════════════════════
// Ensure .modal-center (brand detail, etc.) also above nav
document.querySelectorAll('.modal-center').forEach(m => {
  if (!m.style.zIndex) m.style.zIndex = '350';
});

// ══ APPLY TAB ORDER ON LOAD ═══════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  try { loadTabOrder(); applyTabOrder(); } catch(e) {}
});

// ══ SCROLL FAB LISTENER ═══════════════════════════════════════
window.addEventListener('scroll', () => {
  const fab = document.getElementById('scroll-fab');
  if (!fab) return;
  fab.style.display = document.documentElement.scrollTop > 250 ? 'flex' : 'none';
}, {passive:true});
let currentPhoneType = 'touch';


// ══ BRANDS MANAGER — FULL CRUD ════════════════════════════════
const DEFAULT_BRANDS = {
  touch:  ['Samsung','Apple','Xiaomi','Oppo','Vivo','Tecno','Infinix','Huawei','Realme','Nokia','Honor','OnePlus','Motorola','Itel'],
  keypad: ['Nokia','Itel','Tecno','Samsung','Alcatel']
};
let currentBrandTab = 'touch';
let currentBrandView = 'active'; // 'active' | 'archived'



















// ══ AUTOCOMPLETE DATALISTS ═══════════════════════════════════


// ══ UPDATED openAddPhone ══════════════════════════════════════


// ══ UPDATED savePhone with deviceType ════════════════════════


// Override savePhone to use new version


// ══ FIXED renderPhonesShortage (only qty=0) ════════════════════



// ══ BRANDS MANAGER BUTTON in phones header ════════════════════


// ══ TAB ORDER ════════════════════════════════════════════════
const DEFAULT_TAB_ORDER = ['acc','cash','repairs','sw','phones','used','exp'];
let tabOrder = [];








// ══ MONTHLY SECTION TOGGLE ════════════════════════════════════


// ══ BACKUP SYSTEM ═════════════════════════════════════════════



// ══ DATA HEALTH CHECK ═════════════════════════════════════════


// ══ SMART SCROLL FAB ══════════════════════════════════════════
(function initSmartFab() {
  const fab = document.getElementById('scroll-fab'); if (!fab) return;
  const upBtn = fab.querySelector('button:first-child');
  const dnBtn = fab.querySelector('button:last-child');
  window.addEventListener('scroll', () => {
    const scrollY = window.scrollY || document.documentElement.scrollTop;
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    if (maxScroll < 100) { fab.style.display = 'none'; return; }
    fab.style.display = 'flex';
    const atTop = scrollY < 100, atBottom = scrollY > maxScroll - 100;
    if (upBtn) upBtn.style.display = atTop ? 'none' : 'flex';
    if (dnBtn) dnBtn.style.display = atBottom ? 'none' : 'flex';
  }, {passive:true});
})();

// ══ DASHBOARD CAROUSEL ════════════════════════════════════════


// Touch drag support + arrow init
(function initCarouselDrag() {
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('dash-carousel');
    if (!el) return;
    // Initial arrow state
    updateCarouselArrows();
    el.addEventListener('scroll', updateCarouselArrows, {passive:true});
    let startX = 0, startScroll = 0, dragging = false;
    el.addEventListener('touchstart', e => { startX = e.touches[0].pageX; startScroll = el.scrollLeft; dragging = true; }, {passive:true});
    el.addEventListener('touchmove',  e => { if (!dragging) return; el.scrollLeft = startScroll - (e.touches[0].pageX - startX); }, {passive:true});
    el.addEventListener('touchend',   () => { dragging = false; updateCarouselArrows(); });
    el.addEventListener('mousedown',  e => { startX = e.pageX; startScroll = el.scrollLeft; dragging = true; el.style.cursor='grabbing'; e.preventDefault(); });
    window.addEventListener('mousemove', e => { if (!dragging) return; el.scrollLeft = startScroll - (e.pageX - startX); });
    window.addEventListener('mouseup',   () => { dragging = false; if(el) el.style.cursor=''; updateCarouselArrows(); });
  });
})();

// ══ SMART TRANSACTION ROLLBACK ════════════════════════════════


let _pendingRollback = null;







// Rollback from monthly report view


// ══ REPAIR FILTER & NEW STATUS SYSTEM ═════════════════════════
let repairPanelFilter = 'all';






// ── renderRepairPanel (final override) ─────────────────────────

