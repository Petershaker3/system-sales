# Feature reconciliation — working record

This is a **partial** semantic comparison, not a complete audit. Candidate `8946909f2cc55c8a2eb12836cdccd002a7ea624c`, divergent `3615091315aa7ca601ae8f0d78703e29b6410409`, base `a6d158041f696dfb34789e04beca21ff78293f33`. Candidate was merged into the authorized working branch; neither remote main nor the divergent branch was changed. The divergent branch remains the preservation reference for its three unique commits.

| Feature | Candidate | Divergent branch | Working disposition / evidence |
| --- | --- | --- | --- |
| Reminders and notes | No reminders module | `src/ui/reminders.ts`, modal and tests, device-local `mshop.reminders.v1`, due dates and recurring items | Adapted module and modal, integrated into existing shell; same storage key. Storage failure reported and updates not applied on write failure; capacity rejects rather than dropping old entries. Device-local, not a shop database or a payment. Node tests added/adapted. UI and restoration not yet device-tested. |
| Fixed expense templates | Saved category reasons in appearance settings, no amount/source template | Device-local `mshop.fixed-expenses.v1`, optional amount, note and source; can directly post | Added compatible local templates alongside—not instead of—saved reasons. Choosing fills the existing form and requires an explicit submit. No direct posting, to avoid surprising or duplicate financial movements. Drawer templates cannot silently become outside expenses when shift is closed. Storage errors reported; malformed records block writes. Existing direct-post shortcut remains unported. |
| Receiving new goods / phones | New product/phone directs operator to receiving; `0035_receiving_document.sql` and receiving service support document flow | New item and phone forms offer a direct single-item `receiveStock` following creation | Retain candidate flow pending end-to-end review. Sequential create + receive is not atomic across both actions; blind copying could bypass candidate's document workflow. No functionality discarded: divergent branch remains. Need inspect all form variants, failed receipt behavior and document transactions before choosing a unified UI. |
| Pairing QR | `src/screens/mobile/pair-qr.ts`, ZXing round-trip tests | Real QR through companion implementation | Retain candidate implementation; no proof of complete behavior equivalence on physical devices. |
| Camera | Native detector plus ZXing fallback, `src/ui/scan.ts` | Main rear camera selection, decoder changes | Candidate fallback retained. Lens selection, Android permission and decoding require semantic and hardware comparison; no claim of equivalence. |
| External links / WhatsApp | Narrow WhatsApp allowlist and desktop shell in `src-tauri/src/commands/shell.rs`, browser path `src/ui/external.ts`; Windows uses `cmd` | More general URL command with Windows `explorer`, JNI Android, and GSMArena | Retain narrow allowlist, do not add generic launcher blindly. Long Windows links and Android link launch remain unresolved; divergent fix requires security and device tests. |
| GSMArena | No `src/ui/gsmarena.ts` | Phone information link and tests | Unported; inspect exposure, network/offline behavior and allowlisting before integrating. |
| Shift and daily reports | Current report architecture and `src/ui/external.ts` | Async open and configured owner-number validation | Unresolved: check every sending path and placeholder handling; physical Windows verification required. |
| Catalog variants, quantity and price forms | Candidate has later receiving screens and variants | Divergent `NewItemModal.vue` embeds receiving, variant combinations, associated tests | Full field-by-field and transaction comparison pending; preserve candidate's document model and divergent branch. |
| Expenses categories and pins | Saved reasons `appearance.expenseReasons` | Pinned amount/source/note | Both retained in working tree; fixed templates do not replace stored reasons or historical rows. |
| JNI correction / camera guard | No divergent `commands/system.rs` | `fea30c4` fixes JNI ownership and architecture guard | Not portable in isolation; no new Rust/JNI command was added. |
| Database migrations | Candidate through `0037` | No migration changes from common base | No migration was edited. Candidate SQL 0001–0033 is byte-identical to base; candidate adds 0034–0037. Populated upgrade still untested locally. |

## Integrity and limitations

