// ═══════════════════════════════════════════════════════════
// db_integration.js — Phase 6: Database Integration Layer
// ═══════════════════════════════════════════════════════════
// طبقة تكامل حقيقية وقابلة للاختبار فعليًا (بعكس db_foundation.js
// في Phase 5 التي كانت دوالًا نقية توثيقية فقط). هذه الطبقة تُفوِّض
// فعليًا لـ Storage API الحالي (بدون تعديل سلوكه إطلاقًا)، لكنها
// **غير مربوطة بأي كود عمل حالي** (phones.js, repair.js, إلخ) —
// أي كود موجود يستمر في العمل تمامًا كما هو، بدون أي تغيير.
//
// الهدف: فصل منطق العمل عن آلية التخزين، بحيث يصبح استبدال
// localStorage بقاعدة بيانات حقيقية مستقبلًا (Supabase/SQLite/REST)
// مجرد كتابة Adapter جديد يلتزم بنفس العقد، دون لمس منطق العمل.

// ══ نموذج أخطاء موحّد لكل المزوّدين الحاليين والمستقبليين ══
const DB_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'NOT_FOUND',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  STORAGE_FAILURE: 'STORAGE_FAILURE',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNSUPPORTED_OPERATION: 'UNSUPPORTED_OPERATION',
});
class DatabaseError extends Error {
  constructor(code, message, originalError = null) {
    super(message);
    this.name = 'DatabaseError';
    this.code = code;
    this.originalError = originalError;
  }
}

// ══ عقد المحوّل (Adapter Interface) — كل مزوّد مستقبلي يلتزم بهذا الشكل بالضبط ══
class DatabaseAdapter {
  async create(entityType, record) { throw new DatabaseError(DB_ERROR_CODES.NOT_IMPLEMENTED, 'create() not implemented'); }
  async read(entityType, id) { throw new DatabaseError(DB_ERROR_CODES.NOT_IMPLEMENTED, 'read() not implemented'); }
  async update(entityType, id, changes) { throw new DatabaseError(DB_ERROR_CODES.NOT_IMPLEMENTED, 'update() not implemented'); }
  async delete(entityType, id) { throw new DatabaseError(DB_ERROR_CODES.NOT_IMPLEMENTED, 'delete() not implemented'); }
  async query(entityType, filterFn) { throw new DatabaseError(DB_ERROR_CODES.NOT_IMPLEMENTED, 'query() not implemented'); }
  async transaction(operations) { throw new DatabaseError(DB_ERROR_CODES.NOT_IMPLEMENTED, 'transaction() not implemented'); }
  async batch(operations) { throw new DatabaseError(DB_ERROR_CODES.NOT_IMPLEMENTED, 'batch() not implemented'); }
}

// ══ خريطة الكيانات ذات المجموعة الثابتة (Static Collections) ══
// كيانات مُخزَّنة كمصفوفة كاملة تحت مفتاح واحد ثابت.
const LOCAL_COLLECTION_MAP = Object.freeze({
  phones:        { storageKey: 'mshop_inventory',    idField: 'id' },
  notes:         { storageKey: 'mshop_notes',        idField: 'id' },
  notifications: { storageKey: 'mshop_notifs',       idField: 'id' },
  repairParts:   { storageKey: 'mshop_repair_parts', idField: 'id' },
  faultTypes:    { storageKey: 'mshop_fault_types',  idField: 'id' },
});

// ══ [Phase 7.2] خريطة الكيانات المُقسَّمة يوميًا (Partitioned Collections) ══
// البنية الفعلية في localStorage: مفتاح يومي `mshop_d_YYYY-MM-DD` يحتوي كائنًا
// بداخله مصفوفات فرعية (phones, acc, used, cash, sw, exp, repairs).
//
// كل إدخال هنا يصف:
//   subKey   — اسم المصفوفة الفرعية داخل كائن اليوم
//   idField  — حقل المعرّف داخل كل سجل (يُضاف تلقائيًا عند الإنشاء إن لم يكن موجودًا)
//   dateField— الحقل الذي يحمل التاريخ داخل السجل (لتحديد partition الكتابة)
//
// القاعدة المعمارية: Repository لا تعرف شيئًا عن هذه المفاتيح أو البنية —
// كل التوجيه يحدث داخل LocalAdapter حصرًا.
const LOCAL_PARTITIONED_MAP = Object.freeze({
  phoneTransactions:       { subKey: 'phones',  idField: 'id', dateField: 'date' },
  usedPhoneTransactions:   { subKey: 'used',    idField: 'id', dateField: 'date' },
  accessoryTransactions:   { subKey: 'acc',     idField: 'id', dateField: 'date' },
  softwareTransactions:    { subKey: 'sw',      idField: 'id', dateField: 'date' },
  walletTransactions:      { subKey: 'cash',    idField: 'id', dateField: 'date' },
  expenseTransactions:     { subKey: 'exp',     idField: 'id', dateField: 'date' },
  repairTransactions:      { subKey: 'repairs', idField: 'id', dateField: 'date' },
});

// ── مساعد داخلي: يبني مفتاح التقسيم اليومي من تاريخ بصيغة YYYY-MM-DD ──
// مُعرَّف هنا (خارج الكلاس) لأنه ثابت محض وليس له حالة.
function _buildPartitionKey(dateStr) {
  return 'mshop_d_' + dateStr;
}

// ══ [Phase 7.2] Local Adapter — يدعم كلا النوعين: Static و Partitioned ══
//
// مسار التوجيه الداخلي (غير مرئي للـ Repository أو الـ Mapper):
//
//   entityType موجود في LOCAL_COLLECTION_MAP  → مسار Static (سلوك قديم محفوظ بالكامل)
//   entityType موجود في LOCAL_PARTITIONED_MAP → مسار Partitioned (جديد — Phase 7.2)
//   غير موجود في أي منهما                   → UNSUPPORTED_OPERATION error
//
class LocalAdapter extends DatabaseAdapter {

  // ══════════════════════════════════════════════════════════
  // ── أدوات التوجيه الداخلية (Private Routing Helpers) ──
  // ══════════════════════════════════════════════════════════

