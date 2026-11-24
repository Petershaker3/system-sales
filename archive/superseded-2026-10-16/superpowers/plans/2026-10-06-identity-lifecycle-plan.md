# Identity Lifecycle — Design Plan

**Status: PERSISTED AND VALIDATED. No implementation authorised.**
**Date: 2026-10-06**
**Supersedes: nothing. Extends `2026-10-03-identity-slice-plan.md`.**

---

## 1. Why this slice exists

The Identity slice is verified on the physical SM-N976N. The Product catalogue
slice is verified on desktop only, because the hardware run was blocked: the
Manager account's password was created by hand during the Identity run, recorded
nowhere, and the app has no way to change or reset it.

A read-only audit of the Identity slice (`README.md`, "Hardware verification")
found that a forgotten Manager password **permanently bricks a device**. There is
no CLI, no backdoor and no second device to recover from, because every device
owns a local SQLite file and V1 has no server (`ADR-008`).

The audit also found a dead error code, `ACCOUNT_LOCKED_MANAGER_RESET_REQUIRED`,
whose Arabic text promises a manager reset that no code implements.

This slice closes both, and adds the user administration that `spec:17-18`
implies and the schema never provided.

---

## 2. Decisions taken (Product Owner, 2026-10-06)

| # | Decision | Value |
|---|---|---|
| D1 | Change own password | Yes |
| D2 | Manager resets another user's password | Yes |
| D3 | Reset sets `must_change_password` | `true` |
| D4 | Forced change gates the whole system | Only `ChangeOwnPassword` permitted until done |
| D5 | `ManageUsers` requires re-authentication | Yes |
| D6 | `display_name` unique | **No** |
| D7 | Login identifier | Independent `username`, unique |
| D8 | `username` backfill | `user-<8 hex>`, not a name slug |
| D9 | `username` changeable | Yes, Manager-only + re-authenticated |
| D10 | Delete users | **Never** |
| D11 | Disable / enable users | Yes |
| D12 | Last active Manager guard | Refuse |
| D13 | Reset revokes sessions | Target user's sessions only |
| D14 | Lockout | 15 minutes, automatic recovery. Manager unlock is **out of scope** |
| D15 | `LockoutThresholdReached` | **Delete entirely** |
| D16 | Minimum password length | 8, unchanged, centralised in `password_is_acceptable()` |
| D17 | Assurance after own-password change | Returns to `Normal` |
| D18 | Credential material in audit | **Forbidden** |
| D19 | `username` DB invariant | **`NOT NULL` + `UNIQUE`**, not merely domain-enforced |

---

## 3. The `username NOT NULL` problem — investigated, not assumed

D19 requires a database-level invariant. This section records what SQLite
actually permits, because the answer decides the migration's shape.

**Environment as built:** `sqlx 0.9.0` -> `libsqlite3-sys 0.37.0` -> bundled
**SQLite 3.51.3**. `db.rs` sets `.foreign_keys(true)` per connection, so foreign
keys are enforced. `sqlx::migrate!` wraps each migration in a DDL transaction
(`sqlx-core-0.9.0/src/migrate/migrate.rs:64`), **unless** the file begins with
`-- no-transaction` (`source.rs:233-234`).

Measured behaviour, against the project's real four-table schema:

| # | Question | Result |
|---|---|---|
| 1 | `ALTER TABLE ... ADD COLUMN x TEXT UNIQUE` | **Impossible.** `Cannot add a UNIQUE column` |
| 2 | `ADD COLUMN x TEXT NOT NULL` without a default | Accepted (but meaningless before backfill) |
| 3 | `ADD COLUMN x TEXT` then `CREATE UNIQUE INDEX` | Works; many NULLs coexist |
| 4 | `PRAGMA foreign_keys=OFF` **inside** a transaction | **Silently ignored** — still reports `1` |
| 5 | Table rebuild **inside** a transaction, FKs on | **Fails**: `FOREIGN KEY constraint failed` |
| 6 | Table rebuild with `PRAGMA foreign_keys=OFF` outside a transaction | **Succeeds.** All 4 tables keep their rows, `PRAGMA foreign_key_check` clean, all three FK intents preserved (`RESTRICT` on `products`, `CASCADE` on `sessions`, `SET NULL` on `audit_events`), and `NOT NULL UNIQUE` genuinely enforced |
| 7 | `username` in a separate table as `TEXT NOT NULL UNIQUE` | **Works**, no `ALTER`, no rebuild, no `PRAGMA` |

