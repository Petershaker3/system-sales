# ADR-059: Evidence review for a historical recorded wallet

Status: narrow review path implemented; differing or absent historical wallet and
unresolved-refund payment policy remain open.

Migration 0030 could have written a wallet ID by method. It is not evidence that
that wallet actually received a particular historical sale. Migration 0043
therefore recorded no provenance for pre-existing payments. Do not rewrite any
original sale or payment to create the appearance of certainty.

Migration 0044 adds append-only manager review events. An authorized manager
may confirm the wallet already recorded on a historical electronic payment only
after recording a reason and an independent evidence reference. The actor,
timestamp, and idempotency request identity are stored. This is a human
attestation, not automatic verification of the evidence. A request ID can be
replayed only with identical content and actor. A confirmation may be revoked by
an explicit, append-only review event while unused. Once refund allocations use
the confirmation, revocation is refused: changing attribution retroactively
would misrepresent money already paid. A future correction must be an explicit
compensating financial event, not deletion or modification of these records.

An active confirmation allows the existing original-payment-linked refund or
cancellation path to use the same recorded wallet. The database trigger and
service both enforce that evidence exists. The original payment is unchanged.
The review and its audit entry commit or roll back together. The owner-facing
invoice panel displays the recorded wallet as unproven until the owner enters
both reason and supporting evidence. The panel does not infer identity from a
payment method, and explicitly warns against confirming a conflicting number.

This is intentionally narrower than a complete provenance-resolution workflow:
if the recorded wallet is absent or differs from the evidence, the current
schema and refund triggers cannot safely substitute another wallet. The review
path refuses that case; it needs an explicit effective-source model, accounting
for previously recorded balances and existing allocations. A disputed or
unresolved historical refund also cannot be paid without an approved policy for
its actual payment source. Until that decision and financial ledger exist,
return and cancellation remain blocked for that source. A physical drawer ID
for cash payments is still absent. None of these review events create a ledger
posting, reconcile cash, prove profit or justify removing report guards.

## Extension: reviewed effective source (0045–0046)

An evidence-backed confirmation may now name a different existing wallet or
resolve a formerly absent wallet. An effective attribution view consults the
append-only review; the original payment and its recorded historical wallet
remain unchanged. Linked refunds use that effective wallet, including when
today's method setting has changed. Wallet estimates use the explicit reviewed
source for the original payment, rather than retaining a conflicting guessed
wallet. Review history is accessible to managers. An existing linked refund to
a different wallet prevents a new confirmation; once any allocation uses the
review, revocation is refused. Conflicts requiring correction of an already
posted refund still need a compensating financial ledger and remain blocked.

This resolves neither the physical payment source for an unresolved refund nor
cash drawer identity. Unreviewed cases remain blocked and the report guard
remains in place.

## Audit clarification: review transitions and event periods

The manager-only history API exposes the original recorded wallet separately
from the effective proven attribution immediately before and after each event.
These transitions are derived from the immutable payment and the ordered,
append-only review chain: a confirmation changes unresolved to its named wallet;
a revocation changes that wallet back to unresolved. The historical field is
not itself proof. Reviews are evidence-based attestations, not financial
postings, and after an allocation uses a confirmation it cannot be revoked.
Concurrent conflicting confirmations serialize at `BEGIN IMMEDIATE`, and a
repeated request succeeds only for the same actor and identical payload.

Wallet lifetime and period estimates apply the current effective attribution to
the original sale's event time, not the later review time. Thus a review can
change a historical wallet-period estimate. The original sale remains untouched;
a query is **not** an as-of-review-time audit report. Before confirmation the
estimate may still include the legacy recorded wallet, which is unverified and
must not be called a reconciled balance. Refund payments remain in the period
in which the reversal occurred. Linked old refund allocations to another wallet
prevent a confirmation. An old reversal with no allocation remains unresolved:
the system does not infer a link, and further returns on that sale remain
blocked even if an individual original wallet has since been reviewed.
