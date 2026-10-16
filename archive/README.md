# الأرشيف — فهرس

كل ما هنا **للعلم والتدقيق فقط**:
- **للقراءة فقط:** لا يُعدَّل (`docs/PROJECT_INSTRUCTIONS.md` §7).
- **ليس مرجعًا** لأي قرار حالي. الخطة الحاكمة هي [`docs/PLAN.md`](../docs/PLAN.md).

**قاعدة الأرشفة:**
- **النقل:** `git mv` إلى هنا، و**لا حذف أبدًا**. تاريخ كل ملف محفوظ في git، ويظهر بـ`git log --follow <path>`.
- **التوثيق:** يُكتب سبب كل نقل في هذا الفهرس.

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