### 3.1 Consequences for the two options originally considered

- **`0003` backfill then `0004` constraint tightening does not work.** SQLite has
  no `ALTER COLUMN ... SET NOT NULL` and no `ADD CONSTRAINT`. Migration `0004`
  would still have to rebuild the table, so splitting into two migrations buys
  nothing but an extra step and a wider window in which `username` is nullable.
- **Rebuilding `users` inside `0003` is possible but hazardous.** It requires the
  `-- no-transaction` opt-out, which means **no rollback**. On a field device a
  crash between `DROP TABLE users` and `COMMIT` leaves the database half
  rebuilt. It also requires `PRAGMA foreign_keys=OFF`, and `foreign_keys` is a
  **per-connection** setting on a pool with `max_connections(4)`; if the
  migration ends without restoring it, a pooled connection can silently return to
  the application with foreign keys **off**, which would quietly disable the
  `ON DELETE RESTRICT` guarantee the catalogue relies on.

### 3.2 Recommendation: a separate `user_credentials` table

**Put `username` and `must_change_password` in their own table**, whose primary
purpose is to carry the constraints SQLite cannot add to `users`:

```sql
CREATE TABLE user_credentials (
    user_id               TEXT    PRIMARY KEY
                              REFERENCES users (id) ON DELETE CASCADE,
    username              TEXT    NOT NULL UNIQUE,
    must_change_password  INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1))
);
```

This satisfies D19 with a real `NOT NULL UNIQUE` table constraint, inside the
normal transactional migration, atomically, with no `ALTER`, no `PRAGMA`, no
`-- no-transaction`, and no risk of leaving foreign keys disabled.

It also matches the shape the codebase already uses: `sessions` holds
`assurance` separately from `users`, `users` holds `verifier` separately from
`sessions`, and `find_by_token_hash` already issues a second query to read the
role from `users`. One more narrow read is consistent, not novel.

`disabled_at` / `disabled_by` stay on `users`, because they are state about the
account rather than credentials, and because `disabled_by` is a self-reference
that reads more naturally there.

**The cost, stated plainly:** reading a username now costs one extra query or a
join. The catalogue repository already does exactly this kind of second query, so
the pattern is proven in this codebase.

**If the Product Owner prefers `username` to remain a column on `users`,** the
alternative is a single `-- no-transaction` migration performing the documented
SQLite rebuild, ending with `PRAGMA foreign_keys=ON`, plus a regression test that
asserts `PRAGMA foreign_keys` is still `1` on a pooled connection afterwards.
That path is workable but strictly more dangerous, and this plan recommends
against it.

---

## 4. Schema — `0003_identity_lifecycle.sql`

```sql
-- Migration 0003: user lifecycle.
--
-- Password management, user administration and the login identifier.
--
-- WHY A SEPARATE TABLE: SQLite cannot add a UNIQUE constraint with ALTER TABLE,
-- and cannot add NOT NULL to an existing column at all. `user_credentials`
-- carries both as real table constraints instead of leaving them optional in
-- `users` and hoping the domain remembers. See plan section 3.
--
-- NO DELETE PATH: a user is never deleted. `products.created_by` is
-- ON DELETE RESTRICT, so deleting a user who ever catalogued something would
-- fail anyway. Disabling is the lifecycle.

ALTER TABLE users ADD COLUMN disabled_at   INTEGER;
ALTER TABLE users ADD COLUMN disabled_by   TEXT REFERENCES users (id) ON DELETE RESTRICT;

CREATE TABLE user_credentials (
    user_id               TEXT    PRIMARY KEY
                              REFERENCES users (id) ON DELETE CASCADE,
    -- The login identifier. `display_name` is deliberately not unique
    -- (decision D6), so this is what distinguishes two operators who share a
    -- name in the picker.
    username              TEXT    NOT NULL UNIQUE,
    -- Decision D3: set by a manager reset, cleared by the forced change.
    must_change_password  INTEGER NOT NULL DEFAULT 0
                              CHECK (must_change_password IN (0, 1))
);

-- Backfill, ordered by id. UUID v7 is time-ordered (ADR-009), so this is
-- deterministic and replayable. `substr(id,1,8)` cannot collide.
INSERT INTO user_credentials (user_id, username, must_change_password)
SELECT id, 'user-' || substr(id, 1, 8), 0
FROM users;

CREATE INDEX idx_users_disabled ON users (disabled_at);
```

