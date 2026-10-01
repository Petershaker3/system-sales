# Historical Reference Snapshot — خطة التنفيذ

> **لمنفذي الوكلاء:** تُنفذ كل شريحة بعد مراجعة المواصفة المعتمدة في `docs/superpowers/specs/2026-10-02-historical-reference-snapshot-design.md`، وبموافقة صريحة جديدة من المالك. **لا يُنفَّذ أي كود من هذه الخطة قبل ذلك.**

**الهدف:** طبقة شهور تاريخية محفوظة (read-only) يعرضها النظام الجديد عند فتح أي شهر سابق لتاريخ الإطلاق، **بدون** إعادة حساب، و**بدون** أي بيانات تشغيلية من النظام القديم.

**المعمارية:** ملف JSON ثابت مُدمَج في الـbinary وقت الـcompile عبر `include_str!`، تقرؤه وحدة Rust واحدة. نقطة قرار واحدة `resolve_month()` ترجع `Historical | Live | Unavailable`. صفر قاعدة بيانات، صفر I/O وقت التشغيل، صفر writes.

**التقنيات:** Rust + `serde`/`serde_json` فقط. **لا** SQLx، **لا** SQLite، **لا** Supabase، **لا** Tauri commands لهذه الطبقة. المال `i64` الصحيح — **ممنوع** `f64`/`REAL` (-spec:49).

**المواصفة:** `docs/superpowers/specs/2026-10-02-historical-reference-snapshot-design.md`

---

## شرط مسبق — BLOCKER

**مستودع Tauri غير موجود بعد.** متحقَّق منه في `2026-10-02`:

```text
src-tauri/    ❌ غير موجود
src/          ❌ غير موجود
tests/        ❌ غير موجود
Cargo.toml    ❌ غير موجود
```

`spec:88` ينصّ: *"لا يوجد test runner أو build script للتطبيق الجديد بعد"*. لذلك:

> **كل المهام من Task 1 فصاعدًا معلّقة على إنشاء scaffold Tauri** حسب البنية في `spec:56-67`، وهو نفسه مثاليّ في خطة `docs/superpowers/plans/2026-09-28-mobile-shop-system.md`.

- ⛔ **لا تُنشئ `src-tauri/` من أجل هذه الخطة.** الـscaffold قرار معماري منفصل، وصناعته هنا يعني قفز فوق تجربة Tauri المعتمدة (`spec:40`).
- Task 0 (توثيق) هي الوحيدة القابلة للتنفيذ الآن.

---

## قيود عامة — Global Constraints

These apply to every task implicitly:

- **ممنوع** أي جدول SQLite أو migration للـHistorical Reference.
- **ممنوع** أي Supabase/RLS usage.
- **ممنوع** أي write path أو API لتعديل الأرقام.
- **ممنوع** fallback يحسب الشهر التاريخي من بيانات حية.
- **ممنوع** استخدام قيم Historical كـ**baseline** أو كـ**test anchor**.
- **ممنوع** `grossProfit` المخزَّن — مش حقل مستقل في التقرير القديم.
- **ممنوع** `_rolled` / `cashType` / أي شرط `mshop_*`.
- **ممنوع** أي `arithmetic` داخل `historical.rs` (spec §6.1).
- **ممنوع** نقل شروط §8 إلى كود تشغيلي — هي validation وقت التجهيز فقط.
- **ممنوع** `f64`/`REAL` لكل الأرقام — `i64` فقط.
- ممنوع تعديل أي ملف خارج `src-tauri/` و`docs/` (عدا Task 0).
- ⚠️ `product/` **لا يُلمس ولا يُؤرشف** في هذه الخطة — انظر Task 0.

---

## Task 0: توثيق قرار أرشفة `product/` (توثيق فقط — لا تنفيذ)

**Files:**
- Create: `docs/decisions/ADR-006-archive-legacy-product-stack.md`
- ❌ **لا تنشئ** `archive/legacy-project/product/`
- ❌ **لا تنقل أو تحذف** أي ملف من `product/`

**Interfaces:**
- Consumes: لا شيء.
- Produces: قرار موثّق `ADR-006` يقابله شجرة `product/` (~4,700 سطر Rust غير متتبَّع).

