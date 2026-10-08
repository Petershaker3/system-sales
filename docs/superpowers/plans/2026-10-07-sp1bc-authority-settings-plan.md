# SP-1b + SP-1c — Authority and Settings Foundation

> **For agentic workers:** execute this slice as **one body of work**. Stop only for
> a genuinely new architectural decision, something outside this scope, or a real
> blocker needing the Product Owner. A migration boundary is a technical seam, not
> a decision gate.

**Goal:** give the application the settings, classification-write and step-up
authority contracts that every later inventory operation depends on.

**Architecture:** unchanged. `Vue → Tauri commands → Services → Domain → Repositories → SQLite`.

**Tech Stack:** Tauri 2.12 · Rust 1.98.1 · SQLx 0.9 · SQLite (3.51.3) · Vue 3 · TypeScript strict

**Spec:** `docs/superpowers/specs/2026-09-28-mobile-shop-system.md` ·
`docs/decisions/ADR-011` · `ADR-012` · `ADR-013`

**Prerequisite:** SP-1a (`89292e3`) — schema foundation, `Piastres`, departments
domain + repository, 239 tests.

---

## Why this body of work, before the ledger

Three contracts have exactly one insertion point, and it is cheaper to install them
now than to retrofit them across every later inventory use case:

| Contract | Insertion point | Cost of deferring |
|---|---|---|
| `Sensitivity` + Pattern approval | `Session::authorize` — the one authorization decision point | Every later operation must be re-audited for Pattern wiring |
| Settings resolution | cost-method fallback for an unclassified product | The first cost calculation has no fallback |
| Department write path | the only way `0004` can be written | The table is currently unwritable from the application |

The ledger is deliberately **not** in this slice.

---

## Scope

### In

`0006` settings + price history · `0007` pattern · VAT/DiscountKind domain ·
`Sensitivity` + `PatternApproval` · settings and pattern services · department
service + commands · 4 new permissions · fourth authorization axis · audit events ·
`DepartmentsPanel` · `SettingsPanel` · `PatternPrompt` · `spec:239` clarification ·
tests + architecture guards · hardware verification if reached · state update

### Out

Inventory ledger · cost layers · moving average · FIFO · serialized units ·
purchasing · suppliers · sales · returns · VAT arithmetic · reports ·
anything not named above

---

## Task 1 — `0006_settings_and_price_history.sql`

```sql
CREATE TABLE app_settings (
    key        TEXT    PRIMARY KEY NOT NULL,
    value      TEXT    NOT NULL,
    -- SET NULL, not RESTRICT: a setting must survive the user who last changed
    -- it. Configuration is not attribution history.
    updated_by TEXT    REFERENCES users (id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE product_price_history (
    id              TEXT    PRIMARY KEY NOT NULL,
    product_id      TEXT    NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
    -- NULL is preserved rather than collapsed. A price can be "unset" before it
    -- is "set", and a history that cannot record the transition lies about it.
    old_price_minor INTEGER          CHECK (old_price_minor IS NULL OR old_price_minor >= 0),
    new_price_minor INTEGER          CHECK (new_price_minor IS NULL OR new_price_minor >= 0),
    actor_id        TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    occurred_at     INTEGER NOT NULL,
    -- Refuses a history row that records no change at all.
    CHECK (old_price_minor IS NOT new_price_minor)
);

CREATE INDEX idx_price_history_product
    ON product_price_history (product_id, occurred_at, id);
```

Purely additive. References `users` and `products` only; nothing references either
new table. No backfill.

## Task 2 — `0007_pattern.sql`

```sql
CREATE TABLE manager_pattern (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    -- Raw Pattern is NEVER stored. This is an Argon2id verifier in the same PHC
    -- format as a password, via the existing `crypto` module.
    verifier   TEXT    NOT NULL,
    -- Bumped on every set/change/reset. A session approval is valid only while
    -- its stored epoch equals this one, so changing the Pattern invalidates every
    -- open approval without a sweep.
    epoch      INTEGER NOT NULL DEFAULT 1 CHECK (epoch >= 1),
    updated_by TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

ALTER TABLE sessions ADD COLUMN pattern_approved_at INTEGER;
ALTER TABLE sessions ADD COLUMN pattern_epoch     INTEGER NOT NULL DEFAULT 0;
```

Both `ALTER`s are plain `ADD COLUMN` — no rebuild, no `PRAGMA`, no
`-- no-transaction`, because `sessions` has no incoming foreign key.

## Task 3 — settings domain

