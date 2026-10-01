# Historical Reference Snapshot — Design

> **للProduct Owner:** هذا مستند تصميم، مش تنفيذ. لا ينفَّذ أي كود قبل موافقة صريحة.
> المصدر: `docs/superpowers/specs/2026-09-28-mobile-shop-system.md`، `docs/decisions/ADR-004`.

**الحالة:** بانتظار موافقة الـProduct Owner
**تاريخ:** 2026-10-02
**النطاق:** Historical Reference فقط — لا operational migration، ولا legacy business logic.

---

## 1. المشكلة والهدف

النظام الجديد مستقل تمامًا عن النظام القديم. لكن المستخدم بتاع محل بيع محتاج لما يفتح شهر قبل تاريخ إطلاق النظام الجديد، يشوف **أرقامه الحقيقية**، مش شاشة فاضية.

**الهدف:** طبقة شهور تاريخية محفوظة (read-only) يعرضها النظام الجديد عند فتح أي شهر سابق لتاريخ الإطلاق، **بدون** أي إعادة حساب، و**بدون** أي بيانات تشغيلية من النظام القديم.

**ما ليس هدفًا:**
- ليس baseline مقارنة، ولا حساب، ولا test anchor، ولا مصدر لمنطق تشغيل.
- ليس `Source of Truth`. من شهر الإطلاق وما بعده، النظام الجديد يحسب كل شيء بمعماريته هو.
- لا يعيد إنتاج أي `legacy business logic`.

---

## 2. القرارات المغلقة

| القرار | القيمة | من |
|---|---|---|
| الشكل | `Approach A` — static JSON asset + Rust module | Product Owner |
| الستاك | Tauri 2 + Rust/SQLx + SQLite | Product Owner |
| حد البداية/النهاية | ثابت `FIRST_LIVE_MONTH = "2026-10"` | Product Owner |
| أسماء الحقول | أسماء مقروءة | Product Owner |
| نطاق الـsnapshot | `2026-06`, `2026-07`, `2026-08`, `2026-09` | Product Owner |
| يونيو | يظهر مع علامة "شهر جزئي" | Product Owner |
| `product/` | أرشفة إلى `archive/legacy-project/` | Product Owner |

مصدر الأرقام: `محل_كل_البيانات_2026-10-01.json`
SHA-256: `BB1AF604438C7CA16B08B20E32D4D8A6BA614B2710F37FE3ACF63AAD301C72F5` — `920,404` bytes — 96 يوم — `2026-06-10` → `2026-10-01`

المحرك: `computeFinancialTotals` من `dev_extracted/dev/js/ui.js:33-50` — **نسخة حرفية**، بدون تفسير.

---

## 3. الدالة الحدّية — `resolve_month`

نقطة قرار واحدة. لا مكان آخر في النظام يقرّر إن الشهر تاريخي أم حي.

```rust
pub const FIRST_LIVE_MONTH: &str = "2026-10";

pub enum MonthSource {
    Historical(&'static HistoricalMonth), // أرقام محفوظة، read-only
    Live,                                 // يحسبه النظام الجديد من بياناته
    Unavailable,                          // لا بيانات ولا تاريخ — ليس "شهر بلا نشاط"
}

pub fn resolve_month(ym: &str) -> MonthSource;
```

**الحالة الثالثة `Unavailable` إلزامية.** شهر مثل `2026-05` سابق على كل من البيانات القديمة (`2026-06-10`) وإطلاق النظام. لو رجع `Live`، الـUI هيعرض "نظام جديد — لا يوجد نشاط"، وده **ادعاء كاذب**: أنت ما كنتش مستخدم في writable zero. لازم يبقى "لا توجد بيانات لهذه الفترة".

### 3.1 — قاعدة المقارنة: `>=` مش `<`

```rust
// pseudo-code — الترتيب مهم
if let Some(m) = lookup(ym)          { MonthSource::Historical(m) }
else if ym >= FIRST_LIVE_MONTH       { MonthSource::Live }
else                                { MonthSource::Unavailable }
```

**`2026-10` نفسه يرجع `Live`، مش `Historical`.** غير كده هيتحسب مرتين: مرة من snapshot، ومرة من بيانات النظام الجديد.

**ومش** `ym > FIRST_LIVE_MONTH`، لأن ده هيسيب أكتوبر في `Unavailable`.

نقطة الدقة: `ym < FIRST_LIVE_MONTH` **لا تكفي**. لو كانت هي القاعدة، أي شهر بين `2026-06` و`2026-09` بيرجع صح — لكن `2026-05` هيرجع غلط. القاعدة الفعلية هي **"هل الشهر محفوظ في الـsnapshot؟"**، مش **"أقدم من الإطلاق؟"**. الترتيب الصحيح:

1. لو الشهر محفوظ في الـsnapshot → `Historical`
2. لو `ym >= FIRST_LIVE_MONTH` → `Live`
3. غير ذلك → `Unavailable`

---

## 4. الأرقام المعتمدة