  // يُحدِّد نوع الكيان: 'static' | 'partitioned' | null
  _routeType(entityType) {
    if (LOCAL_COLLECTION_MAP[entityType])    return 'static';
    if (LOCAL_PARTITIONED_MAP[entityType])   return 'partitioned';
    return null;
  }

  // يُعيد إعداد المجموعة الثابتة أو يرمي خطأ
  _staticCfg(entityType) {
    const cfg = LOCAL_COLLECTION_MAP[entityType];
    if (!cfg) throw new DatabaseError(
      DB_ERROR_CODES.UNSUPPORTED_OPERATION,
      `LocalAdapter: entityType "${entityType}" غير مدعوم — راجع LOCAL_COLLECTION_MAP و LOCAL_PARTITIONED_MAP`
    );
    return cfg;
  }

  // يُعيد إعداد الكيان المُقسَّم أو يرمي خطأ
  _partCfg(entityType) {
    const cfg = LOCAL_PARTITIONED_MAP[entityType];
    if (!cfg) throw new DatabaseError(
      DB_ERROR_CODES.UNSUPPORTED_OPERATION,
      `LocalAdapter: entityType "${entityType}" غير مدعوم كمجموعة مُقسَّمة`
    );
    return cfg;
  }

  // ── يستخرج التاريخ من سجل أو من قيمة مُمرَّرة صراحةً ──
  // المصدر بالأولوية:
  //   1. record[dateField]   — حقل التاريخ داخل السجل نفسه
  //   2. options.date        — تاريخ مُمرَّر صراحةً من المستدعي
  //   3. today               — تاريخ اليوم كاحتياط
  _resolveDate(record, dateField, options = {}) {
    if (record && record[dateField]) return record[dateField];
    if (options.date)                return options.date;
    // احتياط: استخدم تاريخ اليوم بصيغة YYYY-MM-DD
    return new Date().toISOString().slice(0, 10);
  }

  // ── يُعيد قائمة كل مفاتيح الـ partitions الموجودة فعلًا في localStorage ──
  _allPartitionKeys() {
    return Storage.search('mshop_d_');
  }

  // ── يقرأ كائن اليوم من partition معيّن بأمان ──
  _getPartitionData(partKey) {
    return Storage.get(partKey, { acc:[], used:[], cash:[], sw:[], exp:[], phones:[], repairs:[] });
  }

  // ── يحفظ كائن اليوم في partition معيّن ──
  _savePartitionData(partKey, dayData) {
    Storage.save(partKey, dayData);
  }

  // ══════════════════════════════════════════════════════════
  // ── create ──
  // ══════════════════════════════════════════════════════════
  async create(entityType, record, options = {}) {
    try {
      // ── مسار Static (سلوك محفوظ بالكامل) ──
      if (this._routeType(entityType) === 'static') {
        const { storageKey, idField } = this._staticCfg(entityType);
        const list = Storage.get(storageKey, []);
        if (!record[idField]) record[idField] = generateOperationIdempotencyKey();
        list.push(record);
        Storage.save(storageKey, list);
        return record;
      }

      // ── مسار Partitioned ──
      const { subKey, idField, dateField } = this._partCfg(entityType);
      const dateStr  = this._resolveDate(record, dateField, options);
      const partKey  = _buildPartitionKey(dateStr);
      const dayData  = this._getPartitionData(partKey);
      if (!dayData[subKey]) dayData[subKey] = [];
      if (!record[idField]) record[idField] = generateOperationIdempotencyKey();
      // نسجّل التاريخ داخل السجل إن لم يكن موجودًا (لتمكين الـ read/update/delete لاحقًا)
      if (!record[dateField]) record[dateField] = dateStr;
      dayData[subKey].push(record);
      this._savePartitionData(partKey, dayData);
      return record;

    } catch (e) {
      if (e instanceof DatabaseError) throw e;
      throw new DatabaseError(DB_ERROR_CODES.STORAGE_FAILURE, 'create failed', e);
    }
  }

  // ══════════════════════════════════════════════════════════
  // ── read ──
  // ══════════════════════════════════════════════════════════
  async read(entityType, id, options = {}) {
    try {
      // ── مسار Static ──
      if (this._routeType(entityType) === 'static') {
        const { storageKey, idField } = this._staticCfg(entityType);
        const list  = Storage.get(storageKey, []);
        const found = list.find(r => r[idField] === id);
        if (!found) throw new DatabaseError(DB_ERROR_CODES.NOT_FOUND, `${entityType} with id ${id} not found`);
        return found;
      }

      // ── مسار Partitioned: نبحث في partition محدد أو في كل الـ partitions ──
      const { subKey, idField } = this._partCfg(entityType);

      // لو أُعطي تاريخ محدد في options، نبحث في partition ذلك اليوم فقط (أسرع)
      const targetKeys = options.date
        ? [_buildPartitionKey(options.date)]
        : this._allPartitionKeys();

      for (const partKey of targetKeys) {
        const dayData = this._getPartitionData(partKey);
        const list    = dayData[subKey] || [];
        const found   = list.find(r => r[idField] === id);
        if (found) return found;
      }
      throw new DatabaseError(DB_ERROR_CODES.NOT_FOUND, `${entityType} with id ${id} not found`);

    } catch (e) {
      if (e instanceof DatabaseError) throw e;
      throw new DatabaseError(DB_ERROR_CODES.STORAGE_FAILURE, 'read failed', e);
    }
  }

