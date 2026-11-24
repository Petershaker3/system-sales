# الأرشيف — فهرس

كل ما هنا **للعلم والتدقيق فقط**:
- **للقراءة فقط:** لا يُعدَّل (`docs/PROJECT_INSTRUCTIONS.md` §7).
- **ليس مرجعًا** لأي قرار حالي. الخطة الحاكمة هي [`docs/PLAN.md`](../docs/PLAN.md).

**قاعدة الأرشفة:**
- **النقل:** `git mv` إلى هنا، و**لا حذف أبدًا**. تاريخ كل ملف محفوظ في git، ويظهر بـ`git log --follow <path>`.
- **التوثيق:** يُكتب سبب كل نقل في هذا الفهرس.

---

## أرشفة 2026-10-17 — الـPattern يحل محله PIN المالك

**القرار:** [`ADR-017`](../docs/decisions/ADR-017-pin-approval-recovery-code.md) §3، تنفيذًا لقول المالك في `docs/PLAN.md` §4: العمليات الحساسة بـPIN المالك. والتنفيذ هو البند 1.1، الخطوة 3.

**ما بقي في مكانه:** جدول `manager_pattern`، وأعمدة `sessions.pattern_*`، ومفتاح الإعداد `pattern_required`. الترحيلات المطبَّقة لا تُعدَّل، وقاعدة قديمة فيها المفتاح لازم تفضل تتفتح. والكود لا يقرأ أيًّا منها، وفحص المعمارية `the_retired_pattern_is_read_by_nothing` يضمن ذلك.

### `superseded-2026-10-17/pattern/` — الـPattern

| كان في | لماذا | ما يحل محله |
|---|---|---|
| `src-tauri/src/services/pattern/mod.rs` | خدمة الـPattern: التعيين، والتحقق، وإعادة التعيين، والتعطيل | `services/identity/approval.rs`: موافقة المالك بالـPIN |
| `src-tauri/src/commands/pattern.rs` | أوامره الخمسة | الأمر `approve_with_owner_pin` في `commands/identity.rs` |
| `src-tauri/src/data/repositories/identity/pattern.rs` | قراءة وكتابة `manager_pattern` | `session.rs`: `set_owner_approval` و`consume_owner_approval` و`clear_approvals_granted_by` |
| `src-tauri/tests/integration/pattern.rs` | فحوصه السبعة | `tests/integration/approval.rs` |
| `src/components/PatternPrompt.vue` | نافذة إدخال الـPattern | `src/shell/ApprovalPrompt.vue` |
| `src/api/pattern.ts` | واجهة أوامره | `approveWithOwnerPin` في `src/api/identity.ts` |

### `superseded-2026-10-17/sales-panel/` — لوحة البيع القديمة

| كان في | لماذا | ما يحل محله |
|---|---|---|
| `src/components/SalesPanel.vue` | <ul><li>لم تعد معروضة منذ شاشة «البيع» (البند 1.6).</li><li>كانت الوحيدة التي تستعمل `PatternPrompt`.</li><li>مرجع لمن يبني شاشة المبيعات.</li></ul> | «البيع» للبيع، وشاشة المبيعات في البند 1.14 للإلغاء من القائمة |

### `superseded-2026-10-17/recovery-feature/` — نسخة الاسترجاع الخاصة (`--features recovery`)

**القرار:** [`ADR-017`](../docs/decisions/ADR-017-pin-approval-recovery-code.md) §4، تنفيذًا لاختيار المالك «كود استرجاع» (`ADR-016` 32). والتنفيذ هو البند 1.1، الخطوة 4.

**ما بقي في مكانه:** جدولا `recovery_approval` (`0009`) و`recovery_attempt` (`0010`)، لأن الترحيلات المطبَّقة لا تُعدَّل. والكود لا يقرأ أيًّا منهما.

