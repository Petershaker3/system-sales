-- Migration 0007: Pattern authorization mechanism
--
-- Introduces a second Manager-only approval mechanism after identity
-- lifecycle, so that sensitive inventory operations can require fresh
-- proof beyond a session's assurance level.
--
-- The manager_pattern table holds exactly one row: a verifier, not the
-- Pattern text. The session fields allow the authorization model to
-- distinguish "approved at time T" from "approved under epoch E".

CREATE TABLE manager_pattern (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    verifier   TEXT    NOT NULL,
    epoch      INTEGER NOT NULL DEFAULT 1 CHECK (epoch >= 1),
    updated_by TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- SQLite accepts exactly one ADD COLUMN clause per ALTER TABLE statement, so
-- the two session columns are two statements rather than one.
ALTER TABLE sessions
    ADD COLUMN pattern_approved_at INTEGER;

ALTER TABLE sessions
    ADD COLUMN pattern_epoch INTEGER NOT NULL DEFAULT 0;