  // ══════════════════════════════════════════════════════════
  // ── update ──
  // ══════════════════════════════════════════════════════════
  async update(entityType, id, changes, options = {}) {
    try {
      // ── مسار Static ──
      if (this._routeType(entityType) === 'static') {
        const { storageKey, idField } = this._staticCfg(entityType);
        const list = Storage.get(storageKey, []);
        const idx  = list.findIndex(r => r[idField] === id);
        if (idx === -1) throw new DatabaseError(DB_ERROR_CODES.NOT_FOUND, `${entityType} with id ${id} not found`);
        list[idx] = { ...list[idx], ...changes };
        Storage.save(storageKey, list);
        return list[idx];
      }

      // ── مسار Partitioned: نبحث في partition محدد أو في كل الـ partitions ──
      const { subKey, idField } = this._partCfg(entityType);

      const targetKeys = options.date
        ? [_buildPartitionKey(options.date)]
        : this._allPartitionKeys();

      for (const partKey of targetKeys) {
        const dayData = this._getPartitionData(partKey);
        const list    = dayData[subKey] || [];
        const idx     = list.findIndex(r => r[idField] === id);
        if (idx !== -1) {
          list[idx] = { ...list[idx], ...changes };
          dayData[subKey] = list;
          this._savePartitionData(partKey, dayData);
          return list[idx];
        }
      }
      throw new DatabaseError(DB_ERROR_CODES.NOT_FOUND, `${entityType} with id ${id} not found`);

    } catch (e) {
      if (e instanceof DatabaseError) throw e;
      throw new DatabaseError(DB_ERROR_CODES.STORAGE_FAILURE, 'update failed', e);
    }
  }

  // ══════════════════════════════════════════════════════════
  // ── delete ──
  // ══════════════════════════════════════════════════════════
  async delete(entityType, id, options = {}) {
    try {
      // ── مسار Static ──
      if (this._routeType(entityType) === 'static') {
        const { storageKey, idField } = this._staticCfg(entityType);
        const list = Storage.get(storageKey, []);
        const next = list.filter(r => r[idField] !== id);
        if (next.length === list.length) throw new DatabaseError(DB_ERROR_CODES.NOT_FOUND, `${entityType} with id ${id} not found`);
        Storage.save(storageKey, next);
        return true;
      }

      // ── مسار Partitioned ──
      const { subKey, idField } = this._partCfg(entityType);

      const targetKeys = options.date
        ? [_buildPartitionKey(options.date)]
        : this._allPartitionKeys();

      for (const partKey of targetKeys) {
        const dayData = this._getPartitionData(partKey);
        const list    = dayData[subKey] || [];
        const next    = list.filter(r => r[idField] !== id);
        if (next.length < list.length) {
          dayData[subKey] = next;
          this._savePartitionData(partKey, dayData);
          return true;
        }
      }
      throw new DatabaseError(DB_ERROR_CODES.NOT_FOUND, `${entityType} with id ${id} not found`);

    } catch (e) {
      if (e instanceof DatabaseError) throw e;
      throw new DatabaseError(DB_ERROR_CODES.STORAGE_FAILURE, 'delete failed', e);
    }
  }

  // ══════════════════════════════════════════════════════════
  // ── query ──
  // ══════════════════════════════════════════════════════════
  // options.date  → يقتصر على partition يوم واحد فقط (YYYY-MM-DD)
  // options.dates → مصفوفة تواريخ للاستعلام عن partitions محددة
  // بدون options  → يُجمِّع كل الـ partitions (كامل التاريخ)
  async query(entityType, filterFn, options = {}) {
    try {
      // ── مسار Static ──
      if (this._routeType(entityType) === 'static') {
        const { storageKey } = this._staticCfg(entityType);
        const list = Storage.get(storageKey, []);
        return typeof filterFn === 'function' ? list.filter(filterFn) : list;
      }

      // ── مسار Partitioned: يُجمِّع من كل الـ partitions المطلوبة ──
      const { subKey } = this._partCfg(entityType);

      let targetKeys;
      if (options.date) {
        // استعلام يوم واحد بعينه
        targetKeys = [_buildPartitionKey(options.date)];
      } else if (Array.isArray(options.dates) && options.dates.length > 0) {
        // استعلام أيام محددة
        targetKeys = options.dates.map(d => _buildPartitionKey(d));
      } else {
        // استعلام شامل — كل الـ partitions الموجودة
        targetKeys = this._allPartitionKeys();
      }

      const aggregated = [];
      for (const partKey of targetKeys) {
        const dayData = this._getPartitionData(partKey);
        const list    = dayData[subKey] || [];
        aggregated.push(...list);
      }

      return typeof filterFn === 'function' ? aggregated.filter(filterFn) : aggregated;

    } catch (e) {
      if (e instanceof DatabaseError) throw e;
      throw new DatabaseError(DB_ERROR_CODES.STORAGE_FAILURE, 'query failed', e);
    }
  }

  // ══════════════════════════════════════════════════════════
  // ── transaction / batch (سلوك محفوظ بالكامل) ──
  // ══════════════════════════════════════════════════════════
  // معاملة بسيطة: تنفيذ متتابع لعدة عمليات؛ لو فشلت أي منها، لا Rollback تلقائي
  // حقيقي عبر localStorage (لا يدعم Transactions أصلًا) — موثَّق كقيد معماري صريح.
  async transaction(operations) {
    const results = [];
    for (const op of operations) {
      results.push(await this[op.type](...op.args));
    }
    return results;
  }

  async batch(operations) {
    return this.transaction(operations);
  }
}

// ══ سجل تسجيل المزوّدين — Local Adapter هو التنفيذ الوحيد الموجود حاليًا ══
const DatabaseProviderRegistry = {
  _providers: {},
  _activeName: null,
  register(name, adapterInstance) {
    if (!(adapterInstance instanceof DatabaseAdapter)) {
      throw new DatabaseError(DB_ERROR_CODES.VALIDATION_ERROR, 'Provider must extend DatabaseAdapter');
    }
    this._providers[name] = adapterInstance;
  },
  setActive(name) {
    if (!this._providers[name]) throw new DatabaseError(DB_ERROR_CODES.NOT_FOUND, `Provider "${name}" not registered`);
    this._activeName = name;
  },
  getActive() {
    if (!this._activeName) throw new DatabaseError(DB_ERROR_CODES.NOT_FOUND, 'No active provider set');
    return this._providers[this._activeName];
  },
  getActiveName() { return this._activeName; },
};
// تسجيل وتفعيل Local Adapter فورًا — المزوّد النشط الوحيد المسموح به في هذه المرحلة
DatabaseProviderRegistry.register('local', new LocalAdapter());
DatabaseProviderRegistry.setActive('local');
// ملاحظة: أي مزوّد مستقبلي (مثال: 'supabase', 'sqlite') سيُسجَّل بنفس الطريقة
// بالضبط (`DatabaseProviderRegistry.register('supabase', new SupabaseAdapter())`)
// دون أي تعديل على منطق العمل أو المستودعات (Repositories) أدناه.