```rust
// domain/settings/mod.rs
pub enum DiscountKind { Money, Percentage }

pub struct SettingsSnapshot {
    pub default_cost_method: CostMethod,
    pub invoice_prefix: String,
    pub default_vat_enabled: bool,
    pub default_vat_rate_bp: Option<VatRate>,
    pub default_vat_inclusive: bool,
    pub max_discount_kind: DiscountKind,
    pub max_discount_value: u64,      // piastres, or basis points, per kind
}
```

Reads tolerate a missing key and return the domain default — a setting is
configuration, not an invariant, and a partially configured device must still open.
Writes validate by key type; an unrecognised key is refused rather than stored.

## Task 4 — `Sensitivity` and `PatternApproval`

```rust
// domain/identity/sensitivity.rs
pub enum Sensitivity { Routine, Sensitive }

impl Session {
    /// Fourth authorization axis.
    ///
    /// `pattern_required` comes from settings at call time, so the domain stays
    /// free of I/O. Pattern is deliberately NOT folded into
    /// `requires_reauthenticated()`: that is a blanket per-permission rule, and
    /// inventory is a mix — receiving a carton is routine, opening a balance is not.
    pub fn require_sensitivity(
        &self,
        sensitivity: Sensitivity,
        pattern_required: bool,
        now: Timestamp,
    ) -> Result<(), DomainError>
}
```

`Session` and `SessionFacts` gain `pattern_approved_at: Option<Timestamp>` and
`pattern_epoch: Option<i64>`, read from and written to `sessions`. This is the
precedent `change_own_password` already set — a check at a named operation rather
than a blanket rule.

**`PatternApproval`** carries `(approved_at, epoch)` and exposes
`is_fresh(now, current_epoch, ttl)`. Both conditions must hold: inside the TTL
window **and** epoch still current.

## Task 5 — permissions

Add `ManageInventory`, `ManageDepartments`, `ManageSettings`, `CancelTransaction`.
Manager receives all four; Sales remains `Sell` only.

| Permission | `requires_reauthenticated()`? | Why |
|---|---|---|
| `ManageSettings` | **Yes** — added to the blanket rule | Not a mix: every settings change is sensitive |
| `ManageInventory` | **No** | A mix. `require_sensitivity` per operation |
| `ManageDepartments` | **No** | Creating a department is routine; changing its cost method is not |
| `CancelTransaction` | **No** | Handled by `require_sensitivity` per `ADR`/spec |

## Task 6 — error codes (4 new)

`PATTERN_REQUIRED` · `PATTERN_APPROVAL_STALE` · `PATTERN_NOT_CONFIGURED` ·
`SETTING_UNKNOWN_KEY` — each with an Arabic message in `src/api/errors.ts`. The
Task-1 scanner picks the new domain sources up automatically; the reverse guard
fails the build if a code is missing on either side.

## Task 7 — audit events (6 new)

`DEPARTMENT_CREATED` · `DEPARTMENT_UPDATED` · `DEPARTMENT_ARCHIVED` ·
`SETTING_CHANGED` · `PATTERN_SET` · `PATTERN_RESET`

`PATTERN_VERIFIED` is **not** added: a successful Pattern entry is not a state
change, and logging every prompt would train the reader to ignore the log.

`audit_events.event_type` has no `CHECK` — established convention is convention-only.
An architecture guard asserts every `event::` constant is ASCII screaming-snake.

## Task 8 — department write path (closes the SP-1a gap)

`services/organisation/departments.rs` + `commands/departments.rs`: `create`,
`get`, `list`, `update`, `set_archived`, `reorder`. Each authorizes first, then
writes inside one transaction: domain mutation → repository write → audit → commit.

The repository already takes `&mut SqliteConnection`, so `&mut *tx` satisfies it
with **no repository change**.

## Task 9 — settings and pattern services

- `settings`: `read_snapshot`, `update(key, value)`
- `pattern`: `is_enabled` (from settings), `is_configured`, `set`, `verify`,
  `reset`, `disable`

`reset` follows the `change_own_password` precedent: Manager-only, after
re-authentication, requires the **Manager password** to be re-proved, and clears
the Pattern. A forgotten Pattern is therefore recoverable; nothing else is.

## Task 10 — price history in the catalogue path

§14 requires price history, and history that is not atomic with the price change
is worthless. The catalogue `update` use case therefore gains its **first
transaction**: `drop(conn)` → `pool.begin()` → product update → history insert →
commit.

**This is a deliberate change to an existing use case.** It is required by the
approved scope, and the identity slice already uses this exact pattern. The
`UNIQUE`-violation → `BarcodeAlreadyExists` mapping is preserved.

## Task 11 — frontend

`DepartmentsPanel.vue` · `SettingsPanel.vue` · `PatternPrompt.vue` ·
`src/api/{departments,settings,pattern}.ts`

