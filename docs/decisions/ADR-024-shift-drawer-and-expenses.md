# ADR-024: الوردية والدرج والمصروفات (Shift, Drawer & Expenses)

- **الحالة:** معتمد ومُنفّذ (2026-10-18)
- **البند في الخطة:** `docs/PLAN.md` §12، §19 — البند **1.9**
- **يرتبط بـ:** `ADR-010` (المبالغ بالقروش الصحيحة)، `ADR-016` (القرارات 9 و10 و31 — بوابة جداول المرحلة 1)، `ADR-020` (طرق الدفع ودفتر الآجل)، `ADR-022` (تقرير الوردية للمالك على واتساب)

---

## 1. السياق والهدف

في نهاية اليوم (أو عند تسليم الوردية)، لازم البيّاع أو المالك يقفّل الوردية في **3 دقائق أو أقل** (`PLAN.md` §3 و§12)، ويطابق النقدية المعدودة في الدرج مع المتوقع محسوبًا تلقائيًا من سجلات العمليات نفسها:

1. **فتح الوردية (`open_shift`):** برصيد افتتاحي للدرج (`opening_cash_minor >= 0`) ورقم وردية متسلسل (`#1`, `#2`, …)، ولا يمكن فتح أكثر من وردية في نفس الوقت.
2. **المصروفات (`expenses`) وحركة الدرج (`cash_movements`):**
   - **المصروفات:** مصروف نقدي يخرج من الدرج أثناء الوردية المفتوحة بفئة/بند (`category` مثل `شاي وضيافة`، `مواصلات وشحن`، `أكياس وتغليف`، `كهرباء وفواتير`، `نثريات`) ومبلغ (`amount_minor > 0`) وملاحظة اختيارية (`note`).
   - **حركة الدرج (`cash_movements`):** سحب نقدية للمالك (`owner_draw` — «سحب المالك») أو إيداع نقدية/فكة في الدرج (`cash_in` — «إيداع فكة») بسبب صريح (`reason`).
3. **حساب المتوقع في الدرج (`expected_cash_minor`):**
   - يُحسب من السجلات الفعلية للوردية:
     $$\text{expected\_cash} = \text{opening\_cash} + \text{cash\_sales} + \text{customer\_cash\_in} + \text{cash\_in\_movements} - \text{expenses} - \text{owner\_draw}$$
   - مع عرض تفصيل طرق الدفع الأخرى خلال الوردية (`فودافون كاش`، `إنستاباي`، `فيزا / ميزة`، `تقسيط`، `آجل`) وصافي المبيعات وصافي الربح بعد المصروفات (`PLAN.md` §12).
4. **تقفيل الوردية (`close_shift`) في أقل من 3 دقائق:**
   - عدّ النقدية بالفئات المصرية (`200`, `100`, `50`, `20`, `10`, `5`, `1`, `0.5` ج.م) أو كتابة الإجمالي المعدود مباشرةً.
   - حساب الفرق (`difference_minor = counted_cash_minor - expected_cash_minor`): `0` («مظبوط»)، `< 0` («عجز»)، `> 0` («زيادة»)، مع ملاحظة اختيارية (`close_note`).
   - صلاحية التقفيل للمالك افتراضيًا، مع إعداد **`ui.seller_can_close_shift`** (`"on"` | `"off"`, افتراضي `"off"`) في الإعدادات يسمح للبيّاع بتقفيل الوردية لو المالك فعّله (`docs/ui/mockup-v1/pos.js` و`views/settings.js`).
   - إرسال ملخص تقرير الوردية للمالك على واتساب (`wa.me`) طالما لا توجد طابعة.

---

## 2. القرارات التصميمية

### 2.1 مخطط قاعدة البيانات (ترحيلة `0023_shifts_and_expenses.sql`)

تُضاف الجداول الثلاثة المعتمدة في بوابة القرار (`ADR-016` القرار 31، `HANDOFF_2026-10-17.md` §6):

1. **`shifts`:**
   - `id TEXT PRIMARY KEY`، `shift_number INTEGER NOT NULL UNIQUE CHECK (shift_number >= 1)`
   - `status TEXT NOT NULL CHECK (status IN ('open', 'closed'))`، مع فهرس فريد جزئي `idx_shifts_single_open ON shifts(status) WHERE status = 'open'` يضمن عدم فتح ورديتين في نفس الوقت على مستوى SQLite.
   - `opening_cash_minor INTEGER NOT NULL CHECK (opening_cash_minor >= 0)`
   - عند التقفيل (`status = 'closed'`): `expected_cash_minor`، `counted_cash_minor`، `difference_minor = counted_cash_minor - expected_cash_minor`، `close_note`، `closed_by`، `closed_at >= opened_at`.
   - Triggers تمنع حذف أي وردية (`shifts_no_delete`) وتمنع تعديل وردية بعد إغلاقها (`shifts_immutable_once_closed`).
2. **`expenses`:**
   - `id`, `shift_id REFERENCES shifts(id)`, `category`, `amount_minor > 0`, `note`, `created_by REFERENCES users(id)`, `created_at`.
   - Triggers تضمن أن الوردية مفتوحة وقت التسجيل (`expenses_require_open_shift`) وأن السجل append-only (`expenses_no_update`, `expenses_no_delete`).
3. **`cash_movements`:**
   - `id`, `shift_id REFERENCES shifts(id)`, `kind IN ('cash_in', 'owner_draw')`, `amount_minor > 0`, `reason`, `created_by REFERENCES users(id)`, `created_at`.
   - Triggers تضمن أن الوردية مفتوحة وقت التسجيل (`cash_movements_require_open_shift`) وأن السجل append-only (`cash_movements_no_update`, `cash_movements_no_delete`).

### 2.2 سجل التدقيق (`audit_events`)

كل عملية تُسجّل في نفس المعاملة الذرية (`tx`):
- `shift_opened` (`shift_id`, `shift_number`, `opening_cash_minor`)
- `expense_recorded` (`shift_id`, `expense_id`, `category`, `amount_minor`, `note`)
- `cash_movement_recorded` (`shift_id`, `movement_id`, `kind`, `amount_minor`, `reason`)
- `shift_closed` (`shift_id`, `shift_number`, `expected_cash_minor`, `counted_cash_minor`, `difference_minor`, `close_note`)