// ══ طبقة المستودعات (Repository Layer) — منطق العمل يتحدث معها فقط، أبدًا مع Storage مباشرة ══
// [Phase 7.1] تم ربط طبقة EntityMapper هنا وفق ADR-002:
//   كتابة:  Repository → validate() → toDatabase() → Adapter → Storage
//   قراءة:  Storage → Adapter → fromDatabase() → Repository
// إذا لم يكن للكيان محوّل مُسجَّل، تمرّ البيانات دون تغيير (backward-compatible).
class Repository {
  constructor(entityType) {
    this.entityType = entityType;
  }

  _adapter() { return DatabaseProviderRegistry.getActive(); }

  // ── داخلي: جلب المحوّل المرتبط بهذا الكيان (أو null إن لم يكن مسجَّلًا بعد) ──
  _mapper() {
    // ENTITY_MAPPERS_REGISTRY معرَّف في entity_mappers.js المُحمَّل بعد هذا الملف —
    // الاستدعاء يحدث فقط وقت تشغيل الدوال (runtime)، لذا القيمة متاحة دائمًا.
    if (typeof ENTITY_MAPPERS_REGISTRY !== 'undefined') {
      return ENTITY_MAPPERS_REGISTRY[this.entityType] ?? null;
    }
    return null;
  }

  // ── داخلي: تحويل كائن محلي → صيغة DB (مع اختياري validate أولًا) ──
  _toDb(record) {
    const mapper = this._mapper();
    if (!mapper) return record;
    if (typeof mapper.validate === 'function') mapper.validate(record);
    return mapper.toDatabase(record);
  }

  // ── داخلي: تحويل كائن DB → كائن محلي ──
  _fromDb(record) {
    const mapper = this._mapper();
    if (!mapper || !record) return record;
    return mapper.fromDatabase(record);
  }

  // ══ create: validate → toDatabase → Adapter.create → fromDatabase ══
  async create(record) {
    const dbRecord = this._toDb(record);
    const saved = await this._adapter().create(this.entityType, dbRecord);
    return this._fromDb(saved);
  }

  // ══ findById: Adapter.read → fromDatabase ══
  async findById(id) {
    const raw = await this._adapter().read(this.entityType, id);
    return this._fromDb(raw);
  }

  // ══ update [Phase 7.1.1 — Fix]: read → merge → validate → toDatabase → Adapter.update ══
  // السبب: toDatabase() مصمَّمة للكيان الكامل. تمرير patch جزئي إليها مباشرةً يُنتج
  // قيم افتراضية (null/0/false/[]) لكل حقل مفقود، ثم Adapter.update يدمجها عبر spread
  // فيُدمِّر بيانات مُخزَّنة. الإصلاح: نقرأ السجل الكامل أولًا، ندمج الـ patch على
  // الكيان المحلي الكامل، ثم نُحوِّل الكيان المدمَج فقط — وليس الـ patch وحده.
  //
  // إذا لم يكن للكيان محوّل مُسجَّل: السلوك القديم محفوظ كاملًا (backward-compatible).
  async update(id, changes, options = {}) {
    const mapper = this._mapper();

    // ── مسار بدون محوّل: سلوك مباشر (backward-compatible) ──
    if (!mapper) {
      const saved = await this._adapter().update(this.entityType, id, changes, options);
      return saved;
    }

    // ── مسار بمحوّل: read → merge → validate → toDatabase → write → fromDatabase ──

    // 1. اقرأ السجل الحالي الكامل من قاعدة البيانات
    const currentDb = await this._adapter().read(this.entityType, id);

    // 2. حوّل السجل الحالي إلى كيان محلي كامل
    const currentLocal = mapper.fromDatabase(currentDb);

    // 3. ادمج الـ patch في الكيان المحلي الكامل
    //    (المفاتيح الموجودة في changes تستبدل قيمها فقط — الباقي يبقى كما هو)
    const mergedLocal = { ...currentLocal, ...changes };

    // 4. تحقق من صحة الكيان المدمَج الكامل (وليس الـ patch وحده)
    if (typeof mapper.validate === 'function') mapper.validate(mergedLocal);

    // 5. حوّل الكيان المدمَج الكامل إلى صيغة DB
    const mergedDb = mapper.toDatabase(mergedLocal);

    // 6. اكتب الكيان المحوَّل عبر Adapter
    const savedDb = await this._adapter().update(this.entityType, id, mergedDb, options);

    // 7. أعد تحويل النتيجة إلى كيان محلي قبل إعادتها للمستدعي
    return mapper.fromDatabase(savedDb);
  }

  // ══ delete: يمرّ مباشرة للـ Adapter — لا حاجة للـ Mapper هنا ══
  delete(id, options = {}) { return this._adapter().delete(this.entityType, id, options); }

  // ══ findAll: Adapter.query → fromDatabase على كل سجل ══
  async findAll(filterFn) {
    const rawList = await this._adapter().query(this.entityType, filterFn);
    const mapper = this._mapper();
    if (!mapper || typeof mapper.fromDatabase !== 'function') return rawList;
    return rawList.map(r => mapper.fromDatabase(r));
  }
}

// ── مستودعات كاملة الوظائف (الكيانات المخزَّنة كمجموعة واحدة بمفتاح ثابت) ──
class PhoneRepository extends Repository {
  constructor() {
    super('phones');
  }

  /**
   * [Phase 7.3] Initializes the global in-memory inventory cache from storage.
   */
  async initCache() {
    const records = await this.findAll();
    if (typeof inventory !== 'undefined') {
      inventory = records;
    }
    return records;
  }

