# ADR-026: المرتجع الجزئي والاستبدال و«مخزون تالف» — Partial Returns, Exchanges, and Damaged Stock (البند 1.11)

**الحالة:** مقبول ومنفّذ في الكود (accepted & implemented — 2026-10-18).

**يعتمد على:**
- [`ADR-002`](./ADR-002-inventory-costing.md) — المتوسط المرجح المتحرك والتكلفة الفعلية لوحدات الـIMEI.
- [`ADR-013`](./ADR-013-costing-moving-average-and-fifo.md) — لقطة التكلفة الدائمة على سطر البيع والمرتجع بتكلفة السطر الأصلية (`D7`).
- [`ADR-016`](./ADR-016-owner-plan-2026-10-16.md) — القراران 9 و10 و31 (المرتجع الجزئي أو الكلي بـPIN المالك بتكلفة السطر الأصلية، والتالف إلى «مخزون تالف» بتكلفته ولا يعود للبيع، والاستبدال = مرتجع + بيع، واعتماد جداول المرحلة 1).
- [`ADR-017`](./ADR-017-pin-approval-recovery-code.md) — موافقة المالك بـPIN المالك لعملية حساسة واحدة (`Sensitivity::Sensitive`).
- [`ADR-019`](./ADR-019-optional-imei-units-and-receiving.md) — وحدات الـIMEI الاختيارية (`units`).
- [`ADR-020`](./ADR-020-invoice-payments-and-customer-credit-ledger.md) — مدفوعات الفاتورة (`sale_payments`) ودفتر الآجل (`customer_ledger`).
- [`ADR-021`](./ADR-021-sale-discounts-and-pos-completion.md) — خصم السطر وخصم الفاتورة (`discount_minor`).
- [`ADR-024`](./ADR-024-shift-drawer-and-expenses.md) و[`ADR-025`](./ADR-025-wallets-and-services-ledger.md) — حسابات الوردية والدرج وأرصدة المحافظ.

---

## 1. السياق والهدف