- [ ] **Step 1: اكتب ADR-006**

محتوى إلزامي: الحالة (accepted)، شجرة `product/` المتعارضة مع القرار، وجهة الأرشفة المعتمدة `archive/legacy-project/` (حسب `spec:66`)، و**أن الأرشفة لم تُنفَّذ** ولماذا (تُنفَّذ كخطوة مستقلة بموافقة منفصلة).

- [ ] **Step 2: تأكد إن `product/` سليم**

```bash
Test-Path "product/importer/src/bin/mshop-import.rs"   # True
Test-Path "product/schema/migrations/0001_init.sql"    # True
git status --short product/                             # ?? product/
```

**لا تنفّذ الأرشفة. هذا التوثيق فقط.**

---

## Task 1: ملف الموارد `historical-months.json`

**Files:**
- Create: `src-tauri/resources/historical-months.json`

**Interfaces:**
- Consumes: أرقام spec §4 (الأربعة months).
- Produces: `historical-months.json` — **مصفوفة** كائنات، ترتيبها تقويمي.

- [ ] **Step 1: أنشئ الملف بالترتيب التقويمي**

مصفوفة من 4 كائنات، نفس الحقول في spec §4 بالترتيب: `2026-06` (مع `partial: true` و `coverage`)، `2026-07`، `2026-08`، `2026-09`. كل رقم حرفي من الـspec.

- [ ] **Step 2: تحقق أن الملف JSON صالح**

```bash
python -c "import json;d=json.load(open(r'src-tauri/resources/historical-months.json',encoding='utf-8'));print(len(d),[m['month'] for m in d])"
```

Expected: `4 ['2026-06', '2026-07', '2026-08', '2026-09']`

---

## Task 2: الأنواع + الربط بـ`include_str!`

**Files:**
- Create: `src-tauri/src/domain/historical.rs`
- Modify: `src-tauri/src/domain/mod.rs` (إضافة `pub mod historical;`)
- Modify: `src-tauri/Cargo.toml` (إضافة `serde` + `serde_json`)

**Interfaces:**
- Consumes: `historical-months.json` من Task 1.
- Produces: `HistoricalMonth`، `Coverage`، `MonthSource`، `FIRST_LIVE_MONTH`، `historical_month()`، `resolve_month()`.

- [ ] **Step 1: اكتب الاختبار الفاشل أولًا**

في `src-tauri/tests/historical_tests.rs`:

```rust
use newapp::domain::historical::{historical_month, resolve_month, MonthSource};

#[test]
fn resource_file_has_four_months_in_order() {
    let all = historical_month("2026-06").expect("2026-06 must be present");
    assert!(all.month.eq("2026-06"));
    for ym in ["2026-07", "2026-08", "2026-09"] {
        assert!(historical_month(ym).is_some(), "{ym} must be present");
    }
    assert!(historical_month("2026-05").is_none());
}
```

**Expected:** FAIL — `mod historical` غير موجود.

- [ ] **Step 2: شغّل，确认 الفشل**

```bash
cargo test --test historical_tests
```
Expected: compile error `could not find historical in domain`.

- [ ] **Step 3: اكتب الأنواع**

