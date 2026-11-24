# مراجعة تكميلية للاستلام — ٥ نوفمبر ٢٠٢٦

مراجعة مركّزة على سبع نقاط طلبها صاحب المحل بعد تسليم شاشة الاستلام الموحّدة. كل بند هنا
مكتوب بحالته الحقيقية: **Verified** (اتشغّل واتأكد منه)، **Unverified** (الكود موجود ومتحقّق
منه بالقراءة بس)، **Not tested**، أو **Blocked** (مع السبب).

---

## ١. المورد / التاجر — Verified

| السؤال | الجواب | الدليل |
|---|---|---|
| فيه خانة صريحة لاسم المورد؟ | آه: «المورد / التاجر (اختياري)» جوه «بضاعة جديدة»، وحقل منفصل عن رقم فاتورة المورد والتاريخ والملاحظة | `StockPanel.vue` (حقل `data-receive-supplier`) |
| بيتحفظ في الداتابيز؟ | آه: `stock_movements.supplier_name` (TEXT NULL، مربوط بقيود: مش سلسلة فاضية، ومش بيتشال منه ولا مسافات، وممنوع على أي حركة مش `receipt`) | migration `0014`، واختبارات `receiving_supplier.rs` |
| بيتعرض في سجل التوريد؟ | آه: عمود «المورد» في «آخر توريدات الصنف ده» جنب التاريخ والكمية وسعر الوحدة والفاتورة | `StockPanel.vue` (`data-receive-history`) |

**التمييز بين التلاتة** (وده اللي كان ممكن يلخبط):

| الدور | فين بيتكتب | مين | الاختبار |
|---|---|---|---|
| **المورد / التاجر** | «بضاعة جديدة» ← «المورد / التاجر» | اللي اشتريت منه الشحنة | `a_receipt_records_the_supplier_the_operator_typed` |
| **الموظف اللي بيسجّل** | مش حقل: بيتاخد من الجلسة | المستخدم اللي عامل الفاتورة | `stock_movements.actor_id` + `audit_events` (`stock_received`) |
| **اللي باع موبايل مستعمل** | «موبايل مستعمل» ← «اللي باعه» (اسم/تليفون/بطاقة) | عميل، مش مورد | `used_phone_registration_opening_stock_and_imei_check_work_end_to_end` |

الخانة اتوضّح تحتها سطر واحد بس: «اللي جبت منه الشحنة — مش الموظف اللي بيسجّل… ومش العميل اللي
باع موبايل مستعمل». المخزون مابيعرفش «مورد» ككيان (`ADR` القرار D1: القايمة مشتقة من السجل)،
فمفيش جدول موردين يتعارض معه.

---

## ٢. تسجيل الـIMEI وتحويل الكمية غير المتتبَّعة — Verified

**القاعدة المحققة:** `المرقّم + غير المرقّم = الرصيد`، وتسجيل رقم **بيعيد تسمية قطعة موجودة**،
مش بيستلم قطعة جديدة.

| قبل | بعد تسجيل رقم واحد |
|---|---|
| الرصيد 5 · مرقّم 0 · غير مرقّم 5 | الرصيد 5 · مرقّم 1 · غير مرقّم 4 |

الكود: `register_stock_unit` بيقرا الرصيد وعدد الوحدات المرقّمة، ولو `registered >= on_hand`
بيرفض بـ`RECEIPT_NO_UNTRACKED_PIECES`؛ ولو فيه قطع غير مرقّمة بيدخل صف في `units` بس —
**ما بيلمسش `stock_levels` ولا بيكتب حركة**، وتكلفة القطعة = متوسط تكلفة الرصيد.

### الفحوص (Rust، SQLite حقيقي، ملف `tests/integration/untracked_imei.rs`)

