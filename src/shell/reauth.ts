// The re-authentication gate, in one place.
//
// `Permission::ManageSettings` is blanket re-authenticated
// (`domain/identity/role.rs::requires_reauthenticated`), so the backup commands
// refuse a normal session with `REAUTHENTICATION_REQUIRED` before they do
// anything at all. Screens that touch that permission therefore have to *ask* for
// the password instead of printing the refusal: an operator who reads «يلزم إعادة
// إدخال كلمة المرور» with no field to type it into is stuck, and the message
// reads as a dead end rather than an instruction.
//
// `SettingsPanel`, `StockPanel` and `UserManagement` each carry a hand-rolled copy
// of this gate. New screens use this module so the behaviour cannot drift: prove
// the password once, run the action that was waiting, put the failure inside the
// dialog when it is about the password, and let the screen report its own
// failures when it is not.

import { ref, type Ref } from 'vue';

import { describeError } from '../api/errors';
import * as lifecycle from '../api/lifecycle';
import { skipsPasswordReauth } from './open-mode';

export interface ReauthGate {
  /** The dialog is open and something is waiting behind it. */
  readonly open: Ref<boolean>;
  /** What is being confirmed, so the dialog can name it. */
  readonly reason: Ref<string>;
  readonly password: Ref<string>;
  /** A refusal from `reauthenticate` itself (wrong password, no permission). */
  readonly error: Ref<string>;
  readonly busy: Ref<boolean>;
  /**
   * Ask for the password, then run `action`.
   *
   * While the shop has no account (`ADR-039`) there is no password to prove and
   * Rust already reports the assurance this gate exists to reach, so the action
   * runs straight away — the same rule the three existing panels follow.
   */
  run(action: () => Promise<void>, reason: string): Promise<void>;
  /** Submit the dialog. */
  confirm(): Promise<void>;
  /** Close the dialog and drop whatever was waiting. */
  cancel(): void;
  /** Did this refusal mean «your password is stale», rather than a real failure? */
  refusedForPassword(value: unknown): boolean;
}

export function useReauth(): ReauthGate {
  const open = ref(false);
  const reason = ref('');
  const password = ref('');
  const error = ref('');
  const busy = ref(false);
  const pending = ref<(() => Promise<void>) | null>(null);

  async function run(action: () => Promise<void>, why: string): Promise<void> {
    if (skipsPasswordReauth()) {
      await action();
      return;
    }
    pending.value = action;
    reason.value = why;
    password.value = '';
    error.value = '';
    open.value = true;
  }

  async function confirm(): Promise<void> {
    const action = pending.value;
    if (action === null) return;

    busy.value = true;
    error.value = '';
    try {
      await lifecycle.reauthenticate(password.value);
    } catch (err) {
      // Stay open: the operator is one typo away, not one restart away.
      error.value = describeError(err);
      busy.value = false;
      return;
    }
    busy.value = false;

    // Close first: whatever the action reports belongs on the screen behind it.
    open.value = false;
    password.value = '';
    pending.value = null;
    await action();
  }

  function cancel(): void {
    open.value = false;
    password.value = '';
    error.value = '';
    pending.value = null;
  }

  function refusedForPassword(value: unknown): boolean {
    const code =
      typeof value === 'object' && value !== null && 'code' in value
        ? (value as { code?: unknown }).code
        : undefined;
    return code === 'REAUTHENTICATION_REQUIRED';
  }

  return { open, reason, password, error, busy, run, confirm, cancel, refusedForPassword };
}
