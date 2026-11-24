import assert from 'node:assert/strict';
import test from 'node:test';
import { reportAvailability, type ReportAvailabilityInput } from './report-availability.ts';
const ok: ReportAvailabilityInput = { base: 'ready', auxiliary: 'ready', historyLength: 0, historyLimit: 5000, salesCostsAvailable: true, repairHardwareProfit: 0, repairSoftwareProfit: 0 };
test('real zero values remain valid', () => assert.equal(reportAvailability(ok), 'ready'));
test('failed, missing and redacted data cannot be trusted as zero', () => {
  for (const changes of [{ base: 'failed' as const }, { auxiliary: 'failed' as const }, { salesCostsAvailable: false }, { repairHardwareProfit: null }, { repairSoftwareProfit: undefined }]) {
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