* The template/refill UI does not issue a financial transaction; `submitExpense` still invokes `recordShopExpense` and the server remains responsible for permissions, validation and audit. This does not prove broader financial correctness.
* Reminder and fixed-expense data is stored per device and is not covered by a demonstrated database backup/restore. Neither is synchronized to Android. A browser storage failure is displayed, not treated as a successful save.
* The divergent implementation has more behavior than these rows completely characterize. Review every changed file and test in the three commits, especially camera, QR, catalog forms, reports, shift, opening URLs, and smoke checks. Do not delete the branch.
* Candidate reports use auxiliary `.catch(() => null)` paths and can calculate from default zeros (`src/screens/reports/ReportsScreen.vue`). This high-priority financial issue is not fixed or reconciled here. Tests must cover failed sources, period switches, export/print and data availability, as well as actual business reconciliation.
* Repair overview loads all raw tickets (`src-tauri/src/data/repositories/repair.rs`); performance impact and ticket creation root cause remain unmeasured.
* The full system audit, migration runtime checks, financial reconciliation, backup restoration, Windows and Android device verification remain outstanding. Do not describe this branch as production-ready or ready to promote yet.

## Verification of implementation commit `3c67661754cb65ee122829c2352ab4dacc8cddd3`

* Passed locally: `npm run typecheck`; `npm run test:unit` (290 passed, 0 failed, 0 skipped); `npm run build`; `git diff --check HEAD^ HEAD`.
* Build warns of an ineffective dynamic import and a chunk over 500 kB (main JS 973.69 kB, gzip 280.86 kB). This is a size measurement, not a startup-performance measurement.
* Rust and migration execution blocked locally: neither `cargo` nor `rustc` is installed. Browser interaction, Windows/Android device checks, full financial tests and backup/restore were not run. No CI was triggered for this commit.
* The only code changes are frontend reminders and local templates; no migrations or backend financial rules were modified. Template selection deliberately requires confirmation via the normal expense form. No claim of completed reconciliation, full audit or readiness for promotion.

## Persistence and report follow-up

* **Verified:** the diff `3c67661754cb65ee122829c2352ab4dacc8cddd3..5ef3e5a8c1e521d72894463d4b37fc77cdb8078b` changes only this document, not application code.
* **Verified from source:** reminders and fixed templates use the current WebView's `localStorage` and have no companion synchronization. `src-tauri/src/services/backup/create.rs:198–201` packs a SQLite snapshot and images, not WebView storage; `docs/backup-format-v1.md` defines only database and image components. The reminder and template UIs now warn that the shop backup does not include them. Restoring a database alone does not establish a restore of either local list. Windows WebView storage persistence, Android WebView persistence, actual restore and Wi-Fi behavior are **not device-tested**. Neither list is a financial ledger or a competing shop database.
* **Implemented:** reminder reading rejects malformed rows, unknown repeat values, duplicate IDs and invalid calendar dates instead of silently normalizing and later overwriting them; the write lock keeps unreadable storage untouched. Capacity rejects additions without deleting existing notes. The expense template UI now supports explicit editing and deletion; exact duplicates are refused, but same names with different values are allowed. It still only fills the ordinary expense form, with no direct posting. Both lists remain device-local and are not backed up.
* **Implemented, limited safety guard:** reports no longer turn rejected source requests into empty data. While required data is loading, missing, redacted or failed, the active report is hidden and named source errors are shown; export and summary actions are guarded. A 5,000-row sales result is conservatively treated as potentially truncated because `list_sales_history` orders ascending and caps results. The guard also refuses missing cost/profit fields and repair net profit. Period-specific request counters reject stale responses. At the cap the report is unavailable even when exactly 5,000 records exist; scalable full-history reporting is still required. This guard **does not** prove accounting formulas or reconciliation correct and does not cover other screens.
* **Still unresolved:** fixed-template and reminder storage can be concurrently modified by another WebView/context; no atomic cross-context compare-and-swap is available in this implementation. Evaluate a durable single-owner data model and migration before asserting synchronization or backup protection. Full receiving, camera/attachment, QR, external links and all divergent commits need further comparison; no migration or backend posting code was changed in this follow-up.

### Follow-up verification

On exact implementation commit `0e4d48381e72e1b578d8f06fcc8407dd1b943cec`: `npm run typecheck` passed; `npm run test:unit` passed (297 tests, 0 failures, 0 skipped); `npm run build` passed with the existing ineffective dynamic-import and large-chunk warnings (main JS 978.00 kB, gzip 281.97 kB); `git diff --check HEAD^ HEAD` passed. The browser demo `scripts/reconciliation-check.mjs` passed its three checks (template create/edit/delete without posting, failed expense source, corrupt reminder storage). The broader browser demo `scripts/demo-smoke.mjs` passed 321/321 checks. Demo tests use an in-memory mock backend; they do not prove real SQLite transactions, backup restoration, platform behavior or physical-device compatibility. Rust/migration tests and Windows/Android builds were not run; no release/CI workflow was triggered. A later documentation-only commit records these results and does not change tested application code.

