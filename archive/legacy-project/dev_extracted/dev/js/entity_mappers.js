// ═══════════════════════════════════════════════════════════
// entity_mappers.js — Phase 6.5: Domain Model & Entity Mapping
// ═══════════════════════════════════════════════════════════
// طبقة تحويل بنيوي بحت (Structural Mapping) بين الشكل المحلي الحالي
// (كما هو مُخزَّن اليوم عبر Storage API) والشكل المستقبلي المعتمَد
// لقاعدة البيانات (Phase 4.5 / 4.5A). هذا الملف:
//   • لا يقرأ ولا يكتب أي تخزين إطلاقًا (لا Storage، لا localStorage).
//   • لا يتصل بأي شبكة.
//   • لا يُعدِّل أي كائن وقت التشغيل (Runtime) — كل تحويل يُنتج نسخة جديدة.
//   • لا يحتوي أي منطق عمل (لا حساب ربح، لا إجماليات، لا أرصدة، لا مزامنة، لا نسخ احتياطي).
//   • غير مربوط بأي Repository أو منطق عمل حالي — معزول بالكامل.
//
// إعادة استخدام مقصودة: يعتمد هذا الملف على ثوابت db_foundation.js
// (DB_ENTITY_NAMES, DB_TRANSACTION_TYPES, INITIAL_VERSION, ...) ونموذج
// الأخطاء DatabaseError من db_integration.js — بدل تكرارها، تمامًا
// كما طلبت التعليمات ("Do not create another validation or error system").

// ══ ثوابت مشتركة إضافية خاصة بطبقة التحويل ══════════════════
const MAPPER_RESERVED_FIELD_NAMES = Object.freeze([
  'id','version','shopId','deviceId','createdAt','updatedAt',
  'createdBy','updatedBy','deletedAt','deletedBy','deletedReason','syncGeneration',
]);
const MAPPER_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ══ المبدأ المعماري الحاكم لكل هذا الملف (توثيقي، بلا أي تنفيذ) ══
// • المعاملات الخام هي مصدر الحقيقة الوحيد.
// • daily_summary مُشتَق دائمًا — هذه الطبقة لا تحسبه، فقط تحوّل شكله البنيوي عند الحاجة.
// • أرصدة المحافظ (wallet_balances) مُشتقة دائمًا — نفس المبدأ.
// • التقارير مُشتقة دائمًا من المعاملات عبر المحرك المالي الموحّد (Phase 2B) — غير موجود هنا.
// • أي بيانات مُشتقة لا تصبح مصدر حقيقة أبدًا، ولا تُزامَن مباشرة أبدًا.

// ══ المُحوِّل الأساسي المجرَّد (Base Mapper) ══════════════════
class EntityMapper {
  toDatabase(localObject) {
    throw new DatabaseError(DB_ERROR_CODES.NOT_IMPLEMENTED, `${this.constructor.name}.toDatabase() غير مُنفَّذة`);
  }
  fromDatabase(databaseObject) {
    throw new DatabaseError(DB_ERROR_CODES.NOT_IMPLEMENTED, `${this.constructor.name}.fromDatabase() غير مُنفَّذة`);
  }
  validate(entity) {
    throw new DatabaseError(DB_ERROR_CODES.NOT_IMPLEMENTED, `${this.constructor.name}.validate() غير مُنفَّذة`);
  }
  // نسخ عميق قياسي — لا يُعدِّل الكائن الأصلي أبدًا، مشترك لكل المحوّلات
  clone(entity) {
    return entity == null ? entity : JSON.parse(JSON.stringify(entity));
  }