| الفحص | اللي بيثبته |
|---|---|
| `registering_an_imei_turns_untracked_pieces_into_tracked_without_moving_stock` | 5/0/5 → 5/1/4، والتكلفة 500,000 زي ما هي، ومفيش حركة جديدة في السجل |
| `registering_every_untracked_piece_leaves_no_room_for_another` | قطعتين + رقمين، والتالت مرفوض `RECEIPT_NO_UNTRACKED_PIECES` |
| `a_duplicate_imei_is_refused_and_writes_no_unit` | نفس الرقم مرتين → `IMEI_ALREADY_REGISTERED`، وصف واحد في `units` |
| `an_imei_on_another_product_cannot_be_borrowed` | نفس الرقم على موديل تاني مرفوض |
| `an_imei_cannot_be_registered_for_a_product_that_counted_nothing` | رصيد صفر → مرفوض، ومفيش صف |
| `a_counted_product_refuses_serial_numbers` | منتج بالعدد (كابل) بيرفض الأرقام |
| `two_operators_registering_the_same_imei_at_once_get_one_unit` | تسجيلين في نفس اللحظة: واحد بينجح، والتاني `IMEI_ALREADY_REGISTERED` (قيد `UNIQUE` هو الحكم)، والرصيد ما اتغيّرش |

**تحسين في الكود اتعمل مع المراجعة:** لو التسجيلين اتلاقوا في نفس اللحظة كان الخسران بياخد
`STORAGE_UNAVAILABLE`؛ دلوقتي الخطأ بيترجم لـ`IMEI_ALREADY_REGISTERED` (الترجمة من قيد
`UNIQUE` نفسه، والفحص المسبق بيفضل للمسار العادي).

**شاشة المخزن** بقت بتعرض الرقمين مع بعض: «أجهزة بـ IMEI مسجّل: متسجّل 1 من 5» + «أجهزة من غير
IMEI: 4 قطعة — تسجيل رقم لوحدة منها بينقلها للي فوق، والرصيد الكلي ما بيتغيّرش».

---

## ٣. إلغاء مستند التوريد — **Blocked** (مش منفّذ، والسبب مكتوب)

**التقييم:** الحساب نفسه بيسمح بالإلغاء: عكس السطور بكميتها وتكلفتها بالظبط، في ترانزاكشن
واحدة، بشرط إن مفيش حركة لاحقة على نفس الصنف (عشان ما نعيدش كتابة تكلفة بيعة قديمة)، وبشرط إن
الوحدات المرقّمة اللي جوه المستند لسه `in_stock`. كل ده **ممكن حسابيًا**.

**العائق الحقيقي — عقد السجل نفسه:** جدول `stock_movements` بيقفل أنواع الحركة:

```sql
kind TEXT NOT NULL CHECK (kind IN ('receipt', 'adjustment', 'sale', 'sale_reversal'))
```

مفيش `receipt_reversal`. وإضافة نوع جديد مستحيل بـ`ALTER TABLE` (SQLite مابيعدّلش `CHECK`)،
فالمطلوب **إعادة بناء جدول السجل**، والجدول ده:

- مقصود إنه append-only (عليه `stock_movements_no_update` و`stock_movements_no_delete`)؛
- **مشغّلين ومؤشرات** عليه (10 تريجرز + 3 فهارس) لازم يتعادوا بحرفيتهم؛
- **مراجع داخلية من جداول تانية:** `units.received_movement_id` → `stock_movements`،
  و`stock_movements.reverses_movement_id` → نفسه (`UNIQUE`).

وهنا بيتعارض مع قاعدة الترحيل المكتوبة في المشروع: `0003_identity_lifecycle.sql` رفضت إعادة
بناء جدول ليه مراجع داخلة لأن ده بيحتاج `PRAGMA foreign_keys=OFF`، والـPRAGMA ده **بيتجاهل
بصمت جوه الترانزاكشن**، والبديل (`-- no-transaction`) بيسيب ترحيل نصّه مكتوب لو الجهاز قفل في
نصّه — على دفاتر محل حقيقي.

**القرار:** مفيش تنفيذ جزئي ولا «تسوية عامة» بتتسمى إلغاء توريد. البديل الآمن الموجود دلوقتي
(وموصوف في الشاشة نفسها) هو **تسوية بسباب إجباري** أو **مرتجع**، والاتنين بيتسجلوا كحركتهم
الحقيقية، مش كإلغاء توريد كاذب.

**الخطة الجاهزة لما يوافق المالك على تغيير عقد السجل** (مرتّبة، ومحدّدة):

