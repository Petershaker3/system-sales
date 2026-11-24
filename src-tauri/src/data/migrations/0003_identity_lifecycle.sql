-- Migration 0003: user lifecycle.
--
-- Adds the login identifier, the forced-password-change flag, and the
-- disable/enable lifecycle.
--
-- WHY A SEPARATE TABLE FOR `username` AND `must_change_password`
--
-- The intent was a database-level `NOT NULL UNIQUE` on the login identifier, not
-- an invariant the application remembers to uphold. SQLite cannot deliver that on
-- an existing table:
--
--   * `ALTER TABLE ... ADD COLUMN x UNIQUE` fails outright ("Cannot add a UNIQUE
--     column"), so uniqueness cannot be attached to `users` after the fact.
--   * SQLite has no `ALTER COLUMN ... SET NOT NULL`, so the nullability of an
--     existing column can never be tightened. Splitting the work across `0003`
--     and `0004` would not help: `0004` would need the same table rebuild.
--
-- The remaining route is SQLite's documented rebuild procedure
-- (create-copy-drop-rename), which was measured against this schema and does
-- preserve all three referential intents. It was rejected anyway, because it
-- requires the `-- no-transaction` opt-out and therefore has **no rollback**:
--
--   * `PRAGMA foreign_keys=OFF` is silently ignored inside a transaction, so the
--     rebuild cannot run inside sqlx's normal DDL transaction at all.
--   * `foreign_keys` is a *per-connection* setting and the pool holds several
--     connections. A migration that ended without restoring it could hand the
--     application a connection with foreign keys off, silently disabling the
--     `ON DELETE RESTRICT` guarantee the catalogue depends on.
--   * A crash between `DROP TABLE users` and `COMMIT` leaves a field device half
--     rebuilt, with no recovery path: V1 has no server and no sync (`ADR-008`).
--
-- A dedicated table gets a real `NOT NULL UNIQUE` table constraint inside the
-- normal transactional migration: atomic, reversible, and unable to leave foreign
-- keys disabled. `users` itself is left exactly as it is, so `0001` and `0002`
-- remain valid history and no table is rebuilt.
--
-- The cost is one extra read to fetch a username, which is the same pattern
-- `find_by_token_hash` already uses to read a role from `users`.
--
-- NO DELETE PATH. A user is never deleted. `products.created_by` is
-- ON DELETE RESTRICT, so deleting an operator who ever catalogued something would
-- fail regardless. Disabling is the lifecycle, and history stays attributable.

ALTER TABLE users ADD COLUMN disabled_at INTEGER;

ALTER TABLE users ADD COLUMN disabled_by TEXT REFERENCES users (id) ON DELETE RESTRICT;

CREATE TABLE user_credentials (
    -- One row per account. ON DELETE CASCADE matches `sessions.user_id`; neither
    -- table is ever populated by a delete in practice, but the intent is
    -- consistent with the rest of the schema.
    user_id               TEXT    PRIMARY KEY
                              REFERENCES users (id) ON DELETE CASCADE,

    -- The login identifier, and what makes two operators who share a display
    -- name distinguishable in the picker. NOT NULL and UNIQUE are enforced here
    -- rather than in the application, so the invariant cannot be bypassed by a
    -- caller that forgets to check.
    --
    -- NOCASE makes uniqueness case-insensitive. It pairs with `Username::new`,
    -- which lowercases, so `Ahmed` and `ahmed` are one identifier rather than two
    -- that differ only in case and confuse an operator reading the picker.
    username              TEXT    NOT NULL COLLATE NOCASE UNIQUE,

    -- Set by a manager password reset, cleared by the forced change. A CHECK
    -- rather than a looser type keeps a stray value from reaching the session
    -- gate, which treats anything non-zero as "must change".
    must_change_password  INTEGER NOT NULL DEFAULT 0
                              CHECK (must_change_password IN (0, 1))
);

-- Backfill existing accounts deterministically.
--
-- `user-<first 8 hex of the id>`. UUID v7 is time-ordered (`ADR-009`), so this is
-- replayable and cannot collide: 32 bits of a UUID is not a uniqueness proof on
-- its own, so the uniqueness constraint remains the authority and this only has
-- to be a valid, plausible, ASCII identifier.
--
-- Deliberately NOT derived from `display_name`: a name may be blank, duplicated,
-- non-Latin, or contain characters the identifier rules forbid, and a migration
-- that can fail on user data is a migration that can brick a device. The manager
-- renames these from the user-management screen.
--
-- `COALESCE` makes this safe to re-run over a partially migrated database.
INSERT INTO user_credentials (user_id, username, must_change_password)
SELECT id, 'user-' || substr(id, 1, 8), 0
FROM users
WHERE id NOT IN (SELECT user_id FROM user_credentials);

-- Supports the disabled-account check on the login and resolve paths.
CREATE INDEX idx_users_disabled ON users (disabled_at);