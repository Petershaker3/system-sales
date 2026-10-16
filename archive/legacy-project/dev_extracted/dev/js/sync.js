// ═══════════════════════════════════════════════════════════
// sync.js — تم توليده تلقائيًا أثناء إعادة التنظيم (Phase 1 Refactor)
// كل الدوال هنا منقولة حرفيًا بدون أي تغيير في المنطق أو السلوك
// ═══════════════════════════════════════════════════════════

async function uploadToDrive(){
  const gasUrl=_getGasUrl();
  if(!gasUrl){showToast('⚠️ مزامنة Drive غير مُعدة — لم يتم إرسال أي بيانات','err');return;}
  const allData={};Storage.search('mshop_').forEach(k=>{allData[k]=Storage.getRaw(k);});
  try{
    showToast('⏳ جاري الرفع على Drive...','info');
    const res=await fetch(gasUrl,{method:'POST',body:JSON.stringify(allData)});
    const txt=await res.text();
    if(txt==='ok'||txt.includes('ok'))showToast('✅ تم الرفع على Google Drive!','ok');
    else showToast('مشكلة: '+txt,'err');
  }catch(e){showToast('خطأ في الاتصال: '+e.message,'err');}
}

function downloadFromDrive(){
  const gasUrl=_getGasUrl();
  if(!gasUrl){showToast('⚠️ مزامنة Drive غير مُعدة — لم يتم جلب أي بيانات','err');return;}
  if(!confirm('تحميل البيانات من Google Drive?\nسيتم دمج البيانات الموجودة.'))return;
  const cb='_dl_'+Date.now();
  window[cb]=function(data){
    try{let cnt=0;Object.keys(data).forEach(k=>{if(k.startsWith('mshop_')){Storage.saveRaw(k,data[k]);cnt++;}});loadAll();loadData();renderAll();renderInvWidget();showToast(`✅ تم التحميل من Drive! (${cnt} ملف)`,'ok');}
    catch(e){showToast('خطأ في معالجة البيانات','err');}
    delete window[cb];
  };
  const s=document.createElement('script');
  s.src=gasUrl+'?callback='+cb+'&t='+Date.now();
  s.onerror=()=>{showToast('فشل التحميل — تأكد من الاتصال','err');delete window[cb];};
  document.head.appendChild(s);
  setTimeout(()=>{if(window[cb]){showToast('انتهت المهلة — جرب تاني','err');delete window[cb];}},15000);
}

function showDriveFiles(){downloadFromDrive();}

function closeDriveModal(){const el=$('modal-drive');if(el)el.style.display='none';}

function renderDriveConnStatus(){
  const el=$('drive-conn-status');if(!el)return;
  el.innerHTML=`<div style="margin-bottom:9px"><span class="drive-conn-badge" style="background:#052e16;color:#4ade80">✅ Google Drive مُعد عبر Apps Script</span></div>`;
}

function connectDrive(){showToast('✅ Google Drive مُعد بالفعل — استخدم زر "☁️ رفع Drive"','ok');}

function disconnectDrive(){}

function saveDriveClientId(){}

// ═══════════════════════════════════════════════════════════════════
// ══ Phase 4 — Sync Preparation (Architecture Only) ═══════════════════
// ═══════════════════════════════════════════════════════════════════
// كل ما يلي هيكل معماري بحت — لا اتصال شبكة، لا استدعاء API، لا مزامنة فعلية.
// النظام يبقى Offline بالكامل كما هو تمامًا. هذا الكود غير مُفعَّل وغير
// مربوط بأي دالة حفظ/تعديل/حذف حالية — "خطافات" جاهزة للربط مستقبلًا فقط.
//
// مصادر الحقيقة الحالية لا تتغيّر: localStorage عبر Storage API يبقى
// المصدر الوحيد للبيانات الآن ومستقبلًا (Offline-First)، وأي مزوّد
// مزامنة مستقبلي (Supabase/Firebase/REST/سيرفر خاص) سيُضاف *فوق* هذه
// الطبقة دون أي تعديل على منطق العمل الحالي.

// ── أدوات مساعدة داخلية (مستقلة تمامًا عن باقي الملفات، بما فيها backup.js) ──
function _syncGenUUID(){
  if(typeof crypto!=='undefined' && typeof crypto.randomUUID==='function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
    const r=Math.random()*16|0, v=c==='x'?r:(r&0x3|0x8); return v.toString(16);
  });
}
function _syncGetDeviceId(){
  // معرّف جهاز مستقل خاص بطبقة المزامنة (مُنفصل عمدًا عن أي معرّف مشابه في backup.js
  // لتفادي أي اعتماد متبادل بين الوحدتين — استقلالية كاملة بين الطبقات)
  let id=Storage.getRaw('mshop_sync_device_id');
  if(!id){ id=_syncGenUUID(); Storage.saveRaw('mshop_sync_device_id', id); }
  return id;
}

// ══ SyncState — حالة المزامنة الحالية (محلي بالكامل) ══════════════════
const SYNC_STATE_KEY='mshop_sync_state';
const SyncState={
  _defaults(){
    return {
      deviceId:_syncGetDeviceId(),
      syncGeneration:0,        // يزيد مستقبلًا مع كل دورة مزامنة ناجحة — 0 دائمًا الآن
      lastSyncTime:null,       // يبقى null دائمًا في هذه المرحلة (لا مزامنة فعلية)
      pendingCount:0,          // عدد العمليات المنتظرة في الطابور
      lastError:null,
      connectionStatus:'offline', // القيمة الوحيدة الممكنة حاليًا — لا يوجد اتصال بأي خادم
      providerName:null,       // اسم المزوّد المستقبلي (Supabase/Firebase/...) — null الآن
      restoreEpoch:0,          // [Phase 6 §Restore Epoch] راجع markRestored() أدناه — metadata محلي بحت، لا يغيّر صيغة النسخ الاحتياطي
    };
  },
  get(){ return Storage.get(SYNC_STATE_KEY, this._defaults()); },
  set(partial){
    const next={...this.get(), ...partial};
    Storage.save(SYNC_STATE_KEY, next);
    return next;
  },
  reset(){ Storage.save(SYNC_STATE_KEY, this._defaults()); return this._defaults(); },
  // [Phase 6 §Restore Epoch] يُستدعى فقط من backup.js عند نجاح استعادة فعلية. metadata
  // محلي خاص بطبقة المزامنة فقط — لا يمس صيغة/تشفير النسخة الاحتياطية بأي شكل. الغرض:
  // لو backend حقيقي مستقبلي أراد إظهار تنبيه/تأكيد صريح لأول مزامنة بعد استعادة (لأن
  // الحالة المحلية قد تكون أقدم من حالة السيرفر — راجع ADR-005 §Backup/Restore
  // Interaction)، يمكنه الاعتماد على هذا الرقم المتصاعد بدل تخمين "هل حدثت استعادة".
  markRestored(){ return this.set({restoreEpoch:(this.get().restoreEpoch||0)+1}); },
};

