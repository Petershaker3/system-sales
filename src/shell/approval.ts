// The one owner-approval prompt of the app (ADR-017 §3).
//
// A screen wraps a sensitive command:
//
//   const outcome = await withOwnerApproval(() => sales.cancelSale(id, why), 'إلغاء الفاتورة …');
//   if (outcome.status === 'cancelled') return;
//
// and App.vue shows <ApprovalPrompt> while a request is pending. One request at
// a time: a new one settles the previous as backed out, and so does locking,
// switching or signing out (`dismissApproval`), because the session the
// approval was for is gone.

import { shallowRef } from 'vue';

import { runWithOwnerApproval } from './approval-flow';
import type { ApprovalOutcome } from './approval-flow';

export interface ApprovalRequest {
  /** What is being approved, shown under the title. */
  readonly label: string;
  /** Answer the request: `true` once Rust accepted a PIN, `false` when backed out. */
  readonly settle: (approved: boolean) => void;
}

/** The request the prompt is showing, or `null`. */
export const pendingApproval = shallowRef<ApprovalRequest | null>(null);

/** Show the prompt; resolves once it is answered. */
export function requestOwnerApproval(label: string): Promise<boolean> {
  pendingApproval.value?.settle(false);
  return new Promise<boolean>((resolve) => {
    const request: ApprovalRequest = {
      label,
      settle: (approved) => {
        if (pendingApproval.value === request) pendingApproval.value = null;
        resolve(approved);
      },
    };
    pendingApproval.value = request;
  });
}

/** Back out of any pending request (the screen was locked, switched or left). */
export function dismissApproval(): void {
  pendingApproval.value?.settle(false);
}

/** Run a sensitive command, asking for the owner's PIN once if Rust wants it. */
export function withOwnerApproval<T>(
  action: () => Promise<T>,
  label: string
): Promise<ApprovalOutcome<T>> {
  return runWithOwnerApproval(action, label, requestOwnerApproval);
}
