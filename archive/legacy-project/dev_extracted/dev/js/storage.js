// ═══════════════════════════════════════════════════════════
// storage.js — تم توليده تلقائيًا أثناء إعادة التنظيم (Phase 1 Refactor)
// كل الدوال هنا منقولة حرفيًا بدون أي تغيير في المنطق أو السلوك
// ═══════════════════════════════════════════════════════════

// ══ Phase 2A — Unified Storage API ═══════════════════════════
// طبقة موحّدة فوق localStorage — نفس المفاتيح، نفس شكل البيانات، بدون أي تغيير سلوكي.
// كل دوال هذا الملف (وبقية الملفات) تمر من الآن عبر Storage.* بدل استدعاء localStorage مباشرة.
const Storage = {
  // يقرأ مفتاحًا ويُرجع القيمة بعد JSON.parse، أو fallback عند عدم الوجود أو تلف البيانات
  get(key, fallback = null) {
    let raw;
    try { raw = localStorage.getItem(key); }
    catch (e) { Storage._log('getItem-exception', key, e.message); return fallback; }
    if (raw === null || raw === undefined) return fallback;
    try { return JSON.parse(raw); }
    catch (e) { Storage._log('json-parse-error', key, e.message); return fallback; }
  },
  // يقرأ القيمة الخام كنص بدون JSON.parse (نادرًا ما تُستخدم، لحالات خاصة)
  getRaw(key) {
    try { return localStorage.getItem(key); }
    catch (e) { Storage._log('getRaw-exception', key, e.message); return null; }
  },
  // يحفظ نصًا خامًا بدون أي JSON.stringify (لحالة نسخ قيمة خام من مفتاح قديم لمفتاح جديد حرفيًا)
  saveRaw(key, rawValue) {
    try { localStorage.setItem(key, rawValue); return true; }
    catch (e) { Storage._log('saveRaw-exception', key, e.message); return false; }
  },
  // يحفظ قيمة بعد JSON.stringify
  save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { Storage._log('setItem-exception', key, e.message); return false; }
  },
  // يقرأ القيمة الحالية، يطبّق عليها دالة تعديل، ثم يحفظ الناتج — عملية ذرّية منطقيًا
  update(key, updaterFn, fallback = null) {
    const cur = Storage.get(key, fallback);
    const next = updaterFn(cur);
    Storage.save(key, next);
    return next;
  },
  remove(key) {
    try { localStorage.removeItem(key); return true; }
    catch (e) { Storage._log('removeItem-exception', key, e.message); return false; }
  },
  exists(key) {
    try { return localStorage.getItem(key) !== null; }
    catch (e) { Storage._log('exists-exception', key, e.message); return false; }
  },
  // يُرجع كل المفاتيح التي تبدأ بـ prefix معيّن (بديل آمن لحلقات for على localStorage.key(i))
  search(prefix) {
    const results = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) results.push(k);
      }
    } catch (e) { Storage._log('search-exception', prefix, e.message); }
    return results;
  },
  // حذف نطاقي لمفتاح واحد فقط (ليس مسحًا شاملًا، حماية من فقد بيانات عرضي)
  // نسخة تشخيصية من get() تُميّز بين "مفتاح غير موجود" و"بيانات تالفة" — تُستخدم فقط في فحص صحة البيانات
  tryGet(key) {
    let raw;
    try { raw = localStorage.getItem(key); }
    catch (e) { return { ok: false, missing: false, corrupt: false, exception: true, value: null }; }
    if (raw === null || raw === undefined) return { ok: true, missing: true, corrupt: false, value: null };
    try { return { ok: true, missing: false, corrupt: false, value: JSON.parse(raw) }; }
    catch (e) { return { ok: false, missing: false, corrupt: true, value: null }; }
  },
  clear(key) { return Storage.remove(key); },
  // سجلّ تصحيح داخلي خفيف — لا يظهر في الواجهة إطلاقًا، فقط للتتبع أثناء التطوير
  _logs: [],
  _log(type, key, msg) {
    try {
      Storage._logs.push({ type, key, msg, at: new Date().toISOString() });
      if (Storage._logs.length > 200) Storage._logs.shift();
    } catch (e) {}
  },
};