  // ── أدوات مساعدة مشتركة (بدون منطق خاص بكيان معيّن) ──
  _buildStandardMetadata(overrides = {}) {
    return {
      id: overrides.id ?? null,
      version: overrides.version ?? INITIAL_VERSION,
      shopId: overrides.shopId ?? null,
      deviceId: overrides.deviceId ?? null,
      createdAt: overrides.createdAt ?? null,
      updatedAt: overrides.updatedAt ?? null,
      createdBy: overrides.createdBy ?? null,
      updatedBy: overrides.updatedBy ?? null,
      deletedAt: overrides.deletedAt ?? null,
      deletedBy: overrides.deletedBy ?? null,
      deletedReason: overrides.deletedReason ?? null,
      syncGeneration: overrides.syncGeneration ?? null,
    };
  }
  _requireFields(entity, fields, entityName) {
    const missing = fields.filter(f => entity?.[f] === undefined || entity?.[f] === null || entity?.[f] === '');
    if (missing.length) {
      throw new DatabaseError(DB_ERROR_CODES.VALIDATION_ERROR, `${entityName}: حقول مطلوبة مفقودة: ${missing.join(', ')}`);
    }
  }
  _validateEnum(value, allowedValues, fieldName, entityName) {
    if (value != null && !allowedValues.includes(value)) {
      throw new DatabaseError(DB_ERROR_CODES.VALIDATION_ERROR, `${entityName}: قيمة غير صالحة لـ"${fieldName}": "${value}" (المسموح: ${allowedValues.join('/')})`);
    }
  }
  _validateUUIDIfPresent(value, fieldName, entityName) {
    if (value == null) return;
    if (!MAPPER_UUID_PATTERN.test(value)) {
      throw new DatabaseError(DB_ERROR_CODES.VALIDATION_ERROR, `${entityName}: "${fieldName}" ليس UUID صالحًا: "${value}"`);
    }
  }
  _combineDateTime(dateStr, timeStr) {
    // دمج تاريخ+وقت نصيَّين (كما هما مُخزَّنان اليوم) لطابع زمني تقديري — لا يُنشئ بيانات جديدة، فقط يعيد تشكيل الموجود
    if (!dateStr) return null;
    return timeStr ? `${dateStr}T${timeStr}` : dateStr;
  }
}

// ══ محوّل أساسي مشترك لكل المعاملات (Transaction Types) ══════
// يقلّل التكرار بين الـ5 محوّلات المعاملاتية دون تغيير عددها أو أسمائها المطلوبة
class TransactionMapperBase extends EntityMapper {
  _validateTransactionCommon(entity, entityName) {
    this._validateEnum(entity.transactionType, Object.values(DB_TRANSACTION_TYPES), 'transactionType', entityName);
    this._validateUUIDIfPresent(entity.relatedTransactionId, 'relatedTransactionId', entityName);
    // بديل _rolled: لو transactionType==='rollback' يجب وجود relatedTransactionId يشير للأصل
    if (entity.transactionType === DB_TRANSACTION_TYPES.ROLLBACK && !entity.relatedTransactionId) {
      throw new DatabaseError(DB_ERROR_CODES.VALIDATION_ERROR, `${entityName}: معاملة rollback تتطلب relatedTransactionId`);
    }
  }
}

// ══ PhoneMapper — كتالوج الهواتف (mshop_inventory) ═══════════
// محلي: {id, brand, model, ram, storage, color, internalCode, qty, buyPrice, supplier, notes, addedDate, lastBuyDate, purchaseHistory[], archived?, favorite?}
// قاعدة بيانات: نفس الحقول + بيانات وصفية قياسية. لا لقطة تاريخية هنا (هذا هو "السجل الرئيسي" نفسه الذي تُؤخَذ منه اللقطات).
class PhoneMapper extends EntityMapper {
  toDatabase(local) {
    return {
      id: local.id ?? null,
      brand: local.brand ?? null, model: local.model ?? null,
      ram: local.ram ?? null, storage: local.storage ?? null, color: local.color ?? null,
      internalCode: local.internalCode ?? null, qty: local.qty ?? 0, buyPrice: local.buyPrice ?? 0,
      supplier: local.supplier ?? null, notes: local.notes ?? null,
      archived: local.archived ?? false, favorite: local.favorite ?? false,
      purchaseHistory: Array.isArray(local.purchaseHistory) ? local.purchaseHistory.map(h => ({...h})) : [],
      ...this._buildStandardMetadata({ id: local.id, createdAt: local.addedDate, updatedAt: local.lastBuyDate }),
    };
  }
  fromDatabase(db) {
    return {
      id: db.id, brand: db.brand, model: db.model, ram: db.ram, storage: db.storage, color: db.color,
      internalCode: db.internalCode, qty: db.qty, buyPrice: db.buyPrice, supplier: db.supplier, notes: db.notes,
      addedDate: db.createdAt, lastBuyDate: db.updatedAt,
      purchaseHistory: Array.isArray(db.purchaseHistory) ? db.purchaseHistory.map(h => ({...h})) : [],
      archived: !!db.archived, favorite: !!db.favorite,
    };
  }
  validate(entity) {
    this._requireFields(entity, ['brand', 'model'], 'PhoneMapper');
    this._validateUUIDIfPresent(entity.id, 'id', 'PhoneMapper');
  }
}

