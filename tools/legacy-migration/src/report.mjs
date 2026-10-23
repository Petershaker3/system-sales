// The report the owner keeps next to the backup.
//
// A migration an owner cannot check is a migration he has to trust. This file
// states, in his own words and his own numbers, what went in, what stayed out and
// why, and how to restore the file on the new system.

import { monthLabel } from './util.mjs';

const money = (value) => `${(Number(value) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} ج.م`;
const count = (value) => (Number(value) || 0).toLocaleString('en-US');

function monthTable(plan) {
  const lines = [
    '| الشهر | مبيعات | تكلفة | ربح | مصاريف | صيانة وسوفت | كاش (عمولات) |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const month of plan.months) {
    const totals = month.totals || {};
    const mode = !month.include ? 'مش متنقل' : month.mode === 'detail' ? 'تفصيلي' : month.mode === 'summary' ? 'مجمّع' : 'مش متنقل';
    lines.push(
      `| ${month.label} (${mode}) | ${money(totals.sales)} | ${money(totals.cost)} | ${money(totals.profit)} | ${money(totals.expenses)} | ${money(totals.repairs)} | ${money(totals.fees)} |`,
    );
  }
  return lines.join('\n');
}

function findingsSection(findings) {
  if (!findings.length) return '_مفيش أي ملاحظات — كل الصفوف عدّت الفحص._';
  const rows = findings.slice(0, 80).map((finding) => {
    const level = finding.level === 'error' ? 'خطأ' : 'تنبيه';
    const ref = finding.ref ? ` \`${finding.ref}\`` : '';
    return `- **${level}**: ${finding.message}${ref}`;
  });
  if (findings.length > 80) rows.push(`- …و${findings.length - 80} ملاحظة تانية.`);
  return rows.join('\n');
}