1. `0036_receipt_reversal.sql` — إعادة بناء `stock_movements` بـ`kind` بيشمل `'receipt_reversal'`،
   مع `PRAGMA defer_foreign_keys=ON` جوه الترانزاكشن (بيشتغل، مش زي `foreign_keys`)، وإعادة
   إنشاء الـ10 تريجرز والفهارس، و`PRAGMA foreign_key_check` في آخر الترحيل.
2. جدول `receipt_reversals(id, document_id UNIQUE, reason NOT NULL, actor_id, approved_by,
   occurred_at)` — **`UNIQUE(document_id)`** هو منع التكرار، والحركات نفسها بتحمل
   `reverses_movement_id` (فيه `UNIQUE` أصلاً).
3. `reverse_receipt_document(document_id, reason)` في `services/inventory/stock.rs`:
   `Sensitivity::Sensitive` (موافقة المالك) + `Permission::ManageInventory`، وكل سطور المستند في
   ترانزاكشن واحدة، ورفض كامل لو: في حركة لاحقة على أي صنف في المستند، أو وحدة من المستند
   مش `in_stock`، أو الرصيد أقل من الكمية المطلوب عكسها.
4. ما بيتلمسش الفلوس: استلام المورد **مالوش أثر نقدي** في السجل، فمفيش حاجة تتعكس ماليًا. (شراء
   المستعمل اللي بيصرف من الدرج مساره مختلف: بيان `owner_draw` بيتسجل وقت الشراء، وإرجاعه
   إجراء منفصل عن إلغاء مستند توريد.)
5. اختبارات: عكس سليم، منع التكرار، رفض بعد بيعة، رفض بعد تسجيل IMEI، ورفض لو الرصيد أقل.

---

## ٤. فحوص «غير المرقّم» من الأول للآخر — Verified (خدمة + SQLite)

| السيناريو | النتيجة المؤكدة |
|---|---|
| استلام 5 موبايلات من غير IMEI | رصيد 5 / تكلفة 500,000 |
| بيع 2 | رصيد 3، والتكلفة 300,000 |
| إلغاء البيعة | رصيد 5 تاني، وإلغاء تاني مرفوض (مفيش عكس مرتين) |
| مرتجع جزئي في بيعة تانية | 5 ← بيع 3 ← 2 ← مرتجع 1 سليم = 3، والتكلفة ترجع بتكلفتها الأصلية |
| مرتجع تالف | ما بيرجعش للرف؛ بيتسجل في `damaged_stock` بـ«تالف» |
| مفيش IMEI بيتألف | البيع من غير رقم بيستهلك من غير المرقّم الأول، والمرقّم بيتسجّل بـ`sold`/`retired` بالسبب |
| مطابقة الرصيد | `SUM(quantity_delta) = stock_levels.quantity` و`SUM(cost_delta_minor) = total_cost_minor` بعد كل خطوة، و`tracked + untracked = on_hand` |

الفحوص: `selling_without_imei_consumes_untracked_pieces_before_any_tracked_one`،
`five_untracked_phones_sold_two_then_cancelled_are_five_again`،
`a_partial_return_of_an_untracked_sale_adds_back_only_what_came_back`،
`an_imei_typed_at_the_counter_labels_an_untracked_piece_on_the_same_receipt`،
`tracked_untracked_and_damaged_reconcile_with_the_ledger_at_every_step`.

---

## ٥. سلوك سعر البيع — Verified

| الحالة | السلوك | الفحص |
|---|---|---|
| سعر مكتوب «للفاتورة دي بس» | السطر بيتسجل بسعره، وسعر الموديل **ما بيتغيّرش** | `a_price_typed_for_one_invoice_applies_to_that_invoice_and_no_other` |
| البيعة اللي بعدها | بترجع لسعر الموديل (القرار ما بقاش افتراضي) | نفس الفحص |
| تعديل سعر الموديل بعدين | الفاتورة القديمة بتفضل بسعرها وتكلفتها وربحها | `changing_the_model_price_never_rewrites_an_invoice_already_recorded` |
| منتج من غير سعر | البيعة مرفوضة لحد ما حد يقرر، والقرار مش بيتحول لافتراضي | `a_product_with_no_price_is_refused_until_somebody_decides` |
| إجمالي مؤكد مختلف | مرفوض، مش بيتم تسعير الفاتورة سرًا | `a_sale_confirmed_at_a_different_total_is_refused_rather_than_repriced` |
| «احفظه سعر الموديل» | بيكتب على المنتج + سجل تغيير سعر (`product_price_history`) | نفس فحص تعديل السعر |