**Prerequisite, and it is a real defect:** `.field`, `.hint` and `.error` are
defined only in `App.vue`'s `<style scoped>` block, so no child component's markup
receives them. Every new panel would render unstyled. Fix first, by moving those
rules to an unscoped block.

## Task 12 — documentation

- `spec:239` — annotate that rounding was closed by the delivery specification §10
  and recorded in `ADR-013`, mirroring the `spec:28` annotation for D2
- `README` — SP-1b/c scope rows, hardware evidence, status labels
- `domain/mod.rs` — the permitted coupling is no longer only `catalog → identity`;
  `catalog → organisation` is now second, and the comment must say so
- **`ADR-014` proposed** for the Pattern approval mechanism. Flagged for the
  Product Owner: a second approval mechanism is expensive to reverse and is
  ADR-shaped, but it was not in the approved deliverable list.

---

## Assumptions requiring confirmation

| # | Assumption | Value | Rationale |
|---|---|---|---|
| 1 | **Pattern approval TTL** | **5 minutes** | A step-up for one operation should not survive long. 5 minutes covers a form fill without outliving its purpose. **This is a security parameter and I am proposing it, not deciding it** |
| 2 | Invoice prefix default | empty | `2026-10-07-001`; the prefix is an addition, not a replacement |
| 3 | `max_discount_value` | `0` = no discount allowed | Fails closed |
| 4 | Missing setting key | returns the domain default | A device must open even partially configured |

---

## Testing

**Unit** — `Sensitivity` routing · `PatternApproval` freshness, epoch staleness,
boundary at exactly TTL · `SettingsSnapshot` defaults for every missing key ·
`DiscountKind` · `VatRate` on `Product`.

**Integration** — settings CRUD and default-on-missing · a price change writes
history **atomically**, and a forced failure leaves neither · history records
unset→set and set→unset transitions · Pattern set/verify/epoch-bump/reset ·
Pattern verifier never appears in `audit_events` · sessions round-trip the new
columns · department CRUD with audit · a Sales user is refused every new operation ·
`ManageSettings` requires re-authentication · `ManageInventory` does **not** blanket-
re-auth, proving the mix works.

**Architecture** — new commands take no token/role/actor · new services touch no
SQL · `pattern`/`verifier` never reaches the frontend · every `event::` constant
is ASCII screaming-snake · error-code drift passes both directions non-vacuously.

---

## Hardware verification

Only if the desktop suite is green, and **only after a separate explicit approval
per gate**, mirroring the SP-1a sequence.

**Before anything: a fresh pre-migration snapshot.** Per `ADR-011`, the device
database now has a live `-wal` and `-shm`, so `shop.db` alone is stale. The
snapshot **must** copy all three, with the app force-stopped and `pidof` confirmed
empty, then verify `integrity_check`, `_sqlx_migrations = 1..5`, and hashes.

`0006` and `0007` are purely additive — no rebuild, no `DROP`, no `RENAME` — so the
atomicity risk that made `0005` dangerous does not recur.

---

## Definition of done

1. Desktop suite green; SP-1a's 239 tests unmodified and still passing.
2. `npm run typecheck` and `npm run build` exit 0.
3. A department can be created, edited, ordered, archived and restored through the
   application — the first time `0004` is writable.
4. Price changes write history atomically.
5. Pattern can be set, verified, expired, invalidated by change, and reset.
6. `Session::require_sensitivity` unit-tested for every branch.
7. Every new error code has an Arabic message; both drift guards pass non-vacuously.
8. Architecture guards prove: no token/actor parameter, no SQL in services, no
   Pattern material in the frontend.
9. `spec:239` no longer contradicts `ADR-013`.
10. Hardware status recorded honestly — **UI remains BLOCKED on the Manager
    credential**, recorded as *implemented and automated-tested, device UI
    verification blocked*, never as verified.
11. Documentation and state updated.
12. No unrelated changes; no destructive device operation.

---

## Risks

| Risk | Severity | Handling |
|---|---|---|
| Adding a transaction to the catalogue `update` path changes existing behaviour | Medium | Required by §14. Identity slice uses the identical pattern. Existing catalogue tests must stay green untouched |
| Pattern TTL is wrong | Medium | **Assumption 1 — needs your confirmation** |
| Fourth authorization axis is checked inconsistently across services | High | One method on `Session`; services call it, never re-implement. Architecture guard |
| `manager_pattern` single-row invariant | Low | `CHECK (id = 1)` plus all accessors take no id argument |
| Foregetting the WAL when snapshotting | **High** | `ADR-011` makes it a written rule; snapshot step is a precondition of the gate |
| Scope creep into the ledger | Medium | Ledger is named as out of scope in this plan |