# Full-System Delivery Plan — Mobile Shop System

> **Status:** COORDINATION DOCUMENT — not a substitute for the specification,
> does not authorize code changes, and is not evidence that any test has passed.
>
> **Authorized by:** Product Owner, planning task of 2026-10-15.
> **Authorized write scope:** this file only (`tasks/delivery-plan.md`).
>
> **Basis:** a read-only inspection of the repository performed for this document.
> Where a fact could not be independently re-checked, it is labelled as reported
> or unverified below. No test, build, or device run was executed for this plan.

---

## 1. Purpose, scope, and authority

This document is the **single coordination and traceability reference** for
delivering the Mobile Shop System from its current repository state to verified
final acceptance.

- It **links** requirements → current state → evidence → dependencies →
  decisions → acceptance; it does **not** restate the specification.
- It **does not** replace `tasks/todo.md` (the working index) and does not
  authorize edits to it.
- It **does not** modify source, tests, migrations, configuration, ADRs, the
  specification, or any other file.
- It records what exists and what is missing **as observed**, not as believed.

`docs/PROJECT_INSTRUCTIONS.md` remains in force: Product Owner authority (§1),
independent new system (§2), the Decision Gate (§3), evidence classification
(§4), the workflow (§5), and the safety rules (§7) all apply to delivery.

## 2. Evidence classes and status vocabulary

**Evidence classes** (per `docs/PROJECT_INSTRUCTIONS.md` §4):

| Label | Meaning |
|---|---|
| `VERIFIED` | confirmed against the actual source or data, with the reference cited |
| `REPORTED — NOT INDEPENDENTLY VERIFIED` | stated by a prior report; not re-checked for this plan |
| `UNVERIFIED` | plausible but not confirmed against real behavior or data |
| `ASSUMPTION` | an unproven premise being relied upon |
| `NEEDS PRODUCT OWNER DECISION` | the answer would change scope, architecture, or data interpretation |

**Execution gates** — kept strictly separate:

| Gate | Meaning |
|---|---|
| CODE | implementation exists **and** is wired into the real application path |
| TEST | relevant tests exist **and** a fresh run has passed |
| DEVICE / RUNTIME | the required behavior was observed on the applicable platform |

**Gate status tokens** used verbatim in §4 and §9:

| Token | Meaning |
|---|---|
| `PASS — VERIFIED` | executed in this review; output cited |
| `EXISTS — NOT RUN` | artifact exists; not executed/checked in this review |
| `REPORTED — NOT INDEPENDENTLY VERIFIED` | claimed by a prior report; not re-checked |
| `FAIL` | executed and did not succeed; output cited |
| `BLOCKED` | cannot be attempted (decision, hardware, external dependency) |
| `ABSENT` | absence established by a sufficiently scoped inspection |
| `UNVERIFIED` | current state cannot be established from available evidence |
| `NEEDS PRODUCT OWNER DECISION` | product behavior / scope / data semantics unresolved |

**Three rules that must not be collapsed:**

1. A test file existing is **not** a passing test.
2. A successful build is **not** proof the app launches.
3. A database row proves only what the evidence actually demonstrates.

**Platform column values:** `Win+And` · `Android-only` · `Windows-only` ·
`Any (no device gate)`.

## 3. Normative sources and V1 boundaries

**Authority hierarchy** (highest first), as determined from the repository:

1. `docs/PROJECT_INSTRUCTIONS.md` — standing project rules; Owner's latest
   explicit statement wins.
2. `docs/superpowers/specs/2026-09-28-mobile-shop-system.md` — the normative
   specification, rebaselined 2026-10-02 by `ADR-007`, with inline amendments
   2026-10-07 (`ADR-012`, `ADR-013`).
3. Accepted ADRs in `docs/decisions/` — `ADR-001` … `ADR-015` (see note on
   `ADR-005` below).
4. Task plans and handoff reports — **non-normative**; working evidence only.

**Recorded conflicts / gaps in the sources:**

- `ADR-005` is **absent** from `docs/decisions/` (present: 001-004, 006-015).
  Its subject and disposition are `UNVERIFIED`; no rule depends on it today
  (open item D9).
- `ADR-001` (single-POS ownership) is **cancelled for V1** by `ADR-008`; its text
  is retained as history.
- `ADR-013` partially supersedes `ADR-002` (FIFO). `ADR-015` amends `ADR-012`
  (§7, `cost_method`) and `ADR-013` (consequences).

**V1 scope (ADR-008):** offline-first local POS on **both** Windows and Android;
each device owns its own local SQLite; **no** automatic sync, central server,
cloud database, conflict resolver, or sync engine. Future sync is deferred and
must not be designed here.

**Money (ADR-010):** currency `EGP`, minor unit `piastre`, 2 decimals. Stored as
integer `amount_minor`; never `REAL`/`f64`/decimal text. Rounding policy is
`ceil(piastre)` at computation only (ADR-013 / delivery spec §10); never applied
to a stored value.

**Sessions (ADR-009):** entity ids are UUID v7; the session token lives in the OS
credential store (Windows Credential Manager / Android Keystore), never reaches
JavaScript, and SQLite stores only `SHA-256(token)`.

## 4. Complete requirement traceability

**Disposition vocabulary:** `IMPLEMENTED — VERIFIED` · `IMPLEMENTED — NOT
VERIFIED` · `PARTIAL` · `MISSING` · `FAILING` · `BLOCKED` · `NEEDS PRODUCT OWNER
DECISION` · `NOT APPLICABLE (V1)`.

**Reading the table.** "Test" reflects the state of the test corpus and the
latest *reported* result — **no test run was performed for this plan**, so any
green result is `REPORTED — NOT INDEPENDENTLY VERIFIED`. "Device" is `ABSENT`/
`NOT RUN` except where noted.

### 4.1 `platform-data` — application, local DB, versions, migrations