  /**
   * [Phase 7.3] Optimistic Write-Through Create with Automatic Failure Rollback
   */
  async create(record) {
    const localEntity = this._mapper() ? this._fromDb(this._toDb(record)) : { ...record };
    
    // 1. Optimistic Cache Update
    if (typeof inventory !== 'undefined') {
      inventory.push(localEntity);
    }

    try {
      // 2. Async Storage Persistence
      const savedEntity = await super.create(record);
      // Sync generated properties (e.g. ID) back to cache
      if (typeof inventory !== 'undefined') {
        const idx = inventory.indexOf(localEntity);
        if (idx !== -1) inventory[idx] = savedEntity;
      }
      return savedEntity;
    } catch (err) {
      // 3. Rollback on Failure
      if (typeof inventory !== 'undefined') {
        const idx = inventory.indexOf(localEntity);
        if (idx !== -1) inventory.splice(idx, 1);
      }
      throw err;
    }
  }

  /**
   * [Phase 7.3] Optimistic Write-Through Update with Automatic Failure Rollback
   */
  async update(id, changes) {
    let backupItem = null;
    let targetIdx = -1;

    if (typeof inventory !== 'undefined') {
      targetIdx = inventory.findIndex(p => p.id === id);
      if (targetIdx !== -1) {
        backupItem = { ...inventory[targetIdx] };
        inventory[targetIdx] = { ...inventory[targetIdx], ...changes };
      }
    }

    try {
      const savedEntity = await super.update(id, changes);
      if (typeof inventory !== 'undefined' && targetIdx !== -1) {
        inventory[targetIdx] = savedEntity;
      }
      return savedEntity;
    } catch (err) {
      // Rollback on Failure
      if (typeof inventory !== 'undefined' && targetIdx !== -1 && backupItem) {
        inventory[targetIdx] = backupItem;
      }
      throw err;
    }
  }

  /**
   * [Phase 7.3] Optimistic Write-Through Delete with Automatic Failure Rollback
   */
  async delete(id) {
    let backupItem = null;
    let targetIdx = -1;

    if (typeof inventory !== 'undefined') {
      targetIdx = inventory.findIndex(p => p.id === id);
      if (targetIdx !== -1) {
        backupItem = inventory[targetIdx];
        inventory.splice(targetIdx, 1);
      }
    }

    try {
      const result = await super.delete(id);
      return result;
    } catch (err) {
      // Rollback on Failure
      if (typeof inventory !== 'undefined' && backupItem && targetIdx !== -1) {
        inventory.splice(targetIdx, 0, backupItem);
      }
      throw err;
    }
  }
}
class NoteRepository extends Repository {
  constructor() { super('notes'); }

  async initCache() {
    const records = await this.findAll();
    if (typeof notes !== 'undefined') {
      notes.length = 0;
      notes.push(...records);
    }
    return records;
  }

  async create(record) {
    const localEntity = this._mapper() ? this._fromDb(this._toDb(record)) : { ...record };
    if (typeof notes !== 'undefined') {
      notes.unshift(localEntity);
    }
    try {
      const savedEntity = await super.create(record);
      if (typeof notes !== 'undefined') {
        const idx = notes.indexOf(localEntity);
        if (idx !== -1) notes[idx] = savedEntity;
      }
      return savedEntity;
    } catch (err) {
      if (typeof notes !== 'undefined') {
        const idx = notes.indexOf(localEntity);
        if (idx !== -1) notes.splice(idx, 1);
      }
      throw err;
    }
  }

  async update(id, changes) {
    let backupItem = null;
    let targetIdx = -1;
    if (typeof notes !== 'undefined') {
      targetIdx = notes.findIndex(n => n.id === id);
      if (targetIdx !== -1) {
        backupItem = { ...notes[targetIdx] };
        notes[targetIdx] = { ...notes[targetIdx], ...changes };
      }
    }
    try {
      const savedEntity = await super.update(id, changes);
      if (typeof notes !== 'undefined' && targetIdx !== -1) {
        notes[targetIdx] = savedEntity;
      }
      return savedEntity;
    } catch (err) {
      if (typeof notes !== 'undefined' && targetIdx !== -1 && backupItem) {
        notes[targetIdx] = backupItem;
      }
      throw err;
    }
  }

  async delete(id) {
    let backupItem = null;
    let targetIdx = -1;
    if (typeof notes !== 'undefined') {
      targetIdx = notes.findIndex(n => n.id === id);
      if (targetIdx !== -1) {
        backupItem = notes[targetIdx];
        notes.splice(targetIdx, 1);
      }
    }
    try {
      const result = await super.delete(id);
      return result;
    } catch (err) {
      if (typeof notes !== 'undefined' && backupItem && targetIdx !== -1) {
        notes.splice(targetIdx, 0, backupItem);
      }
      throw err;
    }
  }
}

// ══ [Phase 8.2] Transaction Repositories for Daily Partitioned Entities ══
class AccessoryTransactionRepository extends Repository {
  constructor() { super('accessoryTransactions'); }

  async initCache() {
    const records = await this.findAll();
    if (typeof data !== 'undefined' && data.acc) {
      data.acc.length = 0;
      data.acc.push(...records);
    }
    return records;
  }

  async create(record) {
    const localEntity = this._mapper() ? this._fromDb(this._toDb(record)) : { ...record };
    if (typeof data !== 'undefined' && data.acc) {
      data.acc.push(localEntity);
    }
    try {
      const savedEntity = await super.create(record);
      if (typeof data !== 'undefined' && data.acc) {
        const idx = data.acc.indexOf(localEntity);
        if (idx !== -1) data.acc[idx] = savedEntity;
      }
      return savedEntity;
    } catch (err) {
      if (typeof data !== 'undefined' && data.acc) {
        const idx = data.acc.indexOf(localEntity);
        if (idx !== -1) data.acc.splice(idx, 1);
      }
      throw err;
    }
  }
}
class PhoneTransactionRepository extends Repository {
  constructor() { super('phoneTransactions'); }

  async initCache() {
    const records = await this.findAll();
    if (typeof data !== 'undefined' && data.phones) {
      data.phones.length = 0;
      data.phones.push(...records);
    }
    return records;
  }

  async create(record) {
    const localEntity = this._mapper() ? this._fromDb(this._toDb(record)) : { ...record };
    if (typeof data !== 'undefined' && data.phones) {
      data.phones.push(localEntity);
    }
    try {
      const savedEntity = await super.create(record);
      if (typeof data !== 'undefined' && data.phones) {
        const idx = data.phones.indexOf(localEntity);
        if (idx !== -1) data.phones[idx] = savedEntity;
      }
      return savedEntity;
    } catch (err) {
      if (typeof data !== 'undefined' && data.phones) {
        const idx = data.phones.indexOf(localEntity);
        if (idx !== -1) data.phones.splice(idx, 1);
      }
      throw err;
    }
  }
}
class UsedPhoneTransactionRepository extends Repository {
  constructor() { super('usedPhoneTransactions'); }