## Follow-up: sales returns and reporting scope

**Verified in source:** `analytics.ts` filters a cancelled sale out of every original-sale period and uses gross sale totals for partially returned sales; it does not consume `alreadyRefundedMinor` in its report calculations. `sale_returns` and `sale_reversals` hold separate event timestamps. Consequently, the existing frontend is not an event-period reconciliation and can present incorrect historical figures after returns or cancellation. A free/zero-value return cannot be detected from refund amount alone.

**Implemented safety measure:** the sale history DTO now includes an additive `returnCount` from `sale_returns` (including zero refunds). The demo backend exposes the same field. The existing Reports screen refuses to display or export reports when any returned/cancelled sale is in its bounded input, or return count is absent (older backend). This is deliberately conservative: one historical return can make all report periods unavailable. It prevents presenting this known-incomplete formula as trusted, but is not a reporting solution. No existing migration or financial transaction behavior was changed. The added Rust repository/service integration assertions require cargo and remain unrun locally.

**SQLite experiment, not production aggregation:** `scripts/sqlite-reconciliation-test.py` applies all 37 actual migration SQL files in Python SQLite to an empty in-memory fixture, checks integrity and foreign keys, makes a SQLite backup copy, and uses 5,002 synthetic sale documents plus multiple returns (including zero) and a cancellation. It checks separate event totals and the `idx_sales_occurred_at` plan, illustrating why joining return rows directly to sale totals multiplies revenue. It does not run the SQLx migration runner, encrypted application backup/restore, Rust services, financial reconciliation, or a device. It does not define an approved net-profit formula and is not wired to the application.

**Remaining:** production reporting must aggregate bounded period events in SQLite, including cancellations, returns (intact vs damaged), sale-level and line-level discounts/surcharges, wallet fees, expenses and source attribution without cross-join duplication. It must reconcile category/phone breakdowns and relevant business-day boundaries, use indexes and a consistent snapshot, enforce permissions, and have real integration, historical-migration, >5,000-event and financial reconciliation tests. Current report guards and the experiment do not meet that requirement. Full policy/semantics must be derived from established records rather than invented from this fixture.

**Verification on `625a3f2fa7af75c767ae7552e93e30df6d609a9a`:** frontend typecheck and production build passed (same large chunk / ineffective dynamic import warnings); 298 frontend unit tests passed, zero skipped. Focused browser demo regression passed all four scenarios, including a zero-value return. Python SQLite reconciliation experiment passed both tests, including 5,002 sales and all 37 migrations on an empty database. `git diff --check HEAD^ HEAD` passed. Rust code and integration assertions were **not compiled or executed**: no Rust toolchain is installed. Platform builds, encrypted backup/restore, populated database upgrades and financial reconciliation are **not tested**. No CI, release, or publication was triggered. This is not production-ready and the requested complete-history database report remains unimplemented.

### Event-period foundation (work in progress, not a replacement report)

An additive `0038` index and an internal sales-repository query now aggregate
original sales, return events and cancellation events independently by each
record's UTC timestamp, in half-open periods. They deliberately expose separate
amount/cost components instead of inventing a profit or payment-source policy.
The cancellation aggregation reports inconsistent linked snapshots rather than
silently treating those as verified. No existing report uses this query; the
return/cancellation and incomplete-history guards remain in force. Service/API
permission checks, period/timezone validation, payment-ledger reconciliation,
other report sources, full profit policy, migration upgrades, and UI integration
remain unfinished. The query does not yet validate every possible malformed
return/reversal linkage or independently reconcile wallet and drawer balances.

Python SQLite executes the exact repository SQL over synthetic periods with
5,002 original sales, partial, zero-value, full and damaged returns, an exchange,
a cancellation, split payment rows, and duplicate-link constraint attempts.
This checks component totals and indexed query plans, not production service
transactions, source balances or profits. The new Rust integration test is
unexecuted. Cargo/rustc/rustup were absent, and a direct attempt to reach the
pinned toolchain distribution at static.rust-lang.org failed with SSL connection
error in this network environment. No platform or backup-restore claims follow.

### Provisional event components integrated, not a reconciled report

The repository event query is exposed through a manager-only service, command,
typed API and separately labeled provisional UI panel. The request interval is
half-open and computed from the configured local business-day boundary; changing
periods discards stale responses. Missing, unsafe-integer and inconsistent
cancellation results are rejected. The panel does not supply any existing profit,
chart, export or WhatsApp figure and does not bypass the existing report guard.
It is explicitly marked unreviewed, not an approved financial statement. The
report still cannot be considered complete or reconciled.

