// ═══════════════════════════════════════════════════════════
// import_probe.mjs — SPIKE (throwaway): إثبات استيراد legacy
// ═══════════════════════════════════════════════════════════
// هدف: إثبات feasibility قبل تثبيت مخطط SQLite (المهمة 1.4 في الخطة).
// ليس محوّل إنتاج. يقرأ تصديرًا اصطناعيًا، يطبّع كل سجل إلى «لقطة» مستقلة
// عن شكل المصدر، ثم يتحقق من شروط القبول.
//
// Node فقط، بلا اعتماديات. exit 1 عند كسر أي شرط.
//
// مراجع المصدر (غير منسوخة، للقراءة فقط):
//   dev_extracted/dev/js/storage.js:110-138  → خلط الشكلين داخل نفس القسم
//   dev_extracted/dev/js/ui.js:24-50        → صيغة مجام��ع التقرير القديم
// ═══════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(HERE, 'fixtures', 'legacy-export-mixed.json');

// ── markers مستخرجة من storage.js:120-123 ───────────────────
// repairs مستثناة عمدًا: لا mapper مسجّل لها، فتبقى محلية دائمًا.
const DB_SHAPE_MARKER = Object.freeze({
  acc: 'snapshotName',
  used: 'snapshotName',
  sw: 'snapshotName',
  cash: 'walletName',
  exp: 'snapshotCategory',
  phones: 'snapshotModelName',
});

const failures = [];
const reviewQueue = [];