// ══ SyncQueue — طابور عمليات محلي بالكامل (لا يُعالَج فعليًا في هذه المرحلة) ══
const SYNC_QUEUE_KEY='mshop_sync_queue';
const SYNC_QUEUE_MAX_ENTRIES=500; // حد أقصى دفاعي لمنع تضخم localStorage بلا داعٍ
const SyncQueue={
  // حالات العملية الممكنة (Enum توثيقي، تُستخدَم كنصوص مباشرة للبساطة)
  STATUS:{ PENDING:'Pending', PROCESSING:'Processing', SYNCED:'Synced', FAILED:'Failed' },

  _load(){ return Storage.get(SYNC_QUEUE_KEY, []); },
  _saveAll(list){ Storage.save(SYNC_QUEUE_KEY, list.slice(0, SYNC_QUEUE_MAX_ENTRIES)); },

  // يضيف عملية جديدة للطابور بحالة Pending — لا يرسل أي شيء لأي خادم إطلاقًا
  // ملاحظة: لو عملية Pending أخرى موجودة بالفعل لنفس entityId+operationType، تُستبدَل
  // بالأحدث بدل تكديس عمليات مكرَّرة لنفس التغيير (يمنع رفع نفس التغيير أكثر من مرة).
  enqueue({operationType, entityType, entityId, payload}){
    const list=this._load();
    const now=new Date().toISOString();
    const dupIdx=list.findIndex(e=>e.status===this.STATUS.PENDING && e.entityId===entityId && e.entityType===entityType && e.operationType===operationType);
    if(dupIdx!==-1) list.splice(dupIdx,1);
    const entry={
      operationId:_syncGenUUID(),
      operationType,           // 'create' | 'update' | 'delete'
      entityType,              // مثال: 'phoneTransactions', 'accessoryTransactions'...
      entityId,
      timestamp:now,           // حقل الترتيب الحتمي المُستخدَم في LWW — لا يُعدَّل بعد الإنشاء
      createdAt:now, updatedAt:now,
      deviceId:_syncGetDeviceId(),
      syncGeneration:SyncState.get().syncGeneration,
      payload:payload||null,
      status:this.STATUS.PENDING,
      retryCount:0, lastError:null,
    };
    list.unshift(entry);
    this._saveAll(list);
    SyncState.set({pendingCount:this.countByStatus(this.STATUS.PENDING)});
    return entry;
  },

  list(){ return this._load(); },
  countByStatus(status){ return this._load().filter(e=>e.status===status).length; },

  // يُعيد أقدم N عملية Pending أولًا (ترتيب حتمي بالتوقيت ثم operationId) — دفعة واحدة للرفع
  dequeuePendingBatch(n=50){
    return this._load()
      .filter(e=>e.status===this.STATUS.PENDING)
      .sort((a,b)=>_syncCompareLWW(a,b))
      .slice(0,n);
  },

  updateStatus(operationId, status){
    const list=this._load();
    const entry=list.find(e=>e.operationId===operationId);
    if(!entry) return null;
    entry.status=status; entry.updatedAt=new Date().toISOString();
    this._saveAll(list);
    SyncState.set({pendingCount:this.countByStatus(this.STATUS.PENDING)});
    return entry;
  },

  markProcessing(operationIds){ operationIds.forEach(id=>this.updateStatus(id, this.STATUS.PROCESSING)); },
  // [Phase 6] serverRevision اختياري — يُخزَّن على العملية عند توفره من acknowledgment
  // الرفع، ليصبح متاحًا لاحقًا كسلطة ترتيب LWW موثوقة بدل الاعتماد فقط على timestamp
  // العميل (راجع ADR-005 §Server Revision). لا يُغيِّر أي حقل موجود، إضافة فقط.
  markSynced(operationId, serverRevision){
    const entry=this.updateStatus(operationId, this.STATUS.SYNCED);
    if(entry && serverRevision!=null){
      const list=this._load();
      const e=list.find(x=>x.operationId===operationId);
      if(e){ e.serverRevision=serverRevision; this._saveAll(list); }
    }
    return entry;
  },

  // فشل يُبقي العملية قابلة لإعادة المحاولة (Failed لا يُحذَف تلقائيًا أبدًا) —
  // تُعاد إلى Pending تلقائيًا عند طلب دفعة جديدة إن لم تتجاوز حد المحاولات
  markFailed(operationId, errorMessage){
    const list=this._load();
    const entry=list.find(e=>e.operationId===operationId);
    if(!entry) return null;
    entry.status=this.STATUS.FAILED; entry.retryCount=(entry.retryCount||0)+1;
    entry.lastError=String(errorMessage||'').slice(0,300); entry.updatedAt=new Date().toISOString();
    this._saveAll(list);
    SyncState.set({pendingCount:this.countByStatus(this.STATUS.PENDING)});
    return entry;
  },

  // يعيد كل العمليات الفاشلة (حتى حد محاولات معقول) إلى Pending — إعادة محاولة صريحة
  retryFailed(maxRetries=5){
    const list=this._load();
    let requeued=0;
    list.forEach(e=>{
      if(e.status===this.STATUS.FAILED && (e.retryCount||0)<maxRetries){ e.status=this.STATUS.PENDING; requeued++; }
    });
    this._saveAll(list);
    SyncState.set({pendingCount:this.countByStatus(this.STATUS.PENDING)});
    return requeued;
  },

  removeById(operationId){
    const list=this._load().filter(e=>e.operationId!==operationId);
    this._saveAll(list);
    SyncState.set({pendingCount:this.countByStatus(this.STATUS.PENDING)});
  },

  clear(){ this._saveAll([]); SyncState.set({pendingCount:0}); },
};

// ═══════════════════════════════════════════════════════════════════
// ══ Phase 5 — Sync Engine (queue processing + conflict resolution + mock provider) ══
// ═══════════════════════════════════════════════════════════════════
// يبني فوق هيكل Phase 4 أعلاه دون تعديل أي عقد تخزين أو صيغة نسخ احتياطي أو معادلة
// مالية. SyncManager.enabled يبقى false افتراضيًا — لا مزامنة إنتاجية فعلية بلا مزوّد
// حقيقي مُعتمَد صراحة (انظر LocalMockSyncProvider أسفل — للاختبار فقط، ليس للإنتاج).

// ── الكيانات المسموح مزامنتها فقط: مصادر الحقيقة (معاملات + كتالوج الهواتف)،
//    وليس أي قيمة مُشتقة/محسوبة أو حالة محلية بحتة ──
const SYNC_ENTITY_ALLOWLIST = Object.freeze(new Set([
  'phones', 'phoneTransactions', 'usedPhoneTransactions', 'accessoryTransactions',
  'softwareTransactions', 'walletTransactions', 'expenseTransactions',
]));
// مُستبعَد عمدًا وبشكل موثَّق:
//  - 'repairTransactions'/'repairs': لا هوية DB-shape مستقرة بعد (انظر الاستثناء
//    المعماري الموثَّق أعلى RepairMapper في entity_mappers.js) — لا تشارك في المزامنة
//    حتى تُحسَم خطوة هجرتها بشكل منسَّق ومستقل.
//  - dailySummary/walletBalances: قيم مُشتقة دائمًا، تُعاد بناؤها محليًا، لا تُزامَن أبدًا.
//  - notes/notifications/settings/passwords/session/trash/backups/diagnostics: حالة
//    محلية أو حساسة أو واجهة مستخدم بحتة — خارج نطاق المزامنة الحالي عمدًا.

