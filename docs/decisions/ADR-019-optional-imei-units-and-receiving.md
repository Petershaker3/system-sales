# ADR-019: وحدات الـ IMEI الاختيارية، والاستلام وأول المدة، وبيع الأجهزة

**الحالة:** مقبول (2026-10-17). تنفيذ لموافقة البوابة على جداول المرحلة 1 ([`ADR-016`](ADR-016-owner-plan-2026-10-16.md) القرارات 8 و30 و31 و34) بشكل الاقتراحات في [`docs/PLAN.md`](../PLAN.md) §7 و§11 والـhandoff (§6 في [`HANDOFF_2026-10-17.md`](../../HANDOFF_2026-10-17.md)). أي حاجة أكبر من الاقتراح بترجع للبوابة.

**البند:** 1.4 في [`tasks/todo.md`](../../tasks/todo.md).

---

## السياق

- الموبايل في المحل ساعات بيتستلم بالـIMEI جهاز جهاز، وساعات بيتستلم بالعدد بس في الزحمة وبعدين الـIMEI يتمسح من العلبة ساعة البيع، وساعات بيتباع من غير IMEI خالص لو الوضع اختياري.
- المالك ممكن كمان يفعّل وضع «إلزامي لكل جهاز» من الإعدادات بحيث أي استلام أو بيع لموبايل لازم يكون بالـIMEI.
- أول يوم شغل محتاج تفريقة واضحة في الاستلام بين «توريد من مورد» (`supplier` — مشتريات عادية، روتينية) و«بضاعة موجودة عندي أول مرة» (`opening` — رصيد افتتاحي، ميتحسبش مشتريات، وبيحتاج موافقة PIN المالك لأنه عملية حساسة بتضيف قيمة للمخزن من غير فاتورة مورد).

## القرار

### 1. قاعدة البيانات — ترحيلة `0020_imei_units_and_receiving.sql`

إضافة بس، في حدود اقتراحات §6 المعتمدة في البوابة:

1. **`products.tracking`:**
   - `TEXT NOT NULL DEFAULT 'none' CHECK (tracking IN ('none', 'serial_optional', 'serial_required'))`
   - أي موبايل (`brand_id IS NOT NULL`) بياخد `serial_optional` تلقائيًا في الترحيلة وعند التسجيل في `create_phone`.
2. **`stock_movements.receipt_kind`:**
   - `TEXT NULL CHECK (receipt_kind IS NULL OR receipt_kind IN ('supplier', 'opening'))`
   - مسموح بس لما `kind = 'receipt'` (بـ triggers في القاعدة)، ولما `receipt_kind = 'opening'` ممنوع يتحط `supplier_name`.
3. **جدول `units`:**
   - `id TEXT PRIMARY KEY NOT NULL` (UUID v7)
   - `product_id TEXT NOT NULL REFERENCES products (id) ON DELETE RESTRICT`
   - `imei TEXT NOT NULL UNIQUE` — 15 رقم بالظبط (`GLOB` من 15 خانة أرقام) + فحص Luhn في الدومين.
   - `imei2 TEXT NULL UNIQUE` — اختياري، 15 رقم مختلف عن `imei`.
   - `color TEXT NULL` — لون الجهاز لو اتحدد (مُرحّل من 1.2 خطوة 2 للوحدة نفسها).
   - `unit_cost_minor INTEGER NOT NULL CHECK (unit_cost_minor >= 0)` — التكلفة الفعلية للجهاز بالقروش.
   - `status TEXT NOT NULL CHECK (status IN ('in_stock', 'sold', 'retired'))`
   - `received_movement_id TEXT NULL REFERENCES stock_movements (id) ON DELETE RESTRICT` (`NULL` لو الجهاز اتسجّل ساعة البيع من رصيد غير مسجّل).
   - `sale_line_id TEXT NULL REFERENCES sale_lines (id) ON DELETE RESTRICT`
   - `retired_reason TEXT NULL` — سبب الإخراج التلقائي (مثلًا `'untracked_sale_overflow'` لما موبايل يتباع من غير IMEI والرصيد الباقي يبقى أقل من الأجهزة المسجلة).
   - `created_by TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT`
   - `created_at INTEGER NOT NULL`
4. **`sale_lines.unit_id`:**
   - `TEXT NULL REFERENCES units (id) ON DELETE RESTRICT` — بيربط سطر البيع بالوحدة اللي اتباعت بـIMEI.

*(ملحوظة: تفاصيل المستعمل الموجود في المحل أول يوم متأجلة للمرحلة 2 حسب `ADR-016` القرار 34).*

