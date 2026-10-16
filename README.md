# Mobile Shop System

Offline-first point-of-sale for a mobile shop. Tauri 2 + Vue 3 + SQLite, with
Android and Windows both acting as full POS clients, each owning its own local
database.

> **Status: Identity + Identity lifecycle + Product catalogue + Authority & settings (SP-1) + Inventory & costing (SP-2) slices.**
> Accounts, sessions, roles, the login flow, password management, user
> administration, the product identity catalogue, department classification,
> device settings and the Pattern step-up approval are implemented and tested.
> **Moving Average and FIFO costing are now implemented too**: stock positions,
> FIFO cost layers, receiving and consumption, and the costing-method switch.
> The sales slice is also implemented: atomic invoice + lines + stock + cost +
> ledger + audit with line-level cost snapshots (`commands/sales.rs`,
> `migrations/0011`, `SalesPanel.vue`). Receipt documents and barcode capture
> are still absent. See
> [Current scope](#current-scope).
>
> **Verification status differs by slice, and the difference is deliberate.** The
> Identity slice is verified on the physical SM-N976N. The Product catalogue and
> the Authority & settings slice are verified on desktop only; their Android runs
> are recorded as not done, for reasons that have nothing to do with the slice
> code. **SP-2 is verified by the reported test suite only — its device
> verification has not been run, and no Android behaviour is claimed for it.**
> See [Hardware verification](#hardware-verification).

---

## Requirements

| Tool | Version | Notes |
|---|---|---|
| Rust | `1.98.1` | pinned by `rust-toolchain.toml`; do not override |
| Node.js | 24+ | `npm` must be on `PATH` |
| Visual Studio Build Tools | 2022 or newer | **required on Windows** — see below |
| Android SDK + NDK | NDK `28.2.13676358` | `platforms/android-37`, `build-tools/36.0.0` |
| JDK | 17 | Gradle requirement |

`rust-toolchain.toml` pins exactly two targets:

```text
aarch64-linux-android
x86_64-pc-windows-msvc
```

## The MSVC prerequisite

Cargo compiles build scripts for the **host**, so an Android build still needs the
MSVC linker. Without this you get:

```text
error: linker `link.exe` not found
```

`vcvars64.bat` must be loaded before any cargo command. `scripts/android-build.ps1`
does this for you. For a manual cargo command, run it inside a shell that has
already sourced `vcvars64.bat`.

## Commands

Run from the repository root unless noted.

> **Set `CARGO_TARGET_DIR` for desktop cargo commands too.** By default cargo
> writes to `src-tauri/target`, which is on `C:`. After the identity slice that
> directory reached **7.49 GB** and left `C:` with roughly 2 GB free. Building on
> `E:` keeps the two drives separate:
>
> ```powershell
> $env:CARGO_TARGET_DIR = 'E:\Rust\targets'
> ```
>
> `scripts/android-build.ps1` sets this automatically for Android builds; a bare
> `cargo test` does not.

```bash
# Rust
cd src-tauri
cargo build --lib                 # compile the library
cargo check                       # type-check without codegen
cargo test                        # 84 unit + 152 integration + 50 architecture tests
cd ..

# Frontend
npm install
npm run typecheck                 # vue-tsc --noEmit, strict
npm run build                     # typecheck + vite build -> dist/

# Android: build a debug APK
.\scripts\android-build.ps1 -Apk

# Android: build, then install on a connected device
.\scripts\android-build.ps1 -Apk -Device

# Android: provision the environment and exit without building
.\scripts\android-build.ps1 -Verify
```

### Test layout

| Path | Scope |
|---|---|
| `src-tauri/tests/unit/` | Domain rules only — no Tauri, no SQLite, no OS |
| `src-tauri/tests/integration/` | Real SQLite and the real service layer. No mock database |
| `src-tauri/tests/architecture/` | Invariants asserted against source text at compile time |

The architecture tests exist because some guarantees here are not runtime
behaviour. They fail **the build** if, for example, a command grows a token
parameter, `Session` gains a public constructor, or anything in `src/` mentions
`localStorage`.

## Build environment

Android builds write several gigabytes. On this machine the drives do not have
room on `D:`, so `scripts/android-build.ps1` redirects the heavy paths to `E:`
**for the build process only** — no `setx`, no registry writes, no change to your
machine's environment:

| Variable | Value | Why |
|---|---|---|
| `CARGO_TARGET_DIR` | `E:\Rust\targets` | ~5 GB of cargo artifacts |
| `GRADLE_USER_HOME` | `E:\Gradle` | Gradle cache and wrapper |
| `TEMP` / `TMP` | `E:\Rust\temp` | Gradle and NDK scratch space |
| `npm_config_cache` | `E:\Rust\npm-cache` | npm cache |

The Android SDK and NDK stay on `D:`; they are read-mostly.

`tools/npm.bat` exists because Gradle's Tauri plugin spawns the literal command
`npm.bat`, and Node 24 ships only `npm`, `npm.cmd` and `npm.ps1`. The shim is
project-owned and put on `PATH` for the build only — Node's own directory is
never modified.

## Security model

| Property | How |
|---|---|
| Passwords | Argon2id, PHC string, cost `m=19456 KiB, t=2, p=1` |
| Session token | 32 bytes from the OS CSPRNG, hex-encoded |
| Token storage | OS credential store only — Windows Credential Manager (`Local` persistence) / Android Keystore |
| Token in the database | `SHA-256(token)` only, never the token |
| Token in JavaScript | **Never.** No command accepts one; the frontend holds no credential |
| Session lifetime | 15 minutes idle, 12 hours absolute; idle never extends the absolute deadline |
| Lockout | 5 failed attempts → 15 minutes |
| Account enumeration | Unknown account and wrong password return the same error and cost the same Argon2 work |
| Wholesale data | Requires the `Manager` role **and** a `reauthenticated` session |
| Credential store down | **Fail closed.** No fallback exists by design |

The frontend receives `{ userId, displayName, role, assurance }` after login and
nothing else. Every later command resolves the session internally.

> **Threat model.** As recorded in `ADR-003` and `spec:55`: this does not protect
> the database file from someone who can read it directly, and does not claim to.
> The token digest is stored unencrypted for that reason. It does mean a stolen
> database yields no usable session.

## Architecture

```text
Vue ──▶ commands ──▶ services ──▶ domain ──▶ repositories ──▶ SQLite
        transport     orchestration  rules      SQLx lives here
        only          + keyring       only
```

- `domain/` depends on no Tauri, no SQLx, no SQLite, no operating system
- `commands/` are transport only: no SQL, no business rules, no `executeSql`
- `repositories/` are the only place SQLx appears
- `Session` has private fields and no public constructor, so `commands/` cannot
  fabricate one — only `Session::open`, which validates expiry

## Database

Each device owns one file. No shared database, no synchronisation, no server
(`ADR-008`). Migrations are forward-only; rollback means restore a backup then
fix forward, not run a `Down` script.

Eleven migrations (`0001`…`0011`), forward-only. Tables:

| Table | Migration | Purpose |
|---|---|---|
| `users` | `0001` | Accounts, Argon2id verifiers, lockout counters |
| `sessions` | `0001`, `0003` | Token digest, assurance level, Pattern approval, expiry |
| `audit_events` | `0001` | Every attributed operation: identity, catalogue, departments, settings, Pattern, stock |
| `products` | `0002`, `0005` | Product identity, disposition, department classification, prices |
| `user_credentials` | `0003` | Login identifier, forced-change flag |
| `departments` | `0004` | Product classification, plus its costing method and VAT defaults |
| `app_settings` | `0006` | Device defaults; `product_price_history` records every price transition |
| `manager_pattern` | `0007` | Exactly one row: a **verifier**, never the Pattern text, plus an epoch |
| `stock_levels` | `0008` | One stock counter per product (`product_id` alone, no location) |
| `fifo_layers` | `0008` | Cost layers, consumed oldest-first by `(received_at, id)` |
| `product_price_history` | `0006` | Every price transition, written in the same transaction as the change |
| `recovery_approval` | `0009` | One-time supervised manager-recovery approval (recovery builds only) |
| `recovery_attempt` | `0010` | Recovery attempts (recovery builds only) |
| `sales` | `0011` | Sale header: immutable monotonic reference, cancellation state |
| `sale_lines` | `0011` | Line snapshots: price/cost/profit at sale time, never recomputed |
| `stock_movements` | `0011` | Movement ledger: the rebuild source |
| `sale_reversals` | `0011` | Cancellation reversals; no edit, no double-cancel |

There are deliberately **no** `sync_outbox` or `sync_cursors` tables.

### The costing authority rule

A product's cost lives in exactly one place, decided by its department's
`cost_method`. Storing both would mean two sources of truth that drift; storing
one with no rule would leave a reader unable to tell which (`ADR-015`).

| `cost_method` | owns the cost | the other representation |
|---|---|---|
| `moving_average` | `stock_levels.total_cost_minor` | `fifo_layers` must be **empty** |
| `fifo` | `fifo_layers` | `total_cost_minor` must be **`NULL`** |

`NULL` is not zero: `NULL` means "the layers are in charge", and `0` would read as
free stock. `stock_levels.quantity` is the on-hand count under either method.

Rounding is **ceiling to the piastre at computation only**, intermediates are
`i128`, storage is integer minor units, and there is deliberately no remainder
column and no floating point anywhere in the money path (`ADR-013`, spec §10). A
product with **no department** follows the device default in
`app_settings.default_cost_method` rather than being refused or auto-classified.

## Dependencies

Pinned exactly in `Cargo.toml`; no automatic major/minor upgrades (`ADR-008`).

Licences were re-verified against the **actual resolved tree** on 2026-10-03 by
reading `license` out of each of the 436 crates' own `Cargo.toml` in the registry
cache. Every crate in the tree declared a licence; none was unreadable.

### Correction: the tree is not copyleft-free

An earlier note in this project claimed the dependency tree contained no
copyleft. **That was wrong**, and the full-tree check is what caught it.

| Crate | Version | Licence | Origin |
|---|---|---|---|
| `cssparser` | 0.37.0 | MPL-2.0 | transitive, via the Tauri webview stack |
| `cssparser-macros` | 0.7.1 | MPL-2.0 | transitive, via the Tauri webview stack |
| `selectors` | 0.38.0 | MPL-2.0 | transitive, via the Tauri webview stack |
| `dtoa-short` | 0.3.5 | MPL-2.0 | transitive |
| `option-ext` | 0.2.0 | MPL-2.0 | transitive |
| `r-efi` | 6.0.0 | MIT OR Apache-2.0 **OR** LGPL-2.1-or-later | transitive; permissively licensable |

These are **file-level** copyleft obligations, not per-derivative-work ones, and
they entered with Tauri in an earlier step, not with the identity slice. MPL-2.0
in a statically-linked dependency is ordinarily compatible with distributing a
proprietary application, but that is a legal judgement, not an engineering one,
and `spec:239` reserves licence review to the Product Owner.

**Every dependency added by the identity slice is permissively licensed:**

| Crate | Licence |
|---|---|
| `argon2`, `password-hash`, `phc`, `blake2` | MIT OR Apache-2.0 |
| `uuid` (v7), `sha2`, `digest`, `crypto-common` | MIT OR Apache-2.0 |
| `getrandom` | MIT OR Apache-2.0 |
| `keyring-core` | MIT OR Apache-2.0 |
| `windows-native-keyring-store` | MIT OR Apache-2.0 |
| `android-native-keyring-store` | MIT OR Apache-2.0 |
| `jni`, `ndk-context`, `log`, `regex`, `thiserror` | MIT OR Apache-2.0 |
| `byteorder` | Unlicense OR MIT |
| `windows-sys`, `zeroize`, `chrono` | MIT OR Apache-2.0 |
| `tempfile` (dev), `sqlx` | MIT OR Apache-2.0 |

Neither native keyring store pulls OpenSSL, which matters because the Android
cross-build is already sensitive to added build steps.

## Current scope

Implemented and tested:

- First-run setup creating the first manager, once, enforced transactionally
- Login by user picker plus password
- Sessions with idle and absolute expiry, resolved from the OS credential store
- Re-authentication to raise the assurance level
- Lockout after five failed attempts
- Audit trail
- Product catalogue: create, read, list, edit, archive, reactivate
- Sale price in piastres as an `INTEGER`, with `NULL` meaning "not set" and `0`
  meaning genuinely free (ADR-010)
- Disposition recorded as `quantity` or `serialized`, with no tracking yet
- Optional unique barcode, plus case-insensitive typed/pasted lookup
- Attribution (`created_by`, `updated_by`) taken from the resolved session
- Password change: own password, and a manager reset that forces a change at next
  sign-in. A forgotten password no longer bricks a device
- User administration: create, change role, disable/enable, change the login
  identifier. No user is ever deleted
- `username` as an independent, unique, normalised login identifier, with
  `display_name` left non-unique so two operators may share a name
- A broken `user_credentials` row is reported as `ACCOUNT_DATA_INTEGRITY_ERROR`
  rather than being hidden or defaulted. Login and session resolution refuse such
  an account; the management list still shows it, flagged
- Departments: create, edit, re-order, archive and restore, each with its own cost
  method and VAT. Classification only — no stock (SP-1b)
- Device settings: read and write the seven stored keys, every read and every write
  behind fresh re-authentication (`ManageSettings`). Unknown keys and malformed
  values are refused by the domain; a missing key reads as its default (SP-1b)
- Pattern step-up approval: set, prove, reset with the Manager password (the only
  recovery path) and disable. Approvals are five minutes, epoch-invalidated, and
  never leave an audit trace (`SP-1c`, `ADR-014`)
- Price history: changing a product's sale price writes the old and new value in
  the same transaction as the change itself (SP-1b)
- Stock and costing (SP-2): one stock counter per product, Moving Average and FIFO
  cost arithmetic with the ceiling rounding rule of `ADR-013`, receiving and
  consumption, and a costing-method switch that converts the stock that already
  exists rather than relabelling it
- Receiving a delivery is routine; declaring an opening balance and switching the
  costing method are sensitive and sit behind re-authentication and the Pattern
  (`ADR-015`)
- Insufficient stock refuses the whole operation: no partial consumption, and a
  negative balance is impossible at the storage layer
- Encrypted backup in-app (P2a, `ADR-003`): manager-only create/restore
  commands plus UI, crash-safe staged restore with startup recovery wiring
  (`recover_interrupted` before open, fail closed). Restore takes effect on
  manual restart — automatic restart and auto-close were decided against
- Customer file core (P4, `spec:178-179`): name plus one optional contact,
  never merged; explicit one-time sale links and free-text snapshots on
  unlinked sales, entered at invoice time in the sales panel. Browsing is
  manager-only; sellers create at invoice time.
  Warranty dates at sale time only (no preset periods)

Not started, and deliberately so:

| Item | Blocked on |
|---|---|
| Sale-line cost snapshot | Shipped with the sales slice: each line stores price/cost/profit at sale time, never recomputed (`sale_lines.unit_cost_minor`) |
| Customer returns at original cost | Later slice (needs decision D7: damaged/non-resellable accounting) |
| Movement ledger | Shipped with the sales slice (`stock_movements` in `migrations/0011`); stocktakes and adjustments stay a later slice |
| Sales recording and cancellation | Shipped (`record_sale` / `cancel_sale` with reversal, no double-cancel). Receipts and reports stay later slices |
| Serialised units, IMEI tracking | A later slice. `disposition` names the class; nothing tracks units yet |
| Suppliers, purchase orders, payables | Deferred by `spec` §231. Receiving is a unit cost and a quantity, not a procurement document |
| Barcode scanning, generation, label printing | BLOCKED in `ADR-008`. Needs hardware evidence. Typed and pasted lookup needs neither, so it shipped |
| Wholesale price | Deferred. A shop selling both retail and wholesale will need it |
| Rounding on weighted average, discounts, tax | OPEN. Settled in principle by the delivery specification (ceiling at each fractional piastre, `ADR-013`) but **not implemented** — SP-1 applies no rounding, and `spec:239` closes only when the costing engine lands |
| Synchronisation | Out of scope for V1 (`ADR-008`) |

### Schema foundation (SP-1)

Shipped in the `inventory-procurement` slice, deliberately without any costing
arithmetic. Full plan: `docs/superpowers/plans/2026-10-07-sp1-schema-foundation-plan.md`.

| Item | State |
|---|---|
| `departments` — product classification | Shipped. `migrations/0004` |
| Department is a **classification**, not a location | `ADR-012`. One stock counter per product |
| `one_off` as a third product disposition | Shipped. `spec:175`'s third class, in its own right rather than folded into `quantity` |
| `products.department_id`, `default_cost_minor`, `vat_rate_bp` | Shipped, all nullable, `NULL` for every pre-existing row. No invented data |
| `products` rebuilt atomically | Shipped in `0005` — no `PRAGMA`, no `-- no-transaction` |
| `Piastres` as the single money type | Shipped. `SalePrice` delegates rather than duplicating |
| `busy_timeout` on both pools | Shipped. 5 s |
| `departments.cost_method` (`moving_average` / `fifo`) | **Stored and inert.** No costing engine reads it yet — see `ADR-013` |
| Product classification moved from `catalog-media` to Inventory | `ADR-012`. Supersedes the catalogue slice's D6 deferral |

The ledger, cost layers, serialised units, purchasing and sales are **not** built.
Nothing in SP-1 computes a cost, a quantity or a tax amount.

`tests/architecture/main.rs` asserts that no cost or wholesale price column, no
category, no inventory or sync table exists, and that the sale price stays
nullable, so these boundaries cannot erode unnoticed.

---

### Authority & settings (SP-1b/c)

Shipped as one body on top of SP-1. Authority = who may run a sensitive
operation and under what freshly-proven conditions; settings = the device's
configuration store. Full plan:
`docs/superpowers/plans/2026-10-07-sp1bc-authority-settings-plan.md`.

| Item | State |
|---|---|
| `departments` CRUD, re-order, archive/restore | Shipped. Audited (`department_created` / `department_updated` / `department_archived`); archived rows refuse edits and re-ordering; restore audits as `department_updated` |
| Device settings: `read_settings` / `update_setting` | Shipped. Seven validated keys; unknown keys and malformed values refused; missing keys read as domain defaults |
| Blanket re-authentication for `ManageSettings` | Shipped — both read and every write (`DomainError::ReauthenticationRequired`) |
| Pattern approval (`pattern_set` / `pattern_reset`) | Shipped (`ADR-014`). The stored material never crosses the frontend; approvals are five minutes, epoch-invalidated, and deliberately un-audited |
| Price history in the catalogue path | Shipped — old and new price written in the same transaction as the price change |
| `migrations/0007` | Shipped. Two separate `ALTER TABLE` statements (SQLite rejects two clauses in one) |
| Frontend: Departments / Settings / Pattern panels | Shipped. `npm run typecheck` and `npm run build` exit 0; interaction on a real device is **not** evidenced — see below |

No inventory, costing, purchasing or sales logic was added here — the 
`departments.cost_method` column and the settings defaults stay inert until a
later slice reads them (`ADR-013`).

---

## Hardware verification

Verification is tracked per slice, because "it works" means different things for
a slice that has been on a phone and one that has not.

| Slice | Desktop | Physical SM-N976N |
|---|---|---|
| Identity | 94 tests | **Verified** - setup, login, logout, session survives process death, lockout, Android Keystore read/write |
| Migration `0003` | 154 tests | **Verified** - ran on the live device database, no crash, no migration error |
| Credentials backfill | 154 tests | **Verified** - the generated `user-01a10c02` is rendered by the login picker |
| Login picker username | 154 tests | **Verified** - `Peter - user-01a10c02 - manager` on screen |
| Product catalogue | 154 tests | **Blocked** - behaviour unverified; the Manager credential is unavailable, see below |
| Identity lifecycle behaviour | 154 tests | **Blocked** - behaviour unverified; the Manager credential is unavailable, see below |
| SP-1 Android build | 239 tests | **Verified** - debug APK built, `arm64-v8a`, `apksigner verify` clean |
| SP-1 install compatibility | 239 tests | **Verified** - signing certificate matches the installed app on all three digests; `versionCode` equal |
| SP-1 install / replace | 239 tests | **Verified** - `adb install -r` `Success`; app data preserved (`firstInstallTime` and `ceDataInode` unchanged) |
| SP-1 migration `0004` | 239 tests | **Verified** - applied on the live database; `departments` table present |
| SP-1 migration `0005` | 239 tests | **Verified** - applied on the live database; products rebuild committed; `_sqlx_migrations = 1..5` |
| SP-1 post-migration integrity | 239 tests | **Verified** - `integrity_check = ok`; schema, FKs and indexes as designed; `users`/`user_credentials`/`audit_events` unchanged |
| SP-1 UI / login behaviour | 239 tests | **Blocked** - Manager credential unavailable, as above |
| **SP-1 populated-products preservation** | 16 desktop tests | **UNVERIFIED** - the device held `products = 0`, so `0005` proves the rebuild runs and commits, **not** that it preserves existing rows on device |
| Authority & settings (SP-1b/c) - backend | 286 tests | **Not run** - no Android build, no install and no on-device migration (`0007`) this round |
| Authority & settings (SP-1b/c) - UI | 286 tests | **Blocked** - department/settings/pattern interaction unexercised; the Manager credential is unavailable and device operations were frozen for this round, see below |
| SP-1 device re-run - build and install | 286 tests | **Verified** - debug APK rebuilt from the current source (298 MB), clean uninstall + install, app launched with no crash and no `FATAL`/panic in logcat |
| SP-1 device re-run - migrations | 286 tests | **Verified** - all seven migrations applied from zero on a fresh `shop.db` (`users = 0`); schema byte-for-byte as `0006`/`0007` define it |
| SP-1 device re-run - departments | 286 tests | **Verified** - created `GroceryG1`, edited it, archived it and restored it, each with its own audit event |
| SP-1 device re-run - settings | 286 tests | **Verified** - the Manager re-authentication modal passed and the settings form loaded |
| SP-1 device re-run - Pattern **save** | 286 tests | **UNVERIFIED** - the UI form and button were reached, but the run was cut short by a timeout before the write. **No `manager_pattern` row and no `PATTERN_SET` event was observed**, so this is not claimed as a pass |
| Inventory & costing (SP-2) | 361 tests | **Not runnable** - the commands, the API client and the panel now exist, but no APK carrying them has been built, installed or run. Migration `0008` has never been applied on a device |

The Pattern save row is the one to read twice. Reaching the form and pressing the
button is not evidence that anything was stored; the only evidence that would
close it is a `manager_pattern` row and a `PATTERN_SET` audit event read back from
the device database. Neither exists yet, so the row stays unverified rather than
being folded into the passes above it.

The last two rows carry the distinction that matters most. A successful migration
is **not** evidence that data was preserved: with zero product rows, there was no
data to preserve. Populated-product preservation rests on the desktop tests alone,
which run the rebuild against a hand-built `0004`-state database holding three
synthetic products.

The last two are **blocked by credential availability, not by a defect**. That
distinction matters: a code fault and a missing test input both leave a slice
unverified on hardware, but only one of them is something to fix. The reason is
established rather than assumed - see [Verification credential policy](#verification-credential-policy).

### What the Product catalogue did reach on the device

The APK built and installed over the Identity build with data preserved, and the
incremental `0001 -> 0002` migration ran on a real Android SQLite file:

- `app-universal-debug.apk`, aarch64, `minSdk=24`
- install returned `Success`, `lastUpdateTime` advanced, app data preserved
- `shop.db-wal` grew to ~169 KB and `shop.db-shm` to 32 KB on first launch
- the app then served a working login screen, which required a successful query
  against the already-migrated database
- logcat carried no `FATAL`, no Rust panic and no SQLite error

So the migration path that desktop in-memory tests cannot exercise - applying
`0002` to a database that already has `0001` and a live account - does work on
hardware.

### Why the behaviour steps did not run

Catalogue steps 3-10 and every Identity lifecycle behaviour step require signing in
as the Manager. That account was created by hand on the device during the Identity
verification, and its password was never recorded anywhere - see
[Verification credential policy](#verification-credential-policy) below.

Note what the Identity lifecycle slice changed about this. At the time the
catalogue was closed, a forgotten password was unrecoverable in principle. It no
longer is: password change and a manager reset with a forced change at next
sign-in now exist. The blocker today is narrower and different in kind - **there is
no authenticated session to perform a reset from**, because establishing one
requires the password that was never recorded. The capability exists; the door to
it is not open.

**No catalogue or lifecycle code was reached on hardware.** Nothing here
contradicts the desktop result, and nothing here should be read as evidence that
either works on a phone.

### Identity lifecycle slice

Password management and user administration are implemented and verified on
desktop, and their `0003` migration is verified on hardware - see the table above.
Not yet verified on hardware:

- The forced-change screen and the re-authentication modal
- Creating a sales account on the device, which the device currently lacks
- Disabling and re-enabling an account on the device

The device has no second account, so the `Sales`-role paths are exercised on
desktop only. **No Android destructive operation was performed**: Peter's real
device data, audit trail and the `0001 -> 0002` migration evidence are untouched.

### A broken `user_credentials` invariant

Migration `0003` gives every account exactly one `user_credentials` row, and the
application never deletes one — there is no API that can produce the gap. It can
still arise from a manual edit, a partial restore, or corruption, and the wrong
response to it would be quiet and severe: defaulting the missing forced-change flag
to "not set" would issue a session that walks straight past the gate that confines
a manager-reset account to a single operation.

So a missing row is treated as what it is — an internal invariant violation:

| Surface | Behaviour |
|---|---|
| Login | Refused with `ACCOUNT_DATA_INTEGRITY_ERROR`; no token and no session row left behind |
| Session resolve | Refused; no `Session` can be built, so nothing can be authorised |
| Login picker | The whole call fails rather than returning a list with an account missing |
| User management | The account is still listed, flagged, with a placeholder identifier |
| Forced-change gate | Cannot be bypassed: a broken account is locked out, not admitted |

The error is deliberately its own code. Reusing `LOCAL_STORAGE_UNAVAILABLE` would
send a technician chasing a database outage that is not happening; reusing
`INVALID_CREDENTIALS` would tell an operator their password is wrong when it is not.

`tests/integration/credentials_integrity.rs` covers each surface by deleting a row
directly, and `tests/architecture/main.rs` guards the shape so the defaulting
cannot return.

---

## The database lives in three files, and `shop.db` alone can be stale

Discovered while verifying SP-1 on the device. It is recorded here because the
failure is **silent**: the wrong file still opens, still passes `integrity_check`,
and is simply older than you think.

**Where the database actually is.** `lib.rs` opens it at
`app.path().app_local_data_dir()` joined with `shop.db`, and on Android that is
the **app data directory root**:

```
/data/user/0/com.mshop.system/shop.db
```

**not** `databases/shop.db`. That directory exists and is empty. A procedure that
assumed otherwise reads a non-existent path and produces a **zero-byte file named
`shop.db`**.

**Before the migration** there was no `-wal` file, so `shop.db` was fully
self-contained and copying it alone was correct. **After `0004` and `0005` ran:**

```
shop.db       110592 bytes   ← unchanged; byte-identical to the pre-migration snapshot
shop.db-wal   111272 bytes   ← every byte the migrations wrote
shop.db-shm    32768 bytes
```

`am force-stop` is not a clean SQLite close. SQLite checkpoints and removes the
WAL only when the last connection closes normally; a force-stop skips that, so the
committed migration frames stay in `shop.db-wal`.

> **Rule: never treat `shop.db` alone as a valid snapshot while a `-wal` file
> exists.**

Copying it today yields a valid, `integrity_check`-clean file at migration `3`.
No error. No warning. Just an older database.

**Restore rule:** place `shop.db` and `shop.db-wal` together, **delete
`shop.db-shm`**, then open. `-shm` is the WAL index — derived, not data; SQLite
rebuilds it.

The accepted pre-`0005` recovery point (`E:\backups\shop-pre-0005\shop.db`) stays
**valid**: it was taken when no WAL existed, so it is self-contained.

Full reasoning, the alternatives rejected, and the restore procedure:
`docs/decisions/ADR-011-wal-aware-database-snapshot.md`.

### Two consequences

- **Backup and recovery completeness is a dependency, not a gap in this slice.**
  Inventory does not own backup. A durable online-backup capability belongs to
  the `local-backup` slice under `ADR-003`. Until that exists, device snapshots
  require the application to be stopped.
  **NEEDS FOLLOW-UP / DEPENDENCY** — the architecture decision is settled; what
  remains is implementing the capability.
- **No integration test exercises WAL.** `db.rs:72` opens the in-memory pool
  without a journal mode, and SQLite cannot use WAL on `:memory:`, so the suite
  runs on a rollback-journal database. WAL growth, checkpointing and the
  `-wal`/`-shm` lifecycle are untested there. Android hardware evidence covers it
  instead. File-backed WAL tests are deferred to the backup work rather than
  refactoring 100 unrelated tests.

---

## Verification credential policy

A hardware verification run needs credentials. Recording them is unavoidable; what
is decided here is **where they may live and what may be done to obtain them**.
No secret appears in this document, and none is to be added to it.

**The rules**

1. The first Manager password is created by the operator during first-run setup.
   It is never generated, seeded or chosen by the build.
2. A Manager password is **never stored in this repository**, in a plan, in a
   script, in a log or in a commit. Only its Argon2id verifier ever reaches
   storage, and that verifier does not leave the device's SQLite file.
3. Credentials used for a hardware run are **not a recovery mechanism**. A
   password recorded for testing does not become the answer to a lost device.
4. A hardware run needs its credential available **by a legitimate route before
   the run starts** - supplied by the operator at that moment, or set on a device
   provisioned for the purpose.
5. Losing a Manager password on a real device is **not** resolved in V1 by editing
   SQLite or by clearing application data. Both are out of scope: the first
   abandons the audit trail and every record attributed to the account, the second
   abandons the database entirely.
6. A Manager reset runs **only from an authenticated Manager session**, gated on
   `Permission::ManageUsers` and therefore on a freshly proven password.

**What this means in practice**

The recovery capability the Identity lifecycle slice added is real, and it is also
not reachable in the one situation where it would be wanted. A manager reset needs
a manager session; a manager session needs the password. So a device whose Manager
password is forgotten remains unadministrable in V1 - not because the software
lacks the feature, but because no unauthenticated entry point to it is permitted,
and permitting one would be a backdoor.

The gap this section closes is a **testing and operations gap**, not an
authentication design gap. The difference is worth preserving:

- The desktop suite proves the behaviour: `change_own_password` requires the
  current password, `manager_reset_password` forces a change at next sign-in, a
  reset revokes the target's sessions and not the manager's, and no credential
  material reaches the audit trail.
- What is unproven on hardware is the UI wiring of those flows - the
  re-authentication modal, the forced-change screen and the management buttons.
  That is presentation, not a security boundary.

**For the next hardware run**

Capture the credential in the plan before the run, not during it. A device
provisioned specifically for testing can have its Manager password set at
first-run by the operator, which is the intended route and needs no repository
change at all.

### Gaps this exposed, and their current status

| Gap | Status |
|---|---|
| No password-change or password-reset flow | **Closed in the software.** Password change, manager reset and the forced-change gate exist. See the credential policy above for why they are still unreachable without a password. |
| No staff-creation flow | **Closed.** `create_user`, role change, disable/enable and username change exist behind `ManageUsers`. |
| Verification credentials are not recorded anywhere | **Still open, and the sole blocker** for Android *behaviour* verification. It does not block migration or schema verification, which do not need a credential. See [Verification credential policy](#verification-credential-policy). |
| `0005` preserving populated `products` on real Android | **UNVERIFIED.** The device held `products = 0`. Desktop tests are the evidence |
| Durable backup / recovery | **NEEDS FOLLOW-UP / DEPENDENCY** on the `local-backup` capability (`ADR-003`). See the WAL section above |
| WAL lifecycle in integration tests | **UNVERIFIED.** The in-memory pool cannot use WAL; device evidence covers it. Deferred to the backup work |
| `ADR-005` referenced by the superseded Historical Reference slice | **Still open.** The file was never created; the slice itself is out of scope under `ADR-007`. Pre-existing, unrelated to Inventory |
| Departments UI | **Not built.** The domain, repository and schema exist; no command, service or panel |
| No documented way to reach a Manager session on a device whose password is unknown | **Closed.** A manager reset exists, but it needs an authenticated manager session to run from. Combined with the row above, this means a forgotten password on a single-owner device is still unrecoverable in practice. |

Step 11 (`PERMISSION_DENIED` for a Sales role) is covered on desktop by
`a_user_without_catalogue_permission_is_refused`, which uses the real SQLite
repository and the real authentication and authorization path. It was not
exercised on device, and no failure and no architecture gap was found there.