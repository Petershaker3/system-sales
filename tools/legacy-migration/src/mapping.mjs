// الجسر بين القديم والجديد: كل حاجة في ملف المحل القديم، رايحة فين في السيستم
// الجديد، وهتبقى بأي شكل، وتحت أنهي قسم.
//
// كل الدوال هنا نقية: بتاخد الخطة (أو صف منها) وبترجّع كلام للعرض. مفيش DOM ولا
// كتابة — عشان الاختبارات تقدر تتأكد إن اللي الشاشة بتقوله هو نفسه اللي الباني بيعمله.

import { normalizeText } from './util.mjs';

const EGP = (value) => `${(Number(value) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} ج.م`;

const value = (input, kind = 'text') => {
  if (input === null || input === undefined || input === '') return null;
  if (kind === 'money') return EGP(input);
  if (kind === 'bool') return input ? 'أيوه' : 'لأ';
  return String(input);
};

// ── أسماء الحقول في الملف القديم ──────────────────────────────────────────
// نفس ترتيب ما البرنامج القديم بيكتبه، بالعربي، عشان المالك يتعرف على صفه.
const LEGACY_FIELDS = {
  acc: [
    ['name', 'الصنف', 'text'],
    ['mainCat', 'التصنيف', 'text'],
    ['buy', 'سعر الشراء', 'money'],
    ['sell', 'سعر البيع', 'money'],
    ['profit', 'الربح', 'money'],
    ['time', 'الوقت', 'text'],
  ],
  used: [
    ['name', 'الجهاز', 'text'],
    ['buy', 'سعر الشراء', 'money'],
    ['sell', 'سعر البيع', 'money'],
    ['profit', 'الربح', 'money'],
    ['note', 'ملاحظة', 'text'],
    ['time', 'الوقت', 'text'],
  ],
  phones: [
    ['modelName', 'اسم الموديل', 'text'],
    ['brand', 'الشركة', 'text'],
    ['model', 'الموديل', 'text'],
    ['qty', 'الكمية', 'text'],
    ['buyPrice', 'سعر الشراء', 'money'],
    ['sellPrice', 'سعر البيع', 'money'],
    ['profit', 'الربح', 'money'],
    ['time', 'الوقت', 'text'],
  ],
  sw: [
    ['name', 'الجهاز', 'text'],
    ['price', 'المبلغ', 'money'],
    ['paid', 'مدفوع', 'bool'],
    ['delivered', 'اتسلّم', 'bool'],
    ['note', 'ملاحظة', 'text'],
    ['time', 'الوقت', 'text'],
  ],
  cash: [
    ['cashType', 'النوع', 'text'],
    ['service', 'الخدمة', 'text'],
    ['walletId', 'المحفظة', 'text'],
    ['amount', 'العمولة', 'money'],
    ['transferAmount', 'المبلغ اللي اتحرك', 'money'],
    ['time', 'الوقت', 'text'],
  ],
  exp: [
    ['category', 'التصنيف', 'text'],
    ['amount', 'المبلغ', 'money'],
    ['time', 'الوقت', 'text'],
  ],
  repairs: [
    ['no', 'رقم التذكرة', 'text'],
    ['clientName', 'اسم العميل', 'text'],
    ['clientPhone', 'تليفون العميل', 'text'],
    ['brand', 'الشركة', 'text'],
    ['model', 'الموديل', 'text'],
    ['deviceType', 'نوع الجهاز', 'text'],
    ['faultType', 'العيب', 'text'],
    ['partName', 'قطعة الغيار', 'text'],
    ['partBuyPrice', 'سعر القطعة', 'money'],
    ['servicePrice', 'المبلغ', 'money'],
    ['supplier', 'المورد', 'text'],
    ['status', 'الحالة', 'text'],
    ['fixed', 'اتصلّح', 'bool'],
    ['delivered', 'اتسلّم', 'bool'],
    ['paid', 'مدفوع', 'bool'],
    ['notes', 'ملاحظات', 'text'],
    ['time', 'الوقت', 'text'],
  ],
  inventory: [
    ['brand', 'الشركة', 'text'],
    ['model', 'الموديل', 'text'],
    ['ram', 'الرام', 'text'],
    ['storage', 'المساحة', 'text'],
    ['qty', 'الكمية', 'text'],
    ['buyPrice', 'سعر الشراء', 'money'],
    ['supplier', 'المورد', 'text'],
    ['addedDate', 'تاريخ الإضافة', 'text'],
  ],
  catalog: [
    ['name', 'الاسم', 'text'],
    ['buy', 'سعر الشراء', 'money'],
    ['sell', 'سعر البيع', 'money'],
  ],
};

/** حقول الصف كما هي في الملف القديم، ومن غير اختراع. */
export function legacyFields(section, raw) {
  const shape = LEGACY_FIELDS[section] || [];
  if (!raw || typeof raw !== 'object') return [];
  return shape
    .map(([key, label, kind]) => ({ key, label, value: value(raw[key], kind) }))
    .filter((field) => field.value !== null);
}