// ── Tombstones — يمنع "إحياء" سجل محذوف محليًا عبر تغيير بعيد قديم يصل متأخرًا ──
// الاحتفاظ: غير محدود حاليًا (بيانات وصفية صغيرة فقط: نوع/معرّف/توقيت — وليست نسخة
// كاملة من السجل)، لا تُحذف تلقائيًا بعد المزامنة — القرار موثَّق هنا عمدًا.
const SYNC_TOMBSTONES_KEY='mshop_sync_tombstones';
const SYNC_TOMBSTONES_MAX_ENTRIES=1000;
const SyncTombstones={
  _load(){ return Storage.get(SYNC_TOMBSTONES_KEY, []); },
  _saveAll(list){ Storage.save(SYNC_TOMBSTONES_KEY, list.slice(0, SYNC_TOMBSTONES_MAX_ENTRIES)); },
  record(entityType, entityId, deletedAt){
    const list=this._load().filter(t=>!(t.entityType===entityType && t.entityId===entityId));
    list.unshift({entityType, entityId, deletedAt: deletedAt || new Date().toISOString()});
    this._saveAll(list);
  },
  find(entityType, entityId){ return this._load().find(t=>t.entityType===entityType && t.entityId===entityId) || null; },
  // هل تغيير بعيد وارد (بتوقيته) أقدم من أو يساوي لحظة الحذف المحلي المسجَّلة؟
  // لو نعم (أو لو التغيير البعيد بلا توقيت إطلاقًا) — يُرفَض تطبيقه ولا يُحيي السجل.
  isSuperseded(entityType, entityId, remoteTimestamp){
    const t=this.find(entityType, entityId);
    if(!t) return false;
    if(!remoteTimestamp) return true; // بلا توقيت موثوق — الأمان الافتراضي: لا تُحيِ السجل
    return new Date(remoteTimestamp).getTime() <= new Date(t.deletedAt).getTime();
  },
  clear(){ this._saveAll([]); },
};

// ── مقارنة حتمية لتحديد الأحدث بين عمليتين (LWW) — تُستخدَم من SyncConflictResolver ──
// الترتيب: التوقيت أولًا (ISO string قابلة للمقارنة النصية مباشرة)، وعند التساوي
// التام يُحسَم التعادل بمقارنة نصية حتمية على operationId (الأصغر معجميًا يفوز —
// اختيار حتمي تعسّفي لكنه ثابت ومكرَّر على كل الأجهزة بنفس النتيجة دائمًا).
function _syncCompareLWW(a, b){
  // [Phase 6] لو الطرفان يحملان serverRevision (عدّاد سيرفر تصاعدي حتمي غير معتمد على
  // ساعة أي جهاز — راجع ADR-005 §Server Revision)، يُستخدَم كسلطة ترتيب أولى، أكثر
  // موثوقية من مقارنة توقيت جهازين قد يكون أحدهما بساعة خاطئة. لو أحدهما أو كلاهما
  // بلا serverRevision بعد (عملية محلية لم تُرفَع بعد)، يُستخدَم التوقيت كما كان دائمًا.
  if(typeof a?.serverRevision==='number' && typeof b?.serverRevision==='number' && a.serverRevision!==b.serverRevision){
    return a.serverRevision>b.serverRevision ? 1 : -1;
  }
  const ta=a?.timestamp||a?.clientTimestamp||'', tb=b?.timestamp||b?.clientTimestamp||'';
  if(ta!==tb) return ta>tb ? 1 : -1; // 1 يعني a أحدث
  const ia=a?.operationId||'', ib=b?.operationId||'';
  if(ia===ib) return 0;
  return ia<ib ? 1 : -1; // تعادل تام — الأصغر معجميًا يفوز، بشكل حتمي وثابت
}

// ══ SyncConflictResolver — تنفيذ حقيقي: Last-Write-Wins حتمي مع كاسر تعادل صريح ══
const SyncConflictResolver={
  // تعارض حقيقي فقط لو: نفس entityId، وكلا الطرفين يملك تغييرًا فعليًا (وليس أحدهما
  // غائبًا فقط = إنشاء بسيط). معاملات بمعرّفات مختلفة ليست تعارضًا أبدًا — راجع القاعدة
  // المالية: لا يُدمَج معاملتان ماليتان مختلفتا الهوية حسابيًا مهما تشابهت قيمهما.
  detectConflict(localOp, remoteOp){
    if(!localOp || !remoteOp) return {hasConflict:false, reason:'one-side-missing'};
    if(localOp.entityId!==remoteOp.entityId || localOp.entityType!==remoteOp.entityType){
      return {hasConflict:false, reason:'different-entity-identity'};
    }
    if(localOp.operationId===remoteOp.operationId) return {hasConflict:false, reason:'same-operation'};
    return {hasConflict:true, reason:'same-entity-changed-both-sides'};
  },
  // LWW حتمي — لا يُقارِن أبدًا ترتيب خصائص كائن JS، فقط timestamp صريح ثم operationId.
  // لا يُسقِط أي بيانات بصمت: النتيجة تحمل winner/loser/reason دائمًا.
  resolveConflict(localOp, remoteOp, strategy='lastWriteWins'){
    if(strategy!=='lastWriteWins'){
      return {winner:null, loser:null, merged:false, reason:'unsupported-strategy:'+strategy};
    }
    const cmp=_syncCompareLWW(localOp, remoteOp);
    const winner = cmp>=0 ? localOp : remoteOp;
    const loser  = cmp>=0 ? remoteOp : localOp;
    const reason = (localOp.timestamp===remoteOp.timestamp)
      ? 'equal-timestamp-tiebreak-by-operationId'
      : (cmp>=0 ? 'local-timestamp-newer' : 'remote-timestamp-newer');
    return {winner, loser, merged:false, reason, strategy};
  },
  // دمج حقول جزئي — يُستخدَم فقط لو صراحةً طُلب دمج (غير مُفعَّل افتراضيًا في المحرّك
  // الحالي؛ المحرّك يستخدم resolveConflict كاملة السجل، وليس دمجًا حقليًا تلقائيًا،
  // تحديدًا عشان لا تُدمَج قيم مالية حسابيًا — القاعدة رقم 15 في نطاق هذه المهمة).
  mergeChanges(baseRecord, localChanges, remoteChanges){
    return {...baseRecord, ...localChanges, ...remoteChanges, merged:true};
  },
};