// ══ PhoneTransactionMapper — بيع هاتف جديد (من data.phones[] اليومية) ══
// محلي: {modelId, modelName, qty, sellPrice, profit, time, _rolled?, date?}
// قاعدة بيانات: transactionType بدل _rolled. snapshotModelName = لقطة تاريخية لاسم الموديل وقت البيع (لا يتغيّر لو اتغيّر اسم الموديل لاحقًا).
class PhoneTransactionMapper extends TransactionMapperBase {
  toDatabase(local) {
    return {
      id: null, phoneId: local.modelId ?? null,
      snapshotModelName: local.modelName ?? null, // ── لقطة تاريخية إلزامية ──
      qty: local.qty ?? 1, sellPrice: local.sellPrice ?? 0, profit: local.profit ?? 0,
      transactionType: local._rolled ? DB_TRANSACTION_TYPES.ROLLBACK : DB_TRANSACTION_TYPES.SALE,
      relatedTransactionId: null, // يُملأ فعليًا وقت التنفيذ الحقيقي المستقبلي فقط
      ...this._buildStandardMetadata({ createdAt: this._combineDateTime(local.date, local.time) }),
    };
  }
  fromDatabase(db) {
    return {
      modelId: db.phoneId, modelName: db.snapshotModelName, qty: db.qty,
      sellPrice: db.sellPrice, profit: db.profit,
      time: (db.createdAt || '').split('T')[1] || null,
      date: (db.createdAt || '').split('T')[0] || null,
      _rolled: db.transactionType === DB_TRANSACTION_TYPES.ROLLBACK || undefined,
    };
  }
  validate(entity) {
    this._requireFields(entity, ['modelId', 'modelName'], 'PhoneTransactionMapper');
    this._validateTransactionCommon(entity, 'PhoneTransactionMapper');
  }
}

// ══ UsedPhoneTransactionMapper — بيع مستعمل (data.used[]) ══════
// محلي: {name, sell, profit, time, note?, _rolled?}
class UsedPhoneTransactionMapper extends TransactionMapperBase {
  toDatabase(local) {
    return {
      id: null, snapshotName: local.name ?? null, sellAmount: local.sell ?? 0, profit: local.profit ?? 0,
      note: local.note ?? null,
      transactionType: local._rolled ? DB_TRANSACTION_TYPES.ROLLBACK : DB_TRANSACTION_TYPES.SALE,
      relatedTransactionId: null,
      ...this._buildStandardMetadata({ createdAt: this._combineDateTime(null, local.time) }),
    };
  }
  fromDatabase(db) {
    return {
      name: db.snapshotName, sell: db.sellAmount, profit: db.profit, note: db.note,
      time: (db.createdAt || '').split('T').pop() || null,
      _rolled: db.transactionType === DB_TRANSACTION_TYPES.ROLLBACK || undefined,
    };
  }
  validate(entity) {
    this._requireFields(entity, ['name'], 'UsedPhoneTransactionMapper');
    this._validateTransactionCommon(entity, 'UsedPhoneTransactionMapper');
  }
}

// ══ AccessoryTransactionMapper — بيع اكسسوار (data.acc[]) ══════
// محلي: {name, mainCat, buy, sell, profit, time, qty?, _rolled?, _rollInfo?}
class AccessoryTransactionMapper extends TransactionMapperBase {
  toDatabase(local) {
    return {
      id: null, snapshotName: local.name ?? null, snapshotCategory: local.mainCat ?? null,
      buyAmount: local.buy ?? 0, sellAmount: local.sell ?? 0, profit: local.profit ?? 0,
      qty: local.qty ?? null, // قد تكون null (الكمية اختيارية أصلًا في النظام الحالي)
      transactionType: local._rolled ? DB_TRANSACTION_TYPES.ROLLBACK : DB_TRANSACTION_TYPES.SALE,
      relatedTransactionId: null,
      ...this._buildStandardMetadata({ createdAt: this._combineDateTime(null, local.time) }),
    };
  }
  fromDatabase(db) {
    return {
      name: db.snapshotName, mainCat: db.snapshotCategory, buy: db.buyAmount, sell: db.sellAmount,
      profit: db.profit, qty: db.qty ?? undefined,
      time: (db.createdAt || '').split('T').pop() || null,
      _rolled: db.transactionType === DB_TRANSACTION_TYPES.ROLLBACK || undefined,
    };
  }
  validate(entity) {
    this._requireFields(entity, ['name'], 'AccessoryTransactionMapper');
    this._validateTransactionCommon(entity, 'AccessoryTransactionMapper');
  }
}