| ID | Requirement (spec §) | Platforms | Code | Test | Device | Evidence / Gap | Disposition |
|---|---|---|---|---|---|---|---|
| PLAT-01 | Installed standalone app on Windows and Android; not a browser (§43, §208) | Win+And | PRESENT | ABSENT | NOT RUN | `src-tauri/tauri.conf.json`, `src/main.rs`, `src-tauri/src/lib.rs:37`, `capabilities/{default,mobile}.json` | IMPLEMENTED — NOT VERIFIED |
| PLAT-02 | Tauri pinned `2.12.0`; no auto major/minor upgrades (§44, ADR-008) | Win+And | PRESENT | n/a | n/a | `src-tauri/Cargo.toml:29` `tauri = { version = "=2.12.0" }` | VERIFIED (code) |
| PLAT-03 | SQLx pinned `0.9.0` (§44) | Win+And | PRESENT | n/a | n/a | `Cargo.toml:36` `sqlx = { version = "=0.9.0" }` | VERIFIED (code) |
| PLAT-04 | Rust pinned `1.98.1` via `rust-toolchain.toml`; `Cargo.lock` committed (§44, ADR-008) | Win+And | PRESENT | n/a | n/a | `rust-toolchain.toml:9`; `src-tauri/Cargo.toml:7`; `src-tauri/Cargo.lock` present | VERIFIED (code) |
| PLAT-05 | No general SQL interface exposed to the WebView (§45, §148); only named, role-checked Rust commands | Win+And | PRESENT | REPORTED | NOT RUN | no `tauri-plugin-sql` dependency; `invoke_handler` in `lib.rs:39-85` | IMPLEMENTED — NOT VERIFIED (runtime) |
| PLAT-06 | Vue + TypeScript **strict** (§47, §129) | Win+And | PRESENT | REPORTED | n/a | `tsconfig.json:17` `strict: true` (+ `noUnusedLocals`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) | VERIFIED (config) |
| PLAT-07 | No backend / no cloud / no sync / no server / no Supabase in V1; `@supabase/*` not present (§48, §147, §234, ADR-008) | Win+And | PRESENT | n/a | n/a | `package.json` dependencies = `@tauri-apps/api`, `vue` only; no-sync-test rule (§136) follows from no sync engine | VERIFIED (code) |
| PLAT-08 | Layer architecture `Vue→Commands→Services→Domain→Repositories→SQLite`; domain independent of Tauri/SQLx/SQLite (§58-104, §131) | Win+And | PRESENT | REPORTED | n/a | `src-tauri/src/{domain,services,data/{repositories,migrations},commands}`; architecture guards in `tests/architecture/main.rs`; §131 global-state avoidance enforced at review (no dedicated guard claimed) | IMPLEMENTED — NOT VERIFIED (guards run) |
| PLAT-09 | Six future-sync architectural constraints (stable ids, boundaries, repo abstraction, timestamps, no SQLite/network in domain) (§105-116) | Win+And | PRESENT | REPORTED | n/a | UUID v7 (ADR-009); repository abstraction; `tests/architecture` | IMPLEMENTED — NOT VERIFIED |
| PLAT-10 | Build/release pipeline: `npm run build` → green; installable artifacts per platform (§43, §141) | Win+And | PRESENT | UNVERIFIED | ABSENT | `package.json:9` build = `vue-tsc --noEmit && vite build`; **result not recorded this review**; `SalesPanel.vue:260` unused-local is a static build-block inference (not an executed result) | UNVERIFIED |
| PLAT-11 | `tests/device/` scenario tree exists (§92) | Win+And | ABSENT | ABSENT | ABSENT | no `src-tauri/tests/device/`; only `architecture`, `integration`, `unit` | MISSING |
| PLAT-12 | Each device owns an independent local SQLite; no shared DB; no cross-device ownership lock; no sale refused because of another device (§118, §155, §159-163; no cross-device sale policy per §223) | Win+And | PRESENT | n/a | NOT RUN | `src-tauri/src/lib.rs:19-23` (`DB_FILENAME` + no-shared-DB comment); ADR-008; `README.md:168-170` | IMPLEMENTED — NOT VERIFIED |
| PLAT-13 | README documents the exact build/test commands before the first production slice (§141, §227) | Any (no device gate) | PARTIAL | n/a | n/a | `README.md:56-106` documents commands + test layout; scope claims stale (C4, C8); owned by PA | PARTIAL |
| PLAT-14 | Single shared Vue frontend across both platforms (§47) | Win+And | PRESENT | n/a | n/a | single `src/` tree; `capabilities/{default,mobile}.json`; "as far as possible" not measured | IMPLEMENTED — NOT VERIFIED |

### 4.2 `identity-access` — accounts, roles, permissions, audit

| ID | Requirement (spec §) | Platforms | Code | Test | Device | Evidence / Gap | Disposition |
|---|---|---|---|---|---|---|---|
| ID-01 | Accounts, sessions, login/logout; bootstrap first manager (§15-19) | Win+And | PRESENT | REPORTED | NOT RUN | `services/identity/*`; `commands/identity*.rs`; snapshot: 1 user `ShopManager1` (manager) | IMPLEMENTED — NOT VERIFIED |
| ID-02 | Roles: manager vs sales; wholesale/cost not returned to sales; permissions enforced at data layer, not UI-hidden (§17-18, §210) | Win+And | PRESENT | REPORTED | NOT RUN | `domain/identity/role.rs`, `sensitivity.rs`, `policy.rs`; `tests/integration/authority.rs` | IMPLEMENTED — NOT VERIFIED |
| ID-03 | Every operation attributed to the executing user via a checked Rust command; no "unknown user" state (§19, §177) | Win+And | PRESENT | REPORTED | NOT RUN | attribution from session; snapshot audit rows carry manager id | IMPLEMENTED — NOT VERIFIED |
| ID-04 | Product/record archival preserves invoice & movement history; no hard delete from normal flow; no direct replacement of original user data (§20, §147, §221) | Win+And | PARTIAL | REPORTED | NOT RUN | `set_product_archived`, `ON DELETE RESTRICT`; deletion flows for sales/history not verified; owned by P4b | PARTIAL |
| ID-05 | Session token in OS credential store; never to JS; SQLite stores `SHA-256(token)`; fail closed (ADR-009) | Win+And | PRESENT | REPORTED | NOT RUN | `services/identity/secure_store.rs`; `keyring-core` + native stores; `lib.rs:90-93` | IMPLEMENTED — NOT VERIFIED |
| ID-06 | Password policy, lockout, forced change, lifecycle (create/disable/enable/role/username) (ADR-009; §15-19) | Win+And | PRESENT | REPORTED | NOT RUN | `commands/identity_lifecycle.rs`; `tests/integration/identity_lifecycle.rs` | IMPLEMENTED — NOT VERIFIED |
| ID-07 | One-time supervised manager-password recovery (R1) — production builds must exclude it | Win+And | PRESENT | REPORTED | NOT RUN | `commands/recovery.rs` behind `#[cfg(feature="recovery")]`; `tests/integration/recovery*.rs`; `build-proof-evidence.txt` | IMPLEMENTED — NOT VERIFIED |
| ID-08 | Audit trail of operations/changes/cancellations attributed to user (§19, §33) | Win+And | PARTIAL | REPORTED | NOT RUN | `audit_events` table; snapshot shows 11 events incl. `pattern_set`; operational audit breadth not verified; core attribution owned by P4b/P5, operational breadth by P7 | PARTIAL |

### 4.3 Pattern step-up (`ADR-014`)

| ID | Requirement | Platforms | Code | Test | Device | Evidence / Gap | Disposition |
|---|---|---|---|---|---|---|---|
| PAT-01 | Optional manager-only second approval for sensitive operations; 5-min TTL, epoch invalidation | Win+And | PRESENT | REPORTED | NOT RUN (round-trip; write evidenced in §5.1) | snapshot: `manager_pattern` 1 row, `epoch=1`, `verifier` Argon2id PHC; `audit_events` `pattern_set {"epoch":1}`; `app_settings.pattern_required=1`; device TTL/epoch check owned by P1 (A22) | PARTIAL |
| PAT-02 | `verify_pattern` round trip: accept correct, reject wrong; refuses stale/absent | Win+And | PRESENT | REPORTED | NOT RUN | `commands/pattern.rs`; `tests/integration/pattern.rs`; device run never completed; owned by P1 | IMPLEMENTED — NOT VERIFIED |
| PAT-03 | Enable/disable/reset Pattern; reset only from an authenticated manager session | Win+And | PRESENT | REPORTED | NOT RUN | `commands/pattern.rs` (`set/reset/disable`); `PatternPrompt.vue`; owned by P1 | IMPLEMENTED — NOT VERIFIED |

### 4.4 `catalog-media` — products, barcode, image, IMEI/Serial

| ID | Requirement (spec §) | Platforms | Code | Test | Device | Evidence / Gap | Disposition |
|---|---|---|---|---|---|---|---|
| CAT-01 | Product create/get/list/update/archive; independent barcode field (§176, §221) | Win+And | PRESENT | REPORTED | NOT RUN | `commands/catalog.rs`; `repositories/catalog/product.rs`; `tests/integration/catalog.rs` | IMPLEMENTED — NOT VERIFIED |
| CAT-02 | Barcode lookup for sale/add; USB reader on Windows, camera on Android; offline after first load (§196, §211) | Win+And | ABSENT | ABSENT | BLOCKED | no barcode dependency (`Cargo.toml:118`); `ADR-004` physical acceptance not performed; device acceptance additionally BLOCKED on hardware + D5 | MISSING |
| CAT-03 | Barcode generation + label printing (new capability entirely) (§176, §237) | Win+And | ABSENT | ABSENT | BLOCKED | label scope is an open decision (D5) | NEEDS PRODUCT OWNER DECISION |
| CAT-04 | Optional IMEI/Serial per piece; duplicate id forbidden per product/shop (§197, §211) | Win+And | ABSENT | ABSENT | ABSENT | `services/sales/mod.rs:197-202` refuses non-`Quantity` dispositions; no serial tables | MISSING |
| CAT-05 | One main product image; file stored separately; record holds a reference only (§192-193, §220) | Win+And | ABSENT | ABSENT | ABSENT | no image module/table; `photos` absent in schema; capture hardware-gated to Android camera, display on both | MISSING |
| CAT-06 | Departments = product classification; inheritance of `cost_method`; product w/o department follows `app_settings.default_cost_method` (§28, ADR-012, ADR-015) | Win+And | PRESENT | REPORTED | NOT RUN | `departments` table (`0004`); `services/organisation/*`; `Department::update` guard | IMPLEMENTED — NOT VERIFIED |
| CAT-07 | Price-history (immutable sale snapshots; price change does not rewrite history) (§173) | Win+And | PARTIAL | REPORTED | NOT RUN | `0006_settings_and_price_history.sql`; snapshot on sale line deferred to sale completion; sale-completion part owned by P5 | PARTIAL |