### 2. إعداد المحل `ui.imei_mode`

- بيتحفظ في `app_settings` تحت مفتاح `ui.imei_mode` بقيمتين: `'optional'` (الافتراضي) أو `'required'`.
- بيغيره المالك من «الإعدادات ← الأصناف والبيع ← تتبع الـ IMEI في الموبايلات» بصلاحية `ManageCatalog`.
- لما يكون `'required'`، أي موبايل (`tracking != 'none'`) لازم يستلم بعدد أجهزة مسجلة يساوي الكمية بالظبط، ولازم يتباع بـIMEI لكل قطعة.

### 3. الاستلام وأول المدة (`receive_with_units` / `receive_opening_stock`)

- كل سطر استلام بيشتغل في Transaction واحدة:
  - لو `receipt_kind = 'supplier'`: عملية روتينية (`Sensitivity::Routine`)، ومسموح فيها باسم المورد الاختياري.
  - لو `receipt_kind = 'opening'`: عملية حساسة (`Sensitivity::Sensitive`) بتستهلك موافقة PIN المالك جوه نفس الـTransaction، وبترفض أي اسم مورد (`RECEIPT_OPENING_HAS_SUPPLIER`).
- لكل IMEI مبعوت مع الاستلام:
  - بيتفحص إنه 15 رقم وبـLuhn سليم (`IMEI_LENGTH_INVALID` / `IMEI_CHECK_DIGIT_INVALID`).
  - بيتفحص إنه مش متكرر جوه نفس الدفعة (`IMEI_DUPLICATE_IN_BATCH`) ومش مسجّل قبل كده في المحل (`IMEI_ALREADY_REGISTERED`).
  - عدد الـIMEIs مينفعش يزيد عن الكمية المستلمة (`IMEI_COUNT_EXCEEDS_QUANTITY`)، ولو وضع الـIMEI إلزامي لازم يساوي الكمية بالظبط (`IMEI_REQUIRED_FOR_ALL_UNITS`).
  - كل جهاز بيتسجّل في `units` بتكلفته الفعلية (`unit_cost_minor`) وحالته `'in_stock'`.

### 4. البيع وإلغاء البيع (`record_sale_with_units` / `cancel_sale`)

- **البيع بـIMEI مسجّل (`status = 'in_stock'`):**
  - بيتأكد إن الجهاز موجود في المحل ولنفس الصنف، وبيعلّمه `'sold'` ويربطه بسطر الفاتورة (`sale_lines.unit_id` و`units.sale_line_id`).
  - تكلفة السطر بتكون التكلفة الفعلية للوحدة المسجلة (`unit.unit_cost_minor`)، وبتتخصم من `stock_levels` ومن دفتر الحركات بنفس الرقم بالظبط.
- **البيع بـIMEI جديد وقت البيع (تسجيل متأخر من العلبة):**
  - لو الـIMEI مش مسجّل في `units`، بس الصنف عنده رصيد غير مسجّل (`on_hand > in_stock_units.len()`)، السيستم بيفحص Luhn، ويحسب تكلفته من المتوسط المرجح للرصيد غير المسجّل، ويسجّله في `units` ويربطه بالبيعة في خطوة واحدة.
  - لو كل الرصيد اللي على الرف متسجّل ليه IMEIs بالفعل (`on_hand == in_stock_units.len()`)، بيرفض تسجيل IMEI غريب (`IMEI_NO_UNREGISTERED_STOCK`).
- **البيع من غير IMEI (في الوضع الاختياري):**
  - بيخصم من الرصيد غير المسجّل الأول بالمتوسط المرجح.
  - لو الكمية المباعة خلت الرصيد الباقي على الرف أقل من عدد وحدات الـIMEI المسجلة في المحل (`in_stock_units.len() > remaining_on_hand`)، السيستم بيشيل **أقدم وحدة مسجلة** (`ORDER BY created_at ASC, id ASC`) تلقائيًا (`status = 'retired'`, `retired_reason = 'untracked_sale_overflow'`, `sale_line_id = line.id`) وياخد تكلفتها الفعلية، عشان عدد الأجهزة المسجلة في المحل عمره ما يزيد عن الرصيد الفعلي.
- **إلغاء الفاتورة (`cancel_sale`):**
  - بيرجّع الرصيد والتكلفة لـ`stock_levels`، وبيرجّع أي وحدة اتباعت أو اتشالت تلقائيًا مع السطر ده لحالة `'in_stock'`.