// ── خريطة الملف القديم كله ────────────────────────────────────────────────
// كل مفتاح في الباكب القديم، ووظيفته، ومصيره. `count` بياخد (legacy, plan).
export const LEGACY_MAP = [
  {
    key: 'mshop_cfg',
    title: 'إعدادات المحل',
    legacy: 'اسم المحل، الشعار، كلمات السر',
    plan: 'اسم المحل والشعار يتنقلوا. كلمات السر لأ.',
    dest: 'إعدادات ← اسم المحل، والشعار في «صور» التطبيق',
    inNew: 'app_settings + images/shop-logo.jpg',
    tab: 'settings',
    count: () => 1,
  },
  {
    key: 'mshop_cats',
    title: 'التصنيفات',
    legacy: 'لستة أقسام: جراب، سكرين، سماعات…',
    plan: 'كل قسم بيبقى تصنيف في شجرة التصنيفات.',
    dest: 'المخزن ← التصنيفات (أو قسم في الأصناف)',
    inNew: 'departments',
    tab: 'categories',
    count: (_legacy, plan) => plan.categories.filter((row) => row.include).length,
  },
  {
    key: 'mshop_ca',
    title: 'كتالوج الإكسسوارات',
    legacy: 'اسم + سعر شراء + سعر بيع',
    plan: 'كل سطر صنف في المخزن، بكمية بتكتبها إنت.',
    dest: 'المخزن ← الأصناف ← تحت قسمه',
    inNew: 'products + stock_levels',
    tab: 'items',
    count: (_legacy, plan) => plan.items.filter((row) => row.priceSource === 'mshop_ca' && row.include).length,
  },
  {
    key: 'mshop_cu',
    title: 'كتالوج المستعمل',
    legacy: 'اسم + شراء + بيع',
    plan: 'أصناف تحت قسم «مستعمل».',
    dest: 'المخزن ← الأصناف ← مستعمل',
    inNew: 'products',
    tab: 'items',
    count: (_legacy, plan) => plan.items.filter((row) => row.kind === 'used' && row.include).length,
  },
  {
    key: 'mshop_inventory',
    title: 'المخزن (الموبايلات)',
    legacy: 'ماركة، موديل، رام، مساحة، كمية، سعر شراء',
    plan: 'كل موبايل صنف بشركته وموديله وكميته.',
    dest: 'المخزن ← الأصناف ← موبايلات جديدة',
    inNew: 'products + stock_levels + brands',
    tab: 'items',
    count: (_legacy, plan) => plan.items.filter((row) => row.kind === 'phone' && row.include).length,
  },
  {
    key: 'mshop_brands*',
    title: 'ماركات الموبايلات',
    legacy: 'أسماء شركات (وتلاتة منها بعلامة زراير)',
    plan: 'بتتوحّد وأي ماركة ظهرت في بيعة، والاسم المكرر بيتشال.',
    dest: 'المخزن ← الماركات',
    inNew: 'brands',
    tab: 'brands',
    count: (_legacy, plan) => plan.brands.filter((row) => row.include).length,
  },
  {
    key: 'mshop_wallets_list + cfg',
    title: 'المحافظ وأرقامها',
    legacy: 'أرقام فودافون/اتصالات/إنستا باي + رصيد بداية',
    plan: 'نفس المحافظ، والرصيد اللي هتفتح بيه (راجعه).',
    dest: 'المحافظ',
    inNew: 'wallets',
    tab: 'wallets',
    count: (_legacy, plan) => plan.wallets.filter((row) => row.include).length,
  },
  {
    key: 'mshop_d_*/acc',
    title: 'مبيعات الإكسسوارات',
    legacy: 'كل بيعة: صنف، شراء، بيع، ربح، وقت',
    plan: 'الشهر الحالي: فاتورة لكل بيعة. الشهور اللي فاتت: رقم مجمّع.',
    dest: 'المبيعات ← الفواتير',
    inNew: 'sales + sale_lines + sale_payments + stock_movements',
    tab: 'sales',
    count: (_legacy, plan) => plan.sales.filter((row) => row.section === 'acc' && row.include).length,
  },
  {
    key: 'mshop_d_*/used',
    title: 'مبيعات المستعمل',
    legacy: 'جهاز مستعمل اتباع',
    plan: 'زي الإكسسوار: تفصيلي في الشهر الحالي، ومجمّع قبله.',
    dest: 'المبيعات ← الفواتير ← مستعمل',
    inNew: 'sales + sale_lines',
    tab: 'sales',
    count: (_legacy, plan) => plan.sales.filter((row) => row.section === 'used' && row.include).length,
  },
  {
    key: 'mshop_d_*/phones',
    title: 'مبيعات الموبايلات',
    legacy: 'موديل، كمية، شراء، بيع',
    plan: 'فاتورة بسطر واحد لكل جهاز، والكمية بتتخصم من المخزن.',
    dest: 'المبيعات ← الفواتير',
    inNew: 'sales + sale_lines + stock_movements',
    tab: 'sales',
    count: (_legacy, plan) => plan.sales.filter((row) => row.section === 'phones' && row.include).length,
  },
  {
    key: 'mshop_d_*/sw',
    title: 'السوفت وير',
    legacy: 'جهاز + مبلغ + مدفوع/اتسلّم',
    plan: 'تذكرة سوفت وير في الصيانة.',
    dest: 'الصيانة ← التذاكر (نوع: سوفت وير)',
    inNew: 'repairs (service_kind = software)',
    tab: 'repairs',
    count: (_legacy, plan) => plan.repairs.filter((row) => row.kind === 'software' && row.include).length,
  },
  {
    key: 'mshop_d_*/repairs',
    title: 'الصيانة',
    legacy: 'تذكرة: جهاز، عيب، قطعة، مبلغ، حالة',
    plan: 'تذكرة كاملة بتاريخها وحالتها ومدفوعها.',
    dest: 'الصيانة ← التذاكر',
    inNew: 'repairs',
    tab: 'repairs',
    count: (_legacy, plan) => plan.repairs.filter((row) => row.kind === 'hardware' && row.include).length,
  },
  {
    key: 'mshop_d_*/exp',
    title: 'المصاريف',
    legacy: 'تصنيف + مبلغ + وقت',
    plan: 'مصروف بتاريخه، مدفوع «من برّه الدرج».',
    dest: 'المصاريف',
    inNew: 'expenses',
    tab: 'expenses',
    count: (_legacy, plan) => plan.expenses.filter((row) => row.include).length,
  },
  {
    key: 'mshop_d_*/cash',
    title: 'حركات الكاش',
    legacy: 'خدمة محفظة + العمولة (ومرة واحدة المبلغ اللي اتحرك)',
    plan: 'بتتحسب في التقرير بس، ومش بتتسجّل حركة محفظة.',
    dest: 'تقرير الترحيل + جدول عمولات الشهور',
    inNew: 'لا صف — أرقام فقط',
    tab: 'map',
    count: (_legacy, plan) => plan.cashOps.filter((row) => row.include).length,
  },
  {
    key: 'mshop_notes / notifs / trash / calc_hist',
    title: 'الملاحظات والتنبيهات والمهملات والآلة الحاسبة',
    legacy: 'حاجات شخصية وسجل أدوات',
    plan: 'مش بتتنقل — زي ما اتفقنا.',
    dest: '—',
    inNew: 'مفيش',
    tab: '',
    count: (legacy) => (legacy.excluded || []).length,
  },
];

