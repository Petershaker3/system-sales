import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSellableInPos, posOnHand } from './sellable.ts';

test('a phone is offered on the sales screen', () => {
  // The old filter was `disposition === 'quantity'` only, so all 102 migrated
  // phones were missing from the search box and the tiles.
  assert.equal(isSellableInPos({ disposition: 'serialized' }), true);
});

test('a counted product stays offered', () => {
  assert.equal(isSellableInPos({ disposition: 'quantity' }), true);
});

test('a one-off piece is not offered', () => {
  assert.equal(isSellableInPos({ disposition: 'one_off' }), false);
});

test('a phone counts its units, not its stock level', () => {
  const phone = { id: 'p1', onHand: 0 };
  assert.equal(posOnHand(phone, true, { p1: 3 }), 3);
  assert.equal(posOnHand(phone, true, {}), 0);
});

test('a counted product reads its stock level', () => {
  const item = { id: 'p2', onHand: 7 };
  assert.equal(posOnHand(item, false, { p2: 2 }), 7);
});
