# ADR-007: النظام الجديد مستقل تمامًا

**الحالة:** مقبول (accepted) — قرار نهائي من Product Owner بتاريخ 2026-10-02.

## القرار

النظام الجديد **مستقل تمامًا** ويُصمَّم من أول المبادئ.

> Build the new system correctly and durably from scratch.
> Do not let the old system constrain the new architecture.

## ما الذي لا يُشتق من النظام القديم

النظام القديم **ليس** مصدرًا لأي من الآتي:

- منطق العمل أو قواعد المجال
- مخطط البيانات أو أسماء الجداول أو الأعمدة
- دلالات المحاسبة أو تعريفات المؤشرات
- نماذج المخزون أو التكلفة
- دلالات الكاش أو الوردية
- صيغ التقارير أو معادلاتها
- متطلبات التوافق أو المطابقة

## ما الذي يحدث للمادة القديمة

المادة القديمة **تبقى** في `archive/` للأرشفة والتدقيق (منذ 2026-10-16 كلها تحته، ومنها كود البرنامج القديم في `archive/legacy-project/dev_extracted/`):

- لا تُحذف ولا تُعدَّل.
- لا تُستشهد بها كشرط قبول لأي شريحة في النظام الجديد.
- لا ترحيل ولا importer ولا محول يقرأها في مسار التطبيق.

`spikes/legacy-import/` و`product/` نُقلا في 2026-10-16 إلى `archive/legacy-project/` كأثر تاريخي (`ADR-006` نُفِّذ)، **خارج** المعمارية ومن خارج الاعتماديات.

## الدليل المعماري

```text
NEW SYSTEM
    ↓
Own domain model          (defined per module, first principles)
Own business rules
Own database              (own SQLite schema, own migrations)
Own reports               (own KPI definitions, own formulas)
Own accounting semantics  (own profit/cash definitions)
Own inventory model       (own costing, own movements)
Own sales model
Own backup model
Own platform adapters

LEGACY SYSTEM
    ↓
NOT a dependency
NOT a source of truth
NOT a compatibility target
NOT a migration requirement
NOT a reporting requirement
NOT an architectural constraint
```

## القاعدة الحاكمة

> Legacy data and legacy architecture must not constrain the new system.
> The new system is designed independently from first principles.

النظام الجديد يستطيع التطور سنوات **دون** اشتراط بقاء النظام القديم متاحًا أو صحيحًا أو موجودًا.

## قاعدة التبرير

إذا لم يكن هناك تبرير ممكن خارج النظام القديم، فالتبرير غير كافٍ. عبارة «النظام القديم كان يفعل كذا» **ليست تبريرًا**؛ هي إشارة **للتوقف والسؤال**.

## الأثر على الوثائق

| الوثيقة | الأثر |
|---|---|
| `specs/2026-09-28-mobile-shop-system.md` | أُعيد أساسها: حُذفت الفقرات التي تعتمد على النظام القديم، وأُعيدت صياغة أخرى حول أول المبادئ |
| `plans/2026-09-28-mobile-shop-system.md` | أُعيد أساسها: أُسقطت مهام الاستيراد، وأُعيدت صياغة الباقي |
| `decisions/ADR-002` | حُذفت الشروط المرتبطة بمعاملة البيانات القديمة |
| `decisions/ADR-003` | أُعيدت صياغة شرط تصميم الصيغة |
| `specs|plans/2026-10-02-historical-reference-snapshot-*` | **SUPERSEDED** — خارج النطاق |
| `decisions/ADR-006` | **SUPERSEDED** |

## أسئلة مفتوحة

**تعريفات مؤشرات التقارير المالية** — قرار منتج مستقل. ما معنى `Total Sales` وما معنى `Net Profit`، وأي الحركات تدخل في كل منهما؟ لا يُشتق من أي تقرير سابق، ولا يُملأ بمحاكاة.