### 4.5 `inventory-procurement` — stock ledger, costing, receiving

| ID | Requirement (spec §) | Platforms | Code | Test | Device | Evidence / Gap | Disposition |
|---|---|---|---|---|---|---|---|
| INV-01 | Stock ledger; balances not computed from UI or mutable values without a movement (§130) | Win+And | PRESENT | REPORTED | NOT RUN | `0008_stock_and_cost_layers.sql`; `services/inventory/*`; `commands/inventory.rs` | IMPLEMENTED — NOT VERIFIED |
| INV-02 | Weighted moving average for quantity items; per-unit actual cost for IMEI/Serial (§174, ADR-002, ADR-013) | Win+And | PARTIAL | REPORTED | NOT RUN | MA engine present and owned by P4b; **serial path absent**, owned by P3 (see CAT-04) | PARTIAL |
| INV-03 | FIFO layers as option per department; authority rule (one representation authoritative, the other NULL/empty) (§174, ADR-013, ADR-015) | Win+And | PRESENT | REPORTED | NOT RUN | `domain/costing/fifo.rs`; `fifo_layers`; `STOCK_COST_AUTHORITY_CONFLICT` | IMPLEMENTED — NOT VERIFIED |
| INV-04 | Opening balance entered by the user before first sale; no invented quantities (§175) | Win+And | PRESENT | REPORTED | NOT RUN | opening-balance operation in `services/inventory`; `service` ownership of sensitivity | IMPLEMENTED — NOT VERIFIED |
| INV-05 | Simplified receiving = supplier name + quantity + unit cost; **no** purchase orders / payables (§29, §231) | Win+And | PARTIAL | REPORTED | NOT RUN | `receive_stock` exists but **no supplier field** — `0008:63` "No supplier, purchase order or payable"; owned by P4b after D1 | PARTIAL / needs D1 |
| INV-06 | Stock conflict visible in-device; no silent/partial deduction; `CHECK (quantity >= 0)` last line of defence (§212, ADR-015 §6) | Win+And | PRESENT | REPORTED | NOT RUN | `COST_INSUFFICIENT_STOCK`; schema CHECK; tested via raw SQL | IMPLEMENTED — NOT VERIFIED |
| INV-07 | Costing-method switch converts current stock; new-only effect; manager-only + reauth + Pattern (§89-98, ADR-013, ADR-015) | Win+And | PRESENT | REPORTED | NOT RUN | `switch_cost_method`; `Department::update` refuses direct change | IMPLEMENTED — NOT VERIFIED |
| INV-08 | Movement ledger is the rebuild source; stocktake/adjustments/transfers (§134, ADR-013, ADR-015) | Win+And | PARTIAL | REPORTED | NOT RUN | receive/remove/transfer present; **stocktake/adjustment not confirmed**; owned by P4b | PARTIAL |

### 4.6 `customer-records`

| ID | Requirement (spec §) | Platforms | Code | Test | Device | Evidence / Gap | Disposition |
|---|---|---|---|---|---|---|---|
| CUST-01 | Simple customer file: name + one optional contact; optional link to sale/repair/IMEI; warranty date range (§30, §179) | Win+And | ABSENT | ABSENT | ABSENT | no customer module/table/command | MISSING |
| CUST-02 | Sales user may enter a new customer for an invoice without browsing purchase history (§18, §179) | Win+And | ABSENT | ABSENT | ABSENT | depends on CUST-01 | MISSING |
| CUST-03 | Sales user cannot browse the customer purchase record (§18, §179) | Win+And | ABSENT | ABSENT | ABSENT | depends on CUST-01 | MISSING |
| CUST-04 | No credit/installments in V1 (§30) | Win+And | n/a | n/a | n/a | scope exclusion | NOT APPLICABLE (V1) |
| CUST-05 | No two similar customer names merged into one record; customer linking only by explicit command, otherwise the name stays a text snapshot on the operation (§178) | Win+And | ABSENT | ABSENT | ABSENT | no customer module; owned by P4; scenario A21 | MISSING |

### 4.7 `pos-sales`

| ID | Requirement (spec §) | Platforms | Code | Test | Device | Evidence / Gap | Disposition |
|---|---|---|---|---|---|---|---|
| SALE-01 | Complete sale workflow; atomic invoice + lines + stock + cost + ledger + audit; injected failure leaves no partial sale (§53, §138) | Win+And | PRESENT | REPORTED | NOT RUN | `commands/sales.rs`; `services/sales/mod.rs`; `tests/integration/sales.rs` | IMPLEMENTED — NOT VERIFIED |
| SALE-02 | Line stores product/barcode/price/**cost**/profit snapshot at sale time; never recomputed (§173, ADR-013) | Win+And | PRESENT | REPORTED | NOT RUN | `unit_cost_minor`/`cost_total_minor`; `SaleOutcomeWithCost` | IMPLEMENTED — NOT VERIFIED |
| SALE-03 | Wholesale/cost/profit omitted (not zeroed) for unauthorized callers (§54, §210, ADR-015) | Win+And | PRESENT | REPORTED | NOT RUN | `SaleOutcomePublic` vs `SaleOutcomeWithCost` split in Rust | IMPLEMENTED — NOT VERIFIED |
| SALE-04 | Immutable, monotonic sale reference; retry must not duplicate; `SALE_REFERENCE_CONFLICT` (§212) | Win+And | PARTIAL | REPORTED | NOT RUN | `SALE_REFERENCE_CONFLICT` code; idempotent-retry behaviour not independently verified; owned by P5 | PARTIAL |
| SALE-05 | Cancellation writes a reversal; no edit, no double-cancel; manager-only + Sensitive gate (§31) | Win+And | PRESENT | REPORTED | NOT RUN | `cancel_sale`; `SALE_ALREADY_CANCELLED`; `SALE_REVERSAL_INCONSISTENT` | IMPLEMENTED — NOT VERIFIED |
| SALE-06 | Payments: cash-first; **actual payment methods** not decided (§233) | Win+And | PARTIAL | REPORTED | NOT RUN | cash-only in `SalesPanel.vue`; other methods open (D3); owned by P5 | PARTIAL / D3 |
| SALE-07 | Customer returns; damaged/non-resellable accounting (§239, ADR-013) | Win+And | ABSENT | ABSENT | ABSENT | return-to-stock at original line cost designed but not implemented; damaged accounting open (D7) | NEEDS PRODUCT OWNER DECISION |
| SALE-08 | Receipt document printing (printer model undecided) (§233) | Win+And | ABSENT | ABSENT | BLOCKED | no printer/print code | NEEDS PRODUCT OWNER DECISION |
| SALE-09 | Refresh-then-confirm: price change never silently commits; `SALE_PRICE_CHANGED` (§53) | Win+And | PRESENT | REPORTED | NOT RUN | `SalesPanel.vue` refresh-then-confirm; `SALE_PRICE_CHANGED` | IMPLEMENTED — NOT VERIFIED |
| SALE-10 | Serialized/one-off dispositions refused rather than approximated in V1 (§175, `services/sales/mod.rs:197`) | Win+And | PRESENT | REPORTED | NOT RUN | `SALE_DISPOSITION_NOT_SUPPORTED` | IMPLEMENTED (V1 subset) |

### 4.8 `cash-reconciliation`