في الواقع اليومي لمحل الموبايلات (`docs/PLAN.md` §10 و§19):
1. العميل ممكن يرجّع **صنف واحد أو كمية جزئية** من فاتورة فيها أكتر من صنف، أو يرجّع الفاتورة على أكتر من مرة، مش لازم إلغاء الفاتورة كلها مرة واحدة (`cancel_sale`).
2. المرتجع عملية حساسة تحتاج **موافقة المالك بالـPIN** (`Sensitivity::Sensitive`) حتى لو المالك نفسه هو اللي فاتح الجلسة.
3. الصنف المرتجع يعود **بتكلفة السطر الأصلية المسجلة وقت البيع** (`D7`، `ADR-016` #7 و#9)، مش بالتكلفة الحالية في المخزن.
4. الصنف المرتجع له حالتان:
   - **سليم (`intact`):** يرجع لرصيد المخزن القابل للبيع (`stock_levels` + حركة `sale_reversal` في `stock_movements`)، ولو كان جهاز بالـIMEI ترجع وحدته في جدول `units` لحالة `in_stock`.
   - **تالف (`damaged`):** يدخل في **«مخزون تالف» (`damaged_stock`)** بتكلفته الأصلية، **ولا يعود لرصيد البيع** (`stock_levels`)، ولو كان جهاز بالـIMEI تتحول وحدته إلى `retired` مع سبب التلف عشان ما يتباعش تاني بالغلط.
5. **الاستبدال (`exchange`) = مرتجع + بيع جديد في عملية واحدة** (`BEGIN IMMEDIATE` واحدة بموافقة PIN مالك واحدة)، والفرق بين قيمة الأصناف الجديدة وقيمة المرتجع هو اللي بيتحصّل من العميل أو يرجع له.
6. **رد الفلوس (`refund`):** يرجع **بنفس طريقة الدفع الأصلية افتراضيًا** (يخصم من كاش الدرج في الوردية لو `cash`، أو من رصيد محفظة المحل لو `vf`/`instapay`، أو ينزّل من مديونية العميل في `customer_ledger` لو `credit`)، مع إمكانية اختيار طريقة الرد وقت العملية.

---

## 2. المخطط والترحيلة `0025_partial_returns_and_damaged_stock.sql`

الترحيلة `0025` إضافية بالكامل (purely additive) ولا تعدّل أي ترحيلة سابقة:

1. **إضافة عمودين اختياريين على `sale_lines`:**
   - `reverses_line_id TEXT NULL REFERENCES sale_lines (id) ON DELETE RESTRICT`: يربط كل سطر مرتجع بسطر البيع الأصلي الذي أُرجع منه.
   - `return_condition TEXT NULL CHECK (return_condition IS NULL OR return_condition IN ('intact', 'damaged'))`: يحدد حالة السطر المرتجع (`intact` = سليم، `damaged` = تالف).

2. **جدول `sale_returns` (سجل عمليات المرتجع والاستبدال، للإضافة فقط):**
   - `id TEXT PRIMARY KEY NOT NULL`
   - `original_sale_id TEXT NOT NULL REFERENCES sales (id) ON DELETE RESTRICT`
   - `return_sale_id TEXT NOT NULL UNIQUE REFERENCES sales (id) ON DELETE RESTRICT` (وثيقة `sales` من نوع `kind = 'reversal'` تحمل السطور المرتجعة ومدفوعات الرد)
   - `exchange_sale_id TEXT NULL UNIQUE REFERENCES sales (id) ON DELETE RESTRICT` (وثيقة الفاتورة الجديدة عند الاستبدال في عملية واحدة، أو `NULL` في المرتجع العادي)
   - `refund_minor INTEGER NOT NULL CHECK (refund_minor >= 0)`
   - `cost_returned_minor INTEGER NOT NULL CHECK (cost_returned_minor >= 0)` (التكلفة المستردة للمخزن السليم)
   - `damaged_cost_minor INTEGER NOT NULL DEFAULT 0 CHECK (damaged_cost_minor >= 0)` (تكلفة الأصناف التالفة المسجلة في `damaged_stock`)
   - `reason TEXT NOT NULL CHECK (length(trim(reason)) > 0 AND length(reason) <= 200)`
   - `actor_id TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT`
   - `approved_by TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT`
   - `occurred_at INTEGER NOT NULL`
   - محمي بـTriggers تمنع التعديل والحذف (`sale_returns_no_update` و`sale_returns_no_delete`).

3. **جدول `damaged_stock` («مخزون تالف» — للإضافة فقط):**
   - `id TEXT PRIMARY KEY NOT NULL`
   - `product_id TEXT NOT NULL REFERENCES products (id) ON DELETE RESTRICT`
   - `sale_id TEXT NOT NULL REFERENCES sales (id) ON DELETE RESTRICT` (الفاتورة الأصلية)
   - `return_sale_id TEXT NOT NULL REFERENCES sales (id) ON DELETE RESTRICT` (وثيقة المرتجع)
   - `sale_line_id TEXT NOT NULL REFERENCES sale_lines (id) ON DELETE RESTRICT` (سطر البيع الأصلي)
   - `return_line_id TEXT NOT NULL REFERENCES sale_lines (id) ON DELETE RESTRICT` (سطر المرتجع)
   - `unit_id TEXT NULL REFERENCES units (id) ON DELETE RESTRICT` (وحدة الـIMEI إن وُجدت)
   - `quantity INTEGER NOT NULL CHECK (quantity > 0)`
   - `unit_cost_minor INTEGER NOT NULL CHECK (unit_cost_minor >= 0)`
   - `total_cost_minor INTEGER NOT NULL CHECK (total_cost_minor >= 0)`
   - `reason TEXT NOT NULL CHECK (length(trim(reason)) > 0 AND length(reason) <= 200)`
   - `actor_id TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT`
   - `approved_by TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT`
   - `occurred_at INTEGER NOT NULL`
   - محمي بـTriggers تمنع التعديل والحذف (`damaged_stock_no_update` و`damaged_stock_no_delete`).

---

## 3. القواعد الحسابية والمحاسبية

1. **حساب تكلفة وسعر السطر المرتجع (`compute_partial_line_return`):**
   - لكل سطر أصلي كميته `Q` وتكلفته الإجمالية `C` وخصمه `D`:
   - عند إرجاع كل الكمية المتبقية في السطر (`q == remaining_qty`)، يأخذ السطر المرتجع **الباقي الفعلي بالظبط** (`C - already_returned_cost` و`D - already_returned_discount`)، بحيث مجموع المرتجعات الجزئية لأي سطر يساوي دائمًا 100% من تكلفة وقيمة السطر الأصلي بدون أي فرق تقريب.
   - عند إرجاع جزء أقل من المتبقي (`q < remaining_qty`)، تُحسب التكلفة والخصم بالنسبة الصحيحة (`(C * q) / Q` باستخدام `i128`)، ويُحفظ `line_total_minor = (q * unit_selling_price_minor) - return_discount_minor` متوافقًا مع قيد `sale_lines_discount_within_gross`.
2. **خصم الفاتورة العام (`invoice_discount_minor`):**
   - لو الفاتورة الأصلية عليها خصم عام إضافي فوق خصومات السطور، يُوزّع تناسبيًا على المرتجع الجزئي، وعند إرجاع آخر قطعة متبقية في الفاتورة يسترد العميل الرصيد المتبقي بالظبط (`original.total_minor - already_refunded_minor`).
3. **الأثر على المخزن والدرج والمحافظ والآجل:**
   - **السليم (`intact`):** يزود `stock_levels.quantity` و`stock_levels.total_cost_minor` ويكتب حركة `sale_reversal` في `stock_movements` بنفس الكمية والتكلفة، فيحافظ على متطابقة دفتر الحركات `stock_levels.quantity = SUM(stock_movements.quantity_delta)`.
   - **التالف (`damaged`):** يُسجّل في `damaged_stock` بتكلفته الأصلية، ولا يكتب حركة في `stock_movements` ولا يزود `stock_levels`، فلا يعود للبيع أبدًا.
   - **وثيقة المرتجع (`sales.kind = 'reversal'`):**
     - `total_minor = refund_minor`.
     - `cost_total_minor = cost_returned_minor` (تكلفة السليم الراجع للمخزن فقط؛ وبذلك فإن التالف يظل مخصومًا من صافي الربح بقدر تكلفته الفعلية، فضلًا عن ظهوره المستقل في `damaged_stock`).
     - مدفوعات الرد في `sale_payments` تخصم تلقائيًا من مبيعات الكاش والمتوقع في الدرج (`shifts`) ومن أرصدة المحافظ (`wallets`)، وأي جزء `credit` يكتب قيد `sale_reversal` سالب في `customer_ledger`.
