// Whether the shop is running without an account (`ADR-039`).
//
// The frontend never *decides* this: Rust does, from the open owner row, and
// reports it in `bootstrap_status` (`api/identity.ts`). This module only carries
// that answer so any screen can read it without threading a prop through the
// shell — the same way `ui/appearance.ts` carries the look.
//
// What it changes is presentation only, and in one direction: while the shop is
// open there is nothing to lock, no PIN to set, and no password to re-prove, so
// the screens that would ask for one must not ask. The authority itself is decided
// in Rust (`services/identity/open_mode.rs`); hiding a button here is not what
// keeps an open till open.

import { ref } from 'vue';

import type { BootstrapStatus } from '../api/identity.ts';

export interface OpenModeState {
  /** The shop is running on the open owner row: nobody has made an account. */
  readonly active: boolean;
  /** What the open row is called, so the banner names the operator the chip does. */
  readonly displayName: string;
}

const OPEN: OpenModeState = { active: false, displayName: '' };

/** The one copy of this state; set from `App.vue` once per start-up. */
export const openMode = ref<OpenModeState>(OPEN);

/** Record what the backend said. Called at start-up, and again after a claim. */
export function readOpenMode(status: BootstrapStatus): void {
  openMode.value = {
    active: status.openMode,
    displayName: status.openDisplayName ?? '',
  };
}

/** The shop has an account now: the lock, the PIN and the password are back. */
export function clearOpenMode(): void {
  openMode.value = OPEN;
}

/**
 * What to call the open operator when a screen has to name it.
 *
 * The row carries a display name from the moment it is made, so the fallback is for
 * the moment before the database answers at all — a start-up that failed and a
 * unit test, where an empty name must not print as ««»».
 */
export function openOperatorName(displayName: string): string {
  const name = displayName.trim();
  return name === '' ? 'صاحب المحل' : name;
}

/**
 * The line the shell shows over the screens while the shop is open.
 *
 * Worded as an offer and not a warning: running this way is the intended first
 * state, and the owner is the one who decides when to make the account.
 */
export function openModeHint(state: OpenModeState = openMode.value): string {
  // Nothing to say once the account exists: a screen that renders the line
  // unconditionally then shows an empty space rather than a stale promise.
  if (!state.active) return '';
  const who = openOperatorName(state.displayName);
  return `السيستم شغال من غير حساب باسم «${who}». اعمل حساب المالك من الإعدادات لما تحب، وهيفضل شغال من غير قفل ولا PIN.`;
}

/**
 * Whether a screen may skip its "prove the password again" step.
 *
 * The three legacy panels ask for the password before user administration and
 * before wholesale figures, because `Permission::ManageUsers` and
 * `Permission::ViewCostAndProfit` require a freshly proven one. An open shop has
 * no password to prove yet — and Rust already holds its session at the top
 * assurance level — so the prompt would ask for something that does not exist and
 * then refuse the action for guessing. The rule is Rust's; this only stops the UI
 * from demanding a secret the shop has not got.
 */
export function skipsPasswordReauth(state: OpenModeState = openMode.value): boolean {
  return state.active;
}