// ── أين يقع كل صف في السيستم الجديد ───────────────────────────────────────
// اسم الشاشة اللي المالك هيلاقيها في البرنامج الجديد، والجدول اللي الصف بيتكتب فيه.
export const DESTINATIONS = {
  categories: { where: 'المخزن ← التصنيفات', table: 'departments' },
  brands: { where: 'المخزن ← الماركات', table: 'brands' },
  items: { where: 'المخزن ← الأصناف', table: 'products + stock_levels' },
  sales: { where: 'المبيعات ← الفواتير', table: 'sales + sale_lines + sale_payments' },
  summary: { where: 'المبيعات ← الفواتير (سطر مجمّع)', table: 'sales + sale_lines' },
  repairs: { where: 'الصيانة ← التذاكر', table: 'repairs' },
  expenses: { where: 'المصاريف', table: 'expenses' },
  wallets: { where: 'المحافظ', table: 'wallets' },
  months: { where: 'مبيعات كل شهر', table: 'sales (فاتورة لكل بيعة أو فاتورة شهر)' },
};

const KINDS = { accessory: 'إكسسوار', phone: 'موبايل جديد', used: 'مستعمل' };
const SALE_SECTIONS = { acc: 'إكسسوارات', used: 'مستعمل', phones: 'موبايلات' };

/**
 * لوحة الصف: شكله في القديم، وشكله في الجديد، وفين هيقع بالظبط.
 *
 * `plan` مطلوب عشان نترجم المعرّفات لأسماء (التصنيف، الشركة) — الصف لوحده بيقول
 * `categoryId` ومحدش بيفهمه.
 */
