/**
 * Pattern approval API (SP-1b).
 *
 * A thin typed wrapper over `invoke`, mirroring `catalog.ts`. `verifyPattern`
 * is permissionless by design: any signed-in operator may prove the Pattern to
 * lift the step-up gate on a sensitive operation. Setting, resetting and
 * disabling are `ManageSettings` work and sit behind re-authentication.
 *
 * The entered Pattern travels once, is checked, and is dropped — nothing in
 * this file or its callers stores it beyond the input binding.
 */

import { invoke } from '@tauri-apps/api/core';

import type { CommandError } from './errors';

/**
 * What the panel needs to render: whether protection is on, and whether a
 * Pattern exists to check against.
 */
export interface PatternStatus {
  readonly enabled: boolean;
  readonly configured: boolean;
}

/** Status needs no permission: it answers "is there anything to prove". */
export async function getPatternStatus(): Promise<PatternStatus> {
  return invoke<PatternStatus>('get_pattern_status');
}

/**
 * Check the entered Pattern and stamp this session's five-minute approval.
 * Wrong → `INVALID_CREDENTIALS`; none set → `PATTERN_NOT_CONFIGURED`.
 */
export async function verifyPattern(pattern: string): Promise<void> {
  return invoke<void>('verify_pattern', { pattern });
}

/**
 * Set (or replace) the Pattern and switch protection on. Must satisfy the
 * password policy; requires a freshly re-authenticated session.
 */
export async function setPattern(pattern: string): Promise<void> {
  return invoke<void>('set_pattern', { pattern });
}

/**
 * Clear the Pattern after re-proving the Manager password — the recovery path
 * for a forgotten Pattern. Nothing else recovers it.
 */
export async function resetPattern(password: string): Promise<void> {
  return invoke<void>('reset_pattern', { password });
}

/** Switch protection off, keeping the stored Pattern for a later re-enable. */
export async function disablePattern(): Promise<void> {
  return invoke<void>('disable_pattern');
}

export type { CommandError };
