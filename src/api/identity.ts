// The identity boundary as the frontend sees it.
//
// This module is deliberately the *only* place that talks to Rust about
// identity, and it holds no credential of any kind. There is no token here, and
// there is nothing to persist: Rust keeps the session token in the operating
// system's credential store and resolves it internally on every call
// (ADR-009).
//
// Consequences worth stating plainly:
//   * There is no `localStorage` access anywhere in `src/`.
//   * `whoami()` after a restart restores the session, because the token never
//     needed to leave Rust.
//   * Signing out is a Rust-side operation, not a client-side cleanup.

import { invoke } from '@tauri-apps/api/core';

export type Role = 'manager' | 'sales';

export type Assurance = 'normal' | 'reauthenticated';

/** Who is operating the shop right now. */
export interface Session {
  readonly userId: string;
  readonly displayName: string;
  readonly role: Role;
  readonly assurance: Assurance;
}

/** A row in the login picker. Carries no secret material. */
export interface UserSummary {
  readonly id: string;
  readonly displayName: string;
  /**
   * The login identifier.
   *
   * Shown because `displayName` is not unique: two operators may share a name, and
   * the picker would otherwise offer two identical rows.
   */
  readonly username: string;
  readonly role: Role;
  /** Present but unusable. Shown so it is visible rather than mysteriously absent. */
  readonly disabled: boolean;
  /**
   * Whether the account has a daily PIN (ADR-017 §2): the lock screen offers the
   * PIN pad when it does, the password when it does not. The fact only.
   */
  readonly hasPin: boolean;
}

export interface BootstrapStatus {
  /**
   * The database has no accounts at all. Nothing is shown for it any more (`ADR-039`):
   * the card in الإعدادات claims the open row, and the claim creates the owner account
   * itself when the device is empty — so a `true` here means `ensure_open_account` could
   * not make the row, which is a broken file, and worth telling apart from `openMode`.
   *
   * A first launch is *not* in this state any more: it opens on the shop's own
   * operator (`ADR-039`), and the account is made afterwards from الإعدادات.
   */
  readonly needsSetup: boolean;
  /**
   * The shop is running without an account (`ADR-039`).
   *
   * Decided by Rust, not inferred here: a missing session is also a lock, a
   * sign-out or an expired day, and every one of those must still show the lock
   * card. Only the backend knows which of them this is.
   */
  readonly openMode: boolean;
  /** What the open operator is called, so the banner and the card say the same name the chip says. */
  readonly openDisplayName: string | null;
}

export function bootstrapStatus(): Promise<BootstrapStatus> {
  return invoke<BootstrapStatus>('bootstrap_status');
}

/**
 * Claim the shop's open operator as a real account (`ADR-039`).
 *
 * The replacement for the old first-run form, now that the account is made from
 * الإعدادات ← المستخدمين والصلاحيات while the shop is already selling. It answers
 * with the session the new password just opened, so the till does not stop at a
 * lock card for having finished the setup.
 */
export function claimOpenAccount(displayName: string, password: string): Promise<Session> {
  return invoke<Session>('claim_open_account', { displayName, password });
}

export function listUsers(): Promise<UserSummary[]> {
  return invoke<UserSummary[]>('list_users_for_picker');
}

export function login(userId: string, password: string): Promise<Session> {
  return invoke<Session>('login', { userId, password });
}

/** Sign in with the daily PIN (ADR-017 §2). Switching user is this, with the next person's PIN. */
export function loginWithPin(userId: string, pin: string): Promise<Session> {
  return invoke<Session>('login_with_pin', { userId, pin });
}

/**
 * Approve one sensitive operation on the current session with a manager's PIN
 * (ADR-017 §3). Asked after a command answered `OWNER_APPROVAL_REQUIRED`; the
 * screen then retries that command once. Nothing comes back: the approval stays
 * in Rust, on the session, where only the operation can spend it.
 */
export function approveWithOwnerPin(approverId: string, pin: string): Promise<void> {
  return invoke<void>('approve_with_owner_pin', { approverId, pin });
}

/**
 * Replace a forgotten password with the recovery code (ADR-017 §4), from the
 * lock card, without a session. A wrong code counts against the lockout. On
 * success every session has ended and the new code comes back once, to be
 * written down; the owner then signs in with the new password or a PIN.
 */
export function recoverPasswordWithCode(
  userId: string,
  code: string,
  newPassword: string
): Promise<{ readonly code: string }> {
  return invoke<{ readonly code: string }>('recover_password_with_code', { userId, code, newPassword });
}

export function logout(): Promise<void> {
  return invoke<void>('logout');
}

/** The current operator, or `null` when nobody is signed in. */
export function whoami(): Promise<Session | null> {
  return invoke<Session | null>('whoami');
}

/**
 * Re-prove the password to raise the session to `reauthenticated`.
 *
 * The catalog slice will require this before it releases wholesale figures
 * (`plan:151`). Nothing in the identity slice displays such figures, so this
 * exists to be ready rather than to be used.
 */
export function reauthenticate(password: string): Promise<Assurance> {
  return invoke<Assurance>('reauthenticate', { password });
}