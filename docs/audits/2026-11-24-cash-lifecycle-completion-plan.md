# Cash lifecycle completion: implementation and review plan

Status: **in progress, not a reconciled ledger**. This plan is not evidence of completion. Operational shift close must remain available independently of financial reconciliation.

## Review against the current code

- `0048`–`0051` provide explicit drawer identities, immutable source postings and paired transfers, but deliberately have no complete backfill, opening anchor or certified balance. A NULL drawer means unknown, not the default drawer.
- `compute_shift_totals` still combines timestamp-derived estimates with captured events. Sales and customer cash currently use time windows rather than source posting identity; old windows can overlap at millisecond boundaries. Existing estimates and report guards must not be renamed or displayed as reconciled.
- Wallet voids and provable repair cash reversals now have event-shift attribution. Mixed/legacy repair refunds, electronic repair event history and other historical gaps remain unresolved. The current mutable repair status cannot establish historical receipt or payout method.
- The shift observation table records physical counts separately from closing; it is shift-specific rather than a complete multi-drawer reconciliation. A count is not a money movement, and a transfer's two postings must not become shop income or expense.
- Closing currently stores an estimate because the old schema requires it. Existing DTOs intentionally conceal this as a reconciled result. Preserve old rows and keep the operational workflow working.

## Sequence and acceptance conditions

1. Attribute captured cash sale/customer receipts and reversals to the recorded shift, retaining an explicitly uncertain legacy fallback. Review boundary timestamps, unassigned postings, outside expenses and rollback behavior. This is an estimate improvement only.
2. Audit every financial writer, including less visible cancellation/void/return, mixed repair payments, migrations and correction flows. Capture immutable source, physical payout method, drawer, actor, event time and independent operation/idempotency identity in the same transaction. Where original or payout evidence is absent, create a visible unresolved gap rather than invent it. Preserve original electronic wallet attribution and authorized refund rules.
3. Introduce per-drawer physical observations and traceable count-to-count reconciliation with immutable anchors, exact integer arithmetic, explicit coverage intervals and gap records. A verified expected balance requires a known opening observation and proof all intervening sources are accounted for; otherwise return unknown, never zero. Capture observations, movements and discrepancy resolutions atomically and make corrections append-only, actor-authorized and evidence-backed. Handle repeated submissions and concurrent count/transfer/close safely.
4. Extend UI and API for manager-visible multi-drawer history, counts, discrepancy and correction; preserve the single-open-shift operational workflow. Keep counts distinct from cash postings and keep unmatched handovers visible rather than blocking close.
5. Replace provisional financial reports with event-period aggregation over immutable originals and compensations, using consistent boundaries, explicit unknown/failed states and no joins that multiply money. Historical source gaps and review-derived restatements must remain visible; do not remove existing guards before equivalence and completeness are established.
6. Verify fresh and populated upgrades, no source-row mutation, failure rollback, authorization, concurrency, idempotency, overflow, cross-shift events, multi-drawer transfers, encrypted backup/restore and physical counts. Run Rust/SQLx integration plus frontend tests and the safe non-release workflow at the exact final SHA. Finally exercise the real SQLite → Rust → Tauri commands → Vue path, including a populated upgraded database and end-to-end close/handover/report; mocked demo is not proof. Document any environment or device limitations without claiming Windows/Android coverage.

No promotion, release, branch deletion, history rewrite or change to the pre-existing archive deletion is authorized.

## Implementation notes: 0052

The manager can record an append-only, idempotent physical observation for any configured drawer, including zero and times outside an open shift. A contemporaneous open shift is context, not an assertion that the drawer belongs to that shift. The observation is audited, does not create a posting and does not establish an expected balance, discrepancy or reconciliation. New records do not assign old shift counts to drawers. The API exposes the latest 100 observations and the UI labels them as unverified; source coverage and count-to-count reconciliation are still required.