> **محدودية لازم تتقال:** السعر بيحدده اللي معاه `ManageCatalog` (المالك/المدير)، وللبيع
> «للفاتورة دي بس» **مفيش** مسار منفصل بيسمح للبيّاع يكتب سعر من غير الصلاحية دي.

---

## ٦. مطابقة الحسابات — Verified (اللي اتفحص) / Unverified (اللي ما اتفحصش)

| البند | الحالة | الدليل |
|---|---|---|
| تكلفة الاستلام وتقييم المخزون | Verified | `SUM(cost_delta_minor) = total_cost_minor` بعد كل خطوة في `untracked_imei.rs` + اختبارات `stock_costing.rs` |
| المتوسط المرجح للمنتجات بالعدد | Verified | `stock_costing.rs` (اختبارات التكلفة والحركة والرفض عند نقص الرصيد) |
| التكلفة الفردية للأجهزة المرقّمة | Verified | `selling_by_registered_imei_uses_the_units_exact_cost_and_marks_it_sold` + الفحوص الجديدة |
| التكلفة والربح | Verified | `a_price_typed_for_one_invoice…` و`changing_the_model_price…` |
| عكس إلغاء البيعة | Verified | `five_untracked_phones_sold_two_then_cancelled_are_five_again` + اختبارات `sales.rs` |
| المرتجع الجزئي والتالف | Verified | `a_partial_return_of_an_untracked_sale_adds_back_only_what_came_back` |
| عكس مستند التوريد | **Blocked** | البند ٣ فوق |
| المورد وسجل التوريد | Verified | `receiving_supplier.rs` |
| الذرّية ومنع التكرار | Verified | `receive_document` (ترانزاكشن واحدة) + منع التسجيل المكرّر (قيد `UNIQUE`) |
| ويندوز / أندرويد | **Unverified** | ما اشتغلوش على الأجهزة هنا |

---

## ٦.١ سجل البناء والاختبار (اللي بيتقال عليه «Verified»)

| البوابة | السجل | النتيجة |
|---|---|---|
| CI `42071121479` | Frontend (typecheck + build) | ✅ و**269** اختبار وحدة |
| نفس التشغيل | Rust (cargo test، Linux) | ✅ **762** فحص، 0 فاشل — 57 lib / 107 معمارية / **405** تكامل / 193 وحدة (كان 745 قبل المراجعة دي؛ **+17** فحص جديد) |
| `scripts/receiving-followup-check.mjs` | متصفح حقيقي على التطبيق والديمو | ✅ **13/13** (`/tmp/receiving-shots`) |
| `scripts/demo-smoke.mjs` | متصفح حقيقي، كل الشاشات | ✅ **320/320** (`/tmp/demo-followup`) |
| `scripts/new-features-check.mjs` | متصفح حقيقي | ✅ **36/36** (`/tmp/new-shots3`) |
| Windows / Android | — | ⏭️ `skipped` — **Unverified** |

الفحوص الجديدة بالاسم (Rust، `tests/integration/`):

`untracked_imei.rs` — `registering_an_imei_turns_untracked_pieces_into_tracked_without_moving_stock`،
`registering_every_untracked_piece_leaves_no_room_for_another`، `a_duplicate_imei_is_refused_and_writes_no_unit`،
`an_imei_on_another_product_cannot_be_borrowed`، `an_imei_cannot_be_registered_for_a_product_that_counted_nothing`،
`a_counted_product_refuses_serial_numbers`، `two_operators_registering_the_same_imei_at_once_get_one_unit`،
`selling_without_imei_consumes_untracked_pieces_before_any_tracked_one`،
`five_untracked_phones_sold_two_then_cancelled_are_five_again`،
`a_partial_return_of_an_untracked_sale_adds_back_only_what_came_back`،
`an_imei_typed_at_the_counter_labels_an_untracked_piece_on_the_same_receipt`،
`tracked_untracked_and_damaged_reconcile_with_the_ledger_at_every_step`.

