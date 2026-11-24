-- Migration 0001: identity.
--
-- Scope is deliberately narrow: three tables covering accounts, sessions and
-- audit. `plan:141` lists a wider initial set, but those tables belong to
-- slices whose semantics are not yet decided (currency is still unnamed, and
-- product disposition is open). Creating them now would encode assumptions as
-- schema, which `PROJECT_INSTRUCTIONS.md` §4 forbids.
--
-- NO SYNC TABLES. ADR-008 places all synchronisation outside V1. The earlier
-- `plan:141` list named `sync_outbox` and `sync_cursors`; that was pre-rebaseline
-- drift and was corrected on 2026-10-03. Creating them here would build exactly
-- the forbidden structure.
--
-- Timestamps are INTEGER milliseconds since the Unix epoch, UTC. Numeric
-- storage lets SQLite compare and order them without format ambiguity.
--
-- Rollback is not a `Down` script: `plan:143` fixes the recovery model as
-- restore-a-backup then forward-fix.

CREATE TABLE users (
    id              TEXT    PRIMARY KEY NOT NULL,
    display_name    TEXT    NOT NULL,
    -- The role is a closed two-value domain (spec:17-18). The CHECK keeps the
    -- enum honest at the storage layer even if a future writer is careless.
    role            TEXT    NOT NULL CHECK (role IN ('manager', 'sales')),
    -- Argon2id verifier in PHC string format. Never a plaintext password.
    verifier        TEXT    NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    -- NULL means not locked. Stored as epoch millis, not a formatted string.
    locked_until    INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE sessions (
    -- SHA-256 of the session token, never the token itself (ADR-009). A copy of
    -- this database therefore yields no usable session credential.
    token_hash          TEXT    PRIMARY KEY NOT NULL,
    user_id             TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    assurance           TEXT    NOT NULL CHECK (assurance IN ('normal', 'reauthenticated')),
    issued_at           INTEGER NOT NULL,
    last_seen_at        INTEGER NOT NULL,
    -- Fixed at issue time and never extended, so idling cannot push a session
    -- past its maximum lifetime.
    absolute_expires_at INTEGER NOT NULL
);

CREATE INDEX idx_sessions_user_id ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (absolute_expires_at);

CREATE TABLE audit_events (
    id          TEXT    PRIMARY KEY NOT NULL,
    -- Nullable: a failed login for an account that does not exist still has to
    -- be recorded, and there is no user to attribute it to.
    user_id     TEXT    REFERENCES users (id) ON DELETE SET NULL,
    event_type  TEXT    NOT NULL,
    occurred_at INTEGER NOT NULL,
    -- JSON. Never a secret: no password, no verifier, no session token.
    detail      TEXT
);

CREATE INDEX idx_audit_occurred_at ON audit_events (occurred_at);
CREATE INDEX idx_audit_user_id ON audit_events (user_id);
CREATE INDEX idx_audit_event_type ON audit_events (event_type);