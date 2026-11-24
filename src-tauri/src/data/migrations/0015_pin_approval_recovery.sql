-- 0015: PIN sign-in, owner-PIN approvals and the recovery code (ADR-017;
-- the owner's approval: ADR-016 decisions 31 and 32).
--
-- Additive only. No existing column, row, trigger or migration changes:
--
-- * `user_credentials.pin_verifier` — the Argon2id verifier of the daily PIN
--   (4–6 digits). NULL means the account has no PIN yet; the PIN text itself
--   is never stored. Wrong PINs count in the existing `users.failed_attempts`
--   lockout, so no counter is added here.
-- * `user_credentials.recovery_verifier` / `recovery_created_at` — the Argon2id
--   verifier of the owner's one-time recovery code and when it was made. NULL
--   means no code exists.
-- * `sessions.approved_by` / `approved_at` — a pending owner-PIN approval on
--   the session: who approved and when. One sensitive operation consumes it,
--   and it lapses after a short TTL. It replaces the Pattern approval, whose
--   columns (`pattern_approved_at`, `pattern_epoch`, 0007) stay unread.
--
-- `users` rows are never deleted (accounts are disabled), so ON DELETE SET NULL
-- on `approved_by` only matters for a test database.

ALTER TABLE user_credentials ADD COLUMN pin_verifier TEXT;
ALTER TABLE user_credentials ADD COLUMN recovery_verifier TEXT;
ALTER TABLE user_credentials ADD COLUMN recovery_created_at INTEGER;

ALTER TABLE sessions ADD COLUMN approved_by TEXT REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN approved_at INTEGER;