export function buildReport({ plan, legacy, result, manifest, backupName, passwordLength }) {
  const totals = result.totals;
  const stats = result.stats;
  const source = plan.source || {};
  const excluded = (source.excludedKeys || [])
    .map((entry) => `- ${entry.label} (\`${entry.key}\`) — مش بيتنقل بأمر المالك.`)
    .join('\n');
  const unknown = (source.unknownKeys || []).map((key) => `- \`${key}\` — مفتاح مش معروف للأداة، اتساب زي ما هو.`).join('\n');
  const wallets = plan.wallets
    .filter((wallet) => wallet.include)
    .map((wallet) => `- ${wallet.name}${wallet.number ? ` (${wallet.number})` : ''}: **${money(wallet.currentBalance)}**${wallet.balanceIsGuess ? ' — رقم مبدئي، راجعه من شاشة المحافظ بعد الاستيراد' : ''}`)
    .join('\n');

  const monthsSummary = plan.months.filter((month) => month.include).map((month) => {
    const label = monthLabel(month.month);
    if (month.mode === 'detail') return `- **${label}** — كل المبيعات تفصيليًا (${count(plan.sales.filter((sale) => (sale.date || '').startsWith(month.month) && sale.include).length)} بيعة).`;
    if (month.mode === 'summary') return `- **${label}** — مجمّع: ${count(plan.summary.filter((row) => row.month === month.month && row.include).length)} سطر ملخّص بدل مبيعات اليوم.`;
    return `- **${label}** — متنقلش.`;
  }).join('\n');

  return `<div dir="rtl">

# تقرير ترحيل البيانات — ${plan.settings.shopName}

**اتولد:** ${new Date(plan.createdAt).toLocaleString('ar-EG')}
**ملف النسخة:** \`${backupName}\`
**حجم النسخة:** ${(result.bytes.length / 1024 / 1024).toFixed(2)} ميجا
**قاعدة البيانات جوه النسخة:** ${(manifest.database.len / 1024 / 1024).toFixed(2)} ميجا
**كلمة سر النسخة:** ${passwordLength} حرف — مش مكتوبة هنا، ومش ممكن استرجاعها.

## 1. المصدر

| | |
|---|---|
| المحل | ${source.shopName || '—'} |
| أول يوم | ${source.firstDay || '—'} |
| آخر يوم | ${source.lastDay || '—'} |
| عدد الأيام | ${count(source.days)} |
| إجمالي الحركات في الملف | ${count(source.records)} |

## 2. اللي اتنقل

| العنصر | العدد |
|---|---:|
| التصنيفات | ${count(stats.categories)} |
| الماركات | ${count(stats.brands)} |
| الأصناف (إكسسوار + مستعمل + موبايل) | ${count(stats.products)} |
| فواتير مبيعات تفصيلية | ${count(stats.sales)} |
| شهور مجمّعة (كل شهر فاتورة واحدة) | ${count(stats.summaryMonths)} |
| تذاكر صيانة وسوفت وير | ${count(stats.repairs)} |
| مصاريف | ${count(stats.expenses)} |
| محافظ | ${count(stats.wallets)} |
| شعار المحل | ${stats.logoIncluded ? 'اتنقل' : 'مش موجود'} |

**فلوس الشهر التفصيلي:** مبيعات ${money(totals.saleTotal)} — تكلفة ${money(totals.saleCost)} — ربح ${money(totals.saleProfit)}
**فلوس الشهور المجمّعة:** مبيعات ${money(totals.summaryTotal)} — تكلفة ${money(totals.summaryCost)} — ربح ${money(totals.summaryProfit)}
**المصاريف المتنقلة:** ${money(totals.expenseTotal)}، **الصيانة:** ${money(totals.repairTotal)} (تكلفة قطع ${money(totals.repairCost)}).

## 3. الشهور

${monthTable(plan)}

${monthsSummary}

> الأرقام في العمود الأخير هي **عمولات** الكاش اللي اتسجلت في القديم. القديم كان بيسجّل العمولة بس في أغلب الحركات، مش المبلغ اللي اتحرك، عشان كده محفظة السيستم الجديد بتفتح بالرصيد اللي انت كتبته، مش بمجموع الحركات القديمة.

## 4. أرصدة المحافظ اللي هتفتح بيها

${wallets || '_مفيش محافظ مختارة._'}

## 5. اللي **مش** اتنقل وليه

- **مبيعات الشهور اللي فاتت كل سطر لوحده** — اتنقلت أرقامها الشهرية بس (زي ما طلبت). لو حبيت تفصيلها كلها، غيّر الشهر لـ «تفصيلي» في الأداة واعمل النسخة تاني.
- **الفواتير الملغية** (${count(legacy.stats.rolled)} حركة عليها علامة \`_rolled\`) — ملغية أصلًا في القديم.
- **حركات المحافظ التفصيلية** — القديم كان بيسجّل العمولة مش المبلغ، فتحويلها لحركات كان هيخترع أرصدة. أرقامها موجودة فوق وفي جدول الشهور.
- **كلمات السر وGoogle Client ID** من \`mshop_cfg\` — أسرار، مش بيانات محل، ومش بتتنقل.

${excluded ? `### مفاتيح موجودة في الملف ومتنقلتش\n${excluded}` : ''}
${unknown ? `### مفاتيح الأداة مش عارفاها\n${unknown}` : ''}

## 6. ملاحظات الفحص

${findingsSection(result.findings)}

## 7. ترجّعها إزاي على السيستم الجديد

1. افتح برنامج السيستم الجديد على الكمبيوتر.
2. من **الإعدادات ‹ النسخة الاحتياطية**، اختار **استيراد نسخة**.
3. حدد الملف \`${backupName}\` واكتب كلمة السر اللي اخترتها.
4. البرنامج بيطلب منك **تقفل وتفتح** بعد الاستيراد — اعمل كده.
5. بعد ما يفتح: راجع **المخزن** (الأصناف والكميات)، و**المحافظ** (الأرصدة)، و**المبيعات** (أرقام الشهور).

> **قبل ما تستورد:** خد نسخة من بيانات الجهاز الحالية لو عليه أي شغل، لأن الاستيراد بيستبدل قاعدة البيانات كلها.

## 8. حاجات محتاجة عينك بعد الاستيراد

- **كميات الإكسسوارات**: القديم مكانش بيسجّل كمية، فكل إكسسوار فتح بـ **0**. عدّل الكميات من شاشة المخزن، أو اكتبها في الأداة قبل ما تعمل النسخة.
- **أسعار بيع الموبايلات**: القديم مكانش بيخزّن سعر بيع للموبايل في المخزن. الأداة اقترحت آخر سعر بيع اتسجل لنفس الموديل، وده **اقتراح مش حقيقة**.
- **أرصدة المحافظ**: راجعها، لأن القديم مكانش فيه رصيد جاري حقيقي.

</div>
`;
}
