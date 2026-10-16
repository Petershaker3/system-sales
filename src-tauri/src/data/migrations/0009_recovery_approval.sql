-- Migration 0009: single-use recovery approvals (plan R1).
--
-- One row per owner-approved password reset. The row is consumed
-- transactionally with the verifier write: `consumed_at` moves from NULL to a
-- timestamp in the same transaction, so a crash before commit rolls the
-- consumption back (safe retry with the same reference) and a crash after
-- commit leaves a consumed row (replay refused).
--
-- The row carries no secret: reference, device, target and reason only. The
-- new password travels through the supervised session and is never stored.

CREATE TABLE recovery_approval (
    reference      TEXT    PRIMARY KEY,
    device_id      TEXT    NOT NULL,
    target_user_id TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    reason         TEXT    NOT NULL,
    approved_at    INTEGER NOT NULL,
    consumed_at    INTEGER
);
