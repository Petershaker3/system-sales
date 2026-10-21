// Unit tests for «صنف جديد»'s pure choices. Run: npm run test:unit
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CategoryEntry } from '../../api/categories.ts';
import {
  addVariantValue,
  barcodeProblem,
  cleanVariantValue,
  comboKey,
  comboLabel,
  dimensionSuggestions,
  ean13CheckDigit,
  isShopCode,
  itemCategories,
  itemProblem,
  MAX_VARIANTS,
  newCategoryParent,
  plannedReceipt,
  VARIANT_DIMENSIONS,
  variantCombos,
  variantsProblem,
  variantTitle,
} from './item.ts';


function category(
  id: string,
  name: string,
  parentId: string | null,
  kind: CategoryEntry['kind'],
  sortOrder: number
): CategoryEntry {
  return {
    id,
    name,
    parentId,
    kind,
    icon: 'tag',
    hidden: false,
    sortOrder,
    products: 0,
    isDefault: true,
    deletable: false,
  };
}

// The tree the shop starts with, flattened in `list_categories`' order.
const TREE: CategoryEntry[] = [
  category('phone', 'موبايلات جديدة', null, 'phone', 10),
  category('used', 'مستعمل', null, 'used', 20),
  category('items', 'إكسسوارات', null, 'item', 30),
  category('cases', 'جرابات', 'items', 'item', 10),
  category('screens', 'اسكرينات', 'items', 'item', 20),
  category('chargers', 'شواحن', 'items', 'item', 30),
  category('watch', 'ساعات ذكية', null, 'item', 40),
];

test('counted items are offered the sub-categories of a counted main', () => {
  assert.deepEqual(
    itemCategories(TREE).map((c) => c.name),
    ['جرابات', 'اسكرينات', 'شواحن', 'ساعات ذكية']
  );
});

test('a counted main with no sub-category is offered itself', () => {
  const tree = TREE.filter((c) => c.id !== 'watch');
  tree.push(category('parts', 'قطع غيار', null, 'item', 50));
  assert.deepEqual(
    itemCategories(tree).map((c) => c.name),
    ['جرابات', 'اسكرينات', 'شواحن', 'قطع غيار']
  );
});

test('phone and used categories are never offered to a counted item', () => {
  const names = itemCategories(TREE).map((c) => c.name);
  assert.ok(!names.includes('موبايلات جديدة'));
  assert.ok(!names.includes('مستعمل'));
});

test('a hidden counted category is still offered for creating an item', () => {
  // Hiding removes the button from the sales screen only (ADR-018 §1).
  const tree = TREE.map((c) => (c.id === 'cases' ? { ...c, hidden: true } : c));
  assert.ok(itemCategories(tree).some((c) => c.name === 'جرابات'));
});

test('a new inline category goes under the chosen sub-category’s main', () => {
  assert.equal(newCategoryParent(TREE, 'cases'), 'items');
});

test('a new inline category under a childless main becomes its first sub', () => {
  const tree = TREE.filter((c) => c.parentId !== 'items');
  assert.equal(newCategoryParent(tree, 'watch'), 'watch');
});

test('with nothing chosen there is no parent for a new category', () => {
  assert.equal(newCategoryParent(TREE, ''), null);
});

test('a barcode is optional, and otherwise 6 to 14 digits', () => {
  assert.equal(barcodeProblem(''), '');
  assert.equal(barcodeProblem('   '), '');
  assert.equal(barcodeProblem('123456'), '');
  assert.equal(barcodeProblem('12345678901234'), '');
  assert.equal(barcodeProblem('12345'), 'الباركود أرقام بس (من 6 لـ 14 رقم)');
  assert.equal(barcodeProblem('123456789012345'), 'الباركود أرقام بس (من 6 لـ 14 رقم)');
  assert.equal(barcodeProblem('ABC123'), 'الباركود أرقام بس (من 6 لـ 14 رقم)');
  assert.equal(barcodeProblem(' 123456 '), '');
});

test('the EAN-13 check digit is the standard one', () => {
  assert.equal(ean13CheckDigit('400638133393'), 1);
  assert.equal(ean13CheckDigit('200000000001'), 5);
  assert.equal(ean13CheckDigit('200000000006'), 0);
  assert.equal(ean13CheckDigit('20000000000'), null);
  assert.equal(ean13CheckDigit('20000000000A'), null);
});

