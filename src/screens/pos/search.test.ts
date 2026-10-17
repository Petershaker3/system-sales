// Unit tests for finding a product on the sales screen. Run: npm run test:unit
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildIndex, looksLikeCode, search } from './search.ts';

const items = [
  { id: 'a', name: 'شاحن آيفون 20 وات', barcode: '6901234567890', departmentName: 'إكسسوارات', soldRecently: 5 },
  { id: 'b', name: 'جراب آيفون 13', barcode: null, departmentName: 'إكسسوارات', soldRecently: 40 },
  { id: 'c', name: 'سماعة سامسونج', barcode: '1234567', departmentName: 'سماعات', soldRecently: 1 },
  { id: 'd', name: 'كابل تايب سي', barcode: null, departmentName: 'إكسسوارات', soldRecently: 12 },
];
const index = buildIndex(items);

test('letters typed interchangeably still match', () => {
  assert.deepEqual(search(index, 'شاحن ايفون').map((x) => x.id), ['a']);
});

test('every word must match, in any order', () => {
  assert.deepEqual(search(index, 'ايفون جراب').map((x) => x.id), ['b']);
});

test('ties on the whole query go to the best seller; a name starting with the first word goes first', () => {
  assert.deepEqual(search(index, 'ايفون').map((x) => x.id), ['b', 'a']);
  assert.deepEqual(search(index, 'شاحن').map((x) => x.id)[0], 'a');
});

test('the department name is searchable', () => {
  assert.deepEqual(
    search(index, 'اكسسوارات').map((x) => x.id),
    ['b', 'd', 'a'],
    'all accessories, best sellers first'
  );
});

test('an exact barcode wins outright, Arabic digits included', () => {
  assert.deepEqual(search(index, '6901234567890').map((x) => x.id), ['a']);
  assert.deepEqual(search(index, '١٢٣٤٥٦٧').map((x) => x.id), ['c']);
});

test('an empty query finds nothing', () => {
  assert.deepEqual(search(index, '   '), []);
});

test('a long run of digits looks like a scan', () => {
  assert.equal(looksLikeCode('6901234567890'), true);
  assert.equal(looksLikeCode('١٢٣٤٥٦٧'), true);
  assert.equal(looksLikeCode('20 وات'), false);
});

test('tile icons are guessed from the name, top-up cards before chargers', async () => {
  const { iconFor } = await import('./icons.ts');
  assert.equal(iconFor('شاحن سامسونج 25 وات'), 'battery-charging', 'the brand does not make it a phone');
  assert.equal(iconFor('سامسونج A15'), 'smartphone');
  assert.equal(iconFor('كارت شحن فودافون 50'), 'credit-card');
  assert.equal(iconFor('كارت ميموري 64 جيجا'), 'memory-stick');
  assert.equal(iconFor('جراب سيليكون'), 'package');
  assert.equal(iconFor('حاجة تانية'), 'tag');
  assert.equal(iconFor('جراب سيليكون آيفون 13', 'حماية وجرابات'), 'package', 'the name wins over the department');
  assert.equal(iconFor('ستاند', 'سماعات'), 'headphones', 'the department decides when the name says nothing');
});
