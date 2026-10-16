/**
 * User lifecycle API: password management and user administration.
 *
 * A thin typed wrapper over `invoke`, mirroring `identity.ts`. No token is ever
 * read or sent: the backend resolves the operator from the OS credential store on
 * every call, so a tampered frontend still cannot act as someone else.
 *
 * Every failure arrives as a `CommandError` carrying a stable code. Rendering
 * happens in `errors.ts`.
 */

import { invoke } from '@tauri-apps/api/core';

import type { CommandError } from './errors';

export type Role = 'manager' | 'sales';

/** One account as the management screen sees it. */
export interface ManagedUser {
  readonly userId: string;
  readonly displayName: string;
  /**
   * The login identifier. Present because `displayName` is not unique: two
   * operators may share a name, and the username is what tells them apart.
   */
  readonly username: string;
  readonly role: Role;
  readonly disabled: boolean;
  /** A manager reset this account's password; it must be changed at next sign-in. */
  readonly mustChangePassword: boolean;
  /**
   * This account has lost its credentials row.
   *
   * The backend guarantees one per account, so this means a broken invariant: a
   * manual edit, a partial restore, or corruption. The row is shown rather than
   * hidden, because an account silently missing from the list leaves an operator
   * with no way to know it existed or why it vanished. Login and session resolution
   * refuse such an account outright, so this flag is informational for the operator
   * and a technician, not an operable state.
   */
  readonly integrityFault: boolean;
}

/**
 * Change the signed-in operator's own password.
 *
 * Permitted even while a forced change is pending: it is the one operation such a
 * session may perform. `currentPassword` is required — without it, anyone holding
 * an unlocked device could lock the real owner out permanently.
 */
export async function changeOwnPassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await invoke('change_own_password', { currentPassword, newPassword });
}

/**
 * A manager sets another account's password and forces a change at next sign-in.
 *
 * This is the capability that makes a forgotten password recoverable. It revokes
 * the target's sessions only.
 */
export async function resetUserPassword(
  userId: string,
  temporaryPassword: string,
): Promise<void> {
  await invoke('reset_user_password', { userId, temporaryPassword });
}

/**
 * Re-prove the password to raise the session to `reauthenticated`.
 *
 * Required before any user administration, because creating an account, resetting
 * a password, changing a role and disabling an operator all alter who can do what.
 */
export async function reauthenticate(password: string): Promise<void> {
  await invoke('reauthenticate', { password });
}

export async function listUsersForManagement(): Promise<ManagedUser[]> {
  return invoke<ManagedUser[]>('list_users_for_management');
}

export async function createUser(input: {
  readonly displayName: string;
  readonly username: string;
  readonly role: Role;
  readonly password: string;
}): Promise<string> {
  return invoke<string>('create_user', {
    displayName: input.displayName,
    username: input.username,
    role: input.role,
    password: input.password,
  });
}

export async function changeUserRole(userId: string, role: Role): Promise<void> {
  await invoke('change_user_role', { userId, role });
}

export async function disableUser(userId: string): Promise<void> {
  await invoke('disable_user', { userId });
}

export async function enableUser(userId: string): Promise<void> {
  await invoke('enable_user', { userId });
}

/**
 * Change a login identifier. Manager-only and re-authenticated.
 *
 * A sales user has no way to rename themselves; only a manager can rename anyone.
 */
export async function setUsername(userId: string, username: string): Promise<void> {
  await invoke('set_username', { userId, username });
}

/**
 * Whether the signed-in account must change its password before continuing.
 *
 * Read from the resolved session rather than accepted from the caller, so it
 * reflects what the backend will actually enforce.
 */
export async function passwordChangeRequired(): Promise<boolean> {
  return invoke<boolean>('password_change_required');
}

export type { CommandError };