**Source trace / unresolved financial risk:** `sale_payments` snapshots method
and `wallet_id` but does not contain a cash drawer id; shift totals derive cash
from signed sale/reversal rows by time, while wallet balances use signed rows by
the recorded wallet id. A cancellation copies original payment rows, including
wallet id; a return can accept explicit refund sources. For default partial
returns `refunded_by_method_for_sale` groups prior refunds by method, not wallet,
and `remaining_by_method` removes that method total once while iterating original
payment rows; multiple original wallets with the same method can therefore be
misallocated. The fallback allocation can put leftover on the first source.
This is a source-code finding, not a reproduced production transaction; do not
claim per-wallet or historical drawer reconciliation. A cash-drawer identity
cannot be inferred from the payment record or current settings without further
historical evidence. Do not silently rewrite old rows or invent one.

Intact return lines append positive `sale_reversal` inventory movements and
restore stock value at the original line cost; damaged returns go to
`damaged_stock` and retire units rather than restoring sellable stock. Full
cancellation reverses the original snapshots. These are traced code paths,
not an independently verified profit formula or proof of every inventory cost
method. Service-level test scenarios and accounting reconciliation are still
needed, including split same-method wallets, custom refund sources and original
cash-drawer provenance. Repair, expense, wallet-service and all legacy report
metrics remain unreconciled.

The additional populated-v37-to-v38 Python SQLite experiment applies the real
SQL files and checks preserved sales rows, integrity and foreign keys. It is not
SQLx, a real backup restore, or an upgrade test for every historical schema.
The Rust service authorization test and integration tests are present but not
run. No Rust toolchain was found locally; static.rust-lang.org is unreachable,
and the GitHub Rust 1.98.1 release query did not provide a toolchain. No CI or
release workflow was triggered. The remaining recovery, durable persistence,
platform and independent audit work is open.

**Verification at application/test commit `0b05a51a27d44dc62afa33b5744c87d9d03d0ce4`:**
TypeScript typecheck, 298 frontend unit tests, production frontend build, five
focused mocked-demo browser checks, three Python SQLite experiments, and
`git diff --check HEAD^ HEAD` passed. The browser test does not run Rust or a
real database. The build emitted the existing dynamic-import and large-chunk
warnings. Rust compilation, SQLx fresh/upgrade tests, real transaction-to-UI
end-to-end tests, payment/inventory reconciliation and platform tests were not
run and remain unverified. This verification note is documentation only.

### Refund allocation correction — implemented, Rust verification blocked

Migration `0039` adds an append-only allocation table linking a positive
reversal payment to an exact original payment and amount. SQLite checks the
linked sale/reversal documents, matching method and recorded wallet, and
remaining capacity on both sides. No existing payment, invoice or movement is
rewritten and there is no automatic historical backfill. Return/exchange
transactions under `BEGIN IMMEDIATE` now consume remaining original payment
rows in payment order, write a separate reversal payment and allocation for each
slice, and link cancellation payments one-for-one. Explicit requested sources
are accepted only when they match original source and available amount. A
missing wallet on a historical electronic payment, a prior positive reversal
without complete links, or insufficient matching original amounts refuses the
operation rather than choosing a current primary wallet. This intentionally
restricts previously accepted cross-source custom refunds and historical
returns until there is a reviewed reconciliation mechanism. Zero-value
reversals retain a zero payment row but have no positive allocation. Inspection
also refuses an unallocated historical reversal rather than presenting guessed
per-payment balances. The UI has a distinct source-unverifiable error.

**Source identity limits:** `sale_payments.wallet_id` was backfilled by migration
`0030` using the then-unique method mapping; subsequent rows explicitly name a
wallet when recorded. NULL for electronic payments is not safely recoverable
from today's primary wallet. Cash payments carry no drawer identity or shift id,
so the database cannot prove which of multiple drawers funded an old or new
cash payment; a timestamp-based shift aggregate is not a drawer identity. The
repository has a single-open-shift model, not a represented multi-drawer ledger.
Neither a new allocation link nor a matching cash method proves a drawer. No
actual shop database was available for a historical-record audit.

