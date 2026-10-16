// ═══════════════════════════════════════════════════════════
// backup.js — تم توليده تلقائيًا أثناء إعادة التنظيم (Phase 1 Refactor)
// كل الدوال هنا منقولة حرفيًا بدون أي تغيير في المنطق أو السلوك
// ═══════════════════════════════════════════════════════════

function exportMonth(){const obj={_type:'month',month:selMonth};Storage.search('mshop_d_'+selMonth).forEach(k=>{obj[k]=Storage.getRaw(k);});dlJSON(obj,'محل_'+selMonth+'.json');}

function exportAll(){const obj={};Storage.search('mshop_').forEach(k=>{obj[k]=Storage.getRaw(k);});dlJSON(obj,'محل_كل_البيانات_'+TODAY+'.json');}

function dlJSON(obj,fn){const blob=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=fn;a.click();URL.revokeObjectURL(url);}

function importData(inp){const file=inp.files[0];if(!file)return;const reader=new FileReader();reader.onload=e=>{try{const raw=JSON.parse(e.target.result);let cnt=0;Object.keys(raw).forEach(k=>{if(k.startsWith('mshop_')){Storage.saveRaw(k,raw[k]);cnt++;}});loadAll();loadData();renderAll();if($('S-monthly')?.style.display!=='none')renderMonthly();showToast(`✅ تم الاستيراد! (${cnt} ملف)`,'ok');}catch{showToast('خطأ في الملف','err');}};reader.readAsText(file);inp.value='';}

