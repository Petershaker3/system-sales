// The owner's PIN approval as a screen uses it (ADR-017 §3): run a sensitive
// command; if Rust answers OWNER_APPROVAL_REQUIRED, ask for the owner's PIN
// once, then run the command once more. Pure — no Vue, no invoke — so the rule
// is unit-tested; `approval.ts` connects it to the one prompt the app shows.
//
// The frontend decides nothing here. Rust says when an approval is needed,
// checks the PIN, and spends the approval inside the operation; this file only
// spares the operator from pressing the button twice.

import { asCommandError, ErrorCode } from '../api/errors.ts';

/** Ask for an approval: `true` once one was granted, `false` if the operator backed out. */
export type AskForApproval = (label: string) => Promise<boolean>;

/** What became of a sensitive command. */
export type ApprovalOutcome<T> =
  | { readonly status: 'done'; readonly value: T }
  | { readonly status: 'cancelled' };

/** Whether `error` is Rust asking for the owner's approval. */
export function needsOwnerApproval(error: unknown): boolean {
  return asCommandError(error)?.code === ErrorCode.OWNER_APPROVAL_REQUIRED;
}

/**
 * Run `action`; when it needs the owner's approval, ask once (`label` says what
 * is being approved) and retry once.
 *
 * Any other error is the screen's, unchanged. So is a second
 * OWNER_APPROVAL_REQUIRED after an approval — the two minutes ran out, or the
 * approval was withdrawn — because asking again in a loop would hide whatever
 * keeps withdrawing it.
 */
export async function runWithOwnerApproval<T>(
  action: () => Promise<T>,
  label: string,
  ask: AskForApproval
): Promise<ApprovalOutcome<T>> {
  try {
    return { status: 'done', value: await action() };
  } catch (err) {
    if (!needsOwnerApproval(err)) throw err;
  }
  if (!(await ask(label))) return { status: 'cancelled' };
  return { status: 'done', value: await action() };
}
