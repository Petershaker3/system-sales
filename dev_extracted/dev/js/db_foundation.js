// ═══════════════════════════════════════════════════════════
// db_foundation.js — Phase 5: Database Foundation (Architecture Only)
// ═══════════════════════════════════════════════════════════
// كل ما في هذا الملف هيكل معماري ودوال نقية (Pure Functions) فقط.
// لا شيء هنا مربوط بأي تدفق حالي في التطبيق، ولا يُستدعى من أي مكان
// آخر في الكود. الهدف الوحيد: تجهيز الأساس المعماري المعتمَد
// (Phase 4.5 / 4.5A) بحيث يكون جاهزًا للربط الفعلي مستقبلًا
// بخطوة واحدة بسيطة، دون أي تغيير في سلوك النظام الحالي.
//
// النظام يبقى Offline-First بالكامل. لا اتصال شبكة. لا SQL. لا Supabase.
// localStorage عبر Storage API يبقى المصدر الوحيد الفعلي للبيانات اليوم.

// ══ 1) النموذج المُوجَّه بالمعاملات — أسماء الكيانات المعتمَدة ══
// مرجع توثيقي فقط — لا يُستخدَم لإعادة تسمية أي مفتاح localStorage حالي
const DB_ENTITY_NAMES = Object.freeze({
  phoneTransactions: 'phone_transactions',
  usedPhoneTransactions: 'used_phone_transactions',
  accessoryTransactions: 'accessory_transactions',
  softwareTransactions: 'software_transactions',
  walletTransactions: 'wallet_transactions',
  repairs: 'repairs',
  expenses: 'expenses',
  categories: 'categories',
  brands: 'brands',
  repairParts: 'repair_parts',
  faultTypes: 'fault_types',
  notes: 'notes',
  notifications: 'notifications',
  settings: 'settings',
  dailySummary: 'daily_summary',
  walletBalances: 'wallet_balances',
  devices: 'devices',
  auditLog: 'audit_log',
  schemaMeta: 'schema_meta',
});

// أنواع المعاملات المعتمَدة — بديل مستقبلي لعلم _rolled الحالي
const DB_TRANSACTION_TYPES = Object.freeze({
  SALE: 'sale',
  RETURN: 'return',
  EXCHANGE: 'exchange',
  RESERVATION: 'reservation',
  ADJUSTMENT: 'adjustment',
  ROLLBACK: 'rollback',
});

// يبني "شكل" سجل معاملة مستقبلي بالنموذج المعتمَد — دالة نقية توثيقية،
// لا تُنشئ أي سجل فعلي ولا تُستدعى من أي تدفق حالي في التطبيق.
// ملاحظة: لم يُنفَّذ سلوك التراجع الفعلي بعد (كما طُلب صراحة) — هذا الشكل فقط.
function buildTransactionRecordShape({entityType, transactionType, relatedTransactionId=null, payload={}}) {
  return {
    id: null, // يُملأ بـ UUID عند التنفيذ الفعلي مستقبلًا
    entityType,
    transactionType, // أحد قيم DB_TRANSACTION_TYPES
    relatedTransactionId, // يشير لمعاملة أصلية عند rollback/return/exchange
    ...createTimestampFields(),
    ...createOwnershipFieldsShape(),
    version: INITIAL_VERSION,
    payload,
  };
}

// ══ 2) الملخص اليومي — تجهيز مفهومَي التحديث التراكمي وإعادة البناء الكامل ══
// شكل مرجعي لصف daily_summary مستقبلي
const DAILY_SUMMARY_SHAPE = Object.freeze({
  shopId: null, date: null,
  totalSales: 0, totalProfit: 0, totalExpenses: 0, netProfit: 0,
  transactionCount: 0, updatedAt: null,
});