| ID | Requirement (spec §) | Platforms | Code | Test | Device | Evidence / Gap | Disposition |
|---|---|---|---|---|---|---|---|
| CASH-01 | Cash movements + shift open/close (§32) | Win+And | ABSENT | ABSENT | ABSENT | no cash module/table/command | MISSING |
| CASH-02 | Drawer reconciliation against cash sales (§32) | Win+And | ABSENT | ABSENT | ABSENT | depends on CASH-01 | MISSING |

### 4.9 `shop-operations`

| ID | Requirement (spec §) | Platforms | Code | Test | Device | Evidence / Gap | Disposition |
|---|---|---|---|---|---|---|---|
| OPS-01 | Repairs / maintenance records linked to IMEI/customer (§33) | Win+And | ABSENT | ABSENT | ABSENT | no repair module/table/command | MISSING |
| OPS-02 | Expenses recording (§33) | Win+And | ABSENT | ABSENT | ABSENT | no expense module | MISSING |
| OPS-03 | Operational audit log (§33) | Win+And | PARTIAL | REPORTED | NOT RUN | `audit_events` exists; operational breadth (repairs/expenses) not built; owned by P7 | PARTIAL |

### 4.10 `local-backup`

| ID | Requirement (spec §) | Platforms | Code | Test | Device | Evidence / Gap | Disposition |
|---|---|---|---|---|---|---|---|
| BAK-01 | Encrypted, versioned, portable backup bundle: DB + images + manifest; manager password (ADR-003) | Win+And | PRESENT | REPORTED | NOT RUN | `domain/backup/*`; `services/backup/*`; `tests/{unit,integration}/backup.rs` | IMPLEMENTED — NOT VERIFIED |
| BAK-02 | Wrong password / tampered / truncated / unsafe path all fail closed; never overwrite without a full valid restore (ADR-003) | Win+And | PRESENT | REPORTED | NOT RUN | single `BACKUP_DECRYPT_FAILED` (no oracle); 8 crash-state tests | IMPLEMENTED — NOT VERIFIED |
| BAK-03 | Crash-safe staged restore + idempotent startup recovery (Prepared→BackedUp→Installed) (ADR-003) | Win+And | PARTIAL | REPORTED | NOT RUN | `journal.rs:237` `recover_interrupted` **defined**; **not called** in `lib.rs` startup; wiring owned by P2a | PARTIAL |
| BAK-04 | Restore includes images; missing image shows placeholder (§194-195, §213) | Win+And | PARTIAL | REPORTED | ABSENT | images in bundle; **no UI**; product-image module absent (CAT-05), so placeholder path absent; owned by P3 (CAT-05) | PARTIAL / depends CAT-05 |
| BAK-05 | Tauri command + UI entry point; on-device interactive create/restore (ADR-003; plan-backup tired) | Win+And | ABSENT | ABSENT | BLOCKED | explicitly out of the implemented scope; no command/UI | MISSING (prereq-blocked) |
| BAK-06 | WAL-aware snapshot (`VACUUM INTO`, writes nothing to source) (ADR-011) | Win+And | PRESENT | REPORTED | NOT RUN | `services/backup/create.rs`; `tests/integration/backup.rs::a_snapshot_captures_data_that_lives_only_in_the_wal` | IMPLEMENTED — NOT VERIFIED |
| BAK-07 | Operational policy: snapshot trigger, retention, restore validation, integrity checks (ADR-008 `shell`, §232) | Win+And | ABSENT | ABSENT | ABSENT | deliberately open (D6) | NEEDS PRODUCT OWNER DECISION |

### 4.11 `reports`

| ID | Requirement (spec §) | Platforms | Code | Test | Device | Evidence / Gap | Disposition |
|---|---|---|---|---|---|---|---|
| REP-01 | Metrics/reports on transactions with **independent definitions**, not legacy-derived (§35, §181-188, §238) | Any (no device gate) | ABSENT | ABSENT | n/a | no reports module; definitions explicitly open (D2) | NEEDS PRODUCT OWNER DECISION |
| REP-02 | `Total Sales`, `Net Profit` etc. each with explicit written semantics (§183-188) | Any (no device gate) | ABSENT | ABSENT | n/a | depends REP-01 / D2 | NEEDS PRODUCT OWNER DECISION |
| REP-03 | Report role restrictions & consistency between operational records and reports (§33) | Any (no device gate) | ABSENT | ABSENT | n/a | depends REP-01 | MISSING |

### 4.12 Migrations & data safety

| ID | Requirement (spec §) | Platforms | Code | Test | Device | Evidence / Gap | Disposition |
|---|---|---|---|---|---|---|---|
| MIG-01 | Versioned migrations; forward-fix only; no “Down” rollback (§145, `plan:143`, `0008:66`) | Win+And | PRESENT | REPORTED | PASS — VERIFIED (0005 checksum only); 1-4/6-7 REPORTED | 11 migrations `0001`…`0011`; `0005` blob checksum re-verified this review; 1-4/6-7 matches inherited from the prior verification (see §5.1); `integrity_check = ok`; completion via P9 acceptance (A9, A11) | PARTIAL |
| MIG-02 | Upgrade applies on a **populated** DB; existing rows survive; tampering detected, not repaired (§214) | Win+And | PRESENT | REPORTED | NOT RUN | `tests/integration/migration_backward_compat.rs` (3 tests) | IMPLEMENTED — NOT VERIFIED |
| MIG-03 | Resolve the recorded `0005` device conflict | Win+And | PRESENT | n/a | PASS — VERIFIED (checksum) | repo `0005` blob = working tree = device `d167c2d5…36b3` (full 96-hex); 1-7 ledger entries all match | IMPLEMENTED — VERIFIED (checksum); app reopen UNVERIFIED (A11) |
| MIG-04 | No WAL hazard: a live DB is never copied as `shop.db` alone (ADR-011) | Win+And | PARTIAL | REPORTED | NOT RUN | snapshot uses `VACUUM INTO`; **no integration test exercises WAL** (`db.rs:72` in-memory); snapshot path owned by P2a | PARTIAL |

### 4.13 Cross-cutting requirements

| ID | Requirement (spec §) | Platforms | Code | Test | Device | Evidence / Gap | Disposition |
|---|---|---|---|---|---|---|---|
| XC-01 | Money stored as integer minor units; never `REAL`/`f64`; round-trip Rust↔WebView lossless (§56, §139, ADR-010) | Win+And | PRESENT | REPORTED | NOT RUN | `domain/money/*`; integer columns; `tests/…` money boundaries | IMPLEMENTED — NOT VERIFIED |
| XC-02 | Ceil(piastre) at computation only; `i128` intermediates (ADR-013) | Win+And | PRESENT | REPORTED | NOT RUN | `domain/costing/*` | IMPLEMENTED — NOT VERIFIED |
| XC-03 | Domain independent of Tauri/SQLx/SQLite/platform (§99, §128) | Win+And | PRESENT | REPORTED | n/a | architecture guards | IMPLEMENTED — NOT VERIFIED |
| XC-04 | No secrets in client; no credential in WebView; fail-closed storage (§147-148, ADR-009) | Win+And | PRESENT | REPORTED | NOT RUN | `errors.ts` `SECURE_STORAGE_UNAVAILABLE`; architecture guard: no pattern secret in storage | IMPLEMENTED — NOT VERIFIED |
| XC-05 | User-facing text in Arabic message files, not scattered in domain logic (§127) | Win+And | PRESENT | REPORTED | n/a | `src/api/errors.ts`; bidirectional architecture guard | IMPLEMENTED — NOT VERIFIED |
| XC-06 | Arabic RTL UI (§13) | Win+And | PRESENT | ABSENT | NOT RUN | Vue app; RTL not independently asserted | IMPLEMENTED — NOT VERIFIED |
| XC-07 | Error codes stable and language-independent across IPC (§127) | Win+And | PRESENT | REPORTED | n/a | `ErrorCode` exhaustive map; drift guards | IMPLEMENTED — NOT VERIFIED |
| XC-08 | Estimates/legacy independence: no legacy schema/logic/data enters the new system (§143-148, §199-204, ADR-007) | Win+And | PRESENT | REPORTED | n/a | no legacy importer found; `product/` untracked and unused; full-tree absence sweep not recorded | IMPLEMENTED — NOT VERIFIED |
| XC-09 | Consistent timestamp + metadata where domain requires (§112, ADR-009) | Win+And | PRESENT | REPORTED | NOT RUN | INTEGER ms epoch UTC across migrations; UUID v7 | IMPLEMENTED — NOT VERIFIED |
| XC-10 | No images or large fields stored inside the DB; the image is an external file with a record reference only (§220) | Win+And | PRESENT | ABSENT | NOT RUN | schema-wide grep over `0001`…`0011`: no `BLOB` column (checked this correction); probe scenario A20; owned by P4b | IMPLEMENTED — NOT VERIFIED |
| XC-11 | No silent drop of financial transactions; verification performed on data copies (§145) | Win+And | PARTIAL | REPORTED | NOT RUN | atomicity engine + scenario A2 (injected failure); data-copy practice is process, enforced at review; owned by P4b | PARTIAL |
| XC-12 | Database-file encryption out of V1 scope; no file-read-prevention claim (§55, §235, §146) | Win+And | n/a | n/a | n/a | ADR-003 rejects local-DB encryption for V1; `README.md:147-150` states the boundary; any change needs approval | NOT APPLICABLE (V1) |