// ══ SoftwareTransactionMapper — عملية سوفت وير (data.sw[]) ══════
// محلي: {name, price, time, paid?, delivered?, note?, _rolled?}
class SoftwareTransactionMapper extends TransactionMapperBase {
  toDatabase(local) {
    return {
      id: null, snapshotName: local.name ?? null, amount: local.price ?? 0,
      paid: local.paid ?? false, delivered: local.delivered ?? false, note: local.note ?? null,
      transactionType: local._rolled ? DB_TRANSACTION_TYPES.ROLLBACK : DB_TRANSACTION_TYPES.SALE,
      relatedTransactionId: null,
      ...this._buildStandardMetadata({ createdAt: this._combineDateTime(null, local.time) }),
    };
  }
  fromDatabase(db) {
    return {
      name: db.snapshotName, price: db.amount, paid: !!db.paid, delivered: !!db.delivered, note: db.note,
      time: (db.createdAt || '').split('T').pop() || null,
      _rolled: db.transactionType === DB_TRANSACTION_TYPES.ROLLBACK || undefined,
    };
  }
  validate(entity) {
    this._requireFields(entity, ['name'], 'SoftwareTransactionMapper');
    this._validateTransactionCommon(entity, 'SoftwareTransactionMapper');
  }
}

// ══ WalletTransactionMapper — عملية كاش/محفظة (data.cash[]) ══════
// محلي: {cashType('ايداع'/'سحب'), service, amount, time, _rolled?}
class WalletTransactionMapper extends TransactionMapperBase {
  toDatabase(local) {
    return {
      id: null, walletName: local.service ?? null, // مرجع بالاسم اليوم — سيصبح walletId فعليًا بعد ترحيل حقيقي
      cashType: local.cashType ?? null, amount: local.amount ?? 0,
      transactionType: local._rolled ? DB_TRANSACTION_TYPES.ROLLBACK : DB_TRANSACTION_TYPES.ADJUSTMENT,
      relatedTransactionId: null,
      ...this._buildStandardMetadata({ createdAt: this._combineDateTime(null, local.time) }),
    };
  }
  fromDatabase(db) {
    return {
      service: db.walletName, cashType: db.cashType, amount: db.amount,
      time: (db.createdAt || '').split('T').pop() || null,
      _rolled: db.transactionType === DB_TRANSACTION_TYPES.ROLLBACK || undefined,
    };
  }
  validate(entity) {
    this._requireFields(entity, ['service', 'cashType'], 'WalletTransactionMapper');
    this._validateEnum(entity.cashType, ['ايداع', 'سحب'], 'cashType', 'WalletTransactionMapper');
    this._validateTransactionCommon(entity, 'WalletTransactionMapper');
  }
}

// ══ ExpenseMapper — مصروف (data.exp[]) — يبقى "expenses" وليس "_transactions" (قرار Phase 4.5A) ══
// محلي: {category, amount, time}
class ExpenseMapper extends EntityMapper {
  toDatabase(local) {
    return {
      id: null, snapshotCategory: local.category ?? null, amount: local.amount ?? 0,
      ...this._buildStandardMetadata({ createdAt: this._combineDateTime(null, local.time) }),
    };
  }
  fromDatabase(db) {
    return { category: db.snapshotCategory, amount: db.amount, time: (db.createdAt || '').split('T').pop() || null };
  }
  validate(entity) {
    this._requireFields(entity, ['category', 'amount'], 'ExpenseMapper');
  }
}