ترتيب **تقويمي**. كل شهر `VERIFIED` — مُعتمد من الـProduct Owner.

### `2026-06` — **شهر جزئي** (18 يوم من 30، يبدأ `2026-06-10`)

`VERIFIED` — مع علامة `partial` وإعلان التغطية.

```json
{
  "month": "2026-06", "partial": true,
  "coverage": { "from": "2026-06-10", "to": "2026-06-30" },
  "reportedTotal": 57804, "netProfit": 27547,
  "accessorySales": 50405, "accessoryProfit": 23182,
  "usedSales": 9100,  "usedProfit": 1800,
  "cashTotal": 3924,  "softwareTotal": 3475, "expensesTotal": 11459,
  "newPhoneSales": 26100, "newPhoneProfit": 3040,
  "repairServiceTotal": 11210, "repairProfit": 3585,
  "operationCount": 891
}
```

### `2026-07` — شهر كامل (27 يوم)

```json
{
  "month": "2026-07",
  "reportedTotal": 107902, "netProfit": 35676,
  "accessorySales": 95600, "accessoryProfit": 40041,
  "usedSales": 5850,  "usedProfit": 750,
  "cashTotal": 7667,  "softwareTotal": 4635, "expensesTotal": 38832,
  "newPhoneSales": 218550, "newPhoneProfit": 20430,
  "repairServiceTotal": 2980, "repairProfit": 985,
  "operationCount": 1502
}
```

### `2026-08` — شهر كامل (25 يوم)

```json
{
  "month": "2026-08",
  "reportedTotal": 95040, "netProfit": 29671,
  "accessorySales": 84455, "accessoryProfit": 36474,
  "usedSales": 10200, "usedProfit": 1500,
  "cashTotal": 6690,  "softwareTotal": 3895, "expensesTotal": 31058,
  "newPhoneSales": 124890, "newPhoneProfit": 11970,
  "repairServiceTotal": 800, "repairProfit": 200,
  "operationCount": 1272
}
```

### `2026-09` — شهر كامل (25 يوم)

الشهر المرجعي الأصلي — أول شهر اعتمده الـProduct Owner.

```json
{
  "month": "2026-09",
  "reportedTotal": 89625, "netProfit": 31964,
  "accessorySales": 80305, "accessoryProfit": 32267,
  "usedSales": 5250,   "usedProfit": 1000,
  "cashTotal": 5600,   "softwareTotal": 3720, "expensesTotal": 28823,
  "newPhoneSales": 166140, "newPhoneProfit": 18200,
  "repairServiceTotal": 0, "repairProfit": 0,
  "operationCount": 1081
}
```

---

## 5. فخّان لازم يتوثّقوا في الكود

الاسم المقروء **مش كافي** هنا. حقول اتنين فيها معنى مضلل لو حد قراها من غير سياق:

**5.1 — `reportedTotal` ليس إجمالي المبيعات**

```js
const total = aS + sT + cT;   // ui.js:47 — مُستخرَج وقت التجهيز فقط، NOT business logic
```

`reportedTotal` = `accessorySales + softwareTotal + cashTotal` **فقط**.
**لا يحتوي** على `usedSales` ولا `newPhoneSales` — ودّي أكبر بنود الإيراد (سبتمبر: `166,140 + 5,250`).

لو مطور قرأ `reportedTotal: 89625` واعتبره "إجمالي المبيعات"، خطأ بحدود `171,390`. لازم يبقى عليه تحذير صريح في الـRust doc comment والـREADME. **اسم `reportedTotal` موجود بالظبط عشان يمنع هذا الخطأ.**

**5.2 — `cashTotal` ليس صافي الكاش**

`ui.js:40` بتجمع `i.amount` **بدون** النظر لـ`cashType`. في الملف كله `296` صف نوعه `سحب`، وكل الـ`amount` قيمها موجبة — يعني السحوبات بتتحسب **تدفقات داخلة**.

لذلك `cashTotal` = كاش **تقرير قديم**، مش رصيد صافي. (في سبتمبر بالذات كل الصفوف `ايداع`، فمفيش أثر — لكن الاسم لازم يمنع الخطأ في أي شهر تاني.)

**5.3 — `grossProfit` مش مخزَّن عن قصد**

`grossProfit = netProfit + expensesTotal`. مش حقل مستقل في التقرير القديم. تخزينه = توريث legacy business logic. **ممنوع.**

---

## 6. الملفات

| الملف | الدور |
|---|---|
| `src-tauri/resources/historical-months.json` | الأرقام المعتمدة. immutable. |
| `src-tauri/src/domain/historical.rs` | الأنواع + `resolve_month()` + lookup فقط. **read-only، صفر arithmetic** |
| `src-tauri/tests/historical_tests.rs` | اختبارات العقد فقط (parsing، boundary، lookup) — مش اختبارات أرقام |
| `docs/decisions/ADR-005-historical-reference-snapshot.md` | هذا القرار |

`historical.rs` يعتمد على JSON بـ`include_str!` وقت الـcompile — **مفيش I/O وقت التشغيل، مفيش path resolution، مفيش فشل تحميل**. الـsnapshot موجود في الـbinary.