// ══ SyncProviderInterface — العقد النهائي [Phase 6] الذي يجب أن يلتزم به أي مزوّد ══
// حقيقي مستقبلي (Supabase / Firebase / REST API / سيرفر ذاتي الاستضافة) — بلا أي
// تنفيذ حقيقي هنا. منطق العمل (business logic) في SyncManager.syncNow() لا يعتمد
// على أي مزوّد بعينه، فقط على هذا العقد بالضبط. أي مزوّد حقيقي (مثل
// sync_provider_supabase.js) يجب أن يلتزم بهذه الأشكال حرفيًا.
//
// connect(config) → {ok, error?}
//   يُنشئ الاتصال/الجلسة (لا مسؤولية auth كاملة هنا — راجع ADR-006؛ الـ provider
//   adapter هو المسؤول عن login/token handling، وليس هذه الواجهة نفسها).
//
// uploadBatch(operations) → {ok, results:[{operationId, ok, serverRevision?, error?}]}
//   operations: [{operationId, operationType, entityType, entityId, deviceId,
//                 timestamp /* client timestamp */, payload}]
//   يجب أن يكون idempotent على operationId (رفع نفس operationId مرتين لا يُنشئ
//   سجلًا ثانيًا ولا يُرجِع نتيجة مختلفة — راجع ADR-005 §Idempotency).
//
// downloadChanges(cursor, pageSize) → {ok, changes, nextCursor, hasMore, error?}
//   changes: [{entityType, entityId, operationId, deviceId, clientTimestamp,
//              serverRevision, payload, deleted}]
//   serverRevision: عدّاد تصاعدي حتمي per-owner يمنحه السيرفر — هو مصدر ترتيب LWW
//   الموثوق (راجع ADR-005 §Server Revision)، وليس أي توقيت جهاز عميل.
//   nextCursor: القيمة التي يجب استخدامها في الطلب التالي فقط بعد نجاح تطبيق هذه
//   الصفحة بالكامل. hasMore=true يعني وجود صفحة تالية يجب طلبها بنفس الدورة.
//   قد يُرجِع أيضًا {ok:false, code:'CURSOR_TOO_OLD'} إن كان cursor العميل أقدم من
//   نافذة الاحتفاظ بسجل التغييرات — يستوجب عندها full resync من current-state
//   (راجع ADR-005 §Cursor Too Old)، وليس معالجته كخطأ عادي قابل لإعادة المحاولة.
//
// disconnect() → {ok}
const SyncProviderInterface={
  async connect(config){ throw new Error('SyncProviderInterface.connect: not implemented — no provider configured'); },
  async uploadBatch(operations){ throw new Error('SyncProviderInterface.uploadBatch: not implemented'); },
  async downloadChanges(cursor, pageSize){ throw new Error('SyncProviderInterface.downloadChanges: not implemented'); },
  async disconnect(){ throw new Error('SyncProviderInterface.disconnect: not implemented'); },
};

// ══ LocalMockSyncProvider — مزوّد اختباري حتمي في الذاكرة فقط ══════════════
// ⚠️ للاختبار فقط — ليس جزءًا من سلوك الإنتاج، ولا يُسجَّل أو يُفعَّل تلقائيًا أبدًا.
// يُحاكي "سيرفر بعيد" بسيط: يقبل دفعات الرفع، يُرجع تغييرات منذ generation مُعطاة،
// يدعم محاكاة حذف بعيد وفشل مؤقت للاختبار. الحالة كلها في متغيّر JS عادي (ليست في
// localStorage) — تُمحى تلقائيًا بمجرد انتهاء الصفحة، ولا تلوّث أي مفتاح تخزين حقيقي.
// [Phase 6] يحاكي بنية Section 4's hybrid model بأمانة: current-state map (آخر حالة
// فعلية لكل كيان) + append-only log (مؤشرات فقط، بلا حمولة — كما توصي ADR-007) يقود
// الـ cursor. هذا الفصل ضروري لاختبار gap-detection بشكل حقيقي: current-state وحده
// يُنتج "فجوات" شرعية كلما تحدَّث كيان أكثر من مرة (revision قديمة تختفي) — وهذا ليس
// فسادًا حقيقيًا. الـ log فقط هو التسلسل الذي يجب ألا يحتوي فجوة غير مُتعمَّدة أبدًا.
function createLocalMockSyncProvider(){
  let remoteRecords={};   // entityType|entityId → {..., serverRevision, deleted} (current-state)
  let logEntries=[];      // [{logRevision, entityType, entityId}] (append-only pointers فقط)
  let revisionCounter=0;
  let failNextUpload=false, failNextDownload=false;
  let forceCursorTooOld=false;
  let retentionFloor=0;      // [Phase 6] أقل logRevision لا يزال محفوظًا — يحاكي compaction/retention حقيقي
  let simulateGapAfter=null; // [Phase 6] اختباري: يترك رقم log revision واحد بلا مؤشر عمدًا لمحاكاة فجوة حقيقية
  const key=(entityType,entityId)=>entityType+'|'+entityId;
  return {
    name:'local-mock',
    async connect(config){ return {ok:true}; },
    // operations: [{operationId, operationType, entityType, entityId, deviceId, timestamp, payload}]
    async uploadBatch(operations){
      if(failNextUpload){ failNextUpload=false; throw new Error('mock-upload-failure'); }
      const results=[];
      for(const op of operations){
        // idempotency: نفس operationId المُرفَق سابقًا لنفس السجل لا يُنشئ revision جديدة، يُرجِع نفس النتيجة
        const k=key(op.entityType, op.entityId);
        const existing=remoteRecords[k];
        if(existing && existing.operationId===op.operationId){
          results.push({operationId:op.operationId, ok:true, serverRevision:existing.serverRevision});
          continue;
        }
        revisionCounter++;
        if(simulateGapAfter===revisionCounter){ simulateGapAfter=null; revisionCounter++; } // يترك فجوة حقيقية في تسلسل الـ log عمدًا للاختبار
        remoteRecords[k]={
          entityType:op.entityType, entityId:op.entityId,
          payload: op.operationType==='delete' ? null : op.payload,
          clientTimestamp: op.timestamp, deviceId: op.deviceId||null, operationId: op.operationId,
          serverRevision: revisionCounter, deleted: op.operationType==='delete',
        };
        logEntries.push({logRevision:revisionCounter, entityType:op.entityType, entityId:op.entityId});
        results.push({operationId:op.operationId, ok:true, serverRevision:revisionCounter});
      }
      return {ok:true, results};
    },
    // cursor: آخر logRevision يعرفه العميل (موضع في الـ log، وليس revision كيان بعينه).
    // pageSize: حجم الصفحة الأقصى.
    async downloadChanges(cursor, pageSize){
      if(failNextDownload){ failNextDownload=false; throw new Error('mock-download-failure'); }
      const since=cursor||0;
      if(forceCursorTooOld || (since>0 && since<retentionFloor)){ forceCursorTooOld=false; return {ok:false, code:'CURSOR_TOO_OLD'}; }
      const size=pageSize||200;
      const logPage=logEntries.filter(l=>l.logRevision>since).sort((a,b)=>a.logRevision-b.logRevision).slice(0, size);
      const hasMore=logEntries.filter(l=>l.logRevision>since).length>logPage.length;
      const nextCursor=logPage.length ? logPage[logPage.length-1].logRevision : since;
      // Join: لكل مؤشر log، أعد الحالة الحالية الفعلية للكيان (current-state)، وليس
      // نسخة تاريخية بلحظة المؤشر — إعادة تطبيق نفس الحالة الحالية أكثر من مرة داخل
      // نفس الدورة عملية آمنة idempotent (راجع Section 9)، وهذا بالضبط ما يضمنه ذلك.
      const changes=logPage.map(l=>{
        const rec=remoteRecords[key(l.entityType,l.entityId)];
        return rec ? {...rec, logRevision:l.logRevision} : null;
      }).filter(Boolean);
      return {ok:true, changes, nextCursor, hasMore, _logRevisionsSeen:logPage.map(l=>l.logRevision)};
    },
    async disconnect(){ return {ok:true}; },
    // ── أدوات اختبار إضافية (ليست جزءًا من SyncProviderInterface) ──
    _simulateRemoteChange(entityType, entityId, payload, timestamp, deleted=false){
      revisionCounter++;
      if(simulateGapAfter===revisionCounter){ simulateGapAfter=null; revisionCounter++; } // يترك فجوة حقيقية في تسلسل الـ log عمدًا للاختبار
      remoteRecords[key(entityType,entityId)]={entityType, entityId, payload, clientTimestamp:timestamp, deviceId:'remote-sim', operationId:'remote_'+revisionCounter, serverRevision:revisionCounter, deleted};
      logEntries.push({logRevision:revisionCounter, entityType, entityId});
    },
    _simulateUploadFailure(){ failNextUpload=true; },
    _simulateDownloadFailure(){ failNextDownload=true; },
    _simulateGapAfterNextRevision(){ simulateGapAfter=revisionCounter+1; },
    _simulateCursorTooOld(active=true){ forceCursorTooOld=active; },
    _setRetentionFloor(rev){ retentionFloor=rev; },
    _reset(){ remoteRecords={}; logEntries=[]; revisionCounter=0; failNextUpload=false; failNextDownload=false; forceCursorTooOld=false; retentionFloor=0; simulateGapAfter=null; },
    _snapshot(){ return {remoteRecords:{...remoteRecords}, logEntries:[...logEntries]}; },
  };
}