// ══ RepairMapper — أمر صيانة (كيان "أمر خدمة"، يبقى repairs وليس _transactions) ══
// محلي: {id, brand, model, faultType, servicePrice, profit, status, clientName?, clientPhone?, supplier?, partName?, notes?, fixed?, delivered?, paid?, statusHistory?, time, _rolled?}
//
// ⚠️ استثناء معماري موثَّق (قرار مُتعمَّد، وليس نقصًا عرضيًا في الهجرة):
// هذا الـ Mapper مكتمل ومُختبَر، لكنه غير مُسجَّل عمدًا تحت مفتاح 'repairTransactions'
// في ENTITY_MAPPERS_REGISTRY أدناه. تسجيله سيجعل RepairTransactionRepository._mapper()
// يبدأ فورًا بكتابة سجلات صيانة جديدة بصيغة DB-shape (snapshotBrand/…)، بينما كل سجلات
// الصيانة الحالية والقديمة محليّة الشكل بالكامل (brand/model/…) — وهذا سيُنتج نفس فئة
// عطل "DB-shape مقابل Local-shape" التي عولجت لبقية الكيانات، لكن هذه المرة في مسار
// الكتابة نفسه وليس القراءة فقط. القرار الحالي (الأكثر أمانًا للبيانات): إبقاء الصيانة
// محليّة الشكل بالكامل حتى تُتَّخذ خطوة هجرة منسَّقة (تسجيل Mapper + تحديث مسارات القراءة
// معًا في نفس التغيير، مع اختبار كامل) — وليس كإصلاح جانبي ضمن مهمة أخرى.
class RepairMapper extends EntityMapper {
  toDatabase(local) {
    return {
      id: local.id ?? null,
      snapshotBrand: local.brand ?? null, snapshotModel: local.model ?? null, // لقطة تاريخية
      snapshotFaultType: local.faultType ?? null, snapshotPartName: local.partName ?? null,
      servicePrice: local.servicePrice ?? 0, profit: local.profit ?? 0,
      status: local.status ?? null, clientName: local.clientName ?? null, clientPhone: local.clientPhone ?? null,
      supplier: local.supplier ?? null, notes: local.notes ?? null,
      fixed: local.fixed ?? false, delivered: local.delivered ?? false, paid: local.paid ?? false,
      statusHistory: Array.isArray(local.statusHistory) ? local.statusHistory.map(h => ({...h})) : [],
      isRolledBack: !!local._rolled, // بديل مؤقت — النموذج الكامل (rollback كمعاملة) لم يُطبَّق على repairs بعد
      ...this._buildStandardMetadata({ id: local.id, createdAt: this._combineDateTime(null, local.time) }),
    };
  }
  fromDatabase(db) {
    return {
      id: db.id, brand: db.snapshotBrand, model: db.snapshotModel, faultType: db.snapshotFaultType,
      partName: db.snapshotPartName, servicePrice: db.servicePrice, profit: db.profit, status: db.status,
      clientName: db.clientName, clientPhone: db.clientPhone, supplier: db.supplier, notes: db.notes,
      fixed: !!db.fixed, delivered: !!db.delivered, paid: !!db.paid,
      statusHistory: Array.isArray(db.statusHistory) ? db.statusHistory.map(h => ({...h})) : [],
      time: (db.createdAt || '').split('T').pop() || null,
      _rolled: db.isRolledBack || undefined,
    };
  }
  validate(entity) {
    this._requireFields(entity, ['brand', 'model'], 'RepairMapper');
  }
}

// ══ WalletMapper — تهيئة محفظة (اسم + حد + رصيد افتتاحي، من mshop_wallets) ══
// محلي (كما بناها WalletRepository في Phase 6): {name, limit, opening}
class WalletMapper extends EntityMapper {
  toDatabase(local) {
    return {
      id: null, name: local.name ?? null,
      limitAmount: local.limit ?? null, openingBalance: local.opening ?? 0,
      ...this._buildStandardMetadata({}),
    };
  }
  fromDatabase(db) {
    return { name: db.name, limit: db.limitAmount ?? null, opening: db.openingBalance ?? 0 };
  }
  validate(entity) {
    this._requireFields(entity, ['name'], 'WalletMapper');
  }
}

