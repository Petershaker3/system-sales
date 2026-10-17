// The owner-approval retry rule (ADR-017 §3): ask once, retry once.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { needsOwnerApproval, runWithOwnerApproval } from './approval-flow.ts';

const REQUIRED = { code: 'OWNER_APPROVAL_REQUIRED' };

/** An `ask` that records the labels it was shown and answers `answer`. */
function recorder(answer: boolean): { ask: (label: string) => Promise<boolean>; labels: string[] } {
  const labels: string[] = [];
  return {
    labels,
    ask: async (label: string) => {
      labels.push(label);
      return answer;
    },
  };
}

test('a command that needs no approval runs once and never asks', async () => {
  const { ask, labels } = recorder(true);
  let runs = 0;
  const outcome = await runWithOwnerApproval(
    async () => {
      runs += 1;
      return 7;
    },
    'رصيد بداية',
    ask
  );
  assert.deepEqual(outcome, { status: 'done', value: 7 });
  assert.equal(runs, 1);
  assert.deepEqual(labels, []);
});

test('OWNER_APPROVAL_REQUIRED asks once with the label, then retries once', async () => {
  const { ask, labels } = recorder(true);
  let runs = 0;
  const outcome = await runWithOwnerApproval(
    async () => {
      runs += 1;
      if (runs === 1) throw REQUIRED;
      return 'ok';
    },
    'إلغاء الفاتورة INV-20261017-0001',
    ask
  );
  assert.deepEqual(outcome, { status: 'done', value: 'ok' });
  assert.equal(runs, 2);
  assert.deepEqual(labels, ['إلغاء الفاتورة INV-20261017-0001']);
});

test('backing out of the prompt cancels without running the command again', async () => {
  const { ask } = recorder(false);
  let runs = 0;
  const outcome = await runWithOwnerApproval(
    async () => {
      runs += 1;
      throw REQUIRED;
    },
    'رصيد بداية',
    ask
  );
  assert.deepEqual(outcome, { status: 'cancelled' });
  assert.equal(runs, 1);
});

test('any other error goes to the screen unchanged, without a prompt', async () => {
  const { ask, labels } = recorder(true);
  const refusal = { code: 'SALE_NOT_FOUND' };
  await assert.rejects(
    runWithOwnerApproval(
      async () => {
        throw refusal;
      },
      'إلغاء',
      ask
    ),
    (thrown: unknown) => thrown === refusal
  );
  assert.deepEqual(labels, []);
});

test('a second OWNER_APPROVAL_REQUIRED after approving reaches the screen; no loop', async () => {
  const { ask, labels } = recorder(true);
  let runs = 0;
  await assert.rejects(
    runWithOwnerApproval(
      async () => {
        runs += 1;
        throw REQUIRED;
      },
      'إلغاء',
      ask
    ),
    (thrown: unknown) => thrown === REQUIRED
  );
  assert.equal(runs, 2);
  assert.equal(labels.length, 1);
});

test('needsOwnerApproval recognises only the approval code', () => {
  assert.equal(needsOwnerApproval(REQUIRED), true);
  assert.equal(needsOwnerApproval({ code: 'REAUTHENTICATION_REQUIRED' }), false);
  assert.equal(needsOwnerApproval(new Error('network')), false);
  assert.equal(needsOwnerApproval(null), false);
});