// ── يربط entityType باسم المستودع العالمي المقابل — Lookup كسول وقت التشغيل فقط،
//    لأن بعض المستودعات (مثل phoneRepo في phones.js) تُحمَّل بعد sync.js في الترتيب
//    الحالي لـ <script> — لا يجوز الإشارة لها مباشرة عند وقت تقييم هذا الملف نفسه.
function _syncRepoFor(entityType){
  switch(entityType){
    case 'phones':                 return typeof phoneRepo!=='undefined' ? phoneRepo : null;
    case 'phoneTransactions':      return typeof phoneTransactionRepo!=='undefined' ? phoneTransactionRepo : null;
    case 'usedPhoneTransactions':  return typeof usedPhoneTransactionRepo!=='undefined' ? usedPhoneTransactionRepo : null;
    case 'accessoryTransactions':  return typeof accessoryTransactionRepo!=='undefined' ? accessoryTransactionRepo : null;
    case 'softwareTransactions':   return typeof softwareTransactionRepo!=='undefined' ? softwareTransactionRepo : null;
    case 'walletTransactions':     return typeof walletTransactionRepo!=='undefined' ? walletTransactionRepo : null;
    case 'expenseTransactions':    return typeof expenseTransactionRepo!=='undefined' ? expenseTransactionRepo : null;
    default: return null;
  }
}

// ── تحقّق أمني من شكل أي تغيير بعيد قبل تطبيقه — البيانات البعيدة غير موثوقة دائمًا ──
function _syncValidateRemoteChange(rc){
  if(!rc || typeof rc!=='object') return false;
  if(typeof rc.entityType!=='string' || !SYNC_ENTITY_ALLOWLIST.has(rc.entityType)) return false;
  if(typeof rc.entityId!=='string' && typeof rc.entityId!=='number') return false;
  if(rc.deleted!==true && (typeof rc.payload!=='object' || rc.payload===null || Array.isArray(rc.payload))) return false;
  if(rc.clientTimestamp!=null && typeof rc.clientTimestamp!=='string') return false;
  if(rc.serverRevision!=null && typeof rc.serverRevision!=='number') return false;
  // حد دفاعي لحجم الـ payload — رفض أي حمولة بعيدة ضخمة بشكل غير معقول قبل أي معالجة أخرى
  try{ if(rc.payload && JSON.stringify(rc.payload).length>200000) return false; }catch(e){ return false; }
  return true;
}

// ── تطبيق تحديث/إنشاء بعيد عبر أقرب حدود Repository آمنة — أبدًا عبر save() الشامل،
//    وأبدًا عبر تحويل يدوي DB-shape↔Local-shape (Repository.create/update يتكفّلان بذلك) ──
// [Phase 6 — Hardening] لا يعتمد على أي exception عرضي (مثل mapper.fromDatabase(null))
// لتحديد "غير موجود". findById() في Repository الأساسية (db_integration.js) ترمي
// DatabaseError صريحة بكود NOT_FOUND فعليًا (عبر LocalAdapter.read()) — نفرّق هنا
// صراحةً بين هذا الخطأ تحديدًا (فعلًا غير موجود → create) وأي خطأ آخر (تلف تخزين،
// خطأ غير متوقع…) الذي يجب أن يفشل بوضوح وليس أن يُفسَّر خطأً كـ"سجل غير موجود"
// فيُنشئ نسخة مكرَّرة بنفس الـ id فوق خطأ حقيقي غير معالَج.
async function _syncApplyUpsert(remoteChange){
  const repo=_syncRepoFor(remoteChange.entityType);
  if(!repo) throw new Error('sync-apply: no repository for entityType '+remoteChange.entityType);
  let exists=true;
  try{
    await repo.findById(remoteChange.entityId);
  }catch(e){
    if(e instanceof DatabaseError && e.code===DB_ERROR_CODES.NOT_FOUND) exists=false;
    else throw e; // خطأ حقيقي غير متعلق بالوجود — لا يُترجَم إلى create()
  }
  return exists
    ? await repo.update(remoteChange.entityId, remoteChange.payload)
    : await repo.create({...remoteChange.payload, id:remoteChange.entityId});
}
async function _syncApplyDelete(remoteChange){
  const repo=_syncRepoFor(remoteChange.entityType);
  if(!repo) throw new Error('sync-apply: no repository for entityType '+remoteChange.entityType);
  return repo.delete(remoteChange.entityId);
}

// ── [Phase 6] تصنيف الأخطاء — يحدّد استراتيجية إعادة المحاولة المناسبة لكل نوع فشل.
//    يعتمد على e.code إن وُجد (الشكل الذي يُفترَض أن يلتزم به أي provider حقيقي)،
//    وإلا يُعامَل كخطأ شبكة قابل لإعادة المحاولة تلقائيًا (الخيار الأكثر أمانًا) ──
function _syncClassifyError(e){
  if(!e) return 'unknown';
  if(e.code==='AUTH_EXPIRED' || e.code==='UNAUTHORIZED') return 'auth';
  if(e.code==='VALIDATION_ERROR') return 'validation';
  if(e.code==='PERMANENT') return 'permanent';
  if(e.code==='CURSOR_TOO_OLD') return 'cursor-too-old';
  return 'network';
}

