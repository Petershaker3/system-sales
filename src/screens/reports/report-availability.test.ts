import assert from 'node:assert/strict';
import test from 'node:test';
import { affectedHistoryInWindow, reportAvailability, reportWindowHasReversals, type ReportAvailabilityInput } from './report-availability.ts';
const ok: ReportAvailabilityInput = { base: 'ready', auxiliary: 'ready', historyLength: 0, historyLimit: 5000, salesCostsAvailable: true, hasReturnsOrCancellations: false, repairHardwareProfit: 0, repairSoftwareProfit: 0 };
test('real zero values remain valid', () => assert.equal(reportAvailability(ok), 'ready'));
test('failed, missing and redacted data cannot be trusted as zero', () => {
  for (const changes of [{ base: 'failed' as const }, { auxiliary: 'failed' as const }, { salesCostsAvailable: false }, { hasReturnsOrCancellations: true }, { repairHardwareProfit: null }, { repairSoftwareProfit: undefined }]) {
    assert.equal(reportAvailability({ ...ok, ...changes }), 'incomplete');
  }
});
test('an at-limit history may be truncated and is not a complete report', () => {
  assert.equal(reportAvailability({ ...ok, historyLength: 4999 }), 'ready');
  assert.equal(reportAvailability({ ...ok, historyLength: 5000 }), 'incomplete');
});
test('in-flight requests do not show stale results', () => {
  assert.equal(reportAvailability({ ...ok, base: 'loading' }), 'loading');
  assert.equal(reportAvailability({ ...ok, auxiliary: 'loading' }), 'loading');
});

test('a rejected source retains its identity and original error', async () => {
  const { reportSource, sourceErrorParts } = await import('./report-availability.ts');
  const reason = { code: 'LOCAL_STORAGE_UNAVAILABLE' };
  await assert.rejects(reportSource('المحافظ', Promise.reject(reason)), err => {
    assert.deepEqual(sourceErrorParts(err), { source: 'المحافظ', cause: reason });
    return true;
  });
});

test('returns and cancellations cannot be represented by the current sale-only report', () => {
  assert.equal(reportAvailability({ ...ok, hasReturnsOrCancellations: true }), 'incomplete');
});

test('unrelated history does not block, but a changed sale in the report window does', () => {
  const window = { from: 100, to: 200 };
  const sale = { occurredAt: 201, isCancelled: true, alreadyRefundedMinor: 10, returnCount: 1 };
  assert.equal(affectedHistoryInWindow([sale], window), false);
  // A later cancellation can change the representation of an earlier sale.
  assert.equal(affectedHistoryInWindow([{ ...sale, occurredAt: 100 }], window), true);
  assert.equal(affectedHistoryInWindow([{ ...sale, occurredAt: 200 }], window), false);
  assert.equal(affectedHistoryInWindow([{ ...sale, returnCount: null }], window), true);
});

test('return and cancellation events use actual half-open event times', async () => {
  const events = [{ at: 99, kind: 'return' }, { at: 200, kind: 'cancel' }];
  const load = async (from: number, to: number) => ({
    returnCount: events.filter(e => e.kind === 'return' && e.at >= from && e.at < to).length,
    cancellationCount: events.filter(e => e.kind === 'cancel' && e.at >= from && e.at < to).length,
  });
  assert.equal(await reportWindowHasReversals({ from: 100, to: 200 }, load), false);
  assert.equal(await reportWindowHasReversals({ from: 200, to: 300 }, load), true);
  assert.equal(await reportWindowHasReversals({ from: 0, to: 100 }, load), true);
});

test('missing event evidence stays unavailable, not zero', async () => {
  await assert.rejects(reportWindowHasReversals({ from: 1, to: 2 }, async () => { throw new Error('offline'); }));
  await assert.rejects(reportWindowHasReversals({ from: 1, to: 2 }, async () => ({ returnCount: NaN, cancellationCount: 0 })));
  assert.equal(reportAvailability({ ...ok, auxiliary: 'failed' }), 'incomplete');
  assert.equal(reportAvailability({ ...ok, historyLength: 5000 }), 'incomplete');
});