  async initCache() {
    const records = await this.findAll();
    if (typeof data !== 'undefined' && data.used) {
      data.used.length = 0;
      data.used.push(...records);
    }
    return records;
  }

  async create(record) {
    const localEntity = this._mapper() ? this._fromDb(this._toDb(record)) : { ...record };
    if (typeof data !== 'undefined' && data.used) {
      data.used.push(localEntity);
    }
    try {
      const savedEntity = await super.create(record);
      if (typeof data !== 'undefined' && data.used) {
        const idx = data.used.indexOf(localEntity);
        if (idx !== -1) data.used[idx] = savedEntity;
      }
      return savedEntity;
    } catch (err) {
      if (typeof data !== 'undefined' && data.used) {
        const idx = data.used.indexOf(localEntity);
        if (idx !== -1) data.used.splice(idx, 1);
      }
      throw err;
    }
  }
}
class SoftwareTransactionRepository extends Repository {
  constructor() { super('softwareTransactions'); }

  async initCache() {
    const records = await this.findAll();
    if (typeof data !== 'undefined' && data.sw) {
      data.sw.length = 0;
      data.sw.push(...records);
    }
    return records;
  }

  async create(record) {
    const localEntity = this._mapper() ? this._fromDb(this._toDb(record)) : { ...record };
    if (typeof data !== 'undefined' && data.sw) {
      data.sw.push(localEntity);
    }
    try {
      const savedEntity = await super.create(record);
      if (typeof data !== 'undefined' && data.sw) {
        const idx = data.sw.indexOf(localEntity);
        if (idx !== -1) data.sw[idx] = savedEntity;
      }
      return savedEntity;
    } catch (err) {
      if (typeof data !== 'undefined' && data.sw) {
        const idx = data.sw.indexOf(localEntity);
        if (idx !== -1) data.sw.splice(idx, 1);
      }
      throw err;
    }
  }

  async update(id, changes, options = {}) {
    if (!id) return null;
    const result = await super.update(id, changes, options);
    if (typeof data !== 'undefined' && data.sw) {
      const idx = data.sw.findIndex(r => r.id === id);
      if (idx !== -1) data.sw[idx] = result;
    }
    return result;
  }
}
class WalletTransactionRepository extends Repository {
  constructor() { super('walletTransactions'); }

  async initCache() {
    const records = await this.findAll();
    if (typeof data !== 'undefined' && data.cash) {
      data.cash.length = 0;
      data.cash.push(...records);
    }
    return records;
  }

  async create(record) {
    const localEntity = this._mapper() ? this._fromDb(this._toDb(record)) : { ...record };
    if (typeof data !== 'undefined' && data.cash) {
      data.cash.push(localEntity);
    }
    try {
      const savedEntity = await super.create(record);
      if (typeof data !== 'undefined' && data.cash) {
        const idx = data.cash.indexOf(localEntity);
        if (idx !== -1) data.cash[idx] = savedEntity;
      }
      return savedEntity;
    } catch (err) {
      if (typeof data !== 'undefined' && data.cash) {
        const idx = data.cash.indexOf(localEntity);
        if (idx !== -1) data.cash.splice(idx, 1);
      }
      throw err;
    }
  }
}
class ExpenseTransactionRepository extends Repository {
  constructor() { super('expenseTransactions'); }

  async initCache() {
    const records = await this.findAll();
    if (typeof data !== 'undefined' && data.exp) {
      data.exp.length = 0;
      data.exp.push(...records);
    }
    return records;
  }

  async create(record) {
    const localEntity = this._mapper() ? this._fromDb(this._toDb(record)) : { ...record };
    if (typeof data !== 'undefined' && data.exp) {
      data.exp.push(localEntity);
    }
    try {
      const savedEntity = await super.create(record);
      if (typeof data !== 'undefined' && data.exp) {
        const idx = data.exp.indexOf(localEntity);
        if (idx !== -1) data.exp[idx] = savedEntity;
      }
      return savedEntity;
    } catch (err) {
      if (typeof data !== 'undefined' && data.exp) {
        const idx = data.exp.indexOf(localEntity);
        if (idx !== -1) data.exp.splice(idx, 1);
      }
      throw err;
    }
  }
}
class RepairTransactionRepository extends Repository {
  constructor() { super('repairTransactions'); }

  async initCache() {
    const records = await this.findAll();
    if (typeof data !== 'undefined' && data.repairs) {
      data.repairs.length = 0;
      data.repairs.push(...records);
    }
    return records;
  }

  async create(record) {
    const localEntity = this._mapper() ? this._fromDb(this._toDb(record)) : { ...record };
    if (typeof data !== 'undefined' && data.repairs) {
      data.repairs.push(localEntity);
    }
    try {
      const savedEntity = await super.create(record);
      if (typeof data !== 'undefined' && data.repairs) {
        const idx = data.repairs.indexOf(localEntity);
        if (idx !== -1) data.repairs[idx] = savedEntity;
      }
      return savedEntity;
    } catch (err) {
      if (typeof data !== 'undefined' && data.repairs) {
        const idx = data.repairs.indexOf(localEntity);
        if (idx !== -1) data.repairs.splice(idx, 1);
      }
      throw err;
    }
  }

  async update(id, changes, options = {}) {
    if (!id) return null;
    const result = await super.update(id, changes, options);
    if (typeof data !== 'undefined' && data.repairs) {
      const idx = data.repairs.findIndex(r => r.id === id);
      if (idx !== -1) data.repairs[idx] = result;
    }
    return result;
  }

  async delete(id, options = {}) {
    if (!id) return null;
    let backup = null;
    if (typeof data !== 'undefined' && data.repairs) {
      const idx = data.repairs.findIndex(r => r.id === id);
      if (idx !== -1) { backup = data.repairs[idx]; data.repairs.splice(idx, 1); }
    }
    try {
      await super.delete(id, options);
      return true;
    } catch (err) {
      if (backup && typeof data !== 'undefined' && data.repairs) data.repairs.push(backup);
      throw err;
    }
  }
}