// إعادة بناء كاملة من معاملات خام — دالة نقية (Pure): تستقبل مصفوفة معاملات
// وتُرجع ملخصًا محسوبًا بالكامل، بدون أي قراءة/كتابة لأي تخزين.
// هذا يطابق تمامًا مبدأ "المعاملات الخام هي مصدر الحقيقة الوحيد" المعتمَد.
function rebuildDailySummaryFromTransactions(transactions=[]) {
  const active = transactions.filter(t => !t.deletedAt && t.transactionType !== DB_TRANSACTION_TYPES.ROLLBACK);
  const totalSales = active.reduce((s,t)=> s + (t.saleAmount||0), 0);
  const totalProfit = active.reduce((s,t)=> s + (t.profit||0), 0);
  const totalExpenses = active.reduce((s,t)=> s + (t.expenseAmount||0), 0);
  return {
    ...DAILY_SUMMARY_SHAPE,
    totalSales, totalProfit, totalExpenses,
    netProfit: totalProfit - totalExpenses,
    transactionCount: active.length,
    updatedAt: new Date().toISOString(),
  };
}

// تحديث تراكمي (Delta) — دالة نقية تُطبِّق فرقًا واحدًا على ملخص موجود
// بدل إعادة حساب الكل؛ يُستخدَم مستقبلًا وقت كل معاملة جديدة فرديًا.
function applyDailySummaryDelta(currentSummary, delta={}) {
  return {
    ...currentSummary,
    totalSales: (currentSummary.totalSales||0) + (delta.saleAmount||0),
    totalProfit: (currentSummary.totalProfit||0) + (delta.profit||0),
    totalExpenses: (currentSummary.totalExpenses||0) + (delta.expenseAmount||0),
    netProfit: (currentSummary.totalProfit||0) + (delta.profit||0) - ((currentSummary.totalExpenses||0) + (delta.expenseAmount||0)),
    transactionCount: (currentSummary.transactionCount||0) + 1,
    updatedAt: new Date().toISOString(),
  };
}

// ══ 3) أرصدة المحافظ — Delta-based فقط، صفر قيم مطلقة ══
const WALLET_BALANCE_SHAPE = Object.freeze({ shopId:null, walletId:null, balance:0, updatedAt:null });

// إعادة بناء كاملة (نفس منطق getWalletBalance الحالي، معزول كدالة نقية توثيقية)
function rebuildWalletBalanceFromTransactions(walletTransactions=[], openingBalance=0) {
  const active = walletTransactions.filter(t => !t.deletedAt);
  const balance = active.reduce((bal, t) => {
    if (t.transactionType === DB_TRANSACTION_TYPES.ROLLBACK) return bal;
    return bal + (t.cashType === 'ايداع' ? (t.amount||0) : -(t.amount||0));
  }, openingBalance);
  return { ...WALLET_BALANCE_SHAPE, balance, updatedAt: new Date().toISOString() };
}

// تطبيق فرق واحد (لا تعيين قيمة مطلقة أبدًا) — آمن للدمج بين أجهزة متعددة
function applyWalletBalanceDelta(currentBalance, deltaAmount) {
  return { ...currentBalance, balance: (currentBalance.balance||0) + deltaAmount, updatedAt: new Date().toISOString() };
}

// ══ 4) سجل التدقيق — تجهيز الشكل فقط، بدون أي تسجيل فعلي أو واجهة ══
function buildAuditLogEntryShape({eventType, entityType, entityId, oldValue=null, newValue=null}) {
  return {
    id: null, shopId: null, eventType, entityType, entityId,
    oldValue, newValue, // JSON snapshots كما طُلب
    createdAt: new Date().toISOString(),
    createdBy: null, // Placeholder — لا مصادقة بعد
    // ملاحظة معمارية: الكتابة الفعلية مستقبلًا يجب أن تكون من الخادم فقط (Append-Only)
    // — هذا الملف لا يكتب لأي مكان، فقط يوثّق الشكل المتوقَّع.
  };
}

// ══ 5) الحذف الناعم — الحقول المعتمَدة (لم تُطبَّق على أي جدول فعليًا بعد) ══
const SOFT_DELETE_FIELDS_SHAPE = Object.freeze({ deletedAt: null, deletedBy: null, deletedReason: null });
// ملاحظة: مفهوم "v_trash" الموحّد (View تجميعي عبر كل الكيانات القابلة للحذف)
// هو تصميم قاعدة بيانات مستقبلي (SQL VIEW) — لا يُنفَّذ هنا إطلاقًا.
// سلة المحذوفات الحالية (mshop_trash) تبقى تعمل بالضبط كما هي، بدون أي تعديل.