### 4.14 Build, release, and platform acceptance

| ID | Requirement (spec §) | Platforms | Code | Test | Device | Evidence / Gap | Disposition |
|---|---|---|---|---|---|---|---|
| REL-01 | Fresh `npm run build` exits 0 (§141) | Win+And | PRESENT | UNVERIFIED | ABSENT | not run this review; unused-local inference | UNVERIFIED |
| REL-02 | Install & launch on Windows and Android as an installed app (§208) | Win+And | PRESENT | ABSENT | NOT RUN | prior APK `com.mshop.system` v0.1.0 (REPORTED); no launch evidence | UNVERIFIED |
| REL-03 | Windows offline operation, including selling (§209) | Windows-only | PRESENT | ABSENT | NOT RUN | none | UNVERIFIED |
| REL-04 | Full role/inventory/offline/backup/upgrade acceptance pass (§214) | Win+And | n/a | ABSENT | NOT RUN | no acceptance run recorded | UNVERIFIED |
| REL-05 | Hardware acceptance: camera (Android), USB reader (Windows), printer (§137, ADR-004) | Win+And | ABSENT | ABSENT | BLOCKED | no reader/printer; camera path spike-only; exercised per peripheral (camera Android, reader Windows, printer TBD) | BLOCKED |

> **Requirement count:** 91 traceable rows across 14 groups, counted as every
> `| ID-NN |` data row in the §4 group tables (PLAT 14, ID 8, PAT 3, CAT 7,
> INV 8, CUST 5, SALE 10, CASH 2, OPS 3, BAK 7, REP 3, MIG 4, XC 12, REL 5).
> Every normative capability in spec §22-35 and every success criterion §208-214
> has a row, as do the material subordinate clauses (§47, §55, §131, §140-141,
> §145-147, §155, §162, §178, §220, §227, §234-235). Governance-only constraints
> (§146 approval boundary, §136 no-sync-test rule) are enforced via §11 and the
> decision register rather than product rows, as stated there.
> Cross-cutting, security, money, offline, migration-safety, backup, and error
> handling are in §4.12-4.13.

## 5. Current-state evidence and known gaps

### 5.1 Evidence inherited from the original review (2026-10-15)

- **Repository state:** `git status --porcelain` = 156 entries (42 modified,
  12 deleted, 101 untracked, plus this file as the 156th entry from the same porcelain snapshot); branch
  `review/r1-bundle`; `HEAD = 7c8506a6…`. No destructive git action taken. This file remains untracked.
- **Migrations:** 11 files `0001`…`0011` present. The `0005` working-tree file
  SHA-384 **re-computed this review** = `d167c2d5c7459a0093dafb265967866bb0dab41
  504ac8c3063648bb85d1dfaafbff9a9877abfc5bcf1d04713973236b3`, identical to the
  device-recorded `v5`. The pulled snapshot (2026-10-09) records ledger
  `1,2,3,4,5,6,7` and `PRAGMA integrity_check = ok` **re-queried this review**.
  (The 1-4 and 6-7 checksum matches are inherited from the prior verification,
  not recomputed here.)
- **Pattern write:** the pulled snapshot (2026-10-09), **re-queried this
  review**, holds exactly one `manager_pattern` row (`epoch = 1`),
  `users = 1`, `sessions = 1`, `app_settings.pattern_required = 1`, and
  `audit_events` includes `pattern_set` (with `first_manager_created`,
  `login_succeeded`, department events).
- **Pins:** `tauri =2.12.0`, `sqlx =0.9.0`, `rust-version 1.98.1`,
  `rust-toolchain.toml channel = 1.98.1`, `Cargo.lock` present.
- **Frontend deps:** `package.json` = `vue 3.5.43`, `@tauri-apps/api 2.12.0`
  only; no Supabase.
- **Build-block inference:** `tsconfig.json:27` `noUnusedLocals: true`; build
  script `vue-tsc --noEmit && vite build`; `SalesPanel.vue:260` declares
  `showCancelReauth` with no reference.

**Provenance:** the `0005` recomputation, snapshot re-queries, pin readings, and
file observations above were performed once, during the original 2026-10-15
planning review. The F1–F15 correction and this targeted correction inherited
them verbatim — nothing in §5.1 was re-executed, upgraded, or re-queried here,
so all of it remains historical evidence, not fresh verification.

### 5.2 Reported but not independently verified

- Test counts and green results for every slice (Identity, lifecycle, catalogue,
  SP-1/SP-2, sales, backup). The most recent handoff reports: architecture 75,
  unit 123, lib 27, integration 228 (3 ignored), integration+recovery 242 —
  all on 2026-10-14, none re-run for this plan.
- A1 APK build (`com.mshop.system`, v0.1.0, minSdk 24, targetSdk 37) on
  2026-10-09.
- `SP-2 = IMPLEMENTATION VERIFIED BY REPORTED TESTS / DEVICE UNVERIFIED /
  DOCUMENTATION COMPLETE` — recorded by the Product Owner on the implementer's
  report, explicitly not independently inspected.

### 5.3 Known gaps and stale documents

| # | Location | Stale claim | Actual observed |
|---|---|---|---|
| C1 | `tasks/plan-sp2.md:23-24` | “no service layer, no tests” | `services/inventory`, costing tests exist |
| C2 | `tasks/plan-sp2.md:27-32` | Pattern-save device proof missing | snapshot shows `manager_pattern` + `pattern_set` |
| C3 | `tasks/plan-r1t5.md:3-5` | “nothing in this plan implemented” | `RecoveryPanel.vue` + `src/api/recovery.ts` exist; gated in `App.vue` |
| C4 | `README.md:13` | “no sales … code yet” | sales implemented (`commands/sales.rs`, `0011_sales.sql`) |
| C5 | `tasks/todo.md:47` | repo `0005` = `eff17a80…` | repo `0005` now = `d167c2d5…` = device |
| C6 | `tasks/todo.md:49-51` | “older build; bytes unrecoverable” | resolved: blob matches device for v5 |
| C7 | `docs/decisions/` | — | `ADR-005` does not exist |
| C8 | `README.md:172` | “Eight migrations … Eight tables” | 11 migration files `0001`…`0011` present; ≥10 tables |

**Absent capabilities (no code/table/command):** customer-records;
cash-reconciliation; shop-operations (repairs, expenses); reports; barcode
capture/generation/labels; product image; IMEI/Serial; supplier on receiving;
backup command/UI + startup recovery wiring; `tests/device/`.

## 6. Definition of Done and platform applicability

A requirement is **delivered** only when all applicable gates hold, each with a
cited evidence artifact:

1. **CODE** — present and wired into the real path (registered in `lib.rs` if a
   command).
2. **TEST** — present **and** a fresh run recorded green (not merely a file).
3. **DEVICE / RUNTIME** — observed **only where the Platforms column in §4
   requires it**, on the named platform(s), with saved evidence.

Platform applicability rule (spec §7):

- `Win+And` → both platforms must be exercised before the requirement is
  complete.