// ── مستودعات بقراءة حقيقية فقط (Read-Only فعليًا الآن) — انظر "قيد معماري مكتشَف" أسفله ──
// السبب: الصيانة والمصاريف والكاش مُخزَّنة اليوم مُقسَّمة داخل سجلات يومية
// (mshop_d_<date>)، وليست مجموعة واحدة بمعرّفات صريحة كما يفترض عقد Repository
// العام. الكتابة (create/update/delete) عبر هذا العقد العام غير آمنة معماريًا
// بدون تطبيق نموذج "المعاملات" المعتمَد في Phase 4.5 على البيانات الفعلية أولًا
// (خارج نطاق هذه المرحلة — "Avoid unnecessary refactoring of completed modules").
class RepairRepository extends Repository {
  constructor(){ super('repairs'); }
  async findAll(filterFn) {
    // يُعيد استخدام نفس منطق التجميع التاريخي الموجود بالفعل (getAllRepairs)
    // للقراءة فقط، دون أي تكرار لمنطق الحساب أو تغيير في repair.js نفسه.
    if (typeof getAllRepairs !== 'function') {
      throw new DatabaseError(DB_ERROR_CODES.UNSUPPORTED_OPERATION, 'getAllRepairs() غير متاحة في هذا السياق');
    }
    const all = getAllRepairs();
    return typeof filterFn === 'function' ? all.filter(filterFn) : all;
  }
  async create() { throw new DatabaseError(DB_ERROR_CODES.NOT_IMPLEMENTED, 'RepairRepository.create: يتطلب نموذج المعاملات المعتمَد (Phase 4.5) قبل التفعيل — البيانات اليوم مُقسَّمة يوميًا وليست مجموعة واحدة'); }
  async update() { throw new DatabaseError(DB_ERROR_CODES.NOT_IMPLEMENTED, 'RepairRepository.update: نفس القيد أعلاه'); }
  async delete() { throw new DatabaseError(DB_ERROR_CODES.NOT_IMPLEMENTED, 'RepairRepository.delete: نفس القيد أعلاه'); }
  async findById() { throw new DatabaseError(DB_ERROR_CODES.NOT_IMPLEMENTED, 'RepairRepository.findById: نفس القيد — استخدم findAll مع فلتر بدلًا منه حاليًا'); }
}
class ExpenseRepository extends Repository {
  constructor(){ super('expenses'); }
  async findAll() { throw new DatabaseError(DB_ERROR_CODES.NOT_IMPLEMENTED, 'ExpenseRepository: نفس قيد البيانات اليومية المُقسَّمة — لا دالة تجميع جاهزة مكافئة لـ getAllRepairs متاحة حاليًا لهذا الكيان'); }
  async create() { throw new DatabaseError(DB_ERROR_CODES.NOT_IMPLEMENTED, 'ExpenseRepository.create: نفس القيد'); }
  async update() { throw new DatabaseError(DB_ERROR_CODES.NOT_IMPLEMENTED, 'ExpenseRepository.update: نفس القيد'); }
  async delete() { throw new DatabaseError(DB_ERROR_CODES.NOT_IMPLEMENTED, 'ExpenseRepository.delete: نفس القيد'); }
  async findById() { throw new DatabaseError(DB_ERROR_CODES.NOT_IMPLEMENTED, 'ExpenseRepository.findById: نفس القيد'); }
}
// WalletRepository: يعمل فوق تهيئة المحافظ (الترتيب/الحدود/الرصيد الافتتاحي)
// المخزَّنة ككائن إعداد واحد (mshop_wallets) — "المعرّف" هنا هو اسم المحفظة نفسه.
class WalletRepository {
  async findAll() {
    if (typeof walletOrder === 'undefined') throw new DatabaseError(DB_ERROR_CODES.UNSUPPORTED_OPERATION, 'حالة المحافظ غير متاحة في هذا السياق');
    return walletOrder.map(name => ({ name, limit: walletLimits[name]||null, opening: walletOpening[name]||0 }));
  }
  async findById(name) {
    const all = await this.findAll();
    const found = all.find(w => w.name === name);
    if (!found) throw new DatabaseError(DB_ERROR_CODES.NOT_FOUND, `wallet "${name}" not found`);
    return found;
  }
  async create() { throw new DatabaseError(DB_ERROR_CODES.NOT_IMPLEMENTED, 'WalletRepository.create: إدارة المحافظ تمر حاليًا عبر saveWalletsCfg() في cash.js — لم تُربَط هنا لتفادي إعادة هيكلة كود مكتمل'); }
  async update() { throw new DatabaseError(DB_ERROR_CODES.NOT_IMPLEMENTED, 'WalletRepository.update: نفس القيد أعلاه'); }
  async delete() { throw new DatabaseError(DB_ERROR_CODES.NOT_IMPLEMENTED, 'WalletRepository.delete: نفس القيد أعلاه'); }
}

// ══ [Phase 8.3] Static Collection Repositories ══

class RepairPartRepository extends Repository {
  constructor() { super('repairParts'); }

  async initCache() {
    const records = await this.findAll();
    if (typeof repairParts !== 'undefined') {
      repairParts.length = 0;
      repairParts.push(...records);
    }
    return records;
  }

  async create(record) {
    const localEntity = this._mapper() ? this._fromDb(this._toDb(record)) : { ...record };
    if (typeof repairParts !== 'undefined') {
      repairParts.push(localEntity);
    }
    try {
      const savedEntity = await super.create(record);
      if (typeof repairParts !== 'undefined') {
        const idx = repairParts.indexOf(localEntity);
        if (idx !== -1) repairParts[idx] = savedEntity;
      }
      return savedEntity;
    } catch (err) {
      if (typeof repairParts !== 'undefined') {
        const idx = repairParts.indexOf(localEntity);
        if (idx !== -1) repairParts.splice(idx, 1);
      }
      throw err;
    }
  }