test('only a 2-prefixed code with a right check digit reads as a shop code', () => {
  assert.equal(isShopCode('2000000000015'), true);
  assert.equal(isShopCode('2000000000019'), false); // wrong check digit
  assert.equal(isShopCode('4006381333931'), false); // a manufacturer's code
  assert.equal(isShopCode('200000000001'), false); // not 13 digits
  assert.equal(isShopCode('200000000001A'), false);
});

test('the first missing thing is the one named, in the mockup’s order', () => {
  const cats = itemCategories(TREE);
  const complete = { categoryId: 'cases', name: 'جراب', barcode: '', priceMinor: 7500 };

  assert.equal(itemProblem([], complete), 'مفيش تصنيف بالعدد. ضيف واحد من الإعدادات.');
  assert.equal(itemProblem(cats, { ...complete, categoryId: '' }), 'اختار التصنيف');
  assert.equal(itemProblem(cats, { ...complete, name: '   ' }), 'اكتب اسم الصنف');
  assert.equal(
    itemProblem(cats, { ...complete, barcode: 'abc' }),
    'الباركود أرقام بس (من 6 لـ 14 رقم)'
  );
  assert.equal(itemProblem(cats, { ...complete, priceMinor: null }), 'اكتب سعر البيع');
  assert.equal(itemProblem(cats, { ...complete, priceMinor: 0 }), 'اكتب سعر البيع');
  assert.equal(itemProblem(cats, complete), '');
});

test('the seven variant dimensions and their suggestions match the mockup', () => {
  assert.deepEqual(VARIANT_DIMENSIONS, [
    'الموبايل',
    'اللون',
    'النوع',
    'المقاس',
    'القوة',
    'الطول',
    'المساحة',
  ]);
  assert.ok(dimensionSuggestions('اللون').includes('أسود'));
  assert.ok(dimensionSuggestions('القوة').includes('25W'));
  assert.ok(dimensionSuggestions('الطول').includes('1م'));
  assert.ok(dimensionSuggestions('المساحة').includes('128GB'));
  assert.deepEqual(dimensionSuggestions('الموبايل', ['Galaxy A16', 'iPhone 16']), [
    'Galaxy A16',
    'iPhone 16',
  ]);
  assert.deepEqual(dimensionSuggestions('المقاس'), []);
});

test('cleanVariantValue and addVariantValue strip commas and refuse duplicates', () => {
  assert.equal(cleanVariantValue('  Galaxy   A16،،, '), 'Galaxy A16');
  const first = addVariantValue([], 'Galaxy A16،');
  assert.deepEqual(first, ['Galaxy A16']);
  assert.deepEqual(addVariantValue(first, 'galaxy  a16'), ['Galaxy A16']);
  assert.deepEqual(addVariantValue(first, 'أبيض'), ['Galaxy A16', 'أبيض']);
  assert.deepEqual(addVariantValue(['أبيض'], 'ابيض'), ['أبيض']);
});

test('variantCombos requires the first dimension and builds the Cartesian product', () => {
  assert.deepEqual(variantCombos([]), []);
  assert.deepEqual(variantCombos([{ values: [] }, { values: ['أسود'] }]), []);
  assert.deepEqual(
    variantCombos([{ values: ['20W', '33W'] }, { values: [] }]),
    [['20W'], ['33W']],
  );
  assert.deepEqual(
    variantCombos([
      { values: ['Galaxy A16', 'iPhone 16'] },
      { values: ['أسود', 'بينك'] },
    ]),
    [
      ['Galaxy A16', 'أسود'],
      ['Galaxy A16', 'بينك'],
      ['iPhone 16', 'أسود'],
      ['iPhone 16', 'بينك'],
    ],
  );
  assert.equal(comboKey(['Galaxy A16', 'أسود']), 'Galaxy A16|أسود');
  assert.equal(comboLabel(['Galaxy A16', 'أسود']), 'Galaxy A16، أسود');
  assert.equal(
    variantTitle('  جراب   سيليكون ملون ', ['Galaxy A16', 'أسود']),
    'جراب سيليكون ملون Galaxy A16 أسود',
  );
});

