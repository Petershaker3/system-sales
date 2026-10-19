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
    return `لسه ما عملتش حساب على الجهاز. السيستم شغال باسم «${openOperatorName(displayName)}» من غير قفل ولا PIN.`;
  }
  return 'الحساب موجود على الجهاز، وهو اللي السيستم شغال بيه. كل الحسابات والصلاحيات في القايمة هنا تحت.';
}

/**
 * The accounts that can run the shop, found while the till is still open
 * (`ADR-039`).
 *
 * An open shop is not read-only: whoever stands at the counter *is* the manager, and
 * `users::create_user` asks nothing else of a manager session — so a manager account
 * with a password of the till's choosing can exist before the owner signs their own
 * name to the shop. The claim does not undo that account and does not try to; what it
 * can do is make the owner see it before the signature, and point at the list where
 * it can be disabled.
 *
 * A disabled row is not counted — nobody signs in with it, so it is not a second hand
 * on the till. A row owing a password change is, because whoever made it is the one
 * who wrote that temporary password.
 */
export function managerAccountsWhileOpen(
  users: readonly {
    readonly role: string;
    readonly disabled: boolean;
    readonly displayName: string;
  }[],
): readonly string[] {
  return users
    .filter((user) => user.role === 'manager' && !user.disabled)
    .map((user) => user.displayName);
}

/**
 * What the card says about them, or `null` when there is nothing to say.
 *
 * Not a confirmation step and not a refusal: the shop's own account is never held
 * hostage to a row somebody else made. It names the accounts, says plainly that they
 * survive the claim, and leaves the decision where it belongs.
 */
export function managersNotice(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const list = names.map((name) => `«${name}»`).join('، ');
  if (names.length === 1) {
    return `في حساب مدير اتعمل وقت ما المحل كان شغال من غير حساب: ${list}. الحساب ده هيفضل شغال بعد ما تعمل حسابك — راجعه من القايمة تحت، ولو مش تعرفه عطّله.`;
  }
  return `في ${names.length} حسابات مدير اتعملوا وقت ما المحل كان شغال من غير حساب: ${list}. هيفضلوا شغالين بعد ما تعمل حسابك — راجعهم من القايمة تحت، وعطّل اللي مش تعرفه.`;
}

