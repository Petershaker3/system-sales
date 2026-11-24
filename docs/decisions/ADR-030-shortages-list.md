# ADR-030: قايمة النواقص واقتراحات المخزن والربط مع البيع والاستلام (البند 1.15)

- **التاريخ:** 2026-10-18
- **الحالة:** مقبول ومنفّذ
- **المراجع:** `docs/PLAN.md` §11 و§19؛ `docs/ui/SALES-SHORTAGES.md`؛ `ADR-016` (#20 و#31)؛ `HANDOFF_2026-10-17.md` §4؛ المعاينة `docs/ui/mockup-v1/views/shortages.js` و`docs/ui/mockup-v1/pos.js`.

---

## السياق

ينص `docs/PLAN.md` §11 و§19 (البند **1.15** — ختام المرحلة 1) و`docs/ui/SALES-SHORTAGES.md` على بناء قايمة **«النواقص»** ككراسة محل حية تجمع:

- **تبويبان في شاشة «المخزن» (`StoreScreen.vue`):**
  - **«الأصناف»** و**«النواقص (عددها)»** مع شارة بعدد النواقص النشطة (`open` + `ordered`).
- **الإضافة اليدوية للنواقص (بواسطة المالك أو أي بيّاع):**
  - اختيار صنف من المخزن (بحث مباشر بالاسم أثناء الكتابة) أو كتابة اسم صنف حر غير مسجّل في المحل لو العميل سأل عليه.
  - تحديد الكمية المطلوبة، وملاحظة اختيارية، وبيانات **عميل مستني** (اسم أو رقم تليفون، اختياري).
  - إضافة نفس الصنف مرة ثانية وهو ما زال في النواقص النشطة **تزيد الكمية المطلوبة** وتحدّث الملاحظة وبيانات العميل المنتظر بدل تكرار الصف.
- **الإضافة السريعة من شاشة البيع (`PosScreen.vue`) بدون الخروج من الفاتورة:**
  - إذا بحث البيّاع عن صنف ولم تخرج أي نتيجة: زر **«لو العميل طالبه: ضيف ‹...› للنواقص»**.
  - إذا ظهر الصنف في البحث وكان رصيده المتاح `0` (`خلصان`): زر **«ضيف للنواقص»** بجانبه بالكمية المقترحة.
- **مقترح من المخزن (اقتراحات النظام التلقائية):**
  - الأصناف النشطة التي وصلت إلى حد الطلب (`min_qty` الافتراضي: `5` للإكسسوارات والأصناف بالعدد، `2` للموبايلات الجديدة، `1` للمستعمل) أو خلصت (`on_hand == 0`) وليست مسجّلة بالفعل في النواقص النشطة.
  - الكمية المقترحة للطلب: `max(1, min_qty * 2 - on_hand)`، مع زر **«ضيفه للنواقص»** لكل صف وزر **«ضيف الكل»**.
- **دورة حياة الصنف في النواقص:**
  - **«ناقص» (`open`) ↔ «اتطلب» (`ordered`) → «وصل» (`resolved_at IS NOT NULL`)**.
  - عند الضغط على **«وصل»** أو عند **استلام بضاعة (`receive_stock` / `receive_opening_stock`)** لصنف مربوط في النواقص، يُغلق السجل تلقائياً (`resolved_at`) ويظهر تنبيه واضح؛ وإذا كان هناك عميل ينتظره يظهر اسمه ورقمه في التنبيه (`«...» وصل، و... مستنيه: ...`).
  - الحذف النهائي (`delete_shortage`) متاح للمالك أو لِمَن سجّل الصنف فقط.

---

## القرار

1. **الترحيلة `0026_shortages.sql` وفق المخطط المعتمد (`ADR-016` #31):**
   - جدول `shortages` (`STRICT`) بالحقول المعتمدة حرفياً:
     `shortages(id, product_id NULL, name, qty, note, customer_name NULL, customer_phone NULL, status open|ordered, created_by, created_at, resolved_at NULL)`
     مع فهرسي `idx_shortages_active` و`idx_shortages_product`.
2. **طبقات النطاق والبيانات والخدمة والأوامر (`src-tauri/src/{domain,data/repositories,services,commands}/shortage.rs`):**
   - دوال النطاق النقية في `domain::shortage` (`default_min_qty`، `suggested_qty`، `normalize_shortage_name`، `ShortageStatus`، و`ShortageError` بسبعة أكواد خطأ مطابقة لـ`src/api/errors.ts`).
   - ستة أوامر Tauri محمية بصلاحية الجلسة (`Permission::Sell` مع قصر الحذف لغير المالك على مَن أنشأ السجل) ومسجّلة في ` audit_log` (`SHORTAGE_ADDED`، `SHORTAGE_UPDATED`، `SHORTAGE_RESOLVED`، `SHORTAGE_DELETED`):
     `shortages_overview`، `add_shortage`، `set_shortage_status`، `resolve_shortage`، `delete_shortage`، `add_all_suggested_shortages`.
   - ربط تلقائي داخل معاملة استلام المخزن (`services::inventory::stock::receive_with_units` عبر `shortage_repo::resolve_shortages_for_product`).
3. **الواجهة (`ShortagesPanel.vue` و`StoreScreen.vue` و`PosScreen.vue` و`StockPanel.vue`):**
   - وحدة دوال نقية مختبرة في `src/screens/store/shortages.ts` (`src/screens/store/shortages.test.ts`).
   - لوحة `ShortagesPanel.vue` داخل تبويب «النواقص» في `StoreScreen.vue`، والإضافة السريعة من بحث `PosScreen.vue`، وتنبيه العميل المنتظر عند الاستلام في `StockPanel.vue`.