test('variantsProblem validates dimensions, the 60-variant cap, row barcodes and prices', () => {
  const cats = itemCategories(TREE);
  const base = {
    categoryId: 'cases',
    name: 'جراب سيليكون ملون',
    dim1Label: 'الموبايل',
    dim1Values: ['Galaxy A16', 'iPhone 16'],
    dim2Label: 'اللون',
    dim2Values: ['أسود', 'بينك'],
    priceMinor: 7500,
    rows: {},
  };

  assert.equal(variantsProblem(cats, base), '');
  assert.equal(
    variantsProblem(cats, { ...base, dim1Values: [] }),
    'اكتب نوع واحد على الأقل في «الموبايل»، ودوس Enter بعد كل واحد',
  );

  const sixtyOne = Array.from({ length: MAX_VARIANTS + 1 }, (_, i) => `M${i + 1}`);
  assert.ok(
    variantsProblem(cats, { ...base, dim1Values: sixtyOne, dim2Values: [] }).includes('الحد 60'),
  );

  assert.equal(
    variantsProblem(cats, {
      ...base,
      rows: { 'Galaxy A16|أسود': { barcode: '123', price: '' } },
    }),
    '«Galaxy A16، أسود»: الباركود أرقام بس (من 6 لـ 14 رقم)',
  );

  assert.equal(
    variantsProblem(cats, {
      ...base,
      rows: {
        'Galaxy A16|أسود': { barcode: '2000000000015', price: '' },
        'iPhone 16|بينك': { barcode: '2000000000015', price: '' },
      },
    }),
    '«iPhone 16، بينك»: الباركود ده على «Galaxy A16، أسود»',
  );

  assert.equal(
    variantsProblem(cats, { ...base, priceMinor: null }),
    'اكتب سعر البيع',
  );

  assert.equal(
    variantsProblem(cats, {
      ...base,
      rows: { 'Galaxy A16|أسود': { barcode: '', price: '0' } },
    }),
    '«Galaxy A16، أسود»: اكتب سعر البيع',
  );
});


// The goods on the shelf, typed in the registration form itself (owner request
// 2026-10-21): a count and a cost become a receipt; a count without a cost is
// refused; empty fields keep the old two-step walk to «استلام توريد».
test('plannedReceipt: both empty = registration alone, as before', () => {
  assert.equal(plannedReceipt('', ''), null);
  assert.equal(plannedReceipt('  ', ''), null);
});

test('plannedReceipt: a count and a cost become one receipt, in piastres', () => {
  assert.deepEqual(plannedReceipt('5', '12.50'), { qty: 5, costMinor: 1250 });
  assert.deepEqual(plannedReceipt('1', '0'), { qty: 1, costMinor: 0 }, 'a free batch is a cost of zero, not a missing one');
});

test('plannedReceipt: a count without a cost is refused loudly', () => {
  assert.equal(typeof plannedReceipt('5', ''), 'string');
  assert.equal(typeof plannedReceipt('5', 'abc'), 'string');
  assert.equal(typeof plannedReceipt('0', '10'), 'string', 'zero units is not a receipt');
  assert.equal(typeof plannedReceipt('-3', '10'), 'string');
  assert.equal(typeof plannedReceipt('2.5', '10'), 'string', 'half a piece does not go on a shelf');
});

test('plannedReceipt: a cost without a count asks for the count', () => {
  assert.equal(typeof plannedReceipt('', '10'), 'string');
});

test('variantsProblem: a row with a count needs its cost — its own or the form’s', () => {
  const cats = [
    {
      id: 'c1',
      name: 'إكسسوارات',
      parentId: null,
      kind: 'item',
      icon: 'tag',
      hidden: false,
      sortOrder: 0,
      products: 0,
      isDefault: true,
      deletable: false,
    },
  ] as unknown as readonly CategoryEntry[];
  const base = {
    categoryId: 'c1',
    name: 'جراب',
    dim1Label: 'الموبايل' as const,
    dim1Values: ['Galaxy A16'],
    dim2Label: 'اللون' as const,
    dim2Values: [],
    priceMinor: 15000,
    rows: { 'Galaxy A16': { barcode: '', price: '', qty: '3', cost: '' } },
  };
  assert.equal(
    variantsProblem(cats, base),
    '«Galaxy A16»: اكتب تكلفة الوحدة للبضاعة الموجودة',
  );
  assert.equal(variantsProblem(cats, { ...base, defaultCost: '25' }), '');
  assert.equal(
    variantsProblem(cats, {
      ...base,
      rows: { 'Galaxy A16': { barcode: '', price: '', qty: '3', cost: '25' } },
    }),
    '',
  );
  assert.equal(variantsProblem(cats, { ...base, rows: { 'Galaxy A16': { barcode: '', price: '' } } }), '');
});