| كان في | لماذا | ما يحل محله |
|---|---|---|
| `src-tauri/src/services/identity/recovery.rs` | استرجاع كلمة سر المالك بموافقة تتجهّز للجهاز وبالـPattern، في نسخة خاصة فقط | `services/identity/recovery_code.rs`: كود الاسترجاع |
| `src-tauri/src/commands/recovery.rs` | أمراه `stage_recovery_approval` و`execute_manager_recovery` | `recover_password_with_code` و`create_recovery_code` و`recovery_code_status` |
| `src-tauri/src/data/repositories/identity/recovery.rs` | قراءة وكتابة جدولي `0009` و`0010` | `credentials.rs`: `recovery_verifier` و`set_recovery_verifier` |
| `src-tauri/tests/integration/recovery.rs`<br>`src-tauri/tests/integration/recovery_reset.rs` | فحوصها | `tests/integration/recovery_code.rs` |
| `src/components/RecoveryPanel.vue`<br>`src/api/recovery.ts` | لوحتها، خلف علامة البناء `VITE_RECOVERY` | «نسيت كلمة السر؟» على كارت المالك (`src/shell/RecoverPassword.vue`)، وكارت «كود الاسترجاع» في الإعدادات |

### `superseded-2026-10-17/handoffs/` — الـhandoff القديم

| كان في | لماذا | ما يحل محله |
|---|---|---|
| `HANDOFF_2026-10-16.md` | handoff المرحلة 0 وبداية المرحلة 1. المالك طلب handoff جديد لشات جديد (2026-10-17). §4 فيه اقتراحات الجداول اللي اتوافق عليها عند البوابة (`ADR-016` 31). | [`HANDOFF_2026-10-17.md`](../HANDOFF_2026-10-17.md)، و§6 فيه الاقتراحات اللي لسه ما اتبنتش، منقولة من §4 |

### `superseded-2026-10-17/departments-panel/` — لوحة الأقسام وأوامرها

**القرار:** [`ADR-018`](../docs/decisions/ADR-018-category-tree-brands-variants-images.md) §1: القسم بقى تصنيف في شجرة بمستويين (`ADR-016` 5 و29 و31). والتنفيذ هو البند 1.2، الخطوة 1.

**ما بقي في مكانه:** جدول `departments` نفسه (اتضاف له الأب والنوع والأيقونة والإخفاء في `0016`)، وأعمدة طريقة التكلفة والضريبة من غير أثر (1.3)، وخدمات الأقسام القديمة في `services/organisation/departments.rs` لأن اختباراتها لسه بتستعملها. أوامرها اتشالت من `lib.rs`، وفحص المعمارية `the_retired_department_commands_stay_retired` بيمنع رجوعها.

| كان في | لماذا | ما يحل محله |
|---|---|---|
| `src-tauri/src/commands/departments.rs` | ستة أوامر: إضافة وتعديل (بطريقة التكلفة والضريبة) وأرشفة وترتيب كامل وقراءة | `src-tauri/src/commands/categories.rs`: `list_categories` و`create_category` و`rename_category` و`set_category_hidden` و`move_category` و`delete_category` |
| `src/components/DepartmentsPanel.vue` | لوحة الأقسام في «المخزن» | كارت «التصنيفات في شاشة البيع» في الإعدادات (`src/screens/settings/CategoriesCard.vue`)، زي المعاينة |
| `src/api/departments.ts` | واجهة أوامرها | `src/api/categories.ts`، والنوع `CostMethod` اتنقل لـ`src/api/settings.ts` |

---

## أرشفة 2026-10-16 — بعد اعتماد الخطة الحالية

**قول المالك:** «ملناش دعوة بالقديم، خلينا في اللي بنتفق عليه أنا وانت. عدّل كل الملفات بما يتوافق مع الخطة الحالية، وأرشف اللي ملهوش لازمة.»

**القرارات:** [`ADR-016`](../docs/decisions/ADR-016-owner-plan-2026-10-16.md).

### `legacy-project/` — البرنامج القديم

| كان في | أصبح في | لماذا |
|---|---|---|
| `dev_extracted/` | `legacy-project/dev_extracted/` | كود البرنامج القديم: ملف HTML واحد، و`localStorage`. مادة أرشيفية لا يُبنى عليها (`ADR-007`). نُقل من جذر المستودع لتنظيفه |
| `dev_phase24_rc_closed_2026-08-18_manifest.txt` | `legacy-project/` | فهرس أرشيف إصدار قديم |
| `product/` | `legacy-project/product/` | <ul><li>شجرة Rust مشتقة من القديم: مخطط، ومستورد، وترحيل.</li><li>لم تكن جزءًا من النظام الجديد قط.</li><li>`ADR-006` نُفِّذ.</li><li>توصية تقرير المقارنة §9 المعتمدة.</li></ul> |
| `spikes/legacy-import/` | `legacy-project/spikes/legacy-import/` | تجربة استيراد من القديم. الاستيراد خارج النطاق (`ADR-007`)، وتوصية §9 |