// ── [Phase 6] Observability آمنة — حقول محدودة فقط، ولا شيء حسّاس إطلاقًا:
//    ممنوع تسجيل passwords/tokens/encryption keys/.mshop password/حمولات مالية كاملة.
//    Ring buffer محلي صغير (50 حدثًا) + console.log للتشخيص أثناء التطوير فقط ──
const SYNC_TELEMETRY_KEY='mshop_sync_telemetry';
const SYNC_TELEMETRY_MAX=50;
function _syncLog(event, fields){
  try{
    const safe={event, at:new Date().toISOString()};
    ['uploaded','downloaded','applied','conflicts','failed','pages','durationMs','errorClass','reason'].forEach(k=>{
      if(fields && fields[k]!==undefined) safe[k]=fields[k];
    });
    if(typeof console!=='undefined' && console.log) console.log('[sync]', safe);
    const list=Storage.get(SYNC_TELEMETRY_KEY, []);
    list.unshift(safe);
    Storage.save(SYNC_TELEMETRY_KEY, list.slice(0, SYNC_TELEMETRY_MAX));
  }catch(e){/* التسجيل نفسه يجب ألا يُفشِل المزامنة أبدًا */}
}
function _syncElapsed(t0){ return Math.round((typeof performance!=='undefined'?performance.now():Date.now())-t0); }