```rust
//! Historical Reference Snapshot — read-only.
//!
//! الوحدة **تقرأ وتعرض فقط**. ممنوع منعًا باتًا أي دالة تعيد حساب
//! `reportedTotal` أو `netProfit` أو `operationCount` — انظر spec §6.1.
//! كل القيم تُقرأ من JSON مُدمَج وقت الـcompile وتُعرض كما هي.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::OnceLock;

/// أول شهر يحسبه النظام الجديد. `>=` هذا الشهر = Live.
pub const FIRST_LIVE_MONTH: &str = "2026-10";

const RAW: &str = include_str!("../../resources/historical-months.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Coverage {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoricalMonth {
    pub month: String,
    /// شهر جزئي — البيانات لا تغطي الشهر كاملًا.
    pub partial: bool,
    pub coverage: Option<Coverage>,
    /// إجمالي **تقرير النظام القديم**، لا كل المبيعات — انظر spec §5.1.
    pub reported_total: i64,
    pub net_profit: i64,
    pub accessory_sales: i64,
    pub accessory_profit: i64,
    pub used_sales: i64,
    pub used_profit: i64,
    pub cash_total: i64,
    pub software_total: i64,
    pub expenses_total: i64,
    pub new_phone_sales: i64,
    pub new_phone_profit: i64,
    pub repair_service_total: i64,
    pub repair_profit: i64,
    pub operation_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MonthSource {
    /// أرقام محفوظة من النظام القديم — read-only.
    Historical(&'static HistoricalMonth),
    /// يحسبه النظام الجديد من بياناته التشغيلية.
    Live,
    /// لا snapshot ولا نظام جديد — ليس "شهر بلا نشاط".
    Unavailable,
}

static MONTHS: OnceLock<BTreeMap<String, HistoricalMonth>> = OnceLock::new();

fn months() -> &'static BTreeMap<String, HistoricalMonth> {
    MONTHS.get_or_init(|| {
        let parsed: Vec<HistoricalMonth> = serde_json::from_str(RAW)
            .expect("historical-months.json is embedded and validated by the build");
        parsed.into_iter().map(|m| (m.month.clone(), m)).collect()
    })
}

/// lookup فقط — مفيش حساب.
pub fn historical_month(ym: &str) -> Option<&'static HistoricalMonth> {
    months().get(ym)
}

/// نقطة القرار الوحيدة. ترتيب الفحص مهم — spec §3.1.
pub fn resolve_month(ym: &str) -> MonthSource {
    if let Some(m) = historical_month(ym) {
        return MonthSource::Historical(m);
    }
    if ym >= FIRST_LIVE_MONTH {
        return MonthSource::Live;
    }
    MonthSource::Unavailable
}
```

**ملاحظات تنفيذ إلزامية:**
- `RAW` المسار: `../../resources/...` لأن الملف عند `src-tauri/src/domain/historical.rs`.
- `deny_unknown_fields` يكشف خطأ الإملاء في الـJSON فور البناء.
- `resolve_month` يفحص الـsnapshot **أولًا**؛ لو رجع `Unavailable` لـ`2026-06` فالمشكلة في الملف مش في المقارنة.
- `ym` نص مُجرَّد بلا validation لـ`YYYY-MM`. مدخل مشوّه يرجع `Unavailable`. قرار مقصود: يتجنّب `Result` في مسار الـUI. ❌ لا تضف regex parsing هنا — مش في النطاق.

- [ ] **Step 4: `pub mod historical;`**

في `src-tauri/src/domain/mod.rs`. لو `domain/` لسه فاضي، أنشئ الملف:

```rust
pub mod historical;
```

- [ ] **Step 5: `Cargo.toml`**

```toml
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

**داخل `[dependencies]`**، مش `[dev-dependencies]` — `include_str!` يحتاج `serde_json` وقت البناء.

- [ ] **Step 6: شغّل الاختبار**

```bash
cargo test --test historical_tests
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/resources/historical-months.json src-tauri/src/domain/historical.rs src-tauri/src/domain/mod.rs src-tauri/Cargo.toml src-tauri/tests/historical_tests.rs
git commit -m "feat: add read-only historical reference snapshot layer"
```

---

## Task 3: اختبارات عقد Historical Reference

**Files:**
- Modify: `src-tauri/tests/historical_tests.rs`

**Interfaces:**
- Consumes: Task 2.
- Produces: تغطية حدود `resolve_month` + شكل البيانات.

> ⚠️ **خط أحمر — خط التمييز.**
> **مسموح:** تأكيد البنية والحدود والشكل (type, presence, enum variant, `partial`/تغطية).
> **ممنوع:** تأكيد أي **قيمة رقمية** (`assert_eq!(m.reported_total, 89625)`) — ده test anchor، ممنوع بالقرار.
> ممنوع كمان تأكيد صدق المعادلات (spec §8) — دي validation وقت التجهيز، تُحذف ولا تدخل الكود.

- [ ] **Step 1: اختبار حدود `resolve_month`**

```rust
#[test]
fn boundary_resolves_correctly() {
    // شهر محفوظ
    assert!(matches!(resolve_month("2026-09"), MonthSource::Historical(_)));
    // الشهر المرجعي نفسه = Live، لا Historical — تمنع الازدواج
    assert_eq!(resolve_month("2026-10"), MonthSource::Live);
    assert_eq!(resolve_month("2026-11"), MonthSource::Live);
    // أقدم من البيانات القديمة ولا محفوظ
    assert_eq!(resolve_month("2026-05"), MonthSource::Unavailable);
    assert_eq!(resolve_month("2020-01"), MonthSource::Unavailable);
}