function markDeletedShape(record, {deletedBy=null, deletedReason=null}={}) {
  return { ...record, deletedAt: new Date().toISOString(), deletedBy, deletedReason };
}

// ══ 6) الأجهزة — بيانات وصفية موسّعة (شكل فقط) ══
const DEVICE_METADATA_SHAPE = Object.freeze({
  platform: null, browser: null, operatingSystem: null,
  applicationVersion: null, lastSeen: null, deviceName: null,
});

// ══ 7) بيانات الملكية — محجوزة لدعم تعدد مستخدمين مستقبلي ══
function createOwnershipFieldsShape() {
  return { createdBy: null, updatedBy: null }; // null = لا يوجد نظام مستخدمين فعلي بعد
}

// ══ A) اتفاقية الطوابع الزمنية الموحّدة ══
function createTimestampFields() {
  const now = new Date().toISOString();
  return { createdAt: now, updatedAt: now };
}
function touchUpdatedAt(record) {
  return { ...record, updatedAt: new Date().toISOString() };
}

// ══ B) التزامن التفاؤلي (Optimistic Concurrency) عبر version ══
const INITIAL_VERSION = 1;
function incrementVersion(record) {
  return { ...record, version: (record.version||INITIAL_VERSION) + 1, updatedAt: new Date().toISOString() };
}

// ══ قاعدة اللقطة التاريخية (Historical Snapshot) ══
// يستخرج نسخة "لحظية" من حقول مرجعية (اسم منتج، فئة...) وقت المعاملة،
// بحيث تبقى ثابتة حتى لو تغيّر السجل الأصلي لاحقًا — تكرار متعمَّد ومعتمَد معماريًا.
function snapshotHistoricalFields(sourceRecord, fieldNames=[]) {
  const snapshot = {};
  fieldNames.forEach(f => { snapshot[f] = sourceRecord?.[f] ?? null; });
  return snapshot;
}

// ══ Schema Meta — إصدار بنية قاعدة البيانات نفسها (منفصل عن إصدار التطبيق/النسخ الاحتياطي) ══
const DEFAULT_SCHEMA_META = Object.freeze({ currentVersion: 1, appliedAt: null });

// ══ مفتاح Idempotency — يمنع تطبيق نفس العملية مرتين مستقبلًا ══
function generateOperationIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random()*16|0, v = c==='x' ? r : (r&0x3|0x8); return v.toString(16);
  });
}

// ══ حقول مخصَّصة اختيارية (custom_fields) — لكيانات محدَّدة فقط، بضوابط صارمة ══
const DB_CUSTOM_FIELDS_ALLOWED_ENTITIES = Object.freeze(['phones', 'repairs']);
// أي اسم حقل يبدو ماليًا/تقريريًا/قابلًا للفهرسة يُرفَض من custom_fields عمدًا —
// هذه الحقول يجب أن تبقى أعمدة حقيقية دائمًا، لا JSON حر.
const DB_CUSTOM_FIELDS_BLOCKLIST = Object.freeze([
  'price','buyprice','sellprice','profit','amount','sell','cost','total','balance','qty','quantity',
]);
function validateCustomFields(entityType, customFieldsObj={}) {
  if (!DB_CUSTOM_FIELDS_ALLOWED_ENTITIES.includes(entityType)) {
    return { valid:false, reason:`custom_fields غير مسموح لهذا الكيان: ${entityType}` };
  }
  const badKey = Object.keys(customFieldsObj).find(k =>
    DB_CUSTOM_FIELDS_BLOCKLIST.some(blocked => k.toLowerCase().includes(blocked))
  );
  if (badKey) {
    return { valid:false, reason:`الحقل "${badKey}" يبدو ماليًا/تقريريًا — يجب أن يكون عمودًا حقيقيًا، لا custom_fields` };
  }
  return { valid:true };
}
