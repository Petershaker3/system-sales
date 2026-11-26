import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCancellationPartsCostInput } from './cancellation-cost.ts';

test('cancellation parts cost requires a typed amount when parts were used', () => {
  assert.deepEqual(parseCancellationPartsCostInput(''), { ok: false });
  assert.deepEqual(parseCancellationPartsCostInput('   '), { ok: false });
});

test('an explicitly entered zero is a valid cancellation parts cost', () => {
  assert.deepEqual(parseCancellationPartsCostInput('0'), { ok: true, amountMinor: 0 });
});

test('cancellation parts cost converts pounds to piastres', () => {
  assert.deepEqual(parseCancellationPartsCostInput('12.34'), { ok: true, amountMinor: 1234 });
});

test('cancellation parts cost refuses invalid and unsafe amounts', () => {
  assert.deepEqual(parseCancellationPartsCostInput('-1'), { ok: false });
  assert.deepEqual(parseCancellationPartsCostInput('nope'), { ok: false });
  assert.deepEqual(parseCancellationPartsCostInput('90071992547410'), { ok: false });
});