- `Android-only` → e.g. camera capture (CAT-05); Windows not required.
- `Windows-only` → e.g. offline core (REL-03) and USB reader (CAT-02).
- `Any (no device gate)` → platform-independent logic accepted via automated
  tests (e.g. money precision XC-01).
- A missing device/peripheral is a **blocker** for the affected criterion, never
  reported as a success.

## 7. Open decisions and schema design-freeze rules

### 7.1 Mandatory schema rules

- Any unresolved decision that changes a migration’s schema, constraints,
  relationships, or data semantics **must be resolved before that migration is
  written**. Recording it here does **not** authorize a guess.
- The implementer must **not** hard-code a schema default to “keep moving”.
- Phases are split so independent work can proceed **without** freezing
  unresolved behavior (see §8: P2a/P2b; CAT core vs hardware).

### 7.2 Decision register

| ID | Question | Normative source | Affected requirements / phases | Blocks? | If deferred | Rework risk | Required before |
|---|---|---|---|---|---|---|---|
| **D1** | Supplier name in simplified receiving | spec §29, §231; `0008:63` | INV-05, receiving schema, P4b | Yes (schema) | Receiving stays without supplier; **additive only if no receiving migration is committed first** | REWORK RISK | the receiving migration (P4b) |
| **D2** | Report / KPI definitions (`Total Sales`, `Net Profit`, cash semantics) | spec §181-188, §238 | REP-01..03, P8 | Yes (P8) | No effect on P0-P7 | SAFE TO DEFER (for P0-P7) | the reports slice |
| **D3** | Actual payment methods + receipt/label printer model | spec §233 | SALE-06, SALE-08, payment schema, P5 | Yes (schema) | Cash-only sale remains valid; **rework if sale/payment tables change first** | REWORK RISK | the payment/sale schema migration |
| **D4** | Warranty periods/terms by product type | spec §179, §236 | CUST-01 (warranty part), P4 | Partially | Rest of customer-records unaffected | SAFE TO DEFER (partial) | the warranty part of P4 |
| **D5** | Barcode label scope + printing hardware acceptance | spec §176, §237; ADR-004 | CAT-03, CAT-02 acceptance, P3 | Partially | Barcode capture stays BLOCKED; core catalogue unaffected | SAFE TO DEFER (partial) | label work, not catalogue |
| **D6** | Backup operational policy: trigger, retention, restore validation, integrity checks | spec §232; ADR-008, ADR-011 | BAK-07, P2b | Partially | P2a (engine wiring) proceeds without it | SAFE TO DEFER (P2b only) | P2b |
| **D7** | Damaged/non-resellable return accounting | spec §239; ADR-013 | SALE-07, returns schema, P5 | Yes (schema) | Returns deferred with it | REWORK RISK | the returns migration |
| **D8** | `product/` disposition | `tasks/todo.md:127`, ADR-008 | none in delivery | No | Untracked tree stays; not a base | SAFE TO DEFER | nothing in delivery |
| **D9** | Restore/locate `ADR-005` | `docs/decisions/` gap | none currently | No | No rule depends on it today | SAFE TO DEFER | nothing in delivery |
| **D10** | Backend/hosting scope (§234) | spec §234; ADR-008 | PLAT-07 | No | None in V1; recorded NOT APPLICABLE | SAFE (N/A) | nothing in delivery |
| **D11** | Backup KDF/crypto library choice (§235) | spec §235; ADR-003 | BAK-01 | No — RESOLVED | AEAD `XChaCha20-Poly1305` + KDF `Argon2id` parameters documented in ADR-003; engine implementation REPORTED, not re-verified | RESOLVED | nothing (implemented) |

## 8. Delivery phases and dependencies

> Phases are ordered by dependency, not by size. **Track B is independent and
> must not gate Track A.**

### Track A — verification-critical

| Phase | Objective | Entry conditions | Scope / deliverables | Platforms | Acceptance criteria | Exit evidence | Gates | Blockers |
|---|---|---|---|---|---|---|---|---|
| **P0 — Build enablement** | Make the tree build from current source | Owner approval to edit files | Resolve build blocker(s) only (e.g. the unused local) | Win+And (host build) | `npm run build` exits 0 | recorded build log | P1 | build result unverified |
| **P1 — Device verification baseline** | Establish the trusted device baseline | **P0 only** (not PA) | Build `com.mshop.system`; `adb install -r` (no wipe); confirm launch; `verify_pattern` round-trip; Pattern enable/disable/reset (PAT-03); TTL/epoch invalidation check (A22); record `0005` reopen | Win+And | app opens; Pattern accepts/rejects correctly; DB opens or documented outcome | P1 evidence bundle (§9.3) | P2a, P3-CAT, P4, P4b, P5 | device availability |
| **P2a — Backup engine wiring** | Make the existing mechanism reachable in-app | P0 | Tauri commands + UI + **startup recovery wiring** (`recover_interrupted`) | Win+And | create/restore from UI; fail-closed on wrong password; crash-recovery | command list + UI + device round-trip | P2b | none (mechanism exists) |
| **P2b — Backup operational policy** | Finalize operational backup behavior | P2a + **D6** | Snapshot trigger, retention, restore validation, integrity checks | Win+And | policy approved and exercised | policy doc + run | final gate | D6 |
| **P3 — Catalogue completion** | Close catalogue gaps | P1; **D5** for labels | Product image (CAT-05, Android capture); IMEI/Serial (CAT-04); labels (CAT-03) | Win+And (+Android camera, +Windows USB) | per-requirement DoD | image/serial/label evidence | P5 | D5, hardware |
| **P4 — Customer records** | Build customer file + links | P0 (`+D4` for warranty) | CUST-01..03, CUST-05; sale link in-phase; IMEI link completes with P3, repair link with P7 | Win+And | customer core + no-merge; sales-user field entry, no history browse | integration + device | P5, P7 | D4 (warranty part) |
| **P4b — Inventory completion** | Complete + verify the inventory slice | P1; **D1** before the receiving migration | INV-01..08; receiving migration with supplier (post-D1); stocktake/adjustment; ID-04 archival verification; XC-10 schema probe; XC-11 no-drop | Win+And | receiving with supplier; stocktake path; guarded cost-switch; ledger rebuild | integration + schema probe | P5, P7 | D1 |
| **P5 — Sales completion** | Complete POS | P4 + P4b + **D3** (and **D7** before returns migration) | Returns (SALE-07), payment methods (SALE-06), customer link, receipt (SALE-08), retry idempotency (SALE-04) | Win+And | full sale/return/payment DoD | integration + device | P6, P7 | D3, D7 |
| **P6 — Cash reconciliation** | Shifts + drawer reconciliation | P5 | CASH-01..02 | Win+And | open/close shift; reconcile vs cash sales | integration + device | P7, P8 | none |
| **P7 — Shop operations** | Repairs + expenses + audit breadth | P5 + P4b + P4 | OPS-01..03 + customer-repair/IMEI link completion + ID-08 operational breadth | Win+And | repair/expense records linked to IMEI/customer | integration + device | P8 | none |
| **P8 — Reports** | Metrics/reports | P5/P6/P7 + **D2** | REP-01..03 | Any (no device gate) | each metric has explicit written semantics; consistency with records | integration + role restrictions | final gate | D2 |
| **P9 — Platform acceptance** | Full-system acceptance | P0-P8 (including P4b) | §9 scenarios on both platforms | Win+And | every applicable §208-214 criterion passes | acceptance evidence bundle | final gate | hardware (REL-05) |

### Track B — administrative (independent)

| Phase | Objective | Entry | Work | Exit | Note |
|---|---|---|---|---|---|
| **PA — Repository & documentation baseline** | Make `HEAD` buildable and the tree clean | Owner approval | `.gitattributes` (`*.sql eol=lf`); commit frontend toolchain; commit backend slices; `.gitignore` logs/evidence; re-baseline `README` | `HEAD` buildable; untracked source committed; README reflects sales/backup | **Must not gate P1** |

**Phase separation rules applied:** catalog core (CAT-01/06) is separate from
hardware/printing/image (CAT-02/03/05); backup engine (P2a) is separate from
policy (P2b); schema-affecting decisions (D1/D3/D7) gate their migrations, not
whole phases.