// ══ NoteMapper — ملاحظة/تذكير (mshop_notes) ══════════════════
// محلي: {id, title, content, type, priority, created, createdTime, done, doneDate, dueDate?, dueTime?, conditionData?}
class NoteMapper extends EntityMapper {
  toDatabase(local) {
    return {
      id: local.id ?? null, title: local.title ?? null, content: local.content ?? null,
      noteType: local.type ?? null, priority: local.priority ?? null,
      done: local.done ?? false, doneDate: local.doneDate ?? null,
      dueDate: local.dueDate ?? null, dueTime: local.dueTime ?? null,
      conditionData: local.conditionData ? { ...local.conditionData } : null,
      ...this._buildStandardMetadata({ id: local.id, createdAt: this._combineDateTime(local.created, local.createdTime) }),
    };
  }
  fromDatabase(db) {
    const [created, createdTime] = (db.createdAt || '').split('T');
    return {
      id: db.id, title: db.title, content: db.content, type: db.noteType, priority: db.priority,
      done: !!db.done, doneDate: db.doneDate, dueDate: db.dueDate, dueTime: db.dueTime,
      created: created || null, createdTime: createdTime || null,
      conditionData: db.conditionData ? { ...db.conditionData } : undefined,
    };
  }
  validate(entity) {
    this._requireFields(entity, ['title'], 'NoteMapper');
    this._validateEnum(entity.noteType, ['note', 'reminder', 'conditional'], 'noteType', 'NoteMapper');
    this._validateUUIDIfPresent(entity.id, 'id', 'NoteMapper');
  }
}

// ══ NotificationMapper — إشعار مُولَّد (mshop_notifs) ══════════
// محلي: {id, type, title, body, noteId?, matchInfo?, created, read}
class NotificationMapper extends EntityMapper {
  toDatabase(local) {
    return {
      id: local.id ?? null, notifType: local.type ?? null, title: local.title ?? null, body: local.body ?? null,
      relatedNoteId: local.noteId ?? null, matchInfo: local.matchInfo ?? null, read: local.read ?? false,
      ...this._buildStandardMetadata({ createdAt: local.created }),
    };
  }
  fromDatabase(db) {
    return {
      id: db.id, type: db.notifType, title: db.title, body: db.body,
      noteId: db.relatedNoteId ?? undefined, matchInfo: db.matchInfo ?? undefined,
      created: db.createdAt, read: !!db.read,
    };
  }
  validate(entity) {
    this._requireFields(entity, ['title', 'body'], 'NotificationMapper');
  }
}

// ══ CategoryMapper — فئة (اكسسوار/مستعمل/مصاريف) — محليًا نص بسيط اليوم ══
// محلي: string (اسم الفئة فقط، مصفوفة نصوص accCats/catA/catU/catE)
class CategoryMapper extends EntityMapper {
  toDatabase(local, categoryType = null) {
    // local هنا نص بسيط وليس كائنًا — حالة خاصة موثَّقة صراحة
    if (typeof local !== 'string') {
      throw new DatabaseError(DB_ERROR_CODES.VALIDATION_ERROR, 'CategoryMapper.toDatabase: يتوقع نصًا (اسم الفئة)');
    }
    return { id: null, name: local, categoryType, ...this._buildStandardMetadata({}) };
  }
  fromDatabase(db) {
    return db.name; // يعود لشكله الأصلي: نص بسيط
  }
  validate(entity) {
    this._requireFields(entity, ['name'], 'CategoryMapper');
  }
}

// ══ BrandMapper — ماركة (mshop_brands2_<type>) ══════════════
// محلي: {name, archived}
class BrandMapper extends EntityMapper {
  toDatabase(local, brandType = null) {
    return { id: null, name: local.name ?? null, brandType, archived: local.archived ?? false, ...this._buildStandardMetadata({}) };
  }
  fromDatabase(db) {
    return { name: db.name, archived: !!db.archived };
  }
  validate(entity) {
    this._requireFields(entity, ['name'], 'BrandMapper');
  }
}

// ══ RepairPartMapper — قطعة غيار (mshop_repair_parts) ══════════
// محلي: {id, name, compatible, qty, buyPrice, supplier}
class RepairPartMapper extends EntityMapper {
  toDatabase(local) {
    return {
      id: local.id ?? null, name: local.name ?? null, compatible: local.compatible ?? null,
      qty: local.qty ?? 0, buyPrice: local.buyPrice ?? 0, supplier: local.supplier ?? null,
      ...this._buildStandardMetadata({ id: local.id }),
    };
  }
  fromDatabase(db) {
    return { id: db.id, name: db.name, compatible: db.compatible, qty: db.qty, buyPrice: db.buyPrice, supplier: db.supplier };
  }
  validate(entity) {
    this._requireFields(entity, ['name'], 'RepairPartMapper');
  }
}

