// Unit tests for the sales screen's invoices. Run: npm run test:unit
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addProduct,
  available,
  changeDue,
  changeQuantity,
  clear,
  closePaid,
  current,
  drop,
  hold,
  moveSelection,
  newCart,
  removeLine,
  setQuantity,
  switchTo,
  totals,
} from './cart.ts';
import type { SellableProduct } from './cart.ts';

const charger: SellableProduct = { id: 'p1', name: 'شاحن', priceMinor: 15000, onHand: 3 };
const cable: SellableProduct = { id: 'p2', name: 'كابل', priceMinor: 5050, onHand: 10 };
const noPrice: SellableProduct = { id: 'p3', name: 'بدون سعر', priceMinor: null, onHand: 5 };

test('adding the same product twice merges into one line', () => {
  const cart = newCart();
  assert.deepEqual(addProduct(cart, charger), { ok: true });
  assert.deepEqual(addProduct(cart, charger), { ok: true });
  assert.equal(current(cart).lines.length, 1);
  assert.equal(current(cart).lines[0]?.quantity, 2);
  assert.equal(cart.selected, 0);
});

test('totals are integer piastres and count units', () => {
  const cart = newCart();
  addProduct(cart, charger);
  addProduct(cart, cable, 2);
  assert.deepEqual(totals(current(cart)), { totalMinor: 15000 + 2 * 5050, count: 3 });
});

test('a product without a price cannot be added', () => {
  const cart = newCart();
  const result = addProduct(cart, noPrice);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'no-price');
  assert.equal(current(cart).lines.length, 0);
});

test('stock is checked across every open invoice, held ones included', () => {
  const cart = newCart();
  addProduct(cart, charger, 2);
  assert.equal(hold(cart), true);
  assert.equal(available(cart, charger), 1);
  assert.deepEqual(addProduct(cart, charger, 2), { ok: false, reason: 'limit', available: 1 });
  assert.deepEqual(addProduct(cart, charger), { ok: true });
  assert.deepEqual(addProduct(cart, charger), { ok: false, reason: 'out-of-stock', available: 0 });
});

test('+ and − change the selected line; below one removes it', () => {
  const cart = newCart();
  addProduct(cart, cable);
  assert.deepEqual(changeQuantity(cart, cable, 1), { ok: true });
  assert.equal(current(cart).lines[0]?.quantity, 2);
  changeQuantity(cart, cable, -1);
  changeQuantity(cart, cable, -1);
  assert.equal(current(cart).lines.length, 0);
});

test('setting a quantity respects what is free elsewhere', () => {
  const cart = newCart();
  addProduct(cart, charger);
  assert.deepEqual(setQuantity(cart, charger, 3), { ok: true });
  assert.deepEqual(setQuantity(cart, charger, 4), { ok: false, reason: 'limit', available: 3 });
});

test('hold opens a fresh invoice; switching back drops an empty one', () => {
  const cart = newCart();
  assert.equal(hold(cart), false, 'an empty invoice is not held');
  addProduct(cart, cable);
  hold(cart);
  assert.equal(cart.invoices.length, 2);
  assert.equal(cart.active, 1);
  switchTo(cart, 0);
  assert.equal(cart.invoices.length, 1, 'the empty invoice was dropped, not held');
  assert.equal(current(cart).held, false);
  assert.equal(current(cart).lines[0]?.productId, 'p2');
});

test('switching away from a non-empty invoice holds it', () => {
  const cart = newCart();
  addProduct(cart, cable);
  hold(cart);
  addProduct(cart, charger);
  switchTo(cart, 0);
  assert.equal(cart.invoices.length, 2);
  assert.equal(cart.invoices[1]?.held, true);
});

test('dropping a held invoice keeps the current one active', () => {
  const cart = newCart();
  addProduct(cart, cable);
  hold(cart);
  addProduct(cart, charger);
  drop(cart, 0);
  assert.equal(cart.invoices.length, 1);
  assert.equal(current(cart).lines[0]?.productId, 'p1');
});

test('closing a paid invoice opens a fresh one, never a held one', () => {
  const cart = newCart();
  addProduct(cart, cable);
  hold(cart);
  addProduct(cart, charger);
  closePaid(cart);
  assert.equal(current(cart).held, false);
  assert.equal(current(cart).lines.length, 0);
  assert.equal(cart.invoices.length, 2, 'the held invoice stays waiting');
});

test('removing and moving the selection stay in range', () => {
  const cart = newCart();
  addProduct(cart, cable);
  addProduct(cart, charger);
  moveSelection(cart, -5);
  assert.equal(cart.selected, 0);
  moveSelection(cart, 5);
  assert.equal(cart.selected, 1);
  removeLine(cart);
  assert.equal(cart.selected, 0);
  clear(cart);
  assert.equal(current(cart).lines.length, 0);
  assert.equal(cart.selected, -1);
});

test('change is due only when the cash covers the total', () => {
  assert.equal(changeDue(15000, 20000), 5000);
  assert.equal(changeDue(15000, 15000), 0);
  assert.equal(changeDue(15000, 10000), null);
});
