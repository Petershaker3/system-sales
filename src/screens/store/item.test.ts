// Unit tests for «صنف جديد»'s pure choices. Run: npm run test:unit
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CategoryEntry } from '../../api/categories.ts';
import {
  barcodeProblem,
  ean13CheckDigit,
  isShopCode,
  itemCategories,
  itemProblem,
  newCategoryParent,
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
