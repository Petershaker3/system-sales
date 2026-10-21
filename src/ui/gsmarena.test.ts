// The GSMArena search term is a rule over the stored product name: the model
// stays, the shop's own words (storage, grade) go.
import assert from 'node:assert/strict';
import test from 'node:test';

import { gsmArenaSearchTerm, gsmArenaUrl } from './gsmarena.ts';

test('a new phone is searched by its model, without the storage size', () => {
  assert.equal(gsmArenaSearchTerm('Samsung Galaxy A54 128GB'), 'Samsung Galaxy A54');
  assert.equal(gsmArenaSearchTerm('iPhone 13 256GB'), 'iPhone 13');
  assert.equal(gsmArenaSearchTerm('Xiaomi Redmi Note 12 8GB RAM 256GB'), 'Xiaomi Redmi Note 12');
});

test('a used phone is searched by its model, without the shop’s grade words', () => {
  assert.equal(
    gsmArenaSearchTerm('Samsung Galaxy A54 128GB مستعمل فئة A'),
    'Samsung Galaxy A54',
  );
  assert.equal(gsmArenaSearchTerm('iPhone 12 مستعمل فئة B'), 'iPhone 12');
});

test('network generations and model numbers survive — only sizes are dropped', () => {
  assert.equal(gsmArenaSearchTerm('Samsung Galaxy A54 5G'), 'Samsung Galaxy A54 5G');
  assert.equal(gsmArenaSearchTerm('Nokia 105'), 'Nokia 105');
});

test('the URL is GSMArena’s own quick search, percent-encoded', () => {
  assert.equal(
    gsmArenaUrl('Samsung Galaxy A54 128GB'),
    'https://www.gsmarena.com/results.php3?sQuickSearch=yes&sName=Samsung%20Galaxy%20A54',
  );
});

test('a name that leaves nothing to search has no URL — the mark stays hidden', () => {
  assert.equal(gsmArenaSearchTerm('256GB'), '');
  assert.equal(gsmArenaUrl('256GB'), '');
  assert.equal(gsmArenaUrl('   '), '');
});