#[test]
fn every_snapshot_month_is_before_first_live_month() {
    for ym in ["2026-06", "2026-07", "2026-08", "2026-09"] {
        let m = historical_month(ym).unwrap();
        assert!(m.month < FIRST_LIVE_MONTH, "{ym} must precede the live boundary");
        assert!(matches!(resolve_month(ym), MonthSource::Historical(_)));
    }
}
```

- [ ] **Step 2: اختبار الشهر الجزئي (يونيو)**

```rust
#[test]
fn june_is_marked_partial_with_coverage() {
    let june = historical_month("2026-06").expect("2026-06 must be present");
    assert!(june.partial, "2026-06 coverage starts 2026-06-10 — must be flagged partial");
    let c = june.coverage.as_ref().expect("partial month must declare coverage");
    assert_eq!(c.from, "2026-06-10");
    assert_eq!(c.to, "2026-06-30");
}

#[test]
fn full_months_are_not_partial() {
    for ym in ["2026-07", "2026-08", "2026-09"] {
        let m = historical_month(ym).unwrap();
        assert!(!m.partial, "{ym} is a full month");
        assert!(m.coverage.is_none(), "{ym} must not declare coverage");
    }
}
```

- [ ] **Step 3: اختبار شكل الأرقام — بدون تثبيت قيم**

```rust
#[test]
fn all_values_are_non_negative_integers() {
    for ym in ["2026-06", "2026-07", "2026-08", "2026-09"] {
        let m = historical_month(ym).unwrap();
        let fields = [
            m.reported_total, m.net_profit, m.accessory_sales, m.accessory_profit,
            m.used_sales, m.used_profit, m.cash_total, m.software_total,
            m.expenses_total, m.new_phone_sales, m.new_phone_profit,
            m.repair_service_total, m.repair_profit, m.operation_count,
        ];
        for (name, v) in [
            ("reported_total", m.reported_total), ("net_profit", m.net_profit),
            ("accessory_sales", m.accessory_sales), ("accessory_profit", m.accessory_profit),
            ("used_sales", m.used_sales), ("used_profit", m.used_profit),
            ("cash_total", m.cash_total), ("software_total", m.software_total),
            ("expenses_total", m.expenses_total), ("new_phone_sales", m.new_phone_sales),
            ("new_phone_profit", m.new_phone_profit),
            ("repair_service_total", m.repair_service_total),
            ("repair_profit", m.repair_profit), ("operation_count", m.operation_count),
        ] {
            assert!(v >= 0, "{ym}.{name} must not be negative");
        }
        let _ = fields; // shape-only traversal
    }
}
```

- [ ] **Step 4: مراجعة يدوية — لا إعادة حساب في `historical.rs`**

**هذه ليست اختبار Rust.** لا تبني reflection على أسماء الدوال ولا دالة اختبار فارغة — تعقيد بلا فائدة في مشروع بهذا الحجم. التحقق **يدوي في الـPR**:

اعتمد هذا الـcheck في الـPR description:

```bash
# يجب أن يخرج فارغًا
grep -nE 'fn (recompute_|derive_|count_|calculate_)' src-tauri/src/domain/historical.rs
# يجب أن يخرج فارغًا
grep -nE 'f64|f32|as f64' src-tauri/src/domain/historical.rs
# كل القيم i64
grep -n 'i64' src-tauri/src/domain/historical.rs | head -20
```

**معايير القبول:**
1. الـgrep الأول **فارغ** — مفيش دالة تعيد حساب أي حقل.
2. الـgrep الثاني **فارغ** — مفيش `f64`/`f32` إطلاقًا.
3. الـgrep الثالث يوكّد أن كل حقول `HistoricalMonth` معلنة `i64`.
4. `MonthSource` فيه **ثلاث** variants بالضبط — `Historical` / `Live` / `Unavailable`. مفيش رابع.
5. الدوال العامة **اثنتان بالضبط**: `historical_month()` و`resolve_month()`.

> أي انحراف = ⛔ STOP. الرجوع لـspec §6.1.

- [ ] **Step 5: شغّل**

```bash
cargo test --test historical_tests
```
Expected: كل الاختبارات PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/tests/historical_tests.rs
git commit -m "test: cover historical reference contract and boundaries"
```

