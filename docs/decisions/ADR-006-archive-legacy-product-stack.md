# ADR-006: أرشفة شجرة `product/` (legacy product stack)

## الحالة

**مقبول (accepted)** — ولم يُنفَّذ.

## السياق

بين phases سابقة بُنيت شجرة `product/` (~4,700 سطر Rust غير متتبَّع في git):

| المكوّن | الدور |
|---|---|
| `product/schema/` | مخطط SQLite تشغيلي (3 migrations) |
| `product/importer/` | `mshop-import` — استيراد المعاملات التشغيلية |
| `product/migration/reader.rs` | قراءة JSON النظام القديم (`mshop_*`) |
| `product/migration/mapping.rs` | **1,602 سطر** تحويل legacy entities |
| `product/migration/validation.rs` | مطابقة ومصالحة منطق التقرير القديم |

الشجرة **شغالة** — 61 اختبار بتعدّي.

لكن هدفها هو بالضبط ما يرفضه قرار الـProduct Owner بتاريخ 2026-10-02:

| ما في `product/` | قرار المالك |
|---|---|
| مخطط SQLite تشغيلي | Historical Reference **ليس** Operational Data |
| `mshop-import` ينقل بيانات تشغيلية | **لا تنقل** أي بيانات تشغيلية من النظام القديم |
| `mapping.rs` + `validation.rs` | **لا تعيد إنتاج** أو توريث أي Legacy business logic |

## القرار

أرشفة `product/` إلى `archive/legacy-project/` — المسار المعتمد في `docs/superpowers/specs/2026-09-28-mobile-shop-system.md:66`، والمستخدم فعليًا لوثائق النظام السابق.

أرشفة لا حذف: الكود غير المتتبَّع لا يمكن استرجاعه بعد `git rm`.

## لماذا لم يُنفَّذ بعد

- قرار الأرشفة **مقبول**، لكن التنفيذ خطوة منفصلة تحتاج موافقة صريحة.
- التنفيذ يمسّ شجرة خارج نطاق المشروع الحالي؛ لا يجوز خلطه مع وثائق Historical Reference في نفس العملية.
- شجرة `product/` سليمة في مكانها — لا خطر فوري.

## البدائل المُستبعَدة

| البديل | سبب الاستبعاد |
|---|---|
| الحذف النهائي | يفقد الكود نهائيًا؛ غير قابل للاسترجاع. |
| الإبقاء في مكانه | كود تشغيل legacy يظل متاحًا ومتاحًا للاستخدام، ويخالف الاتجاه المعتمد. |

## الأثر

- **لا أثر على النظام الجديد.** الشجرة مستقلة تمامًا عن Historical Reference (`docs/superpowers/specs/2026-10-02-historical-reference-snapshot-design.md`).
- بعد الأرشفة، `docs/superpowers/specs/2026-09-28-mobile-shop-system.md:30` يتحقق فعليًا: «فصل تعريفات التقارير القديمة عن الجديدة».

## التنفيذ — غير منفَّذ

```text
# لم يُنفَّذ. يتطلب موافقة منفصلة.
product/  →  archive/legacy-project/product/
```

ممنوع التنفيذ ضمن أي مهمة Historical Reference.