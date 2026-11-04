import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setBusinessDayStartHour } from '../sales/analytics.ts';
import {
  computeAutoWalletFeeMinor,
  computeWalletAlertState,
  drawerCashDeltaForCustomerOp,
  resolveServiceFeeMinor,
  resolveWalletMonthBounds,
  walletBalanceAfterCustomerOp,
  walletStateBadge,
} from './wallets.ts';

test('resolveServiceFeeMinor requires explicit typed fee in manual mode and accepts 0', () => {
  assert.equal(resolveServiceFeeMinor('', 'manual', 1_000), null);
  assert.equal(resolveServiceFeeMinor('   ', 'manual', 1_000), null);
  assert.equal(resolveServiceFeeMinor('0', 'manual', 1_000), 0);
  assert.equal(resolveServiceFeeMinor('15', 'manual', 1_000), 1_500);

  // In auto mode, empty input falls back to the computed default, while a typed value overrides it.
  assert.equal(resolveServiceFeeMinor('', 'auto', 1_000), 1_000);
  assert.equal(resolveServiceFeeMinor('0', 'auto', 1_000), 0);
  assert.equal(resolveServiceFeeMinor('20', 'auto', 1_000), 2_000);
});

test('computeAutoWalletFeeMinor applies percentage with minimum floor', () => {
  // 1,000 EGP at 1% = 10 EGP (1,000 minor) >= 5 EGP min (500 minor)
  assert.equal(computeAutoWalletFeeMinor(100_000, 1, 500), 1_000);
  // 200 EGP at 1% = 2 EGP (200 minor) < 5 EGP min -> 500 minor
  assert.equal(computeAutoWalletFeeMinor(20_000, 1, 500), 500);
  assert.equal(computeAutoWalletFeeMinor(0, 1, 500), 0);
});

test('deposit vs withdrawal direction for wallet balance and drawer cash', () => {
  // Deposit 1,000 EGP with 10 EGP fee from a 14,500 EGP wallet:
  // Wallet balance decreases by 1,000 EGP -> 13,500 EGP; drawer cash increases by 1,010 EGP.
  assert.equal(walletBalanceAfterCustomerOp(1_450_000, 'deposit', 100_000), 1_350_000);
  assert.equal(drawerCashDeltaForCustomerOp('deposit', 100_000, 1_000), 101_000);

  // Withdraw 500 EGP with 5 EGP fee into a 14,500 EGP wallet:
  // Wallet balance increases by 500 EGP -> 15,000 EGP; drawer cash decreases by 495 EGP.
  assert.equal(walletBalanceAfterCustomerOp(1_450_000, 'withdraw', 50_000), 1_500_000);
  assert.equal(drawerCashDeltaForCustomerOp('withdraw', 50_000, 500), -49_500);
});

test('computeWalletAlertState classifies ok, low, near, over, and neg', () => {
  assert.equal(computeWalletAlertState(1_000_000, 300_000, 9_000_000), 'ok');
  assert.equal(computeWalletAlertState(200_000, 300_000, 9_000_000), 'low');
  assert.equal(computeWalletAlertState(8_200_000, 300_000, 9_000_000), 'near');
  assert.equal(computeWalletAlertState(9_500_000, 300_000, 9_000_000), 'over');
  assert.equal(computeWalletAlertState(-100, 300_000, 9_000_000), 'neg');
  assert.equal(walletStateBadge('low')?.label, 'قربت تخلص');
});

test('the monthly meter runs on the shop month, which opens at 05:00 on the 1st', () => {
  // The owner's «بداية اليوم» choice is applied on boot; a unit test sets it itself
  // (the module default stays midnight so a calculation that never read it does not
  // invent a shift).
  setBusinessDayStartHour(5);
  try {
    assertMonthOpensAtFive();
  } finally {
    setBusinessDayStartHour(0);
  }
});

function assertMonthOpensAtFive(): void {
  // 5 November, mid-afternoon: the month opened on 1 November at 05:00.
  const now = new Date(2026, 10, 5, 14, 30);
  const { fromMs, toMs } = resolveWalletMonthBounds(now);
  assert.equal(fromMs, new Date(2026, 10, 1, 5, 0, 0, 0).getTime());
  assert.equal(toMs, now.getTime());

  // 3 AM on 1 November is still the night of 31 October in this shop, so the running
  // month is October: a wallet that spent its allowance last night has not got a
  // fresh one at midnight.
  const lateNight = new Date(2026, 10, 1, 3, 0);
  assert.equal(
    resolveWalletMonthBounds(lateNight).fromMs,
    new Date(2026, 9, 1, 5, 0, 0, 0).getTime(),
  );
}