Notes:
- The backfill is one statement, ASCII-only, independent of `display_name` and of
  the operator's language (D8).
- `disabled_at INTEGER` is preferred over an `enabled BOOLEAN` because it records
  *when*, which the audit trail and any future "disabled since" report need.
- `disabled_by` is nullable: the first manager has no actor.

---

## 5. Domain

### 5.1 `Username`

A newtype over `String` in `domain/identity/user.rs`. Normalisation happens in the
constructor, never at the call site, so no caller can introduce a non-normalised
value.

- Trim, then lowercase.
- Reject empty, reject length outside 3..=32.
- Permit only ASCII alphanumerics and `.`, `_`, `-`.
- `parse` for the reverse direction.

### 5.2 `Permission`

Add:

- `ChangeOwnPassword` — **no role requirement and no re-authentication.** It must
  work at `Normal` assurance, otherwise the forced change (D4) is impossible: a
  user landing from a manager reset has only a fresh login, never a
  re-authentication. `Role::allows` must return `true` for both roles.

`ManageUsers` already exists and stays Manager-only.

### 5.3 Extract the assurance policy (do this first)

`Session::authorize` currently special-cases one permission inline:

```rust
if permission == Permission::ViewCostAndProfit
    && self.assurance != Assurance::Reauthenticated
```

D5 adds a second. Writing `== A || == B` grows a conditional inside the
authorisation function. Move the policy onto the permission:

```rust
impl Permission {
    /// Whether holding this permission requires a freshly proven password.
    pub fn requires_reauthenticated(self) -> bool {
        matches!(self, Permission::ViewCostAndProfit | Permission::ManageUsers)
    }
}
```

This is the first change in the slice, because everything else is verified
against it.

### 5.4 `SessionFacts` and `Session` gain two fields

- `must_change_password: bool`, read from `user_credentials` in the same place
  `find_by_token_hash` already reads `role` from `users`.
- `disabled_at: Option<Timestamp>`. `resolve` refuses a disabled user with
  `AccountDisabled`.

Reading them at resolve time — not caching them on the session row — is what makes
a disable or a role change take effect on the very next command. This mirrors the
existing, deliberate behaviour for `role` and must not be deviated from.

### 5.5 Three-axis `authorize`

```rust
pub fn authorize(&self, permission: Permission) -> Result<(), DomainError> {
    // A user who must change their password can do exactly one thing (D4).
    if self.must_change_password && permission != Permission::ChangeOwnPassword {
        return Err(DomainError::PasswordChangeRequired);
    }
    if !self.role.allows(permission) {
        return Err(DomainError::PermissionDenied);
    }
    if permission.requires_reauthenticated() && self.assurance != Assurance::Reauthenticated {
        return Err(DomainError::ReauthenticationRequired);
    }
    Ok(())
}
```

The first clause is what makes the forced change enforced at the
application/data layer as `spec:210` requires, rather than merely hidden in the
UI.

---

## 6. Repositories

### 6.1 `user_repo` additions

| Function | Purpose |
|---|---|
| `update_verifier(conn, id, phc, now)` | **Absent today. This is the brick-breaker.** |
| `set_disabled(conn, id, Option<Timestamp>, Option<UserId>, now)` | One write for disable/enable |
| `find_by_username(conn, &Username)` | Login and picker |
| `count_active_managers(conn)` | Backs the D12 guard |
| `find_credentials(conn, user_id)` | `must_change_password` |
| `set_username(conn, user_id, &Username, now)` | |
| `set_must_change_password(conn, user_id, bool, now)` | |

### 6.2 `user_repo` cleanup

`find_by_id` and `list` currently duplicate the same ~25 lines of row parsing.
Any new query adds a third copy. Extract one `row_to_user(row) -> Result<User,
sqlx::Error>` and have all callers use it. This is the same remedy already applied
in the catalogue repository.

### 6.3 `session_repo::delete_by_user` — required, not optional

`login` calls `delete_all` then inserts, so exactly one session row exists at any
moment. Using `delete_all` for a manager reset of *another* user **would destroy
the manager's own session mid-operation**.

`delete_by_user(conn, user_id)` deletes only rows whose `user_id` matches the
target, leaving the manager's session untouched. This is D13 and it has a
mandatory integration test (section 9).