---

## Task 4: توثيق الوحدة

**Files:**
- Create: `docs/decisions/ADR-005-historical-reference-snapshot.md`
- Create: `src-tauri/src/domain/HISTORICAL.md`

**Interfaces:**
- Consumes: Task 2, 3.
- Produces: تحذيرات `reportedTotal`/`cashTotal` قريبة من الكود.

- [ ] **Step 1: `HISTORICAL.md`**

محتوى إلزامي، بنفس تحذيرات spec §5:

> - **`reportedTotal` ليس إجمالي المبيعات** = `accessorySales + softwareTotal + cashTotal` فقط. **لا يحتوي** `usedSales` ولا `newPhoneSales`.
> - **`cashTotal` ليس صافي كاش** — النظام القديم جمع `amount` بدون النظر لـ`cashType`.
> - **`2026-06` شهر جزئي** — البيانات تبدأ `2026-06-10`.
> - الوحدة **read-only**. ممنوع أي إعادة حساب.
> - مصدر الأرقام: SHA-256 `BB1AF604438C7CA16B08B20E32D4D8A6BA614B2710F37FE3ACF63AAD301C72F5`.

- [ ] **Step 2: ADR-005**

نفس محتوى §6/§7 من الـspec: الحالة (accepted)،/link to spec، والـForbidden list.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/domain/HISTORICAL.md docs/decisions/ADR-005-historical-reference-snapshot.md
git commit -m "docs: document historical reference boundary and field semantics"
```

---

## Task 5: فصل Historical عن الـLive (ربط، بدون data migration)

**Files:**
- Create: `src-tauri/src/modules/reports/month_resolver.rs`
- Modify: `src-tauri/src/modules/reports/mod.rs`

**Interfaces:**
- Consumes: `resolve_month()` من Task 2.
- Produces: `reports::resolve_report_month(ym) -> ReportMonthSource` — الحدّ الوحيد بين Historical والـLive.

- [ ] **Step 1: صمّم الـwrapper**

```rust
//! الحدّ الوحيد بين التقرير التاريخي المحفوظ والتقرير الحي.
//! لا مكان آخر في النظام يقرّر إن الشهر تاريخي أم حي.

use crate::domain::historical::{resolve_month, HistoricalMonth, MonthSource};