// ══ FaultTypeMapper — نوع عطل (mshop_fault_types) — محليًا {id, name, hidden} ══
class FaultTypeMapper extends EntityMapper {
  toDatabase(local) {
    return {
      id: local.id ?? null, name: local.name ?? null, hidden: local.hidden ?? false,
      ...this._buildStandardMetadata({ id: local.id }),
    };
  }
  fromDatabase(db) { return { id: db.id, name: db.name, hidden: db.hidden ?? false }; }
  validate(entity) { this._requireFields(entity, ['name'], 'FaultTypeMapper'); }
}

// ══ SettingsMapper — إعدادات المحل (mshop_cfg) ══════════════
// محلي: {name, passMain, passAdmin, adminTimeout, ...}
// ⚠️ ملاحظة أمنية موثَّقة (لا معالجة هنا): كلمتا المرور نص صريح اليوم في التخزين
// المحلي — هذا المحوّل ينقل البنية كما هي فقط، لا يُضيف ولا يُزيل أي حماية.
class SettingsMapper extends EntityMapper {
  toDatabase(local) {
    return {
      id: null, shopName: local.name ?? null,
      passMain: local.passMain ?? null, passAdmin: local.passAdmin ?? null,
      adminTimeoutMinutes: local.adminTimeout ?? null,
      ...this._buildStandardMetadata({}),
    };
  }
  fromDatabase(db) {
    return { name: db.shopName, passMain: db.passMain, passAdmin: db.passAdmin, adminTimeout: db.adminTimeoutMinutes };
  }
  validate(entity) {
    this._requireFields(entity, ['shopName'], 'SettingsMapper');
  }
}

// ══ DailySummaryMapper — تحويل بنيوي فقط، صفر حساب (مُشتَق دائمًا) ══
// محلي (شكل db_foundation.js DAILY_SUMMARY_SHAPE): {shopId,date,totalSales,totalProfit,totalExpenses,netProfit,transactionCount,updatedAt}
class DailySummaryMapper extends EntityMapper {
  toDatabase(local) {
    // لا حساب هنا إطلاقًا — فقط إعادة تسمية/تنظيم حقول موجودة بالفعل
    return {
      shopId: local.shopId ?? null, date: local.date ?? null,
      totalSales: local.totalSales ?? 0, totalProfit: local.totalProfit ?? 0,
      totalExpenses: local.totalExpenses ?? 0, netProfit: local.netProfit ?? 0,
      transactionCount: local.transactionCount ?? 0,
      updatedAt: local.updatedAt ?? null,
    };
  }
  fromDatabase(db) { return { ...db }; }
  validate(entity) {
    this._requireFields(entity, ['shopId', 'date'], 'DailySummaryMapper');
  }
}

// ══ WalletBalanceMapper — تحويل بنيوي فقط، صفر حساب (مُشتَق دائمًا) ══
// محلي (شكل db_foundation.js WALLET_BALANCE_SHAPE): {shopId,walletId,balance,updatedAt}
class WalletBalanceMapper extends EntityMapper {
  toDatabase(local) {
    return {
      shopId: local.shopId ?? null, walletId: local.walletId ?? null,
      balance: local.balance ?? 0, updatedAt: local.updatedAt ?? null,
    };
  }
  fromDatabase(db) { return { ...db }; }
  validate(entity) {
    this._requireFields(entity, ['walletId'], 'WalletBalanceMapper');
  }
}

// ══ سجل مركزي لكل المحوّلات (لتسهيل الاستخدام المستقبلي — لا استدعاء ذاتي هنا) ══
const ENTITY_MAPPERS_REGISTRY = Object.freeze({
  phones: new PhoneMapper(),
  phoneTransactions: new PhoneTransactionMapper(),
  usedPhoneTransactions: new UsedPhoneTransactionMapper(),
  accessoryTransactions: new AccessoryTransactionMapper(),
  softwareTransactions: new SoftwareTransactionMapper(),
  walletTransactions: new WalletTransactionMapper(),
  expenses: new ExpenseMapper(),
  expenseTransactions: new ExpenseMapper(),
  repairs: new RepairMapper(),
  wallets: new WalletMapper(),
  notes: new NoteMapper(),
  notifications: new NotificationMapper(),
  categories: new CategoryMapper(),
  brands: new BrandMapper(),
  repairParts: new RepairPartMapper(),
  faultTypes: new FaultTypeMapper(),
  settings: new SettingsMapper(),
  dailySummary: new DailySummaryMapper(),
  walletBalances: new WalletBalanceMapper(),
});