function migrate(){
  const keys=[];for(let i=0;i<localStorage.length;i++)keys.push(localStorage.key(i));
  const skip=new Set(['mshop_cfg','mshop_ca','mshop_cu','mshop_ce','mshop_cats','mshop_notes','mshop_notifs','mshop_calc_hist','mshop_trash','mshop_inventory','mshop_repair_parts','mshop_fault_types']);
  const dr=/^\d{4}-\d{2}-\d{2}$/,px=['mshop_','shop_v1_'];
  keys.forEach(k=>{
    if(!k||skip.has(k)||k.startsWith('mshop_d_'))return;
    for(const p of px){if(k.startsWith(p)){const date=k.slice(p.length);if(dr.test(date)){const nk='mshop_d_'+date;if(!Storage.exists(nk)){const d=Storage.get(k);if(d){if(!d.cash&&d.vf)d.cash=d.vf.map(i=>({cashType:'ايداع',service:i.desc||'فودافون كاش',amount:i.comm||0,time:i.time||''}));if(!d.cash)d.cash=[];['acc','used','sw','exp','phones','repairs'].forEach(x=>{if(!d[x])d[x]=[];});Storage.save(nk,d);}}}break;}}
  });
  // Migrate old notes format
  {const arr=Storage.get('mshop_notes');if(arr&&arr.length&&arr[0]&&!arr[0].title){const m=arr.map(n=>({id:n.id||Date.now(),title:(n.text||'').slice(0,40)||'ملاحظة',content:n.text||'',type:'note',priority:2,created:n.createdDate||td(),createdTime:n.createdTime||'',done:n.done||false,doneDate:n.doneDate||null}));Storage.save('mshop_notes',m);}}
  if(!Storage.exists('mshop_ca')&&Storage.exists('mshop_catalog'))Storage.saveRaw('mshop_ca',Storage.getRaw('mshop_catalog'));
}

function loadAll(){
  cfg={...cfg,...Storage.get('mshop_cfg',{})};
  {const v=Storage.get('mshop_ca');if(v)catA=v;}
  {const v=Storage.get('mshop_cu');if(v)catU=v;}
  {const v=Storage.get('mshop_ce');if(v)catE=v;}
  {const v=Storage.get('mshop_cats');accCats=v?v:[...DEFAULT_CATS];}
  {const v=Storage.get('mshop_notes');if(v)notes=v;}
  {const v=Storage.get('mshop_notifs');if(v)notifs=v;}
  {const v=Storage.get('mshop_calc_hist');if(v)calcHist=v;}
  {const v=Storage.get('mshop_trash');if(v)trash=v;}
  {const v=Storage.get('mshop_inventory');if(v)inventory=v;}
  {const v=Storage.get('mshop_repair_parts');if(v)repairParts=v;}
  {const v=Storage.get('mshop_fault_types');faultTypes=v?v:[...DEFAULT_FAULT_TYPES];}
  loadWallets();
}

