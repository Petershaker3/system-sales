import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  brandChips,
  brandPick,
  buildTree,
  chipVisible,
  inChip,
  inSelection,
  keepSelection,
  mainChips,
  mainOf,
  searchWords,
  subChips,
  toggle,
} from './categories.ts';
import type { TreeCategory } from './categories.ts';

const cat = (id: string, name: string, parentId: string | null = null, hidden = false, kind = 'item'): TreeCategory => ({
  id,
  name,
  parentId,
  kind,
  icon: 'tag',
  hidden,
});

// The order is the owner's, as the backend returns it.
const LIST: TreeCategory[] = [
  cat('phones', 'موبايلات جديدة'),
  cat('acc', 'إكسسوارات'),
  cat('cases', 'جرابات', 'acc'),
  cat('chargers', 'شواحن', 'acc'),
  cat('old', 'قديم', 'acc', true),
  cat('smart', 'ساعات ذكية', null, true),
  cat('watch-straps', 'أساتك', 'smart'),
];

// Products by category: two cases, a charger, an accessory straight in «إكسسوارات»,
// one in a hidden sub-category, a phone, and one unclassified.
const PRODUCTS = ['cases', 'cases', 'chargers', 'acc', 'old', 'phones', null];

test('a main category counts its own products and its sub-categories\'', () => {
  const tree = buildTree(LIST);
  const chips = mainChips(tree, PRODUCTS);
  assert.deepEqual(
    chips.map((c) => [c.id, c.count]),
    [
      ['phones', 1],
      ['acc', 5],
    ],
    'the hidden «ساعات ذكية» gets no chip; «إكسسوارات» counts its hidden sub too'
  );
});

test('the second row shows the shown sub-categories of the chosen main, or of the chosen sub\'s main', () => {
  const tree = buildTree(LIST);
  assert.deepEqual(subChips(tree, 'acc', PRODUCTS).map((c) => [c.id, c.count]), [
    ['cases', 2],
    ['chargers', 1],
  ]);
  assert.deepEqual(
    subChips(tree, 'cases', PRODUCTS).map((c) => c.id),
    ['cases', 'chargers'],
    'with a sub-category chosen, its siblings stay in view'
  );
  assert.deepEqual(subChips(tree, 'phones', PRODUCTS), [], 'no sub-categories, no second row');
  assert.deepEqual(subChips(tree, 'all', PRODUCTS), []);
  assert.deepEqual(subChips(tree, 'watch-straps', PRODUCTS), [], 'under a hidden main, nothing shows');
});

test('a product is under its category and under that category\'s main', () => {
  const tree = buildTree(LIST);
  assert.equal(inChip(tree, 'cases', 'cases'), true);
  assert.equal(inChip(tree, 'cases', 'acc'), true);
  assert.equal(inChip(tree, 'cases', 'chargers'), false);
  assert.equal(inChip(tree, 'acc', 'cases'), false, 'a product in the main is not in its sub-categories');
  assert.equal(inChip(tree, null, 'acc'), false);
  assert.equal(mainOf(tree, 'chargers'), 'acc');
  assert.equal(mainOf(tree, 'phones'), 'phones');
  assert.equal(mainOf(tree, 'gone'), null);
});

test('hiding a main hides its sub-categories\' chips too', () => {
  const tree = buildTree(LIST);
  assert.equal(chipVisible(tree, 'cases'), true);
  assert.equal(chipVisible(tree, 'old'), false);
  assert.equal(chipVisible(tree, 'smart'), false);
  assert.equal(chipVisible(tree, 'watch-straps'), false, 'its own flag is off, its parent\'s is on');
});

test('clicking the chosen sub-category again goes back to its main', () => {
  const tree = buildTree(LIST);
  assert.equal(toggle(tree, 'top', 'acc'), 'acc');
  assert.equal(toggle(tree, 'acc', 'cases'), 'cases');
  assert.equal(toggle(tree, 'cases', 'cases'), 'acc');
  assert.equal(toggle(tree, 'acc', 'acc'), 'acc', 'the chosen main stays chosen');
});

test('a choice that lost its chip after a reload falls back to «الأكثر مبيعًا»', () => {
  const tree = buildTree(LIST);
  assert.equal(keepSelection(tree, 'cases'), 'cases');
  assert.equal(keepSelection(tree, 'old'), 'top');
  assert.equal(keepSelection(tree, 'gone'), 'top');
  assert.equal(keepSelection(tree, 'all'), 'all');
});

test('search finds a product by its category\'s name and its parent\'s', () => {
  const tree = buildTree(LIST);
  assert.equal(searchWords(tree, 'cases'), 'إكسسوارات جرابات');
  assert.equal(searchWords(tree, 'phones'), 'موبايلات جديدة');
  assert.equal(searchWords(tree, 'old'), 'إكسسوارات قديم', 'hidden still searchable');
  assert.equal(searchWords(tree, null), '');
});

// The companies under a phone category (ADR-018 §2).
const PHONE_LIST: TreeCategory[] = [
  cat('phones', 'موبايلات جديدة', null, false, 'phone'),
  cat('acc', 'إكسسوارات'),
  cat('cases', 'جرابات', 'acc'),
];
const BRANDS = [
  { id: 'apple', name: 'Apple', sortOrder: 20 },
  { id: 'samsung', name: 'Samsung', sortOrder: 10 },
  { id: 'nokia', name: 'Nokia', sortOrder: 110 },
];
const PHONES = [
  { categoryId: 'phones', brandId: 'apple' },
  { categoryId: 'phones', brandId: 'samsung' },
  { categoryId: 'phones', brandId: 'samsung' },
  { categoryId: 'cases', brandId: null },
  { categoryId: null, brandId: 'nokia' },
];

test('under a phone category the second row is its companies, in the owner\'s order', () => {
  const tree = buildTree(PHONE_LIST);
  assert.deepEqual(
    brandChips(tree, 'phones', PHONES, BRANDS).map((c) => [c.id, c.name, c.count]),
    [
      ['phones~samsung', 'Samsung', 2],
      ['phones~apple', 'Apple', 1],
    ],
    'only companies with phones under it; Nokia\'s one is unclassified'
  );
  assert.deepEqual(brandChips(tree, 'phones~apple', PHONES, BRANDS).length, 2, 'a chosen company keeps the row');
  assert.deepEqual(brandChips(tree, 'acc', PHONES, BRANDS), [], 'counted goods show their sub-categories, not companies');
  assert.deepEqual(brandChips(tree, 'all', PHONES, BRANDS), []);
});

test('a company chip filters the main category to that company, and clicking it again goes back', () => {
  const tree = buildTree(PHONE_LIST);
  assert.deepEqual(brandPick('phones~apple'), ['phones', 'apple']);
  assert.equal(brandPick('phones'), null);
  assert.equal(inSelection(tree, { categoryId: 'phones', brandId: 'apple' }, 'phones~apple'), true);
  assert.equal(inSelection(tree, { categoryId: 'phones', brandId: 'samsung' }, 'phones~apple'), false);
  assert.equal(inSelection(tree, { categoryId: 'cases', brandId: null }, 'acc'), true);
  assert.equal(mainOf(tree, 'phones~apple'), 'phones');
  assert.equal(toggle(tree, 'phones~apple', 'phones~apple'), 'phones');
  assert.equal(keepSelection(tree, 'phones~apple'), 'phones~apple');
  assert.equal(keepSelection(tree, 'gone~apple'), 'top');
});
