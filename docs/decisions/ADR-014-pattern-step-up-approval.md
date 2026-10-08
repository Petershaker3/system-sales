# ADR-014: Pattern Approval (Step-Up Authorization)

**Status:** Accepted — Product Owner decision 2026-10-07 (SP-1b / SP-1c)

**Related:** `ADR-003` (local backup encryption), `ADR-010` (EGP / piastres), `ADR-012` (inventory schema)

## Context

The session authorization model (`Session::authorize`) uses three axes:

- `user_id` must be active (not disabled, has valid credentials)
- `role` must allow the `Permission`
- `assurance` must be `Reauthenticated` when the permission requires it

Several inventory operations (opening balance, adjustment, stocktake, department
transfer, management settings) involve either large amounts of inventory, a
change to the costing method, or a change to the default settings of a device.
Doing these with only the assurance that a login occurred at some point in the
past is not sufficient when the manager's session might have been established
hours ago.

Rather than inventing a separate login or requiring a full manager session on
every operation, the system uses a bounded second secret — the Pattern — that is
verified at the moment of a sensitive operation.

## Decision

A **Pattern** (step-up approval) is an optional second Manager-only
authorization mechanism.

- It does **not** replace authentication. The manager must already have a valid
  session (`Session::authorize`) to reach the operation.
- It does **not** replace `reauthentication`. Sensitive operations that require
  a freshly proven password remain so; Pattern is an **additional** layer, not
  rather than a reduction.
- It is **opt-in** at the device level through `ManageSettings`.
- When enabled (`Pattern` is configured), sensitive operations must have a fresh
  Pattern approval — not merely an old session — to proceed.

## Implementation

- `manager_pattern` table (`id INTEGER PRIMARY KEY CHECK (id = 1)`) holds a
  single `verifier` (Argon2id PHC string, via the existing `crypto` module,
  never the raw Pattern).
- `sessions` carries `pattern_approved_at` and `pattern_epoch` (added in
  `0007`).
- `pattern_epoch` is an integer starting at 1, incremented on every set/change/
  reset.
- A session's `authorize` checks the three axes, then a service-level
  `require_sensitivity(Sensitivity::Sensitive, pattern_required=true)` checks
  whether `(approved_at, epoch)` is fresh against `current_pattern_epoch`
  (read from the `manager_pattern` row) with a **5-minute TTL**.
- If `pattern_approved_at` is `None` or `epoch` differs from current, the
  operation is refused with `DomainError::PatternRequired` or
  `DomainError::PatternApprovalStale`.
- A `PatternRequired` is different from `PermissionDenied`: the permission is
  held; the authorization step that must accompany it is missing.

## Why not a blanket `requires_reauthenticated` entry

`Permission::requires_reauthenticated()` is a **blanket per-permission** rule
(see `domain/identity/role.rs`). Adding `ManageInventory`, `ManageDepartments`,
or `CancelTransaction` to this list would demand a password prompt for **every**
routine operation (e.g., receiving a carton) rather than only for sensitive ones.
The design separates them:

- Routine inventory operations need role + session only.
- Sensitive inventory operations need role + session + `Reauthenticated` +
  Pattern (if enabled).
- `ManageSettings` is blanket-sensitive (every settings change is sensitive),
  so it is in the blanket list.

## TTL and epoch design

`TTL = 5` minutes is a security parameter decided by the Product Owner.

- Starts when verification succeeds.
- Expires after exactly the TTL — no extension, no renewal on use.
- `epoch` invalidates without sweeping session rows.

This is the reason `pattern_approved_at` must remain `Option<Timestamp>`
rather than a `bool`: the distinction between "never approved" and "approved
and now expired" must survive for audit purposes.

## Reset / recovery

A forgotten Pattern is recovered only from an **authenticated Manager session**,
not by a backdoor, by editing SQLite, or by clearing data:

- The manager must re-authenticate.
- The manager must prove the current password (`manage_reset_password` or
  `change_own_password` pattern).
- Only then may the Pattern be reset or cleared.

No secret is stored: `manager_pattern` holds an Argon2id verifier, not the
Pattern text or a derived key.

## Boundary

- The `manager_pattern` table is not a `users` table; it is exactly one row.
- The `Pattern` mechanism is not a second login; it does not create a session.
- The `Pattern` mechanism is not a replacement for `Reauthenticated`; a session
  must pass both before reaching the Pattern check.

## Consequences

- **Positive:** Every sensitive inventory operation can now carry a bounded,
  revocable step-up that does not require an operator to enter a password on
  every carton.
- **Positive:** Changing the Pattern immediately invalidates all open approvals,
  with no sweep over `sessions`.
- **Limitation:** Integration tests of the Pattern mechanism require either
  injecting a verifier (possible through the existing `InMemoryTokenStore`
  harness) or a real device. The existing architecture tests assert that no
  `pattern` secret reaches `localStorage`; they remain sufficient for the
  mechanism's boundary.
- **Not in scope:** A backup/recovery procedure (`ADR-003`) that is not yet
  implemented is not changed by this decision; a `local-backup` slice must
  implement durable preservation independently.
- **Not replaced:** The `Permission` enum, the `Assurance` model, session
  expiry, and the audit model are unchanged. Only the authorization call
  site gains the fourth axis.

## References

- `docs/decisions/ADR-003-encrypted-local-backups.md` — the separate backup
  capability this authorization mechanism does not assume.
- `spec:138` — atomicity of database operations that include authorization.
- `spec:177` — attribution from the session, never the caller.
- `plan:151` — authorization is resolved at the session layer, not per command.