// ══ [Read-path compatibility fix] DB-shape → Local-shape عند القراءة فقط ══
// بعض الكيانات المُقسَّمة يوميًا (acc/used/sw/cash/exp/phones) تُكتَب عبر مستودعاتها
// بصيغة قاعدة البيانات (EntityMapper.toDatabase())، لكن loadData() و getMonthData()
// كانتا تقرآن القيمة الخام مباشرة دون تحويلها — فتظهر الحقول المُعاد تسميتها
// (مثل price→amount في السوفت وير، sell→sellAmount في الاكسسوار) كـ undefined أمام
// computeFinancialTotals() وكود العرض. هذا تحويل في الذاكرة فقط عند كل قراءة —
// لا يُكتب أي شيء إلى Storage، ولا يُغيَّر شكل التخزين الفعلي إطلاقًا.
// 'repairs' غير مُدرَجة هنا عمدًا: تحقّقنا أن ENTITY_MAPPERS_REGISTRY لا يحتوي مفتاح
// 'repairTransactions'، لذا Repository._mapper() يُرجع null لها فعليًا، وRepairMapper
// لا يُستدعى إطلاقًا في مسار الكتابة الحالي — سجلات الصيانة اليوم محليّة الشكل بالفعل.
const PARTITION_DB_SHAPE_MARKERS = Object.freeze({
  acc: 'snapshotName', used: 'snapshotName', sw: 'snapshotName',
  cash: 'walletName', exp: 'snapshotCategory', phones: 'snapshotModelName',
});
function _partitionMapperFor(subKey){
  if (typeof LOCAL_PARTITIONED_MAP === 'undefined' || typeof ENTITY_MAPPERS_REGISTRY === 'undefined') return null;
  const entityType = Object.keys(LOCAL_PARTITIONED_MAP).find(k => LOCAL_PARTITIONED_MAP[k].subKey === subKey);
  return entityType ? (ENTITY_MAPPERS_REGISTRY[entityType] || null) : null;
}
function toLocalShapeRecords(subKey, records){
  if (!Array.isArray(records) || !records.length) return records || [];
  const marker = PARTITION_DB_SHAPE_MARKERS[subKey];
  const mapper = _partitionMapperFor(subKey);
  if (!marker || !mapper) return records; // لا يوجد Mapper مُسجَّل فعليًا لهذا القسم — أعِد السجلات كما هي
  return records.map(r => {
    if (!r || !Object.prototype.hasOwnProperty.call(r, marker)) return r; // Local-shape قديم (قبل الهجرة) — بلا تعديل
    return { id: r.id, ...mapper.fromDatabase(r) }; // DB-shape — حوّل للعرض، مع الحفاظ على id دائمًا (يعتمد عليه software.js/repair.js لتمييز السجلات المُهاجَرة)
  });
}

function loadData(){
  const v=Storage.get(DK());
  data=v||{acc:[],used:[],cash:[],sw:[],exp:[],phones:[],repairs:[]};
  if(!data.cash)data.cash=(data.vf||[]).map(i=>({cashType:'ايداع',service:i.desc||'فودافون كاش',amount:i.comm||0,time:i.time||''}));
  ['acc','used','sw','exp','phones','repairs'].forEach(k=>{if(!data[k])data[k]=[];});
  data.cash=data.cash.map(i=>({cashType:i.cashType||'ايداع',...i}));
  ['acc','used','sw','cash','exp','phones'].forEach(k=>{ data[k]=toLocalShapeRecords(k, data[k]); });
}

function save(){if(typeof _restoringBackup!=='undefined'&&_restoringBackup)return;Storage.save(DK(),data);const el=$('save-ind');if(el){el.style.opacity='1';clearTimeout(_st);_st=setTimeout(()=>el.style.opacity='0',2200);}}

function saveCfg(){Storage.save('mshop_cfg',cfg);}

function saveCA(){Storage.save('mshop_ca',catA);rAccCats();rCatL('a');}

function saveCU(){Storage.save('mshop_cu',catU);rCatQ('used');rCatL('u');}

function saveCE(){Storage.save('mshop_ce',catE);rExpQ();rCatL('e');}

function saveCats(){Storage.save('mshop_cats',accCats);rAccCats();rCatMgmt();populateCatSelect();}

function saveNotes(){Storage.save('mshop_notes',notes);updateBadges();}

function saveNotifs(){Storage.save('mshop_notifs',notifs);updateBadges();}

function saveCalcHist(){Storage.save('mshop_calc_hist',calcHist);}

function saveTrash(){Storage.save('mshop_trash',trash);}

function saveInventory(){Storage.save('mshop_inventory',inventory);renderInvSummary();renderInvWidget();}