The additive table does not itself make historic records trustworthy; a
positive pre-0039 reversal remains unlinked, and returns/inspection for that
invoice are deliberately unavailable pending an evidence-based repair workflow.
Likewise, financial report guard remains in place. Inventory code still restores
intact returns to stock via movement rows at original line cost and records
damaged items separately; full profit, cost-method changes, wallet balances,
customer credit, cash drawer provenance and remaining report metrics are not
fully reconciled. SQL triggers and synthetic fixtures are not a substitute for
service transaction testing. Rust tests for repeated same-method wallets,
cancellation links, and unlinked history have been added but have not run.

**Toolchain status:** no local cargo/rustc/rustup; pinned distribution remains
unreachable from the sandbox's authorized network, and no independent
non-release runner has been made available. Do not ship or rely on these Rust
changes as verified before compiling, running SQLx fresh and populated upgrade
tests, and executing full transaction reconciliation with the pinned toolchain.

**Verification at application/test commit `7e09fe5f2a6491ead871ebbf9d1ee567b24e7311`:**
frontend typecheck, 298 frontend unit tests, frontend build, four synthetic
Python SQLite tests (including source-match/over-allocation trigger checks and a
populated migration from schema 0037) and `git diff --check HEAD^ HEAD` passed.
The build retained dynamic-import and chunk-size warnings. Rust compilation,
SQLx migrations and all new Rust transaction tests were **not run**. Python
executes database SQL only; it does not execute the Rust allocation algorithm.
This note is documentation-only.

### Drawer-source investigation and non-release Rust verification

The real shift implementation has **one open shift**, not a drawer catalogue,
default-drawer setting, drawer ids, or a multiple-drawer ledger. Opening cash is
stored on `shifts`; drawer expenses and manual cash movements carry `shift_id`.
Sale/refund cash payments carry neither drawer nor shift id. Cash customer-debt
payments are in `customer_ledger`, wallet/service operations in `wallet_ops`,
and repair deposits/deliveries in mutable `repairs`; these also lack drawer ids.
Shift closing computes an expected balance from a mixture of explicitly linked
shift rows and timestamp ranges, inclusive at both ends. Wallet operations
filter `voided_at IS NULL`, and repair totals use current status; those sources
require event-history review before claiming historical reconciliation. This is
source inspection, not a test on an actual shop database. No historical drawer
identity was fabricated. Existing shift balances remain timestamp-derived and
**must not be treated as reconciled**; disabling or replacing that closing path
requires an integrated change across all of these writers and its user-facing
workflow, not just a new sale column. Multi-drawer source capture, transfers,
opening/closing, unresolved-source reporting, and end-to-end balances remain
unimplemented. The provisional report guard remains enabled.

Full cancellation's `restore_line` sums original sale movement quantity/cost,
links its stock reversal movements, collapses legacy FIFO to moving average,
and restores unit states in the transaction. Partial returns compute original
line-based prorated costs, post intact stock movements or damaged-stock records.
These observations are not a verified complete profit calculation.

A branch-scoped read-only GitHub workflow was added so the pinned Rust compiler
and SQLx tests run without publication. The release-capable CI workflow's push
trigger is temporarily excluded for this one recovery branch; its exception and
branch-specific verification workflow must be reconsidered before any promotion.
No release workflow, tag movement or publication was triggered. Run
`45515207863` succeeded for `6655f37eae482be8706b9dc52bda23a6195eefa5`, including
`cargo test --locked --no-fail-fast` and frontend build. Run `45516196387`
succeeded for `51b1f14e7f5ad72b5db8f3359e4b531612aef798`, adding a populated
SQLx upgrade fixture. Run `45516257456` succeeded for
`afa2f3f816517e9f564dd3d15484b7a92378b824`, adding a two-writer database-level
allocation-capacity test. These are not device tests or a two-session POS refund
test. Logs hosted on results-receiver.actions.githubusercontent.com could not be
downloaded from this sandbox; the GitHub job statuses and steps are accessible.

Migration `0040` permits reversal to the exact previously recorded wallet even
if that wallet no longer receives new payments of the old method; new sales
still require a currently eligible wallet. The Python SQLite fixture passed,
but Rust run `45517602266` at `e15ed462a6e29cc00992a939c8a253fd19690bae`
failed, followed by diagnostic run `45518498514` at
`feca3893f0268f3bd7e69f950ce2059780addc0f`; the populated-v38 upgrade test was
reported failed. Diagnosis and a passing current-SHA Rust run remain necessary.