export function describeRow(plan, coll, row) {
  const category = plan.categories.find((entry) => entry.id === row.categoryId);
  const brand = plan.brands.find((entry) => entry.id === row.brandId);
  const dest = DESTINATIONS[coll] || { where: '—', table: '—' };
  const raw = row.raw || null;

  const newFields = (pairs) => pairs
    .map(([label, entry]) => ({ label, value: entry }))
    .filter((field) => field.value !== null && field.value !== undefined && field.value !== '');

  if (coll === 'items') {
    const section = category ? `قسم «${category.name}»` : 'من غير قسم';
    const fromStore = row.priceSource === 'mshop_inventory';
    // The catalogue rows are not kept byte-for-byte in the plan (only the values
    // that matter), so the old side falls back to those values rather than
    // showing an empty box.
    const fallback = fromStore
      ? [
        { key: 'brand', label: 'الشركة', value: brand?.name || null },
        { key: 'model', label: 'الموديل', value: row.model || null },
        { key: 'ram', label: 'الرام', value: row.ramGb ? `${row.ramGb} جيجا` : null },
        { key: 'storage', label: 'المساحة', value: row.storageGb ? `${row.storageGb} جيجا` : null },
        { key: 'qty', label: 'الكمية', value: String(row.qty) },
        { key: 'buyPrice', label: 'سعر الشراء', value: row.buy ? EGP(row.buy) : null },
      ]
      : [
        { key: 'name', label: 'الاسم', value: row.name },
        { key: 'buy', label: 'سعر الشراء', value: row.buy ? EGP(row.buy) : null },
        { key: 'sell', label: 'سعر البيع', value: row.sell ? EGP(row.sell) : null },
      ];
    return {
      old: {
        title: 'في القديم',
        section: row.priceSource,
        fields: legacyFields(fromStore ? 'inventory' : 'catalog', raw).length
          ? legacyFields(fromStore ? 'inventory' : 'catalog', raw)
          : fallback.filter((field) => field.value !== null),
      },
      next: {
        title: 'في السيستم الجديد',
        where: `المخزن ← الأصناف ← ${section}`,
        table: 'products',
        fields: newFields([
          ['الاسم', row.name],
          ['القسم', category?.name ?? '—'],
          ['النوع', KINDS[row.kind]],
          ['الشركة', brand?.name ?? null],
          ['الموديل', row.model],
          ['الرام', row.ramGb ? `${row.ramGb} جيجا` : null],
          ['المساحة', row.storageGb ? `${row.storageGb} جيجا` : null],
          ['سعر الشراء', row.buy ? EGP(row.buy) : null],
          ['سعر البيع', row.sell ? EGP(row.sell) : 'بدون سعر'],
          ['الكمية اللي هتتسجل', `${row.qty} قطعة`],
        ]),
      },
      note: row.qty > 0
        ? 'الكمية دي هي اللي هتتسجل في المخزن، وبتتسجل كاستلام افتتاحي بتاريخ الترحيل.'
        : 'الكمية صفر — الصنف هيتسجل بلا رصيد. عدّلها لو عنده قطع.',
    };
  }

  if (coll === 'categories') {
    const parent = plan.categories.find((entry) => entry.id === row.parentId);
    const items = plan.items.filter((item) => item.categoryId === row.id);
    return {
      old: {
        title: 'في القديم',
        fields: [{ label: 'اسم القسم', value: row.name }, ...(parent ? [{ label: 'تحت قسم', value: parent.name }] : [])],
      },
      next: {
        title: 'في السيستم الجديد',
        where: parent ? `المخزن ← التصنيفات ← تحت «${parent.name}»` : 'المخزن ← التصنيفات (تصنيف رئيسي)',
        table: 'departments',
        fields: newFields([
          ['الاسم', row.name],
          ['النوع', row.kind === 'phone' ? 'موبايلات (بشركة وموديل)' : row.kind === 'used' ? 'مستعمل' : 'بضاعة بالعدد'],
          ['الأيقونة', row.icon],
          ['الترتيب', String(row.sortOrder)],
          ['أصناف تحته', `${items.length} صنف`],
        ]),
      },
      note: items.length
        ? `${items.length} صنف هيتحط تحت القسم ده في المخزن.`
        : 'مفيش أصناف تحت القسم ده — هيتنقل فاضي.',
    };
  }

  if (coll === 'brands') {
    const items = plan.items.filter((item) => item.brandId === row.id);
    return {
      old: { title: 'في القديم', fields: [{ label: 'الشركة', value: row.name }] },
      next: {
        title: 'في السيستم الجديد',
        where: 'المخزن ← الماركات',
        table: 'brands',
        fields: newFields([
          ['الاسم', row.name],
          ['نوع الجهاز', row.deviceType === 'keypad' ? 'زراير' : row.deviceType === 'both' ? 'الاتنين' : 'تاتش'],
          ['الترتيب', String(row.sortOrder)],
          ['موبايلات عليها', `${items.length}`],
        ]),
      },
      note: items.length ? `${items.length} موبايل مربوط بالشركة دي.` : 'مفيش موبايلات عليها.',
    };
  }

  if (coll === 'sales') {
    const saleFallback = [
      { label: 'الصنف', value: row.name },
      { label: 'التصنيف', value: category?.name || SALE_SECTIONS[row.section] },
      { label: 'التاريخ', value: row.date },
      { label: 'الوقت', value: row.clock || 'مش مسجّل' },
      { label: 'سعر الشراء', value: EGP(row.buy) },
      { label: 'سعر البيع', value: EGP(row.sell) },
      { label: 'الربح', value: EGP((row.sell - row.buy) * row.qty) },
    ].filter((field) => field.value !== undefined && field.value !== null && field.value !== '');
    return {
      old: {
        title: 'في القديم',
        fields: legacyFields(row.section, raw).length
          ? legacyFields(row.section, raw)
          : saleFallback,
      },
      next: {
        title: 'في السيستم الجديد',
        where: `المبيعات ← فاتورة ${row.date}`
          + (category ? ` ← ${section(category)}` : ''),
        table: 'sales + sale_lines + sale_payments',
        fields: newFields([
          ['رقم الفاتورة', `TRH-${row.date.replace(/-/g, '')}-…`],
          ['التاريخ', row.date],
          ['الوقت', row.clock || 'ظهرًا (الوقت مش مسجّل)'],
          ['الصنف', row.name],
          ['القسم', category?.name ?? SALE_SECTIONS[row.section]],
          ['الكمية', String(row.qty)],
          ['سعر الوحدة', EGP(row.sell)],
          ['الإجمالي', EGP(row.sell * row.qty)],
          ['التكلفة', EGP(row.buy * row.qty)],
          ['الربح', EGP((row.sell - row.buy) * row.qty)],
          ['طريقة الدفع', 'كاش'],
        ]),
      },
      note: 'البيع بيتسجل من غير عميل ومن غير خصم — القديم مكانش بيسجّلهم. والكمية بتتخصم من المخزون.',
    };
  }

  if (coll === 'summary') {
    return {
      old: {
        title: 'في القديم',
        fields: [
          { label: 'الشهر', value: row.month },
          { label: 'القسم', value: SALE_SECTIONS[row.section] },
          { label: 'البند', value: row.label },
          { label: 'عدد الحركات', value: String(row.count) },
          { label: 'مبيعات', value: EGP(row.total) },
          { label: 'تكلفة', value: EGP(row.cost) },
        ],
      },
      next: {
        title: 'في السيستم الجديد',
        where: `المبيعات ← فاتورة مجمّعة لشهر ${row.month}`,
        table: 'sales (OLD-…) + sale_lines',
        fields: newFields([
          ['الفاتورة', `OLD-${row.month.replace('-', '')}-…`],
          ['البند', row.label],
          ['القسم', category?.name ?? SALE_SECTIONS[row.section]],
          ['المبلغ', EGP(row.total)],
          ['التكلفة', EGP(row.cost)],
          ['الربح', EGP(row.total - row.cost)],
        ]),
      },
      note: 'الصنف بيتسجل مؤرشف باسم «ترحيل …» عشان يبان في التقارير وميتباعش تاني.',
    };
  }

  if (coll === 'repairs') {
    return {
      old: {
        title: 'في القديم',
        fields: legacyFields(row.kind === 'software' ? 'sw' : 'repairs', raw).length
          ? legacyFields(row.kind === 'software' ? 'sw' : 'repairs', raw)
          : [
            { label: 'التذكرة', value: row.ticketNo },
            { label: 'الجهاز', value: row.deviceName },
            { label: 'العيب', value: row.issue },
            { label: 'المبلغ', value: EGP(row.price) },
          ],
      },
      next: {
        title: 'في السيستم الجديد',
        where: `الصيانة ← التذاكر (${row.kind === 'software' ? 'سوفت وير' : 'صيانة'})`,
        table: 'repairs',
        fields: newFields([
          ['رقم التذكرة', row.ticketNo],
          ['التاريخ', row.date],
          ['الجهاز', row.deviceName],
          ['العيب', row.issue],
          ['قطعة الغيار', row.partsCost ? EGP(row.partsCost) : 'بدون'],
          ['المبلغ', EGP(row.price)],
          ['الحالة', row.delivered ? 'اتسلّمت' : 'شغالة'],
          ['العميل', row.customerName || row.customerPhone || 'بدون'],
        ]),
      },
      note: row.delivered ? 'التذكرة هتتسجل «اتسلّمت».' : 'التذكرة هتتسجل «اتصلّحت» لسه ما اتسلّمتش.',
    };
  }

  if (coll === 'expenses') {
    return {
      old: {
        title: 'في القديم',
        fields: legacyFields('exp', raw).length
          ? legacyFields('exp', raw)
          : [
            { label: 'التصنيف', value: row.category },
            { label: 'المبلغ', value: EGP(row.amount) },
            { label: 'التاريخ', value: row.date },
          ],
      },
      next: {
        title: 'في السيستم الجديد',
        where: 'المصاريف',
        table: 'expenses',
        fields: newFields([
          ['التصنيف', row.category],
          ['المبلغ', EGP(row.amount)],
          ['التاريخ', row.date],
          ['مدفوع من', 'برّه الدرج'],
          ['ملاحظة', 'ترحيل من السيستم القديم'],
        ]),
      },
      note: '«برّه الدرج» لأن القديم مكانش بيقول المصروف طلع من أنهي درج.',
    };
  }

  if (coll === 'wallets') {
    const opening = row.balanceIsGuess;
    return {
      old: {
        title: 'في القديم',
        fields: [
          { label: 'المحفظة', value: row.name },
          { label: 'الرقم', value: row.number || 'بدون رقم' },
          { label: 'رصيد البداية المسجّل', value: EGP(row.openingBalance) },
          { label: 'تاريخ البداية', value: row.openingDate },
        ],
      },
      next: {
        title: 'في السيستم الجديد',
        where: 'المحافظ',
        table: 'wallets',
        fields: newFields([
          ['الاسم', row.name],
          ['الرقم', row.number || 'بدون رقم'],
          ['طريقة الدفع', row.payMethod === 'vf' ? 'فودافون كاش' : row.payMethod === 'instapay' ? 'إنستاباي' : 'محفظة عادية'],
          ['الرصيد اللي هتفتح بيه', EGP(row.currentBalance)],
          ['حد يومي', row.dailyLimit ? EGP(row.dailyLimit) : 'بدون'],
        ]),
      },
      note: opening
        ? 'الرصيد ده جاي من «رصيد البداية» في القديم، مش رصيد النهارده — عدّله على اللي في المحفظة فعلًا.'
        : '',
    };
  }

  if (coll === 'months') {
    const modeText = row.mode === 'detail'
      ? 'كل بيعة بتتحول لفاتورة لوحدها'
      : row.mode === 'summary' ? 'فاتورة واحدة للشهر + سطر لكل قسم' : 'الشهر مش هيتنقل';
    return {
      old: {
        title: 'في القديم',
        fields: [
          { label: 'الشهر', value: row.label },
          { label: 'مبيعات', value: EGP(row.totals?.sales) },
          { label: 'تكلفة', value: EGP(row.totals?.cost) },
          { label: 'مصاريف', value: EGP(row.totals?.expenses) },
        ],
      },
      next: {
        title: 'في السيستم الجديد',
        where: modeText,
        table: row.mode === 'detail' ? 'sales + sale_lines' : 'sales (مجمّع)',
        fields: newFields([
          ['الطريقة', row.mode === 'detail' ? 'تفصيلي' : row.mode === 'summary' ? 'مجمّع' : 'مش متنقل'],
          ['مبيعات الشهر', EGP(row.totals?.sales)],
          ['ربح الشهر', EGP(row.totals?.profit)],
        ]),
      },
      note: '',
    };
  }

  return {
    old: { title: 'في القديم', fields: legacyFields('acc', raw) },
    next: { title: 'في السيستم الجديد', where: dest.where, table: dest.table, fields: [] },
    note: '',
  };
}