function check(ok, label, detail = '') {
  if (ok) console.log(`  [ok]   ${label}`);
  else {
    console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`);
    failures.push(label + (detail ? ` — ${detail}` : ''));
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v) => (typeof v === 'string' && v.length ? v : null);

function detectShape(subKey, record) {
  const marker = DB_SHAPE_MARKER[subKey];
  if (!marker) return 'local';
  return Object.prototype.hasOwnProperty.call(record, marker) ? 'db' : 'local';
}

// وصف مختلف لكل قسم: الإكسسوار/المستعمل/السوفتوير بالاسم،
// الهاتف بلقطة الموديل، والصيانة باسم العلامة+الموديل.
function descriptionFor(kind, r) {
  if (kind === 'phones') {
    return str(r.snapshotModelName) ?? str(r.modelName) ?? ([str(r.brand), str(r.model)].filter(Boolean).join(' ') || null);
  }
  if (kind === 'repairs') {
    return [str(r.brand), str(r.model)].filter(Boolean).join(' ') || null;
  }
  // الكاش وصفه اسم المحفظة/الخدمة، والمصروف وصفه فئته.
  if (kind === 'cash') {
    return str(r.walletName) ?? str(r.service) ?? null;
  }
  if (kind === 'exp') {
    return str(r.snapshotCategory) ?? str(r.category) ?? null;
  }
  return str(r.snapshotName) ?? str(r.name) ?? null;
}

// لقطة معيارية واحدة لكل المعاملات. لا تحمّل productId ولا userId مطلقًا.
function toSnapshot(kind, date, record, shape) {
  return {
    kind,
    date,
    id: record.id ?? null,
    shape,
    description: descriptionFor(kind, record),
    category: str(record.snapshotCategory) ?? str(record.mainCat) ?? str(record.faultType) ?? null,
    cost: num(record.buyAmount ?? record.buy ?? record.buyPrice),
    price: num(record.sellAmount ?? record.sell ?? record.sellPrice),
    amount: num(record.amount ?? record.price),
    servicePrice: num(record.servicePrice),
    profit: num(record.profit),
    qty: typeof record.qty === 'number' ? record.qty : 1,
    cashType: str(record.cashType) ?? null,
    wallet: str(record.walletName) ?? str(record.service) ?? null,
    status: str(record.status) ?? null,
    clientName: str(record.clientName) ?? null,
    rolled: !!record._rolled || record.transactionType === 'rollback' || record.isRolledBack === true,
    origin: 'legacy-import',
    createdBy: null, // لا يوجد مستخدم موثوق في legacy
    productId: null, // لا يُخترع ربط بالمنتجات
  };
}

function readPartition(exportData, key) {
  const raw = exportData[key];
  if (!raw) return [];
  const rows = [];
  for (const [subKey, records] of Object.entries(raw)) {
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      if (!record || typeof record !== 'object') {
        reviewQueue.push({ key, subKey, reason: 'record-not-object' });
        continue;
      }
      const shape = detectShape(subKey, record);
      const row = toSnapshot(subKey, key.replace('mshop_d_', ''), record, shape);
      rows.push(row);
      if (!row.description) {
        reviewQueue.push({ key, subKey, id: row.id, reason: 'missing-description' });
      }
    }
  }
  return rows;
}

// ── مجاميع التقرير القديم: نفس تعريف ui.js:24-50 حرفيًا ──────
// cT = sum(cash.amount) بلا إشارة على cashType — إيداع وسحب معًا، كما في الكود.
const live = (r) => !r.rolled;

function totalsFor(rows) {
  const acc = rows.filter((r) => r.kind === 'acc' && live(r));
  const used = rows.filter((r) => r.kind === 'used' && live(r));
  const cash = rows.filter((r) => r.kind === 'cash' && live(r));
  const sw = rows.filter((r) => r.kind === 'sw' && live(r));
  const exp = rows.filter((r) => r.kind === 'exp' && live(r));
  const ph = rows.filter((r) => r.kind === 'phones' && live(r));
  const rep = rows.filter((r) => r.kind === 'repairs' && live(r));

  const aS = acc.reduce((s, r) => s + r.price, 0);
  const aP = acc.reduce((s, r) => s + r.profit, 0);
  const uS = used.reduce((s, r) => s + r.price, 0);
  const uP = used.reduce((s, r) => s + r.profit, 0);
  const cT = cash.reduce((s, r) => s + r.amount, 0);
  const sT = sw.reduce((s, r) => s + r.amount, 0);
  const eT = exp.reduce((s, r) => s + r.amount, 0);
  const phS = ph.reduce((s, r) => s + r.price * r.qty, 0);
  const phP = ph.reduce((s, r) => s + r.profit, 0);
  const repS = rep.reduce((s, r) => s + r.servicePrice, 0);
  const repP = rep.filter((r) => r.status !== 'ملغي').reduce((s, r) => s + r.profit, 0);

  return {
    aS, aP, uS, uP, cT, sT, eT, phS, phP, repS, repP,
    total: aS + sT + cT,
    profit: aP + uP + cT + sT + phP + repP - eT,
  };
}

function sumTotals(list) {
  const out = {};
  for (const k of Object.keys(list[0] ?? {})) out[k] = list.reduce((s, t) => s + (t[k] ?? 0), 0);
  return out;
}

// ── التنفيذ ─────────────────────────────────────────────────

const exportData = JSON.parse(readFileSync(fixturePath, 'utf8'));
const partitionKeys = Object.keys(exportData).filter((k) => k.startsWith('mshop_d_')).sort();

console.log('Legacy import probe (spike)');
console.log('===========================\n');

const byDay = [];
const rowsByDay = new Map();
for (const key of partitionKeys) {
  const rows = readPartition(exportData, key);
  rowsByDay.set(key, rows);
  byDay.push(totalsFor(rows));
  const db = rows.filter((r) => r.shape === 'db').length;
  const local = rows.filter((r) => r.shape === 'local').length;
  console.log(`${key}: ${rows.length} سجل (db-shape=${db}, local-shape=${local})`);
}

const allRows = [...rowsByDay.values()].flat();
const grand = sumTotals(byDay);
const expected = exportData._expected_legacy_totals;

console.log('\n1) كشف الشكل لكل سجل على حدة');
{
  const acc1 = rowsByDay.get('mshop_d_2026-09-20').filter((r) => r.kind === 'acc');
  check(
    acc1.some((r) => r.shape === 'db') && acc1.some((r) => r.shape === 'local'),
    'قسم acc في نفس اليوم يحتوي السجلين (db و local)',
    `shapes=${acc1.map((r) => r.shape).join(',')}`,
  );
  check(
    acc1.every((r) => r.description && r.description.length > 0),
    'الاسم يُقرأ من snapshotName أو name في الشكلين',
  );
  const phoneRow = allRows.find((r) => r.kind === 'phones');
  check(phoneRow?.description === 'Samsung A55 8/128', 'لقطة الموديل تُقرأ من snapshotModelName');
  const repairRow = allRows.find((r) => r.id === 'rep_1');
  check(repairRow?.description === 'Huawei P40', 'وصف الصيانة يُركّب من العلامة+الموديل');
}

console.log('\n2) عدم اختراع بيانات');
{
  check(allRows.every((r) => r.productId === null), 'لا يوجد productId مُختلق لأي معاملة');
  check(allRows.every((r) => r.origin === 'legacy-import'), 'كل المعاملات تحمل origin=legacy-import');
  check(allRows.every((r) => r.createdBy === null), 'لا يوجد مستخدم منسوب بلا مصدر');

  const ca = exportData.mshop_ca ?? [];
  const cu = exportData.mshop_cu ?? [];
  check(ca.length > 0 && ca.every((i) => !('qty' in i)), 'كتالوج الإكسسوارات بلا كميات — لا رصيد مُستنتج');
  check(cu.length > 0 && cu.every((i) => !('qty' in i)), 'كتالوج المستعمل بلا كميات — لا رصيد مُستنتج');
}

console.log('\n3) حفظ اللقطات واستبعاد الملغى');
{
  const rolled = allRows.filter((r) => r.rolled);
  check(rolled.length === 1 && rolled[0].kind === 'acc', 'المعاملة الملغاة (_rolled) مُكتشفة');
  check(
    allRows.filter((r) => r.kind === 'phones').every((r) => r.cost === 9000 && r.profit === 600),
    'تكلفة/ربح بيع الهاتف محفوظان من لحظة البيع',
  );
  check(
    allRows.filter((r) => r.kind === 'acc').some((r) => r.cost === 40),
    'تكلفة الإكسسوار محفوظة (40) رغم اختلاف سعر الكتالوج',
  );
}

console.log('\n4) مطابقة مجاميع التقرير القديم');
{
  for (const [i, key] of partitionKeys.entries()) {
    const day = key.replace('mshop_d_', '');
    const exp = expected.byDay[day];
    const got = byDay[i];
    const diffs = Object.keys(exp)
      .filter((k) => !k.startsWith('_'))
      .filter((k) => got[k] !== exp[k])
      .map((k) => `${k}: متوقع ${exp[k]} / فعلي ${got[k]}`);
    check(diffs.length === 0, `مجاميع ${day} مطابقة للصيغة المعتمدة`, diffs.join('; '));
  }
  const gdiff = Object.keys(expected.grand)
    .filter((k) => grand[k] !== expected.grand[k])
    .map((k) => `${k}: متوقع ${expected.grand[k]} / فعلي ${grand[k]}`);
  check(gdiff.length === 0, 'المجاميع الكلية مطابقة', gdiff.join('; '));

  const day1 = byDay[0];
  const phoneSales = allRows.filter((r) => r.date === '2026-09-20' && r.kind === 'phones').reduce((s, r) => s + r.price * r.qty, 0);
  check(day1.total === day1.aS + day1.sT + day1.cT, 'إجمالي المبيعات = إكسسوار + سوفت وير + كاش فقط');
  check(day1.total < day1.aS + day1.sT + day1.cT + phoneSales, 'بيع الهواتف لا يدخل في إجمالي المبيعات القديم');
  check(day1.cT === 700, 'cT تجمع السحب مع الإيداع (700) — سلوك الكود القديم، لا إصلاح تلقائي');
  check(day1.repP === 100 && day1.repS === 350, 'الصيانة الملغاة: مستثناة من الربح، باقية في مجموع servicePrice');
}

console.log('\n5) قائمة المراجعة اليدوية');
{
  check(reviewQueue.length === 0, 'لا سجلات تحتاج تخمينًا أو ربطًا يدويًا', JSON.stringify(reviewQueue));
  for (const q of reviewQueue) console.log('    -', JSON.stringify(q));
}

console.log('\n---');
if (failures.length) {
  console.log(`RESULT: FAIL (${failures.length})`);
  for (const f of failures) console.log('  *', f);
  process.exit(1);
}
console.log('RESULT: PASS — القراءة ممكنة، الحدود موثّقة، ولا حاجة لاختراع بيانات.');