// ══ SyncManager — الواجهة المركزية ══════════════════════════════════════
const SyncManager={
  enabled:false,      // إيقاف صريح — لا مزامنة إنتاجية تحدث ما لم يُفعَّل صراحةً بمزوّد حقيقي معتمَد
  provider:null,      // لا مزوّد متصل افتراضيًا؛ يُسنَد هنا كائن يلتزم بـ SyncProviderInterface
  _syncing:false,     // قفل تزامن بسيط داخل نفس التبويب — يمنع تشغيل syncNow() مرتين معًا
  // علم داخلي: true فقط أثناء تطبيق تغيير بعيد عبر Repository (انظر _syncApplyUpsert/
  // _syncApplyDelete أدناه). يمنع afterSave/afterUpdate/afterDelete من إعادة تسجيل
  // نفس التغيير البعيد في الطابور المحلي للرفع — وإلا يتكرّر "صدى" كل تنزيل كرفع جديد،
  // وقد يُعيد كتابة قيمة بعيدة أحدث بنسخة محلية أقدم عبر سباق رفع/تنزيل داخل نفس الدورة.
  _applyingRemote:false,

  init(providerAdapter){
    this.provider=providerAdapter||null;
    SyncState.set({providerName:providerAdapter?.name||null});
  },

  // ── [Phase 6 §Cross-Tab Lock] الـ _syncing وحده boolean عادي على كائن JS، نطاقه
  // تبويب واحد فقط — لا يحمي من تبويبين لنفس الأصل يشغِّلان syncNow() في نفس اللحظة،
  // ما قد يُسبِّب سباقًا حقيقيًا على مفاتيح SyncQueue/SyncState المشترَكة في localStorage.
  // Web Locks API (navigator.locks) يوفّر قفلًا عابرًا للتبويبات أصيلًا في المتصفح؛
  // عند عدم توفره (متصفح قديم) نتراجع إلى localStorage lock-with-timestamp-and-owner-id
  // (معرّف مالك + مهلة انتهاء دفاعية، لمنع قفل "معلَّق" للأبد لو انهار تبويب مالك القفل).
  _CROSS_TAB_LOCK_NAME:'mshop-sync-lock',
  _CROSS_TAB_LOCK_FALLBACK_KEY:'mshop_sync_crosstab_lock',
  _CROSS_TAB_LOCK_STALE_MS:60000, // قفل fallback أقدم من دقيقة يُعتبَر معلَّقًا (تبويب مالكه انهار) ويُكسَر بأمان
  async _withCrossTabLock(fn){
    if(typeof navigator!=='undefined' && navigator.locks && typeof navigator.locks.request==='function'){
      let acquired=true;
      const outcome=await navigator.locks.request(this._CROSS_TAB_LOCK_NAME, {ifAvailable:true}, async (lock)=>{
        if(!lock){ acquired=false; return {ok:false, reason:'sync-already-in-progress'}; }
        return await fn();
      });
      return acquired ? outcome : {ok:false, reason:'sync-already-in-progress'};
    }
    // ── fallback لمتصفحات بلا Web Locks API ──
    const key=this._CROSS_TAB_LOCK_FALLBACK_KEY;
    const now=Date.now();
    let raw=null; try{ raw=Storage.getRaw(key); }catch(e){}
    if(raw){
      try{
        const lock=JSON.parse(raw);
        if(lock && (now-lock.at)<this._CROSS_TAB_LOCK_STALE_MS){
          return {ok:false, reason:'sync-already-in-progress'};
        }
      }catch(e){/* قفل تالف — يُعامَل كغير موجود */}
    }
    const ownerId=_syncGenUUID();
    try{ Storage.saveRaw(key, JSON.stringify({owner:ownerId, at:now})); }catch(e){}
    try{
      // تحقّق ثانٍ بعد الكتابة لتقليل نافذة السباق النظرية بين تبويبين كتبا في نفس اللحظة تقريبًا
      const check=JSON.parse(Storage.getRaw(key)||'{}');
      if(check.owner!==ownerId) return {ok:false, reason:'sync-already-in-progress'};
      return await fn();
    } finally {
      try{
        const cur=JSON.parse(Storage.getRaw(key)||'{}');
        if(cur.owner===ownerId) Storage.saveRaw(key, '');
      }catch(e){}
    }
  },

  // ── [Phase 6 §Retry/Backoff] فشل شبكة فقط يُعاد جدولته تلقائيًا (exponential backoff
  // مع jitter، سقف 30 دقيقة). فشل auth/validation/permanent لا يُعاد تلقائيًا أبدًا —
  // يتطلب تدخلًا (إعادة تسجيل دخول، تصحيح بيانات) وليس مجرد إعادة محاولة عمياء ──
  _retryTimer:null,
  _backoffMs:30000,
  _BACKOFF_MAX_MS:1800000,
  scheduleRetry(errorClass){
    this.stopAutoRetry();
    if(errorClass!=='network'){ this._backoffMs=30000; return; } // لا إعادة محاولة تلقائية لغير أخطاء الشبكة
    const jitter=Math.random()*0.3*this._backoffMs;
    const delay=Math.min(this._backoffMs, this._BACKOFF_MAX_MS)+jitter;
    this._retryTimer=setTimeout(()=>{ this.syncNow(); }, delay);
    this._backoffMs=Math.min(this._backoffMs*2, this._BACKOFF_MAX_MS);
  },
  stopAutoRetry(){ if(this._retryTimer){ clearTimeout(this._retryTimer); this._retryTimer=null; } },
  resetBackoff(){ this._backoffMs=30000; },

  // ── خطافات مرتبطة الآن فعليًا بـ Repository.create/update/delete (db_integration.js) —
  // لكنها تبقى بلا أي أثر سلوكي ما دام enabled=false (الحالة الافتراضية والإنتاجية الحالية) ──
  afterSave(entityType, entityId, payload){ this._notify('create', entityType, entityId, payload); },
  afterUpdate(entityType, entityId, payload){ this._notify('update', entityType, entityId, payload); },
  afterDelete(entityType, entityId){ this._notify('delete', entityType, entityId, null); },

  _notify(operationType, entityType, entityId, payload){
    if(!this.enabled) return;
    if(this._applyingRemote) return; // هذا التغيير أصله بعيد بالفعل — لا يُعاد رفعه كأنه محلي جديد
    if(!SYNC_ENTITY_ALLOWLIST.has(entityType)) return; // كيان خارج نطاق المزامنة عمدًا
    if(operationType==='delete') SyncTombstones.record(entityType, entityId, new Date().toISOString());
    SyncQueue.enqueue({operationType, entityType, entityId, payload});
  },

  // ── محرّك المزامنة الفعلي — يعمل فقط لو enabled=true ولديه provider ──
  // التسلسل: قفل (تبويب + قفل عابر للتبويبات، راجع _withLock) → رفع المعلَّق → تنزيل
  // مُقسَّم على صفحات (pagination) → فحص فجوات → فحص/حل تعارضات → تطبيق عبر Repository
  // → تقديم المؤشر لكل صفحة فقط بعد نجاح تطبيقها بالكامل → حفظ الحالة → تحرير القفل.
  async syncNow(){
    if(!this.enabled || !this.provider) return {ok:false, reason:'sync-disabled-or-no-provider'};
    if(this._syncing) return {ok:false, reason:'sync-already-in-progress'};
    const result=await this._withCrossTabLock(()=>this._syncNowLocked());
    // جدولة إعادة محاولة تلقائية فقط لأخطاء الشبكة القابلة لإعادة المحاولة بأمان
    if(result && result.ok) this.resetBackoff();
    else if(result && result.errorClass) this.scheduleRetry(result.errorClass);
    return result;
  },

  // [Phase 6] الجسم الفعلي لـ syncNow()، يعمل داخل قفل عابر للتبويبات (_withCrossTabLock)
  // بالإضافة لقفل _syncing المحلي داخل نفس التبويب (الأصلي، غير مُعدَّل في سلوكه).
  async _syncNowLocked(){
    this._syncing=true;
    const startedAt=new Date().toISOString(); const t0=(typeof performance!=='undefined'?performance.now():Date.now());
    const result={ok:false, uploaded:0, downloaded:0, conflicts:0, applied:0, failed:0, pages:0, error:null, errorClass:null};
    try{
      const state=SyncState.get();

      // 1) رفع الدفعة المعلَّقة (لو وُجدت)
      const batch=SyncQueue.dequeuePendingBatch(100);
      if(batch.length){
        SyncQueue.markProcessing(batch.map(o=>o.operationId));
        let uploadAck;
        try{ uploadAck=await this.provider.uploadBatch(batch); }
        catch(e){
          batch.forEach(op=>SyncQueue.markFailed(op.operationId, e.message));
          result.error='upload-failed: '+e.message; result.errorClass=_syncClassifyError(e);
          SyncState.set({lastError:result.error, lastSyncTime:new Date().toISOString(), connectionStatus:'error'});
          _syncLog('sync-completed', {...result, durationMs:_syncElapsed(t0)});
          return result;
        }
        (uploadAck.results||[]).forEach(r=>{
          if(r.ok){ SyncQueue.markSynced(r.operationId, r.serverRevision); result.uploaded++; }
          else { SyncQueue.markFailed(r.operationId, r.error||'upload-rejected'); result.failed++; }
        });
      }

      // 2) تنزيل مُقسَّم على صفحات — يتقدّم المؤشر فقط بعد نجاح تطبيق كل صفحة كاملة،
      //    وليس دفعة واحدة ضخمة غير مُقسَّمة كما في التصميم الأولي (Phase 5).
      let cursor=state.syncGeneration||0;
      let hasMore=true, resyncAttempted=false;
      while(hasMore){
        let downloadResp;
        try{ downloadResp=await this.provider.downloadChanges(cursor, 200); }
        catch(e){
          result.error='download-failed: '+e.message; result.errorClass=_syncClassifyError(e);
          SyncState.set({lastError:result.error, lastSyncTime:new Date().toISOString(), connectionStatus:'error'});
          result.ok = batch.length>0 && result.failed===0; // الرفع نجح حتى لو فشل التنزيل هذه الدورة
          _syncLog('sync-completed', {...result, durationMs:_syncElapsed(t0)});
          return result;
        }
        if(downloadResp.ok===false){
          if(downloadResp.code==='CURSOR_TOO_OLD' && !resyncAttempted){
            // [Phase 6 §Cursor Too Old] سجل التغييرات لم يعد يحتفظ بهذا المؤشر — لا يعني
            // هذا أن التغييرات التاريخية "غير موجودة"، بل أن full resync من current-state
            // مطلوب بدلًا من الاعتماد على السجل التزايدي لهذه الدورة فقط. مرة واحدة فقط
            // لمنع أي حلقة لا نهائية لو استمر السيرفر في رفض المؤشر الجديد أيضًا.
            resyncAttempted=true; cursor=0; SyncState.set({connectionStatus:'resyncing'}); continue;
          }
          result.error='download-rejected: '+(downloadResp.code||'unknown');
          result.errorClass = downloadResp.code==='CURSOR_TOO_OLD' ? 'cursor-too-old' : 'unknown';
          SyncState.set({lastError:result.error, lastSyncTime:new Date().toISOString(), connectionStatus:'error'});
          _syncLog('sync-completed', {...result, durationMs:_syncElapsed(t0)});
          return result;
        }

        // [Phase 6 §Gap Detection] الـ logRevision لكل عنصر يجب أن يكون تسلسلًا متصلًا
        // تمامًا بدءًا من cursor+1 — أي فجوة تعني فقدان بيانات حقيقي في سجل التغييرات،
        // وليس مجرد كيان تم تجاوزه شرعيًا (ذلك موجود بالفعل في current-state، لا في الـ
        // log نفسه). لا نتجاهل الفجوة أبدًا ولا نتقدّم بالمؤشر فوقها بصمت.
        const revisions=(downloadResp.changes||[]).map(c=>c.logRevision).filter(r=>typeof r==='number').sort((a,b)=>a-b);
        let expected=cursor+1;
        for(const rev of revisions){
          if(rev!==expected){
            result.error=`cursor-gap: expected revision ${expected}, got ${rev}`;
            result.errorClass='cursor-gap';
            SyncState.set({lastError:result.error, lastSyncTime:new Date().toISOString(), connectionStatus:'error'});
            _syncLog('sync-completed', {...result, durationMs:_syncElapsed(t0)});
            return result; // لا تقدُّم للمؤشر — يُعاد المحاولة من نفس النقطة لاحقًا
          }
          expected=rev+1;
        }

        const pageChanges=(downloadResp.changes||[]).filter(_syncValidateRemoteChange).filter(c=>SYNC_ENTITY_ALLOWLIST.has(c.entityType));
        result.downloaded+=pageChanges.length;

        // 3) لكل تغيير بعيد في هذه الصفحة: تومبستون → تعارض → تطبيق عبر Repository فقط
        // (كل تطبيق يمر عبر _applyingRemote=true حتى لا يُعاد تسجيله في الطابور المحلي
        // للرفع من جديد — راجع _notify أعلاه — وإلا يتحوّل كل تنزيل "صدى" لرفع تالٍ)
        for(const remoteChange of pageChanges){
          if(remoteChange.deleted){
            if(SyncTombstones.isSuperseded(remoteChange.entityType, remoteChange.entityId, remoteChange.clientTimestamp)){ continue; }
            SyncTombstones.record(remoteChange.entityType, remoteChange.entityId, remoteChange.clientTimestamp);
            this._applyingRemote=true;
            try{ await _syncApplyDelete(remoteChange); result.applied++; }
            catch(e){ result.failed++; }
            finally{ this._applyingRemote=false; }
            continue;
          }
          if(SyncTombstones.isSuperseded(remoteChange.entityType, remoteChange.entityId, remoteChange.clientTimestamp)){ continue; } // إحياء سجل محذوف محليًا — مرفوض

          const localCandidate=SyncQueue.list().find(o=>o.entityId===remoteChange.entityId && o.entityType===remoteChange.entityType && o.status===SyncQueue.STATUS.SYNCED);
          const conflict=SyncConflictResolver.detectConflict(localCandidate, remoteChange);
          if(conflict.hasConflict){
            result.conflicts++;
            const resolution=SyncConflictResolver.resolveConflict(localCandidate, remoteChange);
            if(resolution.winner!==remoteChange) continue; // المحلي فاز بـ LWW — لا تُطبَّق نسخة الخادم
          }
          this._applyingRemote=true;
          try{ await _syncApplyUpsert(remoteChange); result.applied++; }
          catch(e){ result.failed++; }
          finally{ this._applyingRemote=false; }
        }

        // 4) يتقدّم المؤشر فقط بعد نجاح تطبيق هذه الصفحة بالكامل (لا تقدُّم جزئي مبكر) —
        //    يُحفَظ فورًا حتى لو انهار التبويب قبل طلب الصفحة التالية، فلا تُعاد نفس
        //    الصفحة إلا لو فشل التطبيق فعليًا (idempotent بأي الأحوال — راجع Section 9).
        cursor=downloadResp.nextCursor!=null ? downloadResp.nextCursor : cursor;
        SyncState.set({syncGeneration:cursor});
        result.pages++;
        hasMore=!!downloadResp.hasMore;
      }

      SyncState.set({lastSyncTime:new Date().toISOString(), lastError:null, connectionStatus:'online'});
      result.ok=true;
      _syncLog('sync-completed', {...result, durationMs:_syncElapsed(t0)});
      // RC-2: refresh UI after remote changes applied so Device B sees them immediately
      if(result.applied>0){
        try{if(typeof loadAll==='function')loadAll();}catch(e){}
        try{if(typeof loadData==='function')loadData();}catch(e){}
        try{if(typeof renderAll==='function')renderAll();}catch(e){}
        try{if(typeof renderInvWidget==='function')renderInvWidget();}catch(e){}
      }
      return result;
    } finally {
      this._syncing=false;
    }
  },
  getStatus(){ return SyncState.get(); },
  getQueueSnapshot(){ return SyncQueue.list(); },
  getTelemetry(){ return Storage.get(SYNC_TELEMETRY_KEY, []); },

  // ── [Phase 6 §Sync Triggers] Periodic + Manual + on-reconnect فقط — بلا realtime/
  // WebSocket (غير مبرَّر لتطبيق محل واحد، راجع ADR-005 §Realtime vs Periodic). كل
  // مشغِّل هنا آمن تمامًا استدعاؤه دائمًا: syncNow() نفسها ترفض العمل فورًا ما لم يكن
  // enabled=true وprovider موجودًا — فتفعيل هذه المشغِّلات لا أثر له إطلاقًا اليوم.
  _autoSyncTimer:null,
  _onlineListener:null,
  startAutoSync(intervalMs){
    this.stopAutoSync();
    const period=intervalMs || 5*60*1000; // كل 5 دقائق افتراضيًا
    this._autoSyncTimer=setInterval(()=>{ this.syncNow(); }, period);
    if(typeof window!=='undefined'){
      this._onlineListener=()=>{ this.resetBackoff(); this.syncNow(); };
      window.addEventListener('online', this._onlineListener);
    }
  },
  stopAutoSync(){
    if(this._autoSyncTimer){ clearInterval(this._autoSyncTimer); this._autoSyncTimer=null; }
    if(this._onlineListener && typeof window!=='undefined'){ window.removeEventListener('online', this._onlineListener); this._onlineListener=null; }
    this.stopAutoRetry();
  },
};