function exportBackup() {
  const backup = {version: '1.0', date: new Date().toISOString(), shop: cfg?.name||'محل', data:{}};
  const keys = [...Storage.search('mshop_'), ...['shopCfg','shopInventory'].filter(k=>Storage.exists(k))];
  keys.forEach(k=>{
    const r = Storage.tryGet(k);
    backup.data[k] = r.corrupt ? Storage.getRaw(k) : r.value;
  });
  const blob = new Blob([JSON.stringify(backup, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `backup_${cfg?.name||'محل'}_${td()}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  Storage.saveRaw('mshop_last_backup', td());
  showToast('✅ تم تصدير النسخة الاحتياطية', 'ok');
  renderSettingsPage();
}

function importBackup(input) {
  const file = input?.files?.[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const backup = JSON.parse(e.target.result);
      if (!backup.data) { showToast('ملف غير صالح', 'err'); return; }
      if (!confirm(`استعادة نسخة احتياطية من ${backup.date?.slice(0,10)||'تاريخ غير معروف'}؟\nسيتم استبدال البيانات الحالية!`)) return;
      Object.entries(backup.data).forEach(([k,v]) => {
        Storage.saveRaw(k, typeof v === 'string' ? v : JSON.stringify(v));
      });
      showToast('✅ تمت الاستعادة — جاري إعادة التحميل...', 'ok');
      setTimeout(() => location.reload(), 1200);
    } catch { showToast('خطأ في قراءة الملف', 'err'); }
  };
  reader.readAsText(file);
}

// ══ Phase 3A — نظام النسخ الاحتياطي المشفّر (.mshop) ═══════════
// نظام جديد ومستقل تمامًا عن exportBackup/importBackup أعلاه (لم تُمس ولا تزال تعمل كما هي).
// يستخدم فقط Web Crypto API القياسي (AES-GCM + PBKDF2) — بدون أي تشفير مخصص.

const MSHOP_APP_VERSION = '1.0';
const MSHOP_BACKUP_FORMAT_VERSION = 1;
const MSHOP_PBKDF2_ITERATIONS = 150000;

function bufToB64(buf){return btoa(String.fromCharCode(...new Uint8Array(buf)));}
function b64ToBuf(b64){const bin=atob(b64);const arr=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);return arr.buffer;}

// UUID حقيقي (v4) عبر Web Crypto لو متاح، مع بديل احتياطي آمن
function genBackupId(){
  if(typeof crypto!=='undefined' && typeof crypto.randomUUID==='function') return crypto.randomUUID();
  // بديل احتياطي (لو randomUUID غير مدعوم في متصفح قديم جدًا)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
    const r=Math.random()*16|0, v=c==='x'?r:(r&0x3|0x8); return v.toString(16);
  });
}

// معرّف جهاز ثابت (مُولَّد مرة واحدة ومحفوظ) — Placeholder لمزامنة مستقبلية، غير مُستخدَم حاليًا
function getOrCreateDeviceId(){
  let id=Storage.getRaw('mshop_device_id');
  if(!id){ id=genBackupId(); Storage.saveRaw('mshop_device_id', id); }
  return id;
}

// مقارنة إصدارات بسيطة بصيغة "x.y.z" — ترجع 1 لو a أحدث من b، -1 لو أقدم، 0 لو متساويين
function compareVersions(a, b){
  const pa=String(a||'0').split('.').map(n=>parseInt(n)||0);
  const pb=String(b||'0').split('.').map(n=>parseInt(n)||0);
  const len=Math.max(pa.length, pb.length);
  for(let i=0;i<len;i++){
    const x=pa[i]||0, y=pb[i]||0;
    if(x>y)return 1;
    if(x<y)return -1;
  }
  return 0;
}

// عدّ السجلات لكل وحدة رئيسية — تشخيصي بحت (يُضاف للـ metadata فقط)
function countBackupRecords(dataObj){
  const counts={phones:0, usedPhones:0, accessories:0, repairs:0, software:0, cash:0, expenses:0, notes:0, notifications:0};
  Object.entries(dataObj).forEach(([k,v])=>{
    if(k.startsWith('mshop_d_') && v && typeof v==='object'){
      counts.accessories+=(v.acc||[]).length;
      counts.usedPhones+=(v.used||[]).length;
      counts.cash+=(v.cash||[]).length;
      counts.software+=(v.sw||[]).length;
      counts.expenses+=(v.exp||[]).length;
      counts.phones+=(v.phones||[]).length;
      counts.repairs+=(v.repairs||[]).length;
    }
  });
  counts.notes=Array.isArray(dataObj['mshop_notes'])?dataObj['mshop_notes'].length:0;
  counts.notifications=Array.isArray(dataObj['mshop_notifs'])?dataObj['mshop_notifs'].length:0;
  return counts;
}

// يجمع كل مفاتيح mshop_* (نفس منطق exportBackup أعلاه بالضبط — يضمن تغطية كاملة لكل الوحدات الحالية والمستقبلية تلقائيًا)
function gatherAllBackupData(){
  const obj={};
  const keys=[...Storage.search('mshop_'), ...['shopCfg','shopInventory'].filter(k=>Storage.exists(k))];
  keys.forEach(k=>{const r=Storage.tryGet(k);obj[k]=r.corrupt?Storage.getRaw(k):r.value;});
  return obj;
}

async function deriveBackupKey(password, saltBytes){
  const enc=new TextEncoder();
  const keyMaterial=await crypto.subtle.importKey('raw', enc.encode(password), {name:'PBKDF2'}, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {name:'PBKDF2', salt:saltBytes, iterations:MSHOP_PBKDF2_ITERATIONS, hash:'SHA-256'},
    keyMaterial, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']
  );
}

async function encryptBackupPayload(jsonString, password){
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await deriveBackupKey(password, salt);
  const cipherBuf=await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, new TextEncoder().encode(jsonString));
  return {salt:bufToB64(salt), iv:bufToB64(iv), cipher:bufToB64(cipherBuf)};
}

async function decryptBackupPayload(encObj, password){
  const salt=new Uint8Array(b64ToBuf(encObj.salt));
  const iv=new Uint8Array(b64ToBuf(encObj.iv));
  const key=await deriveBackupKey(password, salt);
  const plainBuf=await crypto.subtle.decrypt({name:'AES-GCM', iv}, key, b64ToBuf(encObj.cipher));
  return new TextDecoder().decode(plainBuf);
}

async function computeChecksum(str){
  const hashBuf=await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return bufToB64(hashBuf);
}

// ── تقدير حجم localStorage المُستخدَم (تحذير سعة تخزين) ──────
function estimateStorageUsageBytes(){
  let total=0;
  try{
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      const v=localStorage.getItem(k);
      total+=(k?k.length:0)+(v?v.length:0);
    }
  }catch(e){}
  return total*2; // تقدير: كل حرف UTF-16 ≈ 2 بايت
}
const MSHOP_STORAGE_WARN_THRESHOLD_BYTES = 4.5*1024*1024; // تحذير عند الاقتراب من الحد الشائع لمعظم المتصفحات (~5MB)

function updateBackupProgress(stageText){
  document.querySelectorAll('.backup-progress-indicator').forEach(el=>{
    el.textContent=stageText||'';
    el.style.display=stageText?'block':'none';
  });
}

// ── إنشاء النسخة الاحتياطية ─────────────────────────────────
let _backupInProgress=false;
async function createSecureBackup(password){
  if(_backupInProgress){ showToast('⏳ نسخة احتياطية قيد الإنشاء بالفعل — انتظر حتى تنتهي','info'); return null; }
  _backupInProgress=true;
  try{
    updateBackupProgress('⏳ جاري التحضير...');
    const usageBytes=estimateStorageUsageBytes();
    if(usageBytes>MSHOP_STORAGE_WARN_THRESHOLD_BYTES){
      // تحذير فقط، لا يمنع إنشاء النسخة إطلاقًا
      showToast('⚠️ مساحة التخزين المحلي تقترب من الامتلاء — يُفضَّل عمل نسخة احتياطية ومراجعة البيانات القديمة','info');
    }

    const data=gatherAllBackupData();
    const jsonString=JSON.stringify({data});
    const recordCounts=countBackupRecords(data);
    const checksum=await computeChecksum(jsonString);
    const meta={
      appVersion:MSHOP_APP_VERSION, backupFormatVersion:MSHOP_BACKUP_FORMAT_VERSION,
      date:td(), time:ts(), createdAt:new Date().toISOString(),
      device:(typeof navigator!=='undefined'&&navigator.userAgent?navigator.userAgent.slice(0,120):''),
      backupId:genBackupId(), encrypted:!!password, checksum,
      recordCounts, approxSizeBytes:jsonString.length,
      // Placeholders لمزامنة مستقبلية — غير مُستخدَمة حاليًا، بدون أي تنفيذ فعلي للمزامنة
      deviceId:getOrCreateDeviceId(), lastSyncTime:null, syncGeneration:0,
    };
    let fileObj;
    if(password){
      updateBackupProgress('🔒 جاري التشفير...');
      const enc=await encryptBackupPayload(jsonString, password);
      fileObj={mshopBackup:true, meta, enc};
    }else{
      fileObj={mshopBackup:true, meta, data};
    }
    // تحقق فوري بعد الإنشاء مباشرة (طلب صريح: Validate immediately after creation)
    updateBackupProgress('🔎 جاري التحقق...');
    const v=await validateBackupObject(fileObj, password);
    if(!v.ok){
      showToast('⚠️ فشل التحقق من النسخة بعد إنشائها: '+v.reason,'err');
      recordBackupHistory({date:td(), time:ts(), backupId:meta.backupId, sizeBytes:jsonString.length, encrypted:!!password, success:false});
      return null;
    }

    updateBackupProgress('✅ جاري الإنهاء...');
    const fname=`محل_${(cfg?.name||'نسخة')}_${td()}.mshop`;
    const blob=new Blob([JSON.stringify(fileObj)], {type:'application/octet-stream'});
    Storage.saveRaw('mshop_last_backup', td()+' '+ts());
    recordBackupHistory({date:td(), time:ts(), backupId:meta.backupId, sizeBytes:blob.size||jsonString.length, encrypted:!!password, success:true});
    if (typeof renderSettingsPage==='function') renderSettingsPage();
    return {blob, fname, meta};
  }catch(e){
    showToast('❌ فشل إنشاء النسخة الاحتياطية','err');
    recordBackupHistory({date:td(), time:ts(), backupId:null, sizeBytes:0, encrypted:!!password, success:false});
    return null;
  }finally{
    _backupInProgress=false;
    updateBackupProgress('');
  }
}

// ── سجل تاريخ آخر 10 نسخ احتياطية (نجاح/فشل) — بيانات وصفية فقط، لا يُخزَّن أي ملف فعلي ──
function recordBackupHistory(entry){
  let history=Storage.get('mshop_backup_history_log', []);
  if(!Array.isArray(history))history=[];
  history.unshift(entry);
  if(history.length>10)history=history.slice(0,10);
  Storage.save('mshop_backup_history_log', history);
}

// ── التحقق من صحة/سلامة ملف نسخة احتياطية ───────────────────
// ══ Phase 3A+ — إطار ترحيل إصدارات النسخ الاحتياطية (Migration Framework) ══
// بنية جاهزة لإضافة تحويلات مستقبلية بسهولة دون تعديل منطق التحقق نفسه.
// كل مفتاح = رقم الإصدار المصدر، والقيمة = دالة تحوّل بيانات هذا الإصدار لصيغة الإصدار التالي مباشرة.
// حاليًا لا توجد أي ترحيلات فعلية مطلوبة (الإصدار 1 هو الوحيد الموجود) — فقط الهيكل جاهز للمستقبل.
const MSHOP_BACKUP_MIGRATIONS = {
  // مثال توضيحي للمستقبل (غير مُفعَّل الآن):
  // 1: (data, meta) => ({ data: {...data}, meta: {...meta} }), // يحوّل من v1 إلى v2
};

// يُحاول ترحيل نسخة احتياطية قديمة خطوة بخطوة حتى تصل لآخر إصدار مدعوم حاليًا.
// يرجع null لو الإصدار غير معروف أو لا توجد سلسلة ترحيل كاملة له.
function migrateBackupData(data, meta){
  let curVersion=meta.backupFormatVersion??1;
  let curData=data, curMeta=meta;
  while(curVersion<MSHOP_BACKUP_FORMAT_VERSION){
    const step=MSHOP_BACKUP_MIGRATIONS[curVersion];
    if(!step) return null; // لا توجد خطوة ترحيل معروفة لهذا الإصدار — لا يمكن الإكمال بأمان
    const result=step(curData, curMeta);
    curData=result.data; curMeta={...curMeta, ...result.meta};
    curVersion++;
  }
  return {data:curData, meta:{...curMeta, backupFormatVersion:MSHOP_BACKUP_FORMAT_VERSION}};
}

async function validateBackupObject(fileObj, password){
  if(!fileObj || !fileObj.mshopBackup) return {ok:false, reason:'ملف غير صالح (ليس نسخة احتياطية من محل الموبايلات)'};
  if(!fileObj.meta) return {ok:false, reason:'بيانات وصفية (metadata) مفقودة'};
  if((fileObj.meta.backupFormatVersion||0) > MSHOP_BACKUP_FORMAT_VERSION) return {ok:false, reason:'إصدار النسخة الاحتياطية أحدث من إصدار التطبيق الحالي — حدّث التطبيق أولًا'};
  if(fileObj.meta.appVersion && compareVersions(fileObj.meta.appVersion, MSHOP_APP_VERSION)>0){
    return {ok:false, reason:`هذه النسخة أُنشئت بإصدار أحدث من التطبيق (${fileObj.meta.appVersion})، بينما إصدارك الحالي (${MSHOP_APP_VERSION}) — حدّث التطبيق أولًا قبل الاستعادة`};
  }
  let jsonString;
  try{
    if(fileObj.enc){
      if(!password) return {ok:false, reason:'هذه النسخة مشفّرة وتحتاج كلمة مرور'};
      jsonString=await decryptBackupPayload(fileObj.enc, password);
    }else{
      jsonString=JSON.stringify({data:fileObj.data});
    }
  }catch(e){ return {ok:false, reason:'فشل فك التشفير — كلمة المرور غير صحيحة أو الملف تالف'}; }
  if(fileObj.meta.checksum){
    const checksum=await computeChecksum(jsonString);
    if(checksum!==fileObj.meta.checksum) return {ok:false, reason:'الملف تالف (فشل التحقق من السلامة)'};
  }
  let parsed;
  try{ parsed=JSON.parse(jsonString); }catch(e){ return {ok:false, reason:'بيانات JSON تالفة داخل الملف'}; }
  if(!parsed.data || typeof parsed.data!=='object') return {ok:false, reason:'لا توجد بيانات صالحة داخل النسخة'};
  // ── ترحيل الإصدارات القديمة (إن وُجدت) قبل القبول ──
  if((fileObj.meta.backupFormatVersion??1) < MSHOP_BACKUP_FORMAT_VERSION){
    const migrated=migrateBackupData(parsed.data, fileObj.meta);
    if(!migrated) return {ok:false, reason:'إصدار قديم غير مدعوم — لا توجد مسارات ترحيل متاحة لهذا الإصدار'};
    parsed.data=migrated.data; fileObj.meta=migrated.meta;
  }
  return {ok:true, data:parsed.data, meta:fileObj.meta};
}

// ── الاستعادة (ذرّية: تراجع تلقائي عند أي فشل) ─────────────────
// ══ Phase 3A+ — قفل الواجهة أثناء الاستعادة ══════════════════
let _restoringBackup=false;
function lockAppForRestore(locked){
  _restoringBackup=locked;
  const overlay=$('restore-lock-overlay');
  if(overlay)overlay.style.display=locked?'flex':'none';
}

// يتيح للمستخدم استعادة آخر نسخة طارئة (تم إنشاؤها تلقائيًا قبل آخر عملية استعادة) لاحقًا لو احتاج
async function restoreEmergencyBackup(){
  const em=Storage.get('mshop_emergency_backup');
  if(!em){ showToast('لا توجد نسخة طارئة محفوظة','err'); return; }
  if(!confirm(`استعادة النسخة الطارئة المحفوظة تلقائيًا بتاريخ ${em.createdAt?.slice(0,16).replace('T',' ')||'غير معروف'}؟`))return;
  lockAppForRestore(true);
  try{
    const fileObj=JSON.parse(em.raw);
    const v=await validateBackupObject(fileObj, null);
    if(!v.ok){ showToast('❌ النسخة الطارئة تالفة: '+v.reason,'err'); return; }
    Object.entries(v.data).forEach(([k,val])=>{ Storage.saveRaw(k, typeof val==='string'?val:JSON.stringify(val)); });
    loadAll();loadData();
    showToast('✅ تمت استعادة النسخة الطارئة — جاري إعادة التحميل...','ok');
    setTimeout(()=>location.reload(),1200);
  }catch(e){
    showToast('❌ فشلت استعادة النسخة الطارئة','err');
  }finally{
    lockAppForRestore(false);
  }
}

// يحذف النسخة الطارئة فقط (بعد استعادة ناجحة، أو أي وقت آخر) — لا يؤثر على أي نسخة أخرى
function deleteEmergencyBackup(){
  if(!Storage.exists('mshop_emergency_backup')){ showToast('لا توجد نسخة طارئة لحذفها','info'); return; }
  if(!confirm('حذف النسخة الطارئة المحفوظة تلقائيًا؟ لن تتمكن من الرجوع لها بعد ذلك.'))return;
  Storage.remove('mshop_emergency_backup');
  showToast('🗑️ تم حذف النسخة الطارئة','ok');
  if (typeof renderSettingsPage==='function') renderSettingsPage();
}

async function restoreSecureBackup(file, password){
  if(_restoringBackup){ showToast('⏳ عملية استعادة قيد التنفيذ بالفعل','info'); return; }
  let text;
  try{ text=await file.text(); }catch(e){ showToast('❌ تعذّرت قراءة الملف','err'); return; }
  let fileObj;
  try{ fileObj=JSON.parse(text); }catch(e){ showToast('❌ ملف غير صالح (ليس JSON سليم)','err'); return; }

  const v=await validateBackupObject(fileObj, password);
  if(!v.ok){ showToast('❌ '+v.reason,'err'); return; }

  if(!confirm(`استعادة نسخة احتياطية بتاريخ ${v.meta.date} الساعة ${v.meta.time}؟\nسيتم استبدال كل البيانات الحالية بالكامل!`)) return;

  lockAppForRestore(true);
  updateBackupProgress('⏳ جاري التحضير...');
  try{
    // نسخة طارئة تلقائية مخزَّنة فعليًا (وليست فقط في الذاكرة) قبل أي كتابة —
    // طبقة أمان إضافية فوق آلية التراجع الحالية، تنجو حتى لو حصل تحديث للصفحة أثناء الاستعادة
    try{
      const emergency=await createSecureBackup(null);
      if(emergency){
        const emergencyText=await emergency.blob.text();
        Storage.save('mshop_emergency_backup', {createdAt:new Date().toISOString(), backupId:emergency.meta.backupId, raw:emergencyText});
      }
    }catch(e){ /* فشل إنشاء النسخة الطارئة لا يوقف الاستعادة، لكنه يُفقد طبقة الأمان الإضافية فقط — آلية Snapshot أدناه تبقى كافية */ }

    // Snapshot الحالة الحالية بالكامل قبل أي كتابة — لضمان تراجع تلقائي لو حصل أي خطأ أثناء الاستعادة
    const snapshotKeys=Storage.search('mshop_');
    const snapshot={};
    snapshotKeys.forEach(k=>{snapshot[k]=Storage.getRaw(k);});

    try{
      updateBackupProgress('📥 جاري الاستعادة...');
      var _diagLines=[];var _diagIdx=0;
      Object.entries(v.data).forEach(([k,val])=>{
        const payload = typeof val==='string'?val:JSON.stringify(val);
        const result = Storage.saveRaw(k, payload);
        _diagIdx++;_diagLines.push(_diagIdx+'. '+k+' | ok='+result+' | bytes='+payload.length);
      });
      var _allKeys=Object.keys(v.data);var _lastKey=_allKeys[_allKeys.length-1];
      _diagLines.push('---');
      _diagLines.push('LAST KEY: '+_lastKey);
      _diagLines.push('TOTAL KEYS: '+_allKeys.length);
      _diagLines.push('---KEYS ORDER---');
      _allKeys.forEach(function(ek,i){_diagLines.push(i+'. '+ek);});
      setTimeout(function(){alert(_diagLines.join('\n'));},100);
      // تحقق ما بعد الاستعادة: التأكد إن البيانات الأساسية تُحمَّل بدون أخطاء
      updateBackupProgress('✅ جاري الإنهاء...');
      loadAll();loadData();
      showToast('✅ تمت الاستعادة بنجاح — جاري إعادة التحميل...','ok');
      setTimeout(()=>location.reload(),1200);
      return true;
    }catch(e){
      // Rollback الفوري لنفس اللقطة المحفوظة (الطبقة الأساسية)
      Object.entries(snapshot).forEach(([k,val])=>{ if(val===null) Storage.remove(k); else Storage.saveRaw(k,val); });
      try{loadAll();loadData();}catch(e2){}
      showToast('❌ فشلت الاستعادة — تم التراجع التلقائي للحالة السابقة، لم تُفقَد أي بيانات','err');
      return false;
    }
  }finally{
    lockAppForRestore(false);
    updateBackupProgress('');
  }
}

// ── المشاركة (Web Share API) أو التنزيل التلقائي (سطح المكتب) ──
async function shareOrDownloadBackup(blob, fname){
  try{
    if(typeof navigator!=='undefined' && navigator.share && navigator.canShare){
      const file=new File([blob], fname, {type:blob.type});
      if(navigator.canShare({files:[file]})){
        await navigator.share({files:[file], title:'نسخة احتياطية - محل الموبايلات', text:'نسخة احتياطية بتاريخ '+td()});
        return 'shared';
      }
    }
  }catch(e){ /* المستخدم ألغى المشاركة أو فشلت — نكمل بالتنزيل */ }
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=fname;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return 'downloaded';
}

// ── ملخص النسخة قبل التصدير/المشاركة (معلوماتي فقط) ──────────
let _backupSummaryResolve=null;
function showBackupSummaryDialog(result){
  return new Promise(resolve=>{
    _backupSummaryResolve=resolve;
    const sizeKb=((result.blob.size||0)/1024).toFixed(1);
    const content=$('backup-summary-content');
    if(content){
      content.innerHTML=`
        <div>📅 التاريخ: <b style="color:#e2e8f0">${result.meta.date}</b></div>
        <div>🕐 الوقت: <b style="color:#e2e8f0">${result.meta.time}</b></div>
        <div>🔖 إصدار النسخة: <b style="color:#e2e8f0">${result.meta.backupFormatVersion}</b></div>
        <div>📱 إصدار التطبيق: <b style="color:#e2e8f0">${result.meta.appVersion}</b></div>
        <div>${result.meta.encrypted?'🔒 <span style="color:#4ade80">مشفّرة (موصى به)</span>':'⚠️ <span style="color:#f59e0b">غير مشفّرة</span>'}</div>
        <div>💾 الحجم التقريبي: <b style="color:#e2e8f0">${sizeKb} KB</b></div>
        <div>🆔 المعرّف: <span style="color:#64748b;font-size:10px">${result.meta.backupId}</span></div>
      `;
    }
    const modal=$('modal-backup-summary');if(modal)modal.style.display='flex';
  });
}
function backupSummaryAction(proceed){
  const modal=$('modal-backup-summary');if(modal)modal.style.display='none';
  if(_backupSummaryResolve){const r=_backupSummaryResolve;_backupSummaryResolve=null;r(proceed);}
}

// ── إجراءات الواجهة ──────────────────────────────────────────
async function doCreateSecureBackup(){
  const pw=g('backup-password-inp')||null;
  // التشفير هو الخيار الموصى به افتراضيًا — تجاهله يتطلب تأكيدًا صريحًا وواضحًا من المستخدم
  if(!pw){
    if(!confirm('⚠️ لم تُدخل كلمة مرور — ستُنشأ نسخة غير مشفّرة (أي شخص يحصل على الملف يقدر يقرأ كل بياناتك بسهولة).\n\nالتشفير موصى به بشدة لحماية بيانات المحل الحساسة.\n\nهل تريد المتابعة بدون تشفير رغم ذلك؟')) return;
  }
  const btn=$('secure-backup-btn');if(btn)btn.disabled=true;
  const result=await createSecureBackup(pw);
  if(btn)btn.disabled=false;
  if(!result)return;
  const proceed=await showBackupSummaryDialog(result);
  if(!proceed)return;
  const how=await shareOrDownloadBackup(result.blob, result.fname);
  showToast(how==='shared'?'✅ تم إنشاء النسخة ومشاركتها':'✅ تم إنشاء النسخة وتنزيلها','ok');
  clr('backup-password-inp');
}

function doRestoreSecureBackup(input){
  const file=input?.files?.[0];if(!file)return;
  const pw=g('restore-password-inp')||null;
  restoreSecureBackup(file, pw).finally(()=>{input.value='';clr('restore-password-inp');});
}

// ── التذكير اليومي ────────────────────────────────────────────
function checkBackupReminder(){
  try{
    if(Storage.getRaw('mshop_backup_reminder_dismissed')==='1')return;
    const today=td();
    if(Storage.getRaw('mshop_backup_reminder_last_shown')===today)return;
    const snoozeUntil=Storage.getRaw('mshop_backup_reminder_snooze');
    if(snoozeUntil && snoozeUntil>new Date().toISOString())return;
    const lastBackup=Storage.getRaw('mshop_last_backup');
    const lastDate=lastBackup?lastBackup.slice(0,10):null;
    if(lastDate===today)return;
    showBackupReminderPopup(lastDate);
  }catch(e){}
}

function showBackupReminderPopup(lastDate){
  Storage.saveRaw('mshop_backup_reminder_last_shown', td());
  const daysAgo=lastDate?Math.max(0,Math.round((new Date(td())-new Date(lastDate))/86400000)):null;
  const msg=$('backup-reminder-msg');
  if(msg)msg.textContent=lastDate?`آخر نسخة احتياطية كانت من ${daysAgo} يوم (${lastDate})`:'لم يتم إنشاء أي نسخة احتياطية بعد';
  const modal=$('modal-backup-reminder');
  if(modal)modal.style.display='flex';
}

function backupReminderAction(action){
  const modal=$('modal-backup-reminder');if(modal)modal.style.display='none';
  if(action==='create'){goSettings();setTimeout(()=>$('sec-secure-backup')?.scrollIntoView({behavior:'smooth'}),200);}
  if(action==='later'){const snooze=new Date();snooze.setHours(snooze.getHours()+4);Storage.saveRaw('mshop_backup_reminder_snooze', snooze.toISOString());}
  if(action==='dismiss'){Storage.saveRaw('mshop_backup_reminder_dismissed','1');}
}
