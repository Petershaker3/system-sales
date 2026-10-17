import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cashSuggestions,
  DEFAULT_PAY_METHODS,
  enabledPayMethods,
  isPayMethodEnabled,
  methodLabel,
  normalizePayMethods,
  paidSoFar,
  paymentsSummaryText,
  remainingDue,
} from './payments.ts';

describe('payment methods settings & POS split payment helpers (ADR-020)', () => {
  it('normalizes enabled payment methods and keeps cash always enabled', () => {
    assert.equal(normalizePayMethods(undefined), DEFAULT_PAY_METHODS);
    assert.equal(normalizePayMethods('credit, cash, vf'), 'cash,vf,credit');
    // Missing cash falls back to default.
    assert.equal(normalizePayMethods('vf,instapay'), DEFAULT_PAY_METHODS);
    // Unknown method falls back to default.
    assert.equal(normalizePayMethods('cash,bitcoin'), DEFAULT_PAY_METHODS);

    assert.equal(isPayMethodEnabled('cash', 'cash,vf'), true);
    assert.equal(isPayMethodEnabled('vf', 'cash,vf'), true);
    assert.equal(isPayMethodEnabled('card', 'cash,vf'), false);
    assert.deepEqual(
      enabledPayMethods('cash,vf,credit').map((m) => m.id),
      ['cash', 'vf', 'credit']
    );
  });

  it('computes split payment totals, remaining due, and summary labels', () => {
    const parts = [
      { method: 'cash' as const, amountMinor: 500_00 },
      { method: 'vf' as const, amountMinor: 350_00, reference: 'VF-1' },
    ];
    assert.equal(paidSoFar(parts), 850_00);
    assert.equal(remainingDue(1000_00, parts), 150_00);
    assert.equal(remainingDue(800_00, parts), 0);

    assert.equal(methodLabel('install', 'valU'), 'تقسيط (valU)');
    assert.equal(
      paymentsSummaryText([{ method: 'cash', amountMinor: 500_00 }]),
      'كاش'
    );
    const summary = paymentsSummaryText(parts);
    assert.ok(summary.includes('كاش') && summary.includes('فودافون كاش'));
  });

  it('builds ascending cash denomination suggestions starting with exact due', () => {
    const sugs = cashSuggestions(320_00);
    assert.equal(sugs[0], 320_00);
    assert.ok(sugs.includes(350_00));
    assert.ok(sugs.includes(400_00));
    assert.ok(sugs.length <= 5);
  });
});
