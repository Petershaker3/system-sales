// One-time supervised manager-password recovery (plan R1, Design B).
//
// # This is not a security boundary
//
// The control is the Rust `recovery` cargo feature: `stage_recovery_approval`
// and `execute_manager_recovery` do not exist in a production build, so a
// production bundle carrying this module could only ever fail the invoke.
// `VITE_RECOVERY` decides whether the panel *ships*, nothing more. It must
// never be described as protection.
//
// # Nothing is persisted
//
// There is no `localStorage` access anywhere in `src/` and this module adds
// none. The Pattern and the temporary password are typed by the owner, passed
// straight to Rust, and dropped: both are verified and never stored or logged
// on either side (`services/identity/password.rs`).

import { invoke } from '@tauri-apps/api/core';

/**
 * Whether this bundle was built with the recovery panel included.
 *
 * Read from the build-time environment, so it is a constant after the build.
 * Unset - the default, and therefore the safe state - means no panel.
 */
export const RECOVERY_ENABLED = import.meta.env.VITE_RECOVERY === '1';

/** The approval the owner confirmed, plus the Pattern that authorises it. */
export interface StagedApproval {
  readonly reference: string;
  readonly deviceId: string;
  readonly targetUserId: string;
  readonly reason: string;
  readonly approvedBy: string;
  readonly pattern: string;
}

/**
 * Record the owner's approval for one later execution.
 *
 * Rust refuses without the current device Pattern, refuses a second execution
 * of the same reference, and throttles repeated attempts. Nothing here retries.
 */
export function stageRecoveryApproval(input: StagedApproval): Promise<void> {
  return invoke<void>('stage_recovery_approval', { ...input });
}

/**
 * Consume the staged approval and set a temporary password on its target.
 *
 * Returns the recovered account's id. The backend then forces a password change
 * at first sign-in, so this password is a bridge and not the owner's final one.
 */
export function executeManagerRecovery(
  reference: string,
  deviceId: string,
  newPassword: string,
): Promise<string> {
  return invoke<string>('execute_manager_recovery', { reference, deviceId, newPassword });
}