// ── [Phase 6 §Sync Status UI] عرض آمن فقط — بلا كشف أي token/password/encryption
// key/حمولة مالية كاملة. يعكس الحقول الآمنة الموجودة أصلًا في SyncState/SyncQueue ──
function renderSyncStatus(){
  const el=(typeof $==='function') ? $('sync-status-widget') : (typeof document!=='undefined' ? document.getElementById('sync-status-widget') : null);
  if(!el) return;
  if(typeof SyncManager==='undefined'){ el.textContent='غير متاح'; return; }
  if(!SyncManager.enabled){
    el.innerHTML='⚪ المزامنة غير مُفعَّلة حاليًا (قيد التطوير المعماري — لا يوجد مزوّد إنتاجي متصل بعد)';
    return;
  }
  const st=SyncManager.getStatus();
  const pending=SyncQueue.countByStatus(SyncQueue.STATUS.PENDING);
  const statusMap={
    online:'🟢 متصل', offline:'⚪ غير متصل', error:'🔴 خطأ في المزامنة',
    resyncing:'🟡 إعادة مزامنة كاملة جارية',
  };
  const parts=[
    statusMap[st.connectionStatus]||('⚪ '+(st.connectionStatus||'غير معروف')),
    SyncManager._syncing ? '⏳ جاري المزامنة الآن' : null,
    pending>0 ? `📋 ${pending} عملية معلَّقة` : null,
    st.lastSyncTime ? `آخر مزامنة: ${new Date(st.lastSyncTime).toLocaleString('ar-EG')}` : 'لم تتم أي مزامنة بعد',
    st.lastError ? `⚠️ ${st.lastError}` : null,
  ].filter(Boolean);
  el.innerHTML=parts.join('<br>');
}
