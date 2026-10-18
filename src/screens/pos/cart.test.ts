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
  computeDiscountMinor,
  current,
  discountExceedsSellerLimit,
  discountSummary,
  drop,
  hold,
  moveSelection,
  newCart,
  openNewInvoice,
  removeLine,
  reprice,
  setInvoiceDiscount,
  setLineDiscount,
  setLineImei,
  setLineWarranty,
  setQuantity,
  switchTo,
  takenImeis,
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

test('a fresh catalogue reprices open lines and drops what can no longer be sold', () => {
  const cart = newCart();
  addProduct(cart, charger);
  addProduct(cart, cable);
  hold(cart);
  addProduct(cart, cable);
  const dropped = reprice(cart, [{ ...cable, priceMinor: 6000 }]);
  assert.deepEqual(dropped, ['شاحن']);
  assert.equal(cart.invoices[0]?.lines.length, 1);
  assert.equal(cart.invoices[0]?.lines[0]?.unitPriceMinor, 6000);
  assert.equal(current(cart).lines[0]?.unitPriceMinor, 6000);
});

test('serial phones add one line per unit and prevent duplicate IMEIs across open invoices', () => {
  const phone: SellableProduct = {
    id: 'ph1',
    name: 'Samsung Galaxy A16 128GB',
    priceMinor: 925000,
    onHand: 3,
    serial: true,
  };
  const cart = newCart();
  assert.deepEqual(addProduct(cart, phone, 1, null), { ok: true });
  assert.deepEqual(addProduct(cart, phone, 1, '356938035643809'), { ok: true });
  assert.equal(current(cart).lines.length, 2, 'each serial phone is its own line');
  assert.equal(current(cart).lines[0]?.imei, null);
  assert.equal(current(cart).lines[1]?.imei, '356938035643809');

  // Cannot attach the same IMEI to the first line.
  assert.equal(setLineImei(cart, 0, '356938035643809'), false);
  // Can attach a different IMEI to the first line.
  assert.equal(setLineImei(cart, 0, '490154203237518'), true);
  assert.deepEqual([...takenImeis(cart)].sort(), ['356938035643809', '490154203237518']);
});

test('line and invoice discounts reduce net totals and clamp when quantities shrink', () => {
  const cart = newCart();
  addProduct(cart, charger, 2); // 2 * 15000 = 30000
  addProduct(cart, cable, 1); // 1 * 5050 = 5050 => gross = 35050

  assert.equal(setLineDiscount(cart, 0, 2000), true);
  assert.equal(setInvoiceDiscount(cart, 1050), true);
  assert.deepEqual(discountSummary(current(cart)), {
    grossSubtotalMinor: 35050,
    linesDiscountMinor: 2000,
    linesNetSubtotalMinor: 33050,
    invoiceDiscountMinor: 1050,
    totalDiscountMinor: 3050,
    netTotalMinor: 32000,
  });
  assert.deepEqual(totals(current(cart)), { totalMinor: 32000, count: 3 });

  // Out-of-range discounts are rejected.
  assert.equal(setLineDiscount(cart, 0, 30001), false);
  assert.equal(setInvoiceDiscount(cart, 33051), false);

  // Removing lines clamps invoice discount so netTotalMinor never goes negative.
  removeLine(cart, 0);
  removeLine(cart, 0);
  assert.equal(discountSummary(current(cart)).netTotalMinor, 0);
  assert.equal(discountSummary(current(cart)).invoiceDiscountMinor, 0);
});

test('computeDiscountMinor and discountExceedsSellerLimit match exact percentage boundaries', () => {
  assert.equal(computeDiscountMinor(20000, 'percent', 5), 1000);
  assert.equal(computeDiscountMinor(20000, 'percent', 101), null);
  assert.equal(computeDiscountMinor(20000, 'amount', 1500), 1500);
  assert.equal(computeDiscountMinor(20000, 'amount', 20001), null);

  assert.equal(discountExceedsSellerLimit(20000, 1000, 5), false);
  assert.equal(discountExceedsSellerLimit(20000, 1001, 5), true);
  assert.equal(discountExceedsSellerLimit(20000, 1, 0), true);

  const cart = newCart();
  assert.equal(openNewInvoice(cart), false, 'empty invoice stays focused');
  addProduct(cart, cable);
  assert.equal(openNewInvoice(cart), true, 'non-empty invoice is held and a new one opens');
  assert.equal(cart.invoices.length, 2);
});

test('cart lines inherit defaultWarrantyMonths and setLineWarranty updates 0..60 months', () => {
  const cart = newCart();
  const usedPhone = {
    id: 'u1',
    name: 'iPhone 13 مستعمل',
    priceMinor: 2_500_000,
    onHand: 1,
    serial: true,
    defaultWarrantyMonths: 3,
  };
  addProduct(cart, usedPhone, 1);
  addProduct(cart, charger, 1);
  assert.equal(current(cart).lines[0]?.warrantyMonths, 3);
  assert.equal(current(cart).lines[1]?.warrantyMonths, 0);

  assert.equal(setLineWarranty(cart, 1, 6), true);
  assert.equal(current(cart).lines[1]?.warrantyMonths, 6);
  assert.equal(setLineWarranty(cart, 1, 61), false);
  assert.equal(setLineWarranty(cart, 1, -1), false);
});