## 9. Acceptance coverage map and scenarios

### 9.1 Specification success-criteria → scenario map

| Spec id | Criterion | Scenarios |
|---|---|---|
| §208 | installed app on Windows + Android | A0 |
| §209 | Windows works offline incl. selling | A5 |
| §210 | sales cannot reach wholesale/admin; tested at app/data layer | A3, A4, A16 |
| §211 | barcode search + optional IMEI/Serial + main image | A10, A17, A18 |
| §212 | no lost/duplicated deferred transactions on retry; stock conflict visible | A13, A14 |
| §213 | import local backup (data + image) to another device, integrity + links verified | A7, A15 |
| §214 | role/inventory/offline/backup/upgrade tests pass | A1-A9, A13, A16 |
| §138 | financial atomicity (cross-cutting) | A2 |
| §139 | currency precision (cross-cutting) | A12 |
| §140/§155 | each device on an independent local SQLite; per-device offline acceptance | A19, A5, A6 |
| §220 | no images/large fields in the DB | A20 |
| §178 | customer no-merge; explicit linking only | A21 |
| ADR-014 | Pattern TTL expiry + epoch invalidation | A22 |
| §89-98/ADR-013/015 | costing-method switch + FIFO authority rule | A23, A24 |
| §175 | opening balance before first sale | A25 |
| §31 | cancellation reversal + audit trail | A26 |
| ADR-009 | session persistence across restart | A27 |
| ADR-009/XC-04 | secure-store-unavailable fail-closed | A28 |

### 9.2 Scenarios

> Windows **and** Android unless the Platforms note says otherwise. “Test
> evidence” is the automated-test artifact and result; “Device evidence” is the
> observed on-device/runtime artifact. The two are tracked separately: a test
> result never stands in for a device observation.

| # | Scenario (requirement refs) | Platforms | Preconditions + test data | Steps | Expected | Negative cases | Test evidence / status | Device evidence / status |
|---|---|---|---|---|---|---|---|---|
| A0 | Install & launch (PLAT-01, §208) | Win+And | signed per-OS build; package id `com.mshop.system`; version recorded | install; launch | opens as an installed app, no browser | unsigned/incompatible build refused | n/a (manual install) | per-OS screenshot + package id/version — NOT RUN |
| A1 | Atomic sale deducts stock (SALE-01, §214) | Win+And | product `SKU-TEST-001`, on-hand 10 | sell 2 units; read position before/after | one invoice + 1 line + 1 movement commit; position 10→8 | concurrent oversell handled without partial write | integration sales output — REPORTED | DB pull (`stock_levels`, `stock_movements`) + invoice — NOT RUN |
| A2 | Injected failure leaves no partial sale (SALE-01, XC-11, §138) | Win+And | sandbox DB; product `SKU-TEST-001`, on-hand 10 | begin sale of 2; force failure after line insert, before movement | no invoice row, no movement row; position stays 10 | partial write refused | integration sales atomicity output — REPORTED | DB state probe — NOT RUN |
| A3 | Sales role refused at data layer (ID-02, §210) | Win+And | authenticated sales session | invoke a manager-only command (e.g. `create_user`) directly | refused by Rust; audit entry written | UI-hidden but direct invoke also refused | authority test output — REPORTED | command result + audit row — NOT RUN |
| A4 | Wholesale/cost not returned to sales (SALE-03, §210) | Win+And | authenticated sales session; product with set cost | fetch product/sale payload | no cost/wholesale/profit fields present | fields omitted, not zero-substituted | authority test output — REPORTED | payload capture — NOT RUN |
| A5 | Offline sale, Windows (REL-03, PLAT-12, §209) | Windows-only | installed Windows build; network disconnected; product `SKU-TEST-001` in stock | sell 1 unit | succeeds locally; position decremented | — | n/a (manual) | screenshot + DB pull — NOT RUN |
| A6 | Offline sale, Android (PLAT-12, §161) | Android-only | installed Android build; airplane mode; product `SKU-TEST-001` in stock | sell 1 unit | succeeds locally; position decremented | — | n/a (manual) | screenshot + logcat + DB pull — NOT RUN |
| A7 | Backup create + restore to another device (BAK-01, §213) | Win+And | P2a complete; bundle from device 1 + manager password | create bundle; record hash; restore on device 2 | data + images restored; integrity + links verified | wrong password/tamper refuse, nothing written | ABSENT (no command/UI yet) | bundle hash + restored DB pull — BLOCKED (missing impl; BAK-05) |
| A8 | Backup fail-closed (BAK-02) | Win+And | valid bundle + wrong password; tampered copy; truncated copy | attempt restore with each | refused; target DB byte-identical | truncation/unsafe path refused | backup fail-closed tests output — REPORTED | error code + unchanged DB — NOT RUN |
| A9 | Migration upgrade on populated DB (MIG-02, §214) | Win+And | older-chain populated DB (3 synthetic products, per desktop test) | open with current build | forward-applies; all rows survive | tamper detected, not repaired | `migration_backward_compat` output — REPORTED | upgraded DB row check — NOT RUN |
| A10 | Barcode search (CAT-02, §211) | Win+And | product with barcode `622100000001` | scan/type the code | exact product returned | unknown code handled gracefully | ABSENT (no lookup path) | screen + DB row — BLOCKED (missing impl; hardware) |
| A11 | `0005` device reopen (MIG-03) | Android-only | pulled device DB copy (ledger 1-7, `integrity_check = ok`) | open with current build | opens without “modified” refusal, or documented outcome | — | n/a (manual) | app log + exit state — NOT RUN |
| A12 | Currency precision (XC-01/02, §139) | Win+And | amounts 0, 1, 100, 10050 (=100.50 EGP), `i64::MAX`; Rust↔WebView round-trip | store + round-trip each amount | INTEGER minor units; no `REAL`/`f64`; lossless | overflow → `COST_OVERFLOW` | money boundary tests output — REPORTED | column-type probe + round-trip capture — NOT RUN |
| A13 | Stock conflict visible (INV-06, §212) | Win+And | product on-hand 1 | attempt sale of 2 | clear in-device conflict; quantity stays 1 | `COST_INSUFFICIENT_STOCK`; no negative stock | raw-SQL conflict test output — REPORTED | error + DB state — NOT RUN |
| A14 | Retry does not duplicate (SALE-04, §212) | Win+And | completed sale with reference `R-0001` (exactly 1 invoice row) | repeat submit with the same reference | still 1 invoice row; second submit refused | `SALE_REFERENCE_CONFLICT` | retry test output — REPORTED | DB row count + code — NOT RUN |
| A15 | Restore images + placeholder (BAK-04, §213) | Win+And | bundle containing 2 product images (needs CAT-05) | restore; open product whose local image is absent | images restored; placeholder shown for the absent one | missing image → default, no crash | ABSENT (no UI/image module) | screen + `files/photos` listing — BLOCKED (missing impl; CAT-05) |
| A16 | Permission matrix at data layer (ID-02/03, §210) | Win+And | authenticated sales session | attempt manage-users, catalogue write, inventory write, sale cancel, cost read | each refused by Rust with its code; audit entries | refusals carry distinct codes | authority matrix tests output — REPORTED | command results + audit — NOT RUN |
| A17 | IMEI/Serial tracking (CAT-04, §211) | Win+And | serialized product; unit IMEI `356938035643250` | record unit sale; attempt the same id twice | id recorded once; duplicate refused | duplicate-id error code | ABSENT (no serial tables) | DB row + code — BLOCKED (missing impl; P3) |
| A18 | Product image capture (CAT-05, §211) | Android-only | Android device camera; product `P-001` | capture/choose; save | file under local photos dir; record holds reference only | cancel → no file, no reference | ABSENT (no image module) | file listing + DB row — BLOCKED (missing impl; P3) |
| A19 | Per-device independent DB (PLAT-12, §140/§155) | Win+And | two devices (or device + wiped reinstall); first-run setup on each | set up manager per device; create product `DB-ONLY-1` on device 1 only; pull both DBs | each device has its own `shop.db`; product exists only on device 1; no shared state | — | n/a (design property) | both DB pulls + row diff — NOT RUN |
| A20 | Schema probe: no image/BLOB columns; money INTEGER-only (XC-10, XC-01, §220/§139) | Any (no device gate) | current source tree + migrated DB | grep migrations for `BLOB`; `PRAGMA table_info` per table; check money column affinity | no `BLOB`/image column; money columns `INTEGER` | — | probe output — NOT RUN (no probe test file) | n/a |
| A21 | Customer no-merge + explicit link (CUST-05, §178) | Win+And | P4 complete; names `Ahmed Hassan` vs `Ahmed H.`; one unlinked sale | create both customers; link one explicitly; query | two separate records; only the chosen one linked; unlinked sale keeps text snapshot | similar-name auto-merge refused | customer tests output — NOT RUN (no impl) | DB rows + link state — NOT RUN |
| A22 | Pattern TTL expiry + epoch invalidation (PAT-01, PAT-02) | Win+And | Pattern enabled (`pattern_required=1`); approval obtained at T0 for a sensitive op | attempt the approved op at T0+6min; reset Pattern (epoch bump), then retry with the pre-reset approval | late attempt refused as stale; post-reset approval refused on epoch mismatch; no op executes on either refusal | expired approval accepted; pre-reset approval accepted after reset | pattern tests output — REPORTED; TTL/epoch case coverage not confirmed | command results + codes — NOT RUN |
| A23 | Costing-method switch converts stock (INV-07) | Win+And | department `D-SWITCH` (`moving_average`); product on-hand 10, `total_cost_minor=10050`; manager session + reauth + Pattern | switch department to `fifo`; post new receipt; attempt direct `cost_method` edit and non-manager switch | stock converted per ADR-013/015; new postings follow `fifo`; `department_updated` audited | direct edit refused; non-manager switch refused | costing tests output — REPORTED; switch-case coverage not confirmed | DB layers + audit — NOT RUN |
| A24 | FIFO consumption order + authority rule (INV-03) | Win+And | `fifo` department; two layers for one product with equal `received_at`, ids `L1<L2`; on-hand covers a 3-unit sale | sell 3 units spanning both layers | oldest-first by (`received_at`, `id`); layers own the cost and `total_cost_minor` stays `NULL` | `STOCK_COST_AUTHORITY_CONFLICT` on dual representation | costing tests output — REPORTED; tie-break case not confirmed | layer rows + position — NOT RUN |
| A25 | Opening balance before first sale (INV-04, §175) | Win+And | quantity-tracked product `P-OPEN` with no balance and no movements | attempt sale of 1 (expect refusal); record opening balance 20 units; sell 1 | pre-balance sale refused with position unchanged; balance recorded as a movement (no invented quantities); post-balance sale succeeds | invented balance; sale consuming nonexistent stock | opening-balance tests output — REPORTED; pre-balance refusal case not confirmed | position + movements — NOT RUN |
| A26 | Cancellation writes reversal + audit (SALE-05, ID-08, §31) | Win+And | completed sale `S-0001` (manager session) | cancel `S-0001`; attempt a second cancel; attempt to edit the sale | reversal movement written; stock restored; second cancel refused (`SALE_ALREADY_CANCELLED`); both sale and cancel attributed in `audit_events` | edit path; double-cancel effect | cancellation tests output — REPORTED; audit-attribution case not confirmed | reversal rows + audit — NOT RUN |
| A27 | Session survives application restart (ID-01, ID-05, ADR-009) | Win+And | authenticated session (idle < 15min, absolute < 12h); plus one expired session row | restart the app; resolve both sessions | valid session resolves with same user/role; expired session purged, not resolved | expired session admitted; invented session | session tests output — REPORTED; restart case not confirmed | prior Identity-slice device run (session survived process death) — REPORTED, not re-verified; fresh run — NOT RUN |
| A28 | Secure store unavailable fails closed (ID-05, XC-04, ADR-009) | Win+And | OS credential store unreachable (harness-injected `KeyringTokenStore` failure) | attempt login, then attempt any authenticated command | fail closed with `SECURE_STORAGE_UNAVAILABLE`; no session created; no fallback store | weaker fallback invented; token cached outside the store | credential tests output — REPORTED; unavailability case not confirmed | refusal codes — NOT RUN |