pub enum ReportMonthSource {
    /// أرقام محفوظة — تُعرض كما هي. لا تُعاد ولا تُشتق منها.
    StoredSnapshot { month: &'static HistoricalMonth },
    /// يُحسب من بيانات النظام الجديدة.
    ComputeLive,
    /// لا توجد بيانات لهذه الفترة.
    NoData,
}

pub fn resolve_report_month(ym: &str) -> ReportMonthSource {
    match resolve_month(ym) {
        MonthSource::Historical(m) => ReportMonthSource::StoredSnapshot { month: m },
        MonthSource::Live => ReportMonthSource::ComputeLive,
        MonthSource::Unavailable => ReportMonthSource::NoData,
    }
}
```

**هذا آخر مكان مسموح فيه الشجرة بالإشارة للـHistorical.**

- [ ] **Step 2: اختبار**

```rust
#[test]
fn report_layer_maps_all_three_states() {
    assert!(matches!(resolve_report_month("2026-09"), ReportMonthSource::StoredSnapshot { .. }));
    assert_eq!(resolve_report_month("2026-10"), ReportMonthSource::ComputeLive);
    assert_eq!(resolve_report_month("2026-05"), ReportMonthSource::NoData);
}
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/modules/reports/month_resolver.rs src-tauri/src/modules/reports/mod.rs src-tauri/tests/historical_tests.rs
git commit -m "feat: bound reports layer to historical reference boundary"
```

---

## ما لن يتم تنفيذه

### ممنوع تمامًا

- ❌ **أي** SQLite migration أو جدول أو seed للـHistorical Reference.
- ❌ **أي** Supabase/RLS usage.
- ❌ **أي** write path، API، أو شاشة تعديل للأرقام المحفوظة.
- ❌ **أي** runtime arithmetic في `historical.rs` — لا `recompute_*` ولا `derive_*` ولا `count_*`.
- ❌ **أي** إعادة إنتاج لـlegacy business logic: لا `_rolled`، لا `cashType`، لا شرط `mshop_*`، لا ترشيح الأقسام الستة.
- ❌ **استخدام Historical كـbaseline أو test anchor** — لا مقارنة للمحرك الجديد، ولا تأكيد لقيم رقمية في الاختبارات.
- ❌ **`grossProfit` المخزَّن أو المحسوب هنا.**
- ❌ **`f64`/`REAL`** — `i64` فقط.
- ❌ **ترحيل بيانات تشغيلية** من النظام القديم — لا منتج، لا عميل، لا مخزون، لا فاتورة.
- ❌ **مزامنة Historical مع الـLive** — مستقلان تمامًا.
- ❌ **اعتبار Historical `Source of Truth`** — من `2026-10` النظام الجديد هو المرجع.
- ❌ **إنشاء `src-tauri/` من أجل هذه الخطة** (شرط مسبق، spec §الـscaffold).
- ❌ **أرشفة `product/`** — Task 0 توثيق فقط.

### خارج النطاق

- ربط الـUI واختيار إطاره (`spec:40`, `spec:75`) — قرار منفصل بعد تجربة Tauri.
- شهور قديمة غير `2026-06`…`2026-09` — البيانات غير موجودة في الـexport.
- بيانات `2026-10-01` الموجودة في الملف القديم — **لا تُرحَّل**؛ أكتوبر أول شهر حي.

---

## Self-Review

**تغطية الـspec:** §3 `resolve_month` → Task 2 ✅ · §3.1 ترتيب الفحص → Task 2 + Task 3 ✅ · §4 الأرقام → Task 1 ✅ · §5 الفخّان → Task 4 ✅ · §5.3 `grossProfit` → ممنوع ✅ · §6 الملفات → Tasks 1,2,4,5 ✅ · §6.1 صفر arithmetic → Task 2 + Task 3 ✅ · §7 الممنوع → Global Constraints + ما لن يتم تنفيذه ✅ · §8 validation وقت التجهيز → **مستبعد عمدًا** ✅ (معروض في constraints كـ«ممنوع نقلها»).

**تطابق الأنواع:** `MonthSource` متطابق بين Task 2 وTask 5 ✅ · `FIRST_LIVE_MONTH` مُعرَّف في Task 2 ومستخدم في Task 3 ✅ · `historical_month()` مُعرَّفة في Task 2 ومسمّاة في Task 3 ✅ · `ReportMonthSource` جديد في Task 5 فقط ولا يُعيد تصدير `MonthSource` للواجهة ✅.

**اسم `src-tauri/tests/historical_tests.rs`:** المشروع يفضل `tests/integration/` (spec:63) — لكن اختبارات هذا الملف unit-tests لوحدةRust بلا SQLite، فـ`src-tauri/tests/` هو موقع Rust القياسي. **موثّق كـdeviation مقصود.**

**Placeholders:** لا يوجد `TBD`/`TODO`. Task 3 Step 4 **محدّد عمدًا كمراجعة يدوية** لا كاختبار Rust — `grep` في الـPR بدل reflection على أسماء الدوال، لأن reflection تعقيد بلا فائدة في مشروع بهذا الحجم.

**عيوب معروفة في الخطة (مقصودة ومش مؤجلة):**
- `serde` يُضاف كـdependency لـ**وقت البناء** (`serde_json` لـ`include_str!` parsing). حجم اعتماد كبير لـطبقة read-only — مقبول لأن البيانات immutable، لكن لو كبر الملف يُعاد التقييم لاستخدام `no_std` parsing أو build script.
- lookup خطي عبر `BTreeMap` (4 عناصر). مقصود بـYAGNI؛ لو تجاوز 12 شهرًا يُعاد التقييم.