### 6.4 New `credential_repo`

Owns `user_credentials`: `insert`, `find_by_user`, `find_by_username`,
`update_username`, `set_must_change_password`.

---

## 7. Services

### 7.1 `services/identity/password.rs`

```rust
pub async fn change_own_password(pool, tokens, current: &str, new: &str) -> ...
pub async fn manager_reset_password(pool, tokens, target: UserId, temporary: &str) -> ...
```

**`change_own_password`**
1. `authorize(ChangeOwnPassword)` — passes even while `must_change_password` is set.
2. Validate the new value with `password_is_acceptable` (D16). Never re-implement.
3. Verify `current` against the stored verifier. **Required** — otherwise a
   borrowed unlocked device could change the password.
4. Write the new verifier and clear `must_change_password`, in **one transaction**
   with the audit event.
5. Reset assurance to `Normal` (D17) via `session_repo::set_assurance`.
6. The current session stays valid. The operator just proved themselves; being
   ejected would be friction with no security gain.

**`manager_reset_password`**
1. `authorize(ManageUsers)` — role **and** re-authentication (D5).
2. Hash the temporary password, set `must_change_password = 1`.
3. `session_repo::delete_by_user(target)` (D13).
4. Audit `PASSWORD_RESET`, all in **one transaction**.

Neither ever returns, logs or audits the password.

### 7.2 `services/identity/users.rs`

```rust
pub async fn create_user(pool, session, display_name, username, role, password) -> ...
pub async fn change_role(pool, session, target, new_role) -> ...
pub async fn disable_user(pool, session, target) -> ...
pub async fn enable_user(pool, session, target) -> ...
pub async fn set_username(pool, session, target, username) -> ...
```

Every one requires `authorize(ManageUsers)`, so all five inherit D5. `username`
changes are therefore Manager-only; a Sales user may change only their own
password (D1) and never their own username (D9).

**`create_user` copies `bootstrap.rs` exactly:** validate, hash, then a single
transaction containing insert + credentials insert + audit. No count gate, but
the same atomicity.

**The D12 guard is mandatory.** `count_active_managers() <= 1` must refuse to
disable, with `CannotDisableLastManager`. There is no backdoor reset (D14), so
disabling the last Manager makes a device permanently unadministrable. Refusing
also applies to disabling oneself (`CannotDisableSelf`).

**`username` uniqueness** is enforced by the table constraint. The service
translates the driver error into `UsernameAlreadyExists`, mirroring how
`BarcodeAlreadyExists` is produced in the catalogue.

---

## 8. Commands, error codes, audit, frontend

### 8.1 Commands

`change_own_password`, `manager_reset_password`, `create_user`, `change_role`,
`disable_user`, `enable_user`, `set_username`, `list_users_for_management`.

None accepts a token, user id, role or actor from the frontend. The target is
chosen by the manager in the UI and arrives as an opaque id; the actor always
comes from the resolved `Session`. The existing architecture test covers every
command module and must be confirmed to include the new file.

### 8.2 Error codes

| Code | Reason |
|---|---|
| `PASSWORD_CHANGE_REQUIRED` | The forced-change gate (D4) |
| `ACCOUNT_DISABLED` | Distinct from `ACCOUNT_TEMPORARILY_LOCKED`: a disabled account is an administrative decision, a lock is a 15-minute timer |
| `USERNAME_ALREADY_EXISTS` | Table constraint violation, translated |
| `USERNAME_INVALID` | Failed `Username` invariants |
| `CANNOT_DISABLE_LAST_MANAGER` | D12. Without this a device can be bricked by a single tap |
| `CANNOT_DISABLE_SELF` | |
| `CURRENT_PASSWORD_INCORRECT` | Distinct context from login; no enumeration risk because the caller is already authenticated |

**C2 resolution.** `LockoutThresholdReached`, `ACCOUNT_LOCKED_MANAGER_RESET_REQUIRED`
and its Arabic text are **deleted** (D15). `AccountLocked` already covers the only
reachable state, and the Arabic text currently promises an operation no code
performs. Since D14 places manager unlock out of scope, there is nothing truthful
for the message to describe. An honest message on unreachable code is still dead
code.

### 8.3 Audit events

