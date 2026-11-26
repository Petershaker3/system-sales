# ADR-060: Repair cost recognition and cancellation disposition

Status: implemented locally on the candidate branch; not committed.

## Decision

Repair and software ticket cost entered before delivery remains an operational
estimate. It is visible on an open ticket but is excluded from actual parts cost
and net profit. The final cost is recognized in the delivery period. Open-ticket
estimates do not enter actual net profit.

A cancelled ticket records one explicit disposition:

- `no_parts`: no part cost is recognized;
- `used`: the operator records the actual cost when the part cannot be returned;
- `unknown`: no cost is guessed and the affected financial result is incomplete.

Historical cancellations migrate to `unknown`. Their event time is recovered
from the existing cancellation audit event when that event identifies the
ticket. An old cancellation with no recoverable timestamp keeps its period
unknown and conservatively makes financial summaries incomplete until the
history can be reviewed.

## Audit and reporting

Cost entries retain actor, time, basis, previous amount, and new amount in an
append-only history table. Creation, estimate edits, delivery, and cancellation
write their cost history in the same transaction as the ticket change. The
cancellation audit event also stores its disposition. Existing ticket costs
and past rows are not rewritten to manufacture a resolved historical value.

Only explicit final costs contribute to financial cost totals. A missing or
unknown cancellation disposition returns unavailable cost and profit values,
which the report UI presents as unresolved instead of zero. Cash refund handling
remains governed by its separate evidence and approval rules.

## Consequences

The financial distribution can differ from the previous implementation for
open tickets with entered estimates and for cancellations whose used-part cost
is now explicit. A period containing an unresolved cancellation cannot claim a
complete repair profit. This decision does not establish that cash counts or
estimates are reconciled balances.
