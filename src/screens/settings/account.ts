// The rule the «اعمل حساب المالك» form applies before it sends anything
// (`ADR-039`).
//
// Deliberately a sibling of the start-up form in `App.vue` and not a copy of it: the
// same shop is now reached from الإعدادات after it opened, with the till selling
// underneath. The length is not a preference either — it is `policy::MIN_PASSWORD_LEN`
// in Rust, and a shorter password is refused there — so a field-level check here
// exists only to stop a keystroke that is already known to be wasted. Nothing here
// authorises anything: the claim itself is `services/identity/open_mode.rs`.

import { openOperatorName } from '../../shell/open-mode.ts';

export interface OwnerAccountForm {
  readonly displayName: string;
  readonly password: string;
  readonly confirm: string;
}

/** `domain/identity/policy.rs::MIN_PASSWORD_LEN`. */
export const MIN_PASSWORD_LEN = 8;

/** The first rule the form breaks, in Arabic, or null when it breaks none. */
export function ownerAccountProblem(form: OwnerAccountForm, busy = false): string | null {
  if (form.displayName.trim() === '') {
    return 'اكتب اسم صاحب المحل. هو اللي هيظهر في الفواتير وفي سجل العمليات.';
  }
  if (form.password.length < MIN_PASSWORD_LEN) {
    return `كلمة السر لازم تكون ${MIN_PASSWORD_LEN} أحرف على الأقل.`;
  }
  if (form.password !== form.confirm) {
    return 'الكلمتان غير متطابقتين.';
  }
  return busy ? 'استنى الآخر يخلص.' : null;
}

/**
 * What the card says about the account: while it is missing, and after it exists.
 *
 * One place, so الإعدادات never promises a button the shop has already used, and so
 * the claim is described as what it is — the shop's own operator becoming a real
 * account, not the shop suddenly starting.
 */
export function accountStateLine(open: boolean, displayName: string): string {
  if (open) {
    return `لسه مفيش حساب على الجهاز ده. السيستم شغال باسم «${openOperatorName(displayName)}» من غير قفل ولا PIN.`;
  }
  return 'في حساب على الجهاز ده، وهو اللي السيستم شغال بيه. كل الحسابات والصلاحيات في القايمة هنا تحت.';
}