```rust
USER_CREATED  PASSWORD_CHANGED  PASSWORD_RESET  ROLE_CHANGED
USER_DISABLED  USER_ENABLED  USERNAME_CHANGED  SESSIONS_REVOKED
```

`USERNAME_CHANGED` detail carries `old_username`, `new_username`, `target` and
`actor` as D9 requires. Detail may contain roles, usernames and user ids. It must
never contain a password, a verifier or a token (D18). An architecture test
should assert that no audit append call site passes anything resembling
credential material.

### 8.4 Frontend

| Screen | Notes |
|---|---|
| Forced change | Full-screen, no exit. Reflects `PASSWORD_CHANGE_REQUIRED` rather than being the only enforcement |
| Re-auth modal | **Does not exist today.** `reauthenticate` is wired in `api/identity.ts` but no UI calls it, and `ViewCostAndProfit` is enforced by no command. Password management is its first real consumer, so this cost belongs in the estimate |
| User management | List, create, change role, disable/enable, reset. Manager only |
| Login picker redesign | `displayName` / `username` / `role` on three lines, which resolves D6 without exposing a UUID (D7) |
| `whoami` | Gains `mustChangePassword` |

`App.vue` grows a fourth state: `setup | login | forced-change | shell`.

---

## 9. Tests

| Layer | Coverage |
|---|---|
| Unit | `Username` normalisation and rejection; `requires_reauthenticated`; **every** combination of the three `authorize` axes across both roles and both assurance levels |
| Integration | Own change succeeds; wrong current rejected; weak new rejected; manager reset sets `must_change_password`; **a manager reset kills the target's session and not the manager's** (D13, mandatory); forced change blocks `ManageCatalog` with `PASSWORD_CHANGE_REQUIRED`; a disable takes effect immediately on an already-open session; last-manager guard; self-disable guard; `username` uniqueness; `username` normalisation on read-back; no delete path exists |
| Architecture | New commands accept no session/token/role; no audit call site passes credential material; no SQL in services; no `DELETE FROM users` anywhere; `user_credentials.username` is `NOT NULL UNIQUE` in the migration text |

The D13 regression matters most: without it the feature appears to work while
signing the manager out during their own operation, which no happy-path test
would notice.

---

## 10. Android impact

| Item | Detail |
|---|---|
| Migration `0003` | The **first migration with a data backfill.** The physical device holds one real user, `Peter`, so the backfill can be observed against real data |
| `disabled_at` | New state; no existing UI concept |
| Forced change | First blocking, must-complete flow on a small screen |
| Picker | Three lines per user on a 5.8" display; needs a layout review |
| Credential store | `delete_by_user` removes a SQLite row. The OS store holds only the current operator's token, so no keychain cleanup is required |

**Sequencing risk.** If the backfill is wrong, a field device is bricked with no
recovery path. The first implementation step should therefore be the migration
alone, verified against a **copy** of the device database, before any service
layer exists.

---

## 11. Sequence

```
1. Domain: Permission.requires_reauthenticated, SessionFacts fields, three-axis authorize
2. Migration 0003 + backfill          (alone, tested against a copy of the device DB)
3. Repositories: update_verifier, delete_by_user, set_disabled, credential_repo, row_to_user
4. Services: password.rs, users.rs
5. Commands + registration
6. Error codes + Arabic messages; delete LockoutThresholdReached
7. Tests per layer as each lands
8. Frontend: re-auth modal -> user management -> picker -> forced change
9. Desktop verification
10. STOP for review
11. Android build, install, hardware verification
```

---

## 12. Verified environment facts

Recorded so the migration decision is not re-litigated:

- `sqlx 0.9.0`, `libsqlite3-sys 0.37.0`, bundled SQLite **3.51.3**
- `db.rs` enables `foreign_keys(true)` per connection; FKs are enforced
- `sqlx` wraps migrations in a DDL transaction; `-- no-transaction` opts out
- SQLite cannot `ADD COLUMN ... UNIQUE`, and cannot alter nullability
- `PRAGMA foreign_keys=OFF` is silently ignored inside a transaction
- The documented table rebuild succeeds with FKs off outside a transaction, and
  preserves all three referential intents in this schema

---

## 13. Explicitly out of scope

- Manager unlock of a lockout (D14)
- Deleting users, ever (D10)
- Raising the minimum password length (D16)
- Password expiry, history, or rotation schedules
- Any `username` self-service for Sales users (D9)
- Any synchronisation (`ADR-008`)