### 9.3 P1 exit bundle

Build log (`com.mshop.system`, version) · `adb install -r` log · app-open
screenshot · `verify_pattern` accept + reject evidence (PAT-02) · Pattern
enable/disable/reset check (PAT-03) · TTL/epoch check (A22) · A11 result.

**Coverage statement:** all 91 requirement rows in §4 map to a scenario (A0-A28)
or carry an explicit disposition (`BLOCKED` / `MISSING` / `NOT APPLICABLE` /
`NEEDS PRODUCT OWNER DECISION` / `PARTIAL` with a named owner). Test evidence
and device evidence are tracked in separate columns; a test result never clears
a device observation. Governance-only constraints (§146 approval boundary, §136
no-sync-test rule) are enforced via §11 and the decision register, not product
rows. Acceptance coverage is **not** declared complete while any row is
`UNVERIFIED`, `NOT RUN`, `BLOCKED`, `MISSING`, `PARTIAL`, or `NEEDS PRODUCT
OWNER DECISION` — except through the waiver rule in §10, which never applies to
mandatory §208-214 criteria without an explicit scope/specification decision.

## 10. Final delivery gate

The system is **ready for delivery** only when **all** hold:

1. Every applicable normative requirement has a **traceable disposition** and no
   row in §4 is left `UNVERIFIED` or `NOT RUN` unless **both** hold: (a) it is a
   non-blocking limitation explicitly accepted by the Product Owner, and (b) it
   is **not** a mandatory §208-214 criterion. A mandatory criterion is cleared
   only by a passing result with cited evidence — never by documentation alone.
2. Every mandatory **CODE**, **TEST**, and **DEVICE/RUNTIME** gate is satisfied
   with a cited artifact.
3. Required tests have **fresh recorded results** (executed, with logs).
4. Required platform-specific checks carry evidence for their platform.
5. Required **backup/restore** (A7, A8, A15) and **migration** (A9, A11)
   scenarios pass.
6. Security (ID-02, A3, A4, A16, XC-04), authorization, and financial
   correctness (A1, A2, A12) requirements are satisfied.
7. **No unresolved blocking** Product Owner decisions remain (D1, D3, D7 and any
   raised later; D10 is recorded N/A and D11 is resolved, so neither blocks).
8. No critical defect is hidden by a stale status document (see §5.3 C1-C8).
9. Release artifacts and handoff evidence are available.
10. Any remaining **non-blocking** limitation is explicitly documented and
   accepted by the Product Owner. **Waiver of a mandatory §208-214 criterion
   requires an explicit Product Owner scope/specification decision recorded in
   §7.2; the implementer must not decide it.**

Readiness is **not** “all tasks attempted”; it is “acceptance criteria passed and
evidenced”. The gate is derived from §4, not from new conditions.

## 11. Execution authority and change log

**After this planning task:** the plan enables a subsequent implementation task
in which the implementer may choose reasonable **secondary** implementation
details within the approved scope. The implementer must **stop and seek the
Product Owner** before changing **architecture, scope, product behavior, or data
interpretation** — especially any decision affecting schema or persisted data
semantics (`docs/PROJECT_INSTRUCTIONS.md` §1, §3).

This planning task does **not** authorize implementation.

**Standing approval boundary (spec §146):** the following always require Product
Owner approval before implementation — procurement scope (D1), local-DB
encryption or any file-read-prevention claim (XC-12), any change to roles or
cost/wholesale visibility (ID-02, SALE-03), and any sync or future-architecture
decision (D10). The §136 no-sync-test rule follows from PLAT-07 (there is no
sync engine to test).

| Date | Change | Evidence |
|---|---|---|
| 2026-10-15 | Created | read-only review; see §5 |
| 2026-10-15 | Corrected per independent audit F1–F15 (91 rows; P4b; gate rewrite) | read-only correction; no other file touched |