function section(category) {
  return category.kind === 'phone' ? 'موبايلات جديدة' : category.kind === 'used' ? 'مستعمل' : category.name;
}

// ── حلول التنبيهات ───────────────────────────────────────────────────────
// كل تنبيه في `validatePlan` بيطلع بالكود بتاعه؛ هنا بنقول للمالك: يعني إيه،
// وليه حصل، وإيه اللي يعمله بالظبط، وفي أنهي تبويب.
export const FINDING_GUIDES = {
  'duplicate-category': {
    title: 'تصنيف مكرر',
    why: 'السيستم الجديد بيرفض تصنيفين بنفس الاسم، لأن الأصناف هتتلخبط بينهم.',
    fix: 'افتح التصنيفات، اختار الصفّين، ودوس «ادمج المحدد» — هيبقى قسم واحد وكل الأصناف تتحوّل عليه.',
    coll: 'categories',
    auto: 'merge-duplicate',
  },
  'empty-category': {
    title: 'تصنيف من غير اسم',
    why: 'الاسم فاضي، ومش ممكن يتحفظ كده في شجرة التصنيفات.',
    fix: 'اكتب له اسم، أو احذفه لو مش محتاجه.',
    coll: 'categories',
  },
  'category-icon': {
    title: 'أيقونة غير معروفة',
    why: 'السيستم الجديد عنده لستة أيقونات ثابتة، والاسم ده مش منها.',
    fix: 'من عمود الأيقونة اختار واحدة من اللستة — أو سيبها وهتتحول لـ«tag» لوحدها.',
    coll: 'categories',
  },
  'orphan-category': {
    title: 'تصنيف مربوط بأب مش موجود',
    why: 'التصنيف ده بيتقال إنه تحت تصنيف تاني، وده التاني مش موجود في الخطة (يمكن حذفته).',
    fix: 'افتح التصنيف وخلّي «تحت تصنيف» فاضي، أو اختار الأب الصح.',
    coll: 'categories',
    auto: 'clear-parent',
  },
  'empty-item': {
    title: 'صنف من غير اسم',
    why: 'كل صنف لازم يكون له اسم يبان في الفاتورة والمخزن.',
    fix: 'اكتب الاسم، أو استبعده من الترحيل (شيل علامة «يتنقل»).',
    coll: 'items',
  },
  'negative-price': {
    title: 'سعر سالب',
    why: 'المبلغ بالسالب مش ممكن يتحفظ في السيستم الجديد.',
    fix: 'امسح السالب — السعر لازم يكون صفر أو أكتر.',
    coll: 'items',
  },
  'item-category': {
    title: 'صنف في تصنيف مش موجود',
    why: 'الصنف مربوط بقسم اتشال من الخطة (أو استبعدته).',
    fix: 'اختار قسم من عمود «التصنيف»، أو اتركه «بدون تصنيف».',
    coll: 'items',
    auto: 'clear-category',
  },
  'phone-model': {
    title: 'موبايل من غير موديل',
    why: 'السيستم الجديد بيعرض الموبايل بـ«الشركة + الموديل»، والموديل فاضي.',
    fix: 'اكتب الموديل في التفاصيل (مثلًا A07)، أو حوّله لإكسسوار لو مش موبايل.',
    coll: 'items',
  },
  'phone-brand': {
    title: 'موبايل من غير شركة',
    why: '«صنف جديد» في السيستم الجديد بيطلب الشركة الأول عشان يجيب الموديلات.',
    fix: 'اختار الشركة من عمود «الشركة»، أو ضيف الماركة من تبويب الماركات.',
    coll: 'items',
  },
  'no-sale-price': {
    title: 'صنف من غير سعر بيع',
    why: 'القديم مكانش بيسجّل سعر بيع للصنف ده، والفاتورة بتحتاج سعر.',
    fix: 'اكتب سعر البيع في عمود «بيع». أداة الترحيل مش بتخترع سعر.',
    coll: 'items',
  },
  'duplicate-item': {
    title: 'صنف متكرر',
    why: 'نفس الاسم موجود مرتين، فهيتسجل صنفين منفصلين والمخزون هيتقسم عليهم.',
    fix: 'اختار الصفّين في الأصناف ودوس «ادمج المحدد» — الكميات بتتجمع.',
    coll: 'items',
    auto: 'merge-duplicate',
  },
  'item-excluded-with-sales': {
    title: 'صنف مستبعد وله مبيعات',
    why: 'الصنف مش محدد إنه يتنقل، بس فيه بيعة مسجّلة في شهر تفصيلي.',
    fix: 'لو عايز الصنف في المخزن، اشمله. ولو سايبه بره، مفيش حاجة تعملها — البيعة هتتنقل على صنف مؤرشف باسمه عشان رقم الشهر يفضل صح وميتباعش تاني.',
    coll: 'items',
    auto: 'include-item',
  },
  'sale-item-missing': {
    title: 'بيعة مربوطة بصنف مش موجود',
    why: 'الصنف بتاع البيعة اتشال من الخطة، فمفيش حاجة تتسجل عليها الفاتورة.',
    fix: 'ارجّع الصنف (اشمله من الأصناف)، أو احذف البيعة دي.',
    coll: 'sales',
  },
  'month-skipped': {
    title: 'شهر متحدد إنه ما يتنقلش',
    why: 'علّمته «مش متنقل» بس سايبه محدد إنه يتنقل — الاتنين متناقضين.',
    fix: 'اختار في تبويب الشهور: إما «يتنقل» أو شيل علامة التحديد.',
    coll: 'months',
    auto: 'unskip',
  },
  'wallet-negative': {
    title: 'رصيد محفظة سالب',
    why: 'المحفظة مش ممكن تفتح برصيد بالسالب.',
    fix: 'اكتب الرصيد الحقيقي (صفر أو أكتر).',
    coll: 'wallets',
  },
  'wallet-number': {
    title: 'رقم محفظة طويل',
    why: 'السيستم بيسمح بـ80 حرف للرقم.',
    fix: 'قصّر الرقم لآخر 11 رقم مثلًا.',
    coll: 'wallets',
  },
  'expense-zero': {
    title: 'مصروف بمبلغ صفر',
    why: 'مصروف صفر مش هيتسجل ومش هيبان في التقارير.',
    fix: 'اكتب المبلغ، أو استبعده.',
    coll: 'expenses',
  },
  'repair-price': {
    title: 'تذكرة بمبلغ سالب',
    why: 'المبلغ أو سعر القطعة بالسالب.',
    fix: 'امسح السالب من التفاصيل.',
    coll: 'repairs',
  },
};

