# ADR-021 — خصم الفاتورة أو السطر بحد للبيّاع وموافقة المالك بـ PIN، واستكمال شاشة البيع (البند 1.6)

- **الحالة:** مقبول (2026-10-17)
- **البند في الخطة:** `1.6` (`docs/PLAN.md` §4، §5، §19؛ `ADR-016` القرارات 4، 31؛ `ADR-017` §3؛ `HANDOFF_2026-10-17.md` §6)
- **المعاينة المرجعية:** `docs/ui/mockup-v1/pos.js` (`openDiscount`، `discCalc`، `exactCash`، `totals`) و`docs/ui/mockup-v1/views/settings.js` (`discountLimit`)

---

## 1. السياق والمطلوب

البند `1.6` في المرحلة الأولى يكمّل شاشة البيع للكمبيوتر كما في المعاينة المعتمدة:
1. **الخصم (`F3`):** على السطر المحدد أو على الفاتورة كلها، بنسبة مئوية (`%`) أو بمبلغ بالجنيه (`ج.م`).
2. **حد الخصم للبيّاع وموافقة المالك بـ PIN:**
   - إعداد نسبة الحد الأقصى للخصم من غير موافقة المالك (`ui.discount_limit_pct`، الافتراضي `5%` كما في `PLAN.md` §4 و`mockup-v1/app.js`).
   - أي خصم في حدود النسبة المسموحة (`discount_minor * 100 <= gross_subtotal_minor * limit_pct`) يتسجّل كعملية عادية (`Sensitivity::Routine`) من غير طلب PIN.
   - أي خصم **فوق الحد** (`discount_minor * 100 > gross_subtotal_minor * limit_pct`) يُعتبر عملية حساسة (`Sensitivity::Sensitive`) تتطلب **موافقة المالك بـ PIN** (`withOwnerApproval` ← `OWNER_APPROVAL_REQUIRED` ← `approval::consume_in_tx`) حتى لو المالك نفسه هو اللي فاتح الجلسة (`ADR-017` §3)، ويتسجّل `approved_by` على الفاتورة وفي سجل التدقيق (`sale_recorded`).
3. **أزرار واختصارات شاشة البيع (`PLAN.md` §5 و`pos.js`):**
   - زرار **«خصم F3»** وزرار **«كاش بالظبط»** في سلة الفاتورة.
   - اختصارات الكيبورد الكاملة: `Enter`، `Ctrl+Enter`، `F2` (الكمية)، `F3` (الخصم)، `F4` (العميل)، `F8` (انتظار)، `F12` (الدفع)، `Del` (حذف سطر)، `+ / −` (زيادة/نقص الكمية شاملة سطور الموبايلات)، `↑ / ↓` (اختيار سطر أو نتيجة بحث)، `/` (البحث)، `Esc`، و`Ctrl+L` (القفل).

---

## 2. القرار التصميمي

### 2.1 إعداد حد الخصم (`ui.discount_limit_pct`)

- يُخزَّن في `app_settings` تحت المفتاح `AppearanceKey::DiscountLimitPct` (`"ui.discount_limit_pct"`) كعدد صحيح من `0` إلى `100` (الافتراضي `"5"`).
- يُقرأ ضمن `read_appearance` ويُعدَّل بصلاحية `Permission::ManageCatalog` من كارت **«الخصم في شاشة البيع»** (`DiscountLimitCard.vue`) في الإعدادات.

### 2.2 ترحيلة `0022_sale_discounts.sql`

تُضاف الأعمدة التالية بشكل تجمعي (Additive) بدون تعديل أي ترحيلة سابقة:
- على جدول `sales`:
  - `discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0)`: إجمالي الخصم على الفاتورة بالقرش (شاملاً خصومات السطور وخصم الفاتورة العام)، بحيث `total_minor = gross_subtotal_minor - discount_minor`.
  - `approved_by TEXT NULL REFERENCES users (id) ON DELETE RESTRICT`: معرّف المالك الذي وافق بـ PIN عندما يتجاوز الخصم حد البيّاع (`NULL` في الفواتير العادية).
- على جدول `sale_lines`:
  - `discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0)`: الخصم على هذا السطر بالقرش، بحيث `line_total_minor = quantity * unit_selling_price_minor - discount_minor`.

### 2.3 التحقق في الدومين (`domain/sales/mod.rs`)

- لكل سطر: `0 <= line_discount_minor <= quantity * unit_price_minor`، وإلا يُرفض بـ `SALE_DISCOUNT_INVALID`.
- للفاتورة: `0 <= invoice_discount_minor <= sum(line_total_minor)`، وإلا يُرفض بـ `SALE_DISCOUNT_INVALID`.
- المقارنة مع حد البيّاع تتم بحساب صحيح بـ `i128` بدون أي أعداد عشرية عائمة:
  ```rust
  pub fn discount_exceeds_limit(
      gross_subtotal_minor: i64,
      total_discount_minor: i64,
      limit_pct: u8,
  ) -> bool
  ```
- عند إلغاء الفاتورة (`cancel_sale`): الفاتورة العكسية (`reversal`) تنسخ `discount_minor` على الفاتورة وعلى كل سطر، بحيث يبقى صافي المبيعات والخصومات والمدفوعات متطابقًا في التقفيل.
