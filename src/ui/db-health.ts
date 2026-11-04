/**
 * Is the shop's database reachable in this run?
 *
 * `LOCAL_STORAGE_UNAVAILABLE` is what every command answers once a restore has
 * closed the database pool for good (`api/errors.ts`) or when the file cannot be
 * opened. Its stock sentence says «أبلغ المسؤول الفني», which is true about the
 * storage and useless as an instruction: the one thing that works is closing the
 * app and opening it again.
 *
 * The flag is set the moment any command reports it, so the shell can say that
 * once, at the top, instead of leaving the operator to collect the same sentence
 * from every screen (owner report, 2026-11-02: a sale and the categories list both
 * failed with it and both looked like unrelated bugs).
 */

import { ref } from 'vue';

/** What the shell shows when it is set: one sentence and a restart button. */
export const databaseUnreachable = ref(false);

export function noteDatabaseFailure(code: string | null | undefined): void {
  if (code === 'LOCAL_STORAGE_UNAVAILABLE') databaseUnreachable.value = true;
}

/** Tests only. */
export function forgetDatabaseFailure(): void {
  databaseUnreachable.value = false;
}