`one_time_price.rs` — `a_price_typed_for_one_invoice_applies_to_that_invoice_and_no_other`،
`changing_the_model_price_never_rewrites_an_invoice_already_recorded`،
`a_product_with_no_price_is_refused_until_somebody_decides`،
`a_sale_confirmed_at_a_different_total_is_refused_rather_than_repriced`،
`a_plain_sale_line_input_still_takes_the_model_price`.

الفحوص اللي كانت موجودة واتعتمد عليها: `a_receipt_records_the_supplier_the_operator_typed`،
`a_receipt_without_a_supplier_stores_null_not_an_empty_string`،
`the_supplier_list_is_derived_from_history_rather_than_stored_twice` (من `receiving_supplier.rs`).

---

## ٧. الحدود المعروفة بعد المراجعة دي

1. **إلغاء مستند التوريد:** مش منفّذ (البند ٣) — العائق عقد السجل، مش الحساب.
2. **بيع من غير IMEI وفيه أجهزة مرقّمة أكثر من الرصيد:** النظام «بيتقاعد» الأقدم ويسجّل السبب
   `untracked_sale_overflow`. ده مش تخمين لرقم الجهاز اللي اتباع، لكنه قرار محاسبي: الرقم اللي
   اتقاعد مش موجود في المحل. الحالة متحققة ومغطاة بفحص.
3. **تسجيل IMEI مش بياخد موافقة مالك** (زي الاستلام العادي): هو تصحيح وصف لقطعة موجودة، مش
   حركة مخزون. لو المالك عايزه حساس، ده قرار منفصل.

---

## ٨. الدليل النهائي

| البند | القيمة |
|---|---|
| الفرع | `arena/d6e5ae21-system-sales` |
| الكوميت اللي عليه البوابة الخضراء دي | `92b3e9d` — https://github.com/Petershaker3/system-sales/commit/92b3e9d82136e8b6c271b952ee6dbe3441120161 |
| تشغيل CI | https://github.com/Petershaker3/system-sales/actions/runs/42071121479 — **completed / success** |
| الوظايف | `Frontend (typecheck, build)` ✅ · `Rust (cargo test, Linux)` ✅ · `Android` ⏭️ skipped · `Windows` ⏭️ skipped · `Publish` ⏭️ skipped |
| شجرة العمل | نضيفة (`git status --porcelain` فاضية) — كل التغييرات مدفوعة |
| الفحوص المسمّاة | إعلانات (annotations) على وظيفة Rust: **762** فحص إجمالًا، ومنهم إعلان مخصّص **«27 review-named tests»** فيه أسماء كل فحوص المراجعة دي: 12 × `untracked_imei::` + 5 × `one_time_price::` + 6 × `receiving_supplier::` + 4 × `returns::` — كلهم `ok` |

الكوميتات اللي بعد `04b4f38`:

- `29b4431` — سجل البناء وأسماء الفحوص وتقرير الحالة لكل بند.
- `6956793` — إعلان CI منفصل بأسماء فحوص المراجعة (`27 review-named tests`).
- `92b3e9d` — تصحيح كلمة في التقرير؛ **ده الالتزام اللي عليه البوابة الخضراء فوق**.
- أي التزام توثيقي بعده ما بيغيّرش السلوك: نفس المجموعة بتتفحص بنفس الأمر، والنتيجة المطلوبة هي
  تشغيل CI الأخير على الفرع.

**اللي لسه مش متحقّق (وما بيتقالش عليه Verified):** تشغيل فعلي على ويندوز وأندرويد — الوظيفتين
بتفضل `skipped` في كل تشغيل. الحسابات والمخزون متحققين على SQLite حقيقي في CI، وعلى المتصفح
بموديل الديمو، ومش على جهاز المالك.