function saveRepairParts(){Storage.save('mshop_repair_parts',repairParts);}

function saveFaultTypes(){Storage.save('mshop_fault_types',faultTypes);}

function loadTabOrder() {
  tabOrder = Storage.get('mshop_tab_order') || [...DEFAULT_TAB_ORDER];
  // Ensure all tabs are present
  DEFAULT_TAB_ORDER.forEach(t => { if (!tabOrder.includes(t)) tabOrder.push(t); });
}

function saveTabOrder() {
  // Read current order from the UI list
  const items = document.querySelectorAll('#tab-order-list .to-item');
  tabOrder = [...items].map(el => el.dataset.id);
  Storage.save('mshop_tab_order', tabOrder);
  applyTabOrder();
  showToast('✅ تم حفظ الترتيب','ok');
}

function resetTabOrder() {
  tabOrder = [...DEFAULT_TAB_ORDER];
  Storage.remove('mshop_tab_order');
  applyTabOrder();
  renderTabOrderList();
  showToast('↺ تم الإعادة للترتيب الافتراضي','info');
}

function getBrandsData(type) {
  // Returns array of {name, archived}
  const stored = Storage.get('mshop_brands2_'+type);
  if (stored) return stored;
  // Migrate from old format or use defaults
  const oldList = Storage.get('mshop_brands_'+type);
  const names = oldList || [...DEFAULT_BRANDS[type]];
  return names.map(n => ({name:n, archived:false}));
}

function saveBrandsData(type, data) {
  Storage.save('mshop_brands2_'+type, data);
  // Keep old format in sync for backward compat
  Storage.save('mshop_brands_'+type, data.filter(b=>!b.archived).map(b=>b.name));
}

function getBrands(type) {
  return getBrandsData(type).filter(b=>!b.archived).map(b=>b.name);
}

function saveBrands(type, list) {
  const data = getBrandsData(type);
  // Merge: keep archived, update active list
  const archived = data.filter(b=>b.archived);
  const newData = list.map(n=>({name:n,archived:false})).concat(archived);
  saveBrandsData(type, newData);
}

function getRepairLog(){return Storage.get('mshop_rep_log',{});}

function saveRepairLog(log){Storage.save('mshop_rep_log',log);}

function getAllData(){
  const agg=[];
  const dayKeys=Storage.search('mshop_d_');
  dayKeys.forEach(k=>{const date=k.replace('mshop_d_','');
  const d=Storage.get(k);if(!d)return;
    d.acc?.forEach(it=>agg.push({type:'acc',typeAr:'اكسسوار',c:'#3b82f6',name:it.name,amount:it.sell,date,time:it.time||''}));
    d.used?.forEach(it=>agg.push({type:'used',typeAr:'مستعمل',c:'#8b5cf6',name:it.name,amount:it.sell,date,time:it.time||''}));
    d.cash?.forEach(it=>agg.push({type:'cash',typeAr:'كاش',c:'#ef4444',name:it.service+' '+it.cashType,amount:it.amount,date,time:it.time||''}));
    d.sw?.forEach(it=>agg.push({type:'sw',typeAr:'سوفت وير',c:'#10b981',name:it.name,amount:it.price,date,time:it.time||''}));
    d.exp?.forEach(it=>agg.push({type:'exp',typeAr:'مصروف',c:'#f59e0b',name:it.category,amount:it.amount,date,time:it.time||''}));
    d.phones?.forEach(it=>agg.push({type:'phones',typeAr:'هاتف جديد',c:'#06b6d4',name:it.modelName||'',amount:it.sellPrice||0,date,time:it.time||''}));
    d.repairs?.forEach(it=>agg.push({type:'repairs',typeAr:'صيانة',c:'#f97316',name:it.brand+' '+it.model,amount:it.servicePrice||0,date,time:it.time||''}));
  });
  return agg.sort((a,b)=>b.date.localeCompare(a.date));
}