/** اسم التبويب اللي بيخص كود التنبيه. */
export function tabOfFinding(finding) {
  const guide = FINDING_GUIDES[finding.code];
  switch (guide?.coll) {
    case 'categories': return 'categories';
    case 'items': return 'items';
    case 'brands': return 'brands';
    case 'sales': return 'sales';
    case 'months': return 'months';
    case 'wallets': return 'wallets';
    case 'expenses': return 'expenses';
    case 'repairs': return 'repairs';
    default: return 'overview';
  }
}

/** التنبيه بشكل واحد للعرض: العنوان، السبب، الحل، ومكان الصف. */
export function explainFinding(finding) {
  const guide = FINDING_GUIDES[finding.code] || {
    title: 'ملاحظة',
    why: 'الفحص لقى حاجة محتاجة مراجعة.',
    fix: 'راجع الصف وغير اللي ناقص.',
  };
  return {
    level: finding.level,
    code: finding.code,
    title: guide.title,
    message: finding.message,
    why: guide.why,
    fix: guide.fix,
    auto: guide.auto || null,
    tab: tabOfFinding(finding),
    ref: finding.ref || null,
  };
}

// ── محرّرات الحقول ────────────────────────────────────────────────────────
// نفس الحقول في لوحة التفاصيل: النوع بيحدد شكل الحقل، والحدود بتمنع القيم اللي
// السيستم الجديد بيرفضها.
export function fieldsOf(plan, coll, row) {
  const categories = plan.categories.filter((entry) => entry.include);
  const brands = plan.brands.filter((entry) => entry.include);
  const text = (field, label, extra = {}) => ({ field, label, type: 'text', ...extra });
  const money = (field, label) => ({ field, label, type: 'float', step: '0.01' });
  const count = (field, label) => ({ field, label, type: 'int', min: '0' });

  if (coll === 'items') {
    const base = [
      text('name', 'الاسم', { wide: true }),
      { field: 'kind', label: 'النوع', type: 'select', options: [['accessory', 'إكسسوار'], ['phone', 'موبايل جديد'], ['used', 'مستعمل']] },
      { field: 'categoryId', label: 'القسم', type: 'select', options: [['', '— بدون قسم —'], ...categories.map((entry) => [entry.id, entry.name])] },
      money('buy', 'سعر الشراء'),
      money('sell', 'سعر البيع'),
      count('qty', 'الكمية عندك دلوقتي'),
    ];
    if (row.kind === 'phone') {
      base.push(
        { field: 'brandId', label: 'الشركة', type: 'select', options: [['', '— بدون شركة —'], ...brands.map((entry) => [entry.id, entry.name])] },
        text('model', 'الموديل'),
        count('ramGb', 'الرام (جيجا)'),
        count('storageGb', 'المساحة (جيجا)'),
      );
    }
    base.push(text('supplier', 'المورد'), text('notes', 'ملاحظات', { wide: true }));
    return base;
  }
  if (coll === 'categories') {
    return [
      text('name', 'اسم التصنيف', { wide: true }),
      { field: 'kind', label: 'النوع', type: 'select', options: [['item', 'بضاعة بالعدد'], ['phone', 'موبايلات جديدة'], ['used', 'مستعمل']] },
      {
        field: 'parentId',
        label: 'تحت تصنيف',
        type: 'select',
        options: [['', '— تصنيف رئيسي —'], ...plan.categories.filter((entry) => !entry.parentId && entry.id !== row.id).map((entry) => [entry.id, entry.name])],
      },
      count('sortOrder', 'الترتيب'),
    ];
  }
  if (coll === 'brands') {
    return [
      text('name', 'اسم الشركة', { wide: true }),
      { field: 'deviceType', label: 'نوع الجهاز', type: 'select', options: [['touch', 'تاتش'], ['keypad', 'زراير'], ['both', 'الاتنين']] },
      count('sortOrder', 'الترتيب'),
    ];
  }
  if (coll === 'sales') {
    return [
      text('name', 'الصنف', { wide: true }),
      { field: 'itemId', label: 'الصنف في المخزن', type: 'select', options: plan.items.map((entry) => [entry.id, entry.name]) },
      text('date', 'التاريخ (YYYY-MM-DD)'),
      text('clock', 'الوقت'),
      count('qty', 'الكمية'),
      money('buy', 'سعر الشراء'),
      money('sell', 'سعر البيع'),
    ];
  }
  if (coll === 'summary') {
    return [
      text('label', 'اسم البند', { wide: true }),
      count('count', 'عدد الحركات'),
      money('total', 'المبيعات'),
      money('cost', 'التكلفة'),
      { field: 'categoryId', label: 'القسم', type: 'select', options: [['', '— بدون قسم —'], ...categories.map((entry) => [entry.id, entry.name])] },
    ];
  }
  if (coll === 'repairs') {
    return [
      text('ticketNo', 'رقم التذكرة'),
      { field: 'kind', label: 'النوع', type: 'select', options: [['hardware', 'صيانة'], ['software', 'سوفت وير']] },
      text('date', 'التاريخ (YYYY-MM-DD)'),
      text('deviceName', 'الجهاز', { wide: true }),
      text('issue', 'العيب', { wide: true }),
      text('customerName', 'اسم العميل'),
      text('customerPhone', 'تليفون العميل'),
      money('partsCost', 'سعر القطعة'),
      money('price', 'المبلغ'),
      { field: 'delivered', label: 'اتسلّمت', type: 'bool' },
    ];
  }
  if (coll === 'expenses') {
    return [
      text('category', 'التصنيف'),
      text('date', 'التاريخ (YYYY-MM-DD)'),
      money('amount', 'المبلغ'),
    ];
  }
  if (coll === 'wallets') {
    return [
      text('name', 'اسم المحفظة', { wide: true }),
      text('number', 'الرقم'),
      money('currentBalance', 'الرصيد اللي هتفتح بيه'),
      money('dailyLimit', 'الحد اليومي'),
    ];
  }
  if (coll === 'months') {
    return [
      { field: 'mode', label: 'طريقة النقل', type: 'select', options: [['detail', 'تفصيلي'], ['summary', 'مجمّع'], ['skip', 'مش متنقل']] },
    ];
  }
  return [];
}

/** القيمة معروضة زي ما الشاشة بتعرضها. */
export function fieldValue(row, field) {
  const entry = row[field];
  if (entry === null || entry === undefined) return '';
  return String(entry);
}

/** الترجمة العربية للي بيحصل للصف. */
export function stateOf(row) {
  if (row.include === false) return { label: 'مش هيتنقل', tone: 'off' };
  return { label: 'هيتنقل', tone: 'on' };
}

export { normalizeText };
