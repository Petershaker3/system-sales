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
