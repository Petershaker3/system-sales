# ADR-020: مدفوعات الفاتورة ودفتر آجل العميل (كاش، محافظ، إنستاباي، كارت، تقسيط، آجل، ودفع مقسّم)

- **الحالة:** معتمد
- **التاريخ:** 2026-10-18
- **البند:** 1.5 من المرحلة 1 (`docs/PLAN.md` §8 و§19؛ `ADR-016` #16 و#31؛ `HANDOFF_2026-10-17.md` §6)

## السياق

الفاتورة في المحل قد تُدفع كاش، أو فودافون كاش (محافظ)، أو إنستاباي، أو كارت على ماكينة البنك الخارجية، أو تقسيط شركة، أو آجل على عميل مسجّل، أو مقسّمة بين أكثر من طريقة في نفس الفاتورة (مثل جزء كاش والباقي فودافون كاش أو آجل). وكل طريقة غير الكاش يمكن للمالك تفعيلها أو قفلها من الإعدادات بحيث لا تظهر الطريقة المقفولة في شاشة الدفع.

## القرارات

### 1. طرق الدفع وتفعيلها من الإعدادات (`ui.pay_methods`)
- طرق الدفع المعتمدة:
  - `cash` («كاش»): مفعّلة دائمًا ولا يمكن قفلها.
  - `vf` («فودافون كاش»): محافظ إلكترونية، مع مرجع اختياري.
  - `instapay` («إنستاباي»): تحويل إنستاباي، مع مرجع اختياري.
  - `card` («فيزا / ميزة»): ماكينة البنك الخارجية، تسجيل فقط مع مرجع اختياري.
  - `install` («تقسيط»): شركات التقسيط (`valU`، `سهولة`، `Sympl`، `حالًا`، `كونتكت`) وتُحفظ الشركة في `reference`.
  - `credit` («آجل»): دين على العميل المسجّل، يتطلب ربط عميل (`customer_id`) ويُرحَّل إلى `customer_ledger`.
- تُحفظ الطرق المفعّلة في `app_settings` تحت المفتاح `ui.pay_methods` (`AppearanceKey::PayMethods`، بصلاحية `Permission::ManageCatalog`) بقيمة افتراضية `"cash,vf,instapay,card,install,credit"`.
- الطريقة المقفولة تختفي من شاشة الدفع، كما يرفض الـ Backend أي عملية دفع بها (`SALE_PAYMENT_METHOD_DISABLED`).

### 2. جدول `sale_payments` (ترحيل `0021`)
- `sale_payments(id, sale_id, payment_no, method, amount_minor, reference, occurred_at)`:
  - يمثّل دفعة واحدة أو جزءًا من دفعة مقسّمة على الفاتورة (`sales.id`).
  - مجموع `amount_minor` لكل صفوف الفاتورة يساوي `sales.total_minor` بالقرش (`SALE_PAYMENT_TOTAL_MISMATCH`).
  - في الفواتير ذات الإجمالي الموجب (`total_minor > 0`) يجب أن يكون كل `amount_minor > 0`.
  - الجدول للإضافة فقط (`BEFORE UPDATE` و`BEFORE DELETE` ترفض التعديل والحذف).
  - عند إلغاء فاتورة (`cancel_sale`)، تُنسخ صفوف `sale_payments` على وثيقة الإلغاء (`reversal`) ليبقى صافي كل طريقة دفع في التقفيل (`sale` ناقص `reversal`) مطابقًا للدرج والمحافظ بالقرش.

### 3. البيع الآجل وجدول `customer_ledger` (ترحيل `0021`)
- أي دفعة بطريقة `credit` تشترط وجود `customer_id` لعميل حي غير مؤرشف على الفاتورة (`SALE_CREDIT_REQUIRES_CUSTOMER`)، ويُفرض ذلك في طبقة الخدمات وبتريجر قاعدة بيانات (`sale_payments_credit_requires_customer`).
- `customer_ledger(id, customer_id, kind, amount_minor, method, sale_id, note, actor_id, occurred_at)`:
  - `kind = 'credit_sale'`: قيد آجل موجب (`amount_minor > 0`) مرتبط بـ `sale_id` يُكتب داخل نفس معاملة البيع.
  - `kind = 'sale_reversal'`: قيد عكسي سالب (`amount_minor < 0`) مرتبط بوثيقة الإلغاء عند إلغاء فاتورة كان فيها جزء آجل.
  - `kind = 'payment'`: سداد من العميل (`amount_minor < 0`) بطريقة تحصيل (`cash`، `vf`، `instapay`، `card`) عبر الأمر `record_customer_payment`.
- رصيد العميل الآجل (`balance_minor = COALESCE(SUM(amount_minor), 0)`) يُعرض مع بيانات العميل في شاشة البيع ونافذة الدفع.