### `superseded-2026-10-16/` — وثائق حلّت محلها الخطة الحالية

| كان في | أصبح في | لماذا | ما يحل محله |
|---|---|---|---|
| `HANDOFF_2026-10-15.md` | `handoffs/` | هاند أوف قديم، وفيه قرارات D1–D9، ومنها D3 «كاش فقط» وD4 «بلا مدد ضمان» اللتان أُلغيتا | `HANDOFF_2026-10-16.md` و`ADR-016` |
| `HANDOFF_ADR003_BACKUP_20261014.md` | `handoffs/` | هاند أوف شريحة النسخ الاحتياطي، وهي منتهية ومنفَّذة | `README.md` (النطاق الحالي) و`ADR-003` |
| `HANDOFF_PH7_SALESV1_20261013.md` | `handoffs/` | هاند أوف شريحة البيع v1، وهي منتهية | `README.md` و`docs/PLAN.md` §19 |
| `tasks/delivery-plan.md` | `tasks/` | خطة التسليم القديمة: الأطوار P0–P9، ونطاق `ADR-008` | `docs/PLAN.md` §19 (المراحل 0–4) |
| `tasks/todo.md` (نسخة 2026-10-15) | `tasks/todo-2026-10-15.md` | قائمة مهام الاتجاه القديم: فحوص Pattern على الجهاز، وترحيلات Android، وبوابات الاستيراد | `tasks/todo.md` الجديدة |
| `tasks/plan-backup-adr003.md`<br>`tasks/plan-p4b.md`<br>`tasks/plan-r1t5.md`<br>`tasks/plan-recovery.md`<br>`tasks/plan-sp2.md` | `tasks/` | خطط شرائح منتهية: النسخ، والمخزون P4b، والاسترجاع، وSP-2 | الكود نفسه، و`README.md` |
| `tasks/review-r1.md`<br>`tasks/review-r1t5-package.md` | `tasks/` | سجلات مراجعة منتهية | — |
| `docs/superpowers/plans/2026-10-*.md` (7 ملفات) | `superpowers/plans/` | خطط شرائح منتهية: الهوية، والكتالوج، ودورة حياة الهوية، وأساس SP-1، والصلاحيات والإعدادات، ومواصفة الاسترجاع، وخطة «المرجع التاريخي» | `docs/PLAN.md` |
| `docs/superpowers/specs/2026-10-02-historical-reference-snapshot-design.md` | `superpowers/specs/` | تصميم «مرجع تاريخي» للبيانات القديمة. خارج الخطة، فالقديم لا يدخل النظام | — |
| `screen-*.png` و`ui-*.xml` (6 ملفات في الجذر) | `device-debug/` | لقطات وتفريغات واجهة من فحص جهاز Android (P1). `screen-main.png` تالف | — |

### ما لم يُنقل، ولماذا

| الملف | لماذا بقي في مكانه |
|---|---|
| `docs/superpowers/specs/2026-09-28-mobile-shop-system.md` | <ul><li>الكود يشير إلى أسطره بأرقامها (`spec:NNN`، أكثر من 170 مرة).</li><li>عُدِّل عنوانه وسطر حالته في مكانهما.</li><li>في آخره ملحق يربط كل قسم ملغى بالخطة الحالية.</li></ul> |
| `docs/superpowers/plans/2026-09-28-mobile-shop-system.md` | الكود يشير إلى أسطره (`plan:141`–`plan:171`)، وفي آخره ملحق |
| `docs/decisions/ADR-*.md` (كلها) | <ul><li>سجل القرارات يبقى في مكانه.</li><li>الملغى منها عليه حالة «مُلغى» وملحق.</li><li>المرجع الحالي `ADR-016`.</li></ul> |

---

## قبل 2026-10-16

- `legacy-project/handoff/`، و`reports/`، و`source-docs/`: وثائق البرنامج القديم، وقد أُرشفت مبكرًا. تفاصيلها في [`legacy-project/README.md`](legacy-project/README.md).
