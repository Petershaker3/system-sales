// The rule of the «اعمل حساب المالك» form (`ADR-039`), tested without a component:
// the card is a form, and the form's whole job is these three refusals. The minimum
// length is asserted against the same number Rust uses, because a UI that let a
// shorter password through would not be convenient — it would be a rejected submit.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  accountStateLine,
  managerAccountsWhileOpen,
  managersNotice,
  MIN_PASSWORD_LEN,
  ownerAccountProblem,
} from './account.ts';

const FORM = {
  displayName: 'بيتر',
  password: '12345678',
  confirm: '12345678',
};

test('a complete form is accepted', () => {
  assert.equal(ownerAccountProblem(FORM), null);
});

test('the minimum is the domain minimum, not a suggestion', () => {
  assert.equal(MIN_PASSWORD_LEN, 8);
  const oneShort = { ...FORM, password: 'a'.repeat(MIN_PASSWORD_LEN - 1), confirm: 'a'.repeat(MIN_PASSWORD_LEN - 1) };
  assert.equal(ownerAccountProblem(oneShort), `كلمة السر لازم تكون ${MIN_PASSWORD_LEN} أحرف على الأقل.`);
  const atLeast = { ...FORM, password: 'a'.repeat(MIN_PASSWORD_LEN), confirm: 'a'.repeat(MIN_PASSWORD_LEN) };
  assert.equal(ownerAccountProblem(atLeast), null);
});

test('the name is checked for what is typed, not for what is stored', () => {
  assert.match(ownerAccountProblem({ ...FORM, displayName: '' }) ?? '', /اكتب اسم صاحب المحل/);
  assert.match(ownerAccountProblem({ ...FORM, displayName: '   ' }) ?? '', /اكتب اسم صاحب المحل/);
});

test('the two password fields must say the same thing', () => {
  assert.equal(ownerAccountProblem({ ...FORM, confirm: '12345679' }), 'الكلمتان غير متطابقتين.');
});

test('the first rule broken is the one reported', () => {
  // A name missing AND a short password is one problem to fix, in reading order —
  // the same shape as the start-up form's validator, so the two never disagree.
  assert.match(
    ownerAccountProblem({ displayName: '', password: '1', confirm: '2' }) ?? '',
    /اكتب اسم صاحب المحل/,
  );
});

test('a submit while the previous one is in flight is refused with a waiting line', () => {
  assert.equal(ownerAccountProblem(FORM, true), 'استنى الآخر يخلص.');
  // …and only that line: an unfinished name still reports its own problem first.
  assert.match(ownerAccountProblem({ ...FORM, displayName: '' }, true) ?? '', /اكتب اسم صاحب المحل/);
});

test('the card describes an open shop as running, not as broken', () => {
  const line = accountStateLine(true, 'المالك');
  assert.match(line, /لسه ما عملتش حساب/);
  assert.match(line, /شغال باسم «المالك»/);
  assert.doesNotMatch(line, /خطأ|فشل/);
});

test('a row with no name of its own is still called something', () => {
  assert.match(accountStateLine(true, '  '), /«صاحب المحل»/);
});

test('a manager made while the till was open is named, a seller is not', () => {
  const names = managerAccountsWhileOpen([
    { displayName: 'المالك', role: 'manager', disabled: false },
    { displayName: 'سارة', role: 'sales', disabled: false },
    { displayName: 'يوسف', role: 'manager', disabled: true },
    { displayName: 'مراد', role: 'manager', disabled: false },
  ]);
  assert.deepEqual(names, ['المالك', 'مراد']);
});

test('an open shop with nobody else has nothing to warn about', () => {
  assert.equal(managersNotice([]), null);
  assert.equal(managersNotice(managerAccountsWhileOpen([{ displayName: 'سارة', role: 'sales', disabled: false }])), null);
});

test('the notice says the account survives the claim and where to turn it off', () => {
  const line = managersNotice(['مراد']) ?? '';
  assert.match(line, /اتعمل وقت ما المحل كان شغال من غير حساب/);
  assert.match(line, /هيفضل شغال بعد ما تعمل حسابك/);
  assert.match(line, /«مراد»/);
  assert.match(line, /عطّله/);
  assert.doesNotMatch(line, /خطأ|مرفوض|ما تقدرش/);
});

test('more than one account is counted, not summarised away', () => {
  const line = managersNotice(['مراد', 'حسن', 'سارة']) ?? '';
  assert.match(line, /3 حسابات مدير/);
  assert.match(line, /«مراد»، «حسن»، «سارة»/);
  assert.match(line, /راجعهم/);
});

test('after the claim the card stops offering the form it just used', () => {
  const line = accountStateLine(false, 'بيتر');
  assert.match(line, /الحساب موجود|في حساب/);
  assert.doesNotMatch(line, /اعمل حساب المالك/);
});