**Follow-up:** diagnostic run `45519429207` identified the failing fixture's
trigger recreation. Run `45520289515` still failed after an initial attempt;
recreating the fixture trigger on the same acquired SQLite connection fixed it.
Non-release run `45521201988` then **passed** frontend build and all
`cargo test --locked --no-fail-fast` tests at exact SHA
`f54bbe167173e1e7683cf6651e6f13ddcba233bd`:
https://github.com/Petershaker3/system-sales/actions/runs/45521201988.
This covers the existing fresh migration tests, the synthetic populated v38
SQLx upgrade, the new historical-wallet refund service case, and the
allocation-writer concurrency test. It does not cover multiple physical drawers,
all cash transaction writers, two concurrent POS refund approvals, verified
shop data, complete inventory/profit reconciliation, or device compatibility.
The current drawer balances and the full financial report remain unreconciled.

### Interim shift safety — not a cash lifecycle implementation

Source mapping continues to show an incomplete money model: sale/refund
payments, customer debt payments, wallet operations and repair deposits/
settlements have no cash drawer identity. Drawer expenses and cash movements
link to a shift, not a physical drawer. Opening/closing are shift snapshots;
wallet transfers have `via` rather than a drawer identity, and voids and repair
status are mutable. No existing writer has been migrated to a unified drawer
ledger, no source identities have been guessed, and no balance reconciliation
has been proven. In particular, the existing `close_shift` backend still stores
its timestamp-derived expected cash and difference; API clients can call it
without the UI acknowledgement. The safety work below is not a backend close
block, not a verified accounting control, and must not be described as one.

To avoid presenting the old arithmetic as a verified count, the shift command
now exposes `cashReconciled: false`; the shift UI labels its figures
unreconciled, requires the operator to enter a physical cash count and
acknowledge the warning before using the UI close button, and no longer copies
expected cash into the count. Opening cash is also explicitly entered. The
WhatsApp shift text warns of unreconciled cash and suppresses the unverified
profit; the owner report and mobile view no longer present the estimated drawer
balance as verified. These measures do not resolve missing sources or make
historical or future shift closes auditable. Existing report guards remain.

The focused demo regression covers the blank count and acknowledgement, using a
mocked backend only. The broader demo smoke was attempted and progressed through
the updated shift checks, then failed at the guarded report screen because it
expected the old `[data-reports-day-rating]` element. It did not complete; the
underlying report-guard behavior needs a separately updated full smoke test.

**Verification at `8ed84f8471aba34bbf56ebf7bfa967172077b76d`:** non-release
GitHub run https://github.com/Petershaker3/system-sales/actions/runs/45523419867
passed the pinned Rust `cargo test --locked --no-fail-fast` suite and frontend
build, including the new transport-status test. Local typecheck and 298 frontend
unit tests passed; six focused demo browser checks passed. The broad mocked demo
smoke did not complete: it failed on a guarded report screen after its updated
shift checks passed. No real drawer balance, device, or full cash lifecycle was
verified. Documentation added after this tested commit does not change code.

### Backend fail-closed shift close and physical-count observations

`close_shift` now validates authorization, count and note, locks SQLite with
`BEGIN IMMEDIATE`, and refuses with `SHIFT_CASH_UNRECONCILED` before writing
any close when sources have not been reconciled. The current implementation has
no trusted reconciliation path, so **all new shift closes are blocked**, even
when a discrepancy note is supplied. This is an intentional operational
restriction; there is no approved policy for closing with unresolved sources.
Existing closed shifts and their historical figures are not rewritten.

Additive migration `0041` stores append-only physical count observations tied to
the open shift and actor, with an audit event in the same transaction. Counts
are not postings, opening balances, proof of a drawer identity, or proof of a
reconciled closing balance. The frontend and demo expose count-only operation;
reopening the modal can read the latest count, while closing stays unavailable.
No per-drawer identity, transactional cash posting, transfers or reconciliation
ledger has been implemented. Until those exist, the single-open-shift shop
cannot start a later shift via the normal workflow. Do not call this a complete
cash lifecycle or production-ready substitute.

Broad demo investigation: the initial missing KPI/day-rating failure was the
intentional return/cancellation guard, confirmed against the actual demo history
(the warning explicitly names returns/cancellations). The smoke now asserts that
real guard and disabled export, then separately exercises the existing report UI
with a deliberately filtered no-reversal fixture; it restores the original demo
invoker afterwards. This fixture is **not** evidence of correct reporting on
complete histories. The previously expected mobile drawer figure was also
unreconciled; the remote view now explicitly says it is unavailable. With these
updates the broad mock demo completed **323/323** checks locally; the earlier
run after the first smoke update completed 322/323 and exposed that stale mobile
expectation. Focused mock checks: 6/6 passed. Local typecheck, 298 unit tests,
production frontend build and five supplementary raw SQLite tests passed on the
backend safety code, with typecheck and broad smoke rerun after the mobile fix.
Rust/SQLx non-release run 45525179849 tests code SHA
`7e57343731fd0d76cc358d4b700ff036d5c64b69`; consult its actual conclusion before
claiming it passed. Local Rust toolchain and platform/device verification remain
unavailable.