  async update(id, changes) {
    let backupItem = null;
    let targetIdx = -1;
    if (typeof repairParts !== 'undefined') {
      targetIdx = repairParts.findIndex(rp => rp.id === id);
      if (targetIdx !== -1) {
        backupItem = { ...repairParts[targetIdx] };
        repairParts[targetIdx] = { ...repairParts[targetIdx], ...changes };
      }
    }
    try {
      const savedEntity = await super.update(id, changes);
      if (typeof repairParts !== 'undefined' && targetIdx !== -1) {
        repairParts[targetIdx] = savedEntity;
      }
      return savedEntity;
    } catch (err) {
      if (typeof repairParts !== 'undefined' && targetIdx !== -1 && backupItem) {
        repairParts[targetIdx] = backupItem;
      }
      throw err;
    }
  }

  async delete(id) {
    let backupItem = null;
    let targetIdx = -1;
    if (typeof repairParts !== 'undefined') {
      targetIdx = repairParts.findIndex(rp => rp.id === id);
      if (targetIdx !== -1) {
        backupItem = repairParts[targetIdx];
        repairParts.splice(targetIdx, 1);
      }
    }
    try {
      const result = await super.delete(id);
      return result;
    } catch (err) {
      if (typeof repairParts !== 'undefined' && backupItem && targetIdx !== -1) {
        repairParts.splice(targetIdx, 0, backupItem);
      }
      throw err;
    }
  }
}

// ══ FaultTypeRepository — نوع عطل (mshop_fault_types) — الآن كيان موحّد {id, name, hidden} ══
// يمتد Repository ويستخدم المسار المركزي (Mapper → Adapter → Storage).
// initCache() تتولى تطبيع البيانات القديمة (نصوص / أobjetات بدون id).
class FaultTypeRepository extends Repository {
  constructor() { super('faultTypes'); }

  async initCache() {
    const raw = await this.findAll();
    let normalized = false;
    const data = raw.map((item, i) => {
      if (typeof item === 'string') {
        normalized = true;
        return { id: `ft_migrated_${i}`, name: item, hidden: false };
      }
      if (item && typeof item === 'object' && !item.id) {
        normalized = true;
        return { id: `ft_migrated_${i}`, name: item.name ?? '', hidden: item.hidden ?? false };
      }
      return item;
    });
    if (typeof faultTypes !== 'undefined') {
      faultTypes.length = 0;
      faultTypes.push(...data);
    }
    if (normalized) {
      const storageKey = this._adapter()._staticCfg('faultTypes').storageKey;
      Storage.save(storageKey, data);
    }
    return data;
  }

  async create(record) {
    const localEntity = this._fromDb(this._toDb(record));
    if (typeof faultTypes !== 'undefined') faultTypes.push(localEntity);
    try {
      const savedEntity = await super.create(record);
      if (typeof faultTypes !== 'undefined') {
        const idx = faultTypes.indexOf(localEntity);
        if (idx !== -1) faultTypes[idx] = savedEntity;
      }
      return savedEntity;
    } catch (err) {
      if (typeof faultTypes !== 'undefined') {
        const idx = faultTypes.indexOf(localEntity);
        if (idx !== -1) faultTypes.splice(idx, 1);
      }
      throw err;
    }
  }

  async update(id, changes) {
    let backupItem = null;
    let targetIdx = -1;
    if (typeof faultTypes !== 'undefined') {
      targetIdx = faultTypes.findIndex(f => f.id === id);
      if (targetIdx !== -1) {
        backupItem = { ...faultTypes[targetIdx] };
        faultTypes[targetIdx] = { ...faultTypes[targetIdx], ...changes };
      }
    }
    try {
      const savedEntity = await super.update(id, changes);
      if (typeof faultTypes !== 'undefined' && targetIdx !== -1) {
        faultTypes[targetIdx] = savedEntity;
      }
      return savedEntity;
    } catch (err) {
      if (typeof faultTypes !== 'undefined' && targetIdx !== -1 && backupItem) {
        faultTypes[targetIdx] = backupItem;
      }
      throw err;
    }
  }

  async delete(id) {
    let backupItem = null;
    let targetIdx = -1;
    if (typeof faultTypes !== 'undefined') {
      targetIdx = faultTypes.findIndex(f => f.id === id);
      if (targetIdx !== -1) backupItem = faultTypes.splice(targetIdx, 1)[0];
    }
    try {
      const result = await super.delete(id);
      return result;
    } catch (err) {
      if (typeof faultTypes !== 'undefined' && targetIdx !== -1 && backupItem) {
        faultTypes.splice(targetIdx, 0, backupItem);
      }
      throw err;
    }
  }
}

// ══ Centralized Repository Instances ══
const noteRepo = new NoteRepository();
const repairPartRepo = new RepairPartRepository();
const faultTypeRepo = new FaultTypeRepository();
const accessoryTransactionRepo = new AccessoryTransactionRepository();
const expenseTransactionRepo = new ExpenseTransactionRepository();
const phoneTransactionRepo = new PhoneTransactionRepository();
const usedPhoneTransactionRepo = new UsedPhoneTransactionRepository();
const softwareTransactionRepo = new SoftwareTransactionRepository();
const walletTransactionRepo = new WalletTransactionRepository();
const repairTransactionRepo = new RepairTransactionRepository();

// ══ توثيق مصدر الحقيقة (Source of Truth) — بلا أي تنفيذ، توضيح معماري فقط ══
// - المعاملات الخام (البيانات اليومية الفعلية) = المصدر الوحيد للحقيقة، دائمًا.
// - daily_summary مُشتَق دائمًا (راجع db_foundation.js) — لا يُعامَل أبدًا كسلطة نهائية.
// - أرصدة المحافظ (wallet_balances المستقبلي) مُشتقة دائمًا من نفس المبدأ.
// - كل التقارير الحالية (يومي/شهري/تحليلات) مُشتقة من المعاملات الخام عبر المحرك المالي الموحّد.
// - أي مزامنة مستقبلية يجب ألا تُزامِن أي جدول/بنية مُشتقة مباشرة أبدًا —
//   فقط المعاملات الخام تُزامَن، والمُشتقات تُعاد بناؤها محليًا بعد كل دمج.