### 6.1 — `historical.rs` لا يحسب شيئًا

الوحدة **تقرأ وتعرض فقط**. الدوال المتاحة:

```rust
pub fn resolve_month(ym: &str) -> MonthSource;      // lookup
pub fn historical_month(ym: &str) -> Option<&'static HistoricalMonth>; // lookup
```

**ممنوع منعًا باتًا** أي دالة من الشكل ده:

```rust
fn recompute_reported_total(m: &HistoricalMonth) -> i64 { ... }  // ⛔
fn derive_net_profit(m: &HistoricalMonth) -> i64 { ... }         // ⛔
fn count_operations(m: &HistoricalMonth) -> i64 { ... }         // ⛔
```

`reportedTotal` و`netProfit` و`operationCount` **قيم محفوظة تُقرأ كما هي**. لو النظام محتاج يشتق منها حاجة، بتتم في طبقة الـUI أو الـreports الجديدة، **بمعمارية النظام الجديد**، ومفيش أي reusable helper في `historical.rs` يخدم الغرضين.

---

## 7. الممنوع

- ❌ أي جدول في SQLite أو migration للـhistorical reference
- ❌ أي Supabase/RLS usage
- ❌ أي write path أو API لتعديل الأرقام
- ❌ fallback يحسب الشهر التاريخي من بيانات حية
- ❌ اختبارات تعتمد على الأرقام كـanchor للمحرك الجديد
- ❌ `grossProfit` المخزَّن
- ❌ reintroducing `_rolled` / `cashType` / أي شرط `mshop_*`
- ⛔ **أي arithmetic في `historical.rs`** — لا `recompute_*` ولا `derive_*` ولا `count_*` (انظر §6.1)
- ⛔ **نقل شروط §8 إلى كود تشغيلي** — التحقق وقت التجهيز فقط، ونتايجه تُحذف ولا تدخل أي ملف مصدر

---

## 8. التحقق وقت التجهيز — Preparation-time Validation Only

> **هذه الشروط لا تُنفَّذ داخل النظام الجديد.** هي خطوات مراجعة تُطبَّق على الـJSON **قبل** اعتماده، مرة واحدة، بواسطة أداة/سكربت خارج المستودع. مفيش نسخة منها بتُنسخ لـ`historical.rs` ولا لأي كود تشغيلي.

الـ`HistoricalMonth` في النظام الجديد **passive data struct**. مفيش فيه أي arithmetic. مفيش دالة تعيد حساب أي حقل.

الشروط المستخدمة **مرة واحدة أثناء التجهيز** للتأكد إن الـJSON المتولّد صحيح:

| # | الشرط | الغرض |
|---|---|---|
| 1 | `reportedTotal == accessorySales + softwareTotal + cashTotal` | كشف خطأ نسخ/جمع في إعداد الملف |
| 2 | `netProfit == accessoryProfit + usedProfit + cashTotal + softwareTotal + newPhoneProfit + repairProfit − expensesTotal` | نفس الغرض |
| 3 | تغطية الشهر الجزئي معلنة صراحةً والـ`coverage` مطابقة للبيانات | منع عرض شهر ناقص كأنه كامل |
| 4 | كل شهر في الملف له `source.sha256` | إمكانية إعادة التوليد والمقارنة |

**الرقم 3 المحذوف عمدًا:** لم يعد هناك ما يتحقق منه في وقت التشغيل. `operationCount` محفوظ كقيمة، والنظام الجديد يعرضها كما هي بدون أي اشتقاق.

**ملاحظة على `(1)`/`(2)`:** هذه كانت معادلات النظام القديم وقت الاستخراج. توثيقها هنا لتفسير **منشأ** الأرقام، مش لإعادة إنتاجها. عند تشغيل التحقق، النتيجة **تُحذف** ولا تدخل أي ملف مصدر.

---

## 9. خارج النطاق

- أرشفة `product/` ← **مهمة مستقلة**، موثّقة في خطة التنفيذ كخطوة صفر.
- بيانات `2026-10-01` الموجودة في الملف القديم: **لا تُرحَّل**. أكتوبر أول شهر حي، ويبدأ من جديد بمعمارية النظام الجديد. قرار صريح.
- ربط الـUI: أي الشاشة تعرض الحالة `Historical`/`Unavailable` بسرعة — خارج هذا المستند.

---

## 10. القرارات المغلقة

1. ✅ الموافقة على التصميم ككل — مع التعديلين.
2. ✅ `total` → **`reportedTotal`** (Product Owner).
3. ✅ `historical.rs` read-only، صفر arithmetic (Product Owner).
4. ✅ شروط §8 = validation وقت التجهيز فقط، مش business logic (Product Owner).
5. ✅ `2026-10` ترجع `Live` — أول شهر حي، وبيانات الملف القديم لتو لا تُرحَّل (Product Owner).

**لا يتبقى قرار مفتوح في هذا المستند.**
</invoke>