### Operational closure and explicit handover (supersedes the blanket-close block above)

The non-release workflow passed for `0f8bb48e110dc8914f1f3e078d5084c8f52d5f2a`
(run 45526247712). The operational model now allows an authorized operator to
close a specific open shift with an explicitly supplied nonnegative physical
count. The count, audit entries and close share an immediate SQLite transaction;
failed audit writes roll the whole close back. A stale close request must name
its shift and cannot close a later shift. This is not financial reconciliation.
The legacy schema requires storing the timestamp-based expected value and its
arithmetic difference; they are estimates, not verified balances. Shift record
DTOs suppress both values and carry `cashReconciled: false`, while live totals
remain flagged unreconciled and visible only as estimates.

A subsequent opening requires an independently entered observation, not a
prefill. Migration 0042 preserves the new opening, actor, previous shift/count
when known, and arithmetic handover difference, all unresolved; there is no
implicit settlement, adjustment or verified drawer identity. Historical shift
identities and drawer sources are not inferred. A numerical difference between
observations does not establish that they concern the same physical drawer.
Opening/closing remains subject to existing seller authorization. Existing
closed records remain immutable. The return/cancellation report guard remains; it does not by itself prove all
financial reporting sources reconciled. Unverified drawer balances are withheld
where guarded, but a complete screen/export/API review remains outstanding.

On `04d163400fa485e4fbe1f50f4c7ab58e49efef0a`, local 298 unit tests,
typecheck, build, 6 focused mock checks, 5 SQLite experiments and 325/325 broad
mock-demo checks passed; the subsequent stale-request guard has also passed
local typecheck and focused mock checks. These mock checks are not a substitute
for real device tests. GitHub non-release runs 45527743833 (04d1634) and
45528165063 (54a951f) must be checked for their actual conclusions.

**Still incomplete:** this is not the requested durable drawer ledger. New cash
writers are not universally bound to a configured immutable drawer identity,
transfers and reversals have no unified posting model, and no complete
reconciliation or discrepancy-resolution policy exists. The handover record
has no history UI/API beyond the immediate opening comparison yet. Transaction
idempotency across sales, expenses, wallets, repairs and transfers, actual Tauri
direct-command execution, upgraded real backups and device behavior remain
unverified. Do not promote or describe this as a complete cash lifecycle.

The handover lookup additionally distinguishes a proven new closing observation
from legacy `counted_cash_minor`: earlier UI versions could prefill an estimate,
so legacy values are not promoted to physical-count evidence. Their shift link
is retained and the prior-count/difference fields remain unknown. The opening
screen warns that old amounts may have unverified provenance and that compared
observations may not identify the same drawer.

### Wallet provenance and explicit selection (migration 0043)

The requested baseline `66ed5d8ca0cb854ad81a893abde11e44c36bbf78` passed
non-release run 45528531952. Migration 0030 could fill a historical sale's
wallet ID using the wallet configured for a payment method at migration time.
A non-null value therefore does not prove the original receiving wallet.
Migration 0043 does **not** backfill provenance. It records evidence for new
sale wallet payments and protects it against updates/deletion; a database
allocation trigger also refuses an electronic refund without matching evidence.
The shared Rust resolver requires an explicitly supplied eligible wallet for
new sale, debt-payment and repair electronic payments rather than silently
choosing a primary. The wallet selector now offers even a single eligible
wallet, with an explicit choice. Sales cancellation and return refuse an
unknown electronic source before committing; the existing original-payment
allocation and wallet checks remain in place.

This is intentionally conservative: **all electronic sale payments already in a
shop at the 0043 upgrade lack this new evidence**, including some that may in
fact have been selected correctly. They cannot currently be returned/cancelled
through these paths until an auditable evidence-based resolution is implemented;
there is no unsafe automatic backfill or override. This is an operational
limitation, not proof that all old wallet records are wrong. Existing customer
and repair history can likewise contain inferred attribution and has not been
retroactively verified. The demo backend is only a mock and its historical data
and refund logic do not establish database-level provenance.

Trace map for further ledger implementation: sale and exchange receipts and
reversals live in `sales`/`sale_payments`, with `refund_payment_allocations` for
new linked reversals; customer settlement is in `customer_ledger`; repair
receipt and settlement are recorded in repair rows; drawer expenses and manual
movements use `expenses` and `cash_movements` linked to a shift; wallet services
and top-up/unload/void use `wallet_ops`; shifts and the two observation tables
record operational handover. Several writers still use time-window association
and/or deferred transactions and do not record a physical drawer identity.
There is no common cash movement/idempotency ledger and no complete reconciliation
or resolution model. In particular, a cash refund's original drawer remains
unknown: the new electronic provenance must not be mistaken for completion of
cash drawer attribution, profit reporting, multi-drawer transfers or end-to-end
reconciliation. The existing report guard remains unchanged.

Non-release run 45530379999 at `ff9f2531dec3a6a8cd4dc9aa63640cc5acc87467`
failed Rust compilation (`E0596`, reborrow of an already borrowed transaction).
The reborrow was corrected at `4b02bdbdd8dfc1fc380cfa16a588eac8d5b386f0` and
fixtures exercising real wallet selection were updated; consult the later run
before asserting Rust success. Local typecheck, 298 unit tests, production
build, five raw SQLite experiments and six focused mock checks passed for the
wallet changes. A broad mock demo run including a missing-wallet rejection
completed 326/326 checks on the 4b02bdb changes. These browser checks use a mock
backend, not a real Tauri/SQLite UI. A new encrypted backup/restore test covers
shift counts, handover and wallet provenance and checks restored integrity and
append-only enforcement; its result requires the non-release CI run on or
after `977aac61830a2aaa54d1a39bb6b081f61fca0c22`.

Wallet summaries may include historical inferred assignments. The wallet API now
marks its calculated balance `balanceReconciled: false`; the wallet screen and
manual adjustment dialog label the calculation and equality as unverified.
Recording an existing authorized wallet adjustment is not proof of source
reconciliation. Its read/compute/write transaction now takes SQLite's immediate
write lock before computing a difference, and rejects signed arithmetic overflow.
A file-backed concurrent test exercises duplicate requests to adjust to the same
observed amount. This does not supply general idempotency keys for other cash or
wallet events and does not resolve ambiguous historical sources.

Report UI, printed page, CSV, and daily WhatsApp summary now carry an explicit
unverified-calculation warning, and the WhatsApp formatter withholds the drawer
balance regardless of any caller-provided estimate. The return/cancellation
guard remains unchanged. These warnings do not make the underlying report
calculations complete, and no full screen/API review or real database-to-UI test
has yet been proved.

### Historical wallet review (0044)

Migration 0044 adds manager-only evidence confirmations and compensating
revocations for the **same wallet ID already recorded** on an older electronic
sale payment. This is a review of independent evidence, not a claim that the
recorded ID was inherently reliable. Review rows carry reason, evidence
reference, actor, timestamp and request ID; are immutable; and commit with an
audit entry. The backend and allocation trigger accept an active review, while
preventing withdrawal once a refund uses it. Identical requests are replayable;
changed requests cannot reuse the same identity. The sales invoice UI exposes
this manager review and warns against choosing without evidence.

**Limits:** a missing wallet or evidence that points to a different wallet is
not resolvable by this implementation. A used review cannot yet be corrected
with a compensating financial posting. Historical returns and cancellations
remain blocked if source evidence is unresolved; the actual payment method for
an unresolved refund is an open business-policy decision. No drawer identity,
unified financial ledger, reconciliation, complete event-period reporting or
real Tauri database-to-UI proof has been added by this change. The report guard
remains. Do not describe this as full provenance resolution or cash lifecycle.


### Effective source review (0045–0046)

Superseding the same-wallet restriction in the preceding section, a manager
may explicitly select an existing wallet supported by independent evidence even
when the historical payment records another wallet or none. The original value
is preserved; an effective-source view and the append-only decision identify
the reviewed wallet. Refund allocation and wallet estimates use the active
reviewed source. Wallets whose current method changed remain eligible as
historical sources. If an existing linked refund names another wallet the
review is refused; used confirmations cannot be revoked until a compensating
financial correction model exists. The full review event history is exposed
to managers. This is an attestation, not a technical verification of evidence.

Unresolved payment sources remain blocked: no physical payment destination is
inferred and no decision has been made for paying a refund from a different
source. Full drawer ledger, reconciliation, complete history reporting, and
real database-to-UI validation are still outstanding. The report guard remains.
